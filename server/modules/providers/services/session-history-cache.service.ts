import fsp from 'node:fs/promises';

import type { FetchHistoryResult } from '@/shared/types.js';

/**
 * Full-transcript cache for session history reads.
 *
 * Every provider history reader materializes the complete normalized
 * transcript and then slices out the requested page, so serving a 20-row page
 * of a large session re-read and re-parsed the whole transcript file on every
 * request — opening a session, each older page while scrolling up, and every
 * post-turn refresh. For a multi-megabyte JSONL that is most of a second of
 * CPU per request.
 *
 * Entries are keyed by app session id and validated with one `stat` per
 * request against the transcript file's identity (path + mtime + size), so
 * only the first read after the file changes pays the parse. A reader that can
 * resume from a byte offset leaves a token on its entry (`resume`) and is
 * handed it back through a per-load context on the next reload, so a plain
 * append re-parses only the new tail; anything else (truncation, rewrite,
 * mtime backwards) makes the reader fall back and it re-parses the file whole.
 *
 * Only history readers that read `jsonl_path` itself may use this cache —
 * callers pass `transcriptPath: null` for providers whose messages live
 * elsewhere (Cursor's store.db, OpenCode's shared SQLite), which bypasses
 * caching entirely.
 */

type CacheEntry = {
  transcriptPath: string;
  mtimeMs: number;
  /** File size in bytes; doubles as the entry's cost against the byte budget. */
  size: number;
  /**
   * Whether the session was running when `full` was read. Part of the entry's
   * identity, not just its payload: a running read withholds the last turn's
   * `forkAnchorId`, so serving it back after the run ends (the file is
   * unchanged for a beat) would hand the client a final reply with no fork
   * button — and the reverse would offer a fork into a half-written turn.
   */
  running: boolean;
  full: FetchHistoryResult;
  /**
   * Opaque parse state the reader returned for `full`, handed back to it on the
   * next reload so a plain append can resume from the previous offset. Absent
   * when the reader cannot resume.
   */
  resume?: unknown;
};

type GetFullHistoryArgs = {
  sessionId: string;
  /** Path of the file the provider's history reader actually parses, or null to bypass. */
  transcriptPath: string | null | undefined;
  /**
   * Whether the session's run is in flight right now. Rides the entry identity
   * so a running/idle flip re-reads rather than serving the other's result.
   */
  running?: boolean;
  /** Loads the complete transcript (`limit: null, offset: 0`) from the provider. */
  loadFull: () => Promise<FetchHistoryResult>;
};

/**
 * Per-session scratch the cache publishes around one full read.
 *
 * `getFullHistory` installs one immediately before calling the reader's
 * `loadFull`, and removes it once the read settles. A reader that can resume
 * from a byte offset calls `takeHistoryLoadContext(sessionId)` to read
 * `previous` (the parse state the entry being replaced carried) and to publish
 * the state its own parse produced on `producedResume`. Readers that cannot
 * resume ignore it, and a read that did not go through the cache finds none.
 */
export type HistoryLoadContext = {
  previous: { resume: unknown; size: number; mtimeMs: number } | null;
  producedResume: unknown;
};

const loadContexts = new Map<string, HistoryLoadContext>();

/**
 * Returns the in-flight load context for `sessionId`, or null when no cache
 * reload is in flight for it.
 *
 * Consumed by `claude-sessions.provider`'s history reader. The returned object
 * is live: a reader hands its resume token back by assigning `producedResume`.
 */
export function takeHistoryLoadContext(sessionId: string): HistoryLoadContext | null {
  return loadContexts.get(sessionId) ?? null;
}

/**
 * A transcript entry's heap cost is roughly the file it was parsed from, so
 * the budget is expressed in file bytes. The newest entry is always retained
 * even when it alone exceeds the budget — evicting it would just re-parse the
 * same file on the next request.
 */
const MAX_CACHED_TRANSCRIPT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;

export function createSessionHistoryCache(
  maxTotalFileBytes = MAX_CACHED_TRANSCRIPT_FILE_BYTES,
  maxEntries = MAX_CACHE_ENTRIES,
) {
  const entries = new Map<string, CacheEntry>();
  const pendingLoads = new Map<string, Promise<FetchHistoryResult>>();

  function evictOverBudget(): void {
    let totalBytes = 0;
    for (const entry of entries.values()) {
      totalBytes += entry.size;
    }
    for (const key of entries.keys()) {
      if (entries.size <= 1 || (totalBytes <= maxTotalFileBytes && entries.size <= maxEntries)) {
        break;
      }
      totalBytes -= entries.get(key)!.size;
      entries.delete(key);
    }
  }

  return {
    /**
     * Returns the session's full transcript through the cache, or null when
     * the session is not cacheable (no transcript path, or the file cannot be
     * stat'ed) — the caller then falls back to a plain provider read.
     */
    async getFullHistory({ sessionId, transcriptPath, running = false, loadFull }: GetFullHistoryArgs): Promise<FetchHistoryResult | null> {
      if (!transcriptPath) {
        return null;
      }

      let stat;
      try {
        stat = await fsp.stat(transcriptPath);
      } catch {
        entries.delete(sessionId);
        return null;
      }
      if (!stat.isFile()) {
        entries.delete(sessionId);
        return null;
      }

      const cached = entries.get(sessionId);
      if (
        cached
        && cached.transcriptPath === transcriptPath
        && cached.mtimeMs === stat.mtimeMs
        && cached.size === stat.size
        && cached.running === running
      ) {
        // Re-insert to mark as most recently used.
        entries.delete(sessionId);
        entries.set(sessionId, cached);
        return cached.full;
      }

      // Concurrent requests for the same session share one parse. The file may
      // gain rows while the load runs; the pre-load stat is what the entry is
      // keyed by, so the next request would see a changed stat and re-read.
      const pending = pendingLoads.get(sessionId);
      if (pending) {
        return pending;
      }

      // The reader sees the entry being replaced (its resume, size and mtime)
      // and can publish the state its own parse produced. Installed before the
      // load starts and removed once it settles, so a reader invoked outside
      // the cache — a direct provider read — finds nothing and parses whole.
      const context: HistoryLoadContext = {
        previous: cached
          ? { resume: cached.resume, size: cached.size, mtimeMs: cached.mtimeMs }
          : null,
        producedResume: undefined,
      };
      loadContexts.set(sessionId, context);

      const load = loadFull()
        .then((full) => {
          entries.delete(sessionId);
          entries.set(sessionId, {
            transcriptPath,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            running,
            full,
            resume: context.producedResume,
          });
          evictOverBudget();
          return full;
        })
        .finally(() => {
          loadContexts.delete(sessionId);
        });
      pendingLoads.set(sessionId, load);
      try {
        return await load;
      } finally {
        pendingLoads.delete(sessionId);
      }
    },
  };
}

export const sessionHistoryCache = createSessionHistoryCache();
