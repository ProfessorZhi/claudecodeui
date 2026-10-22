import path from 'node:path';

import express, { type Express, type RequestHandler, type Router } from 'express';

/**
 * The debug agent's env gate (ADR-003 decision 3, as narrowed by adjudication B).
 *
 * "Off" must mean *the thing does not exist*, not "a check returned false". That
 * distinction is why this module — and not each consumer — is the only place
 * that reads `DEBUG_AGENT`: a consumer that parsed the variable itself would be
 * making a second, independently-wrong decision, and a single missed check would
 * expose the control plane to every logged-in user (ADR-003 decision 6: the gate
 * is the security boundary, `authenticateToken` only answers "who are you").
 *
 * The gate is evaluated ONCE per process, at first read, and it is FAIL-CLOSED:
 * an unset variable, an unrecognised value, or an enabled gate with no fixture
 * root all resolve to "closed". Every decision carries a printable reason, so a
 * closed gate says *why* it is closed rather than being silent.
 *
 * Three faces read this module (adjudication B dropped `capabilities` — that
 * table is a closed literal that does not grow with the registry, so "no entry
 * when off" is vacuously true and is not evidence of anything):
 *
 *  1. registry — `providerRegistry.registerDebugAgentProvider()`;
 *  2. watcher  — `getDebugAgentProjectsRoot()`;
 *  3. routes   — `mountDebugAgentControlPlane()`.
 */

/** Runtime provider id. Deliberately NOT a member of the `LLMProvider` union (ADR-003 decision 2). */
export const DEBUG_AGENT_PROVIDER_ID = 'debug';

/** Where the dev-only control plane is mounted when the gate is open. */
export const DEBUG_AGENT_CONTROL_PLANE_PATH = '/api/debug-agent';

const ENABLED_VALUES = new Set(['1', 'true', 'yes', 'on']);
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off', '']);

export type DebugAgentGateReading = {
  enabled: boolean;
  /** The fixture home, or `null` while the gate is closed. Never `os.homedir()`. */
  home: string | null;
  /** Why the gate decided what it decided. Always printable, on both sides. */
  reason: string;
};

let cached: DebugAgentGateReading | null = null;

function evaluate(): DebugAgentGateReading {
  const raw = process.env.DEBUG_AGENT;

  if (raw === undefined) {
    return { enabled: false, home: null, reason: 'DEBUG_AGENT is unset' };
  }

  const value = raw.trim().toLowerCase();
  if (DISABLED_VALUES.has(value)) {
    return { enabled: false, home: null, reason: `DEBUG_AGENT=${JSON.stringify(raw)}` };
  }

  if (!ENABLED_VALUES.has(value)) {
    // Unrecognised -> closed. A typo must not open the gate, and it must not be
    // guessed at either: the reason names the value that was rejected.
    return {
      enabled: false,
      home: null,
      reason: `DEBUG_AGENT=${JSON.stringify(raw)} is not a recognised value (expected one of 1/true/yes/on or 0/false/no/off)`,
    };
  }

  const home = (process.env.DEBUG_AGENT_HOME ?? '').trim();
  if (!home) {
    // Enabled but rootless. The fixture root comes from the gate variable and
    // never from `os.homedir()` (ADR-003 "fixture HOME 隔离与清理"), so without
    // it there is no root that is safe to write to. Falling back would point the
    // debug agent at the real home — the failure that section exists to prevent.
    return {
      enabled: false,
      home: null,
      reason: 'DEBUG_AGENT is enabled but DEBUG_AGENT_HOME is empty: the fixture root is mandatory and is never defaulted to os.homedir()',
    };
  }

  return {
    enabled: true,
    home: path.resolve(home),
    reason: `DEBUG_AGENT=${JSON.stringify(raw)} with DEBUG_AGENT_HOME=${JSON.stringify(home)}`,
  };
}

/** The gate's decision, evaluated at first read and cached for the process's lifetime. */
export function readDebugAgentGate(): DebugAgentGateReading {
  if (!cached) {
    cached = evaluate();
    if (cached.enabled) {
      console.log(`[DEBUG-AGENT] enabled: ${cached.reason}`);
    } else if (process.env.DEBUG_AGENT !== undefined) {
      console.warn(`[DEBUG-AGENT] closed: ${cached.reason}`);
    }
  }

  return cached;
}

export function isDebugAgentEnabled(): boolean {
  return readDebugAgentGate().enabled;
}

/** The printable reason behind the current decision, on both sides of the gate. */
export function getDebugAgentGateReason(): string {
  return readDebugAgentGate().reason;
}

/**
 * Face 2 — "watcher 没有根" (ADR-003 decision 3).
 *
 * The directory the debug agent's transcript fixtures live in, or `null` while
 * the gate is closed. `null` is load-bearing: the watcher adds a root to its
 * observation set only when it gets a path back, so a closed gate means the
 * fixture root is not observed *and* is not created by the watcher's `mkdir`.
 */
export function getDebugAgentProjectsRoot(): string | null {
  const home = readDebugAgentGate().home;
  return home ? path.join(home, '.claude', 'projects') : null;
}

/**
 * Face 3 — "路由未挂载" (ADR-003 decision 3).
 *
 * The control plane's router. It is created here rather than in the routes
 * module because *this* module owns the decision of whether it may be attached;
 * the routes module registers endpoints onto it.
 *
 * Note what "not mounted" is NOT: it is not a 404. `static-assets.module.ts`
 * renders `dist/index.html` for every extension-less path and is mounted after
 * every `/api/*` route, so a path nobody mounted answers `200 text/html` (the
 * frontend shell). Asserting 404 would be red against a correct implementation
 * (ADR-003 验证记录 a), and would also blunt the tamper case for this face.
 */
export const debugAgentControlPlaneRouter: Router = express.Router();

/**
 * Attaches the control plane, or does nothing at all.
 *
 * Returns whether it attached, so the entrypoint can log the decision. The
 * attach is skipped — not guarded downstream — when the gate is closed: nothing
 * is added to the application's middleware stack, so there is no layer for a
 * request to reach. A handler that answered "403 forbidden" would still be a
 * layer, and would still be reachable.
 */
export function mountDebugAgentControlPlane(app: Express, authenticate: RequestHandler): boolean {
  if (!isDebugAgentEnabled()) {
    return false;
  }

  app.use(DEBUG_AGENT_CONTROL_PLANE_PATH, authenticate, debugAgentControlPlaneRouter);
  return true;
}
