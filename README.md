# Investor diligence — Convex deployment

Analyze pitch decks and transcripts through a Convex-backed website and authenticated HTTP MCP service. Convex owns source files, versioned evidence, analysis state, and durable workflow orchestration. Backend actions call xAI directly; the website and MCP adapter share case authorization.

Use Node 22.12+ (below 25) and pnpm 10.30.3:

```sh
pnpm install --frozen-lockfile
pnpm setup:check
pnpm setup:convex  # push to the configured development deployment
pnpm dev           # website and HTTP MCP adapter
```

Run `pnpm dev:convex` separately to watch and deploy backend edits. Configure public `VITE_CONVEX_URL` in the web app's environment; Vite does not load root `.env.local`. See [setup](docs/SETUP.md), [browser authentication](docs/MCP_BROWSER_AUTH.md), and [web integration](docs/WEB_INTEGRATION.md). `pnpm dev:hosted` is an alias for the same website/MCP development path.

The council runs intake → context brief → ten parallel specialist lenses → Devil's Advocate → ranked report. Only intake receives files. Outputs retain explicit source references and undergo schema and evidence checks. PDF quotations and page accuracy still require evaluation. Convex stores attempts, usage, immutable source/configuration snapshots, and intermediate artifacts; runs continue independently of the client connection.

Live analysis requires `XAI_API_KEY` and `LIVE_ANALYSIS_ENABLED=true` on Convex. Tests simulate xAI; paid inference, evidence quality, and named-client compatibility remain unverified. Hosted MCP fails closed until OAuth and the identity bridge are configured; WorkOS account setup and browser callback UI remain outstanding. Browser password recovery and chat are also unfinished.

`render.yaml` describes website/MCP hosting separately from the Convex deployment. Restoring Convex does not itself publish those services. See [MCP specification](docs/MCP_SPECIFICATION.md) and [workflow details](docs/CONVEX_RUNS.md).

The disk-backed runtime remains available through `pnpm dev:local`, `pnpm setup:check:local`, and `pnpm start:local`; see [local setup](docs/LOCAL.md). Existing stdio client configurations still use that local runtime. Local runs are not migrated into Convex automatically.

```sh
pnpm check  # configuration, types, tests, builds, formatting
```

See [plan](PLAN.md). The [earlier hosted implementation record](docs/PLAN_HOSTED_HISTORY.md) preserves detailed milestones and historical verification results.
