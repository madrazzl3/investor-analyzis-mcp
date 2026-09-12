import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
// Provider copies of confidential documents must not outlive their attempt.
crons.interval(
  'reconcile provider files',
  { minutes: 15 },
  internal.analysis.execute.reconcileProviderFiles,
  {},
);
crons.interval(
  'reclaim abandoned uploads',
  { hours: 1 },
  internal.uploads.cleanup,
  { cursor: null },
);
export default crons;
