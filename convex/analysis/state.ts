import { internalMutation, internalQuery } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import {
  assertSupported,
  liveAnalysisEnabled,
  validatePayload,
  type RunMode,
  type SnapshotBundle,
} from './registry';
import { providerCall } from './values';

type DbCtx = Pick<MutationCtx | QueryCtx, 'db'>;
/** Synthetic runs accept only fixtures; live runs only stored private uploads. */
export function sourceMatches(
  source: Doc<'documentVersions'> | null,
  caseId: Id<'cases'>,
  mode: RunMode,
): source is Doc<'documentVersions'> {
  return (
    !!source &&
    source.caseId === caseId &&
    source.synthetic === (mode === 'synthetic') &&
    (mode === 'synthetic' || !!source.storageId)
  );
}
export async function executionContext(ctx: DbCtx, runId: Id<'analysisRuns'>) {
  const run = await ctx.db.get(runId);
  if (!run) throw new Error('Run not found');
  if (run.status === 'cancelled' || run.status === 'failed')
    throw new Error('Run is terminal');
  const mode: RunMode = run.mode ?? 'synthetic';
  const member = await ctx.db.get(run.createdBy);
  if (!member || member.organizationId !== run.organizationId)
    throw new Error('Initiator access revoked');
  const item = await ctx.db.get(run.caseId);
  if (!item || item.organizationId !== run.organizationId)
    throw new Error('Case access revoked');
  const sources = [];
  for (const id of run.documentVersionIds) {
    const source = await ctx.db.get(id);
    if (!sourceMatches(source, run.caseId, mode))
      throw new Error('Source access revoked');
    sources.push(source);
  }
  const snapshot = await ctx.db.get(run.snapshotId);
  if (!snapshot) throw new Error('Snapshot missing');
  assertSupported(snapshot.hash, mode);
  return {
    run,
    mode,
    sources,
    bundle: JSON.parse(snapshot.bundleJson) as SnapshotBundle,
    configHash: snapshot.hash,
  };
}
export const plan = internalQuery({
  args: { runId: v.id('analysisRuns') },
  handler: async (ctx, args) => {
    const { bundle } = await executionContext(ctx, args.runId);
    return {
      steps: Object.entries(bundle.workflow.steps).map(([id, step]) => ({
        id,
        dependencies: [
          ...new Set(
            Object.values(step.inputs).flatMap((b) =>
              ('merge' in b ? b.sources : [b])
                .filter((s) => s.from === 'step')
                .map((s) => s.step),
            ),
          ),
        ],
      })),
      maxParallelSteps: bundle.workflow.limits.maxParallelSteps,
    };
  },
});
export const begin = internalMutation({
  args: { runId: v.id('analysisRuns'), stepId: v.string() },
  handler: async (ctx, args) => {
    const { run, mode, sources, bundle, configHash } = await executionContext(
      ctx,
      args.runId,
    );
    const stage = await ctx.db
      .query('agentRuns')
      .withIndex('by_run_step', (q) =>
        q.eq('runId', args.runId).eq('stepId', args.stepId),
      )
      .unique();
    if (!stage) throw new Error('Step missing');
    if (stage.status === 'completed')
      return { completed: true as const, outputs: stage.outputs };
    // Stops new paid calls immediately; already accepted outputs remain.
    if (mode === 'live' && !liveAnalysisEnabled())
      throw new Error('Live analysis is disabled');
    const spec = bundle.workflow.steps[args.stepId]!,
      agent = bundle.agents[spec.agent]!;
    if (
      stage.attempts >= agent.retry.maxAttempts ||
      stage.attempts >= agent.limits.maxModelCalls ||
      run.calls >= bundle.workflow.limits.maxModelCalls
    )
      throw new Error('Call/attempt budget exhausted');
    // Supersede only an interrupted attempt; keep a recorded failure reason.
    const previous = stage.activeAttempt
      ? await ctx.db.get(stage.activeAttempt)
      : null;
    if (previous?.status === 'running')
      await ctx.db.patch(previous._id, {
        status: 'failed',
        error: 'superseded',
      });
    const documents = sources.map((doc) => ({
      documentVersionId: doc._id,
      name: doc.name,
    }));
    const inputs: Record<string, unknown> = {},
      artifactIds: Id<'artifacts'>[] = [];
    for (const [port, binding] of Object.entries(spec.inputs)) {
      const payloads = [];
      for (const source of 'merge' in binding ? binding.sources : [binding]) {
        if (source.from === 'input') {
          if (source.name !== 'documents')
            throw new Error('Unknown submitted input');
          payloads.push(documents);
        } else {
          const upstream = await ctx.db
            .query('agentRuns')
            .withIndex('by_run_step', (q) =>
              q.eq('runId', run._id).eq('stepId', source.step),
            )
            .unique();
          const id = upstream?.outputs[source.output];
          const artifact = id ? await ctx.db.get(id) : null;
          if (
            upstream?.status !== 'completed' ||
            !artifact ||
            artifact.runId !== run._id
          )
            throw new Error('Dependency incomplete');
          payloads.push(artifact.payload);
          artifactIds.push(artifact._id);
        }
      }
      inputs[port] = 'merge' in binding ? payloads.flat() : payloads[0];
      validatePayload(agent.inputs[port]!.schema, inputs[port]);
    }
    const attemptId = await ctx.db.insert('agentAttempts', {
      runId: run._id,
      agentRunId: stage._id,
      number: stage.attempts + 1,
      status: 'running',
    });
    await ctx.db.insert('contextManifests', {
      runId: run._id,
      attemptId,
      configHash,
      inputs,
      inputArtifactIds: [...new Set(artifactIds)],
      documentVersionIds: run.documentVersionIds,
    });
    await ctx.db.patch(stage._id, {
      status: 'running',
      activeAttempt: attemptId,
      attempts: stage.attempts + 1,
    });
    await ctx.db.patch(run._id, { status: 'running', calls: run.calls + 1 });
    return { completed: false as const, attemptId };
  },
});
export const context = internalQuery({
  args: { attemptId: v.id('agentAttempts') },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt) throw new Error('Attempt missing');
    const { bundle, mode, sources } = await executionContext(
      ctx,
      attempt.runId,
    );
    const stage = await ctx.db.get(attempt.agentRunId);
    if (
      !stage ||
      stage.activeAttempt !== attempt._id ||
      attempt.status !== 'running'
    )
      throw new Error('Stale attempt');
    const manifest = await ctx.db
      .query('contextManifests')
      .withIndex('by_attempt', (q) => q.eq('attemptId', attempt._id))
      .unique();
    if (!manifest) throw new Error('Context missing');
    const agent = bundle.agents[stage.agent]!;
    const base = {
      agent,
      inputs: manifest.inputs as Record<string, unknown>,
      prompt: bundle.prompts[agent.promptFile]!,
    };
    if (mode === 'synthetic') return { ...base, mode, live: null };
    // Attach only this run's frozen, authorized sources, in manifest order.
    const byId = new Map(sources.map((doc) => [doc._id as string, doc]));
    const attachments = new Map<string, (typeof sources)[number]>();
    for (const [port, spec] of Object.entries(agent.inputs)) {
      if (spec.delivery !== 'attachments') continue;
      for (const item of base.inputs[port] as { documentVersionId: string }[]) {
        const doc = byId.get(item.documentVersionId);
        if (!doc) throw new Error('Source access denied');
        attachments.set(doc._id, doc);
      }
    }
    const model = bundle.models[agent.modelProfile]!;
    if (model.provider !== 'xai') throw new Error('Unsupported model provider');
    const ports = Object.keys(agent.outputs);
    return {
      ...base,
      mode,
      live: {
        model: model.model,
        maxToolCalls: model.maxToolCalls,
        maxOutputTokens: agent.limits.maxOutputTokensPerCall,
        timeoutMs: agent.limits.timeoutSeconds * 1000,
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ports,
          properties: Object.fromEntries(
            Object.entries(agent.outputs).map(([port, contract]) => {
              const {
                $schema: _,
                $id: __,
                ...schema
              } = bundle.schemas[contract.schema] as Record<string, unknown>;
              return [port, schema];
            }),
          ),
        },
        outputSchemas: Object.fromEntries(
          Object.entries(agent.outputs).map(([port, c]) => [port, c.schema]),
        ),
        attachments: [...attachments.values()].map((doc) => ({
          documentVersionId: doc._id,
          name: doc.name,
          storageId: doc.storageId!,
          contentType: doc.contentType ?? 'application/octet-stream',
        })),
      },
    };
  },
});
function verifySources(value: unknown, allowed: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((x) => verifySources(x, allowed));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'documentVersionId' &&
      (typeof child !== 'string' || !allowed.has(child))
    )
      throw new Error('Foreign evidence reference');
    verifySources(child, allowed);
  }
}
export const publish = internalMutation({
  args: {
    attemptId: v.id('agentAttempts'),
    outputs: v.any(),
    provider: v.optional(providerCall),
  },
  handler: async (ctx, args): Promise<Record<string, Id<'artifacts'>>> => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt) throw new Error('Attempt missing');
    const { run, mode, bundle } = await executionContext(ctx, attempt.runId);
    // Live outputs must come from a recorded provider response; fixtures never do.
    if ((mode === 'live') !== !!args.provider)
      throw new Error('Provider record mismatch');
    const stage = await ctx.db.get(attempt.agentRunId);
    if (!stage || stage.activeAttempt !== attempt._id)
      throw new Error('Stale attempt');
    if (stage.status === 'completed' && attempt.status === 'completed')
      return stage.outputs;
    if (attempt.status !== 'running' || stage.status !== 'running')
      throw new Error('Attempt is not running');
    const agent = bundle.agents[stage.agent]!;
    if (
      !args.outputs ||
      typeof args.outputs !== 'object' ||
      Array.isArray(args.outputs) ||
      Object.keys(args.outputs).sort().join('|') !==
        Object.keys(agent.outputs).sort().join('|')
    )
      throw new Error('Output ports mismatch');
    for (const [port, contract] of Object.entries(agent.outputs)) {
      validatePayload(contract.schema, args.outputs[port]);
      verifySources(args.outputs[port], new Set(run.documentVersionIds));
    }
    const manifest = await ctx.db
      .query('contextManifests')
      .withIndex('by_attempt', (q) => q.eq('attemptId', attempt._id))
      .unique();
    if (!manifest) throw new Error('Context missing');
    const outputs: Record<string, Id<'artifacts'>> = {};
    for (const [port, contract] of Object.entries(agent.outputs))
      outputs[port] = await ctx.db.insert('artifacts', {
        runId: run._id,
        agentRunId: stage._id,
        attemptId: attempt._id,
        output: port,
        schema: contract.schema,
        payload: args.outputs[port],
        inputArtifactIds: manifest.inputArtifactIds,
      });
    await ctx.db.patch(stage._id, { status: 'completed', outputs });
    await ctx.db.patch(attempt._id, {
      status: 'completed',
      ...(args.provider ? { provider: args.provider } : {}),
    });
    return outputs;
  },
});
/**
 * Records a failed attempt and decides, within the snapshot's retry policy and
 * call budgets, whether the workflow should schedule another attempt.
 */
export const failAttempt = internalMutation({
  args: {
    attemptId: v.id('agentAttempts'),
    error: v.string(),
    retryable: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ retryAfterMs: number } | null> => {
    const attempt = await ctx.db.get(args.attemptId);
    if (!attempt || attempt.status !== 'running') return null;
    await ctx.db.patch(attempt._id, { status: 'failed', error: args.error });
    const stage = await ctx.db.get(attempt.agentRunId);
    if (stage?.activeAttempt !== attempt._id || stage.status !== 'running')
      return null;
    let retry = false;
    if (args.retryable) {
      try {
        const { run, bundle } = await executionContext(ctx, attempt.runId);
        const agent = bundle.agents[stage.agent]!;
        retry =
          (agent.retry.on as string[]).includes(args.error) &&
          stage.attempts < agent.retry.maxAttempts &&
          stage.attempts < agent.limits.maxModelCalls &&
          run.calls < bundle.workflow.limits.maxModelCalls;
      } catch {
        // Terminal run, revoked access, or unsupported snapshot: do not retry.
      }
    }
    await ctx.db.patch(stage._id, { status: retry ? 'pending' : 'failed' });
    if (retry)
      return {
        retryAfterMs: Math.min(60_000, 5_000 * 2 ** (stage.attempts - 1)),
      };
    const run = await ctx.db.get(attempt.runId);
    if (run && (run.status === 'running' || run.status === 'queued'))
      await ctx.db.patch(run._id, { error: `${stage.stepId}: ${args.error}` });
    return null;
  },
});
export const finish = internalMutation({
  args: { runId: v.id('analysisRuns') },
  handler: async (ctx, args) => {
    const { run, bundle } = await executionContext(ctx, args.runId);
    const outputs: Record<string, Id<'artifacts'>> = {};
    const stages = await ctx.db
      .query('agentRuns')
      .withIndex('by_run', (q) => q.eq('runId', run._id))
      .collect();
    if (
      stages.length !== Object.keys(bundle.workflow.steps).length ||
      stages.some((s) => s.status !== 'completed')
    )
      throw new Error('Incomplete workflow');
    for (const [port, source] of Object.entries(bundle.workflow.outputs)) {
      const stage = stages.find((s) => s.stepId === source.step);
      const id = stage?.outputs[source.output];
      if (!id) throw new Error('Final output missing');
      outputs[port] = id;
    }
    await ctx.db.patch(run._id, { status: 'completed', outputs });
    return null;
  },
});
