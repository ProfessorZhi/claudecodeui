import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CLAUDE_SESSION_MEMORY_MAX,
  buildClaudeSessionScopeUnitName,
  createClaudeSessionScopeSpawn,
  listClaudeSessionScopeUnits,
  mapCliOptionsToSDK,
  parseClaudeSessionScopeOwnerPid,
  probeSystemdUserScope,
  resetClaudeSessionScopeProbeCache,
  resolveClaudeSessionMemoryMax,
  resolveResidentScopeSweepEnabled,
  stopClaudeSessionScopes,
  sweepOrphanClaudeSessionScopes,
} from '@/modules/providers/index.js';
import type { SessionScopeProcess } from '@/modules/providers/index.js';

// These cases are about the cgroup a session lands in, which is only observable by really
// creating scopes. The two cases that need a systemd user manager assert the probe is true
// first instead of skipping: a silent skip on this host would leave the whole confinement story
// unverified while the file still exited 0.

/**
 * The two cases that drive a real memory hog into its cap each leave an `oom-kill` record in the
 * user journal, indistinguishable from a real session being killed. They run only on request:
 * `RUN_OOM_CAP_TESTS=1`.
 */
const OOM_CAP_SKIP = process.env.RUN_OOM_CAP_TESTS === '1'
  ? false
  : 'produces oom-kill journal records; set RUN_OOM_CAP_TESTS=1 to run';

/**
 * The sweep case stops every scope on the host whose owner pid is gone, not only the ones it
 * created, and asserts the swept set is exactly its own fixtures — so it can stop a crashed
 * server's leftovers and fails when any exist. It runs only on request: `RUN_HOST_WIDE_SWEEP_TESTS=1`.
 */
const HOST_WIDE_SWEEP_SKIP = process.env.RUN_HOST_WIDE_SWEEP_TESTS === '1'
  ? false
  : 'sweeps every orphan scope on the host; set RUN_HOST_WIDE_SWEEP_TESTS=1 to run';

/** Cap the isolation case runs under. Small enough that a hog reaches it in well under a second. */
const ISOLATION_CAP = '64M';
/**
 * Cap the attribution case runs under, deliberately different from {@link ISOLATION_CAP}: the
 * isolation case leaves a fire-and-forget journal lookup behind, and a shared cap value would let
 * that late line satisfy this case's assertion.
 */
const ATTRIBUTION_CAP = '80M';
/** Cap for the passthrough case, which must not be killed before it is aborted. */
const PASSTHROUGH_CAP = '256M';

/** Grows until the scope's cap reaps it. Buffers are external memory, so V8's own heap limit is not involved. */
const MEMORY_HOG_SOURCE = 'const held=[];for(;;){held.push(Buffer.alloc(8*1024*1024));}';

/** Sleeps without pulling in timers/promises for one call. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Resolves with a process's exit status, or rejects if it never exits. */
function exitOf(proc: SessionScopeProcess): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve([code, signal]));
  });
}

/** Polls until `predicate` holds, so a slow scope start is not a flake. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${describe()}`);
}

/**
 * The unit names from {@link listClaudeSessionScopeUnits} that belong to this file.
 *
 * The product function answers the operator's question — every `claudecodeui-session-*` unit on
 * this host — and that is deliberately the right answer for stop and sweep, whose whole job is to
 * find *other* servers' orphans. It is the wrong answer for an assertion: a real server on this
 * machine (a dev `:3001`, a concurrent lane, a DoD harness) keeps its own live sessions in the same
 * list, so comparing that list against a fixed count is a claim about the host, not about this
 * file, and it goes red whenever anything else on the machine is holding a session — the normal
 * state here.
 *
 * So every read below goes through this filter, and a unit counts as ours two ways, because this
 * file fixtures both kinds:
 *  - hook-created scopes are named `claudecodeui-session-<owner>-<suffix>` with *our* pid, so the
 *    prefix {@link buildClaudeSessionScopeUnitName} of `process.pid` selects them;
 *  - `startScope` fixtures are named by hand, and the orphan ones carry a deliberately dead owner
 *    pid, so the caller passes the names it started via `startedHere`.
 * A unit matching neither is somebody else's and stays invisible. A *missing* or *extra* unit of
 * ours still fails, which is what keeps these criteria sharp.
 */
const ownScopes = (startedHere: readonly string[] = []): string[] => {
  const ownPrefix = buildClaudeSessionScopeUnitName(process.pid, '');
  return listClaudeSessionScopeUnits().filter(
    (unit) => unit.startsWith(ownPrefix) || startedHere.includes(unit),
  );
};

/** Real scopes started directly by the lifecycle case, so every one of them can be reaped. */
const startedScopeChildren: Array<ChildProcess> = [];

/**
 * Starts a session scope the way the hook does — a transient user scope whose unit name encodes
 * its owner — but running `sleep`, which keeps the scope alive without a CLI in the loop.
 */
function startScope(unitName: string): string {
  const child = spawn('systemd-run', [
    '--user', '--scope', '--quiet',
    `--unit=${unitName}`,
    '--', 'sleep', '120',
  ], { stdio: 'ignore' });
  startedScopeChildren.push(child);
  return `${unitName}.scope`;
}

/** Kills every scope process this file started, so a failing case cannot leak scopes onto the host. */
async function reapStartedScopes(): Promise<void> {
  const exits = startedScopeChildren.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  }));
  for (const child of startedScopeChildren) {
    child.kill('SIGKILL');
  }
  await Promise.all(exits);
  startedScopeChildren.length = 0;
}

/**
 * A PID that is provably gone: a child that has been reaped. Reused PIDs would make the orphan
 * fixture non-orphan, so the liveness check is part of obtaining it.
 */
function reapOneProcess(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(result.status, 0, 'the sacrificial process must exit cleanly');
    const pid = result.pid;
    if (typeof pid !== 'number') {
      continue;
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      return pid;
    }
  }
  throw new Error('could not obtain a provably dead PID');
}

/** A `systemd-run` that always fails, so the probe has to conclude the host cannot scope. */
function fakeFailingSystemdRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-scope-path-'));
  const binary = path.join(dir, 'systemd-run');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return dir;
}

test.after(async () => {
  await reapStartedScopes();
  stopClaudeSessionScopes();
});

test('the default cap is the documented one, and `off` disables scoping', () => {
  assert.equal(resolveClaudeSessionMemoryMax({}), DEFAULT_CLAUDE_SESSION_MEMORY_MAX);
  assert.equal(resolveClaudeSessionMemoryMax({ CLAUDE_SESSION_MEMORY_MAX: '2G' }), '2G');
  assert.equal(resolveClaudeSessionMemoryMax({ CLAUDE_SESSION_MEMORY_MAX: 'off' }), null);
  assert.equal(resolveClaudeSessionMemoryMax({ CLAUDE_SESSION_MEMORY_MAX: '0' }), null);

  // The unit name is the only place an owner is recorded, so building and parsing it is one
  // contract: sweep depends on reading back exactly what the hook wrote.
  const unitName = buildClaudeSessionScopeUnitName(4242, 'a1b2');
  assert.equal(unitName, 'claudecodeui-session-4242-a1b2');
  assert.equal(parseClaudeSessionScopeOwnerPid(`${unitName}.scope`), 4242);
  assert.equal(parseClaudeSessionScopeOwnerPid('some-other.scope'), null);
});

test('the hook generates a capped scope argv and passes cwd, env and signal through', () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const hook = createClaudeSessionScopeSpawn({
    memoryMax: ISOLATION_CAP,
    ownerPid: process.pid,
    probe: () => true,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options: options as Record<string, unknown> });
      return {
        stdin: process.stdin as unknown as SessionScopeProcess['stdin'],
        stdout: process.stdout as unknown as SessionScopeProcess['stdout'],
        killed: false,
        exitCode: null,
        kill: () => true,
        on: () => undefined,
        once: () => undefined,
        off: () => undefined,
      } as SessionScopeProcess;
    },
  });
  assert.ok(hook, 'a passing probe must still produce the hook');

  const controller = new AbortController();
  hook({
    command: '/opt/claude/bin/claude',
    args: ['--print', 'hello world'],
    cwd: '/tmp/session-cwd',
    env: { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://example.invalid' },
    signal: controller.signal,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'systemd-run');
  // Joined so the assertions read as the command line the operator would see, which is what the
  // criterion names: `-p MemoryMax=` as one token pair, not two loose arguments.
  const commandLine = calls[0].args.join(' ');
  assert.ok(commandLine.includes('--scope'));
  assert.ok(commandLine.includes(`-p MemoryMax=${ISOLATION_CAP}`));
  assert.ok(commandLine.includes('-p MemorySwapMax=0'));
  assert.match(commandLine, /--unit=claudecodeui-session-\d+-[0-9a-f]{8}\b/);
  // The wrapped command keeps its own argv, after the `--` that stops systemd parsing options.
  const separator = calls[0].args.indexOf('--');
  assert.ok(separator > 0);
  assert.deepEqual(calls[0].args.slice(separator + 1), ['/opt/claude/bin/claude', '--print', 'hello world']);

  assert.equal(calls[0].options.cwd, '/tmp/session-cwd');
  assert.deepEqual(calls[0].options.env, { PATH: '/usr/bin', ANTHROPIC_BASE_URL: 'http://example.invalid' });
  assert.equal(calls[0].options.signal, controller.signal);
});

test('a host whose systemd-run fails falls back to the SDK spawn path', () => {
  const fakeDir = fakeFailingSystemdRunDir();
  const savedPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${savedPath ?? ''}`;

  try {
    // The probe has to be re-run under the failing PATH, not answered from a cache.
    resetClaudeSessionScopeProbeCache();
    assert.equal(probeSystemdUserScope(DEFAULT_CLAUDE_SESSION_MEMORY_MAX), false);
    assert.equal(createClaudeSessionScopeSpawn(), undefined);

    resetClaudeSessionScopeProbeCache();
    const sdkOptions = mapCliOptionsToSDK({});
    assert.ok(
      !Object.hasOwn(sdkOptions, 'spawnClaudeCodeProcess'),
      'the SDK must spawn the CLI itself when this host cannot scope',
    );
  } finally {
    process.env.PATH = savedPath;
    resetClaudeSessionScopeProbeCache();
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
});

test('CLAUDE_SESSION_MEMORY_MAX=off leaves the SDK spawn path untouched too', () => {
  const savedCap = process.env.CLAUDE_SESSION_MEMORY_MAX;
  process.env.CLAUDE_SESSION_MEMORY_MAX = 'off';

  try {
    resetClaudeSessionScopeProbeCache();
    assert.equal(createClaudeSessionScopeSpawn(), undefined);
    const sdkOptions = mapCliOptionsToSDK({});
    assert.ok(!Object.hasOwn(sdkOptions, 'spawnClaudeCodeProcess'));
  } finally {
    if (savedCap === undefined) {
      delete process.env.CLAUDE_SESSION_MEMORY_MAX;
    } else {
      process.env.CLAUDE_SESSION_MEMORY_MAX = savedCap;
    }
    resetClaudeSessionScopeProbeCache();
  }
});

test('on a host that can scope, the default options carry the hook', () => {
  // The positive control for the two degradation cases above: without it, an assertion that the
  // key is absent would also pass if the wiring were missing outright.
  resetClaudeSessionScopeProbeCache();
  assert.equal(
    probeSystemdUserScope(DEFAULT_CLAUDE_SESSION_MEMORY_MAX),
    true,
    'this host must have a usable systemd user manager for the scope cases to mean anything',
  );
  resetClaudeSessionScopeProbeCache();

  const sdkOptions = mapCliOptionsToSDK({});
  assert.ok(Object.hasOwn(sdkOptions, 'spawnClaudeCodeProcess'));
  assert.equal(typeof sdkOptions.spawnClaudeCodeProcess, 'function');
});

test('a session over its cap dies alone; a live sibling is untouched', { skip: OOM_CAP_SKIP }, async () => {
  assert.equal(
    probeSystemdUserScope(ISOLATION_CAP),
    true,
    'this host must have a usable systemd user manager for the isolation case to mean anything',
  );

  const hook = createClaudeSessionScopeSpawn({
    memoryMax: ISOLATION_CAP,
    ownerPid: process.pid,
    probe: () => true,
  });
  assert.ok(hook);

  const spawnOne = (source: string) => hook({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
  });

  const hog = spawnOne(MEMORY_HOG_SOURCE);
  const sibling = spawnOne('setInterval(()=>{},1000)');

  try {
    const [code, signal] = await exitOf(hog);
    assert.ok(
      code !== 0 || signal !== null,
      `the capped session must have been killed, saw code=${code} signal=${signal}`,
    );

    // The sibling ran under the same cap in its own scope: an OOM confined to one scope must not
    // reach it, which is the whole point of not sharing the server's cgroup.
    assert.equal(sibling.exitCode, null, 'the sibling session must still be running');
    assert.equal(sibling.killed, false);
    await waitUntil(
      // This process's scopes only: a real server on this host keeps its own live sessions in the
      // same global list, so the count has to be attributed before it means anything.
      () => ownScopes().length === 1,
      // The doomed scope is reaped when its last process dies; the sibling's outlives it.
      10_000,
      () => `one surviving session scope, saw ${JSON.stringify(ownScopes())}`,
    );
  } finally {
    sibling.kill('SIGKILL');
    await exitOf(sibling);
    stopClaudeSessionScopes();
  }
});

test('the hook passes cwd, env and the abort signal to the real scope', async () => {
  assert.equal(
    probeSystemdUserScope(PASSTHROUGH_CAP),
    true,
    'this host must have a usable systemd user manager for the passthrough case to mean anything',
  );

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-scope-cwd-'));
  const marker = `scope-marker-${process.pid}-${Date.now()}`;
  const hook = createClaudeSessionScopeSpawn({
    memoryMax: PASSTHROUGH_CAP,
    ownerPid: process.pid,
    probe: () => true,
  });
  assert.ok(hook);

  const controller = new AbortController();
  // Prints what it received, then stays up so the abort is what ends it.
  const proc = hook({
    command: process.execPath,
    args: ['-e', 'console.log(process.cwd());console.log(process.env.CLAUDE_SESSION_SCOPE_PROBE);setInterval(()=>{},1000);'],
    cwd,
    env: { ...process.env, CLAUDE_SESSION_SCOPE_PROBE: marker },
    signal: controller.signal,
  });

  // Node's abort path emits an `AbortError` on the child; the SDK's own transport installs a
  // listener for it, and this case stands in for that so the emit is not an uncaught throw.
  proc.on('error', () => {});

  let output = '';
  proc.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });

  try {
    await waitUntil(
      () => output.includes(marker) && output.includes(cwd),
      15_000,
      () => `the scoped child to report its cwd and env, saw ${JSON.stringify(output)}`,
    );

    controller.abort();
    const [code, signal] = await exitOf(proc);
    assert.ok(
      code !== 0 || signal !== null,
      `an aborted session must exit, saw code=${code} signal=${signal}`,
    );
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exitOf(proc);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    stopClaudeSessionScopes();
  }
});

test('stopping this server\'s scopes leaves none', async () => {
  assert.equal(probeSystemdUserScope(DEFAULT_CLAUDE_SESSION_MEMORY_MAX), true);

  try {
    const owned = ['one', 'two', 'three'].map((suffix) =>
      startScope(buildClaudeSessionScopeUnitName(process.pid, suffix)));
    await waitUntil(
      () => owned.every((unit) => ownScopes(owned).includes(unit)),
      15_000,
      () => `three session scopes, saw ${JSON.stringify(ownScopes(owned))}`,
    );

    const stopped = stopClaudeSessionScopes();
    assert.deepEqual([...stopped].sort(), [...owned].sort());
    assert.deepEqual(
      ownScopes(owned),
      [],
      'the stop function must leave none of this server\'s scopes on the host',
    );
  } finally {
    stopClaudeSessionScopes();
    await reapStartedScopes();
  }
});

test('sweep takes only orphans', { skip: HOST_WIDE_SWEEP_SKIP }, async () => {
  assert.equal(probeSystemdUserScope(DEFAULT_CLAUDE_SESSION_MEMORY_MAX), true);

  // Anything left by an earlier crashed run has a dead owner, so this is also the state the
  // server's own start-up sweep would leave behind.
  sweepOrphanClaudeSessionScopes();

  try {
    // Two scopes whose owning server is gone, and one whose owner (this process) is not.
    const deadOwnerPid = reapOneProcess();
    const orphans = ['orphan-one', 'orphan-two'].map((suffix) =>
      startScope(buildClaudeSessionScopeUnitName(deadOwnerPid, suffix)));
    const survivor = startScope(buildClaudeSessionScopeUnitName(process.pid, 'survivor'));
    // The two orphans answer to a dead owner pid, so they cannot be attributed by this process's
    // prefix; the case names them instead. A foreign scope in neither arm stays out of the count.
    const fixtures = [...orphans, survivor];
    await waitUntil(
      () => ownScopes(fixtures).length === 3,
      15_000,
      () => `three scopes before the sweep, saw ${JSON.stringify(ownScopes(fixtures))}`,
    );

    const swept = sweepOrphanClaudeSessionScopes();
    assert.deepEqual([...swept].sort(), [...orphans].sort());
    assert.deepEqual(
      ownScopes([survivor]),
      [survivor],
      'a live server\'s session must survive the sweep',
    );
  } finally {
    stopClaudeSessionScopes();
    await reapStartedScopes();
  }
});

test('the start-up sweep is on unless CLAUDE_SESSION_SCOPE_SWEEP turns it off', () => {
  assert.equal(resolveResidentScopeSweepEnabled({}), true);
  assert.equal(resolveResidentScopeSweepEnabled({ CLAUDE_SESSION_SCOPE_SWEEP: '' }), true);
  assert.equal(resolveResidentScopeSweepEnabled({ CLAUDE_SESSION_SCOPE_SWEEP: 'on' }), true);
  assert.equal(resolveResidentScopeSweepEnabled({ CLAUDE_SESSION_SCOPE_SWEEP: 'off' }), false);
  assert.equal(resolveResidentScopeSweepEnabled({ CLAUDE_SESSION_SCOPE_SWEEP: ' OFF ' }), false);
  assert.equal(resolveResidentScopeSweepEnabled({ CLAUDE_SESSION_SCOPE_SWEEP: '0' }), false);
});

test('a cap kill names the cap; a non-OOM failure does not', { skip: OOM_CAP_SKIP }, async () => {
  assert.equal(probeSystemdUserScope(ATTRIBUTION_CAP), true);

  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };

  const hook = createClaudeSessionScopeSpawn({
    memoryMax: ATTRIBUTION_CAP,
    ownerPid: process.pid,
    probe: () => true,
  });
  assert.ok(hook);

  const run = (source: string) => hook({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
  });

  try {
    const hog = run(MEMORY_HOG_SOURCE);
    const [hogCode, hogSignal] = await exitOf(hog);
    assert.ok(hogCode !== 0 || hogSignal !== null);

    const capLine = () =>
      logged.filter((line) => line.includes('memory cap') && line.includes(ATTRIBUTION_CAP));
    await waitUntil(
      () => capLine().some((line) => line.includes(ATTRIBUTION_CAP)),
      15_000,
      () => `a log line naming the cap ${ATTRIBUTION_CAP}, saw ${JSON.stringify(logged)}`,
    );
    assert.equal(capLine().length, 1);

    // A failure that is not a cap kill must stay silent: this one exits non-zero, so the exit
    // path does look the journal up and has to come back empty-handed.
    const failed = run('process.exit(1)');
    const [failCode] = await exitOf(failed);
    assert.equal(failCode, 1);
    await sleep(1_500);
    assert.deepEqual(capLine().length, 1, `an ordinary failure must not blame the cap, saw ${JSON.stringify(logged)}`);
  } finally {
    console.error = originalConsoleError;
    stopClaudeSessionScopes();
  }
});
