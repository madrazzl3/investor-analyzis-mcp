// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflowTest from '@convex-dev/workflow/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
import { fakeOutput } from '../../convex/analysis/fake';
import type { Id } from '../../convex/_generated/dataModel';

// Proves the run read surface (step-tagged artifacts, manifests, listings) is
// scoped to organization members, and that publish enforces evidence provenance.
const modules = import.meta.glob('../../convex/**/*.{ts,js}');
const issuer = 'https://synthetic-auth.invalid';
const page = { numItems: 50, cursor: null };
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  const ids = await t.run(async (ctx) => {
    const org = await ctx.db.insert('organizations', { name: 'Alice org' });
    const bobOrg = await ctx.db.insert('organizations', { name: 'Bob org' });
    const member = (organizationId: Id<'organizations'>, subject: string) =>
      ctx.db.insert('memberships', {
        organizationId,
        issuer,
        subject,
        role: 'owner',
      });
    await member(org, 'alice');
    const carolMembership = await member(org, 'carol');
    await member(bobOrg, 'bob');
    return { org, bobOrg, carolMembership };
  });
  const as = (subject: string) => t.withIdentity({ issuer, subject });
  const alice = as('alice'),
    bob = as('bob'),
    carol = as('carol');
  // Cases and fixtures go through the app's own mutations.
  const caseId = await alice.mutation(api.cases.create, {
    organizationId: ids.org,
    name: 'Alice case',
  });
  const documentId = await alice.mutation(api.cases.addSyntheticDocument, {
    caseId,
  });
  const bobCase = await bob.mutation(api.cases.create, {
    organizationId: ids.bobOrg,
    name: 'Bob case',
  });
  const bobDocument = await bob.mutation(api.cases.addSyntheticDocument, {
    caseId: bobCase,
  });
  return {
    t,
    alice,
    bob,
    carol,
    ...ids,
    caseId,
    documentId,
    bobCase,
    bobDocument,
  };
}
type S = Awaited<ReturnType<typeof setup>>;
const startAlice = (s: S, requestId = 'alice-run') =>
  s.alice.mutation(api.runs.start, {
    caseId: s.caseId,
    requestId,
    documentVersionIds: [s.documentId],
  });
async function claim(s: S, runId: Id<'analysisRuns'>, stepId: string) {
  const result = await s.t.mutation(internal.analysis.state.begin, {
    runId,
    stepId,
  });
  if (result.completed) throw new Error('Expected new attempt');
  return result.attemptId;
}
const artifactsOf = (s: S, runId: Id<'analysisRuns'>) =>
  s.t.run((ctx) =>
    ctx.db
      .query('artifacts')
      .withIndex('by_run', (q) => q.eq('runId', runId))
      .collect(),
  );

describe('run read surface authorization', () => {
  it('tags every artifact with its producing step for owners and same-org members', async () => {
    const s = await setup(),
      runId = await startAlice(s);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    for (const caller of [s.alice, s.carol]) {
      const { run, steps } = await caller.query(api.runs.get, { runId });
      expect(run.status).toBe('completed');
      const listed = await caller.query(api.runs.artifacts, {
        runId,
        paginationOpts: page,
      });
      expect(listed.page.map((a) => `${a.stepId}:${a.output}`).sort()).toEqual([
        'consistency:findings',
        'extract:claims',
        'report:report',
        'verify:verifiedFindings',
      ]);
      // stepId comes from the artifact's own agentRun, not the port name.
      for (const artifact of listed.page)
        expect(
          steps.find((step) => step._id === artifact.agentRunId)!.stepId,
        ).toBe(artifact.stepId);
      const report = await caller.query(api.runs.getArtifact, {
        artifactId: run.outputs.report!,
      });
      expect(report.stepId).toBe('report');
      expect(
        (await caller.query(api.runs.contexts, { runId, paginationOpts: page }))
          .page,
      ).toHaveLength(4);
    }
  });

  it('refuses other tenants and unauthenticated callers on every run function', async () => {
    const s = await setup(),
      runId = await startAlice(s);
    for (const [caller, error] of [
      [s.bob, 'Access denied'],
      [s.t, 'Authentication required'],
    ] as const) {
      await expect(caller.query(api.runs.get, { runId })).rejects.toThrow(
        error,
      );
      await expect(
        caller.query(api.runs.artifacts, { runId, paginationOpts: page }),
      ).rejects.toThrow(error);
      await expect(
        caller.query(api.runs.contexts, { runId, paginationOpts: page }),
      ).rejects.toThrow(error);
      await expect(
        caller.query(api.runs.list, { caseId: s.caseId, paginationOpts: page }),
      ).rejects.toThrow(error);
      await expect(caller.mutation(api.runs.cancel, { runId })).rejects.toThrow(
        error,
      );
      await expect(caller.mutation(api.runs.resume, { runId })).rejects.toThrow(
        error,
      );
    }
    await expect(s.t.query(api.runs.capabilities, {})).rejects.toThrow(
      'Authentication required',
    );
    // Refused cancellation had no effect: the run still completes.
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await s.alice.query(api.runs.get, { runId })).run.status).toBe(
      'completed',
    );
    for (const artifact of await artifactsOf(s, runId)) {
      await expect(
        s.bob.query(api.runs.getArtifact, { artifactId: artifact._id }),
      ).rejects.toThrow('Access denied');
      await expect(
        s.t.query(api.runs.getArtifact, { artifactId: artifact._id }),
      ).rejects.toThrow('Authentication required');
    }
  });

  it("scopes listings to the caller's case and refuses another tenant's documents", async () => {
    const s = await setup(),
      aliceRun = await startAlice(s);
    const bobRun = await s.bob.mutation(api.runs.start, {
      caseId: s.bobCase,
      requestId: 'bob-run',
      documentVersionIds: [s.bobDocument],
    });
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const aliceArtifacts = new Set(
      (await artifactsOf(s, aliceRun)).map((a) => a._id),
    );
    const bobRuns = await s.bob.query(api.runs.list, {
      caseId: s.bobCase,
      paginationOpts: page,
    });
    expect(bobRuns.page.map((r) => r._id)).toEqual([bobRun]);
    const bobArtifacts = await s.bob.query(api.runs.artifacts, {
      runId: bobRun,
      paginationOpts: page,
    });
    expect(bobArtifacts.page).toHaveLength(4);
    expect(bobArtifacts.page.some((a) => aliceArtifacts.has(a._id))).toBe(
      false,
    );
    const aliceRuns = await s.alice.query(api.runs.list, {
      caseId: s.caseId,
      paginationOpts: page,
    });
    expect(aliceRuns.page.map((r) => r._id)).toEqual([aliceRun]);
    // Bob cannot analyze Alice's fixture inside his own case.
    await expect(
      s.bob.mutation(api.runs.start, {
        caseId: s.bobCase,
        requestId: 'steal',
        documentVersionIds: [s.documentId],
      }),
    ).rejects.toThrow('Source access denied');
    await expect(
      s.bob.mutation(api.cases.addSyntheticDocument, { caseId: s.caseId }),
    ).rejects.toThrow('Access denied');
    expect(
      (
        await s.bob.query(api.runs.list, {
          caseId: s.bobCase,
          paginationOpts: page,
        })
      ).page,
    ).toHaveLength(1);
  });

  it('cuts off a member as soon as their membership is removed', async () => {
    const s = await setup(),
      runId = await startAlice(s);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [artifact] = await artifactsOf(s, runId);
    await s.carol.query(api.runs.getArtifact, { artifactId: artifact!._id });
    await s.t.run((ctx) => ctx.db.delete(s.carolMembership));
    await expect(
      s.carol.query(api.runs.artifacts, { runId, paginationOpts: page }),
    ).rejects.toThrow('Access denied');
    await expect(
      s.carol.query(api.runs.getArtifact, { artifactId: artifact!._id }),
    ).rejects.toThrow('Access denied');
  });
});

describe('evidence provenance at publish', () => {
  it("rejects citations of a document that is not one of the run's inputs", async () => {
    const s = await setup(),
      runId = await startAlice(s);
    // Same case, same organization, real ID — but not frozen into this run.
    const sibling = await s.t.run((ctx) =>
      ctx.db.insert('documentVersions', {
        caseId: s.caseId,
        name: 'Unselected fixture',
        synthetic: true,
      }),
    );
    const attemptId = await claim(s, runId, 'extract');
    for (const documentVersionId of [sibling, s.bobDocument])
      await expect(
        s.t.mutation(internal.analysis.state.publish, {
          attemptId,
          outputs: {
            claims: [
              {
                id: 'c',
                text: 'text',
                evidence: [{ documentVersionId, quote: 'q', page: 1 }],
              },
            ],
          },
        }),
      ).rejects.toThrow('Foreign evidence reference');
    expect(await artifactsOf(s, runId)).toHaveLength(0);
    const { steps } = await s.alice.query(api.runs.get, { runId });
    expect(steps.find((step) => step.stepId === 'extract')!.status).toBe(
      'running',
    );
  });

  it('lets a step without attachments cite only evidence present in its inputs', async () => {
    const s = await setup(),
      runId = await startAlice(s);
    for (const stepId of ['extract', 'consistency', 'verify'])
      await s.t.action(internal.analysis.execute.step, { runId, stepId });
    const attemptId = await claim(s, runId, 'report');
    const context = await s.t.query(internal.analysis.state.context, {
      attemptId,
    });
    const withEvidence = (quote: string, page: number) => {
      const outputs = fakeOutput(context.agent.id, context.inputs) as {
        report: { findings: { evidence: unknown[] }[] };
      };
      outputs.report.findings[0]!.evidence = [
        { documentVersionId: s.documentId, quote, page },
      ];
      return outputs;
    };
    for (const outputs of [
      // Real run document, but a quote the step was never given.
      withEvidence('Revenue grew 400% year over year.', 1),
      // Given quote, wrong page.
      withEvidence('Synthetic fixture quote; no document was analyzed.', 2),
      withEvidence('   ', 1),
    ])
      await expect(
        s.t.mutation(internal.analysis.state.publish, { attemptId, outputs }),
      ).rejects.toThrow('Evidence quote not found in step inputs');
    expect(await artifactsOf(s, runId)).toHaveLength(3);
    // A contiguous excerpt differing only in case and whitespace is accepted.
    const saved = await s.t.mutation(internal.analysis.state.publish, {
      attemptId,
      outputs: withEvidence('SYNTHETIC   fixture\nquote', 1),
    });
    const report = await s.alice.query(api.runs.getArtifact, {
      artifactId: saved.report!,
    });
    expect(report.stepId).toBe('report');
    expect(report.payload.findings[0].evidence[0].quote).toBe(
      'SYNTHETIC   fixture\nquote',
    );
  });
});

describe('delegated MCP access to runs', () => {
  const site = 'https://test.convex.site';
  const provider = 'https://example.authkit.app';
  beforeEach(() => {
    vi.stubEnv('CONVEX_SITE_URL', site);
    vi.stubEnv('WORKOS_AUTHKIT_ISSUER', provider);
    vi.stubEnv('WORKOS_API_KEY', 'test-provider-key');
    vi.stubEnv('MCP_RESOURCE_URL', 'https://mcp.example/mcp');
    vi.stubEnv('MCP_BRIDGE_JWKS', '{"keys":[]}');
  });

  it('confines a delegated token to its granted workspace even where the user is also a member', async () => {
    const t = convexTest(schema, modules);
    workflowTest.register(t);
    const userId = await t.run((ctx) =>
      ctx.db.insert('users', { email: 'alice@example.invalid' }),
    );
    const alice = t.withIdentity({ issuer: site, subject: `${userId}|s1` });
    const granted = await alice.mutation(api.organizations.createPersonal, {});
    const other = await t.run(async (ctx) => {
      const id = await ctx.db.insert('organizations', { name: 'Other' });
      await ctx.db.insert('memberships', {
        organizationId: id,
        issuer: site,
        subject: userId,
        role: 'owner',
      });
      return id;
    });
    const runIn = async (organizationId: Id<'organizations'>) => {
      const caseId = await alice.mutation(api.cases.create, {
        organizationId,
        name: 'Case',
      });
      const documentId = await alice.mutation(api.cases.addSyntheticDocument, {
        caseId,
      });
      const runId = await alice.mutation(api.runs.start, {
        caseId,
        requestId: 'run',
        documentVersionIds: [documentId],
      });
      return { caseId, documentId, runId };
    };
    const inGrant = await runIn(granted),
      outside = await runIn(other);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const prepared = await alice.mutation(internal.mcpConnections.prepare, {
      organizationId: granted,
      externalAuthId: 'ext_auth_test_123456789',
    });
    await alice.mutation(internal.mcpConnections.activate, {
      connectionId: prepared.connectionId,
      providerSubject: 'user_workos_alice',
    });
    await t.mutation(internal.mcpConnections.bindConsent, {
      connectionId: prepared.connectionId,
      consentId: 'consent_one',
      providerSubject: 'user_workos_alice',
      providerIssuer: provider,
    });
    const delegated = t.withIdentity({
      issuer: `${site}/mcp-bridge`,
      subject: 'user_workos_alice',
      mcpConnectionId: prepared.connectionId,
      mcpConsentId: 'consent_one',
    });

    // Positive: the granted workspace is fully readable through the bridge.
    const { run } = await delegated.query(api.runs.get, {
      runId: inGrant.runId,
    });
    expect(run.status).toBe('completed');
    expect(
      (
        await delegated.query(api.runs.artifacts, {
          runId: inGrant.runId,
          paginationOpts: page,
        })
      ).page,
    ).toHaveLength(4);

    // Negative: the same user's other workspace is not.
    const { run: outsideRun } = await alice.query(api.runs.get, {
      runId: outside.runId,
    });
    const denied = [
      () => delegated.query(api.runs.get, { runId: outside.runId }),
      () =>
        delegated.query(api.runs.artifacts, {
          runId: outside.runId,
          paginationOpts: page,
        }),
      () =>
        delegated.query(api.runs.contexts, {
          runId: outside.runId,
          paginationOpts: page,
        }),
      () =>
        delegated.query(api.runs.getArtifact, {
          artifactId: outsideRun.outputs.report!,
        }),
      () =>
        delegated.query(api.runs.list, {
          caseId: outside.caseId,
          paginationOpts: page,
        }),
      () =>
        delegated.mutation(api.runs.start, {
          caseId: outside.caseId,
          requestId: 'delegated',
          documentVersionIds: [outside.documentId],
        }),
      () => delegated.mutation(api.runs.cancel, { runId: outside.runId }),
      () => delegated.mutation(api.runs.resume, { runId: outside.runId }),
    ];
    for (const call of denied)
      await expect(call()).rejects.toThrow('Access denied');
    expect(
      (await alice.query(api.runs.get, { runId: outside.runId })).run.status,
    ).toBe('completed');

    // Revoking the grant cuts off the granted workspace too.
    await alice.mutation(api.mcpConnections.revoke, {
      connectionId: prepared.connectionId,
    });
    await expect(
      delegated.query(api.runs.artifacts, {
        runId: inGrant.runId,
        paginationOpts: page,
      }),
    ).rejects.toThrow('revoked');
  });
});
