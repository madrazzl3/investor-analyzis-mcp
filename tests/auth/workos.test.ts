import { describe, expect, it, vi } from 'vitest';
import { completeWithWorkOS } from '../../convex/mcpOAuth';
import { publicBridgeKeys } from '../../convex/mcpBridge';
import {
  readAuthSettings,
  createAuthenticator,
} from '../../apps/mcp-server/src/auth';
import { createLocalJWKSet, generateKeyPair, exportJWK, SignJWT } from 'jose';
const args = {
  externalAuthId: 'ext_auth_123456789',
  externalId: 'https://convex.site#alice',
  email: 'alice@example.invalid',
  connectionId: 'grant1',
  organizationName: 'Workspace',
};
const config = {
  issuer: 'https://tenant.authkit.app',
  apiKey: 'provider-test-secret',
};

describe('WorkOS completion and token contract', () => {
  it('passes only server-derived identity and grant to WorkOS and maps by external ID', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          redirect_uri: `${config.issuer}/oauth2/complete?state=test`,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: 'user_alice', external_id: args.externalId }),
      );
    const result = await completeWithWorkOS(args, config, fetcher);
    expect(result.providerSubject).toBe('user_alice');
    const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
    expect(body.user).toEqual({ id: args.externalId, email: args.email });
    expect(body.user_consent_options[0].choices).toEqual([
      { value: 'grant1', label: 'Workspace' },
    ]);
    expect(fetcher.mock.calls[1]![0]).toContain(
      encodeURIComponent(args.externalId),
    );
  });
  it('rejects foreign redirects, user mapping mismatch, malformed responses and provider errors without leaking diagnostics', async () => {
    const cases = [
      [Response.json({ redirect_uri: 'https://evil.example/steal' })],
      [
        Response.json({ redirect_uri: `${config.issuer}/complete` }),
        Response.json({ id: 'user_alice', external_id: 'bob' }),
      ],
      [new Response('secret diagnostics', { status: 500 })],
      [new Response('not JSON')],
    ];
    for (const responses of cases) {
      const fetcher = vi.fn<typeof fetch>();
      for (const response of responses) fetcher.mockResolvedValueOnce(response);
      await expect(completeWithWorkOS(args, config, fetcher)).rejects.toThrow(
        'Unable to complete MCP authorization; restart the connection',
      );
    }
  });
  it('never publishes private JWK material', () => {
    const publicKeys = publicBridgeKeys(
      JSON.stringify({
        keys: [
          { kty: 'RSA', n: 'n', e: 'e', kid: 'id', d: 'private', p: 'private' },
        ],
      }),
    );
    expect(JSON.stringify(publicKeys)).not.toContain('private');
  });
  it('fails closed without WorkOS configuration and requires a user consent grant, not just a signed ID token', async () => {
    expect(readAuthSettings({ MCP_AUTH_PROVIDER: 'workos' })).toBeUndefined();
    const settings = readAuthSettings({
      MCP_AUTH_PROVIDER: 'workos',
      MCP_RESOURCE_URL: 'https://mcp.example/mcp',
      WORKOS_AUTHKIT_ISSUER: config.issuer,
      CONVEX_URL: 'https://test.convex.cloud',
      CONVEX_SITE_URL: 'https://test.convex.site',
      MCP_BRIDGE_CLIENT_ID: 'mcp',
      MCP_BRIDGE_CLIENT_SECRET: 'secret',
    })!;
    const keys = await generateKeyPair('RS256');
    const verify = createAuthenticator(
      settings,
      createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] }),
    );
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(config.issuer)
        .setAudience(settings.resource)
        .setSubject('user_alice')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
    await expect(verify(`Bearer ${await sign({})}`)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      verify(
        `Bearer ${await sign({ sid: 'consent1', 'urn:investor:mcp-grant': 'grant1' })}`,
      ),
    ).resolves.toMatchObject({ subject: 'user_alice' });
  });
});
