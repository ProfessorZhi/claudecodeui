import { uiLastOpenedDb } from '@/modules/database/index.js';
import type { UiLastOpenedRecord } from '@/modules/database/index.js';

/**
 * The seam over the browser's last-opened-session pointer.
 *
 * WHY THIS EXISTS AS A SERVICE AND NOT INLINE IN THE ROUTE. The pointer is
 * storage, and the module rules keep the providers routes to parse → call →
 * translate. The routes call these two methods; the MCP gateway is handed the
 * same reader (`readLastOpened`) at composition time, so there is exactly ONE
 * place that knows the pointer's storage shape and exactly one place that can
 * write it.
 *
 * WHY THE WRITE IS BROWSER-ONLY. `recordOpenedSession` is called from the
 * provider's session-read HTTP routes — the transcript and outline endpoints the
 * UI hits when it opens a session. An MCP token never reaches those routes: the
 * gateway's `session_read` calls `sessionsService.fetchHistory`/`fetchOutline`
 * directly, so a token reading a transcript cannot move the pointer. That is the
 * AC that says "an MCP caller must not write this table", enforced by the two
 * call graphs being disjoint rather than by a branch inside this file.
 *
 * WHAT COUNTS AS "OPENED". Neither route is ever called speculatively: the UI
 * fetches a transcript/outline only for the session it is showing, so a request
 * on either route IS the browser opening that session. See the task record's
 * Finding for the prefetch investigation that pins this.
 *
 * Consumers: `provider.routes.ts` (the messages and outline handlers) and
 * `server/index.ts`, which binds `readLastOpened` into the MCP gateway's
 * `readTools` bag as `uiLastOpened`.
 */
export const uiLastOpenedSessionService = {
  /** Records `sessionId` as the one session the UI has open, replacing any other. */
  recordOpenedSession(sessionId: string, at: number = Date.now()): void {
    uiLastOpenedDb.record(sessionId, at);
  },

  /** The last-opened session, or `null` when the UI has opened none. */
  readLastOpened(): UiLastOpenedRecord | null {
    return uiLastOpenedDb.read();
  },
};
