# Grok and private document ingestion

Status: the Grok adapter is wired into a separate approved live workflow (`config/workflows/diligence-live.v1.json`) that runs on uploaded documents. It is tested end to end in Convex against a simulated xAI HTTP endpoint. **No paid request, live model validation, or real PDF evaluation has been performed**, and the deployment kill switch (`LIVE_ANALYSIS_ENABLED`) is off unless explicitly set. Synthetic fixtures still run the unchanged fake workflow.

## Upload contract

Web and MCP accept PDF decks and UTF-8 text transcripts from **1 to 100,000,000 bytes (100 MB)** using the same direct upload contract:

1. Call `uploads.prepare` (MCP `prepare_upload`) with `{ caseId, requestId, name, contentType, size }`. Use `application/pdf` or `text/plain`, and retain the request ID for retries.
2. POST raw file bytes to the returned `uploadUrl`, using the **exact returned headers**. Do not send multipart, base64, or your MCP authorization token. The storage response contains `{ storageId }`.
3. Call `uploadValidation.attach` (MCP `attach_document`) with `{ uploadId, storageId }`. Only its `{ documentVersionId }` result confirms a usable source.

Preparation authorizes the case and binds an expiring intent to its membership owner. A random per-intent parameter in the upload Content-Type becomes immutable Convex file metadata; finalization rejects receipts without this binding, wrong size, expired intents, and another user's intent. Original MIME type is stored separately on the document version for provider use. Upload URLs and their headers are private capabilities; never put them in logs, reports, or persisted agent artifacts.

Finalization uses a Node action to stream bytes through SHA-256 and PDF-signature/UTF-8 validation, then atomically rechecks case access, the claimed storage ID, size, type, and hash before creating the immutable source. It does not buffer 100 MB in MCP or action arguments. The MCP JSON body limit remains 1 MiB. The old `documents.upload` action remains a **2 MiB** inline fallback for existing integrations.

Retry preparation with identical metadata and request ID. If it returns `documentVersionId`, completion already succeeded; if it returns `storageId`, retry attachment without uploading again. Otherwise POST and retain the receipt before attachment. A claimed intent cannot switch storage IDs. Expired or invalid uploads require a new request ID. The website keeps the request and receipt in memory; a reload loses that local retry state. Changed bytes after a completed request require a new request ID, even when name and size match.

Intents expire after one hour. Convex gives the storage POST a two-minute timeout; slow or interrupted transfers may need to restart, and resumable multipart upload is not implemented. An hourly metadata-only cleanup scan removes expired uncommitted files and duplicate uploads, while preserving the committed original. Convex upload URLs themselves expire after one hour from issuance; a URL reissued near intent expiry may still accept bytes after finalization has expired, which cleanup will reclaim. Direct storage POST cannot enforce our size limit before bytes reach storage: the application checks the declared size before issuing a URL and rejects an actual-size mismatch before attachment. A malicious or abandoned upload may temporarily consume storage until cleanup. Rate limits and per-workspace storage quotas remain follow-up work. [Convex direct uploads](https://docs.convex.dev/file-storage/upload-files)

`documents.list` returns authorized display metadata, never storage IDs, provider IDs, binding parameters, or bearer download URLs. It currently returns up to 100 documents; pagination is pending. MCP clients need access to the actual file and an HTTP upload capability; a chat attachment is not automatically available to a remote MCP server. Clients without this capability use the website.

100 MB is an ingestion limit, not a guarantee that a model can analyze every file within its context, duration, or cost budget. Provider and evidence-quality evaluations remain required.

PDF magic-byte checking validates the upload format marker, not that the PDF is complete, readable, safe to parse, or accurately understood. Originals are never rendered by this code.

## Provider adapter

`packages/grok/src/index.ts` implements the server-only xAI Files and Responses REST boundary using native fetch. This small adapter keeps the explicitly required file lifecycle visible without an SDK dependency; broader AI SDK integration can follow when useful.

- Upload original blobs to the authenticated private Files endpoint; provider filenames contain source version IDs rather than confidential company names.
- Supply file IDs with `input_file` and a schema through Responses `text.format`.
- Request `store: false`, bounded output tokens and tool calls, request timeouts, and no optional external-search tools.
- Validate the returned JSON locally through a supplied validator before it can be published.
- Record actual response/model IDs and available token usage. Missing usage stays `null`.
- Return sanitized error categories; never log raw provider bodies, prompts, or credentials.
- Leave retry ownership to Convex Workflow. No automatic billable-call replay occurs inside the adapter.

The request also caps inline context bytes, attachment count, and aggregate attachment bytes. These are mechanical bounds, not a calibrated dollar budget. Tool charges and provider-side internal processing mean token limits alone do not enforce spend. Per-organization reservations and provider usage reconciliation remain pending.

The implementation follows xAI's [private files](https://docs.x.ai/developers/files) and [structured Responses output](https://docs.x.ai/developers/model-capabilities/text/structured-outputs) documentation. Configurable models must be validated against the actual account. Attachment search is not proof of exhaustive page inspection. Schema conformance is not proof that a quote or page anchor is correct.

## Live workflow

`runs.start` derives the mode from its inputs. All synthetic fixtures run the fake workflow; all uploaded documents run the live workflow; a mix is rejected, so a requested real analysis is never answered with synthetic output. The run records `mode` and snapshots the approved bundle for that mode.

| Setting          | Value                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Model profile    | `grok-primary@1.0.0` → `grok-4.6` (concrete ID; the actual response model is recorded per attempt)                              |
| Steps            | `extract-claims@2.0.0` → `check-consistency@2.0.0` → `verify-findings@2.0.0` → `write-report@2.0.0`                             |
| Attachments      | Every uploaded document goes to extract, consistency, and verify; the report step receives verified JSON only                   |
| Output contracts | `claims@2.0.0`, `findings@2.0.0`, `verified-findings@2.0.0`, `report@2.0.0` (nullable `page`, category, follow-up, disposition) |
| Per call         | ≤16,000 output tokens (report 8,000), ≤10 attachment-search tool calls, 180 s timeout                                           |
| Per run          | ≤8 model calls; each step ≤2 attempts                                                                                           |

v2 schemas make `page` nullable because transcripts have no pages and the prompts forbid guessing. They also bound array lengths and string sizes so each artifact stays under the 100 KB inline limit.

Each step action (`convex/analysis/execute.ts`, Node runtime):

1. Claims an attempt (`begin`), which rechecks membership, case, and source ownership and refuses new calls when the kill switch is off.
2. Loads the saved context manifest. Attachments are resolved only from the run's frozen document versions, in manifest order, and read server-side from private storage.
3. Builds a strict JSON Schema keyed by the agent's output ports from the frozen snapshot, then calls `runWithPrivateFiles` with local validators for every port.
4. Publishes through the existing atomic `publish` mutation, which revalidates schemas, rejects `documentVersionId`s outside the run, refuses stale or cancelled attempts, and stores the provider model, response ID, and token usage on the attempt. Live outputs without a provider record, or synthetic outputs with one, are rejected.

`runs.get` returns per-attempt sanitized error categories, models, and usage. The website shows mode, model, calls, and reported tokens.

### Retries and failure

Workflow-level automatic action retries stay disabled because an ambiguous provider failure may already be billed. Instead the step returns a retry decision from `failAttempt`: only errors listed in the agent's `retry.on` (`rate_limit`, `provider_unavailable`) are retried, only within `retry.maxAttempts`, the agent call limit, and the run call limit, with 5 s → 10 s … ≤60 s backoff via `runAfter`. Invalid output, foreign evidence, missing configuration, and budget errors fail immediately. The run's `error` names the step and category (for example `extract: provider_unavailable`); provider bodies are never persisted. `runs.resume` reuses completed artifacts without billing them again.

### Kill switch

`LIVE_ANALYSIS_ENABLED=true` must be set on the Convex deployment, along with `XAI_API_KEY`. The flag is checked when starting, resuming, and before every new model call. Turning it off stops a running analysis before its next paid step; accepted outputs remain. `runs.capabilities` exposes the flag to the website. This is a coarse spend control, not a per-organization budget.

## Persisted provider lifecycle

The step binds the adapter callbacks: `uploaded` → `internal.providerFiles.record` (before the model sees the file), `deleted` / `cleanupFailed` → `internal.providerFiles.mark`. Files are deleted after every call, including rejected output and failed calls. A failed status write no longer masks the call's result or skips deleting the remaining files; the record stays pending for reconciliation.

`convex/crons.ts` runs `analysis/execute:reconcileProviderFiles` every 15 minutes. It deletes `uploaded` or `cleanup_failed` copies whose attempt has finished, or is still marked running but started more than 15 minutes ago (longer than an action can live). A copy already missing at the provider counts as deleted.

Known gaps: a crash after the provider accepts an upload but before its ID is recorded can still orphan a file; there is no provider-side listing reconciliation yet. Application `store: false` and explicit deletion are not a contractual provider-retention guarantee. Each step uploads its own copies (three uploads per document per run) rather than sharing them.

## Before calling this live

1. Set `XAI_API_KEY` and `LIVE_ANALYSIS_ENABLED=true` on a development deployment and run an explicitly authorized paid smoke test with synthetic decks/transcripts. Confirm `grok-4.6` accepts `input_file`, strict `json_schema` (including `anyOf` nullable fields and length/item bounds), and `max_tool_calls` as sent.
2. Evaluate evidence integrity: quotes that do not appear in the source, wrong page anchors, missed charts/tables, and prompt-injection fixtures. Schema conformance is not proof a quote is correct; a deterministic quote check for text transcripts is a cheap next step.
3. Add per-organization budgets and cost reconciliation (attachment-search invocations are billed separately from tokens).
4. Evaluate large-document model coverage and cost, and add per-workspace storage quotas.

## Verification

`pnpm exec vitest run tests/grok` covers the adapter: private file requests, validated outputs, sanitized provider failures, cleanup (including failed status writes), credential/budget rejection, case authorization, immutable upload idempotency, and invalid file rejection.

`pnpm exec vitest run tests/convex/live.test.ts` runs the real Convex Workflow against a simulated xAI endpoint. It covers a complete four-step live run (request shape, attachments, usage, provider-file deletion), the kill switch at start/mid-run/resume, rejection of mixed inputs, bounded retries on 429/503 with sanitized failure reasons, rejection of invalid and foreign-evidence output without publishing or retrying, and delayed reconciliation of abandoned provider copies.

### Upload verification (2026-09-12)

A real 100,000,000-byte synthetic UTF-8 file was POSTed to the personal development deployment (`resolute-bloodhound-555`), attached through streaming validation, and attached again with the same receipt. The saved size matched and both completions returned the same document version. This verified that Convex preserves the exact MIME binding parameter on direct uploads. The synthetic file/case were removed and the previous administrator fixture setting restored. No model call was made. This tests storage/finalization with an administrator-supplied synthetic identity, not browser OAuth or a named MCP client's file access.

The integrated suite passes 86 tests, including streamed 100 MB validation, metadata substitution, owner/case authorization, expiry, retries, invalid bytes/hash, cleanup preservation, and HTTP MCP upload-tool dispatch. TypeScript and builds pass. Repository-wide formatting remains blocked by 90 existing files in the separate `diligent/` scaffold; changed files pass targeted formatting.
