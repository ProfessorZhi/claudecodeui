#!/usr/bin/env node
/**
 * What an e2e run has to prepare, before its browser loads its first page, and whether it can.
 *
 * THE DEFECT THIS EXISTS FOR. `scripts/e2e-data-dir-selection.mjs` moved the run's *data directory*
 * off `os.tmpdir()` and onto a filesystem it reads the free space of. The rest of the run's scratch
 * space did not move with it: Chromium's user-data directory, `tsx`'s transform cache, Node's compile
 * cache and Playwright's own transform cache are all created under `os.tmpdir()`, which reads
 * `TMPDIR`, which the driver's environment does not set — so every run on this host still writes them
 * onto the root filesystem, shared with the whole fleet. When that filesystem is under the load a
 * fleet puts on it, the page the criterion is about never renders at all and the leg dies in its own
 * assembly step, before any assertion it owns. Measured on this host (2026-09-26, 128 cores):
 *
 *   six concurrent `npx playwright test e2e/voice-trim.spec.ts -g "AC-122"`, `TMPDIR` unset
 *     ⇒ 6/6 `Test timeout of 35000ms exceeded`, dying in `expandProject()` on the sidebar row —
 *       the same shape as the ledger's `2026-09-26T01:05:13Z` fail, and with none of the
 *       criterion's own wording in the failure;
 *   the same six runs with each run's scratch on the 4 TB volume
 *     ⇒ 6/6 green, `[voice-replay] original=… trimmed=…` printed.
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT DOES NOT. Given the candidate scratch roots, the run's need,
 * and a budget, it returns either the set of targets that still have to be prepared, or a refusal
 * naming the target that could not be. Preparing a target is injected (`warm`), the clock is injected
 * (`now`), and so is the filesystem reading (`availableBytes`), so every branch — including "the
 * preparation itself did not fit the budget" — is an input a test can hand in rather than an
 * environment it has to stand up. The module never touches the filesystem, never prints, and never
 * ends a process: the caller owns all three, which is what lets the same decision be read by a test
 * and by the config without the test having to run a browser.
 *
 * WHY A BUDGET RATHER THAN A TIMEOUT. A run that gives its assembly step no bound reports the failure
 * wherever the starvation lands, which for this defect is inside a case that is measuring something
 * else. A budget that is checked *while* preparing, and whose expiry names the target that overran,
 * puts the failure back on the step that actually failed.
 */

import { tmpdir as osTmpdirPath } from 'node:os';
import { join } from 'node:path';

/**
 * Names the scratch root outright, bypassing the candidate list.
 *
 * Deliberately its own name rather than `TMPDIR`: `TMPDIR` is set by whoever launched the run, is read
 * by every unrelated tool the run spawns, and is exactly the thing that is unset here — so pointing
 * this run's scratch somewhere is a decision about *this run*, and it is spelled as one.
 */
export const ASSEMBLY_TEMP_ROOT_ENV = 'QUAY_E2E_ASSEMBLY_TEMP_ROOT';

/**
 * How long the whole preparation may take, in milliseconds.
 *
 * The leg that first showed this defect is bounded at 35 s (`e2e/voice-trim.spec.ts`), and the goal
 * gate that runs it at 60 s. Preparation that has not finished in 35 s has already spent the leg's
 * own budget, so bounding it by the same number is what keeps the budget *below* the ceiling it is
 * protecting: a preparation that cannot finish is refused here, with a name, rather than discovered
 * later as a case that timed out for reasons it cannot see.
 */
export const DEFAULT_ASSEMBLY_BUDGET_MS = 35_000;

/**
 * What the run's scratch has to hold, in MiB.
 *
 * A run writes ~55 MiB of scratch outside its data directory (browser profile, transform caches) and
 * the browser's profile grows while the page is open; 256 MiB is several times the observed need, on
 * the same reasoning as the data directory's 1 GiB floor — the cost of being wrong here is a run that
 * starts and then starves, which is the failure this exists to prevent.
 */
export const DEFAULT_TEMP_NEED_MB = 256;

/** Bytes in one MiB, spelled once so the arithmetic has a single home. */
const BYTES_PER_MIB = 1024 * 1024;

/**
 * The name of the probe file a prepared target carries.
 *
 * A directory that merely exists is not evidence that the run's scratch is usable: a target created
 * by someone else's run, or left behind by a run that died, would read as prepared. The probe is
 * written by the warm-up and is what "prepared" is asked about, so the answer is about this run's own
 * writing rather than about a directory's existence.
 */
export const PROBE_FILE_NAME = '.quay-e2e-assembly-ready';

/**
 * @typedef {object} AssemblyCandidateReading
 * @property {string} path The candidate as considered.
 * @property {number | null} availableBytes Bytes available on that candidate's filesystem, or null when it could not be read.
 * @property {boolean} ok Whether that candidate had room for the run's scratch.
 */

/**
 * The scratch roots a run may use, most specific first.
 *
 * An explicit `ASSEMBLY_TEMP_ROOT_ENV` comes first: a caller who named a location has said where the
 * scratch goes. The run's own data directory comes next — it is the only candidate that is *this
 * run's*, and it has already been chosen off a filesystem whose free space was read at the moment of
 * choosing, so it is the one candidate that is not shared with the rest of the fleet. `TMPDIR` and
 * `os.tmpdir()` come last: they are where the defect lives, they are reachable only when the run's
 * own directory cannot hold the scratch, and the refusal below is what happens when neither can.
 *
 * Duplicates are dropped because `os.tmpdir()` reads `TMPDIR`, so a run with `TMPDIR` set would
 * otherwise weigh the same directory twice and report the same shortfall twice.
 *
 * @param {{ env?: Record<string, string | undefined>, dataDir?: string, osTmpdir?: string }} [options]
 * @returns {string[]}
 */
export const assemblyTempCandidates = (options = {}) => {
  const env = options.env ?? process.env;
  const legacy = options.osTmpdir ?? osTmpdirPath();
  /** @type {string[]} */
  const candidates = [];
  const offered = [
    env[ASSEMBLY_TEMP_ROOT_ENV],
    typeof options.dataDir === 'string' && options.dataDir.trim() !== '' ? join(options.dataDir, 'tmp') : undefined,
    env.TMPDIR,
    legacy,
  ];
  for (const candidate of offered) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    if (candidates.includes(candidate)) continue;
    candidates.push(candidate);
  }
  return candidates;
};

/**
 * The refusal for a scratch root that could not be prepared, already worded for a human reading a red run.
 *
 * @param {string} target
 * @param {number} elapsedMs
 * @param {number} budgetMs
 * @returns {string}
 */
const describeOverrun = (target, elapsedMs, budgetMs) => [
  `[e2e] refusing to start the run: preparing this run's scratch root did not fit the assembly budget — ${target} took ${elapsedMs}ms of the ${budgetMs}ms allowed.`,
  '[e2e] the run is ending here, before any server or browser starts, rather than starving the first page load and reporting the shortfall inside a case that is measuring something else.',
].join('\n');

/**
 * The refusal when no candidate can hold the run's scratch.
 *
 * Per candidate and not aggregated, because the actionable question is "was one of them close, or is
 * every candidate on this machine too small" — a single total answers neither.
 *
 * @param {number} needBytes
 * @param {AssemblyCandidateReading[]} readings
 * @returns {string}
 */
const describeShortfall = (needBytes, readings) => [
  `[e2e] refusing to start the run: no candidate can hold this run's ${needBytes} bytes of scratch space.`,
  ...readings.map((reading) => (reading.availableBytes === null
    ? `[e2e]   candidate ${reading.path}: filesystem could not be read, so it cannot be shown to hold ${needBytes} bytes`
    : `[e2e]   candidate ${reading.path}: ${reading.availableBytes} bytes available, shortfall ${needBytes - reading.availableBytes} bytes`)),
  '[e2e] the run is ending here rather than letting the browser find out mid-page-load.',
].join('\n');

/**
 * Decides what the run still has to prepare, prepares it, and reports what it cost.
 *
 * Four outcomes, and each is one of the things the criterion behind this module has to be able to say:
 * a target list that was already prepared is *skipped* rather than prepared again (a worker that
 * re-evaluates the config must not redo the owner's work); targets that are not yet prepared are
 * *prepared* and returned; an explicitly given target list is used *as given* and never substituted
 * from the candidate list; and a preparation that overran the budget is *refused*, naming the target
 * that overran. The filesystem reading only gates the candidate list — an explicit target list is a
 * decision already made, so it is prepared without being re-weighed.
 *
 * `warm` is called once per pending target and is the only thing here that touches anything outside
 * this function. It is not called for a target `isWarmed` already reports true for, which is what
 * makes a second evaluation of the same run free.
 *
 * @param {{
 *   candidates?: string[],
 *   targets?: string[],
 *   budgetMs?: number,
 *   needBytes?: number,
 *   availableBytes?: (target: string) => number | null,
 *   isWarmed?: (target: string) => boolean,
 *   warm?: (target: string) => void,
 *   now?: () => number,
 * }} [options]
 * @returns {
 *   | { ok: true, skipped: true, targets: [], readings: AssemblyCandidateReading[], elapsedMs: number, prepared: string[] }
 *   | { ok: true, skipped: false, targets: string[], readings: AssemblyCandidateReading[], elapsedMs: number, prepared: string[], warmed: { target: string, elapsedMs: number, availableBytes: number | null }[] }
 *   | { ok: false, reason: string, readings: AssemblyCandidateReading[], target: string, elapsedMs: number, budgetMs: number }
 * }
 */
export const planAssembly = (options = {}) => {
  const budgetMs = options.budgetMs ?? DEFAULT_ASSEMBLY_BUDGET_MS;
  const needBytes = options.needBytes ?? DEFAULT_TEMP_NEED_MB * BYTES_PER_MIB;
  const availableBytes = options.availableBytes ?? (() => null);
  const isWarmed = options.isWarmed ?? (() => false);
  const warm = options.warm ?? (() => {});
  const now = options.now ?? (() => Date.now());

  /** @type {AssemblyCandidateReading[]} */
  const readings = [];
  /** @type {string[]} */
  let chosen;
  if (Array.isArray(options.targets)) {
    // Explicit: used as given. Weighed against nothing, because someone who names a target has
    // already made the choice this function would otherwise be making for them.
    chosen = [...options.targets];
  } else {
    chosen = [];
    for (const candidate of options.candidates ?? []) {
      /** @type {number | null} */
      let available = null;
      try {
        available = availableBytes(candidate);
      } catch {
        // A reader that throws is a candidate whose filesystem could not be read — the same reading
        // `fsAvailableBytes` gives for a path no `statfs` reaches.
        available = null;
      }
      // The first candidate with room, not every candidate with room: the run has one scratch root,
      // and a run that prepared a second one would be writing its profile into two places. Tested on
      // `available` itself rather than on a derived boolean so the accepted reading below is provably
      // a number.
      if (available !== null && available >= needBytes) {
        readings.push({ path: candidate, availableBytes: available, ok: true });
        chosen.push(candidate);
        break;
      }
      readings.push({ path: candidate, availableBytes: available, ok: false });
    }
    if (chosen.length === 0) {
      return {
        ok: false,
        reason: describeShortfall(needBytes, readings),
        readings,
        target: '',
        elapsedMs: 0,
        budgetMs,
      };
    }
  }

  const pending = chosen.filter((target) => !isWarmed(target));
  const startedAt = now();
  if (pending.length === 0) {
    return {
      ok: true,
      skipped: true,
      targets: [],
      readings,
      elapsedMs: now() - startedAt,
      prepared: chosen,
    };
  }

  /** @type {{ target: string, elapsedMs: number, availableBytes: number | null }[]} */
  const warmed = [];
  for (const target of pending) {
    const at = now();
    warm(target);
    const elapsed = now() - at;
    const reading = readings.find((candidate) => candidate.path === target);
    warmed.push({ target, elapsedMs: elapsed, availableBytes: reading?.availableBytes ?? null });
    const total = now() - startedAt;
    if (total > budgetMs) {
      return {
        ok: false,
        reason: describeOverrun(target, total, budgetMs),
        readings,
        target,
        elapsedMs: total,
        budgetMs,
      };
    }
  }

  return {
    ok: true,
    skipped: false,
    targets: pending,
    readings,
    elapsedMs: now() - startedAt,
    prepared: chosen,
    warmed,
  };
};
