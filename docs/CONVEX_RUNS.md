# Persisted analysis runs

## Implemented

Convex runs two approved workflows on the actual Workflow component: a four-step fake-agent workflow for synthetic fixtures, and the 14-step live Grok investor council for uploaded documents (see [Grok ingestion](GROK_INGESTION.md)). The synthetic workflow was smoke-tested on the development deployment; the live workflow is tested only against a simulated provider and is off unless `LIVE_ANALYSIS_ENABLED=true`.

The following functions require an authenticated identity and matching organization membership:

| Function                              | Purpose                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| `cases:create` / `cases:list`         | Create/list organization cases                                         |
| `cases:addSyntheticDocument`          | Add an explicitly synthetic source reference to an authorized case     |
| `runs:start`                          | Snapshot the approved config and inputs, then start a durable workflow |
| `runs:get` / `runs:list`              | Inspect run mode, status, stages, attempt errors, and model usage      |
| `runs:artifacts` / `runs:getArtifact` | Read saved intermediate/final outputs                                  |
| `runs:contexts`                       | Inspect saved context manifests                                        |
| `runs:cancel`                         | Cancel orchestration and reject late artifact publication              |
| `runs:resume`                         | Restart a failed run within its remaining attempt/call budget          |
| `runs:capabilities`                   | Report whether this deployment accepts live analysis                   |

Organization membership grants access to the organization's cases for this version. Membership provisioning and browser OAuth are not implemented. There is no public self-enrollment or service-key bypass. Functions derive identity from `ctx.auth`; the run's initiating membership is rechecked before execution and publication.

`runs:start` takes `caseId`, `requestId`, and 1–10 distinct `documentVersionIds` from that case. All synthetic fixtures select the synthetic workflow; all uploaded documents select the live workflow (only when enabled); mixing them is rejected. The same request ID with the same ordered inputs returns the existing run; different inputs under that ID are rejected. The application publishes one approved workflow per mode; callers cannot supply arbitrary configs.

## Persistence and recovery

Convex stores configuration snapshots, analysis runs, agent runs, attempts, context manifests, and artifacts. JSON Schema contains reserved `$` keys, so the complete configuration bundle is stored losslessly as `bundleJson` with its content hash. Inputs refer to immutable source IDs; outputs retain schema IDs and producer/input-artifact lineage.

A step claims an attempt in a mutation, loads its persisted context, executes the fake agent or the Grok call, and publishes validated output artifacts and completion in one mutation. Superseding an interrupted (still running) attempt invalidates the old attempt ID; an attempt that already failed keeps its recorded reason. Duplicate publication returns the accepted artifact IDs and cannot replace their payloads. Reads and publication reject revoked access and deleted/moved source records.

Workflow history contains step references and artifact IDs; completed application steps are reused when orchestration replays. A failure marks the overall run failed and leaves existing artifacts available to authorized readers. `runs:resume` replays orchestration while reusing completed artifacts. It does not reset call budgets or accept configuration changes. Cancelled runs require a new start request.

Automatic action retries are disabled for both workflows. A live step may retry classified provider failures (`rate_limit`, `provider_unavailable`) within its snapshot's attempt and call budgets, with backoff; other failures become inspectable failed runs whose `error` names the step and category. Authorized callers can resume within the remaining budget. Native transactional retries and workflow persistence remain active. Token usage is recorded per attempt, but no cost budget is enforced yet.

## Configuration publication

```sh
pnpm config:validate
pnpm config:generate
pnpm check
pnpm exec convex dev --once
```

`config:generate` creates `convex/analysis/approved.json` (one approved bundle per mode; exactly one workflow per runner is required) and standalone JSON Schema validators. Each bundle contains only the agents, models, prompts, and schemas its workflow uses, so adding the live configuration did not change the synthetic bundle's hash. These are application-generated files, separate from Convex's CLI-generated `_generated` bindings. CI checks that they match the source configuration.

Only the current approved bundle hash for each mode is supported. A run with an older, unsupported snapshot fails explicitly instead of silently using changed prompts/schemas. Before supporting concurrent workflow revisions, retain a registry of compatible bundles/runners. Do not edit saved snapshots to migrate active runs.

Payloads are deliberately bounded and inline (100 KB per validated payload, at most 10 documents per run); the v2 live schemas bound array and string sizes to fit. Larger reports will require File Storage-backed artifacts. Output content hashes and retention cleanup remain follow-up work; provider usage and provider-file cleanup are recorded per attempt; stored artifact IDs, schemas, and lineage already identify each immutable published output.

## Verification

Run `pnpm exec vitest run tests/convex --silent`. Tests use `convex-test` with real Workflow/Workpool component scheduling and simulated identities. They cover completion, reconnection, partial-run recovery, duplicate starts/publication, invalid/foreign evidence, stale attempts, retry budgets, cancellation, and membership revocation. `tests/convex/live.test.ts` covers the live workflow against a simulated xAI endpoint.

A development smoke run also completed all four stages with four fake calls and a saved report. Duplicate starts reused the run, and unauthenticated/unrelated identities were denied. This was an administrator-simulated identity through the Convex CLI, not a validated end-user OAuth session. Synthetic fixture details are stored locally in ignored `.local-runs/convex-smoke.json`; synthetic records remain in the development database for inspection.

`devFixtures:seed` is internal/admin-only and additionally requires `ALLOW_SYNTHETIC_FIXTURES=true` in that deployment. The flag was removed after the smoke test. Keep it disabled normally and never use it to provision real users. Convex's `--identity` CLI option is an administrator testing facility, not an application authentication mechanism.
