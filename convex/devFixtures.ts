import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

// Administrator-only smoke fixture. Never a public onboarding or auth bypass.
export const seed = internalMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    if (process.env.ALLOW_SYNTHETIC_FIXTURES !== 'true')
      throw new Error('Synthetic seeding disabled');
    if (!/^[a-z0-9-]{1,80}$/.test(args.key))
      throw new Error('Invalid fixture key');
    const issuer = 'https://synthetic-auth.invalid',
      subject = `smoke-${args.key}`;
    const organizationId = await ctx.db.insert('organizations', {
      name: `Synthetic smoke ${args.key}`,
    });
    const memberId = await ctx.db.insert('memberships', {
      organizationId,
      issuer,
      subject,
      role: 'owner',
    });
    const caseId = await ctx.db.insert('cases', {
      organizationId,
      name: 'Synthetic smoke case',
      createdBy: memberId,
    });
    const documentId = await ctx.db.insert('documentVersions', {
      caseId,
      name: 'Synthetic smoke document — not investor data',
      synthetic: true,
    });
    return {
      organizationId,
      memberId,
      caseId,
      documentId,
      identity: { issuer, subject },
    };
  },
});

/** Remove only an administrator-created upload smoke case with no analysis runs. */
export const removeUploadSmoke = internalMutation({
  args: { caseId: v.id('cases'), key: v.string() },
  handler: async (ctx, { caseId, key }) => {
    if (process.env.ALLOW_SYNTHETIC_FIXTURES !== 'true')
      throw new Error('Synthetic seeding disabled');
    const item = await ctx.db.get(caseId);
    if (!item) return;
    const org = await ctx.db.get(item.organizationId);
    const member = await ctx.db.get(item.createdBy);
    if (
      item.name !== 'Synthetic smoke case' ||
      org?.name !== `Synthetic smoke ${key}` ||
      member?.subject !== `smoke-${key}` ||
      member.issuer !== 'https://synthetic-auth.invalid'
    )
      throw new Error('Not this smoke fixture');
    if (
      (
        await ctx.db
          .query('analysisRuns')
          .withIndex('by_case', (q) => q.eq('caseId', caseId))
          .take(1)
      ).length
    )
      throw new Error('Cannot remove analysis evidence');
    for (const doc of await ctx.db
      .query('documentVersions')
      .withIndex('by_case', (q) => q.eq('caseId', caseId))
      .collect()) {
      if (doc.storageId) await ctx.storage.delete(doc.storageId);
      await ctx.db.delete(doc._id);
    }
    for (const intent of await ctx.db
      .query('uploadIntents')
      .withIndex('by_case_request', (q) => q.eq('caseId', caseId))
      .collect()) {
      if (intent.storageId && (await ctx.db.system.get(intent.storageId)))
        await ctx.storage.delete(intent.storageId);
      await ctx.db.delete(intent._id);
    }
    await ctx.db.delete(caseId);
    await ctx.db.delete(member._id);
    await ctx.db.delete(item.organizationId);
  },
});
