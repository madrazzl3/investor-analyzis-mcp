import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBundle, compile, hash } from './config.js';

try {
  const root = resolve(process.argv[2] ?? 'config');
  const files = readdirSync(resolve(root, 'workflows'))
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (!files.length) throw new Error('No workflow definitions');
  for (const file of files) {
    const bundle = loadBundle(root, `workflows/${file}`);
    const plan = compile(bundle);
    console.info(
      `${bundle.workflow.id}@${bundle.workflow.version}: valid; ${bundle.runnerVersion}; ${plan.order.length} steps; snapshot ${hash(bundle).slice(0, 12)}`,
    );
  }
  console.info('Validation only. No model calls or credentials used.');
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'Configuration validation failed',
  );
  process.exitCode = 1;
}
