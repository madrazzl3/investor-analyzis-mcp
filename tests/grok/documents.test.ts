// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';

const modules = import.meta.glob('../../convex/**/*.{ts,js}');
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
    return await ctx.db.insert('cases', {
      organizationId,
      name: 'Synthetic case',
      createdBy,
    });
  });
  return {
    t,
    caseId,
    alice: t.withIdentity({ issuer, subject: 'alice' }),
    bob: t.withIdentity({ issuer, subject: 'bob' }),
  };
}
const body = {
  requestId: 'upload-1',
  name: 'fixture.pdf',
  contentType: 'application/pdf' as const,
  base64: btoa('%PDF-1.7\nSynthetic test only'),
};
describe('authorized document ingestion', () => {
  it('stores immutable private source metadata and deduplicates repeated uploads', async () => {
    const s = await setup();
    const first = await s.alice.action(api.documents.upload, {
      ...body,
      caseId: s.caseId,
    });
    expect(
      await s.alice.action(api.documents.upload, { ...body, caseId: s.caseId }),
    ).toEqual(first);
    const items = await s.alice.query(api.documents.list, { caseId: s.caseId });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ synthetic: false, name: 'fixture.pdf' });
    expect(items[0]).not.toHaveProperty('storageId');
    await s.t.run(async (ctx) => {
      const doc = await ctx.db.get(first.documentVersionId);
      expect(doc?.sha256).toBeTruthy();
      expect(await ctx.db.system.query('_storage').collect()).toHaveLength(1);
    });
    const registered = await s.t.run((ctx) =>
      ctx.db.get(first.documentVersionId),
    );
    await s.t.mutation(internal.documents.discardUnregistered, {
      caseId: s.caseId,
      requestId: body.requestId,
      storageId: registered!.storageId!,
    });
    await s.t.run(async (ctx) => {
      expect(await ctx.storage.get(registered!.storageId!)).not.toBeNull();
    });
    await expect(
      s.alice.action(api.documents.upload, {
        ...body,
        caseId: s.caseId,
        base64: btoa('%PDF-1.7\nChanged'),
      }),
    ).rejects.toThrow('Idempotency');
  });
  it('denies anonymous and unrelated identities before storing bytes', async () => {
    const s = await setup();
    for (const caller of [s.t, s.bob]) {
      await expect(
        caller.action(api.documents.upload, { ...body, caseId: s.caseId }),
      ).rejects.toThrow();
      await expect(
        caller.query(api.documents.list, { caseId: s.caseId }),
      ).rejects.toThrow();
    }
    await s.t.run(async (ctx) => {
      expect(await ctx.db.system.query('_storage').collect()).toHaveLength(0);
    });
  });
  it('rejects invalid PDFs and malformed base64 without creating sources', async () => {
    const s = await setup();
    for (const base64 of ['not base64', btoa('not a PDF'), '']) {
      await expect(
        s.alice.action(api.documents.upload, {
          ...body,
          caseId: s.caseId,
          base64,
        }),
      ).rejects.toThrow();
    }
    expect(
      await s.alice.query(api.documents.list, { caseId: s.caseId }),
    ).toHaveLength(0);
  });
});
