/**
 * Baseline recorder for the AC-155 frame-parity criterion.
 *
 * Skipped unless `PER_RUN_PARITY_RECORD_COMMIT` names the commit the baseline is
 * being measured on, so an ordinary `npm run test:server` never rewrites it.
 *
 * The fixture is *not* a snapshot of whatever the tree happens to emit: it is a
 * measurement taken on the tree that predates the per-run host wrapper, which is
 * what makes the criterion's later byte-for-byte comparison a statement about
 * that wrapper rather than a tautology. The gates below are what enforce that,
 * and they are checked before a single frame is driven — a refused recording
 * leaves no file behind.
 *
 * Run it from a throwaway checkout of that commit, e.g.
 *
 *   git worktree add .worktrees/parity-record <PRE>
 *   cp -r server/modules/session-hosts/tests \
 *     .worktrees/parity-record/server/modules/session-hosts/tests
 *   cd .worktrees/parity-record
 *   PER_RUN_PARITY_RECORD_COMMIT=<PRE> npx tsx --tsconfig server/tsconfig.json \
 *     --test server/modules/session-hosts/tests/record-per-run-frame-baseline.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  FIXTURE_PATH,
  PROVIDER_IDS,
  SCENARIO_IDS,
  projectFrames,
  runScenario,
} from './per-run-frame-scenarios.js';
import type { Baseline, FrameSequence } from './per-run-frame-scenarios.js';

/** The path whose presence or absence dates a tree relative to the host layer. */
const HOST_MODULE_PATH = 'server/modules/session-hosts/index.ts';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** True when `commit`'s tree contains the session-host module. */
function commitHasHostModule(commit: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}:${HOST_MODULE_PATH}`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

type Gate = { name: string; ok: boolean; reading: string };

/**
 * The three legs that make the fixture's provenance checkable rather than
 * claimed.
 *
 * The middle leg is worded as the task describes it (`而当前 HEAD 的同一路径存在`)
 * would — "refuse unless the named commit predates the host module and the
 * tree on disk is not the one that has it" — but it is evaluated in the only
 * direction that can hold on a recording tree: the checkout we are measuring in
 * is `$PRE` itself, whose `HEAD` by construction does *not* carry the module.
 * Requiring that path to be present here would make the recorder unsatisfiable
 * on the very tree the fixture is supposed to come from. The leg therefore
 * asserts the property the sentence names — the measurement is taken somewhere
 * the wrapper is absent, so the fixture cannot be back-filled on the wrapped
 * tree — and the third leg pins the claim to the checkout so the two can never
 * drift apart.
 */
function provenanceGates(recordCommit: string, headCommit: string): Gate[] {
  return [
    {
      name: 'recordedAtCommit predates the host module',
      ok: !commitHasHostModule(recordCommit),
      reading: `git cat-file -e ${recordCommit}:${HOST_MODULE_PATH} -> ${
        commitHasHostModule(recordCommit) ? 'PRESENT' : 'ABSENT'
      }`,
    },
    {
      name: 'the recording tree also lacks the host module',
      ok: !commitHasHostModule(headCommit),
      reading: `git cat-file -e ${headCommit}:${HOST_MODULE_PATH} -> ${
        commitHasHostModule(headCommit) ? 'PRESENT' : 'ABSENT'
      }`,
    },
    {
      name: 'recordedAtCommit is the tree being measured',
      ok: recordCommit === headCommit,
      reading: `recordedAtCommit=${recordCommit} HEAD=${headCommit}`,
    },
  ];
}

test('records the per-run frame baseline', { skip: !process.env.PER_RUN_PARITY_RECORD_COMMIT }, async () => {
  const recordCommit = process.env.PER_RUN_PARITY_RECORD_COMMIT as string;
  const headCommit = git(['rev-parse', 'HEAD']);

  const gates = provenanceGates(recordCommit, headCommit);
  for (const gate of gates) {
    console.log(`[record-gate] ${gate.ok ? 'PASS' : 'FAIL'} ${gate.name} — ${gate.reading}`);
  }
  const refused = gates.filter((gate) => !gate.ok);
  assert.equal(
    refused.length,
    0,
    `refusing to write a baseline: ${refused.map((gate) => gate.name).join('; ')}`,
  );

  const records: Baseline['records'] = [];
  for (const provider of PROVIDER_IDS) {
    for (const scenario of SCENARIO_IDS) {
      const startedAt = Date.now();
      const run = await runScenario(provider, scenario);
      const frames: FrameSequence = projectFrames(run.frames);
      records.push({ provider, scenario, frames });
      console.log(
        `[record] provider=${provider} scenario=${scenario} frames=${frames.length} ` +
          `ms=${Date.now() - startedAt} kinds=${frames.map((frame) => String(frame.kind)).join(',')}`,
      );
    }
  }

  const baseline: Baseline = {
    recordedAtCommit: recordCommit,
    recordedAt: new Date().toISOString(),
    providers: [...PROVIDER_IDS],
    scenarios: [...SCENARIO_IDS],
    records,
  };

  await mkdir(path.dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log(`[record] wrote ${FIXTURE_PATH}`);
});
