import { getAuthUserId } from '@convex-dev/auth/server';
import type { QueryCtx, MutationCtx } from './_generated/server';
import { ConvexError } from 'convex/values';
import { bridgeIssuer, workosConfig } from './mcpConfig';
import type { Id } from './_generated/dataModel';

/**
 * Demo deployments (DEMO_OPEN_ACCESS=true) treat unauthenticated callers as one
 * shared demo actor. It is still membership-checked, so it reaches only the
 * workspace it creates, never a signed-in user's data. The issuer is not a URL,
 * so no real token issuer can collide with it.
 */
export const DEMO_IDENTITY = {
  issuer: 'urn:investor-analysis:demo',
  subject: 'demo',
} as const;
export function demoOpenAccess() {
  return process.env.DEMO_OPEN_ACCESS === 'true';
}

// Convex Auth subjects contain a session suffix. Membership is bound to the user.
// Only normalize the trusted Convex issuer; external identities remain opaque.
export async function requireIdentity(
  ctx: Pick<QueryCtx | MutationCtx, 'auth' | 'db'>,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    if (demoOpenAccess()) return { ...DEMO_IDENTITY };
    throw new ConvexError('Authentication required');
  }
  if (process.env.MCP_BRIDGE_JWKS && identity.issuer === bridgeIssuer()) {
    const id =
      typeof identity.mcpConnectionId === 'string' &&
      ctx.db.normalizeId('mcpConnections', identity.mcpConnectionId);
    const connection = id && (await ctx.db.get(id));
    if (
      !connection ||
      connection.status !== 'active' ||
      connection.providerSubject !== identity.subject ||
      connection.providerIssuer !== workosConfig().issuer ||
      !connection.consentId ||
      connection.consentId !== identity.mcpConsentId
    )
      throw new ConvexError('MCP connection revoked or invalid');
    const member = await ctx.db.get(connection.membershipId);
    if (
      !member ||
      member.subject !== connection.ownerSubject ||
      member.issuer !== process.env.CONVEX_SITE_URL ||
      member.organizationId !== connection.organizationId
    )
      throw new ConvexError('Access denied');
    return {
      issuer: member.issuer,
      subject: member.subject,
      organizationId: connection.organizationId as Id<'organizations'>,
      delegated: true as const,
    };
  }

  if (
    process.env.CONVEX_SITE_URL &&
    identity.issuer === process.env.CONVEX_SITE_URL
  ) {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError('Authentication required');
    return { issuer: identity.issuer, subject: userId as string };
  }
  return { issuer: identity.issuer, subject: identity.subject };
}
