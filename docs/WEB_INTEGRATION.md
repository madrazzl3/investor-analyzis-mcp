# Web integration

The website now has two independently mounted views: a public synthetic demo and a Convex-authenticated workspace. The sample design remains intact; its fake login fields and freeform question input have been removed.

## Configuration

Set `VITE_CONVEX_URL` to the public Convex deployment URL for the web build/dev process. Optionally set `VITE_MCP_URL` to the hosted MCP endpoint. Both values are public and bundled into browser assets. Never expose model keys, OAuth secrets, or deploy keys through a `VITE_*` variable. Vite runs from `apps/web`; root `.env.local` is not automatically loaded into the web app.

Without a Convex URL, demo mode works and the private workspace displays a connection-unavailable state without collecting credentials. With a URL, `ConvexAuthProvider` handles Password sign-in/sign-up; `useConvexAuth` must confirm authentication before any private component mounts. The backend Auth configuration and signing keys must be provisioned separately. This implementation is a pilot: password recovery and email verification are not yet offered.

## Shared backend operations

- `organizations.list` discovers memberships and `organizations.createPersonal` provides idempotent onboarding.
- `cases.list` and `cases.create` provide authorized case access.
- `documents.list`, `uploads.prepare`, and `uploadValidation.attach` list/save PDF decks and UTF-8 transcripts up to 100 MB (100,000,000 bytes). The browser POSTs raw files directly to Convex storage with the exact returned headers, then finalizes validation. Upload retries reuse an in-memory request ID and retain the storage receipt once received, avoiding a second POST after a finalization failure.
- `runs.start` over the case's uploaded documents (at most 10) starts a live Grok analysis when `runs.capabilities` reports it enabled; the button is disabled otherwise. The document list is pinned with the request ID for ambiguous retries.
- `cases.addSyntheticDocument` and `runs.start` also create an explicitly labeled synthetic execution test, which does not analyze uploaded documents.
- Run details show the mode (live or synthetic), recorded model, call count, reported tokens, and per-step attempt error categories.
- `runs.list`, `runs.get`, and `runs.artifacts` subscribe to saved progress and output; lists support incremental pagination.
- `runs.cancel` and `runs.resume` use the same application operations as MCP. Reopening a saved analysis does not restart it.

There is no freeform live chat controller yet. The private case assistant is an explicit operation panel; it does not generate chat messages. Artifacts are rendered as escaped structured JSON with schema, input-artifact IDs, and source references preserved. A richer evidence/report renderer remains future work.

## Isolation and retries

Demo takes no case IDs, credentials, uploads, private questions, or private message history. Entering demo unmounts private subscriptions and input forms. Returning preserves only the selected organization/case/run IDs in memory; the backend reauthorizes and reloads content. Sign-out clears the selections. Case and organization changes clear dependent selections. Private query failures replace the view with a reconnect message.

Synthetic starts retain a request ID across ambiguous errors until acknowledged. The document ID is pinned for that retry. Keys are in memory only; after a full reload, inspect saved analyses before initiating another test. Backend idempotency and authorization remain authoritative.

## Verification and limits

`tests/web/isolation.test.ts` covers mode-scoped selection, dependent-selection clearing, and ambiguous-start key reuse. `apps/web/src/demo.test.ts` renders the actual demo and verifies synthetic labeling and absence of input/credential controls. Vite production build passes. The demo and unconfigured workspace were inspected in the local browser, including the mode switch and unavailable-auth state. Real browser sign-in/upload/run execution and target-client MCP flows were not verified by this web track.
