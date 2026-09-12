import {
  start as startWorkflow,
  cancel as cancelWorkflow,
  restart as restartWorkflow,
} from '@convex-dev/workflow';
import { paginationOptsValidator } from 'convex/server';
import { mutation, query, type QueryCtx } from './_generated/server';
import { components, internal } from './_generated/api';
import { v, ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { requireCase, requireRun } from './access';
import {
  approvedFor,
  assertSupported,
  liveAnalysisEnabled,
  type RunMode,
  type SnapshotBundle,
} from './analysis/registry';
import { sourceMatches } from './analysis/state';
import { requireIdentity } from './identity';
export const start = mutation({
  args: {
    caseId: v.id('cases'),
    requestId: v.string(),
    documentVersionIds: v.array(v.id('documentVersions')),
  },
  handler: async (ctx, args): Promise<Id<'analysisRuns'>> => {
    const { item, member } = await requireCase(ctx, args.caseId);
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(args.requestId))
      throw new ConvexError('Invalid request ID');
    if (
      args.documentVersionIds.length < 1 ||
      args.documentVersionIds.length > 10 ||
      new Set(args.documentVersionIds).size !== args.documentVersionIds.length
    )
      throw new ConvexError('Choose 1–10 distinct documents');
    // Inputs decide the mode: fixtures run fake agents, uploads run Grok.
    // A requested real analysis is never substituted with synthetic output.
    const docs = await Promise.all(
      args.documentVersionIds.map((id) => ctx.db.get(id)),
    );
    const mode: RunMode = docs[0]?.synthetic ? 'synthetic' : 'live';
    if (!docs.every((doc) => sourceMatches(doc, args.caseId, mode)))
      throw new ConvexError(
        docs.every((doc) => doc?.caseId === args.caseId)
          ? 'Do not mix synthetic fixtures with uploaded documents'
          : 'Source access denied',
      );
    const existing = await ctx.db
      .query('analysisRuns')
      .withIndex('by_case_request', (q) =>
        q.eq('caseId', args.caseId).eq('requestId', args.requestId),
      )
      .unique();
    if (existing) {
      if (
        JSON.stringify(existing.documentVersionIds) !==
        JSON.stringify(args.documentVersionIds)
      )
        throw new ConvexError('Idempotency key reused with different inputs');
      return existing._id;
    }
    if (mode === 'live' && !liveAnalysisEnabled())
      throw new ConvexError('Live analysis is not enabled on this deployment');
    const approved = approvedFor(mode);
    const snapshot = await ctx.db
      .query('configurationSnapshots')
      .withIndex('by_hash', (q) => q.eq('hash', approved.configHash))
      .unique();
    const snapshotId =
      snapshot?._id ??
      (await ctx.db.insert('configurationSnapshots', {
        hash: approved.configHash,
        bundleJson: JSON.stringify(approved.bundle),
      }));
    const runId = await ctx.db.insert('analysisRuns', {
      caseId: item._id,
      organizationId: item.organizationId,
      createdBy: member._id,
      requestId: args.requestId,
      documentVersionIds: args.documentVersionIds,
      mode,
      snapshotId,
      status: 'queued',
      calls: 0,
      outputs: {},
    });
    for (const [stepId, step] of Object.entries(approved.bundle.workflow.steps))
      await ctx.db.insert('agentRuns', {
        runId,
        stepId,
        agent: step.agent,
        status: 'pending',
        attempts: 0,
        outputs: {},
      });
    const workflowId = await startWorkflow(
      ctx,
      internal.analysis.workflow.diligence,
      { runId },
      {
        startAsync: true,
        onComplete: internal.analysis.workflow.onComplete,
        context: { runId },
      },
    );
    await ctx.db.patch(runId, { workflowId });
    return runId;
  },
});
export const get = query({
  args: { runId: v.id('analysisRuns') },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    const steps = await ctx.db
      .query('agentRuns')
      .withIndex('by_run', (q) => q.eq('runId', run._id))
      .collect();
    const attempts = await ctx.db
      .query('agentAttempts')
      .withIndex('by_run', (q) => q.eq('runId', run._id))
      .collect();
    return {
      run: { ...run, mode: run.mode ?? ('synthetic' as const) },
      steps,
      // Sanitized error categories and provider usage; no prompts or bodies.
      attempts: attempts.map((a) => ({
        agentRunId: a.agentRunId,
        number: a.number,
        status: a.status,
        error: a.error,
        model: a.provider?.model,
        usage: a.provider?.usage,
      })),
    };
  },
});
/** Whether this deployment accepts live (paid) analysis of uploaded documents. */
export const capabilities = query({
  args: {},
  handler: async (ctx) => {
    await requireIdentity(ctx);
    return { liveAnalysis: liveAnalysisEnabled() };
  },
});
export const list = query({
  args: { caseId: v.id('cases'), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireCase(ctx, args.caseId);
    return ctx.db
      .query('analysisRuns')
      .withIndex('by_case', (q) => q.eq('caseId', args.caseId))
      .order('desc')
      .paginate(args.paginationOpts);
  },
});
export const getArtifact = query({
  args: { artifactId: v.id('artifacts') },
  handler: async (ctx, args) => {
    await requireIdentity(ctx);
    const artifact = await ctx.db.get(args.artifactId);
    if (!artifact) throw new ConvexError('Access denied');
    await requireRun(ctx, artifact.runId);
    return withStep(ctx, artifact);
  },
});
// Several council steps share an output port name, so name the producing step.
async function withStep(ctx: QueryCtx, artifact: Doc<'artifacts'>) {
  const stage = await ctx.db.get(artifact.agentRunId);
  return { ...artifact, stepId: stage?.stepId ?? null };
}
export const artifacts = query({
  args: {
    runId: v.id('analysisRuns'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireRun(ctx, args.runId);
    const page = await ctx.db
      .query('artifacts')
      .withIndex('by_run', (q) => q.eq('runId', args.runId))
      .paginate(args.paginationOpts);
    return {
      ...page,
      page: await Promise.all(page.page.map((a) => withStep(ctx, a))),
    };
  },
});
export const cancel = mutation({
  args: { runId: v.id('analysisRuns') },
  handler: async (ctx, args) => {
    const run = await requireRun(ctx, args.runId);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return;
    await ctx.db.patch(run._id, { status: 'cancelled' });
    if (run.workflowId)
      await cancelWorkflow(ctx, components.workflow, run.workflowId);
  },
});

export const contexts = query({
  args: {
    runId: v.id('analysisRuns'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireRun(ctx, args.runId);
    return ctx.db
      .query('contextManifests')
      .withIndex('by_run', (q) => q.eq('runId', args.runId))
      .paginate(args.paginationOpts);
  },
});

export const resume = mutation({
  args: { runId: v.id('analysisRuns') },
  handler: async (ctx, args): Promise<Id<'analysisRuns'>> => {
    const run = await requireRun(ctx, args.runId);
    if (
      run.status === 'running' ||
      run.status === 'queued' ||
      run.status === 'completed'
    )
      return run._id;
    if (run.status === 'cancelled' || !run.workflowId)
      throw new ConvexError('Create a new run after cancellation');
    const member = await ctx.db.get(run.createdBy);
    if (!member || member.organizationId !== run.organizationId)
      throw new ConvexError('Initiator access revoked');
    if (run.mode === 'live' && !liveAnalysisEnabled())
      throw new ConvexError('Live analysis is not enabled on this deployment');
    const snapshot = await ctx.db.get(run.snapshotId);
    if (!snapshot) throw new ConvexError('Snapshot missing');
    assertSupported(snapshot.hash, run.mode ?? 'synthetic');
    const bundle = JSON.parse(snapshot.bundleJson) as SnapshotBundle;
    const stages = await ctx.db
      .query('agentRuns')
      .withIndex('by_run', (q) => q.eq('runId', run._id))
      .collect();
    if (
      run.calls >= bundle.workflow.limits.maxModelCalls ||
      stages.some(
        (stage) =>
          stage.status !== 'completed' &&
          stage.attempts >= bundle.agents[stage.agent]!.retry.maxAttempts,
      )
    )
      throw new ConvexError('Run retry budget exhausted');
    await ctx.db.patch(run._id, { status: 'queued', error: undefined });
    // Replay orchestration; accepted application artifacts are reused by begin().
    await restartWorkflow(ctx, components.workflow, run.workflowId, {
      from: 0,
      startAsync: true,
    });
    return run._id;
  },
});
