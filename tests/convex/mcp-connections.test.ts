// @vitest-environment edge-runtime
/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  generateKeyPair,
  exportJWK,
  exportPKCS8,
  SignJWT,
  jwtVerify,
} from 'jose';
import schema from '../../convex/schema';
import { api, internal } from '../../convex/_generated/api';
import { MCP_GRANT_CLAIM, MCP_BACKEND_AUDIENCE } from '../../convex/mcpConfig';

const modules = import.meta.glob('../../convex/**/*.{ts,js}');
const issuer = 'https://test.convex.site';
const provider = 'https://example.authkit.app';
const resource = 'https://mcp.example/mcp';
beforeEach(() => {
  vi.stubEnv('CONVEX_SITE_URL', issuer);
  vi.stubEnv('WORKOS_AUTHKIT_ISSUER', provider);
  vi.stubEnv('WORKOS_API_KEY', 'test-provider-key');
  vi.stubEnv('MCP_RESOURCE_URL', resource);
  vi.stubEnv('MCP_BRIDGE_JWKS', '{"keys":[]}');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function setup() {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) =>
    ctx.db.insert('users', { email: 'alice@example.invalid' }),
  );
  const alice = t.withIdentity({ issuer, subject: `${userId}|session-one` });
  const bob = t.withIdentity({ issuer, subject: 'bob|session' });
  const organizationId = await alice.mutation(
    api.organizations.createPersonal,
    {},
  );
  const anotherOrg = await t.run(async (ctx) => {
    const id = await ctx.db.insert('organizations', {
      name: 'Other workspace of Alice',
    });
    await ctx.db.insert('memberships', {
      organizationId: id,
      issuer,
      subject: userId,
      role: 'owner',
    });
    return id;
  });
  return { t, alice, bob, organizationId, anotherOrg, userId };
}
async function authorized(s: Awaited<ReturnType<typeof setup>>) {
  const prepared = await s.alice.mutation(internal.mcpConnections.prepare, {
    organizationId: s.organizationId,
    externalAuthId: 'ext_auth_test_123456789',
  });
  await s.alice.mutation(internal.mcpConnections.activate, {
    connectionId: prepared.connectionId,
    providerSubject: 'user_workos_alice',
  });
  await s.t.mutation(internal.mcpConnections.bindConsent, {
    connectionId: prepared.connectionId,
    consentId: 'consent_one',
    providerSubject: 'user_workos_alice',
    providerIssuer: provider,
  });
  return prepared;
}
it('only website users can create grants for their own workspace; flow IDs cannot be replayed or stolen', async () => {
  const s = await setup();
  const args = {
    organizationId: s.organizationId,
    externalAuthId: 'ext_auth_test_123456789',
  };
  await expect(
    s.t.mutation(internal.mcpConnections.prepare, args),
  ).rejects.toThrow('Website sign-in required');
  await expect(
    s.bob.mutation(internal.mcpConnections.prepare, args),
  ).rejects.toThrow('Access denied');
  const grant = await s.alice.mutation(internal.mcpConnections.prepare, args);
  expect(grant.email).toBe('alice@example.invalid');
  expect(grant.externalId).toBe(`${issuer}#${s.userId}`);
  await expect(
    s.alice.mutation(internal.mcpConnections.prepare, args),
  ).rejects.toThrow('already used');
  await expect(
    s.bob.mutation(internal.mcpConnections.activate, {
      connectionId: grant.connectionId,
      providerSubject: 'user_bob',
    }),
  ).rejects.toThrow();
});
it('maps a delegated token to the same user but limits it to its granted workspace, and revokes immediately', async () => {
  const s = await setup();
  const grant = await authorized(s);
  const delegated = s.t.withIdentity({
    issuer: `${issuer}/mcp-bridge`,
    subject: 'user_workos_alice',
    mcpConnectionId: grant.connectionId,
    mcpConsentId: 'consent_one',
  });
  expect(
    (await delegated.query(api.organizations.list, {})).map((o) => o._id),
  ).toEqual([s.organizationId]);
  await delegated.mutation(api.cases.create, {
    organizationId: s.organizationId,
    name: 'Delegated case',
  });
  await expect(
    delegated.query(api.cases.list, { organizationId: s.anotherOrg }),
  ).rejects.toThrow('Access denied');
  await expect(
    delegated.mutation(api.organizations.createPersonal, {}),
  ).rejects.toThrow('Website sign-in required');
  await expect(delegated.query(api.mcpConnections.list, {})).rejects.toThrow(
    'Website sign-in required',
  );
  await expect(
    s.bob.mutation(api.mcpConnections.revoke, {
      connectionId: grant.connectionId,
    }),
  ).rejects.toThrow('Access denied');
  await s.alice.mutation(api.mcpConnections.revoke, {
    connectionId: grant.connectionId,
  });
  await s.alice.mutation(api.mcpConnections.revoke, {
    connectionId: grant.connectionId,
  });
  await expect(
    delegated.query(api.cases.list, { organizationId: s.organizationId }),
  ).rejects.toThrow('revoked');
});
it('rejects a substituted subject, consent, pending grant, and removed membership', async () => {
  const s = await setup();
  const grant = await authorized(s);
  for (const [subject, consent] of [
    ['user_other', 'consent_one'],
    ['user_workos_alice', 'consent_other'],
  ]) {
    const bad = s.t.withIdentity({
      issuer: `${issuer}/mcp-bridge`,
      subject,
      mcpConnectionId: grant.connectionId,
      mcpConsentId: consent,
    });
    await expect(bad.query(api.organizations.list, {})).rejects.toThrow();
  }
  await s.t.run(async (ctx) => {
    const connection = await ctx.db.get(grant.connectionId);
    await ctx.db.delete(connection!.membershipId);
  });
  await expect(
    s.t.query(internal.mcpConnections.validate, {
      connectionId: grant.connectionId,
      providerSubject: 'user_workos_alice',
      providerIssuer: provider,
      consentId: 'consent_one',
    }),
  ).rejects.toThrow('Access denied');
});
it('exchanges a signed provider token for a separate bounded backend token, and rejects bad clients, audiences and revoked grants', async () => {
  const s = await setup();
  const grant = await authorized(s);
  const workosKeys = await generateKeyPair('RS256', { extractable: true });
  const bridgeKeys = await generateKeyPair('RS256', { extractable: true });
  vi.stubEnv(
    'MCP_BRIDGE_PRIVATE_KEY',
    await exportPKCS8(bridgeKeys.privateKey),
  );
  vi.stubEnv('MCP_BRIDGE_KEY_ID', 'bridge');
  vi.stubEnv(
    'MCP_BRIDGE_JWKS',
    JSON.stringify({
      keys: [{ ...(await exportJWK(bridgeKeys.publicKey)), kid: 'bridge' }],
    }),
  );
  vi.stubEnv('MCP_BRIDGE_CLIENT_ID', 'mcp');
  vi.stubEnv('MCP_BRIDGE_CLIENT_SECRET', 'secret');
  const workosJwk = {
    ...(await exportJWK(workosKeys.publicKey)),
    kid: 'workos',
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe(`${provider}/oauth2/jwks`);
      return Response.json({ keys: [workosJwk] });
    }),
  );
  const makeToken = (audience = resource) =>
    new SignJWT({ [MCP_GRANT_CLAIM]: grant.connectionId, sid: 'consent_one' })
      .setProtectedHeader({ alg: 'RS256', kid: 'workos' })
      .setIssuer(provider)
      .setSubject('user_workos_alice')
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(workosKeys.privateKey);
  const exchange = (token: string, client = 'mcp:secret') =>
    s.t.fetch('/mcp/exchange', {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(client)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: MCP_BACKEND_AUDIENCE,
        subject_token: token,
      }).toString(),
    });
  const original = await makeToken();
  expect((await exchange(original, 'wrong:secret')).status).toBe(401);
  expect((await exchange(await makeToken('other'))).status).toBe(400);
  const response = await exchange(original);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.access_token).not.toBe(original);
  const { payload } = await jwtVerify(
    result.access_token,
    bridgeKeys.publicKey,
    { issuer: `${issuer}/mcp-bridge`, audience: MCP_BACKEND_AUDIENCE },
  );
  expect(payload.mcpConnectionId).toBe(grant.connectionId);
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(60);
  expect(payload.sub).toBe('user_workos_alice');
  await s.alice.mutation(api.mcpConnections.revoke, {
    connectionId: grant.connectionId,
  });
  expect((await exchange(original)).status).toBe(400);
});
it('requires a new flow after provider failure and rejects expired or competing consent activation', async () => {
  const s = await setup();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response('private provider failure', { status: 500 }),
    ),
  );
  const args = {
    organizationId: s.organizationId,
    externalAuthId: 'ext_auth_failure_123456789',
  };
  await expect(
    s.alice.action(api.mcpOAuth.completeBrowserLogin, args),
  ).rejects.toThrow('restart the connection');
  const grants = await s.alice.query(api.mcpConnections.list, {});
  expect(grants[0]?.status).toBe('revoked');
  await expect(
    s.alice.action(api.mcpOAuth.completeBrowserLogin, args),
  ).rejects.toThrow('already used');
  const grant = await authorized(s);
  await expect(
    s.t.mutation(internal.mcpConnections.bindConsent, {
      connectionId: grant.connectionId,
      consentId: 'other-consent',
      providerSubject: 'user_workos_alice',
      providerIssuer: provider,
    }),
  ).rejects.toThrow('Access denied');
  const prepared = await s.alice.mutation(internal.mcpConnections.prepare, {
    organizationId: s.organizationId,
    externalAuthId: 'ext_auth_expired_123456789',
  });
  await s.t.run((ctx) => ctx.db.patch(prepared.connectionId, { expiresAt: 1 }));
  await expect(
    s.alice.mutation(internal.mcpConnections.activate, {
      connectionId: prepared.connectionId,
      providerSubject: 'user_workos_alice',
    }),
  ).rejects.toThrow('unavailable');
});
