/**
 * The MCP gateway's `ui_open_session` handler (gap-mcp-ui-open-session).
 *
 * This is the first tool that changes what the USER'S SCREEN shows, and it is
 * built to keep that fact honest rather than convenient:
 *
 *  - IT NAMES ONE DEVICE. `session` follows AC-246's existing target rules (an id
 *    or a unique title substring), and `client` addresses ONE connected browser —
 *    an exact device id, or a unique substring of the device's id or name. The
 *    instruction is written to that device's tabs and to no other, so a caller
 *    that meant the phone cannot yank the desktop. With exactly one device online
 *    `client` may be omitted; with several it is REQUIRED (the refusal lists the
 *    candidates), and with none the tool reports `NO_CLIENT`.
 *  - IT DOES NOT WAIT FOR THE USER. The navigation service resolves with the
 *    DELIVERY reading — the browser answered `applied` / `shown` / `declined`, or
 *    nothing arrived inside ~1.5s — and the tool returns at that moment. An
 *    `ask`-policy device therefore answers `pending_user`, and its human decides
 *    later; the final verdict is read back out of `ui_visible_context`'s
 *    `navigations[]`, not from this call.
 *  - IT IS RATE LIMITED PER TOKEN. A token may ask {@link
 *    MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE} times a minute; the next attempt
 *    is refused `RATE_LIMITED`. The limiter is an INJECTED dep rather than a
 *    closure because the MCP server is built per request — a limiter owned by the
 *    builder would start empty on every call and never throttle anything.
 *
 * The tool never raises `SELF_TARGET`: opening the caller's own session neither
 * interrupts nor queues a run, so the self-referential guard (AC-252) is
 * deliberately not applied here.
 *
 * What comes back is the RECORD the navigation service minted, projected to the
 * fields a caller acts on: the `navigationId` it can look the record up by, the
 * resolved device, and the delivery `status`.
 */

import { z } from 'zod';

import type { UiClientDevice, UiNavigationPosition, UiNavigationRecord } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import { MCP_TOOL_NOT_IMPLEMENTED_CODE } from './mcp-gateway.read-tools.js';
import type {
  McpWriteToolDeps,
  McpWriteToolRegistration,
  McpWriteToolSeam,
} from './mcp-gateway.write-tools.js';
// The gateway's ONE principal-name resolution, shared with the write
// notifications so the name on the bar and the name an operator sees cannot drift.
import { resolveClientName } from './mcp-write-notification.js';

// --------------------------- the rate limit ---------------------------

/**
 * How many times ONE token may call `ui_open_session` inside
 * {@link UI_OPEN_SESSION_RATE_WINDOW_MS}. Fixed in code on purpose: the
 * permission the tool needs is the scope, and the rate limit is a safety rail
 * against a runaway agent, not a per-user setting.
 */
export const MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE = 6;

/** The window the limit is measured over: one minute. */
export const UI_OPEN_SESSION_RATE_WINDOW_MS = 60_000;

/** The per-token throttle the handler consults before it does anything else. */
export type UiOpenSessionRateLimiter = {
  /**
   * True when this call is allowed. False when the key has already made the
   * limit's worth of calls inside the window — the refused call is NOT counted,
   * so a caller that keeps hammering does not extend its own penalty.
   */
  allow(key: string): boolean;
};

/** The options a criterion may override to drive the limiter without waiting a minute. */
export type UiOpenSessionRateLimiterOptions = {
  /** Calls allowed per window; defaults to {@link MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE}. */
  limit?: number;
  /** The window length; defaults to {@link UI_OPEN_SESSION_RATE_WINDOW_MS}. */
  windowMs?: number;
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Builds a per-key sliding-window limiter.
 *
 * Production builds ONE of these per server run (`server/index.ts`) and hands it
 * to the tool's deps, because the MCP server itself is built per request: the
 * throttle only exists if its state outlives a single call.
 */
export function createUiOpenSessionRateLimiter(
  options: UiOpenSessionRateLimiterOptions = {},
): UiOpenSessionRateLimiter {
  const limit = options.limit ?? MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE;
  const windowMs = options.windowMs ?? UI_OPEN_SESSION_RATE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  /** One key's recent call timestamps, oldest first. */
  const hits = new Map<string, number[]>();

  return {
    allow(key) {
      const moment = now();
      const recent = (hits.get(key) ?? []).filter((at) => at > moment - windowMs);
      if (recent.length >= limit) {
        // The refused call is not recorded: the window is a reading of what was
        // allowed, so a caller in penalty cannot push its own expiry out.
        hits.set(key, recent);
        return false;
      }
      recent.push(moment);
      hits.set(key, recent);
      return true;
    },
  };
}

// --------------------------- the tool's schemas ---------------------------

/** Where in the session to land: the newest message (default) or one by id. */
export const UI_OPEN_SESSION_AT_SCHEMA = z.union([
  z.object({ latest: z.literal(true) }),
  z.object({ messageId: z.string() }),
]);

/**
 * The tool's arguments. `session` and `client` are resolved before the body runs
 * (the AC-246 target gate rewrites `session`; this module resolves `client`).
 * `at` is optional and defaults to `{ latest: true }`.
 */
export const UI_OPEN_SESSION_INPUT_SCHEMA = {
  client: z.string().optional(),
  session: z.string(),
  at: UI_OPEN_SESSION_AT_SCHEMA.optional(),
};

/** The tool's reading: which navigation was asked for, in which browser, and how it landed. */
export const UI_OPEN_SESSION_OUTPUT_SCHEMA = {
  navigationId: z.string(),
  device: z.object({ deviceId: z.string(), deviceName: z.string() }),
  sessionId: z.string(),
  status: z.enum([
    'applied',
    'declined',
    'pending_user',
    'unresponsive',
    'ignored',
    'superseded',
    'expired',
  ]),
  tabId: z.string().nullable(),
};

/** The tool's arguments, read off the validated `args`. */
export type McpUiOpenSessionInput = {
  client?: string;
  session: string;
  at?: UiNavigationPosition;
};

/** The tool's reading. */
export type UiOpenSessionPayload = {
  navigationId: string;
  device: { deviceId: string; deviceName: string };
  sessionId: string;
  status: UiNavigationRecord['status'];
  tabId: string | null;
};

// --------------------------- injected services ---------------------------

/**
 * What the tool answers from: the connected-device roster, the navigation
 * service, and the per-token limiter.
 *
 * All injected so `server/index.ts` can bind the process-wide singletons while a
 * criterion drives its own fakes — and so the limiter's state is owned by the
 * composition root rather than by a per-request closure.
 */
export type McpUiOpenSessionDeps = {
  /** Every connected device, the same listing `ui_clients_list` publishes. */
  listUiClients: () => UiClientDevice[];
  /** The navigation push: write a `ui.navigate` and resolve with its delivery reading. */
  navigate: (request: {
    deviceId: string;
    deviceName: string;
    sessionId: string;
    at: UiNavigationPosition;
    requestedBy: string | null;
  }) => Promise<UiNavigationRecord>;
  /**
   * The throttle, consulted once per call BEFORE device resolution. Optional: a
   * mount without it performs no rate limiting (the criterion for the other legs
   * supplies one only where it drives the limit).
   */
  rateLimiter?: UiOpenSessionRateLimiter;
  /**
   * Resolves the asking client's human-readable name for the confirmation bar
   * and the navigation record. Optional: it defaults to the gateway's ONE
   * principal resolver ({@link resolveClientName}, the same function the write
   * notifications name their caller with), so a mount that does not care about
   * the label is still wired to the real resolution rather than to a second copy.
   */
  resolveClientName?: (principal: McpPrincipal) => string;
};

/** Whether the injected deps carry this tool's services, i.e. it is wired. */
export function isUiOpenSessionWired(
  deps: McpWriteToolDeps,
): deps is McpWriteToolDeps & { uiOpenSession: McpUiOpenSessionDeps } {
  return deps.uiOpenSession !== undefined;
}

// --------------------------- device resolution ---------------------------

/** Whether a device matches one query: an exact `deviceId`, or the substring in either of its names. */
function deviceMatches(device: UiClientDevice, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    device.deviceId.toLowerCase().includes(needle) || device.deviceName.toLowerCase().includes(needle)
  );
}

/** The candidate shape a refusal carries so the caller can retry with a real device. */
function candidatesOf(devices: readonly UiClientDevice[]): { id: string; name: string; tabs: number }[] {
  return devices.map((device) => ({
    id: device.deviceId,
    name: device.deviceName,
    tabs: device.tabs.length,
  }));
}

/**
 * Resolves the ONE device to open the session in.
 *
 * The rules are AC-246's device reading, plus the omitted-`client` arm this tool
 * adds:
 *
 *  - omitted, exactly one device connected: that device is chosen (there is no
 *    ambiguity to refuse) — a single phone must not require its own id echoed
 *    back;
 *  - omitted, several connected: refused `CLIENT_REQUIRED` with the candidates,
 *    because guessing would open the session on a screen the caller did not
 *    choose;
 *  - omitted, none connected: refused `NO_CLIENT`;
 *  - named: an exact `deviceId` wins; otherwise the trimmed, case-insensitive
 *    query must match exactly one device's id or name. Several matches are
 *    refused `TARGET_AMBIGUOUS` with the candidates, and no match is refused
 *    `CLIENT_NOT_FOUND` carrying the query.
 *
 * `CLIENT_NOT_FOUND` is this tool's own not-found code for devices rather than
 * `ui_visible_context`'s `INVALID_ARGUMENT`: a caller that named a browser which
 * is not connected needs to tell "no such browser" from "your arguments were
 * malformed", and this is the tool where a wrong device actually moves someone's
 * screen.
 */
export function resolveUiOpenSessionDevice(
  devices: readonly UiClientDevice[],
  client: string | undefined,
): UiClientDevice {
  const named = typeof client === 'string' ? client.trim() : '';
  if (named.length === 0) {
    const only = devices[0];
    if (devices.length === 0) {
      throw new McpToolError(
        MCP_ERROR_CODES.NO_CLIENT,
        'No browser is connected, so there is no screen to open the session on.',
        true,
        { kind: 'device', candidates: [] },
      );
    }
    if (devices.length === 1 && only !== undefined) {
      return only;
    }
    throw new McpToolError(
      MCP_ERROR_CODES.CLIENT_REQUIRED,
      `${devices.length} browsers are connected; name the one to open the session in.`,
      false,
      { kind: 'device', candidates: candidatesOf(devices) },
    );
  }

  const exact = devices.find((device) => device.deviceId === named);
  if (exact !== undefined) {
    return exact;
  }

  const matches = devices.filter((device) => deviceMatches(device, named));
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) {
    return first;
  }

  if (matches.length > 1) {
    throw new McpToolError(
      MCP_ERROR_CODES.TARGET_AMBIGUOUS,
      `"${named}" matches ${matches.length} connected devices; name one of them.`,
      false,
      { client: named, kind: 'device', candidates: candidatesOf(matches) },
    );
  }

  throw new McpToolError(
    MCP_ERROR_CODES.CLIENT_NOT_FOUND,
    `No connected browser matches "${named}".`,
    false,
    { client: named, kind: 'device', candidates: candidatesOf(devices) },
  );
}

// --------------------------- input ---------------------------

/** Reads the landing position off validated args, defaulting to the newest message. */
function readPosition(value: unknown): UiNavigationPosition {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.latest === true) {
      return { latest: true };
    }
    if (typeof record.messageId === 'string' && record.messageId.length > 0) {
      return { messageId: record.messageId };
    }
  }
  return { latest: true };
}

/**
 * Reads the tool's arguments off the validated `args`.
 *
 * The audited wrapper has already enforced {@link UI_OPEN_SESSION_INPUT_SCHEMA}
 * before this runs, so a missing `session` is impossible by the time the handler
 * is entered; the default below is the same "newest message" the schema's optional
 * `at` documents.
 */
export function readUiOpenSessionInput(args: Record<string, unknown>): McpUiOpenSessionInput {
  const session = typeof args.session === 'string' ? args.session : '';
  const client = typeof args.client === 'string' ? args.client : undefined;
  return { session, client, at: readPosition(args.at) };
}

// --------------------------- the handler ---------------------------

/**
 * The `ui_open_session` reading.
 *
 * Order matters: the throttle is consulted FIRST (a refused call must not have
 * resolved or touched a device), then the device is resolved, and only then is
 * the navigation written. The returned `status` is the DELIVERY reading — this
 * function never awaits a `ui.navigate_result`.
 *
 * Consumers: {@link registerMcpUiOpenSessionTool}, and the criterion, which calls
 * it over a fake navigation service.
 */
export async function buildUiOpenSession(
  deps: McpUiOpenSessionDeps,
  input: McpUiOpenSessionInput,
  principal: McpPrincipal,
): Promise<UiOpenSessionPayload> {
  const limiter = deps.rateLimiter;
  // Keyed by TOKEN, not by device or session: the limit is a property of the
  // credential that was handed out, which is also the unit a human revokes.
  if (limiter !== undefined && !limiter.allow(String(principal.tokenId))) {
    throw new McpToolError(
      MCP_ERROR_CODES.RATE_LIMITED,
      `This token may open a session at most ${MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE} times a minute.`,
      true,
      {
        limit: MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE,
        windowMs: UI_OPEN_SESSION_RATE_WINDOW_MS,
      },
    );
  }

  const resolveRequester = deps.resolveClientName ?? resolveClientName;
  const device = resolveUiOpenSessionDevice(deps.listUiClients(), input.client);
  const record = await deps.navigate({
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    sessionId: input.session,
    at: input.at ?? { latest: true },
    // The NAME the user reads on the bar, never the raw client id: a personal
    // access token has no client at all, so `principal.clientId` alone left the
    // prompt blank and the "ask" policy asked about nobody.
    requestedBy: resolveRequester(principal),
  });

  return {
    navigationId: record.navigationId,
    device: { deviceId: record.deviceId, deviceName: record.deviceName },
    sessionId: record.sessionId,
    status: record.status,
    tabId: record.tabId,
  };
}

// --------------------------- registration ---------------------------

/**
 * One tool's metadata as `registerMcpWriteTools` hands it down.
 *
 * The name, description and scope come from the caller — the write-tools module
 * is the one statement of the name set, and the scope is read from AC-243's
 * vocabulary there rather than re-typed here.
 */
export type McpUiOpenSessionRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
};

/**
 * The refusal a mount without the injected deps answers with.
 *
 * `ui_open_session` is registered even when unwired — the annotation and error
 * records are TOTAL over the tool-name union, so the name must exist on
 * `tools/list` — and its body names the task that delivers the behaviour, exactly
 * like the stage-4 placeholders.
 */
function notImplemented(name: string): never {
  throw new McpToolError(
    MCP_TOOL_NOT_IMPLEMENTED_CODE,
    `${name} is registered but its behaviour is delivered by gap-mcp-ui-open-session.`,
    false,
    { tool: name, owner: 'gap-mcp-ui-open-session' },
  );
}

/**
 * Registers `ui_open_session` through the audited write seam.
 *
 * The handler is NOT wrapped by the self-target guard: opening the caller's own
 * session neither interrupts nor queues a run, so `SELF_TARGET` must not fire
 * (the task's AC says so explicitly). Consumers: `mcp-gateway.write-tools.js`'s
 * `registerMcpWriteTools` (the single call site).
 */
export function registerMcpUiOpenSessionTool(
  seam: McpWriteToolSeam,
  deps: McpUiOpenSessionDeps | null,
  registration: McpUiOpenSessionRegistration,
): void {
  const body: McpWriteToolRegistration['handler'] =
    deps === null
      ? () => notImplemented(registration.name)
      : (args, ctx) => buildUiOpenSession(deps, readUiOpenSessionInput(args), ctx.principal);

  seam({
    name: registration.name,
    description: registration.description,
    requiredScope: registration.requiredScope,
    inputSchema: registration.inputSchema,
    outputSchema: registration.outputSchema,
    handler: body,
  });
}
