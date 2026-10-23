import express from 'express';

import type { createSettingsService } from './settings.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function userId(req: express.Request): number {
  return Number((req as AuthenticatedRequest).user?.id);
}

function queryString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * The origin this request arrived on, used as the MCP endpoint's base when the
 * deployment has not declared `PUBLIC_BASE_URL`. Express always populates the
 * Host header for an HTTP/1.1 request, so the fallback host is the one the
 * client actually dialed.
 */
function requestOrigin(req: express.Request): string {
  return `${req.protocol}://${req.get('host') ?? ''}`;
}

/** Creates thin Settings transport handlers around the application service. */
export function createSettingsRouter(
  service: ReturnType<typeof createSettingsService>,
): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>, status = 200) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.status(status).json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/credentials', respond((req) => service.listCredentials(
    userId(req), queryString(req.query.type),
  )));
  router.post('/credentials', respond((req) => service.createCredential(userId(req), req.body ?? {})));
  router.delete('/credentials/:credentialId', respond((req) => service.deleteCredential(
    userId(req), Number(req.params.credentialId),
  )));
  router.patch('/credentials/:credentialId/toggle', respond((req) => service.toggleCredential(
    userId(req), Number(req.params.credentialId), req.body?.isActive,
  )));
  router.get('/notification-preferences', respond((req) => service.getNotificationPreferences(userId(req))));
  router.put('/notification-preferences', respond((req) => service.updateNotificationPreferences(
    userId(req), req.body ?? {},
  )));
  router.get('/push/vapid-public-key', respond(() => service.getVapidPublicKey()));
  router.post('/push/subscribe', respond((req) => service.subscribeToPush(userId(req), req.body ?? {})));
  router.post('/push/unsubscribe', respond((req) => service.unsubscribeFromPush(
    userId(req), req.body?.endpoint,
  )));
  router.get('/mcp-gateway', respond((req) => service.getMcpGatewayStatus(requestOrigin(req))));
  // The recent MCP tool-call list (AC-304). `limit` / `includeReads` are passed
  // through as raw query values; the service's reader normalizes the limit and
  // reads `includeReads` as true only for `'true'`.
  router.get('/mcp-audit', respond((req) => service.listMcpAudit(userId(req), {
    limit: req.query.limit,
    includeReads: req.query.includeReads,
  })));
  router.get('/access-tokens', respond((req) => service.listAccessTokens(userId(req))));
  // The advanced read-only OAuth-token list. GET only: OAuth tokens are issued by
  // the OAuth flows and revoked through the grant/client cascades, so no POST or
  // DELETE handler exists here (both answer 404).
  router.get('/oauth-tokens', respond((req) => service.listOAuthTokens(userId(req))));
  router.post('/access-tokens', respond(
    (req) => service.createAccessToken(userId(req), req.body ?? {}),
    201,
  ));
  router.delete('/access-tokens/:tokenId', respond((req) => service.revokeAccessToken(
    userId(req), Number(req.params.tokenId),
  )));
  return router;
}
