/**
 * One log line per OAuth and MCP HTTP request, with every secret left out.
 *
 * The server had no request log at all, so when an external client (Gemini)
 * registered and was sent to the consent page but never exchanged its code, the
 * only evidence was database rows that look identical for "the request never
 * arrived" and "it arrived and was refused". This line says which: method, path
 * without the query, status, the OAuth `error` or the HTML error message, the
 * redirect target's origin and path (never its query, which carries the code),
 * the client id's first eight characters, the grant type, the caller's address as
 * Cloudflare reports it, the Cloudflare ray id, the user agent, and only the
 * *class* of a bearer token (`ccp_`, `cca_`, other) — never the token.
 *
 * It never reads or prints: passwords, authorization codes, code verifiers,
 * client secrets, refresh or access tokens, `state`, or any redirect query.
 */

import type { Request, RequestHandler, Response } from 'express';

/** Where each finished request's line is written; `console.log` in production. */
type LogSink = (line: string) => void;

/** Replaces anything that could break a log line (control characters, non-ASCII) and caps the length. */
function printable(value: unknown, max: number): string {
  return String(value ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

/** The first header value, or `undefined`. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** `ccp` / `cca` / `other` for a Bearer credential, `none` when absent; the token itself is never kept. */
function bearerClass(req: Request): string {
  const authorization = header(req, 'authorization');
  if (!authorization || !/^Bearer\s+\S/i.test(authorization)) {
    return 'none';
  }
  const token = authorization.replace(/^Bearer\s+/i, '');
  if (token.startsWith('ccp_')) return 'ccp';
  if (token.startsWith('cca_')) return 'cca';
  return 'other';
}

/** A redirect's origin and path without its query, or `-` when the response did not redirect. */
function redirectTarget(res: Response): string {
  const location = res.getHeader('location');
  if (typeof location !== 'string') {
    return '-';
  }
  try {
    const url = new URL(location);
    return printable(`${url.origin}${url.pathname}`, 120);
  } catch {
    return 'unparseable';
  }
}

/**
 * Creates the request logger. Mount it before the OAuth and MCP routers on the
 * path prefixes worth recording; it adds no behaviour of its own and never
 * alters a response. Used by the server entrypoint (`server/index.ts`) and by this
 * module's criterion, which supplies `log` to read the lines.
 */
export function createOAuthRequestLogger(options: { log?: LogSink; now?: () => number } = {}): RequestHandler {
  const log: LogSink = options.log ?? ((line) => console.log(line));
  const now = options.now ?? Date.now;

  return (req, res, next) => {
    const started = now();
    let oauthError: string | undefined;
    let htmlMessage: string | undefined;

    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const error = (body as { error?: unknown } | null)?.error;
      if (typeof error === 'string') {
        oauthError = error;
      }
      return json(body);
    };
    const send = res.send.bind(res);
    res.send = (body?: unknown) => {
      if (typeof body === 'string' && res.statusCode >= 400) {
        htmlMessage = /<p>([^<]{1,120})<\/p>/.exec(body)?.[1];
      }
      return send(body);
    };

    res.on('finish', () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const query = (req.query ?? {}) as Record<string, unknown>;
      const clientId = printable(body.client_id ?? query.client_id, 64).replace(/[^0-9a-zA-Z]/g, '').slice(0, 8);
      const rawGrant = printable(body.grant_type, 32);
      const grant = rawGrant === 'authorization_code' || rawGrant === 'refresh_token' ? rawGrant : '-';
      const detail = oauthError ? ` ${printable(oauthError, 40)}` : htmlMessage ? ` msg="${printable(htmlMessage, 100)}"` : '';
      log(
        `[OAuthReq] ${printable(req.method, 8)} ${printable(req.originalUrl.split('?')[0], 100)} -> ${res.statusCode}${detail}`
        + ` redirect=${redirectTarget(res)} ${now() - started}ms client=${clientId || '-'} grant=${grant}`
        + ` auth=${bearerClass(req)} ip=${printable(header(req, 'cf-connecting-ip') ?? req.socket?.remoteAddress ?? '-', 45)}`
        + ` ray=${printable(header(req, 'cf-ray') ?? '-', 24)} ua="${printable(header(req, 'user-agent') ?? '-', 60)}"`
      );
    });
    next();
  };
}
