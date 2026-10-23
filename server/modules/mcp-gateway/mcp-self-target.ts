/**
 * The MCP gateway's self-referential guard (AC-252; SPEC
 * `docs/proposals/mcp-gateway-SPEC.md` v3.1 §290–§300).
 *
 * A gateway client can itself be a CloudCLI session — the canonical nesting is
 * "a Claude Code session opened inside CloudCLI calling CloudCLI's own MCP
 * server". When that session calls a WRITE tool against ITSELF it does not just
 * act on a stranger: `session_send` queues a message behind the round that is
 * waiting for this very tool result, and `session_interrupt` / `session_close`
 * kill the round the tool result was going to return into. The request
 * deadlocks, so the tool must be refused before it reaches the control or host
 * service.
 *
 * The rule (SPEC §296). The target session's CURRENT turn is running a gateway
 * WRITE tool — `phase === 'tool'` and the pending `tool_use`'s raw name matches
 * `^mcp__.+__(<gateway write tool name>)$` — then the four write operations
 * named in {@link MCP_SELF_TARGET_WRITE_OPS} are refused with
 * {@link SELF_TARGET_CODE}. Two properties are load-bearing and are what the
 * criterion pins:
 *
 *  - **The server alias is arbitrary.** The `<server>` segment is whatever the
 *    user typed in `.mcp.json` (`cloudcli`, `my-cc-ui`, `x`, …), so the suffix
 *    is taken at the LAST `__` boundary and matched against the write-tool NAMES
 *    — never against a hard-coded `mcp__cloudcli` server prefix. An alias that
 *    merely starts with `mcp__cloudcli` is not special; an alias that does not
 *    is not exempt.
 *  - **The write-tool names come from the registry, not a second copy.** The
 *    names are injected ({@link SelfTargetDeps.writeToolNames}); the dispatch
 *    point supplies them from `MCP_STAGE4_WRITE_TOOLS`, so adding a write tool
 *    there widens the guard with no edit here. A module-local array would be
 *    exactly the drift the SPEC forbids.
 *
 * The guard is a HEURISTIC and errs on the safe side: another MCP server that
 * happens to expose a gateway-named tool triggers it too. `TurnState.toolName`
 * is only produced by Claude's turn-phase reducer today, so a non-Claude
 * session reads as `idle` and never triggers the guard (SPEC §297); the
 * criterion injects its own turn reader, so the rule is exercised without a
 * real Claude run.
 *
 * Consumers: `mcp-gateway.write-tools.ts`, whose `registerMcpWriteTools` wraps
 * every registered write tool with {@link buildSelfTargetGuard} BEFORE the
 * handler — so a blocked call never reaches the control or host service and
 * leaves an `error` audit row rather than an `ok`. This module's criterion
 * drives both exports directly and through the real `/mcp` mount.
 *
 * `phase !== 'tool'` is a RELEASE, not a block: the turn-phase reducer leaves
 * `toolName` set to the previous turn's tool while the phase moves on, so a
 * guard that read `toolName` alone would refuse a session that is merely idle
 * after having run a gateway tool. Only a LIVE pending tool counts.
 */

import type { TurnState } from '@/modules/providers/index.js';

// --------------------------- vocabulary ---------------------------

/**
 * The refusal code a self-targeted write call carries. Consumers: the dispatch
 * point (which throws it as a JSON body the audit wrapper renders as `isError`)
 * and this module's criterion, which asserts it instead of re-typing the
 * literal.
 */
export const SELF_TARGET_CODE = 'SELF_TARGET';

/**
 * The write operations refused against a self-target (SPEC §296). The list is
 * the four operations that would deadlock the target's own waiting round;
 * `session_start` and `session_create` are deliberately absent — starting a
 * host or creating a session does not abort the tool result the caller is
 * waiting on.
 *
 * `session_cancel_queued` is a stage-6 tool, not a stage-4 one: it is listed
 * here because the RULE protects it, and a later task that adds a write tool
 * only has to widen the registry the guard reads — the operation set stays the
 * one statement of which calls are refused. Consumers: {@link buildSelfTargetGuard}
 * and this module's criterion.
 */
export const MCP_SELF_TARGET_WRITE_OPS = [
  'session_send',
  'session_interrupt',
  'session_close',
  'session_cancel_queued',
] as const;

/** One protected write operation, derived from the list so the two cannot drift. */
export type McpSelfTargetWriteOp = (typeof MCP_SELF_TARGET_WRITE_OPS)[number];

/** The `mcp__` server prefix every MCP tool name carries. */
const MCP_TOOL_PREFIX = 'mcp__';

/** The segment separator between the server alias and the tool name. */
const TOOL_SEPARATOR = '__';

// --------------------------- injected deps ---------------------------

/**
 * The two seams the guard reads, both injected so a criterion can manufacture
 * any turn and any write-tool set without a real Claude run or the real table.
 *
 * - `readTurn` is the target session's live turn. Production supplies the
 *   providers barrel's `readSessionTurn` (the one source of `TurnState`); the
 *   criterion supplies a function returning a `TurnState` it controls.
 * - `writeToolNames` is the gateway write-tool name set. Production supplies it
 *   from `MCP_STAGE4_WRITE_TOOLS` at the dispatch point; the criterion supplies
 *   its own registry, which is how leg (d) proves a newly added write tool is
 *   covered with no guard edit.
 */
export type SelfTargetDeps = {
  readTurn: (sessionId: string) => TurnState;
  writeToolNames: readonly string[];
};

/**
 * The guard's answer for one call. `allowed: true` carries nothing else;
 * `allowed: false` carries the refusal code, the matched write-tool name (the
 * suffix, which is the write tool the TARGET is executing) and a printable
 * message naming the target, that tool and the operation.
 */
export type SelfTargetDecision =
  | { allowed: true }
  | { allowed: false; code: typeof SELF_TARGET_CODE; message: string; suffix: string };

/** The reading {@link isSelfTargetTurn} returns, blocked or not. */
export type SelfTargetTurnReading = {
  blocked: boolean;
  /** The matched write-tool name when blocked, else null. */
  suffix: string | null;
  /** A printable explanation for both outcomes. */
  reason: string;
};

// --------------------------- the rule ---------------------------

/**
 * Splits a raw MCP tool name into its alias and tool-name halves, or null when
 * it is not shaped `mcp__<non-empty alias>__<non-empty name>`.
 *
 * The suffix is taken at the LAST `__`, so an alias containing `-` (or any other
 * character, including an inner `__`) is handled without assuming anything about
 * it. A name with only one `__` (`mcp__onlyone`), an empty alias
 * (`mcp____session_send`), a missing `mcp__` prefix, or a trailing separator all
 * read as "not a gateway tool reference" rather than being guessed at.
 */
function splitGatewayToolName(toolName: string): { alias: string; name: string } | null {
  if (!toolName.startsWith(MCP_TOOL_PREFIX)) {
    return null;
  }
  const rest = toolName.slice(MCP_TOOL_PREFIX.length);
  const separatorAt = rest.lastIndexOf(TOOL_SEPARATOR);
  if (separatorAt <= 0) {
    // `-1`: no separator at all. `0`: the alias is empty.
    return null;
  }
  const alias = rest.slice(0, separatorAt);
  const name = rest.slice(separatorAt + TOOL_SEPARATOR.length);
  if (alias.length === 0 || name.length === 0) {
    return null;
  }
  return { alias, name };
}

/**
 * Decides whether one turn is a self-target: the session is LIVE in a tool and
 * that tool's name is a gateway write tool.
 *
 * A turn whose phase is not `tool` is released — the phase reducer leaves the
 * previous tool's name in place, so `toolName` alone is not evidence of a
 * pending call. A null name, a name that is not `mcp__alias__tool`, an empty
 * write-tool set, or a suffix outside the set are all releases. The check reads
 * the injected `writeToolNames` and never a module-local list.
 *
 * Consumers: {@link buildSelfTargetGuard} and this module's criterion, which
 * reads the `blocked` / `suffix` / `reason` triple on every arm.
 */
export function isSelfTargetTurn(
  turn: TurnState,
  writeToolNames: readonly string[],
): SelfTargetTurnReading {
  if (turn.phase !== 'tool') {
    return {
      blocked: false,
      suffix: null,
      reason: `Phase is ${turn.phase}, not tool; allowed.`,
    };
  }
  const toolName = turn.toolName;
  if (toolName === null) {
    return { blocked: false, suffix: null, reason: 'In the tool phase but with no tool name; allowed.' };
  }
  const split = splitGatewayToolName(toolName);
  if (split === null) {
    return {
      blocked: false,
      suffix: null,
      reason: `${toolName} is not of the form mcp__<alias>__<tool>; allowed.`,
    };
  }
  if (!writeToolNames.includes(split.name)) {
    return {
      blocked: false,
      suffix: null,
      reason: `The suffix ${split.name} of ${toolName} is not in the gateway write-tool name set; allowed.`,
    };
  }
  return {
    blocked: true,
    suffix: split.name,
    reason: `The target session is executing gateway write tool ${toolName} (alias ${split.alias}); the self-target write is refused.`,
  };
}

// --------------------------- the guard ---------------------------

/** Whether one operation is one the guard protects. */
function isProtectedOp(op: string): op is McpSelfTargetWriteOp {
  return (MCP_SELF_TARGET_WRITE_OPS as readonly string[]).includes(op);
}

/**
 * Builds the guard the write-tool dispatch point calls before each handler.
 *
 * The returned function takes the tool name (`op`) and the TARGET session id
 * (already rewritten to an id by AC-246's target gate) and answers a
 * {@link SelfTargetDecision}:
 *
 *  - `op` is not one of {@link MCP_SELF_TARGET_WRITE_OPS} — a read tool or an
 *    unprotected write tool such as `session_start` / `session_create` — is
 *    allowed WITHOUT reading the turn, so read tools can never be refused;
 *  - otherwise the target's live turn is read and run through
 *    {@link isSelfTargetTurn}; a hit is refused with {@link SELF_TARGET_CODE},
 *    the matched suffix and a printable message naming the target, the gateway
 *    write tool the target is executing, and the refused operation.
 *
 * Consumers: `registerMcpWriteTools` (wrapped around every registered write
 * tool) and this module's criterion (driven directly, including the
 * `session_cancel_queued` operation whose tool is registered elsewhere).
 */
export function buildSelfTargetGuard(
  deps: SelfTargetDeps,
): (input: { op: string; targetSessionId: string }) => SelfTargetDecision {
  return ({ op, targetSessionId }) => {
    if (!isProtectedOp(op)) {
      return { allowed: true };
    }
    const turn = deps.readTurn(targetSessionId);
    const reading = isSelfTargetTurn(turn, deps.writeToolNames);
    if (!reading.blocked) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: SELF_TARGET_CODE,
      suffix: reading.suffix ?? '',
      message:
        `Target session ${targetSessionId} is executing gateway write tool ${turn.toolName ?? ''}; ` +
        `the write operation (${op}) against it is refused to avoid a self-target deadlock.`,
    };
  };
}
