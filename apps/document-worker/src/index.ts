// Job claiming and processing will be implemented after the auth boundary.
// Do not acknowledge jobs, upload results, or simulate processing here.
console.error(
  'Document worker is not configured: job protocol and parser are pending.',
);
process.exitCode = 1;
