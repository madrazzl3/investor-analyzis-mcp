import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, exportPKCS8 } from 'jose';
import { serializeBridgeEnvironment } from './bridge-env.mjs';

// Development only. Captured environment values and subprocess diagnostics are never printed.
try {
  const run = (args, input) =>
    execFileSync('pnpm', ['exec', 'convex', ...args, '--deployment', 'dev'], {
      env: { ...process.env, CONVEX_DEPLOY_KEY: '' },
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const existingNames = new Set(
    run(['env', 'list', '--names-only']).trim().split('\n'),
  );
  const existing = {};
  const names = [
    'MCP_BRIDGE_PRIVATE_KEY',
    'MCP_BRIDGE_JWKS',
    'MCP_BRIDGE_KEY_ID',
    'MCP_BRIDGE_CLIENT_ID',
    'MCP_BRIDGE_CLIENT_SECRET',
  ];
  const count = names.filter((name) => existingNames.has(name)).length;
  if (count !== 0 && count !== names.length)
    throw new Error(
      'Partial bridge configuration; preserve existing keys and resolve it manually',
    );
  if (count) {
    for (const name of ['MCP_BRIDGE_CLIENT_ID', 'MCP_BRIDGE_CLIENT_SECRET'])
      existing[name] = run(['env', 'get', name]).trim();
    JSON.parse(run(['env', 'get', 'MCP_BRIDGE_JWKS']));
  }
  const local = existsSync('.env.local')
    ? parseEnv(readFileSync('.env.local', 'utf8'))
    : {};
  let values = existing;
  if (!count) {
    const keys = await generateKeyPair('RS256', { extractable: true });
    const kid = randomUUID();
    values = {
      MCP_BRIDGE_PRIVATE_KEY: await exportPKCS8(keys.privateKey),
      MCP_BRIDGE_JWKS: JSON.stringify({
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            kid,
            alg: 'RS256',
            use: 'sig',
          },
        ],
      }),
      MCP_BRIDGE_KEY_ID: kid,
      MCP_BRIDGE_CLIENT_ID: 'investor-mcp-render',
      MCP_BRIDGE_CLIENT_SECRET: randomBytes(32).toString('base64url'),
    };
    if (local.MCP_BRIDGE_CLIENT_SECRET || local.MCP_BRIDGE_CLIENT_ID)
      throw new Error(
        'Local bridge values exist; refusing to create a mismatched deployment pair',
      );
    run(['env', 'set'], serializeBridgeEnvironment(values));
  }
  const lines = [];
  for (const name of ['MCP_BRIDGE_CLIENT_ID', 'MCP_BRIDGE_CLIENT_SECRET']) {
    if (local[name] && local[name] !== values[name])
      throw new Error(
        'Local and deployment credentials differ; refusing overwrite',
      );
    if (!local[name]) lines.push(`${name}=${values[name]}`);
  }
  if (lines.length) {
    appendFileSync(
      '.env.local',
      `\n# Development MCP-to-Convex bridge (not OAuth client credentials)\n${lines.join('\n')}\n`,
      { mode: 0o600 },
    );
    chmodSync('.env.local', 0o600);
  }
  console.log(
    'Development bridge signing keys and service credential configured/preserved. No key material printed. WorkOS activation is separate.',
  );
} catch (error) {
  console.error(
    error?.status !== undefined
      ? 'Convex setup command failed; no credential diagnostics printed.'
      : error.message,
  );
  process.exitCode = 1;
}
