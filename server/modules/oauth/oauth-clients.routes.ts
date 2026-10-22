/**
 * OAuth client routes (AC-264).
 *
 * Two thin surfaces over `oauth-clients.service.ts`:
 *
 *  - {@link mountOAuthRegister} attaches the SDK's `clientRegistrationHandler`
 *    at `/oauth/register`, but only when `MCP_DCR` is not `off` — while off the
 *    path is not mounted at all, so a request falls through to Express's 404 and
 *    the endpoint is genuinely absent (not merely refusing). Mount ORDER is the
 *    composition root's job: it must sit before the static-assets middleware, or
 *    the SPA catch-all would answer the path.
 *  - {@link createOAuthClientsRouter} is the manual-client `POST` the settings
 *    API exposes. Authentication is applied by the composition root, not here;
 *    the route only parses the body, calls the service, and formats the response.
 *
 * Consumers: `server/index.ts` (mounts both) and this module's oauth-dcr
 * criterion, through the OAuth barrel.
 */

import type { Express, Router } from 'express';
import express from 'express';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';

import { createOAuthClientsService, createOAuthRegisteredClientsStore } from './oauth-clients.service.js';
import type { OAuthDcrMode } from './oauth-dcr.policy.js';
import type { OAuthStore } from './oauth-store.service.js';

/** Whether the registration endpoint was attached, and why. Consumers: `server/index.ts` and the DCR criterion. */
export type OAuthRegisterMountReading = {
  mounted: boolean;
  reason: string;
};

/** Arguments to {@link mountOAuthRegister}; the mode and allowlist are injected by the composition root. */
export type MountOAuthRegisterDeps = {
  store: OAuthStore;
  dcrMode: OAuthDcrMode;
  allowedHosts: string[];
};

/**
 * Mounts `/oauth/register` when `MCP_DCR` is `allowlist` or `open`; attaches
 * NOTHING when it is `off`, returning `{ mounted: false }` so the caller can log
 * the decision and the path answers 404. The clients store it hands the SDK
 * handler enforces the policy (allowlist + scheme safety).
 */
export function mountOAuthRegister(app: Express, deps: MountOAuthRegisterDeps): OAuthRegisterMountReading {
  const { store, dcrMode, allowedHosts } = deps;

  if (dcrMode === 'off') {
    return { mounted: false, reason: 'MCP_DCR is off' };
  }

  app.use(
    '/oauth/register',
    clientRegistrationHandler({
      clientsStore: createOAuthRegisteredClientsStore({ store, dcrMode, allowedHosts }),
    }),
  );

  return { mounted: true, reason: `MCP_DCR=${dcrMode}` };
}

/**
 * The manual-client route factory. `POST /` (mounted at `/api/oauth/clients`)
 * creates a confidential client for the logged-in user and answers
 * `201 { client_id, client_secret }` — the secret's only appearance. A missing or
 * malformed `redirect_uris` and any policy violation both answer
 * `400 { error: 'invalid_redirect_uri', error_description }`.
 *
 * The route does NOT authenticate: `server/index.ts` applies `authenticateToken`
 * ahead of it, exactly as the neighbouring settings routes do.
 */
export function createOAuthClientsRouter(deps: { store: OAuthStore }): Router {
  const service = createOAuthClientsService({ store: deps.store });
  const router = express.Router();

  router.post('/', (req, res) => {
    const body = req.body as { client_name?: unknown; redirect_uris?: unknown } | undefined;
    const rawUris = body?.redirect_uris;
    const redirectUris = Array.isArray(rawUris)
      ? rawUris.filter((value): value is string => typeof value === 'string')
      : null;

    if (redirectUris === null || redirectUris.length === 0) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: 'redirect_uris must be a non-empty array of strings',
      });
      return;
    }

    const clientName =
      typeof body?.client_name === 'string' && body.client_name.trim() !== ''
        ? body.client_name
        : 'manual client';

    const result = service.createManualClient({ clientName, redirectUris });
    if (!result.ok) {
      res.status(400).json({ error: result.error, error_description: result.reason });
      return;
    }

    res.status(201).json({ client_id: result.clientId, client_secret: result.clientSecret });
  });

  return router;
}
