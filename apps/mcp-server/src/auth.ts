import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type AuthSettings = {
  provider?: 'workos';
  resource: string;
  issuer: string;
  jwksUrl: string;
  scope: string;
  exchangeUrl: string;
  exchangeClientId: string;
  exchangeClientSecret: string;
  convexAudience: string;
  convexIssuer: string;
  convexJwksUrl: string;
  convexUrl: string;
  allowedOrigins: string[];
};
export class AuthFailure extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export function readAuthSettings(
  env: NodeJS.ProcessEnv,
): AuthSettings | undefined {
  if (env.MCP_AUTH_PROVIDER === 'workos') {
    const required = [
      'MCP_RESOURCE_URL',
      'WORKOS_AUTHKIT_ISSUER',
      'CONVEX_URL',
      'CONVEX_SITE_URL',
      'MCP_BRIDGE_CLIENT_ID',
      'MCP_BRIDGE_CLIENT_SECRET',
    ];
    if (required.some((name) => !env[name])) return undefined;
    for (const name of [
      'MCP_RESOURCE_URL',
      'WORKOS_AUTHKIT_ISSUER',
      'CONVEX_URL',
      'CONVEX_SITE_URL',
    ]) {
      const url = new URL(env[name]!);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(`${name} requires an HTTPS URL`);
    }
    const issuer = env.WORKOS_AUTHKIT_ISSUER!;
    const site = env.CONVEX_SITE_URL!;
    if (
      new URL(issuer).origin !== issuer ||
      new URL(site).origin !== site ||
      new URL(env.MCP_RESOURCE_URL!).pathname !== '/mcp'
    )
      throw new Error('Invalid OAuth endpoint configuration');
    return {
      provider: 'workos',
      resource: env.MCP_RESOURCE_URL!,
      issuer,
      jwksUrl: `${issuer}/oauth2/jwks`,
      scope: 'openid',
      exchangeUrl: `${site}/mcp/exchange`,
      exchangeClientId: env.MCP_BRIDGE_CLIENT_ID!,
      exchangeClientSecret: env.MCP_BRIDGE_CLIENT_SECRET!,
      convexAudience: 'investor-mcp-backend',
      convexIssuer: `${site}/mcp-bridge`,
      convexJwksUrl: `${site}/mcp/jwks`,
      convexUrl: env.CONVEX_URL!,
      allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  if (env.MCP_AUTH_PROVIDER && env.MCP_AUTH_PROVIDER !== 'external')
    throw new Error('Unknown MCP_AUTH_PROVIDER');
  const names = [
    'MCP_RESOURCE_URL',
    'MCP_AUTH_ISSUER',
    'MCP_AUTH_JWKS_URL',
    'MCP_TOKEN_EXCHANGE_URL',
    'MCP_TOKEN_EXCHANGE_CLIENT_ID',
    'MCP_TOKEN_EXCHANGE_CLIENT_SECRET',
    'MCP_CONVEX_AUDIENCE',
    'MCP_CONVEX_ISSUER',
    'MCP_CONVEX_JWKS_URL',
    'CONVEX_URL',
  ] as const;
  if (names.some((name) => !env[name])) return undefined;
  for (const name of names.filter(
    (name) => name.endsWith('URL') || name.endsWith('ISSUER'),
  )) {
    const url = new URL(env[name]!);
    if (url.protocol !== 'https:') throw new Error(`${name} requires HTTPS`);
  }
  const resource = new URL(env.MCP_RESOURCE_URL!);
  if (resource.pathname !== '/mcp' || resource.search || resource.hash)
    throw new Error('MCP_RESOURCE_URL must end in /mcp');
  return {
    resource: resource.href,
    issuer: env.MCP_AUTH_ISSUER!,
    jwksUrl: env.MCP_AUTH_JWKS_URL!,
    scope: 'diligence',
    exchangeUrl: env.MCP_TOKEN_EXCHANGE_URL!,
    exchangeClientId: env.MCP_TOKEN_EXCHANGE_CLIENT_ID!,
    exchangeClientSecret: env.MCP_TOKEN_EXCHANGE_CLIENT_SECRET!,
    convexAudience: env.MCP_CONVEX_AUDIENCE!,
    convexIssuer: env.MCP_CONVEX_ISSUER!,
    convexJwksUrl: env.MCP_CONVEX_JWKS_URL!,
    convexUrl: env.CONVEX_URL!,
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
export function createAuthenticator(
  settings: AuthSettings,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(settings.jwksUrl)),
) {
  return async (authorization: string | undefined) => {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization || '');
    if (!match) throw new AuthFailure(401, 'invalid_token');
    try {
      const { payload } = await jwtVerify(match[1]!, keys, {
        issuer: settings.issuer,
        audience: settings.resource,
        algorithms:
          settings.provider === 'workos' ? ['RS256'] : ['RS256', 'ES256'],
        requiredClaims: ['exp', 'sub', 'iat'],
      });
      if (!payload.sub) throw new Error('Missing subject');
      if (settings.provider === 'workos') {
        if (
          !payload.sub.startsWith('user_') ||
          typeof payload.sid !== 'string' ||
          !payload.sid ||
          typeof payload['urn:investor:mcp-grant'] !== 'string' ||
          !payload['urn:investor:mcp-grant']
        )
          throw new AuthFailure(403, 'insufficient_scope');
      } else if (
        typeof payload.scope !== 'string' ||
        !payload.scope.split(' ').includes(settings.scope)
      ) {
        throw new AuthFailure(403, 'insufficient_scope');
      }
      return { token: match[1]!, subject: payload.sub };
    } catch (error) {
      if (error instanceof AuthFailure) throw error;
      throw new AuthFailure(401, 'invalid_token');
    }
  };
}
// Exchange is provider-configured: the MCP token is never forwarded to Convex.
export function createTokenExchange(
  settings: AuthSettings,
  fetcher: typeof fetch = fetch,
  keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(settings.convexJwksUrl)),
) {
  return async (actor: { token: string; subject: string }) => {
    const response = await fetcher(settings.exchangeUrl, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(settings.exchangeClientId)}:${encodeURIComponent(settings.exchangeClientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: actor.token,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience: settings.convexAudience,
      }),
    });
    if (!response.ok) {
      if (response.status === 400) {
        const failure = await response.json().catch(() => null);
        if (failure?.error === 'invalid_grant')
          throw new AuthFailure(401, 'invalid_token');
      }
      throw new AuthFailure(503, 'temporarily_unavailable');
    }
    const body = (await response.json()) as {
      access_token?: string;
      token_type?: string;
    };
    if (
      !body.access_token ||
      body.access_token === actor.token ||
      body.token_type?.toLowerCase() !== 'bearer'
    )
      throw new Error('Invalid exchange response');
    const { payload } = await jwtVerify(body.access_token, keys, {
      issuer: settings.convexIssuer,
      audience: settings.convexAudience,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['exp', 'sub'],
    });
    if (payload.sub !== actor.subject)
      throw new Error('Exchange changed subject');
    return body.access_token;
  };
}
