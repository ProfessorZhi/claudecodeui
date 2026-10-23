/**
 * The row fields lineage grouping reads and writes. Every field is optional, so
 * any list row that names a branch origin structurally satisfies it:
 * `SessionWithProvider` carries them as `__lineage*`, and a recent-conversations
 * row carries only `forkedFromSessionId`.
 */
export type LineageRow = {
  forkedFromSessionId?: string | null;
  __lineageDepth?: number;
  __lineageSiblingIndex?: number;
  __lineageSiblingCount?: number;
};

/**
 * Reorders a recency-sorted session list so a forked session sits directly
 * beneath the session it was branched from.
 *
 * Forking copies a conversation and leaves the copy its source's name, so a
 * plain recency sort scatters the pair and the sidebar shows two rows a reader
 * cannot tell apart. Grouping puts them together; the branch marker the row
 * draws is the only signal that survives name truncation.
 *
 * A group is anchored at its NEWEST member, not at its source: the whole group
 * moves to the slot that member would have occupied on its own. A branch is
 * usually the session still in use, and anchoring on the source would push the
 * work someone just did down the list behind an older conversation. The cost is
 * that the top level is no longer a pure time order — an older source can be
 * lifted by a newer branch under it.
 *
 * Two rows are left untouched:
 *
 * - a fork whose source is not in this list, because both lists are paged (a
 *   source that has not been loaded yet must not hide the fork); and
 * - a fork whose source chain loops back on itself, which no well-formed
 *   transcript produces but a hand-edited row could.
 *
 * A branch comes back carrying its nesting level in `__lineageDepth`, plus its
 * 1-based ordinal among its source's branches and how many there are, so a row
 * can show a branch number once a source has been forked more than once.
 * Unbranched sessions keep the exact object they arrived with.
 *
 * Used by `getAllSessions` in the sidebar's project-formatting utilities and by
 * SidebarRecentConversations for the cross-project recents list.
 */
export const groupSessionsByLineage = <TRow extends LineageRow>(
  sessions: TRow[],
  getSessionId: (row: TRow) => string,
): Array<TRow & LineageRow> => {
  if (sessions.length < 2) {
    return sessions;
  }

  const byId = new Map(sessions.map((session) => [getSessionId(session), session]));
  // Position each session arrived at, i.e. its recency rank. The input is
  // already recency-sorted, so the smallest rank in a lineage group is the
  // group's anchor: a group floats to wherever its most recently used member
  // would have sat, which keeps a just-used branch near the top instead of
  // burying it under a source that has not been touched since.
  const rankOf = new Map(sessions.map((session, index) => [getSessionId(session), index]));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, TRow[]>();

  /** Whether walking up from `startId` reaches `targetId`, i.e. the edge closes a loop. */
  const reaches = (startId: string, targetId: string): boolean => {
    const seen = new Set<string>();
    // Bound the walk by the visited set rather than by a depth: a cycle has no
    // natural end, and the set is also what keeps a malformed chain from hanging.
    let cursor: string | null | undefined = startId;
    while (cursor && !seen.has(cursor)) {
      if (cursor === targetId) {
        return true;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)?.forkedFromSessionId;
    }
    return false;
  };

  for (const session of sessions) {
    const id = getSessionId(session);
    const sourceId = session.forkedFromSessionId;
    if (!sourceId || sourceId === id || !byId.has(sourceId)) {
      continue;
    }
    if (reaches(sourceId, id)) {
      continue;
    }

    parentOf.set(id, sourceId);
    const siblings = childrenOf.get(sourceId);
    if (siblings) {
      siblings.push(session);
    } else {
      childrenOf.set(sourceId, [session]);
    }
  }

  if (parentOf.size === 0) {
    return sessions;
  }

  /** Recency rank of the newest session in this group. `parentOf` is acyclic, so this terminates. */
  const anchorRank = (id: string): number => {
    let rank = rankOf.get(id) ?? Number.MAX_SAFE_INTEGER;
    for (const child of childrenOf.get(id) ?? []) {
      rank = Math.min(rank, anchorRank(getSessionId(child)));
    }
    return rank;
  };

  const ordered: Array<TRow & LineageRow> = [];
  const placed = new Set<string>();
  const place = (session: TRow, depth: number): void => {
    const id = getSessionId(session);
    if (placed.has(id)) {
      return;
    }
    placed.add(id);
    if (depth === 0) {
      ordered.push(session);
    } else {
      // Siblings arrive in recency order, so their position in the list is the
      // ordinal the row's marker shows once a source has more than one branch.
      const siblings = childrenOf.get(parentOf.get(id) ?? '') ?? [];
      ordered.push({
        ...session,
        __lineageDepth: depth,
        __lineageSiblingIndex: siblings.indexOf(session) + 1,
        __lineageSiblingCount: siblings.length,
      });
    }
    for (const child of childrenOf.get(id) ?? []) {
      place(child, depth + 1);
    }
  };

  // A group takes the slot of its newest member, so a freshly used branch is
  // not pushed down the list by an older source it was branched from.
  const roots = sessions.filter((session) => !parentOf.has(getSessionId(session)));
  for (const root of [...roots].sort((a, b) => anchorRank(getSessionId(a)) - anchorRank(getSessionId(b)))) {
    place(root, 0);
  }
  // Anything still unplaced was only reachable through a loop; show it rather
  // than silently dropping a session out of the sidebar.
  for (const session of sessions) {
    place(session, 0);
  }

  return ordered;
};
