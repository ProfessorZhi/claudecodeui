import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * One reply, drawn twice, with a tool row between the two copies.
 *
 * Observed in the browser on a live turn that says something, runs a tool, then
 * says something else: the opening segment is drawn once from the server's
 * `text` frame and once from the row this client streamed it into. Both vanish
 * into one on a page reload, so only the incremental path produces the pair.
 *
 * The three shapes below are driven by *block-keyed* frames — the server names
 * the block each streaming fragment, the block's own settled `text` frame, and
 * the `stream_end` that closes it with the same opaque `blockKey`. That name is
 * what the store joins on: the block buffers as one entity, the settled frame
 * *replaces* its client row in place, and the persisted row a refresh brings in
 * under the same id inherits the name, so the block is one row in all three
 * states and no text-equality guess is involved.
 *
 * What the old path did — and still does for any frame the server did not name —
 * is reproduced by the `it.fails` cases: the live row was re-stamped with the
 * client's clock on every flush, so its last stamp was newer than the tool row
 * the server had already sent, merged order became `[echo, tool, live]`, and
 * `dedupeAdjacentAssistantEchoes` — which only folds *adjacent* rows — matched
 * nothing. Those cases are kept, marked as failing, so that the day the
 * unkeyed providers (codex / cursor / opencode, and any older server) get a
 * block identity the gap turns red and is not quietly forgotten.
 *
 * Every case drives the store through its own public methods with `Date` pinned,
 * so each states the one ordering it is about instead of racing a real clock.
 * The two controls at the end must hold before and after any fix: the same
 * words in the adjacent order already collapse, and two different turns that
 * read the same are two replies.
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
const SEGMENT = 'the opening segment';
/** The server's name for the turn's first content block; opaque to the client. */
const BLOCK_ONE = 'msg-1:0';
/** A second block of the same turn — same message id, next index. */
const BLOCK_TWO = 'msg-1:1';
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

const msg = (over: Partial<NormalizedMessage>): NormalizedMessage => ({
  provider: 'claude',
  sessionId: SID,
  ...over,
} as NormalizedMessage);

const userRow = (id: string, offsetMs: number) => msg({
  id,
  kind: 'text',
  role: 'user',
  content: `prompt ${id}`,
  timestamp: at(offsetMs),
  transcriptAnchorId: `anchor-${id}`,
});

/** The server's settled `text` frame (or persisted row) for a block. */
const echoRow = (id: string, content: string, offsetMs: number, blockKey?: string) => msg({
  id,
  kind: 'text',
  role: 'assistant',
  content,
  timestamp: at(offsetMs),
  ...(blockKey ? { blockKey } : {}),
});

const toolRow = (id: string, offsetMs: number) => msg({
  id,
  kind: 'tool_use',
  toolId: `tool-${id}`,
  toolName: 'Bash',
  toolInput: { command: 'sleep 8' },
  timestamp: at(offsetMs),
});

const historyOf = (messages: NormalizedMessage[]) => ({
  ok: true,
  json: async () => ({ data: { messages, total: messages.length, hasMore: false } }),
});

const rowsWithText = (rows: NormalizedMessage[], content: string) =>
  rows.filter((row) => row.kind !== 'tool_use' && row.content === content && row.role !== 'user');

/** The assistant rows the transcript would draw, in order, whatever they say. */
const assistantRows = (rows: NormalizedMessage[]) =>
  rows.filter((row) => row.kind !== 'tool_use' && row.role !== 'user');

const describeOrder = (rows: NormalizedMessage[]) =>
  rows.map((row) => `${row.kind}:${row.id}`).join(' → ');

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue(historyOf([]));
  // Only `Date` is pinned: the store reads the wall clock when it stamps a live
  // row, and that read is the thing under test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(BASE);
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

/**
 * A store whose slot already holds the persisted prompt row.
 *
 * That is the ordinary state of a conversation by the time its first reply
 * streams: the session page has fetched its history, and the prompt is on disk.
 * It matters here because `computeMerged` only sorts by timestamp once the slot
 * has server rows; with none, realtime rows keep their arrival order and the
 * pair below is adjacent by construction (see the first lines of
 * `computeMerged`), which would hide the defect rather than test for it.
 */
async function freshStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  sessionMessages.mockResolvedValue(historyOf([userRow('u1', -1000)]));
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer(SID, { limit: 20, offset: 0 });
  });
  return view;
}

type StoreView = Awaited<ReturnType<typeof freshStore>>;

/**
 * One block-keyed turn, in the order the frames reach the store:
 *
 *   t=firstDeltaAt   a delta flush mints the block's live row, stamped with the
 *                    frame's own (server) timestamp
 *   t=terminalAt     the settled `text` frame for that block — its own id, its
 *                    own timestamp, the same `blockKey` — replaces the row
 *   t=settleAt       `stream_end`: a straggling flush must not resurrect the
 *                    block, and the settle finds it already settled
 *
 * The client's settle is placed *after* the tool frame's stamp on purpose: that
 * is the frame order the defect needs, and it is the ordinary one, because the
 * server's tool frame is already on its way when `stream_end` runs.
 */
function streamBlock(view: StoreView, opts: {
  blockKey: string;
  segment: string;
  terminalId: string;
  terminalAt: number;
  settleAt: number;
}) {
  const store = view.result.current;

  vi.setSystemTime(BASE);
  act(() => {
    store.updateStreaming(SID, opts.segment, 'claude', {
      blockKey: opts.blockKey,
      timestamp: at(0),
    });
  });

  act(() => {
    store.appendRealtime(SID, echoRow(opts.terminalId, opts.segment, opts.terminalAt, opts.blockKey));
  });

  vi.setSystemTime(BASE + opts.settleAt);
  act(() => {
    store.updateStreaming(SID, opts.segment, 'claude', {
      blockKey: opts.blockKey,
      timestamp: at(opts.settleAt),
    });
    store.finalizeStreaming(SID, { blockKey: opts.blockKey });
  });
}

describe('a block-keyed segment whose settled frame has a tool row after it', () => {
  it('draws the segment once, under the settled frame\'s own id', async () => {
    const view = await freshStore();
    streamBlock(view, { blockKey: BLOCK_ONE, segment: SEGMENT, terminalId: 'srv-seg1', terminalAt: 640, settleAt: 700 });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool1', 641)); });

    const rows = view.result.current.getMessages(SID);
    const segments = rowsWithText(rows, SEGMENT);
    assert.equal(
      segments.length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
    // Count alone would also be satisfied by the live row surviving and the
    // settled frame being dropped. The survivor has to be the settled frame's
    // row, which is the id the persisted transcript row will carry.
    assert.equal(
      segments[0].id,
      'srv-seg1',
      `the survivor must be the settled frame's row, got: ${describeOrder(rows)}`,
    );
    assert.equal(
      segments[0].blockKey,
      BLOCK_ONE,
      'the survivor must still carry the block it is one state of',
    );
  });

  it('draws the segment once when the settled row lands between two tool rows', async () => {
    const view = await freshStore();
    streamBlock(view, { blockKey: BLOCK_ONE, segment: SEGMENT, terminalId: 'srv-seg1', terminalAt: 640, settleAt: 700 });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool1', 641)); });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool2', 800)); });

    const rows = view.result.current.getMessages(SID);
    const segments = rowsWithText(rows, SEGMENT);
    assert.equal(
      segments.length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
    assert.equal(
      segments[0].id,
      'srv-seg1',
      `the survivor must be the settled frame's row, got: ${describeOrder(rows)}`,
    );
  });

  it('draws the segment once when a server refresh brings the settled frame and the tool row in', async () => {
    const view = await freshStore();
    const store = view.result.current;

    // No realtime `text` frame at all: the client only streamed the segment, and
    // the persisted copy arrives through a tail refresh (the switch-back path).
    vi.setSystemTime(BASE);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude', { blockKey: BLOCK_ONE, timestamp: at(0) });
    });
    vi.setSystemTime(BASE + 700);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude', { blockKey: BLOCK_ONE, timestamp: at(700) });
      store.finalizeStreaming(SID, { blockKey: BLOCK_ONE });
    });

    sessionMessages.mockResolvedValue(historyOf([
      userRow('u1', -1000),
      echoRow('srv-seg1', SEGMENT, 640),
      toolRow('srv-tool1', 641),
    ]));
    await act(async () => {
      await store.fetchFromServer(SID, { limit: 20, offset: 0 });
    });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `the segment must be one row, got: ${describeOrder(rows)}`,
    );
  });
});

describe('a block-keyed turn that says two things', () => {
  it('keeps the block\'s first-delta timestamp across flushes and takes the settled frame\'s on handover', async () => {
    const view = await freshStore();
    const store = view.result.current;

    vi.setSystemTime(BASE + 500);
    act(() => {
      store.updateStreaming(SID, 'he', 'claude', { blockKey: BLOCK_ONE, timestamp: at(10) });
    });
    const opened = rowsWithText(store.getMessages(SID), 'he')[0];
    assert.equal(opened.timestamp, at(10), 'the row is stamped with the block\'s first frame');

    // A later flush carries a later frame stamp. The block's clock is the one it
    // opened on; re-stamping here is what used to push the row past the tool row.
    vi.setSystemTime(BASE + 600);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude', { blockKey: BLOCK_ONE, timestamp: at(600) });
    });
    const flushed = rowsWithText(store.getMessages(SID), SEGMENT)[0];
    assert.equal(flushed.timestamp, at(10), 'a flush must not re-stamp the block');

    // The settled frame is the block's own record, so its clock takes over.
    act(() => {
      store.appendRealtime(SID, echoRow('srv-seg1', SEGMENT, 640, BLOCK_ONE));
    });
    const settled = rowsWithText(store.getMessages(SID), SEGMENT)[0];
    assert.equal(settled.id, 'srv-seg1');
    assert.equal(settled.timestamp, at(640), 'the handover takes the settled frame\'s timestamp');
  });

  it('draws a tool row between the two blocks as its own row, and the blocks as two', async () => {
    const view = await freshStore();
    const store = view.result.current;

    vi.setSystemTime(BASE + 100);
    act(() => {
      store.updateStreaming(SID, 'the opening segment', 'claude', { blockKey: BLOCK_ONE, timestamp: at(10) });
    });
    act(() => {
      store.appendRealtime(SID, echoRow('srv-seg1', 'the opening segment', 640, BLOCK_ONE));
    });
    act(() => { store.appendRealtime(SID, toolRow('srv-tool1', 641)); });

    vi.setSystemTime(BASE + 800);
    act(() => {
      store.updateStreaming(SID, 'the closing segment', 'claude', { blockKey: BLOCK_TWO, timestamp: at(800) });
    });
    act(() => {
      store.appendRealtime(SID, echoRow('srv-seg2', 'the closing segment', 810, BLOCK_TWO));
    });

    const rows = store.getMessages(SID);
    assert.equal(rowsWithText(rows, 'the opening segment').length, 1, describeOrder(rows));
    assert.equal(rowsWithText(rows, 'the closing segment').length, 1, describeOrder(rows));
    const ids = assistantRows(rows).map((row) => row.id);
    assert.equal(ids.length, 2, `two blocks are two rows, got: ${describeOrder(rows)}`);
    assert.notEqual(ids[0], ids[1], 'the two blocks must not share a row identity');
  });

  it('does not fold two blocks of one turn that read the same', async () => {
    const view = await freshStore();
    const store = view.result.current;

    vi.setSystemTime(BASE + 100);
    act(() => {
      store.updateStreaming(SID, 'same words', 'claude', { blockKey: BLOCK_ONE, timestamp: at(10) });
    });
    vi.setSystemTime(BASE + 200);
    act(() => {
      store.updateStreaming(SID, 'same words', 'claude', { blockKey: BLOCK_TWO, timestamp: at(110) });
    });

    // Settle both, so the pair reaches the adjacency pass as two assistant text
    // rows with identical content — the shape a text-equality collapse would
    // happily fold into one, deleting a segment the reader watched arrive.
    act(() => { store.finalizeStreaming(SID, { blockKey: BLOCK_ONE }); });
    act(() => { store.finalizeStreaming(SID, { blockKey: BLOCK_TWO }); });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, 'same words').length,
      2,
      `two named blocks are two rows however alike they read, got: ${describeOrder(rows)}`,
    );
  });
});

describe('the same shapes on frames the server did not key', () => {
  /**
   * The pre-fix frame path, verbatim: one live row per session, re-stamped with
   * the client's clock on every flush, settled by `stream_end`. Kept as the
   * failing baseline for the providers that still publish no block.
   */
  function runSegmentThenTool(view: StoreView, opts: { echoAt: number; toolAt: number; settleAt: number }) {
    const store = view.result.current;
    vi.setSystemTime(BASE);
    act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });

    act(() => { store.appendRealtime(SID, echoRow('srv-seg1', SEGMENT, opts.echoAt)); });

    vi.setSystemTime(BASE + opts.settleAt);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude');
      store.finalizeStreaming(SID);
    });

    act(() => { store.appendRealtime(SID, toolRow('srv-tool1', opts.toolAt)); });
  }

  it.fails('KNOWN GAP: without a block key the segment is still drawn twice', async () => {
    const view = await freshStore();

    // Server stamps: text at +640, tool at +641. Client settles at +700, so the
    // live row's last stamp (+700) is newer than the tool row's (+641).
    runSegmentThenTool(view, { echoAt: 640, toolAt: 641, settleAt: 700 });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `KNOWN GAP (codex / cursor / opencode publish no blockKey): got: ${describeOrder(rows)}`,
    );
  });

  it.fails('KNOWN GAP: without a block key the live row still lands between two tool rows', async () => {
    const view = await freshStore();

    runSegmentThenTool(view, { echoAt: 640, toolAt: 641, settleAt: 700 });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool2', 800)); });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `KNOWN GAP (codex / cursor / opencode publish no blockKey): got: ${describeOrder(rows)}`,
    );
  });

  it.fails('KNOWN GAP: without a block key a refresh still brings the echo in beside the live row', async () => {
    const view = await freshStore();
    const store = view.result.current;

    vi.setSystemTime(BASE);
    act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });
    vi.setSystemTime(BASE + 700);
    act(() => {
      store.updateStreaming(SID, SEGMENT, 'claude');
      store.finalizeStreaming(SID);
    });

    sessionMessages.mockResolvedValue(historyOf([
      userRow('u1', -1000),
      echoRow('srv-seg1', SEGMENT, 640),
      toolRow('srv-tool1', 641),
    ]));
    await act(async () => {
      await store.fetchFromServer(SID, { limit: 20, offset: 0 });
    });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `KNOWN GAP (codex / cursor / opencode publish no blockKey): got: ${describeOrder(rows)}`,
    );
  });
});

describe('controls that must hold before and after any fix', () => {
  it('already collapses the same pair when no tool row sits between them', async () => {
    const view = await freshStore();

    // A block-keyed turn, but the tool row is stamped after the block settled:
    // merged order is `[echo, live, tool]`, adjacent, which the existing rule
    // folds even without the block join.
    streamBlock(view, { blockKey: BLOCK_ONE, segment: SEGMENT, terminalId: 'srv-seg1', terminalAt: 640, settleAt: 700 });
    act(() => { view.result.current.appendRealtime(SID, toolRow('srv-tool1', 800)); });

    const rows = view.result.current.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      1,
      `adjacent order is the already-handled shape, got: ${describeOrder(rows)}`,
    );
  });

  it('keeps two different turns that read the same as two replies', async () => {
    const view = await freshStore();
    const store = view.result.current;

    // Turn 1 settled and persisted; turn 2 (after a second prompt) says the same
    // words. A fix that folds across a tool row must not fold across a user row.
    act(() => { store.appendRealtime(SID, echoRow('srv-seg1', SEGMENT, 100)); });
    act(() => { store.appendRealtime(SID, toolRow('srv-tool1', 200)); });
    act(() => { store.appendRealtime(SID, userRow('u2', 300)); });
    vi.setSystemTime(BASE + 400);
    act(() => { store.updateStreaming(SID, SEGMENT, 'claude'); });

    const rows = store.getMessages(SID);
    assert.equal(
      rowsWithText(rows, SEGMENT).length,
      2,
      `two turns are two replies, got: ${describeOrder(rows)}`,
    );
  });
});
