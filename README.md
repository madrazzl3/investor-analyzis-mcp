# Investor diligence — local Grok orchestration

Analyze pitch decks and transcripts through a local stdio MCP server. The Node process runs the investor council, calls xAI directly, and saves original source snapshots, workflow configuration, attempts, usage, intermediate artifacts, and reports on disk. No Convex deployment, Render service, OAuth account, or browser login is required.

Use Node 22.12+ (below 25) and pnpm 10.30.3:

```sh
pnpm install --frozen-lockfile
# Set XAI_API_KEY in your shell or the repository .env.local.
pnpm setup:check
pnpm dev
```

`pnpm dev` starts stdio MCP, so connect it from an MCP client rather than typing into its terminal. For a built server, run `pnpm demo:build` then `pnpm start:local`. See [local setup and MCP configuration](docs/LOCAL.md).

The council runs intake → context brief → ten parallel specialist lenses → Devil's Advocate → ranked report. Only intake receives files. Outputs undergo schema and source-reference checks; transcript quotes must occur in the source, and downstream quotes must come from prior inputs. PDF quotations/page accuracy still require human evaluation.

Tools: `analyze_files`, `get_report`, `list_analysis_runs`, `get_artifact`, `resume_analysis`, `cancel_analysis`, and `cleanup_provider_files`. Repeated identical files, names, case name, and configuration reuse the existing run. Local input supports PDF/TXT/MD, up to ten files and 20 MiB combined.

The local process must remain open during analysis. Results survive restarts; interrupted work resumes explicitly within its original budgets. Data is stored in gitignored `.local-runs/` (override with `LOCAL_DATA_DIR`). Files are uploaded privately to xAI and deletion is attempted after each step. This is a single-user filesystem trust boundary, with no remote service or multi-user authorization.

`XAI_MODEL` optionally overrides the configured model and is pinned into each run snapshot. No real provider inference has been verified; automated tests simulate xAI. Model access, paid usage, extraction quality, and client compatibility need live validation.

```sh
pnpm check  # configuration, types, tests, all builds, formatting
```

The old hosted website, HTTP MCP adapter, Convex backend, and their dependencies/tests remain as legacy code; they are not used by local stdio. `pnpm dev:hosted` explicitly starts the old services. Existing cloud data is not migrated and deployed services are not shut down by this change. See [plan](PLAN.md) and [hosted history](docs/README_HOSTED_HISTORY.md).
