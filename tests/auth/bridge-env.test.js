import { expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { serializeBridgeEnvironment } from '../../scripts/bridge-env.mjs';
it('preserves PEM newlines and JSON quotes in the CLI environment file', () => {
  const values = {
    MCP_BRIDGE_PRIVATE_KEY:
      '-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n',
    MCP_BRIDGE_JWKS: JSON.stringify({
      keys: [{ kty: 'RSA', n: 'test', e: 'AQAB', kid: 'test' }],
    }),
    MCP_BRIDGE_KEY_ID: 'test',
    MCP_BRIDGE_CLIENT_ID: 'test',
    MCP_BRIDGE_CLIENT_SECRET: 'synthetic-secret',
  };
  const parsed = parseEnv(serializeBridgeEnvironment(values));
  expect(parsed).toEqual(values);
  expect(JSON.parse(parsed.MCP_BRIDGE_JWKS).keys[0].kid).toBe('test');
});
