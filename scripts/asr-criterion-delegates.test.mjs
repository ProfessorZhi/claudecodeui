#!/usr/bin/env node
/**
 * AC-132 / AC-133 read through their criterion entry points rather than through their probes.
 *
 * WHAT THIS PROVES, AND WHY IT IS NOT "THE FILE EXISTS". `scripts/asr-capability-check.mjs` and
 * `scripts/asr-mime-allowlist-check.mjs` carry no reading of their own — AC1 and AC2 are the
 * readings, and they compare this entry point's output against the probe it forwards to. A
 * delegate that swallowed its child and exited 0 would satisfy AC1/AC2 while destroying the
 * criterion, because the goal-driver reads THIS process's exit code. So each delegate is staged
 * alone in a throwaway directory with a STAND-IN probe beside it and driven with real arguments:
 *
 *   · the stand-in exits 7 ⇒ the delegate must exit 7 too, not 0;
 *   · the stand-in exits 0 ⇒ the delegate must exit 0 (the forward is not a constant);
 *   · the stand-in is absent ⇒ the delegate must exit non-zero (a missing probe is a failure, never
 *     a silent pass).
 *
 * The stand-in echoes the argv it received, so the assertions read the argument forwarding itself:
 * `--root /x --landing` is asserted to arrive whole, in order, and unmodified.
 *
 * The stand-ins are written, not read: each case stages only the two files it needs, so nothing
 * here can be satisfied by a probe that happens to be green in the shipping tree.
 *
 * Run with: node --test scripts/asr-criterion-delegates.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * A criterion entry point, paired with the probe name it resolves BESIDE ITSELF. The pairing is
 * the whole contract under test: the delegate resolves its target from its own directory, so a
 * staged copy picks up the stand-in.
 *
 * @typedef {{ id: string, entry: string, probe: string }} DelegatePair
 */

/** @type {DelegatePair[]} */
const DELEGATES = [
  { id: 'AC-132', entry: 'asr-capability-check.mjs', probe: 'asr-second-adapter-check.mjs' },
  { id: 'AC-133', entry: 'asr-mime-allowlist-check.mjs', probe: 'asr-mime-size-gaps-check.mjs' },
];

/** The arguments the forwarding assertions are written against. `--landing` is the one the probes
 *  actually branch on, so a delegate that dropped or reordered arguments would be caught. */
const ARGV = ['--root', '/x', '--landing'];
const ECHO = "process.stdout.write('argv=' + JSON.stringify(process.argv.slice(2)) + '\\n');\n";
const EXPECTED_ECHO = `argv=${JSON.stringify(ARGV)}`;

/** @type {string[]} */
const staged = [];
after(() => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stages `pair.entry` in a fresh throwaway directory, optionally beside a stand-in probe named
 * `pair.probe`. `probeBody === null` stages the delegate ALONE, which is the missing-probe case.
 *
 * @param {DelegatePair} pair
 * @param {string|null} probeBody
 * @returns {string} the staged delegate's path
 */
function stage(pair, probeBody) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asr-criterion-delegate-'));
  staged.push(dir);
  const entryCopy = path.join(dir, pair.entry);
  cpSync(path.join(SCRIPT_DIR, pair.entry), entryCopy);
  if (probeBody !== null) writeFileSync(path.join(dir, pair.probe), probeBody);
  return entryCopy;
}

/**
 * Drives a staged delegate and returns what a reader can observe from outside it.
 *
 * @param {string} entryCopy
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function run(entryCopy) {
  return spawnSync(process.execPath, [entryCopy, ...ARGV], { encoding: 'utf8' });
}

for (const pair of DELEGATES) {
  const { id, entry, probe } = pair;

  test(`${id}: ${entry} forwards a failing probe's status and its argv`, () => {
    const entryCopy = stage(pair, `${ECHO}process.exit(7);\n`);
    const result = run(entryCopy);
    assert.equal(
      result.status,
      7,
      `${entry} must exit with the probe's status, not mask it (stderr: ${result.stderr})`,
    );
    assert.equal(
      result.stdout.trim(),
      EXPECTED_ECHO,
      `${entry} must forward ${JSON.stringify(ARGV)} to ${probe} verbatim`,
    );
  });

  test(`${id}: ${entry} forwards a clean probe's status (the forward is not a constant)`, () => {
    const entryCopy = stage(pair, `${ECHO}process.exit(0);\n`);
    const result = run(entryCopy);
    assert.equal(
      result.status,
      0,
      `${entry} must exit 0 when the probe does, or the exit-7 case above proves nothing`,
    );
    assert.equal(result.stdout.trim(), EXPECTED_ECHO);
  });

  test(`${id}: ${entry} fails when the probe it names is absent`, () => {
    assert.ok(existsSync(path.join(SCRIPT_DIR, entry)), `${entry} must exist in the tree`);
    const entryCopy = stage(pair, null);
    const result = run(entryCopy);
    assert.notEqual(
      result.status,
      0,
      `${entry} must not report success for a missing ${probe} (stderr: ${result.stderr})`,
    );
  });
}
