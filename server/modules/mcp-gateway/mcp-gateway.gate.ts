/**
 * The MCP gateway's env gate (AC-240).
 *
 * `MCP_ENABLED` is read HERE and nowhere else: a consumer that parsed the
 * variable itself would be making a second, independently-wrong decision, and a
 * single missed check would expose an unauthenticated MCP transport. The gate
 * is FAIL-CLOSED — unset, a `false` value, or an unrecognised value all resolve
 * to "closed", and every decision carries a printable reason so a closed gateway
 * says *why* it is closed.
 *
 * Deliberately NOT cached, unlike the debug agent's gate: the criterion has to
 * read both states in one process by passing two different `env` objects, which
 * a process-lifetime cache would collapse into the first. The function is pure
 * over its argument, so "read once per process" is the caller's choice
 * (`mountMcpGateway` reads it once, at mount time), not a property of this
 * module.
 */

/** Where the stateless Streamable HTTP endpoint lives, before the static layer. */
export const MCP_GATEWAY_PATH = '/mcp';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off', '']);

export type McpGatewayGateReading = {
  enabled: boolean;
  /** Why the gate decided what it decided. Always printable, on both sides. */
  reason: string;
};

/**
 * The gate's decision for the given environment, defaulting to `process.env`.
 *
 * Only a value that is `1`/`true`/`yes`/`on` after trimming and lowercasing
 * opens the gate; everything else — including an unset variable — is closed.
 */
export function readMcpGatewayGate(env: NodeJS.ProcessEnv = process.env): McpGatewayGateReading {
  const raw = env.MCP_ENABLED;

  if (raw === undefined) {
    return { enabled: false, reason: 'MCP_ENABLED is unset' };
  }

  const value = raw.trim().toLowerCase();
  if (DISABLED_VALUES.has(value)) {
    return { enabled: false, reason: `MCP_ENABLED=${JSON.stringify(raw)}` };
  }

  if (!ENABLED_VALUES.has(value)) {
    // Unrecognised -> closed. A typo must not open the gate, and it must not be
    // guessed at either: the reason names the value that was rejected.
    return {
      enabled: false,
      reason: `MCP_ENABLED=${JSON.stringify(raw)} is not a recognised value (expected one of 1/true/yes/on or 0/false/no/off)`,
    };
  }

  return { enabled: true, reason: `MCP_ENABLED=${JSON.stringify(raw)}` };
}
