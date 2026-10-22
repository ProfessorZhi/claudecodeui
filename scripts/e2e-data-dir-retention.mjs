#!/usr/bin/env node
/**
 * Bounded retention for the e2e data directories — the reclaimer the selector deliberately did not
 * contain.
 *
 * THE DEFECT THIS EXISTS FOR. Every e2e run creates one throwaway directory under a shared parent
 * (`$HOME/.cache/quay-e2e-tmp`, or whichever candidate `scripts/e2e-data-dir-selection.mjs` picks)
 * and nothing ever removes it. Measured on this host on 2026-09-28, `~/.cache/quay-e2e-tmp` held
 * 1794 directories / 103 GB, every one of them created within the previous 24 hours — a pure
 * accumulation rate of roughly 100 GB/day with no reclaimer anywhere on the run path. The pool is a
 * *user quota*, not a filesystem size: `df` still reported 3.3 TB free on `/data` while four
 * different writes failed with `EDQUOT` (`errno -122`) — Playwright's transform-cache `open`, a
 * `copyfile` of the auth database, an `mkdtemp` of the next run's directory, and even the `.lock`
 * file `task_write` needs to record the damage. The last one is what makes this a criterion defect
 * rather than an inconvenience: the failure lands *before* the run starts, so a criterion that is
 * green in every respect is reported red by an exhausted quota, with the failure text naming a
 * scratch path none of its assertions mention.
 *
 * WHY IT IS A SEPARATE MODULE. `scripts/e2e-data-dir-selection.mjs` says, in its own header, that
 * recycling what an earlier run left behind "is deliberately not this module's job (a run that
 * cannot start is the condition worth failing on; housekeeping is a separate concern)". That
 * sentence is a correct statement about *that* module — choosing where a run goes is not the same
 * decision as how long it stays — and it is the reason this file exists rather than an edit there.
 * The "separate concern" it names is this one. The selector's selection semantics, its 15 cases and
 * its refusal text are untouched.
 *
 * WHAT IS DECIDED HERE, AND WHAT IS NOT. `selectReclaimableDirs` is the whole decision: given
 * directory entries, a TTL and an exclusion set, which of them may be reclaimed. It touches nothing
 * — no filesystem, no clock, no log — so every branch is an input a test can hand in rather than an
 * environment it has to stand up. `reclaimDataDirs` is the thin sweep around it: read the parent,
 * apply the decision, remove what it selects, and report what happened. It never throws and never
 * ends a process; the caller owns both, and the run-path caller in particular must not be able to
 * die of its housekeeping.
 *
 * THE SAFETY BOUNDARIES, EACH ONE A READING RATHER THAN A PROMISE:
 *
 *   · TTL-bounded, and the bound is overridable. Only entries whose mtime is older than the TTL are
 *     ever selected, the default TTL is 6 hours — far longer than any run — and
 *     `QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS` overrides it for an operator draining a backlog.
 *   · Fail-closed on an unreadable TTL. `0`, a non-number and a negative value all mean "the bound
 *     could not be established", and an unknown bound reclaims NOTHING rather than everything.
 *   · Name-bounded. Only entries matching the run-directory prefix are candidates. This is not
 *     theoretical: this host's `~/.cache/quay-e2e-tmp` also holds `node-compile-cache` and
 *     `playwright-transform-cache-1004`, other tools' caches sitting in the same parent. They are
 *     never candidates, whatever their age.
 *   · Owner-bounded. Only directories owned by the invoking user are read into the candidate set,
 *     so another account's run directory under a shared parent is not this run's to delete.
 *   · Excluded-by-name. The directory this run is using is never reclaimed, even when it is older
 *     than the TTL — which is the shape a worker getting a re-evaluation would otherwise produce.
 *   · Budget-bounded on the run path. A sweep that removes a real backlog is not fast (measured here:
 *     ~38k files/s, ~89 ms for a 3371-file/63 MiB directory), so the run-path caller caps the work
 *     per run. The cap is a reading (`budgetMs`), the report says whether it was hit, and the manual
 *     entry is unbounded by default because it is not on a run's critical path.
 *
 * WHY A BUDGET RATHER THAN "DELETE EVERYTHING OLD". Deleting the whole backlog inside
 * `playwright.config.ts` would put minutes of synchronous `unlink` in front of every run — long
 * enough to cross the config's own boot ceiling, which is the same class of defect this task exists
 * to end, arriving from the other side. The accumulation rate is one directory per run and the
 * reclaim rate is bounded by the budget but far larger than that, so a partial sweep per run drains
 * the pool instead of merely failing to grow it.
 */

import { readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
// No `node:os` import: the home and os-tmpdir defaults belong to `dataDirCandidates`, which already
// resolves them itself (`scripts/e2e-data-dir-selection.mjs`). This module only forwards the caller's
// override, so importing the same two functions here would be two names for nothing — which is
// exactly what lint reported before this line was deleted.
import { basename, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR_ENV, dataDirCandidates } from './e2e-data-dir-selection.mjs';

/**
 * Raises or lowers the retention TTL, in hours.
 *
 * A sibling of the selector's `QUAY_E2E_DATA_DIR_MIN_FREE_MB` in both naming and intent: the number
 * that decides this behaviour is a reading an operator can change, not a constant buried here. The
 * pair is how a backlog that has already grown is drained without editing code —
 * `QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS=1 npm run e2e:reclaim` reclaims everything older than an
 * hour instead of the default six.
 */
export const RETENTION_TTL_HOURS_ENV = 'QUAY_E2E_DATA_DIR_RETENTION_TTL_HOURS';

/**
 * How long an abandoned run directory is kept when nothing says otherwise.
 *
 * Six hours, and deliberately not lower: every value below this is a value some real run could
 * still be using. The longest leg in this checkout is bounded at 35 s and the goal gate kills a
 * criterion at 60 s, so six hours is ~360x the longest run this repository can produce — the point
 * where "old enough to be abandoned" stops being a guess about timing. It is also short enough to
 * be useful: at the measured ~100 GB/day of accumulation, a 6-hour window caps the pool at ~25 GB
 * *if nothing reclaims it*, which is a size the quota tolerates while the sweep catches up.
 */
export const DEFAULT_RETENTION_TTL_HOURS = 6;

/**
 * The prefix a run directory carries.
 *
 * Written here rather than imported from the selector, which spells the same prefix inline at its
 * `mkdtemp` call site: importing a private constant would mean widening the selector's surface for
 * this module's benefit, and the two spellings are held together by a test that reads the selector's
 * own creation through this prefix — a drift between them would leave every run directory
 * unreclaimable, which no case here could miss.
 */
export const RUN_DIR_PREFIX = 'quay-e2e-';

/**
 * How much of a run's own budget the owner-path sweep may spend by default, in milliseconds.
 *
 * Two seconds is ~3% of the 60 s a criterion is allowed and ~5% of this config's own 40 s boot
 * ceiling, and at the measured ~89 ms for a 3371-file directory it reclaims on the order of twenty
 * directories per run — against a creation rate of one directory per run. The bound exists because
 * the alternative is unbounded synchronous deletion in front of browser launch; it is a reading, not
 * a fixed count, so a slower or faster host changes the number of directories drained rather than
 * the delay a run pays.
 */
export const DEFAULT_RECLAIM_BUDGET_MS = 2_000;

/** Milliseconds in one hour, spelled once so the TTL arithmetic has a single home. */
const MS_PER_HOUR = 3_600_000;

/**
 * One directory under the parent being swept.
 *
 * `uid` is optional because it is a property of the *real* reader: an injected reader in a test
 * answers about names and ages, and the ownership filter treats a missing uid as owned (the caller
 * has already decided those entries are in scope).
 *
 * @typedef {object} RetentionEntry
 * @property {string} name The directory's own name under the parent, never a path.
 * @property {number} mtimeMs Its modification time, in epoch milliseconds.
 * @property {number} [uid] Its owner, when the reader could read one.
 */

/**
 * The two halves of a retention decision.
 *
 * Both are returned, not just the reclaimable half: the pair is what lets a caller (and a case)
 * assert that a directory was *considered and kept* rather than never looked at
 * ([[anti-fake-variant-passes-means-criterion-hole]]).
 *
 * @typedef {object} RetentionSelection
 * @property {RetentionEntry[]} reclaimable The entries that may be removed.
 * @property {RetentionEntry[]} kept The entries that may not, for whatever reason.
 */

/**
 * What one sweep did.
 *
 * @typedef {object} RetentionReport
 * @property {string} parent The directory that was swept.
 * @property {number | null} ttlMs The TTL applied, or null when it could not be established.
 * @property {boolean} dryRun True when nothing was removed.
 * @property {number} scanned Entries the parent held, before any filter.
 * @property {number} foreign Entries kept because they belong to another user.
 * @property {number} reclaimable Entries the decision selected.
 * @property {number} reclaimed Entries actually removed.
 * @property {number | null} bytesReclaimed Bytes removed, when a measurer was supplied.
 * @property {boolean} stoppedEarly True when the budget was crossed with entries still selected.
 * @property {number} elapsedMs Wall-clock the sweep spent, as the injected clock saw it.
 * @property {string[]} reclaimedNames The names actually removed, in the order they were removed.
 * @property {string[]} errors One line per thing that could not be read or removed.
 * @property {string} summary The whole report as one `[e2e]` line.
 */

/**
 * The retention TTL for this sweep, in milliseconds, from `RETENTION_TTL_HOURS_ENV` when it holds a
 * positive number.
 *
 * `null` means the bound could not be established, and it is deliberately not the default: a caller
 * who set a TTL and got six hours instead would be told the sweep was bounded when it was not, and
 * the only way to notice would be to read the printed number back. The selector refuses to start a
 * run in the same situation; here the fail-closed side is "keep everything", because the thing being
 * decided is a deletion.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export const retentionTtlMsFromEnv = (env = process.env) => {
  const raw = env[RETENTION_TTL_HOURS_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETENTION_TTL_HOURS * MS_PER_HOUR;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * MS_PER_HOUR);
};

/**
 * Which of `entries` may be reclaimed — the whole decision, as a pure function.
 *
 * Four things keep an entry:
 *
 *   · a TTL that could not be established (`null`, a non-number, or a value `<= 0`). An unknown bound
 *     is not a licence to delete: this is the fail-closed side, and it is the *only* behaviour for
 *     `0`, which a reader could otherwise mistake for "older than now".
 *   · a name that does not start with the run-directory prefix. Other tools cache in the same parent.
 *   · a name in the exclusion set. The set is compared as *names*, so a caller may hand in either
 *     the bare name or any path ending in it (`basename` is applied to values containing a
 *     separator); the entry this run is using is the one that must survive an over-age sweep.
 *   · an mtime newer than the cutoff. The comparison is strict (`>`), so an entry exactly at the
 *     cutoff is reclaimable — the bound is "older than the TTL", and an entry whose age is exactly
 *     the TTL is not younger than it.
 *
 * @param {{
 *   entries: RetentionEntry[],
 *   ttlMs: number | null,
 *   prefix?: string,
 *   exclude?: string[],
 *   now?: number,
 * }} options
 * @returns {RetentionSelection}
 */
export const selectReclaimableDirs = ({ entries, ttlMs, prefix = RUN_DIR_PREFIX, exclude = [], now = Date.now() }) => {
  /** @type {Set<string>} */
  const excluded = new Set();
  for (const value of exclude) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    excluded.add(value.includes('/') ? basename(value) : value);
  }

  // Narrowed inline rather than through the `bounded` boolean: TypeScript does not carry a narrowing
  // through a derived boolean, and the subtraction below needs `ttlMs` to be a number.
  const bounded = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0;
  const cutoff = bounded ? now - ttlMs : Number.POSITIVE_INFINITY;

  /** @type {RetentionEntry[]} */
  const reclaimable = [];
  /** @type {RetentionEntry[]} */
  const kept = [];
  for (const entry of entries) {
    if (!bounded) { kept.push(entry); continue; }
    if (typeof entry.name !== 'string' || !entry.name.startsWith(prefix)) { kept.push(entry); continue; }
    if (excluded.has(entry.name)) { kept.push(entry); continue; }
    if (entry.mtimeMs > cutoff) { kept.push(entry); continue; }
    reclaimable.push(entry);
  }
  return { reclaimable, kept };
};

/**
 * The bytes a directory holds, summed over its files, without following symlinks.
 *
 * Best-effort by design: a file that disappears between the listing and the stat contributes
 * nothing rather than failing the measurement, because this number is a report and not a decision.
 * Symlinks are neither counted nor followed — the run directory is throwaway data, and a link into
 * something that is not throwaway must not make this walk read it.
 *
 * @param {string} target
 * @returns {number}
 */
export const dirSizeBytes = (target) => {
  let total = 0;
  /** @type {string[]} */
  const stack = [target];
  while (stack.length > 0) {
    const current = /** @type {string} */ (stack.pop());
    /** @type {import('node:fs').Dirent[]} */
    let dirents;
    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const child = join(current, dirent.name);
      if (dirent.isDirectory()) { stack.push(child); continue; }
      if (!dirent.isFile()) continue;
      try {
        total += statSync(child).size;
      } catch {
        // Gone between the listing and the stat: it contributes no bytes and nothing else.
      }
    }
  }
  return total;
};

/**
 * The directories directly under `parent`, with the age and owner the decision needs.
 *
 * Only real directories, and only their own metadata: a symlink is skipped rather than resolved, so
 * a name in this listing always denotes a directory inside `parent` rather than somewhere else that
 * happens to be linked from it. A child that cannot be stat'ed is skipped for the same reason — the
 * sweep is not allowed to die of one unreadable entry.
 *
 * @param {string} parent
 * @returns {RetentionEntry[]}
 */
const readEntriesFrom = (parent) => {
  /** @type {RetentionEntry[]} */
  const entries = [];
  for (const dirent of readdirSync(parent, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    try {
      const stats = statSync(join(parent, dirent.name));
      entries.push({ name: dirent.name, mtimeMs: stats.mtimeMs, uid: stats.uid });
    } catch {
      // Unreadable: not a candidate this sweep can reason about, and not a reason to stop.
    }
  }
  return entries;
};

/**
 * `error.message` for anything throwable, so a caught non-Error does not print as `undefined`.
 *
 * @param {unknown} error
 * @returns {string}
 */
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The whole report as one `[e2e]` line, with `null` fields spelled as words rather than as `null`.
 *
 * One line, because this is the reading an operator checks the sweep against — the same shape the
 * selector's `data-dir=… free-bytes=…` line has, and for the same reason: it has to be parseable
 * and quotable without the reader having to reconstruct it from several outputs.
 *
 * @param {RetentionReport} report
 * @returns {string}
 */
const describeRetention = (report) => [
  `[e2e] retention: parent=${report.parent}`,
  `ttl-ms=${report.ttlMs === null ? 'none' : String(report.ttlMs)}`,
  `scanned=${report.scanned}`,
  `reclaimable=${report.reclaimable}`,
  `reclaimed=${report.reclaimed}`,
  `bytes-reclaimed=${report.bytesReclaimed === null ? 'n/a' : String(report.bytesReclaimed)}`,
  `remaining=${report.reclaimable - report.reclaimed}`,
  `elapsed-ms=${report.elapsedMs}`,
  ...(report.foreign > 0 ? [`foreign-kept=${report.foreign}`] : []),
  ...(report.dryRun ? ['dry-run=true'] : []),
  ...(report.stoppedEarly ? ['stopped-early=true'] : []),
  ...(report.errors.length > 0 ? [`errors=${report.errors.length}`] : []),
].join(' ');

/**
 * Sweeps one parent directory: reads it, applies the decision, removes what it selects.
 *
 * Never throws and never ends a process. Every failure — an unreadable parent, a child that cannot be
 * removed — becomes a line in `errors` and the sweep continues, because the alternative is a run
 * dying of its own housekeeping, which is the shape of the defect this file exists for arriving from
 * the other side. A parent that does not exist is not an error at all: it is a parent with nothing
 * in it, which is the common case for a host whose runs have never used that candidate.
 *
 * The clock is injected (`now`) and read twice per removal, so a case can cross the budget without
 * waiting for it. `measureBytes` is optional and defaults to *no* measurement: walking a directory to
 * learn its size costs about as much as removing it, which is a price the run path must not pay for a
 * number only the manual entry reports.
 *
 * @param {{
 *   parent?: string,
 *   env?: Record<string, string | undefined>,
 *   ttlMs?: number | null,
 *   prefix?: string,
 *   exclude?: string[],
 *   budgetMs?: number,
 *   dryRun?: boolean,
 *   ownerUid?: number | null,
 *   now?: () => number,
 *   readEntries?: (parent: string) => RetentionEntry[],
 *   remove?: (target: string) => void,
 *   measureBytes?: (target: string) => number,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {RetentionReport}
 */
export const reclaimDataDirs = (options = {}) => {
  const parent = typeof options.parent === 'string' ? options.parent : '';
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => {});
  const now = options.now ?? (() => Date.now());
  const readEntries = options.readEntries ?? readEntriesFrom;
  const remove = options.remove ?? ((target) => { rmSync(target, { recursive: true, force: true }); });
  const measureBytes = options.measureBytes;

  /**
   * The invoking user, or null when the platform has no such notion (`process.getuid` is absent on
   * Windows). Null means "ownership is not a filter here" rather than "no entry is owned", so the
   * sweep still works where the question cannot be asked.
   */
  /** @type {number | null} */
  let ownerUid;
  if (options.ownerUid !== undefined) {
    ownerUid = options.ownerUid;
  } else {
    ownerUid = typeof process.getuid === 'function' ? process.getuid() : null;
  }

  /** @type {RetentionReport} */
  const report = {
    parent,
    ttlMs: null,
    dryRun,
    scanned: 0,
    foreign: 0,
    reclaimable: 0,
    reclaimed: 0,
    bytesReclaimed: measureBytes === undefined ? null : 0,
    stoppedEarly: false,
    elapsedMs: 0,
    reclaimedNames: [],
    errors: [],
    summary: '',
  };

  const startedAt = now();
  try {
    report.ttlMs = options.ttlMs !== undefined
      ? options.ttlMs
      : retentionTtlMsFromEnv(options.env ?? process.env);
    const budgetMs = options.budgetMs ?? DEFAULT_RECLAIM_BUDGET_MS;

    /** @type {RetentionEntry[]} */
    let entries;
    try {
      entries = readEntries(parent);
    } catch (error) {
      // A parent that is not there is empty, not broken: on this host two of the three candidates
      // exist, and a host that has never run an e2e has none. Any other failure is recorded and the
      // sweep stops here rather than guessing what the parent holds.
      const code = /** @type {{ code?: unknown }} */ (error)?.code;
      if (code !== 'ENOENT') {
        report.errors.push(`${parent}: could not be read (${errorMessage(error)}) — nothing is reclaimed here`);
        log(`[e2e] retention: ${report.errors[0]}`);
      }
      report.elapsedMs = now() - startedAt;
      report.summary = describeRetention(report);
      return report;
    }

    const owned = entries.filter((entry) => ownerUid === null || entry.uid === undefined || entry.uid === ownerUid);
    report.scanned = entries.length;
    report.foreign = entries.length - owned.length;

    const { reclaimable } = selectReclaimableDirs({
      entries: owned,
      ttlMs: report.ttlMs,
      prefix: options.prefix ?? RUN_DIR_PREFIX,
      exclude: options.exclude ?? [],
      now: now(),
    });
    report.reclaimable = reclaimable.length;

    for (const entry of reclaimable) {
      if (now() - startedAt > budgetMs) {
        report.stoppedEarly = true;
        break;
      }
      const target = join(parent, entry.name);
      if (measureBytes !== undefined) {
        try {
          report.bytesReclaimed = (report.bytesReclaimed ?? 0) + measureBytes(target);
        } catch {
          // A directory whose size cannot be read is still a directory that can be removed; the
          // report's byte count is the only thing lost.
        }
      }
      if (dryRun) continue;
      try {
        remove(target);
        report.reclaimed += 1;
        report.reclaimedNames.push(entry.name);
      } catch (error) {
        report.errors.push(`${entry.name}: could not be removed (${errorMessage(error)}) — leaving it in place`);
      }
    }
  } catch (error) {
    // The outer net. Nothing above is expected to throw, and the one thing that must hold whatever
    // happens is that a caller's run cannot end here: this function is called from Playwright's own
    // config evaluation, where a throw is a run that never starts.
    report.errors.push(`${parent}: the sweep itself failed (${errorMessage(error)}) — nothing further was reclaimed`);
  }

  report.elapsedMs = now() - startedAt;
  report.summary = describeRetention(report);
  log(report.summary);
  for (const error of report.errors) log(`[e2e] retention: ${error}`);
  return report;
};

/**
 * The parent directories a sweep with no explicit target considers.
 *
 * The selector's own candidate list, unchanged and undeduplicated-once-more: those are exactly the
 * directories a run may create a data directory inside, so those are the directories that accumulate
 * one. Existing directories only — sweeping a parent that is not there would be a listing that
 * cannot succeed — and the list is the selector's, so a host that changes where runs go does not
 * leave this module sweeping the old place.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, osTmpdir?: string }} [options]
 * @returns {string[]}
 */
export const defaultRetentionParents = (options = {}) => {
  const env = options.env ?? process.env;
  /** @type {string[]} */
  const existing = [];
  for (const candidate of dataDirCandidates({ env, home: options.home, osTmpdir: options.osTmpdir })) {
    try {
      if (statSync(candidate).isDirectory()) existing.push(candidate);
    } catch {
      // Not there: nothing has accumulated in it, and nothing can be listed out of it.
    }
  }
  return existing;
};

/** Usage line, printed by `--help` and by an argument this entry does not understand. */
const USAGE = [
  'usage: node scripts/e2e-data-dir-retention.mjs [--parent <dir>]... [--dry-run] [--budget-ms <n>] [--quiet]',
  '',
  `Reclaims e2e run directories older than the TTL (default ${DEFAULT_RETENTION_TTL_HOURS}h, override with ${RETENTION_TTL_HOURS_ENV}).`,
  'With no --parent, every existing data-directory candidate is swept.',
  'Exit status is always 0: housekeeping must not be able to fail a run.',
].join('\n');

/**
 * The manual entry — `npm run e2e:reclaim`.
 *
 * Unbounded in time by default, because this is the operator's drain and not a step in front of a
 * browser launch; `--budget-ms` bounds it for a caller that cares. `QUAY_E2E_DATA_DIR` is excluded
 * exactly as the run path excludes the directory it created, so a sweep started beside a live run
 * does not reclaim that run's data.
 *
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, log?: (line: string) => void }} [options]
 * @returns {number}
 */
export const runRetentionCli = (argv, options = {}) => {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.log(line));
  /** @type {string[]} */
  const parents = [];
  let dryRun = false;
  let quiet = false;
  let budgetMs = Number.POSITIVE_INFINITY;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--parent') {
      const value = argv[index + 1];
      if (typeof value === 'string' && value.trim() !== '') parents.push(resolvePath(value));
      index += 1;
      continue;
    }
    if (arg === '--budget-ms') {
      const value = Number(argv[index + 1]);
      if (Number.isFinite(value) && value >= 0) budgetMs = value;
      index += 1;
      continue;
    }
    if (arg === '--dry-run') { dryRun = true; continue; }
    if (arg === '--quiet') { quiet = true; continue; }
    if (arg === '--help' || arg === '-h') { log(USAGE); return 0; }
    // An unrecognised argument is named rather than ignored: a typo'd `--parents` would otherwise
    // sweep the default list, which is exactly the quiet widening an operator must not get.
    log(`${USAGE}\nunknown argument: ${arg}`);
    return 0;
  }

  /** The declared data directory, if any: the one directory this sweep must not touch. */
  const declared = env[DATA_DIR_ENV];
  const exclude = typeof declared === 'string' && declared.trim() !== '' ? [declared] : [];
  const targets = parents.length > 0 ? parents : defaultRetentionParents({ env });

  let reclaimed = 0;
  let bytesReclaimed = 0;
  let swept = 0;
  for (const parent of targets) {
    const report = reclaimDataDirs({
      parent,
      env,
      exclude,
      dryRun,
      budgetMs,
      // The manual entry pays for the byte reading the run path declines: it is the number an
      // operator quotes after a drain, and it is the only place that number is worth a second walk.
      measureBytes: dirSizeBytes,
      log: quiet ? () => {} : log,
    });
    swept += 1;
    reclaimed += report.reclaimed;
    bytesReclaimed += report.bytesReclaimed ?? 0;
  }
  log(
    `[e2e] retention: total parents=${swept} reclaimed=${reclaimed} bytes-reclaimed=${bytesReclaimed}`
      + (dryRun ? ' dry-run=true' : ''),
  );
  return 0;
};

/**
 * Whether this file is the process's entry point.
 *
 * Both sides go through `realpath` because a task worktree reaches this file through paths that may
 * themselves be links, and an entry that silently did nothing would make `npm run e2e:reclaim` exit
 * 0 without sweeping — a green that cannot go red. Imported (as `playwright.config.ts` does),
 * `process.argv[1]` names the importer and this is false.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // `process.exitCode` rather than `process.exit`: a sweep still writing its report to a pipe must
  // not have the write truncated by an immediate exit, and the status is the same either way.
  process.exitCode = runRetentionCli(process.argv.slice(2));
}
