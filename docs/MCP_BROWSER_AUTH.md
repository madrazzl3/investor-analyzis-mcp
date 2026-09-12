# Browser authorization for MCP

## Decision and delivery boundary

Use **WorkOS Standalone Connect** as the OAuth authorization server and retain **Convex Auth Password** as the website identity source. This avoids migrating existing website accounts while delegating OAuth authorization codes, PKCE, client registration, consent, refresh tokens, and provider token signing to WorkOS. The integration is implemented against its documented API; no WorkOS account or credentials were supplied and no named client has been verified.

The website UI is deliberately unchanged. The backend API it needs is implemented below. A live browser connection additionally requires the login page integration and provider/dashboard configuration. Do not present a configured MCP process or local mocked tests as a completed browser login.

## Flow

1. The investor's MCP app connects to Render `/mcp` and discovers WorkOS through protected resource metadata.
2. The app starts WorkOS Authorization Code + PKCE with the MCP URL as `resource`.
3. WorkOS redirects the browser to our configured Login URI with `external_auth_id`.
4. The website authenticates through its existing Convex Auth session and lets the user select a workspace and explicitly continue.
5. The website calls `mcpOAuth.completeBrowserLogin({externalAuthId, organizationId})`. Convex verifies the browser identity and current membership, obtains the email from the user record, and creates a ten-minute pending grant. Caller-supplied user IDs/emails are not accepted.
6. Convex calls WorkOS `/authkit/oauth2/complete` with a stable external ID derived from the Convex issuer and user ID. A consent option offers only this grant and workspace. The returned redirect must be on the configured AuthKit origin. Convex retrieves the WorkOS user by that exact external ID and records its provider subject. Email equality never links accounts.
7. The website navigates to the returned `redirectUri`. WorkOS shows its consent screen and completes the callback/code exchange with the MCP client. Our grant remains `awaiting_consent` until a valid provider access token is used.
8. Render verifies the WorkOS token's issuer, MCP audience, signature, time claims, user subject, consent ID, and `urn:investor:mcp-grant` claim. It exchanges this token with Convex `/mcp/exchange` using a separate restricted service credential.
9. The exchange verifies the original token again, verifies the grant/membership, and atomically binds the grant to its first WorkOS consent `sid`. It issues a separate backend JWT, lasting at most 60 seconds and never longer than the incoming token.
10. Convex verifies the backend issuer, audience, and signature. Every application operation also checks the grant's current state and original membership and limits access to the selected workspace.

The exchange credential alone grants no user access. Incoming MCP tokens are never forwarded as Convex session tokens. Backend JWTs use a dedicated signing pair, not `JWT_PRIVATE_KEY` and not a Convex deploy key.

## Website contract for the deferred UI

- Preserve only `external_auth_id` through sign-in. Do not accept arbitrary return URLs or automatically complete an authorization URL on page load.
- Require an explicit Continue gesture after displaying the signed-in account and selected workspace. WorkOS provides the authoritative client/scope consent afterward.
- Call the authenticated `mcpOAuth.completeBrowserLogin` action and navigate only to its returned redirect. Provider credentials never reach the browser.
- Show errors without provider details. Restart the connection after a failed/expired/consumed attempt; do not blindly retry completion. Ambiguous provider outcomes cannot be safely replayed.
- Use `mcpConnections.list({})` and `mcpConnections.revoke({connectionId})` for a connection-management screen. These APIs require a website session, never a delegated MCP token.
- Revocation is idempotent and immediately blocks subsequent backend operations, including already issued backend JWTs and future refreshed provider tokens carrying the old grant. Reconnection requires a new flow/grant. Revocation does not cancel runs already accepted.

A grant permits reading/managing cases, synthetic runs, documents and artifacts in one workspace through existing backend permissions. `openid` is used for WorkOS identity discovery; the signed grant claim and local membership enforce application authority. Missing grant claims fail closed. Fine-grained read-only scopes are not implemented. The local record stores the provider consent ID, not access/refresh tokens. Disconnect revokes application access; provider-wide token revocation and consent-record deletion are separate dashboard/API operations.

## Configuration

### WorkOS dashboard

1. Create/select the intended WorkOS environment and enable Standalone Connect with the future website Login URI (HTTPS).
2. Register the exact HTTPS MCP endpoint as a Resource Indicator. Do not fall back to an environment client ID as the accepted MCP audience.
3. Enable Client ID Metadata Documents. Enable Dynamic Client Registration only if needed by tested older clients, or pre-register the client with exact redirect URIs.
4. Configure permitted client scopes including `openid` and `offline_access` where refresh access is intended. Confirm the grant consent option is included in issued access tokens and maintained during refresh.
5. Test consent approval/denial, PKCE rejection, expired code rejection, callback validation, refresh, and reconnection with each target client. These are provider integration acceptance tests, not claimed by our mocks.

### Convex environment

- `WORKOS_API_KEY`: completion and external-user lookup only, server-side.
- `WORKOS_AUTHKIT_ISSUER`: exact AuthKit HTTPS origin, no trailing slash.
- `MCP_RESOURCE_URL`: the same resource registered in WorkOS.
- `MCP_BRIDGE_PRIVATE_KEY`, `MCP_BRIDGE_KEY_ID`, `MCP_BRIDGE_JWKS`: dedicated RS256 signing material/public JWKS.
- `MCP_BRIDGE_CLIENT_ID`, `MCP_BRIDGE_CLIENT_SECRET`: restricted Render-to-exchange credential.
- `CONVEX_SITE_URL`: supplied by Convex.

`pnpm setup:mcp-bridge` provisions/preserves the development bridge key pair and service credential. It copies only the service credential into ignored root `.env.local` for Render process development, never the signing key. It never targets production and refuses partial or mismatched existing configuration. It reads the selected development environment to preserve keys without printing values. Configure separate production values through secret stores. The auth config references `MCP_BRIDGE_JWKS`, so provision it before deploying this auth config to a new deployment. Rotate keys deliberately; keep old public keys until issued backend tokens expire and JWKS caches refresh.

### Render MCP environment

- `MCP_AUTH_PROVIDER=workos`
- `WORKOS_AUTHKIT_ISSUER`, `MCP_RESOURCE_URL`
- `CONVEX_URL`, `CONVEX_SITE_URL` (public backend API and HTTP action origins)
- `MCP_BRIDGE_CLIENT_ID`, `MCP_BRIDGE_CLIENT_SECRET`
- `MCP_ALLOWED_ORIGINS`: exact browser origins allowed to call MCP; omit to reject cross-origin browser requests.

Render does not need `WORKOS_API_KEY` or either signing private key. WorkOS mode derives the JWKS and exchange URLs; legacy `MCP_AUTH_PROVIDER=external` remains supported but is not the selected integration.

### Public endpoints

- Render: `/mcp`, `/.well-known/oauth-protected-resource/mcp`, root protected-resource alias; validated WorkOS discovery proxy at `/.well-known/oauth-authorization-server` for older clients.
- Convex HTTP: `POST /mcp/exchange` (authenticated token exchange), `GET /mcp/jwks` (public signing keys only).
- WorkOS: authorization, token, registration, discovery and consent endpoints. We do not reimplement these.

## Verification and limitations

Tests exercise server-derived identity, provider redirect validation, external-ID mapping, replay/expired attempts, consent binding, tenant isolation, connection ownership, immediate revocation, signed provider-to-backend token exchange, invalid client credentials, wrong audience, token lifetime, and stripping private JWK fields. Provider interactions use mocks. Live WorkOS calls, the website callback, named clients, and refresh continuity remain unverified until account configuration and UI work are completed.

Grant records are durable; automatic expiry cleanup for unused rows is deferred. WorkOS owns provider refresh-token lifecycle. Local access revocation is immediate through grant state, but provider-side revocation of an already signed access token is observed at its expiry unless local access is also revoked. Use short provider token lifetimes. No WorkOS account was created and no provider charges were incurred by implementation.

## Official references

- [WorkOS Standalone Connect](https://workos.com/docs/authkit/connect/standalone)
- [Completion API](https://workos.com/docs/reference/workos-connect/standalone)
- [WorkOS MCP configuration](https://workos.com/docs/authkit/mcp)
- [WorkOS access token claims](https://workos.com/docs/reference/workos-connect/token)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Convex custom JWT verification](https://docs.convex.dev/auth/advanced/custom-jwt)

### Recorded verification (2026-09-12)

`pnpm check` passes all 60 tests, configuration validation, type checks, builds, and formatting. The backend is deployed to the existing development Convex project. Live smoke checks verified public-only JWKS output, rejection of unauthenticated exchange requests, and Convex verification of a correctly signed backend token followed by rejection of its invalid grant. A deployment-discovered environment serialization issue was corrected without rotating keys and covered by a regression test. Rerunning development bridge setup preserved the existing key pair and service credential. These checks did not call WorkOS or test a real browser/client authorization flow.
