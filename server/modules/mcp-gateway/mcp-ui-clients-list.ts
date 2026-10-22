/**
 * The MCP gateway's `ui_clients_list` handler (gap-mcp-ui-clients-list).
 *
 * The tool answers "which browsers are online right now, and how is each one
 * set up" — the discovery half of the observe/steer pair. A caller reads this
 * listing, picks a device by name or id, and then asks `ui_visible_context`
 * (what it is showing) or `ui_open_session` (open something in it). Discovery
 * and observation are two questions on purpose: discovery enumerates every
 * device AND its policy in one cheap call, while an observation addresses one
 * device and returns a much larger, per-tab reading. Conflating them would make
 * picking a device cost as much as observing one.
 *
 * Two readings feed the answer, both injected so the gateway keeps no handle on
 * a socket:
 *
 *  - `listUiClients()` is the device ROSTER: who is connected, and each device's
 *    tabs (their ids and when they connected). It is the same listing
 *    `ui_visible_context` resolves a `client` against.
 *  - `requestUiState()` is one round trip that asks every connected tab what it
 *    is showing. Only its per-device STATUS is read here (visibility, focus,
 *    navigation policy, and whether it answered) — never a session, a message
 *    range, or any content. The per-tab detail belongs to `ui_visible_context`.
 *
 * Three rules decide the shape:
 *
 *  - IDENTITY AND STATUS ONLY. A device row carries no session, no message id
 *    range, no approval count — nothing about WHAT a browser is showing, only
 *    who it is and how it is set up. A caller that wants the content reads it
 *    with `ui_visible_context`, which is what keeps this listing small and safe
 *    to call on every turn.
 *  - NAMES MUST BE USABLE AS ADDRESSES. Two browsers on two machines can share
 *    the name their OS reports, so a duplicate name is disambiguated with a
 *    stable short suffix taken from the device's own id — the same suffix every
 *    call, so a name read here still addresses the same device next turn.
 *  - A SILENT BROWSER IS A FACT, NOT A FAILURE. A device none of whose tabs
 *    answered is reported `unresponsive` with every status field null, exactly
 *    as `ui_visible_context` reports a silent tab: a closed lid must not make
 *    the roster unreadable.
 *
 * The deps are injected (`server/index.ts` binds the registry's read port and
 * the process-wide round trip), so this module owns the behaviour and the
 * criterion drives the same two seams over its own fake browsers.
 */

import { z } from 'zod';

import type { UiClientDevice, UiVisibleContextDevice, UiVisibleContextTab } from '@/shared/types.js';
import type { UiStateRequestOptions } from '@/modules/websocket/index.js';

import type { McpToolInputSchema } from './mcp-gateway.audit.js';
import type { McpReadToolDeps, McpReadToolSeam } from './mcp-gateway.read-tools.js';

/**
 * The two readings `ui_clients_list` answers from: the connected devices and the
 * round trip that asks them for their status.
 *
 * Both are injected rather than imported so the gateway keeps no handle on a
 * socket: the round trip is the only thing that touches a connection, and this
 * module only ever sees the identity-grouped result.
 */
export type McpUiClientsListDeps = {
  /**
   * Every connected device, the same roster `ui_visible_context` resolves a
   * `client` against. This is the listing's spine: a device appears here even
   * when none of its tabs answer.
   */
  listUiClients: () => UiClientDevice[];
  /**
   * The UI-state round trip: ask every connected device's tabs what they are
   * showing. Bound to the websocket module's `requestUiState`, the same
   * primitive the other UI-facing tools share.
   */
  requestUiState: (options?: UiStateRequestOptions) => Promise<UiVisibleContextDevice[]>;
};

/** Whether the injected deps carry the round trip, i.e. this tool is wired. */
export function isUiClientsListWired(
  deps: McpReadToolDeps,
): deps is McpReadToolDeps & { uiClientsList: McpUiClientsListDeps } {
  return deps.uiClientsList !== undefined;
}

/** One tab of a device, by identity only: what it is showing is not part of this reading. */
export type UiClientsListTab = {
  /** This tab's own id. */
  tabId: string;
  /** Epoch ms when this tab's identity reached the server. */
  connectedAt: number;
};

/**
 * One device as `ui_clients_list` reports it.
 *
 * `deviceName` is the device's display name, carrying a stable short suffix when
 * another connected device shares the name (see {@link buildUiClientsList}).
 * The status fields (`visibility`, `hasFocus`, `navigationPolicy`) describe the
 * device's most recently focused ANSWERING tab; when no tab answered they are
 * null and `unresponsive` is true.
 */
export type UiClientsListDevice = {
  deviceId: string;
  deviceName: string;
  /** Newest focus moment across this device's answering tabs; null when none answered. */
  lastFocusedAt: number | null;
  /** Whether the device's representative tab was in the foreground; null when none answered. */
  visibility: 'visible' | 'hidden' | null;
  /** Whether the device's representative tab held focus; null when none answered. */
  hasFocus: boolean | null;
  /** The device's navigation policy; null when none of its tabs answered. */
  navigationPolicy: string | null;
  /** True when the device was asked and none of its tabs answered. */
  unresponsive: boolean;
  /** This device's tabs, by identity (oldest connection first), with no per-tab report. */
  tabs: UiClientsListTab[];
};

/** The tool's reading: every connected device, most recently focused first. */
export type UiClientsListPayload = {
  devices: UiClientsListDevice[];
};

/** The shortest device-id prefix a disambiguating suffix starts at. */
const DEVICE_SUFFIX_MIN_LENGTH = 4;

/**
 * A name unique within one listing, for a device whose name another shares.
 *
 * The suffix is the device's OWN id prefix, so the same device always reads the
 * same name: two calls against an unchanged registry return the same listing,
 * and a caller can address a device by the name a previous call showed. The
 * prefix grows only as far as it must — past a prefix another device in the
 * group shares, and past a name already handed out — so it stays short in the
 * ordinary case while remaining unique when two ids happen to start alike.
 */
function suffixedName(device: UiClientDevice, group: readonly UiClientDevice[], used: ReadonlySet<string>): string {
  for (let length = DEVICE_SUFFIX_MIN_LENGTH; length <= device.deviceId.length; length += 1) {
    const prefix = device.deviceId.slice(0, length);
    const sharesPrefix = group.some(
      (other) => other.deviceId !== device.deviceId && other.deviceId.slice(0, length) === prefix,
    );
    const candidate = `${device.deviceName} (${prefix})`;
    if (!sharesPrefix && !used.has(candidate)) {
      return candidate;
    }
  }
  // Unreachable in practice: devices are keyed by id, so the full id is unique
  // within the group by the last iteration. The full id is the stable fallback.
  return `${device.deviceName} (${device.deviceId})`;
}

/**
 * Every device's display name, made unique within one listing.
 *
 * A name only one device carries is left exactly as the browser announced it —
 * no suffix is added where none is needed. When two or more devices share a
 * name, each gets a stable suffix from its own id (see {@link suffixedName}).
 * Unique names are placed first so a duplicate's suffixed name is checked
 * against them rather than silently colliding with one.
 */
function displayNames(devices: readonly UiClientDevice[]): Map<string, string> {
  const groups = new Map<string, UiClientDevice[]>();
  for (const device of devices) {
    const group = groups.get(device.deviceName);
    if (group === undefined) {
      groups.set(device.deviceName, [device]);
    } else {
      group.push(device);
    }
  }

  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const device of devices) {
    if ((groups.get(device.deviceName)?.length ?? 0) <= 1) {
      names.set(device.deviceId, device.deviceName);
      used.add(device.deviceName);
    }
  }
  for (const device of devices) {
    const group = groups.get(device.deviceName) ?? [device];
    if (group.length <= 1) {
      continue;
    }
    const name = suffixedName(device, group, used);
    names.set(device.deviceId, name);
    used.add(name);
  }
  return names;
}

/** The focus moment a tab sorts by, with a never-focused tab sorting last. */
function focusKey(tab: UiVisibleContextTab): number {
  return tab.lastFocusedAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * The status one device reports: its most recently focused ANSWERING tab's
 * visibility, focus and policy, plus whether any tab answered at all.
 *
 * The representative tab is the one the caller would be looking at, so the
 * device's status answers "is the user actually here" directly rather than
 * making the caller fold several tabs together. A device whose tabs all stayed
 * silent has no representative and reads `unresponsive` with null status — never
 * a fabricated "hidden/inactive" reading, which would be indistinguishable from
 * a real one.
 */
function deviceStatus(report: UiVisibleContextDevice | undefined): Pick<
  UiClientsListDevice,
  'lastFocusedAt' | 'visibility' | 'hasFocus' | 'navigationPolicy' | 'unresponsive'
> {
  const answering = (report?.tabs ?? [])
    .filter((tab) => !tab.unresponsive)
    .sort((left, right) => focusKey(right) - focusKey(left));
  const representative = answering[0] ?? null;
  if (representative === null) {
    return { lastFocusedAt: null, visibility: null, hasFocus: null, navigationPolicy: null, unresponsive: true };
  }
  return {
    lastFocusedAt: report?.lastFocusedAt ?? representative.lastFocusedAt,
    visibility: representative.visibility,
    hasFocus: representative.hasFocus,
    navigationPolicy: representative.navigationPolicy,
    unresponsive: false,
  };
}

/**
 * The `ui_clients_list` reading.
 *
 * The roster comes from `listUiClients()` and the status from one round trip;
 * the two are joined by `deviceId`. A device in the roster always appears, even
 * when the round trip reported nothing for it (every tab silent, or a socket
 * gone between the two reads) — it is reported `unresponsive`, which is the
 * honest answer and keeps the roster complete.
 *
 * An empty roster is a legitimate reading, not an error: "no browser is
 * connected" is exactly what the caller asked for, and the round trip resolves
 * at once when there is nobody to ask.
 *
 * Consumers: {@link registerMcpUiClientsListTool}, and the criterion, which
 * calls it over fake connections.
 */
export async function buildUiClientsList(deps: McpUiClientsListDeps): Promise<UiClientsListPayload> {
  const roster = deps.listUiClients();
  const reported = await deps.requestUiState();
  const reportsByDevice = new Map(reported.map((device) => [device.deviceId, device]));
  const names = displayNames(roster);

  const devices: UiClientsListDevice[] = roster.map((device) => ({
    deviceId: device.deviceId,
    deviceName: names.get(device.deviceId) ?? device.deviceName,
    ...deviceStatus(reportsByDevice.get(device.deviceId)),
    tabs: device.tabs.map((tab) => ({ tabId: tab.tabId, connectedAt: tab.connectedAt })),
  }));

  // Newest focus first, so "which device is the user actually looking at" is the
  // first row rather than a fact the caller has to derive. A device no tab
  // answered has no focus moment and sorts last.
  devices.sort(
    (left, right) => (right.lastFocusedAt ?? Number.NEGATIVE_INFINITY) - (left.lastFocusedAt ?? Number.NEGATIVE_INFINITY),
  );

  return { devices };
}

/**
 * One tool's metadata as `registerMcpReadTools` hands it down: the name,
 * description and scope read from the stage-3 table, plus the two schemas read
 * from the body table. No handler — this module owns the behaviour.
 */
export type McpUiClientsListRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  /** A raw shape, or a built schema carrying a constraint (the shared body-table type). */
  inputSchema: McpToolInputSchema;
  outputSchema: z.ZodRawShape;
};

/**
 * Registers `ui_clients_list` through the audited read seam.
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
export function registerMcpUiClientsListTool(
  seam: McpReadToolSeam,
  deps: McpUiClientsListDeps,
  registration: McpUiClientsListRegistration,
): void {
  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: () => buildUiClientsList(deps),
  });
}
