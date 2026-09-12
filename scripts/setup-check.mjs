import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const local = existsSync('.env.local')
  ? parseEnv(readFileSync('.env.local', 'utf8'))
  : {};
const env = { ...local, ...process.env };
const groups = {
  'Local HTTP service': ['MCP_PUBLIC_URL', 'WEB_PUBLIC_URL'],
  'Convex connection': ['CONVEX_DEPLOYMENT', 'CONVEX_URL'],
  'Website build (public configuration)': ['VITE_CONVEX_URL'],
  'MCP OAuth provider and exchange':
    env.MCP_AUTH_PROVIDER !== 'external'
      ? [
          'MCP_AUTH_PROVIDER',
          'MCP_RESOURCE_URL',
          'WORKOS_AUTHKIT_ISSUER',
          'CONVEX_SITE_URL',
          'MCP_BRIDGE_CLIENT_ID',
          'MCP_BRIDGE_CLIENT_SECRET',
        ]
      : [
          'MCP_RESOURCE_URL',
          'MCP_AUTH_ISSUER',
          'MCP_AUTH_JWKS_URL',
          'MCP_TOKEN_EXCHANGE_URL',
          'MCP_TOKEN_EXCHANGE_CLIENT_ID',
          'MCP_TOKEN_EXCHANGE_CLIENT_SECRET',
          'MCP_CONVEX_AUDIENCE',
          'MCP_CONVEX_ISSUER',
          'MCP_CONVEX_JWKS_URL',
        ],
};
let missing = false;
for (const [group, keys] of Object.entries(groups)) {
  console.info(`\n${group}`);
  for (const key of keys) {
    const set = Boolean(env[key]?.trim());
    console.info(`  ${key}: ${set ? 'set' : 'missing'}`);
    missing ||= !set;
  }
}
console.info(
  '\nThis checks presence only; it does not verify credentials, connectivity, or OAuth readiness.',
);
if (missing)
  console.info('See docs/SETUP.md for the remaining account setup steps.');
process.exitCode = missing ? 1 : 0;
