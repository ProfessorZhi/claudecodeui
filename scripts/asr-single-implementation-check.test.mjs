#!/usr/bin/env node
/**
 * The falsification controls for scripts/asr-single-implementation-check.mjs (AC-129).
 *
 * Each case below first runs the probe against an UNMUTATED fixture and requires green, then
 * applies exactly one mutation and requires red. Both halves matter: only the second half
 * proves the probe notices the fake form, and only the first proves the red came from the
 * mutation rather than from a probe that is red for every input.
 *
 * The fixture is built at run time, in a temporary directory, OUT OF THE SHIPPING FILES —
 * copied, never re-typed. Two reasons. A fixture that were checked into the repository would
 * itself be the second implementation the uniqueness scan is looking for, and would have to be
 * excluded by name, which is the hardcoded-list shape this probe exists to avoid. And a
 * hand-written stub would prove the probe reads the stub, not that it reads this repository's
 * real import specifiers.
 *
 * Run with: node --test scripts/asr-single-implementation-check.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PROBE = path.join(SCRIPT_DIR, 'asr-single-implementation-check.mjs');

/**
 * The shipping files a fixture needs: the implementation, one consumer per group, the alias
 * registration the frontend's specifier resolves through, and the four files the landing
 * report reads. Copied from the repository so the probe meets the real specifiers.
 */
const SHIPPING_FILES = [
  'tsconfig.json',
  'vite.config.js',
  'vitest.config.ts',
  '.oxlintrc.json',
  'package.json',
  'shared/asr/transcriptionWire.ts',
  // The two files that carry the endpoint literal WITHOUT shaping a request or parsing a
  // response: the registry names it in the comment explaining the multipart shape, and the
  // offline invariant board records the URL its fixture resolves to. They are in the fixture
  // because the probe used to report them as second implementations; the case at the bottom of
  // this file is the one that holds the distinction in place.
  'shared/asr/asrRegistry.ts',
  'shared/asr/asrInvariants.ts',
  'src/shared/api.ts',
  'src/modules/chat/hooks/useVoiceInput.ts',
  'server/modules/voice/voice.service.ts',
  'experiments/voice-asr-cli/transcribe.ts',
];

const IMPLEMENTATION_FILE = 'shared/asr/transcriptionWire.ts';
/** A file in the fixture that mentions the endpoint and implements nothing. */
const MENTION_FILE = 'shared/asr/asrRegistry.ts';

function buildFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asr-wire-probe-'));
  for (const relativePath of SHIPPING_FILES) {
    const destination = path.join(root, relativePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(path.join(REPO_ROOT, relativePath), destination);
  }
  return root;
}

/**
 * @param {string} root
 * @param {string[]} [args]
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function runProbe(root, args = []) {
  const result = spawnSync(process.execPath, [PROBE, '--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.error, undefined, `the probe could not be started: ${result.error?.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * A fixture whose probe run is green — the precondition every mutation case starts from.
 * @param {import('node:test').TestContext} t
 * @returns {string} the fixture root
 */
function greenFixture(t) {
  const root = buildFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = runProbe(root);
  assert.equal(
    baseline.status,
    0,
    `the unmutated fixture must pass, otherwise the mutation below proves nothing:\n${baseline.stdout}`,
  );
  return root;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} contents
 */
function writeFixtureFile(root, relativePath, contents) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

/**
 * Replaces `from` with `to`, refusing to silently no-op on a fixture that has drifted.
 * @param {string} root
 * @param {string} relativePath
 * @param {string} from
 * @param {string} to
 */
function patchFixtureFile(root, relativePath, from, to) {
  const filePath = path.join(root, relativePath);
  const source = readFileSync(filePath, 'utf8');
  assert.ok(source.includes(from), `${relativePath} no longer contains ${from}; this case needs updating`);
  writeFileSync(filePath, source.replace(from, to));
}

/**
 * @param {string} root
 * @returns {string}
 */
function readImplementation(root) {
  return readFileSync(path.join(root, IMPLEMENTATION_FILE), 'utf8');
}

// ── AC3 ──────────────────────────────────────────────────────────────────────────────────────

test('AC3: a copy written on each side makes the consumers resolve to different paths', (t) => {
  const root = greenFixture(t);
  const implementation = readImplementation(root);

  // The fake form: instead of importing the shared module, each side keeps its own copy.
  writeFixtureFile(root, 'shared/asr/transcriptionWireFrontend.ts', implementation);
  writeFixtureFile(root, 'shared/asr/transcriptionWireServer.ts', implementation);

  patchFixtureFile(
    root,
    'src/shared/api.ts',
    '@shared/asr/transcriptionWire',
    '@shared/asr/transcriptionWireFrontend',
  );
  patchFixtureFile(
    root,
    'src/modules/chat/hooks/useVoiceInput.ts',
    '@shared/asr/transcriptionWire',
    '@shared/asr/transcriptionWireFrontend',
  );
  patchFixtureFile(
    root,
    'server/modules/voice/voice.service.ts',
    '../../../shared/asr/transcriptionWire.js',
    '../../../shared/asr/transcriptionWireServer.js',
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `a per-side copy must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /paths differ/, `the verdict must name the shape it found:\n${result.stdout}`);
});

// ── AC4 ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Three ways to be a second implementation, one at a time. The last two matter most: each
 * carries only ONE half of the wire protocol's vocabulary, so a probe that knew only the
 * endpoint literal (or only the parse) would stay green on them.
 */
/** @type {{ name: string, relativePath: string, source: (root: string) => string }[]} */
const SECOND_IMPLEMENTATION_VARIANTS = [
  {
    name: 'a verbatim copy of the implementation that nothing imports',
    relativePath: 'server/modules/voice/transcriptionWireCopy.ts',
    source: (root) => readImplementation(root),
  },
  {
    name: 'a second multipart builder, with no endpoint literal in it',
    relativePath: 'src/shared/legacyTranscriptionBody.ts',
    source: () =>
      [
        'export function buildLegacyTranscriptionBody(audio: Blob, fileName: string, model: string): FormData {',
        '  const body = new FormData();',
        "  body.append('file', audio, fileName);",
        "  body.append('model', model);",
        '  return body;',
        '}',
        '',
      ].join('\n'),
  },
  {
    name: 'a second response parser, with no request side in it',
    relativePath: 'src/shared/legacyTranscriptionResponse.ts',
    source: () =>
      [
        'export function readLegacyTranscript(responseText: string): string {',
        '  const parsed = JSON.parse(responseText) as { text?: unknown } | null;',
        "  return String(parsed?.text || '');",
        '}',
        '',
      ].join('\n'),
  },
];

test('AC4: a second implementation anywhere in production sources is reported as SECOND_IMPL', (t) => {
  const root = greenFixture(t);

  for (const variant of SECOND_IMPLEMENTATION_VARIANTS) {
    writeFixtureFile(root, variant.relativePath, variant.source(root));

    const result = runProbe(root);
    assert.notEqual(result.status, 0, `${variant.name} must not pass:\n${result.stdout}`);
    assert.match(result.stdout, /SECOND_IMPL/, `the verdict must name the shape it found:\n${result.stdout}`);

    // Removed again, so the next variant is proven on its own rather than in a pile.
    rmSync(path.join(root, variant.relativePath));
    assert.equal(runProbe(root).status, 0, `the fixture must return to green after removing ${variant.name}`);
  }
});

// ── the false positive this probe used to have ───────────────────────────────────────────────

/**
 * A file that only RECORDS the endpoint is not a second implementation. Both halves are asserted:
 * green (the unmutated fixture, which now carries the two real mention files), and red once that
 * same file is given a request to shape — so the reading above is a distinction rather than a
 * blind spot.
 */
test('AC4: a file that only records the endpoint is a mention, not a second implementation', (t) => {
  const root = greenFixture(t);
  const baseline = runProbe(root);
  assert.match(
    baseline.stdout,
    new RegExp(`^mention ${MENTION_FILE.replace(/[.\\/]/g, '\\$&')} markers=endpoint-literal \\(`, 'm'),
    `the mention has to be printed, or the green above is a scan that stopped looking:\n${baseline.stdout}`,
  );

  const filePath = path.join(root, MENTION_FILE);
  writeFileSync(
    filePath,
    `${readFileSync(filePath, 'utf8')}\nfunction legacyBody(audio, model) {\n  const body = new FormData();\n  body.append('file', audio);\n  body.append('model', model);\n  return body;\n}\n`,
  );

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `shaping a request in that file must not pass:\n${result.stdout}`);
  assert.match(result.stdout, /SECOND_IMPL/, `the verdict must name the shape it found:\n${result.stdout}`);
  assert.doesNotMatch(
    result.stdout,
    new RegExp(`^mention ${MENTION_FILE.replace(/[.\\/]/g, '\\$&')} `, 'm'),
    `the mutated file is no longer a mere mention:\n${result.stdout}`,
  );
});

// ── AC5 ──────────────────────────────────────────────────────────────────────────────────────

test('AC5: a tree with no implementation at all is a failure, not an empty pass', (t) => {
  const root = greenFixture(t);

  rmSync(path.join(root, IMPLEMENTATION_FILE));

  const result = runProbe(root);
  assert.notEqual(result.status, 0, `an empty scan must not exit 0:\n${result.stdout}`);
  assert.match(result.stdout, /no implementation/, `the verdict must name the shape it found:\n${result.stdout}`);
});

// ── AC8, the second half ─────────────────────────────────────────────────────────────────────

test('AC8: a landing that is not covered by npm run lint is reported, not merely un-flagged', (t) => {
  const root = greenFixture(t);

  const before = runProbe(root, ['--landing']);
  assert.equal(before.status, 0, `--landing must pass on the fixture:\n${before.stdout}`);
  assert.match(before.stdout, /^landing=shared\/asr$/m);
  assert.match(before.stdout, /^lint-covers-landing=yes/m);

  // The fake form: drop the landing directory from the lint path list. The tree is then only
  // "not flagged" — nothing lints it — which is exactly the reading this half must refuse.
  patchFixtureFile(root, 'package.json', 'oxlint src/ server/ scripts/ shared/', 'oxlint src/ server/ scripts/');

  const after = runProbe(root, ['--landing']);
  assert.notEqual(after.status, 0, `an uncovered landing must not pass:\n${after.stdout}`);
  assert.match(after.stdout, /^lint-covers-landing=no/m, `the verdict must name the shape it found:\n${after.stdout}`);
});
