# Authentication and MCP adapter

## Selected browser authorization integration

WorkOS Standalone Connect now supplies the OAuth side while retaining Convex Auth website login. The login-completion API, explicit identity mapping, workspace grants/revocation, and separate Convex token bridge are implemented. See [MCP_BROWSER_AUTH.md](MCP_BROWSER_AUTH.md) for the current flow, settings, tests, and deferred website UI. Provider account configuration and named-client verification remain required. The external-provider discussion below describes the legacy adapter mode.

## Implemented

The Render process serves authenticated MCP over Streamable HTTP using the installed official SDK's per-request handler. It provides protected resource metadata at `/.well-known/oauth-protected-resource/mcp` (and the root alias). Missing deployment configuration returns 503; missing/invalid tokens return 401 with an OAuth discovery challenge; missing scope returns 403. Issuer, resource audience, signature algorithm, expiration, issued-at and subject are validated. Browser origins and the canonical Host are checked before processing. Request bodies are limited to 1 MiB. Authentication tokens are never logged or copied into tool arguments.

The exposed tools are `list_workspaces`, `list_cases`, `create_case`, `list_documents`, `resume_analysis`, `start_analysis`, `get_analysis_status`, `list_analysis_runs`, `list_artifacts`, `get_artifact`, and `cancel_analysis`. They call existing authorization-aware Convex functions; each tool request gets a separate authenticated Convex client. Backend errors are returned as tool errors without leaking provider diagnostics. Run outputs remain in Convex, independent of HTTP connections. The initial MCP start tool exposes the synthetic workflow only. Live ingestion is a separate track, not implicitly enabled by this transport.

## Website login

`convex/auth.ts` configures Convex Auth's Password provider for pilot sign-up and sign-in. Passwords must contain 12–256 characters. The web client uses `ConvexAuthProvider`, `useAuthActions().signIn('password', {email, password, flow})`, and `signOut()`. Convex Auth owns credentials/sessions; application membership is separate. `convex/identity.ts` normalizes only the trusted Convex Auth issuer's session-bearing subject into its stable user ID using `getAuthUserId`. Other trusted providers' subjects remain opaque. Email addresses never grant organization access.

Development signing keys (`JWT_PRIVATE_KEY`, `JWKS`) are configured through the official manual setup procedure; `CONVEX_SITE_URL` is deployment-provided. Configure separate keys for production. `SITE_URL` is needed for OAuth/email redirects, not Password-only login. Email verification and password recovery are not implemented: this is a pilot login, not a production account-lifecycle claim. Do not use unverified email for invites or automatic account linking.

## Legacy external-provider identity boundary

Convex Auth is not an MCP OAuth authorization server. The MCP adapter requires an external authorization server supporting the selected clients and a provider-operated OAuth token exchange endpoint. We have not selected/configured or tested that provider.

In legacy external mode, the adapter verifies an MCP-audience JWT, exchanges it using RFC 8693, then verifies the newly issued backend-audience JWT before passing it to Convex. It rejects reusing the incoming token. The exchange must preserve `sub`; changing subjects is rejected. Configure Convex to trust the exchanged token's issuer/audience through a separately reviewed provider addition. The auth config now additionally trusts our dedicated Convex bridge issuer when its keys are configured. Arbitrary external exchange tokens remain rejected.

**An external identity and a website identity are not linked automatically.** A provider integration must map an authenticated MCP investor to the same stable Convex user identity through an authorized bridge, or implement reviewed explicit account linking and a different exchange mapping contract. Do not manually equate email addresses, forward MCP tokens, or use a deploy key as runtime application identity. Until that integration is validated, the MCP deployment should remain unconfigured/fail closed. The resource-server foundation is executable and locally tested; end-to-end OAuth login is not claimed complete.

Required Render settings:

- `MCP_RESOURCE_URL`: canonical HTTPS URL ending in `/mcp`.
- `MCP_AUTH_ISSUER`, `MCP_AUTH_JWKS_URL`: externally operated authorization server and signing keys.
- `MCP_TOKEN_EXCHANGE_URL`, `MCP_TOKEN_EXCHANGE_CLIENT_ID`, `MCP_TOKEN_EXCHANGE_CLIENT_SECRET`: provider exchange endpoint and restricted client credentials.
- `MCP_CONVEX_AUDIENCE`, `MCP_CONVEX_ISSUER`, `MCP_CONVEX_JWKS_URL`: expected backend token claims/keys.
- `CONVEX_URL`: backend deployment URL.
- `MCP_ALLOWED_ORIGINS`: comma-separated exact browser origins (empty rejects browser-origin requests).

The required MCP scope is `diligence`. Metadata is sourced from configuration, never request Host/forwarded headers. Access JWTs are verified per request; immediate provider revocation/introspection is not implemented. Use short token lifetimes and existing membership checks for case revocation. There is no public OAuth authorize/token endpoint in this repository.

## Protocol profile

See [MCP_SPECIFICATION.md](MCP_SPECIFICATION.md) for the targeted revision, stateless legacy compatibility, and HTTP conformance tests. The backend grant is verified before protected protocol requests, so revoked connections receive HTTP 401 with OAuth discovery rather than an application tool error. Infrastructure failures remain HTTP 503.

## Verification and release limits

`tests/auth/mcp.test.ts` covers audience/expiry/scope failures, exchange token reuse and subject mismatch, metadata, origin rejection, and a real authenticated HTTP tool call against a fake backend. Existing Convex tests enforce tenant access. These are local protocol tests, not verification of ChatGPT, Claude, or Grok consumer integrations. No Render deployment was performed. Authentication setup, provider exchange/account mapping, email recovery, named-client tests, and production abuse controls remain release work.

References: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization), [Convex Auth setup](https://labs.convex.dev/auth/setup), [Password provider](https://labs.convex.dev/auth/config/passwords).
