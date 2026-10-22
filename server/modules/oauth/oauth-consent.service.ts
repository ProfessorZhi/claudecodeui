/**
 * OAuth consent semantics (gap-oauth-consent-spa-backend-contract).
 *
 * The pure half of the SPA consent hand-off. `oauth-consent.routes.ts` parses
 * transport input and calls in here, so exactly one definition decides:
 *
 *   · which scopes the consent screen offers and which one is pinned;
 *   · whether a `(client_id, redirect_uri)` pair is a request we may send the
 *     user onward for at all (RFC 6749 §3.1.2.4 — an unregistered callback is
 *     never redirected to, on the allow branch or the deny one);
 *   · what a decision actually grants (the submitted set ∩ the vocabulary, with
 *     the read-only scope forced in and duplicates collapsed).
 *
 * Nothing here reads the request, the clock or the database: the only injected
 * seam is the client lookup, which is the AC-258 repository in production.
 *
 * Consumers: `oauth-consent.routes.ts` (both the redirect router and the JSON
 * API router) and this module's criterion `tests/oauth-consent-page.test.ts`.
 */

import type { OAuthClientRow } from '@/modules/database/index.js';
import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/access-tokens.service.js';

/** The scope every consent grants; the SPA lists it checked and not removable. */
export const OAUTH_CONSENT_READ_SCOPE = 'cloudcli:read';

/**
 * Every scope the consent screen offers, in vocabulary order, each with what it
 * lets the client do. The screen offers the WHOLE vocabulary rather than what
 * the client asked for: the clients that matter (ChatGPT, Gemini) send no
 * `scope` at all, so listing only the requested scopes left the read-only box as
 * the only choice and the owner had no way to grant a write scope.
 */
const SCOPE_DESCRIPTIONS: Record<string, string> = {
  'cloudcli:read': 'View projects, sessions, runs and status',
  'cloudcli:session:send': 'Send messages to existing sessions (the session runs commands)',
  'cloudcli:session:create': 'Start new sessions (the session runs commands)',
  'cloudcli:session:control': 'Interrupt runs, start and close sessions, stop background tasks',
  'cloudcli:approve': 'Answer pending tool approvals',
  // gap-mcp-ui-open-session: the first scope that lets a client change what the
  // user's screen shows — it opens a session in one of their connected browsers.
  'cloudcli:navigate': 'Open a session in one of your browsers',
};

/** One scope as the consent screen renders it, and as `GET /context` returns it. */
export type ConsentScopeOption = {
  scope: string;
  description: string;
  /** The pinned scope: always granted, shown checked and not removable. */
  required: boolean;
  /** True for every scope that lets the client change something (i.e. not the read-only one). */
  writable: boolean;
};

/** The client lookup this service needs; the AC-258 repository in production. */
export type OAuthConsentClients = { findById(clientId: string): OAuthClientRow | undefined };

/** The whole vocabulary, each entry flagged for the screen. */
export function consentScopeOptions(): ConsentScopeOption[] {
  return ACCESS_TOKEN_SCOPES.map((scope) => ({
    scope,
    description: SCOPE_DESCRIPTIONS[scope] ?? '',
    required: scope === OAUTH_CONSENT_READ_SCOPE,
    writable: scope !== OAUTH_CONSENT_READ_SCOPE,
  }));
}

/** The redirect URIs stored for a client; an unparseable column counts as none. */
export function registeredRedirectUris(client: OAuthClientRow): string[] {
  try {
    const parsed: unknown = JSON.parse(client.redirect_uris);
    return Array.isArray(parsed) ? parsed.filter((uri): uri is string => typeof uri === 'string') : [];
  } catch {
    return [];
  }
}

/** What a consent request validated to. A refusal carries the RFC 6749 §5.2 code and a readable reason. */
export type ConsentRequestReading =
  | {
      ok: true;
      clientId: string;
      clientName: string;
      callbackHost: string;
      redirectUri: string;
    }
  | { ok: false; status: number; error: string; message: string };

/**
 * The `(client_id, redirect_uri)` half of the authorization-request validation,
 * shared by `GET /oauth/authorize` and the two JSON API routes so the three can
 * never disagree.
 *
 * `redirect_uri` must be a parseable URL that appears VERBATIM in the client's
 * registered set: an unregistered callback is refused here, before any branch
 * that could redirect — which is what keeps the deny path from being an open
 * redirector. `response_type` is deliberately not checked here: it is transport
 * shape that only the browser-facing `GET /authorize` needs.
 */
export function readConsentRequest(
  clients: OAuthConsentClients,
  input: { clientId: string | null; redirectUri: string | null }
): ConsentRequestReading {
  if (input.clientId === null) {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Missing client_id' };
  }
  const client = clients.findById(input.clientId);
  if (!client || client.disabled_at !== null) {
    return { ok: false, status: 400, error: 'unauthorized_client', message: 'Unknown or disabled client' };
  }
  if (input.redirectUri === null) {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Missing redirect_uri' };
  }
  let callbackHost: string;
  try {
    callbackHost = new URL(input.redirectUri).host;
  } catch {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Invalid redirect_uri' };
  }
  if (!registeredRedirectUris(client).includes(input.redirectUri)) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      message: 'redirect_uri is not registered for this client',
    };
  }
  return {
    ok: true,
    clientId: input.clientId,
    clientName: client.client_name ?? '',
    callbackHost,
    redirectUri: input.redirectUri,
  };
}

/**
 * The scopes a decision grants: `cloudcli:read` first (forced, as the screen
 * pins it), then every submitted scope that is in the vocabulary, once each. A
 * value the client invented — `cloudcli:admin`, a typo, anything else — is
 * dropped rather than stored on the grant.
 */
export function grantedScopes(submitted: readonly string[]): string[] {
  const vocabulary = new Set<string>(ACCESS_TOKEN_SCOPES);
  const seen = new Set<string>([OAUTH_CONSENT_READ_SCOPE]);
  const scopes = [OAUTH_CONSENT_READ_SCOPE];
  for (const scope of submitted) {
    if (!vocabulary.has(scope) || seen.has(scope)) {
      continue;
    }
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}
