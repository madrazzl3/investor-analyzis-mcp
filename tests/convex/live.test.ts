// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflowTest from '@convex-dev/workflow/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

// Grok is simulated at the HTTP boundary. No request leaves the test process.
const modules = import.meta.glob('../../convex/**/*.{ts,js}');
const issuer = 'https://test.invalid';

type Call = { url: string; method: string; body: unknown; auth: string | null };
type Reply = (port: string, inputs: Record<string, unknown>) => Response;

function payload(port: string, inputs: Record<string, unknown>) {
  if (port === 'report')
    return {
      report: {
        ...(inputs.verifiedFindings as object),
        summary: 'One unresolved revenue-definition question.',
        requestedMaterials: ['Monthly revenue by customer'],
      },
    };
  const documents = inputs.documents as { documentVersionId: string }[];
  const evidence = (page: number | null) => [
    {
      documentVersionId: documents[0]!.documentVersionId,
      quote: 'Annual recurring revenue of $2.4M',
      page,
    },
  ];
  const finding = {
    id: 'f1',
    category: 'cross_document',
    statement: 'The deck and call describe ARR differently.',
    severity: 'high',
    evidence: evidence(null),
    alternativeExplanation: 'The figures may cover different periods.',
    followUpQuestion: 'What portion of ARR is contracted recurring revenue?',
  };
  const verified = {
    findings: [
      { ...finding, disposition: 'unresolved', verificationNote: 'Checked.' },
    ],
    coverage: 'Both documents were attached; charts were not interpreted.',
  };
  if (port === 'claims')
    return {
      claims: [
        {
          id: 'c1',
          topic: 'financial',
          text: 'ARR $2.4M',
          evidence: evidence(3),
        },
      ],
    };
  if (port === 'findings') return { findings: [finding] };
  return { verifiedFindings: verified };
}
const ok: Reply = (port, inputs) =>
  Response.json({
    id: `response-${port}`,
    status: 'completed',
    model: 'grok-4.6-0901',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: JSON.stringify(payload(port, inputs)) },
        ],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
  });

function provider(reply: Reply = ok) {
  const calls: Call[] = [];
  let files = 0;
  const fetcher = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body =
      init.body instanceof FormData
        ? (init.body.get('file') as File).name
        : typeof init.body === 'string'
          ? JSON.parse(init.body)
          : null;
    calls.push({
      url: String(url),
      method,
      body,
      auth: new Headers(init.headers).get('authorization'),
    });
    if (String(url) === 'https://api.x.ai/v1/files' && method === 'POST')
      return Response.json({ id: `file-${++files}` });
    if (String(url).startsWith('https://api.x.ai/v1/files/'))
      return Response.json({ deleted: true });
    if (String(url) === 'https://api.x.ai/v1/responses') {
      const request = body as {
        input: { content: { type: string; text?: string }[] }[];
        text: { format: { schema: { required: string[] } } };
      };
      const inputs = JSON.parse(request.input[1]!.content[0]!.text!);
      return reply(request.text.format.schema.required[0]!, inputs);
    }
    return new Response('unexpected', { status: 500 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { calls, fetcher };
}

async function setup() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  const { caseId, owner } = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert('organizations', {
      name: 'Fixtures',
    });
    const owner = await ctx.db.insert('memberships', {
      organizationId,
      issuer,
      subject: 'alice',
      role: 'owner',
    });
    const caseId = await ctx.db.insert('cases', {
      organizationId,
      name: 'Synthetic live case',
      createdBy: owner,
    });
    return { caseId, owner };
  });
  const alice = t.withIdentity({ issuer, subject: 'alice' });
  const upload = async (requestId: string, name: string, text: string) =>
    (
      await alice.action(api.documents.upload, {
        caseId,
        requestId,
        name,
        contentType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain',
        base64: btoa(text),
      })
    ).documentVersionId;
  const deck = await upload('deck', 'deck.pdf', '%PDF-1.7\nSynthetic deck');
  const call = await upload('call', 'call.txt', 'Synthetic founder call');
  const start = (requestId = 'live-1', ids = [deck, call]) =>
    alice.mutation(api.runs.start, {
      caseId,
      requestId,
      documentVersionIds: ids,
    });
  return { t, alice, caseId, owner, deck, call, start };
}
const finish = (s: Awaited<ReturnType<typeof setup>>) =>
  s.t.finishAllScheduledFunctions(vi.runAllTimers);
const providerFiles = (s: Awaited<ReturnType<typeof setup>>) =>
  s.t.run((ctx) => ctx.db.query('providerFiles').collect());

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('LIVE_ANALYSIS_ENABLED', 'true');
  vi.stubEnv('XAI_API_KEY', 'test-key');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('live Grok workflow', () => {
  it('analyzes uploaded documents through Grok, records usage, and deletes provider copies', async () => {
    const s = await setup();
    const { calls } = provider();
    const runId = await s.start();
    await finish(s);
    const { run, steps, attempts } = await s.alice.query(api.runs.get, {
      runId,
    });
    expect(run.status).toBe('completed');
    expect(run.mode).toBe('live');
    expect(run.calls).toBe(4);
    expect(steps.every((step) => step.status === 'completed')).toBe(true);
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) {
      expect(attempt.model).toBe('grok-4.6-0901');
      expect(attempt.usage).toEqual({
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
      });
    }
    const report = await s.alice.query(api.runs.getArtifact, {
      artifactId: run.outputs.report!,
    });
    expect(report.schema).toBe('report@2.0.0');
    expect(report.payload.findings[0].evidence[0].documentVersionId).toBe(
      s.deck,
    );

    // Every request went to xAI with the server-side key only.
    expect(calls.every((c) => c.url.startsWith('https://api.x.ai/v1/'))).toBe(
      true,
    );
    expect(calls.every((c) => c.auth === 'Bearer test-key')).toBe(true);
    const responses = calls.filter((c) => c.url.endsWith('/responses'));
    expect(responses).toHaveLength(4);
    const extract = responses.find(
      (c) =>
        (c.body as { text: { format: { schema: { required: string[] } } } })
          .text.format.schema.required[0] === 'claims',
    )!.body as Record<string, any>;
    expect(extract.model).toBe('grok-4.6');
    expect(extract.store).toBe(false);
    expect(extract.max_output_tokens).toBe(16000);
    expect(extract.text.format.strict).toBe(true);
    expect(
      extract.text.format.schema.properties.claims.$schema,
    ).toBeUndefined();
    expect(extract.input[0].content).toContain('Extract the company');
    expect(
      extract.input[1].content.filter(
        (part: { type: string }) => part.type === 'input_file',
      ),
    ).toHaveLength(2);
    // The report step receives verified JSON only, never attachments.
    const reportRequest = responses.find(
      (c) =>
        (c.body as { text: { format: { schema: { required: string[] } } } })
          .text.format.schema.required[0] === 'report',
    )!.body as Record<string, any>;
    expect(JSON.stringify(reportRequest)).not.toContain('input_file');

    // Two documents attached to three steps; each provider copy was deleted.
    const uploads = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/files'),
    );
    expect(uploads.map((c) => c.body).sort()).toEqual(
      [
        `${s.call}.txt`,
        `${s.call}.txt`,
        `${s.call}.txt`,
        `${s.deck}.pdf`,
        `${s.deck}.pdf`,
        `${s.deck}.pdf`,
      ].sort(),
    );
    const files = await providerFiles(s);
    expect(files).toHaveLength(6);
    expect(files.every((file) => file.status === 'deleted')).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(6);
  });

  it('refuses live analysis when disabled and never mixes fixtures with uploads', async () => {
    const s = await setup();
    const { fetcher } = provider();
    vi.stubEnv('LIVE_ANALYSIS_ENABLED', '');
    await expect(s.start()).rejects.toThrow('not enabled');
    const fixture = await s.alice.mutation(api.cases.addSyntheticDocument, {
      caseId: s.caseId,
    });
    await expect(s.start('mixed', [fixture, s.deck])).rejects.toThrow(
      'Do not mix',
    );
    await expect(s.start('mixed-2', [s.deck, fixture])).rejects.toThrow(
      'Do not mix',
    );
    // Synthetic fixtures still use the fake workflow without any provider call.
    const synthetic = await s.start('synthetic', [fixture]);
    await finish(s);
    const { run } = await s.alice.query(api.runs.get, { runId: synthetic });
    expect(run.mode).toBe('synthetic');
    expect(run.status).toBe('completed');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops before the next paid step when the kill switch is turned off', async () => {
    const s = await setup();
    const { calls } = provider();
    const runId = await s.start();
    await s.t.action(internal.analysis.execute.step, {
      runId,
      stepId: 'extract',
    });
    vi.stubEnv('LIVE_ANALYSIS_ENABLED', 'false');
    await finish(s);
    const { run } = await s.alice.query(api.runs.get, { runId });
    expect(run.status).toBe('failed');
    expect(calls.filter((c) => c.url.endsWith('/responses'))).toHaveLength(1);
    await expect(s.alice.mutation(api.runs.resume, { runId })).rejects.toThrow(
      'not enabled',
    );
    vi.stubEnv('LIVE_ANALYSIS_ENABLED', 'true');
    await s.alice.mutation(api.runs.resume, { runId });
    await finish(s);
    const resumed = await s.alice.query(api.runs.get, { runId });
    expect(resumed.run.status).toBe('completed');
    // The completed extract step was reused, not billed again.
    expect(calls.filter((c) => c.url.endsWith('/responses'))).toHaveLength(4);
  });

  it('retries classified provider failures within the attempt budget', async () => {
    const s = await setup();
    let limited = 1;
    provider((port, inputs) =>
      port === 'claims' && limited-- > 0
        ? new Response('secret prompt echo', { status: 429 })
        : ok(port, inputs),
    );
    const runId = await s.start();
    await finish(s);
    const { run, steps, attempts } = await s.alice.query(api.runs.get, {
      runId,
    });
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(5);
    const extract = steps.find((step) => step.stepId === 'extract')!;
    expect(extract.attempts).toBe(2);
    expect(
      attempts
        .filter((a) => a.agentRunId === extract._id)
        .map((a) => [a.status, a.error]),
    ).toEqual([
      ['failed', 'rate_limit'],
      ['completed', undefined],
    ]);
    expect((await providerFiles(s)).every((f) => f.status === 'deleted')).toBe(
      true,
    );
  });

  it('fails with a sanitized reason when retries are exhausted', async () => {
    const s = await setup();
    const { calls } = provider(
      () => new Response('secret prompt echo', { status: 503 }),
    );
    const runId = await s.start();
    await finish(s);
    const { run, steps } = await s.alice.query(api.runs.get, { runId });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('extract: provider_unavailable');
    expect(JSON.stringify(run)).not.toContain('secret');
    expect(steps.find((step) => step.stepId === 'extract')!.attempts).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/responses'))).toHaveLength(2);
    expect((await providerFiles(s)).every((f) => f.status === 'deleted')).toBe(
      true,
    );
  });

  it('rejects invalid or foreign-evidence output without publishing or retrying', async () => {
    for (const text of [
      'not json',
      JSON.stringify({
        claims: [
          {
            id: 'c1',
            topic: 'financial',
            text: 'ARR',
            evidence: [{ documentVersionId: 'foreign', quote: 'q', page: 1 }],
          },
        ],
      }),
    ]) {
      const s = await setup();
      provider(() =>
        Response.json({
          id: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text }],
            },
          ],
        }),
      );
      const runId = await s.start();
      await finish(s);
      const { run, steps } = await s.alice.query(api.runs.get, { runId });
      expect(run.status).toBe('failed');
      expect(steps.find((step) => step.stepId === 'extract')!.attempts).toBe(1);
      const artifacts = await s.alice.query(api.runs.artifacts, {
        runId,
        paginationOpts: { numItems: 20, cursor: null },
      });
      expect(artifacts.page).toHaveLength(0);
      expect(
        (await providerFiles(s)).every((f) => f.status === 'deleted'),
      ).toBe(true);
    }
  });

  it('reconciles provider copies only after their attempt can no longer be running', async () => {
    const s = await setup();
    const { calls } = provider();
    const runId = await s.start();
    const claim = await s.t.mutation(internal.analysis.state.begin, {
      runId,
      stepId: 'extract',
    });
    if (claim.completed) throw new Error('Expected new attempt');
    await s.t.mutation(internal.providerFiles.record, {
      attemptId: claim.attemptId,
      documentVersionId: s.deck as Id<'documentVersions'>,
      providerFileId: 'orphan-1',
    });
    const reconcile = () =>
      s.t.action(internal.analysis.execute.reconcileProviderFiles, {});
    expect(await reconcile()).toEqual({ deleted: 0, failed: 0 });
    expect(calls).toHaveLength(0);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await reconcile()).toEqual({ deleted: 1, failed: 0 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['DELETE', 'https://api.x.ai/v1/files/orphan-1'],
    ]);
    expect((await providerFiles(s))[0]!.status).toBe('deleted');
    expect(await reconcile()).toEqual({ deleted: 0, failed: 0 });
  });
});
