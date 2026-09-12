// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
const modules = import.meta.glob('../../convex/**/*.{ts,js}');
afterEach(() => vi.unstubAllGlobals());
async function setup() {
  const t = convexTest(schema, modules);
  const issuer = 'https://test.invalid';
  const caseId = await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert('organizations', {
      name: 'Fixtures',
    });
    const createdBy = await ctx.db.insert('memberships', {
      organizationId,
      issuer,
      subject: 'alice',
      role: 'owner',
    });
    await ctx.db.insert('memberships', {
      organizationId,
      issuer,
      subject: 'bob',
      role: 'member',
    });
    return ctx.db.insert('cases', {
      organizationId,
      name: 'Synthetic',
      createdBy,
    });
  });
  const alice = t.withIdentity({ issuer, subject: 'alice' });
  const bob = t.withIdentity({ issuer, subject: 'bob' });
  const args = {
    caseId,
    name: 'fixture.pdf',
    requestId: 'direct-1',
    contentType: 'application/pdf' as const,
    size: 12,
  };
  const prepare = () => alice.mutation(api.uploads.prepare, args);
  async function store(
    contentType: string,
    data = '%PDF-fixture',
    size?: number,
    sha256?: string,
  ) {
    return t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob([data]));
      // convex-test omits Content-Type; emulate immutable metadata from a real
      // direct storage POST, and large-file metadata without allocating a Blob.
      await ctx.db.patch(
        storageId as never,
        {
          contentType,
          ...(size ? { size } : {}),
          ...(sha256 ? { sha256 } : {}),
        } as never,
      );
      return storageId;
    });
  }
  return { t, alice, bob, caseId, args, prepare, store };
}
describe('direct upload receipts', () => {
  it('binds metadata to an owner, rejects substitution, and reuses completion', async () => {
    const s = await setup();
    const prepared = await s.prepare();
    const storageId = await s.store(prepared.headers!['Content-Type']);
    const args = { uploadId: prepared.uploadId, storageId };
    await expect(
      s.bob.action(api.uploadValidation.attach, args),
    ).rejects.toThrow('Access denied');
    await expect(
      s.t.action(api.uploadValidation.attach, args),
    ).rejects.toThrow();
    const foreign = await s.store('application/pdf; upload-token=someone-else');
    await expect(
      s.alice.action(api.uploadValidation.attach, {
        ...args,
        storageId: foreign,
      }),
    ).rejects.toThrow('does not match');
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response('%PDF-fixture'));
    vi.stubGlobal('fetch', fetchMock);
    const completed = await s.alice.action(api.uploadValidation.attach, args);
    expect(await s.alice.action(api.uploadValidation.attach, args)).toEqual(
      completed,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await s.prepare()).documentVersionId).toBe(
      completed.documentVersionId,
    );
    expect(
      await s.alice.query(api.documents.list, { caseId: s.caseId }),
    ).toHaveLength(1);
    await expect(
      s.alice.action(api.uploadValidation.attach, {
        ...args,
        storageId: foreign,
      }),
    ).rejects.toThrow('different file');
  });
  it('rejects expired intents, conflicting requests and unauthorized preparation', async () => {
    const s = await setup();
    const prepared = await s.prepare();
    for (const caller of [s.t, s.bob])
      await expect(
        caller.mutation(api.uploads.prepare, s.args),
      ).rejects.toThrow();
    for (const size of [0, 100_000_001, 1.5])
      await expect(
        s.alice.mutation(api.uploads.prepare, {
          ...s.args,
          requestId: 'bad',
          size,
        }),
      ).rejects.toThrow();
    await expect(
      s.alice.mutation(api.uploads.prepare, { ...s.args, name: 'changed.pdf' }),
    ).rejects.toThrow('Idempotency');
    const storageId = await s.store(prepared.headers!['Content-Type']);
    await s.t.run((ctx) => ctx.db.patch(prepared.uploadId, { expiresAt: 0 }));
    await expect(
      s.alice.action(api.uploadValidation.attach, {
        uploadId: prepared.uploadId,
        storageId,
      }),
    ).rejects.toThrow('expired');
  });
  it('streams an exact 100 MB file through validation and checks its hash', async () => {
    const s = await setup();
    const size = 100_000_000;
    const prepared = await s.alice.mutation(api.uploads.prepare, {
      ...s.args,
      size,
    });
    const chunk = new Uint8Array(1_000_000).fill(32);
    chunk.set(new TextEncoder().encode('%PDF-'));
    const hash = createHash('sha256');
    for (let i = 0; i < 100; i++) hash.update(chunk);
    const storageId = await s.store(
      prepared.headers!['Content-Type'],
      '%PDF-fixture',
      size,
      hash.digest('base64'),
    );
    vi.stubGlobal('fetch', async () => {
      let remaining = 100;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
        }),
      );
    });
    const { documentVersionId } = await s.alice.action(
      api.uploadValidation.attach,
      { uploadId: prepared.uploadId, storageId },
    );
    expect(await s.t.run((ctx) => ctx.db.get(documentVersionId))).toMatchObject(
      { size, contentType: 'application/pdf' },
    );
  });
  it('rejects invalid signatures, invalid UTF-8 and altered file bytes', async () => {
    const s = await setup();
    for (const [i, contentType, data] of [
      [0, 'application/pdf', 'not-pdf-data'],
      [1, 'text/plain', new Uint8Array([0xff])],
      [2, 'application/pdf', '%PDF-altered'],
    ] as const) {
      const prepared = await s.alice.mutation(api.uploads.prepare, {
        ...s.args,
        requestId: `invalid-${i}`,
        contentType,
      });
      const storageId = await s.store(prepared.headers!['Content-Type']);
      vi.stubGlobal('fetch', async () => new Response(data));
      await expect(
        s.alice.action(api.uploadValidation.attach, {
          uploadId: prepared.uploadId,
          storageId,
        }),
      ).rejects.toThrow();
    }
    expect(
      await s.alice.query(api.documents.list, { caseId: s.caseId }),
    ).toHaveLength(0);
  });
  it('retries transient validation failures and cleans abandoned bytes without deleting evidence', async () => {
    const s = await setup();
    const prepared = await s.prepare();
    const storageId = await s.store(prepared.headers!['Content-Type']);
    const duplicate = await s.store(prepared.headers!['Content-Type']);
    const args = { uploadId: prepared.uploadId, storageId };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockImplementation(async () => new Response('%PDF-fixture')),
    );
    await expect(
      s.alice.action(api.uploadValidation.attach, args),
    ).rejects.toThrow('Network failure');
    expect((await s.prepare()).storageId).toBe(storageId);
    const completed = await s.alice.action(api.uploadValidation.attach, args);
    await s.t.run((ctx) => ctx.db.patch(prepared.uploadId, { expiresAt: 0 }));
    await s.t.mutation(internal.uploads.cleanup, { cursor: null });
    await s.t.run(async (ctx) => {
      expect(await ctx.db.system.get(duplicate)).toBeNull();
      expect(await ctx.db.system.get(storageId)).not.toBeNull();
      expect(await ctx.db.get(completed.documentVersionId)).not.toBeNull();
    });
  });
  it('rechecks membership before committing a validated file', async () => {
    const s = await setup();
    const prepared = await s.prepare();
    const storageId = await s.store(prepared.headers!['Content-Type']);
    const args = { uploadId: prepared.uploadId, storageId };
    await s.alice.mutation(internal.uploads.claim, args);
    await s.t.run(async (ctx) => {
      const intent = await ctx.db.get(prepared.uploadId);
      await ctx.db.delete(intent!.ownerId);
    });
    await expect(
      s.alice.mutation(internal.uploads.commit, { ...args, sha256: 'unused' }),
    ).rejects.toThrow('Access denied');
  });
});
