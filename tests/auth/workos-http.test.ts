import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/mcp-server/src/app';
import { readAuthSettings } from '../../apps/mcp-server/src/auth';
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});
it('proxies only matching PKCE-capable provider metadata and restricts browser preflight origins', async () => {
  const settings = readAuthSettings({
    MCP_AUTH_PROVIDER: 'workos',
    MCP_RESOURCE_URL: 'https://mcp.example/mcp',
    WORKOS_AUTHKIT_ISSUER: 'https://tenant.authkit.app',
    CONVEX_URL: 'https://test.convex.cloud',
    CONVEX_SITE_URL: 'https://test.convex.site',
    MCP_BRIDGE_CLIENT_ID: 'mcp',
    MCP_BRIDGE_CLIENT_SECRET: 'secret',
    MCP_ALLOWED_ORIGINS: 'https://our-website.example',
  })!;
  const nativeFetch = fetch;
  let badIssuer = false;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith(settings.issuer))
      return Promise.resolve(
        Response.json({
          issuer: badIssuer ? 'https://evil.example' : settings.issuer,
          code_challenge_methods_supported: ['S256'],
          authorization_endpoint: `${settings.issuer}/oauth2/authorize`,
          token_endpoint: `${settings.issuer}/oauth2/token`,
        }),
      );
    return nativeFetch(url, init);
  });
  server = createHttpServer(settings);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  const base = `http://127.0.0.1:${address.port}`;
  settings.resource = `${base}/mcp`;
  const metadata = await fetch(
    `${base}/.well-known/oauth-authorization-server`,
  );
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).issuer).toBe(settings.issuer);
  badIssuer = true;
  expect(
    (await fetch(`${base}/.well-known/oauth-authorization-server`)).status,
  ).toBe(503);
  const allowed = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://our-website.example',
      'access-control-request-method': 'POST',
    },
  });
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get('access-control-allow-origin')).toBe(
    'https://our-website.example',
  );
  expect(
    (
      await fetch(`${base}/mcp`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
});
