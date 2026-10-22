import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { closeConnection, initializeDatabase, providerModelsDb } from '@/modules/database/index.js';
import { mapCliOptionsToSDK, resolveModelLaunchSpec } from '@/modules/providers/index.js';
import type { LaunchSpecGuards } from '@/modules/providers/index.js';
import { handleShellConnection } from '@/modules/websocket/index.js';
import { applyLaunchSpecEnv } from '@/shared/utils.js';
import type { ProviderModelEnvRow } from '@/shared/types.js';

type Env = Record<string, string | undefined>;

// Reference: the historical claude-fjdac launch. Known non-equivalences with it (registered honestly):
//  - the original used a shell wrapper exporting these vars; here they are compiled from library rows;
//  - CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS (SDK path) and TERM/COLORTERM/FORCE_COLOR (pty path) are added by the app;
//  - the credential value is asserted only for presence/source, never printed.
const SECRET = 'sk-fjdac-SENTINEL';
const FJDAC_ROWS: ProviderModelEnvRow[] = [
  { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://fjdac.example' },
  { key: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', value: SECRET },
  { key: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'value', value: 'fj-opus' },
  { key: 'ANTHROPIC_DEFAULT_SONNET_MODEL', kind: 'value', value: 'fj-sonnet' },
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'value', value: 'fj-haiku' },
  { key: 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', kind: 'value', value: '400000' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', kind: 'value', value: '300000' },
  { key: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', kind: 'value', value: '80' },
  { key: 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN', kind: 'value', value: '1' },
  { key: 'CLAUDE_CODE_DISABLE_MOUSE', kind: 'value', value: '1' },
  { key: 'ANTHROPIC_API_KEY', kind: 'unset' },
];
const FJDAC_KEYS = FJDAC_ROWS.filter((row) => row.kind !== 'unset').map((row) => row.key);

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (d: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.send = () => undefined;
  return socket;
}

function capturePtyEnv(model: string): Env {
  let captured: Env | null = null;
  const fakePty = {
    onData: () => ({ dispose: () => undefined }),
    onExit: () => ({ dispose: () => undefined }),
    write() {}, resize() {}, kill() {},
  };
  const socket = createFakeSocket();
  handleShellConnection(socket as never, {
    resolveProviderSessionId: () => null,
    spawnPty: ((_s: string, _a: string[], opts: { env: Env }) => {
      captured = opts.env;
      return fakePty;
    }) as never,
  });
  socket.emit('message', JSON.stringify({
    type: 'init', projectPath: process.cwd(), sessionId: `spawn-env-${Date.now()}`, hasSession: false,
    provider: 'plain-shell', isPlainShell: true, initialCommand: 'true', model,
  }));
  assert.ok(captured, 'spawnPty was called');
  return captured;
}

/** The contract every final spawn env must meet for the fjdac fixture. */
function assertFjdacEnv(env: Env, label: string): void {
  assert.ok(!('ANTHROPIC_API_KEY' in env), `${label}: unset key must be absent from the final env`);
  for (const key of FJDAC_KEYS) {
    assert.ok(typeof env[key] === 'string' && env[key], `${label}: ${key} present`);
  }
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://fjdac.example');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN === SECRET, true, `${label}: credential sourced from the library secret`);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '400000');
}

/**
 * Inline value of a denied row, unique per key so a leak can be traced back to the row that
 * produced it.
 */
const deniedRowValue = (key: string) => `/evil/${key}`;

/**
 * The keys the model-config write path rejects (`DENIED_ENV_KEYS`, the AC-023 object) plus one
 * `DYLD_`-prefixed key. The fixture below writes them straight to the library through the db layer,
 * i.e. BYPASSING the write-path validation, so only the compile path's own re-validation can drop
 * them — this is the compile-path half AC-023 cannot substitute for.
 */
const CLOSED_KEYS = [
  'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV', 'SHELL', 'IFS',
  'PYTHONPATH', 'CLAUDE_CLI_PATH', 'CLAUDE_CONFIG_DIR', 'DYLD_INSERT_LIBRARIES',
];
const DENIED_ROWS: ProviderModelEnvRow[] = CLOSED_KEYS.map((key) => ({ key, kind: 'value', value: deniedRowValue(key) }));
/** Positive control in the SAME entry: a row that must reach the final env, so "drop everything" cannot pass. */
const ALLOWED_ROW: ProviderModelEnvRow = { key: 'ANTHROPIC_BASE_URL', kind: 'value', value: 'https://denied-rows.example' };
const DENIED_MODEL = 'denied-rows';

/** The lax filter the production guard stands in for; used by the negative control below. */
const LAX_GUARD: LaunchSpecGuards = { isAllowedKey: () => true };

const hostExports = (key: string) => process.env[key] !== undefined;

/**
 * The contract a FINAL spawn env must meet when the entry was written around the write path.
 * The denied keys split in two, and collapsing the split would be a WRONG assertion:
 *  - a denied key the host does NOT export must be MISSING ENTIRELY: the row value is then its only
 *    possible source, so presence == leak;
 *  - a denied key the host DOES export (PATH, SHELL, and IFS in this environment) must carry the
 *    HOST-INHERITED value, never the row's inline value. Asserting "missing entirely" for these is
 *    stably red — the inherited key is exactly what AC-001's passthrough baseline requires to be
 *    there. A future reader must not mistake an inherited PATH/SHELL for a leak.
 * "Host-inherited" is deliberately not "byte-equal to process.env": the pty path re-prioritizes the
 * host's own PATH entries (prioritizeUserNpmGlobalBin), so the check is that no entry appears that
 * the host did not already have.
 */
function assertDeniedRowsNeverReachFinalEnv(env: Env, label: string): void {
  const values = Object.values(env);
  for (const key of CLOSED_KEYS) {
    assert.ok(!values.includes(deniedRowValue(key)), `${label}: the inline value of the ${key} row leaked`);
  }
  for (const key of CLOSED_KEYS.filter((key) => !hostExports(key))) {
    assert.ok(!(key in env), `${label}: ${key} is not exported by the host, so it must be missing entirely`);
  }
  for (const key of CLOSED_KEYS.filter(hostExports)) {
    assert.ok(env[key], `${label}: ${key} must keep the host-inherited value`);
    assert.notEqual(env[key], deniedRowValue(key), `${label}: ${key} must not take the row's value`);
    const hostEntries = new Set(String(process.env[key]).split(path.delimiter));
    for (const entry of String(env[key]).split(path.delimiter)) {
      assert.ok(hostEntries.has(entry), `${label}: ${key} gained a non-host entry '${entry}'`);
    }
  }
  assert.equal(env.ANTHROPIC_BASE_URL, ALLOWED_ROW.value, `${label}: the allowed row in the same entry still reaches the final env`);
}

async function withFixture(run: () => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'model-spawn-env-'));
  const previousDb = process.env.DATABASE_PATH;
  const saved = process.env;
  closeConnection();
  process.env.DATABASE_PATH = path.join(dir, 'auth.db');
  try {
    await initializeDatabase();
    providerModelsDb.createCustomProviderModel('claude', { id: 'fjdac', model: 'fjdac', config: { env: FJDAC_ROWS } });
    // The host env carries the credential the unset row must strip.
    process.env.ANTHROPIC_API_KEY = 'sk-host-inherited';
    await run();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    process.env = saved;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    await rm(dir, { recursive: true, force: true });
  }
}

test('SDK path: sdkOptions.env for a persisted model matches the fjdac reference and drops the unset key', async () => {
  await withFixture(() => {
    assertFjdacEnv(mapCliOptionsToSDK({ model: 'fjdac' }).env as Env, 'sdk');
    // Same set of keys as host env + fjdac rows + the app-added bg ceiling, minus the unset key.
    const keys = Object.keys(mapCliOptionsToSDK({ model: 'fjdac' }).env as Env);
    const expected = new Set([...Object.keys(process.env).filter((k) => k !== 'ANTHROPIC_API_KEY'), ...FJDAC_KEYS, 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']);
    assert.deepStrictEqual(new Set(keys), expected);
  });
});

test('pty path: spawned env for a persisted model matches the fjdac reference and drops the unset key', async () => {
  await withFixture(() => {
    assertFjdacEnv(capturePtyEnv('fjdac'), 'pty');
  });
});

test('built-in model keeps the inherited env untouched on both paths', async () => {
  await withFixture(() => {
    assert.equal((mapCliOptionsToSDK({ model: 'opus' }).env as Env).ANTHROPIC_API_KEY, 'sk-host-inherited');
    assert.equal(capturePtyEnv('opus').ANTHROPIC_API_KEY, 'sk-host-inherited');
  });
});

test('fake variant: a compile that omits the unset removal is caught by the contract', async () => {
  await withFixture(() => {
    const real = resolveModelLaunchSpec('claude', 'fjdac');
    const noRemoval = { ...process.env, ...real.env } as Env; // spec without applying unsetEnv
    assert.throws(() => assertFjdacEnv(noRemoval, 'fake'));
  });
});

test('envref missing surfaces a warning through the compile entry used by both paths', async () => {
  await withFixture(() => {
    delete process.env.MODEL_SPAWN_ENV_MISSING;
    providerModelsDb.createCustomProviderModel('claude', {
      id: 'ref', model: 'ref', config: { env: [{ key: 'ANTHROPIC_AUTH_TOKEN', kind: 'envref', value: 'MODEL_SPAWN_ENV_MISSING' }] },
    });
    const spec = resolveModelLaunchSpec('claude', 'ref');
    assert.equal(spec.warnings.length, 1);
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in (mapCliOptionsToSDK({ model: 'ref' }).env as Env)), 'no silent fallback to an inherited value');
  });
});

test('denied rows written straight to the library never reach either final env, and the compile names every one of them', async () => {
  await withFixture(() => {
    providerModelsDb.createCustomProviderModel('claude', {
      id: DENIED_MODEL, model: DENIED_MODEL, config: { env: [...DENIED_ROWS, ALLOWED_ROW] },
    });
    const spec = resolveModelLaunchSpec('claude', DENIED_MODEL);
    for (const key of CLOSED_KEYS) {
      assert.ok(!(key in spec.env), `compile: denied row ${key} must not compile`);
      assert.ok(spec.warnings.some((warning) => warning.includes(key)), `compile: a warning must name ${key}`);
    }
    assert.equal(spec.warnings.length, CLOSED_KEYS.length, 'compile: one warning per dropped row');
    assertDeniedRowsNeverReachFinalEnv(mapCliOptionsToSDK({ model: DENIED_MODEL }).env as Env, 'sdk');
    assertDeniedRowsNeverReachFinalEnv(capturePtyEnv(DENIED_MODEL), 'pty');
  });
});

test('fake variant: under a lax LaunchSpecGuards the final-env contract above goes red, so the seam is load-bearing', async () => {
  await withFixture(() => {
    providerModelsDb.createCustomProviderModel('claude', {
      id: DENIED_MODEL, model: DENIED_MODEL, config: { env: [...DENIED_ROWS, ALLOWED_ROW] },
    });
    const laxSpec = resolveModelLaunchSpec('claude', DENIED_MODEL, LAX_GUARD);
    // The lax filter is exactly what the production guard stands in for: every denied row lands.
    for (const key of CLOSED_KEYS) {
      assert.equal(laxSpec.env[key], deniedRowValue(key), `lax: ${key} lands when the filter is open`);
    }
    assert.equal(laxSpec.warnings.length, 0, 'lax: nothing is dropped, so nothing is warned about');
    // Composed into a final env by the same helper both production paths use, it violates the contract.
    const laxFinalEnv = applyLaunchSpecEnv({ ...process.env }, laxSpec) as Env;
    assert.equal(laxFinalEnv.LD_PRELOAD, deniedRowValue('LD_PRELOAD'), 'lax: the leak is real, not assumed');
    assert.throws(() => assertDeniedRowsNeverReachFinalEnv(laxFinalEnv, 'lax'), /leaked/);
  });
});
