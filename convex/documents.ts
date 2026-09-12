import {
  action,
  mutation,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { requireCase } from './access';
import type { Id } from './_generated/dataModel';

export const MAX_DOCUMENT_BYTES = 100_000_000;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
export const authorize = internalQuery({
  args: { caseId: v.id('cases') },
  handler: async (ctx, args) => {
    await requireCase(ctx, args.caseId);
    return null;
  },
});

export const list = query({
  args: { caseId: v.id('cases') },
  handler: async (ctx, args) => {
    await requireCase(ctx, args.caseId);
    const documents = await ctx.db
      .query('documentVersions')
      .withIndex('by_case', (q) => q.eq('caseId', args.caseId))
      .take(100);
    return documents.map(({ _id, name, synthetic, size, contentType }) => ({
      documentVersionId: _id,
      name,
      synthetic,
      size,
      contentType,
    }));
  },
});

export const register = internalMutation({
  args: {
    caseId: v.id('cases'),
    requestId: v.string(),
    name: v.string(),
    storageId: v.id('_storage'),
    sha256: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args): Promise<Id<'documentVersions'>> => {
    await requireCase(ctx, args.caseId);
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      !metadata ||
      metadata.size > MAX_DOCUMENT_BYTES ||
      (metadata.contentType !== undefined &&
        metadata.contentType !== args.contentType) ||
      metadata.sha256 !== args.sha256
    )
      throw new Error('Invalid storage metadata');
    const prior = await ctx.db
      .query('documentVersions')
      .withIndex('by_case_request', (q) =>
        q.eq('caseId', args.caseId).eq('requestId', args.requestId),
      )
      .unique();
    if (prior) {
      if (
        prior.sha256 !== args.sha256 ||
        prior.name !== args.name ||
        prior.contentType !== args.contentType
      )
        throw new Error('Idempotency key reused with different document');
      if (prior.storageId !== args.storageId)
        await ctx.storage.delete(args.storageId);
      return prior._id;
    }
    return await ctx.db.insert('documentVersions', {
      ...args,
      size: metadata.size,
      synthetic: false,
    });
  },
});

export const discardUnregistered = internalMutation({
  args: {
    caseId: v.id('cases'),
    requestId: v.string(),
    storageId: v.id('_storage'),
  },
  handler: async (ctx, args) => {
    // A registration response can fail after its transaction committed. Never
    // delete a source already linked by that logical upload.
    const registered = await ctx.db
      .query('documentVersions')
      .withIndex('by_case_request', (q) =>
        q.eq('caseId', args.caseId).eq('requestId', args.requestId),
      )
      .unique();
    if (registered?.storageId !== args.storageId)
      await ctx.storage.delete(args.storageId);
  },
});

/** Bounded action upload keeps storage ownership under the authenticated server. */
export const upload = action({
  args: {
    caseId: v.id('cases'),
    requestId: v.string(),
    name: v.string(),
    contentType: v.union(v.literal('application/pdf'), v.literal('text/plain')),
    base64: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ documentVersionId: Id<'documentVersions'> }> => {
    await ctx.runQuery(internal.documents.authorize, { caseId: args.caseId });
    if (
      !args.requestId.trim() ||
      args.requestId.length > 128 ||
      !args.name.trim() ||
      args.name.length > 200 ||
      args.base64.length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        args.base64,
      )
    )
      throw new Error('Invalid document upload');
    const bytes = Uint8Array.from(atob(args.base64), (character) =>
      character.charCodeAt(0),
    );
    if (!bytes.length || bytes.length > MAX_INLINE_BYTES)
      throw new Error('Document exceeds upload limit');
    if (
      args.contentType === 'application/pdf' &&
      new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-'
    )
      throw new Error('Invalid PDF signature');
    if (args.contentType === 'text/plain') {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('Transcript must be UTF-8');
      }
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = btoa(String.fromCharCode(...digest));
    const storageId = await ctx.storage.store(
      new Blob([bytes], { type: args.contentType }),
    );
    try {
      const documentVersionId = await ctx.runMutation(
        internal.documents.register,
        {
          caseId: args.caseId,
          requestId: args.requestId,
          name: args.name,
          storageId,
          sha256,
          contentType: args.contentType,
        },
      );
      return { documentVersionId };
    } catch (error) {
      await ctx.runMutation(internal.documents.discardUnregistered, {
        caseId: args.caseId,
        requestId: args.requestId,
        storageId,
      });
      throw error;
    }
  },
});
