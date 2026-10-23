/**
 * The deployed artifacts, driven for real (AC2 of `gap-voice-sensevoice-server-adapter`).
 *
 * WHAT IS BEING READ. `voice-sensevoice-adapter.test.ts` reads the manager's RULES against a fake
 * worker — timeouts, restarts, the slot bookkeeping, the fail-closed handshake. Every one of those is
 * a property of this repository's code, and a fake is the right instrument for all of them. This file
 * reads the one claim that no fake can carry:
 *
 *   THE BYTES THIS REPOSITORY WOULD DEPLOY ARE THE BYTES THE EXPERIMENT MEASURED.
 *
 * That claim is not about a code path. It is about a patched `sherpa-onnx` build, two pinned weight
 * files, and a Python worker — four artifacts that exist on one host and produce, for a given wav,
 * exactly one answer. So the reading taken here is a comparison against a RECORD made by the same
 * engine outside this repository: `tc-verify/corpus/voice-index-loop/sv2/sv.jsonl`, the transcript,
 * per-token confidence and per-token timestamp of 1021 clips as the patched build computed them.
 * Reproducing that record verbatim, through this seam, is what makes the `buildId` in `meta` a
 * statement about an artifact rather than a string the worker printed about itself.
 *
 * WHY A MISSING ARTIFACT IS A FAILURE AND NOT A SKIP, ONCE THIS FILE IS THE CRITERION'S RUN. A
 * real-runtime criterion that turns itself off on a machine without a model passes on every machine
 * that cannot answer its question — which is every machine but the one it was written on. So while the
 * criterion is being run, the environment is CHECKED and a missing variable, a missing weight file or a
 * missing patch is red with the sentence that names what to set. The fake-worker criterion is the one
 * that stays green everywhere; that division is the point of having two files.
 *
 * ...AND WHY THE FILE STILL SKIPS WHEN IT IS NOT. `scripts/test.sh` — the fan-in suite — runs EVERY
 * `server/**\/*.test.ts`, with no skip list and no host filter, from an environment that does not export
 * the criterion's variables. Fail-closed-under-every-invocation therefore reds the whole fleet suite for
 * a fact about the host rather than about the diff, which is exactly the shape this repository keeps
 * paying for (`scripts/test.sh`'s own classification comment). So the gate is THE CRITERION'S OWN
 * VARIABLE: `SENSEVOICE_MODEL_DIR` is what AC2's command sets by construction, so a run of the criterion
 * cannot skip, and a run of anything else cannot fail here. The skip is printed, so a green suite says
 * that this file did not answer rather than leaving it ambiguous with one that did.
 *
 * WHY ONE ENVIRONMENT VARIABLE FINDS THREE THINGS. AC2's own command exports `SENSEVOICE_MODEL_DIR`
 * and `SENSEVOICE_PYTHON` and nothing else, so the two on-host locations the criterion also needs —
 * the patched build's `lib` directory, which is what makes the interpreter patched at all, and the
 * corpus record, which is the thing being compared against — are DERIVED from the model directory
 * (`<work root>/sv-probe/<model>` puts the work root two levels up) and each is overridable by its own
 * variable (`SENSEVOICE_PYTHONPATH`, `SENSEVOICE_CORPUS`). A path that is set explicitly always wins;
 * a path that is derived and absent is reported by name. Nothing here hardcodes the machine's layout,
 * so this file travels with the repository.
 *
 * THE REAL-TIME FACTOR IS MEASURED AGAINST THE FIXTURE'S OWN DURATION, parsed out of the wav header,
 * and not against the duration the engine reported back. An RTF whose denominator came from the
 * engine would be the engine's own claim about its own speed; the wav file's frame count is a fact
 * about the audio, and the wall clock around the call is a fact about the deployment.
 *
 * RUNNING IT. The literal AC2 command is
 *   SENSEVOICE_MODEL_DIR=... SENSEVOICE_PYTHON=... npx vitest run server/modules/voice/tests/voice-sensevoice-real.test.ts
 * and it cannot run this file: `vitest.config.ts` includes `src/**` only, so a `server/` path is
 * silently dropped and vitest exits 1 with "No test files found". Server tests in this repository are
 * `node:test` files run through tsx, which is how the directory's every other criterion is run:
 *   npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-real.test.ts
 * Both exit codes are recorded in the task's Evidence, with this paragraph, rather than worked around
 * by editing the runner's include list — widening it would run all of `server/` a second time under
 * jsdom, which is a change to every other criterion in the repository.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

// REGISTRY FIRST, for the reason recorded at length in `voice-sensevoice-adapter.test.ts`: this seam's
// modules form one cycle, every consumer in the repository enters it through the registry, and a
// module that enters through an ADAPTER reads the registry's bindings while they are still in their
// temporal dead zone. Here the registry import is not merely an ordering trick — the row it hands out
// is the object the transcript is taken through, because that row is what `voice.service.ts` selects
// by id when it transcribes.
import {
  listProviders,
  type AsrAdapter,
  type AsrInvocation,
  type AsrRequest,
} from '../../../../shared/asr/asrRegistry.js';
import {
  ensureRuntime,
  installSensevoiceEngine,
  type SensevoiceEnginePort,
} from '../../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';
import {
  createSensevoiceWorker,
  nodeSensevoiceSpawn,
  readSensevoiceManifest,
  type SensevoiceChild,
  type SensevoiceManifest,
  type SensevoiceWorkerOptions,
} from '../sensevoice-worker.js';

// ── where everything is ───────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository this test belongs to; `server/modules/voice/tests/` is four levels down. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'sensevoice', 'manifest.json');
const WORKER_PATH = path.join(REPO_ROOT, 'scripts', 'sensevoice', 'worker.py');

/** The model directory AC2's command names. Read, never defaulted: a default here would be a second place to edit. */
const MODEL_DIR = process.env.SENSEVOICE_MODEL_DIR ?? '';
/** The interpreter of the PATCHED build, which AC2's command names. */
const PYTHON = process.env.SENSEVOICE_PYTHON ?? '';

/**
 * Whether this file is being run as the criterion, or merely collected by something that runs everything.
 *
 * THE GATE IS THE CRITERION'S OWN INPUT. AC2's command sets `SENSEVOICE_MODEL_DIR`, so the criterion's
 * own run can never take this branch, and every failure below stays a failure for it. The fan-in suite
 * (`scripts/test.sh`) runs every `server/**` test from an environment that sets nothing, and for it this
 * file answers with a visible skip instead of a red — a red there would be a fact about the host, not
 * about the diff, and it would take the whole fleet's suite with it.
 *
 * The value is the skip REASON, because `node:test` prints a string option as the reason it did not
 * run; a boolean `true` would leave the run saying only "skipped".
 */
const CRITERION_SKIP = MODEL_DIR === ''
  ? 'SENSEVOICE_MODEL_DIR is not set, so this is not AC2\'s own run: the real-runtime criterion is '
    + 'invoked as `SENSEVOICE_MODEL_DIR=… SENSEVOICE_PYTHON=… npx tsx --tsconfig server/tsconfig.json '
    + '--test server/modules/voice/tests/voice-sensevoice-real.test.ts` (see this file\'s header), and '
    + 'with the variable absent every assertion here would be a claim about this host rather than '
    + 'about the diff'
  : false;

/**
 * The work root, derived from the model directory's own location (`<work root>/sv-probe/<model>`).
 *
 * IT IS DERIVED RATHER THAN CONFIGURED because AC2's command sets one variable and the criterion
 * needs three locations under it. An empty `MODEL_DIR` yields empty paths, which the checks below
 * report by name before anything tries to use them.
 */
const WORK_ROOT = MODEL_DIR === '' ? '' : path.resolve(MODEL_DIR, '..', '..');

/**
 * The patched build's `lib` directory: what makes the named interpreter a PATCHED one.
 *
 * Prepending it to the worker's `PYTHONPATH` is not a convenience — it is the difference between the
 * engine this task ships and the stock one. The interpreter's own virtualenv carries a `sherpa_onnx`
 * whose `frame_log_probs` does not exist (measured: the attribute is present but always empty, and
 * the patched attribute is absent), so an interpreter used without this entry answers every request
 * with the engine's capability probe failing. The property is asserted below rather than assumed.
 */
const BUILD_DIR = process.env.SENSEVOICE_PYTHONPATH
  ?? (WORK_ROOT === '' ? '' : path.join(WORK_ROOT, 'sherpa-patch', 'sherpa-onnx', 'build', 'lib.linux-x86_64-cpython-312'));

/** The record the transcript is compared against: the patched engine's own offline output. */
const CORPUS_PATH = process.env.SENSEVOICE_CORPUS
  ?? (WORK_ROOT === '' ? '' : path.join(WORK_ROOT, 'tc-verify', 'corpus', 'voice-index-loop', 'sv2', 'sv.jsonl'));

/**
 * The wav files the record's ids name: the `wav/` directory beside the record's own directory.
 *
 * The record's ids carry the file's stem (`v3:1` → `1.wav`), and the audio lives one level up from
 * `sv2/`, beside it. It is derived for the same reason the corpus path is: AC2's command names the
 * record and the corpus is where the audio already is.
 */
const WAV_DIR = process.env.SENSEVOICE_WAV_DIR
  ?? (CORPUS_PATH === '' ? '' : path.join(path.dirname(CORPUS_PATH), '..', 'wav'));

/** The one deadline for a request, engine time included. Generous: a 30 s clip on a busy host is still seconds. */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * How many clips are read.
 *
 * SIX, AND THE CRITERION'S TWO FLOORS ARE BOTH ASSERTED RATHER THAN TRUSTED. AC2 asks the shape
 * questions of ≥ 3 fixtures and the verbatim question of ≥ 5 clips; this file reads one set for both,
 * which is strictly stronger, and asserts the set's own size so that a shrunken corpus makes the
 * criterion RED instead of quietly asking its question of two clips.
 */
const CLIP_COUNT = 6;

/** The confidence agreement the record's own precision supports: it stores four decimal places. */
const CONFIDENCE_TOLERANCE = 5e-5;

/** SenseVoice's frame shift, in ms: the unit the record's per-token timestamps are written in. */
const FRAME_MS = 60;

// ── the process, and the handles that end it ──────────────────────────────────────────────────

/**
 * Every child this file spawns, kept so the run can end.
 *
 * THE MANAGER'S PORT HAS NO `dispose`, and it should not: a deployment's engine lives as long as the
 * server process does, and there is no moment in production at which someone wants the child gone but
 * the manager kept. A TEST does need that moment — an open child keeps the event loop alive and the
 * runner would sit on a finished run — so the spawn is wrapped: the same real `nodeSensevoiceSpawn`,
 * with the child it returned remembered for the teardown below.
 */
const children: SensevoiceChild[] = [];

/** The engine's own log lines, kept so a start-up failure can be read rather than guessed at. */
const engineLog: string[] = [];

function recordingSpawn(
  command: string,
  args: string[],
  env: Record<string, string>,
): SensevoiceChild {
  const child = nodeSensevoiceSpawn(command, args, env);
  children.push(child);
  return child;
}

let port: SensevoiceEnginePort | null = null;
let manifest: SensevoiceManifest | null = null;

/**
 * The shipped manifest, or a failure that says why it is not here.
 *
 * `readSensevoiceManifest` is the module under this task's own reading of the pins, so the shipped
 * file is parsed by it rather than by `JSON.parse` here: a manifest this module cannot read is a
 * deployment that cannot start, and reading it the module's own way is what makes that a red reading
 * instead of an untested assumption.
 */
function requireManifest(): SensevoiceManifest {
  if (manifest === null) {
    assert.fail(
      'the shipped manifest was not read: the `before` hook failed before this test ran — see the '
      + `first failure in this run for ${MANIFEST_PATH}`,
    );
  }
  return manifest;
}

/**
 * The `PYTHONPATH` entry the worker was actually given, for the environment reading printed below.
 *
 * IT IS A READING AND NOT THE VARIABLE, because an absent build directory is the one case where the
 * difference matters: the worker is then spawned with no `PYTHONPATH` entry at all, and whether the
 * interpreter carries the patched build in its own site-packages is exactly what the handshake a few
 * lines later decides.
 */
function pythonPathEntry(): string {
  return existsSync(BUILD_DIR) ? BUILD_DIR : 'none (the interpreter must carry the patched build itself)';
}

/** The registry's row for this provider: the object the server itself transcribes through. */
function sensevoiceRow(): AsrAdapter {
  const row = listProviders().find((provider) => provider.id === 'sensevoice-local');
  if (row === undefined) {
    assert.fail(`the registry does not hand out a 'sensevoice-local' provider; it has ${listProviders().map((p) => p.id).join(', ')}`);
  }
  return row;
}

/** An invocation for an engine that is not reached over the network: every field is empty but the deadline. */
function invocation(): AsrInvocation {
  return {
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs: REQUEST_TIMEOUT_MS,
    // The local engine decodes the bytes it is handed and answers on a pipe. A fetch that ran would
    // mean this criterion had stopped reading the thing it is about.
    fetchImpl: (() => {
      throw new Error('the sensevoice-local provider must not reach the network');
    }) as unknown as typeof fetch,
  };
}

// ── the fixtures ─────────────────────────────────────────────────────────────────────────────

/** One record of the patched engine's offline run, in the fields this criterion reads. */
type CorpusRecord = {
  id: string;
  dur: number;
  sherpa_text: string;
  own_text: string;
  frames: number;
  tokens: { tok: string; p: number; t: number }[];
};

/** The wav a record names: the record's id past its `v3:` prefix, as a file name in the corpus's `wav/`. */
function wavPathFor(record: CorpusRecord): string {
  const separator = record.id.indexOf(':');
  const name = separator === -1 ? record.id : record.id.slice(separator + 1);
  return path.join(WAV_DIR, `${name}.wav`);
}

/**
 * The clip set: records whose wav is on disk, taken at an even stride through the record file.
 *
 * THE STRIDE IS THE POINT. The record holds clips whose ids are not contiguous — it carries both
 * `v3:1`-style utterance ids and `v3:c1235.1`-style chunk ids, and only 927 of its 1021 records have a
 * wav beside them — so an id list written here by hand would be a fixture that a regenerated corpus
 * silently invalidates. Taking every `n`-th record that HAS a wav is deterministic, needs no
 * knowledge of the naming scheme, and spreads the sample across the whole recording rather than
 * reading six neighbours.
 */
function clipRecords(records: CorpusRecord[], count: number): CorpusRecord[] {
  const usable = records.filter((record) => existsSync(wavPathFor(record)));
  if (usable.length <= count) return usable;
  const chosen: CorpusRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    chosen.push(usable[Math.round((index * (usable.length - 1)) / (count - 1))]);
  }
  return chosen;
}

/** The record file, in its own order. */
function readCorpus(): CorpusRecord[] {
  assert.ok(
    existsSync(CORPUS_PATH),
    `the record this criterion compares against is not at ${CORPUS_PATH}; set SENSEVOICE_CORPUS to `
    + 'the patched engine\'s jsonl, or SENSEVOICE_MODEL_DIR to a model directory under the same work root',
  );
  return readFileSync(CORPUS_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusRecord);
}

/**
 * The audio's own duration and format, read out of the wav header.
 *
 * IT IS PARSED HERE RATHER THAN ASKED OF THE ENGINE because the real-time factor's denominator must
 * not come from the thing whose speed is being measured. Only the two chunks that answer the question
 * are read — `fmt ` for the sample rate and `data` for the frame count — and both are asserted to be
 * the shape the model's manifest declares, so a fixture at the wrong rate is named rather than
 * silently scored against a duration it does not have.
 */
function readWav(bytes: Uint8Array, expectedSampleRate: number): { durationSec: number; sampleRate: number } {
  const ascii = (offset: number, length: number): string =>
    Array.from(bytes.slice(offset, offset + length), (byte) => String.fromCharCode(byte)).join('');
  assert.equal(ascii(0, 4), 'RIFF', 'the fixture is not a RIFF container');
  assert.equal(ascii(8, 4), 'WAVE', 'the fixture is not a WAVE container');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = ascii(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataBytes = Math.min(chunkSize, bytes.byteLength - offset - 8);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  assert.ok(sampleRate > 0 && dataBytes > 0, 'the fixture has no readable `fmt `/`data` chunk pair');
  assert.equal(sampleRate, expectedSampleRate, `the fixture is ${sampleRate} Hz, not the ${expectedSampleRate} Hz the manifest pins`);
  assert.ok(channels > 0 && bitsPerSample > 0, 'the fixture declares no channel count or sample width');
  const frames = dataBytes / (channels * (bitsPerSample / 8));
  return { durationSec: frames / sampleRate, sampleRate };
}

// ── the engine ───────────────────────────────────────────────────────────────────────────────

before(() => {
  // The skip is taken here and not only on the tests below: a `before` hook runs even when every test
  // in the file is skipped, so an unguarded assertion here would red a run whose tests all declined.
  if (CRITERION_SKIP !== false) {
    console.log(`AC2 skipped: ${CRITERION_SKIP}`);
    return;
  }
  assert.ok(
    PYTHON !== '',
    'AC2 needs the PATCHED build\'s interpreter: run it with SENSEVOICE_PYTHON=<the patched build\'s python3>',
  );
  assert.ok(existsSync(WORKER_PATH), `the worker this criterion spawns is not at ${WORKER_PATH}`);

  manifest = readSensevoiceManifest(MANIFEST_PATH);

  // The pinned files are checked by name before anything is spawned, so a directory that holds
  // nothing answers with the repair an operator can act on rather than with the worker's own
  // "ENGINE_UNAVAILABLE" several layers down.
  for (const file of manifest.model.files) {
    assert.ok(
      existsSync(path.join(MODEL_DIR, file.name)),
      `${MODEL_DIR} holds no ${file.name}, which is one of the two files ${MANIFEST_PATH} pins`,
    );
  }

  const options: SensevoiceWorkerOptions = {
    manifest,
    modelDir: MODEL_DIR,
    python: PYTHON,
    pythonPath: existsSync(BUILD_DIR) ? BUILD_DIR : null,
    workerPath: WORKER_PATH,
    concurrency: 1,
    timeoutMs: REQUEST_TIMEOUT_MS,
    spawn: recordingSpawn,
    log: {
      info: (message) => engineLog.push(`info: ${message}`),
      warn: (message) => engineLog.push(`warn: ${message}`),
    },
  };
  port = createSensevoiceWorker(options);
  installSensevoiceEngine(port);
});

after(() => {
  installSensevoiceEngine(null);
  for (const child of children) child.kill();
});

// ── the readings ─────────────────────────────────────────────────────────────────────────────

/**
 * The manifest is a description of artifacts that are HERE, and the pin it carries is true.
 *
 * This is the cheap half of the criterion and it is taken first: the shipped manifest names a patch
 * file and its digest, and a digest that does not match the file on disk would make every later
 * comparison a comparison with a description of something else. The corpus is read here too, so a
 * missing or truncated record fails before a model is loaded.
 */
test('the shipped manifest pins the patch on disk, and the record has clips to read', { skip: CRITERION_SKIP }, () => {
  const pinned = requireManifest();

  const patchPath = path.join(REPO_ROOT, pinned.engine.patch.path);
  assert.ok(existsSync(patchPath), `${MANIFEST_PATH} pins a patch at ${pinned.engine.patch.path}, which is not in this tree`);
  const patchSha = createHash('sha256').update(readFileSync(patchPath)).digest('hex');
  assert.equal(
    patchSha,
    pinned.engine.patch.sha256,
    `the patch at ${pinned.engine.patch.path} is not the one the manifest pins`,
  );

  assert.equal(pinned.sampleRate, 16000, 'the manifest pins a sample rate the fixtures are not recorded at');

  const records = readCorpus();
  const clips = clipRecords(records, CLIP_COUNT);
  assert.ok(
    clips.length >= 5,
    `the record holds ${records.length} entries but only ${clips.length} with a wav beside them; AC2 needs at `
    + 'least five clips to compare verbatim and three to read the token shape from',
  );

  console.log(
    `AC2 environment: model=${MODEL_DIR} python=${PYTHON} pythonPath=${pythonPathEntry()} `
    + `buildId=${pinned.buildId} clips=${clips.map((clip) => `${clip.id}(${clip.dur.toFixed(2)}s)`).join(',')}`,
  );
});

/**
 * The engine answers for itself before it is asked to recognise anything: the health-shaped reading.
 *
 * `ensureRuntime` is the one call that pays for the model load, and it is the same call the server's
 * health route makes. Its `buildId` is the handshake's, compared against the manifest's — if the
 * worker is running against different weights, this is where the criterion says so once instead of
 * once per clip.
 */
test('the engine comes up ready and reports the manifest\'s build id', { skip: CRITERION_SKIP }, async () => {
  const pinned = requireManifest();
  const status = await ensureRuntime();
  if (!status.available) {
    assert.fail(`the engine did not come up: ${status.reason}${engineLog.length ? ` | log: ${engineLog.join(' | ')}` : ''}`);
  }
  assert.equal(status.buildId, pinned.buildId, 'the running worker is not the build the manifest pins');
  assert.ok(['stopped', 'starting', 'ready'].includes(status.state), `unexpected engine state ${status.state}`);
  console.log(`AC2 engine: state=${status.state} buildId=${status.buildId}${engineLog.length ? ` log=${engineLog.slice(-2).join(' | ')}` : ''}`);
});

/**
 * THE CRITERION. Six clips of the record, recognised here, compared against the record itself.
 *
 * Five readings per clip, and they are the criterion's own:
 *   · the text is the record's text VERBATIM — not merely similar, which is the claim the DoD rests on;
 *   · `tokens` is non-empty and every `confidence` is in (0, 1];
 *   · `meta.buildId` is the manifest's, so the answer is attributable to a pinned artifact;
 *   · the real-time factor is at most 0.2 against the fixture's own duration;
 *   · and the tokens themselves — text, confidence and timestamp — reproduce the record's, which is
 *     the reading that separates "the same model" from "a model that heard the same words". The
 *     record's confidences are stored to four decimal places, so they are compared at that precision;
 *     its timestamps are frame indices at a 60 ms shift, so the comparison converts rather than
 *     compares two units that were never equal.
 */
test('six clips of the record reproduce it: text, tokens, confidences, build id and real-time factor', { skip: CRITERION_SKIP }, async () => {
  const pinned = requireManifest();
  const row = sensevoiceRow();
  const records = readCorpus();
  const clips = clipRecords(records, CLIP_COUNT);
  assert.ok(clips.length >= 5, `only ${clips.length} clips are readable; the criterion needs at least five`);

  const wallTimes: number[] = [];
  for (const record of clips) {
    const fixture = wavPathFor(record);
    const fileBytes = readFileSync(fixture);
    const bytes = new Uint8Array(fileBytes);
    const { durationSec } = readWav(bytes, pinned.sampleRate);

    const request: AsrRequest = {
      audio: { bytes, mimeType: 'audio/wav', fileName: path.basename(fixture) },
    };

    const started = performance.now();
    const result = await row.transcribe(request, invocation());
    const wallSec = (performance.now() - started) / 1000;
    wallTimes.push(wallSec);

    if (!result.ok) {
      assert.fail(`${record.id}: the engine refused the clip (${result.code}): ${result.message}`);
    }

    // ① the text, verbatim against the record.
    assert.equal(
      result.text,
      record.sherpa_text,
      `${record.id}: the recognised text is not the record's text verbatim\n  read:     ${JSON.stringify(result.text)}\n  recorded: ${JSON.stringify(record.sherpa_text)}`,
    );

    // ② the token shape: non-empty, and every confidence inside the half-open unit interval.
    const tokens = result.tokens ?? [];
    assert.ok(tokens.length > 0, `${record.id}: the answer carries no tokens (tokens=${JSON.stringify(result.tokens)})`);
    for (const token of tokens) {
      assert.ok(
        typeof token.confidence === 'number' && token.confidence > 0 && token.confidence <= 1,
        `${record.id}: token ${JSON.stringify(token.text)} carries confidence ${String(token.confidence)}, which is not in (0, 1]`,
      );
    }

    // ③ the tokens against the record's, at the precision the record stores them at.
    assert.equal(
      tokens.length,
      record.tokens.length,
      `${record.id}: ${tokens.length} tokens read against ${record.tokens.length} recorded`,
    );
    tokens.forEach((token, index) => {
      const recorded = record.tokens[index];
      assert.equal(
        token.text,
        recorded.tok,
        `${record.id} token ${index}: read ${JSON.stringify(token.text)}, recorded ${JSON.stringify(recorded.tok)}`,
      );
      assert.ok(
        Math.abs((token.confidence ?? 0) - recorded.p) <= CONFIDENCE_TOLERANCE,
        `${record.id} token ${index} (${JSON.stringify(recorded.tok)}): confidence ${String(token.confidence)} is not the recorded ${recorded.p}`,
      );
      assert.equal(
        Math.round((token.startMs ?? -1) / FRAME_MS),
        recorded.t,
        `${record.id} token ${index} (${JSON.stringify(recorded.tok)}): start ${String(token.startMs)} ms is not the recorded frame ${recorded.t}`,
      );
    });

    // ④ the answer is attributable to the pinned build.
    assert.equal(
      result.meta?.buildId,
      pinned.buildId,
      `${record.id}: the answer's build id is ${String(result.meta?.buildId)}, not the manifest's`,
    );

    // ⑤ the real-time factor, against the fixture's own duration.
    const rtf = wallSec / durationSec;
    assert.ok(
      rtf <= 0.2,
      `${record.id}: real-time factor ${rtf.toFixed(4)} exceeds 0.2 (${wallSec.toFixed(3)} s of wall clock for ${durationSec.toFixed(3)} s of audio)`,
    );

    console.log(
      `AC2 clip ${record.id} dur=${durationSec.toFixed(3)}s wall=${wallSec.toFixed(3)}s rtf=${rtf.toFixed(4)} `
      + `engine=${String(result.meta?.latencyMs)}ms tokens=${tokens.length} buildId=${String(result.meta?.buildId)}`,
    );
  }

  // The mean is printed rather than asserted: the per-clip ceiling above is the criterion, and a mean
  // that happened to sit under it would hide the one clip that did not.
  const meanWallSec = wallTimes.reduce((sum, value) => sum + value, 0) / wallTimes.length;
  console.log(`AC2 ${clips.length} clips, mean wall clock ${meanWallSec.toFixed(3)} s`);
});
