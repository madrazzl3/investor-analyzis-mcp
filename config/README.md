# Analysis configuration

Run `pnpm config:validate` from the repository root. Validation is also part of `pnpm check`.

There are three workflows. `packages/analysis/src/generate-convex.ts` names the one approved per mode; the others validate but cannot run.

- `workflows/diligence.v1.json` (approved, synthetic) uses the v1 agents (extract claims, check consistency, verify findings, write a report) and `local-fake@1.0.0`. It runs synthetic fixtures only and makes no model requests.
- `workflows/investor-council.v1.json` (approved, live) runs uploaded documents through the investor council on `grok-primary@1.0.0` (`grok-4.6`) in Convex when `LIVE_ANALYSIS_ENABLED=true`: `intake-gate` → `chief-venture-officer` → ten specialist lenses in parallel → `devils-advocate` → `thesis-synthesiser`. Only intake receives the documents; later agents may cite only evidence they are given. See [Grok ingestion](../docs/GROK_INGESTION.md).
- `workflows/diligence-live.v1.json` (not approved) is the earlier four-step Grok pipeline on the v2 agents and schemas.

Edit prompts in `prompts/`; input/output contracts are draft-07 JSON Schema files in `schemas/`. Each workflow is snapshotted with only the agents, models, prompts, and schemas it uses, and a workflow must use a single provider (`fake` → `local-fake-v1` runner, `xai` → `convex-grok-v1` runner). xAI profiles name a concrete `grok-*` model ID and an attachment-search tool-call cap; live agents may not exceed a 180 s timeout, and attachment inputs must bind the submitted documents directly. A workflow may run at most 12 steps in parallel. Agent tool lists must be empty.

## Updating the bundle

1. Edit or add a versioned agent JSON and its prompt.
2. Reference existing schema IDs or add versioned schemas. All named ports are required.
3. Add the workflow step and bind every input to submitted inputs or another step's named output. Arrays can use an explicit `concat` merge.
4. Run `pnpm config:validate`, then `pnpm check`.

Inputs determine graph edges; JSON object order is irrelevant. Unknown references, duplicate JSON keys, incompatible ports, non-array merges, cycles, unused steps, invalid schemas, unsupported tools/models, and paths escaping the config root fail validation.

The validator hashes the full loaded bundle including prompts and schemas. The local test runner stores that bundle with every run, so edits do not alter a resumed run. Use a new version when publishing an intentional behavior or schema change.

## Local runner limits

`packages/analysis` provides a development/test runner and an atomic JSON-file store. The integration tests use temporary directories and synthetic fake-handler responses; they are execution-contract tests, not diligence accuracy evaluations.

Implemented: output schema checks, source-version membership checks, saved context manifests, artifact hashes/lineage, atomic multi-output publication, concurrency limits, attempt/call budgets, timeouts, cancellation, and resume from completed steps. One fake-handler invocation counts as one call. Token limits are validated configuration metadata only; token accounting and provider cost enforcement await the Grok adapter.

An exclusive local file lock prevents concurrent execution of a run. After a process crash, confirm the owner is no longer running before removing a stale `<runId>.json.lock`. The store does not provide cloud durability, encrypted tenant storage, or authenticated APIs. It is not wired to web/MCP and must not be used with investor documents. Scope checks verify the trusted test caller's supplied tenant/case, not an actual logged-in identity. Production persistence/orchestration belongs in Convex.

The local runner preserves artifacts from in-flight independent steps when one fails, blocks remaining steps, and marks the run failed. It does not produce a partial final report. Interrupted attempts consume their attempt/call budget; completed steps are not rerun. Live tool execution, provider backoff, arbitrary transforms, loops, dynamic spawning, and cross-run reuse are not implemented.

See [the design](../docs/design/AGENT_CONFIG.md) for the target production semantics.

## Convex execution

The approved fake bundle can also run through Convex Workflow. Run `pnpm config:generate` after editing configs to regenerate the deployment snapshot and standalone validators; `pnpm check` checks for drift. See [Convex run documentation](../docs/CONVEX_RUNS.md). The local runner limitations above apply to the local adapter; production Grok execution remains unimplemented.
