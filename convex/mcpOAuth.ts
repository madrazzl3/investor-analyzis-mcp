import { action } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { MCP_GRANT_CLAIM, workosConfig } from './mcpConfig';

export async function completeWithWorkOS(
  args: {
    externalAuthId: string;
    externalId: string;
    email: string;
    connectionId: string;
    organizationName: string;
  },
  config: { issuer: string; apiKey: string },
  fetcher: typeof fetch = fetch,
) {
  const request = async (path: string, body?: unknown) => {
    const response = await fetcher(`https://api.workos.com${path}`, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error('Authorization provider unavailable');
    return response.json();
  };
  try {
    const completion = await request('/authkit/oauth2/complete', {
      external_auth_id: args.externalAuthId,
      user: { id: args.externalId, email: args.email },
      user_consent_options: [
        {
          claim: MCP_GRANT_CLAIM,
          type: 'enum',
          label:
            'Workspace access: read and manage cases, analyses, and reports',
          choices: [{ value: args.connectionId, label: args.organizationName }],
        },
      ],
    });
    if (typeof completion.redirect_uri !== 'string') throw new Error();
    const redirect = new URL(completion.redirect_uri);
    if (
      redirect.origin !== config.issuer ||
      redirect.protocol !== 'https:' ||
      redirect.username ||
      redirect.password ||
      redirect.hash
    )
      throw new Error();
    // WorkOS sub is its own user ID, not the external ID we supplied. Never map by email.
    const user = await request(
      `/user_management/users/external_id/${encodeURIComponent(args.externalId)}`,
    );
    if (
      typeof user.id !== 'string' ||
      !user.id.startsWith('user_') ||
      user.external_id !== args.externalId
    )
      throw new Error();
    return { redirectUri: redirect.href, providerSubject: user.id as string };
  } catch {
    throw new Error(
      'Unable to complete MCP authorization; restart the connection',
    );
  }
}

/** Future login page calls this only after an explicit Continue gesture. */
export const completeBrowserLogin = action({
  args: { externalAuthId: v.string(), organizationId: v.id('organizations') },
  handler: async (ctx, args): Promise<{ redirectUri: string }> => {
    if (!/^[a-zA-Z0-9_-]{16,200}$/.test(args.externalAuthId))
      throw new Error('Invalid authorization attempt');
    const { issuer } = workosConfig();
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) throw new Error('MCP authorization is not configured');
    // The mutation authenticates the browser, authorizes membership, and fixes the actor.
    const prepared = await ctx.runMutation(
      internal.mcpConnections.prepare,
      args,
    );
    try {
      const result = await completeWithWorkOS(
        { ...prepared, externalAuthId: args.externalAuthId },
        { issuer, apiKey },
      );
      await ctx.runMutation(internal.mcpConnections.activate, {
        connectionId: prepared.connectionId,
        providerSubject: result.providerSubject,
      });
      return { redirectUri: result.redirectUri };
    } catch {
      await ctx.runMutation(internal.mcpConnections.fail, {
        connectionId: prepared.connectionId,
      });
      throw new Error(
        'Unable to complete MCP authorization; restart the connection',
      );
    }
  },
});
