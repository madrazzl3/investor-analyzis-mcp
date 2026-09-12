import { z } from 'zod';

export const runStatusSchema = z.enum([
  'queued',
  'running',
  'awaiting_input',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

// Runtime scope is intentionally small until case authorization is implemented.
export const serviceInfo = {
  name: 'investor-diligence',
  version: '0.0.0',
  stage: 'scaffold',
} as const;
