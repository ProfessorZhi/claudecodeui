/**
 * The MCP gateway's stage-6 resident tools (AC-271, extended by AC-272).
 *
 * This module owns the one statement of "which stage-6 tools exist and the scope
 * each requires": {@link MCP_STAGE6_RESIDENT_TOOLS}. AC-271 delivers exactly one
 * — `session_cancel_queued`, requiring `cloudcli:session:control` — and later
 * stage-6 tasks (AC-272 `session_reconfigure`/`session_background`, AC-273/274
 * `approvals_list`/`approval_answer`) ADD their tools alongside it. AC-252's
 * self-referential guard reads the gateway write-tool names from the gateway's
 * own tables, so those names must stay the single source of truth.
 *
 * WHY AC-272 AND AC-273 DO NOT APPEND TO THE TABLE. AC-271's criterion pins the
 * table's observable contents — `MCP_STAGE6_RESIDENT_TOOLS.map((t) => t.name)`
 * must deep-equal `['session_cancel_queued']` — and AC-272 / AC-273 are barred
 * from editing that criterion (it is a frozen no-regression surface). Growing
 * the table therefore has to happen in the SAME change as widening that
 * assertion, which is a later task's job. AC-272's `session_reconfigure` and
 * AC-273's `session_background` register through the same seam, gated on their
 * deps being present, so AC-271's cancel-queued-only mount keeps registering
 * exactly what it did before. The name/scope SOURCE for an added tool is its own
 * registration function (whose literal name is the one place it is written) plus
 * AC-243's scope vocabulary below — there is still one place per fact.
 *
 * {@link registerMcpResidentTools} installs each name through the SAME audited
 * registration seam AC-244 landed (the transport builds one over `withMcpAudit`,
 * so every tool inherits its audit row and its scope refusal). It is called by
 * `mountMcpGateway` alongside the read and write tools, over the one control
 * service instance the composition root already supplied (`server/index.ts` —
 * never a second instance).
 *
 * The scope literal comes from AC-243's single scope vocabulary
 * (`ACCESS_TOKEN_SCOPES`) rather than being re-typed here, matching the stage-4
 * write table; the array's order is pinned by the OAuth module's own vocabulary
 * criterion, so the positional read cannot silently select the wrong scope.
 */

import { ACCESS_TOKEN_SCOPES } from '@/modules/oauth/index.js';

import type { McpApprovalsDeps } from './mcp-approvals.js';
import { registerMcpApprovalTools } from './mcp-approvals.js';
import type { McpSessionBackgroundDeps } from './mcp-session-background.js';
import { registerMcpSessionBackgroundTool } from './mcp-session-background.js';
import type {
  McpSessionCancelQueuedDeps,
  McpSessionCancelQueuedSeam,
} from './mcp-session-cancel-queued.js';
import { registerMcpSessionCancelQueuedTool } from './mcp-session-cancel-queued.js';
import type { McpSessionReconfigureDeps } from './mcp-session-reconfigure.js';
import { registerMcpSessionReconfigureTool } from './mcp-session-reconfigure.js';

// Position within AC-243's vocabulary, in the order the constant declares and
// `access-token-scopes.test.ts` pins: read, session:send, session:create,
// session:control, approve. `session_background` registers under the read scope
// (the SPEC's read half); its stop branch owns the control check.
const [READ_SCOPE, , , SESSION_CONTROL_SCOPE] = ACCESS_TOKEN_SCOPES;

// --------------------------- the stage-6 resident table ---------------------------

/**
 * Every staged table-listed resident tool, with the scope a caller's token must
 * carry.
 *
 * The single source of truth for the names AC-271's criterion compares against.
 * It is deliberately NOT grown by AC-272: that criterion pins this table's
 * observable contents to exactly `['session_cancel_queued']`, and AC-272 may not
 * edit it. AC-272's `session_reconfigure` is registered alongside (see the file
 * header), by its own registration function; growing THIS table must accompany
 * widening AC-271's assertion in the same change.
 */
export const MCP_STAGE6_RESIDENT_TOOLS = [
  {
    name: 'session_cancel_queued',
    scope: SESSION_CONTROL_SCOPE,
  },
] as const;

/** One table-listed stage-6 resident tool's name, derived from the table so the two cannot drift. */
export type McpStage6ResidentToolName = (typeof MCP_STAGE6_RESIDENT_TOOLS)[number]['name'];

// --------------------------- injected services ---------------------------

/**
 * The services the stage-6 resident tools answer from, all injected.
 *
 * Production passes the process singletons the write tools already use
 * (`server/index.ts`): the single chat control service (AC-233) for
 * `session_cancel_queued`, and AC-272's reconfigure bag (the provider runtime's
 * `reconfigure` passthrough plus the session/model/capability readers) for
 * `session_reconfigure`. The AC-271 criterion passes only `control`, so the
 * reconfigure member is optional and AC-272's tool is registered only when it is
 * supplied — AC-271's cancel-queued-only mount is byte-identical.
 */
export type McpResidentToolDeps = McpSessionCancelQueuedDeps & {
  /** AC-272's reconfigure services. Absent keeps AC-271's exact registration set. */
  reconfigure?: McpSessionReconfigureDeps;
  /**
   * AC-273's `session_background` services: the session reader, AC-245's host
   * snapshot read seam, and the SAME control service AC-271 uses. Absent keeps
   * the cancel-queued-only (and AC-272 reconfigure) registration byte-identical,
   * which is what AC-271's and AC-272's criteria read.
   */
  background?: McpSessionBackgroundDeps;
  /**
   * AC-274's approval tools (`approvals_list` / `approval_answer`): the SAME
   * control service AC-271 uses, presented under its approval verbs, plus the
   * injected clock. Absent keeps the cancel-queued (and reconfigure/background)
   * registration byte-identical — AC-271's criterion pins the table to exactly
   * `['session_cancel_queued']`, so the two approval tools register ALONGSIDE it.
   */
  approvals?: McpApprovalsDeps;
};

/**
 * The seam `registerMcpResidentTools` installs through — the transport's audited
 * registration seam, shared with the read and write tools.
 */
export type McpResidentToolSeam = McpSessionCancelQueuedSeam;

// --------------------------- registration ---------------------------

/**
 * Registers every stage-6 resident tool exactly once, over `deps`.
 *
 * `session_cancel_queued`'s scope comes from {@link MCP_STAGE6_RESIDENT_TOOLS} —
 * the table is the one place the pair (name, scope) is written down — and its
 * handler is AC-271's `buildSessionCancelQueued`. AC-272's `session_reconfigure`
 * is installed through the same seam when its deps are present, under the same
 * `cloudcli:session:control` scope, and AC-273's `session_background` likewise,
 * under the read scope (its stop branch checks the control scope itself).
 */
export function registerMcpResidentTools(seam: McpResidentToolSeam, deps: McpResidentToolDeps): void {
  for (const tool of MCP_STAGE6_RESIDENT_TOOLS) {
    if (tool.name === 'session_cancel_queued') {
      registerMcpSessionCancelQueuedTool(seam, deps, tool.scope);
    }
  }
  if (deps.reconfigure) {
    registerMcpSessionReconfigureTool(seam, deps.reconfigure, SESSION_CONTROL_SCOPE);
  }
  // AC-273's `session_background` registers ALONGSIDE the frozen table for the
  // same reason AC-272's did (see the file header): AC-271's criterion pins
  // `MCP_STAGE6_RESIDENT_TOOLS` to exactly `['session_cancel_queued']`, so the
  // table cannot grow without editing that criterion. Its static scope is the
  // read half; the stop branch's control check lives in the handler.
  if (deps.background) {
    registerMcpSessionBackgroundTool(seam, deps.background, READ_SCOPE);
  }
  // AC-274's `approvals_list` / `approval_answer` register ALONGSIDE the frozen
  // table for the same reason AC-272/AC-273's tools did (see the file header):
  // AC-271's criterion pins `MCP_STAGE6_RESIDENT_TOOLS` to exactly
  // `['session_cancel_queued']`. Their two scopes are written once in
  // `mcp-approvals.ts`, read from AC-243's vocabulary.
  if (deps.approvals) {
    registerMcpApprovalTools(seam, deps.approvals);
  }
}
