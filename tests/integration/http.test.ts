import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHttpServer } from '../../apps/mcp-server/src/app.js';

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    const current = server;
    await new Promise<void>((resolve, reject) =>
      current.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
});

describe('HTTP authentication boundary', () => {
  it('serves health but rejects all MCP access while auth is unconfigured', async () => {
    server = createHttpServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No TCP address');
    const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    for (const headers of [
      new Headers(),
      new Headers({ Authorization: 'Bearer fabricated-token' }),
    ]) {
      const result = await fetch(`${base}/mcp`, { method: 'POST', headers });
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({
        error: 'authentication_not_configured',
      });
    }
    expect((await fetch(`${base}/unknown`)).status).toBe(404);
  });
});
