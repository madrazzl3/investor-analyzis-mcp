import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/mcp-server/src/app';
import { AuthFailure, type AuthSettings } from '../../apps/mcp-server/src/auth';
const VERSION = '2026-07-28';
let server: Server;
let base: string;
let settings: AuthSettings;
const backend = vi.fn(
  async (
    _kind: string,
    _name: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> => [],
);
const exchange = vi.fn(async () => 'backend-token');
beforeEach(async () => {
  backend.mockReset().mockResolvedValue([]);
  exchange.mockReset().mockResolvedValue('backend-token');
  settings = {
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
    convexUrl: 'https://backend.convex.cloud',
    allowedOrigins: ['https://client.example'],
  };
  server = createHttpServer(settings, {
    backend,
    exchange,
    authenticate: async (header) => {
      if (header !== 'Bearer test') throw new AuthFailure(401, 'invalid_token');
      return { token: 'test', subject: 'investor' };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  base = `http://127.0.0.1:${address.port}`;
  settings.resource = `${base}/mcp`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function message(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientInfo': {
          name: 'conformance-fixture',
          version: '1',
        },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
}
function headers(method: string, name?: string) {
  return {
    authorization: 'Bearer test',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
  };
}
function send(
  method: string,
  params: Record<string, unknown> = {},
  changes: Record<string, string> = {},
) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers(method, params.name as string), ...changes },
    body: JSON.stringify(message(method, params)),
  });
}
async function rpc(response: Response) {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)));
    return events.find((event) => event.id === 1);
  }
  return JSON.parse(text);
}
it('serves modern discovery and a stable tools catalog without a session handshake', async () => {
  const discovery = await send('server/discover');
  expect(discovery.status).toBe(200);
  const discovered = await rpc(discovery);
  expect(discovered.result.supportedVersions).toContain(VERSION);
  expect(
    discovered.result._meta['io.modelcontextprotocol/serverInfo'].name,
  ).toBeTruthy();
  expect(discovery.headers.has('mcp-session-id')).toBe(false);
  const listing = await send('tools/list');
  expect(listing.status).toBe(200);
  const tools = (await rpc(listing)).result.tools;
  expect(tools.map((tool: { name: string }) => tool.name)).toContain(
    'list_workspaces',
  );
  expect(tools.map((tool: { name: string }) => tool.name)).toContain(
    'resume_analysis',
  );
  for (const tool of tools) {
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.outputSchema.type).toBe('object');
  }
  expect(backend).not.toHaveBeenCalled();
  expect(exchange).toHaveBeenCalledTimes(2);
});
it('rejects missing/mismatched method, name and protocol headers before executing tools', async () => {
  for (const change of [
    { 'mcp-method': '' },
    { 'mcp-method': 'tools/list' },
    { 'mcp-name': 'other' },
    { 'mcp-name': '' },
    { 'mcp-protocol-version': '2025-11-25' },
  ] as Record<string, string>[]) {
    const response = await send(
      'tools/call',
      { name: 'list_workspaces', arguments: {} },
      change,
    );
    expect(response.status).toBe(400);
    expect((await rpc(response)).error.code).toBe(-32020);
  }
  expect(backend).not.toHaveBeenCalled();
});
it('negotiates unsupported versions and reports unknown methods as protocol errors', async () => {
  const body = message('server/discover');
  body.params._meta['io.modelcontextprotocol/protocolVersion'] = '2099-01-01';
  const unknown = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...headers('server/discover'),
      'mcp-protocol-version': '2099-01-01',
    },
    body: JSON.stringify(body),
  });
  expect(unknown.status).toBe(400);
  expect((await rpc(unknown)).error.data.supported).toContain(VERSION);
  const missing = await send('unknown/method');
  expect(missing.status).toBe(404);
  expect((await rpc(missing)).error.code).toBe(-32601);
});
it('validates media types and message framing, and rejects unsupported HTTP methods', async () => {
  const wrongType = await send(
    'tools/list',
    {},
    { 'content-type': 'text/plain' },
  );
  expect(wrongType.status).toBe(415);
  const malformed = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers('tools/list'),
    body: '{',
  });
  expect(malformed.status).toBe(400);
  expect((await rpc(malformed)).error.code).toBe(-32700);
  const batch = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers('tools/list'),
    body: JSON.stringify([message('tools/list')]),
  });
  expect(batch.status).toBe(400);
  const notAccepted = await send('tools/list', {}, { accept: 'text/plain' });
  expect(notAccepted.status).toBe(406);
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await fetch(`${base}/mcp`, {
      method,
      headers: headers('tools/list'),
    });
    expect(response.status).toBe(405);
  }
});
it('returns structured tool results, preserves tool errors, and validates inputs', async () => {
  backend.mockResolvedValueOnce([{ _id: 'case1' }]);
  const response = await send('tools/call', {
    name: 'list_cases',
    arguments: { organizationId: 'org1' },
  });
  expect(response.status).toBe(200);
  const result = (await rpc(response)).result;
  expect(result.structuredContent).toEqual({ data: [{ _id: 'case1' }] });
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  expect(backend).toHaveBeenLastCalledWith('query', 'cases:list', {
    organizationId: 'org1',
  });
  backend.mockRejectedValueOnce(new Error('Private database diagnostics'));
  const failed = await rpc(
    await send('tools/call', { name: 'list_workspaces', arguments: {} }),
  );
  expect(failed.result.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain('Private database');
  backend.mockClear();
  const invalid = await rpc(
    await send('tools/call', { name: 'list_cases', arguments: {} }),
  );
  expect(invalid.result?.isError || invalid.error).toBeTruthy();
  expect(backend).not.toHaveBeenCalled();
});
it('checks revoked grants before discovery and gives an OAuth challenge, not a tool error', async () => {
  exchange.mockRejectedValueOnce(new AuthFailure(401, 'invalid_token'));
  const revoked = await send('tools/list');
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get('www-authenticate')).toContain(
    'resource_metadata',
  );
  expect(backend).not.toHaveBeenCalled();
  exchange.mockRejectedValueOnce(
    new AuthFailure(503, 'temporarily_unavailable'),
  );
  const unavailable = await send('tools/list');
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.has('www-authenticate')).toBe(false);
  const queryToken = await fetch(`${base}/mcp?access_token=test`, {
    method: 'POST',
    headers: headers('tools/list'),
    body: JSON.stringify(message('tools/list')),
  });
  expect(queryToken.status).toBe(400);
});
it('allows modern browser headers and protects discovery from untrusted origins', async () => {
  const response = await fetch(`${base}/mcp`, {
    method: 'OPTIONS',
    headers: { origin: 'https://client.example' },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-headers')).toContain(
    'Mcp-Method',
  );
  expect(response.headers.get('access-control-allow-headers')).toContain(
    'Mcp-Name',
  );
  const discovery = await fetch(
    `${base}/.well-known/oauth-protected-resource/mcp`,
    { headers: { origin: 'https://client.example' } },
  );
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get('access-control-allow-origin')).toBe(
    'https://client.example',
  );
  const hostile = await fetch(
    `${base}/.well-known/oauth-protected-resource/mcp`,
    { headers: { origin: 'https://evil.example' } },
  );
  expect(hostile.status).toBe(403);
});
it('keeps stateless initialization and notification handling for the three 2025 HTTP revisions', async () => {
  for (const version of ['2025-03-26', '2025-06-18', '2025-11-25']) {
    const legacyHeaders = {
      authorization: 'Bearer test',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': version,
    };
    const initialization = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: legacyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'legacy-test', version: '1' },
        },
      }),
    });
    expect(initialization.status).toBe(200);
    expect((await rpc(initialization)).result.protocolVersion).toBe(version);
    expect(initialization.headers.has('mcp-session-id')).toBe(false);
    const notified = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: legacyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
    const listed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: legacyHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(listed.status).toBe(200);
    expect((await rpc(listed)).result.tools.length).toBeGreaterThan(0);
  }
});

it('exposes bounded upload preparation and action finalization without file bytes in MCP', async () => {
  const args = {
    caseId: 'case',
    requestId: 'request',
    name: 'deck.pdf',
    contentType: 'application/pdf',
    size: 100_000_000,
  };
  backend.mockResolvedValueOnce({
    uploadId: 'upload',
    uploadUrl: 'https://storage.example/upload',
    headers: { 'Content-Type': 'application/pdf; upload-token=fixture' },
  });
  const prepared = await rpc(
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers('tools/call', 'prepare_upload'),
      body: JSON.stringify(
        message('tools/call', { name: 'prepare_upload', arguments: args }),
      ),
    }),
  );
  expect(prepared.result.structuredContent.data.uploadId).toBe('upload');
  expect(backend).toHaveBeenLastCalledWith('mutation', 'uploads:prepare', args);
  backend.mockClear();
  const rejected = await rpc(
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers('tools/call', 'prepare_upload'),
      body: JSON.stringify(
        message('tools/call', {
          name: 'prepare_upload',
          arguments: { ...args, size: 100_000_001 },
        }),
      ),
    }),
  );
  expect(rejected.result?.isError || rejected.error).toBeTruthy();
  expect(backend).not.toHaveBeenCalled();
  backend.mockResolvedValueOnce({ documentVersionId: 'doc' });
  const receipt = { uploadId: 'upload', storageId: 'storage' };
  const attached = await rpc(
    await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: headers('tools/call', 'attach_document'),
      body: JSON.stringify(
        message('tools/call', { name: 'attach_document', arguments: receipt }),
      ),
    }),
  );
  expect(attached.result.structuredContent.data.documentVersionId).toBe('doc');
  expect(backend).toHaveBeenLastCalledWith(
    'action',
    'uploadValidation:attach',
    receipt,
  );
});
