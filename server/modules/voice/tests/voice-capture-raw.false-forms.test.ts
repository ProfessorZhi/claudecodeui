/**
 * The falsifying forms behind `voice-capture-raw.test.ts`.
 *
 * WHY A SEPARATE FILE RATHER THAN MORE READINGS. A green criterion is evidence only if a broken
 * implementation would have made it red. Each case below builds a BROKEN copy of the capture module
 * by a text mutation, runs the raw readings against it, and requires the reading it predicts to fail
 * — and the OTHER reading to stay green, so "the whole rig fell over" is not what the red means.
 *
 * THE TWO MUTATIONS ARE THE CHEAP WAYS TO SATISFY THIS TASK'S WORDS WHILE MISSING ITS SUBJECT:
 *
 *   · `switch-gate-removed` — drop the `if (!rawEnabled) return;` guard, so a deployment that never
 *     turned the switch on still writes a raw file and a row. Every word about "raw capture is
 *     independent" is still implemented, and the switch does nothing. If this case passes, AC2's
 *     "no file, no directory" is not measuring the switch.
 *   · `no-raw-prefix` — build the file name from the listen id alone, dropping the `raw-` prefix. The
 *     bytes are still written, at the right permissions, with a digest of the right buffer; only the
 *     name scheme moved. If this case passes, AC3's `^raw-<listenId>\.bin$` is not measuring the name.
 *
 * THE CLIENT-SIDE FALSE FORM lives with the client criterion: "await the raw upload before the
 * submit" is a mutation of `useVoiceInput.ts`, and the reading it has to red — "the transcript lands
 * even when the upload never resolves" — is in `voiceRawCaptureUpload.test.tsx`, where the never-
 * resolving double makes the awaited form fail by construction. A text-mutation harness for a
 * React hook would have to copy the hook's whole import graph; the criterion is written so the
 * mutation reds it without one.
 *
 * WHERE THE COPIES GO. A copy of a module keeps that module's relative imports, so a copy in this
 * file's directory would not resolve them; the copies live beside the module they copy, each at its
 * OWN path because ESM caches a module by URL.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { VoiceLogPort } from '@/shared/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VOICE_DIR = path.resolve(HERE, '..');
const SHIPPING_CAPTURE_MODULE = path.join(VOICE_DIR, 'voice-capture.ts');
// The `__criterion-falsify-` substring is load-bearing, not decoration: the sibling criteria that
// build copies in this SAME directory (`voice-capture-off`, `-text`, `-secrets`, `-isolation`,
// `voice-dashscope-settings`) forgive a concurrent process's in-flight copy ONLY when the porcelain
// line contains that substring (`isTempCopy`). `__criterion-raw-falsify-` does NOT contain it, so an
// earlier name of this constant made this file's own copies read as *this run's* residue in a
// sibling's tree reading and red it. Keeping the raw marker AFTER the shared substring means both
// properties hold at once: siblings forgive these copies, and this file's copies stay distinguishable
// by name.
const TEMP_PREFIX = '__criterion-falsify-raw-';

type Edit = { anchor: string; replacement: string };
type Expectation = { reading: RegExp; token: string; meaning: string };
type MutationCase = {
  name: string;
  target: RegExp;
  family: string;
  edits: readonly Edit[];
  expects: readonly Expectation[];
  why: string;
};

/**
 * The two anchors the mutations rewrite, kept as the shipping text so the "exactly once" check below
 * is about the module as it is rather than as a reader remembers it.
 */
const SWITCH_GUARD = '      if (!rawEnabled) {';
const RAW_NAME = '  return `raw-${pathSafeStem(listenId)}`;';

const CASES: readonly MutationCase[] = [
  {
    name: 'switch-gate-removed',
    target: /^off-zero$/,
    family: 'off-zero',
    edits: [{ anchor: SWITCH_GUARD, replacement: '      if (false) {' }],
    expects: [
      {
        reading: /^off-zero$/,
        token: 'dirCreated=true',
        meaning: 'a switch-off deployment wrote a raw file and created a directory',
      },
    ],
    why: 'the raw switch is dropped from the write guard, so "off" records anyway',
  },
  {
    name: 'no-raw-prefix',
    target: /^on-bytes-name$/,
    family: 'on-bytes-name',
    edits: [{ anchor: RAW_NAME, replacement: '  return `${pathSafeStem(listenId)}`;' }],
    expects: [
      {
        reading: /^on-bytes-name$/,
        token: 'nameMatch=false',
        meaning: 'the file is named after the listen id without the `raw-` prefix',
      },
    ],
    why: 'the `raw-` prefix is dropped, so a raw file cannot be told from a trimmed one by name',
  },
];

/** The module surface this file drives, read off whichever copy is under test. */
type CaptureModule = {
  createVoiceCapture(dependencies: {
    mode: string;
    log: VoiceLogPort;
    instanceSalt: string;
    audio: { resolveDirectory(): string; writeAudio(d: string, id: string, a: unknown): string; writeRaw?(d: string, id: string, b: Uint8Array): string };
    raw?: boolean;
  }): { recordRaw?(input: { listenId: string; bytes: Uint8Array }): void };
  createVoiceCaptureAudioSink(options: { directory: string }): {
    resolveDirectory(): string;
    writeAudio(d: string, id: string, a: unknown): string;
    writeRaw?(d: string, id: string, b: Uint8Array): string;
  };
  resolveVoiceCaptureRaw(raw: string | undefined): { enabled: boolean };
};

type Outcome = { name: string; value: string; ok: boolean };

/** A run-unique buffer, so "the file holds the upload" is about THIS run's bytes. */
const BYTES = Buffer.from(`falsify-raw-${process.pid}-${Date.now()}:${'f'.repeat(32)}`, 'utf8');
const LISTEN_ID = `listen-falsify-${process.pid}`;

/** Runs the two raw readings against one module copy. */
async function measure(modulePath: string): Promise<Outcome[]> {
  const capture = (await import(pathToFileURL(modulePath).href)) as unknown as CaptureModule;
  const root = mkdtempSync(path.join(os.tmpdir(), 'voice-raw-falsify-'));
  const lines: string[] = [];
  const log: VoiceLogPort = { info: (message: string): void => void lines.push(message) };
  const outcomes: Outcome[] = [];

  try {
    // off-zero: the switch off must produce no directory AND no row.
    const offDir = path.join(root, 'off');
    const offSink = capture.createVoiceCaptureAudioSink({ directory: offDir });
    capture
      .createVoiceCapture({ mode: 'audio', log, instanceSalt: 'x', audio: offSink, raw: false })
      .recordRaw?.({ listenId: LISTEN_ID, bytes: BYTES });
    outcomes.push({
      name: 'off-zero',
      value: `dirCreated=${existsSync(offDir)} rows=${lines.length}`,
      ok: !existsSync(offDir) && lines.length === 0,
    });

    // on-bytes-name: the switch on must write the bytes at the promised name.
    lines.length = 0;
    const onDir = path.join(root, 'on');
    const onSink = capture.createVoiceCaptureAudioSink({ directory: onDir });
    capture
      .createVoiceCapture({ mode: 'audio', log, instanceSalt: 'x', audio: onSink, raw: true })
      .recordRaw?.({ listenId: LISTEN_ID, bytes: BYTES });
    const target = path.join(onDir, `raw-${LISTEN_ID}.bin`);
    const wrote = existsSync(target);
    const expectedName = `raw-${LISTEN_ID}.bin`;
    const actualName = wrote ? path.basename(target) : '(none)';
    outcomes.push({
      name: 'on-bytes-name',
      value:
        `nameMatch=${wrote} expected=${expectedName} actual=${actualName} ` +
        `bytesEqual=${wrote && readFileSync(target).equals(BYTES)} ` +
        `shaEqual=${wrote && createHash('sha256').update(readFileSync(target)).digest('hex') === digestOf(lines)}`,
      ok: wrote && readFileSync(target).equals(BYTES),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return outcomes;
}

/** The sha256 a raw row carried, or `''` — read so the byte reading is not the only road. */
function digestOf(lines: string[]): string {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { event?: string; sha256?: string };
      if (parsed.event === 'voice.capture.raw') return String(parsed.sha256);
    } catch {
      // Not a row.
    }
  }
  return '';
}

for (const mutation of CASES) {
  test(`AC10/${mutation.name}: the unmutated copy is green and the mutation reds ${mutation.family}`, async () => {
    const basePath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-base-${process.pid}.ts`);
    const mutantPath = path.join(VOICE_DIR, `${TEMP_PREFIX}${mutation.name}-mut-${process.pid}.ts`);
    try {
      await copyFile(SHIPPING_CAPTURE_MODULE, basePath);
      const base = await measure(basePath);
      process.stdout.write(
        `falsify/${mutation.name} base red=[${base.filter((o) => !o.ok).map((o) => o.name).join(' ')}]\n`,
      );
      assert.deepEqual(
        base.filter((outcome) => !outcome.ok).map((outcome) => outcome.name),
        [],
        'the unmutated copy must clear both readings before the mutation means anything',
      );

      const shippingText = await readFile(SHIPPING_CAPTURE_MODULE, 'utf8');
      let mutated = shippingText;
      for (const edit of mutation.edits) {
        const count = mutated.split(edit.anchor).length - 1;
        assert.equal(count, 1, `an anchor for ${mutation.name} occurs ${count} times; it must name one site`);
        mutated = mutated.replace(edit.anchor, edit.replacement);
      }
      assert.notEqual(mutated, shippingText);
      await writeFile(mutantPath, mutated, 'utf8');

      const mutant = await measure(mutantPath);
      process.stdout.write(
        `falsify/${mutation.name} mutant red=[${mutant.filter((o) => !o.ok).map((o) => o.name).join(' ')}] ` +
          `values=[${mutant.map((o) => `${o.name}:${o.value}`).join(' ')}] why=${mutation.why}\n`,
      );

      for (const expectation of mutation.expects) {
        const outcome = mutant.find((entry) => expectation.reading.test(entry.name));
        assert.ok(outcome, `no reading matching ${String(expectation.reading)} ran`);
        assert.equal(outcome.ok, false, `${outcome.name} stayed green: ${expectation.meaning}`);
        assert.ok(
          outcome.value.includes(expectation.token),
          `${outcome.name} went red without ${expectation.token} (measured ${outcome.value})`,
        );
      }
      // An outsider stays green, so the red is attributable to the mutation.
      const outsider = mutant.find((entry) => entry.ok);
      assert.ok(outsider, `every reading red under ${mutation.name}, which reads as a broken rig`);
    } finally {
      await rm(basePath, { force: true });
      await rm(mutantPath, { force: true });
    }
  });
}
