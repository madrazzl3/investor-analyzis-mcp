import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Development deployment only. Turns the no-sign-in demo (and paid live Grok
// analysis) on or off. Secret values are piped over stdin and never printed.
const mode = process.argv[2];
if (mode !== 'enable' && mode !== 'disable') {
  console.error('Usage: node scripts/demo-env.mjs enable|disable');
  process.exit(2);
}
const run = (args, input) =>
  execFileSync('pnpm', ['exec', 'convex', ...args, '--deployment', 'dev'], {
    env: { ...process.env, CONVEX_DEPLOY_KEY: '' },
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
try {
  const names = new Set(
    run(['env', 'list', '--names-only']).trim().split('\n'),
  );
  if (mode === 'disable') {
    for (const name of ['DEMO_OPEN_ACCESS', 'LIVE_ANALYSIS_ENABLED'])
      if (names.has(name)) run(['env', 'remove', name]);
    console.info(
      'Demo access and live analysis disabled on the dev deployment.',
    );
    process.exit(0);
  }
  if (!names.has('XAI_API_KEY')) {
    const local = existsSync('.env.local')
      ? parseEnv(readFileSync('.env.local', 'utf8'))
      : {};
    const key = process.env.XAI_API_KEY || local.XAI_API_KEY;
    if (!key)
      throw new Error(
        'XAI_API_KEY is not set on the deployment, in the environment, or in .env.local',
      );
    run(['env', 'set', 'XAI_API_KEY'], key);
    console.info('XAI_API_KEY copied to the dev deployment.');
  }
  run(['env', 'set', 'LIVE_ANALYSIS_ENABLED', 'true']);
  run(['env', 'set', 'DEMO_OPEN_ACCESS', 'true']);
  console.info(
    'Demo enabled on the dev deployment: anonymous callers share one demo workspace and can start paid Grok runs. Run `pnpm demo:disable` after the demo.',
  );
} catch (error) {
  // Subprocess output may echo values, so report only the failing step.
  console.error(
    `Demo configuration failed: ${error instanceof Error && !('stdout' in error) ? error.message : 'Convex CLI command failed'}`,
  );
  process.exit(1);
}
