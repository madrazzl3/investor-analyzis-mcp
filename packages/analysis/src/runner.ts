import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GrokResult } from '../../grok/src/index.js';
import {
  compile,
  hash,
  sources,
  type Bundle,
  type Source,
  type Agent,
} from './config.js';

type Scope = { tenantId: string; caseId: string };
type Artifact = {
  id: string;
  stepId: string;
  output: string;
  schema: string;
  payload: unknown;
  hash: string;
  inputArtifactIds: string[];
};
type Attempt = {
  stepId: string;
  number: number;
  status: 'running' | 'completed' | 'failed';
  error?: string;
  provider?: Omit<GrokResult, 'output'>;
};
type Manifest = {
  stepId: string;
  attempt: number;
  inputs: Record<string, unknown>;
  inputArtifactIds: string[];
  documentVersionIds: string[];
  configHash: string;
};
export type Run = {
  id: string;
  scope: Scope;
  snapshot: Bundle;
  configHash: string;
  inputs: Record<string, unknown>;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  calls: number;
  steps: Record<
    string,
    { status: 'completed' | 'failed'; outputs: Record<string, string> }
  >;
  artifacts: Record<string, Artifact>;
  manifests: Manifest[];
  attempts: Attempt[];
  outputs: Record<string, string>;
};
const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid run ID');
  return id;
};

// Single-user local datastore; filesystem access is the authorization boundary.
// One atomic JSON snapshot per commit. An exclusive lock prevents simultaneous writers.
// After a process crash, a stale .lock requires manual removal after checking the owner.
export class LocalRunStore {
  constructor(
    readonly directory: string,
    readonly allowLive = false,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string) {
    return join(this.directory, `${safeId(id)}.json`);
  }
  create(
    id: string,
    scope: Scope,
    bundle: Bundle,
    inputs: Record<string, unknown>,
  ): Run {
    // Live execution requires an explicit local runtime.
    if (bundle.runnerVersion !== 'local-fake-v1' && !this.allowLive)
      throw new Error('Local runner supports fake-model bundles only');
    const compiled = compile(bundle);
    checkPorts(inputs, Object.keys(bundle.workflow.inputs));
    for (const [key, port] of Object.entries(bundle.workflow.inputs))
      validate(compiled.validators[port.schema]!, inputs[key], key);
    const run: Run = {
      id,
      scope,
      snapshot: bundle,
      configHash: hash(bundle),
      inputs,
      status: 'queued',
      calls: 0,
      steps: {},
      artifacts: {},
      manifests: [],
      attempts: [],
      outputs: {},
    };
    writeFileSync(this.path(id), JSON.stringify(run), {
      flag: 'wx',
      mode: 0o600,
    });
    return this.read(id, scope);
  }
  read(id: string, scope: Scope): Run {
    const run = JSON.parse(readFileSync(this.path(id), 'utf8')) as Run;
    if (
      run.scope.tenantId !== scope.tenantId ||
      run.scope.caseId !== scope.caseId
    )
      throw new Error('Access denied');
    if (hash(run.snapshot) !== run.configHash)
      throw new Error('Snapshot hash mismatch');
    return run;
  }
  commit(run: Run) {
    const temp = `${this.path(run.id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(run), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.path(run.id));
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* Already renamed. */
      }
    }
  }
  lock(id: string) {
    const path = `${this.path(id)}.lock`;
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return () => unlinkSync(path);
  }
}
function checkPorts(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== keys.sort().join('|')
  )
    throw new Error('Output/input ports mismatch');
}
function validate(
  fn: ReturnType<typeof compile>['validators'][string],
  data: unknown,
  label: string,
) {
  if (!fn(data)) throw new Error(`Schema validation failed: ${label}`);
}
export class RetryableError extends Error {
  constructor(readonly code: 'rate_limit' | 'provider_unavailable') {
    super(code);
  }
}
export type FakeHandler = (request: {
  inputs: Record<string, unknown>;
  agent: Agent;
  prompt: string;
  signal: AbortSignal;
  recordProvider: (provider: NonNullable<Attempt['provider']>) => void;
}) => Promise<Record<string, unknown>>;
export type Handlers = Record<string, FakeHandler>;
export async function executeLocal(
  store: LocalRunStore,
  id: string,
  scope: Scope,
  handlers: Handlers,
  options: { signal?: AbortSignal; stopAfterSteps?: number } = {},
): Promise<Run> {
  // Scope comes from a trusted test caller. Production must derive it from verified identity.
  store.read(id, scope);
  const unlock = store.lock(id);
  try {
    const run = store.read(id, scope);
    if (['completed', 'cancelled', 'failed'].includes(run.status)) return run;
    const compiled = compile(run.snapshot);
    for (const step of Object.values(compiled.workflow.steps))
      if (!Object.hasOwn(handlers, step.agent))
        throw new Error(`Missing handler: ${step.agent}`);
    run.status = 'running';
    store.commit(run);
    const allowedDocs = new Set<string>();
    for (const [key, port] of Object.entries(compiled.workflow.inputs)) {
      if (port.schema === 'source-documents@1.0.0')
        for (const doc of run.inputs[key] as { documentVersionId: string }[])
          allowedDocs.add(doc.documentVersionId);
    }
    const checkEvidence = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(checkEvidence);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (
          key === 'documentVersionId' &&
          (typeof child !== 'string' || !allowedDocs.has(child))
        )
          throw new Error(
            'Evidence references a document outside the input snapshot',
          );
        checkEvidence(child);
      }
    };
    const resolveSource = (s: Source) => {
      if (s.from === 'input')
        return { payload: run.inputs[s.name], ids: [] as string[] };
      const artifactId = run.steps[s.step]?.outputs[s.output];
      const artifact = artifactId && run.artifacts[artifactId];
      if (!artifact || hash(artifact.payload) !== artifact.hash)
        throw new Error('Missing or corrupt input artifact');
      return { payload: artifact.payload, ids: [artifact.id] };
    };
    let executed = 0;
    const executeStep = async (stepId: string) => {
      const step = compiled.workflow.steps[stepId]!;
      const agent = run.snapshot.agents[step.agent]!;
      const inputs: Record<string, unknown> = {},
        ids: string[] = [];
      for (const [port, binding] of Object.entries(step.inputs)) {
        const resolved = sources(binding).map(resolveSource);
        inputs[port] =
          'merge' in binding
            ? resolved.flatMap((item) => item.payload as unknown[])
            : resolved[0]!.payload;
        resolved.forEach((item) => ids.push(...item.ids));
        validate(
          compiled.validators[agent.inputs[port]!.schema]!,
          inputs[port],
          port,
        );
      }
      let prior = run.attempts.filter(
        (attempt) => attempt.stepId === stepId,
      ).length;
      // A previously interrupted attempt consumed its budget; the same snapshot is reused.
      for (const attempt of run.attempts.filter(
        (a) => a.stepId === stepId && a.status === 'running',
      )) {
        attempt.status = 'failed';
        attempt.error = 'interrupted';
      }
      while (prior < agent.retry.maxAttempts) {
        if (options.signal?.aborted) return;
        if (
          run.calls >= compiled.workflow.limits.maxModelCalls ||
          prior >= agent.limits.maxModelCalls
        )
          throw new Error('Call budget exhausted');
        const attempt: Attempt = { stepId, number: ++prior, status: 'running' };
        run.attempts.push(attempt);
        run.calls++;
        run.manifests.push({
          stepId,
          attempt: prior,
          inputs: structuredClone(inputs),
          inputArtifactIds: [...new Set(ids)],
          documentVersionIds: [...allowedDocs],
          configHash: run.configHash,
        });
        store.commit(run);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        options.signal?.addEventListener('abort', cancel, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortHandler: (() => void) | undefined;
        try {
          const result = await Promise.race([
            handlers[step.agent]!({
              inputs: structuredClone(inputs),
              agent: structuredClone(agent),
              prompt: run.snapshot.prompts[agent.promptFile]!,
              signal: controller.signal,
              recordProvider: (provider) => {
                attempt.provider = provider;
                store.commit(run);
              },
            }),
            new Promise<never>((_, reject) => {
              abortHandler = () => reject(new Error('cancelled'));
              controller.signal.addEventListener('abort', abortHandler, {
                once: true,
              });
              timer = setTimeout(() => {
                reject(new Error('timeout'));
                controller.abort();
              }, agent.limits.timeoutSeconds * 1000);
              if (controller.signal.aborted) reject(new Error('cancelled'));
            }),
          ]);
          if (options.signal?.aborted) throw new Error('cancelled');
          checkPorts(result, Object.keys(agent.outputs));
          const published: Record<string, string> = {},
            artifacts: Artifact[] = [];
          // Validate every output before publishing any; isolate handler-owned objects.
          const output = JSON.parse(JSON.stringify(result)) as Record<
            string,
            unknown
          >;
          checkPorts(output, Object.keys(agent.outputs));
          for (const [port, contract] of Object.entries(agent.outputs)) {
            validate(compiled.validators[contract.schema]!, output[port], port);
            checkEvidence(output[port]);
            const artifact: Artifact = {
              id: hash([id, stepId, port]),
              stepId,
              output: port,
              schema: contract.schema,
              payload: output[port],
              hash: hash(output[port]),
              inputArtifactIds: [...new Set(ids)],
            };
            artifacts.push(artifact);
            published[port] = artifact.id;
          }
          artifacts.forEach((a) => {
            run.artifacts[a.id] = a;
          });
          run.steps[stepId] = { status: 'completed', outputs: published };
          attempt.status = 'completed';
          store.commit(run);
          return;
        } catch (error) {
          attempt.status = 'failed';
          // Store classified errors, not arbitrary messages that could contain private input.
          attempt.error =
            error instanceof RetryableError
              ? error.code
              : options.signal?.aborted
                ? 'cancelled'
                : 'execution_or_validation_failed';
          store.commit(run);
          if (options.signal?.aborted) return;
          if (
            !(error instanceof RetryableError) ||
            !agent.retry.on.includes(error.code)
          )
            throw error;
        } finally {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', cancel);
          if (abortHandler)
            controller.signal.removeEventListener('abort', abortHandler);
        }
      }
      throw new Error('Attempt budget exhausted');
    };
    while (Object.keys(run.steps).length < compiled.order.length) {
      if (options.signal?.aborted) {
        run.status = 'cancelled';
        store.commit(run);
        return run;
      }
      const ready = compiled.order.filter(
        (step) =>
          !run.steps[step] &&
          compiled.dependencies[step]!.every(
            (dep) => run.steps[dep]?.status === 'completed',
          ),
      );
      if (!ready.length) {
        run.status = 'failed';
        store.commit(run);
        return run;
      }
      const remaining =
        options.stopAfterSteps === undefined
          ? Infinity
          : options.stopAfterSteps - executed;
      if (remaining <= 0) return run;
      const batch = ready.slice(
        0,
        Math.min(compiled.workflow.limits.maxParallelSteps, remaining),
      );
      const results = await Promise.allSettled(batch.map(executeStep));
      results.forEach((result, i) => {
        if (result.status === 'rejected')
          run.steps[batch[i]!] = { status: 'failed', outputs: {} };
      });
      executed += batch.length;
      if (options.signal?.aborted) run.status = 'cancelled';
      else if (results.some((result) => result.status === 'rejected'))
        run.status = 'failed';
      store.commit(run);
      if (run.status !== 'running') return run;
    }
    for (const [port, source] of Object.entries(compiled.workflow.outputs))
      run.outputs[port] = run.steps[source.step]!.outputs[source.output]!;
    run.status = 'completed';
    store.commit(run);
    return run;
  } finally {
    unlock();
  }
}
