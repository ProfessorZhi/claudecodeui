/**
 * The on-host recogniser's process manager, driven through a fake worker (AC1 of
 * `gap-voice-sensevoice-server-adapter`).
 *
 * WHAT IS BEING READ. The `sensevoice-local` adapter is the first recogniser in this seam whose
 * answer comes from a PROCESS rather than from a service, so five things about that process are
 * claims a criterion has to hold rather than traits a reader can check by eye:
 *
 *   ① an answer line becomes an `AsrSuccess` — the text, the tokens with their confidences and
 *      timestamps, and the `buildId` the deployed artifacts are attributable to;
 *   ② a worker that never answers is timed out rather than left hanging, and the process it was
 *      reading is retired instead of reused;
 *   ③ a worker that CRASHES is restarted by the next request, which then succeeds;
 *   ④ requests past the concurrency cap wait for a slot instead of running at once, because the
 *      Python side's session is not re-entrant;
 *   ⑤ an artifact that is not the pinned one makes the engine `ENGINE_UNAVAILABLE` — the fail-closed
 *      answer, never a silent substitution of whatever weights happened to be on disk.
 *
 * WHY A FAKE AND NOT THE REAL THING, said plainly because the boundary matters: ①②③④ are properties
 * of the MANAGER — timeouts, restarts, the slot bookkeeping — and every one of them is about a state
 * a real model reaches only by accident (a genuine crash, a genuine hang). What the real artifacts
 * and the real model are for is a different claim, taken where it belongs, in
 * `voice-sensevoice-real.test.ts`. A criterion that needed Python present to read the queueing rule
 * would be red on every machine that has no patched build, which is every machine but one.
 *
 * HOW THE PROCESS IS FAKED. `createSensevoiceWorker` takes its `spawn` and its manifest as arguments
 * and reads no environment of its own, so the fake is a `SensevoiceChild` — four members, listed in
 * `sensevoice-worker.ts` — whose "stdout" is a queue the test fills. The manager's protocol is two
 * kinds of line and nothing else: exactly one `ready` handshake before it is up, and one answer per
 * request after, keyed by the id the manager wrote to the fake's stdin. The fake therefore parses
 * what was written to it, which is how ① can assert that the audio really was base64'd onto the pipe
 * rather than merely counted.
 *
 * ① AND ⑤ DRIVE THE ADAPTER; ②③④ DRIVE THE MANAGER. ① and ⑤ assert the SEAM's shape (`AsrSuccess`,
 * `AsrFailure.code`), so they install the manager onto the adapter module and call `transcribe` — the
 * same two-step the composition root performs, with the port left as the only variable. ②③④ are about
 * the manager's own rules, so they call the port directly; a caller of the port is what they are
 * measuring, and going through the adapter would add a `status()` call and a mapping neither case is
 * about.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-sensevoice-adapter.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// THE REGISTRY IS IMPORTED FIRST, AND ITS IMPORT IS A VALUE RATHER THAN A TYPE ON PURPOSE.
//
// This seam's modules form one cycle: the registry imports each adapter's `id` and `transcribe`, and
// each adapter imports `declaredAcceptsMime` back from the registry. Every consumer in the repository
// enters the cycle through the registry — `voice.service.ts` and `src/shared/api.ts` both import it
// first — and when the cycle is entered that way the registry's top level reads adapter bindings that
// are already initialised. Enter through an ADAPTER and the registry evaluates while that adapter is
// still mid-evaluation, so its `const id` is in its temporal dead zone and the import throws
// `ReferenceError: Cannot access 'sensevoiceLocalId' before initialization`.
//
// THE DEFECT IS THE SEAM'S AND NOT THIS PROVIDER'S, which is worth stating because it decides where the
// repair belongs. Measured one entry per process: `openai-compatible`, `multimodal`, `dashscope-omni`
// and `sensevoice-local` each throw the same TDZ error when imported as the entry, and
// `shared/asr/asrRegistry.ts` alone imports cleanly. The pre-existing three are therefore exactly as
// fragile, and the seam's convention — the registry is the entry — is what this file follows rather
// than a new rule invented for the fourth provider.
import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import type { AsrInvocation, AsrRequest } from '../../../../shared/asr/asrRegistry.js';
import {
  adapter as sensevoiceAdapter,
  installSensevoiceEngine,
  type SensevoiceEnginePort,
} from '../../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';
import {
  createSensevoiceWorker,
  type SensevoiceChild,
  type SensevoiceManifest,
  type SensevoiceSpawn,
  type SensevoiceWorkerOptions,
} from '../sensevoice-worker.js';

// ── the pinned artifacts ──────────────────────────────────────────────────────────────────────
//
// A manifest of this file's own making rather than `scripts/sensevoice/manifest.json`: what is being
// read here is the manager's USE of the pins — that it compares the handshake against them and
// refuses when they disagree — and a fixture that read the shipped file would go red the day the
// build is re-pinned, for a reason that has nothing to do with the code under test. The shipped
// manifest is read where the shipped artifacts are, in the real-runtime criterion.

const MODEL_FILE = 'model.int8.onnx';
const TOKENS_FILE = 'tokens.txt';
const MODEL_SHA256 = 'a'.repeat(64);
const TOKENS_SHA256 = 'b'.repeat(64);
const ENGINE_VERSION = '1.13.8';
const CAPABILITY_MARKER = 'sv-logprobs-v1';
const BUILD_ID = 'sensevoice-1.13.8-c71f0ce00bec-sv-logprobs-v1';

const MANIFEST: SensevoiceManifest = {
  engine: {
    name: 'sherpa-onnx',
    version: ENGINE_VERSION,
    capabilityMarker: CAPABILITY_MARKER,
    patch: { path: 'experiments/voice-index-loop/sherpa-patch/logprobs.patch', sha256: 'c'.repeat(64) },
  },
  model: {
    files: [
      { name: MODEL_FILE, sha256: MODEL_SHA256 },
      { name: TOKENS_FILE, sha256: TOKENS_SHA256 },
    ],
  },
  sampleRate: 16_000,
  buildId: BUILD_ID,
};

/**
 * A model directory holding exactly the two pinned files, so the CHEAP half of the artifact check
 * passes and the cases below are about the behaviour they name rather than about a missing directory.
 * Its CONTENT is never read — the digest that decides identity arrives on the handshake, and the cheap
 * half is a presence check — so the bytes written below are placeholders.
 */
const MODEL_DIR = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-adapter-model-'));
for (const file of [MODEL_FILE, TOKENS_FILE]) {
  writeFileSync(path.join(MODEL_DIR, file), 'pinned');
}
after(() => rmSync(MODEL_DIR, { recursive: true, force: true }));

/** The worker's start-up line, with any field a case wants to disagree with the manifest overridden. */
function readyLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'ready',
    buildId: BUILD_ID,
    engineVersion: ENGINE_VERSION,
    capabilityMarker: CAPABILITY_MARKER,
    sampleRate: 16_000,
    modelSha256: MODEL_SHA256,
    tokensSha256: TOKENS_SHA256,
    model: 'sense-voice-small-int8',
    ...overrides,
  });
}

/** One request the manager wrote to the fake's stdin, as the fake reads it back. */
type WorkerRequest = { id: number; audio: string; format: string };

// ── the fake child ────────────────────────────────────────────────────────────────────────────

/**
 * One worker process, faked: a queue the test fills in place of stdout, and a record of everything
 * written to stdin.
 *
 * THE QUEUE IS AN ASYNC ITERABLE because that is the type the manager consumes, and it is fed through
 * the same one-line-at-a-time interface a pipe would use — a line pushed while the manager is awaiting
 * one wakes the reader, a line pushed before it asks waits in the queue. `crash` and `kill` are
 * deliberately DIFFERENT endings: the manager distinguishes a stream that ended on its own (the
 * process died under it — case ③) from one it retired itself (case ②), and both are read.
 */
class FakeWorker implements SensevoiceChild {
  /** Every request the manager wrote, already parsed, in the order it wrote them. */
  readonly requests: WorkerRequest[] = [];
  readonly lines: AsyncIterable<string>;
  readonly exited: Promise<number | null>;
  /**
   * Pending forever, which is this fake's answer to "could the process be created?" — yes.
   *
   * `failed` exists for the ASYNCHRONOUS spawn failure (an interpreter that is not on the host), and
   * this fake is a process that was created: it has a queue, it answers, it can be killed. The two
   * cases that are about never having started — a `spawn` that throws, and the real ENOENT path — are
   * read in `voice-sensevoice-adapter.test.ts`'s interpreter case and in
   * `voice-sensevoice-health.routes.test.ts`'s closing control respectively, and neither goes through
   * this class.
   */
  readonly failed: Promise<string> = new Promise<string>(() => {});

  private readonly queue: string[] = [];
  private wake: (() => void) | null = null;
  private ended = false;
  /**
   * Set by the promise executor below, which runs synchronously inside the constructor — so the
   * assignment always happens before any other member is reachable. It cannot be `readonly` and it
   * cannot be a plain declaration: the compiler has no way to see through the executor closure, and
   * the definite-assignment marker is how that is stated rather than worked around.
   */
  private resolveExit!: (code: number | null) => void;

  constructor(
    /** 1 for the first worker this harness spawned, 2 for the next — a reading the cases print. */
    readonly index: number,
    /** What the worker does with each request. Absent means "says nothing", which is case ②. */
    private readonly onRequest: ((request: WorkerRequest, worker: FakeWorker) => void) | undefined,
  ) {
    this.exited = new Promise<number | null>((resolve) => {
      this.resolveExit = resolve;
    });
    this.lines = (async function* read(worker: FakeWorker) {
      while (true) {
        if (worker.queue.length === 0) {
          if (worker.ended) return;
          await new Promise<void>((resolve) => {
            worker.wake = resolve;
          });
          continue;
        }
        yield worker.queue.shift() as string;
      }
    })(this);
  }

  /** Whether the manager retired this process — case ② asserts it did. */
  get killed(): boolean {
    return this.ended;
  }

  /** One line from the worker's stdout. */
  push(line: string): void {
    if (this.ended) return;
    this.queue.push(line);
    const woken = this.wake;
    this.wake = null;
    woken?.();
  }

  /** Answer one request, in the shape the manager's protocol writes. */
  answer(id: number, fields: Record<string, unknown> = {}): void {
    this.push(JSON.stringify({ id, ok: true, text: 'ok', buildId: BUILD_ID, ...fields }));
  }

  send(line: string): void {
    const request = JSON.parse(line) as WorkerRequest;
    this.requests.push(request);
    if (this.onRequest !== undefined) this.onRequest(request, this);
  }

  kill(): void {
    this.finish(null);
  }

  /** The worker stopped on its own: its stream ends and it reports an exit code. */
  crash(code = 1): void {
    this.finish(code);
  }

  private finish(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    const woken = this.wake;
    this.wake = null;
    woken?.();
    this.resolveExit(code);
  }
}

// ── the harness ───────────────────────────────────────────────────────────────────────────────

type HarnessOverrides = {
  /** What each worker does with a request. The default answers it. */
  onRequest?: (request: WorkerRequest, worker: FakeWorker) => void;
  /** What each worker says on start-up. The default is the manifest's own handshake. */
  onSpawn?: (worker: FakeWorker) => void;
  /**
   * The spawn itself, for the cases about a process that never becomes one.
   *
   * DECLARED HERE RATHER THAN LEFT OUT so that a case which needs a failing spawn says so in a field
   * the compiler checks. It used to be omitted from the override type while the default below still
   * read `workerOptions.spawn`, so an override passed by name reached the manager through the object
   * spread and typechecked as nothing at all — a case that looked like it was driving the seam while
   * the seam's own type said the field did not exist. The one consumer is the interpreter case, which
   * throws from here the way `spawn` does for a command it cannot run.
   */
  spawn?: SensevoiceSpawn;
} & Partial<Omit<SensevoiceWorkerOptions, 'spawn' | 'log'>>;

type Harness = {
  options: SensevoiceWorkerOptions;
  /** Every worker the manager spawned, in order. */
  workers: FakeWorker[];
  /** Everything the manager said, for a case that reads a warning rather than a return value. */
  logs: string[];
};

/**
 * A manager configured over a fake child.
 *
 * `concurrency: 1` and a five-second deadline by default, because both are knobs the cases below move
 * and an assertion reads better against a figure the case chose than against the shipping default.
 */
function harness(overrides: HarnessOverrides = {}): Harness {
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const { onRequest, onSpawn, spawn, ...workerOptions } = overrides;

  const defaultSpawn: SensevoiceWorkerOptions['spawn'] = () => {
    const worker = new FakeWorker(
      workers.length + 1,
      onRequest ?? ((request, self) => self.answer(request.id, { text: 'transcribed' })),
    );
    workers.push(worker);
    (onSpawn ?? ((spawned: FakeWorker) => spawned.push(readyLine())))(worker);
    return worker;
  };

  return {
    workers,
    logs,
    options: {
      manifest: workerOptions.manifest ?? MANIFEST,
      // `null` is a MEANINGFUL value here (no model directory configured), so it is defaulted by an
      // explicit comparison rather than by `??`.
      modelDir: workerOptions.modelDir === undefined ? MODEL_DIR : workerOptions.modelDir,
      python: workerOptions.python ?? '/fake/bin/python3',
      pythonPath: workerOptions.pythonPath ?? null,
      workerPath: workerOptions.workerPath ?? '/fake/scripts/sensevoice/worker.py',
      concurrency: workerOptions.concurrency ?? 1,
      timeoutMs: workerOptions.timeoutMs ?? 5_000,
      spawn: spawn ?? defaultSpawn,
      log: {
        info: (message) => logs.push(`info ${message}`),
        warn: (message) => logs.push(`warn ${message}`),
      },
    },
  };
}

// ── the two halves of an adapter call ─────────────────────────────────────────────────────────

const AUDIO = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const AUDIO_BASE64 = Buffer.from(AUDIO).toString('base64');

function request(overrides: Partial<AsrRequest['audio']> = {}): AsrRequest {
  return {
    audio: { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'clip.wav', ...overrides },
  };
}

/** One engine-port request, which is what the manager's own `transcribe` takes. */
function engineRequest(timeoutMs = 5_000): Parameters<SensevoiceEnginePort['transcribe']>[0] {
  return { bytes: AUDIO, mimeType: 'audio/wav', fileName: 'clip.wav', timeoutMs };
}

/**
 * An invocation whose `fetchImpl` throws: this recogniser speaks to no endpoint, so a case that ever
 * reached for the network would fail loudly rather than quietly succeed at nothing.
 */
function invocation(timeoutMs = 5_000): AsrInvocation {
  return {
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutMs,
    fetchImpl: () => {
      throw new Error('the on-host recogniser must not reach for the network');
    },
  };
}

/** Runs `body` with `engine` installed on the adapter module, and always removes it again. */
async function withEngine<T>(engine: SensevoiceEnginePort, body: () => Promise<T>): Promise<T> {
  installSensevoiceEngine(engine);
  try {
    return await body();
  } finally {
    installSensevoiceEngine(null);
  }
}

/** Enough turns of the event loop for the manager's line pump and its slot bookkeeping to settle. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
}

/** The ids the manager has written to a worker's stdin, in order — the pipe's own reading. */
function idsOnPipe(harness_: Harness, worker = 0): number[] {
  return (harness_.workers[worker]?.requests ?? []).map((entry) => entry.id);
}

// ── ① the mapping ─────────────────────────────────────────────────────────────────────────────

test('AC1① an answer line becomes an AsrSuccess carrying the tokens, their confidences and the build id', async () => {
  const spoken = {
    text: '今天天气不错',
    model: 'sense-voice-small-int8',
    latencyMs: 41,
    durationMs: 1_280,
    tokens: [
      { text: '今', confidence: 0.9812, startMs: 0 },
      { text: '天', confidence: 0.9364, startMs: 120 },
      { text: '天气', confidence: 0.871, startMs: 240 },
    ],
  };
  const h = harness({ onRequest: (sent, worker) => worker.answer(sent.id, spoken) });

  const result = await withEngine(createSensevoiceWorker(h.options), () =>
    sensevoiceAdapter.transcribe(request(), invocation()));

  assert.equal(result.ok, true, 'the answer must map to a success');
  if (!result.ok) return;

  assert.equal(result.text, spoken.text);
  // The seam's own fields, not merely present: what the recogniser DID to the text and which
  // recogniser answered. `style: 'verbatim'` is the declaration this adapter publishes, so an adapter
  // that returned the engine's text under another style would claim a transformation here.
  assert.equal(result.style, 'verbatim');
  assert.deepEqual(result.transformations, []);
  assert.equal(result.providerId, 'sensevoice-local');
  // THE TOKENS, FIELD FOR FIELD, including the two the whole task exists for: a per-token confidence
  // and a per-token start. `deepEqual` is the reading rather than a length check because a mapping
  // that dropped `startMs`, or rounded a confidence, would pass a count.
  assert.deepEqual(result.tokens, spoken.tokens);
  assert.equal(result.meta?.buildId, BUILD_ID);
  assert.equal(result.meta?.model, spoken.model);
  assert.equal(result.meta?.latencyMs, spoken.latencyMs);

  // AND THE BYTES REALLY WENT TO THE WORKER: the line the manager wrote is the request's audio,
  // base64-encoded, with the container taken off the file name. Reading the encoding rather than
  // counting the calls is what separates "it asked the engine" from "it asked the engine for THIS
  // audio" — the failure a `Uint8Array.prototype.toString` would produce is "82,73,70,70", which a
  // call count cannot see.
  assert.equal(h.workers.length, 1);
  assert.deepEqual(h.workers[0]?.requests, [{ id: 1, audio: AUDIO_BASE64, format: 'wav' }]);

  console.log(
    `[adapter] mapped text=${JSON.stringify(result.text)} tokens=${result.tokens?.length ?? 0}`
      + ` buildId=${String(result.meta?.buildId)} format=${String(h.workers[0]?.requests[0]?.format)}`,
  );
});

// ── ② the deadline ────────────────────────────────────────────────────────────────────────────

test('AC1② a worker that never answers is timed out and retired, and the next request starts a new one', async () => {
  // `onRequest` says nothing at all, which is the hang: the request is on the pipe and no line ever
  // comes back. Both requests carry a deadline short enough to keep this case quick; the manager takes
  // the smaller of the caller's deadline and its own, so 60 ms is the figure that expires.
  const h = harness({ onRequest: () => {} });
  const engine = createSensevoiceWorker(h.options);

  const timedOut = await engine.transcribe(engineRequest(60));

  assert.equal(timedOut.ok, false, 'a worker that never answers must not produce a success');
  assert.equal(timedOut.ok === false ? timedOut.code : '', 'UPSTREAM_UNAVAILABLE');
  assert.match(
    timedOut.ok === false ? timedOut.message : '',
    /did not answer within 60 ms/,
    'the refusal names the deadline that expired',
  );

  // THE PROCESS IS NOT REUSED, and that is a protocol requirement rather than tidiness: one answer per
  // request travels over one pipe, so a reader that gave up mid-answer no longer knows where the next
  // line begins. A second request must therefore find a NEW process.
  assert.equal(h.workers.length, 1);
  assert.equal(h.workers[0]?.killed, true, 'the timed-out worker must be retired');

  const second = await engine.transcribe(engineRequest(60));
  assert.equal(h.workers.length, 2, 'the next request must start a fresh worker');
  assert.equal(second.ok === false ? second.code : '', 'UPSTREAM_UNAVAILABLE');
  // THE IDS ARE MONOTONIC ACROSS WORKERS, NOT PER WORKER, and that is the reading this line is here
  // for: the replacement is asked with id 2 rather than starting again at 1. The retired worker's
  // answer to id 1 may still be in flight on a pipe nobody is reading, so an id that could be reused
  // would let that stale line settle the new request — the reuse is a correctness property, not a
  // bookkeeping preference.
  assert.deepEqual(idsOnPipe(h, 1), [2], 'the replacement is asked with an id the retired worker never used');

  console.log(
    `[adapter] timeout=${timedOut.ok === false ? timedOut.code : 'ok'}`
      + ` message=${JSON.stringify(timedOut.ok === false ? timedOut.message : '')}`
      + ` workers=${h.workers.length} first-retired=${String(h.workers[0]?.killed)}`,
  );
});

// ── ③ the crash ───────────────────────────────────────────────────────────────────────────────

test('AC1③ a crashed worker is restarted by the next request, which then succeeds', async () => {
  // The FIRST request kills the process from underneath the manager — the stream ends with a request
  // still in flight. The SECOND is served by the replacement. BOTH halves are asserted: only the
  // failure would pass on an engine that never restarted, and only the success would pass on one that
  // silently swallowed a crashed request.
  const h = harness({
    onRequest: (sent, worker) => {
      if (worker.index === 1) {
        worker.crash(139);
        return;
      }
      worker.answer(sent.id, {
        text: 'after the restart',
        tokens: [{ text: 'after', confidence: 0.9, startMs: 0 }],
      });
    },
  });
  const engine = createSensevoiceWorker(h.options);

  const crashed = await engine.transcribe(engineRequest());
  assert.equal(crashed.ok, false, 'the request the crash carried cannot be answered');
  assert.equal(crashed.ok === false ? crashed.code : '', 'UPSTREAM_UNAVAILABLE');

  const restarted = await engine.transcribe(engineRequest());
  assert.equal(restarted.ok, true, 'the next request must be served by a fresh worker');
  assert.equal(restarted.ok === true ? restarted.text : '', 'after the restart');
  assert.equal(h.workers.length, 2);

  // The restarted engine is READY, not merely alive: `status()` reads the handshake the replacement
  // sent, and a manager that had kept the dead process's state would report the old build id — or none
  // at all — instead of the one this worker handshook with.
  const status = engine.status();
  assert.equal(status.available, true);
  assert.equal(status.available === true ? status.buildId : '', BUILD_ID);
  assert.equal(status.available === true ? status.state : '', 'ready');

  console.log(
    `[adapter] crash=${crashed.ok === false ? crashed.code : 'ok'} restarted=${String(restarted.ok)}`
      + ` workers=${h.workers.length} state=${status.available === true ? status.state : 'unavailable'}`,
  );
});

// ── ④ the queue ───────────────────────────────────────────────────────────────────────────────

test('AC1④ requests past the concurrency cap wait for a slot rather than running at once', async () => {
  // THE ANSWERS ARE HELD BY THE TEST, which is what makes "how many are on the pipe" a reading of the
  // pipe rather than a number the fake computed about itself: each request is released only when this
  // case says so, and between releases the only thing that can put a new id on the pipe is a freed
  // slot.
  const concurrency = 2;
  const pendingReleases: (() => void)[] = [];
  const h = harness({
    concurrency,
    onRequest: (sent, worker) => {
      pendingReleases.push(() => worker.answer(sent.id, { text: `answer ${sent.id}` }));
    },
  });
  const engine = createSensevoiceWorker(h.options);

  const started = [1, 2, 3, 4].map(() => engine.transcribe(engineRequest()));
  await settle();

  assert.deepEqual(idsOnPipe(h), [1, 2], 'no more than the cap may be on the pipe at once');

  (pendingReleases.shift() as () => void)(); // 1 answered ⇒ its slot frees
  await settle();
  assert.deepEqual(idsOnPipe(h), [1, 2, 3], 'the first queued request goes out when a slot frees');

  (pendingReleases.shift() as () => void)(); // 2 answered ⇒ the next slot frees
  await settle();
  assert.deepEqual(idsOnPipe(h), [1, 2, 3, 4], 'and the last one when the next slot does');

  while (pendingReleases.length > 0) (pendingReleases.shift() as () => void)();
  const answers = await Promise.all(started);

  // EVERY REQUEST WAS SERVED, ONE ID APIECE, IN ORDER. The cap is a QUEUE and not a drop: a manager
  // that refused the overflow would pass the pipe readings above while failing its callers, and one
  // that re-ordered would hand a caller another caller's answer.
  assert.deepEqual(
    answers.map((answer) => (answer.ok ? answer.text : `failed:${answer.code}`)),
    ['answer 1', 'answer 2', 'answer 3', 'answer 4'],
  );
  assert.equal(h.workers.length, 1, 'one worker serves every request; the cap is per worker, not per process');
  assert.deepEqual(idsOnPipe(h), [1, 2, 3, 4]);

  console.log(
    `[adapter] concurrency=${concurrency} requests=${idsOnPipe(h).length} order=${idsOnPipe(h).join(',')}`
      + ` served=${answers.filter((answer) => answer.ok).length}`,
  );
});

// ── ⑤ the pins ────────────────────────────────────────────────────────────────────────────────

test('AC1⑤ a handshake that is not the pinned build makes the engine ENGINE_UNAVAILABLE, with the disagreement named', async () => {
  // Four disagreements, one per pinned identity: a swapped model, a swapped token list, another build
  // id, and another engine version. Each is its own case because each is a different way to be wrong,
  // and the fail-closed rule is that ALL of them answer the same stable code.
  const disagreements: { name: string; line: string; expected: RegExp }[] = [
    { name: 'model-digest', line: readyLine({ modelSha256: 'f'.repeat(64) }), expected: /model\.int8\.onnx/ },
    { name: 'tokens-digest', line: readyLine({ tokensSha256: 'f'.repeat(64) }), expected: /tokens\.txt/ },
    { name: 'build-id', line: readyLine({ buildId: 'sensevoice-some-other-build' }), expected: /sensevoice-some-other-build/ },
    { name: 'engine-version', line: readyLine({ engineVersion: '1.12.0' }), expected: /1\.12\.0/ },
  ];

  const readings: string[] = [];
  for (const disagreement of disagreements) {
    const h = harness({ onSpawn: (worker) => worker.push(disagreement.line) });
    const engine = createSensevoiceWorker(h.options);

    const result = await withEngine(engine, () => sensevoiceAdapter.transcribe(request(), invocation()));
    assert.equal(result.ok, false, `${disagreement.name}: a build that is not the pinned one must not transcribe`);
    assert.equal(
      result.ok === false ? result.code : '',
      'ENGINE_UNAVAILABLE',
      `${disagreement.name}: the refusal must be the stable engine code`,
    );
    assert.match(result.ok === false ? result.message : '', disagreement.expected);

    // The engine reports itself unavailable to a caller that asks BEFORE sending anything, too —
    // health reads `status()`, and an engine that only discovered the disagreement on the
    // transcription path would report itself ready.
    const status = engine.status();
    assert.equal(status.available, false, `${disagreement.name}: the engine must report itself unavailable`);
    readings.push(`${disagreement.name}=${result.ok === false ? result.code : 'ok'}`);
  }

  console.log(`[adapter] pin-disagreements ${readings.join(' ')}`);
});

test('AC1⑤ a model directory that does not hold the pinned files is ENGINE_UNAVAILABLE before anything is spawned', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-adapter-empty-'));
  try {
    const h = harness({ modelDir: empty });
    const engine = createSensevoiceWorker(h.options);

    const result = await withEngine(engine, () => sensevoiceAdapter.transcribe(request(), invocation()));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.code : '', 'ENGINE_UNAVAILABLE');
    assert.match(result.ok === false ? result.message : '', /does not hold 'model\.int8\.onnx'/);
    // NOTHING WAS STARTED. The cheap half of the check runs at construction precisely so that a
    // deployment with no weights pays no interpreter, and a reading of the spawn count is what says so
    // rather than a comment claiming it.
    assert.equal(h.workers.length, 0, 'an engine with no weights must not spawn a process');

    // The same directory with only the FIRST pinned file present is the same answer naming the second:
    // every pinned file is checked rather than the first one only.
    writeFileSync(path.join(empty, MODEL_FILE), 'pinned');
    const partialHarness = harness({ modelDir: empty });
    const second = await withEngine(createSensevoiceWorker(partialHarness.options), () =>
      sensevoiceAdapter.transcribe(request(), invocation()));
    assert.equal(second.ok === false ? second.code : '', 'ENGINE_UNAVAILABLE');
    assert.match(second.ok === false ? second.message : '', /does not hold 'tokens\.txt'/);
    assert.equal(partialHarness.workers.length, 0);

    // And a deployment that configured no directory at all is the same stable code, with the variable
    // it has to set named in the sentence.
    const unconfiguredHarness = harness({ modelDir: null });
    const third = await withEngine(createSensevoiceWorker(unconfiguredHarness.options), () =>
      sensevoiceAdapter.transcribe(request(), invocation()));
    assert.equal(third.ok === false ? third.code : '', 'ENGINE_UNAVAILABLE');
    assert.match(third.ok === false ? third.message : '', /SENSEVOICE_MODEL_DIR/);
    assert.equal(unconfiguredHarness.workers.length, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('AC1⑤ with no engine installed at all the adapter still answers ENGINE_UNAVAILABLE rather than throwing', async () => {
  // The fail-closed default this module ships with, which is the state of every deployment that never
  // configured this recogniser: `installSensevoiceEngine(null)` is what the module starts as.
  installSensevoiceEngine(null);

  const result = await sensevoiceAdapter.transcribe(request(), invocation());
  assert.equal(result.ok, false, 'a recogniser with no engine must refuse, not throw');
  assert.equal(result.ok === false ? result.code : '', 'ENGINE_UNAVAILABLE');
  assert.match(result.ok === false ? result.message : '', /SENSEVOICE_MODEL_DIR/);
});

test('AC1⑤ an interpreter that does not exist is a state rather than a crash, with the command named', async () => {
  // The other half of "the artifacts are absent" — the weights are there and the PYTHON is not — and
  // it arrives through a different door: `spawn` THROWS synchronously when the executable does not
  // exist, which is the ordinary shape of "this host has no Python". The manager turns that into the
  // same sticky, actionable sentence a missing weight file gets; letting it escape would surface as a
  // rejected promise on the request path instead of a code the caller can act on.
  const command = '/nonexistent/python3';
  const h = harness({
    python: command,
    spawn: () => {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
    },
  });
  const engine = createSensevoiceWorker(h.options);

  // `ensureReady` is the call a caller makes to ask whether the engine is up, so it has to RESOLVE with
  // the state. A rejection here would be read by the health route as a crash rather than as a reason.
  const readiness = await engine.ensureReady();
  assert.equal(readiness.available, false, 'a missing interpreter must be reported, not thrown');
  assert.match(readiness.available === false ? readiness.reason : '', /could not be started/);
  assert.match(
    readiness.available === false ? readiness.reason : '',
    /nonexistent\/python3/,
    'the sentence has to name the command an operator would repair',
  );

  const result = await withEngine(engine, () => sensevoiceAdapter.transcribe(request(), invocation()));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.code : '', 'ENGINE_UNAVAILABLE');
  assert.match(result.ok === false ? result.message : '', /could not be started/);

  // STICKY, which is what keeps a host without Python from forking a doomed child per request: the
  // spawn was attempted once and the next attempt was answered from the recorded state.
  assert.equal(
    h.logs.filter((line) => line.includes('starting')).length,
    1,
    'a missing interpreter is recorded once, not re-attempted on the next request',
  );
  assert.equal(h.workers.length, 0);
});

test('AC1 the registry row the health route reads is this module’s own, carrying the two runtime fields and no credentials', () => {
  // WHY THIS IS HERE AND NOT ONLY IN THE HEALTH CRITERION. `GET /api/voice/health` reaches this
  // recogniser's availability by calling `runtime()` on the adapter the registry handed out — so the
  // route is only as good as this row. Reading it here is what says the row carries `runtime` and
  // `ensureRuntime` at all, and the identity comparisons say the registry published the module's own
  // functions rather than a copy that could drift from it.
  const row = listProviders().find((adapter_) => adapter_.id === 'sensevoice-local');
  assert.notEqual(row, undefined, 'the registry must hand out the sensevoice-local row');
  assert.equal(row?.runtime, sensevoiceAdapter.runtime);
  assert.equal(row?.ensureRuntime, sensevoiceAdapter.ensureRuntime);
  assert.equal(row?.transcribe, sensevoiceAdapter.transcribe);
  // NO `credentials`, which is what makes the settings form render no key field for this provider —
  // a declaration read by the form, not a branch inside it.
  assert.equal(row?.credentials, undefined);
  assert.equal(row?.capabilities.locality, 'local-server');
  assert.deepEqual(row?.capabilities.tokens, { confidence: true, timestamps: true });

  console.log(
    `[adapter] registry row id=${String(row?.id)} runtime=${typeof row?.runtime}`
      + ` ensureRuntime=${typeof row?.ensureRuntime} credentials=${String(row?.credentials)}`,
  );
});

test('AC1 the two guards run before the engine, so neither an unaccepted container nor an over-budget request touches it', async () => {
  // The port is deliberately left UNINSTALLED: if either guard consulted the engine the answer would
  // be `ENGINE_UNAVAILABLE` rather than the guard's own code, which is what makes this a reading of
  // the ORDER rather than of the guards alone.
  installSensevoiceEngine(null);

  const container = await sensevoiceAdapter.transcribe(
    request({ mimeType: 'application/octet-stream', fileName: 'clip.bin' }),
    invocation(),
  );
  assert.equal(container.ok === false ? container.code : '', 'UNSUPPORTED_MIME');

  const oversize = await sensevoiceAdapter.transcribe(
    request({ bytes: new Uint8Array(32 * 1024 * 1024 + 1) }),
    invocation(),
  );
  assert.equal(oversize.ok === false ? oversize.code : '', 'OVERSIZE');

  console.log(
    `[adapter] guards container=${container.ok === false ? container.code : 'ok'}`
      + ` oversize=${oversize.ok === false ? oversize.code : 'ok'}`,
  );
});
