/**
 * The `text` payload: what one attempt ACTUALLY used, sent and got back, on the row it records.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-off.test.ts` reads the mode resolution, the
 * start-up line, the gate and the row's EXISTENCE. It deliberately does not read the row's CONTENTS,
 * and until this criterion those contents were the attempt's own four fields and nothing else — a
 * deployment could not answer "which model did it actually use", "which host answered", "what did the
 * upstream actually say", "which of the six ways did this attempt end", or "what did we hand back"
 * from its own log. Every reading here is about one of those, and every one of them is a reading
 * about the ROW: the row is the only artifact this task delivers.
 *
 * THE SUBJECT IS THE RAW RETURN, AND THAT IS WHY IT IS READ RATHER THAN RECONSTRUCTED. The upstream's
 * answer is the one thing on this path nothing but the transport can produce, so the criterion's
 * stand-in transport answers with a body it also hands to the readings — and the reading is that the
 * row carries THAT string, verbatim, rather than the text the attempt's caller finally got. Those two
 * differ exactly where it matters (`empty-instruction` and `not-an-envelope` below: the caller got a
 * transcription, or nothing, and the upstream said something else entirely), so a row built from the
 * caller's value would pass a reading that only asked "is there a body" and fail this one.
 *
 * HOW IT IS DRIVEN. Eight attempts through ONE shipping service and ONE stand-in transport, in TWO
 * arms that differ only in the mode the port was resolved to: `text` (the shipping port constructor,
 * eight capture rows) and `off` (the same eight attempts, no rows at all). Both arms are driven in
 * the same process against the same harness, so `off.captureLines=0` beside `text.captureLines=8` is
 * a measured pair rather than two runs a reader has to line up. Nothing here reaches a network, starts
 * a process or opens a socket: the transport is the injected port every attempt already goes through,
 * and the log is an array the criterion owns.
 *
 * THE EIGHT ATTEMPTS ARE THE SIX BRANCHES PLUS THE TWO SIDES OF THE CUT. `written`,
 * `upstream-failure` and `preflight-refused` are the three an attempt can end as when the transport
 * is or is not reached; `verbatim-fallback`, `no-speech` and `envelope-error` are the three an answer
 * can end as when it is reached and unusable. `over-limit` and `at-limit` are the same success at
 * 70000 bytes and at exactly the limit, which is what makes the truncation reading two-ended: a
 * mutation that never truncates and one that always flags must both go red, and one case alone cannot
 * tell those apart from a correct implementation.
 *
 * FALSIFYING FORMS LIVE IN `voice-capture-text.false-forms.test.ts`, and the readings are collected
 * by one exported function so that file can run THIS list against a text-mutated copy of
 * `voice-capture.ts`. Its four cases name which reading each mutation must red; see the header there
 * for why each one is reachable at all. Registering the readings as `node:test` cases is guarded by
 * `IS_ENTRY`, so importing this file registers nothing.
 *
 * WHAT THIS FILE DOES NOT COVER (registered in the `AC12 registration` reading rather than left to a
 * reader to notice): the audio mode and its file write, a secrets criterion over the stored
 * credential, capture-failure isolation, and any real-process reading. The write-audio path is
 * exercised ONLY as a positive control, so that the zero this criterion measures is a measured zero;
 * the shipping file write itself is another task's delivery.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
  VoiceAudioUpload,
  VoiceLogPort,
  VoiceRequestOverrides,
  VoiceService,
  VoiceSettings,
} from '@/shared/types.js';
import type {
  VoiceCaptureAudio,
  VoiceCaptureAudioSink,
  VoiceCapturePort,
  VoiceCaptureResolution,
} from '../voice-capture.js';
import type { createVoiceService } from '../voice.service.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — three levels above this file (`server/modules/voice/tests/`). */
const SERVER_DIR = path.resolve(HERE, '../../..');

/** The shipping service module: what this criterion drives, and the file one mutation case copies. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping capture module: the port constructor, the resolver and the payload builder. */
export const SHIPPING_CAPTURE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice-capture.ts');

/**
 * The registry, imported BEFORE the adapter below.
 *
 * The adapter's own module body reads declarations the registry publishes, so importing the adapter
 * into an uninitialised registry is a TDZ error rather than an empty list; the registry's graph
 * evaluates the adapter, so after this import the adapter module is complete. Importing it by path
 * resolves to the same file URL the service's own relative specifier does, so this is the same module
 * instance the service under test sees and not a second copy of the registry.
 */
const REGISTRY_MODULE = path.resolve(SERVER_DIR, '../shared/asr/asrRegistry.ts');
/** The `dashscope-omni` adapter: the prompt, the default model, the declaration, the encoder. */
const ADAPTER_MODULE = path.resolve(
  SERVER_DIR,
  '../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
);

/** This file, read as text by the door scan and by the hand-rolled-row scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 9;

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

/** The deployment shape every arm is driven with: the same defaults the other voice criteria use. */
const DEFAULTS = {
  baseUrl: 'https://voice.example/v1',
  // The shared model of ANOTHER service, deliberately: a provider that declares credentials of its
  // own must not have this id reach its row. See the `written` reading's `modelFromAdapterDefault`.
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
  apiKey: 'server-key',
};

/** A workspace address the adapter's own endpoint rule accepts: https, no port, `maas` hostname. */
const ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

/** The hostname of `ENDPOINT`, which is the only part of it a row may carry. */
const ENDPOINT_HOST = new URL(ENDPOINT).hostname;

/** Run-unique, so a reading about "this value is not in the row" is about THIS run's value. */
const RUN_TAG = `${process.pid}-${Date.now()}`;
/** The credential sentinel: it must reach the wire and must not reach a row. */
const KEY_SENTINEL = `key-${RUN_TAG}`;
/** The upload's own sentinel: same two readings, on the audio side. */
const AUDIO_SENTINEL = `audio-${RUN_TAG}`;

/** The upload's bytes: the sentinel makes "the row does not carry the upload" a reading of THIS run. */
const AUDIO_BYTES = Buffer.from(`${AUDIO_SENTINEL}:${'a'.repeat(64)}`, 'utf8');

/** The upload as the capture seam takes it, for the readings about `mime`, `bytes` and `sha256`. */
const AUDIO: VoiceCaptureAudio = { bytes: AUDIO_BYTES, mimeType: 'audio/webm', fileName: 'clip.webm' };

/** The same upload as the SERVICE takes it. One set of bytes, named twice because the seams differ. */
const AUDIO_UPLOAD: VoiceAudioUpload = {
  bytes: AUDIO_BYTES,
  mimeType: AUDIO.mimeType,
  fileName: AUDIO.fileName,
};

/** The transcription every fixture envelope carries, short enough to leave room for the padding. */
const TRANSCRIPT = '逐字转写';
/** The instruction the `written` case's envelope carries. */
const INSTRUCTION = '整理后的指令';

/** The whole serialised body of the `written` case, and the string the row must carry verbatim. */
const WRITTEN_BODY = JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ transcript: TRANSCRIPT, instruction: INSTRUCTION }) } }],
});

/** The 404 body, verbatim: what a row about a refused attempt has to be able to show. */
const FAIL_BODY = '{"error":{"code":"InvalidParameter","message":"model not found"}}';

/** A 200 answer that is not this service's envelope at all. */
const NOT_ENVELOPE_BODY = '{"choices":[{"message":{"role":"assistant"}}]}';

/** How much bigger than the limit the `over-limit` answer is, in whole bytes. */
const OVER_LIMIT_BYTES = 70_000;

// ── the contract between this file and a mutated copy ─────────────────────────────────────────

/** The modules under test. Absent means the shipping one. */
export type CriterionModules = { service?: string; capture?: string };

/** One reading's outcome, as the falsifying file reads them. */
export type ReadingOutcome = { name: string; value: string; ok: boolean };

// ── the shipped shapes, named as this file needs them ─────────────────────────────────────────

/** The `dashscope-omni` module's surface, as this criterion reads values off it. */
type AdapterModule = {
  id: string;
  DEFAULT_MODEL: string;
  JSON_TASK: string;
  capabilities: { acceptsMime: readonly string[] };
  base64Encode(bytes: Uint8Array): string;
};

/** The capture module's surface, as this criterion reads it. */
type CaptureModule = {
  resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution;
  createVoiceCapture(dependencies: {
    mode: VoiceCaptureResolution['mode'];
    log: VoiceLogPort;
    audio?: VoiceCaptureAudioSink;
  }): VoiceCapturePort;
  resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string;
  RAW_RETURN_LIMIT_BYTES: number;
};

/** One answer the stand-in transport gives, or `null` for an attempt refused before the transport. */
type Answer = { status: number; body: string };

/** One of the eight attempts: the case's name, the upload it sends, and the answer it earns. */
type Step = { name: string; upload: VoiceAudioUpload; answer: Answer | null };

/** One attempt's window over the collected lines, plus the transport's footprint across it. */
type Attempt = {
  /** The step this attempt drove, so a reading can read back what it sent. */
  step: Step;
  /** Every line the collector received during this attempt, in order. */
  lines: string[];
  /** The subset that is NOT a capture row — the `voice.transcribe` attempt line, and nothing else. */
  attemptLines: string[];
  /** The subset that is a capture row. */
  rowLines: string[];
  /** The parsed rows, in the order they appeared. */
  rows: Record<string, unknown>[];
  /** Whether EVERY row line was valid single-line JSON (`JSON.parse` ok, one line). */
  allRowsParse: boolean;
  /** How many times the stand-in transport had been called before this attempt started. */
  callsBefore: number;
  /** The same count after it finished. Equal exactly when this attempt reached no transport. */
  callsAfter: number;
  /** What `transcribe` answered this attempt. */
  result: { ok: boolean; status: number };
};

/** One arm: the mode, the lines, the attempts and the filesystem footprint of the whole run. */
type Arm = {
  name: string;
  /** The RAW value handed to the shipping resolver — read off the environment, never a literal. */
  resolverInput: string | undefined;
  /** The mode the shipping resolver answered with. */
  mode: string;
  /** Every line the collector received across all eight attempts. */
  lines: string[];
  attempts: Attempt[];
  /** Every capture ROW text in this arm, in order. */
  rowTexts: string[];
  /** Every `voice.transcribe` attempt line in this arm, in order. */
  attemptLines: string[];
  /** How many capture rows this arm recorded. */
  captureLines: number;
  /** How many times the injected write-audio sink was reached. */
  writeAudioCalls: number;
  /** The entries of this arm's temp parent when the run was over. */
  parentEntries: string[];
  /** Whether this arm's configured capture directory exists. */
  dirCreated: boolean;
  /** The recorded transport calls: the address and the init, for the wire readings. */
  calls: { url: string; init: RequestInit }[];
  /** How many queued answers were never used. Non-zero reads as a fixture the plan did not consume. */
  answersLeft: number;
};

/** Everything the readings need, measured once. */
type Measurement = {
  /** The arm that records: eight attempts, eight rows. */
  text: Arm;
  /** The arm that does not: the same eight attempts, no rows. */
  off: Arm;
  /** The adapter's own declarations, read live off the module under test's neighbour. */
  adapter: {
    id: string;
    defaultModel: string;
    jsonTask: string;
    acceptsMime: readonly string[];
    /**
     * The adapter's OWN encoding of this run's upload, computed by asking it rather than by encoding
     * here: the wire reading is that the audio arrived as base64 of THESE bytes, and a second
     * encoder written in this file could agree with itself while disagreeing with the adapter.
     */
    audioBase64: string;
  };
  /** The bodies this run's stand-in answered with, for the verbatim and truncation readings. */
  bodies: { written: string; fail: string; over: string; atLimit: string };
  /** The mime this run picked that the adapter does NOT declare, derived rather than written down. */
  undeclaredMime: string;
  /** The limit the module under test exports, read off it rather than repeated here. */
  limit: number;
  /** Whether this file writes a capture row of its own. See `handRolledRow`. */
  handRolledRow: boolean;
  /** The modules this file imports that could open a socket or start a process. */
  doors: string[];
  /** The positive control's footprint: a write-audio sink that REALLY writes, driven in `audio` mode. */
  control: { dirCreated: boolean; filesWritten: number; writeAudioCalls: number };
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;

/**
 * The module specifiers this file must not import, assembled rather than spelled.
 *
 * A scan for a literal would match the scan's own text — the token would appear in this file whether
 * or not this file imported the module — so each candidate is built from parts and never appears
 * contiguously anywhere in the source. `express` and `multer` are on the list because the request
 * path's own criteria drive a router; a criterion that needed one to reach the service would be
 * testing the transport rather than the row.
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

/**
 * Whether this file builds a capture row of its own and writes it somewhere.
 *
 * The token is a call on a log port, assembled from parts for the same reason the specifier list is:
 * spelled out, it would appear in the scan's own text. It is the reading that matters because a
 * hand-rolled row can only reach the collected lines one way — through a call this file makes — and
 * the shipping module is the only thing that may make one. The row COUNTS corroborate it: a row this
 * file wrote would have to be one of the eight the module also wrote, or an extra one the counts in
 * `AC2` and `AC6` would see.
 */
function handRolledRow(): boolean {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return source.includes(`.${'in'}fo(`);
}

/** A chat-completion envelope whose `message.content` is `content`. */
function envelope(content: string): string {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

/** An envelope carrying a written pair, as the adapter reads it. */
function writtenEnvelope(instruction: string, transcript: string): string {
  return envelope(JSON.stringify({ transcript, instruction }));
}

/**
 * An envelope whose WHOLE serialised body is exactly `targetBytes` UTF-8 bytes.
 *
 * The scaffold is measured with the instruction empty and the difference is then filled with ASCII,
 * so the target is hit exactly rather than approximately: the instruction is inserted into the JSON
 * unescaped (`x` has nothing to escape), so replacing two bytes of empty string with `k + 2` bytes of
 * padding adds exactly `k`. A fixture that missed the target by a byte would move the truncation
 * reading's expectation with it and the two ends of the cut would no longer be the limit itself.
 */
function sizedEnvelope(targetBytes: number, transcript: string): string {
  const scaffold = Buffer.byteLength(writtenEnvelope('', transcript), 'utf8');
  const body = writtenEnvelope('x'.repeat(targetBytes - scaffold), transcript);
  const measured = Buffer.byteLength(body, 'utf8');
  if (measured !== targetBytes) {
    throw new Error(`the fixture was built for ${targetBytes} B and measures ${measured} B`);
  }
  return body;
}

/** A field of a row, read as a string; anything else reads as the empty string. */
function fieldString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/** A field of a row, read as an object; anything else reads as an empty object. */
function fieldObject(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

/** Whether a key is ABSENT from a row's field — `truncated` is the one field whose absence means. */
function keyAbsent(row: Record<string, unknown>, key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(fieldObject(row, 'upstream'), key);
}

/** The `Authorization` header a recorded transport call carried, or the empty string. */
function authorizationOf(init: RequestInit): string {
  // The adapter builds a plain object (`{'Content-Type': …, Authorization: …}`), which is what makes
  // this a header reading rather than a `Headers` lookup; anything else reads as no header, so a
  // mutated adapter that stopped sending one shows up as the positive control failing.
  const headers = init.headers as Record<string, string> | undefined;
  return headers?.Authorization ?? '';
}

/** The body a recorded transport call carried, or the empty string. */
function bodyOf(init: RequestInit): string {
  return typeof init.body === 'string' ? init.body : '';
}

/** Whether ANY recorded call's body contains `token`. */
function wireCarried(calls: readonly { init: RequestInit }[], token: string): boolean {
  return token !== '' && calls.some((call) => bodyOf(call.init).includes(token));
}

/** The line as a capture ROW, or `null` — parsed, so a start-up line cannot be mistaken for one. */
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

/** Whether a line is valid single-line JSON that parses to an object. */
function isSingleLineJson(line: string): boolean {
  return !line.includes('\n') && parseCaptureRow(line) !== null;
}

// ── the fixture plan ──────────────────────────────────────────────────────────────────────────

/** The mimes this run is willing to use as "one the adapter does not declare". */
const UNDECLARED_CANDIDATES: readonly string[] = ['audio/flac', 'audio/mp4', 'audio/opus'];

/** An upload with a different container, for the attempt that must be refused before the transport. */
function uploadWithMime(mimeType: string): VoiceAudioUpload {
  return { bytes: AUDIO_BYTES, mimeType, fileName: AUDIO.fileName };
}

/**
 * Resolves the undeclared mime this run will use, or throws when the adapter declares them all.
 *
 * DERIVED FROM THE DECLARATION, never written down: a criterion that named `audio/flac` itself would
 * keep asking for a refusal of that container on the day the adapter started accepting it, and the
 * reading would pass while measuring the opposite of what it says.
 */
function pickUndeclaredMime(acceptsMime: readonly string[]): string {
  const found = UNDECLARED_CANDIDATES.find((candidate) => !acceptsMime.includes(candidate));
  if (found === undefined) {
    throw new Error(
      `every candidate mime is declared by the adapter (${acceptsMime.join(', ')}): this criterion ` +
        'needs one the declaration does NOT name, or the preflight reading has no input',
    );
  }
  return found;
}

/**
 * The eight attempts, built once so both arms drive the identical plan.
 *
 * The `undeclared-mime` step's answer is `null` because that attempt must never reach the transport:
 * the `preflight-refused` reading's subject is that the refusal cost nothing, and a queued answer it
 * consumed would be the evidence that it did not.
 *
 * The service's own request budget is declared in the adapter's `capabilities` and the upload is
 * tiny, so the size gate is not what refuses anything here — the container is. The two gates are
 * different readings and this plan drives one of them.
 */
function buildPlan(input: { limit: number; undeclaredMime: string }): {
  steps: readonly Step[];
  bodies: Measurement['bodies'];
} {
  const over = sizedEnvelope(OVER_LIMIT_BYTES, TRANSCRIPT);
  const atLimit = sizedEnvelope(input.limit, TRANSCRIPT);

  const steps: readonly Step[] = [
    { name: 'written', upload: AUDIO_UPLOAD, answer: { status: 200, body: WRITTEN_BODY } },
    { name: 'upstream-404', upload: AUDIO_UPLOAD, answer: { status: 404, body: FAIL_BODY } },
    { name: 'undeclared-mime', upload: uploadWithMime(input.undeclaredMime), answer: null },
    {
      name: 'empty-instruction',
      upload: AUDIO_UPLOAD,
      answer: { status: 200, body: writtenEnvelope('', TRANSCRIPT) },
    },
    { name: 'empty-both', upload: AUDIO_UPLOAD, answer: { status: 200, body: writtenEnvelope('', '') } },
    { name: 'not-an-envelope', upload: AUDIO_UPLOAD, answer: { status: 200, body: NOT_ENVELOPE_BODY } },
    { name: 'over-limit', upload: AUDIO_UPLOAD, answer: { status: 200, body: over } },
    { name: 'at-limit', upload: AUDIO_UPLOAD, answer: { status: 200, body: atLimit } },
  ];

  return { steps, bodies: { written: WRITTEN_BODY, fail: FAIL_BODY, over, atLimit } };
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────

/**
 * The settings document every attempt is driven with: the user's OWN address and key.
 *
 * The shared six fields are empty because this provider is reached through its own, and setting them
 * would leave a reader unable to tell which one the row's `model` came from — see the `written`
 * reading, where the deployment's `sttModel` is a model of a DIFFERENT service on purpose. The model
 * field is empty so the adapter's declared default is what a row has to show.
 */
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
 * Drives the eight attempts through one arm and reports what the collector and the transport saw.
 *
 * THE ENVIRONMENT IS SET HERE, and the resolver's argument is read back off `process.env` rather than
 * passed as a literal: that is what makes `resolverInput` the value the process actually carries, and
 * it is why the `off` arm's control is a `delete` rather than a second string.
 *
 * THE STAND-IN TRANSPORT IS THE ONLY SEAM A REQUEST LEAVES THROUGH, which is the property the whole
 * file rests on: every attempt's request is recorded here, so "what did the wire carry" and "was
 * there a request at all" are readings of this array rather than claims about the network.
 */
async function runArm(input: {
  name: string;
  rawMode: string | undefined;
  capture: CaptureModule;
  createService: typeof createVoiceService;
  steps: readonly Step[];
  settings: VoiceSettings;
  overrides: VoiceRequestOverrides;
}): Promise<Arm> {
  if (input.rawMode === undefined) {
    delete process.env.VOICE_CAPTURE;
  } else {
    process.env.VOICE_CAPTURE = input.rawMode;
  }

  const lines: string[] = [];
  const log: VoiceLogPort = {
    info: (message: string): void => {
      lines.push(message);
    },
  };

  const calls: { url: string; init: RequestInit }[] = [];
  const answers: Answer[] = input.steps.flatMap((step) => (step.answer === null ? [] : [step.answer]));
  const fetchBackend = async (url: string, options: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: options });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(
        'the stand-in transport was called with no answer queued: an attempt that this plan says is ' +
          'refused before the transport reached it instead',
      );
    }
    return new Response(answer.body, { status: answer.status });
  };

  let writeAudioCalls = 0;
  const sink: VoiceCaptureAudioSink = {
    // The SHIPPING directory resolver, asked at the moment of a write — exactly as the port asks it.
    resolveDirectory: (): string =>
      input.capture.resolveVoiceCaptureDir(process.env.VOICE_CAPTURE_DIR, process.env.DATABASE_PATH),
    // Answers where it wrote, as the shipped contract requires (`writeAudio` returns the path the row
    // then carries). Nothing reads the value here — this sink is the one the text arm must never
    // reach — but a stand-in that did not answer would not be the shape the port is handed in
    // production, and the control below is the arm that proves this shape can write.
    writeAudio: (directory: string, captureId: string, audio: VoiceCaptureAudio): string => {
      writeAudioCalls += 1;
      mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `${captureId}-${audio.fileName}`);
      writeFileSync(target, audio.bytes);
      return target;
    },
  };

  // The SHIPPING port constructor, handed the mode the SHIPPING resolver answered with — so the gate
  // the service applies is the one the deployment's own wiring would reach, not a shape built here.
  const resolution = input.capture.resolveVoiceCaptureMode(input.rawMode);
  const port = input.capture.createVoiceCapture({ mode: resolution.mode, log, audio: sink });
  // Annotated with the shipped contract, so a factory whose surface drifted reds here rather than at
  // the first reading that reads a field off a result.
  const service: VoiceService = input.createService({
    defaults: DEFAULTS,
    timeoutMs: 5_000,
    fetchBackend,
    logger: log,
    capture: port,
  });

  const attempts: Attempt[] = [];
  const rowTexts: string[] = [];
  const attemptLines: string[] = [];

  for (const step of input.steps) {
    const callsBefore = calls.length;
    const from = lines.length;
    const result = await service.transcribe({
      audio: step.upload,
      overrides: input.overrides,
      settings: input.settings,
    });
    const window = lines.slice(from);
    const rowLines = window.filter((line) => parseCaptureRow(line) !== null);
    const attemptWindow = window.filter((line) => parseCaptureRow(line) === null);
    rowTexts.push(...rowLines);
    attemptLines.push(...attemptWindow);
    attempts.push({
      step,
      lines: window,
      attemptLines: attemptWindow,
      rowLines,
      rows: rowLines.map((line) => parseCaptureRow(line) as Record<string, unknown>),
      allRowsParse: rowLines.every(isSingleLineJson),
      callsBefore,
      callsAfter: calls.length,
      result: { ok: result.ok, status: result.ok ? 200 : result.status },
    });
  }

  return {
    name: input.name,
    resolverInput: input.rawMode,
    mode: resolution.mode,
    lines,
    attempts,
    rowTexts,
    attemptLines,
    captureLines: rowTexts.length,
    writeAudioCalls,
    parentEntries: [],
    dirCreated: false,
    calls,
    answersLeft: answers.length,
  };
}

/**
 * THE measurement: both arms, the filesystem footprint, the positive control and the two self-scans.
 *
 * The temp parents are SEPARATE, and that is the whole reason the control proves anything: the
 * harness's parent must come back empty while a sink of the same shape, reached in `audio` mode,
 * really creates the configured directory and really writes a file. Sharing one parent would make
 * the two readings collide — the control's own directory would be an entry in the count that is
 * supposed to be zero.
 */
async function measure(modules: CriterionModules): Promise<Measurement> {
  const servicePath = modules.service ?? SHIPPING_SERVICE_MODULE;
  const capturePath = modules.capture ?? SHIPPING_CAPTURE_MODULE;

  // THE REGISTRY FIRST, THEN THE ADAPTER. The adapter's module body reads declarations the registry
  // publishes, so importing the adapter into an uninitialised registry is a TDZ error rather than an
  // empty list; the registry's own graph evaluates the adapter, so after this import it is complete.
  await import(pathToFileURL(REGISTRY_MODULE).href);
  const adapter = (await import(pathToFileURL(ADAPTER_MODULE).href)) as AdapterModule;
  const serviceModule = (await import(pathToFileURL(servicePath).href)) as {
    createVoiceService: typeof createVoiceService;
  };
  const capture = (await import(pathToFileURL(capturePath).href)) as CaptureModule;

  const undeclaredMime = pickUndeclaredMime(adapter.capabilities.acceptsMime);
  const limit = capture.RAW_RETURN_LIMIT_BYTES;
  const { steps, bodies } = buildPlan({ limit, undeclaredMime });
  const settings = settingsFor();
  // The settings page sends the shared backend's model on every transcribe, so the override carries
  // it too — the strongest form of "that id did not reach this provider's row".
  const overrides: VoiceRequestOverrides = { providerId: adapter.id, sttModel: DEFAULTS.sttModel };

  const parent = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-text-criterion-'));
  const controlParent = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-text-control-'));
  try {
    process.env.VOICE_CAPTURE_DIR = path.join(parent, 'recordings');
    process.env.DATABASE_PATH = path.join(parent, 'auth.db');

    process.env.VOICE_CAPTURE = 'text';
    const text = await runArm({
      name: 'text',
      rawMode: process.env.VOICE_CAPTURE,
      capture,
      createService: serviceModule.createVoiceService,
      steps,
      settings,
      overrides,
    });

    // The control arm: the SAME harness with the variable gone. `process.env` is read back for the
    // argument, so this is the value the process carries rather than a second literal.
    delete process.env.VOICE_CAPTURE;
    const off = await runArm({
      name: 'off',
      rawMode: process.env.VOICE_CAPTURE,
      capture,
      createService: serviceModule.createVoiceService,
      steps,
      settings,
      overrides,
    });

    // Measured once, after all eight attempts, and reported on both arms because the reading is about
    // the whole run rather than about one of its halves.
    const parentEntries = readdirSync(parent);
    const dirCreated = existsSync(process.env.VOICE_CAPTURE_DIR);
    for (const arm of [text, off]) {
      arm.parentEntries = parentEntries;
      arm.dirCreated = dirCreated;
    }

    // ── the positive control: the same sink shape, reached. Without it, `writeAudioCalls=0` would
    // read exactly the same against a sink that could not write at all.
    process.env.VOICE_CAPTURE_DIR = path.join(controlParent, 'recordings');
    let controlWriteCalls = 0;
    const controlPort = capture.createVoiceCapture({
      mode: 'audio',
      log: { info: (): void => {} },
      audio: {
        resolveDirectory: (): string =>
          capture.resolveVoiceCaptureDir(process.env.VOICE_CAPTURE_DIR, process.env.DATABASE_PATH),
        writeAudio: (directory: string, captureId: string, audio: VoiceCaptureAudio): string => {
          controlWriteCalls += 1;
          mkdirSync(directory, { recursive: true });
          const target = path.join(directory, `${captureId}-${audio.fileName}`);
          writeFileSync(target, audio.bytes);
          return target;
        },
      },
    });
    controlPort.recordAttempt('control-1', {
      providerId: adapter.id,
      outcome: 'ok',
      status: 200,
      audio: AUDIO,
    });
    const controlDir = process.env.VOICE_CAPTURE_DIR;
    const control = {
      dirCreated: existsSync(controlDir),
      filesWritten: existsSync(controlDir) ? readdirSync(controlDir).length : 0,
      writeAudioCalls: controlWriteCalls,
    };

    return {
      text,
      off,
      adapter: {
        id: adapter.id,
        defaultModel: adapter.DEFAULT_MODEL,
        jsonTask: adapter.JSON_TASK,
        acceptsMime: adapter.capabilities.acceptsMime,
        audioBase64: adapter.base64Encode(AUDIO_BYTES),
      },
      bodies,
      undeclaredMime,
      limit,
      handRolledRow: handRolledRow(),
      doors: openDoors(),
      control,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(controlParent, { recursive: true, force: true });
  }
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (measurement: Measurement) => Measured };

/** One attempt by case name; a missing attempt is a rig failure rather than a green reading. */
function attemptNamed(arm: Arm, name: string): Attempt {
  const found = arm.attempts.find((entry) => entry.step.name === name);
  if (found === undefined) {
    throw new Error(`the ${arm.name} arm ran no attempt named ${name}`);
  }
  return found;
}

/**
 * One attempt's row by index, or an EMPTY row.
 *
 * EMPTY RATHER THAN A THROW, and that is deliberate: a reading that threw would report its failure
 * without the figures it is about, and the falsifying file reads those figures to say WHICH part of a
 * reading a mutation broke. An absent row makes every field of it read as absent, which is what a
 * missing row means.
 */
function rowAt(attempt: Attempt, index: number): Record<string, unknown> {
  return attempt.rows[index] ?? {};
}

/** A figure that is printed as `(none)` when absent, so a log line never ends at an empty `=`. */
function shown(value: string): string {
  return value === '' ? '(none)' : value;
}

/** The six branches, as the AC names them. Spelled here because the AC spells them. */
const CLOSED_BRANCHES: readonly string[] = [
  'written',
  'verbatim-fallback',
  'no-speech',
  'envelope-error',
  'upstream-failure',
  'preflight-refused',
];

const READINGS: readonly Reading[] = [
  // ── AC2: the mode the process came up in, and the control arm that makes the zero a reading ────
  {
    name: 'AC2 mode resolution and the two arms',
    run: (measurement) => {
      const raw = measurement.text.resolverInput;
      return {
        value:
          `resolverInput=${raw === undefined ? '(unset)' : raw} mode=${measurement.text.mode} ` +
          `off.mode=${measurement.off.mode} off.captureLines=${measurement.off.captureLines} ` +
          `text.captureLines=${measurement.text.captureLines} ` +
          `attempts=${measurement.text.attempts.length} handRolledRow=${measurement.handRolledRow}`,
        ok:
          raw === 'text' &&
          measurement.text.mode === 'text' &&
          measurement.off.mode === 'off' &&
          measurement.off.captureLines === 0 &&
          // The positive control for that zero: the same harness in the other mode records one row
          // per attempt, so an `off` arm that recorded nothing cannot be green by having no port.
          measurement.text.captureLines === measurement.text.attempts.length &&
          measurement.text.attempts.length === 8 &&
          !measurement.handRolledRow,
      };
    },
  },

  // ── AC3: the written attempt's row, field by field ─────────────────────────────────────────────
  {
    name: 'AC3 the written attempt, row for row',
    run: (measurement) => {
      const attempt = attemptNamed(measurement.text, 'written');
      const row = rowAt(attempt, 0);
      const upstream = fieldObject(row, 'upstream');
      const attemptLine = attempt.attemptLines[0] ?? '';
      const rowLine = attempt.rowLines[0] ?? '';
      const id = fieldString(row, 'captureId');
      // The row is tied to THIS attempt's line rather than to any line: the id on the attempt line is
      // the row's id, and the row is the line immediately after it.
      const idMatch = id !== '' && attemptLine.includes(`captureId=${id}`);
      const adjacent = attempt.lines.indexOf(rowLine) === attempt.lines.indexOf(attemptLine) + 1;
      const model = fieldString(row, 'model');
      const modelFromAdapterDefault = model === measurement.adapter.defaultModel && model !== DEFAULTS.sttModel;
      const host = fieldString(row, 'host');
      const hostIsHostname = host === ENDPOINT_HOST && !host.includes('://') && !host.includes('/');
      const bytes = row.bytes;
      const sha = fieldString(row, 'sha256');
      const sha256Match = sha === createHash('sha256').update(AUDIO_BYTES).digest('hex');
      const rawVerbatim = upstream.body === measurement.bodies.written;
      const truncatedAbsent = keyAbsent(row, 'truncated');
      const branch = fieldString(row, 'branch');
      const text = fieldString(row, 'text');
      return {
        value:
          `idMatch=${idMatch} adjacent=${adjacent} providerId=${shown(fieldString(row, 'providerId'))} ` +
          `model=${shown(model)} modelFromAdapterDefault=${modelFromAdapterDefault} ` +
          `host=${shown(host)} hostIsHostname=${hostIsHostname} mime=${shown(fieldString(row, 'mime'))} ` +
          `bytes=${String(bytes)} sha256Match=${sha256Match} ` +
          `upstream.status=${String(upstream.status)} rawVerbatim=${rawVerbatim} ` +
          `truncatedAbsent=${truncatedAbsent} branch=${shown(branch)} text=${JSON.stringify(text)}`,
        ok:
          attempt.rowLines.length === 1 &&
          attempt.allRowsParse &&
          idMatch &&
          adjacent &&
          fieldString(row, 'providerId') === measurement.adapter.id &&
          modelFromAdapterDefault &&
          hostIsHostname &&
          fieldString(row, 'mime') === AUDIO.mimeType &&
          bytes === AUDIO_BYTES.length &&
          sha256Match &&
          upstream.status === 200 &&
          rawVerbatim &&
          truncatedAbsent &&
          branch === 'written' &&
          text === INSTRUCTION,
      };
    },
  },

  // ── AC4: a refused attempt's row carries the upstream's own answer ─────────────────────────────
  {
    name: 'AC4 the refused attempt keeps the upstream own answer',
    run: (measurement) => {
      const attempt = attemptNamed(measurement.text, 'upstream-404');
      const row = rowAt(attempt, 0);
      const upstream = fieldObject(row, 'upstream');
      const rawVerbatim = upstream.body === measurement.bodies.fail;
      const branch = fieldString(row, 'branch');
      return {
        value:
          `failRow=${attempt.rows.length} fail.status=${String(upstream.status)} ` +
          `fail.rawVerbatim=${rawVerbatim} fail.branch=${shown(branch)} ` +
          `result.ok=${attempt.result.ok} result.status=${attempt.result.status}`,
        ok:
          attempt.rows.length === 1 &&
          attempt.allRowsParse &&
          upstream.status === 404 &&
          rawVerbatim &&
          branch === 'upstream-failure' &&
          attempt.result.ok === false &&
          attempt.result.status === 404,
      };
    },
  },

  // ── AC5: the refusal that costs nothing still tells the row what it was about ──────────────────
  {
    name: 'AC5 the preflight refusal costs no request and still tells the row',
    run: (measurement) => {
      const attempt = attemptNamed(measurement.text, 'undeclared-mime');
      const row = rowAt(attempt, 0);
      const branch = fieldString(row, 'branch');
      return {
        value:
          `preflightRow=${attempt.rows.length} preflight.mime=${shown(fieldString(row, 'mime'))} ` +
          `upstreamNull=${row.upstream === null} preflight.branch=${shown(branch)} ` +
          `stubCallsUnchanged=${attempt.callsBefore === attempt.callsAfter} ` +
          `preflight.captureId=${shown(fieldString(row, 'captureId'))} ` +
          `preflight.providerId=${shown(fieldString(row, 'providerId'))} ` +
          `preflight.model=${shown(fieldString(row, 'model'))} ` +
          `preflight.host=${shown(fieldString(row, 'host'))} ` +
          `preflight.bytes=${String(row.bytes)} preflight.sha256=${shown(String(row.sha256))}`,
        ok:
          attempt.rows.length === 1 &&
          attempt.allRowsParse &&
          fieldString(row, 'mime') === measurement.undeclaredMime &&
          row.upstream === null &&
          branch === 'preflight-refused' &&
          attempt.callsBefore === attempt.callsAfter &&
          fieldString(row, 'captureId') !== '' &&
          fieldString(row, 'providerId') === measurement.adapter.id &&
          fieldString(row, 'model') === measurement.adapter.defaultModel &&
          fieldString(row, 'host') === ENDPOINT_HOST &&
          typeof row.bytes === 'number' &&
          typeof row.sha256 === 'string' &&
          row.sha256 !== '',
      };
    },
  },

  // ── AC6: the other three branches, and the closed set they complete ───────────────────────────
  {
    name: 'AC6 the three answers a reachable service can end as',
    run: (measurement) => {
      const names = ['empty-instruction', 'empty-both', 'not-an-envelope'] as const;
      const branches = names.map((name) => fieldString(rowAt(attemptNamed(measurement.text, name), 0), 'branch'));
      const cases = names.map(
        (name, index) => `case=${name} branch=${shown(branches[index] ?? '')}`,
      );
      // The six this run has now observed: the three above, in the order the plan drives them.
      const observed = [
        fieldString(rowAt(attemptNamed(measurement.text, 'written'), 0), 'branch'),
        fieldString(rowAt(attemptNamed(measurement.text, 'upstream-404'), 0), 'branch'),
        fieldString(rowAt(attemptNamed(measurement.text, 'undeclared-mime'), 0), 'branch'),
        ...branches,
      ];
      const distinct = [...new Set(observed)];
      const missing = CLOSED_BRANCHES.filter((branch) => !distinct.includes(branch));
      return {
        value:
          `${cases.join(' ')} branches=${observed.length} distinct=${distinct.length} ` +
          `[${distinct.join(' ')}] missing=[${missing.join(' ')}]`,
        ok:
          branches[0] === 'verbatim-fallback' &&
          branches[1] === 'no-speech' &&
          branches[2] === 'envelope-error' &&
          observed.length === CLOSED_BRANCHES.length &&
          // Pairwise distinct AND exactly the six the vocabulary names: a count alone would be green
          // for six attempts that ended as three branches twice over.
          distinct.length === CLOSED_BRANCHES.length &&
          missing.length === 0,
      };
    },
  },

  // ── AC7: the cut, read from both ends ─────────────────────────────────────────────────────────
  {
    name: 'AC7 the 64KB cut, read from both ends',
    run: (measurement) => {
      const overRow = rowAt(attemptNamed(measurement.text, 'over-limit'), 0);
      const atRow = rowAt(attemptNamed(measurement.text, 'at-limit'), 0);
      const overUpstream = fieldObject(overRow, 'upstream');
      const atUpstream = fieldObject(atRow, 'upstream');
      const overBody = typeof overUpstream.body === 'string' ? overUpstream.body : '';
      const bodyBytes = Buffer.byteLength(overBody, 'utf8');
      // The prefix property, computed from the answer the stand-in gave rather than from the row: the
      // cut body must be the ORIGINAL's first `limit` bytes, not a re-serialisation of it.
      const prefix = Buffer.from(measurement.bodies.over, 'utf8')
        .subarray(0, measurement.limit)
        .toString('utf8');
      const prefixOk = overBody === prefix;
      const flag = overUpstream.truncated === true;
      const verbatim = atUpstream.body === measurement.bodies.atLimit;
      const flagAbsent = keyAbsent(atRow, 'truncated');
      return {
        value:
          `limit=${measurement.limit} over.bodyBytes=${bodyBytes} over.prefix=${prefixOk} ` +
          `over.flag=${flag} atLimit.verbatim=${verbatim} atLimit.flagAbsent=${flagAbsent} ` +
          `over.sourceBytes=${Buffer.byteLength(measurement.bodies.over, 'utf8')} ` +
          `atLimit.sourceBytes=${Buffer.byteLength(measurement.bodies.atLimit, 'utf8')}`,
        ok:
          // The fixtures themselves, first: a reading about a cut at 70000 B means nothing if the
          // answer was not 70000 B, and the same body would red here rather than silently pass.
          Buffer.byteLength(measurement.bodies.over, 'utf8') === OVER_LIMIT_BYTES &&
          Buffer.byteLength(measurement.bodies.atLimit, 'utf8') === measurement.limit &&
          bodyBytes === measurement.limit &&
          prefixOk &&
          flag &&
          verbatim &&
          flagAbsent,
      };
    },
  },

  // ── AC8: the row carries nothing of the request, and the wire carried all of it ────────────────
  {
    name: 'AC8 the wire carries the request and the row does not',
    run: (measurement) => {
      const calls = [...measurement.text.calls, ...measurement.off.calls];
      const rowTexts = measurement.text.rowTexts;
      const wireKey = calls.some((call) => authorizationOf(call.init) === `Bearer ${KEY_SENTINEL}`);
      // The prompt is read live off the adapter and looked for in BOTH spellings: `JSON_TASK` carries
      // a quote and a brace, so inside a serialised body its quote arrives escaped.
      const wirePrompt =
        wireCarried(calls, measurement.adapter.jsonTask) ||
        wireCarried(calls, JSON.stringify(measurement.adapter.jsonTask).slice(1, -1));
      const wireAudio = wireCarried(calls, measurement.adapter.audioBase64);
      const secrets = [KEY_SENTINEL, 'Bearer', 'Authorization', 'Content-Type', 'x-voice-stt-model'];
      const rowCarriesSecret = rowTexts.some((text) => secrets.some((token) => text.includes(token)));
      const rowCarriesPrompt = rowTexts.some((text) => text.includes(measurement.adapter.jsonTask));
      const rowCarriesUpload = rowTexts.some((text) => text.includes(AUDIO_SENTINEL));
      return {
        value:
          `wireCarriedKey=${wireKey} wireCarriedPrompt=${wirePrompt} wireCarriedAudio=${wireAudio} ` +
          `rowCarriesSecret=${rowCarriesSecret} rowCarriesPrompt=${rowCarriesPrompt} ` +
          `rowCarriesUpload=${rowCarriesUpload} rows=${rowTexts.length} calls=${calls.length}`,
        ok:
          // The three positives are what keep the three negatives from being a filter that matches
          // nothing: the same tokens ARE on the wire, so a row that carried them would.
          wireKey &&
          wirePrompt &&
          wireAudio &&
          rowTexts.length > 0 &&
          !rowCarriesSecret &&
          !rowCarriesPrompt &&
          !rowCarriesUpload,
      };
    },
  },

  // ── AC9: nothing was written, and the sink that would have written is real ─────────────────────
  {
    name: 'AC9 no directory and no bytes, against a sink that writes',
    run: (measurement) => ({
      value:
        `dirCreated=${measurement.text.dirCreated} filesWritten=${measurement.text.parentEntries.length} ` +
        `writeAudioCalls=${measurement.text.writeAudioCalls} ` +
        `control.dirCreated=${measurement.control.dirCreated} ` +
        `control.filesWritten=${measurement.control.filesWritten} ` +
        `control.writeAudioCalls=${measurement.control.writeAudioCalls}`,
      ok:
        !measurement.text.dirCreated &&
        measurement.text.parentEntries.length === 0 &&
        measurement.text.writeAudioCalls === 0 &&
        measurement.off.writeAudioCalls === 0 &&
        // The control: the same sink shape, reached once in `audio` mode, really created the
        // configured directory and really wrote one file into it.
        measurement.control.dirCreated &&
        measurement.control.filesWritten === 1 &&
        measurement.control.writeAudioCalls === 1,
    }),
  },

  // ── AC12: what this criterion covered, registered rather than asserted in prose ────────────────
  {
    name: 'AC12 registration',
    run: (measurement) => {
      const queued = measurement.text.attempts.filter((attempt) => attempt.step.answer !== null).length;
      return {
        value:
          'scope=[text mode`s payload only: the upstream raw return copy, the actual model, the ' +
          'hostname, mime/bytes/sha256, the result branch, the returned text, the preflight-refused ' +
          'row, the 64KB cut] out-of-scope=[audio mode and its file write, a secrets criterion, ' +
          'capture-failure isolation, any real-process reading] fixtures=[stand-in fetchBackend, ' +
          'injected log port, injected write-audio sink, used only as the control] truth=[this ' +
          'criterion only does the text payload: every reading above ran against a stand-in ' +
          'transport and an injected log port, nothing reached a real upstream, no process was ' +
          'started, and nothing was written except the control`s own recording, reported here] ' +
          `transport-calls=${measurement.text.calls.length}/${queued} ` +
          `off-transport-calls=${measurement.off.calls.length}/${queued} ` +
          `socket-doors=${measurement.doors.length} control-writes=${measurement.control.writeAudioCalls}`,
        ok:
          // Both arms drove the identical plan, and exactly the attempts that should reach a
          // transport did — one answer per attempt, none left over, and none consumed by the
          // attempt that must be refused before the transport.
          measurement.text.calls.length === queued &&
          measurement.off.calls.length === queued &&
          measurement.text.answersLeft === 0 &&
          measurement.off.answersLeft === 0 &&
          measurement.doors.length === 0 &&
          !measurement.text.dirCreated &&
          measurement.text.writeAudioCalls === 0,
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
 */
export async function collectReadings(modules: CriterionModules = {}): Promise<ReadingOutcome[]> {
  const measurement = await measure(modules);

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
  const readingsOnce = (): Promise<ReadingOutcome[]> => (measuredOnce ??= collectReadings());

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
