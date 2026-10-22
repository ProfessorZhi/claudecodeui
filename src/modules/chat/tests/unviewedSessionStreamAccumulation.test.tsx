import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A reply streaming in a session the reader is *not* looking at still arrives
 * as hundreds of one-token frames, and it has to end up as one row — the shape
 * the viewed session's reply already has.
 *
 * It used to be handed to the store raw, one frame per message, and the
 * projection draws every `stream_delta` as an assistant row. Coming back to
 * that session showed one bubble per token, each with its own markdown badge,
 * and the list header read "Showing 400 of 132 messages" — 132 messages drawn
 * as 400 rows. Nothing collected them afterwards either: the reconciliation
 * that drops superseded realtime rows compares whole texts, and a single token
 * never equals the reply it came from, so the fragments lasted until a page
 * reload rebuilt the store.
 *
 * The rows are asserted on, and by *content*, rather than the handler's calls:
 * what a shared accumulation buffer did wrong was put one session's text into
 * another session's row, which a call-count assertion cannot see.
 */

const VIEWED_SESSION = 'session-viewed';
const OTHER_SESSION = 'session-other';

/** The reply as the socket delivers it: one frame per token, in order. */
const REPLY_TOKENS = [
  'step', ' — ', 'navigate', ' **', 'back', '** ', 'client', '-side', ' and ',
  'inspect', ' the ', 'rows', '.',
];

/** Well past the coalescing window the handler buffers a session's deltas for. */
const FLUSH_BUDGET_MS = 500;

// Module scope, so the handler's effect is not rebound by a new object identity.
const selectedSession = { id: VIEWED_SESSION } as ProjectSession;

const delta = (sessionId: string, content: string, blockKey?: string): ServerEvent => ({
  kind: 'stream_delta',
  sessionId,
  content,
  // A real delta frame carries its own stamp; the store keeps the block's first
  // one. Pinned so the two sessions' rows do not sort against a live clock.
  timestamp: '2026-01-01T00:00:00.000Z',
  ...(blockKey ? { blockKey } : {}),
});

const streamEnd = (sessionId: string, blockKey?: string): ServerEvent => ({
  kind: 'stream_end',
  sessionId,
  ...(blockKey ? { blockKey } : {}),
});

const renderChat = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const streamTimerRef = { current: null as number | null };
  const accumulatedStreamRef = { current: '' };

  const view = renderHook(() => {
    const sessionStore = useSessionStore();

    useChatRealtimeHandlers({
      isActive: true,
      subscribe: (fn) => {
        listener = fn;
        return () => { listener = null; };
      },
      provider: 'claude',
      selectedSession,
      currentSessionId: VIEWED_SESSION,
      setTokenBudget: () => {},
      pendingPermissionRequests: [],
      setPendingPermissionRequests: () => {},
      streamTimerRef,
      accumulatedStreamRef,
      lastSeqRef: { current: new Map() },
      statusCheckSentAtRef: { current: new Map() },
      requestLatestMessages: async () => {},
      sessionStore,
    });

    return sessionStore;
  });

  return {
    sessionStore: view.result.current,
    dispatch: (event: ServerEvent) => listener?.(event),
  };
};

/** The rows the transcript would draw for a session, in order. */
const rowsOf = (store: SessionStore, sessionId: string): NormalizedMessage[] =>
  store.getMessages(sessionId).filter((message) => message.kind !== 'text' || message.role !== 'user');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a reply streaming in a session the reader is not viewing', () => {
  it('is one row holding the reply, not one row per frame', () => {
    const { dispatch, sessionStore } = renderChat();

    assert.ok(
      REPLY_TOKENS.length >= 12,
      'the fixture must deliver a reply as many frames — the defect is one row per frame',
    );
    for (const token of REPLY_TOKENS) {
      dispatch(delta(OTHER_SESSION, token));
    }
    act(() => { vi.advanceTimersByTime(FLUSH_BUDGET_MS); });

    const rows = rowsOf(sessionStore, OTHER_SESSION);
    assert.equal(rows.length, 1, `${REPLY_TOKENS.length} frames must draw as one row`);
    assert.equal(rows[0].kind, 'stream_delta', 'the row is still the turn in flight');
    assert.equal(rows[0].content, REPLY_TOKENS.join(''), 'the row holds the frames, in the order they arrived');
  });

  it('settles into that same row when the turn ends', () => {
    const { dispatch, sessionStore } = renderChat();

    for (const token of REPLY_TOKENS) {
      dispatch(delta(OTHER_SESSION, token));
    }
    dispatch(streamEnd(OTHER_SESSION));

    const rows = rowsOf(sessionStore, OTHER_SESSION);
    assert.equal(rows.length, 1, 'the settle must not add a row');
    assert.equal(rows[0].kind, 'text', 'the settled turn stops being a stream');
    assert.equal(rows[0].role, 'assistant');
    assert.equal(rows[0].content, REPLY_TOKENS.join(''));
  });

  it('takes nothing from a second session streaming at the same time', () => {
    const { dispatch, sessionStore } = renderChat();

    dispatch(delta(VIEWED_SESSION, 'first '));
    dispatch(delta(OTHER_SESSION, 'their '));
    dispatch(delta(VIEWED_SESSION, 'reply'));
    dispatch(delta(OTHER_SESSION, 'reply'));
    act(() => { vi.advanceTimersByTime(FLUSH_BUDGET_MS); });

    const otherRows = rowsOf(sessionStore, OTHER_SESSION);
    assert.equal(otherRows.length, 1, 'the unviewed session is still one row');
    assert.equal(otherRows[0].content, 'their reply', "the unviewed session's row holds only its own text");

    const viewedRows = rowsOf(sessionStore, VIEWED_SESSION);
    assert.equal(viewedRows.length, 1, 'the viewed session is one row too');
    assert.equal(viewedRows[0].content, 'first reply', "the viewed session's row holds only its own text");
  });

  it('keeps each block its own row when two sessions interleave block-keyed frames', () => {
    const { dispatch, sessionStore } = renderChat();

    dispatch(delta(OTHER_SESSION, 'theirs ', 'b:0'));
    dispatch(delta(VIEWED_SESSION, 'one ', 'a:0'));
    dispatch(delta(OTHER_SESSION, 'reply', 'b:0'));
    dispatch(delta(VIEWED_SESSION, 'two', 'a:1'));
    act(() => { vi.advanceTimersByTime(FLUSH_BUDGET_MS); });

    const viewedRows = rowsOf(sessionStore, VIEWED_SESSION);
    assert.equal(viewedRows.length, 2, 'two blocks of one turn are two rows');
    assert.deepEqual(
      viewedRows.map((row) => row.content),
      ['one ', 'two'],
      "each block holds its own segment, not the other block's",
    );
    assert.notEqual(
      viewedRows[0].blockKey,
      viewedRows[1].blockKey,
      'the two rows are distinct blocks',
    );

    const otherRows = rowsOf(sessionStore, OTHER_SESSION);
    assert.equal(otherRows.length, 1, 'the other session is one row for its one block');
    assert.equal(otherRows[0].content, 'theirs reply', "the other session's row holds only its own text");
  });

  it('settles only the block its stream_end names', () => {
    const { dispatch, sessionStore } = renderChat();

    dispatch(delta(OTHER_SESSION, 'first ', 'b:0'));
    dispatch(delta(OTHER_SESSION, 'second', 'b:1'));
    act(() => { vi.advanceTimersByTime(FLUSH_BUDGET_MS); });
    dispatch(streamEnd(OTHER_SESSION, 'b:0'));

    const rows = rowsOf(sessionStore, OTHER_SESSION);
    assert.equal(rows.length, 2, 'the settle must not add or drop a block');
    assert.equal(rows[0].kind, 'text', 'the named block settles');
    assert.equal(rows[0].content, 'first ');
    assert.equal(rows[1].kind, 'stream_delta', 'the block the frame did not name keeps streaming');
    assert.equal(rows[1].content, 'second');
  });
});
