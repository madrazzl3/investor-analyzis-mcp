import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const local = existsSync('.env.local')
  ? parseEnv(readFileSync('.env.local', 'utf8'))
  : {};
const env = { ...local, ...process.env };
const localMode = process.argv.includes('--local');
const groups = localMode
  ? { 'Local Grok runtime': ['XAI_API_KEY'] }
  : {
      'Convex backend': ['CONVEX_DEPLOYMENT', 'CONVEX_URL'],
      'Hosted MCP (WorkOS)': [
        'MCP_AUTH_PROVIDER',
        'MCP_RESOURCE_URL',
        'WORKOS_AUTHKIT_ISSUER',
        'CONVEX_SITE_URL',
        'MCP_BRIDGE_CLIENT_ID',
        'MCP_BRIDGE_CLIENT_SECRET',
      ],
    };
if (!localMode) {
  console.info('Website: set public VITE_CONVEX_URL in the Vite environment.');
  console.info(
    'Convex secrets and live-analysis enablement must be checked on the deployment separately.',
  );
}
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
  '\nThis checks presence only; it does not verify credentials, connectivity, model availability, or analysis quality.',
);
if (missing)
  console.info(
    `See ${localMode ? 'docs/LOCAL.md' : 'docs/SETUP.md'} for the remaining account setup steps.`,
  );
process.exitCode = missing ? 1 : 0;
