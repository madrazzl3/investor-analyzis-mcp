import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GrokClient } from '../../../packages/grok/src/index.js';
import { LocalGrok } from '../../../packages/analysis/src/local-grok.js';
import { createDiskMcpServer } from './offline.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
// Load locally without echoing credentials; inherited environment takes priority.
try {
  loadEnvFile(resolve(root, '.env.local'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!process.env.XAI_API_KEY?.trim()) {
  console.error(
    'Set XAI_API_KEY in the local environment or repository .env.local.',
  );
  process.exit(1);
}
const runtime = new LocalGrok(
  resolve(root, process.env.LOCAL_DATA_DIR || '.local-runs'),
  resolve(root, 'config'),
  new GrokClient(process.env.XAI_API_KEY),
  process.env.XAI_MODEL || undefined,
);
await createDiskMcpServer(runtime).connect(new StdioServerTransport());
console.error(
  'Investor diligence: local disk orchestration, direct xAI requests.',
);
