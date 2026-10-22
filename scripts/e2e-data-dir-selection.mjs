#!/usr/bin/env node
/**
 * Where an e2e run puts the throwaway directory it persists into, and when it refuses to pick one.
 *
 * THE DEFECT THIS EXISTS FOR. `playwright.config.ts` used to take its data directory from
 * `fs.mkdtempSync(path.join(os.tmpdir(), 'quay-e2e-'))` unconditionally. `os.tmpdir()` reads `TMPDIR`,
 * and the driver's own environment does not set it — so on this host every run landed in `/tmp`, on
 * the root filesystem, whatever its remaining space happened to be. A run needs roughly 106 MiB
 * (vite cache, traces, audio, the sqlite auth database) and the root filesystem here has been
 * observed at 362 MiB free, so the run either fit or did not. When it did not, the failure surfaced
 * *inside* a test case as `ENOSPC: no space left on device, write` or
 * `net::ERR_INSUFFICIENT_RESOURCES` — reported against the thing the case was measuring, which is an
 * application defect as far as a reader of that line can tell. The ledger for AC-122 on 2026-09-25
 * is exactly that shape: `fail` at 08:23:20Z (`ENOSPC`), three consecutive `pass` at 08:24:51Z /
 * 08:27:57Z / 08:31:05Z, then `fail` again at 08:35:00Z (`ERR_INSUFFICIENT_RESOURCES`), with none of
 * the three failures reaching an assertion of the criterion.
 *
 * WHAT IS READ, AND WHEN. The choice is made *at the moment it is made*, from the filesystem in
 * front of it: each candidate's filesystem is asked for its available bytes (`statfs(2)`, the same
 * field `df` prints as `Avail`), and a candidate is usable only if it can really hold the run. The
 * floor is a reading too, not a constant buried in here — `QUAY_E2E_DATA_DIR_MIN_FREE_MB` overrides
 * it, which is what makes "no candidate is big enough" reachable without root and without standing
 * up a small filesystem.
 *
 * WHAT IS NOT DONE. No candidate that fails the floor is ever silently accepted, and "nothing
 * qualifies" is not a fallback to `os.tmpdir()`: it ends the run before it starts, naming the
 * shortfall per candidate. Recycling the directories an earlier run left behind is deliberately not
 * this module's job (a run that cannot start is the condition worth failing on; housekeeping is a
 * separate concern), and neither is choosing a location by host: the invariant is "this filesystem
 * has room", not "the data lives under /data".
 *
 * The three numbers a run prints about its own choice — the selected data directory, that
 * filesystem's available bytes, and the floor applied — are on one `[e2e]` line, so an outside
 * reader can check them against `df` instead of taking the run's word for it.
 */

import { mkdirSync, mkdtempSync, statfsSync, writeSync } from 'node:fs';
import { homedir as osHomedir, tmpdir as osTmpdirPath } from 'node:os';
import { dirname, join } from 'node:path';

/** Names the data directory outright, bypassing selection. Its presence also marks a re-evaluating worker rather than the run's owner. */
export const DATA_DIR_ENV = 'QUAY_E2E_DATA_DIR';

/**
 * Raises or lowers the free-space floor, in MiB.
 *
 * Deliberately a superstring of `DATA_DIR_ENV` rather than a name of its own family: it is the floor
 * *for this run's data directory*, and the address of that concept is the data directory's own name.
 * The two are never told apart by substring, only by exact key, so the containment is not a hazard
 * here — reading the value out of an environment object cannot confuse the two.
 */
export const MIN_FREE_MB_ENV = 'QUAY_E2E_DATA_DIR_MIN_FREE_MB';

/**
 * The floor used when `MIN_FREE_MB_ENV` is unset: 1 GiB.
 *
 * Derived from what a run really writes rather than picked for roundness. A full run measures ~106
 * MiB of data directory, and the run shares the volume with the checkout's `node_modules`, the
 * browser download and whatever else is on it, so the floor is ~10x the observed need. That places
 * it on the right side of both readings this host actually produced: the root filesystem's 362-499
 * MiB is *not* enough, and the 4 TB volume is. A tighter floor would accept a filesystem that a
 * single concurrent run could still fill; a looser one would refuse machines whose only sin is
 * being small.
 */
export const DEFAULT_MIN_FREE_MB = 1024;

/** Bytes in one MiB, spelled once so the floor's arithmetic has a single home. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * @typedef {object} CandidateReading
 * @property {string} path The candidate as considered.
 * @property {number | null} availableBytes Bytes available on that candidate's filesystem, or null when it could not be read.
 * @property {boolean} ok Whether that candidate cleared the floor.
 */

/**
 * @typedef {object} SelectionAccepted
 * @property {true} ok
 * @property {string} parent The candidate that was accepted, as the parent to create the run's directory under.
 * @property {number} availableBytes Bytes available on the accepted filesystem.
 * @property {number} minFreeBytes The floor the choice was made against.
 * @property {CandidateReading[]} readings Every candidate considered, in order, up to and including the accepted one.
 */

/**
 * @typedef {object} SelectionRefused
 * @property {false} ok
 * @property {string} reason The refusal, already worded for a human reading a red run.
 * @property {number} minFreeBytes The floor the choice was made against.
 * @property {CandidateReading[]} readings Every candidate considered, each with the bytes it had.
 */

/**
 * Available bytes on the filesystem holding `target`, or null when none could be read.
 *
 * Walks up to the nearest existing ancestor rather than requiring `target` to exist: the candidate
 * list names directories this module may be about to create (`$HOME/.cache/quay-e2e-tmp`), and
 * creating a directory in order to ask whether its filesystem has room would make the reading
 * depend on the choice it is meant to inform. `statfs` is per-filesystem, so the answer is the same
 * for the candidate and for any ancestor on the same mount.
 *
 * @param {string} target
 * @returns {number | null}
 */
export const fsAvailableBytes = (target) => {
  let probe = target;
  for (;;) {
    try {
      const stats = statfsSync(probe);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = dirname(probe);
      // `dirname('/')` is `'/'`: the filesystem root is as far up as this can go, and nothing above
      // it will statfs any better.
      if (parent === probe) return null;
      probe = parent;
    }
  }
};

/**
 * The directories a run may put its data directory under, most specific first.
 *
 * `TMPDIR` comes first because a caller who set it has said where scratch space is; the cache
 * directory under `$HOME` comes second because it is the only candidate on a volume that is not the
 * system one; `os.tmpdir()` comes last so that the historical location is still reachable — and so
 * that a host whose `/tmp` is genuinely roomy behaves as it always did.
 *
 * Duplicates are dropped rather than deduplicated by hand at the call site: `os.tmpdir()` reads
 * `TMPDIR`, so a run with `TMPDIR` set would otherwise consider the same directory twice and report
 * the same shortfall twice.
 *
 * @param {{ env?: Record<string, string | undefined>, home?: string, osTmpdir?: string }} [options]
 * @returns {string[]}
 */
export const dataDirCandidates = (options = {}) => {
  const env = options.env ?? process.env;
  const home = options.home ?? osHomedir();
  const legacy = options.osTmpdir ?? osTmpdirPath();
  /** @type {string[]} */
  const candidates = [];
  for (const candidate of [env.TMPDIR, join(home, '.cache', 'quay-e2e-tmp'), legacy]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    if (candidates.includes(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
};

/**
 * The refusal text: the floor, then one line per candidate saying what that candidate actually had.
 *
 * Per candidate and not aggregated, because the actionable question a reader has is "was one of
 * them close, or is every candidate on this machine small" — a single total would answer neither.
 * A candidate whose bytes could not be read says so instead of printing a zero, since a zero would
 * be indistinguishable from a genuinely full filesystem.
 *
 * @param {number} minFreeBytes
 * @param {CandidateReading[]} readings
 * @returns {string}
 */
const describeShortfall = (minFreeBytes, readings) => {
  const lines = readings.map((reading) => {
    if (reading.availableBytes === null) {
      return `[e2e]   candidate ${reading.path}: filesystem could not be read, so it cannot be shown to hold ${minFreeBytes} bytes`;
    }
    return `[e2e]   candidate ${reading.path}: ${reading.availableBytes} bytes available, shortfall ${minFreeBytes - reading.availableBytes} bytes`;
  });
  return [
    `[e2e] refusing to start the run: insufficient free space for the e2e data directory — no candidate filesystem holds the required ${minFreeBytes} bytes.`,
    ...lines,
    '[e2e] the run is ending here, before any server or test starts, rather than failing later as an ENOSPC inside a case that is measuring something else.',
  ].join('\n');
};

/**
 * Picks the first candidate whose filesystem holds `minFreeBytes`, or reports why none does.
 *
 * The filesystem reading is injected (`availableBytes`) so that every branch of this decision is
 * reachable from a test without a small filesystem: a case can hand in a reader that answers with
 * numbers, and "no candidate qualifies" is then an input rather than an environment.
 *
 * @param {{ candidates: string[], minFreeBytes: number, availableBytes?: (target: string) => number | null }} options
 * @returns {SelectionAccepted | SelectionRefused}
 */
export const selectDataDir = ({ candidates, minFreeBytes, availableBytes = fsAvailableBytes }) => {
  /** @type {CandidateReading[]} */
  const readings = [];
  for (const candidate of candidates) {
    /** @type {number | null} */
    let available = null;
    try {
      available = availableBytes(candidate);
    } catch {
      // An injected reader that throws is a candidate whose filesystem could not be read, which is
      // the same reading `fsAvailableBytes` gives for a path no `statfs` reaches.
      available = null;
    }
    // Tested on `available` itself rather than on a separate `ok` boolean: TypeScript narrows a
    // local across its own guard and not across a boolean derived from it, so the `availableBytes`
    // the accepted result carries is provably a number here.
    if (available !== null && available >= minFreeBytes) {
      readings.push({ path: candidate, availableBytes: available, ok: true });
      return { ok: true, parent: candidate, availableBytes: available, minFreeBytes, readings };
    }
    readings.push({ path: candidate, availableBytes: available, ok: false });
  }
  return { ok: false, reason: describeShortfall(minFreeBytes, readings), minFreeBytes, readings };
};

/**
 * The floor for this run, in bytes, from `MIN_FREE_MB_ENV` when it holds a positive number.
 *
 * A value that is present but unreadable is refused rather than defaulted: a caller who asked for a
 * floor and got `DEFAULT_MIN_FREE_MB` instead would be told the run was bounded when it was not, and
 * the only way to notice would be to read the printed number back. `null` means the floor could not
 * be established.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {number | null}
 */
const minFreeBytesFromEnv = (env) => {
  const raw = env[MIN_FREE_MB_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_MIN_FREE_MB * BYTES_PER_MIB;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed) * BYTES_PER_MIB;
};

/**
 * Where this run's data directory goes, printing the three numbers it was chosen by.
 *
 * `QUAY_E2E_DATA_DIR` short-circuits everything: a worker re-evaluating this config inherits the
 * directory the owner already picked, and re-deciding there would either move the run's data
 * mid-flight or refuse a run that is already under way. So an explicit value is honoured verbatim —
 * no floor is applied to it and nothing is printed — and the returned `explicit` flag is what tells
 * the caller it is not the owner.
 *
 * `fail` is injected rather than called directly so that this decision can be driven in a test. Its
 * default is the only place in this module that ends a process, and it writes synchronously: on a
 * pipe, `console.error` hands the line off asynchronously, so a message followed by an immediate
 * exit is a message that can be lost — and the refusal text is the whole product of the path.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   home?: string,
 *   osTmpdir?: string,
 *   availableBytes?: (target: string) => number | null,
 *   makeTempDir?: (parent: string) => string,
 *   log?: (line: string) => void,
 *   fail?: (message: string) => never,
 * }} [options]
 * @returns {{ dataDir: string, explicit: boolean, availableBytes: number | null, minFreeBytes: number | null }}
 */
export const resolveE2eDataDir = (options = {}) => {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line) => console.log(line));
  // Typed as `never` rather than left to inference: a block-bodied arrow whose last statement is
  // `process.exit(1)` still infers `void`, and a `void` here would stop the caller's control-flow
  // analysis from knowing that nothing after a refusal runs — the refusal path would then read as
  // "maybe we carry on and use a half-decided candidate".
  /** @type {(message: string) => never} */
  const fail = options.fail ?? ((message) => {
    writeSync(2, `${message}\n`);
    process.exit(1);
  });
  const makeTempDir = options.makeTempDir ?? ((parent) => mkdtempSync(join(parent, 'quay-e2e-')));

  const declared = env[DATA_DIR_ENV];
  if (typeof declared === 'string' && declared.trim() !== '') {
    return { dataDir: declared, explicit: true, availableBytes: null, minFreeBytes: null };
  }

  const minFreeBytes = minFreeBytesFromEnv(env);
  if (minFreeBytes === null) {
    fail(
      `[e2e] refusing to start the run: ${MIN_FREE_MB_ENV}="${String(env[MIN_FREE_MB_ENV])}" is not a positive number of MiB, `
        + 'so the free-space floor could not be established. Refusing rather than silently applying the default, '
        + 'because the run would otherwise be bounded by a number nobody asked for.',
    );
  }

  const selection = selectDataDir({
    candidates: dataDirCandidates({ env, home: options.home, osTmpdir: options.osTmpdir }),
    minFreeBytes,
    availableBytes: options.availableBytes,
  });
  if (!selection.ok) fail(selection.reason);

  // Only now, for the accepted candidate alone: a directory is created when it is about to be used,
  // not while it is still being weighed.
  mkdirSync(selection.parent, { recursive: true });
  const dataDir = makeTempDir(selection.parent);
  log(
    `[e2e] data-dir=${dataDir} free-bytes=${selection.availableBytes} min-free-bytes=${selection.minFreeBytes}`
      + ` (candidate ${selection.parent})`,
  );
  return {
    dataDir,
    explicit: false,
    availableBytes: selection.availableBytes,
    minFreeBytes: selection.minFreeBytes,
  };
};
