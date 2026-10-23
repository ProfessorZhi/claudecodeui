import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';

/**
 * One reply, drawn twice — the shape the merge rules did not cover.
 *
 * A turn that has already persisted its opening segment leaves the server
 * holding a row for that text while the client is still streaming the same
 * text into its own row. Merged order puts the persisted row first: the live
 * row is re-stamped with the wall clock on every flush, so it can only ever
 * come last. The collapse therefore has to recognize `(echo, live)` as well as
 * the `(live, echo)` and `(text, text)` pairs it already knew, and the survivor
 * has to stay the live row — the transcript keys a row by its store id, so
 * handing that turn's identity to the echo re-keys it, and a re-key is an
 * unmount on the frame the turn settles (see `dedupeAdjacentAssistantEchoes`).
 *
 * The first two cases below are the two sides of that pair, one while the turn
 * is still in flight and one after it settles; they are asserted separately
 * because each has to be able to go red on its own. The third pins the shape
 * the collapse must *not* take: two turns that merely read the same are two
 * replies, and folding them would move a settled turn's identity onto the next
 * one.
 *
 * The last case is the other half of the defect — the trigger. A refresh that
 * lands mid-turn is what brings the echo in beside the live row in the first
 * place, and the switch-back path issued one without the guard its sibling
 * refresh paths carry.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SID = 'session-1';
const PROMPT = 'prompt';
const SEGMENT = 'the opening segment, already on disk';

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  provider: 'claude',
  sessionId: SID,
  ...over,
} as NormalizedMessage);

const USER_ROW = msg({
  id: 'u1',
  kind: 'text',
  role: 'user',
  content: PROMPT,
  timestamp: '2026-01-01T00:00:01.000Z',
  transcriptAnchorId: 'a1',
});

/**
 * The server's own row for text the client is also holding, dated against the
 * flush that carries it rather than against the fixture's own clock.
 *
 * The pair only exists because the server wrote that segment *before* the flush
 * the reader is looking at, and the merge sorts on exactly that comparison. A
 * fixed date would make the case a statement about which clock ran faster; one
 * second earlier than the live row is the ordering the defect needs, stated.
 */
const persistedEchoOf = (liveRow: NormalizedMessage): NormalizedMessage => msg({
  id: 'srv-seg1',
  kind: 'text',
  role: 'assistant',
  content: liveRow.content,
  timestamp: new Date(Date.parse(String(liveRow.timestamp)) - 1000).toISOString(),
});

const historyOf = (messages: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

/** Everything the transcript draws as a reply — the user's own rows excluded. */
const assistantRows = (rows: NormalizedMessage[]) =>
  rows.filter((row) => row.kind !== 'text' || row.role !== 'user');

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue(historyOf([USER_ROW]));
});

afterEach(() => {
  vi.resetModules();
});

async function loadedStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
  return view;
}

/** Drives the store the way a mid-turn refresh does: the server answers now. */
async function refreshFromServer(
  view: Awaited<ReturnType<typeof loadedStore>>,
  messages: NormalizedMessage[],
) {
  sessionMessages.mockResolvedValue(historyOf(messages));
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
}

describe('a persisted echo that arrives while its own segment is still streaming', () => {
  it('collapses into the live row instead of drawing the reply twice', async () => {
    const view = await loadedStore();

    act(() => { view.result.current.updateStreaming(SID, SEGMENT, 'claude'); });
    const liveRow = assistantRows(view.result.current.getMessages(SID))[0];
    assert.match(String(liveRow.id), /^live:/, 'the turn streams into a row of the client\'s own');

    await refreshFromServer(view, [USER_ROW, persistedEchoOf(liveRow)]);

    const rows = assistantRows(view.result.current.getMessages(SID));
    assert.equal(rows.length, 1, 'the echo of the segment being streamed must not draw beside it');
    assert.equal(rows[0].id, liveRow.id, 'the echo must not take the streaming turn\'s identity');
    assert.match(
      String(rows[0].id),
      /^live:/,
      'the survivor of the pair is the client\'s own row, not the persisted one',
    );
    assert.equal(
      rows[0].kind,
      'stream_delta',
      'the echo must not settle a row whose own turn is still streaming',
    );
  });

  it('collapses the same pair once the turn has settled', async () => {
    const view = await loadedStore();

    act(() => { view.result.current.updateStreaming(SID, SEGMENT, 'claude'); });
    const liveRow = assistantRows(view.result.current.getMessages(SID))[0];
    act(() => { view.result.current.finalizeStreaming(SID); });

    await refreshFromServer(view, [USER_ROW, persistedEchoOf(liveRow)]);

    const rows = assistantRows(view.result.current.getMessages(SID));
    assert.equal(rows.length, 1, 'the settled row and the server\'s echo are one reply');
    assert.equal(rows[0].id, liveRow.id, 'the echo must not take the settled turn\'s identity');
    assert.equal(rows[0].kind, 'text', 'the settled row stays settled');
  });

  it('leaves two turns that read the same as two replies', async () => {
    const view = await loadedStore();

    act(() => { view.result.current.updateStreaming(SID, SEGMENT, 'claude'); });
    const firstTurn = assistantRows(view.result.current.getMessages(SID))[0];
    act(() => { view.result.current.finalizeStreaming(SID); });

    // The next turn happens to write the same words. The row on the left is a
    // live id too — a settled one — which makes this the pair the collapse must
    // refuse: folding it would hand the new turn the identity of the old, and
    // the old reply would stop being drawn at all.
    act(() => { view.result.current.updateStreaming(SID, SEGMENT, 'claude'); });

    const rows = assistantRows(view.result.current.getMessages(SID));
    assert.equal(rows.length, 2, 'a reply that merely reads the same is still its own turn');
    assert.equal(rows[0].id, firstTurn.id, 'the settled turn keeps the identity it settled with');
    assert.equal(rows[1].kind, 'stream_delta', 'the new turn is still streaming');
    assert.notEqual(rows[1].id, firstTurn.id, 'the new turn must not write into the settled row');
  });
});

/* ------------------------------------------------------------------ */
/*  The trigger: the refresh that lands mid-turn                       */
/* ------------------------------------------------------------------ */

const SESSION: ProjectSession = {
  id: SID,
  name: 'Session one',
  provider: 'claude',
} as ProjectSession;

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const ACTIVITY = new Map([[SID, { statusText: 'working', canInterrupt: true }]]);

/**
 * A store that is hydrated and stale, so the session-loading effect takes its
 * returning-to-a-session branch. `refreshLatestFromServer` is the store method
 * whose whole job is the `/messages` request, so counting it is counting the
 * refresh — the sync API the hook itself calls.
 */
function returningStore() {
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 1, hasMore: false, offset: 1 };
  return {
    refreshLatestFromServer: vi.fn(async () => ({
      slot,
      applied: true,
      changed: false,
      deferred: false,
    })),
    fetchFromServer: vi.fn(async () => slot),
    fetchMore: vi.fn(async () => ({ slot, prependedCount: 0 })),
    appendRealtime: vi.fn(),
    setActiveSession: vi.fn(),
    isStale: vi.fn((_sessionId: string) => true),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => []),
    getSessionSlot: vi.fn((_sessionId: string) => slot),
  };
}

/**
 * Held for the hook's whole life rather than rebuilt per render: the refresh
 * decision lives in an effect, and a prop that is a fresh closure on every
 * render would re-enter it on each one — the count below would then be a
 * statement about render passes instead of about navigations.
 */
const hookProps = {
  sendMessage: vi.fn(),
  resetStreamingState: vi.fn(),
  statusCheckSentAtRef: { current: new Map<string, number>() },
  lastSeqRef: { current: new Map<string, number>() },
};

/**
 * Hydrate the session, leave the chat view and come back — the navigation the
 * defect was reported under. The leave/return pair is what re-enters the
 * loading effect with the same session already loaded, which is the branch that
 * decides whether to refresh.
 */
async function leaveAndReturnToChat(store: ReturnType<typeof returningStore>, processing: boolean) {
  const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');

  const view = renderHook(
    ({ isActive }: { isActive: boolean }) =>
      useChatSessionState({
        isActive,
        selectedProject: project,
        selectedSession: SESSION,
        ws: null,
        processingSessions: processing ? (ACTIVITY as never) : undefined,
        sessionStore: store as never,
        ...hookProps,
      }),
    { initialProps: { isActive: true } },
  );

  await act(async () => {});
  view.rerender({ isActive: false });
  view.rerender({ isActive: true });
  await act(async () => {});

  return view;
}

describe('returning to a session that is still streaming', () => {
  it('issues the refresh when nothing is streaming — the path itself, unguarded', async () => {
    const store = returningStore();
    const slot = store.getSessionSlot(SID);
    assert.equal(Boolean(slot?.fetchedAt), true, 'the premise: the session is already hydrated');
    assert.equal(store.isStale(SID), true, 'the premise: its cached transcript has gone stale');

    await leaveAndReturnToChat(store, false);

    assert.equal(
      store.refreshLatestFromServer.mock.calls.length,
      1,
      'a stale session must still be refreshed on the way back in',
    );
  });

  it('issues no persisted-history refresh while the turn is in flight', async () => {
    const store = returningStore();

    await leaveAndReturnToChat(store, true);

    assert.equal(
      store.refreshLatestFromServer.mock.calls.length,
      0,
      'a mid-turn refresh is what puts the persisted echo beside the live row',
    );
  });
});
