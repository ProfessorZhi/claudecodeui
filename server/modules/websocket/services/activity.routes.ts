import express, { type Request, type Response } from 'express';

import type { ActivityStore } from './activity-protocol.service.js';

/**
 * The activity snapshot read port: `GET /:sessionId/activity`.
 *
 * A late-joining client needs the session's current activity *before* it starts
 * hearing frames, because the socket only tells it about changes from the moment
 * it subscribes. This route is that read: it returns the store's snapshot for the
 * session — the same object shape the socket's frames carry — or a 404 when the
 * store holds no such session (never seen, or already retired).
 *
 * The route is deliberately thin: it names the session, asks the store, and
 * translates the answer. It holds no activity state of its own, so the snapshot it
 * returns at a given revision is byte-identical to the upsert frame that revision
 * produced — the two paths read one store, which is the whole point of the
 * protocol.
 *
 * Mounted by `server/index.ts` at `/api/sessions` (behind `authenticateToken`),
 * and mounted directly on a bare app by the criterion
 * `server/modules/websocket/tests/activity-protocol.test.ts`, which is why the
 * refusal is answered in place rather than thrown: a criterion's app carries no
 * error middleware, and a thrown error would reach it as an unhandled stack.
 */
export function createActivityRouter({ activityStore }: { activityStore: ActivityStore }) {
  const router = express.Router();

  router.get('/:sessionId/activity', (request: Request, response: Response) => {
    const sessionId = routeParameter(request.params.sessionId);
    const snapshot = activityStore.snapshot(sessionId);
    if (!snapshot) {
      response.status(404).json({
        success: false,
        error: {
          code: 'SESSION_ACTIVITY_NOT_FOUND',
          message: `No activity snapshot for session "${sessionId}".`,
        },
      });
      return;
    }
    // The body IS the snapshot, not an envelope around it: the socket's frames and
    // this response are the same shape by design, so a client can anchor on either.
    response.json(snapshot);
  });

  return router;
}

/**
 * One path parameter as a string.
 *
 * Express types a route parameter as `string | string[]` (a repeated parameter
 * arrives as a list), and a session id is never a list here — the route names one
 * segment. Taking the first element is the same reading the session-hosts router
 * makes of its own parameters; an empty string then falls through to the same
 * "no such session" answer as an unknown id.
 */
function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? (value[0] ?? '') : value;
}
