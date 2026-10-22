#!/usr/bin/env node
/**
 * The regression guard for `experiments/voice-trim/run-savings.mjs` (AC-117).
 *
 * AC-117's criterion is the literal command `node experiments/voice-trim/run-savings.mjs`.
 * On 2026-10-04 that command went red without anyone touching this file: the shipping
 * module `src/shared/voiceTrim.ts` was refactored (d809d5b0) to reach its endpoint module
 * through the frontend's `@/` source-root alias, and a plain `node` process resolves no
 * such alias — so the runner's own static import of that module threw
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@/shared'` before a single line of it ran.
 * The fix registers the alias as a resolve hook in the runner itself. (The sibling
 * AC-118 runner, `run-quality.mjs`, hit the identical failure and carries the identical
 * fix; this guard is deliberately its twin, because the two criteria share one cause.)
 *
 * This test is the part of that fix that can go stale. Two things have to be true and
 * they are different things:
 *
 *   · the literal criterion command exits 0 and still prints its reading — the fix, read
 *     off a child process rather than asserted-about in prose; and
 *   · the guard can actually go RED. A test that only spawns the runner and checks exit 0
 *     passes just as loudly if the hook is a no-op, because at that point the runner would
 *     not be loading the aliased module at all. So the negative control takes a
 *     same-directory copy of the runner, strikes the one line that installs the hook, and
 *     requires the copy to die on exactly the error this task exists to remove. If the copy
 *     stays green, the registration line moved and the guard is measuring nothing.
 *
 * Run with `node --test scripts/voice-trim-harness.test.mjs`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HARNESS_DIR = join(ROOT, 'experiments', 'voice-trim');
const RUN = join(HARNESS_DIR, 'run-savings.mjs');

/**
 * The single line whose absence is the failure the negative control reproduces. It is
 * quoted here verbatim on purpose: the guard's whole job is to notice that the hook is no
 * longer installed, so a silent drift in this identifier must fail the guard rather than
 * leave it spawning a still-hooked copy and reporting green.
 */
const ALIAS_REGISTRATION = 'registerHooks(aliasHook);';

/**
 * Run one of the `node` runners as a child and hand back its outcome whether it exits 0 or
 * throws. `execFileSync` raises on a non-zero status, so the failure shape is the only way
 * to read a red run's stderr; the positive case is read the same way so both legs share one
 * code path.
 *
 * @param {string} file absolute path to the `.mjs` to run
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runNode(file) {
  try {
    const stdout = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const failure = /** @type {any} */ (err);
    return {
      status: typeof failure.status === 'number' ? failure.status : null,
      stdout: String(failure.stdout ?? ''),
      stderr: String(failure.stderr ?? ''),
    };
  }
}

test('the literal criterion command loads the aliased shipping module and exits 0', () => {
  const { status, stdout, stderr } = runNode(RUN);

  assert.equal(status, 0, `run-savings.mjs exited ${status}; stderr=${stderr}`);
  // The module-not-found this task removed must be absent from stderr, not merely survived:
  // an exit 0 that still printed the alias error would mean the run short-circuited on
  // something else. stderr is otherwise empty on a healthy run, so nothing else is asserted.
  assert.ok(!stderr.includes('ERR_MODULE_NOT_FOUND'), `stderr carried a module-not-found:\n${stderr}`);
  assert.ok(!stderr.includes('@/shared'), `stderr carried the alias the hook exists to resolve:\n${stderr}`);

  // The reading the criterion exists to produce: a per-clip baseline/trimmed time and
  // savedRatio, the aggregate and its speech-kept and fallback readings, and the identity
  // control's zero row that keeps a lazy implementation from scoring full marks.
  assert.match(stdout, /savedRatio=/, 'the per-clip savedRatio reading was not printed');
  assert.match(stdout, /aggregate=/, 'the aggregate savedRatio reading was not printed');
  assert.match(stdout, /speechKeptRatio=/, 'the speechKeptRatio reading was not printed');
  assert.match(stdout, /fallbacks=\d/, 'the fallbacks reading was not printed');
  assert.match(stdout, /savedRatio=0\.0000/, 'the identity positive-control row (savedRatio 0) was not printed');
  assert.match(stdout, /canary=RED 3\/3/, 'the uniqueness canaries did not all fire');
  assert.match(stdout, /checked: \d+ file\(s\)/, 'the uniqueness scan statistic line was not printed');
  assert.match(stdout, /voice-trim savings: OK —/, 'the final OK verdict line was not printed');
});

test('the guard is not dumb: stripping the alias hook reds a same-directory copy on @/shared', () => {
  const source = readFileSync(RUN, 'utf8');
  assert.ok(
    source.includes(ALIAS_REGISTRATION),
    `run-savings.mjs no longer contains "${ALIAS_REGISTRATION}" — the negative control cannot reproduce the failure, ` +
      'so this guard would pass no matter whether the alias is resolvable',
  );

  const stripped = source.replace(ALIAS_REGISTRATION, '// alias hook removed by the negative control');
  assert.notEqual(stripped, source, 'the registration line was found but nothing was replaced');

  // Same directory as the runner: its `../../src/...` imports only resolve from there, and
  // the copy must fail for the alias reason rather than a relocated relative path.
  const copy = join(HARNESS_DIR, `.run-savings.negative-control.${process.pid}.mjs`);
  try {
    writeFileSync(copy, stripped, 'utf8');
    const { status, stderr } = runNode(copy);

    assert.notEqual(status, 0, 'the hook-stripped copy exited 0 — the guard cannot tell the fix from its absence');
    assert.match(stderr, /ERR_MODULE_NOT_FOUND/, `the copy did not fail on a missing module; stderr=${stderr}`);
    assert.match(stderr, /@\/shared/, `the copy did not fail on the @/ alias (the failure this task removes); stderr=${stderr}`);
  } finally {
    rmSync(copy, { force: true });
  }
});
