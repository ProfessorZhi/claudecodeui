import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Criterion for AC-212: the session store models its loaded slice as an
 * absolute-index window `[startIndex, endIndex)` over the full history, with an
 * `attached` flag for "pinned to the newest row".
 *
 * Cases (a)-(f):
 *  (a) a tail window extends toward the front (start decreases, end holds)
 *  (b) a middle window detaches; realtime rows buffer and are not rendered
 *  (c) loading forward to the tail re-attaches and shows the buffer once
 *  (d) the cap drops the window end farthest from the focus, start/end follow
 *  (e) a window grown while `total` changes stays aligned by id, not by offset
 *  (f) the tail-attached actions still produce their pre-change outputs
 *
 * The false forms that must redden it: realtime rows merged into the rendered
 * list while detached; a cap trim that leaves `startIndex` stale; a re-attach
 * that draws a buffered row twice.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

type TailOptions = { limit?: number; offset?: number };
type WindowOptions = { around?: string; before?: number; after?: number };
type RequestOptions = TailOptions & WindowOptions;

let HISTORY: NormalizedMessage[] = [];

function row(index: number): NormalizedMessage {
  return {
    id: `m${index}`,
    kind: 'text',
    role: index % 2 === 0 ? 'user' : 'assistant',
    provider: 'claude',
    sessionId: 'session-1',
    content: `message ${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  } as NormalizedMessage;
}

function buildHistory(total: number): NormalizedMessage[] {
  return Array.from({ length: total }, (_, index) => row(index));
}

function liveRow(id: string, timestampMs: number): NormalizedMessage {
  return {
    id,
    kind: 'text',
    role: 'assistant',
    provider: 'claude',
    sessionId: 'session-1',
    content: id,
    timestamp: new Date(timestampMs).toISOString(),
  } as NormalizedMessage;
}

function rangeIds(start: number, end: number): string[] {
  return Array.from({ length: end - start + 1 }, (_, index) => `m${start + index}`);
}

function ok(data: unknown) {
  return { ok: true, json: async () => ({ data }) };
}

/** The server's around read: the inclusive `[x - before, x + after]` slice. */
function windowPayload(aroundId: string, before: number, after: number) {
  const x = Number(aroundId.slice(1));
  const start = Math.max(0, x - before);
  const end = Math.min(HISTORY.length, x + after + 1);
  return ok({
    messages: HISTORY.slice(start, end),
    startIndex: start,
    total: HISTORY.length,
    hasMoreBefore: start > 0,
    hasMoreAfter: end < HISTORY.length,
  });
}

/** The server's tail read: `limit` rows ending at `total - offset`. */
function tailPayload(limit: number, offset: number) {
  const end = Math.max(0, HISTORY.length - offset);
  const start = Math.max(0, end - limit);
  return ok({
    messages: HISTORY.slice(start, end),
    total: HISTORY.length,
    hasMore: start > 0,
  });
}

beforeEach(() => {
  HISTORY = buildHistory(200);
  sessionMessages.mockReset();
  sessionMessages.mockImplementation(async (...args: unknown[]) => {
    const options = (args[1] ?? {}) as RequestOptions;
    if (typeof options.around === 'string') {
      return windowPayload(options.around, options.before ?? 20, options.after ?? 20);
    }
    return tailPayload(options.limit ?? 20, options.offset ?? 0);
  });
});

afterEach(() => {
  vi.resetModules();
});

async function loadTailStore(total: number, limit = 20) {
  HISTORY = buildHistory(total);
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('session-1', { limit, offset: 0 });
  });
  return view;
}

type StoreView = {
  result: {
    current: {
      getMessages: (sessionId: string) => NormalizedMessage[];
    };
  };
};

function renderedIds(view: StoreView, sessionId = 'session-1'): string[] {
  return view.result.current.getMessages(sessionId).map((message) => message.id);
}

describe('session store window model (AC-212)', () => {
  it('(a) extends a tail window toward the front while the tail edge holds', async () => {
    const view = await loadTailStore(200, 20);

    const tail = view.result.current.getSessionSlot('session-1')!;
    assert.equal(tail.attached, true);
    assert.equal(tail.startIndex, 180);
    assert.equal(tail.endIndex, 200);
    assert.equal(tail.total, 200);

    await act(async () => {
      await view.result.current.loadBefore('session-1', { limit: 20 });
    });

    const extended = view.result.current.getSessionSlot('session-1')!;
    assert.equal(extended.startIndex, 160);
    assert.equal(extended.endIndex, 200);
    assert.deepEqual(renderedIds(view), rangeIds(160, 199));
    assert.equal(new Set(renderedIds(view)).size, 40);
    assert.equal(extended.attached, true);
  });

  it('(b) detaches on a middle window and buffers realtime rows instead of rendering them', async () => {
    const view = await loadTailStore(200, 20);

    await act(async () => {
      await view.result.current.loadWindowAround('session-1', 'm60', { before: 10, after: 10 });
    });

    const detached = view.result.current.getSessionSlot('session-1')!;
    assert.equal(detached.attached, false);
    assert.equal(detached.startIndex, 50);
    assert.equal(detached.endIndex, 71);
    assert.equal(detached.total, 200);
    assert.deepEqual(renderedIds(view), rangeIds(50, 70));

    act(() => {
      view.result.current.appendRealtime('session-1', liveRow('live1', Date.UTC(2026, 0, 2)));
      view.result.current.appendRealtime('session-1', liveRow('live2', Date.UTC(2026, 0, 2, 0, 0, 1)));
    });

    assert.deepEqual(renderedIds(view), rangeIds(50, 70));
    assert.equal(view.result.current.getBufferedRealtimeCount('session-1'), 2);
    assert.equal(view.result.current.getSessionSlot('session-1')!.realtimeMessages.length, 2);
  });

  it('(c) re-attaches when the window reaches the tail and shows the buffer once, in order', async () => {
    const view = await loadTailStore(200, 20);

    await act(async () => {
      await view.result.current.loadWindowAround('session-1', 'm60', { before: 10, after: 10 });
    });

    act(() => {
      view.result.current.appendRealtime('session-1', liveRow('live1', Date.UTC(2026, 0, 2)));
      // A row the server itself will report once the window reaches the tail: it must
      // appear once, not once from the buffer and once from the window.
      view.result.current.appendRealtime('session-1', { ...row(150), role: 'assistant' });
    });
    assert.equal(view.result.current.getBufferedRealtimeCount('session-1'), 2);

    await act(async () => {
      await view.result.current.loadAfter('session-1', { limit: 200 });
    });

    const reattached = view.result.current.getSessionSlot('session-1')!;
    assert.equal(reattached.attached, true);
    assert.equal(reattached.endIndex, 200);
    assert.equal(view.result.current.getBufferedRealtimeCount('session-1'), 0);

    const contents = renderedIds(view);
    assert.equal(new Set(contents).size, contents.length);
    assert.equal(contents.filter((id) => id === 'm150').length, 1);
    assert.ok(contents.includes('live1'));
    assert.equal(contents[contents.length - 1], 'live1');
    assert.equal(contents[0], 'm50');
    assert.equal(contents.length, 150 + 1);
  });

  it('(d) drops the cap-farthest window end and keeps start/end consistent with what remains', async () => {
    const view = await loadTailStore(2000, 20);

    // Focus near the newer edge: [1800, 2000), anchored on m1900.
    await act(async () => {
      await view.result.current.loadWindowAround('session-1', 'm1900', { before: 100, after: 100 });
    });
    await act(async () => {
      await view.result.current.loadBefore('session-1', { limit: 200 });
    });
    await act(async () => {
      await view.result.current.loadBefore('session-1', { limit: 200 });
    });

    const slot = view.result.current.getSessionSlot('session-1')!;
    assert.equal(slot.serverMessages.length, 500);
    assert.equal(slot.startIndex, 1500);
    assert.equal(slot.endIndex, 2000);
    assert.equal(slot.serverMessages[0].id, 'm1500');
    assert.equal(slot.serverMessages[499].id, 'm1999');
    assert.deepEqual(renderedIds(view), rangeIds(1500, 1999));
  });

  it('(e) keeps a window grown during a load aligned by id when total changes', async () => {
    const view = await loadTailStore(130, 20);

    // Detach into the middle, well short of the tail.
    await act(async () => {
      await view.result.current.loadWindowAround('session-1', 'm60', { before: 10, after: 10 });
    });
    assert.equal(view.result.current.getSessionSlot('session-1')!.endIndex, 71);

    // A peer appends while the window is about to grow: the read is anchored on
    // the window's last id, so the extension must follow that id rather than
    // arithmetic on the total it was holding when the window was loaded.
    HISTORY = buildHistory(250);

    await act(async () => {
      await view.result.current.loadAfter('session-1', { limit: 20 });
    });

    const slot = view.result.current.getSessionSlot('session-1')!;
    assert.equal(slot.total, 250);
    assert.equal(slot.startIndex, 50);
    assert.equal(slot.endIndex, 91);
    assert.deepEqual(renderedIds(view), rangeIds(50, 90));
    assert.equal(new Set(renderedIds(view)).size, 41);
    assert.equal(slot.attached, false);
  });

  describe('(f) tail-attached behavior is unchanged', () => {
    it('fetchFromServer returns the newest page as before', async () => {
      const view = await loadTailStore(200, 20);
      const slot = view.result.current.getSessionSlot('session-1')!;
      assert.deepEqual(renderedIds(view), rangeIds(180, 199));
      assert.equal(slot.total, 200);
      assert.equal(slot.hasMore, true);
      assert.equal(slot.attached, true);
    });

    it('fetchMore prepends the next older page as before', async () => {
      const view = await loadTailStore(200, 20);
      await act(async () => {
        await view.result.current.fetchMore('session-1', { limit: 20 });
      });
      const slot = view.result.current.getSessionSlot('session-1')!;
      assert.deepEqual(renderedIds(view), rangeIds(160, 199));
      assert.equal(slot.offset, 40);
      assert.equal(slot.startIndex, 160);
      assert.equal(slot.endIndex, 200);
      assert.equal(slot.attached, true);
    });

    it('appendRealtime renders attached realtime rows as before', async () => {
      const view = await loadTailStore(200, 20);
      act(() => {
        view.result.current.appendRealtime('session-1', liveRow('live1', Date.UTC(2026, 0, 2)));
      });
      const contents = renderedIds(view);
      assert.equal(contents.length, 21);
      assert.equal(contents[contents.length - 1], 'live1');
      assert.equal(view.result.current.getBufferedRealtimeCount('session-1'), 0);
    });

    it('truncateAt drops the anchored row and everything after it as before', async () => {
      HISTORY = [
        { ...row(0), role: 'user', transcriptAnchorId: 'u1' },
        { ...row(1), role: 'assistant' },
        { ...row(2), role: 'user', transcriptAnchorId: 'u2' },
        { ...row(3), role: 'assistant' },
      ];
      const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
      const view = renderHook(() => useSessionStore());
      await act(async () => {
        await view.result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
      });

      act(() => {
        view.result.current.truncateAt('session-1', 'u2');
      });

      assert.deepEqual(renderedIds(view), ['m0', 'm1']);
      const slot = view.result.current.getSessionSlot('session-1')!;
      assert.equal(slot.total, 2);
      assert.equal(slot.endIndex, 2);
      assert.equal(slot.attached, true);
    });
  });
});
