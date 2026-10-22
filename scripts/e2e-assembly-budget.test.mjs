#!/usr/bin/env node
/**
 * The controls for `scripts/e2e-assembly-budget.mjs` — the module `playwright.config.ts` asks where
 * this run's scratch space goes and whether it can be prepared in time.
 *
 * WHY THESE CASES EXIST. The defect behind the module is that a run's scratch space (browser profile,
 * transform caches) is written to `os.tmpdir()` — the root filesystem, shared with the whole fleet —
 * while the run's *data* directory was already moved to a filesystem whose free space was read at the
 * moment of choosing. When that shared filesystem is under load, the criterion's page never renders
 * and the leg dies in its own assembly step, before any assertion it owns. The module's four
 * decisions are what stand between that and a leg that reports something it cannot explain:
 *
 *   a scratch root that has never been prepared is prepared — and the target is returned, so the
 *     caller has something to point the run at;
 *   a root already prepared inside the budget is skipped — a worker re-evaluating the config must not
 *     redo the owner's work, and re-warming is how a "fix" would cost a run its whole budget twice;
 *   a preparation that overruns the budget is refused, naming the target that overran — the failure
 *     lands on the step that failed instead of on the page load that never happened;
 *   an explicitly given target list is used as given — the module does not substitute its own choice
 *     for a decision the caller already made.
 *
 * THE READINGS, NOT THE PROMISES. Nothing here checks that a refusal "says" something. The overrun
 * case reads the target and the elapsed number back out of the result, and the shortfall case asserts
 * that each candidate was *consulted* and recorded, so "skipped" cannot be satisfied by a module that
 * never looked at its candidate list ([[anti-fake-variant-passes-means-criterion-hole]] in the
 * inverse: a green case has to be unreachable without the behaviour).
 *
 * EVERY INPUT IS INJECTED — the filesystem reading, the clock, the warm-up and the already-prepared
 * question — so that "no candidate has room" and "the preparation took too long" are inputs a test
 * hands in rather than an environment it has to stand up. This file therefore never writes to a
 * filesystem and never depends on how full any of them is.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import {
  ASSEMBLY_TEMP_ROOT_ENV,
  DEFAULT_ASSEMBLY_BUDGET_MS,
  DEFAULT_TEMP_NEED_MB,
  PROBE_FILE_NAME,
  assemblyTempCandidates,
  planAssembly,
} from './e2e-assembly-budget.mjs';

const MIB = 1024 * 1024;
const NEED = DEFAULT_TEMP_NEED_MB * MIB;

/**
 * A filesystem reader built from a table, which records every candidate it was asked about.
 *
 * The record matters as much as the answer: "this candidate was passed over" is only a reading if
 * something shows it was reached, and a module that ignored its candidate list entirely would
 * otherwise satisfy every "was not chosen" assertion here.
 *
 * @param {Record<string, number | null>} bytesByPath
 * @returns {{ availableBytes: (target: string) => number | null, asked: string[] }}
 */
const reader = (bytesByPath) => {
  /** @type {string[]} */
  const asked = [];
  return {
    asked,
    availableBytes: (target) => {
      asked.push(target);
      const answer = bytesByPath[target];
      if (answer === undefined) throw new Error(`no reading for ${target}`);
      return answer;
    },
  };
};

/**
 * A clock that only advances when the code under test asks it to, so an overrun is an input.
 *
 * @param {number} stepMs
 */
const steppingClock = (stepMs) => {
  let at = 0;
  return { now: () => at, advance: () => { at += stepMs; } };
};

test('AC: a scratch root that was never prepared is prepared, and is named', () => {
  const { availableBytes, asked } = reader({ '/roomy': 4 * NEED });
  /** @type {string[]} */
  const warmed = [];
  const plan = planAssembly({
    candidates: ['/roomy'],
    availableBytes,
    warm: (target) => warmed.push(target),
    isWarmed: () => false,
    now: () => 0,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.skipped, false);
  assert.deepEqual(plan.targets, ['/roomy']);
  assert.deepEqual(warmed, ['/roomy'], 'the named target was not the one prepared');
  assert.deepEqual(asked, ['/roomy'], 'the candidate was not weighed before being chosen');
  // The reading is carried back, so the caller can print what the choice was made against rather
  // than only what it chose.
  assert.equal(plan.warmed[0].availableBytes, 4 * NEED);
});

test('AC: a scratch root already prepared inside the budget is not prepared again', () => {
  const { availableBytes } = reader({ '/roomy': 4 * NEED });
  /** @type {string[]} */
  const warmed = [];
  const plan = planAssembly({
    candidates: ['/roomy'],
    availableBytes,
    warm: (target) => warmed.push(target),
    isWarmed: () => true,
    now: () => 0,
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.skipped, true, 'a prepared root was prepared a second time');
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(warmed, [], 'the warm-up ran for a target that was already prepared');
  // ...and the target it *would* have used is still reported, so "skipped" is distinguishable from
  // "there was nothing to prepare".
  assert.deepEqual(plan.prepared, ['/roomy']);
});

test('AC: a preparation that overruns the budget is refused, and the overrun names the target', () => {
  const { availableBytes } = reader({ '/slow': 4 * NEED });
  const budgetMs = 5_000;
  const clock = steppingClock(budgetMs + 1);
  const plan = planAssembly({
    candidates: ['/slow'],
    availableBytes,
    // Each call to `now` is one observable step, so the warm-up "takes" longer than the budget
    // without this test having to sleep for it.
    warm: () => clock.advance(),
    isWarmed: () => false,
    budgetMs,
    now: clock.now,
  });

  assert.equal(plan.ok, false);
  assert.equal(plan.target, '/slow', 'the refusal did not name the target that overran');
  assert.match(plan.reason, /assembly budget/);
  assert.match(plan.reason, /\/slow/, 'the refusal text does not name the target');
  assert.equal(plan.budgetMs, budgetMs);
  assert.ok(plan.elapsedMs > budgetMs, `elapsed ${plan.elapsedMs} was not reported as over ${budgetMs}`);
});

test('AC: an explicitly given target list is used as given, not substituted from the candidates', () => {
  const { availableBytes, asked } = reader({ '/roomy': 4 * NEED });
  /** @type {string[]} */
  const warmed = [];
  const plan = planAssembly({
    candidates: ['/roomy'],
    targets: ['/named-by-the-caller'],
    availableBytes,
    warm: (target) => warmed.push(target),
    isWarmed: () => false,
    now: () => 0,
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.targets, ['/named-by-the-caller'], 'the explicit target was overridden');
  assert.deepEqual(warmed, ['/named-by-the-caller']);
  assert.deepEqual(asked, [], 'an explicitly named target was re-weighed against the candidate list');
});

test('AC: no candidate with room is a refusal, and every candidate s shortfall is reported', () => {
  const { availableBytes, asked } = reader({ '/tight': 1, '/tighter': 0, '/unreadable': null });
  /** @type {string[]} */
  const warmed = [];
  const plan = planAssembly({
    candidates: ['/tight', '/tighter', '/unreadable'],
    availableBytes,
    warm: (target) => warmed.push(target),
    isWarmed: () => false,
    now: () => 0,
  });

  assert.equal(plan.ok, false);
  assert.deepEqual(asked, ['/tight', '/tighter', '/unreadable'], 'a candidate was never consulted');
  assert.deepEqual(warmed, [], 'a scratch root was prepared on a filesystem with no room');
  assert.match(plan.reason, /\/tight/);
  assert.match(plan.reason, /\/tighter/);
  assert.match(plan.reason, /could not be read/);
});

test('the candidate list puts this run s own directory ahead of the shared ones', () => {
  const tempRoot = assemblyTempCandidates({
    env: { [ASSEMBLY_TEMP_ROOT_ENV]: '/explicit', TMPDIR: '/shared' },
    dataDir: '/run-data',
    osTmpdir: '/shared',
  });

  // An explicit override first, then the run's own directory, then the shared locations — and the
  // shared ones appear once, not twice: `os.tmpdir()` reads `TMPDIR`, so a run with `TMPDIR` set
  // would otherwise weigh the same directory twice and report the same shortfall twice.
  assert.deepEqual(tempRoot, ['/explicit', join('/run-data', 'tmp'), '/shared']);
  // Without an explicit override the run's own directory wins, which is the whole point: the shared
  // locations are reachable only when it cannot hold the run.
  assert.deepEqual(
    assemblyTempCandidates({ env: {}, dataDir: '/run-data', osTmpdir: '/os-tmp' }),
    [join('/run-data', 'tmp'), '/os-tmp'],
  );
  // A run with no data directory at all is still offered the shared locations rather than an empty
  // list, so "no candidate has room" stays distinguishable from "no candidate was named".
  assert.deepEqual(assemblyTempCandidates({ env: {}, osTmpdir: '/os-tmp' }), ['/os-tmp']);
  assert.equal(PROBE_FILE_NAME.startsWith('.'), true);
  assert.equal(DEFAULT_ASSEMBLY_BUDGET_MS, 35_000);
});
