import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * The Conversations feed is patched in place from `session_upserted` deltas, and
 * it has to end up holding the same members a reload of that feed returns. The
 * reported bug was the live path inserting (and keeping) sessions whose names the
 * project's session-name rules hide: the reload filtered them, the live list did
 * not, so worker sessions reappeared while the user sat on Conversations.
 *
 * These tests drive the real controller through the module barrel and judge every
 * assertion against an independent reload model — the server semantics
 * (unanchored, case-insensitive, any rule hides) written out again below — so the
 * equivalence being asserted is between two implementations, not one.
 */

const RULE = '-task-worker$';
const START = '2026-01-01T00:00:00.000Z';

const harness = vi.hoisted(() => {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  return {
    listeners,
    busyIds: new Set<string>(),
    subscribe: (listener: (event: Record<string, unknown>) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (event: Record<string, unknown>) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    recentConversations: vi.fn(),
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    recentConversations: (...args: unknown[]) => harness.recentConversations(...args),
    archivedProjects: async () => ({ ok: true, json: async () => ({ data: { projects: [] } }) }),
    getArchivedSessions: async () => ({ ok: true, json: async () => ({ data: { sessions: [] } }) }),
    migrateLegacyProjectStars: async () => ({ ok: true }),
  },
}));

// The controller reads the app-wide event stream; there is no provider in a unit
// test, and the set of listeners is exactly what these tests need to see.
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: harness.subscribe }),
}));

// Requires a SessionProtectionProvider that renders nothing here; the controller
// only checks membership of running sessions.
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useBusySessionIdSet: () => harness.busyIds,
}));

const FILTERED: Project = {
  projectId: 'project-1',
  displayName: 'Repo',
  fullPath: '/repo',
  sessionFilter: { hide: [RULE] },
};
const UNFILTERED: Project = {
  projectId: 'project-2',
  displayName: 'Plain',
  fullPath: '/plain',
};

// The controller resets derived state from an effect that runs on `[projects]`,
// so the array identity has to be stable across renders exactly as the real
// parent's state is — a fresh array per render would loop the test forever.
const PROJECTS_LIST: Project[] = [FILTERED, UNFILTERED];
const noop = () => {};
const translate = ((key: string) => key) as unknown as SidebarProjectListProps['t'];

type ServerRow = {
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  provider: string;
  lastActivity: string;
  forkedFromSessionId: null;
};

let serverRows: ServerRow[] = [];

/** The reload (`GET /api/providers/sessions/recent`) semantics, written out independently of the predicate under test. */
const serverVisibleRows = (): ServerRow[] => serverRows.filter((row) => {
  const project = [FILTERED, UNFILTERED].find((candidate) => candidate.projectId === row.projectId);
  const hide = project?.sessionFilter?.hide ?? [];
  return !hide.some((pattern) => new RegExp(pattern, 'i').test(row.sessionTitle));
});

const row = (sessionId: string, sessionTitle: string, project: Project): ServerRow => ({
  sessionId,
  sessionTitle,
  projectId: project.projectId,
  provider: 'claude',
  lastActivity: START,
  forkedFromSessionId: null,
});

const upsert = (sessionId: string, summary: string, project: Project) => harness.emit({
  kind: 'session_upserted',
  sessionId,
  provider: 'claude',
  session: { id: sessionId, summary, messageCount: 0, lastActivity: START },
  project: { projectId: project.projectId, displayName: project.displayName },
  timestamp: START,
});

/** A transcript appearing on disk: the server row is written first, then the delta arrives. */
const createSession = (sessionId: string, summary: string, project: Project) => {
  serverRows = [...serverRows, row(sessionId, summary, project)];
  upsert(sessionId, summary, project);
};

/** The same session renamed later: the row's title changes, then the delta arrives. */
const renameSession = (sessionId: string, summary: string, project: Project) => {
  serverRows = serverRows.map((candidate) => (
    candidate.sessionId === sessionId ? { ...candidate, sessionTitle: summary } : candidate
  ));
  upsert(sessionId, summary, project);
};

const liveIds = (result: { current: ReturnType<typeof useController> }) => (
  result.current.recentConversations.map((conversation) => conversation.sessionId).sort()
);

/** Reloads the feed and returns what the server lists, through the controller's own reload path. */
const reloadIds = async (result: { current: ReturnType<typeof useController> }) => {
  await act(async () => {
    result.current.reloadRecentConversations();
  });
  return result.current.recentConversations.map((conversation) => conversation.sessionId).sort();
};

/** Every live assertion is followed by this: the reload must list the same members. */
const assertMatchesReload = async (result: { current: ReturnType<typeof useController> }) => {
  const live = liveIds(result);
  const reloaded = await reloadIds(result);
  assert.deepEqual(reloaded, live);
};

const { useSidebarController } = await import('@/modules/sidebar');
const { isSessionHiddenByProjectFilter } = await import('@/modules/project-workspace');

const useController = () => useSidebarController({
  projects: PROJECTS_LIST,
  selectedProject: null,
  selectedSession: null,
  activeSessions: harness.busyIds,
  isLoading: false,
  isMobile: false,
  t: translate,
  onRefresh: noop,
  onProjectSelect: noop,
  onSessionSelect: noop,
  isSessionHiddenByProjectFilter,
  setCurrentProject: noop,
  setSidebarVisible: noop,
  sidebarVisible: true,
});

const renderController = () => {
  harness.recentConversations.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ data: { conversations: serverVisibleRows(), total: serverVisibleRows().length, hasMore: false } }),
  }));
  return renderHook(() => useController());
};

beforeEach(() => {
  localStorage.clear();
  harness.listeners.clear();
  harness.recentConversations.mockReset();
});

test('a new session whose name matches the project rules is not inserted, and one that does not match is', async () => {
  serverRows = [row('seed-1', 'human seed', FILTERED)];
  const { result } = renderController();

  await act(async () => {
    result.current.reloadRecentConversations();
  });
  assert.deepEqual(liveIds(result), ['seed-1']);

  // A quay worker transcript appears while the user sits on Conversations.
  await act(async () => {
    createSession('worker-1', 'repo-task-worker', FILTERED);
  });
  assert.deepEqual(liveIds(result), ['seed-1']);
  await assertMatchesReload(result);

  // The positive control: a session created the same way whose name matches nothing.
  await act(async () => {
    createSession('human-2', 'another human session', FILTERED);
  });
  assert.deepEqual(liveIds(result), ['human-2', 'seed-1']);
  await assertMatchesReload(result);
});

test('an existing row renamed into a matching rule is removed', async () => {
  serverRows = [row('seed-1', 'human seed', FILTERED), row('seed-2', 'another human', FILTERED)];
  const { result } = renderController();

  await act(async () => {
    result.current.reloadRecentConversations();
  });
  assert.deepEqual(liveIds(result), ['seed-1', 'seed-2']);

  await act(async () => {
    renameSession('seed-1', 'repo-task-worker', FILTERED);
  });
  assert.deepEqual(liveIds(result), ['seed-2']);
  await assertMatchesReload(result);
});

test('a session inserted nameless and named into a rule afterwards is invisible in the net result', async () => {
  serverRows = [];
  const { result } = renderController();

  // Nameless: nothing matches yet, so the row is inserted (this is the insert
  // branch the "already loaded" case depends on).
  await act(async () => {
    createSession('late-1', '', FILTERED);
  });
  assert.deepEqual(liveIds(result), ['late-1']);
  assert.equal(
    result.current.recentConversations[0].sessionTitle,
    'New Session',
    'a nameless session is inserted under the placeholder title',
  );
  await assertMatchesReload(result);

  // The real name lands later and matches a rule.
  await act(async () => {
    renameSession('late-1', 'late-task-worker', FILTERED);
  });
  assert.deepEqual(liveIds(result), []);
  await assertMatchesReload(result);
});

test('a project with no rules behaves exactly as before', async () => {
  serverRows = [];
  const { result } = renderController();

  await act(async () => {
    createSession('plain-1', 'plain-task-worker', UNFILTERED);
  });
  assert.deepEqual(liveIds(result), ['plain-1']);
  await assertMatchesReload(result);

  // Even a title that would match the *other* project's rule is kept here.
  await act(async () => {
    renameSession('plain-1', 'plain-task-worker', UNFILTERED);
  });
  assert.deepEqual(liveIds(result), ['plain-1']);
  await assertMatchesReload(result);
});

test('an upsert naming no project at all leaves the feed as it was', async () => {
  serverRows = [row('seed-1', 'human seed', FILTERED)];
  const { result } = renderController();

  await act(async () => {
    result.current.reloadRecentConversations();
  });

  await act(async () => {
    harness.emit({
      kind: 'session_upserted',
      sessionId: 'orphan-1',
      provider: 'claude',
      session: { id: 'orphan-1', summary: 'orphan-task-worker', messageCount: 0, lastActivity: START },
      project: null,
      timestamp: START,
    });
  });

  assert.deepEqual(liveIds(result), ['seed-1']);
  await assertMatchesReload(result);
});
