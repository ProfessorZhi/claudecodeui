/**
 * The MCP gateway's `session_reconfigure` handler (AC-272).
 *
 * `session_reconfigure` changes a session's model, reasoning effort and/or
 * permission mode. It does two things that are deliberately kept apart:
 *
 *  1. it records the change on the session row, so the *next* run the session
 *     opens carries it (AC-249's `session_send` reads the stored selection back
 *     and puts it on the run); and
 *  2. when the provider declares the setting can be applied live
 *     (`residentFeatures.liveReconfigure`) and a live resident host is up, it
 *     asks the running process to move — without restarting it.
 *
 * What makes this tool different from the WebSocket `chat.send` path is the
 * refusal: a `permissionMode` outside the provider's capability matrix is
 * REJECTED, with the supported values listed, and nothing is written and no
 * driver is touched. `chat.send` deliberately does the opposite — it silently
 * ignores an unsupported mode (`providerModelsService.setSessionPermissionMode`
 * returns null without a write) — and AC-272's criterion reads the two side by
 * side to pin the difference.
 *
 * Everything is injected ({@link McpSessionReconfigureDeps}): the session store,
 * the provider runtime's `reconfigure` pass-through, the model writers and the
 * capability matrix. Production wires the process singletons (`server/index.ts`);
 * the criterion wires the real objects over its scripted resident driver. The
 * `session` argument arrives already rewritten to an id by AC-246's target gate
 * (the criterion uses an exact id).
 */

import { z } from 'zod';

import type { providerCapabilitiesService, providerModelsService } from '@/modules/providers/index.js';
import type { HostReconfigurePatch, LLMProvider } from '@/shared/types.js';

import { MCP_ERROR_CODES, McpToolError } from './mcp-error-envelope.js';
import type { McpPrincipal } from './mcp-gateway.auth.js';

// --------------------------- capability vocabulary ---------------------------

/** The three settings this tool can change, in the order they are reported. */
export const SESSION_RECONFIGURE_FIELDS = ['model', 'effort', 'permissionMode'] as const;

/** One setting `session_reconfigure` can name. */
export type SessionReconfigureField = (typeof SESSION_RECONFIGURE_FIELDS)[number];

// --------------------------- injected services ---------------------------

/**
 * The services `session_reconfigure` answers from, all injected.
 *
 * `sessions.getSessionById` both resolves the session (a miss is the structured
 * `SESSION_NOT_FOUND`, with zero side effects) and names its provider, which the
 * capability matrix and the runtime pass-through are keyed by.
 *
 * `models` and `capabilities` are the real service slices (the task pins the
 * `Pick`s), so the criterion can hand the process singletons or wrap them in a
 * spy without restating either contract.
 */
export type McpSessionReconfigureDeps = {
  sessions: {
    getSessionById(sessionId: string): { provider: string } | null | undefined;
  };
  /**
   * The provider runtime's `reconfigure` pass-through. It decides only
   * placement; whether the provider supports a live change is this module's
   * read of the matrix below, never a second judgement here.
   */
  runtime: {
    reconfigure(
      provider: LLMProvider,
      sessionId: string,
      patch: HostReconfigurePatch,
    ): Promise<'live' | 'next-turn' | 'unsupported'>;
  };
  models: Pick<typeof providerModelsService, 'setSessionModel' | 'setSessionEffort' | 'setSessionPermissionMode'>;
  capabilities: Pick<
    typeof providerCapabilitiesService,
    'getProviderCapabilities' | 'getRuntimeProviderCapabilities'
  >;
};

// --------------------------- input and payload ---------------------------

/** The `session_reconfigure` tool's typed input. */
export type McpSessionReconfigureInput = {
  /** The session to reconfigure; the transport's target gate resolves a name to an id first. */
  session: string;
  /** The model the session's next run should use. */
  model?: string;
  /** The reasoning effort the session's next run should use. */
  effort?: string;
  /** The permission mode; an unsupported value is refused, listing the supported ones. */
  permissionMode?: string;
};

/** The `session_reconfigure` tool's Zod input shape, used for registration and validation. */
export const SESSION_RECONFIGURE_INPUT_SCHEMA = {
  session: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
} satisfies z.ZodRawShape;

/**
 * The `session_reconfigure` result.
 *
 * `stored` echoes the values that were written to the session row (only the
 * fields the caller gave). `applied` is where the change took effect: `live`
 * means the running process moved without a restart, `next-turn` means it will
 * be picked up by the next launch/turn. `liveSupported` says whether the
 * provider declares live reconfiguration at all — a `false` here is the fact
 * `message` explains.
 */
export type SessionReconfigurePayload = {
  ok: true;
  session: string;
  stored: Partial<Record<SessionReconfigureField, string>>;
  applied: 'live' | 'next-turn';
  liveSupported: boolean;
  message?: string;
};

/** Reads and validates `session_reconfigure`'s arguments. */
export function readSessionReconfigureInput(args: Record<string, unknown>): McpSessionReconfigureInput {
  const session = args.session;
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new McpToolError(
      MCP_ERROR_CODES.INVALID_ARGUMENT,
      '"session" is required and must be a non-empty string.',
    );
  }
  const readOptional = (key: SessionReconfigureField): string | undefined => {
    const value = args[key];
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new McpToolError(
        MCP_ERROR_CODES.INVALID_ARGUMENT,
        `"${key}" must be a non-empty string when given.`,
      );
    }
    return value;
  };
  return {
    session,
    model: readOptional('model'),
    effort: readOptional('effort'),
    permissionMode: readOptional('permissionMode'),
  };
}

/** The sentence a provider with no live reconfiguration is told. Load-bearing words: "live reconfiguration" / "next". */
const NO_LIVE_MESSAGE =
  'This provider does not support live reconfiguration; changes take effect on the next start / next turn.';
/** The sentence a live-capable provider is told when the named settings are not among its live ones. */
const NOT_LIVE_MESSAGE = 'This change is not among the settings this provider can apply live; it takes effect next turn.';
/** The sentence a live-capable provider is told when the driver could not place the change. */
const NOT_PLACED_MESSAGE =
  'This provider was not reconfigured live (no live host was available); the change takes effect next turn.';

/**
 * Reads the settings a provider can change live, from whichever table states
 * them.
 *
 * Two stores carry `residentFeatures`: the union table
 * (`getProviderCapabilities`, where `claude` states `['model','permissionMode']`)
 * and the runtime-declaration table (`getRuntimeProviderCapabilities`, used by
 * providers outside the union). A provider is read from the union table first
 * because that is where a union provider states it; a miss falls through to the
 * runtime table, whose records may carry no `residentFeatures` at all — read as
 * an empty list, the conservative answer.
 */
function readLiveReconfigureFields(
  capabilities: McpSessionReconfigureDeps['capabilities'],
  provider: string,
): SessionReconfigureField[] {
  const union = capabilities.getProviderCapabilities(provider as LLMProvider)?.residentFeatures?.liveReconfigure;
  if (union) {
    return union;
  }
  const declared = capabilities.getRuntimeProviderCapabilities(provider)?.residentFeatures?.liveReconfigure;
  return declared ?? [];
}

// --------------------------- buildSessionReconfigure ---------------------------

/**
 * Records a session's model/effort/permission-mode change and applies what can
 * be applied live.
 *
 * Order is load-bearing. The session is resolved first (a miss is
 * `SESSION_NOT_FOUND` with no side effects), then the permission mode is checked
 * against the provider's capability matrix — an unsupported mode is refused
 * before ANY write and before the driver is reached. Only then are the given
 * fields written, and only then, if the provider declares the setting live, is
 * the running process asked to move.
 *
 * Consumers: `registerMcpSessionReconfigureTool` (the registered handler) and
 * this module's criterion, which drives it through the real mount.
 */
export async function buildSessionReconfigure(
  input: McpSessionReconfigureInput,
  _ctx: { principal: McpPrincipal },
  deps: McpSessionReconfigureDeps,
): Promise<SessionReconfigurePayload> {
  const sessionId = input.session;
  const session = deps.sessions.getSessionById(sessionId);
  if (!session || typeof session.provider !== 'string' || session.provider.length === 0) {
    throw new McpToolError(MCP_ERROR_CODES.SESSION_NOT_FOUND, `No session has id "${sessionId}".`, false, {
      session: sessionId,
    });
  }
  const provider = session.provider;

  // (c) Refuse an unsupported permission mode FIRST — no write, no driver call.
  // This is the deliberate opposite of the WebSocket path, which silently
  // ignores the same value.
  if (input.permissionMode !== undefined) {
    const supported = deps.capabilities.getProviderCapabilities(provider as LLMProvider)?.permissionModes ?? [];
    if (!supported.includes(input.permissionMode)) {
      throw new McpToolError(
        MCP_ERROR_CODES.UNSUPPORTED_PERMISSION_MODE,
        `Provider "${provider}" does not support permission mode "${input.permissionMode}"; supported: ${supported.join(', ') || 'none'}.`,
        false,
        { supported: [...supported] },
      );
    }
  }

  // (a) Record the change on the session row. Each setter is invoked only for a
  // field the caller actually gave.
  const stored: Partial<Record<SessionReconfigureField, string>> = {};
  if (input.model !== undefined) {
    deps.models.setSessionModel(provider as LLMProvider, sessionId, input.model);
    stored.model = input.model;
  }
  if (input.effort !== undefined) {
    deps.models.setSessionEffort(provider as LLMProvider, sessionId, input.effort);
    stored.effort = input.effort;
  }
  if (input.permissionMode !== undefined) {
    deps.models.setSessionPermissionMode(provider as LLMProvider, sessionId, input.permissionMode);
    stored.permissionMode = input.permissionMode;
  }

  // (b)/(d) Apply live what the provider declares it can.
  const live = readLiveReconfigureFields(deps.capabilities, provider);
  const liveSupported = live.length > 0;
  const wantsLive = SESSION_RECONFIGURE_FIELDS.filter((field) => input[field] !== undefined);
  const coLive = wantsLive.filter((field) => live.includes(field));

  if (wantsLive.length === 0 || coLive.length === 0) {
    return {
      ok: true,
      session: sessionId,
      stored,
      applied: 'next-turn',
      liveSupported,
      ...(liveSupported ? { message: NOT_LIVE_MESSAGE } : { message: NO_LIVE_MESSAGE }),
    };
  }

  const patch: HostReconfigurePatch = {};
  if (input.model !== undefined) {
    patch.model = input.model;
  }
  if (input.effort !== undefined) {
    patch.effort = input.effort;
  }
  if (input.permissionMode !== undefined) {
    patch.permissionMode = input.permissionMode;
  }

  const verdict = await deps.runtime.reconfigure(provider as LLMProvider, sessionId, patch);
  if (verdict === 'live') {
    return { ok: true, session: sessionId, stored, applied: 'live', liveSupported };
  }
  return {
    ok: true,
    session: sessionId,
    stored,
    applied: 'next-turn',
    liveSupported,
    message: verdict === 'unsupported' ? NOT_PLACED_MESSAGE : NOT_LIVE_MESSAGE,
  };
}

// --------------------------- registration ---------------------------

/**
 * One resident tool as it is handed to the registration seam.
 *
 * Deliberately the same shape as AC-271's `McpSessionCancelQueuedRegistration`,
 * so the transport's one audited seam installs either without a special case.
 */
export type McpSessionReconfigureRegistration = {
  name: string;
  description: string;
  requiredScope: string;
  inputSchema: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: { principal: McpPrincipal }) => unknown | Promise<unknown>;
};

/** The seam `registerMcpSessionReconfigureTool` installs through (AC-244's audited wrapper). */
export type McpSessionReconfigureSeam = (registration: McpSessionReconfigureRegistration) => void;

/**
 * Installs `session_reconfigure` through the audited seam: its handler is
 * {@link buildSessionReconfigure}, its one scope `cloudcli:session:control`.
 *
 * Consumers: `registerMcpResidentTools` (the stage-6 assembly) and this module's
 * criterion, which drives it through the real mount.
 */
export function registerMcpSessionReconfigureTool(
  seam: McpSessionReconfigureSeam,
  deps: McpSessionReconfigureDeps,
  requiredScope: string,
): void {
  seam({
    name: 'session_reconfigure',
    description: 'Change a session model / effort / permission mode; unsupported permission modes are refused with the supported list.',
    requiredScope,
    inputSchema: SESSION_RECONFIGURE_INPUT_SCHEMA,
    outputSchema: {
      ok: z.boolean(),
      session: z.string(),
      stored: z.record(z.string(), z.string()),
      applied: z.string(),
      liveSupported: z.boolean(),
      message: z.string().optional(),
    },
    handler: (args, ctx) => buildSessionReconfigure(readSessionReconfigureInput(args), ctx, deps),
  });
}
