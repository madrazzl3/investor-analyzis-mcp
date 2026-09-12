import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler } from '../../apps/mcp-server/src/sdk';
import { ConvexError } from 'convex/values';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  createLocalMcpServer,
  describeLocalError,
  readDocument,
  resolveConvexUrl,
} from '../../apps/mcp-server/src/local';

const VERSION = '2026-07-28';
type Call = [kind: string, name: string, args: Record<string, unknown>];
let calls: Call[];
let responses: Record<string, (args: Record<string, unknown>) => unknown>;
const backend = async (
  kind: 'query' | 'mutation' | 'action',
  name: string,
  args: Record<string, unknown>,
) => {
  calls.push([kind, name, args]);
  const respond = responses[name];
  if (!respond) throw new Error(`unexpected ${name}`);
  return respond(args);
};
const storage = vi.fn(
  async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ storageId: 'storage-1' }),
);
beforeEach(() => {
  calls = [];
  storage.mockClear();
  responses = {
    'organizations:createPersonal': () => 'org-1',
    'cases:list': () => [{ _id: 'case-existing', name: 'Existing' }],
    'cases:create': () => 'case-new',
    'uploads:prepare': (args) => ({
      uploadId: `upload-${args.name}`,
      uploadUrl: 'https://storage.invalid/upload',
      headers: { 'Content-Type': `${args.contentType}; upload-token=t` },
    }),
    'uploadValidation:attach': (args) => ({
      documentVersionId: `doc-${args.uploadId}`,
    }),
    'runs:start': () => 'run-1',
  };
});

async function callTool(name: string, args: Record<string, unknown>) {
  const handler = createMcpHandler(
    () =>
      createLocalMcpServer(backend, {
        fetch: storage as typeof fetch,
        pollIntervalMs: 1,
      }),
    { legacy: 'stateless' },
  );
  const response = await handler.fetch(
    new Request('http://127.0.0.1/mcp', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': VERSION,
        'mcp-method': 'tools/call',
        'mcp-name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'test',
              version: '1',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
  );
  const text = await response.text();
  await handler.close();
  const body = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
        .find((event) => event.id === 1)
    : JSON.parse(text);
  return body.result as {
    isError?: boolean;
    content: { text: string }[];
    structuredContent?: { data: Record<string, unknown> };
  };
}

async function fixture(name: string, content: string | Uint8Array) {
  const dir = await mkdtemp(join(tmpdir(), 'local-mcp-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

it('analyzes local files in one call: case, raw upload, attach, start', async () => {
  const deck = await fixture('Deck.pdf', '%PDF-1.4 synthetic');
  const notes = await fixture('call.txt', 'Founder call notes');
  const result = await callTool('analyze_files', { paths: [deck, notes] });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent?.data).toMatchObject({
    caseId: 'case-new',
    caseName: 'Deck.pdf',
    runId: 'run-1',
    documents: [
      { documentVersionId: 'doc-upload-Deck.pdf', name: 'Deck.pdf' },
      { documentVersionId: 'doc-upload-call.txt', name: 'call.txt' },
    ],
  });
  // Raw bytes go to the storage URL with the binding header, never via MCP args.
  expect(storage).toHaveBeenCalledTimes(2);
  const [url, init] = storage.mock.calls[0]!;
  expect(url).toBe('https://storage.invalid/upload');
  expect(init?.headers).toEqual({
    'Content-Type': 'application/pdf; upload-token=t',
  });
  expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe(
    '%PDF-1.4 synthetic',
  );
  const prepare = calls.filter(([, name]) => name === 'uploads:prepare');
  expect(prepare.map(([, , args]) => args.contentType)).toEqual([
    'application/pdf',
    'text/plain',
  ]);
  const start = calls.find(([, name]) => name === 'runs:start')![2];
  expect(start).toMatchObject({
    caseId: 'case-new',
    documentVersionIds: ['doc-upload-Deck.pdf', 'doc-upload-call.txt'],
  });
  expect(start.requestId).toMatch(/^local-[0-9a-f]{40}$/);
});

it('reuses a same-named case and derives stable request IDs for retries', async () => {
  const deck = await fixture('Existing.pdf', '%PDF-1.4 x');
  const first = await callTool('analyze_files', {
    paths: [deck],
    caseName: 'Existing',
  });
  const firstIds = calls
    .filter(([, name]) => name === 'uploads:prepare' || name === 'runs:start')
    .map(([, , args]) => args.requestId);
  calls = [];
  await callTool('analyze_files', { paths: [deck], caseName: 'Existing' });
  const secondIds = calls
    .filter(([, name]) => name === 'uploads:prepare' || name === 'runs:start')
    .map(([, , args]) => args.requestId);
  expect(first.structuredContent?.data.caseId).toBe('case-existing');
  expect(calls.some(([, name]) => name === 'cases:create')).toBe(false);
  expect(secondIds).toEqual(firstIds);
});

it('skips the byte upload when the document is already registered', async () => {
  responses['uploads:prepare'] = () => ({
    uploadId: 'u',
    documentVersionId: 'doc-existing',
  });
  const result = await callTool('upload_text', {
    caseId: 'case-1',
    name: 'transcript.txt',
    text: 'hello',
  });
  expect(result.structuredContent?.data).toEqual({
    documentVersionId: 'doc-existing',
    name: 'transcript.txt',
  });
  expect(storage).not.toHaveBeenCalled();
});

it('rejects unsupported files before creating anything', async () => {
  const image = await fixture('logo.png', 'png');
  const result = await callTool('analyze_files', { paths: [image] });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toContain('Unsupported file type');
  expect(calls).toEqual([]);
  await expect(readDocument(join(tmpdir(), 'missing.pdf'))).rejects.toThrow();
});

it('returns the final report once a run completes, and progress before', async () => {
  const run = {
    _id: 'run-1',
    mode: 'live',
    status: 'running',
    outputs: {} as Record<string, string>,
  };
  responses['runs:get'] = () => ({
    run,
    steps: [
      { stepId: 'intake', status: 'completed', attempts: 1 },
      { stepId: 'synthesis', status: 'pending', attempts: 0 },
    ],
    attempts: [{ usage: { totalTokens: 1200 } }],
  });
  responses['runs:getArtifact'] = ({ artifactId }) => ({
    _id: artifactId,
    payload: { executiveSummary: 'Risks to investigate' },
  });
  const pending = await callTool('get_report', { runId: 'run-1' });
  expect(pending.structuredContent?.data).toMatchObject({
    status: 'running',
    progress: '1/2 steps completed',
    totalTokens: 1200,
    report: null,
    next: 'Still running; call get_report again.',
  });

  // With waitSeconds, it polls until the run reaches a terminal state.
  let polls = 0;
  responses['runs:get'] = () => {
    if (++polls === 3) {
      run.status = 'completed';
      run.outputs = { report: 'artifact-9' };
    }
    return { run, steps: [], attempts: [] };
  };
  const done = await callTool('get_report', { runId: 'run-1', waitSeconds: 5 });
  expect(polls).toBe(3);
  expect(done.structuredContent?.data).toMatchObject({
    status: 'completed',
    reportArtifactId: 'artifact-9',
    report: { executiveSummary: 'Risks to investigate' },
  });
  expect(done.structuredContent?.data).not.toHaveProperty('next');
});

it('surfaces backend reasons locally and resolves the Convex URL', async () => {
  responses['runs:start'] = () => {
    throw new ConvexError('Live analysis is not enabled on this deployment');
  };
  const deck = await fixture('Deck.pdf', '%PDF-1.4 x');
  const result = await callTool('analyze_files', { paths: [deck] });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toBe(
    'Live analysis is not enabled on this deployment',
  );
  expect(describeLocalError('odd')).toBe('Operation failed');

  const envFile = await fixture(
    '.env.local',
    'XAI_API_KEY=secret\nCONVEX_URL="https://demo.convex.cloud"\n',
  );
  expect(resolveConvexUrl({}, new URL(`file://${envFile}`))).toBe(
    'https://demo.convex.cloud',
  );
  expect(
    resolveConvexUrl(
      { CONVEX_URL: 'https://env.convex.cloud' },
      new URL(`file://${envFile}`),
    ),
  ).toBe('https://env.convex.cloud');
  expect(resolveConvexUrl({}, new URL('file:///nonexistent/.env.local'))).toBe(
    undefined,
  );
});

it('creates the demo workspace before the first workspace listing', async () => {
  responses['organizations:list'] = () => [{ _id: 'org-1' }];
  const result = await callTool('list_workspaces', {});
  expect(result.structuredContent?.data).toEqual([{ _id: 'org-1' }]);
  expect(calls.map(([, name]) => name)).toEqual([
    'organizations:createPersonal',
    'organizations:list',
  ]);
});
