import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { DEBUG_AGENT_PROVIDER_ID, getDebugAgentProjectsRoot } from '@/modules/debug-agent/index.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';

type WatcherEventType = 'add' | 'change';

/** Where a provider's session artifacts live. Exported for the gate criterion. */
export type ProviderWatchPath = { provider: LLMProvider; rootPath: string };

const PROVIDER_WATCH_PATHS: ProviderWatchPath[] = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
];

/**
 * The roots actually observed in this process, product roots plus the debug
 * agent's fixture root when the gate is open.
 *
 * ADR-003 decision 3, face 2 — "watcher 没有根". A closed gate yields no path at
 * all, so the fixture root is neither observed nor `mkdir`ed by the watcher, and
 * no `session_upserted` can be broadcast because a scenario advanced. Rootless
 * is the point: an observed-but-ignored root would still create the directory
 * and would still be a root.
 *
 * Duplicates are collapsed by resolved path. Two watchers on one directory
 * deliver every event twice, and the debug agent's fixture root is a directory a
 * caller may legitimately have pointed at an existing root.
 *
 * Exported for the gate criterion (`tests/debug-agent-gate.test.ts`), which
 * reads this set on both sides of the gate.
 */
export function resolveProviderWatchPaths(): ProviderWatchPath[] {
  const roots: ProviderWatchPath[] = [...PROVIDER_WATCH_PATHS];

  const debugAgentRoot = getDebugAgentProjectsRoot();
  if (debugAgentRoot) {
    roots.push({ provider: DEBUG_AGENT_PROVIDER_ID as LLMProvider, rootPath: debugAgentRoot });
  }

  const seen = new Set<string>();
  return roots.filter(({ rootPath }) => {
    const key = path.resolve(rootPath);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

/**
 * Creates every root in `resolveProviderWatchPaths()`, and returns the set it
 * created them for.
 *
 * This is the step that would materialise the fixture root if it were listed,
 * which is why the gate criterion calls it rather than asserting on the list
 * alone: "not listed" and "not created" are two readings of one decision, and
 * the criterion prints both.
 */
export async function ensureProviderWatchRoots(): Promise<ProviderWatchPath[]> {
  const ensured: ProviderWatchPath[] = [];

  for (const path of resolveProviderWatchPaths()) {
    try {
      await fsPromises.mkdir(path.rootPath, { recursive: true });
      ensured.push(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${path.provider}"`, {
        rootPath: path.rootPath,
        error: message,
      });
    }
  }

  return ensured;
}

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/subagents/**',
  '**/tool-results/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

/** How deep the watcher's walk goes into each root. */
const WATCH_DEPTH = 6;

/**
 * Selects the watcher's mechanism: `auto` (default), `native`, or `poll`.
 *
 * `auto` probes each root and prefers native events; `native` demands them and
 * refuses to start rather than degrade; `poll` is the escape hatch for a
 * container or network filesystem where native events are known to be
 * unreliable, and it reproduces the pre-2026 behaviour exactly (a 6 s sweep).
 */
const WATCHER_MODE_ENV_VAR = 'CLOUDCLI_WATCHER_MODE';

/**
 * The polling period this service used unconditionally before the mode split,
 * and the floor the file-count backoff never goes below.
 */
export const POLL_INTERVAL_MIN_MS = 6_000;

/**
 * The ceiling the backoff clamps to (60 s).
 *
 * The interval bounds how long an appended transcript row can sit unindexed and
 * therefore how long a running client waits for its `session_upserted`. An
 * unbounded backoff would trade idle CPU for an unbounded notification delay, so
 * the trade stops here instead of scaling forever with the corpus.
 */
export const POLL_INTERVAL_MAX_MS = 60_000;

/**
 * The corpus size the 6 s floor was measured against: `~/.claude/projects` held
 * 2 186 tracked files on 2026-09-25, the largest tree this watcher polls on the
 * development machine.
 *
 * It anchors the backoff rather than being a tunable. One polling sweep costs
 * roughly one `stat` per tracked file, so holding the idle duty cycle constant
 * as the corpus grows means scaling the period linearly with the file count —
 * and the duty cycle worth holding constant is the one 6 000 ms already produces
 * at this size. The two-arm measurement behind that claim is in the task's
 * Evidence.
 */
const POLL_INTERVAL_REFERENCE_FILES = 2_186;

/**
 * How long a root's native probe may take before it counts as unavailable.
 *
 * It bounds a walk of the root's own directory (`depth: 0`), not of the tree, so
 * it only trips on a filesystem that is hanging rather than on one that is
 * merely large.
 */
const WATCHER_PROBE_TIMEOUT_MS = 5_000;

/**
 * The largest number of entries `countTrackedFiles` visits before it stops.
 *
 * The count only ever sizes a timer, and a root past this many entries is
 * already at the backoff's ceiling, so the walk stops rather than paying a full
 * traversal of an arbitrarily large tree.
 */
const WATCHER_FILE_COUNT_SCAN_MAX = 50_000;

/** Which mechanism delivers filesystem events for a watched root. */
export type WatcherMode = 'native' | 'poll';

/** The polling half of chokidar's options, as this service resolves it. */
export type WatcherPollOptions = {
  usePolling: boolean;
  /** Polling period in ms. `0` in native mode: there is no polling clock at all. */
  interval: number;
  binaryInterval: number;
};

/**
 * What a probe of one watched root found. `nativeAvailable` is the whole
 * reading; `reason` is carried into the mode line so "why did this root end up
 * polling" is answerable from the log alone.
 */
export type WatcherModeProbe = {
  nativeAvailable: boolean;
  reason: string;
};

/** The mode a root resolved to, the chokidar options that carry it, and why. */
export type ResolvedWatcherMode = {
  mode: WatcherMode;
  options: WatcherPollOptions;
  /** One line naming the request, the probe's outcome, and the result. */
  note: string;
};

/** Where `resolveWatcherMode` reports what it decided. */
export type WatcherModeLogSink = (line: string) => void;

/** A fresh native-mode options object; `interval: 0` means "no polling clock". */
function nativeWatcherOptions(): WatcherPollOptions {
  return { usePolling: false, interval: 0, binaryInterval: 0 };
}

/** A fresh polling options object at `interval`. */
function pollingWatcherOptions(interval: number): WatcherPollOptions {
  return { usePolling: true, interval, binaryInterval: interval };
}

/**
 * The polling period for a root holding `trackedFileCount` tracked files.
 *
 * Linear in the file count above the floor and clamped at both ends: at 0 files
 * this is exactly `POLL_INTERVAL_MIN_MS` — the period the watcher used
 * unconditionally before this task — and it grows only in proportion to the work
 * one sweep has to do, up to `POLL_INTERVAL_MAX_MS`. Monotonic non-decreasing by
 * construction, so a bigger corpus can never poll more often than a smaller one.
 *
 * Exported for the watcher-mode criterion
 * (`tests/sessions-watcher-mode.test.ts`), which reads it at 0, 1 000, 5 000 and
 * 50 000 files.
 */
export function resolvePollIntervalMs(trackedFileCount: number): number {
  if (!Number.isFinite(trackedFileCount) || trackedFileCount <= 0) {
    return POLL_INTERVAL_MIN_MS;
  }

  const scaled = Math.ceil((POLL_INTERVAL_MIN_MS * trackedFileCount) / POLL_INTERVAL_REFERENCE_FILES);
  return Math.min(POLL_INTERVAL_MAX_MS, Math.max(POLL_INTERVAL_MIN_MS, scaled));
}

/**
 * Whether the operator explicitly asked for polling.
 *
 * Read separately from `resolveWatcherMode` because a forced-poll boot must not
 * pay for a native probe on every root: on the filesystems `poll` exists for,
 * that probe is exactly the thing that fails, and it would fail serially on each
 * root with a timeout apiece.
 */
function isExplicitPollRequest(requested: string | undefined): boolean {
  return (requested ?? '').trim().toLowerCase() === 'poll';
}

/**
 * Resolves one watched root's mode from the operator's request and the root's
 * probe result, and emits exactly one line describing the decision.
 *
 * A pure function of its arguments — no environment read and no filesystem
 * access — so the criterion can drive every combination without a root; reading
 * `CLOUDCLI_WATCHER_MODE` is the production caller's job.
 *
 *   - `poll`   — polling, period from `resolvePollIntervalMs`. The operator has
 *                already decided, so no probe is consulted.
 *   - `native` — native events, and THROWS when the probe could not establish
 *                them. Degrading here would answer an explicit demand for native
 *                events with the exact mechanism it was asked to avoid, and the
 *                operator would have no way to tell.
 *   - `auto`   — native when the probe succeeded, polling otherwise.
 *   - anything else, including unset — treated as `auto`, and the line says so
 *                and quotes the value it rejected.
 */
export function resolveWatcherMode(
  requested: string | undefined,
  probe: WatcherModeProbe | null,
  trackedFileCount: number,
  log: WatcherModeLogSink = (line) => console.log(line)
): ResolvedWatcherMode {
  const raw = (requested ?? '').trim().toLowerCase();
  const recognized = raw === '' || raw === 'auto' || raw === 'native' || raw === 'poll';
  const asked: 'auto' | 'native' | 'poll' = recognized ? (raw === '' ? 'auto' : (raw as 'auto' | 'native' | 'poll')) : 'auto';
  const fallback = recognized
    ? ''
    : `${WATCHER_MODE_ENV_VAR}=${JSON.stringify(requested)} is not one of auto|native|poll, falling back to auto; `;

  if (asked === 'poll') {
    const interval = resolvePollIntervalMs(trackedFileCount);
    const note = `${fallback}session watcher polling every ${interval}ms (~${trackedFileCount} tracked file(s))`;
    log(note);
    return { mode: 'poll', options: pollingWatcherOptions(interval), note };
  }

  if (asked === 'native') {
    if (!probe?.nativeAvailable) {
      throw new Error(
        `${WATCHER_MODE_ENV_VAR}=native but native filesystem events could not be established for this root ` +
          `(${probe?.reason ?? 'no probe was run'}); refusing to fall back to polling — ` +
          `unset ${WATCHER_MODE_ENV_VAR} or set it to poll to accept polling`
      );
    }

    const note = `${fallback}session watcher using native filesystem events (${probe.reason})`;
    log(note);
    return { mode: 'native', options: nativeWatcherOptions(), note };
  }

  if (probe?.nativeAvailable) {
    const note = `${fallback}session watcher using native filesystem events (${probe.reason})`;
    log(note);
    return { mode: 'native', options: nativeWatcherOptions(), note };
  }

  const interval = resolvePollIntervalMs(trackedFileCount);
  const note =
    `${fallback}session watcher polling every ${interval}ms (~${trackedFileCount} tracked file(s); ` +
    `native events unavailable: ${probe?.reason ?? 'no probe was run'})`;
  log(note);
  return { mode: 'poll', options: pollingWatcherOptions(interval), note };
}

/**
 * Asks one root whether native filesystem events can be established on it.
 *
 * The probe is a chokidar watcher of its own, built like the real one except for
 * `depth: 0`: it asks whether THIS directory can hold a native watch, which is
 * the property a container mount or a network filesystem takes away, and it does
 * not need to walk the tree to answer that. It writes nothing anywhere — it
 * opens watch descriptors and closes them again — so pointing it at `~/.claude`
 * cannot touch a file under it.
 *
 * `ready` is the success reading; an `error` event or the timeout is the failure
 * one. Both carry a `reason` for the mode line.
 */
async function probeNativeWatcher(rootPath: string): Promise<WatcherModeProbe> {
  return new Promise<WatcherModeProbe>((resolve) => {
    let settled = false;

    const probe = chokidar.watch(rootPath, {
      persistent: false,
      ignoreInitial: true,
      followSymlinks: false,
      depth: 0,
      usePolling: false,
    });

    const settle = (result: WatcherModeProbe): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      void probe.close().catch(() => undefined);
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({
        nativeAvailable: false,
        reason: `native probe did not become ready within ${WATCHER_PROBE_TIMEOUT_MS}ms`,
      });
    }, WATCHER_PROBE_TIMEOUT_MS);

    probe.once('ready', () => {
      settle({ nativeAvailable: true, reason: 'native watcher established on the root' });
    });
    probe.once('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      settle({ nativeAvailable: false, reason: `native watcher errored during the probe: ${message}` });
    });
  });
}

/**
 * Estimates how many of this root's files the watcher tracks, which is what the
 * polling backoff scales on.
 *
 * An estimate is the point: an exact count would be another full traversal, and
 * the number only ever sizes a timer. Ignored directories are counted too, so
 * this is an upper bound — which is the safe direction, since an over-count only
 * widens the interval. The walk is bounded in depth (`WATCH_DEPTH`, the
 * watcher's own) and in entries (`WATCHER_FILE_COUNT_SCAN_MAX`), and it reads
 * directory listings only: no file is stat'ed, so the sizing step cannot itself
 * become the cost it is sizing.
 */
async function countTrackedFiles(rootPath: string, provider: LLMProvider): Promise<number> {
  let count = 0;
  let visited = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];

  while (queue.length > 0 && visited < WATCHER_FILE_COUNT_SCAN_MAX) {
    const next = queue.shift();
    if (!next) {
      break;
    }

    let entries;
    try {
      entries = await fsPromises.readdir(next.dir, { withFileTypes: true });
    } catch {
      // A missing or unreadable root is expected on a first run; it tracks nothing.
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      if (visited > WATCHER_FILE_COUNT_SCAN_MAX) {
        break;
      }

      const fullPath = path.join(next.dir, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < WATCH_DEPTH) {
          queue.push({ dir: fullPath, depth: next.depth + 1 });
        }
        continue;
      }

      if (entry.isFile() && isWatcherTargetFile(provider, fullPath)) {
        count += 1;
      }
    }
  }

  return count;
}

/**
 * Where one root's watcher delivers the files it noticed. `initializeSessionsWatcher`
 * omits this and the default routes each event to `onUpdate` (index + broadcast);
 * the watcher-mode criterion supplies its own, so it can read a degradation
 * without standing up a database.
 */
export type WatcherFileEventSink = (
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
) => void;

/**
 * A running watcher for one provider root.
 *
 * `mode()` is read rather than fixed because the handle can CHANGE mechanism: a
 * native watcher that errors is replaced by a polling one instead of being left
 * deaf, which is what a bare `on('error', log)` would amount to. The
 * watcher-mode criterion reads `mode()` and `degradations()` on both sides of an
 * injected error — chokidar has no way to be asked for a specific errno
 * (`ENOSPC` is the real one: the inotify watch limit), and an unwatchable root
 * cannot be staged on demand — and `whenReady()` is the readiness signal it
 * waits on, because `chokidar.watch()` returns before its first walk is over.
 */
export type ProviderRootWatcher = {
  readonly provider: LLMProvider;
  readonly rootPath: string;
  mode(): WatcherMode;
  /** How many times this root has changed mechanism since it started. */
  degradations(): number;
  /** Delivers `error` to the ACTIVE watcher exactly as chokidar delivers one. */
  emitError(error: unknown): void;
  /** Resolves once the active watcher's first walk of the root has finished. */
  whenReady(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Starts one provider root's watcher, and returns the handle that can read (and
 * degrade) its mechanism.
 *
 * `initializeSessionsWatcher` drives this once per root; the watcher-mode
 * criterion drives it directly on a real temporary root, with its own event sink,
 * so it can inject an `ENOSPC` into a native watcher and then prove a later
 * append is still noticed.
 */
export async function watchProviderRoot(input: {
  provider: LLMProvider;
  rootPath: string;
  resolution: ResolvedWatcherMode;
  /** The file count the degradation path's polling interval backs off on. */
  trackedFileCount: number;
  onFileEvent?: WatcherFileEventSink;
}): Promise<ProviderRootWatcher> {
  const { provider, rootPath, resolution, trackedFileCount } = input;
  const onFileEvent: WatcherFileEventSink =
    input.onFileEvent ?? ((eventType, filePath, eventProvider) => void onUpdate(eventType, filePath, eventProvider));

  function readySignal(): { promise: Promise<void>; resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((innerResolve) => {
      resolve = innerResolve;
    });
    return { promise, resolve };
  }

  let mode: WatcherMode = resolution.mode;
  let degradations = 0;
  let active: FSWatcher | null = null;
  // Replaced on every generation, so `whenReady()` reads the readiness of the
  // watcher that is live when it is called rather than of the one that started.
  let ready: { promise: Promise<void>; resolve: () => void } = readySignal();

  /** Creates the watcher for `options` and makes it the live generation. */
  function start(options: WatcherPollOptions): FSWatcher {
    const signal = readySignal();
    ready = signal;

    const watcher = chokidar.watch(rootPath, {
      ignored: WATCHER_IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      depth: WATCH_DEPTH,
      ...options,
    });

    watcher.once('ready', () => signal.resolve());
    // `ignoreInitial: true` still lets a file that appears during the first walk
    // through without a line of its own, which is what the signal above is for.
    watcher
      .on('add', (filePath: string) => {
        onFileEvent('add', filePath, provider);
      })
      .on('change', (filePath: string) => {
        onFileEvent('change', filePath, provider);
      })
      .on('error', (error: unknown) => {
        onWatcherError(watcher, error);
      });

    return watcher;
  }

  /**
   * The degradation policy: a native watcher that errors hands its root to a
   * polling one, and a polling watcher that errors has nothing left to fall back
   * to, so it reports and keeps polling.
   *
   * The switch itself is synchronous — the mode and the replacement watcher are
   * in place before this returns — so a caller that injects an error can read
   * `mode()` back immediately. The failed watcher is closed afterwards; events
   * it delivers in that window are ignored by the generation check below.
   */
  function onWatcherError(source: FSWatcher, error: unknown): void {
    if (source !== active) {
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    if (mode === 'poll') {
      console.error(`Session watcher error for provider "${provider}" (already polling)`, {
        rootPath,
        error: message,
      });
      return;
    }

    mode = 'poll';
    degradations += 1;
    active = null;
    void source.close().catch(() => undefined);

    const interval = resolvePollIntervalMs(trackedFileCount);
    console.error(
      `Session watcher native events failed for provider "${provider}" — degrading to polling every ${interval}ms`,
      { rootPath, error: message }
    );
    active = start(pollingWatcherOptions(interval));
  }

  active = start(resolution.options);

  return {
    provider,
    rootPath,
    mode: () => mode,
    degradations: () => degradations,
    emitError: (error: unknown) => {
      active?.emit('error', error);
    },
    whenReady: () => ready.promise,
    close: async () => {
      const watcher = active;
      active = null;
      if (watcher) {
        await watcher.close();
      }
    },
  };
}

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: ProviderRootWatcher[] = [];

/**
 * The mode every observed root is running in right now.
 *
 * Exported for the debug agent's external-write criterion
 * (`tests/debug-agent-external-write.test.ts`), whose arms must each prove the
 * fixture root came up in the mechanism that arm pinned: an arm that asked for
 * native events and silently got a polling clock would be reporting a different
 * experiment than the one it names.
 */
export function readActiveWatcherModes(): Array<{ rootPath: string; mode: WatcherMode }> {
  return watchers.map((handle) => ({ rootPath: handle.rootPath, mode: handle.mode() }));
}

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    await broadcastSessionUpsertedBatch(queuedUpdate.updatedSessionIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    prunedOrphans: initialSync.prunedOrphans,
    failures: initialSync.failures,
  });

  const requestedMode = process.env[WATCHER_MODE_ENV_VAR];

  for (const { provider, rootPath } of await ensureProviderWatchRoots()) {
    // Resolved OUTSIDE the per-root try below on purpose. An explicit
    // `CLOUDCLI_WATCHER_MODE=native` that this root cannot honour is a
    // configuration error, not a per-root hiccup: swallowing it would leave the
    // root unwatched instead of polling it, which is worse than either mode.
    const probe = isExplicitPollRequest(requestedMode) ? null : await probeNativeWatcher(rootPath);
    const trackedFileCount = await countTrackedFiles(rootPath, provider);
    const resolution = resolveWatcherMode(requestedMode, probe, trackedFileCount);

    try {
      watchers.push(
        await watchProviderRoot({ provider, rootPath, resolution, trackedFileCount })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
