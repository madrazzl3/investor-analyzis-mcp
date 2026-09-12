'use node';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { createHash } from 'node:crypto';
import type { Id } from './_generated/dataModel';

export const attach = action({
  args: { uploadId: v.id('uploadIntents'), storageId: v.id('_storage') },
  handler: async (
    ctx,
    args,
  ): Promise<{ documentVersionId: Id<'documentVersions'> }> => {
    const { intent, url } = await ctx.runQuery(internal.uploads.inspect, args);
    if (intent.documentVersionId)
      return { documentVersionId: intent.documentVersionId };
    await ctx.runMutation(internal.uploads.claim, args);
    if (!url) throw new Error('Uploaded file unavailable');
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok || !response.body)
      throw new Error('Unable to validate upload; retry attachment');
    const reader = response.body.getReader();
    const hash = createHash('sha256');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let prefix = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > intent.size) throw new Error('Upload exceeds declared size');
        hash.update(value);
        if (prefix.length < 5)
          prefix += new TextDecoder().decode(
            value.subarray(0, 5 - prefix.length),
          );
        if (intent.contentType === 'text/plain')
          decoder.decode(value, { stream: true });
      }
      if (intent.contentType === 'text/plain') decoder.decode();
      if (
        size !== intent.size ||
        (intent.contentType === 'application/pdf' && prefix !== '%PDF-')
      )
        throw new Error('Invalid document content');
    } finally {
      await reader.cancel();
    }
    return await ctx.runMutation(internal.uploads.commit, {
      ...args,
      sha256: hash.digest('base64'),
    });
  },
});
