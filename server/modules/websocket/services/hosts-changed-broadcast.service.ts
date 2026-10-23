import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import type { HostsChangedEvent } from '@/shared/types.js';

/**
 * The single producer of the `hosts_changed` invalidation frame.
 *
 * **An invalidation, not a payload.** The frame says *that* the host listing
 * changed and carries the revision that identifies the change — never the
 * listing itself. `GET /api/session-hosts` and its `toHostView` projection stay
 * the one place the shape is built, so the browser and the REST read cannot
 * drift into two implementations of the same view; the client answers the frame
 * by re-reading the endpoint it already trusts.
 *
 * Consumed by `server/index.ts`, which forwards the session-host manager's
 * `onChange` revisions here. It is a seam the composition root installs rather
 * than an import the manager makes: the manager is imported by the providers
 * module (and by this module's chat websocket), so a production import back into
 * the websocket module would close a cycle — the same constraint that keeps the
 * unattended-run opener late-bound.
 *
 * Delivery walks the shared connection registry and skips any socket that is not
 * open, so a closing connection is never handed a frame it would throw on. The
 * revision is passed through unchanged: a client de-duplicates on it, so
 * reusing a value would make a fresh change look like one it had already
 * applied.
 */
export function broadcastHostsChanged(rev: number): void {
  const event: HostsChangedEvent = {
    kind: 'hosts_changed',
    rev,
    timestamp: new Date().toISOString(),
  };
  const payload = JSON.stringify(event);

  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}
