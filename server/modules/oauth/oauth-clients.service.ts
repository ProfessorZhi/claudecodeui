/**
 * OAuth client registration services (AC-264).
 *
 * Two ways a client comes to exist, both leaning on the same storage layer
 * (AC-258's `OAuthStore.registerClient`, which generates the id/secret, writes
 * only the SHA-256 hash, and returns the plaintext exactly once):
 *
 *  - {@link createOAuthRegisteredClientsStore} adapts the store to the SDK's
 *    `OAuthRegisteredClientsStore`, so the SDK's `clientRegistrationHandler`
 *    (`/oauth/register`) can drive dynamic registration. It applies the DCR
 *    policy first and throws the RFC 7591 `invalid_redirect_uri` error on a
 *    violation — the handler turns any `OAuthError` into `400 { error, error_description }`.
 *  - {@link createOAuthClientsService} is the manual path a logged-in user takes
 *    through the settings API. A human action is NOT gated by `MCP_DCR`, but it
 *    still gets the same scheme safety (`open` mode's rule).
 *
 * Neither path generates or hashes a secret itself: both delegate to the store,
 * which is what makes "the library holds only SHA-256" true by construction.
 *
 * Consumers: the OAuth module's `oauth-clients.routes.ts`, `server/index.ts`,
 * and this module's oauth-dcr criterion, all through the OAuth barrel.
 */

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { CustomOAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

import { oauthClientsDb } from '@/modules/database/index.js';

import type { OAuthDcrMode, RedirectUriErrorCode } from './oauth-dcr.policy.js';
import { validateRedirectUris } from './oauth-dcr.policy.js';
import type { OAuthStore } from './oauth-store.service.js';

/** Arguments to {@link createOAuthRegisteredClientsStore}. */
export type OAuthRegisteredClientsStoreDeps = {
  store: OAuthStore;
  dcrMode: OAuthDcrMode;
  allowedHosts: string[];
};

/**
 * Adapts the OAuth store to the SDK's registered-clients store.
 *
 * `registerClient` validates the declared redirect URIs against the DCR policy;
 * a violation throws a `CustomOAuthError('invalid_redirect_uri', …)` that the
 * SDK's registration handler maps to `400 { error: 'invalid_redirect_uri', error_description }`.
 * On success it persists through the store and returns the store's id and
 * plaintext secret (the only place that secret ever appears) layered over the
 * client's metadata.
 *
 * `getClient` reads a live (not disabled) row back as `OAuthClientInformationFull`
 * so a later `mcpAuthRouter` can reuse it.
 *
 * Consumers: `mountOAuthRegister` in `oauth-clients.routes.ts`, and this module's
 * oauth-dcr criterion (which pins the throw and the read-back directly).
 */
export function createOAuthRegisteredClientsStore(
  deps: OAuthRegisteredClientsStoreDeps,
): OAuthRegisteredClientsStore {
  const { store, dcrMode, allowedHosts } = deps;

  return {
    registerClient(clientInfo) {
      const validation = validateRedirectUris({
        dcrMode,
        allowedHosts,
        redirectUris: clientInfo.redirect_uris,
      });
      if (!validation.ok) {
        throw new CustomOAuthError('invalid_redirect_uri', validation.reason);
      }

      // The SDK handler pre-generates a throwaway `client_id`/`client_secret`
      // (it cannot know this store generates its own). Its TypeScript type omits
      // them, but they are present at runtime — strip them from the persisted
      // metadata so no plaintext secret ever reaches the database. Only the
      // store's SHA-256 hash does (see `oauth-store.service.ts`).
      const {
        client_id: discardedClientId,
        client_secret: discardedClientSecret,
        client_id_issued_at: discardedIssuedAt,
        ...clientMetadata
      } = clientInfo as OAuthClientInformationFull;

      const { clientId, clientSecret } = store.registerClient({
        clientName: clientInfo.client_name ?? 'dynamic client',
        redirectUris: clientInfo.redirect_uris,
        metadata: clientMetadata,
        createdVia: 'dcr',
        publicClient: clientInfo.token_endpoint_auth_method === 'none',
      });

      return { ...clientInfo, client_id: clientId, client_secret: clientSecret ?? undefined };
    },

    getClient(clientId) {
      const row = oauthClientsDb.findById(clientId);
      if (!row || row.disabled_at !== null) {
        return undefined;
      }
      const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      return {
        ...metadata,
        client_id: row.client_id,
        redirect_uris: JSON.parse(row.redirect_uris) as string[],
      } as OAuthClientInformationFull;
    },
  };
}

/** Caller-supplied fields for {@link OAuthClientsService.createManualClient}. */
export type CreateManualClientInput = {
  clientName: string;
  redirectUris: string[];
};

/**
 * Result of a manual client creation. On success `clientSecret` is the plaintext
 * and is returned only here; on violation the RFC 7591 error code and the
 * policy's reason.
 */
export type CreateManualClientResult =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; error: RedirectUriErrorCode; reason: string };

/** The manual-client surface the settings route consumes. */
export type OAuthClientsService = {
  createManualClient(input: CreateManualClientInput): CreateManualClientResult;
};

/**
 * Builds the manual-client service. A manual creation is a human action behind
 * `authenticateToken`, so it is exempt from the `MCP_DCR` gate — but it still
 * applies the `open` scheme-safety rule, because an unsafe callback is unsafe
 * however the client was created.
 *
 * Consumers: `createOAuthClientsRouter` in `oauth-clients.routes.ts`, and this
 * module's oauth-dcr criterion.
 */
export function createOAuthClientsService(deps: { store: OAuthStore }): OAuthClientsService {
  const { store } = deps;

  return {
    createManualClient({ clientName, redirectUris }) {
      const validation = validateRedirectUris({ dcrMode: 'open', allowedHosts: [], redirectUris });
      if (!validation.ok) {
        return { ok: false, error: validation.error, reason: validation.reason };
      }

      const { clientId, clientSecret } = store.registerClient({
        clientName,
        redirectUris,
        metadata: { client_name: clientName, redirect_uris: redirectUris },
        createdVia: 'manual',
        publicClient: false,
      });

      // `publicClient: false` guarantees a confidential client, so the store
      // always mints a secret here; its `string | null` type is the general case.
      return { ok: true, clientId, clientSecret: clientSecret as string };
    },
  };
}
