> The stdio entry point now runs entirely locally with direct xAI requests. Use [local setup](LOCAL.md); do not enable Convex demo access for it. The following deployment demo instructions are historical.

# Local demo (no sign-in)

A presenter-run setup: a local stdio MCP server calls the Convex **development** deployment without authentication, and Convex runs the live Grok investor council (intake, context brief, ten specialist lenses, Devil's Advocate, ranked report) on the files you name.

```
MCP host (Claude Desktop / Claude Code / Inspector)
  └─ stdio ─ node apps/mcp-server/dist/stdio.js      (your machine; reads local files)
               └─ HTTPS, anonymous ─ Convex dev deployment ─ Workflow ─ Grok (xAI)
```

## What demo mode opens

`DEMO_OPEN_ACCESS=true` on a Convex deployment makes every unauthenticated caller act as one shared demo actor. That actor is membership-checked like any user, so it reaches only the "Demo workspace" it creates, never a signed-in user's workspace. While it is on, **anyone who knows the deployment URL can read the demo workspace and start paid Grok runs** (each run is capped at 20 model calls; there is no global budget). Use only fictional or public documents, and turn it off after the demo. The hosted `/mcp` endpoint and website sign-in are unchanged.

## Setup (once per machine)

```sh
pnpm install --frozen-lockfile
pnpm exec convex dev --once   # push the current functions to the dev deployment
pnpm demo:enable              # DEMO_OPEN_ACCESS, LIVE_ANALYSIS_ENABLED, XAI_API_KEY (from .env.local)
pnpm demo:build               # builds apps/mcp-server/dist/stdio.js
```

`demo:enable` targets the dev deployment only, copies `XAI_API_KEY` from `.env.local` over stdin only if the deployment lacks it, and never prints values. The stdio server reads `CONVEX_URL` from its environment, or else only that line from the repository `.env.local`.

## Connect a host

Use absolute paths; hosts start the server from their own working directory.

Claude Code:

```sh
claude mcp add investor-diligence -- node /absolute/path/to/repo/apps/mcp-server/dist/stdio.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "investor-diligence": {
      "command": "node",
      "args": ["/absolute/path/to/repo/apps/mcp-server/dist/stdio.js"]
    }
  }
}
```

MCP Inspector: `npx @modelcontextprotocol/inspector node apps/mcp-server/dist/stdio.js`.

Startup problems (missing `CONVEX_URL`, demo access or live analysis off) are written to stderr, which hosts show in their MCP log.

## Run the demo

Ask the assistant, for example: _"Analyze /Users/me/Demo/acme-deck.pdf and /Users/me/Demo/acme-call.txt for investor risks."_

1. `analyze_files` reads the files locally, creates or reuses a case named after the first file (or `caseName`), uploads them, and starts the council. It returns `runId`.
2. `get_report` with `waitSeconds` (up to 50) reports progress (`n/14 steps completed`, token usage) and returns the ranked report once the run is `completed`. A live run takes several minutes, so the assistant calls it repeatedly.
3. For deeper answers, `list_artifacts` / `get_artifact` return each specialist lens's assessment.

Other local tools: `upload_file` (one path into an existing case), `upload_text` (pasted transcript text). All hosted tools remain available. Local tool errors include the backend reason (for example, "Live analysis is not enabled on this deployment").

Analyzing the same files in the same case returns the existing run instead of paying again. Use a new `caseName` for a fresh run. A failed run can be continued with `resume_analysis`.

## After the demo

```sh
pnpm demo:disable   # removes DEMO_OPEN_ACCESS and LIVE_ANALYSIS_ENABLED; keeps XAI_API_KEY
```

## Limitations

- The live council's evidence quality has not been evaluated. Present findings as risks to investigate, not conclusions.
- PDF and `.txt`/`.md` only, up to 100 MB each and 10 files per run.
- The demo workspace is shared by everyone using the deployment anonymously.
