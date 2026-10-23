#!/usr/bin/env node
/**
 * The criterion for `scripts/voice-phase0-report.mjs` (task `gap-voice-phase0-readout-report`).
 *
 * WHAT THIS FILE IS FOR. The report answers the stage-0 exit criterion (`≥ 100` segments with an
 * identifier, `≥ 30` with a correction label) and prints the aggregate readings the proposal names.
 * A report is only worth as much as the fakes it can tell apart from the real thing, so the cases
 * below are built around three things a report like this can get silently wrong:
 *
 *   1. THE AGGREGATES ARE PINNED TO A HAND-BUILT CORPUS. Every count, ratio and exit code is
 *      asserted against a fixture this file constructs from records it can compute the answer for,
 *      so "the numbers moved" is a red case and not a reading nobody checked.
 *   2. THE PRIVACY PROMISE HAS A NEGATIVE CONTROL. D1 says the recorded speech stays local; a report
 *      that quoted a transcript would leak it. A fixture plants sentinel strings in the recognised
 *      text, the `heard` and the `final`, and the report's whole output must not contain one. The
 *      second half of that case is the part that makes the first mean anything: a MUTATED copy of
 *      the script that prints a `heard` must make the same grep find the sentinel, or the privacy
 *      assertion was testing nothing.
 *   3. THE CALIBRE IS THE OFFLINE EXPERIMENT'S. The mark counts are asserted equal to the record's
 *      own `flagStats` values, and the AUROC rank-sum is asserted BIT-FOR-BIT equal to the function
 *      in `experiments/voice-index-loop/sim/sv-eval2.mjs` — the function is extracted from that file
 *      at test time and run, so a drift in either implementation is a red case.
 *
 * The report is a plain `node` script with no loader, so every case spawns it as a child process
 * exactly as the criterion's command names it, and reads the exit code and stdout it produced.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRIPT = path.join(HERE, 'voice-phase0-report.mjs');
const SV_EVAL2 = path.join(REPO_ROOT, 'experiments', 'voice-index-loop', 'sim', 'sv-eval2.mjs');

/** Distinctive strings that must never appear in a report. Each sits in one of the three fields. */
const TEXT_SENTINEL = 'zqSentinelText9';
const HEARD_SENTINEL = 'zqSentinelHeard9';
const FINAL_SENTINEL = 'zqSentinelFinal9';

/** A scratch directory beside the checkout, removed when a case ends. */
function scratchDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'voice-phase0-report-'));
}

/**
 * One stored record document, with the fields the reader actually reads.
 *
 * @param {string} recordId
 * @param {object[]} segments
 * @param {object} [extra]
 */
function record(recordId, segments, extra = {}) {
  return { recordId, ts: 0, providerId: 'sensevoice-local', segments, ...extra };
}

/**
 * One stored segment.
 *
 * @param {number} index
 * @param {string} text
 * @param {{ text: string, confidence?: number }[]} [tokens]
 */
function segment(index, text, tokens) {
  return { index, audioFile: `audio-${index}.wav`, text, ...(tokens === undefined ? {} : { tokens }) };
}

/** Writes `records` as one JSON document each into `directory`. */
/** @param {string} directory @param {{ recordId: string }[]} records */
function writeRecords(directory, records) {
  mkdirSync(directory, { recursive: true });
  for (const [index, value] of records.entries()) {
    writeFileSync(path.join(directory, `${value.recordId}-${index}.json`), JSON.stringify(value));
  }
}

/** Spawns the report exactly as the criterion names it and returns the finished child. */
/** @param {string[]} args @param {Record<string, string>} [env] @param {string} [cwd] */
function runReport(args, env = {}, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

/** The `flagStats` document a fixture would have had written by the service. */
/** @param {string} text @param {{ text: string, confidence?: number }[]} tokens @param {number} flags */
function flagStats(text, tokens, flags) {
  const chars = text.length;
  return {
    chars,
    byTheta: [0.5, 0.6, 0.7, 0.8].map((theta) => ({
      theta,
      flags,
      flagsLatin: flags,
      flagsPer100Chars: (100 * flags) / chars,
      flagsLatinPer100Chars: (100 * flags) / chars,
    })),
  };
}

//----------------------------------------------------------------------------
// The known-answer corpus: every aggregate the report prints, pinned by hand.
//----------------------------------------------------------------------------

/**
 * A one-record fixture whose every reading is computable by hand.
 *
 * The text is `<TEXT_SENTINEL> <HEARD_SENTINEL> AC-103 hello`, tokenised into four tokens whose
 * confidences make the first two one low-confidence run. One correction label repairs
 * `HEARD_SENTINEL` (which is in the text) to `FINAL_SENTINEL` (which is not, so nothing leaks it).
 * The reader's answers for this corpus are:
 *
 *   records 1 · segments 1 · identifier segments 1 · labelled segments 1 · gate not met
 *   manual edit: labelled/segments 1, changed chars = editDistance(heard, final), speech chars = len
 *   forms: misheard 1
 *   confidence: 1 error region, 2 uncorrected identifier regions, AUROC n/a (samples < 10)
 *   marks: at every threshold the one flag the two adjacent low tokens make
 */
function knownAnswerFixture() {
  const directory = scratchDir();
  const text = `${TEXT_SENTINEL} ${HEARD_SENTINEL} AC-103 hello`;
  const tokens = [
    { text: `▁${TEXT_SENTINEL}`, confidence: 0.3 },
    { text: `▁${HEARD_SENTINEL}`, confidence: 0.2 },
    { text: '▁AC-103', confidence: 0.9 },
    { text: '▁hello', confidence: 0.9 },
  ];
  writeRecords(directory, [
    record('known', [segment(0, text, tokens)], {
      labels: [{ segmentIndex: 0, heard: HEARD_SENTINEL, final: FINAL_SENTINEL, op: 'replace' }],
      flagStats: flagStats(text, tokens, 1),
    }),
  ]);
  return { directory, text };
}

/**
 * The report as JSON, or a failure carrying the child's own stderr.
 *
 * Exit 0 (gate met) and exit 2 (gate not met) both mean the readout was made; these small fixtures
 * are all under the gate, so the code is 2. Only 1 — unmeasurable — is a failure here.
 *
 * @param {string} directory
 * @param {string[]} [extraArgs]
 */
function reportJson(directory, extraArgs = []) {
  const result = runReport(['--dir', directory, '--json', ...extraArgs]);
  assert.notEqual(result.status, 1, `the readout was unmeasurable; stderr:\n${result.stderr}`);
  assert.ok(result.status === 0 || result.status === 2, `unexpected exit ${result.status}:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('known-answer corpus: every printed aggregate is the hand-computed one', () => {
  const { directory, text } = knownAnswerFixture();
  try {
    const report = reportJson(directory);

    assert.equal(report.records, 1);
    assert.equal(report.segments, 1);
    assert.equal(report.identifierSegments, 1);
    assert.equal(report.labelledSegments, 1);
    assert.equal(report.gate.met, false);
    assert.equal(report.gate.identifierThreshold, 100);
    assert.equal(report.gate.labelThreshold, 30);

    assert.equal(report.manualEdit.labelledSegmentRatio, 1);
    assert.equal(report.manualEdit.speechChars, text.length);
    // The changed-character count is the edit distance; computed here independently of the script.
    assert.equal(report.manualEdit.changedChars, readEditDistance(HEARD_SENTINEL, FINAL_SENTINEL));
    assert.equal(report.manualEdit.charRatio, report.manualEdit.changedChars / report.manualEdit.speechChars);

    assert.equal(report.forms.corrections, 1);
    assert.equal(report.forms.rewrites, 0);
    assert.equal(report.forms.misheard, 1, 'a Latin `heard` whose key changed is a mishearing');

    assert.equal(report.confidence.errorRegions, 1);
    assert.equal(report.confidence.uncorrectedIdentifierRegions, 2, 'both identifier tokens no label touched');
    assert.equal(report.confidence.auroc, null, 'fewer than ten samples in a class must read n/a');
    assert.equal(report.confidence.insufficient, true);

    assert.equal(report.repairRevertRate, null, 'no record carries repairedText');

    for (const row of report.marks) {
      assert.equal(row.flags, 1, 'the two adjacent low-confidence tokens are one flag');
      assert.equal(row.flagsPer100Chars, (100 * 1) / text.length);
      assert.equal(row.chars, text.length);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** `editDistance`, ported into the test so the assertion is not read off the script under test. */
/** @param {string} left @param {string} right @returns {number} */
function readEditDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + substitution);
    }
    previous = current;
  }
  return previous[right.length];
}

//----------------------------------------------------------------------------
// The privacy promise, and the mutant that has to break it.
//----------------------------------------------------------------------------

test('privacy: no sentinel from the text, the heard or the final reaches either output', () => {
  const { directory } = knownAnswerFixture();
  try {
    for (const args of [['--dir', directory], ['--dir', directory, '--json']]) {
      const result = runReport(args);
      assert.notEqual(result.status, 1, `stderr:\n${result.stderr}`);
      const seen = [TEXT_SENTINEL, HEARD_SENTINEL, FINAL_SENTINEL].filter((sentinel) =>
        result.stdout.includes(sentinel),
      );
      assert.deepEqual(seen, [], `output carried recorded content: ${seen.join(', ')}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('privacy negative control: a variant that prints a heard is caught by the same grep', () => {
  const { directory } = knownAnswerFixture();
  const scratch = scratchDir();
  try {
    const source = readFileSync(SCRIPT, 'utf8');
    const anchor = 'const records = readRecords(directory);';
    assert.ok(source.includes(anchor), 'the private-control anchor moved; the control measured nothing');
    const mutant = source.replace(
      anchor,
      `${anchor}\n  console.log(records.flatMap((r) => (r.labels ?? []).map((l) => l.heard)).join(' '));`,
    );
    const mutantPath = path.join(scratch, 'voice-phase0-report.mutant.mjs');
    writeFileSync(mutantPath, mutant);

    const result = spawnSync(process.execPath, [mutantPath, '--dir', directory], { encoding: 'utf8' });
    assert.ok(
      result.stdout.includes(HEARD_SENTINEL),
      'the mutant did not echo the heard; the privacy control would pass vacuously',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

//----------------------------------------------------------------------------
// Exit codes: the gate, its two thresholds, and the unmeasurable corpus.
//----------------------------------------------------------------------------

/**
 * A corpus with exactly `identifierCount` segments that carry an identifier and exactly
 * `labelCount` that carry a correction label.
 *
 * @param {number} identifierCount
 * @param {number} labelCount
 */
function gateFixture(identifierCount, labelCount) {
  const directory = scratchDir();
  const total = Math.max(identifierCount, labelCount);
  const segments = [];
  /** @type {{ segmentIndex: number, heard: string, final: string, op: string }[]} */
  const labels = [];
  for (let index = 0; index < total; index += 1) {
    const text = index < identifierCount ? `idA${index} there` : 'hello there';
    segments.push(segment(index, text));
    if (index < labelCount) {
      labels.push({ segmentIndex: index, heard: text.split(' ')[0], final: 'idB', op: 'replace' });
    }
  }
  const records = [];
  for (let start = 0; start < segments.length; start += 25) {
    const chunk = segments.slice(start, start + 25);
    records.push(
      record(`gate-${start}`, chunk, {
        labels: labels.filter((label) => label.segmentIndex >= start && label.segmentIndex < start + 25),
      }),
    );
  }
  writeRecords(directory, records);
  return directory;
}

test('gate: 120 identifier segments and 40 labelled segments meet stage 0', () => {
  const directory = gateFixture(120, 40);
  try {
    const result = runReport(['--dir', directory]);
    assert.equal(result.status, 0, `expected met; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /phase 0 gate: MET/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate: 99 identifier segments fails on the identifier threshold alone', () => {
  const directory = gateFixture(99, 40);
  try {
    const result = runReport(['--dir', directory]);
    assert.equal(result.status, 2, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /with identifier-shaped tokens: 99 \(need >= 100: FAIL\)/);
    assert.match(result.stdout, /with correction labels:\s+40 \(need >= 30: PASS\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate: 29 labelled segments fails on the label threshold alone', () => {
  const directory = gateFixture(120, 29);
  try {
    const result = runReport(['--dir', directory]);
    assert.equal(result.status, 2, `stdout:\n${result.stdout}`);
    assert.match(result.stdout, /with identifier-shaped tokens: 120 \(need >= 100: PASS\)/);
    assert.match(result.stdout, /with correction labels:\s+29 \(need >= 30: FAIL\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('gate: a missing data directory exits 1 with an actionable message', () => {
  const missing = path.join(scratchDir(), 'does-not-exist');
  const result = runReport(['--dir', missing]);
  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /no voice data directory/);
  assert.match(result.stderr, /VOICE_DATA_DIR/);
  assert.match(result.stderr, /--dir/);
});

//----------------------------------------------------------------------------
// The AUROC: known answers by construction, and parity with the offline experiment.
//----------------------------------------------------------------------------

/**
 * One segment of `count` identifier tokens: the first `errorCount` carry `errorConfidence` and are
 * corrected, the rest carry `okConfidence` and are left alone.
 *
 * @param {number} count
 * @param {number} errorCount
 * @param {number} errorConfidence
 * @param {number} okConfidence
 */
function aurocFixture(count, errorCount, errorConfidence, okConfidence) {
  const directory = scratchDir();
  const tokens = Array.from({ length: count }, (_, index) => ({
    text: `▁idA${index}`,
    confidence: index < errorCount ? errorConfidence : okConfidence,
  }));
  const text = tokens.map((token) => token.text.replace('▁', ' ')).join('').trim();
  const labels = tokens.slice(0, errorCount).map((token, index) => ({
    segmentIndex: 0,
    heard: token.text.replace('▁', ''),
    final: `idB${index}`,
    op: 'replace',
  }));
  writeRecords(directory, [record('auroc', [segment(0, text, tokens)], { labels })]);
  return directory;
}

test('AUROC: a perfectly separable distribution reads 1.0', () => {
  const directory = aurocFixture(24, 12, 0.1, 0.9);
  try {
    const report = reportJson(directory);
    assert.equal(report.confidence.errorRegions, 12);
    assert.equal(report.confidence.uncorrectedIdentifierRegions, 12);
    assert.equal(report.confidence.insufficient, false);
    assert.equal(report.confidence.auroc, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AUROC: a fully overlapping distribution reads 0.5', () => {
  const directory = aurocFixture(24, 12, 0.5, 0.5);
  try {
    const report = reportJson(directory);
    assert.equal(report.confidence.auroc, 0.5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AUROC: fewer than ten in a class reads n/a, not a number', () => {
  const directory = aurocFixture(21, 12, 0.1, 0.9);
  try {
    const report = reportJson(directory);
    assert.equal(report.confidence.uncorrectedIdentifierRegions, 9);
    assert.equal(report.confidence.auroc, null);
    assert.equal(report.confidence.insufficient, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AUROC: the rank-sum is bit-for-bit the offline experiment\'s function', async () => {
  const theirs = await loadSvEval2Auroc();
  const mine = (await import(pathToFileURL(SCRIPT).href)).auroc;
  const cases = [
    [[0.9, 0.8, 0.95, 0.7], [0.1, 0.2, 0.15]],
    [[0.5, 0.5, 0.5], [0.5, 0.5], [0.5]],
    [[0.1, 0.2, 0.3, 0.4], [0.35, 0.45]],
    [[0.2, 0.6, 0.2, 0.6, 0.6], [0.1, 0.9, 0.6]],
    [[0.42, 0.42, 0.17], [0.17, 0.17, 0.99]],
  ];
  for (const [pos, neg] of cases) {
    assert.strictEqual(
      mine(pos, neg),
      theirs(pos, neg),
      `auroc disagreed with sv-eval2 on pos=${JSON.stringify(pos)} neg=${JSON.stringify(neg)}`,
    );
  }
});

/** Extracts `sv-eval2.mjs`'s own `auroc` and runs it, so the parity is with that file's source. */
async function loadSvEval2Auroc() {
  const source = readFileSync(SV_EVAL2, 'utf8');
  const match = source.match(/function auroc\([^)]*\)\s*\{[^\n]*\}/);
  assert.ok(match, 'sv-eval2.mjs no longer defines a one-line auroc; the parity anchor moved');
  const scratch = scratchDir();
  const modulePath = path.join(scratch, 'sv-eval2-auroc.mjs');
  writeFileSync(modulePath, `${match[0]}\nexport { auroc };\n`);
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    return loaded.auroc;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

//----------------------------------------------------------------------------
// The error-form taxonomy and the mark counts.
//----------------------------------------------------------------------------

test('error forms: every class is counted, rewrites are separated from corrections', () => {
  const directory = scratchDir();
  const pairs = [
    ['fan in', 'fan-in', 'form'],
    ['cloud cli', 'CloudCLI', 'form'],
    ['AC 零零二', 'AC-002', 'spoken-form'],
    ['GOAL 十三', 'GOAL-13', 'spoken-form'],
    ['翻译', 'fan-in', 'cjk-rendering'],
    ['克拉德', 'claude', 'cjk-rendering'],
    ['key', 'quay', 'misheard'],
    ['Cloth Jeddik', 'claude-fjdac', 'misheard'],
  ];
  const segments = pairs.map(([heard], index) => segment(index, heard));
  const segmentsWithRewriteOnly = [...segments, segment(pairs.length, 'extra words here')];
  const labels = pairs.map(([heard, final], index) => ({
    segmentIndex: index,
    heard,
    final,
    op: 'replace',
  }));
  labels.push({
    segmentIndex: pairs.length,
    heard: 'extra words here',
    final: 'something entirely different and long',
    op: 'rewrite',
  });
  writeRecords(directory, [record('forms', segmentsWithRewriteOnly, { labels })]);
  try {
    const report = reportJson(directory);
    assert.equal(report.forms.form, 2);
    assert.equal(report.forms['spoken-form'], 2);
    assert.equal(report.forms['cjk-rendering'], 2);
    assert.equal(report.forms.misheard, 2);
    assert.equal(report.forms.corrections, 8, 'the rewrite is not a correction');
    assert.equal(report.forms.rewrites, 1);
    assert.equal(
      report.labelledSegments,
      8,
      'nine labels, but the rewrite-only segment is not a labelled segment',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marks: the per-theta counts equal the record\'s own flagStats values', () => {
  const { directory, text } = knownAnswerFixture();
  try {
    const report = reportJson(directory);
    const stored = JSON.parse(readFileSync(path.join(directory, 'known-0.json'), 'utf8')).flagStats;
    assert.equal(report.marks.length, stored.byTheta.length);
    for (const [index, row] of report.marks.entries()) {
      assert.equal(row.theta, stored.byTheta[index].theta);
      assert.equal(row.flags, stored.byTheta[index].flags);
      assert.equal(row.flagsPer100Chars, stored.byTheta[index].flagsPer100Chars);
      assert.equal(row.chars, stored.chars);
    }
    assert.equal(report.marks[0].flagsPer100Chars, 100 / text.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marks: recall is the share of correction regions a threshold covers', () => {
  const directory = scratchDir();
  const text = `${TEXT_SENTINEL} ${HEARD_SENTINEL} AC-103 hello`;
  const tokens = [
    { text: `▁${TEXT_SENTINEL}`, confidence: 0.3 },
    { text: `▁${HEARD_SENTINEL}`, confidence: 0.2 },
    { text: '▁AC-103', confidence: 0.9 },
    { text: '▁hello', confidence: 0.9 },
  ];
  writeRecords(directory, [
    record('recall', [segment(0, text, tokens)], {
      labels: [{ segmentIndex: 0, heard: HEARD_SENTINEL, final: FINAL_SENTINEL, op: 'replace' }],
    }),
  ]);
  try {
    const report = reportJson(directory);
    for (const row of report.marks) {
      assert.equal(row.recallTotal, 1);
      assert.equal(row.recallCovered, 1, `theta=${row.theta} must cover the one corrected region`);
      assert.equal(row.recall, 1);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('record documents: an unreadable record is an exit-1 readout, not a short one', () => {
  const directory = scratchDir();
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'not-json.json'), '{ this is not json');
    const result = runReport(['--dir', directory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unreadable record document/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the script is a plain node entry point: it exists and is the module the tests spawn', () => {
  assert.ok(existsSync(SCRIPT));
  assert.ok(readFileSync(SCRIPT, 'utf8').startsWith('#!/usr/bin/env node'));
});
