/**
 * Criterion for resident process containment under a memory cap (AC-167).
 *
 * A resident process that outgrows its cap must die *alone*: the shared resident
 * slice exists so the kernel's choice of victim is confined to the residents,
 * and the manager's host record must carry the kernel fact (`exited`/`oom`)
 * rather than an operator log line. This file drives the real machine for that —
 * real `systemd-run --user --scope` scopes inside `cloudcli-resident.slice`, real
 * memory-eating children, the real session-host manager — and reads four things:
 *
 *   (1) the wrapper's command line and the systemd units it really created carry
 *       the *injected* caps: `-p MemoryMax=<configured>`, `-p MemorySwapMax=0`,
 *       `--slice=cloudcli-resident.slice` verbatim, and a slice cap that systemd
 *       holds and that tracks the configured value.
 *   (2) a child that allocates past the per-session cap is reaped by the kernel,
 *       and the host the manager tracks for it reads `closeReason: 'exited'` with
 *       `closeDetail: 'oom'` — derived from the journal, never from the exit code,
 *       which is why a third child that merely exits non-zero is asserted to be
 *       `error` rather than `oom`.
 *   (3) the sibling child under the same slice, and this test process, are still
 *       alive after that kill.
 *   (4) the scope listing is empty once the scopes are stopped, with a *positive
 *       control*: the same read is required to name each scope while it is up, so
 *       "empty after" cannot be satisfied by a reading that never sees anything.
 *
 * Unevaluated, not green. A host without a usable systemd user manager cannot
 * answer any of the above, so the criterion prints why and exits 3 before
 * registering a single case. This host probes true, so every case below really
 * runs — a skip here would leave the containment story unverified while the file
 * still exited 0.
 *
 * The memory source is deliberately *bounded* (384 MiB, then idle). Two reasons,
 * both load-bearing: against a 96M cap it dies at the cap, and under the
 * falsification variant where the wrapper degrades to a direct `spawn` it stops
 * on its own instead of eating the host — the variant has to red on the readings,
 * not on the machine. It also has to *touch* every page (`b.fill(7)`): a large
 * `Buffer.alloc` is `calloc`ed and left unmapped, so an untouched hog never
 * charges the cgroup and no cap ever fires — measured here, not assumed.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess, SpawnOptions as NodeSpawnOptions } from 'node:child_process';
import test from 'node:test';

import {
  DEFAULT_RESIDENT_SLICE_MEMORY_MAX,
  DEFAULT_RESIDENT_SLICE_NAME,
  applyResidentSliceMemoryMax,
  buildResidentScopeUnitName,
  createResidentScopeSpawn,
  detectResidentScopeOomKill,
  listResidentScopeUnits,
  probeSystemdUserScope,
  readResidentSliceMemoryMax,
  resolveResidentSliceMemoryMax,
  resolveResidentSliceName,
  stopResidentScopes,
} from '@/modules/providers/index.js';
import type { ResidentScopeProcess } from '@/modules/providers/index.js';
import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderHostDriver, IProviderHostDriverSink } from '@/shared/interfaces.js';

/**
 * Per-session cap this file injects. Small enough that a touched hog reaches it
 * in well under a second, large enough that node itself starts inside it.
 */
const PROCESS_CAP = '96M';
/** Slice cap this file injects first. */
const SLICE_CAP = '512M';
/** A second injected value, so "the reading tracks the configuration" is a statement about two */
/** readings rather than about one constant that happens to match. */
const SLICE_CAP_REVISED = '768M';
/** Steps and size of {@link MEMORY_HOG_SOURCE}: 48 x 8 MiB. */
const HOG_STEP_BYTES = 8 * 1024 * 1024;
const HOG_STEPS = 48;

/** Sleeps without pulling in `timers/promises` for one call. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A bounded hog: allocate and *touch* 384 MiB, then idle.
 *
 * `b.fill(7)` is the load-bearing half — see the file header. The loop is bounded
 * so the falsification variant that removes the cap cannot take the host down.
 */
const MEMORY_HOG_SOURCE = 'const h=[];'
  + `for(let i=0;i<${HOG_STEPS};i++){const b=Buffer.alloc(${HOG_STEP_BYTES});b.fill(7);h.push(b);}`
  + 'setInterval(()=>{},1000);';
/** A sibling that does nothing but stay up, so "it survived" is a reading about it. */
const IDLE_SOURCE = 'setInterval(()=>{},1000)';
/** A child that fails on its own, so the OOM attribution has a negative it must not blame. */
const CLEAN_FAILURE_SOURCE = 'process.exit(3)';

/**
 * The slice name the criterion names verbatim: the AC's literal, which is also the default the
 * configuration resolves to.
 *
 * Taken from the constant rather than from the ambient environment on purpose. What this file
 * judges is the *wrapper*, and it judges it by injecting both caps; reading the ambient config
 * into the injected value would make the criterion's own reading depend on the environment it is
 * being run in, so the same file would take a different reading per host. The resolver itself is
 * read separately, with explicit environment objects, in the first case below.
 */
const SLICE_NAME: string = DEFAULT_RESIDENT_SLICE_NAME;

/**
 * Off unless `RUN_OOM_CAP_TESTS=1`. This file drives real hogs into their cap (an `oom-kill`
 * journal record per run, indistinguishable from a real session being killed) and rewrites the
 * memory cap of the shared resident slice while it runs, so it must not run by default.
 * Exits before the probe below so that nothing is created or touched.
 */
if (process.env.RUN_OOM_CAP_TESTS !== '1') {
  console.error('[process-containment] disabled: set RUN_OOM_CAP_TESTS=1 to run (oom-kill journal noise, touches the shared slice)');
  process.exit(0);
}

/**
 * The availability probe, and the exit-3 gate it guards.
 *
 * Asked of a real capped run inside the slice, not of `systemctl is-system-running`:
 * the question is whether the wrapper this criterion drives can run at all, and
 * only a real scope answers it. The slice is created by this probe, which is why
 * the pre-existing cap is read *after* it — reading first would see no slice and
 * leave an injected cap behind after the restore below had nothing to restore.
 */
if (!probeSystemdUserScope(PROCESS_CAP, SLICE_NAME)) {
  console.error(
    `[process-containment] no usable systemd user manager: `
    + `'systemd-run --user --scope --slice=${SLICE_NAME} -p MemoryMax=${PROCESS_CAP} true' `
    + 'did not exit 0, so resident containment is unevaluated here (exit 3)',
  );
  process.exit(3);
}

/** The slice cap this host had before the criterion touched it, restored at the end. */
const sliceCapBefore = readResidentSliceMemoryMax(SLICE_NAME);

/** Every child this file spawned, so a failing case cannot leak a process or a scope. */
const startedChildren: ChildProcess[] = [];

/** One spawn the hook really performed, as the hook performed it. */
type SpawnRecord = { args: readonly string[]; pid: number | null; child: ChildProcess };

/** Every spawn this file's hooks handed to `child_process.spawn`, in order. */
const spawnRecords: SpawnRecord[] = [];

/** The shape the factory returns, taken from the factory so the two cannot drift. */
type ResidentScopeHook = NonNullable<ReturnType<typeof createResidentScopeSpawn>>;

/**
 * The wrapper under test, with its caps injected and its spawn recorded.
 *
 * The recording spawn is a pass-through, not a double: it calls the real
 * `child_process.spawn` with the argv it was handed and only notes what that argv
 * was. That is what makes the command-line reading (1) a reading of the argv the
 * wrapper actually executed rather than of a literal restated in the test.
 */
function createRecordingHook(overrides: {
  memoryMax?: string;
  sliceMemoryMax?: string | null;
} = {}): ResidentScopeHook | undefined {
  return createResidentScopeSpawn({
    memoryMax: overrides.memoryMax ?? PROCESS_CAP,
    sliceName: SLICE_NAME,
    sliceMemoryMax: overrides.sliceMemoryMax === undefined ? SLICE_CAP : overrides.sliceMemoryMax,
    ownerPid: process.pid,
    probe: () => true,
    spawnImpl: (command, args, options: NodeSpawnOptions) => {
      const child = spawn(command, [...args], options);
      spawnRecords.push({ args: [...args], pid: child.pid ?? null, child });
      startedChildren.push(child);
      return child as unknown as ResidentScopeProcess;
    },
  });
}

/** One scoped child, with the unit name read off the argv it was launched with. */
type ScopedChild = { unitName: string | null; pid: number | null; child: ChildProcess; args: readonly string[] };

/**
 * Spawns one child through the wrapper and reads the unit it landed in off the argv.
 *
 * Synchronous on purpose: the hook reaches the real spawn before it returns, so a
 * record taken after the call belongs to that call and no correlation is guessed.
 *
 * `unitName` is nullable, and deliberately not asserted here. An argv with no
 * `--unit=` means the wrapper never created a scope at all — the falsification
 * variant where it degrades to a direct spawn. Failing on the shape right here
 * would red the file while leaving readings (2) and (3) unevaluated, and those are
 * the readings the variant is *about*: with no scope there is nothing to cap, so
 * the hog is never reaped and no unit is ever listed. Each case below therefore
 * reds on its own reading, by timeout, rather than on a shared shape guard.
 */
function spawnScoped(hook: ResidentScopeHook, source: string): ScopedChild {
  const before = spawnRecords.length;
  const spawned = hook({
    command: process.execPath,
    args: ['-e', source],
    cwd: process.cwd(),
    env: process.env,
    signal: new AbortController().signal,
  });
  assert.equal(spawnRecords.length, before + 1, 'the hook must reach the real spawn synchronously');

  // The record holds the real `ChildProcess`, which is what the exit and kill
  // readings below need; the identity check is what keeps that from being a
  // second, unrelated process.
  const record = spawnRecords[before];
  assert.equal(spawned, record.child, 'the wrapper must return the process it spawned');

  const unitArg = record.args.find((arg) => arg.startsWith('--unit='));

  return {
    unitName: unitArg ? unitArg.slice('--unit='.length) : null,
    pid: record.pid,
    child: record.child,
    args: record.args,
  };
}

/** Reads one property of one scope's unit, as systemd reports it, or null when unreadable. */
function readUnitProperty(unitName: string, property: string): string | null {
  const result = spawnSync(
    'systemctl',
    ['--user', 'show', `${unitName}.scope`, '-p', property, '--value'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return null;
  }
  const value = (result.stdout ?? '').trim();
  return value || null;
}

/**
 * systemd's size syntax as bytes, so an injected `96M` can be compared with the
 * `100663296` systemd answers with. `show` reports values, not spellings.
 */
function systemdSizeToBytes(size: string): number | null {
  const match = /^(\d+)([KMGTP]?)$/.exec(size.trim());
  if (!match) {
    return null;
  }
  const scale: Record<string, number> = {
    '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5,
  };
  return Number.parseInt(match[1], 10) * scale[match[2]];
}

/**
 * The units in {@link listResidentScopeUnits} that belong to this file.
 *
 * The product function answers the operator's question — every resident scope on
 * this host — and that is deliberately the right answer for stop and sweep, whose
 * job is to find *other* servers' orphans. It is the wrong thing for an assertion
 * to compare against a fixed count: a real server on this machine keeps its own
 * live sessions in the same list, so a global emptiness claim would be a claim
 * about the host. Every read below is therefore filtered to this process's own
 * owner prefix — which is the prefix the wrapper encodes for us, so the filter
 * and the wrapper cannot drift.
 */
function ownScopes(): string[] {
  const ownPrefix = buildResidentScopeUnitName(process.pid, '');
  return listResidentScopeUnits().filter((unit) => unit.startsWith(ownPrefix));
}

/** Polls until `predicate` holds, so a slow scope start is not a flake. */
async function waitUntilAsync(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  describe: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(100);
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${describe()}`);
}

/** The synchronous form of {@link waitUntilAsync}, for readings that are already in hand. */
function waitUntil(predicate: () => boolean, timeoutMs: number, describe: () => string): Promise<void> {
  return waitUntilAsync(async () => predicate(), timeoutMs, describe);
}

/** Kills every child this file spawned and waits for it, so no case leaks a process. */
async function reapStartedChildren(): Promise<void> {
  const exits = startedChildren.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  }));
  for (const child of startedChildren) {
    child.kill('SIGKILL');
  }
  await Promise.all(exits);
  startedChildren.length = 0;
}

test.after(async () => {
  await reapStartedChildren();
  stopResidentScopes(process.pid);
  // Put the slice back the way this file found it: an injected cap must not
  // outlive the criterion, because the slice does.
  applyResidentSliceMemoryMax(SLICE_NAME, sliceCapBefore ?? 'infinity');
});

test('the caps and the slice come from configuration, and the wrapper puts them on the real units', async () => {
  // The criterion names the slice verbatim; the configuration is what produces it.
  assert.equal(SLICE_NAME, 'cloudcli-resident.slice');
  assert.equal(resolveResidentSliceName({}), SLICE_NAME);
  assert.equal(
    resolveResidentSliceName({ CLAUDE_RESIDENT_SLICE: 'another-resident.slice' }),
    'another-resident.slice',
  );
  assert.equal(resolveResidentSliceName({ CLAUDE_RESIDENT_SLICE: 'off' }), null);
  assert.equal(resolveResidentSliceMemoryMax({}), DEFAULT_RESIDENT_SLICE_MEMORY_MAX);
  assert.equal(resolveResidentSliceMemoryMax({ CLAUDE_RESIDENT_SLICE_MEMORY_MAX: '1G' }), '1G');
  assert.equal(resolveResidentSliceMemoryMax({ CLAUDE_RESIDENT_SLICE_MEMORY_MAX: 'infinity' }), null);

  // The slice cap is a value systemd holds, and it is the value that was applied
  // — twice, and differently, so the reading is about the configuration rather
  // than about a constant that happens to match.
  assert.ok(applyResidentSliceMemoryMax(SLICE_NAME, SLICE_CAP), 'systemd must accept the slice cap');
  assert.equal(readResidentSliceMemoryMax(SLICE_NAME), String(systemdSizeToBytes(SLICE_CAP)));
  assert.ok(applyResidentSliceMemoryMax(SLICE_NAME, SLICE_CAP_REVISED));
  assert.equal(
    readResidentSliceMemoryMax(SLICE_NAME),
    String(systemdSizeToBytes(SLICE_CAP_REVISED)),
  );

  // Building the wrapper applies the cap it was configured with: the slice is at
  // the revised value above, and the only thing between that reading and this one
  // is the factory.
  const hook = createRecordingHook();
  assert.ok(hook, 'an injected passing probe must still produce the hook');
  assert.equal(
    readResidentSliceMemoryMax(SLICE_NAME),
    String(systemdSizeToBytes(SLICE_CAP)),
    'the wrapper must apply the slice cap it was configured with',
  );

  const scoped = spawnScoped(hook, IDLE_SOURCE);
  // A local const, not `scoped.unitName`: a closure cannot see a narrowing of a
  // property, and the reads below are all inside closures.
  const unitName = scoped.unitName;
  try {
    const commandLine = scoped.args.join(' ');
    assert.ok(
      commandLine.includes(`-p MemoryMax=${PROCESS_CAP}`),
      `the argv must carry the injected per-session cap, saw ${commandLine}`,
    );
    assert.ok(commandLine.includes('-p MemorySwapMax=0'));
    assert.ok(
      commandLine.includes('--slice=cloudcli-resident.slice'),
      `the argv must name the slice verbatim, saw ${commandLine}`,
    );
    assert.match(commandLine, /--unit=claudecodeui-session-\d+-[0-9a-f]{8}\b/);
    assert.ok(unitName, `the argv must name the unit it created, saw ${commandLine}`);

    // The same two caps, read off the unit systemd really created rather than off
    // the argv that asked for it.
    await waitUntil(
      () => readUnitProperty(unitName, 'MemoryMax') === String(systemdSizeToBytes(PROCESS_CAP)),
      15_000,
      () => `unit ${unitName} to hold MemoryMax=${PROCESS_CAP}, saw ${readUnitProperty(unitName, 'MemoryMax')}`,
    );
    assert.equal(readUnitProperty(unitName, 'MemorySwapMax'), '0');
    assert.equal(readUnitProperty(unitName, 'Slice'), SLICE_NAME);
  } finally {
    scoped.child.kill('SIGKILL');
    stopResidentScopes(process.pid);
  }

  await waitUntil(
    () => ownScopes().length === 0,
    15_000,
    () => `this file's scopes to be gone, saw ${JSON.stringify(ownScopes())}`,
  );
});

test('a hog over the cap dies alone, its host reads exited/oom, and its sibling and this process survive', async () => {
  const sources = new Map([
    ['session-hog', MEMORY_HOG_SOURCE],
    ['session-sibling', IDLE_SOURCE],
    ['session-failure', CLEAN_FAILURE_SOURCE],
  ]);

  const manager = createSessionHostManager();
  const sinks = new Map<string, IProviderHostDriverSink>();
  const scopedByHostId = new Map<string, ScopedChild>();
  const hook = createRecordingHook();
  assert.ok(hook, 'an injected passing probe must still produce the hook');

  /**
   * The driver whose process is a real scoped child.
   *
   * It is the seam this criterion is about: the exit path asks the kernel fact
   * (`detectResidentScopeOomKill`, the production read over the unit's journal)
   * and reports it through the sink, so the host record carries `oom` only when
   * the journal says the cap did it. A merely non-zero exit is reported as
   * `error`, which is what makes the third child below a control rather than a
   * second copy of the first.
   */
  const driver: IProviderHostDriver = {
    async startHost(host, sink) {
      sinks.set(host.hostId, sink);
      return host;
    },
    async bind(host, binding) {
      const source = sources.get(binding.appSessionId);
      const sink = sinks.get(host.hostId);
      if (!source || !sink) {
        return;
      }

      const scoped = spawnScoped(hook, source);
      scopedByHostId.set(host.hostId, scoped);
      scoped.child.on('exit', () => {
        void (async () => {
          const oom = scoped.unitName !== null && await detectResidentScopeOomKill(scoped.unitName);
          sink.exited({ hostId: host.hostId, detail: oom ? 'oom' : 'error' });
        })();
      });
    },
    async submit() {
      // A host here is one scoped child; a turn is not part of this criterion.
    },
    async interrupt() {
      return false;
    },
    async reconfigure() {
      return 'next-turn';
    },
    async unbind() {
      // Detach is not part of this criterion; the close below is what ends a child.
    },
    async closeHost(host) {
      scopedByHostId.get(host.hostId)?.child.kill('SIGKILL');
    },
  };

  const open = (appSessionId: string) => manager.openHost({
    provider: 'claude',
    mode: 'resident',
    appSessionId,
    driver,
  });

  const hogHost = await open('session-hog');
  const siblingHost = await open('session-sibling');
  const failureHost = await open('session-failure');

  const hog = scopedByHostId.get(hogHost.hostId);
  const sibling = scopedByHostId.get(siblingHost.hostId);
  assert.ok(hog && sibling, 'every opened host must have bound one scoped child');
  assert.ok(typeof sibling.pid === 'number');
  const hogUnit = hog.unitName;
  const siblingUnit = sibling.unitName;

  try {
    // (2) the over-limit child is reaped — with no cap on it, it allocates its
    // bounded 384 MiB and then sits there, which is what makes this a reading about
    // the cap rather than about the workload. Read first, deliberately: the
    // falsification variant that creates no scope at all must red *here*, on "the
    // over-limit process is not killed", rather than on a later control.
    await waitUntil(
      () => hog.child.exitCode !== null || hog.child.signalCode !== null,
      20_000,
      () => 'the over-limit child to be reaped',
    );

    // The host the manager tracks for it records the *kernel* fact — not the exit
    // code, which cannot tell a cap kill from a crash. This is the reading the
    // driver derives from the unit's own journal.
    await waitUntil(
      () => {
        const host = manager.snapshot().find((candidate) => candidate.hostId === hogHost.hostId);
        return host?.closeReason === 'exited' && host.closeDetail === 'oom';
      },
      20_000,
      () => `host ${hogHost.hostId} to read exited/oom, saw ${
        JSON.stringify(manager.snapshot().find((candidate) => candidate.hostId === hogHost.hostId))
      }`,
    );

    // The same fact, read directly from the production seam the driver used, so the
    // host reading above cannot be satisfied by the detail alone. Guarded because a
    // null unit means the wrapper created no scope; the waits just above have
    // already red on that, and there is no unit here to read.
    if (hogUnit !== null) {
      assert.equal(
        await detectResidentScopeOomKill(hogUnit),
        true,
        `the journal must blame the cap for ${hogUnit}`,
      );
    }

    // (4) positive control, on the same reader the emptiness reading uses: the
    // scope of a child that is *still running* has to be named here. Without this
    // the "no residual scope" readings could be satisfied by a reader that never
    // sees anything — and a reader that sees nothing is what a missing scope looks
    // like from the inside. The hog's own unit is not used: a cap-killed scope stays
    // listed as `failed` until it is reset, so naming it would prove nothing here.
    await waitUntil(
      () => siblingUnit !== null && ownScopes().includes(`${siblingUnit}.scope`),
      15_000,
      () => `the listing to name the live sibling ${siblingUnit}, saw ${JSON.stringify(ownScopes())}`,
    );

    // (3) the sibling under the same slice, and this process, are untouched.
    assert.equal(sibling.child.exitCode, null, 'the sibling must still be running');
    assert.equal(sibling.child.signalCode, null, 'the sibling must not have been signalled');
    assert.doesNotThrow(() => process.kill(sibling.pid as number, 0));
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    assert.ok(
      siblingUnit !== null && ownScopes().includes(`${siblingUnit}.scope`),
      `the sibling scope must still be listed, saw ${JSON.stringify(ownScopes())}`,
    );
    assert.notEqual(
      manager.snapshot().find((candidate) => candidate.hostId === siblingHost.hostId)?.state,
      'closed',
    );

    // The negative control for (2): a child that fails on its own exits non-zero
    // too, and must not be blamed on the cap.
    await waitUntil(
      () => manager.snapshot().find((candidate) => candidate.hostId === failureHost.hostId)
        ?.closeReason === 'exited',
      20_000,
      () => 'the cleanly failing child\'s host to close',
    );
    assert.equal(
      manager.snapshot().find((candidate) => candidate.hostId === failureHost.hostId)?.closeDetail,
      'error',
      'an ordinary failure must not be reported as an OOM',
    );
  } finally {
    for (const scoped of scopedByHostId.values()) {
      scoped.child.kill('SIGKILL');
    }
    stopResidentScopes(process.pid);
  }
});

test('the listing names a live scope and is empty once the scopes are stopped', async () => {
  const hook = createRecordingHook();
  assert.ok(hook, 'an injected passing probe must still produce the hook');
  const scoped = spawnScoped(hook, IDLE_SOURCE);
  const unitName = scoped.unitName;

  try {
    // Presence and absence are read through the same function, so "empty after"
    // is a statement about the same reader that saw the scope while it lived.
    await waitUntil(
      () => unitName !== null && ownScopes().includes(`${unitName}.scope`),
      15_000,
      () => `the listing to name ${unitName}, saw ${JSON.stringify(ownScopes())}`,
    );
  } finally {
    scoped.child.kill('SIGKILL');
    stopResidentScopes(process.pid);
  }

  await waitUntil(
    () => ownScopes().length === 0,
    15_000,
    () => `no residual scope, saw ${JSON.stringify(ownScopes())}`,
  );
  assert.deepEqual(ownScopes(), []);
});
