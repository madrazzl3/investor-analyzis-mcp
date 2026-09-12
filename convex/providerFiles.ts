import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';

export const record = internalMutation({
  args: {
    documentVersionId: v.id('documentVersions'),
    attemptId: v.id('agentAttempts'),
    providerFileId: v.string(),
  },
  handler: async (ctx, args) => {
    const attempt = await ctx.db.get(args.attemptId);
    const run = attempt ? await ctx.db.get(attempt.runId) : null;
    const document = await ctx.db.get(args.documentVersionId);
    if (
      !run ||
      !document ||
      document.caseId !== run.caseId ||
      !run.documentVersionIds.includes(document._id)
    )
      throw new Error('Source access denied');
    // Retain cleanup tracking even if the run was cancelled while the upload finished.
    const existing = await ctx.db
      .query('providerFiles')
      .withIndex('by_attempt', (q) => q.eq('attemptId', args.attemptId))
      .collect();
    const prior = existing.find(
      (file) => file.providerFileId === args.providerFileId,
    );
    if (prior) return prior._id;
    return await ctx.db.insert('providerFiles', {
      ...args,
      status: 'uploaded',
    });
  },
});

export const mark = internalMutation({
  args: {
    attemptId: v.id('agentAttempts'),
    providerFileId: v.string(),
    status: v.union(v.literal('deleted'), v.literal('cleanup_failed')),
  },
  handler: async (ctx, args) => {
    const files = await ctx.db
      .query('providerFiles')
      .withIndex('by_attempt', (q) => q.eq('attemptId', args.attemptId))
      .collect();
    const file = files.find(
      (item) => item.providerFileId === args.providerFileId,
    );
    if (!file) throw new Error('Provider file record missing');
    if (file.status !== 'deleted')
      await ctx.db.patch(file._id, { status: args.status });
  },
});

/**
 * Undeleted provider copies whose attempt finished, or whose attempt is still
 * marked running but started before `before` (its action can no longer be
 * alive). Oldest first; bounded per reconciliation pass.
 */
export const abandoned = internalQuery({
  args: { before: v.number() },
  handler: async (ctx, args) => {
    const result = [];
    for (const status of ['uploaded', 'cleanup_failed'] as const) {
      const files = await ctx.db
        .query('providerFiles')
        .withIndex('by_status', (q) => q.eq('status', status))
        .take(100);
      for (const file of files) {
        const attempt = await ctx.db.get(file.attemptId);
        if (
          !attempt ||
          attempt.status !== 'running' ||
          attempt._creationTime < args.before
        )
          result.push(file);
      }
    }
    return result.slice(0, 50);
  },
});
