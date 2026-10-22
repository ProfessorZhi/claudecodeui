/**
 * AC-147's criterion: a recording that cannot record must not change the transcription, and must say
 * so in exactly one line that carries nothing.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-off.test.ts` reads the mode resolution and the
 * gate; `voice-capture-text.test.ts` reads the `text` payload's marks; `voice-capture-audio.test.ts`
 * reads the bytes, the permissions and the accumulation. All three read a recorder that WORKS. This
 * is the fourth face of the same seam and the one the other three cannot reach: a recorder that
 * FAILS — a log port that refuses to print the row, and an audio directory the filesystem refuses to
 * create — and what the caller of `transcribe` receives when it does.
 *
 * THE SUBJECT IS THE CALLER'S RESULT, AND IT IS COMPARED RATHER THAN DESCRIBED. "The transcription
 * still succeeded" is satisfied by an implementation that re-ran the attempt, or that returned a
 * refusal whose text happens to match. So every isolation reading below is a comparison against a
 * BASELINE SERVICE CONSTRUCTED IN THE SAME RUN WITH NO CAPTURE PORT AT ALL, on the same input: same
 * `ok`, same `status`, same `error`, and `value.text` compared byte for byte. The baseline is not a
 * literal written down here — it is the same shipping module, driven the same way, with the seam
 * absent, which is exactly the deployment this task must leave unchanged.
 *
 * WHY THE THROW IS A REAL THROW AND NOT A STUBBED ONE. The two roads that can fail are both REAL
 * seams a deployment wires: the LOG PORT (`dependencies.logger`) and the AUDIO SINK
 * (`dependencies.capture`'s write half). This file injects a port that refuses the row line, and for
 * the audio road it wraps the SHIPPED write implementation (`createVoiceCaptureAudioSink`) around a
 * directory whose parent is a regular file — so the `ENOTDIR` the filesystem raises is the shipped
 * `mkdirSync`'s own, not an error this file invented. A value-injection stand-in that threw on
 * demand would make every isolation reading a reading about the stand-in.
 *
 * WHAT MAKES THE `identical` READINGS MEAN SOMETHING IS THAT THE PORT REALLY THREW. A port that never
 * refuses anything produces the same `resultIdentical=true` as a correct implementation, so each arm
 * carries a positive counter (`text.captureThrew`, `hardPort.threw`, `audio.writeRefused`) and the
 * readings below require it. This is the repository's own rule about zero-readings: a "nothing
 * happened" figure is worth nothing without a companion that says the thing it would have noticed.
 *
 * THE CLOCK IS FROZEN FOR THE MEASUREMENT. AC3 compares the `voice.transcribe` line byte for byte
 * across two arms, and that line carries `latencyMs=${Date.now() - startedAt}` — a wall-clock figure
 * the capture seam has nothing to do with and which would differ between two arms for reasons that
 * are not this task's subject. `Date.now` is therefore pinned to one constant for the duration of the
 * measurement and restored in a `finally`, so both arms read `latencyMs=0` and the byte comparison is
 * about the fields the seam COULD have touched. Registered in AC10 rather than left to a reader to
 * infer from a `latencyMs=0` in the output.
 *
 * HOW IT IS DRIVEN. Six arms, one shipping service, one shipping capture module, one stand-in
 * transport, differing only in the environment and the port a deployment would wire:
 *
 *   · `baseline` — a successful transcription with NO capture port. The reference for AC2/AC3/AC5/AC7.
 *   · `textThrow` — `VOICE_CAPTURE=text` and a log port that refuses the capture ROW. AC2, AC3, AC4.
 *   · `audioBlocked` — `VOICE_CAPTURE=audio` and `VOICE_CAPTURE_DIR` under a REGULAR FILE, through the
 *     shipped writer behind a counting wrapper. AC5.
 *   · `failBaseline` — the upstream answers 404, no capture port. The reference for AC6.
 *   · `failThrow` — the same 404 with the refusing log port. AC6.
 *   · `hardPort` — `text` with a port that refuses every `voice.capture`-prefixed line AS WELL. AC7.
 *
 * WHAT THIS FILE DOES NOT COVER (registered in the `AC10 registration` reading rather than left for a
 * reader to notice): the gate and the mode resolution (AC-143), the `text` payload's marks (AC-144),
 * the write itself and its permissions (AC-145), the three-mode redaction criterion (AC-146) and any
 * real-process reading (AC-148). Nothing here reaches a real upstream, starts a process or opens a
 * socket; the only files written live in this run's own temp tree.
 *
 * FALSIFYING FORMS LIVE IN `voice-capture-isolation.false-forms.test.ts`, and the readings are
 * collected by one exported function so that file can run THIS list against a mutated copy of
 * `voice.service.ts`. See the header there for the two mutations and the one AC clause this file
 * reads structurally rather than literally.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  VoiceAudioUpload,
  VoiceLogPort,
  VoiceRequestOverrides,
  VoiceService,
  VoiceServiceResult,
  VoiceSettings,
} from '@/shared/types.js';
import type {
  VoiceCaptureAudioSink,
  VoiceCapturePort,
  VoiceCaptureResolution,
} from '../voice-capture.js';
import type { createVoiceService } from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — three levels above this file (`server/modules/voice/tests/`). */
const SERVER_DIR = path.resolve(HERE, '../../..');

/** The shipping service module: what this criterion drives, and the file a mutation case copies. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping capture module: the mode resolver, the port constructor and the write-audio factory. */
export const SHIPPING_CAPTURE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice-capture.ts');

/**
 * The registry, imported BEFORE the adapter below.
 *
 * The adapter's own module body reads declarations the registry publishes, so importing the adapter
 * into an uninitialised registry is a TDZ error rather than an empty list; the registry's own graph
 * evaluates the adapter, so after this import the adapter module is complete. Both are imported only
 * for the id a request has to name, which is read rather than spelled so a rename cannot leave this
 * criterion driving a provider nothing claims.
 */
const REGISTRY_MODULE = path.resolve(SERVER_DIR, '../shared/asr/asrRegistry.ts');
/** The `dashscope-omni` adapter: the id this criterion's requests select. */
const ADAPTER_MODULE = path.resolve(
  SERVER_DIR,
  '../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
);

/** This file, read as text by the door scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 7;

/** The instant `Date.now` answers with for the whole measurement. See the header, and AC10. */
const FROZEN_NOW = 1_700_000_000_000;

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

/** The deployment shape every arm is driven with: the same defaults the other voice criteria use. */
const DEFAULTS = {
  baseUrl: 'https://voice.example/v1',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
  apiKey: 'server-key',
};

/** A workspace address the adapter's own endpoint rule accepts: https, no port, `maas` hostname. */
const ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

/** Run-unique, so a reading about "these bytes" is a reading about THIS run's bytes. */
const RUN_TAG = `${process.pid}-${Date.now()}`;

/** The transcription the stand-in upstream returns: AC4's first needle, in the text the caller gets. */
const TRANSCRIPT_SENTINEL = `transcript-${RUN_TAG}`;

/** The head of the upload as text: the raw-bytes needle AC4 searches the failed line for. */
const AUDIO_SENTINEL = `audio-${RUN_TAG}`;

/**
 * The upload's bytes, comfortably past AC4's 192-byte floor.
 *
 * ASCII on purpose, so a substring of these bytes is a substring a `String.includes` can look for:
 * "the raw byte substring of the upload is in the failed line" has to be a search this file can
 * actually run rather than a claim about an encoding.
 */
const AUDIO_BYTES = Buffer.from(`${AUDIO_SENTINEL}:${'a'.repeat(200)}`, 'utf8');

/** The two other representations of the same upload AC4 searches for. */
const AUDIO_BASE64 = AUDIO_BYTES.toString('base64');
const AUDIO_BYTES_HEAD = AUDIO_BYTES.subarray(0, 24).toString('utf8');

/** The credential a deployment holds: AC4's third needle, and the bearer the wire must carry. */
const KEY_SENTINEL = `key-${RUN_TAG}`;

/** The upload as the SERVICE takes it. */
const AUDIO_UPLOAD: VoiceAudioUpload = {
  bytes: AUDIO_BYTES,
  mimeType: 'audio/webm',
  fileName: 'clip.webm',
};

/** The transcript-only envelope: the adapter returns `transcript` as the text, with no instruction. */
const SUCCESS_BODY = JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ transcript: TRANSCRIPT_SENTINEL }) } }],
});

/** The upstream failure AC6 drives: a 404 with a body this criterion authored. */
const NOT_FOUND_STATUS = 404;
const NOT_FOUND_BODY = JSON.stringify({ error: { message: 'no such model', type: 'invalid_request' } });

/** The one line a failed recording is allowed to leave. Compared verbatim, never by prefix alone. */
const FAILED_LINE = 'voice.capture failed';

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;

/**
 * The module specifiers this file must not import, assembled rather than spelled.
 *
 * A scan for a literal would match the scan's own text — the token would appear in this file whether
 * or not this file imported the module — so each candidate is built from parts and never appears
 * contiguously anywhere in the source. AC1 requires this criterion to start no subprocess, open no
 * socket and listen on no port, and an import is the only way it could.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  specifier(['node:', 'child', '_process']),
  specifier(['node:', 'net']),
  specifier(['node:', 'http']),
  specifier(['node:', 'https']),
  specifier(['node:', 'dgram']),
  specifier(['node:', 'cluster']),
  specifier(['expr', 'ess']),
  specifier(['mult', 'er']),
];

/** The doors THIS file has open, computed from its own text. */
function openDoors(): string[] {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return FORBIDDEN_SPECIFIERS.filter((candidate) => source.includes(candidate));
}

/** The line as a capture ROW, or `null` — parsed, so an attempt line cannot be mistaken for one. */
function parseCaptureRow(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return record.event === 'voice.capture' ? record : null;
}

/** The ` captureId=<…>` marker the gate appends in a recording mode, once, at the end of the line. */
const CAPTURE_ID_MARK = /\s*captureId=\S+$/;

/** The attempt line with its capture id removed, so two arms can be compared field for field. */
function withoutCaptureId(line: string): string {
  return line.replace(CAPTURE_ID_MARK, '');
}

/** Whether two buffers hold the same bytes. `Buffer.equals`, not a string compare. */
function sameBytes(left: string, right: string): boolean {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) === 0;
}

// ── the contract between this file and a mutated copy ─────────────────────────────────────────

/** One reading's outcome, as the falsifying file reads them. */
export type ReadingOutcome = { name: string; value: string; ok: boolean };

// ── the shipped shapes, named as this file needs them ─────────────────────────────────────────

/** The capture module's surface, as this criterion reads it. */
type CaptureModule = {
  resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution;
  createVoiceCapture(dependencies: {
    mode: VoiceCaptureResolution['mode'];
    log: VoiceLogPort;
    audio?: VoiceCaptureAudioSink;
  }): VoiceCapturePort;
  resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string;
  createVoiceCaptureAudioSink(options: { directory: string }): VoiceCaptureAudioSink;
};

/** The service module's surface, as this criterion reads it. */
type ServiceModule = { createVoiceService: typeof createVoiceService };

/** One answer the stand-in transport gives. */
type Answer = { status: number; body: string };

/**
 * What the CALLER of `transcribe` received, flattened to the three fields AC2/AC5/AC6/AC7 compare.
 *
 * `threw` is the fourth case and it is not a convenience: removing the local guard makes `transcribe`
 * REJECT rather than answer, so a rig that only modelled `VoiceServiceResult` would crash instead of
 * reporting the reading. A rejection is folded here into a result-shaped value so the comparison
 * reads it as the difference it is (`threw: …` against a baseline that answered).
 */
type ResultView = {
  ok: boolean;
  status: number;
  text: string;
  error: string;
  threw: string | null;
};

/** Flattens one service answer, or one rejection, into the shape the readings compare. */
function viewOf(result: VoiceServiceResult<{ text: string }>): ResultView {
  return result.ok
    ? { ok: true, status: 200, text: result.value.text, error: '', threw: null }
    : { ok: false, status: result.status, text: '', error: result.error, threw: null };
}

/** Whether two arms' answers agree on `ok`, `status` and `error` — AC2's `resultIdentical`. */
function sameResult(left: ResultView, right: ResultView): boolean {
  return (
    left.ok === right.ok &&
    left.status === right.status &&
    left.threw === right.threw &&
    sameBytes(left.error, right.error)
  );
}

/** Whether two arms' returned text is byte-identical — AC2's `textByteIdentical`. */
function sameText(left: ResultView, right: ResultView): boolean {
  return sameBytes(left.text, right.text);
}

/** The audio road's counters, so "the writer refused" is a figure rather than a promise. */
type WriteCounters = {
  /** How many times the write port was reached. */
  attempts: number;
  /** Whether the SHIPPED writer threw for a path this deployment could not create. */
  refused: boolean;
  /** Whether the bytes the port was handed are the upload's own, byte for byte. */
  bytesInHand: boolean;
};

/** One arm: the environment it ran in, the lines it wrote, and what its caller received. */
type Arm = {
  name: string;
  /** The RAW `VOICE_CAPTURE` value the shipping resolver was handed — read off the environment. */
  modeInput: string | undefined;
  /** The mode the shipping resolver answered with. */
  mode: string;
  /** Every line the log port received, in order. */
  lines: string[];
  /** The `voice.transcribe` lines, in order. */
  transcribeLines: string[];
  /** The lines whose trimmed text starts with `voice.capture` — the failure line's own family. */
  failedLines: string[];
  /** The lines that parse to a capture row. */
  rowLines: string[];
  /** How many lines the injected port refused, and which ones. */
  portThrew: number;
  refusedLines: string[];
  /** Whether every refusal was of a capture ROW (`text.thrownOnCaptureLine`). */
  threwOnlyOnRows: boolean;
  result: ResultView;
  write: WriteCounters;
  /** The directory this arm's deployment resolved to, or `null` when none was configured. */
  captureDir: string | null;
  /** Whether that directory exists after the arm — `false` is AC5's promise. */
  dirCreated: boolean;
  /** The `Authorization` header the stand-in transport was handed, or `null` if it saw none. */
  authorization: string | null;
};

/** Everything the readings need, measured once. */
type Measurement = {
  baseline: Arm;
  textThrow: Arm;
  audioBlocked: Arm;
  failBaseline: Arm;
  failThrow: Arm;
  hardPort: Arm;
  /** The modules this file imports that could open a socket or start a process. */
  doors: string[];
  /** The id the adapter declares, read off the module rather than spelled. */
  adapterId: string;
  /** The instant the clock was pinned to for this measurement. */
  frozenNow: number;
};

// ── driving one arm ───────────────────────────────────────────────────────────────────────────

/**
 * Drives one arm's transcription and reports what the collector, the transport and the disk saw.
 *
 * THE ENVIRONMENT IS SET HERE, and the mode handed to the shipping resolver is read BACK OFF
 * `process.env` rather than passed as a literal: that is what makes `modeInput` the value the process
 * actually carries, so this criterion drives the deployment's own value rather than a string only
 * this file knows.
 *
 * THE PORT IS BUILT ONLY WHEN THE ARM INJECTS ONE. A baseline arm constructs no port at all, which is
 * the shape every deployment that records nothing has — and it is why the baseline's attempt line
 * carries no `captureId`, and why that difference is exactly the one AC3 removes before comparing.
 *
 * THE STAND-IN TRANSPORT IS THE ONLY SEAM A REQUEST LEAVES THROUGH, so "the wire carried the
 * credential" is a reading of the header this function was handed rather than a claim about a socket.
 */
async function runArm(input: {
  name: string;
  capture: string | undefined;
  captureDir: string | undefined;
  databasePath: string;
  /** A path created as a REGULAR FILE before the arm, so a directory under it cannot be made. */
  blockerFile?: string;
  injectPort: boolean;
  /** The log port's refusal rule, or `null` for a port that records everything it is given. */
  refuse: 'row' | 'row-or-prefixed' | null;
  /** Whether this deployment wires the counting wrapper around the SHIPPED audio writer. */
  countingSink: boolean;
  answer: Answer;
  settings: VoiceSettings;
  overrides: VoiceRequestOverrides;
  captureModule: CaptureModule;
  createService: typeof createVoiceService;
}): Promise<Arm> {
  if (input.capture === undefined) {
    delete process.env.VOICE_CAPTURE;
  } else {
    process.env.VOICE_CAPTURE = input.capture;
  }
  if (input.captureDir === undefined) {
    delete process.env.VOICE_CAPTURE_DIR;
  } else {
    process.env.VOICE_CAPTURE_DIR = input.captureDir;
  }
  process.env.DATABASE_PATH = input.databasePath;

  if (input.blockerFile !== undefined) {
    writeFileSync(input.blockerFile, `blocker-${RUN_TAG}`);
  }

  // The resolver's argument, read off the environment at the moment the composition root would have it.
  const modeInput = process.env.VOICE_CAPTURE;

  const lines: string[] = [];
  const refusedLines: string[] = [];
  const log: VoiceLogPort = {
    // Method shorthand rather than a captured function, so nothing in this file writes a line of its
    // own into the collector. The refusal rule is the arm's, and the throw carries no needle: a
    // sentinel error whose text mentioned the transcript would make AC4's search a reading about the
    // error this file raised rather than about the line the module printed.
    info: (message: string): void => {
      if (input.refuse !== null) {
        const refuses =
          parseCaptureRow(message) !== null ||
          (input.refuse === 'row-or-prefixed' && message.startsWith('voice.capture'));
        if (refuses) {
          refusedLines.push(message);
          throw new Error('sentinel: this port refuses that line');
        }
      }
      lines.push(message);
    },
  };

  const write: WriteCounters = { attempts: 0, refused: false, bytesInHand: false };
  const sink: VoiceCaptureAudioSink | undefined = input.countingSink
    ? {
        resolveDirectory: (): string =>
          input.captureModule.resolveVoiceCaptureDir(
            process.env.VOICE_CAPTURE_DIR,
            process.env.DATABASE_PATH,
          ),
        // THE SHIPPED WRITER, handed the directory the shipped resolver answered with. The `ENOTDIR`
        // this raises is the shipped `mkdirSync`'s own; this arm only counts the call, checks the
        // bytes it was handed, and remembers that it threw before letting the throw continue on the
        // road the module under test owns.
        writeAudio: (directory, captureId, audio): string => {
          write.attempts += 1;
          // The seam declares `Uint8Array`, so the comparison is made through `Buffer.from` rather
          // than a `Buffer`-only method: the promise is about the bytes, not about which of the two
          // views of them the port happened to hand over.
          write.bytesInHand =
            audio.bytes.length === AUDIO_BYTES.length &&
            Buffer.compare(Buffer.from(audio.bytes), AUDIO_BYTES) === 0;
          try {
            return input.captureModule
              .createVoiceCaptureAudioSink({ directory })
              .writeAudio(directory, captureId, audio);
          } catch (error) {
            write.refused = true;
            throw error;
          }
        },
      }
    : undefined;

  // The SHIPPING port constructor, handed the mode the SHIPPING resolver answered with — so the gate
  // the service applies is the one the deployment's own wiring would reach, not a shape built here.
  const resolution = input.captureModule.resolveVoiceCaptureMode(modeInput);
  const port = input.injectPort
    ? input.captureModule.createVoiceCapture({ mode: resolution.mode, log, audio: sink })
    : undefined;

  let authorization: string | null = null;
  const fetchBackend = async (_url: string, options: RequestInit): Promise<Response> => {
    const headers = options.headers as Record<string, string> | undefined;
    const seen = headers?.['Authorization'];
    if (typeof seen === 'string') {
      authorization = seen;
    }
    return new Response(input.answer.body, { status: input.answer.status });
  };

  // Annotated with the shipped contract, so a factory whose surface drifted reds here rather than at
  // the first reading that reads a field off a result.
  const service: VoiceService = input.createService({
    defaults: DEFAULTS,
    timeoutMs: 5_000,
    fetchBackend,
    logger: log,
    ...(port === undefined ? {} : { capture: port }),
  });

  let result: ResultView;
  try {
    result = viewOf(
      await service.transcribe({
        audio: AUDIO_UPLOAD,
        overrides: input.overrides,
        settings: input.settings,
      }),
    );
  } catch (error) {
    // Reachable only when the isolation under test is ABSENT — see `ResultView.threw`.
    result = {
      ok: false,
      status: -1,
      text: '',
      error: '',
      threw: error instanceof Error ? error.message : String(error),
    };
  }

  const captureDir = input.captureDir ?? null;
  return {
    name: input.name,
    modeInput,
    mode: resolution.mode,
    lines,
    transcribeLines: lines.filter((line) => line.startsWith('voice.transcribe')),
    failedLines: lines.filter((line) => line.trim().startsWith('voice.capture')),
    rowLines: lines.filter((line) => parseCaptureRow(line) !== null),
    portThrew: refusedLines.length,
    refusedLines,
    threwOnlyOnRows:
      refusedLines.length > 0 && refusedLines.every((line) => parseCaptureRow(line) !== null),
    result,
    write,
    captureDir,
    dirCreated: captureDir !== null && existsSync(captureDir),
    authorization,
  };
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────

/** The settings document every attempt is driven with: this provider's OWN address and credential. */
function settingsFor(): VoiceSettings {
  return {
    baseUrl: '',
    apiKey: '',
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    dashscopeEndpoint: ENDPOINT,
    dashscopeApiKey: KEY_SENTINEL,
    dashscopeModel: '',
  };
}

/**
 * THE measurement: six arms, one frozen clock, the purity probe and the two module imports.
 *
 * THE CLOCK IS PINNED HERE AND RESTORED IN `finally`, around everything that runs an arm: AC3
 * compares the attempt line across two arms byte for byte and that line carries a wall-clock figure,
 * so the pin is what makes the comparison about the fields the seam could have touched. The process's
 * own `Date.now` is put back before this function returns, so a sibling criterion in the same process
 * is unaffected — and AC1's own budget is measured after the restore.
 *
 * THE REGISTRY IS IMPORTED BEFORE THE ADAPTER, and for the id only; see the constants above.
 */
async function measure(serviceModulePath: string): Promise<Measurement> {
  const serviceModule = (await import(pathToFileURL(serviceModulePath).href)) as ServiceModule;
  const captureModule = (await import(
    pathToFileURL(SHIPPING_CAPTURE_MODULE).href
  )) as unknown as CaptureModule;
  await import(pathToFileURL(REGISTRY_MODULE).href);
  const adapter = (await import(pathToFileURL(ADAPTER_MODULE).href)) as { id: string };

  const root = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-isolation-'));
  const realNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    const createService = serviceModule.createVoiceService;
    const settings = settingsFor();
    const overrides: VoiceRequestOverrides = { providerId: adapter.id, sttModel: DEFAULTS.sttModel };
    const answer: Answer = { status: 200, body: SUCCESS_BODY };
    const notFound: Answer = { status: NOT_FOUND_STATUS, body: NOT_FOUND_BODY };

    const armDir = (name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };

    // ── the reference: a successful transcription with no capture port at all ────────────────────
    const baseline = await runArm({
      name: 'baseline',
      capture: undefined,
      captureDir: undefined,
      databasePath: path.join(armDir('baseline'), 'auth.db'),
      injectPort: false,
      refuse: null,
      countingSink: false,
      answer,
      settings,
      overrides,
      captureModule,
      createService,
    });

    // ── AC2/AC3/AC4: the log port refuses the capture ROW ────────────────────────────────────────
    const textThrow = await runArm({
      name: 'textThrow',
      capture: 'text',
      captureDir: undefined,
      databasePath: path.join(armDir('text-throw'), 'auth.db'),
      injectPort: true,
      refuse: 'row',
      countingSink: false,
      answer,
      settings,
      overrides,
      captureModule,
      createService,
    });

    // ── AC5: the audio mode, and a directory the filesystem cannot make ─────────────────────────
    const audioRoot = armDir('audio-blocked');
    const audioBlocked = await runArm({
      name: 'audioBlocked',
      capture: 'audio',
      // The configured directory sits UNDER a path this arm creates as a regular file, so the
      // shipped writer's `mkdirSync` is what raises `ENOTDIR`.
      captureDir: path.join(audioRoot, 'blocker', 'voice-capture'),
      blockerFile: path.join(audioRoot, 'blocker'),
      databasePath: path.join(audioRoot, 'auth.db'),
      injectPort: true,
      refuse: null,
      countingSink: true,
      answer,
      settings,
      overrides,
      captureModule,
      createService,
    });

    // ── AC6: the upstream fails, with and without a recorder ────────────────────────────────────
    const failBaseline = await runArm({
      name: 'failBaseline',
      capture: undefined,
      captureDir: undefined,
      databasePath: path.join(armDir('fail-baseline'), 'auth.db'),
      injectPort: false,
      refuse: null,
      countingSink: false,
      answer: notFound,
      settings,
      overrides,
      captureModule,
      createService,
    });
    const failThrow = await runArm({
      name: 'failThrow',
      capture: 'text',
      captureDir: undefined,
      databasePath: path.join(armDir('fail-throw'), 'auth.db'),
      injectPort: true,
      refuse: 'row',
      countingSink: false,
      answer: notFound,
      settings,
      overrides,
      captureModule,
      createService,
    });

    // ── AC7: a port that refuses the failure line as well ───────────────────────────────────────
    const hardPort = await runArm({
      name: 'hardPort',
      capture: 'text',
      captureDir: undefined,
      databasePath: path.join(armDir('hard-port'), 'auth.db'),
      injectPort: true,
      refuse: 'row-or-prefixed',
      countingSink: false,
      answer,
      settings,
      overrides,
      captureModule,
      createService,
    });

    return {
      baseline,
      textThrow,
      audioBlocked,
      failBaseline,
      failThrow,
      hardPort,
      doors: openDoors(),
      adapterId: adapter.id,
      frozenNow: FROZEN_NOW,
    };
  } finally {
    Date.now = realNow;
    rmSync(root, { recursive: true, force: true });
  }
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

/**
 * The needles AC4 searches the failure line for, each paired with a name a red can print.
 *
 * THE LIST IS THE AC'S, and it is a list of things this run KNOWS reached the capture face or the
 * wire: the transcript that came back, the upload in three representations, the credential the
 * settings hold, and the two header names a request carries. Every one of them has a positive control
 * elsewhere in this file (see the AC4 reading) — without that, "the needle is not in the line" would
 * also be true of a run in which the needle never existed.
 */
const NEEDLES: readonly { name: string; value: string }[] = [
  { name: 'TRANSCRIPT_SENTINEL', value: TRANSCRIPT_SENTINEL },
  { name: 'AUDIO_BASE64', value: AUDIO_BASE64 },
  { name: 'AUDIO_BASE64_HEAD', value: AUDIO_BASE64.slice(0, 32) },
  { name: 'AUDIO_BYTES_HEAD', value: AUDIO_BYTES_HEAD },
  { name: 'AUDIO_SENTINEL', value: AUDIO_SENTINEL },
  { name: 'KEY_SENTINEL', value: KEY_SENTINEL },
  { name: 'BEARER_PREFIX', value: 'Bearer ' },
  { name: 'AUTHORIZATION_HEADER', value: 'Authorization' },
  { name: 'CONTENT_TYPE_HEADER', value: 'Content-Type' },
];

/** Every needle found in a text, by name. */
function needlesIn(text: string): string[] {
  return NEEDLES.filter((needle) => text.includes(needle.value)).map((needle) => needle.name);
}

/** One reading: a name, and a function from the measurement to a verdict and its printed value. */
type Reading = { name: string; run: (measurement: Measurement) => { value: string; ok: boolean } };

const READINGS: readonly Reading[] = [
  // ── AC2: a refused row line does not change what the caller receives ───────────────────────────
  {
    name: 'AC2 text throw isolation',
    run: (measurement) => {
      const { baseline, textThrow } = measurement;
      const resultIdentical = sameResult(textThrow.result, baseline.result);
      const textByteIdentical = sameText(textThrow.result, baseline.result);
      return {
        value:
          `text.captureThrew=${textThrow.portThrew} ` +
          `text.thrownOnCaptureLine=${String(textThrow.threwOnlyOnRows)} ` +
          `text.resultIdentical=${String(resultIdentical)} ` +
          `text.textByteIdentical=${String(textByteIdentical)}`,
        ok:
          // THE POSITIVE FIRST: a port that refused nothing produces `resultIdentical=true` for the
          // trivial reason that nothing happened, and the whole reading would be about a seam that
          // was never exercised. The figure is a counter, not a boolean, so "one refusal" and "the
          // port was never asked" cannot read alike.
          textThrow.portThrew >= 1 &&
          // And every refusal was of a capture ROW: a port that had refused the attempt line would be
          // measuring a different failure, one this deployment has no guard for and does not promise.
          textThrow.threwOnlyOnRows &&
          resultIdentical &&
          textByteIdentical &&
          baseline.result.ok &&
          textThrow.result.ok,
      };
    },
  },
  // ── AC3: the attempt line is untouched, and exactly one line is added ──────────────────────────
  {
    name: 'AC3 attempt line unchanged one failed line',
    run: (measurement) => {
      const { baseline, textThrow } = measurement;
      const baselineLine = baseline.transcribeLines[0];
      const thrownLine = textThrow.transcribeLines[0];
      // The capture id is the ONE field the seam is allowed to add (AC-143's gate), so it is removed
      // before the comparison — everything else, including the frozen `latencyMs`, has to match.
      const transcribeLineEqual =
        baseline.transcribeLines.length === 1 &&
        textThrow.transcribeLines.length === 1 &&
        baselineLine !== undefined &&
        thrownLine !== undefined &&
        withoutCaptureId(thrownLine) === baselineLine;
      const failedLines = textThrow.failedLines.length;
      const only = textThrow.failedLines[0];
      const failedLineVerbatim = only !== undefined && only.trim() === FAILED_LINE;
      return {
        value:
          `transcribeLineEqual=${String(transcribeLineEqual)} ` +
          `baselineLine=${String(baselineLine)} thrownLine=${String(thrownLine)} ` +
          `failedLines=${failedLines} failedLineVerbatim=${String(failedLineVerbatim)} ` +
          `failedLine=${JSON.stringify(only ?? null)}`,
        ok: transcribeLineEqual && failedLines === 1 && failedLineVerbatim,
      };
    },
  },
  // ── AC4: the failure line carries nothing, with a positive control for every needle ────────────
  {
    name: 'AC4 failed line carries no content',
    run: (measurement) => {
      const { textThrow } = measurement;
      const only = textThrow.failedLines[0] ?? '';
      const present = needlesIn(only);
      // (a) THE POSITIVES. The transcript is read off the text the CALLER received, and the bearer is
      // read off the header the stand-in transport was handed — so the needles this reading then
      // fails to find in the line are needles that provably existed on this run's other surfaces.
      const serviceHadText = textThrow.result.text.includes(TRANSCRIPT_SENTINEL);
      const wireCarriedKey = textThrow.authorization === `Bearer ${KEY_SENTINEL}`;
      // (b) THE NEGATIVE. The existence of the line is part of the verdict rather than a separate
      // reading: a line that was never printed is trivially content-free, and that vacuity is exactly
      // what this reading must not accept.
      const failedLineContentFree = textThrow.failedLines.length === 1 && present.length === 0;
      return {
        value:
          `serviceHadText=${String(serviceHadText)} wireCarriedKey=${String(wireCarriedKey)} ` +
          `failedLineContentFree=${String(failedLineContentFree)} ` +
          `failedLines=${textThrow.failedLines.length} ` +
          `needles-present=[${present.join(' ')}] needles=${NEEDLES.length} ` +
          `text=${JSON.stringify(textThrow.result.text)} auth=${JSON.stringify(textThrow.authorization)}`,
        ok: serviceHadText && wireCarriedKey && failedLineContentFree,
      };
    },
  },
  // ── AC5: the audio road, and a directory the filesystem refused to make ────────────────────────
  {
    name: 'AC5 audio directory unwritable',
    run: (measurement) => {
      const { baseline, audioBlocked: arm } = measurement;
      const resultIdentical = sameResult(arm.result, baseline.result);
      const textByteIdentical = sameText(arm.result, baseline.result);
      const only = arm.failedLines[0];
      const failedLineVerbatim = only !== undefined && only.trim() === FAILED_LINE;
      return {
        value:
          `audio.resultIdentical=${String(resultIdentical)} ` +
          `audio.textByteIdentical=${String(textByteIdentical)} ` +
          `audio.dirCreated=${String(arm.dirCreated)} ` +
          `audio.failedLineVerbatim=${String(failedLineVerbatim)} ` +
          `audio.failedLines=${arm.failedLines.length} ` +
          `audio.writeAttempts=${arm.write.attempts} audio.writeRefused=${String(arm.write.refused)} ` +
          `audio.bytesInHand=${String(arm.write.bytesInHand)} ` +
          `audio.rows=${arm.rowLines.length} dir=${String(arm.captureDir)}`,
        ok:
          // The three positive controls: the write port was reached, the SHIPPED writer really threw
          // for this path, and the bytes the port was handed are the upload's own. Without them the
          // isolation readings above would also hold for a deployment whose sink was never called —
          // this is AC4's audio-family control, and it lives in this arm because `text` writes nothing.
          arm.write.attempts >= 1 &&
          arm.write.refused &&
          arm.write.bytesInHand &&
          // The isolation itself, against the no-port baseline of the SAME run.
          resultIdentical &&
          textByteIdentical &&
          baseline.result.ok &&
          arm.result.ok &&
          // The failure line is printed once and verbatim, and the directory the deployment named was
          // NOT left behind — a writer that created it and failed later would satisfy neither.
          arm.failedLines.length === 1 &&
          failedLineVerbatim &&
          // No row was written: the write is what failed, so this arm must not also report a row.
          arm.rowLines.length === 0 &&
          !arm.dirCreated,
      };
    },
  },
  // ── AC6: an upstream failure is the same failure whether or not the recorder failed ────────────
  {
    name: 'AC6 upstream failure unchanged',
    run: (measurement) => {
      const { failBaseline, failThrow } = measurement;
      const errorEqual = sameBytes(failThrow.result.error, failBaseline.result.error);
      const only = failThrow.failedLines[0];
      const failedLineVerbatim = only !== undefined && only.trim() === FAILED_LINE;
      return {
        value:
          `fail.ok=${String(failThrow.result.ok)} fail.status=${failThrow.result.status} ` +
          `fail.errorEqual=${String(errorEqual)} fail.failedLines=${failThrow.failedLines.length} ` +
          `baseline.ok=${String(failBaseline.result.ok)} baseline.status=${failBaseline.result.status} ` +
          `error=${JSON.stringify(failThrow.result.error)}`,
        ok:
          failThrow.result.ok === false &&
          failBaseline.result.ok === false &&
          failThrow.result.status === failBaseline.result.status &&
          errorEqual &&
          // The recorder failed on the FAILURE road too, and said so in the one allowed line.
          failThrow.failedLines.length === 1 &&
          failedLineVerbatim,
      };
    },
  },
  // ── AC7: the failure line itself refused — the same invariant, read harder ─────────────────────
  {
    name: 'AC7 failure line refused too',
    run: (measurement) => {
      const { baseline, hardPort: arm } = measurement;
      const textByteIdentical = sameText(arm.result, baseline.result);
      return {
        value:
          `hardPort.threw=${arm.portThrew} ` +
          `hardPortSurvives=${String(arm.result.ok)} ` +
          `hardPort.textByteIdentical=${String(textByteIdentical)} ` +
          `hardPort.failedLines=${arm.failedLines.length} ` +
          `hardPort.threwOnRow=${String(arm.refusedLines.some((l) => parseCaptureRow(l) !== null))} ` +
          `hardPort.threwOnFailedLine=${String(arm.refusedLines.some((l) => l.startsWith('voice.capture')))}`,
        ok:
          // The refusal count: this port refuses the ROW (which is what reaches the guard) and then
          // the failure line (which is what the guard prints). Both figures are read, because a port
          // that refused only the row would be AC2's arm again rather than this one.
          arm.portThrew >= 2 &&
          arm.refusedLines.some((line) => parseCaptureRow(line) !== null) &&
          arm.refusedLines.some((line) => line.startsWith('voice.capture')) &&
          // The invariant: the transcription still answers what it always answered, even though
          // nothing about the recording could be said at all. This reading does NOT require a failure
          // line — the port that refuses it is the arm's whole subject.
          arm.result.ok &&
          baseline.result.ok &&
          textByteIdentical &&
          arm.failedLines.length === 0,
      };
    },
  },
  // ── AC10: what this criterion covered, registered rather than asserted in prose ────────────────
  {
    name: 'AC10 registration',
    run: (measurement) => {
      const arms = [
        measurement.baseline,
        measurement.textThrow,
        measurement.audioBlocked,
        measurement.failBaseline,
        measurement.failThrow,
        measurement.hardPort,
      ];
      return {
        value:
          'scope=[the isolation of a FAILED recording: a log port that refuses the capture row, an ' +
          'audio directory the filesystem cannot create, and a port that refuses the failure line too ' +
          '— each measured against a no-capture-port baseline of the same run, on `ok`/`status`/' +
          '`error` and on `value.text` byte for byte, with exactly one verbatim `voice.capture failed` ' +
          'line and no needle in it] out-of-scope=[the gate and mode resolution (AC-143), the text ' +
          'payload`s marks (AC-144), the write and its permissions (AC-145), the three-mode redaction ' +
          'criterion (AC-146), any real-process reading (AC-148)] fixtures=[stand-in fetchBackend, ' +
          'injected log port, the SHIPPED write-audio factory behind a counting wrapper, a directory ' +
          'whose parent is a regular file] truth=[nothing reached a real upstream, no process was ' +
          'started, no socket was opened; the only files written are the ones this run created inside ' +
          `its own temp tree] clock=[Date.now pinned to ${measurement.frozenNow} for the whole ` +
          'measurement and restored in a `finally`, so AC3`s byte comparison is about the fields the ' +
          'seam could have touched rather than about a wall clock] ' +
          `adapter=${measurement.adapterId} arms=${arms.map((arm) => `${arm.name}:${arm.mode}`).join(' ')} ` +
          `doors=${measurement.doors.length}`,
        ok:
          // The registration is tied to figures, so a run that silently stopped driving an arm cannot
          // print this as its provenance. `modeInput` is read off the environment in every arm, so the
          // pair "what the process carried" / "what the resolver answered" is what is being pinned.
          arms.length === 6 &&
          measurement.baseline.modeInput === undefined &&
          measurement.baseline.mode === 'off' &&
          measurement.textThrow.modeInput === 'text' &&
          measurement.textThrow.mode === 'text' &&
          measurement.audioBlocked.modeInput === 'audio' &&
          measurement.audioBlocked.mode === 'audio' &&
          measurement.baseline.result.ok &&
          measurement.doors.length === 0,
      };
    },
  },
];

/**
 * Runs every reading against one measurement, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsifying file has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 *
 * THE MODULE PATH IS THE ONLY SLOT. Both mutations AC9 names live in `voice.service.ts` — the local
 * guard and the line it prints — so a single copied module is the whole difference between an arm and
 * its mutant. Registered here rather than left for a reader to infer from the signature.
 */
export async function collectReadings(
  serviceModulePath: string = SHIPPING_SERVICE_MODULE,
): Promise<ReadingOutcome[]> {
  const measurement = await measure(serviceModulePath);

  const outcomes: ReadingOutcome[] = [];
  for (const reading of READINGS) {
    let outcome: ReadingOutcome;
    try {
      const measured = reading.run(measurement);
      outcome = { name: reading.name, value: measured.value, ok: measured.ok };
    } catch (error) {
      outcome = {
        name: reading.name,
        value: `threw: ${error instanceof Error ? error.message : String(error)}`,
        ok: false,
      };
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ─────

const IS_ENTRY = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  let driven = 0;
  let measuredOnce: Promise<ReadingOutcome[]> | undefined;
  const readingsOnce = (): Promise<ReadingOutcome[]> =>
    (measuredOnce ??= collectReadings(SHIPPING_SERVICE_MODULE));

  for (const reading of READINGS) {
    test(reading.name, async () => {
      const outcomes = await readingsOnce();
      const outcome = outcomes.find((entry) => entry.name === reading.name);
      assert.ok(outcome, `the reading list produced no outcome for '${reading.name}'`);
      driven += 1;
      // Printed BEFORE the assertion, so a red names itself and its measured value in the log rather
      // than only in the assertion's diff.
      process.stdout.write(`reading ${outcome.name} = ${outcome.value}\n`);
      assert.equal(outcome.ok, true, `reading '${outcome.name}' measured ${outcome.value}`);
    });
  }

  test('AC1 budget and scope', () => {
    const elapsed = Date.now() - STARTED_AT;
    const doors = openDoors();

    // AC1's own words: the run prints `elapsed-ms=<n>`, and the target-side gate gives a criterion
    // sixty seconds. The budget below is this criterion's, four times under that ceiling.
    process.stdout.write(`elapsed-ms=${elapsed}\n`);
    process.stdout.write(
      `reading AC1 scope = elapsed-ms=${elapsed} subprocess-or-socket-imports=${doors.length} ` +
        `[${doors.join(' ')}] readings=${driven}/${READINGS_EXPECTED}\n`,
    );

    assert.equal(
      driven,
      READINGS_EXPECTED,
      `${driven} readings ran but READINGS_EXPECTED is ${READINGS_EXPECTED}: a reading was skipped, ` +
        'which reads exactly like a shorter green list',
    );
    assert.ok(elapsed < 15_000, `the criterion took ${elapsed}ms, past its own 15s budget`);
    assert.deepEqual(
      doors,
      [],
      `this criterion imports a module that can open a socket or start a process: ${doors.join(', ')}`,
    );
  });
}
