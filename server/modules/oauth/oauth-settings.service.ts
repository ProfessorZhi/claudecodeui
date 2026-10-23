/**
 * OAuth settings service (AC-265).
 *
 * The read/revoke/disable surface the settings page drives, over the OAuth store
 * (AC-258). It is deliberately NOT the authorization-server semantics (AC-259) nor
 * the `/mcp` authentication path (AC-263): it only answers "what has this user
 * authorized, and may I take it away".
 *
 *  - {@link OAuthSettingsService.listGrants} projects the caller's own LIVE
 *    consent grants to a display allowlist — client name, redirect host, scopes
 *    and the two timestamps. A revoked grant is not a connected app any more, so
 *    it is dropped here rather than rendered (the row itself stays, with its
 *    `revoked_at` stamp, as the cascade's audit trail). A client secret hash, the
 *    RFC 7591 metadata blob and every token are never copied, so the response
 *    cannot leak a credential.
 *  - {@link OAuthSettingsService.revokeGrant} refuses a grant that is missing OR
 *    owned by another user with the SAME `not_found` outcome: a foreign id answers
 *    404, never 403, so the endpoint is not an ownership oracle (SPEC §421).
 *  - {@link OAuthSettingsService.listClients} / {@link OAuthSettingsService.disableClient}
 *    expose the client list (distinguishing `dcr` from `manual`) and the
 *    client-disable cascade.
 *
 * All writes go through the store: the revocation timestamps and the token
 * cascade are the store's transaction and clock (AC-258), not this layer's. This
 * service performs no timestamping of its own.
 *
 * Consumers: the OAuth module's `oauth-settings.routes.ts`, `server/index.ts`, and
 * this module's oauth-settings criterion, through the OAuth barrel.
 */

import type { OAuthClientRow, OAuthGrantRow } from '@/modules/database/index.js';

import type { OAuthStore } from './oauth-store.service.js';

/**
 * The grant-repository surface the service reads. Narrowed to the three methods
 * used so the injected dependency stays explicit; the real `oauthGrantsDb`
 * satisfies it structurally. Consumers: `createOAuthSettingsService` and
 * `server/index.ts`.
 */
export type OAuthGrantsRepository = {
  listByUser(userId: number): OAuthGrantRow[];
  findById(id: number): OAuthGrantRow | undefined;
};

/**
 * The client-repository surface the service reads. Narrowed to the two methods
 * used; the real `oauthClientsDb` satisfies it structurally.
 */
export type OAuthClientsRepository = {
  findById(clientId: string): OAuthClientRow | undefined;
  allRows(): OAuthClientRow[];
};

/**
 * One grant row as the settings page renders it. `redirectHost` is the hostname of
 * the client's first registered callback; `lastUsed` is null until the grant is
 * first exercised. No secret, metadata or token field exists here by construction.
 */
export type OAuthGrantSummary = {
  id: number;
  clientId: string;
  clientName: string | null;
  redirectHost: string | null;
  scopes: string[];
  createdAt: string | null;
  lastUsed: string | null;
};

/** One client row as the settings page renders it; `createdVia` is `'dcr'` or `'manual'`. */
export type OAuthClientSummary = {
  clientId: string;
  clientName: string | null;
  redirectHost: string | null;
  createdVia: string;
  disabledAt: string | null;
};

/**
 * Outcome of a revocation attempt. `not_found` covers BOTH "no such grant" and
 * "grant belongs to another user" — the caller cannot tell them apart.
 */
export type RevokeGrantOutcome =
  | { ok: true; tokensRevoked: number }
  | { ok: false; reason: 'not_found' };

/** Outcome of a client-disable attempt; `not_found` when no client has that id. */
export type DisableClientOutcome =
  | { ok: true; tokensRevoked: number }
  | { ok: false; reason: 'not_found' };

/**
 * Construction options. `store` owns the revocation cascades; `grantsDb` /
 * `clientsDb` are the read primitives. `now` is accepted so the composition root
 * can share the process clock, but this service writes no timestamps — the store
 * stamps `revoked_at` / `disabled_at` from its own clock.
 */
export type OAuthSettingsServiceOptions = {
  store: OAuthStore;
  grantsDb: OAuthGrantsRepository;
  clientsDb: OAuthClientsRepository;
  now?: () => Date;
};

/** The settings surface the routes consume. */
export type OAuthSettingsService = {
  listGrants(userId: number): OAuthGrantSummary[];
  revokeGrant(userId: number, grantId: number): RevokeGrantOutcome;
  listClients(): OAuthClientSummary[];
  disableClient(clientId: string): DisableClientOutcome;
};

/**
 * The hostname of the first redirect URI in a stored JSON array, or null when the
 * array is empty or unparseable. Only the host is exposed, never the full URI.
 */
function firstRedirectHost(redirectUrisJson: string): string | null {
  try {
    const parsed = JSON.parse(redirectUrisJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const first = parsed[0];
    if (typeof first !== 'string') {
      return null;
    }
    const hostname = new URL(first).hostname;
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/** The stored scope array, defensively filtered to strings; `[]` when unparseable. */
function parseScopes(scopesJson: string): string[] {
  try {
    const parsed = JSON.parse(scopesJson) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Builds the settings service. Every method reads fresh rows (invoked through the
 * repositories on each call), so a revocation performed elsewhere is reflected
 * immediately.
 *
 * Consumers: `createOAuthSettingsRouter` in `oauth-settings.routes.ts`,
 * `server/index.ts`, and this module's oauth-settings criterion.
 */
export function createOAuthSettingsService(
  options: OAuthSettingsServiceOptions
): OAuthSettingsService {
  const { store, grantsDb, clientsDb } = options;

  return {
    listGrants(userId: number): OAuthGrantSummary[] {
      // Only LIVE grants: this list is the settings page's "connected apps", and a
      // grant whose `revoked_at` is stamped is no longer connected — its tokens are
      // rejected on the next `/mcp` call (AC-265 leg (b)). The summary carries no
      // revocation field, so a caller could not filter one out itself; the store's
      // row stays (its stamp is what makes the cascade auditable) while this
      // projection drops it.
      return grantsDb.listByUser(userId).filter((row) => row.revoked_at === null).map((row) => {
        const client = clientsDb.findById(row.client_id);
        return {
          id: row.id,
          clientId: row.client_id,
          clientName: client?.client_name ?? null,
          redirectHost: client === undefined ? null : firstRedirectHost(client.redirect_uris),
          scopes: parseScopes(row.scopes),
          createdAt: row.created_at,
          lastUsed: row.last_used,
        };
      });
    },

    revokeGrant(userId: number, grantId: number): RevokeGrantOutcome {
      const row = grantsDb.findById(grantId);
      // A foreign grant and a missing one are the same 404: no ownership oracle.
      if (row === undefined || row.user_id !== userId) {
        return { ok: false, reason: 'not_found' };
      }
      const { tokensRevoked } = store.revokeGrant(grantId);
      return { ok: true, tokensRevoked };
    },

    listClients(): OAuthClientSummary[] {
      return clientsDb.allRows().map((row) => ({
        clientId: row.client_id,
        clientName: row.client_name,
        redirectHost: firstRedirectHost(row.redirect_uris),
        createdVia: row.created_via,
        disabledAt: row.disabled_at,
      }));
    },

    disableClient(clientId: string): DisableClientOutcome {
      if (clientsDb.findById(clientId) === undefined) {
        return { ok: false, reason: 'not_found' };
      }
      const { tokensRevoked } = store.disableClient(clientId);
      return { ok: true, tokensRevoked };
    },
  };
}
