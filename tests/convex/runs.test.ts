// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflowTest from '@convex-dev/workflow/test';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
import { fakeOutput } from '../../convex/analysis/fake';
import type { Id } from '../../convex/_generated/dataModel';

const modules = import.meta.glob('../../convex/**/*.{ts,js}');
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
async function setup() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  const issuer = 'https://synthetic-auth.invalid';
  const ids = await t.run(async (ctx) => {
    const org = await ctx.db.insert('organizations', {
      name: 'Synthetic organization',
    });
    const otherOrg = await ctx.db.insert('organizations', {
      name: 'Other synthetic organization',
    });
    const owner = await ctx.db.insert('memberships', {
      organizationId: org,
      issuer,
      subject: 'alice',
      role: 'owner',
    });
    await ctx.db.insert('memberships', {
      organizationId: otherOrg,
      issuer,
      subject: 'bob',
      role: 'owner',
    });
    const caseId = await ctx.db.insert('cases', {
      organizationId: org,
      name: 'Synthetic test case',
      createdBy: owner,
    });
    const documentId = await ctx.db.insert('documentVersions', {
      caseId,
      name: 'Synthetic document',
      synthetic: true,
    });
    return { org, owner, caseId, documentId };
  });
  return {
    t,
    alice: t.withIdentity({ issuer, subject: 'alice' }),
    bob: t.withIdentity({ issuer, subject: 'bob' }),
    ...ids,
  };
}
async function manualRun(s: Awaited<ReturnType<typeof setup>>) {
  // Public start registers a durable workflow; leave timers paused for step-level tests.
  return s.alice.mutation(api.runs.start, {
    caseId: s.caseId,
    requestId: 'manual',
    documentVersionIds: [s.documentId],
  });
}
function outputsOf(result: { status: string; outputs?: unknown }) {
  if (result.status !== 'completed') throw new Error('Expected completion');
  return result.outputs;
}
async function claim(
  s: Awaited<ReturnType<typeof setup>>,
  runId: Id<'analysisRuns'>,
  stepId = 'extract',
) {
  const result = await s.t.mutation(internal.analysis.state.begin, {
    runId,
    stepId,
  });
  if (result.completed) throw new Error('Expected new attempt');
  return result.attemptId;
}

describe('Convex workflow and case authorization', () => {
  it('marks workflow failure and resumes its frozen run after access is restored', async () => {
    const s = await setup(),
      runId = await manualRun(s);
    const published = await s.t.action(internal.analysis.execute.step, {
      runId,
      stepId: 'extract',
    });
    const other = await s.t.run((ctx) =>
      ctx.db.insert('organizations', { name: 'Temporary test revocation' }),
    );
    await s.t.run((ctx) => ctx.db.patch(s.owner, { organizationId: other }));
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const snapshotId = await s.t.run(async (ctx) => {
      const run = await ctx.db.get(runId);
      expect(run?.status).toBe('failed');
      return run!.snapshotId;
    });
    await s.t.run((ctx) => ctx.db.patch(s.owner, { organizationId: s.org }));
    await expect(s.bob.mutation(api.runs.resume, { runId })).rejects.toThrow(
      'Access denied',
    );
    await s.alice.mutation(api.runs.resume, { runId });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const result = await s.alice.query(api.runs.get, { runId });
    expect(result.run.status).toBe('completed');
    expect(result.run.snapshotId).toBe(snapshotId);
    expect(
      result.steps.find((step) => step.stepId === 'extract')!.outputs,
    ).toEqual(outputsOf(published));
    expect(result.run.calls).toBe(4);
  });

  it('completes via real Workflow component scheduling and retains artifacts after a new client connects', async () => {
    const s = await setup();
    const runId = await manualRun(s);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const fresh = s.t.withIdentity({
      issuer: 'https://synthetic-auth.invalid',
      subject: 'alice',
    });
    const { run, steps } = await fresh.query(api.runs.get, { runId });
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(4);
    expect(steps.every((step) => step.status === 'completed')).toBe(true);
    const artifacts = await fresh.query(api.runs.artifacts, {
      runId,
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(artifacts.page).toHaveLength(4);
    const report = await fresh.query(api.runs.getArtifact, {
      artifactId: run.outputs.report!,
    });
    expect(report.payload.summary).toContain('Synthetic');
    expect(report.inputArtifactIds).toHaveLength(1);
    await s.t.run(async (ctx) => {
      expect(
        await ctx.db
          .query('contextManifests')
          .withIndex('by_run', (q) => q.eq('runId', runId))
          .collect(),
      ).toHaveLength(4);
    });
    const repeated = await s.t.action(internal.analysis.execute.step, {
      runId,
      stepId: 'extract',
    });
    expect(repeated).toEqual({
      status: 'completed',
      outputs: steps.find((step) => step.stepId === 'extract')!.outputs,
    });
    expect((await fresh.query(api.runs.get, { runId })).run.calls).toBe(4);
  });
  it('deduplicates starts and rejects input changes under the same request ID', async () => {
    const s = await setup(),
      runId = await manualRun(s);
    expect(await manualRun(s)).toBe(runId);
    const extra = await s.t.run((ctx) =>
      ctx.db.insert('documentVersions', {
        caseId: s.caseId,
        name: 'second synthetic',
        synthetic: true,
      }),
    );
    await expect(
      s.alice.mutation(api.runs.start, {
        caseId: s.caseId,
        requestId: 'manual',
        documentVersionIds: [extra],
      }),
    ).rejects.toThrow('Idempotency');
    expect(
      (
        await s.alice.query(api.runs.list, {
          caseId: s.caseId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page,
    ).toHaveLength(1);
  });
  it('denies unauthenticated and cross-tenant reads, starts, cancellation, and artifacts', async () => {
    const s = await setup(),
      runId = await manualRun(s);
    for (const caller of [s.t, s.bob]) {
      await expect(caller.query(api.runs.get, { runId })).rejects.toThrow();
      await expect(
        caller.mutation(api.runs.start, {
          caseId: s.caseId,
          requestId: 'unauthorized',
          documentVersionIds: [s.documentId],
        }),
      ).rejects.toThrow();
      await expect(
        caller.mutation(api.runs.cancel, { runId }),
      ).rejects.toThrow();
      await expect(
        caller.query(api.cases.list, { organizationId: s.org }),
      ).rejects.toThrow();
    }
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const { run } = await s.alice.query(api.runs.get, { runId });
    await expect(
      s.bob.query(api.runs.getArtifact, { artifactId: run.outputs.report! }),
    ).rejects.toThrow();
    await expect(
      s.t.query(api.runs.getArtifact, { artifactId: run.outputs.report! }),
    ).rejects.toThrow();
  });
  it('rejects documents from a different case even within the same organization', async () => {
    const s = await setup();
    const otherCase = await s.alice.mutation(api.cases.create, {
      organizationId: s.org,
      name: 'other case',
    });
    await expect(
      s.alice.mutation(api.runs.start, {
        caseId: otherCase,
        requestId: 'bad-source',
        documentVersionIds: [s.documentId],
      }),
    ).rejects.toThrow('Source access denied');
  });
  it('publishes atomically, rejects foreign evidence, and does not overwrite on duplicate publication', async () => {
    const s = await setup(),
      runId = await manualRun(s),
      attemptId = await claim(s, runId);
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId,
        outputs: {
          claims: [
            {
              id: 'claim',
              text: 'text',
              evidence: [{ documentVersionId: 'foreign', quote: 'q', page: 1 }],
            },
          ],
        },
      }),
    ).rejects.toThrow('Foreign evidence');
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId,
        outputs: { claims: 'wrong' },
      }),
    ).rejects.toThrow('schema');
    expect(
      (
        await s.alice.query(api.runs.artifacts, {
          runId,
          paginationOpts: { numItems: 20, cursor: null },
        })
      ).page,
    ).toHaveLength(0);
    const context = await s.t.query(internal.analysis.state.context, {
      attemptId,
    });
    const outputs = fakeOutput(context.agent.id, context.inputs);
    const saved = await s.t.mutation(internal.analysis.state.publish, {
      attemptId,
      outputs,
    });
    expect(
      await s.t.mutation(internal.analysis.state.publish, {
        attemptId,
        outputs: { claims: [] },
      }),
    ).toEqual(saved);
    const artifact = await s.alice.query(api.runs.getArtifact, {
      artifactId: saved.claims!,
    });
    expect(artifact.payload).toHaveLength(1);
  });
  it('supersedes interrupted attempts, blocks stale writes, and enforces attempt budgets', async () => {
    const s = await setup(),
      runId = await manualRun(s),
      old = await claim(s, runId),
      current = await claim(s, runId);
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId: old,
        outputs: { claims: [] },
      }),
    ).rejects.toThrow('Stale');
    await expect(claim(s, runId)).rejects.toThrow('budget');
    await s.t.mutation(internal.analysis.state.publish, {
      attemptId: current,
      outputs: { claims: [] },
    });
    expect((await s.alice.query(api.runs.get, { runId })).run.calls).toBe(2);
  });
  it('cancellation rejects in-flight output publication', async () => {
    const s = await setup(),
      runId = await manualRun(s),
      attemptId = await claim(s, runId);
    await s.alice.mutation(api.runs.cancel, { runId });
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId,
        outputs: { claims: [] },
      }),
    ).rejects.toThrow('terminal');
    expect((await s.alice.query(api.runs.get, { runId })).run.status).toBe(
      'cancelled',
    );
  });
  it('rechecks initiator membership before publishing and reading results', async () => {
    const s = await setup(),
      runId = await manualRun(s),
      attemptId = await claim(s, runId);
    await s.t.run((ctx) => ctx.db.delete(s.owner));
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId,
        outputs: { claims: [] },
      }),
    ).rejects.toThrow('revoked');
    await expect(s.alice.query(api.runs.get, { runId })).rejects.toThrow(
      'Access denied',
    );
  });
  it('resumes a partially completed run without regenerating published artifacts', async () => {
    const s = await setup(),
      runId = await manualRun(s);
    const published = await s.t.action(internal.analysis.execute.step, {
      runId,
      stepId: 'extract',
    });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const { run, steps } = await s.alice.query(api.runs.get, { runId });
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(4);
    expect(steps.find((s) => s.stepId === 'extract')!.outputs).toEqual(
      outputsOf(published),
    );
  });
});
