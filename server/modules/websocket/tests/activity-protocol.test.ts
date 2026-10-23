/**
 * AC-193: the activity protocol — REST snapshot + whole-snapshot WS upsert, with
 * revisions, a late joiner's snapshot-first order, per-connection cursors, and
 * per-session retirement.
 *
 * AC-182 shipped only the heartbeat: frames that carry a `bootId` and a `rev` so a
 * browser can tell the server is alive. The revision it carried never moved,
 * because the layer that moves it — an authoritative activity snapshot and the
 * change frames built from it — did not exist. This criterion drives that layer:
 * a store that owns the snapshot (`turn ⊕ tasks ⊕ schedules`) and the one
 * per-session revision, hands a late joiner the snapshot over REST, and pushes the
 * *whole* snapshot on every change over the socket.
 *
 * Everything the criterion asserts is a property a naive implementation gets
 * wrong:
 *
 *  - a revision that moves by one per change, and only by one;
 *  - an upsert whose body is the whole snapshot as of its revision, not a patch;
 *  - a client that anchors on a snapshot and only applies `rev === lastRev + 1`;
 *  - a hole in the revision stream that re-fetches the snapshot instead of
 *    splicing the discontinuous frame onto a stale picture;
 *  - two connections to one session with independent cursors;
 *  - a retired session that leaves nothing behind and delivers nothing more.
 *
 * ## Why the two false-form arms are here
 *
 * A criterion that only shows green readings cannot show they have any resolving
 * power. The last case rebuilds the two defects this protocol exists to avoid — an
 * upsert that carries no revision, and a frame body that is not read from the same
 * source as the REST snapshot — and asserts the SAME reading goes red for each. If
 * a false-form arm ever went green, the main assertion above it would be
 * unfalsifiable and the arm would say so.
 *
 * ## What is real and what is forged
 *
 * The store is the production `createActivityStore`, driven with injected
 * readings (a pinned clock, a fixed boot id, fake turn/task/schedule projections)
 * so the criterion never depends on AC-191/AC-192's reducers or on a real clock.
 * The REST path is a real `createActivityRouter` on a real express app over a real
 * socket, not a direct call into the store — the re-fetch the client is asserted to
 * make is an actual HTTP GET. Only the three projections and the clock are forged,
 * and each forgery is a pinned value the assertions read back.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import express from 'express';

import type { TurnState } from '@/modules/providers/index.js';
import {
  WS_OPEN_STATE,
  broadcastHostsChanged,
  connectedClients,
  createActivityStore,
  createActivityRouter,
  type ActivityFrameListener,
  type ActivityProtocolFrame,
  type ActivityProtocolSnapshot,
  type ActivityStore,
  type ActivityStoreOptions,
} from '@/modules/websocket/index.js';

// ---------------------------------------------------------------- test fixtures

/** A deep copy, so a client's stored picture cannot alias a live fixture. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The frame without its `kind`: the snapshot body the frame carries. */
function frameBody(frame: ActivityProtocolFrame): ActivityProtocolSnapshot {
  const { kind: _kind, ...body } = frame;
  return body;
}

/** A turn reading the criterion pins, so AC-191/192 need not have landed. */
function fakeTurn(phase: TurnState['phase'], toolName: string | null): TurnState {
  return { phase, toolName, toolDurationMs: null };
}

/**
 * The three projections the store is fed. Mutable so a case can change one and
 * then call `recordChange` — which is exactly the "the task or schedule changed"
 * event the protocol is about.
 */
type Fixtures = {
  turn: TurnState;
  tasks: unknown[];
  schedules: unknown[];
};

function makeFixtures(): Fixtures {
  return {
    turn: fakeTurn('thinking', 'Read'),
    tasks: [{ id: 'task-1' }],
    schedules: [{ id: 'schedule-1' }],
  };
}

// -------------------------------------------------------------------- the client

/** Fetches one session's authoritative snapshot — the client's re-fetch. */
type SnapshotReader = (sessionId: string) => Promise<ActivityProtocolSnapshot>;

/**
 * A test client, holding one connection's cursor.
 *
 * It implements exactly the cursor semantics the protocol requires and nothing
 * else, so the assertions below are about the server's frames rather than about a
 * client that happened to be forgiving:
 *
 *  - a snapshot anchors it (`lastRev` = the snapshot's rev, and its picture is the
 *    snapshot);
 *  - an upsert is applied only when `rev === lastRev + 1`;
 *  - an upsert at `rev <= lastRev` is stale/duplicate and is ignored;
 *  - an upsert at `rev > lastRev + 1` is a hole: it re-fetches the snapshot rather
 *    than splicing the frame;
 *  - a frame with no numeric `rev` cannot be placed, so it is ignored (this is the
 *    shape AC10's first false-form arm produces).
 *
 * Two instances are two connections. Neither reads the other's cursor.
 */
class ActivityTestClient {
  lastRev: number | null = null;
  state: ActivityProtocolSnapshot | null = null;
  /** The most recent upsert frame handed to this connection. */
  lastUpsert: ActivityProtocolFrame | null = null;
  /** Every frame kind this connection has seen, in order. */
  readonly kinds: string[] = [];
  /** How many times this connection re-fetched a snapshot. */
  refetches = 0;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly readSnapshot: SnapshotReader,
  ) {}

  onFrame(frame: ActivityProtocolFrame): void {
    this.kinds.push(frame.kind);
    if (frame.kind === 'activity.snapshot') {
      this.anchor(frame);
      return;
    }

    this.lastUpsert = frame;
    const rev = frame.rev;
    if (typeof rev !== 'number' || !Number.isFinite(rev)) {
      // No revision: the frame cannot be placed against the cursor, and guessing
      // would be worse than ignoring it.
      return;
    }
    if (this.lastRev === null) {
      // An upsert before any anchor: re-fetch rather than assume a baseline.
      this.pending = this.refetch();
      return;
    }
    if (rev === this.lastRev + 1) {
      this.apply(frame);
      return;
    }
    if (rev <= this.lastRev) {
      return; // stale or duplicate
    }
    // rev > lastRev + 1: a hole in the stream. Re-fetch the authoritative
    // snapshot; never splice the discontinuous frame onto the stale picture.
    this.pending = this.refetch();
  }

  /** Awaits whatever re-fetch the last frame triggered, if any. */
  async settle(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      await pending;
    }
  }

  private anchor(snapshot: ActivityProtocolSnapshot): void {
    this.lastRev = snapshot.rev;
    this.state = clone(snapshot);
  }

  private apply(frame: ActivityProtocolFrame): void {
    this.lastRev = frame.rev;
    this.state = clone(frameBody(frame));
  }

  private async refetch(): Promise<void> {
    this.refetches += 1;
    const snapshot = await this.readSnapshot(this.sessionId);
    this.anchor(snapshot);
  }
}

// ------------------------------------------------------------------- the harness

type Harness = {
  store: ActivityStore;
  /** The same store, over the REST router, for a client's re-fetch. */
  readSnapshot: SnapshotReader;
  /** The raw status plus body of a REST GET, for the 404 assertions. */
  getSnapshot(sessionId: string): Promise<{ status: number; body: ActivityProtocolSnapshot | null }>;
  close(): Promise<void>;
};

/**
 * Builds a store and mounts it behind the real REST router on a real socket.
 *
 * The socket is real so the "re-fetch" the client is asserted to make is an HTTP
 * round trip, not a call into the store that a broken router could not answer.
 */
async function startHarness(options: ActivityStoreOptions): Promise<Harness> {
  const store = createActivityStore(options);
  const app = express();
  app.use('/api/sessions', createActivityRouter({ activityStore: store }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const getSnapshot = async (sessionId: string) => {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/activity`);
    if (response.status !== 200) {
      return { status: response.status, body: null };
    }
    return { status: 200, body: (await response.json()) as ActivityProtocolSnapshot };
  };

  return {
    store,
    getSnapshot,
    readSnapshot: async (sessionId) => {
      const { body } = await getSnapshot(sessionId);
      assert.ok(body, `the REST snapshot for "${sessionId}" was not readable`);
      return body;
    },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

// --------------------------------------------------------- the main protocol case

test('REST snapshot and whole-snapshot upsert share one revision source', async () => {
  const fixtures = makeFixtures();
  const harness = await startHarness({
    now: () => 1_000,
    bootId: 'boot-test',
    readTurn: () => ({ ...fixtures.turn }),
    readTasks: () => fixtures.tasks,
    readSchedules: () => fixtures.schedules,
  });
  const sessionId = 'session-main';

  try {
    // The session is live because a connection is on it: the store is told about a
    // session by a subscriber, which is what the server's run loop stands in for.
    harness.store.subscribe(sessionId, () => undefined);

    // ---- AC2: the REST snapshot is the injected readings, verbatim ----
    const first = await harness.getSnapshot(sessionId);
    assert.equal(first.status, 200, 'a live session did not answer 200 on its activity route');
    const snapshot = first.body;
    assert.ok(snapshot);
    assert.equal(snapshot.sessionId, sessionId);
    assert.equal(snapshot.bootId, 'boot-test');
    assert.equal(snapshot.rev, 0);
    assert.equal(snapshot.asOf, 1_000);
    assert.deepEqual(snapshot.turn, fixtures.turn);
    assert.deepEqual(snapshot.tasks, fixtures.tasks);
    assert.deepEqual(snapshot.schedules, fixtures.schedules);
    const missing = await harness.getSnapshot('never-seen');
    assert.equal(missing.status, 404, 'an unknown session did not answer 404');
    console.log(
      `ac2 snapshot status=${first.status} bootId=${snapshot.bootId} rev=${snapshot.rev} ` +
        `asOf=${snapshot.asOf} tasks=${snapshot.tasks.length} schedules=${snapshot.schedules.length} ` +
        `unknown=${missing.status}`,
    );

    // ---- AC3: a change pushes a whole-snapshot upsert; rev is monotone ----
    const frames: ActivityProtocolFrame[] = [];
    harness.store.subscribe(sessionId, (frame) => frames.push(frame));
    assert.equal(
      frames.filter((frame) => frame.kind === 'activity.upsert').length,
      0,
      'a fresh subscription received an upsert before any change',
    );
    fixtures.tasks = [{ id: 'task-1' }, { id: 'task-2' }];
    harness.store.recordChange(sessionId);
    fixtures.schedules = [{ id: 'schedule-1' }, { id: 'schedule-2' }];
    harness.store.recordChange(sessionId);

    const upserts = frames.filter((frame) => frame.kind === 'activity.upsert');
    assert.equal(upserts.length, 2, `expected two upserts, read ${upserts.length}`);
    assert.equal(upserts[0].rev, snapshot.rev + 1, 'the first change did not advance the revision by one');
    assert.equal(upserts[1].rev, upserts[0].rev + 1, 'the second change did not advance the revision by one');
    for (const frame of upserts) {
      assert.equal(frame.sessionId, sessionId);
      assert.equal(frame.bootId, 'boot-test');
    }
    // The body is the whole snapshot as of that revision, not a delta.
    const snapshotAtSecond = harness.store.snapshot(sessionId);
    assert.ok(snapshotAtSecond);
    assert.deepEqual(
      frameBody(upserts[1]),
      snapshotAtSecond,
      'the upsert body is not the whole snapshot at its revision',
    );
    console.log(
      `ac3 upsert-revs=${upserts.map((frame) => frame.rev).join(',')} ` +
        `whole-snapshot=${isDeepStrictEqual(frameBody(upserts[1]), snapshotAtSecond)}`,
    );

    // ---- AC4: a late joiner's first frame is a snapshot at the current rev ----
    fixtures.tasks = [{ id: 'task-1' }, { id: 'task-2' }, { id: 'task-3' }];
    harness.store.recordChange(sessionId);
    const currentRev = upserts[upserts.length - 1].rev + 1;

    const late: ActivityProtocolFrame[] = [];
    harness.store.subscribe(sessionId, (frame) => late.push(frame));
    assert.equal(late[0].kind, 'activity.snapshot', 'a late joiner did not receive a snapshot first');
    assert.equal(late[0].rev, currentRev, 'the late joiner\'s snapshot is not at the current revision');
    harness.store.recordChange(sessionId);
    assert.equal(late[1].kind, 'activity.upsert', 'a change after the late join did not arrive as an upsert');
    assert.equal(late[1].rev, currentRev + 1, 'the upsert after the late join is not the next revision');
    console.log(`ac4 late-first=${late[0].kind}@${late[0].rev} next=${late[1].kind}@${late[1].rev}`);

    // ---- AC5: the client applies rev+1 and ignores a stale/duplicate frame ----
    const client = new ActivityTestClient(sessionId, harness.readSnapshot);
    harness.store.subscribe(sessionId, (frame) => client.onFrame(frame));
    await client.settle();
    const anchoredRev = client.lastRev;
    assert.equal(anchoredRev, currentRev + 1);
    const anchoredState = clone(client.state);

    const stale: ActivityProtocolFrame = {
      kind: 'activity.upsert',
      sessionId,
      bootId: 'boot-test',
      rev: anchoredRev as number,
      asOf: 1,
      turn: fakeTurn('idle', null),
      tasks: [{ id: 'stale-frame' }],
      schedules: [],
    };
    client.onFrame(stale);
    await client.settle();
    assert.equal(client.lastRev, anchoredRev, 'a stale frame moved the cursor');
    assert.deepEqual(client.state, anchoredState, 'a stale frame changed the client picture');
    assert.equal(client.refetches, 0, 'a stale frame triggered a re-fetch');

    fixtures.schedules = [{ id: 'schedule-1' }, { id: 'schedule-2' }, { id: 'schedule-3' }];
    harness.store.recordChange(sessionId);
    await client.settle();
    assert.equal(client.lastRev, (anchoredRev as number) + 1, 'a continuous frame was not applied');
    console.log(
      `ac5 applied-rev=${client.lastRev} stale-ignored=${client.refetches === 0 ? 'yes' : 'no'}`,
    );

    // ---- AC9: the upsert body equals the REST snapshot at the same revision ----
    fixtures.tasks = [{ id: 'task-9a' }, { id: 'task-9b' }];
    harness.store.recordChange(sessionId);
    await client.settle();
    const upsert = client.lastUpsert;
    assert.ok(upsert, 'the client received no upsert to compare');
    const rest = await harness.getSnapshot(sessionId);
    assert.ok(rest.body);
    assert.equal(upsert.rev, rest.body.rev, 'the upsert and the REST snapshot are at different revisions');
    const sameSource = isDeepStrictEqual(frameBody(upsert), rest.body);
    assert.ok(sameSource, 'the upsert body and the REST snapshot disagree at the same revision');
    console.log(`ac9 upsert-vs-rest rev=${upsert.rev} deepEqual=${sameSource}`);
  } finally {
    await harness.close();
  }
});

// ------------------------------------------------------ the cursor / hole case

test('a hole in the revision stream re-fetches the snapshot; cursors are per-connection', async () => {
  const fixtures = makeFixtures();
  const harness = await startHarness({
    now: () => 5_000,
    bootId: 'boot-gap',
    readTurn: () => ({ ...fixtures.turn }),
    readTasks: () => fixtures.tasks,
    readSchedules: () => fixtures.schedules,
  });
  const sessionId = 'session-gap';

  try {
    const a = new ActivityTestClient(sessionId, harness.readSnapshot);
    const b = new ActivityTestClient(sessionId, harness.readSnapshot);
    harness.store.subscribe(sessionId, (frame) => a.onFrame(frame));
    harness.store.subscribe(sessionId, (frame) => b.onFrame(frame));
    await a.settle();
    await b.settle();
    assert.equal(a.lastRev, 0);
    assert.equal(b.lastRev, 0);
    const bRev = b.lastRev;
    const bState = clone(b.state);

    // ---- AC6: a frame that skips revisions forces a re-fetch ----
    // Injected directly: from the client's side a dropped socket message and a
    // server that skipped a revision look identical, which is the point.
    const spliced: ActivityProtocolFrame = {
      kind: 'activity.upsert',
      sessionId,
      bootId: 'boot-gap',
      rev: (a.lastRev as number) + 5,
      asOf: 1,
      turn: fakeTurn('tool', 'Bash'),
      tasks: [{ id: 'SPLICED' }],
      schedules: [],
    };
    a.onFrame(spliced);
    await a.settle();
    assert.ok(a.refetches >= 1, 'a revision hole did not trigger a snapshot re-fetch');

    const authoritative = await harness.readSnapshot(sessionId);
    assert.deepEqual(a.state, authoritative, 'the client picture is not the authoritative snapshot');
    assert.ok(
      !isDeepStrictEqual(a.state, clone(frameBody(spliced))),
      'the client spliced the discontinuous frame onto its picture',
    );
    console.log(
      `ac6 hole refetches=${a.refetches} state=authoritative ` +
        `spliced-rejected=${!isDeepStrictEqual(a.state, clone(frameBody(spliced)))}`,
    );

    // ---- AC7: the other connection's cursor is untouched ----
    assert.equal(b.lastRev, bRev, 'a re-fetch on one connection moved the other\'s cursor');
    assert.deepEqual(b.state, bState, 'a re-fetch on one connection changed the other\'s picture');
    console.log(`ac7 a.refetches=${a.refetches} b.refetches=${b.refetches} b.lastRev=${b.lastRev}`);
  } finally {
    await harness.close();
  }
});

// -------------------------------------------------------------- the retirement case

test('retireSession reclaims the session and stops delivery', async () => {
  const fixtures = makeFixtures();
  const harness = await startHarness({
    now: () => 7_000,
    bootId: 'boot-retire',
    readTurn: () => ({ ...fixtures.turn }),
    readTasks: () => fixtures.tasks,
    readSchedules: () => fixtures.schedules,
  });
  const sessionId = 'session-retire';

  try {
    const delivered: ActivityProtocolFrame[] = [];
    harness.store.subscribe(sessionId, (frame) => delivered.push(frame));
    assert.equal(delivered.length, 1, 'a subscription did not receive its initial snapshot');
    assert.ok(harness.store.sessionIds().includes(sessionId));

    // ---- AC8: retirement reclaims everything and delivers nothing more ----
    harness.store.retireSession(sessionId);
    assert.ok(
      !harness.store.sessionIds().includes(sessionId),
      'a retired session is still listed by sessionIds',
    );
    assert.equal(harness.store.snapshot(sessionId), null, 'a retired session still answers a snapshot');
    assert.equal((await harness.getSnapshot(sessionId)).status, 404, 'a retired session is still readable over REST');

    const before = delivered.length;
    harness.store.recordChange(sessionId);
    assert.equal(delivered.length, before, 'a retired session delivered a frame after retirement');
    assert.ok(
      !harness.store.sessionIds().includes(sessionId),
      'a change resurrected a retired session',
    );
    console.log(
      `ac8 listed-after-retire=${harness.store.sessionIds().length} ` +
        `snapshot=null get=404 delivered-delta=${delivered.length - before}`,
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- the false forms

/**
 * A variant store whose upsert frames carry NO revision.
 *
 * This is the first defect AC10 isolates: a change frame a client cannot place
 * against its cursor. The reading the main case relies on — "a hole triggers a
 * re-fetch" — has nothing to detect here, so it must come back red.
 */
function createRevlessUpsertStore(sessionId: string, fixtures: Fixtures): ActivityStore {
  const listeners = new Set<ActivityFrameListener>();
  let rev = 0;

  const body = (revision: number): ActivityProtocolSnapshot => ({
    sessionId,
    bootId: 'boot-false-revless',
    rev: revision,
    asOf: 1,
    turn: { ...fixtures.turn },
    tasks: [...fixtures.tasks],
    schedules: [...fixtures.schedules],
  });

  return {
    snapshot: () => body(rev),
    recordChange: () => {
      rev += 1;
      const { rev: _rev, ...withoutRevision } = body(rev);
      const frame = { kind: 'activity.upsert', ...withoutRevision } as ActivityProtocolFrame;
      for (const listener of [...listeners]) {
        listener(frame);
      }
    },
    subscribe: (_sessionId, listener) => {
      listeners.add(listener);
      listener({ kind: 'activity.snapshot', ...body(rev) });
      return () => listeners.delete(listener);
    },
    retireSession: () => listeners.clear(),
    sessionIds: () => [sessionId],
  };
}

/**
 * A variant store whose upsert frame body is NOT read from the same source the
 * REST snapshot reads.
 *
 * This is the second defect AC10 isolates: the upsert carries a cached projection
 * while `snapshot()` reads live. The reading the main case relies on — "at one
 * revision, the frame body and the REST body are equal" — must come back red.
 */
function createStaleUpsertStore(sessionId: string, readLiveTasks: () => unknown[]): ActivityStore {
  const listeners = new Set<ActivityFrameListener>();
  let rev = 0;

  const body = (revision: number, tasks: unknown[]): ActivityProtocolSnapshot => ({
    sessionId,
    bootId: 'boot-false-stale',
    rev: revision,
    asOf: 1,
    turn: { phase: 'idle', toolName: null, toolDurationMs: null },
    tasks,
    schedules: [],
  });

  return {
    // The REST path reads the live tasks...
    snapshot: () => body(rev, readLiveTasks()),
    recordChange: () => {
      rev += 1;
      // ...but the frame carries an empty cached projection, so the two disagree.
      const frame = { kind: 'activity.upsert', ...body(rev, []) } as ActivityProtocolFrame;
      for (const listener of [...listeners]) {
        listener(frame);
      }
    },
    subscribe: (_sessionId, listener) => {
      listeners.add(listener);
      listener({ kind: 'activity.snapshot', ...body(rev, readLiveTasks()) });
      return () => listeners.delete(listener);
    },
    retireSession: () => listeners.clear(),
    sessionIds: () => [sessionId],
  };
}

/**
 * Drives one connection through a two-change sequence whose first frame is lost —
 * a hole in the revision stream — with whatever store is handed in.
 *
 * It is the shared reading for the main case and the first false-form arm: the
 * only question it answers is "did the connection re-fetch after the hole?".
 */
function driveHole(store: ActivityStore, client: ActivityTestClient, sessionId: string): void {
  let dropNext = true;
  store.subscribe(sessionId, (frame) => {
    if (frame.kind === 'activity.upsert' && dropNext) {
      dropNext = false; // the lost frame
      return;
    }
    client.onFrame(frame);
  });
  store.recordChange(sessionId); // rev + 1 — dropped
  store.recordChange(sessionId); // rev + 2 — seen, past the cursor: a hole
}

/**
 * The AC9 reading as a predicate: is the upsert frame's body the same snapshot the
 * REST path answers at that revision?
 */
function sameSourceReading(
  upsert: ActivityProtocolFrame,
  restSnapshot: ActivityProtocolSnapshot,
): boolean {
  return upsert.rev === restSnapshot.rev && isDeepStrictEqual(frameBody(upsert), restSnapshot);
}

test('the false forms fail the reading the main cases pass', async () => {
  const fixtures = makeFixtures();
  const harness = await startHarness({
    now: () => 9_000,
    bootId: 'boot-false-main',
    readTurn: () => ({ ...fixtures.turn }),
    readTasks: () => fixtures.tasks,
    readSchedules: () => fixtures.schedules,
  });
  const sessionId = 'session-false';

  try {
    // ---- arm 1: a rev-less upsert defeats the hole detector ----
    const mainClient = new ActivityTestClient(sessionId, harness.readSnapshot);
    driveHole(harness.store, mainClient, sessionId);
    await mainClient.settle();
    const mainHoleReading = mainClient.refetches >= 1;

    const revlessClient = new ActivityTestClient(sessionId, harness.readSnapshot);
    driveHole(createRevlessUpsertStore(sessionId, fixtures), revlessClient, sessionId);
    await revlessClient.settle();
    const revlessHoleReading = revlessClient.refetches >= 1;

    assert.equal(mainHoleReading, true, 'the main store did not re-fetch after a hole');
    assert.equal(
      revlessHoleReading,
      false,
      'the rev-less variant still let the client detect a hole — the arm does not isolate the defect',
    );
    console.log(
      `ac10(1) main-refetches=${mainClient.refetches} revless-refetches=${revlessClient.refetches} ` +
        `(main reading green, false form red)`,
    );

    // ---- arm 2: an upsert body from a different source than the REST snapshot ----
    fixtures.tasks = [{ id: 'live-task' }];
    harness.store.recordChange(sessionId);
    await mainClient.settle();
    const mainUpsert = mainClient.lastUpsert;
    assert.ok(mainUpsert, 'the main client received no upsert for the source reading');
    const mainRest = harness.store.snapshot(sessionId);
    assert.ok(mainRest);
    const mainSourceReading = sameSourceReading(mainUpsert, mainRest);

    const liveTasks = [{ id: 'live-task' }];
    const staleStore = createStaleUpsertStore(sessionId, () => liveTasks);
    const staleClient = new ActivityTestClient(sessionId, harness.readSnapshot);
    staleStore.subscribe(sessionId, (frame) => staleClient.onFrame(frame));
    staleStore.recordChange(sessionId);
    await staleClient.settle();
    const staleUpsert = staleClient.lastUpsert;
    assert.ok(staleUpsert, 'the stale-source client received no upsert for the source reading');
    const staleRest = staleStore.snapshot(sessionId);
    assert.ok(staleRest);
    const staleSourceReading = sameSourceReading(staleUpsert, staleRest);

    assert.equal(mainSourceReading, true, 'the main store\'s upsert body is not the REST snapshot');
    assert.equal(
      staleSourceReading,
      false,
      'the different-source variant still produced an equal body — the arm does not isolate the defect',
    );
    console.log(
      `ac10(2) main-same-source=${mainSourceReading} stale-same-source=${staleSourceReading} ` +
        `(main reading green, false form red)`,
    );
  } finally {
    await harness.close();
  }
});

// ---------------------------------------------------------------- hosts_changed

/**
 * AC5 (the wire half): `hosts_changed` is delivered to open connections only.
 *
 * The session-hosts store's re-read is driven by this frame, so the two readings
 * that matter are who receives it and what it carries. It carries a revision and
 * no listing: `GET /api/session-hosts` stays the one place the snapshot is built,
 * and a frame that also carried a listing would be a second producer of the same
 * shape — the exact drift this frame exists to avoid.
 *
 * Open-only delivery is asserted with a live control beside it: a connection that
 * is mid-handshake (`CONNECTING`) or closing (`CLOSING`) must not be written to,
 * and a defect that dropped the `readyState` check would leave the dead clients
 * receiving frames while the closed ones still answered the open assertion. So
 * the connection below is `CONNECTING`, and its counterpart is `OPEN`.
 */
test('broadcastHostsChanged sends a revision-only frame to open connections only', () => {
  const received: string[] = [];
  const openClient = {
    readyState: WS_OPEN_STATE,
    send(data: string) { received.push(data); },
  };
  const connectingClient = {
    readyState: 0, // CONNECTING
    send(data: string) { received.push(`unexpected:${data}`); },
  };
  const closingClient = {
    readyState: 2, // CLOSING
    send(data: string) { received.push(`unexpected:${data}`); },
  };

  connectedClients.add(openClient);
  connectedClients.add(connectingClient);
  connectedClients.add(closingClient);
  try {
    broadcastHostsChanged(7);
  } finally {
    connectedClients.delete(openClient);
    connectedClients.delete(connectingClient);
    connectedClients.delete(closingClient);
  }

  assert.equal(received.length, 1, `exactly one connection should receive the frame, got ${received.length}`);
  const frame = JSON.parse(received[0]) as Record<string, unknown>;
  console.log(`hosts_changed frame=${received[0]}`);
  assert.equal(frame.kind, 'hosts_changed');
  assert.equal(frame.rev, 7);
  assert.equal(typeof frame.timestamp, 'string');
  // Revision only: the listing is read over REST, never carried on the frame.
  assert.deepEqual(Object.keys(frame).sort(), ['kind', 'rev', 'timestamp']);
  assert.equal('hosts' in frame, false, 'the frame must not carry a listing');
});
