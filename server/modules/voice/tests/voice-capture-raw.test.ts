/**
 * The raw (pre-VAD) corpus half of the capture seam: the switch, the file, the row, and the pairing id.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-off/text/audio` cover the TRIMMED side — the
 * bytes the recogniser consumed. This one covers the half those handed over: the audio a VAD
 * deliberately removed, which the recogniser never saw and the server therefore could not reconstruct
 * from any trimmed upload. It is the corpus the next task needs to judge the VAD itself.
 *
 * THE SUBJECT IS THE BYTES AND THE PAIRING, so every reading below compares rather than counts: the
 * file's contents against the `Buffer` this file sent, a sha256 recomputed from the file against the
 * one the row carries, and the row's `listenId` against the string this file passed in. A criterion
 * that only asserted "a file appeared" would be satisfied by a file holding something else.
 *
 * FALSIFYING FORMS LIVE IN `voice-capture-raw.false-forms.test.ts`: the switch gate removed (so the
 * off reading has to catch it) and the `raw-` file-name prefix removed (so the byte/permission
 * reading has to catch it). See that file's header for the two mutations and why they are the ones
 * reachable at this seam.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { VoiceLogPort } from '@/shared/types.js';

import {
  createVoiceCapture,
  createVoiceCaptureAudioSink,
  rawCaptureFileName,
  resolveVoiceCaptureRaw,
} from '../voice-capture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The mode a raw recording rides beside. `audio` so the trimmed half is real; raw is INDEPENDENT of it. */
const RIDE_MODE = 'audio';

/** Run-unique bytes, so a reading is about THIS run's upload rather than one a reader could guess. */
const RUN_TAG = `${process.pid}-${Date.now()}`;
const BYTES = Buffer.from(`raw-${RUN_TAG}:${'r'.repeat(48)}`, 'utf8');
/** A second, different buffer for the collision reading: the two files must each keep their OWN bytes. */
const BYTES_2 = Buffer.from(`raw-second-${RUN_TAG}:${'s'.repeat(48)}`, 'utf8');

const LISTEN_A = `listen-${RUN_TAG}-a`;
const LISTEN_B = `listen-${RUN_TAG}-b`;

/** A collector for the port's rows. */
function collector(): { lines: string[]; log: VoiceLogPort } {
  const lines: string[] = [];
  return { lines, log: { info: (message: string): void => void lines.push(message) } };
}

/** The one `voice.capture.raw` row among a collector's lines, or `null`. */
function rawRow(lines: string[]): Record<string, unknown> | null {
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && (parsed as { event?: unknown }).event === 'voice.capture.raw') {
      return parsed as Record<string, unknown>;
    }
  }
  return null;
}

/** The permission bits as four octal digits (`0600`). */
function modeBits(target: string): string {
  return (statSync(target).mode & 0o777).toString(8).padStart(4, '0');
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A scratch tree, removed in `finally`. */
function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'voice-capture-raw-criterion-'));
}

// ── AC1: the switch resolves fail-closed, in one place ────────────────────────────────────────

test('AC1 the raw switch resolves blank/off/unrecognised to off and 1 to on', () => {
  const offCases: (string | undefined)[] = [undefined, '', '   ', 'off', 'bogus', ' AUDIO '];
  const seen = offCases.map((value) => resolveVoiceCaptureRaw(value));
  // Printed before the assertions, so a red names what it measured.
  process.stdout.write(
    `raw-switch off-cases=${offCases.map((value) => JSON.stringify(value)).join(',')} ` +
      `enabled=[${seen.map((resolution) => resolution.enabled).join(',')}] ` +
      `warnings=${seen.filter((resolution) => resolution.warning !== null).length}\n`,
  );

  assert.deepEqual(
    seen.map((resolution) => resolution.enabled),
    offCases.map(() => false),
    'every blank, off or unrecognised value must read as off (fail closed)',
  );
  // The positive control: the ONE value that turns it on must actually turn it on, or the zeros
  // above would also hold for a resolver that never returns true.
  assert.equal(resolveVoiceCaptureRaw('1').enabled, true);
  assert.equal(resolveVoiceCaptureRaw('1').warning, null);
  // An unrecognised value earns a warning naming it; blank and `off` do not.
  assert.equal(resolveVoiceCaptureRaw('bogus').warning !== null, true);
  assert.equal(resolveVoiceCaptureRaw('').warning, null);
  assert.equal(resolveVoiceCaptureRaw('off').warning, null);
});

// ── AC2: switch off means no file AND no directory ────────────────────────────────────────────

test('AC2 the switch off writes no file and creates no directory', () => {
  const root = scratch();
  const directory = path.join(root, 'recordings');
  const { lines, log } = collector();
  try {
    const sink = createVoiceCaptureAudioSink({ directory });
    const port = createVoiceCapture({ mode: RIDE_MODE, log, instanceSalt: 'criterion', audio: sink, raw: false });

    port.recordRaw?.({ listenId: LISTEN_A, bytes: BYTES });

    process.stdout.write(`off dir-created=${existsSync(directory)} rows=${lines.length}\n`);
    assert.equal(existsSync(directory), false, 'a switch-off deployment must not create the directory');
    assert.equal(rawRow(lines), null, 'a switch-off deployment must not write a raw row either');
    // The positive control: the SAME sink and port shape, with the switch on, DOES create it — so the
    // zero above is the switch's doing and not a port that could never write.
    const portOn = createVoiceCapture({ mode: RIDE_MODE, log, instanceSalt: 'criterion', audio: sink, raw: true });
    portOn.recordRaw?.({ listenId: LISTEN_A, bytes: BYTES });
    assert.equal(existsSync(directory), true, 'the same port with the switch on must create the directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC3: switch on writes the bytes themselves, at the promised name and permissions ──────────

test('AC3 the switch on writes the upload byte for byte at raw-<listenId>.bin', () => {
  const root = scratch();
  const directory = path.join(root, 'recordings');
  const { lines, log } = collector();
  const inherited = process.umask();
  process.umask(0o000);
  try {
    const port = createVoiceCapture({
      mode: RIDE_MODE,
      log,
      instanceSalt: 'criterion',
      audio: createVoiceCaptureAudioSink({ directory }),
      raw: true,
    });
    port.recordRaw?.({ listenId: LISTEN_A, bytes: BYTES });

    const row = rawRow(lines);
    assert.ok(row, 'a switch-on raw write must produce exactly one raw row');
    const rowPath = String(row.path);
    const fileName = path.basename(rowPath);

    const onDisk = existsSync(rowPath) ? readFileSync(rowPath) : Buffer.alloc(0);
    process.stdout.write(
      `raw-write file=${fileName} nameMatch=${rawCaptureFileName(LISTEN_A) === fileName} ` +
        `bytesEqual=${onDisk.equals(BYTES)} dirMode=${modeBits(directory)} fileMode=${modeBits(rowPath)} ` +
        `shaMatch=${sha256Hex(onDisk) === String(row.sha256)} rowBytes=${String(row.bytes)}\n`,
    );

    // The name scheme, read off the shipped helper rather than spelled here.
    assert.equal(fileName, rawCaptureFileName(LISTEN_A));
    assert.match(fileName, new RegExp(`^raw-${LISTEN_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.bin$`));
    assert.ok(path.isAbsolute(rowPath));
    // The BYTES, both ways: the file equals the upload, and a digest recomputed from the FILE equals
    // the one the row carries — two independent roads to the same buffer.
    assert.equal(onDisk.equals(BYTES), true, 'the file must hold the uploaded bytes themselves');
    assert.equal(sha256Hex(onDisk), String(row.sha256), 'the row`s sha256 must describe the file');
    assert.equal(row.bytes, BYTES.length);
    assert.equal(row.listenId, LISTEN_A);
    // The permissions, read under a zero umask so the requested bits are what landed.
    assert.equal(modeBits(directory), '0700');
    assert.equal(modeBits(rowPath), '0600');
  } finally {
    process.umask(inherited);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC4: the same listenId twice gives way with `-2`, never overwriting ────────────────────────

test('AC4 a repeated listenId lands a second file and preserves both', () => {
  const root = scratch();
  const directory = path.join(root, 'recordings');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const first = collector();
    const second = collector();
    const sink = createVoiceCaptureAudioSink({ directory });
    createVoiceCapture({ mode: RIDE_MODE, log: first.log, instanceSalt: 'criterion', audio: sink, raw: true })
      .recordRaw?.({ listenId: LISTEN_A, bytes: BYTES });
    createVoiceCapture({ mode: RIDE_MODE, log: second.log, instanceSalt: 'criterion', audio: sink, raw: true })
      .recordRaw?.({ listenId: LISTEN_A, bytes: BYTES_2 });

    const pathOne = String(rawRow(first.lines)?.path ?? '');
    const pathTwo = String(rawRow(second.lines)?.path ?? '');
    const files = readdirSync(directory).sort();
    process.stdout.write(
      `collision files=[${files.join(' ')}] p1=${path.basename(pathOne)} p2=${path.basename(pathTwo)} ` +
        `p1Intact=${existsSync(pathOne) && readFileSync(pathOne).equals(BYTES)} ` +
        `p2Intact=${existsSync(pathTwo) && readFileSync(pathTwo).equals(BYTES_2)}\n`,
    );

    // TWO files for ONE listenId, at DIFFERENT names — the `-2` give-way, learned from the row's own
    // path rather than a spelled suffix.
    assert.equal(files.length, 2);
    assert.notEqual(pathOne, pathTwo);
    assert.equal(readFileSync(pathOne).equals(BYTES), true, 'the first write must survive byte for byte');
    assert.equal(readFileSync(pathTwo).equals(BYTES_2), true, 'and the second must hold its own bytes');
    // The pairing id is still the same one on both rows: the collision is about the FILE name, not
    // about the listen the bytes belong to.
    assert.equal(rawRow(first.lines)?.listenId, LISTEN_A);
    assert.equal(rawRow(second.lines)?.listenId, LISTEN_A);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC12: the corpus is USABLE — the raw file holds what the trimmed one dropped ───────────────

/**
 * A 16-bit mono PCM WAV of `seconds` of silence, so a file's own length is its duration.
 *
 * Built here rather than read from a fixture: the reading is an ARITHMETIC one about two files called
 * two lengths, and a real speech recording would only make the numbers harder to check by eye.
 */
function silentWav(seconds: number, sampleRate = 16_000): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The duration in seconds of a 16-bit mono PCM WAV, from its own header. */
function wavSeconds(bytes: Buffer): number {
  const sampleRate = bytes.readUInt32LE(24);
  const dataBytes = bytes.readUInt32LE(40);
  return dataBytes / (sampleRate * 2);
}

test('AC12 the raw file is longer than the trimmed one by the pause the VAD removed', () => {
  const root = scratch();
  const directory = path.join(root, 'recordings');
  const { lines, log } = collector();
  try {
    // The model of one listen: two speech runs with a long pause between them. The detector cuts the
    // pause out, so the trimmed upload is the two runs (4s) and the raw upload is all of it (7s).
    const SPEECH_SEC = 2;
    const PAUSE_SEC = 3;
    const trimmedWav = silentWav(SPEECH_SEC * 2);
    const rawWav = silentWav(SPEECH_SEC * 2 + PAUSE_SEC);
    const port = createVoiceCapture({
      mode: 'audio',
      log,
      instanceSalt: 'criterion',
      audio: createVoiceCaptureAudioSink({ directory }),
      raw: true,
    });

    // The trimmed attempt: the bytes the recogniser received, and the text it returned.
    port.recordAttempt('trimmed-1', {
      providerId: 'p',
      outcome: 'ok',
      status: 200,
      audio: { bytes: trimmedWav, mimeType: 'audio/wav', fileName: 'seg.wav' },
      listenId: LISTEN_A,
      payload: {
        model: 'm',
        baseUrl: 'https://voice.example/v1',
        audio: { bytes: trimmedWav, mimeType: 'audio/wav', fileName: 'seg.wav' },
        upstream: null,
        requestSent: false,
        reading: { ok: true, text: 'the recogniser heard this' },
      },
    });
    port.recordRaw?.({ listenId: LISTEN_A, bytes: rawWav });

    const rows = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((row) => typeof row.path === 'string');
    const trimmedRow = rows.find((row) => row.event === 'voice.capture')!;
    const rawRow = rows.find((row) => row.event === 'voice.capture.raw')!;
    const trimmedSec = wavSeconds(readFileSync(String(trimmedRow.path)));
    const rawSec = wavSeconds(readFileSync(String(rawRow.path)));
    process.stdout.write(
      `pairing listenId=${rawRow.listenId} trimmedSec=${trimmedSec.toFixed(2)} rawSec=${rawSec.toFixed(2)} ` +
        `deltaSec=${(rawSec - trimmedSec).toFixed(2)} trimmedText=${JSON.stringify(trimmedRow.text)} ` +
        `sameListen=${rawRow.listenId === trimmedRow.listenId}\n`,
    );

    // The corpus is USABLE: the raw file is at least as long as the trimmed audio, the difference is
    // the pause the VAD removed, and the listen's capture row carries the recogniser's text — so a
    // reader can join the pre-VAD audio to what was actually transcribed for the same listen.
    assert.equal(rawRow.listenId, LISTEN_A);
    assert.equal(trimmedRow.listenId, LISTEN_A);
    assert.ok(rawSec >= trimmedSec, `raw ${rawSec}s must be at least the trimmed ${trimmedSec}s`);
    assert.ok(Math.abs(rawSec - trimmedSec - PAUSE_SEC) < 0.01, 'the difference is exactly the pause');
    assert.equal(trimmedRow.text, 'the recogniser heard this');
    assert.notEqual(trimmedRow.text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('AC7 the trimmed row carries listenId when given and omits the key when not', () => {
  const root = scratch();
  const withId = collector();
  const withoutId = collector();
  try {
    const sink = createVoiceCaptureAudioSink({ directory: path.join(root, 'recordings') });
    const port = createVoiceCapture({ mode: 'text', log: withId.log, instanceSalt: 'criterion', audio: sink });
    const attempt = {
      providerId: 'p',
      outcome: 'ok' as const,
      status: 200,
      audio: { bytes: BYTES, mimeType: 'audio/wav', fileName: 'x.wav' },
    };
    port.recordAttempt('capture-1', { ...attempt, listenId: LISTEN_B });

    const other = createVoiceCapture({ mode: 'text', log: withoutId.log, instanceSalt: 'criterion', audio: sink });
    other.recordAttempt('capture-2', { ...attempt });

    const tagged = withId.lines.map((line) => JSON.parse(line) as Record<string, unknown>)[0];
    const untagged = withoutId.lines.map((line) => JSON.parse(line) as Record<string, unknown>)[0];
    process.stdout.write(
      `listenId-row with=${JSON.stringify(tagged.listenId)} withHasKey=${'listenId' in tagged} ` +
        `withoutHasKey=${'listenId' in untagged}\n`,
    );

    assert.equal(tagged.listenId, LISTEN_B);
    assert.equal('listenId' in tagged, true);
    // ABSENCE, not an empty string: a row from a request that named no listen must have no key at all.
    assert.equal('listenId' in untagged, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
