// scripts/undici-blocked-ports-preload.mjs
//
// WHY THIS EXISTS — the `bad port` lottery in the server test lane.
//
// undici (Node's built-in `fetch`) rejects 18 ports outright, before it opens a socket: a request
// to one of them fails with `TypeError: fetch failed` / `cause: Error: bad port`. The server test
// lane runs real HTTP through the global `fetch` against an ephemeral port handed out by
// `app.listen(0, '127.0.0.1')` (54 such sites under server/**/*.test.*). The kernel's ephemeral
// allocator (this host: /proc/sys/net/ipv4/ip_local_port_range = "1024 65535") can pick one of the
// 18, and then the same file that is green on a rerun reds with `bad port` — a different file each
// run, disjoint from any task's delta. That shape wastes dispatch rounds: an unattributable red
// stops an otherwise-finished task.
//
// The fix is one process holding the 18 ports for the whole lane, not a retry added to 57 call
// sites (each of which is outside its task's Touches, so a per-file edit is an anti-drift failure).
// This module is loaded with `--import` by package.json's `test:server` and by the two server-file
// calls in scripts/test.sh; it binds each blocked port on 127.0.0.1 and never releases it while the
// process lives, so the kernel cannot hand that port to `listen(0)`.
//
// MEASURED (2026-10-05, Node v24.21.0, this host), not assumed:
//
//   * A holder on 127.0.0.1:P makes `listen(P, H)` fail with EADDRINUSE for H = 127.0.0.1,
//     0.0.0.0 AND :: — a single 127.0.0.1 bind covers every listen form the server lane uses.
//     (Only a *specific* ::1 bind slips past it, and no server test binds ::1.)
//   * `--import` is NOT evaluated in the `node --test` runner parent; it is forwarded to each
//     per-file child. So the holders live in the test-file processes, one set per live child.
//   * Because of the previous point, up to `--test-concurrency` children race for the same 18
//     ports: the first wins them, the rest see EADDRINUSE. Without a retry, a port freed when the
//     winner exits stays free while other children are still running — the exact window this
//     module exists to close. So a lost port is retried (unref'd timer, see scheduleRetry) until
//     it is held, keeping coverage continuous as long as any child is alive.
//
// SAFETY: this module must never make the lane unable to start. Every bind failure is swallowed
// (a port someone else already holds is just as unavailable to `listen(0)`, so the goal is met
// either way), all handles are unref'd so the holders never keep a process alive, and nothing here
// throws. It is also safe to run as a plain entrypoint (`node scripts/undici-blocked-ports-preload.mjs`),
// which holds the ports until the process is killed.

import net from 'node:net';

/**
 * The 18 ports undici refuses before opening a socket. Kept here as the single source of truth;
 * scripts/undici-blocked-ports-preload.test.mjs pins its own copy to this list.
 *
 * @type {readonly number[]}
 */
export const UNDICI_BLOCKED_PORTS = Object.freeze([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

/**
 * The address the ports are held on. All 54 `listen(0, ...)` sites in server tests bind 127.0.0.1,
 * and (measured) a 127.0.0.1 holder also blocks 0.0.0.0 and :: wildcard allocation of that port.
 */
export const HOLD_HOST = '127.0.0.1';

/** How often a port that was already held elsewhere is re-attempted (ms). */
const RETRY_MS = 500;

/**
 * @typedef {{ port: number, held: boolean, code?: string }} HoldResult
 */

/**
 * Bind one port once. Never rejects.
 *
 * @param {number} port
 * @param {string} host
 * @returns {Promise<HoldResult>}
 */
function holdOnce(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    /** @param {NodeJS.ErrnoException} error */
    const onError = (error) => resolve({ port, held: false, code: error.code ?? 'UNKNOWN' });
    server.once('error', onError);
    server.listen(port, host, () => {
      // unref in the listening callback: this is the reliable point (a handle created by listen()
      // re-refs a server that was unref'd before the call).
      server.unref();
      resolve({ port, held: true });
    });
    // Defensive early unref so a listen that never settles cannot hold the loop open.
    server.unref();
  });
}

/**
 * Re-attempt a port that was not held, until it is. The timer is unref'd, so an otherwise-idle
 * process still exits instead of being pinned by the retry loop.
 *
 * @param {number} port
 * @param {string} host
 * @returns {void}
 */
function scheduleRetry(port, host) {
  const timer = setTimeout(() => {
    holdOnce(port, host).then((result) => {
      if (!result.held) scheduleRetry(port, host);
    });
  }, RETRY_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Hold every blocked port on `host`. Resolves once each port has had its first bind attempt;
 * ports that lost the race keep retrying in the background (hold until held).
 *
 * @param {{ host?: string, ports?: readonly number[] }} [options]
 * @returns {Promise<HoldResult[]>}
 */
export function holdBlockedPorts({ host = HOLD_HOST, ports = UNDICI_BLOCKED_PORTS } = {}) {
  const attempts = ports.map((port) =>
    holdOnce(port, host).then((result) => {
      if (!result.held) scheduleRetry(port, host);
      return result;
    }),
  );
  return Promise.all(attempts);
}

const held = holdBlockedPorts();

// Exposed for a child/test to (a) wait for the first bind round instead of racing a sleep and
// (b) read the list this process actually holds, without importing this module (importing it runs
// the top-level hold, which would make the test's own process a holder).
/** @type {any} */
const g = globalThis;
g.__undiciBlockedPortsPreload = held;
g.__undiciBlockedPorts = UNDICI_BLOCKED_PORTS;
