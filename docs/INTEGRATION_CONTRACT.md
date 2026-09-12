# Integration contract

The web application and MCP adapter call the same authorized Convex case and run APIs. Convex owns orchestration, document versions, context manifests, attempts, and artifacts. Transports cannot publish analysis results or grant themselves case membership.

## Identity and workspace

Browser sessions use Convex Auth Password. `requireIdentity` normalizes the trusted Convex Auth subject to a stable user ID; external issuer subjects remain opaque. `organizations.list({})` returns only the caller's memberships. `organizations.createPersonal({})` transactionally creates an owned workspace if the caller has no membership. There is no public join-by-organization-ID operation.

The selected MCP integration uses WorkOS Standalone Connect and the dedicated Convex token bridge. Authenticated browser completion maps the stable Convex external ID to the WorkOS subject and offers one workspace grant. Each backend operation rechecks this grant and its original membership. See [MCP_BROWSER_AUTH.md](MCP_BROWSER_AUTH.md). Account configuration and the deferred website callback remain needed before live interoperability can be verified.

## Evidence and execution

The primary path is `uploads.prepare({caseId, requestId, name, contentType, size})`, raw HTTP POST to its `uploadUrl` with the exact returned headers, then `uploadValidation.attach({uploadId, storageId})`. It accepts up to 100 MB (100,000,000 bytes), authorizes the owner/case, binds immutable storage metadata to the upload intent, streams format/hash validation, and returns `{documentVersionId}` only after atomic registration. MCP exposes these as `prepare_upload` and `attach_document`. See [upload contract](GROK_INGESTION.md#upload-contract) for retries and cleanup.

The legacy inline fallback `documents.upload({caseId, requestId, name, contentType, base64})` returns `{documentVersionId}`. Supported inputs are PDF and UTF-8 text, with a 2 MiB decoded limit. Authorization is checked before upload and again at registration. Immutable metadata includes the storage hash; reuse of an idempotency key with different contents fails. Raw storage IDs and private URLs are not returned by the list query.

`runs.start({caseId, requestId, documentVersionIds})` selects the approved workflow from its inputs: synthetic fixtures run the fake workflow; uploaded documents run the live Grok workflow, only when the deployment sets `LIVE_ANALYSIS_ENABLED=true`; mixed inputs are rejected. Synthetic output is never substituted for a requested real analysis. `runs.capabilities({})` reports whether live analysis is enabled. The live workflow has not yet been validated with a paid provider call.

Both workflows persist each attempt's resolved context and validates output schemas and source IDs before publication. `runs.get`, `runs.list`, `runs.artifacts`, `runs.contexts`, `runs.cancel`, and `runs.resume` enforce case permissions. A failed attempt can be resumed within its configured budget; completed outputs are reused.

## Independent implementation areas

- MCP/auth: transport, token verification/exchange, backend tool mapping, auth routes.
- Grok/ingestion: private upload validation, provider request/response adapter, cleanup lifecycle.
- Web: Convex Auth, workspace/case management, upload/status/artifact views, isolated demo.
- Shared integration: schema, generated bindings, dependency lockfile, organization authorization, end-to-end verification.

Demo mode is curated public fixture content with no model calls. Private uploads and real model results must never appear in demo state. End-user chat, live-provider validation, companion skill packaging, provider OAuth setup, and named-client certification remain separate unfinished milestones.

## Verification recorded

On 2026-09-12, `pnpm check` passed all 49 tests, type checks, configuration drift checks, builds, and formatting. The updated backend was deployed to the existing development project. A generated test account completed Password sign-up, authenticated idempotent workspace creation, and a private UTF-8 transcript upload with an idempotent repeat. Anonymous workspace access was rejected and the smoke session was signed out. The development deployment retains only synthetic smoke data from this check; no investor files or model calls were used. The local website has an ignored environment file containing its public development Convex URL. Browser login UX, external OAuth, named MCP clients, and real inference quality are not certified by this API smoke test.
