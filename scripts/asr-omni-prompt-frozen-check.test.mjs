#!/usr/bin/env node
/**
 * The falsification harness for `scripts/asr-omni-prompt-frozen-check.mjs` (AC-137).
 *
 * WHAT A GREEN RUN IS SUPPOSED TO MEAN HERE. Not "the checker ran" but "the checker can go red for
 * the right reason, naming the right thing". So almost every case below comes in a pair: the
 * shipping tree passes, and a tree with ONE thing broken fails in a way that names that thing. The
 * pairs are what make the criterion a criterion; without them a checker that always exited 0 would
 * pass this file too.
 *
 * TWO WAYS A MUTATION IS APPLIED, because they prove different halves:
 *
 *   · IN MEMORY (`--control=…`), which exercises the COMPARISON — all six segments, one control
 *     each, so a checker that only compared the first segment cannot hide;
 *   · ON DISK, in a staged tree, with no control at all, which exercises the READ — it proves the
 *     value being compared came off the filesystem rather than out of the checker's own source.
 *     The staged mutation is a single character inserted just inside a segment's opening quote,
 *     found by its declaration, so this file never has to contain any of the prompt's text.
 *
 * NO PROMPT TEXT IN THIS FILE, AND THAT IS A CASE, NOT A STYLE. AC7 requires `grep -n` over the two
 * tool files to find neither the role line nor the first rule line — so the needles are derived at
 * run time from the frozen snapshot, and the grep is run with a POSITIVE CONTROL over the snapshot
 * itself (which must match). Without that control, a grep that failed to start at all would look
 * exactly like a clean scan: "zero hits" and "nothing was searched" must not be the same shape.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR THE TASK STORE. Every case spawns the tool and reads its
 * output; the staged trees live under the OS temp directory and are removed with `t.after()`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_PATH = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_PATH);
const ROOT = path.resolve(TEST_DIR, '..');

const CHECK_REL = 'scripts/asr-omni-prompt-frozen-check.mjs';
const CHECK = path.join(ROOT, CHECK_REL);
const FREEZE_REL = 'experiments/voice-omni-written/freeze.mjs';
const FREEZE = path.join(ROOT, FREEZE_REL);
const SNAPSHOT_REL = 'experiments/voice-omni-written/fixtures/snapshot.json';
const ADAPTER_REL = 'shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts';
const PROMPT_REL = 'experiments/voice-omni-written/raw/written.mts';
const READINGS_REL = 'experiments/voice-omni-written/raw/written-ds.jsonl';

/** The six segments, in the order the checker prints them. */
const SEGMENTS = ['ROLE', 'RULES', 'EXAMPLES', 'JSON_TASK', 'REASONING_EFFORT', 'DEFAULT_MODEL'];

/** One reading of a `… item <SEG> ok=<bool> adapter.sha256=… snapshot.sha256=…` line. */
const ITEM_LINE = /item ([A-Z_]+) ok=(true|false) adapter\.sha256=(\S+) snapshot\.sha256=(\S+)/;

/** @param {Buffer|string} value @returns {string} */
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Run one of the tools and hand back everything a case needs to judge it.
 *
 * `cwd` is the tree, so the tools resolve exactly what the goal gate and the fan-in would.
 *
 * @param {string} script @param {string[]} args @returns {{ status: number, output: string }}
 */
function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** @param {string[]} args @returns {{ status: number, output: string }} */
const runCheck = (args = []) => run(CHECK, args);

/** @param {string[]} args @returns {{ status: number, output: string }} */
const runFreeze = (args = []) => run(FREEZE, args);

/**
 * A throwaway tree carrying the shipping evidence, so a mutation has somewhere to land.
 *
 * @param {import('node:test').TestContext} t @returns {string} the staged root
 */
function stage(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-frozen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The arena has to declare itself ESM the way the shipping tree does. `tsx` decides between the
  // import and require paths from the nearest `package.json`; without one, the staged `.ts` is
  // loaded as CommonJS and Node refuses it with "require() ES Module ... in a cycle" — a failure
  // about the arena's own shape, which would otherwise be read as a failure of the checker.
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  // `shared/asr` goes across whole: the adapter value-imports `baseMimeType` out of the registry, so an
  // arena holding only the adapter's own directory dies on "Cannot find module .../asrRegistry.js" —
  // a failure about the arena, which would otherwise be read as a failure of the checker.
  for (const relative of [
    path.dirname(path.dirname(path.dirname(ADAPTER_REL))),
    path.dirname(PROMPT_REL),
    path.dirname(SNAPSHOT_REL),
  ]) {
    cpSync(path.join(ROOT, relative), path.join(root, relative), { recursive: true });
  }
  return root;
}

/**
 * Change ONE character of a segment's value in a staged adapter file, without knowing the value.
 *
 * The character is inserted immediately inside the opening quote of `export const <NAME> = <quote>`,
 * whatever that quote is (the long segments are template literals, the scalars are single-quoted),
 * so the mutation is a one-character change to the shipped prompt for every segment alike.
 *
 * @param {string} file @param {string} segment @returns {number} how many declarations were hit
 */
function mutateSegmentChar(file, segment) {
  const source = readFileSync(file, 'utf8');
  const marker = `export const ${segment} = `;
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, `the staged adapter declares no '${segment}'`);
  const insertAt = at + marker.length + 1;
  const mutated = `${source.slice(0, insertAt)}·${source.slice(insertAt)}`;
  writeFileSync(file, mutated);
  return mutated === source ? 0 : 1;
}

/**
 * `grep -n -e <needle> …files`, as the criterion's own words ask for it.
 *
 * Status 0 = matched, 1 = no match, 2 = grep itself failed (a missing file, a bad pattern). The
 * three are kept apart on purpose: the case that matters asserts 1, and a run that returned 2 must
 * never be read as "clean".
 *
 * @param {string} needle @param {string[]} files @returns {number}
 */
function grepStatus(needle, files) {
  return spawnSync('grep', ['-n', '-e', needle, ...files], { encoding: 'utf8' }).status ?? -1;
}

/**
 * The frozen snapshot, as data.
 *
 * The shape is spelled out rather than left as the `any` JSON.parse returns, because an `any` here
 * would silently switch off the checking of every case that reads the snapshot.
 *
 * @returns {{
 *   prompts: Record<string, string>,
 *   groups: Record<string, { clips: { clip: string, readings: any[] }[] }>,
 *   provenance: { source: Record<string, { path: string, sha256: string }> },
 * }}
 */
function snapshot() {
  return JSON.parse(readFileSync(path.join(ROOT, SNAPSHOT_REL), 'utf8'));
}

/**
 * The import specifiers of a script, so "this program has no transport" can be read statically.
 *
 * @param {string} file @returns {string[]}
 */
function importSpecifiers(file) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}

// ── AC1: the shipping tree passes, and says what it read ──────────────────────────────────────

test('AC1 · the six segments are compared on the shipping tree, each with its own ok', () => {
  const { status, output } = runCheck();
  assert.equal(status, 0, `the criterion must exit 0 on the shipping tree:\n${output}`);
  for (const segment of SEGMENTS) {
    const line = output.split('\n').map((candidate) => ITEM_LINE.exec(candidate)).find((match) => match?.[1] === segment);
    assert.ok(line, `no 'item ${segment}' line in:\n${output}`);
    assert.equal(line[2], 'true', `${segment} did not read as ok on the shipping tree`);
    assert.match(line[3], /^[0-9a-f]{64}$/, `${segment}'s adapter side is not a sha256`);
    assert.match(line[4], /^[0-9a-f]{64}$/, `${segment}'s snapshot side is not a sha256`);
    assert.equal(line[3], line[4], `${segment} hashed differently on the two sides of a passing run`);
  }
  assert.match(output, /adapter\.path=shared\/asr\/list\/dashscope-omni\/[^\s]+ exists=true sha256=[0-9a-f]{64}/);
  assert.match(
    output,
    /snapshot\.path=experiments\/voice-omni-written\/fixtures\/snapshot\.json exists=true sha256=[0-9a-f]{64}/,
  );
});

test('AC1/AC4 · an empty tree is a failure, not a silent pass', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-frozen-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { status, output } = runCheck(['--root', root]);
  assert.notEqual(status, 0, `an empty tree must not pass:\n${output}`);
  assert.match(output, /EMPTY_READING/, `the failure must be named EMPTY_READING:\n${output}`);
});

// ── AC2: the shape of the readings behind the freeze ─────────────────────────────────────────

test('AC2 · the freeze reports 8 × 10 for both groups and one run id', () => {
  const { status, output } = runCheck();
  assert.equal(status, 0, output);
  assert.ok(output.includes('C 8 clips x 10 readings'), `no C shape line:\n${output}`);
  assert.ok(output.includes('E 8 clips x 10 readings'), `no E shape line:\n${output}`);
  const runId = /readings runId=(\S+) distinct=(\d+)/.exec(output);
  assert.ok(runId, `no run-id line:\n${output}`);
  assert.equal(runId[2], '1', 'the 160 readings must come from exactly one run');
});

test('AC2 · a clip with 9 readings reds and the clip is named', () => {
  const { status, output } = runCheck(['--control=low-rep']);
  assert.notEqual(status, 0, output);
  const named = /group E clip (\S+) has 9 reading/.exec(output);
  assert.ok(named, `no per-clip shortfall naming a clip id:\n${output}`);
  const clips = snapshot().groups.E.clips.map((clip) => clip.clip);
  assert.ok(clips.includes(named[1]), `the named clip '${named[1]}' is not one of the snapshot's E clips`);
});

test('AC2 · a reading from another run reds as "different runs"', () => {
  const { status, output } = runCheck(['--control=straddle']);
  assert.notEqual(status, 0, output);
  assert.match(output, /different runs/, `the straddle must be reported as different runs:\n${output}`);
});

// ── AC3: a mutated segment reds by name — in memory, then on disk ────────────────────────────

for (const segment of SEGMENTS) {
  test(`AC3 · --control=prompt-mutated:${segment} reds and names ${segment}`, () => {
    const { status, output } = runCheck([`--control=prompt-mutated:${segment}`]);
    assert.notEqual(status, 0, output);
    assert.match(output, new RegExp(`MISMATCH ${segment}\\b`), `the mismatch must name ${segment}:\n${output}`);
  });
}

test('AC3 · the unmutated tree is the positive control for every mutation above', () => {
  assert.equal(runCheck().status, 0, 'without a green baseline, "the mutation reds" proves nothing');
});

for (const segment of SEGMENTS) {
  test(`AC3 · one character changed in the adapter FILE reds and names ${segment}`, (t) => {
    const root = stage(t);
    const adapter = path.join(root, ADAPTER_REL);
    assert.equal(mutateSegmentChar(adapter, segment), 1, 'the staged file must actually change');
    const { status, output } = runCheck(['--root', root]);
    assert.notEqual(status, 0, `a one-character prompt edit must red:\n${output}`);
    assert.match(output, new RegExp(`MISMATCH ${segment}\\b`), `the mismatch must name ${segment}:\n${output}`);
  });
}

// ── AC4: absent evidence is a failure, never a skip ──────────────────────────────────────────

test('AC4 · a missing snapshot file reds and names the file', (t) => {
  const root = stage(t);
  rmSync(path.join(root, SNAPSHOT_REL), { force: true });
  const { status, output } = runCheck(['--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /EMPTY_READING/, output);
  assert.ok(output.includes('fixtures/snapshot.json'), `the missing file must be named:\n${output}`);
});

test('AC4 · --control=no-snapshot reds and names the missing items', () => {
  const { status, output } = runCheck(['--control=no-snapshot']);
  assert.notEqual(status, 0, output);
  assert.match(output, /EMPTY_READING/, output);
  assert.match(output, /snapshot\.prompts/, `the missing items must be named:\n${output}`);
});

test('AC4 · an empty snapshot object reds and names the missing items', (t) => {
  const root = stage(t);
  writeFileSync(path.join(root, SNAPSHOT_REL), '{}\n');
  const { status, output } = runCheck(['--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /EMPTY_READING/, output);
  for (const key of ['ROLE', 'RULES', 'EXAMPLES', 'JSON_TASK', 'reasoning_effort', 'model']) {
    assert.ok(output.includes(`snapshot.prompts.${key}`), `${key} must be named as missing:\n${output}`);
  }
});

test('AC4 · --control=empty-snapshot agrees with the staged {}-snapshot case', () => {
  const { status, output } = runCheck(['--control=empty-snapshot']);
  assert.notEqual(status, 0, output);
  assert.match(output, /EMPTY_READING/, output);
});

// ── AC5/AC6: the freeze is a recomputation, and it says which evidence it came from ──────────

test('AC5 · freeze --check passes and prints the shapes, the run id and both source hashes', () => {
  const { status, output } = runFreeze(['--check']);
  assert.equal(status, 0, output);
  assert.ok(output.includes('C 8 x 10'), `no C shape:\n${output}`);
  assert.ok(output.includes('E 8 x 10'), `no E shape:\n${output}`);
  assert.match(output, /runId=\S+/, output);
  for (const key of ['promptFile', 'readingsFile']) {
    assert.match(output, new RegExp(`source\\.${key} path=\\S+ sha256=[0-9a-f]{64}`), `no ${key} reading:\n${output}`);
  }
});

test('AC5 · the freeze has no transport in it at all', () => {
  for (const specifier of importSpecifiers(FREEZE)) {
    assert.match(
      specifier,
      /^node:/,
      `${FREEZE_REL} imports '${specifier}'; anything but a builtin would make "no network" a claim about that module`,
    );
  }
  // The check script needs a LOADER to import the tree's `.ts` (ADR-004 decision 2), so its import
  // list is not empty of non-builtins. That loader is the one allowed exception, and it is named
  // rather than waved through: anything else appearing here fails this arm. Its offline property is
  // additionally ENFORCED at run time — the script poisons `globalThis.fetch` around its own work
  // and reds with `NETWORK` if anything uses it, which every green arm above has exercised.
  assert.deepEqual(
    importSpecifiers(CHECK).filter((specifier) => !specifier.startsWith('node:')),
    ['tsx/esm/api'],
    `${CHECK_REL} imports something other than builtins and its loader`,
  );
});

test('AC5 · freeze --check does not reach the network at run time either', () => {
  // A poisoned fetch/http would show up as a non-zero exit rather than as a request; the point is
  // that the run stays clean with the transport replaced.
  const result = spawnSync(
    process.execPath,
    ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network")}', FREEZE, '--check'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `freeze --check must not need the network:\n${result.stdout}${result.stderr}`);
});

test('AC5 · a one-character edit to the snapshot reds and names the segment', (t) => {
  const root = stage(t);
  const file = path.join(root, SNAPSHOT_REL);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data.prompts.RULES = `${data.prompts.RULES}·`;
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  const { status, output } = runFreeze(['--check', '--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /MISMATCH RULES\b/, `the segment must be named:\n${output}`);
});

test('AC5 · a raw reading removed reds and reports the clip that fell short', (t) => {
  const root = stage(t);
  const file = path.join(root, READINGS_REL);
  const kept = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      if (line.trim() === '') return false;
      const row = JSON.parse(line);
      return !(row.cond === 'C-fewshot' && row.clip === 'd03-o65.wav' && row.rep === 7);
    });
  writeFileSync(file, `${kept.join('\n')}\n`);
  const { status, output } = runFreeze(['--check', '--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /C clip d03-o65\.wav has 9 reading/, `the short clip must be reported:\n${output}`);
  assert.match(output, /SHA256 readingsFile/, `the readings hash must also be reported as stale:\n${output}`);
});

test('AC6 · the snapshot points at the raw prompt file and records its hash', () => {
  const data = snapshot();
  const recorded = data.provenance.source.promptFile;
  assert.equal(recorded.path, PROMPT_REL);
  assert.equal(recorded.sha256, sha256Hex(readFileSync(path.join(ROOT, PROMPT_REL))));
  assert.equal(data.provenance.source.readingsFile.path, READINGS_REL);
  assert.equal(data.provenance.source.readingsFile.sha256, sha256Hex(readFileSync(path.join(ROOT, READINGS_REL))));
});

test('AC6 · freeze --check reds when the raw prompt file changes by one character', (t) => {
  const root = stage(t);
  const file = path.join(root, PROMPT_REL);
  const source = readFileSync(file, 'utf8');
  const marker = 'const RULES = `';
  const at = source.indexOf(marker);
  assert.notEqual(at, -1, 'the staged raw prompt declares RULES as a template literal');
  writeFileSync(file, `${source.slice(0, at + marker.length)}·${source.slice(at + marker.length)}`);
  const { status, output } = runFreeze(['--check', '--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /SHA256 promptFile/, `the prompt hash must be reported as stale:\n${output}`);
  assert.ok(output.includes(PROMPT_REL), `the stale file must be named:\n${output}`);
});

// ── AC7: the probe, the six printed hashes, and the absence of the prompt's text ─────────────

test('AC7 · --probe prints an absolute adapter path inside its module directory', () => {
  const { status, output } = runCheck(['--probe']);
  assert.equal(status, 0, output);
  const probePath = /probe adapter=(\S+)/.exec(output);
  assert.ok(probePath, `no adapter path was printed:\n${output}`);
  assert.ok(path.isAbsolute(probePath[1]), `the printed path must be absolute: ${probePath[1]}`);
  assert.ok(
    probePath[1].startsWith(`${path.join(ROOT, 'shared/asr/list/dashscope-omni')}${path.sep}`),
    `the adapter must live under shared/asr/list/dashscope-omni/: ${probePath[1]}`,
  );
  assert.ok(existsSync(probePath[1]), `the printed path must exist: ${probePath[1]}`);
  assert.match(output, /probe adapter\.exists ok=true/, output);
});

test('AC7 · --probe reds when the adapter is not there', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'asr-frozen-probe-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { status, output } = runCheck(['--probe', '--root', root]);
  assert.notEqual(status, 0, output);
  assert.match(output, /probe adapter\.exists ok=false/, output);
});

test('AC7 · the criterion prints all six segments\' hashes, and they are read, not constants', () => {
  const green = runCheck();
  for (const segment of SEGMENTS) {
    const line = green.output.split('\n').map((candidate) => ITEM_LINE.exec(candidate)).find((match) => match?.[1] === segment);
    assert.ok(line, `no printed hash for ${segment}:\n${green.output}`);
    assert.equal(line[3], line[4], `${segment}'s two printed hashes must agree on a green run`);
  }
  // Positive control: a run that breaks exactly one segment must show THAT segment's two hashes
  // diverging, which is only possible if the numbers were computed from what was read.
  const red = runCheck(['--control=prompt-mutated:ROLE']);
  const lines = red.output
    .split('\n')
    .map((candidate) => ITEM_LINE.exec(candidate))
    .filter((match) => match !== null);
  const byName = new Map(lines.map((match) => [match[1], match]));
  assert.equal(byName.get('ROLE')?.[2], 'false', `ROLE must read false:\n${red.output}`);
  assert.notEqual(byName.get('ROLE')?.[3], byName.get('ROLE')?.[4], 'ROLE\'s hashes must diverge when it differs');
  for (const segment of SEGMENTS.filter((candidate) => candidate !== 'ROLE')) {
    assert.equal(byName.get(segment)?.[2], 'true', `${segment} must stay green when only ROLE moved:\n${red.output}`);
  }
});

test('AC7 · neither tool file carries the prompt text', () => {
  const data = snapshot();
  const needles = [data.prompts.ROLE.split('。')[0], data.prompts.RULES.split('\n')[0]];
  const tools = [CHECK_REL, 'scripts/asr-omni-prompt-frozen-check.test.mjs'];
  for (const needle of needles) {
    assert.ok(needle.length >= 3, `the derived needle is too short to be a scan: ${JSON.stringify(needle)}`);
    // Positive control first: the needle must be findable somewhere, or a broken grep reads clean.
    assert.equal(grepStatus(needle, [SNAPSHOT_REL]), 0, `the positive control found no '${needle}' in the snapshot`);
    assert.equal(
      grepStatus(needle, tools),
      1,
      `grep found '${needle}' in a tool file (status 2 would mean grep itself failed, not that the scan was clean)`,
    );
  }
});
