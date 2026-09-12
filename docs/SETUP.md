# Environment setup

## Current configuration

Local MCP URL: `http://localhost:3000/mcp`. Local UI URL: `http://localhost:5173`.
These are local defaults only; replace them with actual HTTPS service URLs for production. The MCP route remains disabled until its external OAuth provider and identity bridge are configured. Do not mistake a successful configuration presence check for a working login flow.

Run `pnpm setup:check` to list missing settings without printing their values. Exit code 1 means settings are missing. The check reads `.env.local`, with process environment values taking precedence, and makes no network calls.

## Convex

1. Run `pnpm setup:convex` in an interactive terminal.
2. Sign in to the intended Convex account and select or create the development project.
3. Let the CLI generate its bindings and deployment configuration. Preserve the other entries in `.env.local`.
4. Confirm `CONVEX_DEPLOYMENT` and `CONVEX_URL` refer to that development deployment. Do not substitute a production deployment key to bypass development login.

This command pushes the local schema and Workflow component to the selected development deployment. Normal development uses `pnpm dev:convex`. CI/production deployment credentials are separate from application runtime identities.

## Authentication

Browser login uses Convex Auth Password. Development signing keys have been configured; follow [official manual setup](https://labs.convex.dev/auth/setup/manual) for a separate production deployment. Preserve existing signing keys. Password-only login does not require `SITE_URL`; OAuth/email redirects do. Email verification and password recovery are still pending.

For local web development, export `VITE_CONVEX_URL` in the launching shell or put this public URL in `apps/web/.env.local` (ignored). Vite does not automatically load the root secrets file. `VITE_MCP_URL` is the optional public MCP endpoint shown in the connection panel. Never put secrets in either variable.

WorkOS Standalone Connect is the selected OAuth integration, with an implemented browser-completion API and explicit account mapping. Follow [MCP_BROWSER_AUTH.md](MCP_BROWSER_AUTH.md) for provider configuration and the deferred website callback contract. Run `pnpm setup:mcp-bridge` before deploying the new auth config to a new development deployment; existing development bridge keys are already configured. Convex trusts website tokens and separate backend bridge tokens, and checks live workspace grants for the latter. No token passthrough or deployment key identity is supported.

## Render

1. Push this repository to the intended Git hosting account and connect that repository to Render.
2. Review `render.yaml`, choose the account/workspace and service plan, and create the Blueprint services.
3. Use the resulting HTTPS URL plus `/mcp` for `MCP_RESOURCE_URL` on the MCP service and `VITE_MCP_URL` on the website. Set `VITE_CONVEX_URL` at web build time.
4. After OAuth integration exists, supply only the runtime settings each service requires. Deploy keys and Render API keys do not belong in application runtime environments.

The Blueprint builds the website and MCP adapter; external MCP identity configuration and named-client tests remain required. Do not launch investor onboarding until authentication and client tests pass. The unfinished document worker is intentionally not deployed.

## Model providers

No model key is needed for the synthetic workflow. Live analysis of uploaded documents needs `XAI_API_KEY` and `LIVE_ANALYSIS_ENABLED=true` set on the Convex deployment (`pnpm exec convex env set …`); leave the flag unset to keep paid calls off. See [GROK_INGESTION.md](GROK_INGESTION.md). For a local no-sign-in demo, `pnpm demo:enable` sets these plus `DEMO_OPEN_ACCESS` on the dev deployment; see [DEMO.md](DEMO.md). Keep optional provider keys blank until used. Never expose model or service secrets via Vite variables or the companion skill.

## References

- [Convex CLI](https://docs.convex.dev/cli/overview)
- [Render Blueprint reference](https://render.com/docs/blueprint-spec)
