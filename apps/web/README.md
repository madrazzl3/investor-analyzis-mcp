# Investor diligence website

Run `pnpm --filter @investor/web dev` from the repository root. The default view is the synthetic Northstar demo, with sample evidence, curated questions, and prewritten responses. Demo accepts no private files or freeform questions and makes no paid model calls.

The My workspace view uses Convex Auth Password sign-in/sign-up and the shared authorized backend for organization onboarding, cases, document uploads, saved runs, artifacts, cancellation, and resume. Set the public `VITE_CONVEX_URL` in the web process/build environment to enable the connection. Without it, authentication stays unavailable and no credentials are collected. Optional `VITE_MCP_URL` enables copying the hosted endpoint; named-client compatibility is not claimed.

“Run live analysis” sends the case's uploaded documents through the Grok workflow when the deployment enables it; a separate, labeled synthetic workflow test remains. Reports are shown as structured JSON. Conversational chat is not wired in yet. No live run has been verified in a browser. Password recovery/email verification remain pilot limitations. No real web sign-in or confidential-document run has been verified in this task.

See [web integration](../../docs/WEB_INTEGRATION.md) for configuration, API boundaries, mode isolation, tests, and limitations. Fonts load from Google Fonts with local fallbacks.
