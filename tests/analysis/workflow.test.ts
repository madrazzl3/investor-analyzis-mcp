import { mkdtempSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadBundle,
  compile,
  parseStrictJson,
  hash,
  type Bundle,
} from '../../packages/analysis/src/config.js';
import {
  executeLocal,
  LocalRunStore,
  RetryableError,
  type Handlers,
} from '../../packages/analysis/src/runner.js';

const temporary: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'investor-config-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const bundle = () => loadBundle(resolve('config'));
const scope = { tenantId: 'test-tenant', caseId: 'test-case' };
const inputs = {
  documents: [{ documentVersionId: 'synthetic-v1', name: 'Synthetic fixture' }],
};
const evidence = [
  {
    documentVersionId: 'synthetic-v1',
    quote: 'Synthetic fixture quote',
    page: 1,
  },
];
const finding = {
  id: 'candidate-1',
  statement: 'Synthetic discrepancy for runner testing',
  severity: 'medium',
  evidence,
  alternativeExplanation: 'Reporting dates may differ.',
};
function handlers(calls: string[] = []): Handlers {
  return {
    'extract-claims@1.0.0': async ({ inputs }) => {
      calls.push('extract');
      expect(inputs.documents).toEqual([
        { documentVersionId: 'synthetic-v1', name: 'Synthetic fixture' },
      ]);
      return { claims: [{ id: 'claim-1', text: 'Synthetic claim', evidence }] };
    },
    'check-consistency@1.0.0': async ({ inputs }) => {
      calls.push('consistency');
      expect(inputs.claims).toEqual([
        { id: 'claim-1', text: 'Synthetic claim', evidence },
      ]);
      return { findings: [finding] };
    },
    'verify-findings@1.0.0': async ({ inputs }) => {
      calls.push('verify');
      return {
        verifiedFindings: {
          findings: (inputs.findings as object[]).map((f) => ({
            ...f,
            disposition: 'unresolved',
          })),
          coverage: 'Synthetic test only; no documents analyzed.',
        },
      };
    },
    'write-report@1.0.0': async ({ inputs }) => {
      calls.push('report');
      return {
        report: {
          summary: 'Synthetic test report',
          ...(inputs.verifiedFindings as object),
        },
      };
    },
  };
}
function start(b = bundle()) {
  const store = new LocalRunStore(temp());
  store.create('run-1', scope, b, inputs);
  return store;
}

describe('configuration loader/compiler', () => {
  it('loads four connected agents and hashes content independently of object key order', () => {
    const b = bundle();
    expect(compile(b).order).toEqual([
      'extract',
      'consistency',
      'verify',
      'report',
    ]);
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    const old = hash(b);
    b.prompts['prompts/extract-claims.v1.md'] += 'Changed';
    expect(hash(b)).not.toBe(old);
  });
  it('rejects duplicate decoded keys, comments, and trailing commas', () => {
    for (const text of [
      '{"a":1,"\\u0061":2}',
      '{"a":1,}',
      '{/* comment */"a":1}',
    ])
      expect(() => parseStrictJson(text)).toThrow();
  });
  it.each([
    'cycle',
    'missing-port',
    'mismatch',
    'unknown-agent',
    'unused-step',
    'unknown-field',
    'bad-merge',
  ] as const)('rejects %s', (kind) => {
    const b = bundle();
    switch (kind) {
      case 'cycle':
        b.workflow.steps.consistency!.inputs.claims = {
          from: 'step',
          step: 'consistency',
          output: 'findings',
        };
        b.agents['check-consistency@1.0.0']!.inputs.claims!.schema =
          'findings@1.0.0';
        break;
      case 'missing-port':
        b.workflow.steps.consistency!.inputs.claims = {
          from: 'step',
          step: 'extract',
          output: 'missing',
        };
        break;
      case 'mismatch':
        b.workflow.steps.consistency!.inputs.claims = {
          from: 'input',
          name: 'documents',
        };
        break;
      case 'unknown-agent':
        b.workflow.steps.extract!.agent = 'absent@1.0.0';
        break;
      case 'unused-step':
        b.workflow.steps.unused = structuredClone(b.workflow.steps.extract!);
        break;
      case 'unknown-field':
        Object.assign(b.workflow, { eval: 'evil' });
        break;
      case 'bad-merge':
        b.workflow.steps.report!.inputs.verifiedFindings = {
          merge: 'concat',
          sources: [
            { from: 'step', step: 'verify', output: 'verifiedFindings' },
          ],
        };
        break;
    }
    expect(() => compile(b)).toThrow();
  });
  it('rejects inherited object properties as output ports', () => {
    const b = bundle();
    b.workflow.outputs.report!.output = 'toString';
    expect(() => compile(b)).toThrow('Unknown input or output port');
  });
  it('rejects prompt traversal outside the trusted root', () => {
    const dir = temp();
    cpSync('config', join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'outside.md'), 'outside');
    const b = bundle();
    const a = b.agents['extract-claims@1.0.0']!;
    a.promptFile = '../outside.md';
    writeFileSync(
      join(dir, 'config/agents/extract-claims.v1.json'),
      JSON.stringify(a),
    );
    expect(() => loadBundle(join(dir, 'config'))).toThrow('escapes root');
  });
  it('snapshots only what each workflow uses and selects its runner by provider', () => {
    const synthetic = bundle();
    const live = loadBundle(
      resolve('config'),
      'workflows/diligence-live.v1.json',
    );
    expect(synthetic.runnerVersion).toBe('local-fake-v1');
    expect(Object.keys(synthetic.models)).toEqual(['local-fake@1.0.0']);
    expect(
      Object.keys(synthetic.agents).every((a) => a.endsWith('@1.0.0')),
    ).toBe(true);
    expect(live.runnerVersion).toBe('convex-grok-v1');
    expect(Object.keys(live.models)).toEqual(['grok-primary@1.0.0']);
    expect(live.models['grok-primary@1.0.0']).toMatchObject({
      provider: 'xai',
      model: 'grok-4.6',
    });
    expect(Object.keys(live.agents).every((a) => a.endsWith('@2.0.0'))).toBe(
      true,
    );
    // Local fake handlers must never stand in for a live bundle.
    expect(() =>
      new LocalRunStore(temp()).create('run-1', scope, live, inputs),
    ).toThrow('fake-model bundles only');
  });
  it('rejects mixed providers, over-long live timeouts, and attachments from step outputs', () => {
    const live = () =>
      loadBundle(resolve('config'), 'workflows/diligence-live.v1.json');
    const mixed = live();
    mixed.models['local-fake@1.0.0'] = bundle().models['local-fake@1.0.0']!;
    expect(() => compile(mixed)).toThrow('provider does not match');
    const slow = live();
    slow.agents['extract-claims@2.0.0']!.limits.timeoutSeconds = 240;
    expect(() => compile(slow)).toThrow('timeout');
    const leaked = live();
    leaked.agents['write-report@2.0.0']!.inputs.verifiedFindings!.delivery =
      'attachments';
    expect(() => compile(leaked)).toThrow('Attachments must bind');
    const alias = live();
    (alias.models['grok-primary@1.0.0'] as { model: string }).model =
      'gpt-latest';
    expect(() => compile(alias)).toThrow();
  });
});

describe('persisted local fake execution', () => {
  it('publishes intermediates, preserves lineage, resumes from disk, and does not repeat completed work', async () => {
    const b = bundle(),
      store = start(b),
      calls: string[] = [];
    const partial = await executeLocal(store, 'run-1', scope, handlers(calls), {
      stopAfterSteps: 2,
    });
    expect(partial.status).toBe('running');
    expect(Object.keys(partial.artifacts)).toHaveLength(2);
    b.prompts['prompts/extract-claims.v1.md'] = 'changed after start';
    const reopened = new LocalRunStore(store.directory);
    const done = await executeLocal(reopened, 'run-1', scope, handlers(calls));
    expect(done.status).toBe('completed');
    expect(calls).toEqual(['extract', 'consistency', 'verify', 'report']);
    expect(done.snapshot.prompts['prompts/extract-claims.v1.md']).not.toBe(
      b.prompts['prompts/extract-claims.v1.md'],
    );
    expect(done.manifests[1]!.inputArtifactIds).toEqual([
      done.steps.extract!.outputs.claims,
    ]);
    expect(done.artifacts[done.outputs.report!]!.payload).toMatchObject({
      summary: 'Synthetic test report',
    });
    await executeLocal(reopened, 'run-1', scope, handlers(calls));
    expect(calls).toHaveLength(4);
    expect(() => reopened.create('run-1', scope, b, inputs)).toThrow();
  });
  it('merges independent branches in binding order', async () => {
    const b = bundle();
    b.workflow.steps.financials = structuredClone(
      b.workflow.steps.consistency!,
    );
    b.workflow.steps.verify!.inputs.findings = {
      merge: 'concat',
      sources: [
        { from: 'step', step: 'financials', output: 'findings' },
        { from: 'step', step: 'consistency', output: 'findings' },
      ],
    };
    const h = handlers();
    let active = 0,
      max = 0;
    h['check-consistency@1.0.0'] = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { findings: [finding] };
    };
    const done = await executeLocal(start(b), 'run-1', scope, h);
    expect(done.status).toBe('completed');
    expect(max).toBe(2);
    expect(
      done.manifests.find((m) => m.stepId === 'verify')!.inputArtifactIds,
    ).toEqual([
      done.steps.financials!.outputs.findings,
      done.steps.consistency!.outputs.findings,
    ]);
    expect(
      done.manifests.find((m) => m.stepId === 'verify')!.inputs.findings,
    ).toHaveLength(2);
  });
  it('publishes no outputs if any output fails validation and blocks descendants', async () => {
    const b = bundle();
    b.agents['extract-claims@1.0.0']!.outputs.extra = {
      schema: 'claims@1.0.0',
    };
    const h = handlers();
    h['extract-claims@1.0.0'] = async () => ({
      claims: [{ id: 'c', text: 'test', evidence }],
      extra: 'invalid',
    });
    const done = await executeLocal(start(b), 'run-1', scope, h);
    expect(done.status).toBe('failed');
    expect(done.artifacts).toEqual({});
    expect(done.manifests).toHaveLength(1);
    expect(done.outputs).toEqual({});
  });
  it('retries only classified transient errors with the same saved inputs', async () => {
    const h = handlers();
    const original = h['extract-claims@1.0.0']!;
    let calls = 0;
    h['extract-claims@1.0.0'] = async (r) => {
      if (++calls === 1) throw new RetryableError('provider_unavailable');
      return original(r);
    };
    const done = await executeLocal(start(), 'run-1', scope, h);
    expect(done.status).toBe('completed');
    expect(
      done.attempts.filter((a) => a.stepId === 'extract').map((a) => a.status),
    ).toEqual(['failed', 'completed']);
    expect(done.manifests[0]!.inputs).toEqual(done.manifests[1]!.inputs);
    expect(Object.keys(done.artifacts)).toHaveLength(4);
  });
  it('enforces run scope and rejects foreign source references', async () => {
    const store = start();
    await expect(
      executeLocal(
        store,
        'run-1',
        { ...scope, tenantId: 'foreign' },
        handlers(),
      ),
    ).rejects.toThrow('Access denied');
    const h = handlers();
    h['extract-claims@1.0.0'] = async () => ({
      claims: [
        {
          id: 'c',
          text: 'test',
          evidence: [{ ...evidence[0], documentVersionId: 'foreign-doc' }],
        },
      ],
    });
    expect((await executeLocal(store, 'run-1', scope, h)).status).toBe(
      'failed',
    );
    expect(store.read('run-1', scope).artifacts).toEqual({});
  });
  it('rejects competing writers and releases its lock after execution', async () => {
    const store = start();
    const release = store.lock('run-1');
    await expect(
      executeLocal(store, 'run-1', scope, handlers()),
    ).rejects.toThrow();
    release();
    expect((await executeLocal(store, 'run-1', scope, handlers())).status).toBe(
      'completed',
    );
  });
  it('does not publish late output after cancellation', async () => {
    const store = start(),
      controller = new AbortController(),
      h = handlers();
    h['extract-claims@1.0.0'] = async () => {
      controller.abort();
      return { claims: [] };
    };
    const done = await executeLocal(store, 'run-1', scope, h, {
      signal: controller.signal,
    });
    expect(done.status).toBe('cancelled');
    expect(done.artifacts).toEqual({});
  });
  it('stops when the workflow call budget is exhausted', async () => {
    const b = bundle();
    b.workflow.limits.maxModelCalls = 1;
    const done = await executeLocal(start(b), 'run-1', scope, handlers());
    expect(done.status).toBe('failed');
    expect(done.calls).toBe(1);
    expect(Object.keys(done.artifacts)).toHaveLength(1);
  });
});
