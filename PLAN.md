# Local investor diligence plan

Updated 2026-09-12. The requested local architecture supersedes the [hosted plan](docs/PLAN_HOSTED_HISTORY.md).

## Architecture

TypeScript and pnpm remain. A single local Node process exposes stdio MCP and orchestrates the configured investor council with direct xAI Files/Responses calls using `XAI_API_KEY` from the local environment. Atomic JSON snapshots own run state; content-addressed source copies preserve evidence versions. No hosted backend or agent framework is needed.

The existing configuration compiler supplies the dependency graph, parallelism, retry/call budgets, prompts, and output schemas. Intermediate artifacts retain hashes, explicit source references, and input lineage. Completed steps are reused during recovery. Transient failures receive bounded retries; invalid outputs fail the run without fabricated success. Failed specialist coverage does not yield a completed report.

The trust boundary is the local OS user and MCP host. No unauthenticated network endpoint is introduced. Credentials never enter saved configuration/artifacts. Source documents are untrusted evidence and are sent to xAI only during requested analysis.

## Implemented

- Local stdio MCP is the default development/runtime path.
- Disk persistence, immutable configuration/source snapshots, idempotent starts, step scheduling, cancellation and explicit resume.
- Direct Grok calls, per-successful-attempt model/response/token metadata, provider file cleanup tracking and explicit cleanup retries.
- Output contracts, source membership, transcript quote validation, and downstream evidence continuity.
- Mock-provider tests of the full council, idempotency across restart, transient retry, source corruption, fabricated evidence rejection and cleanup recovery.

## Limits and next work

- Keep the local process open. Abrupt termination can leave a lock; verify its PID has stopped before manually removing it and resuming. Calls interrupted after submission may already have been billed; their usage may be unknown.
- Filesystem persistence is not encrypted cloud storage or multi-user authorization. Backups and retention are the local user's responsibility.
- Cleanup tracking cannot close the crash window between provider upload and recording the returned ID. Inspect provider storage after an abrupt crash if necessary.
- Verify a real authorized paid run and evaluate PDF coverage, citations, model availability, prompt quality and costs. No live compatibility claims yet.
- The old website is not connected to this local store. A local browser UI, migration of existing cloud data, removal of legacy dependencies, and shutting down cloud deployments are separate work.

Legacy Convex/Render implementation and tests remain available for reference. They are not prerequisites for local analysis.
