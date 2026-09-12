import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireIdentity } from './identity';
import { ConvexError } from 'convex/values';
export type ReadCtx = Pick<QueryCtx | MutationCtx, 'db' | 'auth'>;
export async function requireOrganization(
  ctx: ReadCtx,
  organizationId: Id<'organizations'>,
) {
  const identity = await requireIdentity(ctx);
  if (identity.delegated && identity.organizationId !== organizationId)
    throw new ConvexError('Access denied');
  const member = await ctx.db
    .query('memberships')
    .withIndex('by_organization_identity', (q) =>
      q
        .eq('organizationId', organizationId)
        .eq('issuer', identity.issuer)
        .eq('subject', identity.subject),
    )
    .unique();
  if (!member) throw new ConvexError('Access denied');
  return member;
}
export async function requireCase(ctx: ReadCtx, caseId: Id<'cases'>) {
  // Reject anonymous callers before revealing whether the document exists.
  await requireIdentity(ctx);
  const item = await ctx.db.get(caseId);
  if (!item) throw new ConvexError('Access denied');
  const member = await requireOrganization(ctx, item.organizationId);
  return { item, member };
}
export async function requireRun(ctx: ReadCtx, runId: Id<'analysisRuns'>) {
  await requireIdentity(ctx);
  const run = await ctx.db.get(runId);
  if (!run) throw new ConvexError('Access denied');
  await requireCase(ctx, run.caseId);
  return run;
}
