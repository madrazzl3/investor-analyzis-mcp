import type { AuthConfig } from 'convex/server';
import { bridgeIssuer, MCP_BACKEND_AUDIENCE } from './mcpConfig';

export default {
  providers: [
    ...(process.env.MCP_BRIDGE_JWKS
      ? [
          {
            type: 'customJwt' as const,
            issuer: bridgeIssuer(),
            applicationID: MCP_BACKEND_AUDIENCE,
            jwks: `${process.env.CONVEX_SITE_URL}/mcp/jwks`,
            algorithm: 'RS256' as const,
          },
        ]
      : []),
    { domain: process.env.CONVEX_SITE_URL!, applicationID: 'convex' },
  ],
} satisfies AuthConfig;
