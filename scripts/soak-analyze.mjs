#!/usr/bin/env node
// soak-analyze.mjs — the PURE half of the soak harness (gap-server-soak-harness).
//
// It turns a soak REPORT (samples + agitator action counts, written by scripts/soak-driver.mjs)
// into a verdict, and it does it with no I/O, no clock and no process inspection of its own: every
// number it reads arrives in the report. That is what makes the criterion falsifiable — the same
// code path judges the real 30-minute server run and the two synthetic stubs of
// `bash scripts/soak.sh --self-test` (one leaking, one steady), so a harness that is green
// "whatever happens" cannot pass both.
//
// WHAT IS BEING DECIDED, and why each check has the shape it has:
//
//   · SLOPE (rss, heap) — a leak is a trend, not a level. A server that sits at 900MB for an hour
//     is fine; one that climbs 5MB/min is not, however small its absolute number. So the check is
//     a least-squares slope over the samples taken DURING agitation, compared against a threshold
//     in bytes/second. The warmup window is excluded (AC-e): a cold server's first minutes are
//     caches filling and code warming, which is growth with a ceiling, not a leak.
//   · LIVE SET (the probes) — the sharp leak rule. The raw slopes above cannot separate a leak from
//     uncollected garbage, because V8 collects lazily and heavy churn leaves hundreds of MB of
//     reclaimable heap on the books. Each probe triggers a heap snapshot (V8's SIGUSR1 signal) and
//     reads the RESULTING FILE: a snapshot is built by walking the reachable graph, so garbage is
//     excluded whether or not a collection ran — which the heap counter read after the same signal
//     is NOT (measured: 92MB at one probe, 291MB at the next, on one run). Growth in the snapshot's
//     live set is retention; the raw heap/RSS series are carried beside it as context only. The
//     budget has two halves, because a long run's live set legitimately grows with the number of
//     sessions it created. See DEFAULT_THRESHOLDS.
//   · RESIDUAL (fd, threads, children, session scopes) — these are counts that should RETURN. A
//     leak here is not a slope but a failure to come back down: after agitation stops and the
//     system cools, the count must sit within a tolerance of the pre-agitation baseline. A slope
//     would be the wrong instrument: these counts are step functions (a scope is created whole),
//     so their regression slope is dominated by when the last one happened to start.
//   · TARGET LIFETIME — judged before either of the above: while the target process is gone, every
//     series reads "too few samples", and that wording hides the event behind a sampling problem.
//     A run of unreadable ticks is reported as the process disappearing, with the tick it happened.
//
// Both verdict shapes print ONE line carrying the series name, the reading, the threshold and the
// cause — the repo's criterion convention — so a reader of the log never has to reconstruct which
// series was over which line.
//
// THRESHOLDS ARE MEASURED, NOT GUESSED. Every entry of DEFAULT_THRESHOLDS carries the run it came
// from in its comment. The noise floor is what a STEADY server produces over the same window; the
// published thresholds are a documented multiple of it. See docs/operations/process-isolation-and-memory-caps.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One sampling tick. A null reading means "not obtainable this tick" and drops the tick from that series only. */
/**
 * @typedef {object} Sample
 * @property {number} t seconds since the sampling started (the series' x axis)
 * @property {number|null} [rssBytes]
 * @property {number|null} [vmHwmBytes]
 * @property {number|null} [heapUsedBytes]
 * @property {number|null} [heapLimitBytes]
 * @property {number|null} [fdCount]
 * @property {number|null} [threadCount]
 * @property {number|null} [childCount]
 * @property {number|null} [cgroupMemoryBytes]
 * @property {number|null} [sessionScopeCount]
 * @property {number|null} [targetPid]
 */

/**
 * @typedef {object} GcProbe
 * @property {number} t seconds since the run started, on the sample series' own x axis
 * @property {number|null} [snapshotBytes] size of the live-object graph V8 wrote (the settled reading)
 * @property {number|null} [nodeCount] live objects in it, from the snapshot header
 * @property {number|null} [edgeCount] references between them
 * @property {number|null} [heapUsedBytes] the target's heap counter read after the snapshot (context only)
 * @property {number|null} [rssBytes]
 * @property {number|null} [sessionsCreated] agitator sessions created by the time of this probe
 * @property {number|null} [snapshotMs]
 * @property {string|null} [snapshotPath]
 * @property {string} [note]
 */

/**
 * @typedef {object} SoakReport
 * @property {string} [schema]
 * @property {number} [durationSeconds]
 * @property {number} [warmupSeconds]
 * @property {number} [samplingIntervalMs]
 * @property {Sample[]} samples
 * @property {GcProbe[]} [gcProbes]
 * @property {Record<string, number>} [actions]
 * @property {string[]} [notes]
 */

/**
 * @typedef {object} Thresholds
 * @property {number} rssBytesPerSecond
 * @property {number} heapUsedBytesPerSecond
 * @property {number} threadCountPerSecond
 * @property {number} fdCountResidual
 * @property {number} childCountResidual
 * @property {number} sessionScopeCountResidual
 * @property {number} liveSetGrowthBytes
 * @property {number} liveSetBytesPerSession
 */

/**
 * The thresholds. Each is a multiple of a measured noise floor; the derivation and the run it came
 * from are in the comment beside it. `scripts/soak-analyze.mjs --calibrate --report <file>` reprints
 * the observed slopes of any report, so these can be re-derived from a fresh measurement rather than
 * re-guessed. Every number quoted below was printed by that command against three 120s runs of
 * `bash scripts/soak.sh --duration 120` (2026-09-25, real server on a temp DB/HOME, real `claude`
 * CLI behind the mock gateway): `~/.soak/baseline-{a,b}.json` and `~/.soak/baseline-c.json`.
 *
 * THRESHOLDS ARE ONLY MEANINGFUL UNDER A PINNED LOAD, which is why the session leg starts sessions
 * on a fixed interval (see runSessionLeg in soak-driver.mjs). The workload's memory scale is the
 * number of sessions driven — measured ~5.2MB of peak RSS and ~148KiB of live set per session — so
 * an agitator that starts the next session whenever the last one settles measures the HOST: the same
 * driver and the same 120s produced 227 sessions on one run and 582 on a faster host, and the hot
 * run crossed a 10MiB/s RSS backstop at 24.3MB/s purely from driving 2.6x the work. baseline-c is
 * the same command under the pinned interval: 240 sessions, matching baseline-a's 227.
 *
 * THE TWO KINDS OF THRESHOLD, and why the raw ones are as loose as they are. The raw RSS/heap slopes
 * are measured on a series that includes UNCOLLECTED GARBAGE: V8 collects lazily, so during the
 * spec'd agitation (transcript lines appended at ~2000/s into a jsonl that reached 105.1MB, which
 * the sessions watcher re-reads on every change) `heapUsed` climbs to many times the live heap and
 * only collapses when something forces a collection. The measured slopes are 6.42/6.51/7.43MB/s of
 * RSS and 5.30/5.30/6.32MB/s of heap — real allocation churn, and provably not retained: the
 * snapshots taken inside the same runs show a live object graph of 41-77MiB while the heap counter
 * reads up to 824MiB, i.e. the raw series is ~11x the live set. Those two series therefore carry a
 * GROSS BACKSTOP only, and the sharp leak judgement is the LIVE-SET probe below, whose noise floor
 * is the live graph's own drift rather than the collector's schedule.
 *
 * @type {Thresholds}
 */
export const DEFAULT_THRESHOLDS = {
  // Published at 12MiB/s (12.58MB/s = 755MB/min): 1.69x the highest measured RSS slope (6.42, 6.51,
  // 7.43MB/s; r2 0.90/0.91/0.91 — churn, not retention). It catches a gross leak (the AC-2 stub at
  // 32MiB/s is 2.67x over it) and deliberately does NOT try to resolve a slow leak: that is the
  // live-set rule's job, and pretending the raw series could do it is what made the first version of
  // this table cry wolf on every healthy run.
  rssBytesPerSecond: 12582912,
  // Same runs: heap slopes 5297481.12, 5300458.07 and 6321788.62 B/s (r2 0.96/0.95/0.98) — the
  // collector's sawtooth, identical in shape to the RSS one. Published at 1.99x the highest.
  heapUsedBytesPerSecond: 12582912,
  // Thread counts move in whole units and only when a pool grows; the steady run showed a net 0
  // over the window. 1 thread per 20s over the drive window is the smallest rate this can resolve.
  threadCountPerSecond: 0.05,
  // Residual tolerances, in COUNT units, not rates. Generous enough for watchers/pool refills that
  // legitimately outlive the agitation, tight enough that a per-session leak of one fd each shows.
  // Measured drifts (min->max inside the window), pinned runs first: fds 7/12/12, children 1/4/3,
  // session scopes 1/4/3 (the unpinned run reached 10-12 because its concurrency was unbounded).
  fdCountResidual: 16,
  childCountResidual: 4,
  sessionScopeCountResidual: 1,
  // Live-object graph written by the target's snapshots: the FLOOR is the growth a run may show
  // whatever else happens, in BYTES, first probe -> last probe. Measured: baseline-a 40.96MiB ->
  // 72.41MiB (+31.45MiB), baseline-b 41.01MiB -> 71.56MiB (+30.54MiB), baseline-c 41.38MiB ->
  // 74.14MiB (+32.76MiB), 5 probes each, all over ~227-240 sessions. Published at 4.03x the largest,
  // so a run whose live set quadruples the measured drift reds even if it created no sessions.
  liveSetGrowthBytes: 138412032,
  // The per-session allowance, in BYTES per session created between the first and last probe.
  // Measured: baseline-b +30.54MiB over 11 -> 227 sessions = 144.8KiB/session, baseline-c +32.76MiB
  // over 13 -> 240 sessions = 147.8KiB/session, at 506k-929k live objects. (baseline-a predates the
  // node/session fields on probes, so it cannot be quoted here — which is itself why the allowance
  // is generous.) Published at 3.46x the measured cost. This is what keeps a LONG run honest: a
  // server may keep an open session's state (that is its job), so the budget grows with the
  // workload — but not without limit, and the measured cost is printed beside it in every verdict.
  liveSetBytesPerSession: 524288,
};

/** A series must have at least this many samples inside its window, else the run cannot be judged. */
export const MIN_SERIES_SAMPLES = 20;

/**
 * Consecutive drive-window ticks whose RSS cannot be read before the target counts as GONE.
 *
 * One unreadable tick is tolerated (a transient /proc read or a pid that just moved); a run of them
 * is not a sampling problem, it is a dead process. The distinction matters because the two produce
 * the same symptom — a series with too few points — and the under-sampled reading is the misleading
 * one: it sends the reader after the sampler when the event was the server exiting. Observed for
 * real in the 2026-09-25 run whose server died at t=100s of a 120s window (see
 * docs/operations/process-isolation-and-memory-caps.md).
 */
export const MIN_TARGET_GONE_TICKS = 2;

/**
 * The agitator actions whose count must be non-zero for the run to mean anything: a report whose
 * "sessions" column reads 0 is a harness that drove nothing, and a green from it is the
 * "green that cannot go red" the repo's criteria forbid.
 */
export const REQUIRED_ACTIONS = [
  { key: 'sessionsCreated', label: '会话数' },
  { key: 'slowClients', label: '慢客户端数' },
  { key: 'transcriptLinesAppended', label: '追加行数' },
  { key: 'searches', label: '搜索次数' },
];

/** Series definitions: how each sampled column is judged. `slope` in units/second, `residual` in units. */
export const SERIES = [
  { key: 'rssBytes', label: 'rss', kind: 'slope', threshold: 'rssBytesPerSecond', unit: 'B/s' },
  { key: 'heapUsedBytes', label: 'heapUsed', kind: 'slope', threshold: 'heapUsedBytesPerSecond', unit: 'B/s' },
  { key: 'threadCount', label: 'threads', kind: 'slope', threshold: 'threadCountPerSecond', unit: '/s' },
  { key: 'fdCount', label: 'fds', kind: 'residual', threshold: 'fdCountResidual', unit: '' },
  { key: 'childCount', label: 'children', kind: 'residual', threshold: 'childCountResidual', unit: '' },
  { key: 'sessionScopeCount', label: 'sessionScopes', kind: 'residual', threshold: 'sessionScopeCountResidual', unit: '' },
];

/** Columns the report must contain; a run that cannot produce one of these cannot be judged. */
export const REQUIRED_SERIES = ['rssBytes', 'fdCount', 'childCount', 'sessionScopeCount'];

/**
 * Least-squares fit y = a + b·x.
 *
 * @param {Array<[number, number]>} points
 * @returns {{ slope: number, intercept: number, r2: number, n: number }}
 */
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? points[0][1] : 0, r2: 0, n };
  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of points) {
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of points) {
    const dx = x - meanX;
    const dy = y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  // A single distinct x (all samples at the same instant) has no slope to speak of; 0 is the
  // honest reading and keeps the caller's division-free path intact.
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: meanY - slope * meanX, r2, n };
}

/**
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {Sample[]} samples
 * @param {string} key
 * @returns {Array<[number, number]>}
 */
function seriesPoints(samples, key) {
  /** @type {Array<[number, number]>} */
  const points = [];
  for (const sample of samples) {
    const value = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (sample))[key];
    if (isFiniteNumber(sample.t) && isFiniteNumber(value)) points.push([sample.t, value]);
  }
  return points;
}

/**
 * When the target process disappeared, as the first tick of the first run of unreadable RSS samples
 * inside the drive window. `null` when the target was readable throughout (the normal case).
 *
 * @param {Sample[]} driveSamples
 * @returns {number|null}
 */
function firstTargetGoneAt(driveSamples) {
  /** @type {number|null} */
  let runStart = null;
  let run = 0;
  for (const sample of driveSamples) {
    if (isFiniteNumber(sample.rssBytes)) {
      runStart = null;
      run = 0;
      continue;
    }
    if (runStart === null) runStart = sample.t;
    run += 1;
    if (run >= MIN_TARGET_GONE_TICKS) return runStart;
  }
  return null;
}

/**
 * Look a threshold up by the name SERIES gives it. The cast exists only because SERIES is a table
 * of string keys: every name in it is a real key of Thresholds, and the analyzer's own unit test
 * walks the table, so a typo here shows up as a `undefined` threshold rather than as a silent pass.
 *
 * @param {Thresholds} thresholds
 * @param {string} key
 * @returns {number}
 */
function thresholdOf(thresholds, key) {
  return /** @type {Record<string, number>} */ (/** @type {unknown} */ (thresholds))[key];
}

/**
 * The window boundaries, taken from the report when present and derived from `durationSeconds`
 * otherwise. Returning them in one place keeps the "warmup is excluded" rule in exactly one spot.
 *
 * @param {SoakReport} report
 * @returns {{ warmupEnd: number, driveEnd: number }}
 */
function windows(report) {
  const warmupEnd = isFiniteNumber(report.warmupSeconds) ? report.warmupSeconds : 0;
  const duration = isFiniteNumber(report.durationSeconds) ? report.durationSeconds : 0;
  return { warmupEnd, driveEnd: warmupEnd + duration };
}

/** Human-readable bytes, so a verdict line is readable without arithmetic. */
/**
 * @param {number} bytes
 * @returns {string}
 */
function humanBytes(bytes) {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${sign}${(abs / (1024 * 1024)).toFixed(2)}MiB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)}KiB`;
  return `${sign}${abs}B`;
}

/**
 * @param {number} value
 * @param {number} digits
 * @returns {string}
 */
function fixed(value, digits) {
  return value.toFixed(digits);
}

/**
 * The per-session reading, when both ends of the probe series know their session count. It is how a
 * reader tells "the live set grows WITH THE WORKLOAD" (a roughly constant cost per session — what a
 * server caches on purpose) from "the live set grows WITH TIME" (a leak): the first has a bounded
 * per-session number, the second does not. Empty when either end cannot supply the counts.
 *
 * @param {GcProbe} first
 * @param {GcProbe} last
 * @returns {string}
 */
function perSessionLine(first, last) {
  const firstSessions = first.sessionsCreated;
  const lastSessions = last.sessionsCreated;
  if (!isFiniteNumber(firstSessions) || !isFiniteNumber(lastSessions)) return '';
  const added = lastSessions - firstSessions;
  if (added <= 0) return ` sessions=${firstSessions}->${lastSessions} perSession=n/a`;
  return ` sessions=${firstSessions}->${lastSessions} perSession=${humanBytes((/** @type {number} */ (last.snapshotBytes) - /** @type {number} */ (first.snapshotBytes)) / added)}`;
}

/**
 * Judge one report. Pure: same input, same verdict, same lines.
 *
 * @param {SoakReport} report
 * @param {{ thresholds?: Thresholds, minSamples?: number, requiredSeries?: string[], requiredActions?: Array<{key: string, label: string}> }} [options]
 * @returns {{
 *   ok: boolean,
 *   lines: string[],
 *   failures: string[],
 *   series: Array<Record<string, unknown>>,
 *   actions: Record<string, number>,
 *   readings: Record<string, number|null>,
 * }}
 */
export function analyzeSoakReport(report, options = {}) {
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const minSamples = options.minSamples ?? MIN_SERIES_SAMPLES;
  const requiredSeries = options.requiredSeries ?? REQUIRED_SERIES;
  const requiredActions = options.requiredActions ?? REQUIRED_ACTIONS;

  const samples = Array.isArray(report.samples) ? report.samples : [];
  const actions = report.actions ?? {};
  const { warmupEnd, driveEnd } = windows(report);

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const failures = [];
  /** @type {Array<Record<string, unknown>>} */
  const seriesResults = [];

  const driveSamples = samples.filter((sample) => sample.t >= warmupEnd && sample.t < driveEnd);
  const warmupSamples = samples.filter((sample) => sample.t < warmupEnd);
  const cooldownSamples = samples.filter((sample) => sample.t >= driveEnd);

  // The target must exist for the run to have measured anything. This is judged FIRST and named
  // explicitly, because every series below degrades into "样本不足" once the process is gone and
  // that wording blames the sampler for what the process did.
  const targetGoneAt = firstTargetGoneAt(driveSamples);
  if (targetGoneAt !== null) {
    const line = `soak-analyze: FAIL target=process — 目标进程自 t=${fixed(targetGoneAt, 1)}s 起连续 ${MIN_TARGET_GONE_TICKS} 次采样读不到（/proc/<pid> 消失），本次判红：进程消失后的斜率与残留都不成立，先查 server.log 尾部`;
    lines.push(line);
    failures.push(line);
  }

  for (const definition of SERIES) {
    const inDrive = seriesPoints(driveSamples, definition.key);
    const present = seriesPoints(samples, definition.key).length > 0;
    const isRequired = requiredSeries.includes(definition.key);
    const threshold = thresholdOf(thresholds, definition.threshold);

    if (!present || inDrive.length < minSamples) {
      const reason = !present
        ? `${definition.label} 序列在整份报告里一个读数都没有`
        : `${definition.label} 序列在驱动窗口内只有 ${inDrive.length} 个样本（< ${minSamples}）`;
      if (isRequired) {
        failures.push(`soak-analyze: FAIL series=${definition.label} — ${reason}，样本不足无法判定，本次判红`);
      }
      lines.push(`soak-analyze: SKIP series=${definition.label} — ${reason}${isRequired ? '' : '（非必需序列）'}`);
      seriesResults.push({ name: definition.label, key: definition.key, judged: false, reason });
      continue;
    }

    if (definition.kind === 'slope') {
      const { slope, r2 } = linearRegression(inDrive);
      const okSlope = Math.abs(slope) <= threshold;
      const line = okSlope
        ? `soak-analyze: OK   series=${definition.label} slope=${fixed(slope, 2)}${definition.unit} threshold=${fixed(threshold, 2)}${definition.unit} r2=${fixed(r2, 2)} n=${inDrive.length} — 驱动窗口内无超阈增长`
        : `soak-analyze: FAIL series=${definition.label} slope=${fixed(slope, 2)}${definition.unit} threshold=${fixed(threshold, 2)}${definition.unit} r2=${fixed(r2, 2)} n=${inDrive.length} — 斜率超阈，成因：驱动窗口内该序列单调增长且未回落（泄漏形态）`;
      lines.push(line);
      if (!okSlope) failures.push(line);
      const peak = inDrive.reduce((best, [, y]) => Math.max(best, y), -Infinity);
      seriesResults.push({
        name: definition.label, key: definition.key, kind: 'slope', judged: true, ok: okSlope,
        slope, slopePerSecond: slope, unit: definition.unit, threshold, r2, n: inDrive.length, peak,
      });
      continue;
    }

    // residual: the count after cooling must come back to the pre-agitation baseline.
    const baselineValues = seriesPoints(warmupSamples, definition.key).map(([, y]) => y);
    const cooldownValues = seriesPoints(cooldownSamples, definition.key).map(([, y]) => y);
    if (baselineValues.length === 0 || cooldownValues.length === 0) {
      const reason = `基线样本=${baselineValues.length}、冷却样本=${cooldownValues.length}，无法做回落判定`;
      if (isRequired) failures.push(`soak-analyze: FAIL series=${definition.label} — ${reason}，本次判红`);
      lines.push(`soak-analyze: SKIP series=${definition.label} — ${reason}`);
      seriesResults.push({ name: definition.label, key: definition.key, judged: false, reason });
      continue;
    }
    const baseline = median(baselineValues);
    const cooled = median(cooldownValues);
    const residual = cooled - baseline;
    const okResidual = residual <= threshold;
    const line = okResidual
      ? `soak-analyze: OK   series=${definition.label} residual=${fixed(residual, 2)} threshold=${fixed(threshold, 2)} baseline=${fixed(baseline, 2)} cooled=${fixed(cooled, 2)} n=${cooldownValues.length} — 冷却后已回到基线容差内`
      : `soak-analyze: FAIL series=${definition.label} residual=${fixed(residual, 2)} threshold=${fixed(threshold, 2)} baseline=${fixed(baseline, 2)} cooled=${fixed(cooled, 2)} n=${cooldownValues.length} — 冷却后残留超容差，成因：搅动停止后该计数没有回落（未释放）`;
    lines.push(line);
    if (!okResidual) failures.push(line);
    seriesResults.push({
      name: definition.label, key: definition.key, kind: 'residual', judged: true, ok: okResidual,
      baseline, cooled, residual, threshold, n: cooldownValues.length,
    });
  }

  // The LIVE-SET rule. Judged on the snapshot probes only, and SKIPped (never silently green) when
  // the report has none: a run that never took a snapshot cannot claim its live set was flat, and
  // saying so is the difference between an unmeasured reading and a passing one.
  //
  // The budget has two halves on purpose. The FLOOR is what an idle-ish run may grow by at all; the
  // PER-SESSION allowance is what the workload is allowed to explain. A leak that retains per unit
  // of time shows up against the floor (nothing else was happening), and a leak that retains per
  // session beyond what a session costs shows up against the allowance. Without the second half the
  // rule would red every long run for keeping OPEN sessions' state, which is what a server does.
  const probes = (Array.isArray(report.gcProbes) ? report.gcProbes : []).filter((probe) => isFiniteNumber(probe.snapshotBytes));
  const liveSetThreshold = thresholdOf(thresholds, 'liveSetGrowthBytes');
  const perSessionAllowance = thresholdOf(thresholds, 'liveSetBytesPerSession');
  /** @type {number|null} */
  let liveSetGrowthBytes = null;
  /** @type {number|null} */
  let liveSetBudgetBytes = null;
  if (probes.length >= 2) {
    const first = probes[0];
    const last = probes[probes.length - 1];
    liveSetGrowthBytes = /** @type {number} */ (last.snapshotBytes) - /** @type {number} */ (first.snapshotBytes);
    const firstSessions = isFiniteNumber(first.sessionsCreated) ? first.sessionsCreated : null;
    const lastSessions = isFiniteNumber(last.sessionsCreated) ? last.sessionsCreated : null;
    const sessionsAdded = firstSessions !== null && lastSessions !== null ? Math.max(0, lastSessions - firstSessions) : null;
    liveSetBudgetBytes = liveSetThreshold + (sessionsAdded === null ? 0 : perSessionAllowance * sessionsAdded);
    const okGrowth = liveSetGrowthBytes <= liveSetBudgetBytes;
    const measured = sessionsAdded !== null && sessionsAdded > 0 ? liveSetGrowthBytes / sessionsAdded : null;
    const reading = `first=${humanBytes(/** @type {number} */ (first.snapshotBytes))} last=${humanBytes(/** @type {number} */ (last.snapshotBytes))} growth=${humanBytes(liveSetGrowthBytes)} budget=${humanBytes(liveSetBudgetBytes)} floor=${humanBytes(liveSetThreshold)} allowance=${humanBytes(perSessionAllowance)}/session n=${probes.length}${perSessionLine(first, last)}`;
    const line = okGrowth
      ? `soak-analyze: OK   probe=live-set ${reading}${measured === null ? '' : ` measuredPerSession=${humanBytes(measured)}`} — 存活对象图在预算内增长，raw 序列的上升是未回收垃圾`
      : `soak-analyze: FAIL probe=live-set ${reading}${measured === null ? '' : ` measuredPerSession=${humanBytes(measured)}`} — 存活对象图超预算，成因：${sessionsAdded === null ? '报告缺 sessionsCreated 读数，按纯时间增长判（floor 已超）' : sessionsAdded === 0 ? '搅动期间没有新会话而对象图仍在涨（纯时间增长）' : `按新建会话数折算每会话 ${humanBytes(measured ?? 0)}，超过每会话额度（保留量不是工作量能解释的）`}，先看 server.log 尾部`;
    lines.push(line);
    if (!okGrowth) failures.push(line);
  } else {
    const why = probes.length === 0
      ? '报告里没有快照探针读数（未提供 --diagnostic-dir 或 --gc-probe-interval 0）'
      : `只有 ${probes.length} 次可用快照（< 2），首尾无法比较`;
    lines.push(`soak-analyze: SKIP probe=live-set — ${why}，存活对象图这一项本次未判定（不是通过）`);
  }

  // The read-only columns: not judged, but their peaks are what the operations doc quotes.
  const vmHwmValues = seriesPoints(samples, 'vmHwmBytes').map(([, y]) => y);
  const cgroupValues = seriesPoints(samples, 'cgroupMemoryBytes').map(([, y]) => y);
  const firstProbe = probes.length > 0 ? probes[0] : null;
  const lastProbe = probes.length > 0 ? probes[probes.length - 1] : null;
  const firstProbeNodes = firstProbe !== null && isFiniteNumber(firstProbe.nodeCount) ? firstProbe.nodeCount : null;
  const lastProbeNodes = lastProbe !== null && isFiniteNumber(lastProbe.nodeCount) ? lastProbe.nodeCount : null;
  const readings = {
    rssPeakBytes: seriesPoints(samples, 'rssBytes').reduce((best, [, y]) => Math.max(best, y), 0),
    vmHwmPeakBytes: vmHwmValues.length > 0 ? Math.max(...vmHwmValues) : null,
    heapUsedPeakBytes: seriesPoints(samples, 'heapUsedBytes').reduce((best, [, y]) => Math.max(best, y), 0),
    cgroupPeakBytes: cgroupValues.length > 0 ? Math.max(...cgroupValues) : null,
    sampleCount: samples.length,
    driveSampleCount: driveSamples.length,
    targetGoneAt,
    probeCount: probes.length,
    liveSetGrowthBytes,
    liveSetFirstBytes: firstProbe === null ? null : /** @type {number} */ (firstProbe.snapshotBytes),
    liveSetLastBytes: lastProbe === null ? null : /** @type {number} */ (lastProbe.snapshotBytes),
    liveNodesFirst: firstProbeNodes,
    liveNodesLast: lastProbeNodes,
  };
  lines.push(
    `soak-analyze: READ samples=${samples.length} drive=${driveSamples.length} rssPeak=${humanBytes(readings.rssPeakBytes)} vmHwmPeak=${readings.vmHwmPeakBytes === null ? 'n/a' : humanBytes(readings.vmHwmPeakBytes)} heapPeak=${humanBytes(readings.heapUsedPeakBytes)} cgroupPeak=${readings.cgroupPeakBytes === null ? 'n/a' : humanBytes(readings.cgroupPeakBytes)}`,
  );
  if (readings.probeCount > 0) {
    lines.push(
      `soak-analyze: READ probes=${readings.probeCount} liveSetFirst=${readings.liveSetFirstBytes === null ? 'n/a' : humanBytes(readings.liveSetFirstBytes)} liveSetLast=${readings.liveSetLastBytes === null ? 'n/a' : humanBytes(readings.liveSetLastBytes)} liveNodes=${readings.liveNodesFirst === null ? 'n/a' : readings.liveNodesFirst}->${readings.liveNodesLast === null ? 'n/a' : readings.liveNodesLast}`,
    );
  }

  for (const action of requiredActions) {
    const count = actions[action.key];
    if (!isFiniteNumber(count) || count <= 0) {
      const line = `soak-analyze: FAIL action=${action.key}(${action.label}) count=${String(count ?? 0)} — 该类动作一次都没跑，本次判红（装置没驱动起来，绿是没有意义的）`;
      lines.push(line);
      failures.push(line);
    } else {
      lines.push(`soak-analyze: OK   action=${action.key}(${action.label}) count=${count}`);
    }
  }

  const ok = failures.length === 0;
  lines.push(ok
    ? 'soak-analyze: VERDICT green — 全部判据通过（见上方逐序列读数）'
    : `soak-analyze: VERDICT red — ${failures.length} 条判据未过（见上方 FAIL 行）`);

  return { ok, lines, failures, series: seriesResults, actions: { ...actions }, readings };
}

/** Parse a report file. Throws with the path in the message — a missing report is a harness error, not a verdict. */
/**
 * @param {string} reportPath
 * @returns {SoakReport}
 */
export function readReport(reportPath) {
  const resolved = path.resolve(reportPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.samples)) {
    throw new Error(`${resolved}: not a soak report (no samples array)`);
  }
  return /** @type {SoakReport} */ (parsed);
}

/**
 * The calibration view: the same fits the verdict uses, printed for every column, so a threshold
 * can be re-derived from a fresh measurement instead of re-guessed.
 *
 * @param {SoakReport} report
 * @param {Thresholds} [thresholds]
 * @returns {string[]}
 */
export function calibrationLines(report, thresholds = DEFAULT_THRESHOLDS) {
  const { warmupEnd, driveEnd } = windows(report);
  const driveSamples = (report.samples ?? []).filter((sample) => sample.t >= warmupEnd && sample.t < driveEnd);
  /** @type {string[]} */
  const out = [`soak-analyze: CALIBRATION window=[${warmupEnd}s, ${driveEnd}s) n=${driveSamples.length}`];
  for (const definition of SERIES) {
    const points = seriesPoints(driveSamples, definition.key);
    if (points.length < 2) continue;
    const { slope, r2 } = linearRegression(points);
    if (definition.kind === 'slope') {
      out.push(`soak-analyze: CALIBRATION series=${definition.label} kind=slope slope=${fixed(slope, 2)}${definition.unit} r2=${fixed(r2, 2)} n=${points.length} currentThreshold=${thresholdOf(thresholds, definition.threshold)}`);
    } else {
      const values = points.map(([, y]) => y);
      out.push(`soak-analyze: CALIBRATION series=${definition.label} kind=residual min=${fixed(Math.min(...values), 1)} max=${fixed(Math.max(...values), 1)} drift=${fixed(values[values.length - 1] - values[0], 2)} n=${points.length} currentThreshold=${thresholdOf(thresholds, definition.threshold)}`);
    }
  }
  const probes = (report.gcProbes ?? []).filter((probe) => isFiniteNumber(probe.snapshotBytes));
  if (probes.length >= 2) {
    const first = probes[0];
    const last = probes[probes.length - 1];
    const firstBytes = /** @type {number} */ (first.snapshotBytes);
    const lastBytes = /** @type {number} */ (last.snapshotBytes);
    out.push(`soak-analyze: CALIBRATION probe=live-set t=[${fixed(first.t, 1)}, ${fixed(last.t, 1)}] first=${fixed(firstBytes, 0)} last=${fixed(lastBytes, 0)} growth=${fixed(lastBytes - firstBytes, 0)} n=${probes.length}${perSessionLine(first, last)} currentThreshold=${thresholdOf(thresholds, 'liveSetGrowthBytes')}`);
  }
  return out;
}

/**
 * @param {string[]} argv
 * @returns {{ report: string | null, calibrate: boolean, quiet: boolean, help: boolean }}
 */
function parseArgs(argv) {
  /** @type {{ report: string | null, calibrate: boolean, quiet: boolean, help: boolean }} */
  const args = { report: null, calibrate: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--help' || item === '-h') args.help = true;
    else if (item === '--calibrate') args.calibrate = true;
    else if (item === '--quiet') args.quiet = true;
    else if (item === '--report') {
      args.report = argv[i + 1] ?? null;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${item}`);
    }
  }
  return args;
}

/**
 * True only when this file is the process entry point. Node resolves `scripts/…` through the
 * symlink the worktree setup creates, so `process.argv[1]` is the symlinked path and a plain string
 * compare against `import.meta.url` would say "not main" — hence realpath on both sides. Without
 * this guard, importing the module to unit-test it would also run the CLI, and rewrite the
 * importer's exit code.
 *
 * @returns {boolean}
 */
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.report === null) {
      process.stderr.write('usage: node scripts/soak-analyze.mjs --report <soak-report.json> [--calibrate] [--quiet]\n');
      process.exit(args.help ? 0 : 2);
    }
    const report = readReport(args.report);
    if (args.calibrate) {
      for (const line of calibrationLines(report)) process.stdout.write(`${line}\n`);
    }
    const verdict = analyzeSoakReport(report);
    if (!args.quiet) {
      for (const line of verdict.lines) process.stdout.write(`${line}\n`);
    } else {
      process.stdout.write(`${verdict.lines[verdict.lines.length - 1]}\n`);
    }
    process.exit(verdict.ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`soak-analyze: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
