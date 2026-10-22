/**
 * OAuth settings routes (AC-265).
 *
 * The thin express transport over `oauth-settings.service.ts` — the settings
 * page's "connected apps / OAuth clients" surface (mcp-gateway-SPEC §152,
 * §483–§485). Four handlers, one path each, all relative to `/api/settings`:
 *
 *   GET    /oauth-grants                    → 200 { grants }
 *   DELETE /oauth-grants/:grantId           → 200 { revoked, tokensRevoked } | 404
 *   GET    /oauth-clients                   → 200 { clients }
 *   PATCH  /oauth-clients/:clientId/disable → 200 { disabled, tokensRevoked } | 404
 *
 * The route does NOT authenticate and does NOT decide ownership: `server/index.ts`
 * applies `authenticateToken` ahead of it, and the service makes the
 * missing-or-foreign 404 decision, so the transport only parses the path, calls
 * the service and formats the response.
 *
 * Consumers: `server/index.ts` (mounts under `/api/settings`) and this module's
 * oauth-settings criterion, through the OAuth barrel.
 */

import type { Router } from 'express';
import express from 'express';

import type { OAuthSettingsService } from './oauth-settings.service.js';

/**
 * The authenticated principal's id, as `authenticateToken` attaches it. Mirrors
 * the settings router's reader so both `authenticateToken`-protected surfaces
 * agree on the shape.
 */
type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

/** The caller's user id, or NaN when unauthenticated (the composition root's guard prevents that). */
function userId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

/**
 * The settings route factory. Mounted at `/api/settings`, it serves the four
 * grant/client paths above; it is intentionally decoupled from the store so the
 * criterion can mount it behind an injected test principal.
 */
export function createOAuthSettingsRouter(service: OAuthSettingsService): Router {
  const router = express.Router();

  router.get('/oauth-grants', (req, res) => {
    res.status(200).json({ grants: service.listGrants(userId(req)) });
  });

  router.delete('/oauth-grants/:grantId', (req, res) => {
    const outcome = service.revokeGrant(userId(req), Number(req.params.grantId));
    if (!outcome.ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ revoked: true, tokensRevoked: outcome.tokensRevoked });
  });

  router.get('/oauth-clients', (_req, res) => {
    res.status(200).json({ clients: service.listClients() });
  });

  router.patch('/oauth-clients/:clientId/disable', (req, res) => {
    const outcome = service.disableClient(req.params.clientId);
    if (!outcome.ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ disabled: true, tokensRevoked: outcome.tokensRevoked });
  });

  return router;
}
