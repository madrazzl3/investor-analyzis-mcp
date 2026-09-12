# MCP implementation profile

Target revision: **2026-07-28**, with explicitly tested stateless Streamable HTTP compatibility for **2025-03-26**, **2025-06-18**, and **2025-11-25**. The pinned official TypeScript server SDK (`@modelcontextprotocol/server` 2.0.0) owns JSON-RPC decoding, version negotiation, request metadata validation, discovery/initialization, and tool dispatch. The Node HTTP adapter owns authentication, browser-origin policy, request size limits, and response delivery.

This is a tested implementation profile, not a certification of every optional MCP feature or of ChatGPT/Claude/Grok integrations.

## Protocol boundary

| Requirement                 | Implementation / verification                                                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modern per-request protocol | `server/discover`, `tools/list`, and `tools/call` work without an initialize handshake or session ID. Server information is in result `_meta` as specified.                                                                                                                  |
| Mirrored request metadata   | SDK checks protocol version, `Mcp-Method`, and `Mcp-Name` against the body. Missing/mismatched required headers produce HTTP 400 / `HeaderMismatch` (-32020).                                                                                                                |
| Version negotiation         | Unsupported modern revisions return HTTP 400 with supported versions. Unknown RPC methods return HTTP 404 / -32601.                                                                                                                                                          |
| HTTP messages               | POST only for messages, UTF-8 JSON through the SDK, one request/notification per POST. Invalid JSON, batch bodies, and wrong content types are rejected.                                                                                                                     |
| Content negotiation         | POST requires `Accept` to list both `application/json` and `text/event-stream` with nonzero quality. Unsupported acceptance returns 406.                                                                                                                                     |
| Response delivery           | JSON or request-scoped SSE from SDK; SSE disables proxy buffering. Node pipeline handles stream errors and handler cleanup. Disconnect aborts the HTTP request context; it does not cancel an already accepted durable Convex analysis.                                      |
| Legacy HTTP                 | All three 2025 revisions initialize and list tools through the same factory. Accepted initialized notifications return empty HTTP 202. No session is minted. GET/DELETE streaming/session management is not offered; 405 is returned.                                        |
| Browser security            | Invalid Origins are rejected for discovery and MCP requests. Exact configured origins receive CORS and exposure of OAuth/protocol headers. Preflight permits modern method/name headers. MCP requests also require the configured Host.                                      |
| Authentication              | Missing/invalid access tokens produce OAuth challenges. Query-string access tokens are rejected. Grant validity is checked before every protected protocol request, including discovery and tools/list.                                                                      |
| Grant revocation / outages  | Exchange `invalid_grant` becomes HTTP 401 with `WWW-Authenticate`. Provider/exchange configuration or verification outages produce 503 without a misleading login challenge.                                                                                                 |
| Tool schemas/results        | Each tool publishes object input/output schemas, returns structured content plus serialized text, and declares read/destructive/idempotent hints. Tool execution errors remain `isError` results with sanitized text; they are distinct from protocol/authentication errors. |

The adapter does not parse or dispatch JSON-RPC itself. Do not add a parallel protocol implementation when extending it. The SDK's modern and legacy routes share one tool factory, preventing catalog differences between protocol revisions.

## Available tools

`list_workspaces`, `list_cases`, `create_case`, `prepare_upload`, `attach_document`, `list_documents`, `start_analysis`, `get_analysis_status`, `list_analysis_runs`, `list_artifacts`, `get_artifact`, `resume_analysis`, `cancel_analysis`.

These tools call the existing authorized Convex operations. A connection only sees its granted workspace. Tool pagination is backend result pagination, separate from protocol-level tools/list pagination; the small static catalog is returned in one response. Tool descriptions distinguish synthetic fixtures from deployment-enabled live analysis. Protocol tests mock analysis execution and do not certify inference quality. Resources, sampling, elicitation, MCP Tasks, and subscription-driven updates are not promised by this profile. Configuration of an OAuth service does not add these application capabilities.

Upload tools coordinate direct HTTP uploads up to 100 MB (100,000,000 bytes); file bytes are never MCP arguments. See the [upload contract](GROK_INGESTION.md#upload-contract). Chat attachments require host support for reading the file and POSTing it; the website is the fallback. This does not establish named-client upload compatibility.

## Available prompts

`review_pitch_deck` is a user-selected, argument-free workflow template, exposed through `prompts/list` and `prompts/get`. It guides case/document selection, direct uploads up to 100 MB, reuse of saved runs, bounded status polling, artifact retrieval, and reporting with source citations, alternative explanations, and uncertainty. It treats source documents and generated artifacts as untrusted evidence and explains the website fallback when a client cannot upload file bytes.

Retrieval returns one user-role text message and does not call the backend analysis tools or start model work. Prompt requests use the same authentication and live-grant checks as tool requests. Tests exercise discovery/retrieval in the modern protocol and all three supported legacy revisions, unknown prompt errors, and unauthenticated/revoked access. Named-client prompt UI support remains unverified. This prompt does not replace the planned companion skill.

To retrieve it, send `prompts/get` with `{"name":"review_pitch_deck"}` through the configured authenticated MCP connection, or select **Review a pitch deck** in a client that exposes MCP prompts.

## OAuth ownership and unfinished activation

WorkOS Standalone Connect implements the authorization server responsibilities: OAuth authorization codes + PKCE, discovery, client registration, consent, and refresh tokens. Our MCP service is the resource server, and the dedicated Convex token bridge preserves the original user/workspace grant without forwarding MCP tokens as website sessions. See [MCP_BROWSER_AUTH.md](MCP_BROWSER_AUTH.md).

The browser completion API exists, but the website callback UI and actual WorkOS account configuration remain deferred. Our local tests use signed synthetic JWTs and mocked provider/backend responses; they do not establish real provider/client compatibility. Acceptance testing with each named app must cover registered redirects, metadata discovery, browser approval/denial, token refresh, and reconnection after revocation.

## Checks

- `tests/mcp/protocol.test.ts`: actual local HTTP protocol exchanges, modern/legacy behavior, framing, metadata mismatch, tool schemas/results/errors, CORS and pre-tool grant rejection.
- `tests/auth`: token signature/audience/scope verification, exchange failures, provider completion contract, discovery proxy, key serialization.
- `tests/convex/mcp-connections.test.ts`: workspace isolation, stable identity mapping, replay/expiry, consent binding, immediate revocation, signed token bridge.
- `pnpm check`: full configuration, type, test, build, and formatting checks.

## Specification references

- [Streamable HTTP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Legacy Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

### Verification recorded

The integrated test run passed 86 tests, including the modern and three legacy protocol revisions; configuration checks, TypeScript, and builds also passed. The final `pnpm check` stopped at repository-wide formatting because 90 files in the separate `diligent/` scaffold have formatting differences. Files changed for this MCP implementation pass their targeted formatting check. No Render deployment or named-client certification was performed in this change.
