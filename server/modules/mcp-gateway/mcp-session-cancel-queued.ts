/**
 * The MCP gateway's `session_cancel_queued` handler (AC-271).
 *
 * `session_cancel_queued` withdraws a message a busy send queued, by the
 * `queuedMessageUuid` that `session_send` handed back. It is an ADAPTER: it
 * translates a tool call into the shared `ChatControlService`'s `cancelQueued`
 * (the same verb AC-231 landed and AC-238 exercised over the debug driver) and
 * translates that verb's verdict into AC-271's own vocabulary.
 *
 * The vocabulary mismatch is the whole point of this module. The control service
 * answers with the shared union `HostQueuedInputCancelResult`
 * (`server/shared/types.ts`): a message still in the queue really leaves it and
 * is answered `withdrawn`; one already taken — already started — is answered
 * `already-started`. AC-271 requires the TOOL to report `cancelled` for the
 * successful withdrawal, so this adapter maps `withdrawn` -> `cancelled` and
 * must never pass `withdrawn` through verbatim; `already-started` maps to
 * itself, so a message that already started is never reported `cancelled`.
 *
 * AC-287 moves the third member off the success side: a uuid the queue never
 * held (never pushed, or belonging to another session) is no longer a
 * `unknown` SUCCESS outcome but an `isError` envelope,
 * `QUEUED_MESSAGE_NOT_FOUND`. The success enum therefore shrinks to
 * `'cancelled' | 'already-started'` — both of which describe a message this
 * session really queued — and the "this process never saw that uuid" fact is
 * stated as the error it is.
 *
 * Everything is injected ({@link McpSessionCancelQueuedDeps}): production wires
 * the process singleton (`server/index.ts`); the criterion wires the real control
 * service over its own fixture. The `session` argument arrives already rewritten
 * to an id by AC-246's target gate (the criterion uses an exact id).
 */

import { z } from 'zod';

import type { HostQueuedInputCancelResult } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';
import type { McpControlCaller } from './mcp-session-send.js';

// --------------------------- injected services ---------------------------

/**
 * The one control verb `session_cancel_queued` needs: withdrawing a queued
 * message by uuid.
 *
 * The caller shape is {@link McpControlCaller} (`{ userId, via: 'mcp' }`), the
 * same caller `session_send` presents, so a withdrawal goes through the control
 * service's shared access entry exactly as a send does. `forbidden` is the
 * control service's own refusal (a caller with no access); it is deliberately a
 * member of this contract because the adapter must treat it as a refusal, never
 * as a successful withdrawal.
 */
export type McpSessionCancelQueuedDeps = {
  control: {
    cancelQueued(
      caller: McpControlCaller,
      input: { sessionId: string; messageUuid: string },
    ): Promise<HostQueuedInputCancelResult | 'forbidden'>;
  };
};

// --------------------------- input and payload ---------------------------

/**
 * AC-271's report vocabulary — the words THIS tool uses on SUCCESS.
 *
 * `cancelled` is the control service's `withdrawn` (the message really left the
 * queue and will never become a round); `already-started` is the reading of a
 * message that had already been dequeued, so it is running or has run and the
 * process was not disturbed. Both describe a message this session really queued,
 * which is why both are successes. The third member AC-271 used to carry —
 * `unknown`, "this session's queue holds no such uuid" — was moved off the
 * success side by AC-287: it is now the `QUEUED_MESSAGE_NOT_FOUND` error, since a
 * reference that names nothing is not a state of a thing that exists.
 */
export type SessionCancelQueuedOutcome = 'cancelled' | 'already-started';

/** The `session_cancel_queued` tool's typed input. */
export type McpSessionCancelQueuedInput = {
  /** The session whose queue is being withdrawn from; the gate resolves a name to an id first. */
  session: string;
  /** The `queuedMessageUuid` a busy `session_send` returned. */
  messageUuid: string;
};

/** The `session_cancel_queued` tool's Zod input shape, used for registration and validation. */
export const SESSION_CANCEL_QUEUED_INPUT_SCHEMA = {
  session: z.string(),
  messageUuid: z.string(),
} satisfies z.ZodRawShape;

/**
 * The `session_cancel_queued` result.
 *
 * `session` and `messageUuid` echo what was withdrawn (the id the gate left and
 * the uuid the caller passed), so a caller can match the answer to the message
 * it took back. `message` is the human sentence AC-271 pins for each outcome.
 */
export type SessionCancelQueuedPayload = {
  outcome: SessionCancelQueuedOutcome;
  session: string;
  messageUuid: string;
  message: string;
};

/** The English sentence each SUCCESS outcome carries (AC-289: caller-facing copy is English-only). */
const OUTCOME_MESSAGES: Record<SessionCancelQueuedOutcome, string> = {
  cancelled: 'The queued message was withdrawn and will not become a turn.',
  'already-started':
    'The message is no longer in the queue (it was taken out to start executing) and can no longer be withdrawn.',
};

/**
 * The sentence the `QUEUED_MESSAGE_NOT_FOUND` error carries — AC-271's own
 * wording for a uuid this session's queue never held, now stated as the error it
 * is (AC-287). English-only (AC-289): it is caller-facing copy.
 */
const QUEUED_MESSAGE_NOT_FOUND_MESSAGE =
  'The session queue has no message with this uuid (it may never have existed, belong to another session, or there is no resident host).';

/** Reads and validates `session_cancel_queued`'s arguments. */
export function readSessionCancelQueuedInput(args: Record<string, unknown>): McpSessionCancelQueuedInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  const messageUuid = args.messageUuid;
  if (typeof messageUuid !== 'string' || messageUuid.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"messageUuid" is required and must be a non-empty string.',
    );
  }
  return { session, messageUuid };
}

// --------------------------- buildSessionCancelQueued ---------------------------

/**
 * Withdraws one queued message and reports AC-271's outcome.
 *
 * The caller is the token's owner, presented under the same `via: 'mcp'` the
 * send path uses, so the control service's shared access entry decides the same
 * way it does for a send. The verdict is translated HERE and only here:
 * `withdrawn` -> `cancelled` (the tool's word for a successful withdrawal),
 * `already-started` -> itself, `unknown` -> the `QUEUED_MESSAGE_NOT_FOUND` error
 * envelope (AC-287), and `forbidden` -> a structured `FORBIDDEN` refusal rather
 * than any outcome. Passing `withdrawn` through, or reading a non-`withdrawn`
 * verdict as `cancelled`, would each be a wrong answer AC-271 pins against.
 *
 * Consumers: `registerMcpSessionCancelQueuedTool` (the registered handler) and
 * this module's criterion, which drives it through the real mount.
 */
export async function buildSessionCancelQueued(
  input: McpSessionCancelQueuedInput,
  ctx: { principal: McpPrincipal },
  deps: McpSessionCancelQueuedDeps,
): Promise<SessionCancelQueuedPayload> {
  const caller: McpControlCaller = { userId: ctx.principal.userId, via: 'mcp' };
  const verdict = await deps.control.cancelQueued(caller, {
    sessionId: input.session,
    messageUuid: input.messageUuid,
  });

  if (verdict === 'forbidden') {
    // AC-232 owns the structured refusal body; this adapter only guarantees the
    // refusal is not mistaken for a successful withdrawal.
    throw new McpToolError(
      MCP_ERROR_CODES.FORBIDDEN,
      'The caller is not allowed to withdraw this session\'s queued message.',
    );
  }

  if (verdict === 'unknown') {
    // AC-287: a uuid this session's queue never held is a reference to nothing,
    // so it is an ERROR rather than a third success outcome. `already-started`
    // stays a success — that message really was queued and really did start.
    throw new McpToolError(MCP_ERROR_CODES.QUEUED_MESSAGE_NOT_FOUND, QUEUED_MESSAGE_NOT_FOUND_MESSAGE);
  }

  const outcome: SessionCancelQueuedOutcome = verdict === 'withdrawn' ? 'cancelled' : verdict;
  return {
    outcome,
    session: input.session,
    messageUuid: input.messageUuid,
    message: OUTCOME_MESSAGES[outcome],
  };
}

// --------------------------- registration ---------------------------

/**
 * One resident tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as AC-249's `McpWriteToolRegistration`, so the
 * transport's one audited seam installs either without a special case.
 */
export type McpSessionCancelQueuedRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/**
 * The seam `registerMcpSessionCancelQueuedTool` installs through. The transport
 * supplies one backed by AC-244's `withMcpAudit`, so the tool inherits the
 * single audit row and the scope refusal without restating either.
 */
export type McpSessionCancelQueuedSeam = (registration: McpSessionCancelQueuedRegistration) => void;

/**
 * Installs `session_cancel_queued` through the audited seam: its handler is
 * {@link buildSessionCancelQueued}, its one scope `cloudcli:session:control`.
 *
 * Consumers: `registerMcpResidentTools` (the stage-6 assembly) and this module's
 * criterion, which reads the registered name and scope back off a recording
 * seam.
 */
export function registerMcpSessionCancelQueuedTool(
  seam: McpSessionCancelQueuedSeam,
  deps: McpSessionCancelQueuedDeps,
  requiredScope: string,
): void {
  seam({
    name: 'session_cancel_queued',
    description: 'Withdraw a queued message by the queuedMessageUuid a busy session_send returned.',
    requiredScope,
    inputSchema: SESSION_CANCEL_QUEUED_INPUT_SCHEMA,
    outputSchema: {
      // AC-287: the success enum is exactly the two outcomes a queued message
      // this session really holds can take. `unknown` left it — that case is now
      // the QUEUED_MESSAGE_NOT_FOUND error.
      outcome: z.enum(['cancelled', 'already-started']),
      session: z.string(),
      messageUuid: z.string(),
      message: z.string(),
    },
    handler: (args, ctx) => buildSessionCancelQueued(readSessionCancelQueuedInput(args), ctx, deps),
  });
}
