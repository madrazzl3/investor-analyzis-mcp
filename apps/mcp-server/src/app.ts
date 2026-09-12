import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMcpServer, convexBackend, type Backend } from './mcp.js';
import {
  AuthFailure,
  createAuthenticator,
  createTokenExchange,
  type AuthSettings,
} from './auth.js';

export function createHttpServer(
  settings?: AuthSettings,
  overrides?: {
    authenticate?: ReturnType<typeof createAuthenticator>;
    backend?: Backend;
    exchange?: ReturnType<typeof createTokenExchange>;
  },
) {
  const authenticate =
    settings && (overrides?.authenticate ?? createAuthenticator(settings));
  const exchange =
    settings && (overrides?.exchange ?? createTokenExchange(settings));
  return createServer(async (request, response) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    const path = request.url?.split('?')[0];
    // Validate browser origins before serving either discovery or protected traffic.
    const origin = request.headers.origin;
    if (origin && !settings?.allowedOrigins.includes(origin)) {
      json(403, { error: 'invalid_origin' });
      return;
    }
    if (origin) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader(
        'Access-Control-Expose-Headers',
        'WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version',
      );
    }

    if (request.method === 'GET' && path === '/healthz') {
      json(200, { status: 'ok', authenticationConfigured: !!settings });
      return;
    }
    if (
      request.method === 'GET' &&
      (path === '/.well-known/oauth-protected-resource/mcp' ||
        path === '/.well-known/oauth-protected-resource')
    ) {
      if (!settings) {
        json(503, { error: 'authentication_not_configured' });
        return;
      }
      json(200, {
        resource: settings.resource,
        authorization_servers: [settings.issuer],
        scopes_supported: [settings.scope],
        bearer_methods_supported: ['header'],
      });
      return;
    }
    if (
      request.method === 'GET' &&
      path === '/.well-known/oauth-authorization-server' &&
      settings?.provider === 'workos'
    ) {
      try {
        const upstream = await fetch(
          `${settings.issuer}/.well-known/oauth-authorization-server`,
          { redirect: 'error', signal: AbortSignal.timeout(5000) },
        );
        if (!upstream.ok) throw new Error();
        const metadata = await upstream.json();
        if (
          metadata.issuer !== settings.issuer ||
          !Array.isArray(metadata.code_challenge_methods_supported) ||
          !metadata.code_challenge_methods_supported.includes('S256')
        )
          throw new Error();
        for (const key of ['authorization_endpoint', 'token_endpoint']) {
          if (
            typeof metadata[key] !== 'string' ||
            new URL(metadata[key]).origin !== settings.issuer
          )
            throw new Error();
        }
        json(200, metadata);
      } catch {
        json(503, { error: 'authorization_server_unavailable' });
      }
      return;
    }
    if (path !== '/mcp') {
      json(404, { error: 'not_found' });
      return;
    }
    if (!settings || !authenticate || !exchange) {
      json(503, { error: 'authentication_not_configured' });
      return;
    }
    // Pin the external host and browser origins. Never use forwarded headers as authority.
    if (request.headers.host !== new URL(settings.resource).host) {
      json(403, { error: 'invalid_host' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, MCP-Session-Id, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      response.end();
      return;
    }
    try {
      if (
        new URL(request.url ?? '/mcp', settings.resource).searchParams.has(
          'access_token',
        )
      ) {
        json(400, { error: 'invalid_request' });
        return;
      }
      const actor = await authenticate(request.headers.authorization);
      if (request.method === 'POST') {
        const accepted = new Set(
          (request.headers.accept ?? '').split(',').flatMap((value) => {
            const [type, ...parameters] = value.trim().toLowerCase().split(';');
            const quality = parameters
              .map((p) => p.trim())
              .find((p) => p.startsWith('q='));
            const q = quality ? Number(quality.slice(2)) : 1;
            return q > 0 && q <= 1 ? [type?.trim()] : [];
          }),
        );
        if (
          !accepted.has('application/json') ||
          !accepted.has('text/event-stream')
        ) {
          json(406, {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message:
                'Accept must include application/json and text/event-stream',
            },
          });
          return;
        }
      }

      // Check the current grant before discovery/tools, not only inside tool handlers.
      let backendToken: string | undefined;
      if (!overrides?.backend || overrides.exchange) {
        try {
          backendToken = await exchange(actor);
        } catch (error) {
          if (error instanceof AuthFailure) throw error;
          throw new AuthFailure(503, 'temporarily_unavailable');
        }
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 1048576) {
          json(413, { error: 'request_too_large' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value && key !== 'authorization')
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const abort = new AbortController();
      request.once('aborted', () => abort.abort());
      response.once('close', () => {
        if (!response.writableEnded) abort.abort();
      });
      const webRequest = new Request(settings.resource, {
        signal: abort.signal,
        method: request.method,
        headers,
        ...(request.method !== 'GET' && request.method !== 'HEAD'
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      const backend =
        overrides?.backend ??
        convexBackend(settings.convexUrl, async () => backendToken!);
      const handler = createMcpHandler(() => createMcpServer(backend), {
        legacy: 'stateless',
      });
      response.once('close', () => {
        void handler.close();
      });
      const result = await handler.fetch(webRequest);
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.setHeader('Cache-Control', 'no-store');
      if (result.headers.get('content-type')?.includes('text/event-stream'))
        response.setHeader('X-Accel-Buffering', 'no');
      response.writeHead(result.status);
      try {
        if (result.body)
          await pipeline(
            Readable.fromWeb(
              result.body as import('node:stream/web').ReadableStream,
            ),
            response,
          );
        else response.end();
      } finally {
        await handler.close();
      }
    } catch (error) {
      if (response.destroyed || response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof AuthFailure) {
        if (error.status === 401 || error.status === 403)
          response.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)}", error="${error.code}", scope="${settings.scope}"`,
          );
        json(error.status, { error: error.code });
      } else json(500, { error: 'request_failed' });
    }
  });
}
