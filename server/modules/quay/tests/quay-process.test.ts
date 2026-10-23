import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { createQuayProcessRunner, type QuayExecFile } from '../quay-process.js';

/**
 * The failure this guards, measured against the real Quay panel (2026-10-04):
 * `quay task list --json` prints every task's whole body, so its payload is
 * linear in the store — this workspace's own quay store (2,531 tasks) prints
 * ~26 MB. At the adapter's previous 8 MiB `maxBuffer` the child was killed
 * mid-string, the service got a stdout torn in the middle of a JSON string,
 * `JSON.parse` threw, and the Task ledger degraded to `null` — which the panel
 * rendered as "0 tasks · 0 ready · 0 needs human · 0 done".
 *
 * The emitter prints a little more than that old cap, so a buffer policy lowered
 * back below a real store's payload fails here instead of silently in the panel.
 */
const OVER_OLD_CAP_BYTES = 9 * 1024 * 1024;

/** Temp project roots created by fixtures; removed once, after the whole file. */
const TEMP_ROOTS: string[] = [];

after(() => {
  for (const root of TEMP_ROOTS) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Creates an isolated temp project root carrying an executable
 * `.quay/plugin/bin/quay` fixture. The fixture is a POSIX shell script so the
 * test never depends on `node` being on the spawned child's `PATH`; `$0` inside
 * it is the absolute entrypoint path, which is what proves *which* project's
 * binary actually ran.
 */
function createProjectRoot(marker: string): { root: string; entrypoint: string; script: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quay-process-'));
  TEMP_ROOTS.push(root);

  const entrypoint = path.join(root, '.quay', 'plugin', 'bin', 'quay');
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, `#!/bin/sh\necho "${marker} $0"\n`);
  fs.chmodSync(entrypoint, 0o755);

  return { root, entrypoint, script: entrypoint };
}

/** An `execFile` error carrying the fields the adapter's classifier inspects. */
function spawnError(fields: { code?: number | string; killed?: boolean; message?: string }): Error & {
  code?: number | string;
  killed?: boolean;
} {
  const error: Error & { code?: number | string; killed?: boolean } = new Error(
    fields.message ?? 'spawn failed',
  );
  if (fields.code !== undefined) {
    error.code = fields.code;
  }
  if (fields.killed !== undefined) {
    error.killed = fields.killed;
  }
  return error;
}

/** A fake spawn boundary recording the exact `(file, args)` the adapter resolved. */
function createRecordingExecFile(): {
  calls: Array<{ file: string; args: readonly string[] }>;
  execFile: QuayExecFile;
} {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const execFile: QuayExecFile = (file, args, _options, done) => {
    calls.push({ file, args });
    done(null, '[]', '');
  };
  return { calls, execFile };
}

test('the quay process adapter captures a payload larger than the old 8 MiB cap through the project entrypoint', async () => {
  // The fixture runs `node` by absolute path (the one running this test) and
  // prints a payload above the old cap. Driving the *real* `execFile` through a
  // real project entrypoint exercises the resolution, the chmod, and the buffer
  // policy together — not just the maxBuffer constant.
  const { root } = createProjectRoot('large-payload');
  fs.writeFileSync(
    path.join(root, '.quay', 'plugin', 'bin', 'quay'),
    `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdout.write(JSON.stringify({pad:"x".repeat(${OVER_OLD_CAP_BYTES})}))'\n`,
  );
  fs.chmodSync(path.join(root, '.quay', 'plugin', 'bin', 'quay'), 0o755);

  const runner = createQuayProcessRunner();
  const result = await runner(root, ['task', 'list', '--json'], { timeoutMs: 30_000 });

  assert.equal(result.error, undefined, `expected a clean run, got: ${result.error ?? ''}`);
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  // Not merely "untruncated by luck": the payload round-trips through JSON.parse,
  // which is the step that failed on the torn stdout.
  const parsed = JSON.parse(result.stdout) as { pad: string };
  assert.equal(parsed.pad.length, OVER_OLD_CAP_BYTES);
});

test('AC1: the adapter spawns the absolute <projectRoot>/.quay/plugin/bin/quay path, never the literal "quay"', async () => {
  const { calls, execFile } = createRecordingExecFile();
  const runner = createQuayProcessRunner({
    execFile,
    fileExists: () => true,
    isExecutable: () => true,
  });

  const projectRoot = path.join(path.sep, 'workspace', 'project-scoped');
  const expectedEntrypoint = path.join(projectRoot, '.quay', 'plugin', 'bin', 'quay');

  const result = await runner(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, expectedEntrypoint);
  assert.notEqual(calls[0]?.file, 'quay');
  // The whitelisted argv is passed through unchanged after the resolved binary.
  assert.deepEqual(calls[0]?.args, ['task', 'list', '--json']);
});

test('AC2: resolution is project-scoped — two roots resolve under their own directory, and QUAY_BIN is not the primary path', async () => {
  const { calls, execFile } = createRecordingExecFile();
  const runner = createQuayProcessRunner({
    execFile,
    fileExists: () => true,
    isExecutable: () => true,
  });

  const rootA = path.join(path.sep, 'workspace', 'project-a');
  const rootB = path.join(path.sep, 'workspace', 'project-b');

  // Negative control: even when a service-level QUAY_BIN points elsewhere, the
  // resolved path stays the project's own entrypoint — so QUAY_BIN is not the
  // primary resolution path.
  const previousQuayBin = process.env.QUAY_BIN;
  process.env.QUAY_BIN = path.join(path.sep, 'opt', 'elsewhere', 'quay');
  try {
    await runner(rootA, ['task', 'list', '--json'], { timeoutMs: 8_000 });
    await runner(rootB, ['task', 'list', '--json'], { timeoutMs: 8_000 });
  } finally {
    if (previousQuayBin === undefined) {
      delete process.env.QUAY_BIN;
    } else {
      process.env.QUAY_BIN = previousQuayBin;
    }
  }

  assert.equal(calls[0]?.file, path.join(rootA, '.quay', 'plugin', 'bin', 'quay'));
  assert.equal(calls[1]?.file, path.join(rootB, '.quay', 'plugin', 'bin', 'quay'));
  assert.ok(calls[0]?.file.startsWith(rootA));
  assert.ok(calls[1]?.file.startsWith(rootB));
  assert.notEqual(calls[0]?.file, calls[1]?.file);
});

test('AC3: a missing entrypoint falls back to the bare PATH "quay" with exactly one explicit warning', async () => {
  const { calls, execFile } = createRecordingExecFile();
  const warnings: string[] = [];
  const runner = createQuayProcessRunner({
    execFile,
    fileExists: () => false,
    warn: (message) => {
      warnings.push(message);
    },
  });

  const projectRoot = path.join(path.sep, 'workspace', 'mid-migration');
  const result = await runner(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  assert.equal(result.ok, true);
  // The fallback branch really spawned the bare command, and warned exactly once.
  assert.deepEqual(calls.map((call) => call.file), ['quay']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /PATH/);
  assert.match(warnings[0] ?? '', /\/quay:init/);
});

test('AC4: failures are classified into four distinct kinds, and the missing-entrypoint message names /quay:init', async () => {
  const projectRoot = path.join(path.sep, 'workspace', 'project-scoped');
  const entrypoint = path.join(projectRoot, '.quay', 'plugin', 'bin', 'quay');

  // (1) No project entrypoint and no bare `quay` on PATH.
  const missing = createQuayProcessRunner({
    execFile: (_file, _args, _options, done) => {
      done(spawnError({ code: 'ENOENT' }), '', '');
    },
    fileExists: () => false,
    warn: () => {},
  });
  const missingResult = await missing(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  // (2) Entrypoint exists but lacks the execute permission → refused before spawning.
  let spawnCountForNotExecutable = 0;
  const notExecutable = createQuayProcessRunner({
    execFile: (_file, _args, _options, done) => {
      spawnCountForNotExecutable += 1;
      done(null, '', '');
    },
    fileExists: () => true,
    isExecutable: () => false,
  });
  const notExecutableResult = await notExecutable(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  // (3) The child exceeded its wall-clock bound and was killed.
  const timedOut = createQuayProcessRunner({
    execFile: (_file, _args, _options, done) => {
      done(spawnError({ killed: true, message: 'Command timed out' }), '', '');
    },
    fileExists: () => true,
    isExecutable: () => true,
  });
  const timeoutResult = await timedOut(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  // (4) The child ran and exited non-zero, writing to stderr.
  const exited = createQuayProcessRunner({
    execFile: (_file, _args, _options, done) => {
      done(spawnError({ code: 2, message: 'Command failed' }), '', 'boom');
    },
    fileExists: () => true,
    isExecutable: () => true,
  });
  const exitResult = await exited(projectRoot, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  const kinds = [
    missingResult.failureKind,
    notExecutableResult.failureKind,
    timeoutResult.failureKind,
    exitResult.failureKind,
  ];
  assert.deepEqual(kinds, [
    'entrypoint-missing',
    'entrypoint-not-executable',
    'timeout',
    'nonzero-exit',
  ]);
  // Four pairwise-distinct categories, not one generic message.
  assert.equal(new Set(kinds).size, 4);

  assert.match(missingResult.error ?? '', /\/quay:init/);
  assert.equal(spawnCountForNotExecutable, 0);
  assert.ok((notExecutableResult.error ?? '').includes(entrypoint));
  assert.match(timeoutResult.error ?? '', /timed out/);
  assert.equal(exitResult.code, 2);
  assert.equal(exitResult.stderr, 'boom');
  assert.match(exitResult.error ?? '', /non-zero/);
});

test('AC4 (real filesystem): an entrypoint without the execute bit is reported, never spawned', async () => {
  const { root } = createProjectRoot('not-executable');
  const entrypoint = path.join(root, '.quay', 'plugin', 'bin', 'quay');
  fs.chmodSync(entrypoint, 0o644);

  const runner = createQuayProcessRunner();
  const result = await runner(root, ['task', 'list', '--json'], { timeoutMs: 8_000 });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'entrypoint-not-executable');
});

test("AC5: two projects with independent entrypoint fixtures never cross-use each other's CLI", async () => {
  const projectA = createProjectRoot('MARKER-A');
  const projectB = createProjectRoot('MARKER-B');

  const runner = createQuayProcessRunner();

  const resultA = await runner(projectA.root, ['task', 'list', '--json'], { timeoutMs: 30_000 });
  const resultB = await runner(projectB.root, ['task', 'list', '--json'], { timeoutMs: 30_000 });

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);

  // A's call ran A's binary (its own marker and its own absolute path), and
  // nothing from B leaked in — and vice versa.
  assert.match(resultA.stdout, /MARKER-A/);
  assert.ok(resultA.stdout.includes(projectA.entrypoint));
  assert.doesNotMatch(resultA.stdout, /MARKER-B/);
  assert.ok(!resultA.stdout.includes(projectB.entrypoint));

  assert.match(resultB.stdout, /MARKER-B/);
  assert.ok(resultB.stdout.includes(projectB.entrypoint));
  assert.doesNotMatch(resultB.stdout, /MARKER-A/);
  assert.ok(!resultB.stdout.includes(projectA.entrypoint));
});
