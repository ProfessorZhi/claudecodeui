/**
 * The MCP gateway's `ui_visible_context` handler (gap-mcp-ui-visible-context).
 *
 * The tool answers "what is the user looking at, in which window, right now" by
 * ASKING the browsers rather than by reading a store: one `ui.state_request`
 * broadcast, the answers collected by the websocket module's round trip, and the
 * result grouped by device. Nothing is cached and nothing is reported on a
 * schedule, so the answer is what the browsers said during this call — and a tab
 * that did not answer is reported as `unresponsive` rather than dropped, because
 * "the laptop lid is closed" is part of the picture.
 *
 * Two rules decide the shape of what comes back:
 *
 *  - IDENTIFIERS AND RANGES ONLY. The round trip already projects each frame down
 *    to a fixed whitelist, and this tool returns that projection unchanged — it
 *    adds no field and reads no body. A caller that wants message text asks
 *    `session_read mode=around` with an id from here, which is the whole point of
 *    reporting a range instead of the messages in it.
 *  - LOCATING A DEVICE IS THE SAME QUESTION AS LOCATING A SESSION. `client`
 *    follows AC-246's resolution rules — an exact `deviceId` wins, otherwise a
 *    trimmed case-insensitive substring must hit exactly one device — and reuses
 *    the same two refusals: `TARGET_AMBIGUOUS` with the candidates when several
 *    devices match, and, when none does, the existing `INVALID_ARGUMENT` envelope
 *    carrying the query that matched nothing. No second not-found literal is
 *    minted for devices: this vocabulary keeps one code per category.
 *
 * The deps are injected (`server/index.ts` binds the registry's read port and the
 * process-wide round trip), so this module owns the behaviour and the criterion
 * drives the same two seams over its own fake browsers.
 */

import { z } from 'zod';

import type { UiClientDevice, UiNavigationRecord, UiVisibleContextDevice } from '@/shared/types.js';
import type { UiStateRequestOptions } from '@/modules/websocket/index.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';

/**
 * The two readings `ui_visible_context` answers from: which devices are
 * connected (what `client` is resolved against) and the round trip that asks
 * them.
 *
 * Both are injected rather than imported so the gateway keeps no handle on a
 * socket: the round trip is the only thing that touches a connection, and this
 * module only ever sees the identity-grouped result.
 */
export type McpUiVisibleContextDeps = {
  /**
   * Every connected device, the same listing `ui_clients_list` publishes.
   * Resolving `client` against it is what makes a name a legitimate way to
   * address a device.
   */
  listUiClients: () => UiClientDevice[];
  /**
   * The UI-state round trip: ask the (optionally one) device's tabs what they
   * are showing. Bound to the websocket module's `requestUiState`, which is the
   * same primitive the other UI-facing tools share.
   */
  requestUiState: (options?: UiStateRequestOptions) => Promise<UiVisibleContextDevice[]>;
  /**
   * The retained navigation records, newest first, optionally narrowed to one
   * `navigationId` (gap-mcp-ui-open-session). Bound to the websocket module's
   * `listUiNavigations`. Optional: a mount without the navigation service still
   * answers `navigations: []`, because "no navigation has been asked for" is the
   * truthful reading of a process that cannot perform one.
   */
  listNavigations?: (navigationId?: string) => UiNavigationRecord[];
};

/** Whether the injected deps carry the round trip, i.e. this tool is wired. */
export function isUiVisibleContextWired(
  deps: McpReadToolDeps,
): deps is McpReadToolDeps & { uiVisibleContext: McpUiVisibleContextDeps } {
  return deps.uiVisibleContext !== undefined;
}

/** The tool's arguments: an optional device reference and an optional navigation id. */
export type McpUiVisibleContextInput = {
  client?: string;
  /**
   * Narrow the `navigations[]` reading to ONE navigation. Absent means every
   * retained navigation is reported, which is how a caller asks "what did the
   * browsers do with what I asked for".
   */
  navigationId?: string;
};

/** The tool's reading: every addressed device, most recently focused first, plus the navigation log. */
export type UiVisibleContextPayload = {
  devices: UiVisibleContextDevice[];
  /**
   * The retained `ui_open_session` records, newest first. Empty when nothing has
   * been asked for (or when no navigation service is wired) — never omitted, so a
   * caller can read "no navigations" without a second call.
   */
  navigations: UiNavigationRecord[];
};

/** Whether a device matches one query: an exact `deviceId`, or the substring in either of its names. */
function deviceMatches(device: UiClientDevice, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    device.deviceId.toLowerCase().includes(needle) || device.deviceName.toLowerCase().includes(needle)
  );
}

/**
 * Resolves one `client` reference to exactly one connected device.
 *
 * The precedence is AC-246's, applied to devices instead of sessions: an exact
 * `deviceId` (verbatim, case-sensitive) always wins, so a caller that read an id
 * off a previous listing addresses that device even if another device's name
 * happens to contain it; otherwise the trimmed, case-insensitive query must
 * match exactly one device's id or name. Several matches are refused with the
 * candidates rather than guessed, and no match is refused with the query —
 * picking either one for the caller would make `ui_visible_context` report a
 * device the caller did not name.
 */
function resolveDevice(devices: readonly UiClientDevice[], client: string): UiClientDevice {
  const exact = devices.find((device) => device.deviceId === client);
  if (exact !== undefined) {
    return exact;
  }

  const query = client.trim();
  const matches = devices.filter((device) => deviceMatches(device, query));
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return first;
  }

  if (matches.length > 1) {
    throw new McpToolError(
      MCP_ERROR_CODES.TARGET_AMBIGUOUS,
      `"${client}" matches ${matches.length} connected devices; name one of them.`,
      false,
      {
        client,
        kind: 'device',
        candidates: matches.map((device) => ({
          id: device.deviceId,
          name: device.deviceName,
          tabs: device.tabs.length,
        })),
      },
    );
  }

  throw new McpToolError(
    MCP_ERROR_CODES.INVALID_ARGUMENT,
    `No connected device matches "${client}".`,
    false,
    { client, kind: 'device', candidates: [] },
  );
}

/**
 * The `ui_visible_context` reading.
 *
 * Without `client`, every connected device is asked. With one, the reference is
 * resolved first and only that device's tabs are asked — so a caller naming a
 * device is not merely filtering the answer, it is asking a narrower question
 * (the other browsers are never written to at all).
 *
 * An empty device list is a legitimate answer, not a failure: "no browser is
 * connected" is exactly what the caller asked for, and an error would make the
 * ordinary state of a headless server look like a broken tool.
 *
 * Consumers: {@link registerMcpUiVisibleContextTool}, and the criterion, which
 * calls it over fake connections.
 */
export async function buildUiVisibleContext(
  deps: McpUiVisibleContextDeps,
  input: McpUiVisibleContextInput,
): Promise<UiVisibleContextPayload> {
  const navigations = deps.listNavigations?.(input.navigationId) ?? [];
  const client = typeof input.client === 'string' ? input.client : null;
  if (client === null) {
    return { devices: await deps.requestUiState(), navigations };
  }

  const device = resolveDevice(deps.listUiClients(), client);
  return { devices: await deps.requestUiState({ deviceId: device.deviceId }), navigations };
}

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas read
 * from the body table. No handler — this module owns the behaviour.
 */
export type McpUiVisibleContextRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Registers `ui_visible_context` through the audited read seam.
 *
 * The name, description, scope and both schemas come from the caller (the
 * stage-3 table plus its body-table entry), so this module owns the BEHAVIOUR
 * and `mcp-gateway.read-tools.js` remains the one statement of the name set.
 * `registerMcpReadTools` calls this only when the deps carry the round trip; an
 * unwired mount keeps the body-table's named refusal instead.
 *
 * Consumers: `mcp-gateway.read-tools.js`'s `registerMcpReadTools` (the single
 * call site).
 */
export function registerMcpUiVisibleContextTool(
  seam: McpReadToolSeam,
  deps: McpUiVisibleContextDeps,
  registration: McpUiVisibleContextRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: (args) => buildUiVisibleContext(deps, args as McpUiVisibleContextInput),
  });
}
