/**
 * Criterion for the resident turn phase being keyed by the *app session id*.
 *
 * The claim is one sentence: a resident Claude host keyed by an app session id
 * (`appSessionId`) that is **not** the provider-native id the SDK reports
 * (`providerSessionId`) still records the phase of its running turn under the
 * app id, so the activity heartbeat — which reads back with the app id the
 * browser subscribes with — sees `tool` / the running tool's name rather than a
 * fresh `idle`.
 *
 * Why this exists separately from `claude-turn-phase.test.ts`: that file drives
 * the tracker directly and never passes through the resident driver's forwarding
 * call site. The per-run (non-resident) path already passes `turnSessionId`
 * explicitly (see `claude-runtime.provider.ts` and its sibling fix); the resident
 * path (`claude-host-driver.provider.ts`) did not, so the tracker was fed the
 * provider id while every reader used the app id. `getTurn` answers `idle` for an
 * unknown key, so the mismatch was silent — the dock stayed on the fallback
 * `Working…` label and no error was ever raised.
 *
 * The two id spaces are the whole point, so this file is written so a fixture
 * where the two ids are equal *cannot* satisfy it: AC3 asserts the inequality as
 * a precondition (the debug-agent e2e fixture collapses the two ids to one, which
 * is exactly why the e2e suite could not catch this).
 *
 * The driver is the real `ClaudeResidentHostDriver` with a scripted process (the
 * injected `createProcess` seam), driven through the real `run` entry and the real
 * private message-fold loop (`observe`), so the frame the tracker sees is the
 * frame this driver would forward in production — the forwarding call site is the
 * thing under test, not a copy of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionHostManager } from '@/modules/session-hosts/index.js';
import type { HostScheduler, SessionHostManager } from '@/modules/session-hosts/index.js';
import { ClaudeResidentHostDriver } from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import type {
  ClaudeResidentProcess,
  ClaudeResidentProcessFactory,
  ClaudeResidentQuery,
} from '@/modules/providers/list/claude/claude-host-driver.provider.js';
import { readSessionTurn } from '@/modules/providers/index.js';
import type {
  AnyRecord,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/**
 * The two id spaces, deliberately different — this is the fixture the criterion
 * is *about*. A fixture where they are equal would pass on the broken code too.
 */
const APP_SESSION_ID = 'resident-phase-app-id-ac-resident-key';
const PROVIDER_SESSION_ID = 'b827aab6-2114-4fe2-b1af-991a6c2285e1';
/** The tool the running turn is in the middle of. */
const TOOL_NAME = 'Bash';
const TOOL_USE_ID = 'toolu_resident_phase_1';

/** A scheduler whose deadlines never fire: this criterion is not about lifetime. */
function inertScheduler(): HostScheduler {
  return { schedule: () => () => undefined };
}

/**
 * A resident process the criterion owns: a stream it pushes into, in order.
 *
 * The query never ends on its own — an iterable that finished would make the
 * driver's read loop call `reportExit` and close the host, turning every reading
 * into a reading of a dead process.
 */
function createFakeProcess(): {
  factory: ClaudeResidentProcessFactory;
  emit(frame: AnyRecord): void;
} {
  const pending: AnyRecord[] = [];
  const waiters: Array<(frame: AnyRecord) => void> = [];

  const push = (frame: AnyRecord): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(frame);
      return;
    }
    pending.push(frame);
  };

  const iterator: AsyncIterator<AnyRecord> = {
    next(): Promise<IteratorResult<AnyRecord>> {
      const frame = pending.shift();
      if (frame) {
        return Promise.resolve({ value: frame, done: false });
      }
      return new Promise<IteratorResult<AnyRecord>>((resolve) => {
        waiters.push((queued) => resolve({ value: queued, done: false }));
      });
    },
    return(): Promise<IteratorResult<AnyRecord>> {
      return new Promise<IteratorResult<AnyRecord>>(() => undefined);
    },
  };

  const query: ClaudeResidentQuery = {
    [Symbol.asyncIterator]: () => iterator,
    interrupt: async () => undefined,
    close: () => undefined,
  };

  return {
    factory: () => ({ query, pid: 4242 }) satisfies ClaudeResidentProcess,
    emit: push,
  };
}

/** The runtime's own turn inputs, stubbed to the two facts the driver asks for. */
const CONTEXT: ProviderRuntimeContext = {
  resolveProviderSessionId: () => null,
  resolveResumeModel: async () => undefined,
  getProviderModels: async () => ({}) as never,
  // The frame pipeline has its own criteria beside this one; the phase tracker is
  // fed before the normalizer, so an empty normalizer is enough here.
  normalizeMessage: () => [],
  isProviderInstalled: async () => true,
};

function createWriter(): ProviderRuntimeWriter {
  return { send: () => undefined, setSessionId: () => undefined, userId: 1 };
}

/** `assistant` message carrying a `tool_use` block, keyed by the provider id. */
function toolUseFrame(): AnyRecord {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: TOOL_USE_ID, name: TOOL_NAME, input: {} }],
    },
    parent_tool_use_id: null,
    uuid: 'u-resident-phase-tool',
    session_id: PROVIDER_SESSION_ID,
  };
}

/** The turn's terminal `result`, keyed by the provider id. */
function resultFrame(): AnyRecord {
  return { type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID };
}

/** Yields the microtask queue enough times for the read loop to drain what was pushed. */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 80; hop += 1) {
    await Promise.resolve();
  }
}

/**
 * Arms one real resident round and waits for its `turn` lease.
 *
 * The wait is on the lease rather than on the host record because the lease is
 * the later fact: by the time it is there, the process has been adopted and the
 * round is parked at its settlement, so frames pushed afterwards are read by the
 * driver's fold loop.
 *
 * The round promise is returned *inside an object on purpose*. A bare
 * `Promise<Promise<void>>` would be unwrapped by the caller's `await`, which
 * would wait for the round to settle — and the round only settles once the caller
 * has pushed its frames, so awaiting it here would deadlock the test.
 */
async function beginRound(
  driver: ClaudeResidentHostDriver,
  manager: SessionHostManager,
): Promise<{ round: Promise<void> }> {
  const round = driver.run(APP_SESSION_ID, { command: 'run the phase leg', options: {} }, createWriter(), CONTEXT);
  for (let hop = 0; hop < 400; hop += 1) {
    const hasTurnLease = manager
      .snapshot()
      .some((host) => host.bindings.get(APP_SESSION_ID)?.leases.some((lease) => lease.kind === 'turn'));
    if (hasTurnLease) {
      return { round };
    }
    await Promise.resolve();
  }
  throw new Error('the resident host never armed a turn lease');
}

test('AC1 resident turn phase is keyed by the app session id, not the provider id', async () => {
  // AC3: the two ids being different is a precondition that is *asserted*, not an
  // implicit assumption — the debug-agent fixture that collapsed them is exactly
  // why the e2e suite could not see this mismatch.
  assert.notEqual(APP_SESSION_ID, PROVIDER_SESSION_ID, 'the criterion must use two distinct id spaces');

  const manager = createSessionHostManager({ now: () => 1_700_000_000_000, scheduler: inertScheduler() });
  const process = createFakeProcess();
  const driver = new ClaudeResidentHostDriver({
    host: manager,
    notifyBackgroundWork: () => undefined,
    notifyUnattendedWork: () => undefined,
    notifyRunStopped: () => undefined,
    createProcess: process.factory,
    now: () => 1_700_000_000_000,
  });

  const { round } = await beginRound(driver, manager);

  // Nothing observed yet: the key reads idle.
  assert.equal(readSessionTurn(APP_SESSION_ID).phase, 'idle');

  // A tool_use turn arrives on the provider-native id.
  process.emit(toolUseFrame());
  await settle();

  const appTurn = readSessionTurn(APP_SESSION_ID);
  // The first failing assertion on the broken code lands here, reading `idle`.
  assert.equal(appTurn.phase, 'tool', `app id must carry the running phase (read: ${JSON.stringify(appTurn)})`);
  assert.equal(
    appTurn.toolName,
    TOOL_NAME,
    `app id must carry the running tool name (read: ${JSON.stringify(appTurn)})`,
  );

  // AC2: the provider id is *not* the phase-carrying key — the fix routes the
  // tracker to the app id, it does not observe under both.
  assert.equal(
    readSessionTurn(PROVIDER_SESSION_ID).phase,
    'idle',
    'the provider id must not be the key the phase is carried under',
  );

  // AC2 positive control: the turn's `result` returns the app-keyed phase to idle.
  process.emit(resultFrame());
  await settle();
  assert.equal(readSessionTurn(APP_SESSION_ID).phase, 'idle', 'the result must return the app-keyed turn to idle');

  await round.catch(() => undefined);
});
