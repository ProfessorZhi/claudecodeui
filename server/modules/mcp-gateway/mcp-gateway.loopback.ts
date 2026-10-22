/**
 * `/mcp` local-only guard (AC-242).
 *
 * While the MCP OAuth switch is off, `/mcp` must be reachable ONLY from the local
 * machine. Two independent signals decide it, and BOTH must agree:
 *
 *  1. the SOCKET's remote address is one of the three loopback literals; and
 *  2. no forwarding header is present at all.
 *
 * The socket address is read directly (`req.socket.remoteAddress`) and never
 * through Express's `ip` accessor: `app.set('trust proxy', …)` makes that accessor
 * return the CLIENT address a proxy put in `X-Forwarded-For`, so a remote caller
 * could hand it `127.0.0.1` and be treated as local — exactly the forgery this
 * guard exists to stop.
 *
 * The header check is deliberately EXISTENCE-only, never value: a local reverse
 * proxy or `tailscale serve` forwards from the loopback interface, so the socket
 * IS loopback and the header is the only thing that distinguishes a forwarded
 * request from a genuine local client. A proxy that thoughtfully rewrites the
 * header to the real (loopback) hop must not be rewarded for it, so an empty
 * string counts as "present" too.
 *
 * That env var is read HERE and nowhere else — a second reader would be a
 * second, independently-wrong decision. This function is NOT cached, unlike the
 * debug agent's gate: the criterion reads both switch states in one process, and
 * a process-lifetime cache would collapse them into the first.
 */

import type { RequestHandler } from 'express';

/** The only values (after trim+lowercase) that turn OAuth on, i.e. open the guard. */
const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);

/**
 * The three remote-address literals treated as local. Deliberately NOT the whole
 * `127.0.0.0/8` range: the criterion pins these three, and every extra accepted
 * address is another exposure surface.
 */
const LOOPBACK_REMOTE_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Forwarding headers whose mere PRESENCE rejects a loopback request. `forwarded`
 * is the RFC 7239 form; the other three are the common vendor shapes.
 */
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip'] as const;

/** The one 403 body both rejection branches return. */
const LOOPBACK_ONLY_BODY = {
  error: 'MCP is only reachable from the local machine while OAuth is disabled',
  code: 'MCP_LOOPBACK_ONLY',
};

/**
 * Whether the MCP OAuth switch is on, i.e. whether the loopback guard stands down.
 *
 * The sole reader of that env var. FAIL-CLOSED: unset, a `false`-family
 * value, or any unrecognised value answers `false` (guard active). Consumers:
 * `createMcpLoopbackGuard` (this module) and the AC-242 criterion, which reads
 * two differently-valued env objects in one process to prove there is no cache.
 */
export function readMcpOauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MCP_OAUTH_ENABLED;
  if (raw === undefined) {
    return false;
  }

  return ENABLED_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Whether a socket remote address is one of the three loopback literals.
 *
 * A missing address (`undefined`, e.g. a socket that never connected) is NOT
 * local: it fails closed. Consumers: `createMcpLoopbackGuard` (this module) and
 * the AC-242 criterion, which pins the three literals against the rejected set.
 */
export function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(address);
}

/**
 * Builds the `/mcp` middleware that admits only local direct connections while
 * OAuth is off. Consumer: `mcp-gateway.transport.ts`, which mounts it in front of
 * the injected `authorize` seam so a rejected request never reaches authentication.
 *
 * The OAuth switch is re-read on EVERY request (no capture at construction), so
 * the same mounted app observes a state change without a restart.
 */
export function createMcpLoopbackGuard(env: NodeJS.ProcessEnv = process.env): RequestHandler {
  return (req, res, next) => {
    if (readMcpOauthEnabled(env)) {
      next();
      return;
    }

    if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) {
      res.status(403).json(LOOPBACK_ONLY_BODY);
      return;
    }

    for (const header of FORWARDING_HEADERS) {
      if (req.headers[header] !== undefined) {
        res.status(403).json(LOOPBACK_ONLY_BODY);
        return;
      }
    }

    next();
  };
}
