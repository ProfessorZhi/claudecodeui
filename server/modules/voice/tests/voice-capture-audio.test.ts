/**
 * The `audio` payload: the uploaded bytes THEMSELVES on disk, the path and the digest on the row, the
 * permission bits on the filesystem, and the two zeroes on the other side of the gate.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-off.test.ts` reads the mode resolution, the
 * start-up line, the gate and the row's EXISTENCE; `voice-capture-text.test.ts` reads the row's
 * CONTENTS for the mode that records text. Neither one writes a file, and until this criterion the
 * seam's write-audio port had no shipping implementation at all — the composition root said so in
 * words. This is the half both of those files handed over: what `audio` mode does that the other two
 * cannot, which is to put the upload on disk.
 *
 * THE SUBJECT IS THE BYTES, AND THAT IS WHY THEY ARE COMPARED RATHER THAN COUNTED. "A file was
 * written" is satisfied by a file holding something else — a base64 copy, half the upload, a header
 * line, a JSON envelope. So every reading here is a comparison against the `Buffer` this file sent:
 * `Buffer.equals` for the file's contents, and for the digest a sha256 RECOMPUTED FROM THE FILE
 * against the one the row carries. Those are two independent roads to the same bytes — a row built
 * from a different source than the file would have to disagree on one of them — which is why AC3
 * reads both rather than either alone.
 *
 * THE PERMISSIONS ARE READ HERE RATHER THAN TRUSTED FROM THE SOURCE, and that is the point of the
 * umask. `mode:` is an argument to `open(2)` and the kernel applies `mode & ~umask` to it, so a
 * reading taken under an inherited umask measures the machine's umask as much as the module's
 * intent. This file therefore drops the umask to `0o000` for the whole measurement and restores the
 * process's own value in a `finally`: under that umask the requested bits are what lands on disk,
 * and an implementation that sets no permission bits at all lands at `0777`/`0666` rather than at
 * the `0700`/`0600` this deployment promises.
 *
 * HOW IT IS DRIVEN. Five arms through ONE shipping service, ONE shipping capture module and ONE
 * stand-in transport, differing only in the environment a deployment would set:
 *
 *   · `audio` — one successful transcription, the directory NOT pre-created. AC3 and AC4.
 *   · `repeat` — three, into a directory this file creates first, with a sentinel file already in
 *     it. AC5: the accumulation, and the proof that "nothing is deleted" is not a zero over an empty
 *     directory.
 *   · `text` — three, with a directory configured. AC6: the same harness, zero files, zero
 *     directories, zero calls to the write port, and no `path` key on any row.
 *   · `off` — one, with a directory configured. AC2's `off.dirResolves=0`: the resolver is not
 *     reached by a mode that writes nothing.
 *   · `default` — one, with `VOICE_CAPTURE_DIR` absent and the database in this run's temp tree.
 *     AC7: the directory lands beside the database, not in the real home directory.
 *
 * THE SINK IS THE SHIPPED ONE. The write port this file hands the service resolves its directory
 * with the shipped resolver and writes with the shipped writer (`createVoiceCaptureAudioSink`), and
 * only COUNTS the calls around them. A stand-in that wrote the file itself would make every byte and
 * permission reading below a reading about this file, so there is exactly one write implementation
 * on this path and it is the one under test.
 *
 * FALSIFYING FORMS LIVE IN `voice-capture-audio.false-forms.test.ts`, and the readings are collected
 * by one exported function so that file can run THIS list against a mutated copy of
 * `voice-capture.ts`. See the header there for why each mutation is reachable at all — including the
 * one form this task's AC names that is NOT reachable, and what stands in for it.
 *
 * WHAT THIS FILE DOES NOT COVER (registered in the `AC10 registration` reading rather than left to a
 * reader to notice): the redaction criterion over keys and headers (AC-146), capture-failure
 * isolation (AC-147), and any real-process reading (AC-148). There is no retention, no size ceiling
 * and no cleanup by design, so "the directory only grows" is the shipped behaviour rather than an
 * omission.
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
  statSync,
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

/** The shipping service module: what this criterion drives, and the file a mutation case copies. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping capture module: the resolver, the port constructor and the write-audio factory. */
export const SHIPPING_CAPTURE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice-capture.ts');
/** The composition root, read as TEXT by the wiring readings — importing it would build a router. */
export const SHIPPING_MODULE_ROOT = path.join(SERVER_DIR, 'modules/voice/voice.module.ts');

/**
 * The registry, imported BEFORE the adapter below.
 *
 * The adapter's own module body reads declarations the registry publishes, so importing the adapter
 * into an uninitialised registry is a TDZ error rather than an empty list; the registry's own graph
 * evaluates the adapter, so after this import the adapter module is complete. Importing it by path
 * resolves to the same file URL the service's own relative specifier does, so this is the same
 * module instance the service under test sees and not a second copy of the registry.
 */
const REGISTRY_MODULE = path.resolve(SERVER_DIR, '../shared/asr/asrRegistry.ts');
/** The `dashscope-omni` adapter: the endpoint rule, the credential field and the answer envelope. */
const ADAPTER_MODULE = path.resolve(
  SERVER_DIR,
  '../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts',
);

/** This file, read as text by the door scan. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 10;

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
/** The upload's own sentinel: makes "the file holds a different string" a reading of this run. */
const AUDIO_SENTINEL = `audio-${RUN_TAG}`;

/**
 * The upload's bytes: the sentinel plus padding, so the digest of THIS run's buffer is not one a
 * reader could have written down, and so the two ends of the digest comparison are about this run.
 */
const AUDIO_BYTES = Buffer.from(`${AUDIO_SENTINEL}:${'b'.repeat(64)}`, 'utf8');

/** The upload as the capture seam takes it: one set of bytes, named once at each seam. */
const AUDIO: VoiceCaptureAudio = { bytes: AUDIO_BYTES, mimeType: 'audio/webm', fileName: 'clip.webm' };

/** The same upload as the SERVICE takes it. */
const AUDIO_UPLOAD: VoiceAudioUpload = {
  bytes: AUDIO_BYTES,
  mimeType: AUDIO.mimeType,
  fileName: AUDIO.fileName,
};

/** The transcription every fixture envelope carries. */
const TRANSCRIPT = '逐字转写';
/** The instruction the envelope's payload carries. The prompt text is not what this file reads. */
const INSTRUCTION = '整理后的指令';

/** The whole serialised body of a successful attempt, which is all AC3-AC7 need to reach `ok`. */
const WRITTEN_BODY = JSON.stringify({
  choices: [
    { message: { content: JSON.stringify({ transcript: TRANSCRIPT, instruction: INSTRUCTION }) } },
  ],
});

/** How many times the `repeat` and `text` arms transcribe, and the count AC5 asserts. */
const REPEAT_ATTEMPTS = 3;

/** The name and contents of the file the `repeat` arm places before its first attempt. */
const SENTINEL_NAME = 'sentinel.bin';
const SENTINEL_BYTES = Buffer.from(`sentinel-${RUN_TAG}:${'s'.repeat(32)}`, 'utf8');

/** The row fields AC6 requires on every capture row, so "zero files" is not "no rows either". */
const REQUIRED_ROW_FIELDS = ['captureId', 'providerId', 'mime', 'bytes', 'sha256'] as const;

/**
 * The instance salt every arm's port is built with.
 *
 * A LITERAL HERE, because the arms are about the WRITE rather than about how the salt is derived —
 * the cross-process derivation has its own criterion in the falsifying file, where a real `tsx` child
 * calls the shipping `resolveInstanceSalt`. A fixed token still exercises the id SHAPE this task adds
 * (`<mode>-<salt>-<sequence>`), which is what the arm's file names below now carry.
 */
const INJECTED_SALT = 'criterion';

// ── the contract between this file and a mutated copy ─────────────────────────────────────────

/** The modules under test. Absent means the shipping one. */
export type CriterionModules = { service?: string; capture?: string };

/** One reading's outcome, as the falsifying file reads them. */
export type ReadingOutcome = { name: string; value: string; ok: boolean };

// ── the shipped shapes, named as this file needs them ─────────────────────────────────────────

/** The `dashscope-omni` module's surface, as this criterion reads values off it. */
type AdapterModule = { id: string };

/** The capture module's surface, as this criterion reads it. */
type CaptureModule = {
  resolveVoiceCaptureMode(raw: string | undefined): VoiceCaptureResolution;
  createVoiceCapture(dependencies: {
    mode: VoiceCaptureResolution['mode'];
    log: VoiceLogPort;
    /** The instance token the shipping factory now requires; this criterion supplies its own. */
    instanceSalt: string;
    audio?: VoiceCaptureAudioSink;
  }): VoiceCapturePort;
  resolveVoiceCaptureDir(raw: string | undefined, databasePath: string | undefined): string;
  createVoiceCaptureAudioSink(options: { directory: string }): VoiceCaptureAudioSink;
};

/** One answer the stand-in transport gives. */
type Answer = { status: number; body: string };

/** One attempt: the case's name, the upload it sends, and the answer it earns. */
type Step = { name: string; upload: VoiceAudioUpload; answer: Answer };

/** One attempt's effect, as the collector saw it. */
type Attempt = {
  name: string;
  /** Every line the collector received during this attempt, in order. */
  lines: string[];
  /** The subset that is a capture ROW. */
  rows: Record<string, unknown>[];
  /** Whether EVERY row line was valid single-line JSON (`JSON.parse` ok, one line). */
  allRowsParse: boolean;
};

/** How many times the write port's two methods were reached, and every path the writer returned. */
type Counters = {
  /** `resolveDirectory` calls. Zero for every mode that writes nothing, and for `off` in full. */
  resolves: number;
  /** `writeAudio` calls. */
  writes: number;
  /** Every path the SHIPPED writer returned, in order. */
  paths: string[];
};

/** One arm: the mode, the attempts, and the filesystem footprint of the whole arm. */
type Arm = {
  name: string;
  /** The RAW value handed to the shipping resolver — read off the environment, never a literal. */
  resolverInput: string | undefined;
  /** The mode the shipping resolver answered with. */
  mode: string;
  /** The directory this arm's deployment resolved to, by the shipped resolver. */
  dir: string;
  /** The `DATABASE_PATH` this arm's deployment ran with, which is what the default derives from. */
  databasePath: string;
  /** Whether that directory already existed when the arm started, before any write. */
  dirExistedBefore: boolean;
  attempts: Attempt[];
  /** Every capture ROW text in this arm, in order. */
  rowTexts: string[];
  /** Every parsed capture row in this arm, in order. */
  rows: Record<string, unknown>[];
  counters: Counters;
  /** The temp parent's entries when the arm was over. */
  parentEntries: string[];
  /** The resolved directory's entries when the arm was over, or `[]` when it does not exist. */
  files: string[];
  dirCreated: boolean;
  /** The permission bits the filesystem reported, as four octal digits, or `(absent)`. */
  modes: { dir: string; file: string };
  /** The body of the sentinel file after the arm, or `null` when it is gone. */
  sentinelBody: Buffer | null;
  /** How many times the stand-in transport was called across the arm. */
  calls: number;
};

/**
 * The never-overwrite reading: an attempt whose preferred file name was ALREADY TAKEN.
 *
 * `preferred` is the name the sink would have used, learned by asking the shipping sink for it in a
 * scratch directory rather than by spelling the naming scheme here — the criterion would then be
 * about a format it had guessed. The sentinel is placed at that name with DIFFERENT bytes, so
 * "the new file is a different name" and "the old bytes are still there" are two independent readings.
 */
type Collision = {
  /** The attempt id the port minted, read off the port rather than assumed. */
  id: string;
  /** The name the sink prefers for `id`, learned from a scratch write. */
  preferred: string;
  /** Where the row says the bytes landed. */
  newPath: string;
  /** Whether the sentinel at `preferred` still holds the bytes this criterion put there. */
  sentinelIntact: boolean;
  /** Whether the row's path is a DIFFERENT name from the one the sentinel occupies. */
  nameChanged: boolean;
  /** Whether the row's path lies inside the directory. */
  pathUnderDir: boolean;
  /** Whether the file at the row's path holds the upload byte for byte. */
  bytesEqual: boolean;
  /** Whether a sha256 recomputed from that file equals the row's `sha256`. */
  shaMatch: boolean;
};

/** Everything the readings need, measured once. */
type Measurement = {
  audio: Arm;
  repeat: Arm;
  text: Arm;
  off: Arm;
  default: Arm;
  /** The collision arm: one attempt into a directory where its preferred name already exists. */
  collision: Collision;
  /** The three pure calls AC2 makes with ARGUMENTS, taken before any arm touches the environment. */
  resolve: {
    parent: string;
    explicit: string;
    database: string;
    gotExplicit: string;
    gotDefault: string;
    gotBlank: string;
  };
  /**
   * The composition root's own figures.
   *
   * `envCaptureSubstring` and `envCaptureToken` are the two readings of the SAME variable, taken
   * side by side: the first counts the bare substring, the second counts it on a word boundary. They
   * differ by exactly the directory variable's own occurrences, and that difference is the whole
   * subject of AC8's cross-task clause — see the registration in the falsifying file.
   */
  root: {
    envDirReads: number;
    /** Reads of `process.env.VOICE_CAPTURE_RAW` — the raw switch, whose own read this task added. */
    envRawReads: number;
    resolverCalled: boolean;
    envCaptureSubstring: number;
    envCaptureToken: number;
  };
  /** The umask this measurement ran under, as three octal digits. */
  umask: string;
  /** Whether the `audio` arm's file holds the upload byte-for-byte, and the digest, from the file. */
  file: { bytesEqual: boolean; lenEqual: boolean; shaFromFile: string; shaInRow: string; shaMatch: boolean };
  /** The `repeat` arm's accumulation figures. */
  accumulation: { distinctPaths: boolean; distinctIds: boolean; eachEqual: boolean; surviving: number };
  /** Whether the shipping modules contain a call that deletes a file. */
  noDeleteCall: boolean;
  /** The modules this file imports that could open a socket or start a process. */
  doors: string[];
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
 * testing the transport rather than the file.
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

/** The sha256 of a buffer, lowercase hex — the same construction the shipping module uses. */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A path's permission bits as four octal digits (`0700`).
 *
 * `statSync` rather than `lstatSync`: the promise is about the object the recording names, and a
 * symlink's own bits say nothing about the file behind it. The mask is `0o777` rather than `0o7777`
 * because the setuid/setgid/sticky bits are not part of this deployment's promise and a reading that
 * folded them in would red on a filesystem that set one for its own reasons.
 */
function modeBits(target: string): string {
  return (statSync(target).mode & 0o777).toString(8).padStart(4, '0');
}

/** A row field as a string; anything else reads as the empty string. */
function fieldString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

/** Whether a row carries every field AC6 requires, each with a usable value. */
function fieldsPresent(row: Record<string, unknown>): boolean {
  return REQUIRED_ROW_FIELDS.every((key) => {
    const value = row[key];
    if (key === 'bytes') {
      return typeof value === 'number' && value > 0;
    }
    return typeof value === 'string' && value !== '';
  });
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

/** Whether a line is valid single-line JSON that parses to a capture row. */
function isSingleLineJson(line: string): boolean {
  return !line.includes('\n') && parseCaptureRow(line) !== null;
}

/** Whether a path lies inside `directory`, by the relative-path rule rather than a prefix compare. */
function isUnder(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** A buffer's length and the head of its digest, so a red names the difference rather than a diff. */
function fingerprint(buffer: Buffer): string {
  return `${buffer.length}B/${sha256Hex(buffer).slice(0, 12)}`;
}

// ── the fixture plan ──────────────────────────────────────────────────────────────────────────

/** `count` successful transcriptions of the same upload, named so a red says which one it was. */
function successSteps(count: number, prefix: string): Step[] {
  return Array.from({ length: count }, (_unused, index) => ({
    name: `${prefix}-${index + 1}`,
    upload: AUDIO_UPLOAD,
    answer: { status: 200, body: WRITTEN_BODY },
  }));
}

/**
 * The settings document every attempt is driven with: this provider's OWN address and credential.
 *
 * The shared fields are empty because this provider is reached through its own, so a row's `mime`
 * and `bytes` can only have come from the upload this file sent rather than from a shared default.
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
    dashscopeApiKey: `key-${RUN_TAG}`,
    dashscopeModel: '',
  };
}

// ── driving one arm ───────────────────────────────────────────────────────────────────────────

/**
 * Drives one arm's attempts and reports what the collector, the transport and the disk saw.
 *
 * THE ENVIRONMENT IS SET HERE, and every value the sink is handed is read back off `process.env`
 * rather than passed as a literal: that is what makes `resolverInput` the value the process actually
 * carries, and it is why the `default` arm is a `delete` rather than a second string.
 *
 * THE STAND-IN TRANSPORT IS THE ONLY SEAM A REQUEST LEAVES THROUGH, so "was there a request at all"
 * is a reading of this array rather than a claim about the network.
 *
 * THE DIRECTORY'S STATE IS READ BEFORE THE FIRST ATTEMPT (`dirExistedBefore`) and after the last
 * one (`files`, `modes`), because those are two different claims: a mode that must not create a
 * directory has to be measured against a directory that did not exist, and a mode that creates one
 * has to be measured on what it left behind.
 */
async function runArm(input: {
  name: string;
  mode: string | undefined;
  captureDir: string | undefined;
  databasePath: string;
  capture: CaptureModule;
  createService: typeof createVoiceService;
  steps: readonly Step[];
  settings: VoiceSettings;
  overrides: VoiceRequestOverrides;
  /** Whether THIS FILE creates the directory before the first attempt, as the accumulation control. */
  precreateDir?: boolean;
  /** Files placed in that directory before the first attempt, so "nothing is deleted" is not empty. */
  seedFiles?: readonly { name: string; bytes: Buffer }[];
}): Promise<Arm> {
  if (input.mode === undefined) {
    delete process.env.VOICE_CAPTURE;
  } else {
    process.env.VOICE_CAPTURE = input.mode;
  }
  if (input.captureDir === undefined) {
    delete process.env.VOICE_CAPTURE_DIR;
  } else {
    process.env.VOICE_CAPTURE_DIR = input.captureDir;
  }
  process.env.DATABASE_PATH = input.databasePath;

  // The resolver's arguments, read off the environment at the moment the deployment would have them.
  const resolverInput = process.env.VOICE_CAPTURE_DIR;
  const resolvedDir = input.capture.resolveVoiceCaptureDir(resolverInput, process.env.DATABASE_PATH);

  if (input.precreateDir === true) {
    mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  }
  for (const seed of input.seedFiles ?? []) {
    writeFileSync(path.join(resolvedDir, seed.name), seed.bytes, { mode: 0o600 });
  }

  const dirExistedBefore = existsSync(resolvedDir);

  const lines: string[] = [];
  const log: VoiceLogPort = {
    // Method shorthand rather than `log.info(...)` anywhere in this file, so the criterion never
    // writes a line of its own into the collector.
    info: (message: string): void => {
      lines.push(message);
    },
  };

  let calls = 0;
  const fetchBackend = async (): Promise<Response> => {
    // Every step in every arm is a success, and each request is answered with ITS step's body. The
    // steps are consumed in order and one call per attempt is what the plan assumes, so a rig that
    // drifted out of phase throws here rather than answering the wrong step and leaving the row
    // readings to fail for a reason that has nothing to do with the module under test.
    const step = input.steps[calls];
    calls += 1;
    if (step === undefined) {
      throw new Error(
        `the stand-in transport was called ${calls} times for ${input.steps.length} attempt(s): ` +
          'this plan assumes exactly one transport call per attempt',
      );
    }
    return new Response(step.answer.body, { status: step.answer.status });
  };

  const counters: Counters = { resolves: 0, writes: 0, paths: [] };
  const sink: VoiceCaptureAudioSink = {
    // The SHIPPING resolver, asked at the moment of a write — exactly as the port asks it. Counting
    // here is what makes `off.dirResolves` and `text.writeCalls` measured rather than asserted.
    resolveDirectory: (): string => {
      counters.resolves += 1;
      return input.capture.resolveVoiceCaptureDir(
        process.env.VOICE_CAPTURE_DIR,
        process.env.DATABASE_PATH,
      );
    },
    // THE SHIPPED WRITER, handed the directory the shipped resolver answered with. The bytes that
    // reach the disk, the permission bits and the returned path are all its work; this arm only
    // counts the call and remembers the path, so every byte and permission reading below is a
    // reading about the shipping implementation rather than about a stand-in written here.
    writeAudio: (directory: string, captureId: string, audio: VoiceCaptureAudio): string => {
      counters.writes += 1;
      const written = input.capture
        .createVoiceCaptureAudioSink({ directory })
        .writeAudio(directory, captureId, audio);
      counters.paths.push(written);
      return written;
    },
  };

  // The SHIPPING port constructor, handed the mode the SHIPPING resolver answered with — so the gate
  // the service applies is the one the deployment's own wiring would reach, not a shape built here.
  const resolution = input.capture.resolveVoiceCaptureMode(input.mode);
  const port = input.capture.createVoiceCapture({
    mode: resolution.mode,
    log,
    instanceSalt: INJECTED_SALT,
    audio: sink,
  });
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

  for (const step of input.steps) {
    const from = lines.length;
    await service.transcribe({
      audio: step.upload,
      overrides: input.overrides,
      settings: input.settings,
    });
    const window = lines.slice(from);
    const rowLines = window.filter((line) => parseCaptureRow(line) !== null);
    rowTexts.push(...rowLines);
    attempts.push({
      name: step.name,
      lines: window,
      rows: rowLines.map((line) => parseCaptureRow(line) as Record<string, unknown>),
      allRowsParse: rowLines.every(isSingleLineJson),
    });
  }

  const rows = rowTexts.map((line) => parseCaptureRow(line) as Record<string, unknown>);
  const dirCreated = existsSync(resolvedDir);
  const firstPath = counters.paths[0];
  const sentinelPath = path.join(resolvedDir, SENTINEL_NAME);

  return {
    name: input.name,
    resolverInput,
    mode: resolution.mode,
    dir: resolvedDir,
    databasePath: input.databasePath,
    dirExistedBefore,
    attempts,
    rowTexts,
    rows,
    counters,
    parentEntries: readdirSync(path.dirname(resolvedDir)),
    files: dirCreated ? readdirSync(resolvedDir) : [],
    dirCreated,
    modes: {
      dir: dirCreated ? modeBits(resolvedDir) : '(absent)',
      file: firstPath !== undefined && existsSync(firstPath) ? modeBits(firstPath) : '(absent)',
    },
    sentinelBody: existsSync(sentinelPath) ? readFileSync(sentinelPath) : null,
    calls,
  };
}

// ── the collision arm ─────────────────────────────────────────────────────────────────────────

/**
 * Drives ONE attempt whose preferred file name is already taken, and reports what survived.
 *
 * THE PORT IS BUILT HERE rather than run through the service, because the reading is about the row's
 * `path` under a name the service cannot be told in advance: the service mints the id internally, and
 * this arm has to place the sentinel at the name that id implies BEFORE the write. Building the port
 * and calling `recordAttempt` with the id the port itself minted keeps the shipping construction
 * point on the path — this is the same `createVoiceCapture` a deployment wires, with a known salt.
 *
 * THE PREFERRED NAME IS LEARNED, NOT SPELLED. The scratch write below asks the SHIPPING sink what
 * name it would choose for this id, so the sentinel lands on the real collision point even if the
 * naming scheme changes; a criterion that hard-coded `audio-<salt>-1.bin` would keep passing after
 * the scheme moved and would be measuring its own guess.
 */
function runCollision(capture: CaptureModule, root: string): Collision {
  const directory = path.join(root, 'recordings');
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const lines: string[] = [];
  const log: VoiceLogPort = {
    info: (message: string): void => {
      lines.push(message);
    },
  };
  const port = capture.createVoiceCapture({
    mode: 'audio',
    log,
    instanceSalt: INJECTED_SALT,
    audio: capture.createVoiceCaptureAudioSink({ directory }),
  });

  const id = port.newAttemptId();

  // The preferred name, learned from a scratch write of the SAME id, then the scratch tree is removed
  // so nothing but the sentinel and the real recording remain inside this arm's root.
  const probeDir = mkdtempSync(path.join(root, 'probe-'));
  const preferred = path.basename(
    capture.createVoiceCaptureAudioSink({ directory: probeDir }).writeAudio(probeDir, id, AUDIO),
  );
  rmSync(probeDir, { recursive: true, force: true });

  // The sentinel: the preferred name, DIFFERENT bytes. Its invariance is the whole point.
  const sentinelPath = path.join(directory, preferred);
  writeFileSync(sentinelPath, SENTINEL_BYTES, { mode: 0o600 });

  port.recordAttempt(id, {
    providerId: 'collision',
    outcome: 'ok',
    status: 200,
    audio: AUDIO,
    payload: {
      model: DEFAULTS.sttModel,
      baseUrl: DEFAULTS.baseUrl,
      audio: AUDIO,
      upstream: null,
      requestSent: false,
      reading: { ok: true, text: '' },
    },
  });

  const row = lines.map((line) => parseCaptureRow(line)).find((parsed) => parsed !== null) ?? null;
  const newPath = row === null ? '' : fieldString(row, 'path');
  const sentinel = existsSync(sentinelPath) ? readFileSync(sentinelPath) : null;
  const written = newPath !== '' && existsSync(newPath) ? readFileSync(newPath) : Buffer.alloc(0);

  return {
    id,
    preferred,
    newPath,
    sentinelIntact: sentinel !== null && sentinel.equals(SENTINEL_BYTES),
    nameChanged: newPath !== '' && path.basename(newPath) !== preferred,
    pathUnderDir: isUnder(directory, newPath),
    bytesEqual: written.equals(AUDIO_BYTES),
    shaMatch: row !== null && sha256Hex(written) === fieldString(row, 'sha256'),
  };
}

// ── the measurement ───────────────────────────────────────────────────────────────────────────

/**
 * Counts a token in a source text, on a WORD BOUNDARY rather than as a bare substring.
 *
 * The boundary is the whole point of this helper. `process.env.VOICE_CAPTURE` is a PREFIX of
 * `process.env.VOICE_CAPTURE_DIR`, so a bare substring count of the first is raised by the second —
 * and the count this criterion reports is about the mode variable, which `VOICE_CAPTURE_DIR` is not.
 */
function countToken(source: string, token: string): number {
  return source.split(new RegExp(`${token.replace(/\./g, '\\.')}(?![\\w$])`)).length - 1;
}

/**
 * THE measurement: five arms, one umask, the purity probe and the source scans.
 *
 * THE UNSET UMASK IS SET HERE AND RESTORED IN `finally`, around everything that touches the disk: the
 * permission promises are made to a filesystem, so reading them under the machine's inherited umask
 * would measure the machine. The process's own value is put back before this function returns, so a
 * sibling criterion in the same process is unaffected.
 *
 * THE PURE PROBE COMES FIRST, before any arm writes to the environment, because AC2's subject is
 * that the resolver reads NO global: the three calls below pass their arguments and are taken while
 * the variables are whatever the caller's process had.
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
  const root = readFileSync(SHIPPING_MODULE_ROOT, 'utf8');

  const probeParent = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-audio-resolve-'));
  const explicit = path.join(probeParent, 'explicit');
  const database = path.join(probeParent, 'auth.db');
  const resolveProbe = {
    parent: probeParent,
    explicit,
    database,
    gotExplicit: capture.resolveVoiceCaptureDir(explicit, database),
    gotDefault: capture.resolveVoiceCaptureDir(undefined, database),
    gotBlank: capture.resolveVoiceCaptureDir('   ', database),
  };

  const settings = settingsFor();
  const overrides: VoiceRequestOverrides = { providerId: adapter.id, sttModel: DEFAULTS.sttModel };
  const one: Step[] = successSteps(1, 'one');
  const three: Step[] = successSteps(REPEAT_ATTEMPTS, 'repeat');

  const stash = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-audio-criterion-'));
  const parents = {
    audio: path.join(stash, 'audio'),
    repeat: path.join(stash, 'repeat'),
    text: path.join(stash, 'text'),
    off: path.join(stash, 'off'),
    default: path.join(stash, 'default'),
  };
  for (const parent of Object.values(parents)) {
    mkdirSync(parent, { recursive: true });
  }

  const inheritedUmask = process.umask();
  process.umask(0o000);
  try {
    const activeUmask = process.umask();

    const audio = await runArm({
      name: 'audio',
      mode: 'audio',
      captureDir: path.join(parents.audio, 'recordings'),
      databasePath: path.join(parents.audio, 'auth.db'),
      capture,
      createService: serviceModule.createVoiceService,
      steps: one,
      settings,
      overrides,
    });

    // The accumulation arm: a directory this FILE creates first, with a sentinel already in it, so
    // the three writes are three ADDITIONS to a non-empty directory and the sentinel is the positive
    // control that makes "nothing was deleted" a reading about a survivor rather than about an empty
    // set. Creating it here rather than letting the writer create it also keeps this arm's subject
    // on the accumulation instead of on the directory's creation, which is AC3's subject.
    const repeat = await runArm({
      name: 'repeat',
      mode: 'audio',
      captureDir: path.join(parents.repeat, 'recordings'),
      databasePath: path.join(parents.repeat, 'auth.db'),
      capture,
      createService: serviceModule.createVoiceService,
      steps: three,
      settings,
      overrides,
      precreateDir: true,
      seedFiles: [{ name: SENTINEL_NAME, bytes: SENTINEL_BYTES }],
    });

    const text = await runArm({
      name: 'text',
      mode: 'text',
      captureDir: path.join(parents.text, 'recordings'),
      databasePath: path.join(parents.text, 'auth.db'),
      capture,
      createService: serviceModule.createVoiceService,
      steps: three,
      settings,
      overrides,
    });

    // The ROW for a mode that writes nothing. `off` is the arm where the resolver must not be reached
    // at all: the port returns before building a row, so nothing asks the sink for a directory.
    const off = await runArm({
      name: 'off',
      mode: undefined,
      captureDir: path.join(parents.off, 'recordings'),
      databasePath: path.join(parents.off, 'auth.db'),
      capture,
      createService: serviceModule.createVoiceService,
      steps: one,
      settings,
      overrides,
    });

    // The DEFAULT arm: `VOICE_CAPTURE_DIR` absent, the database inside this run's temp tree. The
    // directory the deployment resolves is therefore a function of the database path — which is what
    // makes "beside the database" a reading rather than a sentence.
    const defaultArm = await runArm({
      name: 'default',
      mode: 'audio',
      captureDir: undefined,
      databasePath: path.join(parents.default, 'auth.db'),
      capture,
      createService: serviceModule.createVoiceService,
      steps: one,
      settings,
      overrides,
    });

    // ── the byte readings, taken from the FILE rather than from anything the write returned.
    const firstRow = audio.rows[0];
    const firstPath = audio.counters.paths[0];
    const onDisk =
      firstPath === undefined || !existsSync(firstPath) ? Buffer.alloc(0) : readFileSync(firstPath);
    const bytesEqual = onDisk.equals(AUDIO_BYTES);
    if (!bytesEqual) {
      // Printed rather than thrown: the falsifying file has to be able to see WHICH reading noticed,
      // and a throw here would end the list at the first case instead.
      process.stdout.write(
        `audio/write-mismatch: sent=${fingerprint(AUDIO_BYTES)} on-disk=${fingerprint(onDisk)}\n`,
      );
    }

    // ── the accumulation readings: three writes, three names, all present and all unchanged.
    const repeatPaths = repeat.counters.paths;
    const repeatIds = repeat.rows.map((row) => fieldString(row, 'captureId'));
    const accumulation = {
      distinctPaths: new Set(repeatPaths).size === REPEAT_ATTEMPTS,
      distinctIds: new Set(repeatIds).size === REPEAT_ATTEMPTS && repeatIds.every((id) => id !== ''),
      eachEqual: repeatPaths.every(
        (target) => existsSync(target) && readFileSync(target).equals(AUDIO_BYTES),
      ),
      surviving: repeatPaths.filter(
        (target) => existsSync(target) && readFileSync(target).equals(AUDIO_BYTES),
      ).length,
    };

    // ── the deletion scan: the two shipping files, read as text. A module that cleaned up after
    // itself would satisfy every count above and destroy the accumulation this task promises, so the
    // absence of a deletion is read from the source that would have to contain one.
    const shippable = [SHIPPING_CAPTURE_MODULE, SHIPPING_MODULE_ROOT].map((file) =>
      readFileSync(file, 'utf8'),
    );
    const deletionCall = new RegExp(['unlink', 'Sync', '|rm', 'Sync', '|fs\\.rm\\(', '|rmdir', 'Sync'].join(''));
    const noDeleteCall = !shippable.some((source) => deletionCall.test(source));

    // ── the collision arm: one attempt whose preferred name is already occupied. It runs LAST so it
    // cannot perturb the arms above, and through the same `capture` module a mutation case copies.
    const collision = runCollision(capture, path.join(stash, 'collision'));

    return {
      audio,
      repeat,
      text,
      off,
      default: defaultArm,
      collision,
      resolve: resolveProbe,
      root: {
        envDirReads: countToken(root, 'process.env.VOICE_CAPTURE_DIR'),
        // The raw switch's own read, token-bounded so `VOICE_CAPTURE_DIR` and `VOICE_CAPTURE_RAW`
        // are not mistaken for it. It is a SECOND read of a `VOICE_CAPTURE`-prefixed variable, so the
        // unbounded substring count is raised by it exactly as it is by the directory read — see the
        // AC2 wiring reading, whose equation now names both.
        envRawReads: countToken(root, 'process.env.VOICE_CAPTURE_RAW'),
        resolverCalled: root.includes('resolveVoiceCaptureDir('),
        envCaptureSubstring: root.split('process.env.VOICE_CAPTURE').length - 1,
        envCaptureToken: countToken(root, 'process.env.VOICE_CAPTURE'),
      },
      umask: activeUmask.toString(8).padStart(3, '0'),
      file: {
        bytesEqual,
        lenEqual: onDisk.length === AUDIO_BYTES.length,
        shaFromFile: sha256Hex(onDisk),
        shaInRow: firstRow === undefined ? '(no row)' : fieldString(firstRow, 'sha256'),
        shaMatch:
          firstRow !== undefined && sha256Hex(onDisk) === fieldString(firstRow, 'sha256'),
      },
      accumulation,
      noDeleteCall,
      doors: openDoors(),
    };
  } finally {
    process.umask(inheritedUmask);
    rmSync(stash, { recursive: true, force: true });
    rmSync(probeParent, { recursive: true, force: true });
  }
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (measurement: Measurement) => Measured };

const READINGS: readonly Reading[] = [
  // ── AC2: one resolver, fed its arguments, and never reached by a mode that writes nothing ─────
  {
    name: 'AC2 directory resolution',
    run: (measurement) => {
      const { resolve } = measurement;
      const defaultDir = path.join(resolve.parent, 'voice-capture');
      return {
        value:
          `explicit=${resolve.gotExplicit} default=${resolve.gotDefault} blank=${resolve.gotBlank} ` +
          `resolverInput=${String(measurement.audio.resolverInput)}`,
        ok:
          // The three answers are compared against what the ARGUMENTS imply, computed here rather
          // than against literals the resolver could have been written to return.
          resolve.gotExplicit === resolve.explicit &&
          resolve.gotDefault === defaultDir &&
          // A blank string is not a setting: it has to fall through to the same answer as no value.
          resolve.gotBlank === defaultDir,
      };
    },
  },
  // ── AC2: the composition root reads the variable once and calls the resolver ───────────────────
  {
    name: 'AC2 composition root wiring',
    run: (measurement) => ({
      value:
        `envDirReads=${measurement.root.envDirReads} ` +
        `envRawReads=${measurement.root.envRawReads} ` +
        `resolverCalled=${String(measurement.root.resolverCalled)} ` +
        `envCaptureSubstring=${measurement.root.envCaptureSubstring} ` +
        `envCaptureToken=${measurement.root.envCaptureToken} ` +
        `delta=${measurement.root.envCaptureSubstring - measurement.root.envCaptureToken}`,
      ok:
        // EXACTLY one read of the directory variable, because a second one is a second answer to
        // "where do recordings go" and nothing keeps the two in step.
        measurement.root.envDirReads === 1 &&
        measurement.root.resolverCalled &&
        // The boundary count is the one that reads the MODE variable, and it must stay put as the
        // directory AND raw variables are added: the substring count is raised by each of them, and
        // the two being different is the measurement, not a defect. The equation names every
        // `VOICE_CAPTURE`-prefixed read so a FOURTH one added without accounting for it is a red.
        measurement.root.envCaptureToken >= 1 &&
        measurement.root.envCaptureSubstring ===
          measurement.root.envCaptureToken + measurement.root.envDirReads + measurement.root.envRawReads,
    }),
  },
  // ── AC2: `off` resolves nothing ───────────────────────────────────────────────────────────────
  {
    name: 'AC2 off resolves nothing',
    run: (measurement) => ({
      value:
        `off.dirResolves=${measurement.off.counters.resolves} ` +
        `off.writeCalls=${measurement.off.counters.writes} ` +
        `audio.dirResolves=${measurement.audio.counters.resolves} ` +
        `audio.writeCalls=${measurement.audio.counters.writes}`,
      ok:
        // The zero has a companion: the SAME sink, in the mode that writes, is reached. Without
        // that pair this would read the same against a sink that could never be reached at all.
        measurement.off.counters.resolves === 0 &&
        measurement.off.counters.writes === 0 &&
        measurement.audio.counters.resolves === 1 &&
        measurement.audio.counters.writes === 1,
    }),
  },
  // ── AC3: one attempt, one row, and the bytes that went in are the bytes on disk ───────────────
  {
    name: 'AC3 audio write',
    run: (measurement) => {
      const { audio, file } = measurement;
      const row = audio.rows[0];
      const rowPath = row === undefined ? '' : fieldString(row, 'path');
      return {
        value:
          `rows=${audio.rows.length} allRowsParse=${String(audio.attempts.every((a) => a.allRowsParse))} ` +
          `row.path=${rowPath} absPath=${String(path.isAbsolute(rowPath))} ` +
          `pathUnderDir=${String(isUnder(audio.dir, rowPath))} ` +
          `dirExistedBefore=${String(audio.dirExistedBefore)} ` +
          `bytesEqual=${String(file.bytesEqual)} lenEqual=${String(file.lenEqual)} ` +
          `shaFromFile=${file.shaFromFile} shaInRow=${file.shaInRow} shaMatch=${String(file.shaMatch)}`,
        ok:
          // EXACTLY one row for one successful attempt: a second line would mean the attempt was
          // recorded twice, and a row that is not single-line JSON would not be readable at all.
          audio.rows.length === 1 &&
          audio.attempts.every((attempt) => attempt.allRowsParse) &&
          path.isAbsolute(rowPath) &&
          // The directory is compared against the one the DEPLOYMENT resolved, not against the
          // string this file set: a resolver that answered something else would otherwise pass by
          // having this reading compare the wrong pair.
          path.dirname(rowPath) === audio.dir &&
          isUnder(audio.dir, rowPath) &&
          // The directory did not exist before the write and does now, so the mkdir is the writer's.
          !audio.dirExistedBefore &&
          audio.dirCreated &&
          file.bytesEqual &&
          file.lenEqual &&
          file.shaMatch &&
          /^[0-9a-f]{64}$/.test(file.shaFromFile),
      };
    },
  },
  // ── AC4: the permission bits, on the filesystem, under an umask that hides nothing ────────────
  {
    name: 'AC4 permissions under a wide umask',
    run: (measurement) => ({
      value:
        `umask=0o${measurement.umask} dirMode=${measurement.audio.modes.dir} ` +
        `fileMode=${measurement.audio.modes.file} ` +
        `dirExact=${String(measurement.audio.modes.dir === '0700')} ` +
        `fileExact=${String(measurement.audio.modes.file === '0600')}`,
      // READ UNDER `umask 0o000`, so the requested bits are what lands on disk. An implementation
      // that passes no mode and chmods nothing lands at `0777`/`0666` here; one that passes `mode:`
      // and is asked for exactly these bits lands on them. See the falsifying file for what that
      // does and does not separate.
      ok: measurement.audio.modes.dir === '0700' && measurement.audio.modes.file === '0600',
    }),
  },
  // ── AC5: three attempts accumulate, and nothing that was there is gone ────────────────────────
  {
    name: 'AC5 accumulation and no deletion',
    run: (measurement) => {
      const { repeat, accumulation } = measurement;
      const added = repeat.files.filter((name) => name !== SENTINEL_NAME).length;
      return {
        value:
          `files=${added} distinct=${String(accumulation.distinctPaths)} ` +
          `allIdsDistinct=${String(accumulation.distinctIds)} eachEqual=${String(accumulation.eachEqual)} ` +
          `survivingPaths=${accumulation.surviving} ` +
          `sentinelKept=${String(repeat.sentinelBody !== null)} ` +
          `sentinelEqual=${String(repeat.sentinelBody !== null && repeat.sentinelBody.equals(SENTINEL_BYTES))} ` +
          `noDeleteCall=${String(measurement.noDeleteCall)} rows=${repeat.rows.length}`,
        ok:
          // THREE additions to a directory this file had already put a sentinel in: the count is of
          // files that were not there before, taken after the arm rather than derived from the calls.
          added === REPEAT_ATTEMPTS &&
          repeat.rows.length === REPEAT_ATTEMPTS &&
          accumulation.distinctPaths &&
          accumulation.distinctIds &&
          accumulation.eachEqual &&
          accumulation.surviving === REPEAT_ATTEMPTS &&
          // The positive control: a file that existed before the first attempt is still there, byte
          // for byte. Without it "no paths were deleted" would also hold for a directory that was
          // wiped and rewritten, and for an empty set.
          repeat.sentinelBody !== null &&
          repeat.sentinelBody.equals(SENTINEL_BYTES) &&
          measurement.noDeleteCall,
      };
    },
  },
  // ── AC2 (this task): an occupied preferred name is given way to, never overwritten ─────────────
  {
    name: 'AC2 collision never overwrites',
    run: (measurement) => {
      const { collision } = measurement;
      return {
        value:
          `sentinel-intact=${String(collision.sentinelIntact)} new-path=${collision.newPath} ` +
          `preferred=${collision.preferred} id=${collision.id} ` +
          `nameChanged=${String(collision.nameChanged)} ` +
          `pathUnderDir=${String(collision.pathUnderDir)} ` +
          `bytesEqual=${String(collision.bytesEqual)} shaMatch=${String(collision.shaMatch)}`,
        ok:
          // The sentinel: the file that was already at the preferred name still holds the bytes this
          // criterion put there, so the write gave way instead of truncating it.
          collision.sentinelIntact &&
          // The new recording: a DIFFERENT name, inside the directory, holding the upload byte for
          // byte, with a sha256 recomputed from the file equal to the row's own field — the row names
          // the file that was actually written rather than the name that was refused.
          collision.nameChanged &&
          collision.pathUnderDir &&
          collision.bytesEqual &&
          collision.shaMatch,
      };
    },
  },
  // ── AC6: the same harness, the mode that writes nothing ───────────────────────────────────────
  {
    name: 'AC6 text writes nothing',
    run: (measurement) => {
      const { text } = measurement;
      return {
        value:
          `text.dirCreated=${String(text.dirCreated)} text.files=${text.files.length} ` +
          `text.parentEntries=${text.parentEntries.length} text.writeCalls=${text.counters.writes} ` +
          `text.pathKeyAbsent=${String(text.rows.every((row) => !('path' in row)))} ` +
          `text.rows=${text.rows.length} ` +
          `text.fieldsPresent=${String(text.rows.length > 0 && text.rows.every(fieldsPresent))} ` +
          `text.allRowsParse=${String(text.attempts.every((a) => a.allRowsParse))}`,
        ok:
          // The zero is the SHIPPING writer's: the port was handed the shipped sink, so a `text`
          // deployment that wrote a file would be caught here rather than by a stand-in that refused.
          !text.dirCreated &&
          text.files.length === 0 &&
          // The temp parent as well as the directory: an implementation that put its recordings
          // somewhere else under the configured parent would pass a reading about one path only.
          text.parentEntries.length === 0 &&
          text.counters.writes === 0 &&
          // The row is still a row: the same three attempts, all with their fields, and none of them
          // carrying the one key that belongs to the mode that writes.
          text.rows.length === REPEAT_ATTEMPTS &&
          text.rows.every(fieldsPresent) &&
          text.rows.every((row) => !('path' in row)) &&
          text.attempts.every((attempt) => attempt.allRowsParse),
      };
    },
  },
  // ── AC7: the default the deployment gets when it sets nothing ──────────────────────────────────
  {
    name: 'AC7 default directory beside the database',
    run: (measurement) => {
      const { default: arm } = measurement;
      const row = arm.rows[0];
      const rowPath = row === undefined ? '' : fieldString(row, 'path');
      const homeDefault = path.join(os.homedir(), '.cloudcli', 'voice-capture');
      // "Beside the database", computed from THIS arm's database path: the promise is a sibling of
      // `auth.db` rather than a path this file chose, and the arm is the deployment that resolves it.
      const expectedDir = path.join(path.dirname(arm.databasePath), 'voice-capture');
      const touchedHomeDir = arm.dir === homeDefault || isUnder(os.homedir(), arm.dir);
      return {
        value:
          `defaultDir=${arm.dir} expectedDir=${expectedDir} resolverInput=${String(arm.resolverInput)} ` +
          `dirCreated=${String(arm.dirCreated)} files=${arm.files.length} ` +
          `dirMode=${arm.modes.dir} fileMode=${arm.modes.file} ` +
          `pathGrandparent=${path.dirname(path.dirname(rowPath))} ` +
          `grandparentIsDatabaseDir=${String(path.dirname(path.dirname(rowPath)) === path.dirname(arm.databasePath))} ` +
          `touchedHomeDir=${String(touchedHomeDir)}`,
        ok:
          arm.dir === expectedDir &&
          // The AC's own reading: two levels up from the file is the directory the DATABASE is in,
          // which is what "beside the database" means as a figure rather than as a phrase.
          path.dirname(path.dirname(rowPath)) === path.dirname(arm.databasePath) &&
          // The variable was ABSENT for this arm: a resolver handed a literal would answer the same
          // way whether or not the environment carried one, and this is the reading that says the
          // deployment's own value is what it saw.
          arm.resolverInput === undefined &&
          // The row's path is one level inside that directory, so the file is IN it.
          path.dirname(rowPath) === arm.dir &&
          arm.dirCreated &&
          arm.files.length === 1 &&
          arm.modes.dir === '0700' &&
          arm.modes.file === '0600' &&
          // The deployment's default must not be the real home directory's, and this run must not
          // have created one: both halves are the same claim about THIS measurement.
          !touchedHomeDir,
      };
    },
  },
  // ── AC10: what this criterion covered, registered rather than asserted in prose ────────────────
  {
    name: 'AC10 registration',
    run: (measurement) => ({
      value:
        'scope=[the audio mode`s own delivery: the directory resolution, the write port`s default ' +
        'implementation and its injection, the row`s `path` and a sha256 recomputed from the file, ' +
        '0700/0600 read off the filesystem under a zero umask, three attempts accumulating without ' +
        'deletion, and the two zeroes in `text` mode] out-of-scope=[key/header redaction ' +
        '(AC-146), capture-failure isolation (AC-147), any real-process reading (AC-148), retention ' +
        'or a size ceiling — there is none by design] fixtures=[stand-in fetchBackend, injected log ' +
        'port, the SHIPPED write-audio factory behind a counting wrapper] truth=[every reading above ' +
        'ran against a stand-in transport and an injected log port; nothing reached a real upstream, ' +
        'no process was started, no socket was opened, and the only files written are the ones this ' +
        'run resolved inside its own temp tree] ' +
        `arms=${[measurement.audio, measurement.repeat, measurement.text, measurement.off, measurement.default]
          .map((arm) => `${arm.name}:${arm.rows.length}`)
          .join(' ')} ` +
        `umask=0o${measurement.umask} socket-doors=${measurement.doors.length} ` +
        `resolve.input=${String(measurement.audio.resolverInput)}`,
      ok:
        // The registration is tied to figures, so a run that silently stopped driving an arm cannot
        // print this as its provenance.
        measurement.audio.rows.length === 1 &&
        measurement.repeat.rows.length === REPEAT_ATTEMPTS &&
        measurement.text.rows.length === REPEAT_ATTEMPTS &&
        measurement.off.rows.length === 0 &&
        measurement.default.rows.length === 1 &&
        measurement.umask === '000' &&
        measurement.doors.length === 0,
    }),
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
