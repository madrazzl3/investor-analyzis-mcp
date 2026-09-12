# Local setup

Set `XAI_API_KEY` in the launching shell or the repository `.env.local`. Existing environment values take priority. Optional `XAI_MODEL` overrides the configured `grok-4.6` model; use a model available to your account. Optional `LOCAL_DATA_DIR` chooses storage (relative paths resolve against the repository). Credentials stay in the Node process.

```sh
pnpm install --frozen-lockfile
pnpm setup:check
pnpm demo:build
```

For a client supporting local stdio MCP, configure its command as `node` and its arguments as the absolute path to `apps/mcp-server/dist/stdio.js` in this repository. Example (substitute your checkout path):

```json
{
  "mcpServers": {
    "investor-diligence": {
      "command": "node",
      "args": [
        "/absolute/path/investor-analyzis-mcp/apps/mcp-server/dist/stdio.js"
      ]
    }
  }
}
```

The entry point locates config and `.env.local` relative to its own file, independent of the client's working directory. `pnpm dev` runs the source entry point for development. Do not use the old `demo:enable` command: local execution does not require public access to any Convex deployment.

Call `analyze_files` with user-supplied absolute file paths and an optional case name. Poll `get_report` with the returned run ID. Use `get_artifact` to inspect intermediate outputs. Identical inputs/configuration reuse a saved run; change the case name deliberately to request a fresh run. PDF/TXT/MD inputs must be nonempty, at most ten files and 20 MiB combined. UTF-8 text is validated before upload.

Keep the process open while running. Use `cancel_analysis` to stop work, `resume_analysis` for an interrupted/failed run, and `cleanup_provider_files` to retry pending file deletions after it stops. Resume preserves consumed budgets and cannot resurrect an exhausted or cancelled run. An abrupt process crash leaves `<runId>.json.lock` containing its PID: only remove that specific lock after checking that its owner is no longer running. Then resume explicitly.

State and originals live in `.local-runs/`, excluded from Git. If overriding the directory, keep confidential data outside tracked paths. File permissions restrict newly created state to the OS user. Do not expose this single-user adapter over an unauthenticated network transport.

The xAI integration uses [private Files management](https://docs.x.ai/developers/files/managing-files) and [structured outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs). Provider copies are deleted after use where possible; pending IDs remain on disk for cleanup. A crash immediately after upload can leave an unrecorded provider copy. Local operation still sends evidence to xAI and incurs provider charges.

Tests simulate the provider; no paid run or named MCP client has been certified. The legacy hosted web UI does not display local runs, and existing cloud data is not migrated automatically.
