#!/usr/bin/env node
/**
 * AC-130's criterion: the four readings the extraction must not move, byte for byte.
 *
 *   node scripts/asr-extraction-parity-check.mjs                  # check against the baseline
 *   node scripts/asr-extraction-parity-check.mjs --check          # the same, spelled out
 *   node scripts/asr-extraction-parity-check.mjs --explain-sites  # the four driven sites + fixture
 *   node scripts/asr-extraction-parity-check.mjs --record         # (re)record, from a clean tree
 *   node scripts/asr-extraction-parity-check.mjs --root <tree>    # drive another tree
 *
 * WHAT IS COMPARED, AND WHY IT IS THE NORMALIZED READING
 *
 * Four groups, each recorded as a normalized capture of one hop (or one tolerance) and compared
 * byte for byte against `scripts/__fixtures__/asr-extraction-parity-baseline.json`:
 *
 *   inbound             client -> server `POST /api/voice/transcribe` (proxy path only): the
 *                       `audio` form field, the `x-voice-*` headers, the multipart body, URL, verb
 *   direct-outbound     client -> recogniser `POST <baseUrl>/audio/transcriptions`: `file` +
 *                       `model`, `Authorization`, and no declared `Content-Type` (the body is a
 *                       FormData, so the encoder supplies one)
 *   proxy-outbound      server -> recogniser, same URL shape: `file` + `model`, `Authorization`
 *   response-tolerance  both paths' response parsing: the direct path throws on a body that is not
 *                       JSON, the proxy uses it as the transcript
 *
 * The comparison is on the normalized reading and not on raw bytes because the multipart boundary
 * is generated fresh by the platform encoder on every serialization: raw bytes would be red on the
 * first run and on every run after it, and a criterion that can never go green is exactly as
 * useless as one that can never go red. Only the boundary is normalized away; part names,
 * filenames, part content types, the audio bytes, the URL, the verb and the declared headers are
 * compared verbatim. That definition lives in the readers, because they are the ones that observe.
 *
 * WHY THE READERS, AND WHY THIS FILE DOES NOT IMPLEMENT ANYTHING ITSELF
 *
 * Both readers live under `experiments/` and drive the shipping symbols (`transcribeVoice`,
 * `parseTranscriptionResponse`, `createVoiceService`); nothing here re-implements a multipart body
 * or a response parse, because a reading of this file would not be a reading of the app. This file
 * only runs them, compares, and decides. `experiments/**` is outside every tsconfig include and
 * outside `npm run lint`'s path list, so the readers are not covered by a static gate — which is
 * why every failure below is fail-closed on *absence*: a missing reader, an empty readings list, a
 * missing seam symbol and a reader that exits non-zero are all red, never a silent green.
 *
 * FAKE SHAPES THIS IS BUILT TO GO RED ON (each has a named case in the sibling test)
 *
 *   (1) renaming the inbound form field `audio` -> `file`. If the baseline covered only the
 *       outbound hops this would stay green, which is why `inbound` is one of the four.
 *   (2) making the seam as tolerant as the proxy. `response-tolerance` names that group.
 *   (3) a reader that is missing, or prints nothing, or dies: `reader-missing` / `no readings` /
 *       `reader-failed`.
 *   (4) a baseline recorded *after* the extraction: `baseline-not-pre-extraction`, decided from
 *       `git show <recordedFromCommit>:src/shared/api.ts` still carrying the inline inbound field
 *       write, and from that commit being an ancestor of HEAD.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = dirname(HERE);

const BASELINE_REL = join('scripts', '__fixtures__', 'asr-extraction-parity-baseline.json');
const READ_CLIENT_REL = join('experiments', 'voice-asr-parity', 'read-client.ts');
const READ_SERVER_REL = join('experiments', 'voice-asr-parity', 'read-server.ts');
const API_REL = 'src/shared/api.ts';

/** The four groups, in the order they are printed. */
const GROUPS = ['inbound', 'direct-outbound', 'proxy-outbound', 'response-tolerance'];

/** The marker every reading line starts with, and the one the fixture line uses. */
const MARKER = 'ASR-PARITY-READING ';
const FIXTURE_MARKER = 'ASR-PARITY-FIXTURE ';

/**
 * Per-reader wall-clock bound. Generous: the reader loads the shipped module graph through tsx,
 * which is seconds, and a bound a slow machine could reach would turn a load hiccup into a verdict.
 * It exists so a hung reader is reported as `reader-failed` rather than hanging the criterion.
 */
const READER_TIMEOUT_MS = 120000;

/** The seam this criterion drives for the direct path's response tolerance. */
const SEAM_DECLARATION = 'export async function parseTranscriptionResponse';

/**
 * The inline inbound field write. Its presence in `<recordedFromCommit>:src/shared/api.ts` is what
 * makes a baseline *pre*-extraction: once the four hardcoded sites are extracted into one
 * implementation this line moves, and a baseline recorded after that would be a recording of the
 * extraction's own output — after which "zero change" could never be demonstrated again.
 */
const PRE_EXTRACTION_INLINE_INBOUND = "append('audio'";

/**
 * The one line in each reader that declares the synthetic audio, read back here so the baseline's
 * `audio.sha256` is tied to the bytes the readers actually measured rather than to a value copied
 * into a second place. The readers declare it twice (they cannot share a module: the two alias
 * tables are mutually exclusive), so both declarations are read and must agree.
 */
const FIXTURE_DECLARATION = /SYNTHETIC_AUDIO_TEXT\s*=\s*'([^']*)'/;

/**
 * @typedef {{ url: string, method: string, headers: Array<[string, string]>, body: unknown }} CapturedRequest
 * @typedef {{ group: string, half?: string, site?: { symbol?: string, file?: string }, value: unknown }} Reading
 * @typedef {{ source: string, name: string, mimeType: string, bytes: number, sha256: string }} FixtureLine
 * @typedef {{ ok: boolean, stdout: string, reason: string }} ReaderRun
 * @typedef {{ reasons: string[], readings: Reading[], fixtures: FixtureLine[] }} Collected
 * @typedef {{ recordedFromCommit?: unknown, recordedAt?: unknown, recordedInWorktree?: unknown }} Provenance
 * @typedef {{ provenance?: Provenance, audio?: { sha256?: unknown }, readings?: Record<string, unknown>, sha256?: unknown }} Baseline
 * @typedef {{ reasons: string[], baseline: Baseline | null, collected: Collected, groups: Record<string, unknown>, missing: string[] }} Observation
 */

/**
 * @param {string | Uint8Array} input
 * @returns {string}
 */
function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Canonical JSON: object keys sorted, so "the same reading" is "the same bytes" regardless of the
 * order a value's keys were built in on either side of the comparison.
 *
 * @param {unknown} value
 * @returns {string}
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The identity of a whole reading set: the four groups' canonical bytes, in a fixed order.
 *
 * @param {Record<string, unknown>} readings
 * @returns {string}
 */
function readingsHash(readings) {
  return sha256Hex(GROUPS.map((group) => `${group}\n${canonical(readings[group])}`).join('\n'));
}

/**
 * @param {string} root
 * @param {string[]} args
 * @returns {string}
 */
function git(root, args) {
  return String(execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }));
}

let tsxCliCache = '';
/**
 * The tsx entry point, resolved from THIS file so a driven tree needs no node_modules of its own.
 *
 * @returns {string}
 */
function tsxCliPath() {
  if (!tsxCliCache) {
    tsxCliCache = createRequire(import.meta.url).resolve('tsx/cli');
  }
  return tsxCliCache;
}

/**
 * Runs one reader and returns what it printed.
 *
 * `cwd` is the driven tree, and so is the tsconfig handed to tsx: that is the whole reason
 * `--root` works — the reader's `@/*` imports resolve through the driven tree's own alias table,
 * so the symbols it loads are that tree's shipping code.
 *
 * @param {string} root
 * @param {string} readerRel
 * @param {string} tsconfigRel
 * @returns {ReaderRun}
 */
function runReader(root, readerRel, tsconfigRel) {
  const readerPath = join(root, readerRel);
  if (!existsSync(readerPath)) {
    return { ok: false, stdout: '', reason: `reader-missing: ${readerRel} does not exist in ${root}` };
  }

  const result = spawnSync(
    process.execPath,
    [tsxCliPath(), '--tsconfig', join(root, tsconfigRel), readerPath],
    { cwd: root, encoding: 'utf8', timeout: READER_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  const stdout = String(result.stdout ?? '');

  if (result.error) {
    return { ok: false, stdout, reason: `reader-failed: ${readerRel} did not finish (${result.error.message})` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr ?? '').trim().split('\n').slice(-4).join(' | ');
    return {
      ok: false,
      stdout,
      reason: `reader-failed: ${readerRel} exited ${String(result.status)} (${stderr || 'no stderr'})`,
    };
  }
  return { ok: true, stdout, reason: '' };
}

/**
 * Every `ASR-PARITY-READING` line a reader printed, as readings. Non-marker output is ignored.
 *
 * @param {string} stdout
 * @returns {Reading[]}
 */
function parseReadingLines(stdout) {
  /** @type {Reading[]} */
  const readings = [];
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(MARKER)) continue;
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(line.slice(MARKER.length));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const reading = /** @type {Reading} */ (parsed);
    if (typeof reading.group !== 'string') continue;
    readings.push(reading);
  }
  return readings;
}

/**
 * The fixture line a reader printed, or null.
 *
 * @param {string} stdout
 * @returns {FixtureLine | null}
 */
function parseFixtureLine(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith(FIXTURE_MARKER)) continue;
    try {
      const parsed = JSON.parse(line.slice(FIXTURE_MARKER.length));
      if (parsed && typeof parsed === 'object' && typeof parsed.sha256 === 'string') {
        return /** @type {FixtureLine} */ (parsed);
      }
    } catch {
      // A malformed fixture line is an absent one; the caller treats absence as a red.
    }
  }
  return null;
}

/**
 * Runs both readers and returns their readings, fixture lines, and any reader-level failure.
 *
 * @param {string} root
 * @returns {Collected}
 */
function collect(root) {
  const reasons = [];
  /** @type {Reading[]} */
  const readings = [];
  /** @type {FixtureLine[]} */
  const fixtures = [];

  for (const [readerRel, tsconfigRel] of [
    [READ_CLIENT_REL, 'tsconfig.json'],
    [READ_SERVER_REL, join('server', 'tsconfig.json')],
  ]) {
    const run = runReader(root, readerRel, tsconfigRel);
    if (!run.ok) {
      reasons.push(run.reason);
      continue;
    }
    readings.push(...parseReadingLines(run.stdout));
    const fixture = parseFixtureLine(run.stdout);
    if (fixture) fixtures.push(fixture);
  }

  return { reasons, readings, fixtures };
}

/**
 * Folds the readings into the four named groups; `response-tolerance` gains its two halves.
 *
 * @param {Reading[]} readings
 * @returns {Record<string, unknown>}
 */
function assembleGroups(readings) {
  /** @type {Record<string, unknown>} */
  const groups = {};
  for (const reading of readings) {
    if (typeof reading.half === 'string') {
      const halves = /** @type {Record<string, unknown>} */ (groups[reading.group] ?? {});
      halves[reading.half] = reading.value;
      groups[reading.group] = halves;
    } else {
      groups[reading.group] = reading.value;
    }
  }
  return groups;
}

/**
 * The groups that are absent, or present without the two halves `response-tolerance` needs.
 *
 * @param {Record<string, unknown>} groups
 * @returns {string[]}
 */
function incompleteGroups(groups) {
  const missing = GROUPS.filter((group) => !(group in groups));
  const tolerance = /** @type {Record<string, unknown>} */ (groups['response-tolerance'] ?? {});
  if (!('direct' in tolerance)) missing.push('response-tolerance/direct');
  if (!('proxy' in tolerance)) missing.push('response-tolerance/proxy');
  return missing;
}

/**
 * The synthetic audio each reader declared, as a sha256 over the declared bytes.
 *
 * Read out of the readers' own source rather than from a value this file keeps a copy of: the
 * declaration is the readers' statement of what they measured, and comparing the baseline against
 * it is what makes `audio.sha256` mean "the baseline was recorded on these bytes".
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
function declaredFixture(root) {
  /** @type {Record<string, string>} */
  const declared = {};
  for (const readerRel of [READ_CLIENT_REL, READ_SERVER_REL]) {
    const path = join(root, readerRel);
    if (!existsSync(path)) continue;
    const match = FIXTURE_DECLARATION.exec(readFileSync(path, 'utf8'));
    if (match) declared[readerRel] = sha256Hex(Buffer.from(match[1], 'utf8'));
  }
  return declared;
}

/**
 * Every reason the fixture story can fail. Shared by `--check` and `--record`, so a recording is
 * held to the same agreement between the two readers' declarations and their reported lines.
 *
 * @param {string} root
 * @param {Collected} collected
 * @param {Baseline | null} baseline Pass null when recording: the baseline being replaced is not
 *   evidence about the fixture the current readers measure.
 * @returns {string[]}
 */
function fixtureReasons(root, collected, baseline) {
  const reasons = [];
  const declaredValues = Object.values(declaredFixture(root));
  if (declaredValues.length !== 2) {
    reasons.push('fixture-declaration-missing: a reader declares no SYNTHETIC_AUDIO_TEXT');
  } else if (new Set(declaredValues).size !== 1) {
    reasons.push('fixture-mismatch: the two readers declare different synthetic audio');
  }

  const reported = collected.fixtures.map((fixture) => fixture.sha256);
  if (reported.length !== 2) {
    reasons.push('fixture-missing: a reader reported no fixture line');
  } else if (new Set(reported).size !== 1) {
    reasons.push('fixture-mismatch: the two readers reported different synthetic audio');
  }

  if (declaredValues.length === 2 && reported.length === 2) {
    if (declaredValues[0] !== reported[0]) {
      reasons.push(`fixture-mismatch: declared=${declaredValues[0]} reported=${reported[0]}`);
    }
    const recordedAudio = baseline?.audio?.sha256;
    if (typeof recordedAudio === 'string' && recordedAudio !== declaredValues[0]) {
      reasons.push(
        `fixture-mismatch: baseline audio.sha256=${recordedAudio} declared=${declaredValues[0]}`,
      );
    }
  }

  return reasons;
}

/**
 * The provenance verdict, as the reason token or the empty string.
 *
 * `baseline-not-pre-extraction` covers all three ways the claim can fail — the recorded commit is
 * unreadable, it no longer carries the inline inbound field write, or it is not an ancestor of
 * HEAD — because they are one claim: "this baseline was taken from a state that still had the
 * hardcoded sites, before the extraction moved them".
 *
 * @param {string} root
 * @param {Baseline | null} baseline
 * @returns {string}
 */
function provenanceReason(root, baseline) {
  const recorded = baseline?.provenance?.recordedFromCommit;
  if (typeof recorded !== 'string' || recorded.length === 0) return 'baseline-not-pre-extraction';

  let source;
  try {
    source = git(root, ['show', `${recorded}:${API_REL}`]);
  } catch {
    return 'baseline-not-pre-extraction';
  }
  if (!source.includes(PRE_EXTRACTION_INLINE_INBOUND)) return 'baseline-not-pre-extraction';

  try {
    git(root, ['merge-base', '--is-ancestor', recorded, 'HEAD']);
  } catch {
    return 'baseline-not-pre-extraction';
  }
  return '';
}

/**
 * True when `file` really sits inside the driven tree's shipping sources.
 *
 * @param {string} root
 * @param {string} file
 * @returns {boolean}
 */
function insideShippingTree(root, file) {
  return file.startsWith(join(root, 'src') + sep) || file.startsWith(join(root, 'server') + sep);
}

/**
 * Reads the baseline; `null` when it is absent or unparseable.
 *
 * @param {string} root
 * @returns {Baseline | null}
 */
function loadBaseline(root) {
  const path = join(root, BASELINE_REL);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? /** @type {Baseline} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} text
 * @returns {void}
 */
function print(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * Every check the criterion makes, in one place so check, explain-sites and record share it.
 *
 * `requireBaseline` is off for the two modes that are not comparisons: `--explain-sites` reports
 * where the readings came from and `--record` is what produces the baseline in the first place.
 * Both would otherwise be red in a tree that has no baseline yet, for a reason that is about the
 * other mode.
 *
 * @param {string} root
 * @param {boolean} [requireBaseline]
 * @returns {Observation}
 */
function observe(root, requireBaseline = true) {
  const reasons = [];
  const baseline = loadBaseline(root);
  if (!baseline && requireBaseline) reasons.push(`baseline-missing: ${join(root, BASELINE_REL)}`);

  const seamPath = join(root, API_REL);
  if (!existsSync(seamPath) || !readFileSync(seamPath, 'utf8').includes(SEAM_DECLARATION)) {
    reasons.push(`seam-missing: ${SEAM_DECLARATION} is not declared in ${seamPath}`);
  }

  const collected = collect(root);
  reasons.push(...collected.reasons);

  if (collected.readings.length === 0) {
    reasons.push('no readings: no reader produced a single ASR-PARITY-READING line');
  }

  const groups = assembleGroups(collected.readings);
  const missing = collected.readings.length === 0 ? [] : incompleteGroups(groups);
  if (missing.length > 0) {
    reasons.push(`readings-incomplete: no reading for ${missing.join(', ')}`);
  }

  return { reasons, baseline, collected, groups, missing };
}

/**
 * @param {string[]} reasons
 * @returns {number}
 */
function fail(reasons) {
  for (const reason of reasons) print(`reason ${reason}`);
  print(`verdict FAIL reasons=${reasons.map((reason) => reason.split(':')[0]).join(',')}`);
  return 1;
}

/**
 * `--explain-sites`: the absolute path and symbol behind each group, plus the fixture.
 *
 * The paths are the readers' own (`import.meta.resolve`), not declared here, so a site that has
 * moved still reports where it actually is — and a site outside `src/` or `server/` is a red,
 * because the reading then came from something that does not ship.
 *
 * @param {string} root
 * @returns {string[]}
 */
function explainSites(root) {
  const { reasons, collected } = observe(root, false);

  for (const reading of collected.readings) {
    const label = typeof reading.half === 'string' ? `${reading.group}/${reading.half}` : reading.group;
    const file = typeof reading.site?.file === 'string' ? reading.site.file : '';
    const symbol = typeof reading.site?.symbol === 'string' ? reading.site.symbol : '';

    if (!file || !existsSync(file)) {
      reasons.push(`site-missing: ${label} drove no file (${file || 'none'})`);
      print(`site ${label} ${file || 'none'} symbol=${symbol} MISSING`);
      continue;
    }

    const real = realpathSync(file);
    const inside = insideShippingTree(root, real);
    print(`site ${label} ${real} symbol=${symbol} ${inside ? 'in-shipping-tree' : 'OUTSIDE-SHIPPING-TREE'}`);
    if (!inside) reasons.push(`site-outside-shipping-tree: ${label} drove ${real}`);
    if (!symbol || !readFileSync(real, 'utf8').includes(symbol)) {
      reasons.push(`site-symbol-missing: ${label} claims symbol ${symbol || '(none)'} in ${real}`);
    }
  }

  const fixture = collected.fixtures[0];
  if (!fixture) {
    reasons.push('fixture-missing: no reader declared its synthetic audio');
  } else {
    print(
      `fixture ${fixture.source} name=${fixture.name} mimeType=${fixture.mimeType} ` +
        `bytes=${String(fixture.bytes)} sha256=${fixture.sha256}`,
    );
  }

  return reasons;
}

/**
 * `--check` (the default): compare the driven readings against the recorded baseline.
 *
 * @param {string} root
 * @returns {number}
 */
function check(root) {
  const { reasons, baseline, collected, groups } = observe(root);

  // Provenance first: it is about the baseline rather than the tree, and it is the one reason a
  // reader cannot produce. Printed when it holds, so a green run states the claim it checked.
  if (baseline) {
    const provenance = provenanceReason(root, baseline);
    if (provenance) {
      reasons.push(`${provenance}: recordedFromCommit=${String(baseline.provenance?.recordedFromCommit)}`);
    } else {
      print(`pre-extraction ok recordedFromCommit=${String(baseline.provenance?.recordedFromCommit)}`);
    }
  }

  if (collected.readings.length > 0 && baseline) {
    for (const group of GROUPS) {
      const observed = canonical(groups[group]);
      const recorded = canonical(baseline.readings?.[group]);
      const equal = observed === recorded;
      print(`group ${group} ${equal ? 'equal' : 'differ'} sha256=${sha256Hex(Buffer.from(observed, 'utf8'))}`);
      if (!equal) reasons.push(`reading-differs: ${group}`);
    }
  }

  if (baseline) {
    const recordedHash = readingsHash(baseline.readings ?? {});
    print(`baseline sha256=${recordedHash}`);
    print(`baseline recordedFromCommit=${String(baseline.provenance?.recordedFromCommit)}`);
    if (typeof baseline.sha256 === 'string' && baseline.sha256 !== recordedHash) {
      reasons.push(`baseline-sha256-mismatch: stored=${baseline.sha256} recomputed=${recordedHash}`);
    }
    print(`observed sha256=${readingsHash(groups)}`);
  }

  reasons.push(...fixtureReasons(root, collected, baseline));

  return reasons.length > 0 ? fail(reasons) : (print('verdict PASS'), 0);
}

/**
 * `--record`: drive a clean tree and write the baseline it produced.
 *
 * @param {string} root
 * @returns {number}
 */
function record(root) {
  // Fail closed on a dirty shipping source: a baseline recorded next to uncommitted edits would be
  // attributed to `recordedFromCommit` while measuring something else, and the attribution is the
  // whole provenance claim.
  const dirty = git(root, ['status', '--porcelain', '--', 'src', 'server']).trim();
  if (dirty) {
    return fail([`record-refused: src/ or server/ has uncommitted changes\n${dirty}`]);
  }

  const recordedFromCommit = git(root, ['rev-parse', 'HEAD']).trim();
  const { reasons, collected, groups } = observe(root, false);
  reasons.push(...fixtureReasons(root, collected, null));

  const missing = incompleteGroups(groups);
  if (missing.length > 0) reasons.push(`readings-incomplete: no reading for ${missing.join(', ')}`);
  if (reasons.length > 0) return fail(reasons);

  const fixture = collected.fixtures[0];
  const baseline = {
    schema: 'asr-extraction-parity-baseline/v1',
    provenance: {
      recordedFromCommit,
      recordedAt: new Date().toISOString(),
      // False: recorded from the tree being recorded from, whose shipping sources are exactly
      // `recordedFromCommit`'s (asserted clean above). A baseline taken instead from a temporary
      // worktree checked out at an earlier commit would say true and name that commit.
      recordedInWorktree: false,
      recordedBy: 'scripts/asr-extraction-parity-check.mjs --record',
    },
    // The one audio fixture every reading was taken on; the probe re-derives this sha256 from the
    // readers' own declaration and refuses a baseline whose value does not match it.
    audio: {
      source: fixture.source,
      name: fixture.name,
      mimeType: fixture.mimeType,
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    },
    readings: groups,
    sha256: readingsHash(groups),
  };

  writeFileSync(join(root, BASELINE_REL), `${JSON.stringify(baseline, null, 2)}\n`);
  print(`recorded ${BASELINE_REL} from ${recordedFromCommit}`);
  for (const group of GROUPS) {
    print(`group ${group} sha256=${sha256Hex(Buffer.from(canonical(groups[group]), 'utf8'))}`);
  }
  print(`baseline sha256=${baseline.sha256}`);
  return print('verdict PASS'), 0;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  let root = PROBE_ROOT;
  let recordMode = false;
  let explainMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      root = argv[index + 1] ?? '';
      index += 1;
      if (!root) {
        print('usage: --root needs a path');
        return 2;
      }
    } else if (arg === '--record') {
      recordMode = true;
    } else if (arg === '--explain-sites') {
      explainMode = true;
    } else if (arg === '--check') {
      // The default, spelled out.
    } else if (arg === '--help' || arg === '-h') {
      print(
        'usage: node scripts/asr-extraction-parity-check.mjs [--check|--record|--explain-sites] [--root <tree>]',
      );
      return 0;
    } else {
      print(`unknown argument: ${arg}`);
      return 2;
    }
  }

  if (!existsSync(root)) {
    print(`root does not exist: ${root}`);
    return 2;
  }

  if (recordMode) return record(root);
  if (explainMode) {
    const reasons = explainSites(root);
    return reasons.length > 0 ? fail(reasons) : (print('verdict PASS'), 0);
  }
  return check(root);
}

process.exitCode = main(process.argv.slice(2));
