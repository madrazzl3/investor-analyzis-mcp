/** Distinct issuer/audience: never reuse website session tokens for MCP. */
export const MCP_GRANT_CLAIM = 'urn:investor:mcp-grant';
export const MCP_BACKEND_AUDIENCE = 'investor-mcp-backend';
export function workosConfig() {
  const issuer = process.env.WORKOS_AUTHKIT_ISSUER;
  const resource = process.env.MCP_RESOURCE_URL;
  if (!issuer || !resource)
    throw new Error('MCP authorization is not configured');
  for (const value of [issuer, resource]) {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid MCP authorization configuration');
  }
  if (new URL(issuer).origin !== issuer)
    throw new Error('AuthKit issuer must be an HTTPS origin');
  return { issuer, resource, jwksUrl: `${issuer}/oauth2/jwks` };
}
export function bridgeIssuer() {
  if (!process.env.CONVEX_SITE_URL) throw new Error('Convex site URL missing');
  return `${process.env.CONVEX_SITE_URL}/mcp-bridge`;
}
