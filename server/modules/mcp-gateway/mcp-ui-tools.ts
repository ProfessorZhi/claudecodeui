/**
 * The MCP gateway's `ui_last_opened_session` handler (gap-mcp-ui-last-opened-session).
 *
 * The tool answers "which session did the user last open in the browser UI" —
 * not "which session changed most recently". Those are different questions, and
 * conflating them is exactly what this tool exists to avoid: a background run or
 * a scheduled message moves a session's `lastActivity` without the user ever
 * looking at it. The reading therefore comes from ONE stored pointer written by
 * the browser's own session-read routes, never from `lastActivity`. When nothing
 * has been opened there is no answer to invent, so the tool throws the existing
 * NOT_FOUND-class code (`SESSION_NOT_FOUND`) rather than falling back.
 *
 * The session summary it returns is `session_get`'s reading — the same
 * {@link buildSessionDetail} call, so the two tools cannot drift — with one
 * field added: `openedAt`, rendered as the relative + ISO pair every other time
 * field on this surface carries.
 *
 * Only a reader crosses this boundary. The WRITE belongs to the providers
 * module (the browser session-read routes); the gateway is handed the reader at
 * composition time, which is what makes "an MCP token cannot move the pointer"
 * a property of the wiring rather than of a check inside the handler.
 *
 * Only TYPES are imported back from `mcp-gateway.read-tools.js` except for
 * {@link buildSessionDetail} and {@link formatMcpTime}, which are hoisted
 * declarations used at call time — the runtime cycle (read-tools imports this
 * module's `registerMcpUiTools`) is the same shape `mcp-run-get.js` already has
 * with `formatMcpTime`.
 */

import { z } from 'zod';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import { buildSessionDetail, formatMcpTime } from './mcp-gateway.read-tools.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';

// --------------------------- the injected pointer ---------------------------

/** The one row the browser writes: which session is open, and when it opened. */
export type McpUiLastOpenedReading = {
  sessionId: string;
  openedAt: number;
};

/**
 * The read side of the browser's last-opened-session pointer.
 *
 * Production (`server/index.ts`) binds `read` to
 * `uiLastOpenedSessionService.readLastOpened`; the criterion binds the same real
 * store over a temp database and drives the write through the real provider
 * route, so the value the tool answers with is one the browser path actually
 * stored.
 */
export type McpUiLastOpenedStore = {
  /** The last-opened session, or `null` when the UI has opened none. */
  read(): McpUiLastOpenedReading | null;
};

/**
 * The deps `ui_last_opened_session` needs: the read tools' injected services
 * (`session_get`'s reading is built from them) plus the pointer store. A
 * `McpReadToolDeps` that carries `uiLastOpened` IS one of these.
 */
export type McpUiLastOpenedDeps = McpReadToolDeps & { uiLastOpened: McpUiLastOpenedStore };

/** Whether the injected deps carry the pointer reader, i.e. this tool is wired. */
export function isUiLastOpenedWired(deps: McpReadToolDeps): deps is McpUiLastOpenedDeps {
  return deps.uiLastOpened !== undefined;
}

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas read
 * from the body table. No handler — this module owns the behaviour.
 */
export type McpUiToolRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

// --------------------------- the reading ---------------------------

/**
 * The `ui_last_opened_session` reading: the last-opened session's detail plus
 * when it was opened.
 *
 * A missing pointer is a NOT_FOUND, not an empty success: "the user has no
 * session open" has no session to describe, and a caller that asked for one
 * session's detail must be able to tell "none" from "here is a blank one".
 * `SESSION_NOT_FOUND` is the code the rest of this surface already uses for
 * "that session id does not resolve" — no second not-found literal is minted
 * for this tool. The pointer outliving the session (a session deleted since it
 * was opened) reads as the same NOT_FOUND, because the id no longer resolves to
 * a session row.
 *
 * `lastActivity` is deliberately absent from the output and never consulted:
 * the returned `session` carries whatever `session_get` carries, and the
 * ordering fact this tool reports is `openedAt`.
 *
 * Consumers: {@link registerMcpUiTools}, and the criterion, which calls it
 * through a real `/mcp` mount.
 */
export function buildUiLastOpened(deps: McpUiLastOpenedDeps): unknown {
  const last = deps.uiLastOpened.read();
  if (last === null) {
    throw new McpToolError(
      MCP_ERROR_CODES.SESSION_NOT_FOUND,
      'No session has been opened in the browser UI yet.',
    );
  }

  const detail = buildSessionDetail(deps, last.sessionId);
  return { ...detail, openedAt: formatMcpTime(last.openedAt, deps.now) };
}

/**
 * Registers `ui_last_opened_session` through the audited read seam.
 *
 * The name, description, scope and both schemas come from the caller (the
 * stage-3 table plus its body-table entry), so this module owns the BEHAVIOUR
 * and `mcp-gateway.read-tools.js` remains the one statement of the name set.
 * `registerMcpReadTools` calls this only when the deps carry the pointer reader;
 * an unwired mount keeps the body-table's named refusal instead.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site).
 */
export function registerMcpUiTools(
  seam: McpReadToolSeam,
  deps: McpUiLastOpenedDeps,
  registration: McpUiToolRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: () => buildUiLastOpened(deps),
  });
}
