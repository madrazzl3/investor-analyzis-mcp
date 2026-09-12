import { createRemoteJWKSet, jwtVerify, importPKCS8, SignJWT } from 'jose';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  bridgeIssuer,
  workosConfig,
  MCP_BACKEND_AUDIENCE,
  MCP_GRANT_CLAIM,
} from './mcpConfig';

export const SUBJECT_TOKEN_TYPE =
  'urn:ietf:params:oauth:token-type:access_token';
const failure = (status: number, error: string) =>
  Response.json(
    { error },
    {
      status,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    },
  );
// Hash both values before constant-length comparison; no credentials in logs/errors.
async function equalSecret(actual: string, expected: string) {
  const hash = (s: string) =>
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = await Promise.all([hash(actual), hash(expected)]);
  const aa = new Uint8Array(a),
    bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i]! ^ bb[i]!;
  return difference === 0;
}

export function publicBridgeKeys(raw: string) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.keys) || !parsed.keys.length)
    throw new Error('Missing bridge keys');
  return {
    keys: parsed.keys.map((key: Record<string, unknown>) => {
      if (
        key.kty !== 'RSA' ||
        typeof key.n !== 'string' ||
        typeof key.e !== 'string' ||
        typeof key.kid !== 'string'
      )
        throw new Error('Invalid bridge public key');
      return {
        kty: 'RSA',
        n: key.n,
        e: key.e,
        kid: key.kid,
        alg: 'RS256',
        use: 'sig',
      };
    }),
  };
}
export const jwks = httpAction(async () => {
  try {
    if (!process.env.MCP_BRIDGE_JWKS) return failure(503, 'not_configured');
    return Response.json(publicBridgeKeys(process.env.MCP_BRIDGE_JWKS), {
      headers: { 'Cache-Control': 'public, max-age=60' },
    });
  } catch {
    return failure(503, 'not_configured');
  }
});

/** Authenticated RFC 8693 exchange, not an OAuth authorization/token endpoint for clients. */
export const exchange = httpAction(async (ctx, request) => {
  const clientId = process.env.MCP_BRIDGE_CLIENT_ID;
  const clientSecret = process.env.MCP_BRIDGE_CLIENT_SECRET;
  const privateKey = process.env.MCP_BRIDGE_PRIVATE_KEY;
  const keyId = process.env.MCP_BRIDGE_KEY_ID;
  if (
    !clientId ||
    !clientSecret ||
    !privateKey ||
    !keyId ||
    !process.env.MCP_BRIDGE_JWKS
  )
    return failure(503, 'not_configured');
  const expected = `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
  if (
    !(await equalSecret(request.headers.get('authorization') ?? '', expected))
  )
    return failure(401, 'invalid_client');
  if (
    !request.headers
      .get('content-type')
      ?.startsWith('application/x-www-form-urlencoded')
  )
    return failure(400, 'invalid_request');
  const reader = request.body?.getReader();
  if (!reader) return failure(400, 'invalid_request');
  let bytes = 0,
    body = '';
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.length;
    if (bytes > 32_768) {
      await reader.cancel();
      return failure(413, 'invalid_request');
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  const form = new URLSearchParams(body);
  const names = [
    'grant_type',
    'subject_token_type',
    'requested_token_type',
    'audience',
    'subject_token',
  ];
  if (
    names.some((name) => form.getAll(name).length !== 1) ||
    [...form.keys()].some((name) => !names.includes(name)) ||
    form.get('grant_type') !==
      'urn:ietf:params:oauth:grant-type:token-exchange' ||
    form.get('subject_token_type') !== SUBJECT_TOKEN_TYPE ||
    form.get('requested_token_type') !== SUBJECT_TOKEN_TYPE ||
    form.get('audience') !== MCP_BACKEND_AUDIENCE
  )
    return failure(400, 'invalid_request');
  try {
    const config = workosConfig();
    const { payload } = await jwtVerify(
      form.get('subject_token')!,
      createRemoteJWKSet(new URL(config.jwksUrl)),
      {
        issuer: config.issuer,
        audience: config.resource,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'sid'],
      },
    );
    const connectionId = payload[MCP_GRANT_CLAIM];
    if (
      !payload.sub?.startsWith('user_') ||
      typeof connectionId !== 'string' ||
      typeof payload.sid !== 'string' ||
      !payload.sid
    )
      throw new Error();
    const claims = {
      connectionId: connectionId as Id<'mcpConnections'>,
      providerSubject: payload.sub,
      providerIssuer: config.issuer,
      consentId: payload.sid,
    };
    await ctx.runQuery(internal.mcpConnections.validate, claims);
    await ctx.runMutation(internal.mcpConnections.bindConsent, claims);
    const key = await importPKCS8(privateKey.replace(/\\n/g, '\n'), 'RS256');
    const expiresAt = Math.min(
      payload.exp!,
      Math.floor(Date.now() / 1000) + 60,
    );
    const token = await new SignJWT({
      mcpConnectionId: connectionId,
      mcpConsentId: payload.sid,
    })
      .setProtectedHeader({ alg: 'RS256', kid: keyId, typ: 'JWT' })
      .setIssuer(bridgeIssuer())
      .setAudience(MCP_BACKEND_AUDIENCE)
      .setSubject(payload.sub)
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(key);
    return Response.json(
      {
        access_token: token,
        token_type: 'Bearer',
        issued_token_type: SUBJECT_TOKEN_TYPE,
        expires_in: Math.max(0, expiresAt - Math.floor(Date.now() / 1000)),
      },
      {
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      },
    );
  } catch {
    return failure(400, 'invalid_grant');
  }
});
