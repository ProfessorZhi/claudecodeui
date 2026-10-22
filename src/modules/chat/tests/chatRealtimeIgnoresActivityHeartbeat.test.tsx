import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

/**
 * The server beats an `activity.heartbeat` on every subscribed session, and it
 * is a control frame, not a message: it has no `id`. It was reaching the store
 * as a realtime row, where — because a merge assumes every row has a string id —
 * it made `removeOptimisticUserEchoes` throw on the next refresh and froze the
 * session's transcript for good.
 *
 * These cases pin leg 1 of the fix: the realtime handler drops the frame before
 * it can become a row, while a real message of the same shape is still appended
 * (the control that proves the row count is a live reading, not one that is
 * always zero).
 */

const SESSION_ID = 'session-heartbeat';

const SESSION: ProjectSession = {
  id: SESSION_ID,
  name: 'Session one',
  provider: 'claude',
} as ProjectSession;

/** The `activity.heartbeat` frame exactly as the server builds it: no `id`. */
const heartbeatFrame = (): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 0,
  timestamp: '2026-10-02T00:00:00.000Z',
});

/** A real provider message of the same session, which must still be appended. */
const textFrame = (id: string): ServerEvent => ({
  kind: 'text',
  sessionId: SESSION_ID,
  id,
  provider: 'claude',
  role: 'assistant',
  content: 'hello',
  timestamp: '2026-10-02T00:00:01.000Z',
});

/** Mounts the handler with a real store and returns a dispatcher for frames. */
function renderHandlers(store: SessionStore) {
  let listener: ((event: ServerEvent) => void) | null = null;
  const lastSeqRef = { current: new Map() };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const streamTimerRef = { current: null };
  const accumulatedStreamRef = { current: '' };

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
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    requestLatestMessages: async () => {},
    sessionStore: store,
  }));

  return (event: ServerEvent) => listener?.(event);
}

test('an activity.heartbeat frame never becomes a realtime row', () => {
  const storeView = renderHook(() => useSessionStore());
  const store = storeView.result.current;
  const dispatch = renderHandlers(store);

  const realtimeCount = () => store.getSessionSlot(SESSION_ID)?.realtimeMessages.length ?? 0;

  // A real message first, so a slot exists and a stray append would be visible
  // as a changed count rather than hidden behind an absent slot.
  act(() => { dispatch(textFrame('server-1')); });
  const before = realtimeCount();
  assert.equal(before, 1, 'the seed message is a realtime row');

  act(() => { dispatch(heartbeatFrame()); });
  assert.equal(realtimeCount(), before, 'the heartbeat adds no row');

  // Positive control: the reading is not stuck at its seed. A second real
  // message of the same session does move it.
  act(() => { dispatch(textFrame('server-2')); });
  assert.equal(realtimeCount(), before + 1, 'a real message is still appended');
});

test('a heartbeat arriving on a fresh session adds no row', () => {
  const storeView = renderHook(() => useSessionStore());
  const store = storeView.result.current;
  const dispatch = renderHandlers(store);

  const realtimeCount = () => store.getSessionSlot(SESSION_ID)?.realtimeMessages.length ?? 0;

  // The crash shape: the beat is the very first frame on a session the browser
  // has just subscribed to, before any message has been read.
  act(() => { dispatch(heartbeatFrame()); });
  assert.equal(realtimeCount(), 0, 'the heartbeat alone creates no row');

  act(() => { dispatch(textFrame('server-1')); });
  assert.equal(realtimeCount(), 1, 'the counter can still rise on this session');
});
