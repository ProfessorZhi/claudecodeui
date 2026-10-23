/**
 * AC-001 golden baseline — "an existing install upgrades with zero behaviour change".
 *
 * This file IS the fixture the AC-001 criterion (goal GOAL-001) points at. With no configured
 * model selected, the compiled launch spec and both spawn-env assemblies must stay byte-identical
 * to the pre-change baselines frozen below. It is driven through the live entry point
 * `resolveModelLaunchSpec`, so any drift in the spec shape or in either env assembly surfaces
 * here first — the fourth case below is the falsifier (an added, missing or changed key goes red).
 *
 * Provenance: first landed as `server/modules/launch-profiles/tests/passthrough-parity.test.ts`
 * (commit 380922af), then ported verbatim by commit b34a662e
 * (`refactor(launch-profiles): 拆除旧实体，AC-001 黄金基准移植到新入口`) when the launch-profiles
 * entity was torn down under GOAL-001 — the file moved, not its assertions.
 *
 * Porting this file again to a new entry point is allowed. Deleting it, dropping a case, or
 * loosening an expectation is not: the four cases below are the golden baseline's entire surface.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { mapCliOptionsToSDK, resolveModelLaunchSpec } from '@/modules/providers/index.js';
import { handleShellConnection } from '@/modules/websocket/index.js';

type Env = Record<string, string | undefined>;

const FIXTURE_ENV: Record<string, string> = {
  PATH: ['/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
  HOME: '/home/fixture',
  ANTHROPIC_BASE_URL: 'https://example.invalid',
  CONTEXT_WINDOW: '200000',
  TERM: 'dumb',
};

async function withFixtureEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { ...FIXTURE_ENV } as NodeJS.ProcessEnv;
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

/** Pre-change SDK env assembly, frozen as a literal baseline. */
function baselineSdkEnv(bgCeiling: string): Env {
  return { ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: bgCeiling };
}

/** Pre-change pty env assembly, frozen as a literal baseline (PATH unchanged: no npm prefix in fixture). */
function baselinePtyEnv(pathKey: string, pathValue: string | undefined): Env {
  return {
    ...process.env,
    [pathKey]: pathValue,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
  };
}

function assertEnvParity(actual: Env, expected: Env): void {
  assert.deepStrictEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) {
    assert.strictEqual(actual[key], expected[key], `env key ${key}`);
  }
  assert.deepStrictEqual(actual, expected);
}

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; send: (d: string) => void };
  socket.readyState = WebSocket.OPEN;
  socket.send = () => undefined;
  return socket;
}

function createFakePty() {
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  return {
    emitExit: () => exitListener?.({ exitCode: 0 }),
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => undefined };
    },
    write() {},
    resize() {},
    kill() {},
  };
}

test('passthrough model spec has empty env/argv, env-derived context window and no warnings', async () => {
  await withFixtureEnv(() => {
    assert.deepStrictEqual(resolveModelLaunchSpec('claude', null), {
      env: {},
      unsetEnv: [],
      argv: [],
      contextWindow: 200000,
      warnings: [],
    });
  });
});

test('SDK path: env with no configured model equals the pre-change assembly', async () => {
  await withFixtureEnv(() => {
    const sdkOptions = mapCliOptionsToSDK({});
    const bg = (sdkOptions.env as Env).CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS as string;
    assert.ok(bg);
    assertEnvParity(sdkOptions.env, baselineSdkEnv(bg));
  });
});

test('pty path: env with no configured model equals the pre-change assembly', async () => {
  await withFixtureEnv(() => {
    let captured: Env | null = null;
    const fakePty = createFakePty();
    const dependencies = {
      resolveProviderSessionId: () => null,
      spawnPty: ((_shell: string, _args: string[], opts: { env: Env }) => {
        captured = opts.env;
        return fakePty;
      }) as never,
    };
    const socket = createFakeSocket();
    handleShellConnection(socket as never, dependencies);
    socket.emit(
      'message',
      JSON.stringify({
        type: 'init',
        projectPath: process.cwd(),
        sessionId: `parity-${Date.now()}`,
        hasSession: false,
        provider: 'plain-shell',
        isPlainShell: true,
        initialCommand: 'true',
      }),
    );
    assert.ok(captured, 'spawnPty was called');
    assertEnvParity(captured, baselinePtyEnv('PATH', FIXTURE_ENV.PATH));
    fakePty.emitExit();
  });
});

test('parity comparison goes red on an added, missing or changed key', () => {
  const base: Env = { A: '1', B: '2' };
  const added = { ...base, C: '3' };
  const { B: _removed, ...missing } = base;
  const changed = { ...base, B: 'x' };
  for (const mutated of [added, missing, changed]) {
    assert.notDeepStrictEqual(mutated, base);
    assert.throws(() => assertEnvParity(mutated, base));
  }
  // Same probe against a real spec.env mutation.
  const spec = resolveModelLaunchSpec('claude', null);
  assert.throws(() => assertEnvParity({ ...base, ...{ ...spec.env, EXTRA: '1' } }, base));
});
