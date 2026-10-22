/**
 * The MCP gateway's `session_background` handler (AC-273).
 *
 * `session_background` answers two questions about one session's held work:
 *
 *  1. WITHOUT a `stopTaskId` it LISTS the session's `background-task` and
 *     `cron` leases — id, kind, and whether the schedule repeats — read from the
 *     HOST SNAPSHOT (`hosts.liveHostForSession`), which is why a read-only token
 *     is enough; and
 *  2. WITH a `stopTaskId` it STOPS that one task through the shared
 *     `ChatControlService.stopTask`, which needs `cloudcli:session:control`.
 *
 * Three decisions are load-bearing and each is the opposite of a tempting
 * shortcut:
 *
 *  - The scope check for the STOP branch happens HERE and BEFORE the control
 *    service is reached, so a read-only token is refused with the control
 *    service's call count still at zero. The tool's static scope is
 *    `cloudcli:read` (the SPEC's read half), so the control half cannot be left
 *    to the audited registration seam — it is owned here.
 *  - "Does this session hold that task" is decided from the HOST SNAPSHOT, not a
 *    second task table. An id the snapshot does not hold is `TASK_NOT_FOUND`,
 *    and the control service is never called for it — so a missing id can never
 *    be misread as "stopped".
 *  - `stopped: true` is claimed ONLY when the snapshot confirmed the id AND the
 *    control service answered `requested`. The control service has no `stopped`
 *    verdict (a driver that cannot place the request answers `unsupported`), and
 *    the WebSocket path learns "it really stopped" from the later
 *    `task_notification(stopped)` frame — never from this call. Reporting
 *    `stopped` on anything but `requested` would be a fabrication.
 *
 * Everything is injected ({@link McpSessionBackgroundDeps}): production wires
 * the process singletons (`server/index.ts`); the criterion wires the real
 * manager, runtime and control service over a scripted resident process. The
 * `session` argument arrives already rewritten to an id by AC-246's target gate
 * (the criterion uses an exact id).
 */

import { z } from 'zod';

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';
import type { ControlStopTaskOutcome } from '@/modules/providers/index.js';
import type { HostLease } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpScopeDeniedError, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpControlCaller } from './mcp-session-send.js';

// Position within AC-243's single scope vocabulary, in the order the constant
// declares and `access-token-scopes.test.ts` pins: read, session:send,
// session:create, session:control, approve.
const [, , , SESSION_CONTROL_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- injected services ---------------------------

/**
 * What `session_background`'s stop branch reads from a live host: the two facts
 * it reports about the host itself, plus the binding table whose leases are the
 * listing. Structurally satisfied by the session-hosts module's `ProcessHost`
 * (the same object AC-245's `session_get` reads), so production passes the real
 * manager without an adapter.
 */
type McpSessionBackgroundHost = {
  state: string;
  pid: number | null;
  bindings: Map<string, { leases: HostLease[] }>;
};

/**
 * The services `session_background` answers from, all injected.
 *
 * `sessions.getSessionById` resolves the session — a miss is the structured
 * `SESSION_NOT_FOUND`, with zero side effects — and names its provider, which
 * the control service needs to find a runtime.
 *
 * `hosts.liveHostForSession` is AC-245's host read seam (the same one
 * `session_get` uses): the live host serving the session, or null. The listing
 * and the existence precheck read ONLY this snapshot — never a second task
 * table.
 *
 * `control.stopTask` is the shared `ChatControlService.stopTask` (AC-233's one
 * instance) presented under the gateway's own caller vocabulary
 * ({@link McpControlCaller}). Its verdict is the gateway's stop vocabulary: the
 * driver outcomes (`requested` / `unsupported` / `timeout` / `error`) or a stable
 * refusal. A driver that cannot place the request answers `unsupported`, never a
 * claim that the task stopped.
 */
export type McpSessionBackgroundDeps = {
  sessions: {
    getSessionById(sessionId: string): { provider: string } | null | undefined;
  };
  hosts: {
    liveHostForSession(sessionId: string): McpSessionBackgroundHost | null;
  };
  control: {
    stopTask(
      caller: McpControlCaller,
      input: { sessionId: string; taskId: string },
    ): Promise<ControlStopTaskOutcome | 'forbidden' | 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER'>;
  };
};

// --------------------------- input and payload ---------------------------

/**
 * One task the session is holding, as `session_background` reports it.
 *
 * `kind` is exactly the lease kind it came from (`background-task` or `cron`),
 * and `recurring` is the lease's own `recurring` for a `cron` — a
 * `background-task` has no schedule and is reported `recurring: false`.
 */
export type SessionBackgroundTask = {
  id: string;
  kind: 'background-task' | 'cron';
  recurring: boolean;
};

/** The `session_background` tool's typed input. */
export type McpSessionBackgroundInput = {
  /** The session whose held work is listed; the gate resolves a name to an id first. */
  session: string;
  /** When present, stop this task instead of only listing. Requires `cloudcli:session:control`. */
  stopTaskId?: string;
};

/** The `session_background` tool's Zod input shape, used for registration and validation. */
export const SESSION_BACKGROUND_INPUT_SCHEMA = {
  session: z.string(),
  stopTaskId: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_background` result.
 *
 * `host` is the live host's `state`/`pid` or null when the session has none;
 * `tasks` is the held work read from that host's snapshot. On a successful stop,
 * `stopped` is `true`, `taskId` names what was stopped, and `remaining` is the
 * re-read listing. A refusal or a stop failure is thrown (rendered `isError`)
 * rather than returned, so `stopped` is never present without a real stop.
 */
export type SessionBackgroundPayload = {
  ok: boolean;
  session: string;
  host: { state: string; pid: number | null } | null;
  tasks: SessionBackgroundTask[];
  stopped?: boolean;
  taskId?: string;
  remaining?: SessionBackgroundTask[];
  code?: string;
  message?: string;
};

/** The sentence a session with no live host is told. Load-bearing words: "no host". */
const NO_HOST_MESSAGE = 'This session currently has no host, so it has no background tasks or schedules.';

/** Reads and validates `session_background`'s arguments. */
export function readSessionBackgroundInput(args: Record<string, unknown>): McpSessionBackgroundInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  const stopTaskId = args.stopTaskId;
  if (stopTaskId === undefined || stopTaskId === null) {
    return { session };
  }
  if (typeof stopTaskId !== 'string' || stopTaskId.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"stopTaskId" must be a non-empty string when given.',
    );
  }
  return { session, stopTaskId };
}

/** Projects a lease into the report shape, or null for a lease kind that is not background work. */
function toBackgroundTask(lease: HostLease): SessionBackgroundTask | null {
  if (lease.kind === 'background-task') {
    return { id: lease.id, kind: lease.kind, recurring: false };
  }
  if (lease.kind === 'cron') {
    return { id: lease.id, kind: lease.kind, recurring: lease.recurring };
  }
  return null;
}

// --------------------------- buildSessionBackground ---------------------------

/**
 * Lists a session's `background-task` / `cron` leases, or stops one by id.
 *
 * Order is load-bearing, mirroring the acceptance criteria exactly:
 *
 *  1. resolve the session (a miss is `SESSION_NOT_FOUND`, no side effects);
 *  2. read the host snapshot ONCE — this is the listing for the read-only call
 *     and the membership precheck for the stop call;
 *  3. `stopTaskId` absent ⇒ return the listing (or the cold-session sentence);
 *  4. `stopTaskId` present ⇒ check the control scope FIRST (the control service
 *     is not reached when it is missing), then check the id against the snapshot
 *     (an unknown id is `TASK_NOT_FOUND`, the control service is not reached),
 *     then delegate to the control service;
 *  5. a `requested` verdict is the only one that reports `stopped: true`, and it
 *     re-reads the snapshot into `remaining`.
 *
 * Consumers: `registerMcpSessionBackgroundTool` (the registered handler) and this
 * module's criterion, which drives it through the real mount.
 */
export async function buildSessionBackground(
  input: McpSessionBackgroundInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionBackgroundDeps,
): Promise<SessionBackgroundPayload> {
  const sessionId = input.session;
  const session = deps.sessions.getSessionById(sessionId);
  if (!session || typeof session.provider !== 'string' || session.provider.length === 0) {
    throw new McpToolError(MCP_ERROR_CODES.SESSION_NOT_FOUND, `No session has id "${sessionId}".`, false, {
      session: sessionId,
    });
  }

  /**
   * The host reading: `host` is the host's `state`/`pid` or null, and `tasks` is
   * its `background-task` / `cron` leases. Reads the snapshot fresh each call so
   * the post-stop `remaining` is a real re-read rather than a stale copy.
   */
  const readSnapshot = (): { host: { state: string; pid: number | null } | null; tasks: SessionBackgroundTask[] } => {
    const live = deps.hosts.liveHostForSession(sessionId);
    const binding = live?.bindings.get(sessionId);
    if (!live || !binding) {
      return { host: null, tasks: [] };
    }
    const tasks = binding.leases
      .map(toBackgroundTask)
      .filter((task): task is SessionBackgroundTask => task !== null);
    return { host: { state: live.state, pid: live.pid }, tasks };
  };

  // (a)/(e) The read-only listing, and the cold-session answer.
  if (input.stopTaskId === undefined) {
    const snapshot = readSnapshot();
    if (snapshot.host === null) {
      return { ok: true, session: sessionId, host: null, tasks: [], message: NO_HOST_MESSAGE };
    }
    return { ok: true, session: sessionId, host: snapshot.host, tasks: snapshot.tasks };
  }

  const taskId = input.stopTaskId;

  // (b) The control scope is owned HERE, before the control service is reached,
  // so a read-only token's stop never increments the control service's count.
  if (!ctx.principal.scopes.includes(SESSION_CONTROL_SCOPE)) {
    // AC-286: this refusal is the SAME denial the audited wrapper's generic
    // check renders — `McpScopeDeniedError` carries the missing scope both in
    // the sentence and as `details.requiredScopes`, so the envelope (and the
    // denied audit row the wrapper writes) names the scope wherever the refusal
    // is caught. The details hold `requiredScopes` alone: the session/task
    // context on the not-found refusals below belongs to those, not to a denial.
    throw new McpScopeDeniedError([SESSION_CONTROL_SCOPE], 'session_background');
  }

  // (c) The id must be in the snapshot BEFORE the control service is reached, so
  // an unknown id is reported as not-found and is never misread as stopped.
  const before = readSnapshot();
  if (!before.tasks.some((task) => task.id === taskId)) {
    throw new McpToolError(
      MCP_ERROR_CODES.TASK_NOT_FOUND,
      `This session has no background task or schedule with id "${taskId}".`,
      false,
      { session: sessionId, taskId },
    );
  }

  const outcome = await deps.control.stopTask(
    { userId: ctx.principal.userId, via: 'mcp' },
    { sessionId, taskId },
  );

  // (b)/(d) Only `requested` is a real stop; the snapshot is re-read so
  // `remaining` reflects the driver's own lease removal.
  if (outcome === 'requested') {
    const after = readSnapshot();
    return {
      ok: true,
      session: sessionId,
      host: after.host,
      tasks: after.tasks,
      stopped: true,
      taskId,
      remaining: after.tasks,
    };
  }

  if (outcome === 'unsupported' || outcome === 'timeout' || outcome === 'error') {
    const code = outcome === 'unsupported' ? 'STOP_UNSUPPORTED' : outcome === 'timeout' ? 'STOP_TIMEOUT' : 'STOP_ERROR';
    const message =
      outcome === 'unsupported'
        ? "This session's resident host does not support stopping this background task (the request was not placed)."
        : outcome === 'timeout'
          ? 'The stop request timed out; the stop was not confirmed.'
          : 'The stop request failed; the stop was not confirmed.';
    throw new McpToolError(code, message, false, {
      session: sessionId,
      taskId,
      remaining: readSnapshot().tasks,
    });
  }

  // The control service's own refusals pass through unchanged, never as success.
  const refusalMessage =
    outcome === 'forbidden'
      ? "The caller is not allowed to stop this session's background tasks."
      : outcome === 'SESSION_NOT_FOUND'
        ? `No session has id "${sessionId}".`
        : 'This provider does not support background-task control.';
  throw new McpToolError(outcome, refusalMessage, false, { session: sessionId, taskId });
}

// --------------------------- registration ---------------------------

/**
 * One resident tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as AC-271's / AC-272's registration, so the
 * transport's one audited seam installs it without a special case.
 */
export type McpSessionBackgroundRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/** The seam `registerMcpSessionBackgroundTool` installs through (AC-244's audited wrapper). */
export type McpSessionBackgroundSeam = (registration: McpSessionBackgroundRegistration) => void;

/**
 * Installs `session_background` through the audited seam: its handler is
 * {@link buildSessionBackground}, its static scope `cloudcli:read` (the SPEC's
 * read half — the stop branch's `cloudcli:session:control` check lives in the
 * handler, before the control service is reached).
 *
 * Consumers: `registerMcpResidentTools` (the stage-6 assembly) and this module's
 * criterion, which drives it through the real mount.
 */
export function registerMcpSessionBackgroundTool(
  seam: McpSessionBackgroundSeam,
  deps: McpSessionBackgroundDeps,
  requiredScope: string,
): void {
  seam({
    name: 'session_background',
    description:
      'List a session background-task and cron leases from the live host snapshot; with stopTaskId, stop one through the control service.',
    requiredScope,
    inputSchema: SESSION_BACKGROUND_INPUT_SCHEMA,
    outputSchema: {
      ok: z.boolean(),
      session: z.string(),
      host: z.union([z.object({ state: z.string(), pid: z.number().nullable() }), z.null()]),
      tasks: z.array(z.object({ id: z.string(), kind: z.string(), recurring: z.boolean() })),
      stopped: z.boolean().optional(),
      taskId: z.string().optional(),
      remaining: z.array(z.object({ id: z.string(), kind: z.string(), recurring: z.boolean() })).optional(),
      code: z.string().optional(),
      message: z.string().optional(),
    },
    handler: (args, ctx) => buildSessionBackground(readSessionBackgroundInput(args), ctx, deps),
  });
}
