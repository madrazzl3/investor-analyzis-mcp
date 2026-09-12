import { afterEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  createAuthenticator,
  createTokenExchange,
  type AuthSettings,
} from '../../apps/mcp-server/src/auth';
import { createHttpServer } from '../../apps/mcp-server/src/app';
import { once } from 'node:events';
import type { Server } from 'node:http';
const settings: AuthSettings = {
  resource: 'https://mcp.example/mcp',
  issuer: 'https://issuer.example',
  jwksUrl: 'https://issuer.example/jwks',
  scope: 'diligence',
  exchangeUrl: 'https://issuer.example/exchange',
  exchangeClientId: 'test',
  exchangeClientSecret: 'test',
  convexAudience: 'convex',
  convexIssuer: 'https://backend.example',
  convexJwksUrl: 'https://backend.example/jwks',
  convexUrl: 'https://test.convex.cloud',
  allowedOrigins: [],
};
const keys = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({ keys: [await exportJWK(keys.publicKey)] });
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ scope: 'diligence', ...overrides })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(settings.issuer)
    .setAudience(settings.resource)
    .setSubject('investor')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}
let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
describe('MCP token boundary', () => {
  it('verifies signatures, audience, expiry and scope', async () => {
    const verify = createAuthenticator(settings, jwks);
    expect((await verify(`Bearer ${await token()}`)).subject).toBe('investor');
    await expect(verify(undefined)).rejects.toMatchObject({ status: 401 });
    await expect(
      verify(`Bearer ${await token({ scope: 'other' })}`),
    ).rejects.toMatchObject({ status: 403 });
    const wrong = new SignJWT({ scope: 'diligence' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(settings.issuer)
      .setSubject('investor')
      .setAudience('other')
      .setIssuedAt()
      .setExpirationTime('5m');
    await expect(
      verify(`Bearer ${await wrong.sign(keys.privateKey)}`),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      verify(
        `Bearer ${await wrong.setAudience(settings.resource).setExpirationTime(1).sign(keys.privateKey)}`,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects passthrough and changed exchange subjects', async () => {
    const original = await token();
    const exchange = createTokenExchange(
      settings,
      async () =>
        Response.json({ access_token: original, token_type: 'Bearer' }),
      jwks,
    );
    await expect(
      exchange({ token: original, subject: 'investor' }),
    ).rejects.toThrow('Invalid exchange');
    const exchanged = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(settings.convexIssuer)
      .setAudience('convex')
      .setSubject('someone-else')
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    await expect(
      createTokenExchange(
        settings,
        async () =>
          Response.json({ access_token: exchanged, token_type: 'Bearer' }),
        jwks,
      )({ token: original, subject: 'investor' }),
    ).rejects.toThrow('changed subject');
  });
  it('rejects exchanged tokens for another audience or issuer', async () => {
    for (const [issuer, audience] of [
      ['https://wrong.example', 'convex'],
      [settings.convexIssuer, 'wrong'],
    ]) {
      const exchanged = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(issuer!)
        .setAudience(audience!)
        .setSubject('investor')
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      const exchange = createTokenExchange(
        settings,
        async () =>
          Response.json({ access_token: exchanged, token_type: 'Bearer' }),
        jwks,
      );
      await expect(
        exchange({ token: await token(), subject: 'investor' }),
      ).rejects.toThrow();
    }
  });
  it('publishes metadata, challenges unauthenticated access, rejects hostile origins and serves authorized tools', async () => {
    const calls: unknown[] = [];
    server = createHttpServer(settings, {
      authenticate: createAuthenticator(settings, jwks),
      backend: async (...args) => {
        calls.push(args);
        return [];
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    const base = `http://127.0.0.1:${address.port}`;
    settings.resource = `${base}/mcp`;
    const headers = {
      host: 'mcp.example',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    expect(
      (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status,
    ).toBe(200);
    const denied = await fetch(`${base}/mcp`, { method: 'POST', headers });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toContain(
      'resource_metadata',
    );
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: 'POST',
          headers: { ...headers, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    const initialized = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }),
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain('serverInfo');
    const result = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        ...headers,
        authorization: `Bearer ${await token()}`,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_cases', arguments: { organizationId: 'org123' } },
      }),
    });
    expect(result.status).toBe(200);
    expect(await result.text()).toContain('result');
    expect(calls).toEqual([
      ['query', 'cases:list', { organizationId: 'org123' }],
    ]);
  });
});
it('classifies a rejected user grant separately from exchange infrastructure failure', async () => {
  const actor = { token: 'incoming-token', subject: 'investor' };
  const rejected = createTokenExchange(
    settings,
    async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    jwks,
  );
  await expect(rejected(actor)).rejects.toMatchObject({
    status: 401,
    code: 'invalid_token',
  });
  const unavailable = createTokenExchange(
    settings,
    async () => Response.json({ error: 'invalid_client' }, { status: 401 }),
    jwks,
  );
  await expect(unavailable(actor)).rejects.toMatchObject({
    status: 503,
    code: 'temporarily_unavailable',
  });
});
