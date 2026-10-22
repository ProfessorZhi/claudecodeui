import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, providerModelsDb } from '@/modules/database/index.js';
import { resolveModelLaunchSpec } from '@/modules/providers/index.js';
import type { LaunchSpecGuards } from '@/modules/providers/index.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

async function withDb(run: () => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-launch-spec-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    await run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const seed = (id: string, env: ProviderModelEnvRow[] | null) =>
  providerModelsDb.createCustomProviderModel('claude', { id, model: id, config: env ? { env } : null });

/**
 * Inline value of a denied row, unique per key so a leak in a later assertion can be traced back
 * to the row that produced it.
 */
const deniedRowValue = (key: string) => `/evil/${key}`;

/**
 * The keys the model-config write path rejects (`DENIED_ENV_KEYS` in launch-spec.service.ts, the
 * AC-023 write-path object) plus one `DYLD_`-prefixed key, the predicate's second rejection branch.
 * `seed()` writes these straight through the db layer, i.e. BYPASSING the write-path validation, so
 * the compile path's own re-validation (AC-024) is the only thing that can drop them.
 */
const DENIED_KEYS = [
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELL', 'IFS',
  'PYTHONPATH', 'CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR', 'DYLD_INSERT_LIBRARIES',
];
const DENIED_ROWS: ProviderModelEnvRow[] = DENIED_KEYS.map((key) => ({ key, kind: 'value', value: deniedRowValue(key) }));

/** Allowed rows in the SAME entry: positive control, so a "drop everything" compile cannot pass. */
const ALLOWED_ROWS: ProviderModelEnvRow[] = [
  { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://denied-rows.example' },
  { key: 'CLAUDE_CODE_DISABLE_MOUSE', kind: 'value', value: '1' },
];

/**
 * The compile-path contract for an entry written around the write path: every denied row is dropped
 * from `spec.env` AND named by its own warning, while the allowed rows of the same entry still compile.
 */
function assertCompilePathDropsDeniedRows(
  spec: { env: Record<string, string | undefined>; warnings: string[] },
  label: string,
): void {
  for (const row of ALLOWED_ROWS) {
    assert.equal(spec.env[row.key], row.value, `${label}: allowed row ${row.key} still compiles`);
  }
  for (const key of DENIED_KEYS) {
    assert.ok(!(key in spec.env), `${label}: denied row ${key} must not compile into spec.env`);
    assert.ok(spec.warnings.some((warning) => warning.includes(key)), `${label}: a warning must name ${key}`);
  }
}

/**
 * The negative control: the lax filter the production guard stands in for. Used to prove the
 * assertions above are load-bearing rather than vacuously green.
 */
const LAX_GUARD: LaunchSpecGuards = { isAllowedKey: () => true };

test('built-in and unconfigured custom models compile to the passthrough spec', async () => {
  await withDb(() => {
    seed('plain-custom', null);
    for (const id of ['opus', 'sonnet', 'not-a-model', 'plain-custom', undefined, null]) {
      const spec = resolveModelLaunchSpec('claude', id);
      assert.deepStrictEqual(spec.env, {});
      assert.deepStrictEqual(spec.unsetEnv, []);
      assert.deepStrictEqual(spec.argv, []);
      assert.deepStrictEqual(spec.warnings, []);
    }
  });
});

test('value/secret/envref/unset rows compile with the documented semantics', async () => {
  await withDb(() => {
    const previous = process.env.MODEL_SPEC_TEST_REF;
    process.env.MODEL_SPEC_TEST_REF = 'from-host';
    try {
      seed('gw', [
        { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://gw.example' },
        { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: 'sk-secret' },
        { key: 'CLAUDE_CODE_DISABLE_MOUSE', kind: 'envref', value: 'MODEL_SPEC_TEST_REF' },
        { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
        { key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', kind: 'value', value: '400000' },
        { key: 'PATH', kind: 'value', value: '/evil' },
      ]);
      const spec = resolveModelLaunchSpec('claude', 'gw');
      assert.equal(spec.env.ANTHROPIC_BASE_URL, 'https://gw.example');
      assert.equal(spec.env.ANTHROPIC_AUTH_TOKEN, 'sk-secret');
      assert.equal(spec.env.CLAUDE_CODE_DISABLE_MOUSE, 'from-host');
      assert.deepStrictEqual(spec.unsetEnv, ['ANTHROPIC_API_KEY']);
      assert.equal(spec.contextWindow, 400000);
      assert.ok(!('PATH' in spec.env), 'denied key never compiled');
      assert.ok(spec.warnings.some((w) => w.includes('PATH')));
    } finally {
      if (previous === undefined) delete process.env.MODEL_SPEC_TEST_REF;
      else process.env.MODEL_SPEC_TEST_REF = previous;
    }
  });
});

test('envref to a missing host variable warns and does not export the key', async () => {
  await withDb(() => {
    delete process.env.MODEL_SPEC_TEST_MISSING;
    seed('gw', [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'envref', value: 'MODEL_SPEC_TEST_MISSING' }]);
    const spec = resolveModelLaunchSpec('claude', 'gw');
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in spec.env));
    assert.equal(spec.warnings.length, 1);
    assert.match(spec.warnings[0], /MODEL_SPEC_TEST_MISSING/);
  });
});

test('rows written around the write path are re-filtered on every compile: denied keys never compile, each named by a warning', async () => {
  await withDb(() => {
    seed('denied-rows', [...DENIED_ROWS, ...ALLOWED_ROWS]);
    const spec = resolveModelLaunchSpec('claude', 'denied-rows');
    assertCompilePathDropsDeniedRows(spec, 'real');
    // One warning per dropped row, no more: nothing is dropped silently or twice.
    assert.equal(spec.warnings.length, DENIED_KEYS.length);
  });
});

test('fake variant: under a lax LaunchSpecGuards the same contract goes red, so the seam is load-bearing', async () => {
  await withDb(() => {
    seed('denied-rows', [...DENIED_ROWS, ...ALLOWED_ROWS]);
    const lax = resolveModelLaunchSpec('claude', 'denied-rows', LAX_GUARD);
    // The lax filter is exactly what the production guard stands in for: every denied row lands.
    for (const key of DENIED_KEYS) {
      assert.equal(lax.env[key], deniedRowValue(key), `lax: ${key} lands when the filter is open`);
    }
    assert.equal(lax.warnings.length, 0, 'lax: nothing is dropped, so nothing is warned about');
    assert.throws(() => assertCompilePathDropsDeniedRows(lax, 'lax'), /must not compile into spec.env/);
  });
});
