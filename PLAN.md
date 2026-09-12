# Convex investor diligence plan

Updated 2026-09-12. Convex is restored as the default backend at the user's request.

## Architecture

TypeScript and pnpm remain. Convex owns application state, immutable source versions, evidence artifacts, authorization, and durable Workflow orchestration. Actions call xAI using deployment secrets. The website and authenticated HTTP MCP adapter share authorized backend operations. Render hosting is configured separately; no extra agent framework or document worker is required for this switch.

The configuration compiler defines the investor council dependency graph, parallelism, retry/call budgets, prompts, and output schemas. Intake reads sources, a context brief feeds ten specialist lenses, and the Devil's Advocate and synthesiser produce the ranked report. Outputs retain hashes, source references, and input lineage. Failed specialist coverage fails the run; recovery reuses accepted work within budgets.

## Restored defaults

- `pnpm dev` starts the Convex-backed website and HTTP MCP adapter; `pnpm dev:convex` watches backend changes.
- `pnpm setup:check` checks hosted configuration presence without exposing secrets; deployment-side secrets require separate verification.
- Local disk-backed stdio remains optional through `pnpm dev:local` and `pnpm setup:check:local`. Existing local MCP configurations continue using it.
- Local files and run history are not automatically imported into Convex. Existing cloud data is retained.

## Remaining acceptance work

- Verify deployment synchronization on the configured personal development deployment. Production and Render rollout are separate steps.
- Complete WorkOS account configuration and browser callback UI, then verify authenticated MCP with target clients. Missing authentication must continue to fail closed.
- Verify an authorized paid run on synthetic fixtures; evaluate PDF coverage, citations, model availability, prompt quality, and costs. Automated inference tests use simulated xAI.
- Define per-organization budgets, retention, and provider-file lifecycle policy. Preserve existing authorization, bounded retries, idempotency, and evidence-integrity checks.
- Browser chat, password recovery, and companion skill delivery remain unfinished.

See the [hosted implementation history](docs/PLAN_HOSTED_HISTORY.md) for detailed contracts and historical milestones, and [setup](docs/SETUP.md) for configuration.
