/**
 * `/api/oauth/token-info` route factory.
 *
 * The self-check a personal-access-token client makes before it relies on a
 * token: it presents the token itself as `Authorization: Bearer <ccp_…>` and
 * learns the account it belongs to, the scopes it carries and when it expires.
 * Verification goes through the OAuth token service on every request — the
 * service re-reads the row each call, so revoking a token takes effect here with
 * no cache and no restart.
 *
 * A valid token answers 200 `{ userId, scopes, expiresAt }`; a missing header, a
 * header using another scheme, and any token the service rejects (unknown,
 * revoked, expired, wrong prefix) all answer 401 with the same body, so the route
 * never becomes an oracle for which of those reasons applied.
 */

import express from 'express';

import type { AccessTokensService } from '@/modules/oauth/access-tokens.service.js';
import { bearerToken } from '@/shared/utils.js';

/**
 * Creates the router for the token self-check endpoint. Used by the server
 * entrypoint to mount `GET /api/oauth/token-info`, and by this module's
 * criterion to mount the production route factory on a real express server with
 * a real token service.
 */
export function createTokenInfoRouter(tokens: AccessTokensService): express.Router {
  const router = express.Router();

  router.get('/token-info', (req, res) => {
    const token = bearerToken(req.headers.authorization);
    const verified = token === null ? null : tokens.verifyToken(token);
    if (verified === null || !verified.ok) {
      res.status(401).json({ error: 'A valid personal access token is required', code: 'ACCESS_TOKEN_INVALID' });
      return;
    }
    res.json({ userId: verified.userId, scopes: verified.scopes, expiresAt: verified.expiresAt });
  });

  return router;
}
