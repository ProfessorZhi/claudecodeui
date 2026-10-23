/**
 * MCP write-call notifications (AC-303).
 *
 * An EXTERNAL MCP client that successfully calls one of the gateway's WRITE
 * tools (`tools/list` `annotations.readOnlyHint === false`) should push the
 * token's owner a notification — so an unattended client driving the gateway
 * from outside the UI is not silent. The whole feature is deliberately
 * low-noise and non-interrupting:
 *
 *  - it fires on SUCCESS only. The seam lives on the audit wrapper's `ok`
 *    branch (see `mcp-gateway.audit.ts`), so a denied or erroring call never
 *    notifies and the tool's own result is untouched;
 *  - the write/read split is NOT re-decided here. {@link readMcpToolAnnotations}
 *    — the one table a `tools/list` hint is written down in — is the single
 *    classifier: a tool whose `readOnlyHint !== false` returns before the sink
 *    is reached, so a read call can never notify even though the same seam is
 *    handed to every registration;
 *  - a caller's writes MERGE. The first {@link McpWriteNotifierDeps.threshold}
 *    calls inside a {@link McpWriteNotifierDeps.windowMs} window each notify
 *    once (`count: 1`); the call that crosses the threshold notifies ONCE with
 *    the cumulative `count`, and every further call in the same window is
 *    silent. The window resets on expiry (or when a different caller takes
 *    over), so a client that keeps writing is summarised rather than fanned out;
 *  - the message is NEVER carried whole. `messagePreview` is the message's first
 *    40 characters and nothing else — the full text cannot be reconstructed from
 *    any field of the payload.
 *
 * The merge state lives in the closure {@link createMcpWriteNotifier} returns,
 * never at module scope: two mounts in one process (the criteria do exactly
 * this) must not share a window, and a re-mount must not inherit a stale one.
 *
 * Consumers: `mcp-gateway.audit.ts` (whose `ok` branch calls
 * {@link McpWriteNotification.notify} when a seam was threaded in),
 * `mcp-gateway.transport.ts` (which threads the production seam from
 * {@link McpGatewayDeps.writeNotifications}), `server/index.ts` (which builds
 * the production assembly with {@link createMcpWriteNotification}), and this
 * module's criterion, which drives every export directly.
 */

import { accessTokensDb, oauthClientsDb, sessionsDb } from '@/modules/database/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/index.js';

import type { McpPrincipal } from './mcp-gateway.auth.js';
import { readMcpToolAnnotations } from './mcp-tool-annotations.js';

// --------------------------- the payload and its consumers ---------------------------

/** How many characters of a write call's free-text message survive into a payload. */
const PREVIEW_LENGTH = 40;

/** The default merge window, in milliseconds: one minute. */
const DEFAULT_WINDOW_MS = 60_000;

/** The default number of individual notifications before a window collapses to one summary. */
const DEFAULT_THRESHOLD = 5;

/**
 * The one shape a write notification carries.
 *
 * `count` is `1` for an individual notification and the cumulative number of
 * writes for the summary that closes a window (see the module header). The five
 * fields are the whole payload by design: no token string, no auth code and no
 * full message ever reaches it.
 */
export type McpWriteNotificationPayload = {
  /** The calling client's human-readable name. */
  clientName: string;
  /** The write tool that was called. */
  tool: string;
  /** The target session's display name, or null when the call names no session. */
  sessionTitle: string | null;
  /** The first {@link PREVIEW_LENGTH} characters of a `message` argument, or null. */
  messagePreview: string | null;
  /** `1` for an individual notification, the cumulative write count for a summary. */
  count: number;
};

/**
 * Where a notification is delivered. Async (a Promise) or sync (void); a
 * REJECTION/THROW is the caller's to swallow — the audit seam wraps every call
 * so a failing notifier can never change a tool call's result.
 */
export type McpWriteNotifier = (payload: McpWriteNotificationPayload) => void | Promise<void>;

/** One successful write call, as handed to {@link McpWriteNotification.notify}. */
export type McpWriteNotificationInput = {
  /** The authenticated caller whose token made the call. */
  principal: McpPrincipal;
  /** The write tool's name. */
  tool: string;
  /** The call's arguments, read only for the session id and the message preview. */
  args: Record<string, unknown>;
};

/**
 * The seam the audit wrapper holds: a synchronous `notify` it can call on the
 * `ok` branch and wrap in a try/catch.
 */
export type McpWriteNotification = {
  notify(input: McpWriteNotificationInput): void;
};

/** The seams {@link createMcpWriteNotifier} reads. `sink` is the one required member. */
export type McpWriteNotifierDeps = {
  /** Where a notification goes. Never invoked for a read-only tool. */
  sink: McpWriteNotifier;
  /** Clock, default `Date.now`. Injected so the criterion advances a fake one. */
  now?: () => number;
  /** The merge window, in milliseconds. */
  windowMs: number;
  /** How many individual notifications fit in one window before it collapses to a summary. */
  threshold: number;
  /** The calling client's display name. */
  resolveClientName(principal: McpPrincipal): string;
  /** The target session's display name, or null when there is none. */
  resolveSessionTitle(sessionId: string | null): string | null;
};

// --------------------------- shared readings ---------------------------

/** The session id an argument object names, whichever key it uses, or null. */
function sessionIdOf(args: Record<string, unknown>): string | null {
  if (typeof args.session === 'string' && args.session.length > 0) {
    return args.session;
  }
  if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
    return args.sessionId;
  }
  return null;
}

/** The first {@link PREVIEW_LENGTH} characters of a `message` argument, or null. */
function messagePreviewOf(args: Record<string, unknown>): string | null {
  return typeof args.message === 'string' ? args.message.slice(0, PREVIEW_LENGTH) : null;
}

/**
 * The key a caller's merge window belongs to.
 *
 * The token id is preferred because it is the tightest identity the gateway
 * holds; a caller with no token id (an OAuth-only principal) falls back to the
 * client id, and a caller with neither shares the one `anonymous` window rather
 * than being dropped.
 */
function callerKey(principal: McpPrincipal): string {
  if (typeof principal.tokenId === 'number') {
    return `token:${principal.tokenId}`;
  }
  if (typeof principal.clientId === 'string') {
    return `client:${principal.clientId}`;
  }
  return 'anonymous';
}

/**
 * Delivers one payload, letting a SYNCHRONOUS throw propagate (the audit seam's
 * try/catch owns it, which is what mutation (iii) reads) while attaching a
 * rejection guard so an async sink's failure cannot surface as an unhandled
 * rejection.
 */
function emit(sink: McpWriteNotifier, payload: McpWriteNotificationPayload): void {
  const result = sink(payload);
  if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
    void (result as Promise<void>).then(undefined, () => undefined);
  }
}

// --------------------------- the notifier ---------------------------

/**
 * Builds the write notifier: the read-only early-return, the per-caller merge
 * window, and the payload construction, over injected seams.
 *
 * Consumers: {@link createMcpWriteNotification} (the production assembly) and
 * this module's criterion, which injects a recording sink and a fake clock.
 */
export function createMcpWriteNotifier(deps: McpWriteNotifierDeps): McpWriteNotification {
  const now = deps.now ?? (() => Date.now());
  let window: { key: string; start: number; count: number; summarySent: boolean } | null = null;

  return {
    notify(input) {
      // The one classifier: a tool whose declaration is not a write never
      // notifies, whatever the caller did. An unknown name throws here — a
      // registration the transport handed this seam is always in the table.
      if (readMcpToolAnnotations(input.tool).readOnlyHint !== false) {
        return;
      }

      const at = now();
      const key = callerKey(input.principal);
      if (window === null || window.key !== key || at - window.start >= deps.windowMs) {
        window = { key, start: at, count: 0, summarySent: false };
      }
      window.count += 1;

      const base = {
        clientName: deps.resolveClientName(input.principal),
        tool: input.tool,
        sessionTitle: deps.resolveSessionTitle(sessionIdOf(input.args)),
        messagePreview: messagePreviewOf(input.args),
      };

      if (window.count <= deps.threshold) {
        emit(deps.sink, { ...base, count: 1 });
        return;
      }
      // Past the threshold the window notifies exactly once more, with the
      // cumulative count; every further call stays silent until the window
      // expires.
      if (!window.summarySent) {
        emit(deps.sink, { ...base, count: window.count });
        window.summarySent = true;
      }
    },
  };
}

// --------------------------- production assembly ---------------------------

/**
 * The production notifier's seams. Every member is optional: production passes
 * nothing and gets the defaults below; the criterion overrides the sink and the
 * clock. `sink` overrides the whole delivery path, so a caller that supplies one
 * never reaches `notifyUserIfEnabled`.
 */
export type McpWriteNotificationDeps = {
  /** Where a notification goes; defaults to the existing notification orchestrator. */
  sink?: McpWriteNotifier;
  /** Clock, default `Date.now`. */
  now?: () => number;
  /** Merge window, default one minute. */
  windowMs?: number;
  /** Individual notifications per window, default 5. */
  threshold?: number;
  /** Client-name reader; defaults to the gateway's one {@link resolveClientName}. */
  resolveClientName?: (principal: McpPrincipal) => string;
  /** Session-title reader; defaults to the session row's display name. */
  resolveSessionTitle?: (sessionId: string | null) => string | null;
};

/** How many characters of a resolved client name survive; a longer name is cut to this bound. */
export const MCP_CLIENT_NAME_MAX_LENGTH = 64;

/** The name a personal access token with no stored `name` is reported under. */
export const PERSONAL_TOKEN_LABEL = '个人访问令牌';
/** The name an OAuth client whose id is empty (so nothing readable remains) is reported under. */
const OAUTH_CLIENT_LABEL = 'OAuth 客户端';

/**
 * Resolves the human-readable name of the client behind a principal — the ONE
 * such resolution in the gateway.
 *
 * An OAuth principal is named by its client row's `client_name`; when the row
 * carries no display name the CLIENT ID itself stands in (bounded by
 * {@link MCP_CLIENT_NAME_MAX_LENGTH}), because the id is still a readable
 * identity and a prompt that shows nothing tells the user less. A personal
 * access token has no client, so it is named by its token row's `name`; a
 * nameless token falls back to {@link PERSONAL_TOKEN_LABEL}. Never throws — a
 * lookup that cannot run (or finds no row) is a fixed label, not a failure.
 *
 * Consumers: {@link createMcpWriteNotification} (the write notification's
 * `clientName`) and `mcp-ui-open-session.ts` (the confirmation bar's requester,
 * carried on the `ui.navigate` frame and the navigation record). Both read THIS
 * function rather than a second copy, so the name a user sees on the bar and the
 * name recorded for `ui_visible_context` cannot drift.
 */
export function resolveClientName(principal: McpPrincipal): string {
  return boundClientName(readClientName(principal));
}

/** The raw name before bounding: the row's display name, else the best readable fallback. */
function readClientName(principal: McpPrincipal): string {
  try {
    if (principal.clientId !== null) {
      const name = oauthClientsDb.findById(principal.clientId)?.client_name;
      if (typeof name === 'string' && name.length > 0) {
        return name;
      }
      // No display name: the client id is the only readable identity left.
      const id = principal.clientId.trim();
      return id.length > 0 ? id : OAUTH_CLIENT_LABEL;
    }
    const name = accessTokensDb.findById(principal.tokenId)?.name;
    return typeof name === 'string' && name.length > 0 ? name : PERSONAL_TOKEN_LABEL;
  } catch {
    // A lookup that cannot run (e.g. before the database is open) still must not
    // leave the caller unnamed.
    return principal.clientId !== null ? OAUTH_CLIENT_LABEL : PERSONAL_TOKEN_LABEL;
  }
}

/** Cuts a name to {@link MCP_CLIENT_NAME_MAX_LENGTH}, so a fixed-width bar cannot be blown out. */
function boundClientName(name: string): string {
  return name.length > MCP_CLIENT_NAME_MAX_LENGTH ? name.slice(0, MCP_CLIENT_NAME_MAX_LENGTH) : name;
}

/**
 * The default session-title reader: the session row's display name (its
 * `custom_name`, which the repository already coalesces from the transcript
 * name), or null when there is no session or no name.
 */
function defaultResolveSessionTitle(sessionId: string | null): string | null {
  if (sessionId === null) {
    return null;
  }
  const name = sessionsDb.getSessionById(sessionId)?.custom_name ?? null;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

/** The sentence a single write call carries into the notification body. */
function describeWrite(payload: McpWriteNotificationPayload): string {
  const where = payload.sessionTitle === null ? '' : `（${payload.sessionTitle}）`;
  if (payload.count > 1) {
    return `外部客户端 ${payload.clientName} 在 1 分钟内调用了 ${payload.tool} ${payload.count} 次${where}。`;
  }
  const preview = payload.messagePreview === null ? '' : `：${payload.messagePreview}`;
  return `外部客户端 ${payload.clientName} 调用了 ${payload.tool}${where}${preview}。`;
}

/**
 * The production assembly: a {@link createMcpWriteNotifier} whose default sink
 * rides the EXISTING notification path — `notifyUserIfEnabled` over the
 * orchestrator's `agent.notification` code — so a write notification needs no
 * new setting, channel or preference.
 *
 * The orchestrator's `notifyUserIfEnabled` is keyed by user, but the payload
 * deliberately carries no user (its five fields are pinned by the criterion).
 * The owner's id is therefore captured from the principal as each call arrives
 * and read synchronously by the default sink, which is safe because `notify` and
 * the sink both run to the point of reading it before returning. A caller that
 * supplies its own `sink` never touches that capture.
 *
 * Consumers: `server/index.ts` (the composition root, which hands the result to
 * `createMcpGatewayModule`) and this module's criterion.
 */
export function createMcpWriteNotification(deps: McpWriteNotificationDeps = {}): McpWriteNotification {
  let ownerUserId: McpPrincipal['userId'] | null = null;

  const sink: McpWriteNotifier =
    deps.sink ??
    ((payload) => {
      notifyUserIfEnabled({
        userId: ownerUserId,
        event: createNotificationEvent({
          provider: 'system',
          kind: 'info',
          code: 'agent.notification',
          meta: { message: describeWrite(payload) },
        }),
      });
    });

  const notifier = createMcpWriteNotifier({
    sink,
    now: deps.now,
    windowMs: deps.windowMs ?? DEFAULT_WINDOW_MS,
    threshold: deps.threshold ?? DEFAULT_THRESHOLD,
    resolveClientName: deps.resolveClientName ?? resolveClientName,
    resolveSessionTitle: deps.resolveSessionTitle ?? defaultResolveSessionTitle,
  });

  return {
    notify(input) {
      ownerUserId = input.principal.userId;
      notifier.notify(input);
    },
  };
}
