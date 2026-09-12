import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server';
import { v, ConvexError } from 'convex/values';
import { requireOrganization } from './access';
import { requireIdentity } from './identity';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { workosConfig } from './mcpConfig';

async function browserActor(ctx: Pick<QueryCtx | MutationCtx, 'db' | 'auth'>) {
  const raw = await ctx.auth.getUserIdentity();
  if (!raw || raw.issuer !== process.env.CONVEX_SITE_URL)
    throw new ConvexError('Website sign-in required');
  return requireIdentity(ctx);
}
// IDs identify local grants, never credentials. Only browser sessions can manage them.
export const list = query({
  args: {},
  handler: async (ctx) => {
    const actor = await browserActor(ctx);
    return ctx.db
      .query('mcpConnections')
      .withIndex('by_owner', (q) => q.eq('ownerSubject', actor.subject))
      .take(100);
  },
});
export const revoke = mutation({
  args: { connectionId: v.id('mcpConnections') },
  handler: async (ctx, { connectionId }) => {
    const actor = await browserActor(ctx);
    const connection = await ctx.db.get(connectionId);
    if (!connection || connection.ownerSubject !== actor.subject)
      throw new ConvexError('Access denied');
    if (connection.status !== 'revoked')
      await ctx.db.patch(connectionId, {
        status: 'revoked',
        revokedAt: Date.now(),
      });
  },
});
export const prepare = internalMutation({
  args: { organizationId: v.id('organizations'), externalAuthId: v.string() },
  handler: async (ctx, args) => {
    const actor = await browserActor(ctx);
    const { issuer } = workosConfig();
    const member = await requireOrganization(ctx, args.organizationId);
    const userId = ctx.db.normalizeId('users', actor.subject);
    const user = userId && (await ctx.db.get(userId));
    if (!user?.email) throw new ConvexError('Account email required');
    const existing = await ctx.db
      .query('mcpConnections')
      .withIndex('by_flow', (q) => q.eq('externalAuthId', args.externalAuthId))
      .unique();
    if (existing)
      throw new ConvexError(
        'Authorization attempt already used; restart connection',
      );
    const organization = await ctx.db.get(args.organizationId);
    const connectionId = await ctx.db.insert('mcpConnections', {
      ownerSubject: actor.subject,
      membershipId: member._id,
      organizationId: args.organizationId,
      externalAuthId: args.externalAuthId,
      providerIssuer: issuer,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + 10 * 60_000,
    });
    return {
      connectionId,
      externalId: `${actor.issuer}#${actor.subject}`,
      email: user.email,
      organizationName: organization!.name,
    };
  },
});
export const activate = internalMutation({
  args: { connectionId: v.id('mcpConnections'), providerSubject: v.string() },
  handler: async (ctx, args) => {
    const actor = await browserActor(ctx);
    const connection = await ctx.db.get(args.connectionId);
    if (
      !connection ||
      connection.ownerSubject !== actor.subject ||
      connection.status !== 'pending' ||
      connection.expiresAt < Date.now()
    )
      throw new ConvexError('Authorization attempt unavailable');
    const member = await requireOrganization(ctx, connection.organizationId);
    if (member._id !== connection.membershipId)
      throw new ConvexError('Access denied');
    await ctx.db.patch(args.connectionId, {
      providerSubject: args.providerSubject,
      status: 'awaiting_consent',
    });
  },
});
export const fail = internalMutation({
  args: { connectionId: v.id('mcpConnections') },
  handler: async (ctx, args) => {
    const actor = await browserActor(ctx);
    const connection = await ctx.db.get(args.connectionId);
    if (
      connection?.ownerSubject === actor.subject &&
      connection.status === 'pending'
    )
      await ctx.db.patch(args.connectionId, {
        status: 'revoked',
        revokedAt: Date.now(),
      });
  },
});
export const validate = internalQuery({
  args: {
    connectionId: v.id('mcpConnections'),
    providerSubject: v.string(),
    providerIssuer: v.string(),
    consentId: v.string(),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (
      !connection ||
      !['awaiting_consent', 'active'].includes(connection.status) ||
      connection.providerSubject !== args.providerSubject ||
      connection.providerIssuer !== args.providerIssuer ||
      (connection.consentId && connection.consentId !== args.consentId)
    )
      throw new Error('Access denied');
    const member = await ctx.db.get(connection.membershipId);
    if (
      !member ||
      member.organizationId !== connection.organizationId ||
      member.subject !== connection.ownerSubject ||
      member.issuer !== process.env.CONVEX_SITE_URL
    )
      throw new Error('Access denied');
    return null;
  },
});
export const bindConsent = internalMutation({
  args: {
    connectionId: v.id('mcpConnections'),
    consentId: v.string(),
    providerSubject: v.string(),
    providerIssuer: v.string(),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (
      !connection ||
      !['awaiting_consent', 'active'].includes(connection.status) ||
      connection.providerSubject !== args.providerSubject ||
      connection.providerIssuer !== args.providerIssuer ||
      (connection.consentId && connection.consentId !== args.consentId)
    )
      throw new Error('Access denied');
    if (!connection.consentId) {
      if (connection.expiresAt < Date.now())
        throw new Error('Authorization attempt expired');
      await ctx.db.patch(args.connectionId, {
        consentId: args.consentId,
        status: 'active',
      });
    }
  },
});
