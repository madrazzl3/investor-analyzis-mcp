import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const local = existsSync('.env.local')
  ? parseEnv(readFileSync('.env.local', 'utf8'))
  : {};
const env = { ...local, ...process.env };
const groups = { 'Local Grok runtime': ['XAI_API_KEY'] };
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
  console.info('See docs/LOCAL.md for the remaining account setup steps.');
process.exitCode = missing ? 1 : 0;
