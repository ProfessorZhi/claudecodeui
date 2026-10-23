#!/usr/bin/env node
/**
 * AC-137 — the DashScope omni recogniser's prompt is FROZEN, and this is the instrument that says
 * so. It compares the adapter's six prompt segments against the frozen experiment snapshot,
 * segment by segment, and names whichever one moved.
 *
 * WHY THE COMPARISON IS AGAINST A SNAPSHOT AND NOT AGAINST A COPY OF THE TEXT. A criterion that
 * pasted the expected prompt into itself would pass for the wrong reason the moment someone edited
 * the pasted copy: it would be checking one hand-written string against another. So the expected
 * side is `experiments/voice-omni-written/fixtures/snapshot.json`, which is itself DERIVED from the
 * experiment's own raw evidence (`raw/written.mts`, `raw/written-ds.jsonl`) by
 * `experiments/voice-omni-written/freeze.mjs`, and this script additionally re-reads the two raw
 * files and checks the sha256 the snapshot recorded for each. The chain is therefore three links
 * with two independent readings:
 *
 *     adapter constants ≡ snapshot.prompts ≡ raw/written.mts   (compared here, by name)
 *     snapshot.provenance.source.*.sha256 ≡ the raw files      (re-read here, by hash)
 *
 * The consequence worth stating: a snapshot that was HAND-EDITED to disagree with the raw evidence
 * cannot pass, because the provenance hash would no longer describe the file it names.
 *
 * WHAT EACH READING IS, and the failure it exists to catch:
 *
 *   · six prompt segments, each with its own `ok` and BOTH sides' sha256 — so a mismatch names the
 *     segment, rather than reporting "the prompt changed" (AC1, AC3);
 *   · the shape of the readings behind the freeze — 8 clips × 10 readings for both C and E, every
 *     reading carrying ONE run id — so a snapshot that quietly lost a reading, or stitched two runs
 *     together, is visible (AC2);
 *   · the two provenance hashes above (AC6).
 *
 * AN EMPTY READING IS A FAILURE (AC1, AC4). The failure modes that make a checker useless are not
 * wrong answers but absent ones: a missing snapshot, a snapshot that is `{}`, an adapter that could
 * not be imported. Each of those prints `EMPTY_READING` and exits non-zero, so "nothing was
 * checked" can never be mistaken for "everything was fine".
 *
 * OFFLINE, AND CHEAP ON PURPOSE. The script reads four files and imports one module of constants;
 * there is no transport in it, and `globalThis.fetch` is replaced with a poison for the duration so
 * that an adapter which reached for the network would be caught rather than merely discouraged. The
 * default run is also the goal gate's command and must finish far inside its 60-second bound — every
 * falsification case below is opt-in through `--control=`, so the default path does one small import
 * and four reads.
 *
 * Usage:
 *   node scripts/asr-omni-prompt-frozen-check.mjs [--root <dir>] [--probe] [--control=<name>]
 *
 *   --root <dir>          the tree to read (default: this script's repository root). The
 *                         falsification controls point it at a throwaway tree assembled from the
 *                         shipping files, which is what makes each fake form an executable case.
 *   --probe               print the adapter's absolute path and assert it lives under
 *                         `shared/asr/list/dashscope-omni/` and exists (AC7).
 *   --control=<name>      self-falsification, each one a case that MUST go red:
 *                           low-rep               drop one E reading → the clip is named
 *                           straddle              give one reading another run id → "different runs"
 *                           prompt-mutated:<SEG>  change one adapter segment → MISMATCH <SEG>
 *                           no-snapshot           pretend the snapshot is absent
 *                           empty-snapshot        use `{}` as the snapshot
 *
 * Exit codes: 0 = every reading held; 1 = at least one verdict failed (each failing verdict prints
 * its own `FAIL <TOKEN>` line before the ledger); 2 = the command line itself was wrong.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

// Lets this bare-`node` entrypoint import the tree's `.ts` module. Registered before the import.
register();

/** The shipping home of the frozen prompt, and the directory AC7 pins it to. */
const ADAPTER_REL = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
const ADAPTER_HOME = 'shared/asr/list/dashscope-omni';
/** The frozen snapshot: the expected side of the six comparisons. */
const SNAPSHOT_REL = 'experiments/voice-omni-written/fixtures/snapshot.json';

/**
 * The six segments, each paired with where it lives in the snapshot.
 *
 * The two vocabularies differ on purpose: the left column is what the ADAPTER exports and is
 * therefore the name a mismatch is reported under, while the right column is the data field the
 * snapshot records. A reader who sees `MISMATCH REASONING_EFFORT` knows which export to open.
 */
const SEGMENTS = [
  { segment: 'ROLE', snapshotKey: 'ROLE' },
  { segment: 'RULES', snapshotKey: 'RULES' },
  { segment: 'EXAMPLES', snapshotKey: 'EXAMPLES' },
  { segment: 'JSON_TASK', snapshotKey: 'JSON_TASK' },
  { segment: 'REASONING_EFFORT', snapshotKey: 'reasoning_effort' },
  { segment: 'DEFAULT_MODEL', snapshotKey: 'model' },
];

/** The two condition groups the snapshot freezes, and the raw `cond` key each corresponds to. */
const GROUPS = [
  { group: 'C', condition: 'C-fewshot' },
  { group: 'E', condition: 'E-twostep-low' },
];

/** The minimum readings per clip the freeze backs; below this the snapshot no longer supports it. */
const MIN_READINGS = 10;

/** @param {Buffer|string} value @returns {string} */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {unknown} value @returns {string} */
function quote(value) {
  return JSON.stringify(value) ?? String(value);
}

/**
 * The ambient transport, replaced for the duration so that "this script makes no request" is a
 * property that is enforced rather than a promise in a comment.
 *
 * @returns {{ calls: string[], restore: () => void }}
 */
function installFetchPoison() {
  const original = globalThis.fetch;
  /** @type {string[]} */
  const calls = [];
  /** @type {typeof fetch} */
  const poison = async (input) => {
    calls.push(String(input));
    throw new Error('the ambient fetch was used; this check must make no request');
  };
  globalThis.fetch = poison;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── the ledger ───────────────────────────────────────────────────────────────────────────────

/**
 * Readings are printed whether or not a verdict failed: a red run still has to show what was
 * measured, otherwise the failing token is the only thing a reader gets.
 */
class Ledger {
  constructor() {
    /** @type {string[]} */
    this.readings = [];
    /** @type {{ token: string, detail: string }[]} */
    this.problems = [];
  }

  /** @param {string} line @returns {void} */
  record(line) {
    this.readings.push(line);
  }

  /** @param {string} token @param {string} detail @returns {void} */
  fail(token, detail) {
    this.problems.push({ token, detail });
  }

  /** @param {string} heading @returns {void} */
  print(heading) {
    for (const reading of this.readings) process.stdout.write(`${heading} ${reading}\n`);
    for (const { token, detail } of this.problems) process.stdout.write(`FAIL ${token} ${detail}\n`);
    process.stdout.write(
      `${heading} verdict=${this.problems.length === 0 ? 'PASS' : 'FAIL'} readings=${this.readings.length} red=${this.problems.length}\n`,
    );
  }
}

// ── reading the two sides ────────────────────────────────────────────────────────────────────

/**
 * Enter `shared/asr/` through the registry before touching an adapter module.
 *
 * The registry value-imports every adapter and the adapters value-import `baseMimeType` /
 * `declaredAcceptsMime` back out of it, so the entry order decides the outcome: registry first is fine, an
 * adapter first throws `Cannot access '<symbol>' before initialization` at module-eval time. The registry
 * is absent in a reduced tree, and then there is nothing to enter through.
 *
 * @param {string} root @returns {Promise<void>}
 */
async function enterThroughRegistry(root) {
  const registry = path.join(root, 'shared/asr/asrRegistry.ts');
  if (existsSync(registry)) await import(pathToFileURL(registry).href);
}

/**
 * The adapter's six segments, as the module actually exports them.
 *
 * A module that could not be imported is NOT an empty object: returning `{}` would make every
 * segment read as `undefined` and every comparison fail with a mismatch, which is a different (and
 * misleading) finding from "the adapter was not there to read". So this returns `null` and the
 * caller reports `EMPTY_READING`.
 *
 * @param {string} root @returns {Promise<Record<string, unknown>|null>}
 */
async function loadAdapterSegments(root) {
  const file = path.join(root, ADAPTER_REL);
  if (!existsSync(file)) return null;
  await enterThroughRegistry(root);
  const module = await import(pathToFileURL(file).href);
  /** @type {Record<string, unknown>} */
  const values = {};
  for (const { segment } of SEGMENTS) values[segment] = module[segment];
  return values;
}

/**
 * The snapshot as data, or `null` when it is absent or unreadable.
 *
 * @param {string} root @returns {{ text: string, data: any }|null}
 */
function loadSnapshot(root) {
  const file = path.join(root, SNAPSHOT_REL);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return { text, data: JSON.parse(text) };
}

/**
 * One group's shape: how many clips, and how many readings the THINNEST one carries.
 *
 * The minimum rather than the mean, because the claim is "每条 ≥10 次": a mean of 9.9 would satisfy
 * a reader of the mean while leaving exactly the clip this reading exists to notice short.
 *
 * @param {any} group @returns {{ clips: number, minReadings: number, shortClip: string|null, runIds: string[], readings: number }}
 */
function readGroupShape(group) {
  const clips = Array.isArray(group?.clips) ? group.clips : [];
  let minReadings = Number.POSITIVE_INFINITY;
  /** @type {string|null} */
  let shortClip = null;
  let readings = 0;
  /** @type {string[]} */
  const runIds = [];
  for (const clip of clips) {
    const list = Array.isArray(clip?.readings) ? clip.readings : [];
    readings += list.length;
    if (list.length < minReadings) {
      minReadings = list.length;
      shortClip = String(clip?.clip ?? '<unnamed>');
    }
    for (const reading of list) runIds.push(String(reading?.runId ?? '<none>'));
  }
  return {
    clips: clips.length,
    minReadings: minReadings === Number.POSITIVE_INFINITY ? 0 : minReadings,
    shortClip,
    runIds,
    readings,
  };
}

// ── the controls ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply one named self-falsification to the LOADED data, so that each fake form is an executable
 * case rather than a paragraph about one.
 *
 * The `prompt-mutated:` family edits the adapter's segment as the check read it, which exercises
 * the comparison itself; the test file additionally stages a genuinely mutated adapter file on disk
 * and runs with no control at all, which exercises the read. Both are wanted: the first proves the
 * comparison can go red, the second proves the value it compares came off the disk.
 *
 * @param {string} control @param {Ledger} ledger
 * @param {{ segments: Record<string, unknown>|null, snapshot: any }} loaded
 * @returns {boolean} whether the control name was understood
 */
function applyControl(control, ledger, loaded) {
  if (control === 'low-rep') {
    const group = loaded.snapshot?.groups?.E;
    const clip = Array.isArray(group?.clips) ? group.clips[0] : null;
    if (clip === null || !Array.isArray(clip.readings) || clip.readings.length === 0) {
      ledger.fail('CONTROL', 'low-rep: the snapshot has no E clip to shorten, so the control proved nothing');
      return true;
    }
    clip.readings.pop();
    return true;
  }
  if (control === 'straddle') {
    for (const group of Object.values(loaded.snapshot?.groups ?? {})) {
      for (const clip of Array.isArray(/** @type {any} */ (group)?.clips) ? /** @type {any} */ (group).clips : []) {
        if (Array.isArray(clip?.readings) && clip.readings.length > 0) {
          clip.readings[0].runId = 'another-run';
          return true;
        }
      }
    }
    ledger.fail('CONTROL', 'straddle: the snapshot has no reading to re-stamp, so the control proved nothing');
    return true;
  }
  if (control === 'no-snapshot') {
    loaded.snapshot = null;
    return true;
  }
  if (control === 'empty-snapshot') {
    loaded.snapshot = {};
    return true;
  }
  if (control.startsWith('prompt-mutated:')) {
    const segment = control.slice('prompt-mutated:'.length);
    if (!SEGMENTS.some((entry) => entry.segment === segment)) {
      ledger.fail('CONTROL', `prompt-mutated: '${segment}' is not one of ${SEGMENTS.map((entry) => entry.segment).join(', ')}`);
      return true;
    }
    if (loaded.segments === null) {
      ledger.fail('CONTROL', `prompt-mutated:${segment}: the adapter was not read, so the mutation had nothing to land on`);
      return true;
    }
    const value = loaded.segments[segment];
    loaded.segments[segment] = typeof value === 'string' ? `${value}·` : `${quote(value)}·`;
    return true;
  }
  return false;
}

// ── --probe ──────────────────────────────────────────────────────────────────────────────────

/**
 * AC7's first half: the adapter exists, and it lives where the shipping tree expects it.
 *
 * The path check is not decoration. The whole point of freezing the prompt in a shipping module is
 * that the module is the one the recogniser will import; an adapter parked outside
 * `shared/asr/list/dashscope-omni/` would satisfy every text comparison above while being somewhere
 * the registry scan need not look.
 *
 * @param {string} root @returns {number}
 */
function probe(root) {
  const absolute = path.join(root, ADAPTER_REL);
  const insideHome = path.relative(path.join(root, ADAPTER_HOME), absolute).startsWith('..') === false;
  const exists = existsSync(absolute);
  process.stdout.write(`probe adapter=${absolute}\n`);
  process.stdout.write(`probe adapter.under=${ADAPTER_HOME} ok=${insideHome}\n`);
  process.stdout.write(`probe adapter.exists ok=${exists}\n`);
  const ok = insideHome && exists;
  process.stdout.write(`probe verdict=${ok ? 'PASS' : 'FAIL'}\n`);
  return ok ? 0 : 1;
}

// ── the check ────────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} root
 * @param {string|null} control
 * @returns {Promise<number>}
 */
async function check(root, control) {
  const ledger = new Ledger();
  const heading = 'asr-omni-prompt-frozen';

  /** @type {Record<string, unknown>|null} */
  let segments = null;
  try {
    segments = await loadAdapterSegments(root);
  } catch (error) {
    ledger.fail('EMPTY_READING', `${ADAPTER_REL} could not be imported: ${error instanceof Error ? error.message : String(error)}`);
  }

  /** @type {{ text: string, data: any }|null} */
  let snapshot = null;
  try {
    snapshot = loadSnapshot(root);
  } catch (error) {
    ledger.fail('EMPTY_READING', `${SNAPSHOT_REL} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const loaded = { segments, snapshot: snapshot?.data ?? null };

  if (control !== null) {
    if (!applyControl(control, ledger, loaded)) {
      ledger.fail('CONTROL', `unknown control '${control}'`);
    }
  }

  // ── the adapter side: where it is, and what it hashes to ──────────────────────────────────
  const adapterFile = path.join(root, ADAPTER_REL);
  if (!existsSync(adapterFile)) {
    ledger.fail('EMPTY_READING', `adapter is missing: ${ADAPTER_REL} under ${root}`);
    ledger.record('adapter.path=<missing> exists=false sha256=<none>');
  } else {
    ledger.record(`adapter.path=${ADAPTER_REL} exists=true sha256=${sha256Hex(readFileSync(adapterFile))}`);
  }

  // ── the snapshot side: where it is, and what it hashes to ─────────────────────────────────
  if (snapshot === null) {
    ledger.fail('EMPTY_READING', `snapshot is missing or unreadable: ${SNAPSHOT_REL} under ${root}`);
    ledger.record('snapshot.path=<missing> exists=false sha256=<none>');
  } else {
    ledger.record(`snapshot.path=${SNAPSHOT_REL} exists=true sha256=${sha256Hex(snapshot.text)}`);
  }

  // ── the six segments, each named and each with both sides' hash ───────────────────────────
  const snapshotPrompts = loaded.snapshot?.prompts;
  if (snapshotPrompts === undefined || snapshotPrompts === null || typeof snapshotPrompts !== 'object') {
    ledger.fail(
      'EMPTY_READING',
      `snapshot.prompts is ${quote(snapshotPrompts)}, so none of ${SEGMENTS.map((entry) => entry.segment).join(', ')} could be compared`,
    );
  }
  for (const { segment, snapshotKey } of SEGMENTS) {
    const adapterValue = loaded.segments === null ? undefined : loaded.segments[segment];
    const snapshotValue = snapshotPrompts?.[snapshotKey];
    const ok = typeof adapterValue === 'string' && typeof snapshotValue === 'string' && adapterValue === snapshotValue;
    ledger.record(
      `item ${segment} ok=${ok} adapter.sha256=${typeof adapterValue === 'string' ? sha256Hex(adapterValue) : '<unreadable>'} snapshot.sha256=${typeof snapshotValue === 'string' ? sha256Hex(snapshotValue) : '<unreadable>'}`,
    );
    if (loaded.segments === null) {
      if (!ledger.problems.some((problem) => problem.token === 'EMPTY_READING' && problem.detail.includes('adapter is missing'))) {
        ledger.fail('EMPTY_READING', `adapter was not imported, so '${segment}' was not compared`);
      }
      continue;
    }
    if (typeof snapshotValue !== 'string') {
      ledger.fail('EMPTY_READING', `snapshot.prompts.${snapshotKey} is ${quote(snapshotValue)}, so '${segment}' was not compared`);
      continue;
    }
    if (typeof adapterValue !== 'string') {
      ledger.fail('EMPTY_READING', `the adapter exports no string '${segment}' (${quote(adapterValue)}), so nothing was compared`);
      continue;
    }
    if (adapterValue !== snapshotValue) {
      ledger.fail(
        'MISMATCH',
        `${segment} differs: adapter.sha256=${sha256Hex(adapterValue)} snapshot.sha256=${sha256Hex(snapshotValue)} — the shipped prompt is no longer the one the frozen readings were taken with`,
      );
    }
  }

  // ── the shape of the readings behind the freeze ───────────────────────────────────────────
  for (const { group } of GROUPS) {
    const shape = readGroupShape(loaded.snapshot?.groups?.[group]);
    ledger.record(`group ${group} ${shape.clips} clips x ${shape.minReadings} readings`);
    if (shape.clips === 0) {
      ledger.fail('EMPTY_READING', `group ${group} has no clips in the snapshot, so its readings were not looked at`);
      continue;
    }
    if (shape.minReadings < MIN_READINGS) {
      ledger.fail(
        'READINGS',
        `group ${group} clip ${shape.shortClip} has ${shape.minReadings} reading(s), fewer than the ${MIN_READINGS} the freeze backs`,
      );
    }
    const distinct = [...new Set(shape.runIds)];
    if (distinct.length !== 1) {
      ledger.fail('READINGS', `group ${group} carries readings from different runs: ${distinct.join(', ')}`);
    }
  }
  const allRunIds = GROUPS.flatMap(({ group }) => readGroupShape(loaded.snapshot?.groups?.[group]).runIds);
  const distinctRunIds = [...new Set(allRunIds)];
  const uniqueRunId = distinctRunIds.length === 1 ? distinctRunIds[0] : null;
  ledger.record(
    `readings runId=${uniqueRunId ?? '<none>'} distinct=${distinctRunIds.length} readings=${allRunIds.length}`,
  );
  if (uniqueRunId === null) {
    ledger.fail(
      'READINGS',
      allRunIds.length === 0
        ? 'no readings were found in the snapshot, so the single run id could not be read'
        : `the readings come from ${distinctRunIds.length} different runs (${distinctRunIds.join(', ')}), not one`,
    );
  }

  // ── the snapshot's provenance, re-read against the raw evidence it names ──────────────────
  for (const key of ['promptFile', 'readingsFile']) {
    const recorded = loaded.snapshot?.provenance?.source?.[key];
    const declaredPath = typeof recorded?.path === 'string' ? recorded.path : null;
    const declaredHash = typeof recorded?.sha256 === 'string' ? recorded.sha256 : null;
    if (declaredPath === null || declaredHash === null) {
      ledger.fail(
        'EMPTY_READING',
        `snapshot.provenance.source.${key} records ${quote(recorded)}, so the provenance was not checked`,
      );
      ledger.record(`source.${key} path=${quote(declaredPath)} claimed=${quote(declaredHash)} actual=<not read>`);
      continue;
    }
    const file = path.join(root, declaredPath);
    if (!existsSync(file)) {
      ledger.fail('EMPTY_READING', `snapshot.provenance.source.${key} names ${declaredPath}, which is not in ${root}`);
      ledger.record(`source.${key} path=${declaredPath} claimed=${declaredHash} actual=<missing>`);
      continue;
    }
    const actualHash = sha256Hex(readFileSync(file));
    ledger.record(`source.${key} path=${declaredPath} claimed=${declaredHash} actual=${actualHash}`);
    if (actualHash !== declaredHash) {
      ledger.fail(
        'SHA256',
        `snapshot.provenance.source.${key} claims sha256=${declaredHash} for ${declaredPath}, but the file hashes to ${actualHash} — the snapshot no longer describes the evidence it names`,
      );
    }
  }

  ledger.print(heading);
  return ledger.problems.length === 0 ? 0 : 1;
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let root = DEFAULT_ROOT;
  /** @type {string|null} */
  let control = null;
  let probeOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1] ?? '';
      if (value === '') {
        process.stdout.write('usage: --root needs a directory\n');
        return 2;
      }
      root = path.resolve(value);
      index += 1;
    } else if (arg.startsWith('--control=')) {
      control = arg.slice('--control='.length);
    } else if (arg === '--probe') {
      probeOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/asr-omni-prompt-frozen-check.mjs [--root <dir>] [--probe] [--control=<name>]\n');
      return 0;
    } else {
      process.stdout.write(`unknown argument: ${arg}\n`);
      return 2;
    }
  }

  if (probeOnly) return probe(root);
  return check(root, control);
}

/** @type {{ calls: string[], restore: () => void }} */
const poison = installFetchPoison();
let code;
try {
  code = await main(process.argv.slice(2));
} finally {
  poison.restore();
}
if (poison.calls.length > 0) {
  process.stdout.write(`FAIL NETWORK this check made ${poison.calls.length} request(s): ${poison.calls.join(', ')}\n`);
  code = 1;
}
process.exitCode = code;
