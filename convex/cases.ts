import { mutation, query } from './_generated/server';
import { v, ConvexError } from 'convex/values';
import { requireOrganization, requireCase } from './access';

export const create = mutation({
  args: { organizationId: v.id('organizations'), name: v.string() },
  handler: async (ctx, args) => {
    const member = await requireOrganization(ctx, args.organizationId);
    const name = args.name.trim();
    if (!name || name.length > 160)
      throw new ConvexError('Case name must be 1–160 characters');
    return ctx.db.insert('cases', {
      organizationId: args.organizationId,
      name,
      createdBy: member._id,
    });
  },
});
export const list = query({
  args: { organizationId: v.id('organizations') },
  handler: async (ctx, args) => {
    await requireOrganization(ctx, args.organizationId);
    return ctx.db
      .query('cases')
      .withIndex('by_organization', (q) =>
        q.eq('organizationId', args.organizationId),
      )
      .order('desc')
      .take(100);
  },
});
export const addSyntheticDocument = mutation({
  args: { caseId: v.id('cases') },
  handler: async (ctx, args) => {
    await requireCase(ctx, args.caseId);
    const existing = await ctx.db
      .query('documentVersions')
      .withIndex('by_case', (q) => q.eq('caseId', args.caseId))
      .filter((q) => q.eq(q.field('synthetic'), true))
      .first();
    return (
      existing?._id ??
      ctx.db.insert('documentVersions', {
        caseId: args.caseId,
        name: 'Synthetic workflow fixture — not investor evidence',
        synthetic: true,
      })
    );
  },
});
