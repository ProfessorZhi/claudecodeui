/**
 * `GET /api/voice/health` with the on-host recogniser selected (AC3 of
 * `gap-voice-sensevoice-server-adapter`).
 *
 * WHAT IS BEING READ. This is the first provider in the seam whose availability is not a property of
 * the user's stored settings. Whether a remote recogniser is ready is answered by reading the
 * document the user saved; whether THIS one is ready is answered by the machine the server runs on,
 * and the health route is where that answer has to reach a caller BEFORE an upload is attempted. Two
 * readings, then, and they are the criterion's own:
 *
 *   1. with `sensevoice-local` selected and the engine built, the payload carries the runtime's own
 *      state and the build id the deployment is pinned to;
 *   2. with the weights absent, the route answers the stable `ENGINE_UNAVAILABLE` envelope — the
 *      status the vocabulary table holds for that code, with the remedy named in the sentence — and
 *      NOT a 200 with a quietly unusable provider, and not a crash.
 *
 * WHAT THE THIRD READING IS FOR (the control). A refusal that fires for every provider is not a
 * reading about this one: the last case selects a REMOTE recogniser while the on-host engine is in
 * its unavailable state and requires the ordinary 200. Without it, an implementation that failed
 * closed for the whole registry would look exactly like one that failed closed for the engine.
 *
 * HOW IT IS DRIVEN. The shipping router, invoked as the middleware function it is, over the shipping
 * service — no socket, no port, no `express()` app — which is the shape `voice-error-contract.test.ts`
 * keeps for the same reason: a bound port on a shared host reports the platform's ephemeral-port
 * lottery on the runs where it goes red.
 *
 * WHAT THE COMPOSITION ROOT DOES NOT DO HERE, said plainly because the boundary is deliberate:
 * `voice.module.ts` is NOT imported. It is the module that reads the `SENSEVOICE_*` variables and
 * builds the engine, and importing it would also open the settings store, resolve the data
 * directories and start the capture sink at module evaluation — side effects a route criterion must
 * not perform on the tree it is measuring. What this file does instead is what that module does with
 * those variables: `readSensevoiceManifest` for the shipped pins, `createSensevoiceWorker` over the
 * real `nodeSensevoiceSpawn`, and `installSensevoiceEngine`. The engine instance is the only
 * substituted thing, and it is substituted exactly as the composition root substitutes it.
 */

import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// REGISTRY FIRST, for the reason recorded in `voice-sensevoice-adapter.test.ts`: this seam's modules
// form one cycle, and a module that enters through an ADAPTER rather than through the registry reads
// the registry's bindings while they are still in their temporal dead zone. The import is also
// load-bearing here — the payload's rows are compared against the registry, and the control case
// takes a remote provider id from it rather than naming one.
import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import {
  installSensevoiceEngine,
  type SensevoiceEnginePort,
  type SensevoiceEngineStatus,
} from '../../../../shared/asr/list/sensevoice-local/sensevoice-local.asr-provider.js';
import { NO_ENGINE_REASON } from '../../../../shared/asr/list/sensevoice-wasm/sensevoice-wasm.asr-provider.js';
import type { VoiceClientAssetsService, VoiceSettings, VoiceSettingsService } from '../../../shared/types.js';
import {
  createSensevoiceWorker,
  nodeSensevoiceSpawn,
  readSensevoiceManifest,
  unavailableSensevoiceEngine,
  type SensevoiceManifest,
  type SensevoiceWorkerOptions,
} from '../sensevoice-worker.js';
import { createVoiceClientAssetsRouter, createVoiceRouter } from '../voice.routes.js';
import {
  createVoiceClientAssetsService,
  createVoiceService,
  PROVIDER_ERROR_STATUS,
  VOICE_CLIENT_MODEL_BYTES,
  VOICE_CLIENT_MODEL_FILE_NAME,
  VOICE_CLIENT_TOKENS_FILE_NAME,
} from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The repository this test belongs to; `server/modules/voice/tests/` is four levels down. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'scripts', 'sensevoice', 'manifest.json');

const manifest: SensevoiceManifest = readSensevoiceManifest(MANIFEST_PATH);

/**
 * The interpreter and worker this criterion names, and why they are deliberately NOT the real ones.
 *
 * THE ROUTE MUST NEVER BOOT THE ENGINE, and a reading of "it answered 200" cannot tell that apart
 * from "it answered 200 after paying for a model load". Pointing the engine at an interpreter that
 * does not exist makes the difference visible: the settings below are one `ensureReady()` away from
 * the `ENGINE_UNAVAILABLE` the last case in this file actually measures, so a health route that
 * started anything would answer the unavailable envelope instead of the runtime state.
 */
const ABSENT_PYTHON = '/nonexistent/sensevoice-python3';
const ABSENT_WORKER = '/nonexistent/scripts/sensevoice/worker.py';

/** The deployment's own configuration, as `voice.module.ts` reads it from the environment. */
const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user whose stored selection is the provider named; every other field is empty. */
function settingsFor(providerId: string): VoiceSettings {
  return {
    baseUrl: '',
    apiKey: '',
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    providerId,
    dashscopeEndpoint: '',
    dashscopeApiKey: '',
    dashscopeModel: '',
  };
}

/** A directory holding the pinned file NAMES — which is the whole of what the cheap check reads. */
function weightsDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-health-weights-'));
  for (const file of manifest.model.files) {
    writeFileSync(path.join(directory, file.name), 'not the real weights; only the name is read here');
  }
  return directory;
}

/** An engine built the way the composition root builds it, over whatever model directory it is given. */
function engineOver(modelDir: string | null): SensevoiceEnginePort {
  const options: SensevoiceWorkerOptions = {
    manifest,
    modelDir,
    python: ABSENT_PYTHON,
    pythonPath: null,
    workerPath: ABSENT_WORKER,
    concurrency: 1,
    timeoutMs: 1_000,
    spawn: nodeSensevoiceSpawn,
    log: { info: () => undefined, warn: () => undefined },
  };
  return createSensevoiceWorker(options);
}

/** The health payload as this criterion reads it, in the fields the route's callers branch on. */
type Runtime = { available?: unknown; state?: unknown; buildId?: unknown; reason?: unknown };
type ProviderRow = { id?: unknown; configured?: unknown; runtime?: Runtime };
type HealthBody = { configured?: unknown; provider?: unknown; providers?: ProviderRow[] };

type Outcome = { status: number; body: HealthBody };

/**
 * The upload parser every route in this file is built with. None of them read an upload — `/health`
 * and `/client-assets` take a GET, and the asset routes stream a file out — but the dependency type
 * requires one, and a test that reached the route through a cast would stop being a reading of the
 * shape the composition root actually builds.
 */
const inertParser = (_request: unknown, _response: unknown, callback: (error?: unknown) => void) => {
  callback(undefined);
};

/**
 * One `GET /health` through the shipping router.
 */
function callHealth(settings: VoiceSettings): Promise<Outcome> {
  const service = createVoiceService({
    defaults: { ...DEFAULTS },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const settingsService: VoiceSettingsService = {
    getSettings: () => settings,
    saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
    maskForReadback: (document) => document,
  };

  const router = createVoiceRouter({
    voiceService: service,
    voiceSettingsService: settingsService,
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: inertParser,
    parseRawAudioUpload: inertParser,
  });

  return new Promise<Outcome>((resolve, reject) => {
    // Express's default is 200: a handler that calls `json` without naming a status answers it, so the
    // harness starts there rather than at 0 — otherwise every un-named success would read as a refusal.
    let status = 200;
    const request = {
      method: 'GET',
      url: '/health',
      headers: {},
      user: { id: 1 },
    };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: HealthBody) {
        resolve({ status, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status, body: {} });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** The row the payload carries for one provider id. */
function rowFor(body: HealthBody, id: string): ProviderRow {
  const row = (body.providers ?? []).find((provider) => provider.id === id);
  assert.ok(row, `the payload carries no row for '${id}': ${JSON.stringify(body.providers?.map((p) => p.id) ?? [])}`);
  return row;
}

// ── the request-carried override, on the upload route ─────────────────────────────────────────
//
// The health route above reads WHICH recogniser a deployment has. This section reads which one an
// UPLOAD is addressed to, which is the other half of the same seam: the client's device path gives up
// on a clip and re-uploads it naming a recogniser the SERVER can run (S0 of
// `gap-voice-client-asr-fallback-and-first-load`). Two of those namings are refused before a request is
// built — an unregistered id, and this task's addition, one that declares `locality: 'local-client'`
// and therefore only ever ran in the browser that is uploading.

/** One `POST /transcribe` through the shipping router, with a parser that fakes multer's one field. */
function callTranscribe(options: {
  settings: VoiceSettings;
  headers?: Record<string, string>;
  /** The engine installed for the attempt, or `null` for the engine-less state a server really has. */
  engine?: SensevoiceEnginePort | null;
  /** Called for each recognition the engine is asked for, so a refusal can be shown to ask for none. */
  onTranscribe?: () => void;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (options.engine !== undefined) installSensevoiceEngine(options.engine);

  const service = createVoiceService({
    defaults: { ...DEFAULTS },
    timeoutMs: 1_000,
    // The bridge is not the subject of any reading here: a refusal is owed BEFORE a request exists,
    // and the one case that reaches an adapter reaches the on-host engine, which calls nothing.
    fetchBackend: async () => {
      throw new Error('no recognition in this section reaches a remote backend');
    },
    logger: { info: () => undefined },
  });

  const parser = (request: unknown, _response: unknown, callback: (error?: unknown) => void) => {
    // What multer does with a real multipart body, in one line: the frames themselves are not what
    // these cases read — the ADDRESS is — and a four-byte RIFF header is a container the gates accept.
    (request as { file?: unknown }).file = {
      buffer: Buffer.from([0x52, 0x49, 0x46, 0x46]),
      mimetype: 'audio/wav',
      originalname: 'fallback.wav',
    };
    callback(undefined);
  };

  const router = createVoiceRouter({
    voiceService: service,
    voiceSettingsService: {
      getSettings: () => options.settings,
      saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
      maskForReadback: (document) => document,
    },
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: parser as never,
    parseRawAudioUpload: parser as never,
  });

  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    let status = 200;
    const request = {
      method: 'POST',
      url: '/transcribe',
      headers: options.headers ?? {},
      user: { id: 1 },
    };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        resolve({ status, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status, body: {} });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/**
 * An engine that answers a recognition with text, built like every other fake in the seam: the port is
 * a type, so a reading of "the override was USED" needs no model on disk.
 */
function answeringEngine(onTranscribe?: () => void): SensevoiceEnginePort {
  const ready: SensevoiceEngineStatus = { available: true, state: 'ready', buildId: manifest.buildId };
  return {
    status: () => ready,
    ensureReady: async () => ready,
    transcribe: async (request) => {
      onTranscribe?.();
      return {
        ok: true,
        text: `recognised ${request.fileName} on the on-host engine`,
        tokens: [],
        buildId: manifest.buildId,
      };
    },
  };
}

// ── the readings ─────────────────────────────────────────────────────────────────────────────

test('AC3 an available engine is reported with its runtime state and the pinned build id', async () => {
  const directory = weightsDirectory();
  try {
    installSensevoiceEngine(engineOver(directory));
    const outcome = await callHealth(settingsFor('sensevoice-local'));

    assert.equal(outcome.status, 200, `the health reading refused an available engine: ${JSON.stringify(outcome.body)}`);
    assert.equal(outcome.body.provider, 'sensevoice-local', 'the reading is about the provider the user selected');

    const row = rowFor(outcome.body, 'sensevoice-local');
    const runtime = row.runtime;
    assert.ok(runtime, 'the row for an on-host recogniser must carry a runtime reading');
    assert.equal(runtime.available, true);
    // `stopped` IS THE READING, not a placeholder: it says the deployment is configured and loadable
    // and that no process is up — which, with an interpreter that does not exist, is only reachable if
    // the route asked the engine's configuration rather than starting it.
    assert.equal(runtime.state, 'stopped', `expected a configuration reading, got state ${String(runtime.state)}`);
    assert.equal(runtime.buildId, manifest.buildId, 'the reported build must be the one the manifest pins');

    // The runtime reading belongs to the provider that declares one, and to no other row: the remote
    // rows say so by ABSENCE rather than by a null-valued key, which is the shape the client branches on.
    const remote = listProviders().filter((adapter) => adapter.runtime === undefined).map((adapter) => adapter.id);
    assert.ok(remote.length > 0, 'the registry has no provider without a runtime, so this control reads nothing');
    for (const id of remote) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(rowFor(outcome.body, id), 'runtime'),
        false,
        `'${id}' declares no runtime, so its row must not carry the key at all`,
      );
    }

    // And the rows are the registry's own, in its own order — the payload republishes the table.
    assert.deepEqual(
      outcome.body.providers?.map((provider) => provider.id),
      listProviders().map((adapter) => adapter.id),
    );
  } finally {
    installSensevoiceEngine(null);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('AC3 a model directory without the weights answers ENGINE_UNAVAILABLE, naming the file', async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'sensevoice-health-empty-'));
  try {
    // The vocabulary's own row for the code, read rather than restated: a criterion holding its own
    // `503` would go on passing after the table moved, which is exactly the drift this reading is for.
    const owedStatus = PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE'];
    assert.ok(owedStatus !== undefined, 'the vocabulary no longer holds ENGINE_UNAVAILABLE');

    installSensevoiceEngine(engineOver(empty));
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, owedStatus);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.match(
      String((outcome.body as { error?: unknown }).error ?? ''),
      /does not hold 'model\.int8\.onnx'/,
      'the refusal has to name the artifact the operator is missing',
    );
  } finally {
    installSensevoiceEngine(null);
    rmSync(empty, { recursive: true, force: true });
  }
});

test('AC3 no configured model directory at all answers the same code, naming the variable', async () => {
  // The ordinary case for a deployment that does not use this recogniser: `SENSEVOICE_MODEL_DIR` unset
  // is a state, not a fault, and the sentence has to say which variable to set.
  installSensevoiceEngine(engineOver(null));
  try {
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE']);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.match(String((outcome.body as { error?: unknown }).error ?? ''), /SENSEVOICE_MODEL_DIR/);
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 an engine that could not even be described is reported with its own sentence', async () => {
  // The third unavailable shape, and the one the composition root installs when the manifest cannot be
  // read: an engine whose identity is unknown may not report a build, so it is installed in its
  // unavailable form carrying the failure verbatim. Nothing about the route changes for it.
  const reason = 'the SenseVoice manifest at /tmp/none.json could not be read: Unexpected token';
  installSensevoiceEngine(unavailableSensevoiceEngine(reason));
  try {
    const outcome = await callHealth(settingsFor('sensevoice-local'));
    assert.equal(outcome.status, PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE']);
    assert.equal((outcome.body as { code?: unknown }).code, 'ENGINE_UNAVAILABLE');
    assert.equal((outcome.body as { error?: unknown }).error, reason, 'the reason travels verbatim');
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 control: a remote provider still reads as healthy while the on-host engine is unavailable', async () => {
  // The refusal above is about the provider the user SELECTED. A registry-wide failure would answer the
  // same 503 here — which is why this case exists: without it, the criterion above would be satisfied
  // by an implementation that failed closed for everything.
  const remote = listProviders().find((adapter) => adapter.capabilities.locality === 'remote');
  assert.ok(remote, 'the registry has no remote provider, so this control reads nothing');

  installSensevoiceEngine(engineOver(null));
  try {
    const outcome = await callHealth(settingsFor(remote.id));
    assert.equal(outcome.status, 200, `a remote provider must be unaffected: ${JSON.stringify(outcome.body)}`);
    assert.equal(outcome.body.provider, remote.id);
    assert.equal(Object.prototype.hasOwnProperty.call(rowFor(outcome.body, remote.id), 'runtime'), false);
  } finally {
    installSensevoiceEngine(null);
  }
});

test('AC3 control: the interpreter this deployment names really is absent, so `stopped` was not a running engine', async () => {
  // The positive control for the first case's `stopped`. That reading says "configured and loadable,
  // no process up"; it would be worthless if the engine could not have come up at all for some OTHER
  // reason. So the same engine is asked to come up, and it must refuse BY NAME OF THE INTERPRETER —
  // which makes "the health route did not start it" a measurement rather than an inference.
  const directory = weightsDirectory();
  try {
    const engine = engineOver(directory);
    const status = await engine.ensureReady();

    // THE WHOLE ASSERTION OF THIS CASE IS THAT IT REACHED THIS LINE. Node reports a spawn failure on
    // the child's `'error'` event, and an `'error'` with no listener is re-thrown as an uncaught
    // exception — so a seam that ignored it would have taken this test process down rather than
    // returned a status, and there would be no assertion to fail. Reaching `assert.equal` at all is
    // the reading; it is also the one the DoD asks for by name ("缺模型 / 缺 Python 时的失败是可行动
    // 的稳定错误码，不是崩溃").
    assert.equal(status.available, false, 'a missing interpreter is a state, not a rejection');
    // The remedy travels as far as the sentence, so an operator reading the health payload knows which
    // command to repair: the interpreter is named, and the reason says what could not be done with it.
    assert.match(status.available === false ? status.reason : '', /could not be started/);
    assert.match(status.available === false ? status.reason : '', /nonexistent\/sensevoice-python3/);

    // And it is the SAME stable code on the work path, not a second failure shape. An upload attempted
    // against this engine is refused in the seam's vocabulary rather than throwing out of `transcribe`.
    const answer = await engine.transcribe({
      bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
      mimeType: 'audio/wav',
      fileName: 'control.wav',
      timeoutMs: 1_000,
    });
    assert.equal(answer.ok, false, 'a request against an engine that never started cannot succeed');
    assert.equal(answer.ok === false ? answer.code : '', 'ENGINE_UNAVAILABLE');
    assert.match(answer.ok === false ? answer.message : '', /could not be started/);

    // Sticky, like every other provisioning failure: the second question does not re-attempt the spawn.
    // Without this, a caller polling health would fork a fresh doomed process on every poll.
    const again = await engine.ensureReady();
    assert.equal(again.available, false);
    assert.equal(again.available === false ? again.reason : '', status.available === false ? status.reason : '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ── the browser recogniser's same-origin assets ─────────────────────────────────────────────────
//
// S0 of `gap-voice-client-asr-same-origin-delivery`. Two routes are read here. `GET
// /api/voice/client-assets` reports what the SERVER can see on its own disk, so the browser can
// refuse before it downloads a 239 MB model it will not be able to use; `GET /voice-client/{model,ort}/:file`
// serves the artifact itself. Both are read through the shipping factories, for the reason the rest of
// this file already gives: a bound port on a shared host reports the platform's ephemeral-port lottery
// on the runs where it goes red.

/** The runtime files this repository actually ships, resolved the way the composition root resolves them. */
const ORT_DIST = path.join(REPO_ROOT, 'node_modules', 'onnxruntime-web', 'dist');

/** The readiness payload as these cases read it, in the fields the browser branches on. */
type AssetReading = {
  configured?: unknown;
  directory?: unknown;
  source?: unknown;
  ready?: unknown;
  model?: { present?: unknown; bytes?: unknown; expectedBytes?: unknown };
  tokens?: { present?: unknown; bytes?: unknown };
};

/** A file of exactly `bytes` length, created SPARSE — the 239 MB model is a size reading, never written out. */
function writeSizedFile(filePath: string, bytes: number): void {
  const descriptor = openSync(filePath, 'w');
  try {
    ftruncateSync(descriptor, bytes);
  } finally {
    closeSync(descriptor);
  }
}

/** A model directory holding a `model.int8.onnx` of a chosen size and, unless suppressed, a `tokens.txt`. */
function modelDirectory(options: { modelBytes?: number | null; tokens?: boolean } = {}): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'voice-client-assets-'));
  const modelBytes = options.modelBytes === undefined ? VOICE_CLIENT_MODEL_BYTES : options.modelBytes;
  if (modelBytes !== null) {
    writeSizedFile(path.join(directory, VOICE_CLIENT_MODEL_FILE_NAME), modelBytes);
  }
  if (options.tokens !== false) {
    writeFileSync(path.join(directory, VOICE_CLIENT_TOKENS_FILE_NAME), 'the 0\n');
  }
  return directory;
}

/** One `GET /client-assets` through the shipping router, over the shipping assets service. */
function callClientAssets(options: {
  voiceClientModelDir?: string;
  sensevoiceModelDir?: string;
  ortDistDir?: string;
}): Promise<{ status: number; body: AssetReading }> {
  const voiceClientAssets = createVoiceClientAssetsService({
    ...options,
    ortDistDir: options.ortDistDir ?? ORT_DIST,
  });

  const router = createVoiceRouter({
    voiceService: createVoiceService({
      defaults: { ...DEFAULTS },
      timeoutMs: 1_000,
      fetchBackend: async () => {
        throw new Error('the client-asset reading must not call anything');
      },
    }),
    voiceSettingsService: {
      getSettings: () => settingsFor(''),
      saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
      maskForReadback: (document) => document,
    },
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: inertParser,
    parseRawAudioUpload: inertParser,
    voiceClientAssets,
  });

  return new Promise<{ status: number; body: AssetReading }>((resolve, reject) => {
    let status = 200;
    const request = { method: 'GET', url: '/client-assets', headers: {}, user: { id: 1 } };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: AssetReading) {
        resolve({ status, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status, body: {} });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

type AssetOutcome = { status: number; headers: Record<string, string>; body: Buffer };

/**
 * One `GET` through the asset router.
 *
 * The response is a real `Writable`, so the bytes that `pipe` into it are the bytes this reading
 * compares — `res.sendFile` would have hidden them behind the framework's own file layer, and the
 * Range handling is the layer being read.
 */
function callAsset(
  voiceClientAssets: VoiceClientAssetsService,
  url: string,
  headers: Record<string, string> = {},
): Promise<AssetOutcome> {
  const router = createVoiceClientAssetsRouter({ voiceClientAssets });
  return new Promise<AssetOutcome>((resolve, reject) => {
    let status = 200;
    const outHeaders: Record<string, string> = {};
    const chunks: Buffer[] = [];
    const response = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }) as Writable & {
      status(code: number): unknown;
      setHeader(name: string, value: string): unknown;
      json(payload: unknown): unknown;
    };
    response.status = (code: number) => {
      status = code;
      return response;
    };
    response.setHeader = (name: string, value: string) => {
      outHeaders[name.toLowerCase()] = value;
      return response;
    };
    response.json = (payload: unknown) => {
      resolve({ status, headers: outHeaders, body: Buffer.from(JSON.stringify(payload)) });
      return response;
    };
    response.on('finish', () => resolve({ status, headers: outHeaders, body: Buffer.concat(chunks) }));
    router(
      { method: 'GET', url, headers } as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

test('S0 with no model directory configured the reading is not-ready and names no directory', async () => {
  const outcome = await callClientAssets({});
  assert.equal(outcome.status, 200, 'an unconfigured deployment is a state, not a route failure');
  assert.equal(outcome.body.configured, false);
  assert.equal(outcome.body.directory, null);
  assert.equal(outcome.body.source, null);
  assert.equal(outcome.body.ready, false);
  assert.equal(outcome.body.model?.present, false);
  assert.equal(outcome.body.model?.expectedBytes, VOICE_CLIENT_MODEL_BYTES, 'the expected size travels even when nothing is there');
  assert.equal(outcome.body.tokens?.present, false);
});

test('S0 SENSEVOICE_MODEL_DIR is the fallback, and a complete directory reads ready', async () => {
  const directory = modelDirectory();
  try {
    const outcome = await callClientAssets({ sensevoiceModelDir: directory });
    assert.equal(outcome.body.configured, true);
    assert.equal(outcome.body.source, 'SENSEVOICE_MODEL_DIR', 'the on-host recogniser\'s directory is the fallback');
    assert.equal(outcome.body.directory, directory);
    assert.equal(outcome.body.model?.present, true);
    assert.equal(outcome.body.model?.bytes, VOICE_CLIENT_MODEL_BYTES);
    assert.equal(outcome.body.tokens?.present, true);
    assert.equal(outcome.body.ready, true, 'an exact model size plus tokens is the ready state');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('S0 a directory missing either artifact is not ready, and the reading says which one', async () => {
  const withoutModel = modelDirectory({ modelBytes: null });
  const withoutTokens = modelDirectory({ tokens: false });
  try {
    const modelAbsent = await callClientAssets({ voiceClientModelDir: withoutModel });
    assert.equal(modelAbsent.body.configured, true, 'a configured-but-incomplete directory is still configured');
    assert.equal(modelAbsent.body.model?.present, false);
    assert.equal(modelAbsent.body.tokens?.present, true);
    assert.equal(modelAbsent.body.ready, false);

    const tokensAbsent = await callClientAssets({ voiceClientModelDir: withoutTokens });
    assert.equal(tokensAbsent.body.model?.present, true);
    assert.equal(tokensAbsent.body.tokens?.present, false);
    assert.equal(tokensAbsent.body.ready, false);
  } finally {
    rmSync(withoutModel, { recursive: true, force: true });
    rmSync(withoutTokens, { recursive: true, force: true });
  }
});

test('S0 a size-mismatched model is not ready, and the reading says how short it fell', async () => {
  const directory = modelDirectory({ modelBytes: 1_024 });
  try {
    const outcome = await callClientAssets({ voiceClientModelDir: directory });
    assert.equal(outcome.body.model?.present, true);
    assert.equal(outcome.body.model?.bytes, 1_024);
    assert.equal(outcome.body.model?.expectedBytes, VOICE_CLIENT_MODEL_BYTES);
    assert.equal(outcome.body.ready, false, 'a truncated download is not a ready model');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('S0 the asset route serves the whitelisted name and refuses a traversal that reaches it', async () => {
  const directory = modelDirectory({ modelBytes: 16 });
  // A file that exists in the directory but is not on the whitelist: if the route served by existence
  // rather than by name, this is what would leak.
  writeFileSync(path.join(directory, 'notes.txt'), 'not an artifact');
  try {
    const assets = createVoiceClientAssetsService({ voiceClientModelDir: directory, ortDistDir: ORT_DIST });

    // The positive control: the whitelisted name really is served, so the refusals below are about the
    // NAME rather than a route that answers 404 for everything.
    const served = await callAsset(assets, `/model/${VOICE_CLIENT_MODEL_FILE_NAME}`);
    assert.equal(served.status, 200, 'the whitelisted model name is served');
    assert.equal(served.body.length, 16);

    for (const attempted of ['..%2f..%2fpackage.json', '%2e%2e%2f%2e%2e%2fpackage.json', 'notes.txt']) {
      const refused = await callAsset(assets, `/model/${attempted}`);
      assert.equal(refused.status, 404, `'${attempted}' must not resolve: it is not a whitelisted artifact`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('S0 a Range request answers 206 with that exact slice, and the wasm carries the runtime content type', async () => {
  const assets = createVoiceClientAssetsService({ ortDistDir: ORT_DIST });
  const wasmName = 'ort-wasm-simd-threaded.wasm';
  const size = statSync(path.join(ORT_DIST, wasmName)).size;

  const whole = await callAsset(assets, `/ort/${wasmName}`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-type'], 'application/wasm');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['content-length'], String(size));
  assert.equal(whole.body.length, size);

  const ranged = await callAsset(assets, `/ort/${wasmName}`, { range: 'bytes=0-3' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], `bytes 0-3/${size}`);
  assert.equal(ranged.headers['content-length'], '4');
  // The first four bytes of the shipped file, read back: a WebAssembly module's magic number. This is
  // the assertion that the slice is the RANGE's, not the whole file with a header claiming otherwise.
  assert.deepEqual([...ranged.body], [0x00, 0x61, 0x73, 0x6d]);

  const suffix = await callAsset(assets, `/ort/${wasmName}`, { range: 'bytes=-2' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${size - 2}-${size - 1}/${size}`);
  assert.equal(suffix.body.length, 2);

  const refused = await callAsset(assets, '/ort/package.json');
  assert.equal(refused.status, 404, 'only the three shipped runtime files are on the whitelist');
});

// ── the readings the override section above exists for ────────────────────────────────────────

test('S0 an override naming a registered server-side recogniser is used, and its text comes back', async () => {
  let recognised = 0;
  try {
    const outcome = await callTranscribe({
      // The user's OWN selection is the browser recogniser — which is the state the client is in when
      // it falls back — and the override names the recogniser the server can run.
      settings: settingsFor('sensevoice-wasm'),
      headers: { 'x-voice-provider': 'sensevoice-local' },
      engine: answeringEngine(() => {
        recognised += 1;
      }),
    });

    assert.equal(outcome.status, 200, `the override must be honoured: ${JSON.stringify(outcome.body)}`);
    assert.equal(
      outcome.body.text,
      'recognised fallback.wav on the on-host engine',
      'the text is the recogniser the override named',
    );
    assert.equal(recognised, 1, 'exactly one recognition, on the provider the request named');
  } finally {
    installSensevoiceEngine(null);
  }
});

test('S0 an override naming a client-side recogniser is refused before any recognition', async () => {
  const clientSide = listProviders().find((adapter) => adapter.capabilities.locality === 'local-client');
  assert.ok(clientSide, 'the registry has no client-side recogniser, so this reading measures nothing');

  let recognised = 0;
  try {
    const outcome = await callTranscribe({
      settings: settingsFor('sensevoice-local'),
      headers: { 'x-voice-provider': clientSide.id },
      engine: answeringEngine(() => {
        recognised += 1;
      }),
    });

    // `400`: the id came in with the request, so it is the caller's to change — the client's own
    // fallback answers it by naming a different recogniser one line later.
    assert.equal(outcome.status, 400, `a browser-only recogniser cannot serve an upload: ${JSON.stringify(outcome.body)}`);
    assert.match(
      String(outcome.body.error ?? ''),
      new RegExp(clientSide.id),
      'the refusal has to name the id that cannot serve the request',
    );
    assert.match(
      String(outcome.body.error ?? ''),
      /browser/,
      'and it has to say WHY — the engine is in the caller, not missing from this host',
    );
    assert.equal(recognised, 0, 'a refused address must not reach any engine');
  } finally {
    installSensevoiceEngine(null);
  }
});

test('S0 an override naming an id nothing registers is refused', async () => {
  try {
    const outcome = await callTranscribe({
      settings: settingsFor('sensevoice-local'),
      headers: { 'x-voice-provider': 'no-such-recogniser' },
      engine: answeringEngine(),
    });

    assert.equal(outcome.status, 400);
    assert.match(String(outcome.body.error ?? ''), /no-such-recogniser/);
    assert.match(String(outcome.body.error ?? ''), /no ASR adapter is registered/);
  } finally {
    installSensevoiceEngine(null);
  }
});

test('S0 control: with no override the stored selection behaves exactly as it did', async () => {
  // THE NARROWNESS OF THE REFUSAL, which is the whole reason it is scoped to the request. A user who
  // simply has the browser recogniser selected and uploads without naming one gets what this route has
  // always answered — the adapter's own failure, `ENGINE_UNAVAILABLE` — and not the new 400. Reading
  // this as a defect would be to change what a stored selection means, which this task does not.
  installSensevoiceEngine(null);
  const outcome = await callTranscribe({ settings: settingsFor('sensevoice-wasm') });

  assert.equal(outcome.status, PROVIDER_ERROR_STATUS['ENGINE_UNAVAILABLE']);
  assert.equal(outcome.body.code, 'ENGINE_UNAVAILABLE');
  assert.equal(
    outcome.body.error,
    NO_ENGINE_REASON,
    'the sentence is still the adapter\'s own — not the override refusal\'s',
  );
});
