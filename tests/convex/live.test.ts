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
type Reply = (
  port: string,
  inputs: Record<string, any>,
  system: string,
) => Response;
const lensOf = (system: string) =>
  /You are the `([a-z-]+)` specialist/.exec(system)?.[1];

// Plausible council outputs. Later steps copy evidence from their inputs, as the
// prompts require; the mock never sees the documents either.
function payload(port: string, inputs: Record<string, any>, system: string) {
  if (port === 'caseFile') {
    const id = (name: string) =>
      inputs.documents.find((d: { name: string }) => d.name === name)
        .documentVersionId;
    return {
      caseFile: {
        materialQuality: 'adequate',
        whatWeKnow: {
          companyName: 'Synthetic Co',
          product: 'Synthetic payroll software.',
          intendedUsers: null,
          businessModel: 'Subscription',
          stage: null,
        },
        claims: [
          {
            id: 'c1',
            topic: 'traction',
            text: 'ARR is $2.4M.',
            evidence: [
              {
                documentVersionId: id('deck.pdf'),
                quote: 'Annual recurring revenue of $2.4M',
                page: 3,
              },
            ],
          },
          {
            id: 'c2',
            topic: 'team',
            text: 'The founder discussed the company on a call.',
            evidence: [
              {
                documentVersionId: id('call.txt'),
                quote: 'founder  call',
                page: null,
              },
            ],
          },
        ],
        contradictionsAndGaps: [
          {
            id: 'g1',
            issue: 'No retention data.',
            source: 'Neither document gives cohort retention.',
            questionsForFounder: ['What is 12-month logo retention?'],
            evidence: [],
          },
        ],
        flags: { appearsToBeTest: true, other: [] },
        coverage: 'Both documents were read; charts were not interpreted.',
      },
    };
  }
  if (port === 'brief')
    return {
      brief: {
        contextBrief: 'Traction quality likely dominates this deal.',
        delegatedAgents: [
          'traction-authenticity',
          'financial-captable-fragility',
          'founder-team-integrity',
        ],
        whyTheseAgents: 'The only metric is ARR without retention.',
        dominantRiskType: 'traction',
        confidence: 'medium',
      },
    };
  const claim = inputs.caseFile.claims[0].evidence[0];
  const finding = (id: string, evidence: object[]) => ({
    id,
    title: 'ARR without retention',
    exploit: 'Churned customers are replaced by paid acquisition.',
    consequence: 'ARR overstates durable revenue.',
    investmentRisk: 'The valuation rests on unproven retention.',
    vrsd: { vector: 3, reachability: 3, severity: 4, detectability: 2 },
    pricedIn: 'unclear',
    precedentTag: 'fabricated-traction',
    source: 'c1, g1',
    evidence,
    alternativeExplanation: 'Retention may simply not have been shared yet.',
    founderQuestion: 'What is net revenue retention by cohort?',
  });
  if (port === 'assessment') {
    const lens = lensOf(system);
    if (lens === 'exit-return-under-downside')
      return {
        assessment: {
          abstained: true,
          abstentionReason: 'No valuation or terms in the material.',
          findings: [],
        },
      };
    // A contiguous excerpt of the case-file quote, on the same page.
    const excerpt = { ...claim, quote: 'recurring revenue of $2.4M' };
    return {
      assessment: {
        abstained: false,
        abstentionReason: '',
        findings: [finding(lens ? 'f1' : 'da1', lens ? [excerpt] : [])],
      },
    };
  }
  const top = inputs['traction-authenticity'].findings[0];
  return {
    report: {
      executiveSummary: 'Unproven retention behind the ARR headline.',
      overallRiskAssessment: 'medium',
      topFindings: [
        {
          rank: 1,
          lens: 'traction-authenticity',
          findingId: top.id,
          title: top.title,
          exploit: top.exploit,
          consequence: top.consequence,
          investmentRisk: top.investmentRisk,
          investorImplication: 'Verify cohort retention before relying on ARR.',
          vrsd: top.vrsd,
          pricedIn: top.pricedIn,
          evidence: top.evidence,
          alternativeExplanation: top.alternativeExplanation,
        },
      ],
      blindSpots: [],
      founderQuestions: [
        {
          question: 'What is 12-month logo retention?',
          context: 'ARR alone does not show durability.',
          findingIds: [top.id],
        },
      ],
      evidenceToRequest: ['Monthly revenue by customer'],
      coverage: 'Exit lens abstained. No precedent lookup was performed.',
    },
  };
}
const respond = (text: string, id = 'response') =>
  Response.json({
    id,
    status: 'completed',
    model: 'grok-4.6-0901',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 },
  });
const ok: Reply = (port, inputs, system) =>
  respond(JSON.stringify(payload(port, inputs, system)), `response-${port}`);
const lenses = [
  'market-regulatory-exposure',
  'competitive-attack-surface',
  'founder-team-integrity',
  'traction-authenticity',
  'business-model-monetisation-ethics',
  'moat-defensibility-under-attack',
  'financial-captable-fragility',
  'product-tech-attack-surface',
  'trust-safety-reputational-risk',
  'exit-return-under-downside',
];
type Request = {
  input: [{ content: string }, { content: { type: string; text?: string }[] }];
  text: { format: { schema: { required: string[] } } };
};
const portOf = (c: Call) => (c.body as Request).text.format.schema.required[0];

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
      const request = body as Request;
      const inputs = JSON.parse(request.input[1].content[0]!.text!);
      return reply(
        request.text.format.schema.required[0]!,
        inputs,
        request.input[0].content,
      );
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

describe('live Grok investor council', () => {
  it('runs intake, CVO, ten lenses, Devil’s Advocate, and synthesis; records usage; deletes provider copies', async () => {
    const s = await setup();
    const { calls } = provider();
    const runId = await s.start();
    await finish(s);
    const { run, steps, attempts } = await s.alice.query(api.runs.get, {
      runId,
    });
    expect(run.status).toBe('completed');
    expect(run.mode).toBe('live');
    expect(run.calls).toBe(14);
    expect(steps).toHaveLength(14);
    expect(steps.every((step) => step.status === 'completed')).toBe(true);
    expect(attempts).toHaveLength(14);
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
    expect(report.schema).toBe('council-report@1.0.0');
    expect(report.stepId).toBe('synthesis');
    expect(report.payload.topFindings[0].evidence[0]).toEqual({
      documentVersionId: s.deck,
      quote: 'recurring revenue of $2.4M',
      page: 3,
    });
    const artifacts = await s.alice.query(api.runs.artifacts, {
      runId,
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(artifacts.page.map((a) => a.stepId).sort()).toEqual(
      [...lenses, 'cvo', 'devils-advocate', 'intake', 'synthesis'].sort(),
    );

    // Every request went to xAI with the server-side key only.
    expect(calls.every((c) => c.url.startsWith('https://api.x.ai/v1/'))).toBe(
      true,
    );
    expect(calls.every((c) => c.auth === 'Bearer test-key')).toBe(true);
    const responses = calls.filter((c) => c.url.endsWith('/responses'));
    expect(responses).toHaveLength(14);
    const intake = responses.find((c) => portOf(c) === 'caseFile')!
      .body as Record<string, any>;
    expect(intake.model).toBe('grok-4.6');
    expect(intake.store).toBe(false);
    expect(intake.max_output_tokens).toBe(16000);
    expect(intake.text.format.strict).toBe(true);
    expect(
      intake.text.format.schema.properties.caseFile.$schema,
    ).toBeUndefined();
    expect(intake.input[0].content).toContain('# Intake Gate');
    expect(
      intake.input[1].content.filter(
        (part: { type: string }) => part.type === 'input_file',
      ),
    ).toHaveLength(2);
    // Only intake sees documents; every later step receives JSON artifacts.
    const later = responses.filter((c) => portOf(c) !== 'caseFile');
    expect(later).toHaveLength(13);
    for (const c of later)
      expect(JSON.stringify(c.body)).not.toContain('input_file');
    const inputsOf = (c: Call) =>
      Object.keys(
        JSON.parse((c.body as Request).input[1].content[0]!.text!),
      ).sort();
    const specialists = later.filter(
      (c) =>
        portOf(c) === 'assessment' &&
        lensOf((c.body as Request).input[0].content),
    );
    expect(
      specialists
        .map((c) => lensOf((c.body as Request).input[0].content))
        .sort(),
    ).toEqual([...lenses].sort());
    for (const c of specialists)
      expect(inputsOf(c)).toEqual(['brief', 'caseFile']);
    const devil = later.find(
      (c) =>
        portOf(c) === 'assessment' &&
        !lensOf((c.body as Request).input[0].content),
    )!;
    expect(inputsOf(devil)).toEqual(['brief', 'caseFile', ...lenses].sort());
    const synthesis = later.find((c) => portOf(c) === 'report')!;
    expect(inputsOf(synthesis)).toEqual(
      ['brief', 'caseFile', 'devils-advocate', ...lenses].sort(),
    );

    // Two documents attached once, to intake; each provider copy was deleted.
    const uploads = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/files'),
    );
    expect(uploads.map((c) => c.body).sort()).toEqual(
      [`${s.call}.txt`, `${s.deck}.pdf`].sort(),
    );
    const files = await providerFiles(s);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.status === 'deleted')).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
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
      stepId: 'intake',
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
    // The completed intake step was reused, not billed again.
    expect(calls.filter((c) => c.url.endsWith('/responses'))).toHaveLength(14);
  });

  it('retries classified provider failures within the attempt budget', async () => {
    const s = await setup();
    let limited = 1;
    provider((port, inputs, system) =>
      lensOf(system) === 'traction-authenticity' && limited-- > 0
        ? new Response('secret prompt echo', { status: 429 })
        : ok(port, inputs, system),
    );
    const runId = await s.start();
    await finish(s);
    const { run, steps, attempts } = await s.alice.query(api.runs.get, {
      runId,
    });
    expect(run.status).toBe('completed');
    expect(run.calls).toBe(15);
    const lens = steps.find((step) => step.stepId === 'traction-authenticity')!;
    expect(lens.attempts).toBe(2);
    expect(
      attempts
        .filter((a) => a.agentRunId === lens._id)
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
    expect(run.error).toBe('intake: provider_unavailable');
    expect(JSON.stringify(run)).not.toContain('secret');
    expect(steps.find((step) => step.stepId === 'intake')!.attempts).toBe(2);
    expect(calls.filter((c) => c.url.endsWith('/responses'))).toHaveLength(2);
    expect((await providerFiles(s)).every((f) => f.status === 'deleted')).toBe(
      true,
    );
  });

  it('rejects invalid, foreign, or unquotable intake output without publishing or retrying', async () => {
    const caseFile =
      (evidence: (ids: Record<string, string>) => object) =>
      (port: string, inputs: Record<string, any>, system: string) => {
        const valid = payload(port, inputs, system) as { caseFile: any };
        const ids = Object.fromEntries(
          inputs.documents.map(
            (d: { name: string; documentVersionId: string }) => [
              d.name,
              d.documentVersionId,
            ],
          ),
        );
        valid.caseFile.claims[1].evidence = [evidence(ids)];
        return respond(JSON.stringify(valid));
      };
    const replies: Reply[] = [
      () => respond('not json'),
      caseFile(() => ({ documentVersionId: 'foreign', quote: 'q', page: 1 })),
      // The transcript is plain text, so an invented quote is caught mechanically.
      caseFile((ids) => ({
        documentVersionId: ids['call.txt']!,
        quote: 'We have 40 enterprise customers',
        page: null,
      })),
    ];
    for (const reply of replies) {
      const s = await setup();
      provider(reply);
      const runId = await s.start();
      await finish(s);
      const { run, steps } = await s.alice.query(api.runs.get, { runId });
      expect(run.status).toBe('failed');
      expect(run.error).toBe('intake: invalid_output');
      expect(steps.find((step) => step.stepId === 'intake')!.attempts).toBe(1);
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

  it('rejects a specialist quote that is not in the case file, in the action and at publish', async () => {
    const s = await setup();
    const { calls } = provider((port, inputs, system) => {
      if (lensOf(system) !== 'financial-captable-fragility')
        return ok(port, inputs, system);
      const invented = payload(port, inputs, system) as { assessment: any };
      invented.assessment.findings[0].evidence[0].quote = 'Runway of 30 months';
      return respond(JSON.stringify(invented));
    });
    const runId = await s.start();
    await finish(s);
    const { run, steps } = await s.alice.query(api.runs.get, { runId });
    expect(run.status).toBe('failed');
    expect(run.error).toBe('financial-captable-fragility: invalid_output');
    const lens = steps.find(
      (x) => x.stepId === 'financial-captable-fragility',
    )!;
    expect([lens.status, lens.attempts]).toEqual(['failed', 1]);
    // Other lenses' accepted work is kept; nothing downstream ran.
    expect(steps.find((x) => x.stepId === 'synthesis')!.attempts).toBe(0);
    expect(
      calls.some((c) => c.url.endsWith('/responses') && portOf(c) === 'report'),
    ).toBe(false);

    // The publish mutation enforces the same rule independently of the action.
    await s.t.run(async (ctx) => {
      const stage = await ctx.db
        .query('agentRuns')
        .withIndex('by_run_step', (q) =>
          q.eq('runId', runId).eq('stepId', 'financial-captable-fragility'),
        )
        .unique();
      await ctx.db.patch(stage!._id, { status: 'pending' });
      await ctx.db.patch(runId, { status: 'running', error: undefined });
    });
    const claim = await s.t.mutation(internal.analysis.state.begin, {
      runId,
      stepId: 'financial-captable-fragility',
    });
    if (claim.completed) throw new Error('Expected new attempt');
    const evidence = (quote: string) => ({
      assessment: {
        abstained: false,
        abstentionReason: '',
        findings: [
          {
            ...(
              payload(
                'assessment',
                { caseFile: { claims: [{ evidence: [{}] }] } },
                'You are the `x` specialist',
              ) as any
            ).assessment.findings[0],
            evidence: [{ documentVersionId: s.deck, quote, page: 3 }],
          },
        ],
      },
    });
    const provider_ = {
      model: 'grok-4.6-0901',
      responseId: 'r',
      usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    };
    await expect(
      s.t.mutation(internal.analysis.state.publish, {
        attemptId: claim.attemptId,
        outputs: evidence('Runway of 30 months'),
        provider: provider_,
      }),
    ).rejects.toThrow('not found in step inputs');
    await s.t.mutation(internal.analysis.state.publish, {
      attemptId: claim.attemptId,
      outputs: evidence('revenue of $2.4M'),
      provider: provider_,
    });
  });

  it('reconciles provider copies only after their attempt can no longer be running', async () => {
    const s = await setup();
    const { calls } = provider();
    const runId = await s.start();
    const claim = await s.t.mutation(internal.analysis.state.begin, {
      runId,
      stepId: 'intake',
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
