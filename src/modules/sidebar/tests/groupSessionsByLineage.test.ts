import assert from 'node:assert/strict';

import { test } from 'vitest';

import { groupSessionsByLineage } from '@/modules/sidebar/utils/groupSessionsByLineage';
import type { SessionWithProvider } from '@/shared/types';

/**
 * The sidebar's fork grouping. The cases that matter are the ones a live project
 * actually produces — a pair, a chain, a source forked twice — plus the two
 * shapes that must NOT be touched: a fork whose source is on an unloaded page,
 * and a malformed cycle.
 */

const session = (
  id: string,
  forkedFromSessionId: string | null = null,
): SessionWithProvider => ({
  id,
  summary: id,
  __provider: 'claude',
  forkedFromSessionId,
});

const grouped = (sessions: SessionWithProvider[]) =>
  groupSessionsByLineage(sessions, (row) => row.id);

/** Ids in render order, which is what the sidebar actually consumes. */
const idsOf = (sessions: SessionWithProvider[]) => sessions.map((s) => s.id);
const depthOf = (sessions: ReturnType<typeof grouped>, id: string) =>
  sessions.find((s) => s.id === id)?.__lineageDepth ?? 0;

test('lifts a fork out of its recency slot to sit under its source', () => {
  // Recency order puts the fork (newest) first; grouping must move it below.
  const result = grouped([
    session('fork', 'source'),
    session('unrelated'),
    session('source'),
  ]);

  assert.deepEqual(idsOf(result), ['source', 'fork', 'unrelated']);
  assert.equal(depthOf(result, 'fork'), 1);
  assert.equal(depthOf(result, 'source'), 0);
});

test('anchors the whole group at its newest member', () => {
  // The branch is the newest session and its source the oldest. Anchoring on the
  // source would sink the pair to last; anchoring on the newest member keeps the
  // work someone just did at the top, where recency says it belongs.
  const result = grouped([
    session('fork', 'source'),
    session('middle-unrelated'),
    session('oldest-unrelated'),
    session('source'),
  ]);

  assert.deepEqual(idsOf(result), ['source', 'fork', 'middle-unrelated', 'oldest-unrelated']);
});

test('sinks a group whose newest member is older than its neighbours', () => {
  // The counterexample to the case above: the group must not be pinned to the
  // top just for being a group. Its slot is its newest member's slot, wherever
  // that is — here the branch is older than the row already above it.
  const result = grouped([
    session('newest-unrelated'),
    session('fork', 'source'),
    session('source'),
  ]);

  assert.deepEqual(idsOf(result), ['newest-unrelated', 'source', 'fork']);
});

test('numbers the branches of a source that was forked more than once', () => {
  const result = grouped([
    session('first-branch', 'source'),
    session('second-branch', 'source'),
    session('source'),
  ]);

  const first = result.find((s) => s.id === 'first-branch');
  const second = result.find((s) => s.id === 'second-branch');
  assert.equal(first?.__lineageSiblingIndex, 1);
  assert.equal(second?.__lineageSiblingIndex, 2);
  assert.equal(first?.__lineageSiblingCount, 2);
  assert.equal(second?.__lineageSiblingCount, 2);
});

test('counts a lone branch as one, so the row shows the glyph and not a number', () => {
  const result = grouped([session('only-branch', 'source'), session('source')]);

  const only = result.find((s) => s.id === 'only-branch');
  assert.equal(only?.__lineageSiblingIndex, 1);
  assert.equal(only?.__lineageSiblingCount, 1);
});

test('keeps an unbranched session object identical', () => {
  const plain = session('plain');
  const result = grouped([plain, session('fork', 'source'), session('source')]);

  // The sidebar memoizes rows; a needless copy would re-render every row.
  assert.equal(result.find((s) => s.id === 'plain'), plain);
  assert.ok(!('__lineageDepth' in plain));
});

test('leaves a fork in place when its source is not in this page', () => {
  // Session lists are paged, so the source may simply not be loaded yet. The
  // fork must stay visible rather than vanish behind an absent parent.
  const result = grouped([session('fork', 'not-loaded'), session('other')]);

  assert.deepEqual(idsOf(result), ['fork', 'other']);
  assert.equal(depthOf(result, 'fork'), 0);
});

test('nests a fork of a fork', () => {
  const result = grouped([
    session('second-fork', 'fork'),
    session('fork', 'source'),
    session('source'),
  ]);

  assert.deepEqual(idsOf(result), ['source', 'fork', 'second-fork']);
  assert.equal(depthOf(result, 'fork'), 1);
  assert.equal(depthOf(result, 'second-fork'), 2);
});

test('does not drop sessions when a fork chain loops', () => {
  // No transcript produces this, but a hand-edited row could, and a session that
  // silently disappeared from the sidebar would be hard to explain.
  const result = grouped([session('a', 'b'), session('b', 'a'), session('c')]);

  assert.equal(result.length, 3);
  assert.deepEqual([...idsOf(result)].sort(), ['a', 'b', 'c']);
});

test('treats a self-referencing fork as unbranched', () => {
  const result = grouped([session('self', 'self'), session('other')]);

  assert.deepEqual(idsOf(result), ['self', 'other']);
  assert.equal(depthOf(result, 'self'), 0);
});

test('returns the input array untouched when nothing is branched', () => {
  const sessions = [session('a'), session('b')];

  assert.equal(grouped(sessions), sessions);
});

test('orders sibling forks by the recency they arrived in', () => {
  const result = grouped([
    session('newer-fork', 'source'),
    session('older-fork', 'source'),
    session('source'),
  ]);

  assert.deepEqual(idsOf(result), ['source', 'newer-fork', 'older-fork']);
});

test('groups rows keyed by any accessor, as the recents list needs', () => {
  // The recents list keys its rows by `sessionId`, not `id`; the grouping must
  // not assume the project-list field name.
  const rows = [
    { sessionId: 'fork', forkedFromSessionId: 'source' },
    { sessionId: 'source', forkedFromSessionId: null },
  ];

  const result = groupSessionsByLineage(rows, (row) => row.sessionId);

  assert.deepEqual(result.map((row) => row.sessionId), ['source', 'fork']);
  assert.equal(result[1].__lineageDepth, 1);
  assert.equal(result[1].__lineageSiblingCount, 1);
});
