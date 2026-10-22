#!/usr/bin/env node
/**
 * The freeze: turn the repository's own raw readings into the frozen snapshot the criterion reads.
 *
 * WHY A GENERATOR AND NOT A COMMITTED CONSTANT. `experiments/voice-omni-written/raw/` is the
 * experiment's evidence and is immutable input; `fixtures/snapshot.json` is the SHAPE later code is
 * judged against. If the snapshot were hand-written, the two could drift apart silently — a typo in
 * the snapshot would look exactly like a typo in the adapter, and "the prompt is frozen" would be a
 * claim about a file nobody could re-derive. So the snapshot is a DETERMINISTIC FUNCTION of the raw
 * files, and `--check` re-runs that function and compares the result BYTE FOR BYTE:
 *
 *     node experiments/voice-omni-written/freeze.mjs            # (re)write fixtures/snapshot.json
 *     node experiments/voice-omni-written/freeze.mjs --check    # recompute and compare, write nothing
 *     node experiments/voice-omni-written/freeze.mjs --print    # the JSON on stdout, write nothing
 *     --root <dir>                                              # read/write another tree
 *
 * NOTHING IS SAMPLED AND NOTHING IS FETCHED. This script reads three files inside the tree and
 * imports `node:crypto` — there is no transport in it at all, which is what makes "offline" a
 * property of the program rather than a promise about it. The readings were taken on 2026-09-23/24
 * against a live, billed endpoint; re-running them is a human decision (ADR-004 decision 8), not
 * something a freeze does.
 *
 * WHAT IT REFUSES TO PRETEND. The C and E conditions' ten readings per clip are TWO API batches —
 * reps 0–2, then reps 3–9 — and the snapshot records that in `provenance.sourceBatches` instead of
 * flattening it into one tidy series. The verdict column of the experiment (the ✅/◐/❌ rubric in
 * `raw/judge.mts`) is deliberately NOT frozen here; see `provenance.judge` in the snapshot for why.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', '..');

/** The raw prompt source. The README is explicit that E's prompt is defined by THIS file. */
const PROMPT_REL = 'experiments/voice-omni-written/raw/written.mts';
/** The raw readings the freeze is derived from (DashScope endpoint, E group at `effort: low`). */
const READINGS_REL = 'experiments/voice-omni-written/raw/written-ds.jsonl';
/** Where the frozen snapshot lives. */
const SNAPSHOT_REL = 'experiments/voice-omni-written/fixtures/snapshot.json';

/**
 * The freeze's own identity, and a CONSTANT on purpose.
 *
 * It names this freeze, not the moment it ran: `--check` must recompute the same bytes on any day,
 * so a timestamp read from the clock would make the snapshot unreproducible by construction. The
 * readings' own window is recorded in `provenance.readingWindow` as the quoted fact it is.
 */
const RUN_ID = 'voice-omni-written-freeze-2026-09-24';
const FROZEN_AT = '2026-09-24';

/** The two conditions the snapshot freezes, and the raw `cond` key each corresponds to. */
const GROUPS = [
  { group: 'C', condition: 'C-fewshot' },
  { group: 'E', condition: 'E-twostep-low' },
];

/**
 * The segment names the criterion compares, paired with the key they live under in `prompts`.
 *
 * The two vocabularies differ on purpose: the criterion names the ADAPTER'S EXPORTS
 * (`REASONING_EFFORT`, `DEFAULT_MODEL`), while the snapshot names the WIRE/DATA fields
 * (`reasoning_effort`, `model`). Keeping both here is what lets a mismatch be reported under the
 * name a reader of the adapter can act on.
 */
const PROMPT_SEGMENTS = [
  { segment: 'ROLE', key: 'ROLE' },
  { segment: 'RULES', key: 'RULES' },
  { segment: 'EXAMPLES', key: 'EXAMPLES' },
  { segment: 'JSON_TASK', key: 'JSON_TASK' },
  { segment: 'REASONING_EFFORT', key: 'reasoning_effort' },
  { segment: 'DEFAULT_MODEL', key: 'model' },
];

/** The prompt literals lifted out of `written.mts`, in the order they are read there. */
const PROMPT_NAMES = ['ROLE', 'RULES', 'EXAMPLES', 'JSON_TASK'];

/**
 * The batches the ten readings per clip actually came from, as recorded in `raw/README.md`
 * ("前 3 次与后 7 次是两次运行"). The BOUNDARY is quoted knowledge — the raw rows carry a `rep`, not
 * a batch id — while the counts below are counted from the rows, so a reading that moved between
 * batches would move the count with it.
 */
const SOURCE_BATCHES = [
  { reps: [0, 2], basis: 'raw/README.md: 前 3 次与后 7 次是两次运行' },
  { reps: [3, 9], basis: 'raw/README.md: 前 3 次与后 7 次是两次运行' },
];

/** @param {Buffer|string} value @returns {string} */
function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} text @returns {void} */
function print(text) {
  process.stdout.write(`${text}\n`);
}

/**
 * The value of one `const NAME = <literal>;` declaration in the raw prompt source, as a string.
 *
 * WHY THIS IS PARSED AND NOT IMPORTED. `raw/written.mts` imports `./omni.mts`, which reads webm
 * files out of `experiments/voice-gemini-paired-quality/out/` — a directory that is NOT committed.
 * Importing the module to read its constants would therefore make the freeze depend on an
 * uncommitted artifact, which is the opposite of what a freeze is for. So the literals are lifted
 * out of the source text instead.
 *
 * The escape handling is deliberately FAIL-CLOSED: exactly the escapes this file uses are
 * understood (`\``, `\\`, `\n` inside a template literal, and the same minus `\n` in a single-quoted
 * string), and any other backslash sequence throws. A future edit that introduces `\t` will red the
 * freeze rather than silently produce a string that differs from the one the experiment sent.
 *
 * @param {string} source @param {string} name @returns {string}
 */
function extractLiteral(source, name) {
  const marker = `const ${name} = `;
  const at = source.indexOf(marker);
  if (at === -1) throw new Error(`${PROMPT_REL}: no 'const ${name} = ' declaration`);
  const quote = source[at + marker.length];
  if (quote !== "'" && quote !== '`') {
    throw new Error(`${PROMPT_REL}: '${name}' is not declared as a string or template literal`);
  }
  let value = '';
  for (let index = at + marker.length + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      const next = source[index + 1];
      if (next === quote) value += quote;
      else if (next === '\\') value += '\\';
      else if (next === 'n' && quote === '`') value += '\n';
      else throw new Error(`${PROMPT_REL}: '${name}' carries an unsupported escape \\${String(next)}`);
      index += 1;
      continue;
    }
    if (character === quote) return value;
    value += character;
  }
  throw new Error(`${PROMPT_REL}: '${name}' is unterminated`);
}

/**
 * The value of one `field: 'value'` on the line declaring the E condition.
 *
 * Read off the condition's own line rather than off the model's, so the effort the frozen readings
 * were taken at and the effort this snapshot claims cannot come from two different places.
 *
 * @param {string} source @param {string} condition @param {string} field @returns {string}
 */
function extractConditionField(source, condition, field) {
  const line = source.split('\n').find((candidate) => candidate.includes(`key: '${condition}'`));
  if (line === undefined) throw new Error(`${PROMPT_REL}: no condition '${condition}'`);
  const match = new RegExp(`${field}:\\s*'([^']*)'`).exec(line);
  if (match === null) throw new Error(`${PROMPT_REL}: condition '${condition}' declares no '${field}'`);
  return match[1];
}

/**
 * The DashScope model the readings were taken with.
 *
 * The call site is a ternary — `DS ? { model: '…' } : { model: '…' }` — and the frozen readings come
 * from the DashScope arm (`written-ds.jsonl`), so the branch is pinned rather than taken as
 * whichever literal happens to come first.
 *
 * @param {string} source @returns {string}
 */
function extractDashscopeModel(source) {
  const match = /DS\s*\?\s*\{\s*model:\s*'([^']+)'/.exec(source);
  if (match === null) throw new Error(`${PROMPT_REL}: the DashScope branch's model literal was not found`);
  return match[1];
}

/**
 * The raw readings, one object per line, with the fields the snapshot keeps.
 *
 * A line that is not JSON, or that is missing a field the snapshot is built from, throws: a freeze
 * that skipped an unreadable row would produce a snapshot that is quietly smaller than the evidence.
 *
 * @param {string} text @returns {{cond: string, clip: string, rep: number, status: number, ms: number, text: string, err: string}[]}
 */
function parseReadings(text) {
  /** @type {{cond: string, clip: string, rep: number, status: number, ms: number, text: string, err: string}[]} */
  const rows = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${READINGS_REL}:${index + 1}: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    for (const field of ['cond', 'clip', 'rep', 'status', 'ms', 'text']) {
      if (row[field] === undefined) throw new Error(`${READINGS_REL}:${index + 1}: no '${field}'`);
    }
    rows.push({
      cond: String(row.cond),
      clip: String(row.clip),
      rep: Number(row.rep),
      status: Number(row.status),
      ms: Number(row.ms),
      text: String(row.text),
      err: typeof row.err === 'string' ? row.err : '',
    });
  });
  return rows;
}

/**
 * One group's clips and their readings, sorted by clip then rep so the JSON is order-stable.
 *
 * Every reading carries the freeze's single `runId`. It is on the READING rather than only on the
 * envelope because that is the claim being made — one run, all 160 — and a value only the envelope
 * carries cannot show a row that came from somewhere else.
 *
 * @param {{cond: string, clip: string, rep: number, status: number, ms: number, text: string}[]} rows
 * @param {string} condition
 * @returns {{condition: string, clips: {clip: string, readings: object[]}[]}}
 */
function buildGroup(rows, condition) {
  const mine = rows.filter((row) => row.cond === condition);
  /** @type {string[]} */
  const clips = [...new Set(mine.map((row) => row.clip))].sort();
  return {
    condition,
    clips: clips.map((clip) => ({
      clip,
      readings: mine
        .filter((row) => row.clip === clip)
        .sort((left, right) => left.rep - right.rep)
        .map((row) => ({
          runId: RUN_ID,
          rep: row.rep,
          status: row.status,
          ms: row.ms,
          text: row.text,
        })),
    })),
  };
}

/**
 * The frozen snapshot, derived from the tree under `root`.
 *
 * @param {string} root @returns {object}
 */
function buildSnapshot(root) {
  const promptPath = path.join(root, PROMPT_REL);
  const readingsPath = path.join(root, READINGS_REL);
  for (const [label, file] of [['promptFile', promptPath], ['readingsFile', readingsPath]]) {
    if (!existsSync(file)) throw new Error(`EMPTY_READING ${label} is missing: ${path.join(root, label === 'promptFile' ? PROMPT_REL : READINGS_REL)}`);
  }

  const promptBytes = readFileSync(promptPath);
  const readingsBytes = readFileSync(readingsPath);
  const promptSource = promptBytes.toString('utf8');
  const rows = parseReadings(readingsBytes.toString('utf8'));

  /** @type {Record<string, string>} */
  const literals = {};
  for (const name of PROMPT_NAMES) literals[name] = extractLiteral(promptSource, name);

  const groups = GROUPS.map(({ group, condition }) => [group, buildGroup(rows, condition)]);
  const frozen = rows.filter((row) => GROUPS.some((entry) => entry.condition === row.cond));

  /** @type {Record<string, number>} */
  const statuses = {};
  for (const row of frozen) statuses[String(row.status)] = (statuses[String(row.status)] ?? 0) + 1;

  return {
    schema: 'voice-omni-written-frozen-snapshot/1',
    runId: RUN_ID,
    provenance: {
      runId: RUN_ID,
      frozenAt: FROZEN_AT,
      readingWindow: '2026-09-23 至 09-24（raw/README.md）',
      promptVersion: 'written-e-2026-09-24',
      source: {
        promptFile: { path: PROMPT_REL, sha256: sha256Hex(promptBytes) },
        readingsFile: { path: READINGS_REL, sha256: sha256Hex(readingsBytes) },
      },
      sourceBatches: SOURCE_BATCHES.map((batch) => ({
        reps: batch.reps,
        readings: frozen.filter((row) => row.rep >= batch.reps[0] && row.rep <= batch.reps[1]).length,
        basis: batch.basis,
      })),
      clips: [...new Set(frozen.map((row) => row.clip))].sort(),
      groups: Object.fromEntries(
        groups.map(([group, value]) => [
          group,
          {
            condition: value.condition,
            clips: value.clips.length,
            readings: value.clips.reduce((total, clip) => total + clip.readings.length, 0),
          },
        ]),
      ),
      statuses,
      judge:
        '每条读数冻结的是原文（text）、延迟（ms）与调用结果（status，160 条全为 200）；语义判定（✅ 意图正确 / ◐ 可猜回 / ❌ 会误导）没有逐条冻结，因为它由 raw/judge.mts 的规则算出，而 judge.mts 经 written.mts 导入 omni.mts，omni.mts 在导入期读取未入库的 webm（raw/README.md：重算前需先用 ffmpeg 生成），离线驱动不了；把规则重写一遍又会在工装里留下第二份实现。口径本身记在 README 里：C ✅50 ◐26 ❌4、E ✅58 ◐18 ❌4（各 80 条）。',
      limits:
        '8 条 TTS 合成中文片段；语义判定是规则化的人工口径；不同运行之间有时段差异（延迟尤其明显）；qwen3.8-omni-flash 是别名，服务端升级后效果可能漂移；读数不重跑（联网且计费，按 ADR-004 决策 8 归人工）。',
    },
    prompts: {
      ...literals,
      reasoning_effort: extractConditionField(promptSource, 'E-twostep-low', 'effort'),
      model: extractDashscopeModel(promptSource),
    },
    groups: Object.fromEntries(groups),
  };
}

/** @param {object} snapshot @returns {string} */
function serialize(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * One group's shape, as read: how many clips, and how many readings the THINNEST one carries.
 *
 * The minimum rather than an average: the claim is "每条 ≥10 次", and a mean of 9.9 would satisfy a
 * reader of the mean while leaving a clip the criterion exists to notice short.
 *
 * @param {any} group @returns {{clips: number, minReadings: number, readings: number, runIds: string[], shortClip: string|null}}
 */
function readGroupShape(group) {
  const clips = Array.isArray(group?.clips) ? group.clips : [];
  let minReadings = Number.POSITIVE_INFINITY;
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
    readings,
    runIds,
    shortClip,
  };
}

/**
 * `--check`: recompute the snapshot and compare it against the one on disk, reporting EVERY
 * disagreement rather than stopping at the first.
 *
 * Reporting all of them is not a nicety. The falsification cases move one thing at a time, and two
 * of them move something that is visible in more than one reading at once — removing a raw reading
 * changes the readings file's sha256 AND leaves a clip short. A checker that returned on the first
 * failure would make which one a reader sees depend on the order of the code rather than on which
 * claim was broken.
 *
 * @param {string} root @returns {number}
 */
function check(root) {
  /** @type {string[]} */
  const failures = [];
  /** @param {string} token @param {string} detail @returns {void} */
  const fail = (token, detail) => failures.push(`FAIL ${token} ${detail}`);

  const snapshotPath = path.join(root, SNAPSHOT_REL);
  if (!existsSync(snapshotPath)) {
    print(`FAIL SNAPSHOT-MISSING ${SNAPSHOT_REL}`);
    print(`freeze root=${root}`);
    return 1;
  }

  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch (error) {
    print(`FAIL SNAPSHOT-MALFORMED ${SNAPSHOT_REL}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  /** @type {object|null} */
  let rebuilt = null;
  try {
    rebuilt = buildSnapshot(root);
  } catch (error) {
    print(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  print(`freeze root=${root}`);
  print(`freeze runId=${RUN_ID}`);

  // ── the shape of the recomputed readings ──────────────────────────────────────────────────
  for (const { group } of GROUPS) {
    const shape = readGroupShape(rebuilt.groups[group]);
    print(`freeze ${group} ${shape.clips} x ${shape.minReadings}`);
    if (shape.minReadings < 10) {
      fail('READINGS', `${group} clip ${shape.shortClip} has ${shape.minReadings} reading(s), fewer than the 10 the freeze backs`);
    }
    const distinct = [...new Set(shape.runIds)];
    if (distinct.length !== 1) {
      fail('READINGS', `different runs inside group ${group}: ${distinct.join(', ')}`);
    } else if (distinct[0] !== RUN_ID) {
      fail('READINGS', `group ${group} carries runId=${distinct[0]}, expected ${RUN_ID}`);
    }
  }
  const batches = rebuilt.provenance.sourceBatches;
  print(`freeze readings=${Object.values(rebuilt.provenance.groups).reduce((total, g) => total + g.readings, 0)} batches=${batches.length}`);

  // ── the two source files, as the snapshot recorded them ───────────────────────────────────
  for (const [label, key] of [['promptFile', 'promptFile'], ['readingsFile', 'readingsFile']]) {
    const recorded = snapshot?.provenance?.source?.[key];
    const actual = rebuilt.provenance.source[key];
    print(`freeze source.${label} path=${actual.path} sha256=${actual.sha256}`);
    if (recorded?.sha256 === undefined) {
      fail('EMPTY_READING', `snapshot.provenance.source.${key}.sha256 is missing, so nothing was compared`);
    } else if (recorded.sha256 !== actual.sha256) {
      fail(
        'SHA256',
        `${label} differs: snapshot=${String(recorded.sha256)} current=${actual.sha256} — the frozen provenance no longer describes ${actual.path}`,
      );
    }
  }

  // ── the six prompt segments, each named ───────────────────────────────────────────────────
  if (snapshot?.prompts === undefined || snapshot.prompts === null || typeof snapshot.prompts !== 'object') {
    fail(
      'EMPTY_READING',
      `snapshot.prompts is missing or not an object, so none of ${PROMPT_SEGMENTS.map((entry) => entry.segment).join(', ')} could be compared`,
    );
  } else {
    for (const { segment, key } of PROMPT_SEGMENTS) {
      const recorded = snapshot.prompts[key];
      const actual = rebuilt.prompts[key];
      if (typeof recorded !== 'string') {
        fail('EMPTY_READING', `snapshot.prompts.${key} is ${JSON.stringify(recorded)}, so '${segment}' was not compared`);
      } else if (recorded !== actual) {
        fail(
          'MISMATCH',
          `${segment} differs from ${PROMPT_REL}: snapshot sha256=${sha256Hex(recorded)} raw sha256=${sha256Hex(actual)}`,
        );
      }
    }
  }

  // ── and the whole thing, byte for byte ────────────────────────────────────────────────────
  const committed = readFileSync(snapshotPath, 'utf8');
  if (committed !== serialize(rebuilt)) {
    fail(
      'SNAPSHOT-DIFF',
      `${SNAPSHOT_REL} is not the byte-for-byte result of re-running this freeze over ${READINGS_REL} and ${PROMPT_REL} (committed ${committed.length} B, recomputed ${serialize(rebuilt).length} B)`,
    );
  }

  for (const failure of failures) print(failure);
  print(`freeze verdict=${failures.length === 0 ? 'PASS' : 'FAIL'} red=${failures.length}`);
  return failures.length === 0 ? 0 : 1;
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
  let root = DEFAULT_ROOT;
  let mode = 'write';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      const value = argv[index + 1] ?? '';
      if (value === '') {
        print('usage: --root needs a directory');
        return 2;
      }
      root = path.resolve(value);
      index += 1;
    } else if (arg === '--check') {
      mode = 'check';
    } else if (arg === '--print') {
      mode = 'print';
    } else if (arg === '--help' || arg === '-h') {
      print('usage: node experiments/voice-omni-written/freeze.mjs [--check|--print] [--root <dir>]');
      return 0;
    } else {
      print(`unknown argument: ${arg}`);
      return 2;
    }
  }

  /** @type {object} */
  let snapshot;
  try {
    snapshot = buildSnapshot(root);
  } catch (error) {
    print(`FAIL ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (mode === 'check') return check(root);

  const text = serialize(snapshot);
  if (mode === 'print') {
    process.stdout.write(text);
    return 0;
  }

  const target = path.join(root, SNAPSHOT_REL);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, text);
  print(`freeze wrote ${SNAPSHOT_REL} bytes=${Buffer.byteLength(text)} runId=${snapshot.runId}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
