import approved from './approved.json';
import * as validators from './validators.js';
import type { Bundle } from '../../packages/analysis/src/config';
export type SnapshotBundle = Bundle;
export type RunMode = 'synthetic' | 'live';
type Approved = {
  bundle: Bundle;
  configHash: string;
  order: string[];
  dependencies: Record<string, string[]>;
};
const bundles = approved as unknown as Record<RunMode, Approved> & {
  schemaNames: Record<string, string>;
};
/** The currently approved workflow for a mode. Callers cannot supply configs. */
export function approvedFor(mode: RunMode): Approved {
  return bundles[mode];
}
/** Only the current approved bundle for the run's mode executes. */
export function assertSupported(hash: string, mode: RunMode = 'synthetic') {
  if (hash !== bundles[mode].configHash)
    throw new Error(
      'Unsupported configuration snapshot; restore its compatible deployment',
    );
}
export function validatePayload(schema: string, payload: unknown) {
  const key = bundles.schemaNames[schema];
  const validate = (validators as Record<string, (value: unknown) => boolean>)[
    key ?? ''
  ];
  if (!validate || !validate(payload))
    throw new Error('Artifact schema validation failed');
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 100_000)
    throw new Error('Artifact exceeds inline size limit');
}
/** Deployment kill switch for paid analysis. Checked at start, resume, and every step. */
export function liveAnalysisEnabled() {
  return process.env.LIVE_ANALYSIS_ENABLED === 'true';
}
