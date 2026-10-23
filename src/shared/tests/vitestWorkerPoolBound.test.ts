import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { test } from 'vitest';

/**
 * The client-pool bound is a load-bearing property of this repo, not a style
 * preference, so it gets a test instead of only a comment in the config.
 *
 * Vitest sizes its worker pool from `os.availableParallelism()` (128 on the
 * machines this loop runs on) when `test.maxWorkers` is unset. quay never runs
 * one suite at a time — each task worker runs scripts/test.sh as one of its own
 * judging criteria and fan-in runs it again — so oversized pools overlap,
 * oversubscribe Vite's module server, and workers die mid-run. Those deaths are
 * reported as ordinary failures (`STACK_TRACE_ERROR`, `Timeout calling "fetch"`)
 * with a different subset of files red each attempt, which is how a healthy tree
 * gets judged red and a task ends up parked as `exited-not-landed`.
 */

const CLIENT_MAX_WORKERS = 8;
// vitest reads its config from the project root it is invoked in, so that is
// where the file this test reads back lives.
const CONFIG_PATH = path.resolve(process.cwd(), 'vitest.config.ts');

/**
 * Evaluate vitest.config.ts and hand back the `test.maxWorkers` it computes.
 *
 * A child node process, not an import in this one: the config pulls in
 * `vitest/config` -> vite -> esbuild, and esbuild refuses to run inside the
 * jsdom realm this suite installs (its `TextEncoder`/`Uint8Array` invariant does
 * not survive a second realm). Reading it the way vitest itself does — a plain
 * node process evaluating the module — also means the assertion is on the value
 * this machine actually resolves, adaptivity included, rather than on a literal
 * scraped out of the source.
 */
const readConfiguredMaxWorkers = (): unknown => {
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const m = await import(process.env.VITEST_CONFIG_URL);' +
        'process.stdout.write(JSON.stringify(m.default?.test?.maxWorkers ?? null));',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, VITEST_CONFIG_URL: pathToFileURL(CONFIG_PATH).href },
    },
  );
  assert.equal(
    probe.status,
    0,
    `could not evaluate ${CONFIG_PATH} in a node child process (exit ${probe.status}): ${
      probe.stderr?.trim() || probe.error?.message || 'no stderr'
    }`,
  );
  return JSON.parse(probe.stdout);
};

test('vitest.config.ts caps the client worker pool below the CPU count', () => {
  const raw = readConfiguredMaxWorkers();
  const cpus = availableParallelism();

  assert.notEqual(
    raw,
    null,
    `vitest.config.ts does not pin test.maxWorkers; unset, vitest sizes the pool from os.availableParallelism() (${cpus} here) and concurrent suites kill each other's workers mid-run`,
  );
  assert.equal(
    typeof raw,
    'number',
    `test.maxWorkers must be a number of workers, got ${String(raw)}`,
  );

  const maxWorkers = Number(raw);
  assert.ok(
    Number.isInteger(maxWorkers),
    `test.maxWorkers must be a whole number of workers, got ${maxWorkers}`,
  );
  assert.ok(
    maxWorkers >= 1 && maxWorkers <= CLIENT_MAX_WORKERS,
    `test.maxWorkers must stay within [1, ${CLIENT_MAX_WORKERS}] so one suite cannot oversubscribe the box and take the concurrent suites' workers down with it; got ${maxWorkers}`,
  );
  assert.ok(
    maxWorkers <= cpus,
    `test.maxWorkers (${maxWorkers}) must not ask for more workers than the ${cpus} CPUs available`,
  );
  if (cpus > CLIENT_MAX_WORKERS) {
    assert.ok(
      maxWorkers < cpus,
      `test.maxWorkers (${maxWorkers}) equals the CPU count (${cpus}) on a machine this wide — that is vitest's uncapped default, not a bound, and it is exactly what lets overlapping suites kill workers mid-run`,
    );
  }
});
