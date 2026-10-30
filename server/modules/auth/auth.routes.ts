import express from 'express';
import type { RequestHandler } from 'express';

import { AUTH_CLIENT_CLOCK_LOCALS_KEY, normalizeAuthClientClock } from './auth-request-log.service.js';
import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const body = req.body as {
        username?: unknown;
        password?: unknown;
        totp?: unknown;
        clientClock?: unknown;
      };
      // The login is the one request that carries no credential, so it doubles as
      // the carrier for the client's account of why its last session ended. The
      // report is published for the request logger to print; it is NOT read by the
      // authentication decision, which stays username + password and nothing else.
      const clientClock = normalizeAuthClientClock(body.clientClock);
      if (clientClock) {
        res.locals[AUTH_CLIENT_CLOCK_LOCALS_KEY] = clientClock;
      }
      res.json(await service.login(body.username, body.password, body.totp));
    } catch (error) {
      next(error);
    }
  });

  // Two-factor (TOTP) management for the signed-in user. Setup issues a secret
  // that does nothing until /2fa/enable sees a code from it; turning it off
  // needs the password and a current code, not just a session.
  router.get('/2fa/status', authenticateToken, (req, res, next) => {
    try {
      res.json(service.totpStatus((req as AuthenticatedRequest).user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/2fa/setup', authenticateToken, (req, res, next) => {
    try {
      res.json(service.totpSetup((req as AuthenticatedRequest).user));
    } catch (error) {
      next(error);
    }
  });

  router.post('/2fa/enable', authenticateToken, (req, res, next) => {
    try {
      const body = req.body as { code?: unknown };
      res.json(service.totpEnable((req as AuthenticatedRequest).user, body.code));
    } catch (error) {
      next(error);
    }
  });

  router.post('/2fa/disable', authenticateToken, async (req, res, next) => {
    try {
      const body = req.body as { password?: unknown; code?: unknown };
      res.json(await service.totpDisable((req as AuthenticatedRequest).user, body.password, body.code));
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
