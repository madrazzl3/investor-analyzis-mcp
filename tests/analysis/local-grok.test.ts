import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalGrok } from '../../packages/analysis/src/local-grok';
import { GrokClient } from '../../packages/grok/src/index';
import { payload } from '../fixtures/council';
const dirs: string[] = [];
afterEach(() =>
  dirs.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function setup(
  options: { badQuote?: boolean; retry?: boolean; cleanupFail?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'local-grok-'));
  dirs.push(dir);
  const paths = [join(dir, 'deck.pdf'), join(dir, 'call.txt')];
  writeFileSync(paths[0]!, '%PDF-1.7 synthetic fixture');
  writeFileSync(paths[1]!, 'founder call');
  let calls = 0,
    files = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/api.x.ai\/v1\//);
    if (init?.method === 'DELETE')
      return new Response('', { status: options.cleanupFail ? 503 : 200 });
    if (String(url).endsWith('/files'))
      return Response.json({ id: `file-${++files}` });
    calls++;
    if (options.retry && calls === 1) return new Response('', { status: 429 });
    const body = JSON.parse(init!.body as string);
    const inputs = JSON.parse(body.input[1].content[0].text);
    const port = body.text.format.schema.required[0];
    const output = payload(port, inputs, body.input[0].content);
    if (options.badQuote && port === 'caseFile')
      output.caseFile!.claims[1]!.evidence[0]!.quote = 'invented quote';
    return Response.json({
      id: `response-${calls}`,
      status: 'completed',
      model: body.model,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  });
  const data = join(dir, 'data');
  const runtime = new LocalGrok(
    data,
    resolve('config'),
    new GrokClient('test-key', fetcher),
  );
  return { runtime, paths, fetcher, data, calls: () => calls, options };
}
it('executes the entire council locally, preserves artifacts and reuses completed input across restarts', async () => {
  const t = setup();
  const { runId } = await t.runtime.start(t.paths);
  const result = await t.runtime.wait(runId);
  expect(result.status).toBe('completed');
  expect(result.report).toHaveProperty('topFindings');
  expect(t.calls()).toBe(14);
  expect(
    result.attempts.every((a) => a.provider?.usage.totalTokens === 15),
  ).toBe(true);
  expect(result.cleanupPending).toBe(0);
  const restarted = new LocalGrok(
    t.data,
    resolve('config'),
    new GrokClient('test-key', t.fetcher),
  );
  expect((await restarted.start(t.paths)).runId).toBe(runId);
  expect(t.calls()).toBe(14);
  expect(() => restarted.get('../escape')).toThrow();
  expect(restarted.artifact(runId, result.outputs.report!).payload).toEqual(
    result.report,
  );
});
it('rejects fabricated transcript evidence without publishing artifacts', async () => {
  const t = setup({ badQuote: true });
  const { runId } = await t.runtime.start(t.paths);
  const result = await t.runtime.wait(runId);
  expect(result.status).toBe('failed');
  expect(result.outputs).toEqual({});
  expect(t.calls()).toBe(1);
  expect(result.cleanupPending).toBe(0);
});
it('retries only transient errors within saved budgets and retains failed cleanup for explicit retry', async () => {
  const t = setup({ retry: true, cleanupFail: true });
  const { runId } = await t.runtime.start(t.paths);
  const result = await t.runtime.wait(runId);
  expect(result.status).toBe('completed');
  expect(t.calls()).toBe(15);
  expect(result.attempts[0]?.error).toBe('rate_limit');
  expect(result.cleanupPending).toBe(4);
  t.options.cleanupFail = false;
  expect((await t.runtime.cleanup(runId)).cleanupPending).toBe(0);
});
it('rejects corrupt saved source bytes before submitting another request', async () => {
  const t = setup({ badQuote: true });
  const { runId } = await t.runtime.start(t.paths);
  await t.runtime.wait(runId);
  const source = readdirSync(t.data).find((f) => f.endsWith('.source'))!;
  writeFileSync(join(t.data, source), 'corrupted');
  t.runtime.resume(runId);
  expect((await t.runtime.wait(runId)).status).toBe('failed');
  expect(t.calls()).toBe(1);
});
it('aborts an in-flight provider request and never publishes cancelled output', async () => {
  const t = setup();
  let entered!: () => void;
  const generating = new Promise<void>((r) => {
    entered = r;
  });
  let aborted = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (init?.method === 'DELETE') return Response.json({ deleted: true });
    if (String(url).endsWith('/files'))
      return Response.json({ id: 'cancel-file' });
    entered();
    return new Promise((_, reject) =>
      init!.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('aborted'));
        },
        { once: true },
      ),
    );
  };
  const runtime = new LocalGrok(
    t.data,
    resolve('config'),
    new GrokClient('test-key', fetcher),
  );
  const { runId } = await runtime.start(t.paths);
  await generating;
  const result = await runtime.cancel(runId);
  expect(aborted).toBe(true);
  expect(result.status).toBe('cancelled');
  expect(result.outputs).toEqual({});
  expect(runtime.resume(runId).status).toBe('cancelled');
});
