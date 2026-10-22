/**
 * `VOICE_CAPTURE`'s mode gate: what `off` IS, and what it must not do (AC-143).
 *
 * WHAT THIS FILE IS FOR. `VOICE_CAPTURE` selects one of three recording modes at start-up, and the
 * two recording modes are a privacy decision rather than a debugging detail: an attempt's structured
 * line is one thing, and a row — or an uploaded recording — kept beside it is another. Two failures
 * are worth a criterion, and both are cheap to make accidentally:
 *
 *   1. a deployment that NEVER SET THE VARIABLE, or misspelled it, records anyway — the fail-open
 *      shape, where the mode is read as "on unless something says otherwise";
 *   2. a seam that changes what an `off` deployment already logs today — an extra line, an added
 *      field, a directory created beside the database.
 *
 * The readings are measurements of four questions, all taken through the SHIPPING modules, with an
 * injected `fetchBackend` and a frozen clock (nothing here touches the network, and `latencyMs` is a
 * constant so the byte-for-byte comparison is about the seam rather than about timing):
 *
 *   · AC2 — are the three `off`-reading cases BYTE-IDENTICAL to a baseline service built with NO
 *     capture port at all? Compared line by line, because "the log contains no capture row" is blind
 *     to "the log gained a different line";
 *   · AC3 — do those cases touch the filesystem? The injected write-audio port REALLY writes when it
 *     is reached, and two audio control arms reach it in the same run, so the zero is a measured
 *     zero rather than a port that could not have written;
 *   · AC4 — which mode does the process say it came up in, does an unrecognised value earn exactly
 *     one warning naming it and read as `off`, and does the composition root read the variable once
 *     and call the module's own start-up function;
 *   · AC5 — is the zero not an empty implementation? The same input in `text` mode must produce
 *     exactly two capture rows, each carrying the same `captureId` as the attempt line above it;
 *   · AC8 — the scope this criterion does NOT cover is printed beside the parts of the claim that
 *     ARE measurable (the row's field set, the absent audio sink in the shipping composition root,
 *     the frozen clock visible in every line, and the door list AC1 reads too), so the registration
 *     is a reading a reader can check rather than a paragraph a reader can only trust.
 *
 * HOW IT IS STRUCTURED, and why this matters to a reader of a red: the readings live in one exported
 * function so that the FALSIFYING file (`voice-capture-off.false-forms.test.ts`) can run this very
 * list against a text-mutated copy of `voice.service.ts` or `voice-capture.ts` and require the
 * readings it predicts to go red. Registering them as `node:test` cases is guarded by `IS_ENTRY`, so
 * importing this file registers nothing and the falsify run measures only what it asked for.
 *
 * AC6's OTHER HALF LIVES IN THE FALSIFYING FILE, and the split is forced by AC1's own budget: the
 * four existing criteria plus `npm run typecheck` and `npm run lint` are SUBPROCESSES, and AC1
 * requires THIS file to start none. Its `AC1 scope` reading reports that mechanically by reading
 * this file's own module specifiers. AC6's in-process half — the `off` attempt line gains no field —
 * is measured here, where the lines already are.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { VoiceLogPort, VoiceService } from '@/shared/types.js';
import type {
  VoiceCaptureAudio,
  VoiceCaptureAudioSink,
  VoiceCaptureMode,
  VoiceCapturePort,
  VoiceCaptureResolution,
} from '../voice-capture.js';

// ── where things are ──────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `server/` — three levels above this file (`server/modules/voice/tests/`). */
const SERVER_DIR = path.resolve(HERE, '../../..');

/** The shipping service module: the GATE under test, and the file a mutation case copies. */
export const SHIPPING_SERVICE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.service.ts');
/** The shipping capture module: the mode, the lines, the directory and the one row construction point. */
export const SHIPPING_CAPTURE_MODULE = path.join(SERVER_DIR, 'modules/voice/voice-capture.ts');

/**
 * The composition root, READ AS TEXT and never imported.
 *
 * Importing it would read the environment, build a live service and mount a router; AC4 asks a
 * property of its SOURCE (the variable occurs once, the start-up function is called), so the file is
 * read rather than loaded.
 */
const COMPOSITION_ROOT_MODULE = path.join(SERVER_DIR, 'modules/voice/voice.module.ts');

/** This file, read as text by `AC1 scope` — see the decision list in the header. */
const SELF_MODULE = fileURLToPath(import.meta.url);

const STARTED_AT = Date.now();

/** How many readings this file measures. A deleted reading is a red, not a shorter list. */
const READINGS_EXPECTED = 20;

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

/** The deployment shape every arm is driven with: the same defaults the other voice criteria use. */
const DEFAULTS = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

const TIMEOUT_MS = 1_000;

/** The ONE recording every arm sends, baseline and case alike. */
const AUDIO = {
  bytes: Buffer.concat([Buffer.from('criterion recording 0f3c', 'utf8'), Buffer.alloc(1_000, 0x5c)]),
  mimeType: 'audio/webm',
  fileName: 'recording.webm',
};

/**
 * The clock every arm runs on, so `latencyMs` is a constant in every line.
 *
 * Without it the comparison would be between two timestamps rather than between two seams, and the
 * criterion would have to special-case the field it cannot compare.
 */
const FROZEN_NOW = 1_700_000_000_000;

/** The `event` every capture row carries — the AC's own name for it, not the module's constant. */
const CAPTURE_EVENT = 'voice.capture';

/** The marker every row's `captureId` carries in `text` mode, as the module mints it. */
const CAPTURE_ID_PATTERN = / captureId=(\S+)$/;

type Reply = 'ok' | 'fail';

/** The success the recogniser answers with: one body, built fresh because a body reads once. */
function upstreamSuccess(): Response {
  return new Response(JSON.stringify({ text: 'criterion transcript sentinel 8d02' }), { status: 200 });
}

/** The upstream failure AC2 names: a 404 and an error body. */
function upstreamFailure(): Response {
  return new Response(
    JSON.stringify({ error: { message: 'criterion upstream sentinel 3b7e', type: 'invalid_request_error' } }),
    { status: 404 },
  );
}

// ── the arms ──────────────────────────────────────────────────────────────────────────────────

/** Which directory the injected sink resolves when it is reached; `none` wires no port at all. */
type SinkSpec = 'explicit' | 'default' | 'none';

type ArmSpec = {
  /** The name the arm is printed under (`case=<name>`). */
  name: string;
  /** The raw `VOICE_CAPTURE` value this arm's deployment would have been handed. */
  raw: string | undefined;
  sink: SinkSpec;
};

/** The baseline: the same two attempts through a service with NO capture port injected. */
const BASELINE_ARM: ArmSpec = { name: 'baseline', raw: undefined, sink: 'none' };

/**
 * The three raw values that must read as `off`, and the name each is printed under.
 *
 * `unset` and `off` are the two ways to say "do not record"; `verbose` is a value nobody defined, and
 * it is here because the fail-closed decision is about values that were never recognised — a set of
 * cases that only ever contained legal values could not see the difference at all.
 */
const OFF_CASES: readonly ArmSpec[] = [
  { name: 'unset', raw: undefined, sink: 'explicit' },
  { name: 'off', raw: 'off', sink: 'explicit' },
  { name: 'invalid', raw: 'verbose', sink: 'explicit' },
];

/** The positive control (AC5): the same input in the one mode that must add rows. */
const TEXT_CASE: ArmSpec = { name: 'text', raw: 'text', sink: 'explicit' };

/**
 * The two sink controls (AC3).
 *
 * THEY ARE THE REASON the zeros above are measurements. Both drive `audio` mode with the SAME sink
 * the `off` cases inject, and each reaches one half of the write path: the first resolves the
 * configured path, so the directory and the file really appear; the second resolves the DEFAULT
 * directory (beside the database), so the default-resolution counter is shown to be live. A rig
 * whose sink could never have written would produce the same zeros as a deployment that records
 * nothing, and these two arms are what tells those apart.
 */
const AUDIO_CONTROLS: readonly ArmSpec[] = [
  { name: 'audio-explicit', raw: 'audio', sink: 'explicit' },
  { name: 'audio-default', raw: 'audio', sink: 'default' },
];

/** Every arm the rig drives, in the order the readings are printed. */
const ARMS: readonly ArmSpec[] = [BASELINE_ARM, ...OFF_CASES, TEXT_CASE, ...AUDIO_CONTROLS];

// ── the wiring, as this file calls it ─────────────────────────────────────────────────────────

type ServiceDeps = {
  defaults: typeof DEFAULTS;
  timeoutMs: number;
  fetchBackend: (url: string, options: RequestInit) => Promise<Response>;
  logger?: VoiceLogPort;
  capture?: VoiceCapturePort;
};

type ServiceModule = {
  createVoiceService: (dependencies: ServiceDeps) => VoiceService;
};

type CaptureModule = {
  resolveVoiceCaptureMode: (raw: string | undefined) => VoiceCaptureResolution;
  voiceCaptureStartupLine: (mode: VoiceCaptureMode) => string;
  voiceCaptureWarningLine: (value: string) => string;
  /** The start-up function the composition root calls. `name` is read to look for that call. */
  announceVoiceCapture: ((raw: string | undefined, log: VoiceLogPort) => VoiceCaptureResolution) & { name: string };
  resolveVoiceCaptureDir: (raw: string | undefined, databasePath: string | undefined) => string;
  createVoiceCapture: (dependencies: {
    mode: VoiceCaptureMode;
    log: VoiceLogPort;
    audio?: VoiceCaptureAudioSink;
  }) => VoiceCapturePort;
  /**
   * The module's own audio sink, when it ships one.
   *
   * OPTIONAL, AND THE ABSENCE IS A READING RATHER THAN A SKIP — the same shape as the payload builder
   * below, and read off the module under test for the same reason. The audio half of this seam (the
   * file write, the directory, their 0700/0600) is a LATER delivery than this criterion, so "the
   * composition root wires no audio sink" was a true registration about AC-143 and stopped being one
   * the moment that half landed. Reading the factory off the module is what lets the AC8 registration
   * tell "this module has no audio half" from "this module has one and the root wires it" — a
   * sentence this file could not otherwise say about a repository that has moved on.
   */
  createVoiceCaptureAudioSink?: (options: { directory: string }) => VoiceCaptureAudioSink;
  /**
   * The module's payload builder, when it ships one.
   *
   * OPTIONAL, AND THE ABSENCE IS A READING RATHER THAN A SKIP. The row's payload refinement is a
   * later delivery of this seam and this criterion does not verify its CONTENTS — but it does verify
   * that a row carries no field the module's own construction point does not produce, and that check
   * needs the builder's key set. A module with no builder predates the payload, so the key set is
   * empty and the expectation is the five declared fields: stricter than the relaxation, never
   * looser. See `payloadKeySet` and the AC8 registration reading.
   */
  buildVoiceCapturePayload?: (input: {
    model: string;
    baseUrl: string;
    audio: VoiceCaptureAudio;
    upstream: { status: number; body: string } | null;
    requestSent: boolean;
    reading: { ok: boolean; text: string };
  }) => Record<string, unknown>;
};

/** Which module each half of the rig is imported from; both default to the shipping module. */
type CriterionModules = {
  service?: string;
  capture?: string;
};

/** The three paths one run resolves under its own temp parent. */
type TempPaths = {
  /** The temp parent: `VOICE_CAPTURE_DIR` points INSIDE it, so its entries are the whole footprint. */
  parent: string;
  /** The path `VOICE_CAPTURE_DIR` is pointed at: a path that must not exist after the attempts. */
  captureDir: string;
  /** A database path inside the temp parent, so the DEFAULT directory resolves under it too. */
  databasePath: string;
};

// ── what one arm measured ─────────────────────────────────────────────────────────────────────

type SinkCounters = {
  /** Calls to the sink's `writeAudio`: the port asking for bytes to be kept. */
  writeAudioCalls: number;
  /** Calls the sink made through the directory resolver, with either kind of input. */
  resolverCalls: number;
  /** Of those, the calls that resolved the DEFAULT directory (no explicit path). */
  defaultResolves: number;
  /** The files the sink actually wrote. */
  written: string[];
};

type CaptureRow = {
  /** Where the row sits in the arm's line list — adjacency to its attempt line is read off this. */
  index: number;
  line: string;
  parsed: Record<string, unknown>;
};

type ArmMeasurement = {
  name: string;
  /** Every line the arm's log port collected, in order. */
  lines: string[];
  /** The `voice.transcribe` lines among them. */
  attemptLines: string[];
  /** Where those attempt lines sit in `lines`. */
  attemptIndices: number[];
  /** The `captureId=` value on each attempt line, or `''` where there is none. */
  lineIds: string[];
  /** The lines that parse as capture rows. */
  rows: CaptureRow[];
  /** How many times the injected `fetchBackend` was called: the stand-in carried the attempt. */
  backendCalls: number;
  sink: SinkCounters;
  /** Whether the configured path exists after the attempts. */
  dirCreated: boolean;
  /** The entries of the temp parent after the attempts — the arm's whole filesystem footprint. */
  parentEntries: string[];
  /** Whether the DEFAULT directory (beside the database) exists after the attempts. */
  defaultDirCreated: boolean;
};

type ArmOutcome = {
  /** What the module under test says the raw value means. */
  resolution: VoiceCaptureResolution;
  /** What `transcribe` answered for the success and the failure attempt. */
  outcomes: { success: boolean; failure: boolean };
  arm: ArmMeasurement;
};

type AnnounceCase = {
  name: string;
  raw: string | undefined;
  /** The mode this raw value reads as — the input to the module's own start-up-line function. */
  mode: VoiceCaptureMode;
  /** The start-up line this case must produce. */
  startup: string;
  /** How many lines must follow it — the warning count. */
  warnLines: number;
  /** The offending value the warning must name, when there is one. */
  warns?: string;
};

/** The four raw values AC4 announces, including the positive control (`text`). */
const ANNOUNCE_CASES: readonly AnnounceCase[] = [
  { name: 'unset', raw: undefined, mode: 'off', startup: 'voice.capture mode=off', warnLines: 0 },
  { name: 'off', raw: 'off', mode: 'off', startup: 'voice.capture mode=off', warnLines: 0 },
  { name: 'invalid', raw: 'verbose', mode: 'off', startup: 'voice.capture mode=off', warnLines: 1, warns: 'verbose' },
  { name: 'text', raw: 'text', mode: 'text', startup: 'voice.capture mode=text', warnLines: 0 },
];

type Measurement = {
  /** The baseline arm: no capture port, the same two attempts. */
  baseline: ArmMeasurement;
  /** The union of field names the baseline's attempt lines carry. */
  baselineFields: string[];
  /** Every arm, keyed by the name it is printed under. */
  arms: Map<string, ArmMeasurement>;
  /** The lines the module under test's start-up function writes, keyed by case name. */
  announced: Map<string, string[]>;
  /** `process.env.VOICE_CAPTURE` occurrences in the composition root, token-bounded. */
  envReads: number;
  /** The same count without the token boundary, for a reader checking a rename. */
  envReadsSubstring: number;
  /** Whether the composition root CALLS the module's start-up function. */
  announceCalled: boolean;
  /** The symbol name that call was looked for under, read off the module under test. */
  announceSymbol: string;
  /** The composition root's own `createVoiceCapture(…)` call, as text — what it wires, and what not. */
  compositionCall: string;
  /**
   * Whether the module under test ships an audio sink at all, read off that module.
   *
   * The registration reading compares this with what the composition root's call wires, which is a
   * statement about the two halves agreeing rather than about a fact frozen at AC-143's commit. See
   * `CaptureModule.createVoiceCaptureAudioSink`.
   */
  audioSinkShipped: boolean;
  /**
   * The field names a row carries in `audio` mode, read off the module under test.
   *
   * Empty for a module that ships no audio half, and that is a reading rather than a skip — see
   * `audioRowKeySet`, which the AC8 registration reading adds to the declared fields beside the
   * payload builder's own key set.
   */
  audioRowKeys: string[];
  /**
   * The field names the module under test's payload builder produces, read off that module.
   *
   * Empty for a module that ships no builder, and that is a reading rather than a skip — see
   * `payloadKeySet` and the AC8 registration reading, which adds these to the five declared row
   * fields instead of replacing them.
   */
  payloadFields: string[];
  /**
   * The module's two line producers, taken off the SHIPPING module.
   *
   * They are held as functions so AC4 can read the start-up line and the warning as the module's own
   * output rather than as strings this criterion wrote down twice: a criterion that spelled the text
   * itself would pass against a module whose line producer had been renamed into uselessness.
   */
  lines: {
    startup: (mode: VoiceCaptureMode) => string;
    warning: (value: string) => string;
  };
};

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

/** How many times `token` occurs in `text`. */
function countOccurrences(text: string, token: string): number {
  return token === '' ? 0 : text.split(token).length - 1;
}

/**
 * The text of the first `callee(…)` call in `source`, up to its matching paren, or `null`.
 *
 * Parentheses are counted rather than the call being matched by a pattern, so an argument that spans
 * lines or carries a nested call is read whole: AC8 asks what the composition root WIRES into the
 * capture port, and "the sink is not among the arguments" is not a property of a line.
 */
function callText(source: string, callee: string): string | null {
  const start = source.indexOf(`${callee}(`);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let index = start + callee.length; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

/**
 * The doors this criterion must not have opened, as the quoted specifiers an import would carry.
 *
 * Every entry is assembled from parts at run time, because the `AC1 scope` reading reads THIS file's
 * source: a pattern written whole would match the pattern rather than an import, and the reading
 * would then report a door that was never opened. The same list is read a second time by the AC8
 * registration, which reports it beside the stand-in fetch and the frozen clock — the three together
 * are what "this criterion touched neither a real upstream nor a real process" rests on.
 *
 * `npx tsx --test <file>` runs the cases in THIS process, so "no subprocess and no socket" is a
 * property of what this file imports rather than of how it is launched.
 */
const specifier = (parts: readonly string[]): string => `'${parts.join('')}'`;
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

/** The lines of one announce call, through a collector standing in for the process's output. */
function announceFor(capture: CaptureModule, raw: string | undefined): string[] {
  const lines: string[] = [];
  capture.announceVoiceCapture(raw, {
    info: (message): void => {
      lines.push(message);
    },
  });
  return lines;
}

/**
 * The line as a capture ROW, or `null`.
 *
 * A row is read as JSON and kept only when it PARSES and names the capture event. The start-up line
 * and the warning line both contain the string `voice.capture`, so a substring test would count
 * them; and a row that was not single-line JSON would not survive `JSON.parse` at all, which is what
 * makes this predicate the AC's "合法单行 JSON" rather than a proxy for it.
 */
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
  return record.event === CAPTURE_EVENT ? record : null;
}

/**
 * The field names the module under test's payload builder produces, or none when it ships none.
 *
 * READ OFF THE MODULE RATHER THAN WRITTEN DOWN HERE, and that is the whole point of the helper: the
 * row's expected field set becomes "the five declared fields plus whatever THIS module's construction
 * point produces", so a field that appears on a row without the builder producing it is still a red.
 * A list spelled again in this file would have said nothing about the module and would have had to be
 * edited in lockstep with it.
 *
 * The argument is a minimal but COMPLETE input, so what comes back is the builder's SHAPE rather than
 * a function of the fixture: every field of a payload is returned whether or not its source is empty.
 */
function payloadKeySet(capture: CaptureModule): string[] {
  if (capture.buildVoiceCapturePayload === undefined) {
    return [];
  }
  return Object.keys(
    capture.buildVoiceCapturePayload({
      model: '',
      baseUrl: '',
      audio: { bytes: new Uint8Array(0), mimeType: '', fileName: '' },
      upstream: null,
      requestSent: false,
      reading: { ok: false, text: '' },
    }),
  );
}

/**
 * The field names a row carries in `audio` mode, read off the module under test — none when it ships
 * no audio half.
 *
 * READ OFF THE MODULE, for the reason `payloadKeySet` is and in the same shape: the row's expected
 * field set is the declared fields plus what THIS module's construction point produces. The audio
 * half adds one field (`path`, where the bytes landed) that the payload builder cannot produce — the
 * writer that decides it is not part of the builder's input, which is exactly why a row in `text`
 * mode has no such key. A list spelled here would have to be edited in lockstep with the module and
 * would say nothing about it.
 *
 * THE PROBE WRITES NOTHING: the port is built with a sink that answers an empty path and resolves an
 * empty directory, so this measurement leaves no file, no directory, and no entry in any arm's
 * counters. What it reads is the KEY SET of one row, which is what the expectation needs.
 */
function audioRowKeySet(capture: CaptureModule): string[] {
  if (capture.createVoiceCaptureAudioSink === undefined) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  const port = capture.createVoiceCapture({
    mode: 'audio',
    log: {
      info: (message: string): void => {
        const row = parseCaptureRow(message);
        if (row !== null) {
          rows.push(row);
        }
      },
    },
    audio: { resolveDirectory: (): string => '', writeAudio: (): string => '' },
  });
  port.recordAttempt('probe', {
    providerId: '',
    outcome: 'ok',
    status: 200,
    audio: { bytes: new Uint8Array(0), mimeType: '', fileName: '' },
  });
  return [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
}

/** The field names a line carries, in the order they appear (`key=value` tokens). */
function fieldNames(line: string): string[] {
  return line
    .split(' ')
    .filter((token) => token.includes('='))
    .map((token) => token.slice(0, token.indexOf('=')));
}

/**
 * Line-by-line comparison against the baseline, with the first difference spelled out.
 *
 * A length check first, because "the case printed one extra row" and "the case printed a different
 * row" are the same reading but different repairs.
 */
function compareLines(baseline: string[], lines: string[]): { equal: boolean; detail: string } {
  if (baseline.length !== lines.length) {
    return { equal: false, detail: `line-count ${lines.length} vs baseline ${baseline.length}` };
  }
  for (let index = 0; index < baseline.length; index += 1) {
    if (baseline[index] !== lines[index]) {
      return {
        equal: false,
        detail: `line ${index + 1}: baseline ${JSON.stringify(baseline[index])} vs case ${JSON.stringify(lines[index])}`,
      };
    }
  }
  return { equal: true, detail: '' };
}

/**
 * The write-audio port the criterion injects: a sink that REALLY writes.
 *
 * It is not a counter with an empty body. AC3's first reading is `fs.existsSync(<the configured
 * path>) === false` after the attempts, and that reading only means something if this same port
 * creates the directory and the file when it is reached — which the two audio control arms make it
 * do, in the same run, against this same code. The controls are what turn "nothing was created" from
 * a statement about an inert stand-in into a statement about the seam.
 */
function buildSink(
  capture: CaptureModule,
  counters: SinkCounters,
  resolve: 'explicit' | 'default',
  paths: TempPaths,
): VoiceCaptureAudioSink {
  return {
    resolveDirectory(): string {
      counters.resolverCalls += 1;
      if (resolve === 'default') {
        counters.defaultResolves += 1;
      }
      // "Pointing `VOICE_CAPTURE_DIR` at a path" is, at this seam, handing the resolver that value:
      // the module takes its inputs as arguments and the composition root is the one reader of the
      // environment, so the criterion points the variable the way the deployment would.
      return capture.resolveVoiceCaptureDir(
        resolve === 'explicit' ? paths.captureDir : undefined,
        paths.databasePath,
      );
    },
    // Answers the path it wrote, as the shipped contract requires: the port puts that path in the
    // row, so a stand-in that returned nothing would leave every audio row here without one — a
    // difference between this rig and the deployment that would have to be explained rather than
    // measured. The name is this rig's own (`attempt-<n>-<attempt id>`), which is the point of the
    // sink being a seam: the port never learns the naming scheme.
    writeAudio(directory: string, captureId: string, audio: VoiceCaptureAudio): string {
      counters.writeAudioCalls += 1;
      mkdirSync(directory, { recursive: true });
      const target = path.join(directory, `attempt-${counters.writeAudioCalls}-${captureId}`);
      writeFileSync(target, audio.bytes);
      counters.written.push(target);
      return target;
    },
  };
}

/**
 * One arm: build the port from the resolved mode, drive the two attempts, read the lines and the
 * filesystem back.
 *
 * The two attempts are asserted through `outcomes` rather than assumed: a success arm that actually
 * failed upstream would make the byte comparison a comparison of two failures, which reads exactly
 * like a green run.
 */
async function runArm(
  spec: ArmSpec,
  modules: { service: ServiceModule; capture: CaptureModule },
  paths: TempPaths,
): Promise<ArmOutcome> {
  const lines: string[] = [];
  const log: VoiceLogPort = {
    info: (message): void => {
      lines.push(message);
    },
  };
  const counters: SinkCounters = { writeAudioCalls: 0, resolverCalls: 0, defaultResolves: 0, written: [] };

  const resolution = modules.capture.resolveVoiceCaptureMode(spec.raw);
  const sink = spec.sink === 'none' ? undefined : buildSink(modules.capture, counters, spec.sink, paths);

  const replies: { current: Reply } = { current: 'ok' };
  let backendCalls = 0;
  const service = modules.service.createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: TIMEOUT_MS,
    logger: log,
    fetchBackend: async () => {
      backendCalls += 1;
      return replies.current === 'ok' ? upstreamSuccess() : upstreamFailure();
    },
    ...(sink === undefined
      ? {}
      : { capture: modules.capture.createVoiceCapture({ mode: resolution.mode, log, audio: sink }) }),
  });

  replies.current = 'ok';
  const success = await service.transcribe({ audio: AUDIO, overrides: {} });
  replies.current = 'fail';
  const failure = await service.transcribe({ audio: AUDIO, overrides: {} });

  if (success.ok !== true || failure.ok !== false) {
    throw new Error(
      `arm ${spec.name}: the rig's own driver is wrong — the success attempt answered ` +
        `${JSON.stringify(success)} and the failure attempt ${JSON.stringify(failure)}`,
    );
  }

  const attemptIndices: number[] = [];
  const attemptLines: string[] = [];
  const rows: CaptureRow[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith('voice.transcribe')) {
      attemptIndices.push(index);
      attemptLines.push(line);
    }
    const parsed = parseCaptureRow(line);
    if (parsed !== null) {
      rows.push({ index, line, parsed });
    }
  });

  const lineIds = attemptLines.map((line) => {
    const match = CAPTURE_ID_PATTERN.exec(line);
    return match === null ? '' : match[1];
  });

  const defaultDirectory = modules.capture.resolveVoiceCaptureDir(undefined, paths.databasePath);

  return {
    resolution,
    outcomes: { success: success.ok, failure: failure.ok },
    arm: {
      name: spec.name,
      lines,
      attemptLines,
      attemptIndices,
      lineIds,
      rows,
      backendCalls,
      sink: counters,
      dirCreated: existsSync(paths.captureDir),
      parentEntries: existsSync(paths.parent) ? readdirSync(paths.parent).sort() : [],
      defaultDirCreated: existsSync(defaultDirectory),
    },
  };
}

/** Runs every arm under one frozen clock, so `latencyMs` is a constant in every line. */
async function measure(modules: CriterionModules, paths: TempPaths): Promise<Measurement> {
  const service = (await import(pathToFileURL(modules.service ?? SHIPPING_SERVICE_MODULE).href)) as unknown as ServiceModule;
  const capture = (await import(pathToFileURL(modules.capture ?? SHIPPING_CAPTURE_MODULE).href)) as unknown as CaptureModule;

  const compositionRoot = readFileSync(COMPOSITION_ROOT_MODULE, 'utf8');
  const announceSymbol = capture.announceVoiceCapture.name;

  const originalNow = Date.now;
  Date.now = () => FROZEN_NOW;
  try {
    const arms = new Map<string, ArmMeasurement>();
    let baseline: ArmOutcome | undefined;
    for (const spec of ARMS) {
      const outcome = await runArm(spec, { service, capture }, paths);
      arms.set(spec.name, outcome.arm);
      if (spec.name === BASELINE_ARM.name) {
        baseline = outcome;
      }
    }
    if (baseline === undefined) {
      throw new Error(`the rig drove no arm named ${BASELINE_ARM.name}`);
    }

    const baselineFields: string[] = [];
    for (const line of baseline.arm.attemptLines) {
      for (const field of fieldNames(line)) {
        if (!baselineFields.includes(field)) {
          baselineFields.push(field);
        }
      }
    }

    const announced = new Map<string, string[]>();
    for (const spec of ANNOUNCE_CASES) {
      announced.set(spec.name, announceFor(capture, spec.raw));
    }

    return {
      baseline: baseline.arm,
      baselineFields,
      arms,
      announced,
      // Token-bounded, because `VOICE_CAPTURE_DIR` CONTAINS `VOICE_CAPTURE`: a substring count would
      // make "read exactly once" unfalsifiable the moment the audio half reads a directory of its
      // own. The unbounded count is printed beside it so the two can be compared.
      envReads: (compositionRoot.match(/process\.env\.VOICE_CAPTURE(?!_)/g) ?? []).length,
      envReadsSubstring: countOccurrences(compositionRoot, 'process.env.VOICE_CAPTURE'),
      announceCalled: compositionRoot.includes(`${announceSymbol}(`),
      announceSymbol,
      compositionCall: callText(compositionRoot, 'createVoiceCapture') ?? '',
      // Read off the module UNDER TEST, so a mutated copy is measured against its own sink factory.
      audioSinkShipped: typeof capture.createVoiceCaptureAudioSink === 'function',
      // Read off the module UNDER TEST, so a mutated copy is measured against its own audio half.
      audioRowKeys: audioRowKeySet(capture),
      // Read off the module UNDER TEST, so a mutated copy is measured against its own builder.
      payloadFields: payloadKeySet(capture),
      lines: {
        startup: (mode) => capture.voiceCaptureStartupLine(mode),
        warning: (value) => capture.voiceCaptureWarningLine(value),
      },
    };
  } finally {
    Date.now = originalNow;
  }
}

// ── the readings ──────────────────────────────────────────────────────────────────────────────

type Measured = { value: string; ok: boolean };
type Reading = { name: string; run: (measurement: Measurement) => Measured };
export type ReadingOutcome = { name: string; value: string; ok: boolean };

/** One arm by name; a missing arm is a rig failure rather than a green reading. */
function armOf(measurement: Measurement, name: string): ArmMeasurement {
  const arm = measurement.arms.get(name);
  if (arm === undefined) {
    throw new Error(`the measurement has no arm named ${name}`);
  }
  return arm;
}

/** The footprint a reader needs to attribute a filesystem reading. */
function footprint(arm: ArmMeasurement): string {
  const entries = arm.parentEntries.length === 0 ? 'none' : arm.parentEntries.join(' ');
  return `dir-created=${arm.dirCreated} parent-entries=[${entries}]`;
}

const READINGS: readonly Reading[] = [
  // ── AC2: the three off-reading cases are byte-identical to the baseline ─────────────────────
  ...OFF_CASES.map(
    (spec): Reading => ({
      name: `AC2 ${spec.name} byte-equality`,
      run: (measurement) => {
        const arm = armOf(measurement, spec.name);
        const comparison = compareLines(measurement.baseline.lines, arm.lines);
        return {
          value:
            `case=${spec.name} lines=${arm.lines.length} baseline=${measurement.baseline.lines.length} ` +
            `equal=${comparison.equal}${comparison.detail === '' ? '' : ` first-diff=${comparison.detail}`}`,
          ok: comparison.equal,
        };
      },
    }),
  ),
  ...OFF_CASES.map(
    (spec): Reading => ({
      name: `AC2 ${spec.name} capture-rows`,
      run: (measurement) => {
        const arm = armOf(measurement, spec.name);
        const carries = arm.lineIds.some((id) => id !== '');
        return {
          value: `case=${spec.name} captureLines=${arm.rows.length} carries-captureId=${carries}`,
          ok: arm.rows.length === 0 && !carries,
        };
      },
    }),
  ),

  // ── AC3: no directory, no file — with the controls that make the zeros readable ──────────────
  ...[...OFF_CASES, TEXT_CASE].map(
    (spec): Reading => ({
      name: `AC3 ${spec.name} no-directory`,
      run: (measurement) => {
        const arm = armOf(measurement, spec.name);
        return {
          value:
            `case=${spec.name} ${footprint(arm)} writeAudio-calls=${arm.sink.writeAudioCalls} ` +
            `defaultDir-resolves=${arm.sink.defaultResolves} resolver-calls=${arm.sink.resolverCalls} ` +
            `default-dir-created=${arm.defaultDirCreated}`,
          ok: !arm.dirCreated && arm.sink.writeAudioCalls === 0 && arm.sink.defaultResolves === 0,
        };
      },
    }),
  ),
  {
    name: 'AC3 audio-explicit reaches-the-sink',
    run: (measurement) => {
      const arm = armOf(measurement, 'audio-explicit');
      // The port is reached ONCE PER RECORDED ATTEMPT — two here, the success and the failure — so
      // the sink's call count is compared against the rows the arm actually produced rather than
      // against a constant: a rig that recorded nothing would make both sides zero together, and
      // the row count is asserted separately for that reason.
      return {
        value:
          `case=audio-explicit ${footprint(arm)} rows=${arm.rows.length} ` +
          `writeAudio-calls=${arm.sink.writeAudioCalls} files-written=${arm.sink.written.length} ` +
          `defaultDir-resolves=${arm.sink.defaultResolves}`,
        ok:
          arm.rows.length === 2 &&
          arm.dirCreated &&
          arm.sink.writeAudioCalls === arm.rows.length &&
          arm.sink.written.length === arm.rows.length,
      };
    },
  },
  {
    name: 'AC3 audio-default resolves-the-default',
    run: (measurement) => {
      const arm = armOf(measurement, 'audio-default');
      return {
        value:
          `case=audio-default defaultDir-resolves=${arm.sink.defaultResolves} ` +
          `default-dir-created=${arm.defaultDirCreated} rows=${arm.rows.length} ` +
          `writeAudio-calls=${arm.sink.writeAudioCalls} parent-entries=[${arm.parentEntries.join(' ')}]`,
        ok:
          arm.sink.defaultResolves === arm.rows.length &&
          arm.rows.length === 2 &&
          arm.defaultDirCreated &&
          arm.sink.writeAudioCalls === arm.rows.length,
      };
    },
  },

  // ── AC4: the start-up line, the warning, and where they come from ────────────────────────────
  ...ANNOUNCE_CASES.map(
    (spec): Reading => ({
      name: `AC4 ${spec.name} startup-lines`,
      run: (measurement) => {
        const lines = measurement.announced.get(spec.name) ?? [];
        const warnLines = Math.max(lines.length - 1, 0);
        // The expected start-up line and the expected warning are read OFF THE MODULE, and the AC's
        // own literals are asserted beside them: the module and the criterion have to agree on the
        // text, which is what "the line comes from the start-up function" means as a reading.
        const startupFromModule = measurement.lines.startup(spec.mode);
        const warningFromModule = spec.warns === undefined ? '' : measurement.lines.warning(spec.warns);
        const startupOk = lines[0] === spec.startup && lines[0] === startupFromModule;
        const warnOk =
          warnLines === spec.warnLines &&
          (spec.warns === undefined
            ? lines.length === 1
            : // The AC's requirement is that the warning NAMES the offending value; the module's
              // function is what the line must equal. Both are read, so a warning that named the
              // value without being the module's line — or the module's line without the value —
              // is a red.
              (lines[1] ?? '').includes(spec.warns) && lines[1] === warningFromModule);
        return {
          value:
            `case=${spec.name} startup-lines=${JSON.stringify(lines)} warnLines=${warnLines} ` +
            `startup-from-module=${lines[0] === startupFromModule} ` +
            `warning-from-module=${spec.warns === undefined ? 'n/a' : lines[1] === warningFromModule}`,
          ok: startupOk && warnOk,
        };
      },
    }),
  ),
  {
    name: 'AC4 composition-root source',
    run: (measurement) => ({
      value:
        `module=voice.module.ts envReads=${measurement.envReads} ` +
        `envReads-substring=${measurement.envReadsSubstring} announce-called=${measurement.announceCalled} ` +
        `symbol=${measurement.announceSymbol}`,
      ok: measurement.envReads === 1 && measurement.announceCalled,
    }),
  },

  // ── AC5: the zero is not an empty implementation ─────────────────────────────────────────────
  {
    name: 'AC5 text capture-rows',
    run: (measurement) => {
      const arm = armOf(measurement, TEXT_CASE.name);
      const singleLine = arm.rows.every((row) => row.line.split('\n').length === 1);
      const paired =
        arm.rows.length === 2 &&
        arm.lineIds.length === 2 &&
        arm.rows.every((row, index) => row.parsed.captureId === arm.lineIds[index]) &&
        arm.rows.every((row, index) => row.index === (arm.attemptIndices[index] ?? -1) + 1);
      return {
        value:
          `text.captureLines=${arm.rows.length} text.parseable=${singleLine} text.idMatch=${paired} ` +
          `ids=[${arm.lineIds.join(' ')}]`,
        ok: arm.rows.length === 2 && singleLine && paired,
      };
    },
  },

  // ── AC6 (in-process half): the off attempt line gains no field ───────────────────────────────
  {
    name: 'AC6 off field-set',
    run: (measurement) => {
      const offFields: string[] = [];
      for (const spec of OFF_CASES) {
        for (const line of armOf(measurement, spec.name).attemptLines) {
          for (const field of fieldNames(line)) {
            if (!offFields.includes(field)) {
              offFields.push(field);
            }
          }
        }
      }
      const extra = offFields.filter((field) => !measurement.baselineFields.includes(field));
      const missing = measurement.baselineFields.filter((field) => !offFields.includes(field));
      return {
        value:
          `extra=[${extra.join(' ')}] missing=[${missing.join(' ')}] ` +
          `baseline=[${measurement.baselineFields.join(' ')}]`,
        ok: extra.length === 0,
      };
    },
  },

  // ── AC8: what this criterion does and does not cover, registered rather than asserted in prose ─
  {
    name: 'AC8 registration',
    run: (measurement) => {
      // The declaration AC8 asks for, printed with the readings that make its halves checkable. The
      // prose is the claim; the figures after it are the parts of the claim this run can measure:
      //
      //   · the ROW'S FIELD SET is the AC's minimal set (`captureId`/`providerId`/`outcome`/`status`
      //     plus the `event` marker) PLUS the key sets of the module under test's own construction
      //     point — the payload builder's fields, and the field a row carries in `audio` mode —
      //     nothing the construction point does not produce can be on it, and the payload refinement
      //     (`text` mode's actual model, the upstream body verbatim, the result branch, the 64KB cut)
      //     is another criterion's subject: asserted there for its CONTENTS, and read here only for
      //     its shape, because the fields' presence on this row is what this task's change to the
      //     construction point is. See `payloadKeySet` and `audioRowKeySet` for why both halves are
      //     read off the module;
      //   · WHAT THE COMPOSITION ROOT WIRES equals WHAT THE MODULE SHIPS (`audio-sink-wired` against
      //     `audio-sink-shipped`). This term was `!audioWired` while no audio half existed, and that
      //     is a fact about AC-143's commit rather than an invariant — the AC3 control arms reach a
      //     sink the criterion builds either way. It was narrowed to the agreement when AC-145 landed
      //     the audio half, in the same shape as the row's field set above: an expectation read off
      //     the module under test follows the module, while a root that wired something the module
      //     does not ship stays a red. The file write's CONTENTS remain out of this criterion's
      //     scope, which is what the registration line below still says;
      //   · EVERY attempt line the run produced carries `latencyMs=0`, which is what a frozen clock
      //     looks like in the output rather than in the code; and the injected stand-in carried
      //     every attempt, so no real upstream was reached;
      //   · the file opens no door that could reach a network or spawn a process (details in the
      //     `AC1 scope` reading, which is the same list).
      const rows = [...measurement.arms.values()].flatMap((arm) => arm.rows);
      const rowFields = [...new Set(rows.flatMap((row) => Object.keys(row.parsed)))].sort();
      const declaredRowFields = ['captureId', 'event', 'outcome', 'providerId', 'status'];
      // The expectation is the five declared fields PLUS everything the module under test's own
      // construction point produces — the payload builder's keys, and the keys a row carries in
      // `audio` mode (AC-145's `path`). Reading both off the module is what keeps this a check rather
      // than a second hand-kept list: the construction point gains a field and this expectation
      // follows it, while a field that appears on a row WITHOUT the construction point producing it
      // stays a red. A module with neither half makes this the five fields alone — stricter than the
      // relaxation, never looser.
      const expectedRowFields = [
        ...new Set([...declaredRowFields, ...measurement.payloadFields, ...measurement.audioRowKeys]),
      ].sort();
      const attemptLines = [...measurement.arms.values()].flatMap((arm) => arm.attemptLines);
      const frozenClockLines = attemptLines.filter((line) => line.includes('latencyMs=0')).length;
      const backendCalls = [...measurement.arms.values()].reduce((total, arm) => total + arm.backendCalls, 0);
      const doors = openDoors();
      // What the composition root's call WIRES, against what the module under test SHIPS. Reading the
      // second half off the module is what keeps this a check rather than a fact about a commit: while
      // no audio half exists the two agree at `false`, and once one lands they agree at `true` — and a
      // root that wired a sink the module does not ship, or shipped one it never wired, is a red.
      // (AC-145 added the audio half; see the registration prose below.)
      const audioWired = /[{,\s]audio\s*:/.test(measurement.compositionCall);
      const audioSinkShipped = measurement.audioSinkShipped;

      return {
        value:
          'scope=[mode resolution, composition-root startup line + warning, the gate, the minimal ' +
          'capture row, the fail-closed form] out-of-scope=[text payload, audio file write, secrets ' +
          'criterion, capture-failure isolation, real process] fixtures=[stand-in fetchBackend, ' +
          `frozen clock] audio-sink-wired=${audioWired} row-fields=[${rowFields.join(' ')}] ` +
          `declared-fields=[${declaredRowFields.join(' ')}] ` +
          `payload-fields=[${measurement.payloadFields.join(' ')}] ` +
          `audio-row-fields=[${measurement.audioRowKeys.join(' ')}] ` +
          `frozen-clock-lines=${frozenClockLines}/${attemptLines.length} double-calls=${backendCalls} ` +
          `socket-doors=${doors.length} audio-sink-shipped=${audioSinkShipped}`,
        ok:
          audioWired === audioSinkShipped &&
          rows.length > 0 &&
          rowFields.join(' ') === expectedRowFields.join(' ') &&
          attemptLines.length > 0 &&
          frozenClockLines === attemptLines.length &&
          backendCalls > 0 &&
          doors.length === 0,
      };
    },
  },
];

/**
 * Runs every reading against one measurement, in order.
 *
 * TOTAL BY CONSTRUCTION: a reading that throws is reported as a failed reading carrying the failure's
 * message, because the falsify run has to see WHICH reading noticed a mutation, and an exception
 * escaping the list would end the run at the first one instead.
 */
export async function collectReadings(modules: CriterionModules = {}): Promise<ReadingOutcome[]> {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'voice-capture-off-criterion-'));
  try {
    const measurement = await measure(modules, {
      parent,
      captureDir: path.join(parent, 'recordings'),
      databasePath: path.join(parent, 'auth.db'),
    });

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
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

// ── the criterion, as `node:test` cases (registered only when this file is the entry point) ────

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

    // AC1's own words: the run prints `elapsed-ms=<n>` at the end, and the target-side gate gives it
    // sixty seconds. The budget below is the criterion's, four times under the gate's ceiling.
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
