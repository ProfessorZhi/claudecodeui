/**
 * The SenseVoice engine's process manager: the thing that owns `scripts/sensevoice/worker.py`.
 *
 * WHAT IT IS FOR. `shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts` declares the
 * recogniser and holds an installable port; this file is the implementation of that port the
 * shipping deployment installs. It spawns the Python worker, speaks the JSON-line protocol to it,
 * caps how many requests run at once, times each one out, brings the worker back after a crash, and
 * refuses to call the engine available when the artifacts on disk are not the ones this
 * repository's readings were taken on.
 *
 * WHY IT IS NOT IN `shared/`, AND WHY THAT IS THE WHOLE LAYERING. Everything under `shared/asr/` is
 * compiled by BOTH compiler configurations and may therefore use no Node built-in. This file spawns
 * processes, reads files and encodes base64, so it is a SERVER module and lives where the rest of
 * them do. The seam between the two halves is the three-method port — `status`, `ensureReady`,
 * `transcribe` — so the adapter never learns that `child_process` exists and this file never learns
 * what an `AsrResult` is.
 *
 * WHERE THE ARTIFACT IDENTITY IS CHECKED, and why it is checked in two places rather than one.
 * The cheap half runs at construction: the manifest parses, the model directory exists, both pinned
 * files are in it. That is what a caller needs to know before it decides to spawn anything, and it
 * costs two `statSync` calls. The expensive half — the actual SHA-256 of 239 MB of weights — runs at
 * the HANDSHAKE, because the worker computes it anyway while it loads the model and reports it in
 * its first line. Hashing it here at start-up instead would make every boot of the server pay for a
 * quarter-gigabyte read whether or not this recogniser is ever selected; reading it off the
 * handshake costs nothing and is the same reading.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

import type { VoiceLogPort } from '@/shared/types.js';

import type { AsrToken } from '../../../shared/asr/asrRegistry.js';
import type {
  SensevoiceEngineAnswer,
  SensevoiceEngineErrorCode,
  SensevoiceEnginePort,
  SensevoiceEngineRequest,
  SensevoiceEngineStatus,
} from '../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';

// --------------------------- the manifest ---------------------------

/** One artifact the engine's identity rests on: a file name inside the model directory, and its digest. */
export type SensevoiceManifestFile = { name: string; sha256: string };

/**
 * `scripts/sensevoice/manifest.json`, as this module reads it.
 *
 * IT IS A FILE RATHER THAN A CONSTANT HERE on purpose. The pins are a fact about a BUILD — which
 * patched engine, which weights — and the build is produced by a script outside this repository's
 * TypeScript. A constant would have to be edited by hand every time that script ran, and the whole
 * value of the check is that the deployment compares itself against a record it did not just write.
 */
export type SensevoiceManifest = {
  engine: {
    name: string;
    version: string;
    capabilityMarker: string;
    patch: { path: string; sha256: string };
  };
  model: { files: SensevoiceManifestFile[] };
  sampleRate: number;
  /** The `buildId` every reading of this deployment is attributable to. */
  buildId: string;
};

/** Whether `value` is a JSON object, for the field reads below. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A required string field, or a throw naming the field that was missing. */
function requireString(source: Record<string, unknown>, field: string, where: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${where} is missing the string field '${field}'`);
  }
  return value;
}

/**
 * The manifest at `path`, or a throw naming what is wrong with it.
 *
 * THE THROW IS THE POINT and not an inconvenience: a manifest that cannot be read is a deployment
 * whose engine identity is unknown, and the caller turns this into `ENGINE_UNAVAILABLE` carrying the
 * message. Returning a default here would be the silent substitution this seam refuses — a server
 * that could not read its pins would run whatever weights it found.
 *
 * Consumer: `voice.module.ts`, which reads it once at start-up.
 */
export function readSensevoiceManifest(path: string): SensevoiceManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
  const engine = parsed['engine'];
  const model = parsed['model'];
  if (!isRecord(engine)) throw new Error(`${path} has no 'engine' object`);
  if (!isRecord(model)) throw new Error(`${path} has no 'model' object`);
  const patch = engine['patch'];
  if (!isRecord(patch)) throw new Error(`${path} has no 'engine.patch' object`);
  const files = model['files'];
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error(`${path} has no 'model.files' entries`);
  }
  return {
    engine: {
      name: requireString(engine, 'name', `${path}: engine`),
      version: requireString(engine, 'version', `${path}: engine`),
      capabilityMarker: requireString(engine, 'capabilityMarker', `${path}: engine`),
      patch: {
        path: requireString(patch, 'path', `${path}: engine.patch`),
        sha256: requireString(patch, 'sha256', `${path}: engine.patch`),
      },
    },
    model: {
      files: files.map((entry) => {
        if (!isRecord(entry)) throw new Error(`${path}: model.files entries must be objects`);
        return {
          name: requireString(entry, 'name', `${path}: model.files[]`),
          sha256: requireString(entry, 'sha256', `${path}: model.files[]`),
        };
      }),
    },
    sampleRate: typeof parsed['sampleRate'] === 'number' ? parsed['sampleRate'] : 16000,
    buildId: requireString(parsed, 'buildId', path),
  };
}

// --------------------------- the child seam ---------------------------

/**
 * One worker process, as this module needs it.
 *
 * IT IS A TYPE AND NOT A `ChildProcess`, which is what makes every case in
 * `tests/voice-sensevoice-adapter.test.ts` drivable without a Python interpreter on the machine:
 * the fake is a map of canned lines and a promise, the real one is thirty lines at the bottom of
 * this file. The manager never needs a pid, an exit signal, or a stream it writes raw bytes to.
 */
export type SensevoiceChild = {
  /** The worker's stdout, one line at a time, without the trailing newline. */
  lines: AsyncIterable<string>;
  /** Write one line to the worker's stdin. */
  send(line: string): void;
  /** Terminate the process. Idempotent, and safe on a process that is already gone. */
  kill(): void;
  /** Resolves when the process is gone: its exit code, or `null` when a signal ended it. */
  readonly exited: Promise<number | null>;
  /**
   * Resolves with the sentence when the process could not be created AT ALL; stays pending when it
   * was created.
   *
   * A FIFTH MEMBER, and the reason it is not folded into `exited`: Node reports a spawn failure
   * ASYNCHRONOUSLY, on the child's `'error'` event, and `'exit'` never follows it. A seam carrying
   * only `exited` would therefore have nothing to settle — the manager would wait forever on a
   * process that does not exist. That is not a hypothetical: it is what this seam did before this
   * member existed, and `tests/voice-sensevoice-health.routes.test.ts` is the reading that caught it
   * (an absent interpreter reached `start()` as an uncaught `'error'` and killed the test process —
   * a crash where the DoD asks for a stable code).
   *
   * IT IS REQUIRED RATHER THAN OPTIONAL so that every implementation has to answer the question: a
   * fake that omitted it would silently restore the hang, and the compiler is what says so.
   */
  readonly failed: Promise<string>;
};

/** How a worker process is obtained. Injected, so a test supplies its own. */
export type SensevoiceSpawn = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => SensevoiceChild;

/**
 * Somewhere to say what the engine is doing. Injected; this module has no console of its own.
 *
 * `warn` IS REQUIRED HERE AND OPTIONAL ON THE SEAM'S OWN PORT (`VoiceLogPort`), and the asymmetry is
 * deliberate rather than an inconsistency to be tidied away. This module has failures it must not
 * lose — the sticky sentence that says why the engine is unavailable, the line that says the worker
 * stopped under a request — so a log this module accepts has to have somewhere to put them. The
 * seam's port is implemented by three test doubles that never warn, so demanding the method there
 * would make a severity preference into a breaking change. `sensevoiceLogFrom` is the single
 * translation between the two, and it is where the fallback lives.
 */
export type SensevoiceWorkerLog = {
  info(message: string): void;
  warn(message: string): void;
};

/**
 * The seam's log port, as this module's log.
 *
 * A FAILURE IS NEVER DROPPED FOR WANT OF A METHOD. A port that keeps a `warn` gets the line at that
 * severity; a port that was written before `warn` existed gets the very same sentence through
 * `info`. What is not acceptable is the third option — asking for `log.warn(...)` on a port that has
 * none, which would either be a type error the composition root papers over or, worse, a call that
 * silently goes nowhere on the one path an operator reads after a deployment fails.
 *
 * Consumer: `voice.module.ts`.
 */
export function sensevoiceLogFrom(port: VoiceLogPort): SensevoiceWorkerLog {
  return {
    info: (message) => port.info(message),
    warn: (message) => {
      if (port.warn !== undefined) port.warn(message);
      else port.info(message);
    },
  };
}

/** Everything the manager needs, all of it supplied by the composition root that read the environment. */
export type SensevoiceWorkerOptions = {
  manifest: SensevoiceManifest;
  /** The directory holding the pinned weights, or `null` when the deployment named none. */
  modelDir: string | null;
  /** The interpreter the worker is spawned with. */
  python: string;
  /** An entry prepended to the worker's `PYTHONPATH`, or `null` for none. */
  pythonPath: string | null;
  /** Absolute path of `scripts/sensevoice/worker.py`. */
  workerPath: string;
  /** How many requests one worker serves at once. */
  concurrency: number;
  /** The deadline for one request, engine time included. */
  timeoutMs: number;
  spawn: SensevoiceSpawn;
  log: SensevoiceWorkerLog;
};

// --------------------------- the wire ---------------------------

/** The worker's start-up line, as this module reads it. */
type Handshake = {
  buildId: string;
  engineVersion: string;
  capabilityMarker: string;
  model?: string;
  sampleRate: number;
  /** The digest of each pinned artifact, keyed by the file name the manifest uses. */
  digests: Record<string, string>;
};

/** One line of the worker's answer stream. */
type WorkerLine = {
  type?: string;
  id?: string | number | null;
  ok?: boolean;
  text?: unknown;
  tokens?: unknown;
  buildId?: unknown;
  model?: unknown;
  durationMs?: unknown;
  latencyMs?: unknown;
  code?: unknown;
  message?: unknown;
  // THE HANDSHAKE'S OWN FIELDS, and they are declared for a reason rather than for tidiness. A key the
  // worker can send and this type does not name is reachable only by an index expression — which the
  // root compiler configuration tolerates and the server's does not, so the omission showed up as ten
  // errors the moment `server/tsconfig.json` was the configuration doing the checking. Every key the
  // protocol carries is declared here, so a reader can hold this list against `worker.py`'s writes and
  // the compiler holds every reader to it. Each is `unknown`: what arrives is unvalidated JSON, and
  // each site below narrows it before use, exactly as the answer fields do.
  engineVersion?: unknown;
  capabilityMarker?: unknown;
  sampleRate?: unknown;
  modelSha256?: unknown;
  tokensSha256?: unknown;
};

/** The codes the worker is allowed to name, so a stray string cannot reach the seam's vocabulary. */
const WORKER_CODES: readonly SensevoiceEngineErrorCode[] = [
  'ENGINE_UNAVAILABLE',
  'AUDIO_REJECTED',
  'UPSTREAM_UNAVAILABLE',
  'NO_SPEECH_DETECTED',
];

/** `code` when the worker named one this seam knows, and `UPSTREAM_UNAVAILABLE` otherwise. */
function workerCode(code: unknown): SensevoiceEngineErrorCode {
  return WORKER_CODES.indexOf(code as SensevoiceEngineErrorCode) === -1
    ? 'UPSTREAM_UNAVAILABLE'
    : (code as SensevoiceEngineErrorCode);
}

/** Whether a value is one token of the contract's shape, read structurally. */
function asToken(value: unknown): AsrToken | null {
  if (!isRecord(value)) return null;
  if (typeof value['text'] !== 'string') return null;
  const token: AsrToken = { text: value['text'] };
  if (typeof value['confidence'] === 'number') token.confidence = value['confidence'];
  if (typeof value['startMs'] === 'number') token.startMs = value['startMs'];
  return token;
}

/**
 * The handshake's identity, compared against the manifest. Returns the reason it disagrees, or
 * `null` when it agrees.
 *
 * EVERY PINNED FILE IS COMPARED, and that is the difference between "a worker started" and "the
 * pinned build started". Two builds of the same model answer slightly different text with slightly
 * different confidences, so a deployment that quietly loaded different weights would produce
 * readings that look fine and are comparable with nothing recorded — which is the failure this
 * whole check exists to make impossible. The name is the manifest's own, so a manifest that pins a
 * different set of files is compared against that set rather than against a list written here.
 */
function handshakeDisagreement(handshake: Handshake, manifest: SensevoiceManifest): string | null {
  if (handshake.engineVersion !== manifest.engine.version) {
    return `the worker is running ${manifest.engine.name} ${handshake.engineVersion}, and this `
      + `deployment is pinned to ${manifest.engine.version}`;
  }
  if (handshake.capabilityMarker !== manifest.engine.capabilityMarker) {
    return `the worker reports capability '${handshake.capabilityMarker}', and this deployment `
      + `requires '${manifest.engine.capabilityMarker}'`;
  }
  if (handshake.buildId !== manifest.buildId) {
    return `the worker reports build '${handshake.buildId}', and this deployment is pinned to `
      + `'${manifest.buildId}'`;
  }
  for (const file of manifest.model.files) {
    const reported = handshake.digests[file.name];
    if (reported === undefined) {
      return `the worker reported no digest for '${file.name}'`;
    }
    if (reported !== file.sha256) {
      return `the loaded '${file.name}' is not the pinned one: the worker reports ${reported}, and `
        + `the manifest pins ${file.sha256}`;
    }
  }
  return null;
}

// --------------------------- the manager ---------------------------

/**
 * The engine, as `shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.ts` needs it.
 *
 * ONE WORKER, `concurrency` REQUESTS AT ONCE, ANSWERED IN ORDER. The Python side is deliberately
 * single-threaded — the recogniser's session is not re-entrant — so concurrency here means "this
 * many requests may be in flight against this one worker". A request past the cap WAITS for a slot
 * rather than being refused: the caller's own deadline still bounds it, and refusing would turn a
 * busy engine into a failed transcription.
 *
 * A DEAD WORKER IS RESTARTED BY THE NEXT REQUEST, not by a supervisor. There is no timer and no
 * keep-alive: the process exists while there is work and not otherwise, which is what keeps a
 * deployment that never selects this recogniser from holding a quarter-gigabyte of weights
 * resident.
 *
 * Consumer: `voice.module.ts`, which installs the result onto the `sensevoice-local` provider module.
 */
export function createSensevoiceWorker(options: SensevoiceWorkerOptions): SensevoiceEnginePort {
  const { manifest, modelDir, python, pythonPath, workerPath, concurrency, timeoutMs, spawn, log } =
    options;

  /** Set once and never cleared: a deployment whose artifacts are wrong stays wrong until it is fixed. */
  let unavailable: string | null = null;
  let handshake: Handshake | null = null;
  let child: SensevoiceChild | null = null;
  /**
   * Which child the running line loop belongs to.
   *
   * A KILLED CHILD'S LOOP MUST NOT CLEAR ITS SUCCESSOR. The loop and the `exited` handler both run
   * asynchronously, so a worker retired by a timeout can have its stream end AFTER the next request
   * has already spawned a replacement — and without this counter that late ending would tear down a
   * perfectly healthy process. Every handler compares the generation it started under and returns
   * when it is stale.
   */
  let generation = 0;
  let starting: Promise<SensevoiceEngineStatus> | null = null;
  let active = 0;
  const waiting: (() => void)[] = [];
  let nextId = 1;
  const pending = new Map<number, {
    resolve: (answer: SensevoiceEngineAnswer) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /**
   * The cheap half of the artifact check, run once here and never again.
   *
   * A missing directory or a missing file is decided NOW, because those are the failures a
   * deployment hits on its first run and they cost two `statSync` calls to detect. What is
   * deliberately not read here is the content of the weights — see the module comment.
   */
  if (modelDir === null) {
    unavailable = 'SENSEVOICE_MODEL_DIR is not set, so this deployment has no SenseVoice weights to load.';
  } else {
    for (const file of manifest.model.files) {
      try {
        statSync(`${modelDir}/${file.name}`);
      } catch {
        // THE FIRST MISSING FILE IS THE ONE NAMED, and the loop stops there. Continuing would leave the
        // LAST missing file's sentence in `unavailable`, so a directory holding nothing would report
        // the tokens file rather than the weights — the wrong repair for the operator reading it.
        unavailable = `the SenseVoice model directory ${modelDir} does not hold '${file.name}'.`;
        break;
      }
    }
  }

  function status(): SensevoiceEngineStatus {
    if (unavailable !== null) return { available: false, state: 'unavailable', reason: unavailable };
    if (handshake !== null) return { available: true, state: 'ready', buildId: handshake.buildId };
    // Configured and loadable, but no process is up. The build id here is the MANIFEST's — the build
    // this deployment is pinned to and will load — which is a claim about configuration rather than
    // about a running process, and `state` is what tells a reader which of the two they are reading.
    return {
      available: true,
      state: starting === null ? 'stopped' : 'starting',
      buildId: manifest.buildId,
    };
  }

  /** Answer one in-flight request, or do nothing when its deadline already answered it. */
  function settle(id: number, answer: SensevoiceEngineAnswer): void {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(answer);
  }

  /** Fail every in-flight request: the engine is gone and their ids will never be answered. */
  function abandon(reason: string, code: SensevoiceEngineErrorCode): void {
    for (const id of [...pending.keys()]) {
      settle(id, { ok: false, code, message: reason });
    }
  }

  /** Drop the current child without waiting for it, so the next request starts a fresh one. */
  function retire(): void {
    generation += 1;
    const dying = child;
    child = null;
    handshake = null;
    if (dying !== null) dying.kill();
  }

  /** A slot on the engine, or a wait until one frees. */
  function acquire(): Promise<void> {
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  }

  /** One answer line, turned into the port's answer. */
  function answerFrom(line: WorkerLine): SensevoiceEngineAnswer {
    if (line.ok !== true) {
      return {
        ok: false,
        code: workerCode(line.code),
        message: typeof line.message === 'string' ? line.message : 'the engine refused the request',
      };
    }
    const tokens: AsrToken[] = [];
    if (Array.isArray(line.tokens)) {
      for (const entry of line.tokens) {
        const token = asToken(entry);
        if (token !== null) tokens.push(token);
      }
    }
    const answer: SensevoiceEngineAnswer = {
      ok: true,
      text: typeof line.text === 'string' ? line.text : '',
      tokens,
      // The handshake's id, which was validated against the manifest before it was kept, so an
      // answer cannot name a build this deployment is not running.
      buildId: handshake !== null ? handshake.buildId : manifest.buildId,
    };
    if (typeof line.model === 'string') answer.model = line.model;
    if (typeof line.latencyMs === 'number') answer.latencyMs = line.latencyMs;
    if (typeof line.durationMs === 'number') answer.durationMs = line.durationMs;
    return answer;
  }

  /**
   * The worker's stdout, from the handshake onwards.
   *
   * THE FIRST LINE IS THE HANDSHAKE AND EVERY LINE AFTER IT IS AN ANSWER, which is what makes the
   * protocol readable without a per-message type tag: the worker says exactly one thing before it is
   * ready and exactly one thing per request after. A line that arrives before the handshake and is
   * not one — a `fatal` — is the start-up failure, and it is reported with the message the worker
   * wrote rather than as "the process died".
   */
  async function pump(own: number, spawned: SensevoiceChild): Promise<void> {
    let ready = false;
    try {
      for await (const raw of spawned.lines) {
        if (own !== generation) return;
        let line: WorkerLine;
        try {
          line = JSON.parse(raw) as WorkerLine;
        } catch {
          continue;
        }
        if (!ready) {
          if (line.type === 'fatal') {
            unavailable = typeof line.message === 'string'
              ? line.message
              : 'the SenseVoice worker failed to start';
            log.warn(`sensevoice: ${unavailable}`);
            retire();
            return;
          }
          if (line.type !== 'ready') continue;
          const digests: Record<string, string> = {};
          if (typeof line.modelSha256 === 'string') {
            digests[manifest.model.files[0]?.name ?? 'model'] = line.modelSha256;
          }
          if (typeof line.tokensSha256 === 'string') {
            const second = manifest.model.files[1];
            if (second !== undefined) digests[second.name] = line.tokensSha256;
          }
          const reported: Handshake = {
            buildId: String(line.buildId ?? ''),
            engineVersion: String(line.engineVersion ?? ''),
            capabilityMarker: String(line.capabilityMarker ?? ''),
            sampleRate: typeof line.sampleRate === 'number' ? line.sampleRate : 0,
            digests,
          };
          if (typeof line.model === 'string') reported.model = line.model;
          const disagreement = handshakeDisagreement(reported, manifest);
          if (disagreement !== null) {
            unavailable = disagreement;
            log.warn(`sensevoice: ${disagreement}`);
            retire();
            return;
          }
          handshake = reported;
          ready = true;
          log.info(`sensevoice: engine ready, build ${reported.buildId}`);
          continue;
        }
        const id = typeof line.id === 'number' ? line.id : Number(line.id);
        if (Number.isFinite(id)) settle(id, answerFrom(line));
      }
    } catch (error) {
      if (own !== generation) return;
      log.warn(`sensevoice: the worker's output stream ended: ${String(error)}`);
    }
    if (own !== generation) return;
    // The stream ended without anyone having retired this child: the worker crashed, or exited on
    // its own. Every request it was carrying is unanswered and will never be answered.
    abandon('the SenseVoice worker stopped before it answered', 'UPSTREAM_UNAVAILABLE');
    retire();
  }

  /** Spawn the worker and wait for its handshake, or for it to say why it cannot start. */
  function start(): Promise<SensevoiceEngineStatus> {
    generation += 1;
    const own = generation;
    const env: Record<string, string> = {};
    if (modelDir !== null) env['SENSEVOICE_MODEL_DIR'] = modelDir;
    if (pythonPath !== null) env['PYTHONPATH'] = pythonPath;
    log.info(`sensevoice: starting ${python} ${workerPath}`);
    let spawned: SensevoiceChild;
    try {
      spawned = spawn(python, [workerPath], env);
    } catch (error) {
      // A MISSING INTERPRETER IS A STATE, NOT A REJECTION, and it arrives on TWO paths. This is the
      // SYNCHRONOUS one: `spawn` throws outright for an invalid argument — a malformed `stdio`, a
      // command carrying a NUL byte — and a fake in a test throws here on purpose. It is recorded
      // like every other provisioning failure (sticky, with the command in the sentence) so the
      // answer is the same stable `ENGINE_UNAVAILABLE` a missing model directory gets.
      unavailable = `the SenseVoice worker could not be started (${python} ${workerPath}): ${String(error)}`;
      log.warn(`sensevoice: ${unavailable}`);
      return Promise.resolve(status());
    }
    child = spawned;
    // The ASYNCHRONOUS path, and the ordinary one: an interpreter that does not exist is reported by
    // Node on the child's `'error'` event rather than thrown, and `'exit'` never follows it. Without
    // this, `status()` would never leave `starting` and the poll below would never resolve — the
    // missing-Python case would be a hang instead of a state. The child is what knows; this is where
    // its answer becomes the engine's.
    void spawned.failed.then((reason) => {
      if (own !== generation) return;
      unavailable = reason;
      log.warn(`sensevoice: ${unavailable}`);
    });
    void pump(own, spawned);
    void spawned.exited.then((code) => {
      if (own !== generation) return;
      abandon('the SenseVoice worker stopped before it answered', 'UPSTREAM_UNAVAILABLE');
      retire();
      log.warn(`sensevoice: worker exited with code ${String(code)}`);
    });
    // The handshake is not awaited through a second channel: `pump` sets `handshake` as it reads the
    // first line, and this poll finishes as soon as one of the three end states is visible.
    return new Promise<SensevoiceEngineStatus>((resolve) => {
      const poll = (): void => {
        if (handshake !== null || unavailable !== null || child === null) {
          resolve(status());
          return;
        }
        setTimeout(poll, 5);
      };
      poll();
    });
  }

  /** Bring the worker up if it is not up, and answer with the state either way. */
  function ensureReady(): Promise<SensevoiceEngineStatus> {
    if (unavailable !== null || handshake !== null) return Promise.resolve(status());
    if (starting !== null) return starting;
    const run = start().then((settled) => {
      if (starting === run) starting = null;
      return settled;
    });
    starting = run;
    return run;
  }

  return {
    status,

    ensureReady,

    async transcribe(request: SensevoiceEngineRequest): Promise<SensevoiceEngineAnswer> {
      if (unavailable !== null) {
        return { ok: false, code: 'ENGINE_UNAVAILABLE', message: unavailable };
      }
      await acquire();
      try {
        const readiness = await ensureReady();
        if (!readiness.available) {
          return { ok: false, code: 'ENGINE_UNAVAILABLE', message: readiness.reason };
        }
        const live = child;
        if (live === null) {
          return {
            ok: false,
            code: 'ENGINE_UNAVAILABLE',
            message: 'the SenseVoice worker is not running',
          };
        }
        // THE DEPLOYMENT'S OWN FIGURE IS A CEILING, NOT DECORATION. `request.timeoutMs` is the
        // caller's invocation deadline; the option this manager was built with is the deployment's,
        // and taking the smaller of the two is what makes `SENSEVOICE_TIMEOUT_MS` a knob an operator
        // can use to bound an on-host recognition more tightly than the general voice timeout — the
        // two are equal by default (see `voice.module.ts`), so the shipping deployment reads the same
        // deadline it always did.
        const deadline = Math.min(request.timeoutMs, timeoutMs);
        const id = nextId;
        nextId += 1;
        return await new Promise<SensevoiceEngineAnswer>((resolve) => {
          const timer = setTimeout(() => {
            settle(id, {
              ok: false,
              code: 'UPSTREAM_UNAVAILABLE',
              message:
                `the SenseVoice worker did not answer within ${deadline} ms; it was ended `
                + 'and the next request will start a new one',
            });
            // A one-request-at-a-time pipe whose deadline passed has an unread answer still coming,
            // so the stream position is unknown and this process cannot be reused.
            retire();
          }, deadline);
          pending.set(id, { resolve, timer });
          let line: string;
          try {
            line = JSON.stringify({
              id,
              // The bytes are copied through `Buffer.from` rather than encoded in place: the request's
              // `bytes` is a `Uint8Array` that may be a VIEW into a larger buffer, and its own
              // `toString` is `Array.prototype.toString` — "1,2,3" — not an encoder.
              audio: Buffer.from(request.bytes).toString('base64'),
              format: extensionOf(request.fileName, request.mimeType),
            });
            live.send(line);
          } catch (error) {
            // The write itself can fail — the child died between the liveness check above and this
            // line, and a destroyed pipe throws rather than buffering. Without this the request
            // would sit in `pending` until its deadline and then report a timeout, which names the
            // wrong cause; the worker is retired here for the same reason the deadline retires it,
            // since a half-written line leaves the stream position unknown.
            settle(id, {
              ok: false,
              code: 'UPSTREAM_UNAVAILABLE',
              message:
                `the SenseVoice worker's input stream refused the request (${String(error)}); it was `
                + 'ended and the next request will start a new one',
            });
            retire();
          }
        });
      } finally {
        release();
      }
    },
  };
}

// --------------------------- the fail-closed engine ---------------------------

/**
 * An engine that can never serve anything, carrying the reason it cannot.
 *
 * WHY THIS IS A PORT AND NOT AN ABSENCE. The composition root has two ways to be unable to build a
 * real worker — the manifest is unreadable, or the deployment configured nothing — and "install no
 * engine at all" would answer both with the adapter's own generic sentence ("no SenseVoice engine is
 * installed in this process"), which names neither the path that failed to parse nor the variable
 * that was not set. An operator reading `GET /api/voice/health` needs the specific one, so the
 * failure is installed as an engine that reports exactly it. The adapter cannot tell the difference,
 * which is the point: to it, this is an engine that is unavailable, and that is precisely what it is.
 *
 * Consumer: `voice.module.ts`.
 */
export function unavailableSensevoiceEngine(reason: string): SensevoiceEnginePort {
  const status = (): SensevoiceEngineStatus => ({ available: false, state: 'unavailable', reason });
  return {
    status,
    ensureReady: () => Promise.resolve(status()),
    transcribe: () =>
      Promise.resolve({ ok: false as const, code: 'ENGINE_UNAVAILABLE' as const, message: reason }),
  };
}

// --------------------------- the real child ---------------------------

/**
 * The audio's container as the worker's own `format` hint: the file's extension, or the media type's
 * subtype when the name has none.
 *
 * It is only a HINT — the worker sniffs the bytes first and reaches for ffmpeg by suffix when it
 * cannot — which is why a wrong answer here degrades rather than fails. It is still computed from
 * the request rather than hardcoded, because `ffmpeg` needs the right suffix to read a container
 * libsndfile refuses.
 */
export function extensionOf(fileName: string, mimeType: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot !== -1 && dot < fileName.length - 1) return fileName.slice(dot + 1).toLowerCase();
  const slash = mimeType.indexOf('/');
  return (slash === -1 ? mimeType : mimeType.slice(slash + 1)).split(';')[0].trim().toLowerCase();
}

/**
 * The real spawn: a `child_process` behind the four-member seam above.
 *
 * `stdio` IS `['pipe', 'pipe', 'inherit']` AND THE THIRD ENTRY IS THE POINT. The worker writes its
 * JSON protocol to stdout, which is parsed; its stderr is left alone and reaches this process's own,
 * because a Python traceback is the only thing that can explain a start-up failure and capturing it
 * into a buffer nothing reads would throw that away.
 *
 * The environment is the manager's own additions OVER this process's, so a deployment that already
 * has the right `PYTHONPATH` or `SENSEVOICE_MODEL_DIR` exported keeps it when it names only the
 * variables it wants to change.
 *
 * Consumer: `voice.module.ts`.
 */
export function nodeSensevoiceSpawn(
  command: string,
  args: string[],
  env: Record<string, string>,
): SensevoiceChild {
  const process_ = nodeSpawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const stdout = process_.stdout;
  if (stdout === null) throw new Error('the SenseVoice worker was spawned without a stdout pipe');
  return {
    lines: createInterface({ input: stdout }) as unknown as AsyncIterable<string>,
    send(line: string): void {
      process_.stdin?.write(`${line}\n`);
    },
    kill(): void {
      process_.kill('SIGKILL');
    },
    exited: new Promise<number | null>((resolve) => {
      process_.once('exit', (code) => resolve(code ?? null));
    }),
    failed: new Promise<string>((resolve) => {
      // THE LISTENER HAS TO BE ATTACHED HERE, in the implementation that creates the process, and not
      // by the manager that consumes it. An `'error'` event with no listener is re-thrown by Node as
      // an uncaught exception — so a host whose `SENSEVOICE_PYTHON` is wrong would take the whole
      // server down instead of answering the stable code the DoD asks for. The process that reports
      // this failure is the one that has to still be alive to report it.
      //
      // The sentence is the manager's own, word for word, so that the synchronous and asynchronous
      // paths are one reading rather than two that can drift apart.
      process_.once('error', (error: Error) => {
        resolve(`the SenseVoice worker could not be started (${command} ${args.join(' ')}): ${error.message}`);
      });
    }),
  };
}
