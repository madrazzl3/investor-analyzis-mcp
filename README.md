# Investor diligence

TypeScript workspace for an authenticated hosted MCP service that coordinates evidence-based analysis of pitch decks and discussion transcripts. See [PLAN.md](PLAN.md) for architecture and milestones.

## Current state

The workspace now includes Convex Auth browser login, private workspace/case management, PDF/transcript uploads up to 100 MB (100,000,000 bytes) via the website or MCP-coordinated direct HTTP, a tested authenticated MCP transport, and a live Grok analysis workflow for uploaded documents. Convex persists runs, attempts, context manifests, provider usage, and validated artifacts for both the live and the synthetic workflows. The website keeps its curated demo separate from private data.

**Live analysis is implemented but not yet validated against the real provider.** Uploaded documents run a Grok investor council (`grok-4.6`: intake, a context brief, ten specialist risk lenses in parallel, a Devil's Advocate, and a ranked report) only when the Convex deployment sets `LIVE_ANALYSIS_ENABLED=true` and `XAI_API_KEY`; it is tested against a simulated xAI endpoint, and no paid call or evidence-quality evaluation has been made. MCP browser authorization now has a WorkOS Standalone Connect backend, explicit account mapping, revocable workspace grants, and token exchange. Provider account setup and the deferred login-page wiring are still needed; `/mcp` fails closed with 503 until configured. Browser password recovery, end-user chat, the companion skill, and named-client verification remain unfinished. See [integration contract](docs/INTEGRATION_CONTRACT.md), [authentication](docs/AUTH_MCP.md), [ingestion](docs/GROK_INGESTION.md), and [web](docs/WEB_INTEGRATION.md).

The MCP implementation targets protocol **2026-07-28**, with tested stateless fallback for the three 2025 Streamable HTTP revisions. See the [implementation profile](docs/MCP_SPECIFICATION.md) for supported behavior and remaining provider/client acceptance tests.

The MCP prompt **`review_pitch_deck`** guides the upload-to-report workflow. Clients can discover it with `prompts/list` and retrieve it with `prompts/get` (no arguments); retrieval does not start analysis. Client-specific prompt UI support is not yet verified.

## Local development

Use Node 22 LTS (22.12 or newer) and pnpm 10.30.3.

```sh
corepack enable
pnpm install --frozen-lockfile
# Only if .env.local does not already exist:
cp -n .env.example .env.local
pnpm dev
```

The HTTP service defaults to `http://127.0.0.1:3000`; Vite displays its local URL. Only the MCP dev process loads the root `.env.local`. No credentials are required for build/tests. Never put secrets in `VITE_*` variables.

```sh
pnpm check          # types, integration tests, builds, formatting
pnpm format        # format source and documentation
pnpm dev:convex     # interactive Convex setup/development when ready
```

Convex setup requires an account/deployment and may update `.env.local`; preserve existing local values. Set Convex action secrets in the Convex deployment and Render runtime secrets on their respective services. The credential inventory is in `.env.example`. Browser login uses Convex Auth Password. WorkOS Standalone Connect handles MCP OAuth; see [browser authorization setup](docs/MCP_BROWSER_AUTH.md). Set `VITE_CONVEX_URL` for the web build (a public URL, never a secret).

## Layout

- `apps/mcp-server`: authenticated Streamable HTTP transport and Convex tool adapter.
- `apps/web`: browser authentication, private workspaces/uploads, synthetic run inspection, and isolated demo.
- `apps/document-worker`: reserved processing entry point.
- `convex`: authorized case/run APIs, persisted artifacts, and Workflow execution.
- `packages/contracts`: shared validated contracts.
- `tests/integration`: HTTP boundary tests.
- `skills`: companion skill delivery notes.

## Deployment

`render.yaml` describes the MCP web service and static preview. The Convex backend has been deployed to the configured development project and verified with a synthetic run. Render services have not been deployed by this task. The blueprint intentionally omits the unfinished worker. MCP returns 503 until its external OAuth/token exchange settings are configured. `/healthz` success does not indicate analysis readiness. Convex deployment is a separate setup step. Development Convex Auth signing keys have been configured. The account mapping/token bridge is implemented; live WorkOS and target-client verification remain required.

## Next milestone

Run an authorized paid smoke test of the live workflow on synthetic decks/transcripts, then evaluate extraction, evidence integrity, and lens quality, and add per-organization budgets. Configure the MCP OAuth identity bridge before testing ChatGPT, Claude, and Grok. See PLAN.md for chat, report, and skill milestones.

## Configuration checklist

See [docs/SETUP.md](docs/SETUP.md). Run `pnpm setup:check` for a secret-safe presence check and `pnpm setup:convex` for interactive development-project setup. WorkOS account configuration and the login-page integration are still needed to activate the browser flow.

## Website scope

The website supports Convex Auth sign-in, private workspace/case management, bounded PDF/TXT uploads, live Grok analysis of uploaded documents (when enabled), persisted run inspection, and a Demo / My workspace switch. Demo uses fictional content without login or model calls. End-user chat remains pending. See [web integration](docs/WEB_INTEGRATION.md).

## Agent configuration milestone

The JSON configuration validator and a local fake-agent runner are implemented in `packages/analysis`. Run `pnpm config:validate` to validate the workflows in `config/`. Run `pnpm exec vitest run tests/analysis` to exercise disk persistence, named input/output wiring, resume, fan-in, retries, cancellation, and invalid-output rejection without credentials or paid requests.

See [config/README.md](config/README.md) for editing instructions and limitations. The local runner remains a fake-agent test harness and refuses live bundles. Convex runs both the synthetic workflow and the live Grok workflow; production release remains pending. No real documents are processed by the fake agents.

## Convex workflow milestone

See [docs/CONVEX_RUNS.md](docs/CONVEX_RUNS.md) for authorized backend operations, configuration publication, persistence/recovery behavior, and test/deployment evidence. Run `pnpm config:generate` after changing agent configuration; `pnpm check` detects stale generated validators and snapshots.
