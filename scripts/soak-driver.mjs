#!/usr/bin/env node
// soak-driver.mjs — the ACTIVE half of the soak harness (gap-server-soak-harness): it stirs a
// running server and samples it, or (in stub/sample modes) it is both the target and the sampler
// for the harness's own positive control.
//
// WHY IT IS NOT A TEST. Nothing here runs on every fan-in. The criterion for this task is
// "soak is triggered BY HAND" (AC-4 greps for exactly that), so this file is an operator entry
// point, reachable through `bash scripts/soak.sh` and through nothing else.
//
// THE FOUR MODES, and why each one exists:
//
//   stub   `soak-driver.mjs stub --kind leak|steady` — a controlled target process. `leak` retains
//          one Buffer per second (so its RSS climbs without bound), `steady` touches nothing. These
//          are the two arms of AC-2: a harness that cannot red a known leak, and green a known
//          steady process, has not been shown to measure anything.
//   sample `soak-driver.mjs sample --pid <p> …` — the sampling half alone, pointed at any process.
//          `soak.sh --self-test` runs it against each stub and requires red-for-leak /
//          green-for-steady. Same sampler and same analyzer as a real run; only the agitation is
//          absent. That is what keeps the control honest: the code that judges a real server is the
//          code that is judged here.
//   drive  `soak-driver.mjs drive --base-url … --token-file …` — the real thing. Sessions
//          created/sent/aborted, websocket clients closed normally / left half-open / deliberately
//          NOT read, transcript lines appended (one file grown toward the 100MB mark), conversation
//          search fired, PTYs toggled — while RSS, VmHWM, V8 heap, fds, threads, children, the
//          cgroup's memory.current and the `claudecodeui-session-*` scope count are sampled every
//          5 seconds.
//   mock-gateway — a local Anthropic-compatible endpoint, so the real `claude` binary can be driven
//          without credentials and without touching the network. It streams a small reply, or a
//          multi-megabyte one when the prompt carries SOAK_BURST (the lever the slow-client
//          hypothesis needs: something big enough to actually fill a socket that is not read).
//          The burst is produced FRAME BY FRAME under the socket's backpressure (replyFrames +
//          streamReply), never materialized: `--burst-mb` must be able to exceed the workload's own
//          churn, and an array-of-events implementation made the GATEWAY the first thing to OOM at
//          ~512MiB, capping the instrument at ~48MiB — below the scale the question is asked at.
//          The hypothesis is only answerable differentially: the same socket, the same subscribe,
//          the same window, but reading (`--slow-client-drains`) is the control arm, and every other
//          reading in the run — the workload, the session count, the probe cadence — is shared. A
//          single arm cannot separate "the server retains the unread frames" from "the workload grew".
//
// WHAT IS READ, AND FROM WHERE (every source is deliberately outside the server: the soak must not
// need a debug build, and it must not leave a debug surface switched on in production):
//
//   rss / VmHWM / fds / threads / children   /proc/<pid>/…                    exact bytes, no flags
//   cgroup memory.current                    /sys/fs/cgroup/<pid's cgroup>    kernel accounting
//   session scope count                      siblings of the server's cgroup (`…-session-*.scope`)
//   V8 heap, pid, uptime                     POST /api/commands/execute {commandName:"/status"}
//
// The heap source deserves the note: the task offers "a read-only debug outlet OR
// --heapsnapshot-signal, whichever is least invasive, and it must not be left on in production".
// The least invasive option turned out to be an outlet that already exists and is already on in
// production: the `/status` slash-command handler answers `process.memoryUsage()` for the server's
// own process. It adds no endpoint, no flag and no surface — so NODE_OPTIONS is left untouched for
// the real :3001 server, and the soak unit sets only `--heapsnapshot-signal=SIGUSR1
// --diagnostic-dir=…`, which exists solely to preserve the scene when a run goes red (DoD item 6).
// Its cost is precision: heapUsed arrives rounded to whole MiB, which is why the heap threshold sits
// well above the quantization noise (see the threshold comments in soak-analyze.mjs).
//
// TOKEN LIFETIME. The observation credential is capped at 30 minutes (scripts/mint-token.mjs,
// MAX_TTL_MINUTES) and the DoD run is 30 minutes long, so a single token cannot cover a full run.
// The server re-issues one on any request whose presented token is past half its lifetime
// (`X-Refreshed-Token`, auth.middleware.ts), and this driver adopts it: every HTTP response is
// checked, and the websocket legs reconnect with the newest token. Without this the second half of
// a long run would degrade into 401s, which is exactly the failure a soak must not have.
//
// Exit codes: 0 = green, 1 = red (the verdict is the analyzer's, printed on stdout), 2 = the
// harness itself could not run (bad usage, unreachable server, unwritable report).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import { analyzeSoakReport, REQUIRED_ACTIONS, REQUIRED_SERIES } from './soak-analyze.mjs';

const require = createRequire(import.meta.url);
const WebSocket = /** @type {typeof import('ws').default} */ (require('ws'));

const PAGE_SIZE = 4096;
const MIB = 1024 * 1024;
const SOAK_SCHEMA = 'soak-report/1';

/**
 * The offered session load. 500ms between session starts is the rate the thresholds in
 * soak-analyze.mjs were derived at (240 starts over a 120s window); it is the harness's control, not
 * a measurement, so it must not drift with the host (see runSessionLeg). The cap is what bounds the
 * peak: with a ~2s run latency the pinned interval settles at ~4 concurrent sessions — the
 * concurrency the baselines showed — and the cap only exists so a server that stops answering
 * cannot let the in-flight set grow without limit and turn the run into a different experiment.
 */
const SESSION_INTERVAL_MS = 500;
const SESSION_MAX_CONCURRENT = 8;

/** Prefix of the transient session scopes the server spawns per claude run (claude-session-scope.service.ts). */
const SESSION_SCOPE_PREFIX = 'claudecodeui-session-';

/**
 * @typedef {object} Sample
 * @property {number} t
 * @property {number|null} rssBytes
 * @property {number|null} vmHwmBytes
 * @property {number|null} heapUsedBytes
 * @property {number|null} heapTotalBytes
 * @property {number|null} fdCount
 * @property {number|null} threadCount
 * @property {number|null} childCount
 * @property {number|null} cgroupMemoryBytes
 * @property {number|null} sessionScopeCount
 * @property {number|null} targetPid
 * @property {number|null} uptimeSeconds
 * @property {number|null} statusRssBytes
 */

/**
 * @typedef {object} Actions
 * @property {number} sessionsCreated
 * @property {number} chatSends
 * @property {number} runsCompleted
 * @property {number} aborts
 * @property {number} wsNormalCloses
 * @property {number} wsHalfOpen
 * @property {number} slowClients
 * @property {number} slowClientBurstBytes
 * @property {number} slowClientDrainedBytes
 * @property {number} transcriptLinesAppended
 * @property {number} transcriptBytesAppended
 * @property {number} searches
 * @property {number} searchMatches
 * @property {number} shellPtyOpens
 * @property {number} shellPtyCloses
 * @property {number} sessionStartsDeferred
 */

/**
 * @typedef {object} SamplingOptions
 * @property {number|null} pid
 * @property {string|null} baseUrl
 * @property {string|null} token
 * @property {boolean} useStatus
 * @property {number} warmupSeconds
 * @property {number} durationSeconds
 * @property {number} cooldownSeconds
 * @property {number} intervalMs
 */

/**
 * @typedef {object} SampleModeOptions
 * @property {number} pid
 * @property {number} warmupSeconds
 * @property {number} durationSeconds
 * @property {number} cooldownSeconds
 * @property {number} intervalMs
 * @property {string} report
 * @property {string} label
 */

/**
 * @typedef {object} DriveModeOptions
 * @property {string} baseUrl
 * @property {string} tokenFile
 * @property {number} port
 * @property {string} projectDir
 * @property {string} transcriptDir
 * @property {number} warmupSeconds
 * @property {number} durationSeconds
 * @property {number} cooldownSeconds
 * @property {number} intervalMs
 * @property {number} maxTranscriptMb
 * @property {number} burstMb
 * @property {number} slowClientSeconds
 * @property {boolean} slowClientDrains
 * @property {number} sessionIntervalMs
 * @property {number} maxConcurrentSessions
 * @property {string} report
 * @property {string|null} serverLog
 * @property {string|null} diagnosticDir
 * @property {number} gcProbeIntervalSeconds
 * @property {number|null} pid
 * @property {string[]} notes
 */

/**
 * @typedef {object} LegContext
 * @property {string} baseUrl
 * @property {string} token
 * @property {string} projectDir
 * @property {number} port
 * @property {Actions} actions
 * @property {Array<Record<string, unknown>>} windows
 * @property {boolean} stop
 * @property {number} sessionIntervalMs
 * @property {number} sessionMaxConcurrent
 * @property {(token: string) => void} onToken
 */

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} message
 * @returns {never}
 */
function fatal(message) {
  process.stderr.write(`soak-driver: ${message}\n`);
  process.exit(2);
}

/**
 * @param {Partial<Actions>} [overrides]
 * @returns {Actions}
 */
function emptyActions(overrides = {}) {
  return Object.assign({
    sessionsCreated: 0, chatSends: 0, runsCompleted: 0, aborts: 0, wsNormalCloses: 0, wsHalfOpen: 0,
    slowClients: 0, slowClientBurstBytes: 0, slowClientDrainedBytes: 0, transcriptLinesAppended: 0, transcriptBytesAppended: 0,
    searches: 0, searchMatches: 0, shellPtyOpens: 0, shellPtyCloses: 0, sessionStartsDeferred: 0,
  }, overrides);
}

// ─────────────────────────────────────────────────────────────────────────────
// /proc and cgroup readers. Every one returns null rather than throwing: a process that exits
// mid-run is a reading of its own (the sampler records the gap), not a reason to abandon the run.
// ─────────────────────────────────────────────────────────────────────────────

/** @param {string} file @returns {string|null} */
function readTextFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** @param {number} pid @returns {number|null} */
function readRssBytes(pid) {
  const statm = readTextFile(`/proc/${pid}/statm`);
  if (statm === null) return null;
  const residentPages = Number.parseInt(statm.split(/\s+/)[1] ?? '', 10);
  return Number.isFinite(residentPages) ? residentPages * PAGE_SIZE : null;
}

/**
 * A `Vm*` field from /proc/<pid>/status, in bytes (the kernel reports kB).
 *
 * @param {number} pid
 * @param {string} field
 * @returns {number|null}
 */
function readStatusField(pid, field) {
  const status = readTextFile(`/proc/${pid}/status`);
  if (status === null) return null;
  for (const line of status.split('\n')) {
    if (line.startsWith(`${field}:`)) {
      const value = Number.parseInt(line.slice(field.length + 1).trim().split(/\s+/)[0] ?? '', 10);
      return Number.isFinite(value) ? value * 1024 : null;
    }
  }
  return null;
}

/** @param {number} pid @returns {number|null} */
function readFdCount(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

/** @param {number} pid @returns {number|null} */
function readThreadCount(pid) {
  try {
    return fs.readdirSync(`/proc/${pid}/task`).length;
  } catch {
    return null;
  }
}

/**
 * Direct child processes of `pid`, from the kernel's per-thread `children` file. Threads are the
 * right granularity: a child of any thread is a child of the process.
 *
 * @param {number} pid
 * @returns {number|null}
 */
function readChildCount(pid) {
  try {
    const threads = fs.readdirSync(`/proc/${pid}/task`);
    /** @type {Set<string>} */
    const children = new Set();
    for (const thread of threads) {
      const raw = readTextFile(`/proc/${pid}/task/${thread}/children`);
      if (raw === null) continue;
      for (const child of raw.trim().split(/\s+/)) if (child) children.add(child);
    }
    return children.size;
  } catch {
    return null;
  }
}

/**
 * The cgroup directory a pid lives in, as an absolute /sys/fs/cgroup path.
 *
 * @param {number} pid
 * @returns {string|null}
 */
function readCgroupDir(pid) {
  const raw = readTextFile(`/proc/${pid}/cgroup`);
  if (raw === null) return null;
  // cgroup v2 has a single `0::<path>` line; v1 has one line per controller and no unified path.
  const line = raw.split('\n').find((entry) => entry.startsWith('0::'));
  if (!line) return null;
  return path.join('/sys/fs/cgroup', line.slice(3).trim());
}

/** @param {number} pid @returns {number|null} */
function readCgroupMemory(pid) {
  const dir = readCgroupDir(pid);
  if (dir === null) return null;
  const raw = readTextFile(path.join(dir, 'memory.current'));
  if (raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

/**
 * Count the `claudecodeui-session-*` scopes that are siblings of the server's own cgroup. Sessions
 * are spawned as transient units (`systemd-run --user --scope --unit=claudecodeui-session-…`), so
 * they land in the same slice as the server; scanning the server's parent cgroup therefore counts
 * exactly the scopes this server could have produced.
 *
 * @param {number|null} pid
 * @returns {number|null}
 */
function readSessionScopeCount(pid) {
  /** @type {Set<string>} */
  const candidates = new Set();
  if (pid !== null) {
    const dir = readCgroupDir(pid);
    if (dir !== null) {
      candidates.add(path.dirname(dir));
      const appSlice = /^(.*\/app\.slice)(\/|$)/.exec(dir);
      if (appSlice) candidates.add(appSlice[1]);
    }
  }
  if (candidates.size === 0) return null;
  let count = 0;
  let readable = false;
  for (const dir of candidates) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(SESSION_SCOPE_PREFIX) && entry.endsWith('.scope')) count += 1;
      }
      readable = true;
    } catch {
      // A slice that is not there simply contributes nothing.
    }
  }
  return readable ? count : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP (the driver speaks to the server exactly as the SPA does: Bearer token, JSON).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} route
 * @param {unknown} [body]
 * @param {{ method?: string, timeoutMs?: number, onToken?: ((token: string) => void) | undefined }} [options]
 * @returns {Promise<{ status: number, json: unknown }>}
 */
async function apiCall(baseUrl, token, route, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    adoptRefreshedToken(response, options.onToken);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 400) };
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Adopt the token the server re-issued because the presented one is past half its lifetime. This is
 * what keeps a 30-minute run authenticated with a 30-minute-capped credential (see the file header).
 *
 * @param {Response} response
 * @param {((token: string) => void) | undefined} onToken
 */
function adoptRefreshedToken(response, onToken) {
  const refreshed = response.headers.get('x-refreshed-token');
  if (refreshed && onToken) onToken(refreshed);
}

/**
 * The server's own view of itself: pid, uptime and `process.memoryUsage()`. See the file header for
 * why this is the heap source rather than a new debug flag.
 *
 * @param {string} baseUrl
 * @param {string} token
 * @param {((token: string) => void) | undefined} [onToken]
 * @returns {Promise<{ pid: number, heapUsedBytes: number, heapTotalBytes: number, rssBytes: number, uptimeSeconds: number } | null>}
 */
async function fetchStatus(baseUrl, token, onToken) {
  try {
    const { status, json } = await apiCall(baseUrl, token, '/api/commands/execute', { commandName: '/status' }, { timeoutMs: 8_000, onToken });
    if (status !== 200) return null;
    const envelope = /** @type {{ data?: { pid?: number, uptimeSeconds?: number, memoryUsage?: { rssMb?: number, heapUsedMb?: number, heapTotalMb?: number } } }} */ (json);
    const data = envelope?.data;
    if (!data || typeof data.pid !== 'number' || !data.memoryUsage) return null;
    return {
      pid: data.pid,
      heapUsedBytes: (data.memoryUsage.heapUsedMb ?? 0) * MIB,
      heapTotalBytes: (data.memoryUsage.heapTotalMb ?? 0) * MIB,
      rssBytes: (data.memoryUsage.rssMb ?? 0) * MIB,
      uptimeSeconds: typeof data.uptimeSeconds === 'number' ? data.uptimeSeconds : 0,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sampling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One tick. `t` is seconds since the run started — the x axis every series is fitted on.
 *
 * @param {{ t: number, pid: number|null, baseUrl: string|null, token: string|null, useStatus: boolean, onToken?: ((token: string) => void) | undefined }} ctx
 * @returns {Promise<Sample>}
 */
async function collectSample(ctx) {
  let status = null;
  if (ctx.useStatus && ctx.baseUrl !== null && ctx.token !== null) {
    status = await fetchStatus(ctx.baseUrl, ctx.token, ctx.onToken);
  }
  const pid = status?.pid ?? ctx.pid;
  return {
    t: ctx.t,
    rssBytes: pid === null ? null : readRssBytes(pid),
    vmHwmBytes: pid === null ? null : readStatusField(pid, 'VmHWM'),
    heapUsedBytes: status?.heapUsedBytes ?? null,
    heapTotalBytes: status?.heapTotalBytes ?? null,
    fdCount: pid === null ? null : readFdCount(pid),
    threadCount: pid === null ? null : readThreadCount(pid),
    childCount: pid === null ? null : readChildCount(pid),
    cgroupMemoryBytes: pid === null ? null : readCgroupMemory(pid),
    sessionScopeCount: readSessionScopeCount(pid),
    targetPid: pid,
    uptimeSeconds: status?.uptimeSeconds ?? null,
    statusRssBytes: status?.rssBytes ?? null,
  };
}

/**
 * The sampling cycles shared by both modes: a quiet warm-up window, the drive window (this function
 * only samples; the caller's legs do the agitating), then a cool-down window. Kept in one place so
 * "what counts as the warm-up" has exactly one definition — the same split the analyzer uses.
 *
 * @param {SamplingOptions} options
 * @param {((sample: () => Promise<Sample>) => Promise<void>) | null} duringDrive
 * @returns {Promise<Sample[]>}
 */
async function sampleThroughWindows(options, duringDrive) {
  const started = Date.now();
  /** @type {Sample[]} */
  const samples = [];
  const elapsed = () => (Date.now() - started) / 1000;
  const sample = async () => {
    const entry = await collectSample({
      t: Number(elapsed().toFixed(3)),
      pid: options.pid,
      baseUrl: options.baseUrl,
      token: options.token,
      useStatus: options.useStatus,
    });
    samples.push(entry);
    return entry;
  };

  await sample();
  while (elapsed() < options.warmupSeconds) {
    await sleep(options.intervalMs);
    await sample();
  }

  if (duringDrive) {
    await duringDrive(sample);
  } else {
    while (elapsed() < options.warmupSeconds + options.durationSeconds) {
      await sleep(options.intervalMs);
      await sample();
    }
  }

  const cooldownEnd = options.warmupSeconds + options.durationSeconds + options.cooldownSeconds;
  while (elapsed() < cooldownEnd) {
    await sleep(options.intervalMs);
    await sample();
  }
  await sample();
  return samples;
}

// ─────────────────────────────────────────────────────────────────────────────
// stub mode — the controlled target processes of AC-2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `leak` retains one Buffer per second — the AC-2 wording, and slow enough that a sampler running at
 * 500ms sees a stair rather than a jump. `steady` allocates nothing and only touches a fixed
 * working set, so it cannot drift upward even if the OS would rather reclaim those pages.
 *
 * @param {string} kind
 * @param {number} retainMb
 */
async function runStub(kind, retainMb) {
  process.stdout.write(`soak-driver: stub kind=${kind} pid=${process.pid} retain=${retainMb}MiB/s\n`);
  if (kind === 'leak') {
    /** @type {Buffer[]} */
    const retained = [];
    setInterval(() => {
      retained.push(Buffer.alloc(retainMb * MIB, 0x61));
    }, 1000);
  } else {
    const held = Buffer.alloc(8 * MIB, 0x62);
    setInterval(() => {
      held[0] = (held[0] + 1) % 256;
    }, 1000);
  }
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// mock-gateway mode — a local Anthropic-compatible endpoint for the real `claude` binary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The reply's SSE frames in wire order: the two header events, the delta events (one 4KiB block each
 * for a burst), then the three tail events.
 *
 * IT IS A GENERATOR, AND THAT IS THE WHOLE FIX. The previous version built this list as an ARRAY
 * before writing a byte, so a `--burst-mb 512` reply was ~131k JS strings held at once and the
 * GATEWAY was the first process to die of it: `FATAL ERROR: Reached heap limit Allocation failed`,
 * 4095MiB, server `ECONNREFUSED`, 27 sessions, arm discarded. That put the instrument's ceiling at
 * ~48MiB — the size at which its own heap survived — which is BELOW the churn the slow-client
 * hypothesis has to be read against, so the "unbounded send buffer" branch was **未能驱动** rather
 * than refuted. Producing one frame at a time makes the gateway's memory independent of `--burst-mb`.
 *
 * The WIRE BYTES ARE UNCHANGED by that: same event names, same order, same `JSON.stringify`, the
 * same 4KiB text block, the same count. The SDK reads exactly what it read before; only the
 * gateway's peak stops scaling with the reply.
 *
 * @param {boolean} burst
 * @param {number} burstMb
 * @returns {Generator<[string, unknown]>}
 */
function* replyFrames(burst, burstMb) {
  yield ['message_start', {
    type: 'message_start',
    message: {
      id: 'msg_soak', type: 'message', role: 'assistant', model: 'soak-mock', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    },
  }];
  yield ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }];
  if (burst) {
    // Many small deltas rather than one big one: this is what makes the SERVER emit many
    // websocket frames, which is the shape a slow client's backlog is made of.
    const chunk = 'x'.repeat(4096);
    const count = Math.ceil((burstMb * MIB) / chunk.length);
    for (let i = 0; i < count; i += 1) {
      yield ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }];
    }
  } else {
    yield ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'soak-ok' } }];
  }
  yield ['content_block_stop', { type: 'content_block_stop', index: 0 }];
  yield ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }];
  yield ['message_stop', { type: 'message_stop' }];
}

/**
 * One Anthropic-compatible reply, streamed frame by frame with BACKPRESSURE.
 *
 * `res.write` returns false once the response's buffer is past its high-water mark, and the bytes are
 * buffered all the same — so ignoring that return value is what turns "stream the burst" back into
 * "materialize the burst", only this time in Node's socket queue instead of in an array. Awaiting
 * 'drain' there is the half of the fix that actually bounds the gateway: its pending bytes then track
 * the SOCKET's buffer, not the reply's size.
 *
 * The abort signal is attached ONCE per reply, not per frame. A 512MiB reply is 131,072 frames, and a
 * 'close' listener attached per frame would accumulate to Node's max-listener warning (and a real
 * leak of closures) — while the frame the reader abandons mid-write is exactly what has to be caught:
 * `event: message_stop` on a dead socket is not a reading anyone has.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} burst
 * @param {number} burstMb
 * @returns {Promise<void>}
 */
async function streamReply(res, burst, burstMb) {
  const gone = new AbortController();
  const onGone = () => gone.abort();
  res.on('close', onGone);
  res.on('error', onGone);

  /**
   * @param {string} name
   * @param {unknown} data
   * @returns {Promise<boolean>} false when the reader went away and the reply must stop.
   */
  const send = async (name, data) => {
    if (gone.signal.aborted) return false;
    if (res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)) return true;
    try {
      await once(res, 'drain', { signal: gone.signal });
      return true;
    } catch {
      // Aborted: the socket is gone, so there is nothing left to write to.
      return false;
    }
  };

  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [name, data] of replyFrames(burst, burstMb)) {
    if (!(await send(name, data))) {
      res.destroy();
      return;
    }
  }
  res.end();
}

/**
 * @param {number} port 0 = pick a free one
 * @param {string} portFile written once bound, so the caller never races the bind
 * @param {number} burstMb reply size when the request carries the SOAK_BURST marker
 */
async function runMockGateway(port, portFile, burstMb) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!(req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      // The reply handler is async because the burst waits on socket drains, so it must not be handed
      // to the emitter directly: an unhandled rejection here would take the gateway down mid-run,
      // which is the failure this mode exists to stop inflicting on the run.
      streamReply(res, body.includes('SOAK_BURST'), burstMb).catch(() => {
        res.destroy();
      });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(null)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  fs.writeFileSync(portFile, String(address.port));
  // The pid, next to the port, for the same reason the port is there: the DoD reads the gateway's OWN
  // peak RSS out of /proc, and a sampler cannot race the bind-or-die window to find it any other way.
  fs.writeFileSync(`${portFile}.pid`, String(process.pid));
  process.stdout.write(`soak-driver: mock gateway on 127.0.0.1:${address.port} burst=${burstMb}MiB pid=${process.pid} (streamed)\n`);
  await new Promise(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// The agitator legs. Each performs its action once immediately — so even a short run produces a
// non-zero count for every class, which is what AC-3 requires — and then paces itself.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ baseUrl: string, token: string, projectDir: string, port: number, onToken: (token: string) => void, sessionIntervalMs: number, sessionMaxConcurrent: number }} options
 * @returns {LegContext}
 */
function createLegContext(options) {
  return {
    baseUrl: options.baseUrl,
    token: options.token,
    projectDir: options.projectDir,
    port: options.port,
    onToken: options.onToken,
    actions: emptyActions(),
    windows: [],
    stop: false,
    sessionIntervalMs: options.sessionIntervalMs,
    sessionMaxConcurrent: options.sessionMaxConcurrent,
  };
}

/**
 * Create a session and drive exactly one chat run through it, optionally aborting mid-run.
 *
 * @param {LegContext} ctx
 * @param {{ burst?: boolean, abort?: boolean, subscribe?: (sessionId: string) => void }} [options]
 * @returns {Promise<string|null>} the session id, when one was created
 */
async function driveOneSession(ctx, options = {}) {
  const prompt = options.burst ? 'SOAK_BURST slow-client probe' : 'soak probe';
  const created = await apiCall(ctx.baseUrl, ctx.token, '/api/providers/sessions', {
    provider: 'claude', projectPath: ctx.projectDir, initialMessage: '',
  }, { timeoutMs: 20_000, onToken: ctx.onToken });
  const sessionId = /** @type {{ data?: { sessionId?: string } }} */ (created.json)?.data?.sessionId;
  if (created.status !== 201 || typeof sessionId !== 'string') return null;
  ctx.actions.sessionsCreated += 1;

  const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${encodeURIComponent(ctx.token)}`);
  /** @type {string[]} */
  const kinds = [];
  ws.on('message', (raw) => {
    try {
      const frame = JSON.parse(String(raw));
      if (typeof frame.kind === 'string') kinds.push(frame.kind);
    } catch {
      // A frame we cannot parse is not a reason to stop the leg.
    }
  });
  const opened = await new Promise((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('error', () => resolve(false));
    setTimeout(() => resolve(false), 15_000);
  });
  if (!opened) return sessionId;
  // Subscribed before the send, so the session is already streaming into this socket when the run
  // starts: that ordering is what makes the slow-client leg's backlog attributable.
  if (options.subscribe) options.subscribe(sessionId);
  ctx.actions.chatSends += 1;
  try {
    ws.send(JSON.stringify({
      type: 'chat.send', sessionId, content: prompt,
      options: { cwd: ctx.projectDir, permissionMode: 'default' },
    }));
  } catch {
    // The socket can be gone; the run is simply not counted as completed below.
  }

  const sentAt = Date.now();
  const deadline = sentAt + 90_000;
  let aborted = false;
  while (Date.now() < deadline) {
    if (kinds.includes('complete')) break;
    if (!aborted && options.abort && Date.now() - sentAt > 6_000) {
      aborted = true;
      ctx.actions.aborts += 1;
      try {
        ws.send(JSON.stringify({ type: 'chat.abort', sessionId }));
      } catch {
        // ignore
      }
    }
    await sleep(250);
  }
  if (kinds.includes('complete')) ctx.actions.runsCompleted += 1;
  try {
    ws.close(1000);
  } catch {
    // ignore
  }
  return sessionId;
}

/**
 * The session leg: keep sessions in flight so session scopes churn while the sampler watches. The
 * FIRST session carries the burst marker (the slow client's source of data); every fourth is aborted
 * mid-run, which is the path that leaves `abortedSessionIds` entries behind.
 *
 * WHY THE BURST IS ONE SESSION AND NOT EVERY THIRD — the harness's own ceiling at `--burst-mb 512`.
 * The burst is the differential's SUBJECT: it is what fills the socket the slow client is supposed
 * to wedge, and one stream is what the hypothesis needs. Marking every third session instead makes
 * the burst the WORKLOAD, and the instrument cannot afford that: the server holds O(burst) per
 * in-flight reply, so at 512MiB a third of the (capped) in-flight slots are permanently occupied by
 * multi-minute relays. Measured with the burst on every third session at `--burst-mb 512`:
 * `sessionStartsDeferred=150`, 31 sessions offered in the ~67s before the server's own heap ran out
 * (`FATAL ERROR: Reached heap limit`), in BOTH arms — i.e. the OOM is the relay volume, not the
 * wedged client, so the arm that was supposed to be the control died identically and the pair
 * measured nothing. The same every-third policy at 48MiB is why the doc's earlier pair recorded only
 * 156/174 sessions against a 500ms interval that allows 240: the arrivals are interval-bound, the
 * cap is what binds. With the burst confined to one session the session count stops being a function
 * of `--burst-mb`, which is exactly the "instrument ceiling lifted" reading AC1 asks for.
 *
 * @param {LegContext} ctx
 * @param {(sessionId: string) => void} onBurstSession
 * @param {number} durationSeconds
 */
async function runSessionLeg(ctx, onBurstSession, durationSeconds) {
  const until = Date.now() + durationSeconds * 1000;
  let iteration = 0;
  /** @type {Set<Promise<unknown>>} */
  const inFlight = new Set();
  // PINNED OFFERED LOAD, and why it is not "as fast as the server answers". The first version of
  // this leg started the next session as soon as any in-flight one settled, which made the number of
  // sessions in a fixed window a function of the HOST's speed: the same driver and the same 120s
  // produced 227 sessions on one run (0.53s apart) and 582 on another (0.21s apart) purely because
  // the second host was faster. Sessions are what this workload's memory scale is proportional to
  // (measured: ~5.2MB of peak RSS and ~145KiB of live set per session), so an unpinned rate makes
  // every threshold in soak-analyze.mjs a reading of the host, not of the server — the hot run
  // crossed the RSS slope backstop at 24.3MB/s purely by driving 2.6x the sessions. So sessions are
  // now started on a fixed interval, and concurrency is capped: the offered load is the same number
  // on a fast host and a slow one, which is what makes a threshold derived from a baseline run mean
  // anything. `sessionStartsDeferred` counts the ticks the cap swallowed, so a run that hit the
  // ceiling says so instead of quietly driving less than the interval asked for.
  while (!ctx.stop && Date.now() < until) {
    if (inFlight.size >= ctx.sessionMaxConcurrent) {
      ctx.actions.sessionStartsDeferred += 1;
    } else {
      const burst = iteration === 0;
      const abort = iteration % 4 === 3;
      iteration += 1;
      const promise = driveOneSession(ctx, { burst, abort, subscribe: burst ? onBurstSession : undefined })
        .catch(() => null)
        .finally(() => inFlight.delete(promise));
      inFlight.add(promise);
    }
    await sleep(ctx.sessionIntervalMs);
  }
  await Promise.allSettled([...inFlight]);
}

/**
 * A websocket client that closes cleanly, and one that is left half-open: the TCP connection is
 * established and a partial upgrade request is written, and then nothing — the server waits for a
 * request that never completes.
 *
 * @param {LegContext} ctx
 * @param {number} durationSeconds
 */
async function runConnectionLeg(ctx, durationSeconds) {
  const until = Date.now() + durationSeconds * 1000;
  while (!ctx.stop && Date.now() < until) {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws?token=${encodeURIComponent(ctx.token)}`);
    const opened = await new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    if (opened) {
      ws.close(1000);
      ctx.actions.wsNormalCloses += 1;
    }

    const socket = net.connect(ctx.port, '127.0.0.1');
    socket.on('error', () => {});
    socket.write(`GET /ws?token=${encodeURIComponent(ctx.token)} HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`);
    ctx.actions.wsHalfOpen += 1;
    await sleep(2_000);
    socket.destroy();
    await sleep(500);
  }
}

/**
 * A client-to-server websocket frame. Client frames MUST be masked (RFC 6455 §5.3); the server
 * closes the connection otherwise, which would turn this leg into "a client that never subscribed".
 *
 * @param {string} text
 * @returns {Buffer}
 */
function encodeMaskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.from([0x81, 0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/**
 * The slow client. One raw TCP socket, a hand-built websocket handshake, one hand-masked
 * `chat.subscribe` frame — and then no read at all, for the whole window. This is deliberately NOT
 * a `ws` client: the point of the leg is to leave the bytes in the kernel and in the server's
 * user-space send queue, and any library that reads would drain them.
 *
 * The socket's own liveness is recorded (`closedBeforeDeadline`): if the server reaps a client that
 * never drains, the hypothesis "unbounded send buffer" is answered by the server's own behaviour,
 * and that must show up as a reading rather than as a mysterious absence of growth.
 *
 * `drains` turns the same leg into its own control arm: identical socket, identical handshake,
 * identical subscribe, identical window — but the bytes are consumed. It exists because a heap
 * reading cannot attribute anything on its own: two runs that differ ONLY in consumption differ in
 * exactly one term, and the drained byte count is the positive control that says the server really
 * did push the burst (a stalled socket that the server never wrote to proves nothing).
 *
 * @param {LegContext} ctx
 * @param {string} sessionId the burst session to subscribe to
 * @param {number} seconds how long to stay wedged
 * @param {number} bytesExpected the burst size, recorded so the reading can be attributed
 * @param {boolean} drains read the socket instead of leaving it paused (the control arm)
 */
async function runSlowClient(ctx, sessionId, seconds, bytesExpected, drains) {
  const socket = net.connect(ctx.port, '127.0.0.1');
  socket.on('error', () => {});
  let closed = false;
  socket.on('close', () => {
    closed = true;
  });
  const key = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 1)).toString('base64');
  socket.write(
    `GET /ws?token=${encodeURIComponent(ctx.token)} HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${ctx.port}\r\n`
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  // Written before the 101 is read on purpose: the server's ws library pauses the socket until the
  // handshake completes, so this frame waits for the upgrade rather than racing it.
  socket.write(encodeMaskedTextFrame(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId, lastSeq: 0 }] })));
  // The control arm reads; the hypothesis arm does the opposite. The comment below is the hypothesis
  // arm's whole point, and the drain arm exists only to prove that what it leaves behind is the
  // unread bytes rather than the workload.
  if (drains) {
    socket.on('data', (chunk) => {
      ctx.actions.slowClientDrainedBytes += chunk.length;
    });
  } else {
    // No 'data' listener is ever attached and the socket is never resumed: nothing reads. Attaching
    // 'close'/'error' does not resume a paused socket.
    socket.pause();
  }
  ctx.actions.slowClients += 1;
  ctx.actions.slowClientBurstBytes += bytesExpected;
  /** @type {Record<string, unknown>} */
  const window = {
    label: 'slow-client', sessionId, seconds, bytesExpected, drains,
    startedAt: new Date().toISOString(), closedBeforeDeadline: false,
  };
  ctx.windows.push(window);
  await sleep(seconds * 1000);
  window.closedBeforeDeadline = closed;
  window.endedAt = new Date().toISOString();
  socket.destroy();
}

/**
 * The transcript leg: append real-shaped JSONL lines to a Claude transcript, and keep growing ONE
 * file toward `--max-transcript-mb`. The first line carries `cwd`, because that is the field the
 * sessions watcher reads to decide whether the file is a session at all.
 *
 * @param {LegContext} ctx
 * @param {string} transcriptsDir
 * @param {number} maxMb
 * @param {number} durationSeconds
 */
async function runTranscriptLeg(ctx, transcriptsDir, maxMb, durationSeconds) {
  // A stable UUID-shaped id, so the file name is what the real scanner expects to see.
  const sessionId = '9f1c8c62-1000-4000-8000-00000000a501';
  const bucket = ctx.projectDir.replace(/[^a-zA-Z0-9]/g, '-');
  await fsp.mkdir(path.join(transcriptsDir, bucket), { recursive: true });
  const filePath = path.join(transcriptsDir, bucket, `${sessionId}.jsonl`);
  const maxBytes = maxMb * MIB;
  const until = Date.now() + durationSeconds * 1000;
  let written = 0;
  let line = 0;
  // 2000 lines (~320 KiB) per second: the 100MB mark is passed inside the DoD's 30-minute run and
  // not inside the 120-second AC run, which is the difference between the two runs' transcript load.
  const chunkLines = 2000;
  while (!ctx.stop && Date.now() < until) {
    /** @type {string[]} */
    const lines = [];
    for (let i = 0; i < chunkLines; i += 1) {
      line += 1;
      lines.push(JSON.stringify({
        parentUuid: line === 1 ? null : `line-${line - 1}`,
        isSidechain: false,
        userType: 'external',
        cwd: ctx.projectDir,
        sessionId,
        version: '1.0.0',
        type: line % 2 === 0 ? 'assistant' : 'user',
        message: {
          role: line % 2 === 0 ? 'assistant' : 'user',
          content: [{ type: 'text', text: `soaksearch marker line ${line} ${'y'.repeat(64)}` }],
        },
        uuid: `line-${line}`,
        timestamp: new Date().toISOString(),
      }));
    }
    const payload = `${lines.join('\n')}\n`;
    try {
      await fsp.appendFile(filePath, payload);
      const bytes = Buffer.byteLength(payload);
      ctx.actions.transcriptLinesAppended += chunkLines;
      ctx.actions.transcriptBytesAppended += bytes;
      written += bytes;
    } catch {
      // A write that fails is retried next tick; the counts above record only what landed.
    }
    await sleep(written >= maxBytes && written > 0 ? 5000 : 1000);
  }
}

/**
 * The search leg: fire the real conversation-search endpoint (SSE) and read it to completion. The
 * count is what AC-3 checks; the match count is recorded because it is the reading that says the
 * search actually had work to do.
 *
 * @param {LegContext} ctx
 * @param {number} durationSeconds
 */
async function runSearchLeg(ctx, durationSeconds) {
  const until = Date.now() + durationSeconds * 1000;
  while (!ctx.stop && Date.now() < until) {
    ctx.actions.searches += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${ctx.baseUrl}/api/providers/search/sessions?q=soaksearch&limit=20&token=${encodeURIComponent(ctx.token)}`, { signal: controller.signal });
      adoptRefreshedToken(response, ctx.onToken);
      const body = await response.text();
      for (const match of body.matchAll(/"totalMatches":(\d+)/g)) {
        ctx.actions.searchMatches = Math.max(ctx.actions.searchMatches, Number(match[1]));
      }
    } catch {
      // A timed-out or aborted scan is still a search that ran.
    } finally {
      clearTimeout(timer);
    }
    await sleep(6_000);
  }
}

/**
 * The PTY leg: open a shell websocket, let it produce output, close it. `plain-shell` is used
 * deliberately — this leg is about the PTY pool, not about a model.
 *
 * @param {LegContext} ctx
 * @param {number} durationSeconds
 */
async function runShellLeg(ctx, durationSeconds) {
  const until = Date.now() + durationSeconds * 1000;
  while (!ctx.stop && Date.now() < until) {
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/shell?token=${encodeURIComponent(ctx.token)}`);
    const opened = await new Promise((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    if (opened) {
      ws.send(JSON.stringify({ type: 'init', projectPath: ctx.projectDir, provider: 'plain-shell', cols: 80, rows: 24 }));
      await sleep(2_500);
      ctx.actions.shellPtyOpens += 1;
      try {
        ws.close();
        ctx.actions.shellPtyCloses += 1;
      } catch {
        // ignore
      }
    }
    await sleep(4_000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The two runs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sample` mode: no server, no agitation — just the sampler, pointed at a pid.
 *
 * @param {SampleModeOptions} options
 */
async function runSampleMode(options) {
  const startedAt = new Date().toISOString();
  const samples = await sampleThroughWindows({
    pid: options.pid, baseUrl: null, token: null, useStatus: false,
    warmupSeconds: options.warmupSeconds, durationSeconds: options.durationSeconds,
    cooldownSeconds: options.cooldownSeconds, intervalMs: options.intervalMs,
  }, null);
  const report = {
    schema: SOAK_SCHEMA,
    mode: 'sample',
    startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: options.durationSeconds,
    warmupSeconds: options.warmupSeconds,
    cooldownSeconds: options.cooldownSeconds,
    samplingIntervalMs: options.intervalMs,
    target: { kind: 'pid', pid: options.pid, label: options.label, heapSource: null },
    samples,
    actions: emptyActions(),
    windows: [],
    notes: [
      'sample mode: no agitator and no server — the sampler and the analyzer are the same code path a real run uses',
      'the heap series is absent by design: /api/commands/execute /status needs a server, and a stub is not one',
    ],
  };
  const verdict = await finishReport(report, { report: options.report }, {
    requiredSeries: ['rssBytes', 'fdCount', 'childCount', 'sessionScopeCount'],
    requiredActions: [],
  });
  process.stdout.write(`soak-driver: sample target=${options.label} pid=${options.pid}\n`);
  process.exit(verdict.ok ? 0 : 1);
}

/**
 * `drive` mode: the real run against a real server.
 *
 * @param {DriveModeOptions} options
 */
async function runDriveMode(options) {
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
  const startedAt = new Date().toISOString();
  const actions = emptyActions();
  /** @type {Array<Record<string, unknown>>} */
  const windows = [];

  /** @type {{ value: string }} */
  const current = { value: token };
  const onToken = (/** @type {string} */ next) => {
    if (next) current.value = next;
  };

  // Resolve the target pid through /status before anything else, so the very first samples are of
  // the server rather than of a guess; a server that cannot answer is a harness error, not a red run.
  const first = await fetchStatus(options.baseUrl, token, onToken);
  if (first === null) fatal(`the server at ${options.baseUrl} did not answer /api/commands/execute /status — is it up and is the token valid?`);
  options.pid = first.pid;
  if (current.value !== token) fs.writeFileSync(options.tokenFile, current.value);

  const legCtx = createLegContext({
    baseUrl: options.baseUrl, token: current.value, projectDir: options.projectDir, port: options.port, onToken,
    sessionIntervalMs: options.sessionIntervalMs, sessionMaxConcurrent: options.maxConcurrentSessions,
  });
  legCtx.actions = actions;
  legCtx.windows = windows;
  /** @type {string|null} */
  let burstSession = null;

  const driveEndsAt = Date.now() + (options.warmupSeconds + options.durationSeconds) * 1000;
  const originMs = Date.now();
  /** @type {Array<Record<string, unknown>>} */
  const gcProbes = [];
  // The GC prober is created only when a diagnostic directory was supplied: without one there is
  // nowhere for V8 to write the snapshot, and a probe that cannot fire must not look like one that
  // did (the analyzer SKIPs the live-heap rule and says so in the report). `--gc-probe-interval 0`
  // turns the probes off explicitly, for a run that wants the unperturbed raw series.
  const gcProber = options.diagnosticDir === null || options.gcProbeIntervalSeconds <= 0 ? null : createGcProber({
    diagnosticDir: options.diagnosticDir,
    originMs,
    firstProbeAtMs: options.warmupSeconds * 1000,
    intervalSeconds: options.gcProbeIntervalSeconds,
    pid: options.pid,
    createdSessions: () => /** @type {number} */ (actions.sessionsCreated ?? 0),
    readHeapUsed: async () => (await fetchStatus(options.baseUrl, current.value, onToken))?.heapUsedBytes ?? null,
  });
  const samples = await sampleThroughWindows({
    pid: options.pid, baseUrl: options.baseUrl, token: current.value, useStatus: true,
    warmupSeconds: options.warmupSeconds, durationSeconds: options.durationSeconds,
    cooldownSeconds: options.cooldownSeconds, intervalMs: options.intervalMs,
  }, async (sample) => {
    // The legs run for the drive window; each is stopped by `stop` and then awaited, so a leg that
    // is mid-something does not leak into the cool-down window's reading.
    const legs = [
      runSessionLeg(legCtx, (sessionId) => { burstSession = sessionId; }, options.durationSeconds),
      runConnectionLeg(legCtx, options.durationSeconds),
      runTranscriptLeg(legCtx, options.transcriptDir, options.maxTranscriptMb, options.durationSeconds),
      runSearchLeg(legCtx, options.durationSeconds),
      runShellLeg(legCtx, options.durationSeconds),
      (async () => {
        // The slow client starts once a burst session exists — and only then, so its window really
        // contains a subscribed stream rather than an idle socket.
        const gate = Date.now() + Math.min(60_000, options.durationSeconds * 500);
        while (burstSession === null && Date.now() < gate && !legCtx.stop) await sleep(500);
        if (burstSession === null || legCtx.stop) return;
        await runSlowClient(legCtx, burstSession, options.slowClientSeconds, options.burstMb * MIB, options.slowClientDrains);
      })(),
    ];
    while (Date.now() < driveEndsAt) {
      await sleep(options.intervalMs);
      const entry = await sample();
      const window = windows.find((candidate) => candidate.label === 'slow-client');
      if (window && typeof entry.rssBytes === 'number') {
        window.rssPeakBytes = Math.max(/** @type {number} */ (window.rssPeakBytes ?? 0), entry.rssBytes);
      }
      if (gcProber !== null && gcProber.due()) {
        // Between ticks, never during one: the probe blocks on a snapshot write, and a sample that
        // straddled it would mix a settled heap with a churned one.
        gcProbes.push(await gcProber.probe(Number(entry.t.toFixed(3))));
      }
    }
    legCtx.stop = true;
    await Promise.allSettled(legs);
  });

  // The last probe is taken after the cool-down, so the leak rule compares the settled heap at the
  // start of agitation with the settled heap at the end of the run — including whatever the
  // agitation left behind.
  if (gcProber !== null) {
    const coolDownEnd = options.warmupSeconds + options.durationSeconds + options.cooldownSeconds;
    gcProbes.push(await gcProber.probe(coolDownEnd));
  }

  // Post-hoc readings for the slow-client window: what RSS was before it started, and the median it
  // settled at after the cool-down. These are the numbers the hypothesis conclusion is read from.
  const slowWindow = windows.find((candidate) => candidate.label === 'slow-client');
  const before = samples.filter((entry) => entry.t < options.warmupSeconds).map((entry) => entry.rssBytes).filter((value) => typeof value === 'number');
  const settled = samples.filter((entry) => entry.t >= options.warmupSeconds + options.durationSeconds).map((entry) => entry.rssBytes).filter((value) => typeof value === 'number');
  if (slowWindow) {
    slowWindow.rssBeforeBytes = before.length > 0 ? before[before.length - 1] : null;
    settled.sort((a, b) => /** @type {number} */ (a) - /** @type {number} */ (b));
    slowWindow.rssAfterBytes = settled.length > 0 ? settled[Math.floor(settled.length / 2)] : null;
  }

  const report = {
    schema: SOAK_SCHEMA,
    mode: 'drive',
    startedAt,
    endedAt: new Date().toISOString(),
    durationSeconds: options.durationSeconds,
    warmupSeconds: options.warmupSeconds,
    cooldownSeconds: options.cooldownSeconds,
    samplingIntervalMs: options.intervalMs,
    target: {
      kind: 'server',
      baseUrl: options.baseUrl,
      pid: options.pid,
      projectDir: options.projectDir,
      transcriptDir: options.transcriptDir,
      burstMb: options.burstMb,
      heapSource: 'POST /api/commands/execute {commandName:"/status"}',
      gcProbeIntervalSeconds: options.gcProbeIntervalSeconds,
      sessionIntervalMs: options.sessionIntervalMs,
      maxConcurrentSessions: options.maxConcurrentSessions,
      slowClientDrains: options.slowClientDrains,
      serverLog: options.serverLog,
    },
    samples,
    actions,
    windows,
    gcProbes,
    notes: options.notes,
  };
  const verdict = await finishReport(report, {
    report: options.report,
    diagnosticDir: options.diagnosticDir,
    preserveServerLog: options.serverLog,
  }, {
    requiredSeries: REQUIRED_SERIES,
    requiredActions: REQUIRED_ACTIONS,
  });
  process.exit(verdict.ok ? 0 : 1);
}

/**
 * Write the report, preserve the scene when the verdict is red, print the verdict, and (for a red
 * run) take a heap snapshot of the target so the scene is analysable after the fact.
 *
 * @param {Record<string, unknown>} report
 * @param {{ report: string, diagnosticDir?: string|null, preserveServerLog?: string|null }} options
 * @param {{ requiredSeries: string[], requiredActions: Array<{key: string, label: string}> }} analysis
 */
async function finishReport(report, options, analysis) {
  // The analyzer's contract is a plain object with samples/actions/warmup/duration; the report the
  // driver writes is that object plus provenance, so the cast is the whole interface between them.
  const typed = /** @type {import('./soak-analyze.mjs').SoakReport} */ (/** @type {unknown} */ (report));
  const verdict = analyzeSoakReport(typed, {
    requiredSeries: analysis.requiredSeries,
    requiredActions: analysis.requiredActions,
  });

  const reportPath = path.resolve(options.report);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  /** @type {Record<string, unknown>} */
  const scene = {};
  if (!verdict.ok) {
    // DoD item 6: on failure keep the scene. The last stretch of samples is already in the report;
    // the server log tail and a heap snapshot are what a later reader needs on top of it.
    scene.lastSamples = /** @type {unknown[]} */ (report.samples).slice(-40);
    if (options.preserveServerLog) {
      const tail = readTextFile(options.preserveServerLog);
      if (tail !== null) scene.serverLogTail = tail.split('\n').slice(-200).join('\n');
    }
    const pid = /** @type {{ pid?: number|null }} */ (report.target ?? {}).pid;
    if (typeof pid === 'number' && options.diagnosticDir) {
      scene.heapSnapshot = await takeHeapSnapshot(pid, options.diagnosticDir, reportPath);
    }
  }

  fs.writeFileSync(reportPath, `${JSON.stringify({
    ...report,
    verdict: { ok: verdict.ok, failures: verdict.failures, readings: verdict.readings },
    scene,
  }, null, 2)}\n`);

  for (const line of verdict.lines) process.stdout.write(`${line}\n`);
  process.stdout.write(`soak-driver: report written to ${reportPath}\n`);
  return verdict;
}

/**
 * Ask the target for a V8 heap snapshot (SIGUSR1 + `--heapsnapshot-signal`, which the soak unit
 * enables and the :3001 unit deliberately does not) and wait until the FILE IS COMPLETE.
 *
 * Two properties of that write shape every caller here:
 *   · V8 runs a FULL GC before serialising, so a snapshot is the only external lever this harness
 *     has for "what is still alive". The readings taken right after it are GC-SETTLED, which is what
 *     separates a real leak (live heap grows) from allocation churn (garbage the collector has not
 *     bothered to reclaim yet).
 *   · the file appears in the directory before it is finished, so "the file exists" is not "the
 *     snapshot is ready". A copy taken at that moment is 0-byte or truncated — observed for real on
 *     2026-09-25, when `ac3-report.json.heapsnapshot` came out EMPTY while the real 68MiB snapshot
 *     sat complete in the diagnostic directory. Hence the size-settle wait below.
 *
 * @param {number} pid
 * @param {string} diagnosticDir
 * @param {number} [timeoutMs]
 * @returns {Promise<{ path: string, bytes: number, ms: number }|null>}
 */
async function waitForHeapSnapshot(pid, diagnosticDir, timeoutMs = 120_000) {
  const started = Date.now();
  /** @type {Set<string>} */
  let before;
  try {
    before = new Set(fs.readdirSync(diagnosticDir));
  } catch {
    return null;
  }
  try {
    process.kill(pid, 'SIGUSR1');
  } catch {
    return null;
  }

  /** @type {string|null} */
  let found = null;
  while (Date.now() - started < timeoutMs) {
    let entry;
    try {
      entry = fs.readdirSync(diagnosticDir).find((name) => name.endsWith('.heapsnapshot') && !before.has(name));
    } catch {
      return null;
    }
    if (entry !== undefined) {
      found = path.join(diagnosticDir, entry);
      break;
    }
    await sleep(200);
  }
  if (found === null) return null;

  // Wait for the write to finish: two consecutive identical non-zero sizes. A writer that stalls
  // still gets judged by the byte count below rather than being handed on as a good snapshot.
  let last = -1;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    let size = 0;
    try {
      size = fs.statSync(found).size;
    } catch {
      return null;
    }
    if (size > 0 && size === last) {
      stable += 1;
      if (stable >= 2) break;
    } else {
      stable = 0;
    }
    last = size;
    await sleep(300);
  }
  if (stable < 2) return null;
  return { path: found, bytes: last, ms: Date.now() - started };
}

/**
 * Copy a COMPLETE heap snapshot next to the report. Best effort throughout: a soak that reds is
 * still a completed soak if the snapshot cannot be taken, but it never leaves a truncated file
 * behind pretending to be evidence.
 *
 * @param {number} pid
 * @param {string} diagnosticDir
 * @param {string} reportPath
 * @returns {Promise<string|null>}
 */
async function takeHeapSnapshot(pid, diagnosticDir, reportPath) {
  const shot = await waitForHeapSnapshot(pid, diagnosticDir);
  if (shot === null) {
    process.stdout.write('soak-driver: heap snapshot unavailable (no SIGUSR1 handler, or the write timed out)\n');
    return null;
  }
  try {
    const target = `${reportPath}.heapsnapshot`;
    fs.copyFileSync(shot.path, target);
    const copied = fs.statSync(target).size;
    if (copied !== shot.bytes) {
      fs.rmSync(target, { force: true });
      process.stdout.write(`soak-driver: heap snapshot copy came out short (${copied} of ${shot.bytes}B); discarded rather than kept as evidence\n`);
      return null;
    }
    process.stdout.write(`soak-driver: heap snapshot preserved at ${target} (${(copied / MIB).toFixed(1)}MiB, ${shot.ms}ms)\n`);
    return target;
  } catch {
    return null;
  }
}

/**
 * The live-set probe — the reading that decides LEAK versus CHURN.
 *
 * WHY IT EXISTS. The raw RSS/heap series cannot tell the two apart: V8 collects lazily, so under
 * heavy allocation churn `heapUsed` climbs for as long as the churn lasts and collapses only when
 * something forces a collection. The 2026-09-25 baseline showed `heapUsed` 60MB -> 788MB across one
 * 120s window with a fine linear fit (4.4-5.3MB/s, r2 0.95+) while the LIVE object graph over the
 * same window grew 43MB -> 76MB. A verdict built on the raw slope alone therefore has to be set so
 * loose that it stops being a leak detector.
 *
 * WHY A SNAPSHOT AND NOT "heapUsed after a forced GC". The heap counter right after a snapshot is
 * NOT a settled reading: the snapshot makes the collector run, and under this churn the heap has
 * refilled by hundreds of MB before the number can be read back over HTTP (measured: 92MB at one
 * probe, 291MB at the next, against snapshot files of 43MB and 51MB). The snapshot FILE has no such
 * problem — the writer walks the reachable object graph, so garbage is not in it whether or not the
 * collector has reclaimed it. The probe therefore judges the SNAPSHOT (its size and its node/edge
 * counts) and keeps the heap counter as context only.
 *
 * WHAT IT DOES. Every `intervalSeconds` (and once at the end of the cool-down) it asks the target
 * for a snapshot, waits for the file to be complete, reads its size and header counts, and records
 * how many sessions had been created by then — so the report can say whether the live set grew with
 * the WORKLOAD (per-session) or with TIME. Only the newest snapshot is kept on disk, so a 30-minute
 * run does not fill the work directory with 68MiB files.
 *
 * @param {{ diagnosticDir: string, originMs: number, firstProbeAtMs: number, intervalSeconds: number,
 *           readHeapUsed: () => Promise<number|null>, createdSessions: () => number, pid: number }} options
 */
function createGcProber(options) {
  let nextAt = options.originMs + options.firstProbeAtMs;
  /** @type {string|null} */
  let previousSnapshot = null;

  /**
   * @param {number} t seconds since the run started, on the sample series' own x axis
   * @returns {Promise<Record<string, unknown>>}
   */
  async function probe(t) {
    nextAt = Date.now() + options.intervalSeconds * 1000;
    const shot = await waitForHeapSnapshot(options.pid, options.diagnosticDir);
    if (shot === null) {
      return { t, heapUsedBytes: null, rssBytes: null, snapshotBytes: null, nodeCount: null, edgeCount: null, sessionsCreated: options.createdSessions(), note: 'no-snapshot' };
    }
    // The heap counter is read AFTER the snapshot on purpose, and it is labelled as the counter, not
    // as a settled heap: whatever the collector just freed can be garbage again by the time this
    // number arrives. The snapshot below is the settled reading.
    const heapUsedBytes = await options.readHeapUsed();
    const rssBytes = readRssBytes(options.pid);
    const counts = readSnapshotCounts(shot.path);
    if (previousSnapshot !== null && previousSnapshot !== shot.path) {
      fs.rmSync(previousSnapshot, { force: true });
    }
    previousSnapshot = shot.path;
    return {
      t,
      heapUsedBytes,
      rssBytes,
      snapshotBytes: shot.bytes,
      nodeCount: counts?.nodeCount ?? null,
      edgeCount: counts?.edgeCount ?? null,
      sessionsCreated: options.createdSessions(),
      snapshotMs: shot.ms,
      snapshotPath: shot.path,
    };
  }

  return {
    /** True when the interval has come round again. Checked between sampling ticks. */
    due() {
      return Date.now() >= nextAt;
    },
    probe,
  };
}

/**
 * The live-object counts from a V8 heap snapshot's header. V8 writes its metadata first — a few
 * hundred bytes of `"node_count":N,"edge_count":M` — so this reads the head of the file instead of
 * parsing tens of MB of JSON. Best effort: a future format that moves those fields yields nulls
 * rather than a wrong number, and the caller then falls back to the snapshot's byte count.
 *
 * @param {string} snapshotPath
 * @returns {{ nodeCount: number, edgeCount: number }|null}
 */
function readSnapshotCounts(snapshotPath) {
  try {
    const fd = fs.openSync(snapshotPath, 'r');
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    fs.closeSync(fd);
    const text = head.subarray(0, read).toString('utf8');
    const nodes = /"node_count":(\d+)/.exec(text);
    const edges = /"edge_count":(\d+)/.exec(text);
    if (nodes === null) return null;
    return { nodeCount: Number(nodes[1]), edgeCount: edges === null ? 0 : Number(edges[1]) };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseFlags(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) throw new Error(`unexpected argument: ${item}`);
    const name = item.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function numberFlag(flags, name, fallback) {
  const raw = flags[name];
  if (raw === undefined || raw === true) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got ${String(raw)}`);
  return value;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} name
 * @returns {string}
 */
function requiredString(flags, name) {
  const raw = flags[name];
  if (typeof raw !== 'string' || raw === '') throw new Error(`--${name} is required`);
  return raw;
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} name
 * @returns {boolean}
 */
function boolFlag(flags, name) {
  const raw = flags[name];
  // `--flag` parses as `true`; `--flag true` would parse as the string, and both mean the same thing
  // to the caller. `--flag false` is a typo that must not read as "on".
  if (raw === undefined || raw === false) return false;
  if (raw === true || raw === 'true') return true;
  throw new Error(`--${name} takes no value`);
}

/**
 * @param {Record<string, string|boolean>} flags
 * @param {string} name
 * @returns {string|null}
 */
function optionalString(flags, name) {
  const raw = flags[name];
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

const USAGE = `usage:
  node scripts/soak-driver.mjs stub   --kind leak|steady [--retain-mb N]
  node scripts/soak-driver.mjs sample --pid <pid> --duration <s> --report <file> [--warmup <s>] [--cooldown <s>]
                                      [--sample-interval <ms>] [--label <text>]
  node scripts/soak-driver.mjs drive  --base-url <url> --token-file <file> --port <n> --project-dir <dir>
                                      --transcript-dir <dir> --duration <s> --report <file>
                                      [--warmup <s>] [--cooldown <s>] [--sample-interval <ms>]
                                      [--max-transcript-mb <n>] [--burst-mb <n>] [--slow-client-seconds <n>]
                                      [--slow-client-drains]
                                      [--session-interval-ms <n>] [--max-concurrent-sessions <n>]
                                      [--gc-probe-interval <s>] [--server-log <file>] [--diagnostic-dir <dir>]
  node scripts/soak-driver.mjs mock-gateway --port-file <file> [--port <n>] [--burst-mb <n>]
`;

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (mode) {
    case 'stub':
      await runStub(typeof flags.kind === 'string' ? flags.kind : 'leak', numberFlag(flags, 'retain-mb', 1));
      break;
    case 'mock-gateway':
      await runMockGateway(numberFlag(flags, 'port', 0), requiredString(flags, 'port-file'), numberFlag(flags, 'burst-mb', 4));
      break;
    case 'sample':
      await runSampleMode({
        pid: numberFlag(flags, 'pid', -1),
        warmupSeconds: numberFlag(flags, 'warmup', 5),
        durationSeconds: numberFlag(flags, 'duration', 30),
        cooldownSeconds: numberFlag(flags, 'cooldown', 8),
        intervalMs: numberFlag(flags, 'sample-interval', 500),
        report: requiredString(flags, 'report'),
        label: optionalString(flags, 'label') ?? 'pid',
      });
      break;
    case 'drive':
      await runDriveMode({
        baseUrl: requiredString(flags, 'base-url'),
        tokenFile: requiredString(flags, 'token-file'),
        port: numberFlag(flags, 'port', 0),
        projectDir: requiredString(flags, 'project-dir'),
        transcriptDir: requiredString(flags, 'transcript-dir'),
        warmupSeconds: numberFlag(flags, 'warmup', 20),
        durationSeconds: numberFlag(flags, 'duration', 120),
        cooldownSeconds: numberFlag(flags, 'cooldown', 24),
        intervalMs: numberFlag(flags, 'sample-interval', 5000),
        maxTranscriptMb: numberFlag(flags, 'max-transcript-mb', 100),
        burstMb: numberFlag(flags, 'burst-mb', 4),
        slowClientSeconds: numberFlag(flags, 'slow-client-seconds', 40),
        slowClientDrains: boolFlag(flags, 'slow-client-drains'),
        sessionIntervalMs: numberFlag(flags, 'session-interval-ms', SESSION_INTERVAL_MS),
        maxConcurrentSessions: numberFlag(flags, 'max-concurrent-sessions', SESSION_MAX_CONCURRENT),
        report: requiredString(flags, 'report'),
        serverLog: optionalString(flags, 'server-log'),
        diagnosticDir: optionalString(flags, 'diagnostic-dir'),
        gcProbeIntervalSeconds: numberFlag(flags, 'gc-probe-interval', 30),
        pid: flags.pid === undefined ? null : numberFlag(flags, 'pid', -1),
        notes: [],
      });
      break;
    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`soak-driver: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
