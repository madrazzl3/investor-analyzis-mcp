import { mutation, query } from './_generated/server';
import { DEMO_IDENTITY, requireIdentity } from './identity';
import { ConvexError } from 'convex/values';

export const list = query({
  args: {},
  handler: async (ctx) => {
    const actor = await requireIdentity(ctx);
    const memberships = await ctx.db
      .query('memberships')
      .withIndex('by_identity', (q) =>
        q.eq('issuer', actor.issuer).eq('subject', actor.subject),
      )
      .take(100);
    const result = [];
    for (const member of memberships) {
      if (actor.delegated && actor.organizationId !== member.organizationId)
        continue;
      const organization = await ctx.db.get(member.organizationId);
      if (organization) result.push({ ...organization, role: member.role });
    }
    return result;
  },
});

// Transactional and idempotent: onboarding cannot join another user's workspace.
export const createPersonal = mutation({
  args: {},
  handler: async (ctx) => {
    const actor = await requireIdentity(ctx);
    if (actor.delegated) throw new ConvexError('Website sign-in required');
    const existing = await ctx.db
      .query('memberships')
      .withIndex('by_identity', (q) =>
        q.eq('issuer', actor.issuer).eq('subject', actor.subject),
      )
      .first();
    if (existing) return existing.organizationId;
    const organizationId = await ctx.db.insert('organizations', {
      name:
        actor.issuer === DEMO_IDENTITY.issuer
          ? 'Demo workspace'
          : 'My workspace',
    });
    await ctx.db.insert('memberships', {
      organizationId,
      ...actor,
      role: 'owner',
    });
    return organizationId;
  },
});
