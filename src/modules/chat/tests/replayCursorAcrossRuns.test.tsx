import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';
import type { ChatReplayCursorMap, Project, ProjectSession, ServerEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * The replay cursor must survive a run change.
 *
 * `seq` is numbered per run by the server — it restarts at 1 on a session's
 * second and later turns — while the client's cursor is per session. A cursor
 * that only ever rises therefore carries run 1's high-water mark into run 2,
 * where it suppresses every early frame of the new run: the gap a reconnect was
 * supposed to fill. These cases pin the identity rule that fixes it — a frame
 * from a different run replaces the cursor, the subscribe message names the run
 * it belongs to, and an ack for a different run resets it — plus the unchanged
 * behavior for frames and acks that carry no run id.
 */

const SESSION_ID = 'session-a';

const SESSION: ProjectSession = { id: SESSION_ID, name: 'Session one', provider: 'claude' } as ProjectSession;

const PROJECT: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

/** Drives the realtime handler and hands back the cursor map it writes. */
function renderHandlers(initial: Map<string, unknown> = new Map()) {
  let listener: ((event: ServerEvent) => void) | null = null;
  const lastSeqRef = { current: initial as ChatReplayCursorMap };

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: SESSION,
    currentSessionId: SESSION_ID,
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef,
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: () => {},
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  return {
    dispatch: (event: ServerEvent) => listener?.(event),
    cursorFor: (sessionId: string) => lastSeqRef.current.get(sessionId),
  };
}

/** A store stub with just the async surface `useChatSessionState` reaches for. */
function sessionStoreStub() {
  const slot = { fetchedAt: 1, status: 'idle' as const, total: 0, hasMore: false, offset: 0 };
  return {
    refreshLatestFromServer: vi.fn(async () => ({ slot, applied: true, changed: false, deferred: false })),
    fetchFromServer: vi.fn(async () => slot),
    fetchMore: vi.fn(async () => ({ slot, prependedCount: 0 })),
    appendRealtime: vi.fn(),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => []),
    getSessionSlot: vi.fn(() => slot),
  };
}

/**
 * Mounts the hook that owns the subscribe effect and returns the frames it has
 * sent so far. The cursor is handed in already recorded, which is the state a
 * reconnect is in.
 *
 * Every prop that is not a plain value is created once, outside the hook: `ws`
 * and the refs sit in the effect's dependency list, so a fresh object on each
 * render would re-enter the effect and send a second subscribe.
 */
const SUBSCRIBE_WS = {} as WebSocket;
function renderSubscribeSite(cursor: ChatReplayCursorMap) {
  const sendMessage = vi.fn();
  const store = sessionStoreStub();
  const lastSeqRef = { current: cursor };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  renderHook(() => useChatSessionState({
    isActive: true,
    selectedProject: PROJECT,
    selectedSession: SESSION,
    ws: SUBSCRIBE_WS,
    sendMessage,
    resetStreamingState: () => {},
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore: store as unknown as SessionStore,
  }));

  const subscribeFrames = () => sendMessage.mock.calls
    .map(([frame]) => frame as { type?: string; sessions?: Array<Record<string, unknown>> })
    .filter((frame) => frame.type === 'chat.subscribe');

  return { subscribeFrames };
}

const streamFrame = (seq: number, runId?: string): ServerEvent => ({
  kind: 'stream_delta',
  content: `chunk-${seq}`,
  sessionId: SESSION_ID,
  seq,
  ...(runId ? { runId } : {}),
} as unknown as ServerEvent);

test('a frame from a new run replaces the cursor instead of being folded into its high-water mark', () => {
  const { dispatch, cursorFor } = renderHandlers(new Map([[SESSION_ID, { runId: 'run-1', seq: 5 }]]));

  // Run 2's first frame. It numbers from 1, so a max-wins cursor keeps 5 and
  // this frame — and every one after it below 5 — is silently swallowed.
  dispatch(streamFrame(1, 'run-2'));

  assert.deepEqual(cursorFor(SESSION_ID), { runId: 'run-2', seq: 1 });

  // Later frames of the same run keep advancing.
  dispatch(streamFrame(4, 'run-2'));
  assert.deepEqual(cursorFor(SESSION_ID), { runId: 'run-2', seq: 4 });
});

test('a frame with no run id keeps the original only-increasing behavior', () => {
  const { dispatch, cursorFor } = renderHandlers();

  dispatch(streamFrame(3));
  assert.equal(cursorFor(SESSION_ID), 3);

  // Out of order, from a server that does not publish run ids: unchanged.
  dispatch(streamFrame(1));
  assert.equal(cursorFor(SESSION_ID), 3);
});

test('the subscribe message names the run the cursor was recorded against', () => {
  const { subscribeFrames } = renderSubscribeSite(new Map([[SESSION_ID, { runId: 'run-2', seq: 4 }]]));

  const frames = subscribeFrames();
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0]?.sessions, [{ sessionId: SESSION_ID, lastSeq: 4, runId: 'run-2' }]);
});

test('a subscribe with a cursor that has no run id stays on the old shape', () => {
  const { subscribeFrames } = renderSubscribeSite(new Map([[SESSION_ID, 7]]));

  const frames = subscribeFrames();
  assert.equal(frames.length, 1);
  const target = frames[0]?.sessions?.[0] ?? {};
  assert.equal(target.lastSeq, 7);
  assert.equal('runId' in target, false);
});

test('an ack for a different run resets the cursor to that run\'s start', () => {
  const { dispatch, cursorFor } = renderHandlers(new Map([[SESSION_ID, { runId: 'run-1', seq: 5 }]]));

  dispatch({
    kind: 'chat_subscribed',
    sessionId: SESSION_ID,
    isProcessing: true,
    pendingPermissions: [],
    runId: 'run-2',
  } as unknown as ServerEvent);

  assert.deepEqual(cursorFor(SESSION_ID), { runId: 'run-2', seq: 0 });

  // The same run's ack leaves the cursor where it was.
  dispatch(streamFrame(3, 'run-2'));
  dispatch({
    kind: 'chat_subscribed',
    sessionId: SESSION_ID,
    isProcessing: true,
    pendingPermissions: [],
    runId: 'run-2',
  } as unknown as ServerEvent);
  assert.deepEqual(cursorFor(SESSION_ID), { runId: 'run-2', seq: 3 });
});

test('an ack with no run id leaves the cursor alone', () => {
  const { dispatch, cursorFor } = renderHandlers(new Map([[SESSION_ID, { runId: 'run-1', seq: 5 }]]));

  dispatch({
    kind: 'chat_subscribed',
    sessionId: SESSION_ID,
    isProcessing: true,
    pendingPermissions: [],
  } as unknown as ServerEvent);

  assert.deepEqual(cursorFor(SESSION_ID), { runId: 'run-1', seq: 5 });
});
