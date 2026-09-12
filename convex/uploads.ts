import { mutation, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { requireCase, type ReadCtx } from './access';
import type { Id } from './_generated/dataModel';
import { MAX_DOCUMENT_BYTES } from './documents';

const uploadArgs = {
  uploadId: v.id('uploadIntents'),
  storageId: v.id('_storage'),
};
async function authorized(ctx: ReadCtx, uploadId: Id<'uploadIntents'>) {
  const intent = await ctx.db.get(uploadId);
  if (!intent) throw new Error('Upload unavailable');
  const { member } = await requireCase(ctx, intent.caseId);
  if (member._id !== intent.ownerId) throw new Error('Access denied');
  return intent;
}

export const prepare = mutation({
  args: {
    caseId: v.id('cases'),
    requestId: v.string(),
    name: v.string(),
    contentType: v.union(v.literal('application/pdf'), v.literal('text/plain')),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    const { member } = await requireCase(ctx, args.caseId);
    if (
      !args.name.trim() ||
      args.name.length > 200 ||
      !args.requestId.trim() ||
      args.requestId.length > 128 ||
      !Number.isInteger(args.size) ||
      args.size < 1 ||
      args.size > MAX_DOCUMENT_BYTES
    )
      throw new Error(
        'Invalid upload; maximum size is 100 MB (100,000,000 bytes)',
      );
    let intent = await ctx.db
      .query('uploadIntents')
      .withIndex('by_case_request', (q) =>
        q.eq('caseId', args.caseId).eq('requestId', args.requestId),
      )
      .unique();
    if (
      intent &&
      (intent.ownerId !== member._id ||
        intent.name !== args.name ||
        intent.contentType !== args.contentType ||
        intent.size !== args.size)
    )
      throw new Error('Idempotency key reused with different upload');
    if (!intent) {
      // Convex stores Content-Type as immutable file metadata. This secret,
      // per-intent parameter binds the upload receipt to this user and case.
      const uploadId = await ctx.db.insert('uploadIntents', {
        ...args,
        ownerId: member._id,
        uploadContentType: `${args.contentType}; upload-token=${crypto.randomUUID()}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      intent = (await ctx.db.get(uploadId))!;
    }
    if (intent.documentVersionId)
      return {
        uploadId: intent._id,
        documentVersionId: intent.documentVersionId,
      };
    if (intent.expiresAt <= Date.now())
      throw new Error('Upload expired; use a new requestId');
    return {
      uploadId: intent._id,
      uploadUrl: await ctx.storage.generateUploadUrl(),
      method: 'POST' as const,
      headers: { 'Content-Type': intent.uploadContentType },
      expiresAt: intent.expiresAt,
      maxBytes: MAX_DOCUMENT_BYTES,
      storageId: intent.storageId,
    };
  },
});

export const inspect = internalQuery({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const intent = await authorized(ctx, args.uploadId);
    if (intent.storageId && intent.storageId !== args.storageId)
      throw new Error('Upload already bound to a different file');
    if (intent.documentVersionId) return { intent, url: null };
    if (intent.expiresAt <= Date.now()) throw new Error('Upload expired');
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      !metadata ||
      metadata.contentType !== intent.uploadContentType ||
      metadata.size !== intent.size ||
      metadata.size > MAX_DOCUMENT_BYTES ||
      metadata._creationTime < intent._creationTime
    )
      throw new Error('File does not match this upload');
    return { intent, url: await ctx.storage.getUrl(args.storageId) };
  },
});

export const claim = internalMutation({
  args: uploadArgs,
  handler: async (ctx, args) => {
    const intent = await authorized(ctx, args.uploadId);
    if (intent.storageId && intent.storageId !== args.storageId)
      throw new Error('Upload already bound to a different file');
    if (!intent.documentVersionId && intent.expiresAt <= Date.now())
      throw new Error('Upload expired');
    const meta = await ctx.db.system.get(args.storageId);
    if (
      !meta ||
      meta.contentType !== intent.uploadContentType ||
      meta.size !== intent.size ||
      meta._creationTime < intent._creationTime
    )
      throw new Error('File does not match this upload');
    await ctx.db.patch(intent._id, { storageId: args.storageId });
  },
});

export const commit = internalMutation({
  args: { ...uploadArgs, sha256: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ documentVersionId: Id<'documentVersions'> }> => {
    const intent = await authorized(ctx, args.uploadId);
    if (intent.storageId !== args.storageId)
      throw new Error('Upload not claimed');
    if (intent.documentVersionId)
      return { documentVersionId: intent.documentVersionId };
    if (intent.expiresAt <= Date.now()) throw new Error('Upload expired');
    const metadata = await ctx.db.system.get(args.storageId);
    if (
      !metadata ||
      metadata.sha256 !== args.sha256 ||
      metadata.size !== intent.size ||
      metadata.contentType !== intent.uploadContentType
    )
      throw new Error('File integrity check failed');
    const prior = await ctx.db
      .query('documentVersions')
      .withIndex('by_case_request', (q) =>
        q.eq('caseId', intent.caseId).eq('requestId', intent.requestId),
      )
      .unique();
    if (prior) throw new Error('Request ID already used by another upload');
    const documentVersionId = await ctx.db.insert('documentVersions', {
      caseId: intent.caseId,
      requestId: intent.requestId,
      name: intent.name,
      contentType: intent.contentType,
      size: metadata.size,
      sha256: metadata.sha256,
      storageId: args.storageId,
      synthetic: false,
    });
    await ctx.db.patch(intent._id, { documentVersionId });
    return { documentVersionId };
  },
});

// Scan metadata only: even abandoned POSTs without a finalization receipt are
// reclaimed. Preserve committed originals and unrelated storage namespaces.
export const cleanup = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const batch = await ctx.db.system
      .query('_storage')
      .paginate({ cursor: args.cursor, numItems: 100 });
    for (const file of batch.page) {
      if (!file.contentType?.includes('; upload-token=')) continue;
      const intent = await ctx.db
        .query('uploadIntents')
        .withIndex('by_upload_content_type', (q) =>
          q.eq('uploadContentType', file.contentType!),
        )
        .unique();
      if (
        intent &&
        intent.expiresAt <= Date.now() &&
        (!intent.documentVersionId || intent.storageId !== file._id)
      )
        await ctx.storage.delete(file._id);
    }
    if (!batch.isDone)
      await ctx.scheduler.runAfter(0, internal.uploads.cleanup, {
        cursor: batch.continueCursor,
      });
  },
});
