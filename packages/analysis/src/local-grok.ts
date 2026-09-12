import { createHash } from 'node:crypto';
import {
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import {
  GrokClient,
  GrokError,
  runWithPrivateFiles,
  type SourceFile,
} from '../../grok/src/index.js';
import { loadBundle, compile, hash, type Bundle } from './config.js';
import {
  LocalRunStore,
  executeLocal,
  RetryableError,
  type Handlers,
} from './runner.js';
import {
  assertEvidenceFromInputs,
  assertQuotesInText,
  assertRunDocuments,
} from './evidence.js';

const scope = { tenantId: 'local', caseId: 'local' };
const digest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export class LocalGrok {
  readonly store: LocalRunStore;
  private active = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  constructor(
    readonly directory: string,
    readonly configRoot: string,
    private readonly client: GrokClient,
    private readonly model?: string,
  ) {
    this.store = new LocalRunStore(directory, true);
  }
  async start(paths: string[], caseName = 'Local analysis') {
    if (!paths.length || paths.length > 10)
      throw new Error('Provide 1–10 documents');
    let total = 0;
    const files = paths.map((path) => {
      const stat = statSync(resolve(path));
      if (
        !stat.isFile() ||
        stat.size < 1 ||
        total + stat.size > 20 * 1024 * 1024
      )
        throw new Error('Use regular files, at most 20 MiB combined');
      const bytes = readFileSync(resolve(path));
      total += bytes.length;
      const extension = extname(path).toLowerCase();
      const type =
        extension === '.pdf'
          ? 'application/pdf'
          : ['.txt', '.md'].includes(extension)
            ? 'text/plain'
            : '';
      if (!type || !bytes.length || total > 20 * 1024 * 1024)
        throw new Error('Use PDF/TXT/MD files, at most 20 MiB combined');
      if (
        type === 'application/pdf' &&
        !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      )
        throw new Error('Invalid PDF');
      if (type === 'text/plain')
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { bytes, type, name: basename(path), id: digest(bytes) };
    });
    const bundle = loadBundle(
      this.configRoot,
      'workflows/investor-council.v1.json',
    );
    if (this.model)
      for (const model of Object.values(bundle.models))
        if (model.provider === 'xai') model.model = this.model;
    compile(bundle);
    const documents = files.map((f) => ({
      documentVersionId: f.id,
      name: f.name,
    }));
    const id = hash([caseName, documents, bundle]);
    // Content-addressed originals survive edits/deletion of the user's source paths.
    for (const file of files) {
      const path = join(this.directory, `${file.id}.source`);
      if (!existsSync(path))
        writeFileSync(path, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    if (!existsSync(join(this.directory, `${id}.json`)))
      this.store.create(id, scope, bundle, { documents });
    this.launch(id);
    return { runId: id, caseName, documents };
  }
  get(id: string) {
    const run = this.store.read(id, scope);
    return {
      runId: id,
      status: run.status,
      steps: run.steps,
      attempts: run.attempts,
      outputs: run.outputs,
      report: run.outputs.report
        ? run.artifacts[run.outputs.report]?.payload
        : null,
      active: this.active.has(id),
      cleanupPending: readdirSync(this.directory).filter((f) =>
        f.startsWith(`${id}.provider-`),
      ).length,
    };
  }
  list() {
    return readdirSync(this.directory)
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => this.get(f.slice(0, -5)));
  }
  artifact(id: string, artifactId: string) {
    const artifact = this.store.read(id, scope).artifacts[artifactId];
    if (!artifact || hash(artifact.payload) !== artifact.hash)
      throw new Error('Missing or corrupt artifact');
    return artifact;
  }
  async wait(id: string) {
    await this.active.get(id)?.done;
    return this.get(id);
  }
  async cancel(id: string) {
    this.store.read(id, scope);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort();
      await active.done;
    } else {
      const unlock = this.store.lock(id);
      try {
        const run = this.store.read(id, scope);
        if (['queued', 'running'].includes(run.status)) {
          run.status = 'cancelled';
          this.store.commit(run);
        }
      } finally {
        unlock();
      }
    }
    return this.get(id);
  }
  resume(id: string) {
    if (this.active.has(id)) return this.get(id);
    const unlock = this.store.lock(id);
    try {
      const run = this.store.read(id, scope);
      if (run.status === 'failed') {
        // Accepted artifacts and consumed attempt/call budgets remain intact.
        for (const [step, state] of Object.entries(run.steps))
          if (state.status === 'failed') delete run.steps[step];
        run.status = 'queued';
        this.store.commit(run);
      }
    } finally {
      unlock();
    }
    this.launch(id);
    return this.get(id);
  }
  async cleanup(id: string) {
    this.store.read(id, scope);
    if (this.active.has(id))
      throw new Error('Wait for this run to stop before cleanup');
    const unlock = this.store.lock(id);
    try {
      for (const name of readdirSync(this.directory).filter((f) =>
        f.startsWith(`${id}.provider-`),
      )) {
        await this.client.deleteFile(
          readFileSync(join(this.directory, name), 'utf8'),
        );
        unlinkSync(join(this.directory, name));
      }
    } finally {
      unlock();
    }
    return this.get(id);
  }
  private launch(id: string) {
    if (this.active.has(id)) return;
    const run = this.store.read(id, scope);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
    const controller = new AbortController();
    const done = executeLocal(
      this.store,
      id,
      scope,
      this.handlers(id, run.snapshot),
      { signal: controller.signal },
    )
      .catch(() => {
        /* Persisted attempt state is available through get_report. */
      })
      .finally(() => this.active.delete(id));
    this.active.set(id, { controller, done });
  }
  private handlers(id: string, bundle: Bundle): Handlers {
    const compiled = compile(bundle);
    return Object.fromEntries(
      Object.keys(bundle.agents).map((key) => [
        key,
        async ({ inputs, agent, prompt, signal, recordProvider }) => {
          const model = bundle.models[agent.modelProfile]!;
          if (model.provider !== 'xai') throw new Error('Expected xAI model');
          const documents = this.store.read(id, scope).inputs.documents as {
            documentVersionId: string;
            name: string;
          }[];
          const files: SourceFile[] = [];
          const texts = new Map<string, string>();
          const seesDocuments = Object.values(agent.inputs).some(
            (p) => p.delivery === 'attachments',
          );
          if (seesDocuments)
            for (const doc of documents) {
              const bytes = readFileSync(
                join(this.directory, `${doc.documentVersionId}.source`),
              );
              if (digest(bytes) !== doc.documentVersionId)
                throw new Error('Source hash mismatch');
              const type =
                extname(doc.name).toLowerCase() === '.pdf'
                  ? 'application/pdf'
                  : 'text/plain';
              files.push({ ...doc, blob: new Blob([bytes], { type }) });
              if (type === 'text/plain')
                texts.set(doc.documentVersionId, bytes.toString('utf8'));
            }
          const marker = (providerId: string) =>
            join(this.directory, `${id}.provider-${hash(providerId)}`);
          try {
            const result = await runWithPrivateFiles(
              this.client,
              {
                model: model.model,
                prompt,
                inputs,
                files,
                signal,
                maxOutputTokens: agent.limits.maxOutputTokensPerCall,
                maxToolCalls: model.maxToolCalls,
                timeoutMs: agent.limits.timeoutSeconds * 1000,
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: Object.keys(agent.outputs),
                  properties: Object.fromEntries(
                    Object.entries(agent.outputs).map(([port, contract]) => {
                      const {
                        $schema: _schema,
                        $id: _id,
                        ...schema
                      } = bundle.schemas[contract.schema] as Record<
                        string,
                        unknown
                      >;
                      return [port, schema];
                    }),
                  ),
                },
                validate(output) {
                  const value = output as Record<string, unknown>;
                  if (
                    !value ||
                    Object.keys(value).sort().join('|') !==
                      Object.keys(agent.outputs).sort().join('|')
                  )
                    throw new Error('Output ports mismatch');
                  for (const [port, contract] of Object.entries(agent.outputs))
                    if (!compiled.validators[contract.schema]!(value[port]))
                      throw new Error('Invalid output');
                  assertRunDocuments(
                    value,
                    documents.map((d) => d.documentVersionId),
                  );
                  assertQuotesInText(value, texts);
                  if (!seesDocuments) assertEvidenceFromInputs(value, inputs);
                },
              },
              {
                uploaded: async (_, providerId) => {
                  writeFileSync(marker(providerId), providerId, {
                    mode: 0o600,
                  });
                },
                deleted: async (providerId) => {
                  unlinkSync(marker(providerId));
                },
                cleanupFailed: async () => {},
              },
            );
            if (signal.aborted) throw new Error('Cancelled');
            const { output, ...provider } = result;
            recordProvider(provider);
            return output as Record<string, unknown>;
          } catch (error) {
            if (
              error instanceof GrokError &&
              error.retryable &&
              (error.code === 'rate_limit' ||
                error.code === 'provider_unavailable')
            ) {
              await new Promise((r) => setTimeout(r, 1000));
              throw new RetryableError(error.code);
            }
            throw error;
          }
        },
      ]),
    );
  }
}
