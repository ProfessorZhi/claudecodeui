/**
 * The three capture modes × two providers × two outcomes, and the four secrets that must not survive.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. Three sibling criteria read the capture channel's SHAPE —
 * `voice-capture-off.test.ts` the mode resolution and the gate, `voice-capture-text.test.ts` the text
 * row's fields, `voice-capture-audio.test.ts` the file's bytes and permissions — and all three
 * deliberately left this half out: nothing yet reads whether the values that went OUT on the wire are
 * absent from every surface the capture channel writes. This file is that reading, and it is the only
 * file that claims it.
 *
 * THE SUBJECT IS A DISCRIMINATION, NOT AN ABSENCE. "The key is not in the log" is worth nothing unless
 * the key was in the process and went out — a criterion that never sent a credential would report the
 * same zero. So every arm drives a stand-in transport that records what it received, and the same run
 * that reports `logHits=0` reports `keySent=true authorizationLength=<n>` for the same attempt. The
 * four needle families and the four places they must not appear:
 *
 *   · `dashscope-key` — `settings.dashscopeApiKey`, the credential `dashscope-omni` is reached with;
 *   · `shared-key` — ONE sentinel string put into BOTH `defaults.apiKey` and `settings.apiKey`, so
 *     whichever of `resolveVoiceConfig`'s two priorities wins reads the same value;
 *   · `bearer-form` — `Bearer ` + each of the two, the shape the credential actually takes on the wire;
 *   · `audio-base64` — the encoded upload, which only the `dashscope-omni` line ever carries.
 *
 * and the surfaces: the injected log port, a `console` probe over the five methods a deployment's
 * default logger is, every file's BYTES under the capture directory, and every capture file's NAME.
 *
 * THE UPLOAD'S BYTES ARE CHOSEN SO ITS BASE64 IS A LEGAL FILE NAME. Every byte of `AUDIO_BYTES` is at
 * most 61 — digits, `-`, `:` — and base64 emits a sextet's own value for the fourth character of each
 * group, so a sextet can never reach 62 (`+`) or 63 (`/`). That is what lets the same scan function be
 * pointed at a file's name and at a file's bytes without one of the two silently finding nothing. It
 * is also why the length is ≥ 192: the encoding is then ≥ 256 characters, so a hit cannot be a
 * coincidence. (256 is one character past `NAME_MAX`, so the name surface is exercised by the three
 * short families and reported as unavailable for this one — see the AC8 reading.)
 *
 * HOW IT IS DRIVEN. Three arms, one per `VOICE_CAPTURE` value, each driven through the SHIPPING mode
 * resolver, the SHIPPING port constructor and the SHIPPING write-audio sink, and each carrying the RAW
 * environment value the process holds. Every arm runs the same four attempts — `openai-compatible`
 * (the shared backend, multipart) and `dashscope-omni` (its own stored credential, JSON), each once
 * answering and once refusing — through one stand-in transport. Both providers' requests are built by
 * their own adapters; nothing here hardcodes a wire.
 *
 * FALSIFYING FORMS LIVE IN `voice-capture-secrets.false-forms.test.ts`, and the readings are collected
 * by an exported function so that file can run THIS list against a mutated copy of `voice-capture.ts`.
 * Registering the readings as `node:test` cases is guarded by `IS_ENTRY`, so importing this file
 * registers nothing.
 *
 * WHAT THIS FILE DOES NOT COVER (registered in the `AC11 registration` reading rather than left to a
 * reader to notice): the audio file's byte-for-byte contents and permissions, the text row's field
 * set and truncation, the `off` mode's byte-for-byte baseline, capture-failure isolation, and any real
 * process reading. `multimodal` is registered but not driven. The `console` probe covers five methods
 * and is not an enumeration of the process's stderr.
 */

import assert from 'node:assert/strict';
import {
  existsSync,
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
  VoiceService,
  VoiceSettings,
} from '@/shared/types.js';
import type {
  VoiceCaptureAttempt,
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

/** The shipping service module: what this criterion drives, and the mutation cases' reading list. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping capture module: the resolver, the port, the sink and the payload builder. */
export const SHIPPING_CAPTURE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice-capture.ts');

/**
 * The registry, imported BEFORE the adapters below.
 *
 * An adapter's module body reads declarations the registry publishes, so importing an adapter into an
 * uninitialised registry is a TDZ error rather than an empty list. Importing the registry by path
 * resolves to the same file URL the service's own relative specifier does, so this is the same module
 * instance the service under test sees.
 */
const REGISTRY_MODULE = path.resolve(SERVER_DIR, '../shared/asr/asrRegistry.ts');
/** The two adapters this criterion drives, by the ids the registry publishes for them. */
const ADAPTER_MODULES: Readonly<Record<string, string>> = {
  'openai-compatible': path.resolve(
    SERVER_DIR,
    '../shared/asr/list/openai-compatible/openai-compatible.asr-provider.ts',
  ),
  'dashscope-omni': path.resolve(
    SERVER_DIR,
    '../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
  ),
};

/** This file, read as text by the door scan and by the hand-rolled-row scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 8;

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

/** Run-unique, so a reading about "this value is not on a capture surface" is about THIS run's value. */
const RUN_TAG = `${process.pid}-${Date.now()}`;

/** The credential `dashscope-omni` is reached with: the user's own stored field. */
const DASHSCOPE_KEY = `dashscope-key-${RUN_TAG}`;
/**
 * The credential the shared backend is reached with.
 *
 * THE SAME STRING IN TWO PLACES, on purpose: `resolveVoiceConfig` reads `overrides.apiKey` then
 * `defaults.apiKey`, and `resolveRecognitionConfig` reads the provider's stored field then that. A
 * sentinel that only occupied one of the two slots would leave the other free to be the value the
 * request actually carried, and the reading would then be about the wrong string. `AC3` reports that
 * both slots hold it, as booleans — see `sharedKeySlots`.
 */
const SHARED_KEY = `shared-key-${RUN_TAG}`;

/** The upload's own sentinel, folded into bytes that encode to a path-safe base64. */
const AUDIO_SENTINEL = `audio-${RUN_TAG}`;

/**
 * The upload's bytes: ≥ 192 of them, every one at most 61.
 *
 * Digits, `-` and `:` are the whole alphabet, which is what makes `AUDIO_BASE64` free of `+` and `/`
 * and therefore usable as a file NAME as well as file content in the AC8 probe. See the header.
 */
const AUDIO_BYTES = Buffer.from(`${AUDIO_SENTINEL}:${'1'.repeat(200)}`, 'utf8');

/** The encoded upload: the one needle that only the `dashscope-omni` line ever carries. */
const AUDIO_BASE64 = AUDIO_BYTES.toString('base64');

const AUDIO: VoiceCaptureAudio = {
  bytes: AUDIO_BYTES,
  mimeType: 'audio/webm',
  fileName: 'clip.webm',
};
const AUDIO_UPLOAD: VoiceAudioUpload = {
  bytes: AUDIO_BYTES,
  mimeType: AUDIO.mimeType,
  fileName: AUDIO.fileName,
};

/** A workspace address `dashscope-omni`'s own endpoint rule accepts. */
const ENDPOINT = 'https://llm-szunnpxbx46k86c0.cn-beijing.maas.aliyuncs.com';

/** The deployment shape every arm is driven with. See `SHARED_KEY` for why the key is in both slots. */
const DEFAULTS = {
  baseUrl: 'https://voice.example/v1',
  apiKey: SHARED_KEY,
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** The settings document every attempt is driven with: the user's own stored credential. */
function settingsFor(): VoiceSettings {
  return {
    baseUrl: '',
    apiKey: SHARED_KEY,
    sttModel: '',
    ttsModel: '',
    ttsVoice: '',
    ttsFormat: '',
    dashscopeEndpoint: ENDPOINT,
    dashscopeApiKey: DASHSCOPE_KEY,
    dashscopeModel: '',
  };
}

/** The two providers this criterion drives, in the order the plan runs them. */
const PROVIDERS = ['openai-compatible', 'dashscope-omni'] as const;
/** The two outcomes, one of each per provider: the answering attempt and the refusing one. */
const OUTCOMES = ['ok', 'fail'] as const;

/** The bodies the stand-in answers with. Neither carries a needle. */
const OK_BODY = JSON.stringify({
  text: 'transcribed',
  choices: [{ message: { content: '{"transcript":"x","instruction":"y"}' } }],
});
const FAIL_BODY = '{"error":{"code":"InvalidParameter","message":"model not found"}}';
const FAIL_STATUS = 404;

/** A provider id the registry does not publish, so a refusal happens before any transport. */
const UNREGISTERED_PROVIDER_ID = 'zz-not-a-registered-provider';

/** The modes, one per arm, spelled in the order the readings report them. */
const MODES = ['off', 'text', 'audio'] as const;

/**
 * Whether the shared sentinel really occupies both slots, and whether they hold the same string.
 *
 * THE VALUE IS NEVER PRINTED, and that is why this returns booleans and a length rather than a
 * "masked form": `maskSettingsForReadback` masks the provider-DECLARED credential fields, and the
 * shared slot is not one of them, so the masked form of this slot IS the value. Reporting the two
 * slots by identity and the sentinel by length says everything the reading needs — that whichever
 * priority `resolveVoiceConfig` takes reads the same string the wire readings are about — without
 * putting a credential into this criterion's own output.
 */
function sharedKeySlots(): { defaults: boolean; settings: boolean; same: boolean; length: number } {
  const inDefaults = DEFAULTS.apiKey === SHARED_KEY;
  const inSettings = settingsFor().apiKey === SHARED_KEY;
  return {
    defaults: inDefaults,
    settings: inSettings,
    same: inDefaults && inSettings && DEFAULTS.apiKey === settingsFor().apiKey,
    length: SHARED_KEY.length,
  };
}

// ── the needle families ───────────────────────────────────────────────────────────────────────

/** One family of needles: a name for the readings, and the strings it is made of. */
type NeedleFamily = { name: string; needles: readonly string[] };

/**
 * The four families, and THE list every surface is scanned with.
 *
 * A family rather than a flat list because the bearer forms share a name: `Bearer ` + each of the two
 * keys is one family of two strings, which is what the task's own words call it. Every count below is
 * a count of occurrences, so a surface that carries `Bearer <key>` scores for both the key's family
 * and the bearer family — which is correct: those are two forms of the same disclosure.
 */
const NEEDLE_FAMILIES: readonly NeedleFamily[] = [
  { name: 'dashscope-key', needles: [DASHSCOPE_KEY] },
  { name: 'shared-key', needles: [SHARED_KEY] },
  { name: 'bearer-form', needles: [`Bearer ${DASHSCOPE_KEY}`, `Bearer ${SHARED_KEY}`] },
  { name: 'audio-base64', needles: [AUDIO_BASE64] },
];

/** How many times `pattern` occurs in `haystack`, without consuming the overlap it sits in. */
function countOccurrences(haystack: Buffer, pattern: Buffer): number {
  if (pattern.length === 0) {
    return 0;
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(pattern, from);
    if (at < 0) {
      return count;
    }
    count += 1;
    from = at + 1;
  }
}

/**
 * THE scan: how many needle occurrences one surface carries, byte for byte.
 *
 * ONE FUNCTION FOR EVERY SURFACE, which is the point of the AC8 probe: the reading that says a real
 * log line carries nothing is only worth as much as the reading that says the same function finds a
 * needle in a synthetic line. A string is scanned by encoding it, so a log line, a file name and a
 * file's bytes all go through this same comparison and none of the three gets a weaker one.
 */
function scan(surface: Uint8Array | string): number {
  const haystack = typeof surface === 'string' ? Buffer.from(surface, 'utf8') : Buffer.from(surface);
  let hits = 0;
  for (const family of NEEDLE_FAMILIES) {
    for (const needle of family.needles) {
      hits += countOccurrences(haystack, Buffer.from(needle, 'utf8'));
    }
  }
  return hits;
}

/** The same scan, restricted to one family — what the AC8 probe reports per family. */
function scanFamily(surface: Uint8Array | string, family: NeedleFamily): number {
  const haystack = typeof surface === 'string' ? Buffer.from(surface, 'utf8') : Buffer.from(surface);
  let hits = 0;
  for (const needle of family.needles) {
    hits += countOccurrences(haystack, Buffer.from(needle, 'utf8'));
  }
  return hits;
}

// ── the contract between this file and a mutated copy ─────────────────────────────────────────

/** The modules under test. A bare string is shorthand for the CAPTURE module, which is the mutant. */
export type CriterionModules = { service?: string; capture?: string };

/** One reading's outcome, as the falsifying file reads them. */
export type ReadingOutcome = { name: string; value: string; ok: boolean };

/** The resolved module paths, with the shipping modules standing in for whatever was not named. */
function modulePaths(modules: CriterionModules | string): { service: string; capture: string } {
  const requested = typeof modules === 'string' ? { capture: modules } : modules;
  return {
    service: requested.service ?? SHIPPING_SERVICE_MODULE,
    capture: requested.capture ?? SHIPPING_CAPTURE_MODULE,
  };
}

// ── the shipped shapes, named as this file needs them ─────────────────────────────────────────

/** The capture module's surface, as this criterion reads it. */
type CaptureModule = {
  resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution;
  createVoiceCapture(dependencies: {
    mode: VoiceCaptureResolution['mode'];
    log: VoiceLogPort;
    audio?: VoiceCaptureAudioSink;
  }): VoiceCapturePort;
  createVoiceCaptureAudioSink(options: { directory: string }): VoiceCaptureAudioSink;
  resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string;
};

/** The service module's surface. */
type ServiceModule = {
  createVoiceService: typeof createVoiceService;
};

/** One answer the stand-in transport gives. */
type Answer = { status: number; body: string };

/** One of the four attempts an arm drives. */
type PlanEntry = { providerId: string; outcome: string; answer: Answer };

/** One recorded transport call: the address, the headers as sent, and the body's bytes. */
type RecordedCall = { url: string; headers: Record<string, string>; body: Buffer };

/** What the recorded call says about the four needle families' having crossed the wire. */
type Wire = {
  /** The `Authorization` header, verbatim `Bearer ` + the key this provider uses. */
  keySent: boolean;
  /** How long that header is. The VALUE is never printed — this is the reading that stands for it. */
  authorizationLength: number;
  /** Whether the body carries the encoded upload, verbatim. */
  base64Sent: boolean;
  /** Whether the body carries the upload's raw bytes, byte for byte. */
  rawBytesSent: boolean;
  /** The body's own length, so a reader can tell an empty body from an unforeseen one. */
  bodyBytes: number;
  /** How many transport calls this attempt made. Exactly one for every attempt in this plan. */
  calls: number;
};

/** One attempt's window over the collected lines, plus its wire and filesystem footprint. */
type Attempt = {
  plan: PlanEntry;
  /** Every line the injected log port received during this attempt, in order. */
  lines: string[];
  /** The parsed capture rows, in the order they appeared. */
  rows: Record<string, unknown>[];
  /** How many capture rows this attempt recorded. */
  captureLines: number;
  /** How many entries the capture directory held when this attempt finished. */
  filesAfter: number;
  /** How many entries it gained across this attempt. Zero in the modes that write nothing. */
  filesAdded: number;
  wire: Wire;
  result: { ok: boolean; status: number };
};

/** One arm: the mode it came up in, the four attempts, and the surfaces of the whole run. */
type Arm = {
  /** The mode the SHIPPING resolver answered with. */
  mode: string;
  /** The RAW value handed to it — read off the environment, never a literal. */
  resolverInput: string | undefined;
  lines: string[];
  /**
   * Every line the `console` probe received.
   *
   * INCLUDING the control attempt's line, which is the only one there in the modes that inject a log
   * port: see `Arm.control`, which is what keeps this figure from being a zero produced by the
   * harness rather than by the deployment.
   */
  consoleLines: string[];
  attempts: Attempt[];
  /** How many capture rows the arm recorded. */
  captureLines: number;
  /** The capture directory's entries when the run was over. */
  files: string[];
  /** Whether the configured capture directory exists at all. */
  dirExists: boolean;
  /** How many times the injected port was called. The `off` arm's reading is that this is zero. */
  portCalls: { newAttemptId: number; recordAttempt: number };
  /** How many times the injected write-audio sink was reached. */
  writeAudioCalls: number;
  /** The control attempt: a service with no logger and no port, and what the default one received. */
  control: { consoleLines: number; transportCalls: number };
  /** Needle occurrences on the two log faces. */
  logHits: number;
  consoleHits: number;
  /** Needle occurrences on the two capture-file faces. */
  byteHits: number;
  nameHits: number;
  /** The constructors the arm actually called, as `typeof` readings. */
  ctors: { port: string; sink: string; resolver: string };
};

/** Everything the readings need, measured once. */
type Measurement = {
  arms: Arm[];
  /** The registry's own ids, so "the unregistered id is unregistered" is a reading. */
  registeredIds: string[];
  /** Whether this file builds a capture row of its own. See `handRolledRow`. */
  handRolledRow: boolean;
  /** The modules this file imports that could open a socket or start a process. */
  doors: string[];
  /** The shipping files that carry the AC9 reachability seam, read off the tree. */
  seamFiles: string[];
  /**
   * Whether the SHIPPING payload builder leaves the seam's field out of the row it returns.
   *
   * THIS IS THE LOAD-BEARING HALF OF THE REGISTRATION. The seam puts the request's headers in reach of
   * the builder; the row is unchanged only because the builder's return literal does not name them.
   * Read as text rather than asserted in prose, so a form that started copying the field would move
   * this reading before it moved any needle count.
   */
  builderOmitsSeamField: boolean;
  /** Whether the payload builder's own RETURN literal mentions the field it must not write. */
  builderReturnMentionsSeamField: boolean;
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;

/**
 * The module specifiers this file must not import, assembled rather than spelled.
 *
 * A scan for a literal would match the scan's own text, so each candidate is built from parts and
 * never appears contiguously anywhere in the source. `express` and `multer` are on the list because
 * the request path's own criteria drive a router; a criterion that needed one to reach the service
 * would be testing the transport rather than the row.
 */
const FORBIDDEN_SPECIFIERS: readonly string[] = [
  specifier(['node:', 'child', '_process']),
  specifier(['node:', 'net']),
  specifier(['node:', 'http']),
  specifier(['node:', 'https']),
  specifier(['node:', 'dgram']),
  specifier(['node:', 'cluster']),
  specifier(['ex', 'press']),
  specifier(['mult', 'er']),
];

/** The doors THIS file has open, computed from its own text. */
function openDoors(): string[] {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return FORBIDDEN_SPECIFIERS.filter((candidate) => source.includes(candidate));
}

/** The event a capture row carries, assembled so the literal is not in this file's own text. */
const ROW_EVENT = ['voice', 'capture'].join('.');

/**
 * Whether this file builds a capture row of its own.
 *
 * TWO WAYS A ROW COULD ORIGINATE HERE, AND BOTH ARE SCANNED FOR. A row reaches the collected lines
 * through one mechanism — a call this file makes on a log port — so the first pattern is that call
 * with its method name assembled, because spelled out it would match the scan's own text. The second
 * is the row's event literal: a hand-rolled row could be handed to a port this file holds, so the
 * literal that would mark one is scanned for too, and it is why nothing in this file spells it.
 */
function handRolledRow(): boolean {
  const source = readFileSync(SELF_MODULE, 'utf8');
  return source.includes(`.${'in'}fo(`) || source.includes(ROW_EVENT);
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
  return record.event === ROW_EVENT ? record : null;
}

/** The capture directory's entries, or none when it does not exist. */
function currentFiles(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory) : [];
}

/** Needle occurrences across a list of files' bytes, and across their names. */
function fileFaces(
  directory: string,
  names: readonly string[],
): { byteHits: number; nameHits: number } {
  let byteHits = 0;
  let nameHits = 0;
  for (const name of names) {
    nameHits += scan(name);
    byteHits += scan(readFileSync(path.join(directory, name)));
  }
  return { byteHits, nameHits };
}

/**
 * The headers a recorded call carried, narrowed the same way on both sides of the seam.
 *
 * Written here rather than imported: the service's own narrowing is private, and a criterion that
 * borrowed it would be agreeing with the code under test about what a header is.
 */
function readHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined) {
    return {};
  }
  if (headers instanceof Headers) {
    const entries: Record<string, string> = {};
    headers.forEach((value, name) => {
      entries[name] = value;
    });
    return entries;
  }
  if (Array.isArray(headers)) {
    const entries: Record<string, string> = {};
    for (const pair of headers as unknown as readonly (readonly [string, string])[]) {
      entries[pair[0]] = pair[1];
    }
    return entries;
  }
  const entries: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    entries[name] = typeof value === 'string' ? value : value.join(', ');
  }
  return entries;
}

/**
 * A request body's bytes, whatever shape the adapter built it in.
 *
 * THE MULTIPART FORM IS THE ONE THAT MATTERS: `openai-compatible` posts a `FormData`, so its raw bytes
 * are only reachable by asking the platform to encode it the way it would have encoded it on the wire.
 * A `String(body)` would read `[object FormData]` and the `rawBytesSent` reading would be a false zero.
 */
async function serializeBody(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) {
    return Buffer.alloc(0);
  }
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (body instanceof FormData) {
    return Buffer.from(await new Response(body).arrayBuffer());
  }
  if (body instanceof URLSearchParams) {
    return Buffer.from(body.toString(), 'utf8');
  }
  return Buffer.from(String(body), 'utf8');
}

// ── the console probe ─────────────────────────────────────────────────────────────────────────

/** The five methods a deployment's default logger is: the whole of `console`'s line-writing surface. */
const CONSOLE_METHODS = ['info', 'warn', 'error', 'log', 'debug'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

/** The methods' identities BEFORE anything runs, so "the probe was restored" is decidable later. */
const ORIGINAL_CONSOLE: ReadonlyMap<ConsoleMethod, unknown> = new Map(
  CONSOLE_METHODS.map((method) => [method, console[method]] as const),
);

/** Whether every probed method is the function it was before this file ran. */
function consoleRestored(): boolean {
  return CONSOLE_METHODS.every((method) => console[method] === ORIGINAL_CONSOLE.get(method));
}

/**
 * Collects what the process's own output receives, for the duration of the caller's `try`.
 *
 * The shipping service's default logger IS `console` (`dependencies.logger ?? console`), so a
 * deployment that wires no port writes its attempt lines here. The probe covers all five methods the
 * AC names and is restored by the returned closure rather than at the end of the arm, so a throw
 * inside the window cannot leave the process writing into an array.
 */
function installConsoleProbe(sink: string[]): () => void {
  const originals: [ConsoleMethod, unknown][] = [];
  for (const method of CONSOLE_METHODS) {
    originals.push([method, console[method]]);
    (console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ): void => {
      sink.push(args.map((arg) => String(arg)).join(' '));
    };
  }
  return (): void => {
    for (const [method, original] of originals) {
      (console as unknown as Record<string, unknown>)[method] = original;
    }
  };
}

// ── the plan ──────────────────────────────────────────────────────────────────────────────────

/**
 * The four attempts every arm drives: each provider once answering and once refusing.
 *
 * THE ORDER IS THE CONTRACT WITH THE STAND-IN. The transport answers from a queue, so the plan is
 * built once and every arm drives the identical list — a re-ordered plan would still answer every
 * attempt, and the reading would be about a different pair of attempts than the table names.
 */
function buildPlan(): readonly PlanEntry[] {
  const entries: PlanEntry[] = [];
  for (const providerId of PROVIDERS) {
    for (const outcome of OUTCOMES) {
      entries.push({
        providerId,
        outcome,
        answer:
          outcome === 'ok' ? { status: 200, body: OK_BODY } : { status: FAIL_STATUS, body: FAIL_BODY },
      });
    }
  }
  return entries;
}

/** The key the given provider is reached with, as the service resolves it. */
function keyFor(providerId: string): string {
  return providerId === 'dashscope-omni' ? DASHSCOPE_KEY : SHARED_KEY;
}

/** What one attempt's recorded calls say about the four families having crossed the wire. */
function wireReadings(calls: readonly RecordedCall[], entry: PlanEntry): Wire {
  const first = calls[0];
  if (first === undefined) {
    return {
      keySent: false,
      authorizationLength: 0,
      base64Sent: false,
      rawBytesSent: false,
      bodyBytes: 0,
      calls: calls.length,
    };
  }
  const authorization = first.headers.Authorization ?? first.headers.authorization ?? '';
  return {
    keySent: authorization === `Bearer ${keyFor(entry.providerId)}`,
    authorizationLength: authorization.length,
    base64Sent: first.body.includes(AUDIO_BASE64),
    rawBytesSent: first.body.includes(AUDIO_BYTES),
    bodyBytes: first.body.length,
    calls: calls.length,
  };
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────

/**
 * Drives the four attempts through one arm and reports what every surface saw.
 *
 * THE ENVIRONMENT IS SET HERE, and the resolver's argument is read back off `process.env` rather than
 * passed as a literal: that is what makes `resolverInput` the value the process actually carries.
 *
 * BOTH PORTS COME FROM THE SHIPPING CONSTRUCTORS. The capture directory is resolved by the shipping
 * directory resolver (handed the environment's own text, because that is what the composition root
 * hands it), the sink is the shipping sink built around that answer, and the port is the shipping port
 * built for the mode the shipping resolver answered with. The two wrappers DELEGATE every call and
 * count one of them: what the service is handed is the shipping behaviour with a counter beside it,
 * not a second implementation this file could agree with itself about.
 */
async function runArm(input: {
  mode: string;
  captureDir: string;
  capture: CaptureModule;
  service: ServiceModule;
  plan: readonly PlanEntry[];
  settings: VoiceSettings;
}): Promise<Arm> {
  process.env.VOICE_CAPTURE = input.mode;
  process.env.VOICE_CAPTURE_DIR = input.captureDir;

  const lines: string[] = [];
  const log: VoiceLogPort = {
    info: (message: string): void => {
      lines.push(message);
    },
  };

  const calls: RecordedCall[] = [];
  const answers: Answer[] = input.plan.map((entry) => entry.answer);
  const fetchBackend = async (url: string, options: RequestInit): Promise<Response> => {
    const body = await serializeBody(options.body);
    calls.push({ url: String(url), headers: readHeaders(options.headers), body });
    const answer = answers.shift();
    if (answer === undefined) {
      throw new Error(
        'the stand-in transport was called with no answer queued: an attempt this plan says reaches ' +
          'it found no answer, so the plan and the run disagree',
      );
    }
    return new Response(answer.body, { status: answer.status });
  };

  // THE DEPLOYMENT'S OWN WIRING, in the order the composition root does it: the resolver computes the
  // directory, the sink is built around it, and the sink's own `resolveDirectory` — not a copy of the
  // answer — is what the port asks at the moment of a write.
  const resolvedDir = input.capture.resolveVoiceCaptureDir(
    process.env.VOICE_CAPTURE_DIR,
    process.env.DATABASE_PATH,
  );
  const shippingSink = input.capture.createVoiceCaptureAudioSink({ directory: resolvedDir });
  let writeAudioCalls = 0;
  const sink: VoiceCaptureAudioSink = {
    resolveDirectory: (): string => shippingSink.resolveDirectory(),
    writeAudio: (directory: string, captureId: string, audio: VoiceCaptureAudio): string => {
      writeAudioCalls += 1;
      return shippingSink.writeAudio(directory, captureId, audio);
    },
  };

  const portCalls = { newAttemptId: 0, recordAttempt: 0 };
  const resolution = input.capture.resolveVoiceCaptureMode(process.env.VOICE_CAPTURE);
  const shippingPort = input.capture.createVoiceCapture({ mode: resolution.mode, log, audio: sink });
  const port: VoiceCapturePort = {
    mode: shippingPort.mode,
    newAttemptId: (): string => {
      portCalls.newAttemptId += 1;
      return shippingPort.newAttemptId();
    },
    recordAttempt: (captureId: string, attempt: VoiceCaptureAttempt): void => {
      portCalls.recordAttempt += 1;
      shippingPort.recordAttempt(captureId, attempt);
    },
  };

  const service: VoiceService = input.service.createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: 5_000,
    fetchBackend,
    logger: log,
    capture: port,
  });

  const consoleLines: string[] = [];
  const restoreConsole = installConsoleProbe(consoleLines);
  const attempts: Attempt[] = [];
  let controlConsoleLines = 0;
  let controlTransportCalls = 0;
  try {
    for (const entry of input.plan) {
      const callsBefore = calls.length;
      const from = lines.length;
      const filesBefore = currentFiles(input.captureDir).length;
      const result = await service.transcribe({
        audio: AUDIO_UPLOAD,
        overrides: { providerId: entry.providerId },
        settings: input.settings,
      });
      const window = lines.slice(from);
      const filesAfter = currentFiles(input.captureDir).length;
      const rows = window
        .map((line) => parseCaptureRow(line))
        .filter((row): row is Record<string, unknown> => row !== null);
      attempts.push({
        plan: entry,
        lines: window,
        rows,
        captureLines: rows.length,
        filesAfter,
        filesAdded: filesAfter - filesBefore,
        wire: wireReadings(calls.slice(callsBefore), entry),
        result: { ok: result.ok, status: result.ok ? 200 : result.status },
      });
    }

    // ── the console control: a service with NO logger and NO capture port.
    //
    // ONE REFUSAL THAT NEVER REACHES THE TRANSPORT IS ENOUGH, and that is why the id is unregistered:
    // the refusal happens before any request exists, so the line this is about is written by the
    // attempt path and not by a transport that might have logged something of its own. Without it,
    // `console.lines` would be zero in every arm for the trivial reason that this file injects a
    // logger — and AC7's non-emptiness claim would have nothing behind it.
    const consoleFrom = consoleLines.length;
    const controlService: VoiceService = input.service.createVoiceService({
      defaults: DEFAULTS,
      timeoutMs: 5_000,
      fetchBackend: async (): Promise<Response> => {
        controlTransportCalls += 1;
        throw new Error('the console control must not reach the transport');
      },
    });
    await controlService.transcribe({
      audio: AUDIO_UPLOAD,
      overrides: { providerId: UNREGISTERED_PROVIDER_ID },
      settings: input.settings,
    });
    controlConsoleLines = consoleLines.length - consoleFrom;
  } finally {
    restoreConsole();
  }

  const names = currentFiles(input.captureDir);
  const { byteHits, nameHits } = fileFaces(input.captureDir, names);

  return {
    mode: resolution.mode,
    resolverInput: input.mode,
    lines,
    consoleLines,
    attempts,
    captureLines: attempts.reduce((total, attempt) => total + attempt.captureLines, 0),
    files: names,
    dirExists: existsSync(input.captureDir),
    portCalls,
    writeAudioCalls,
    control: { consoleLines: controlConsoleLines, transportCalls: controlTransportCalls },
    logHits: scan(lines.join('\n')),
    consoleHits: scan(consoleLines.join('\n')),
    byteHits,
    nameHits,
    ctors: {
      port: typeof input.capture.createVoiceCapture,
      sink: typeof input.capture.createVoiceCaptureAudioSink,
      resolver: typeof input.capture.resolveVoiceCaptureMode,
    },
  };
}

/**
 * The AC9 reachability seam's field name, spelled where the reading and the scan both use it.
 *
 * It is a NAME and not a value: what crosses the seam is the request's headers, and the reading that
 * matters is whether the builder's return literal mentions the name at all.
 */
const SEAM_FIELD = ['request', 'Headers'].join('');

/**
 * The seam the falsifying forms need, read off the shipping tree.
 *
 * WHY IT IS READ RATHER THAN ASSERTED IN PROSE. The row is built by a pure function from a narrowed
 * input, so a field added on the SERVICE side is dropped at the construction point and a mutation that
 * added one there would measure nothing. The only way a mutation can leak a header or an encoding is
 * for the narrowed input to CARRY it and the builder's return literal to write it — so the criterion
 * registers both halves: which shipping files carry the seam, and that the builder's own return does
 * not name it.
 */
function readSeam(paths: { capture: string }): {
  seamFiles: string[];
  builderOmitsSeamField: boolean;
  builderReturnMentionsSeamField: boolean;
} {
  // TWO READINGS OF TWO DIFFERENT THINGS, and the split is deliberate. WHICH FILES carry the seam is a
  // fact about the SHIPPING tree — it is the completion record's `shippingDelta` — so it is read off
  // the shipping paths and does not move when a mutated copy is being measured. Whether the BUILDER'S
  // RETURN mentions the seam field is a fact about the builder under test, so it follows the path this
  // measurement was handed: a copy whose return literal started naming the field is reported as
  // mentioning it, which is exactly the discrimination AC9's first case rests on.
  const captureSource = readFileSync(paths.capture, 'utf8');
  const seamFiles = [SHIPPING_CAPTURE_MODULE, SHIPPING_SERVICE_MODULE].filter((file) =>
    readFileSync(file, 'utf8').includes(SEAM_FIELD),
  );

  const marker = 'export function buildVoiceCapturePayload(';
  const start = captureSource.indexOf(marker);
  const body = start < 0 ? '' : captureSource.slice(start);
  const end = body.indexOf('\n}\n');
  const builder = end < 0 ? body : body.slice(0, end);
  const returnStart = builder.indexOf('  return {');
  const returnLiteral = returnStart < 0 ? '' : builder.slice(returnStart);

  return {
    seamFiles: seamFiles.map((file) => path.basename(file)),
    builderOmitsSeamField: builder !== '' && !returnLiteral.includes(SEAM_FIELD),
    builderReturnMentionsSeamField: returnLiteral.includes(SEAM_FIELD),
  };
}

/**
 * THE measurement: three arms, the surfaces of each, and the two self-scans.
 *
 * The capture directory is PER ARM and under one temp parent, so `text` and `off` can be asked whether
 * their directory exists at all without an `audio` arm's writes making the answer yes. The parent is
 * removed in a `finally`; every file fact a reading needs is read before that happens.
 */
async function measure(paths: { service: string; capture: string }): Promise<Measurement> {
  // THE REGISTRY FIRST, THEN THE ADAPTERS — an adapter's body reads declarations the registry
  // publishes, so importing one into an uninitialised registry is a TDZ error.
  const registry = (await import(pathToFileURL(REGISTRY_MODULE).href)) as {
    listProviders(): { id: string }[];
  };
  for (const modulePath of Object.values(ADAPTER_MODULES)) {
    await import(pathToFileURL(modulePath).href);
  }
  const serviceModule = (await import(pathToFileURL(paths.service).href)) as ServiceModule;
  const capture = (await import(pathToFileURL(paths.capture).href)) as CaptureModule;

  const plan = buildPlan();
  const settings = settingsFor();
  const parent = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-secrets-criterion-'));

  try {
    process.env.DATABASE_PATH = path.join(parent, 'auth.db');
    const arms: Arm[] = [];
    for (const mode of MODES) {
      arms.push(
        await runArm({
          mode,
          captureDir: path.join(parent, `capture-${mode}`),
          capture,
          service: serviceModule,
          plan,
          settings,
        }),
      );
    }

    const seam = readSeam(paths);

    return {
      arms,
      registeredIds: registry.listProviders().map((adapter) => adapter.id),
      handRolledRow: handRolledRow(),
      doors: openDoors(),
      seamFiles: seam.seamFiles,
      builderOmitsSeamField: seam.builderOmitsSeamField,
      builderReturnMentionsSeamField: seam.builderReturnMentionsSeamField,
    };
  } finally {
    rmSync(parent, { recursive: true, force: true });
    delete process.env.VOICE_CAPTURE;
    delete process.env.VOICE_CAPTURE_DIR;
    delete process.env.DATABASE_PATH;
  }
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (measurement: Measurement) => Measured };

/** One arm by mode; a missing arm is a rig failure rather than a green reading. */
function armNamed(measurement: Measurement, mode: string): Arm {
  const found = measurement.arms.find((arm) => arm.mode === mode);
  if (found === undefined) {
    throw new Error(`the measurement ran no arm in mode ${mode}`);
  }
  return found;
}

/** One attempt by provider and outcome; a missing attempt is a rig failure. */
function attemptNamed(arm: Arm, providerId: string, outcome: string): Attempt {
  const found = arm.attempts.find(
    (attempt) => attempt.plan.providerId === providerId && attempt.plan.outcome === outcome,
  );
  if (found === undefined) {
    throw new Error(`the ${arm.mode} arm ran no ${providerId}/${outcome} attempt`);
  }
  return found;
}

/** Every attempt of every arm, in the order the table reports them. */
function allAttempts(measurement: Measurement): { arm: Arm; attempt: Attempt }[] {
  return measurement.arms.flatMap((arm) => arm.attempts.map((attempt) => ({ arm, attempt })));
}

const READINGS: readonly Reading[] = [
  // ── AC2: where the mode, the port and the sink came from ──────────────────────────────────────
  {
    name: 'AC2 orchestration from the shipping path',
    run: (measurement) => {
      const lines = measurement.arms.map(
        (arm) =>
          `resolverInput=${arm.resolverInput === undefined ? '(unset)' : arm.resolverInput} ` +
          `mode=${arm.mode}`,
      );
      const off = armNamed(measurement, 'off');
      const recording = measurement.arms.filter((arm) => arm.mode !== 'off');
      const offCalls = off.portCalls.newAttemptId + off.portCalls.recordAttempt;
      const unregistered = !measurement.registeredIds.includes(UNREGISTERED_PROVIDER_ID);
      const ctors =
        measurement.arms.length === MODES.length &&
        measurement.arms.every(
          (arm) =>
            arm.ctors.port === 'function' &&
            arm.ctors.sink === 'function' &&
            arm.ctors.resolver === 'function',
        );
      lines.push(
        `off.portCalls=${offCalls} port.recordAttempt=[${measurement.arms
          .map((arm) => `${arm.mode}:${arm.portCalls.recordAttempt}`)
          .join(' ')}] handRolledRow=${measurement.handRolledRow} ` +
          `portCtors=${ctors} registry=[${measurement.registeredIds.join(' ')}] ` +
          `unregistered=${unregistered}`,
      );
      return {
        value: lines.join('\n'),
        ok:
          // The RAW value each arm was driven with, read back off the environment and answered by the
          // shipping resolver. Three modes, three arms, nothing hand-assigned.
          measurement.arms.length === MODES.length &&
          MODES.every((mode) => {
            const arm = armNamed(measurement, mode);
            return arm.resolverInput === mode && arm.mode === mode;
          }) &&
          // The gate, as a count: an `off` port is a port the service holds and never calls.
          offCalls === 0 &&
          off.control.transportCalls === 0 &&
          // The positive control for that zero: the same harness in the recording modes calls the port
          // once per attempt, so an `off` arm that called it zero times cannot be green by having none.
          recording.every((arm) => arm.portCalls.recordAttempt === arm.attempts.length) &&
          recording.every((arm) => arm.portCalls.newAttemptId === arm.attempts.length) &&
          !measurement.handRolledRow &&
          ctors &&
          unregistered,
      };
    },
  },

  // ── AC3: the four families really crossed the wire ────────────────────────────────────────────
  {
    name: 'AC3 the four needle families crossed the wire',
    run: (measurement) => {
      const lines: string[] = [];
      let keySent = 0;
      let base64Sent = 0;
      let rawBytesSent = 0;
      for (const { arm, attempt } of allAttempts(measurement)) {
        const { providerId, outcome } = attempt.plan;
        const wire = attempt.wire;
        keySent += wire.keySent ? 1 : 0;
        base64Sent += wire.base64Sent ? 1 : 0;
        rawBytesSent += wire.rawBytesSent ? 1 : 0;
        // THE VALUE OF THE AUTHORIZATION HEADER IS NEVER PRINTED — only whether it is the expected
        // `Bearer ` + key and how long it is. A criterion about a secret must not be a place it leaks.
        lines.push(
          `wire.${providerId}.${arm.mode}-${outcome}.keySent=${wire.keySent} ` +
            `base64Sent=${wire.base64Sent} rawBytesSent=${wire.rawBytesSent} ` +
            `authorizationLength=${wire.authorizationLength} bodyBytes=${wire.bodyBytes} ` +
            `calls=${wire.calls}`,
        );
      }

      const slots = sharedKeySlots();
      lines.push(
        `keySent.total=${keySent} base64Sent.total=${base64Sent} rawBytesSent.total=${rawBytesSent}`,
      );
      // The fixture's own honesty, as booleans: the sentinel really is in BOTH slots and the two hold
      // the same string. See `sharedKeySlots` for why this is not a "masked form".
      lines.push(
        `sharedKey.inDefaults=${slots.defaults} sharedKey.inSettings=${slots.settings} ` +
          `sharedKey.same=${slots.same} sharedKey.length=${slots.length}`,
      );

      const expectedKeySent = PROVIDERS.length * OUTCOMES.length * MODES.length; // 12
      const expectedPerProvider = OUTCOMES.length * MODES.length; // 6
      const everyAttemptOneCall = allAttempts(measurement).every(
        ({ attempt }) => attempt.wire.calls === 1,
      );
      const keyOnBothLines = PROVIDERS.every((providerId) =>
        allAttempts(measurement)
          .filter(({ attempt }) => attempt.plan.providerId === providerId)
          .every(({ attempt }) => attempt.wire.keySent),
      );
      const base64OnDashscope = allAttempts(measurement)
        .filter(({ attempt }) => attempt.plan.providerId === 'dashscope-omni')
        .every(({ attempt }) => attempt.wire.base64Sent);
      const rawBytesOnShared = allAttempts(measurement)
        .filter(({ attempt }) => attempt.plan.providerId === 'openai-compatible')
        .every(({ attempt }) => attempt.wire.rawBytesSent);

      return {
        value: lines.join('\n'),
        ok:
          keySent === expectedKeySent &&
          base64Sent === expectedPerProvider &&
          rawBytesSent === expectedPerProvider &&
          keyOnBothLines &&
          base64OnDashscope &&
          rawBytesOnShared &&
          everyAttemptOneCall &&
          slots.defaults &&
          slots.settings &&
          slots.same &&
          slots.length > 0,
      };
    },
  },

  // ── AC4: the log faces ───────────────────────────────────────────────────────────────────────
  {
    name: 'AC4 the log faces carry no needle',
    run: (measurement) => {
      const lines = measurement.arms.map(
        (arm) =>
          `mode=${arm.mode} log.lines=${arm.lines.length} console.lines=${arm.consoleLines.length} ` +
          `logHits=${arm.logHits} consoleHits=${arm.consoleHits}`,
      );
      const sinkHits = measurement.arms.reduce(
        (total, arm) => total + arm.logHits + arm.consoleHits,
        0,
      );
      // `sinkHits` is a COUNT and `logFaceClean` is the same fact as a NAME, printed for the reason
      // the falsifying forms need one: a case asserts that a mutant reds this reading WITH a specific
      // literal in its measured value, and a count that a mutation moves from 0 to some number this
      // criterion cannot know in advance is not a literal. The boolean is.
      const logFaceClean = measurement.arms.every(
        (arm) => arm.logHits === 0 && arm.consoleHits === 0,
      );
      lines.push(
        `sinkHits=${sinkHits} logFaceClean=${logFaceClean} consoleRestored=${consoleRestored()}`,
      );
      return {
        value: lines.join('\n'),
        ok:
          measurement.arms.length === MODES.length &&
          measurement.arms.every((arm) => arm.logHits === 0 && arm.consoleHits === 0) &&
          sinkHits === 0 &&
          logFaceClean &&
          consoleRestored(),
      };
    },
  },

  // ── AC5: the capture-file faces ──────────────────────────────────────────────────────────────
  {
    name: 'AC5 the capture files carry no needle',
    run: (measurement) => {
      const lines = measurement.arms.map(
        (arm) =>
          `mode=${arm.mode} files=${arm.files.length} byteHits=${arm.byteHits} ` +
          `nameHits=${arm.nameHits} dirExists=${arm.dirExists}`,
      );
      const nonRecording = measurement.arms.filter((arm) => arm.mode !== 'audio');
      return {
        value: lines.join('\n'),
        ok:
          measurement.arms.length === MODES.length &&
          measurement.arms.every((arm) => arm.byteHits === 0 && arm.nameHits === 0) &&
          // A mode that writes nothing leaves no directory behind even when one is configured — asked
          // of the filesystem rather than promised, and on an arm whose directory is its own.
          nonRecording.every((arm) => !arm.dirExists && arm.files.length === 0) &&
          armNamed(measurement, 'audio').files.length > 0,
      };
    },
  },

  // ── AC6: the twelve-row table ────────────────────────────────────────────────────────────────
  {
    name: 'AC6 the twelve attempt rows',
    run: (measurement) => {
      const entries = allAttempts(measurement);
      const rows = entries.map(({ arm, attempt }) => {
        const hits = scan(attempt.lines.join('\n'));
        return (
          `mode=${arm.mode} provider=${attempt.plan.providerId} outcome=${attempt.plan.outcome} ` +
          `captureLines=${attempt.captureLines} files=${attempt.filesAfter} sinkHits=${hits} ` +
          `keySent=${attempt.wire.keySent}`
        );
      });
      const providers = new Set(entries.map(({ attempt }) => attempt.plan.providerId));
      const outcomes = new Set(entries.map(({ attempt }) => attempt.plan.outcome));
      const sinkHits = entries.reduce(
        (total, { attempt }) => total + scan(attempt.lines.join('\n')),
        0,
      );
      const okRows = entries.filter(({ attempt }) => attempt.plan.outcome === 'ok').length;
      const failRows = entries.filter(({ attempt }) => attempt.plan.outcome === 'fail').length;
      return {
        value:
          `${rows.join('\n')}\nsinkHits=${sinkHits} providers=[${[...providers].sort().join(' ')}] ` +
          `outcomes=[${[...outcomes].sort().join(' ')}] okRows=${okRows} failRows=${failRows}`,
        ok:
          rows.length === PROVIDERS.length * OUTCOMES.length * MODES.length &&
          okRows === PROVIDERS.length * MODES.length &&
          failRows === PROVIDERS.length * MODES.length &&
          providers.size === PROVIDERS.length &&
          outcomes.size === OUTCOMES.length &&
          sinkHits === 0,
      };
    },
  },

  // ── AC7: the zeroes are not emptiness ────────────────────────────────────────────────────────
  {
    name: 'AC7 the zeroes are not emptiness',
    run: (measurement) => {
      const lines = measurement.arms.map(
        (arm) =>
          `mode=${arm.mode} captureLines=${arm.captureLines} ` +
          `transcribeLines=${arm.lines.length - arm.captureLines} files=${arm.files.length} ` +
          `console.lines=${arm.consoleLines.length}`,
      );
      const off = armNamed(measurement, 'off');
      const recording = measurement.arms.filter((arm) => arm.mode !== 'off');
      const perArmAttempts = PROVIDERS.length * OUTCOMES.length;
      return {
        value: lines.join('\n'),
        ok:
          // A recording arm records one row per attempt — four per mode, twelve in all. Without this
          // the log-face zero would be satisfied by a capture channel that was never connected.
          recording.every((arm) => arm.captureLines === perArmAttempts) &&
          measurement.arms.every((arm) => arm.attempts.length === perArmAttempts) &&
          // `off` records nothing and still writes its attempt lines, so its zero is a decision: the
          // attempt lines are one per attempt in EVERY arm, which is what this subtraction reads.
          off.captureLines === 0 &&
          measurement.arms.every(
            (arm) => arm.lines.length - arm.captureLines === arm.attempts.length,
          ) &&
          // The default logger is reached too, so `console.lines` is a measurement rather than a zero
          // produced by this file injecting a port.
          measurement.arms.every((arm) => arm.consoleLines.length > 0) &&
          measurement.arms.every(
            (arm) => arm.control.consoleLines > 0 && arm.control.transportCalls === 0,
          ) &&
          // The audio arm's writes are real: one file per attempt — the write is not gated on the
          // attempt's outcome, so all four land — and no other mode writes any.
          armNamed(measurement, 'audio').attempts.every((attempt) => attempt.filesAdded === 1) &&
          recording.every((arm) =>
            arm.mode === 'audio' ? arm.writeAudioCalls > 0 : arm.writeAudioCalls === 0,
          ),
      };
    },
  },

  // ── AC8: the scanner is not a constant zero ──────────────────────────────────────────────────
  {
    name: 'AC8 the scanner is sensitive',
    run: () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-secrets-probe-'));
      const lines: string[] = [];
      const probes: Record<string, number> = {};
      const nameSurface: string[] = [];
      const nameSurfaceSkipped: string[] = [];
      try {
        for (const family of NEEDLE_FAMILIES) {
          let hits = 0;
          for (const needle of family.needles) {
            // Surface one: a log line of the same shape the shipping service writes.
            hits += scanFamily(
              `voice.transcribe providerId=x outcome=ok status=200 note=${needle}`,
              family,
            );
            // Surface three: a temp file's CONTENT.
            const content = path.join(root, `probe-${family.name}-content.txt`);
            writeFileSync(content, `note=${needle}\n`, 'utf8');
            hits += scanFamily(readFileSync(content), family);
            // Surface two: a temp file's NAME. The whole needle has to fit in ONE path component, so a
            // needle longer than the filesystem's limit is reported instead of being shortened into
            // something the scan would not be looking for.
            const name = `probe-${needle}-name.txt`;
            if (Buffer.byteLength(name, 'utf8') <= 255) {
              const named = path.join(root, name);
              writeFileSync(named, 'this content carries no needle\n', 'utf8');
              hits += scanFamily(path.basename(named), family);
              nameSurface.push(family.name);
            } else {
              nameSurfaceSkipped.push(`${family.name}(${Buffer.byteLength(name, 'utf8')}B)`);
            }
          }
          probes[family.name] = hits;
          lines.push(`probe.${family.name}=${hits}`);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      const negative = scan('voice.transcribe providerId=x outcome=ok status=200');
      lines.push(
        `probe.needle-free-line=${negative} nameSurface=[${nameSurface.join(' ')}] ` +
          `nameSurfaceSkipped=[${nameSurfaceSkipped.join(' ')}] base64.length=${AUDIO_BASE64.length} ` +
          `base64.nameSafe=${!AUDIO_BASE64.includes('/') && !AUDIO_BASE64.includes('+')} ` +
          `bytes.length=${AUDIO_BYTES.length}`,
      );
      return {
        value: lines.join('\n'),
        ok:
          NEEDLE_FAMILIES.every((family) => (probes[family.name] ?? 0) > 0) &&
          // The check that makes the four positives mean something: a line built the same way with no
          // needle in it reads zero through the same function that just found four.
          negative === 0 &&
          nameSurface.length >= NEEDLE_FAMILIES.length - 1 &&
          AUDIO_BASE64.length >= 256 &&
          AUDIO_BYTES.length >= 192 &&
          !AUDIO_BASE64.includes('/') &&
          !AUDIO_BASE64.includes('+'),
      };
    },
  },

  // ── AC11: what this task did and did not touch ───────────────────────────────────────────────
  {
    name: 'AC11 honest registration',
    run: (measurement) => {
      const expectedSeam = ['voice-capture.ts', 'voice.service.ts'];
      const seamComplete =
        expectedSeam.every((file) => measurement.seamFiles.includes(file)) &&
        measurement.seamFiles.length === expectedSeam.length;
      const shippingDelta = measurement.seamFiles.length;
      return {
        value:
          `scope=three-modes-secrets-criterion(log-faces+capture-file-faces) ` +
          `fixtures=stand-in-fetch+injected-log-port+console-probe+temp-capture-dir ` +
          `real-upstream=false real-process=false real-server-log=false multimodal=false ` +
          `not-covered=[audio-bytes-sha256-permissions text-field-set-truncation off-byte-baseline ` +
          `capture-failure-isolation real-process-stdout] ` +
          `shippingDelta=${shippingDelta} seamFiles=[${measurement.seamFiles.join(' ')}] ` +
          `attempts=${allAttempts(measurement).length}`,
        ok:
          // THE DELTA IS NOT ZERO AND IS NOT HIDDEN. The criterion is green on the shipping
          // implementation, but it needed one seam change to be falsifiable at all: the narrowed
          // payload input now carries the request's headers so a mutation of the builder's return
          // literal has something to leak. Both halves are read off the tree — the two files that
          // carry the seam, and the builder's own return, which does not name it.
          seamComplete &&
          measurement.builderOmitsSeamField &&
          !measurement.builderReturnMentionsSeamField &&
          measurement.arms.length === MODES.length &&
          allAttempts(measurement).length === 12,
      };
    },
  },
];

// ── the criterion ─────────────────────────────────────────────────────────────────────────────

/**
 * One measurement per module pair, so the falsifying file can ask for the readings and the raw sink
 * hits without driving the whole harness twice. A rejected measurement is NOT cached: a rig failure
 * reported once must be reportable again.
 */
const measuredOnce = new Map<string, Promise<Measurement>>();

function measurementOnce(modules: CriterionModules | string): Promise<Measurement> {
  const paths = modulePaths(modules);
  const key = `${paths.service}|${paths.capture}`;
  const cached = measuredOnce.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const pending = measure(paths).catch((error: unknown) => {
    measuredOnce.delete(key);
    throw error;
  });
  measuredOnce.set(key, pending);
  return pending;
}

/**
 * Runs every reading against one measurement, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsifying file has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 */
export async function collectReadings(
  modules: CriterionModules | string = {},
): Promise<ReadingOutcome[]> {
  const measurement = await measurementOnce(modules);

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

/**
 * The mutant's footprint on the RAW receiving surfaces: every needle occurrence it left on the log
 * faces and the capture-file faces of its own run.
 *
 * WHY THE FALSIFYING FILE NEEDS THIS AS A NUMBER. A mutation that changed nothing would leave the
 * reading list all green, and "the mutant read green" would then look like "the criterion has no
 * resolution" — the two are the same output and opposite facts. This is the reading that tells them
 * apart: a mutant whose leak reached no surface at all has `rawSinkHits=0`.
 */
export async function collectRawSinkHits(modules: CriterionModules | string = {}): Promise<number> {
  const measurement = await measurementOnce(modules);
  return measurement.arms.reduce(
    (total, arm) => total + arm.logHits + arm.consoleHits + arm.byteHits + arm.nameHits,
    0,
  );
}

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ─────

const IS_ENTRY = path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url);

if (IS_ENTRY) {
  let driven = 0;
  let measured: Promise<ReadingOutcome[]> | undefined;
  const readingsOnce = (): Promise<ReadingOutcome[]> => (measured ??= collectReadings());

  for (const reading of READINGS) {
    test(reading.name, async () => {
      const outcomes = await readingsOnce();
      const outcome = outcomes.find((entry) => entry.name === reading.name);
      assert.ok(outcome, `the reading list produced no outcome for '${reading.name}'`);
      driven += 1;
      // Printed BEFORE the assertion, so a red names itself and its measured value in the log rather
      // than only in the assertion's diff. AC6's and the mode tables' values are multi-line on
      // purpose: the ACs ask for a row per attempt and a line per mode, and this is where they print.
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
