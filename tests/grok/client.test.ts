import { describe, expect, it, vi } from 'vitest';
import {
  GrokClient,
  GrokError,
  runWithPrivateFiles,
  type GrokRequest,
} from '../../packages/grok/src/index';

const source = {
  documentVersionId: 'version-1',
  name: 'Private company.pdf',
  blob: new Blob(['%PDF-1.7 synthetic'], { type: 'application/pdf' }),
};
const request = (): GrokRequest => ({
  model: 'grok-test',
  prompt: 'Extract claims',
  inputs: { documents: [{ documentVersionId: 'version-1' }] },
  schema: { type: 'object' },
  maxOutputTokens: 100,
  maxToolCalls: 2,
  timeoutMs: 1000,
  files: [source],
  validate(output) {
    if (!output || typeof output !== 'object' || !('claims' in output))
      throw Error('invalid');
  },
});
const completion = (text = '{"claims":[]}') =>
  Response.json({
    id: 'response-1',
    status: 'completed',
    model: 'grok-test-pinned',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 25, output_tokens: 10, total_tokens: 35 },
  });
const lifecycle = () => ({
  uploaded: vi.fn(async () => {}),
  deleted: vi.fn(async () => {}),
  cleanupFailed: vi.fn(async () => {}),
});

describe('private Grok adapter', () => {
  it('uploads authenticated private files, validates output, accounts tokens and deletes copies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-1' }))
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(Response.json({ deleted: true }));
    const tracking = lifecycle();
    const result = await runWithPrivateFiles(
      new GrokClient('test-key', fetcher),
      request(),
      tracking,
    );
    expect(result.usage.totalTokens).toBe(35);
    expect(result.model).toBe('grok-test-pinned');
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect((form.get('file') as File).name).toBe('version-1.pdf');
    const payload = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(payload.store).toBe(false);
    expect(payload.max_tool_calls).toBe(2);
    expect(JSON.stringify(payload)).not.toContain('file_url');
    expect(payload.input[1].content[1]).toEqual({
      type: 'input_file',
      file_id: 'file-1',
    });
    expect(tracking.uploaded).toHaveBeenCalledWith(source, 'file-1');
    expect(tracking.deleted).toHaveBeenCalledWith('file-1');
  });
  it('rejects invalid JSON/schema outputs and cleans provider files', async () => {
    for (const text of ['bad json', '{"unexpected":true}']) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ id: 'file-1' }))
        .mockResolvedValueOnce(completion(text))
        .mockResolvedValueOnce(Response.json({ deleted: true }));
      const tracking = lifecycle();
      await expect(
        runWithPrivateFiles(
          new GrokClient('test-key', fetcher),
          request(),
          tracking,
        ),
      ).rejects.toThrow('invalid_output');
      expect(tracking.deleted).toHaveBeenCalledWith('file-1');
    }
  });
  it('redacts provider errors and delegates retries to the workflow', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('secret prompt and key', { status: 429 }),
      );
    const result = await new GrokClient('test-key', fetcher)
      .generate(request(), [])
      .catch((error) => error);
    expect(result).toBeInstanceOf(GrokError);
    expect(result.retryable).toBe(true);
    expect(result.message).not.toContain('secret');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('records cleanup failure without losing a validated response', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-1' }))
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    const tracking = lifecycle();
    expect(
      (
        await runWithPrivateFiles(
          new GrokClient('test-key', fetcher),
          request(),
          tracking,
        )
      ).output,
    ).toEqual({ claims: [] });
    expect(tracking.cleanupFailed).toHaveBeenCalledWith('file-1');
  });
  it('cleans a file when recording ownership fails and never calls the model', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-1' }))
      .mockResolvedValueOnce(Response.json({ deleted: true }));
    const tracking = lifecycle();
    tracking.uploaded.mockRejectedValueOnce(Error('database unavailable'));
    await expect(
      runWithPrivateFiles(
        new GrokClient('test-key', fetcher),
        request(),
        tracking,
      ),
    ).rejects.toThrow('database unavailable');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps deleting and returns the result when a cleanup status write fails', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: 'file-1' }))
      .mockResolvedValueOnce(Response.json({ id: 'file-2' }))
      .mockResolvedValueOnce(completion())
      .mockResolvedValueOnce(Response.json({ deleted: true }))
      .mockResolvedValueOnce(Response.json({ deleted: true }));
    const tracking = lifecycle();
    tracking.deleted.mockRejectedValueOnce(Error('database unavailable'));
    const result = await runWithPrivateFiles(
      new GrokClient('test-key', fetcher),
      { ...request(), files: [source, { ...source, documentVersionId: 'v2' }] },
      tracking,
    );
    expect(result.output).toEqual({ claims: [] });
    const deletes = fetcher.mock.calls.filter(
      ([, init]) => init?.method === 'DELETE',
    );
    expect(deletes.map(([url]) => url)).toEqual([
      'https://api.x.ai/v1/files/file-1',
      'https://api.x.ai/v1/files/file-2',
    ]);
    expect(tracking.cleanupFailed).not.toHaveBeenCalled();
  });
  it('refuses missing configuration and invalid budgets', async () => {
    expect(() => new GrokClient('')).toThrow('configuration');
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new GrokClient('test-key', fetcher).generate(
        { ...request(), maxOutputTokens: 0 },
        [],
      ),
    ).rejects.toThrow('budget');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
