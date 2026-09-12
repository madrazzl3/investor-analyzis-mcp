# Grok and private document ingestion

Status: uploaded documents run the approved live **investor council** workflow (`config/workflows/investor-council.v1.json`) on Grok: intake, a Chief Venture Officer brief, ten parallel specialist lenses, a Devil's Advocate, and a synthesiser. It is tested end to end in Convex against a simulated xAI HTTP endpoint. **No paid request, live model validation, or real PDF evaluation has been performed**, and the deployment kill switch (`LIVE_ANALYSIS_ENABLED`) is off unless explicitly set. Synthetic fixtures still run the unchanged fake workflow.

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

`runs.start` derives the mode from its inputs. All synthetic fixtures run the fake workflow; all uploaded documents run the live workflow; a mix is rejected, so a requested real analysis is never answered with synthetic output. The run records `mode` and snapshots the approved bundle for that mode. The approved workflow per mode is listed explicitly in `packages/analysis/src/generate-convex.ts`; the earlier four-step `diligence-live@1.0.0` (v2 extract/consistency/verify/report agents) stays in `config/` and validates, but is no longer approved to run.

The council adapts the agent definitions in the team's [villainhat-investor](https://github.com/pavitra-st/villainhat-investor) repository (`Agents/`, orchestration in `Agents/AGENT_ORCHESTRATION.md`):

```
intake ─► cvo ─► 10 specialist lenses (parallel) ─► devils-advocate ─► synthesis ─► report
```

| Step                                                                                                                                                                                                                                                                                                                  | Agent / output contract                              | Sees                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `intake`                                                                                                                                                                                                                                                                                                              | `intake-gate@1.0.0` → `case-file@1.0.0`              | The uploaded documents (the only step with attachments) |
| `cvo`                                                                                                                                                                                                                                                                                                                 | `chief-venture-officer@1.0.0` → `cvo-brief@1.0.0`    | Case file                                               |
| `market-regulatory-exposure`, `competitive-attack-surface`, `founder-team-integrity`, `traction-authenticity`, `business-model-monetisation-ethics`, `moat-defensibility-under-attack`, `financial-captable-fragility`, `product-tech-attack-surface`, `trust-safety-reputational-risk`, `exit-return-under-downside` | same-named agents `@1.0.0` → `lens-assessment@1.0.0` | Case file and CVO brief; not each other                 |
| `devils-advocate`                                                                                                                                                                                                                                                                                                     | `devils-advocate@1.0.0` → `lens-assessment@1.0.0`    | Case file, brief, all ten assessments                   |
| `synthesis`                                                                                                                                                                                                                                                                                                           | `thesis-synthesiser@1.0.0` → `council-report@1.0.0`  | Case file, brief, all ten assessments, Devil's Advocate |

| Setting       | Value                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Model profile | `grok-primary@1.0.0` → `grok-4.6` (concrete ID; the actual response model is recorded per attempt)                      |
| Per call      | ≤16,000 output tokens (CVO 8,000; lenses and Devil's Advocate 12,000), ≤10 attachment-search tool calls, ≤180 s timeout |
| Per run       | 14 model calls without retries, ≤20 with retries; each step ≤2 attempts; up to 10 steps in parallel                     |

Contracts:

- `case-file@1.0.0`: material quality, what we know (company, product, users, model, stage; `null` when unstated), ≤40 claims with 1–2 verbatim evidence items, ≤10 contradictions/gaps with founder questions, test/other flags, and coverage.
- `cvo-brief@1.0.0`: context brief, 3–4 delegated lenses (enum of the ten step IDs), dominant risk type, confidence. Delegation adds depth; all ten lenses always run.
- `lens-assessment@1.0.0`: `abstained`, reason, and ≤3 findings: title, exploit, consequence, investment risk, VRSD scores (vector, reachability, severity, detectability; integers 0–5), priced-in, precedent tag, source, ≤3 evidence items, alternative explanation, founder question.
- `council-report@1.0.0`: executive summary, overall risk exposure, ≤6 ranked top findings (lens, finding ID, VRSD, evidence, investor implication), blind spots, ≤10 founder questions, ≤10 materials to request, and coverage. There is no invest/watch/pass recommendation.

Evidence items keep the v2 shape (`documentVersionId`, `quote` ≤300 characters, nullable `page`). Arrays and strings are bounded so each artifact stays under the 100 KB inline limit.

### Evidence integrity

Only intake reads the documents; every later step can cite only what intake extracted. Mechanical checks (`convex/analysis/evidence.ts`) run in the step action, where a violation is classified as `invalid_output`, and again in `publish`:

- Every `documentVersionId` must be one of the run's frozen document versions.
- A quote citing a plain-text transcript must occur in its text (whitespace, case, and typographic quotes/dashes are normalized). PDFs are not parsed, so PDF quotes and page anchors remain unverified.
- A step without attachments may cite only evidence present in its inputs: the same document and page, and the same quote or a contiguous excerpt of it.

These checks prove a quote was copied, not that it was read or interpreted correctly.

### Differences from the source definitions

- Input is the uploaded deck/transcripts instead of a chat summary and URL. Intake extracts an evidence-anchored case file rather than a free-text summary.
- Research enrichment (Exa/Firecrawl), Memory, and the Historian/Precedent Keeper are not implemented: this deployment has no search credentials, and precedents without verifiable sources are forbidden. Findings carry a `precedentTag` only, and the report's coverage says precedent lookup was not performed.
- Findings add verbatim `evidence`, an `alternativeExplanation`, and a `founderQuestion`. Guardrails forbid misconduct allegations and outside facts about named people or companies.
- The synthesiser applies the VRSD composite (vector × reachability × severity ÷ max(detectability, 1)) itself; the arithmetic is model-performed and not yet recomputed in code. The report references specialist artifacts instead of repeating `all_findings`.
- The source orchestration continues when a specialist fails. Here a terminal step failure fails the run; `runs.resume` retries it and reuses every accepted artifact. Reporting a failed lens in coverage (the `incomplete` state) is pending.

Each step action (`convex/analysis/execute.ts`, Node runtime):

1. Claims an attempt (`begin`), which rechecks membership, case, and source ownership and refuses new calls when the kill switch is off.
2. Loads the saved context manifest. Attachments are resolved only from the run's frozen document versions, in manifest order, and read server-side from private storage.
3. Builds a strict JSON Schema keyed by the agent's output ports from the frozen snapshot, then calls `runWithPrivateFiles` with local schema and evidence validators.
4. Publishes through the atomic `publish` mutation, which revalidates schemas and evidence, refuses stale or cancelled attempts, and stores the provider model, response ID, and token usage on the attempt. Live outputs without a provider record, or synthetic outputs with one, are rejected.

`runs.get` returns per-attempt sanitized error categories, models, and usage. `runs.artifacts` and `runs.getArtifact` name the producing `stepId`, since all eleven assessments share the `assessment` port. The website shows mode, model, calls, and reported tokens.

### Retries and failure

Workflow-level automatic action retries stay disabled because an ambiguous provider failure may already be billed. Instead the step returns a retry decision from `failAttempt`: only errors listed in the agent's `retry.on` (`rate_limit`, `provider_unavailable`) are retried, only within `retry.maxAttempts`, the agent call limit, and the run call limit, with 5 s → 10 s … ≤60 s backoff via `runAfter`. Invalid output (including evidence that fails the checks above), missing configuration, and budget errors fail immediately. The run's `error` names the step and category (for example `traction-authenticity: invalid_output`); provider bodies are never persisted. `runs.resume` reuses completed artifacts without billing them again.

### Kill switch

`LIVE_ANALYSIS_ENABLED=true` must be set on the Convex deployment, along with `XAI_API_KEY`. The flag is checked when starting, resuming, and before every new model call. Turning it off stops a running analysis before its next paid step; accepted outputs remain. `runs.capabilities` exposes the flag to the website. This is a coarse spend control, not a per-organization budget.

## Persisted provider lifecycle

The step binds the adapter callbacks: `uploaded` → `internal.providerFiles.record` (before the model sees the file), `deleted` / `cleanupFailed` → `internal.providerFiles.mark`. Files are deleted after every call, including rejected output and failed calls. A failed status write no longer masks the call's result or skips deleting the remaining files; the record stays pending for reconciliation.

`convex/crons.ts` runs `analysis/execute:reconcileProviderFiles` every 15 minutes. It deletes `uploaded` or `cleanup_failed` copies whose attempt has finished, or is still marked running but started more than 15 minutes ago (longer than an action can live). A copy already missing at the provider counts as deleted.

Known gaps: a crash after the provider accepts an upload but before its ID is recorded can still orphan a file; there is no provider-side listing reconciliation yet. Application `store: false` and explicit deletion are not a contractual provider-retention guarantee. Each step uploads its own copies (three uploads per document per run) rather than sharing them.

## Before calling this live

1. Set `XAI_API_KEY` and `LIVE_ANALYSIS_ENABLED=true` on a development deployment and run an explicitly authorized paid smoke test with synthetic decks/transcripts. Confirm `grok-4.6` accepts `input_file`, strict `json_schema` (including `anyOf` nullable fields and length/item bounds), and `max_tool_calls` as sent.
2. Evaluate evidence integrity and lens quality on labeled fixtures: wrong PDF quotes and page anchors, missed charts/tables, prompt-injection fixtures, and whether each lens abstains or scores sensibly. Transcript quotes and downstream copying are checked mechanically; PDF quotes are not. Confirm the intake's 16,000-token output cap is enough (reasoning tokens may count against it).
3. The Grok adapter caps attachments at 20 MiB per call, so larger uploads fail intake with `budget` until document chunking or pre-extraction exists.
4. Add per-organization budgets and cost reconciliation (attachment-search invocations are billed separately from tokens).
5. Evaluate large-document model coverage and cost, and add per-workspace storage quotas.

## Verification

`pnpm exec vitest run tests/grok` covers the adapter: private file requests, validated outputs, sanitized provider failures, cleanup (including failed status writes), credential/budget rejection, case authorization, immutable upload idempotency, and invalid file rejection.

`pnpm exec vitest run tests/convex/live.test.ts` runs the real Convex Workflow against a simulated xAI endpoint. It covers a complete 14-call council run (request shape, attachments to intake only, the inputs each lens, the Devil's Advocate, and the synthesiser receive, usage, provider-file deletion, step-labelled artifacts), the kill switch at start/mid-run/resume, rejection of mixed inputs, bounded retries on 429/503 with sanitized failure reasons, rejection of invalid, foreign, and unquotable intake output and of a specialist quote not in the case file (in the action and at publish) without retrying, and delayed reconciliation of abandoned provider copies. `tests/convex/evidence.test.ts` covers the evidence checks; `tests/analysis/workflow.test.ts` covers the council topology.

### Upload verification (2026-09-12)

A real 100,000,000-byte synthetic UTF-8 file was POSTed to the personal development deployment (`resolute-bloodhound-555`), attached through streaming validation, and attached again with the same receipt. The saved size matched and both completions returned the same document version. This verified that Convex preserves the exact MIME binding parameter on direct uploads. The synthetic file/case were removed and the previous administrator fixture setting restored. No model call was made. This tests storage/finalization with an administrator-supplied synthetic identity, not browser OAuth or a named MCP client's file access.

The integrated suite passes 86 tests, including streamed 100 MB validation, metadata substitution, owner/case authorization, expiry, retries, invalid bytes/hash, cleanup preservation, and HTTP MCP upload-tool dispatch. TypeScript and builds pass. Repository-wide formatting remains blocked by 90 existing files in the separate `diligent/` scaffold; changed files pass targeted formatting.
