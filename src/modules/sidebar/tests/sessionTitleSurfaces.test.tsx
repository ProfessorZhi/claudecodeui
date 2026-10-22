import assert from 'node:assert/strict';

import { act, render, waitFor } from '@testing-library/react';
import React, { useEffect } from 'react';
import { beforeEach, test, vi } from 'vitest';

import WebSocketContext from '@/shared/context/WebSocketContext';
import { SessionProtectionProvider } from '@/shared/context/SessionProtectionContext';
import type {
  ArchivedSessionListItem,
  RecentConversationListItem,
  ServerEvent,
  SessionRowActions,
  SidebarProjectListProps,
} from '@/shared/types';

/**
 * Two sidebar surfaces hold their own copy of a session's title: the
 * Conversations list and the archived list. Both are filled once from the
 * server, so a rename performed in the app used to leave them showing the name
 * the session had when the page was last listed — while the workspace header
 * and the document title had already moved on.
 *
 * These cases drive the real controller (the store both surfaces read) and
 * render the real Conversations list over it, so what is asserted is the row a
 * user actually reads rather than a re-statement of the controller's internals.
 * The archived surface has no lightweight component of its own — `SidebarContent`
 * needs the whole sidebar to render — so it is read from the store its rows are
 * built from.
 */

const apiMock = vi.hoisted(() => ({
  archivedProjects: vi.fn(),
  getArchivedSessions: vi.fn(),
  recentConversations: vi.fn(),
  renameSession: vi.fn(),
  migrateLegacyProjectStars: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: apiMock }));

// The row's name is rendered by the list itself; the per-row control beside it
// reaches for provider capabilities and a canvas, neither of which this case is
// about. Stubbed so the assertion reads only the part under test.
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

// The controller reaches the command palette through its barrel, which drags
// the palette's whole component graph in behind it. Only the one operation the
// controller uses is needed here, and it is a no-op.
vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({
    openFile: () => {},
    openFileInEditor: () => {},
    openDirectory: () => {},
    openSettings: () => {},
    refreshProjects: () => {},
  }),
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');
const { default: SidebarRecentConversations } = await import(
  '@/modules/sidebar/SidebarRecentConversations'
);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');

/** The event listeners the controller registered through `useWebSocket`. */
const listeners = new Set<(event: ServerEvent) => void>();
const subscribe = (listener: (event: ServerEvent) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const emit = (event: ServerEvent) => {
  act(() => {
    for (const listener of [...listeners]) {
      listener(event);
    }
  });
};

/**
 * The two providers the controller reads.
 *
 * The socket is where its events arrive. The session-protection provider is where
 * the *running* count comes from: the sidebar's badge counts the page's one
 * activity reading, not the host listing's turn leases, so the controller is a
 * consumer of that context exactly as `Sidebar` is. A tree without it is a tree
 * the controller cannot run in — which is the throw this wrapper exists to
 * answer, and the reason the production `Sidebar` uses the same hook.
 */
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WebSocketContext.Provider
    value={{ ws: null, sendMessage: () => {}, subscribe, isConnected: true }}
  >
    <SessionProtectionProvider>{children}</SessionProtectionProvider>
  </WebSocketContext.Provider>
);

const ARCHIVED_ROW: ArchivedSessionListItem = {
  sessionId: 's-archived',
  provider: 'claude',
  projectId: null,
  projectPath: null,
  projectDisplayName: 'project one',
  sessionTitle: 'Old archived name',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
  lastActivity: '2026-08-20T10:00:00.000Z',
  isProjectArchived: false,
};

const RECENT_ROW: RecentConversationListItem = {
  sessionId: 's-recent',
  provider: 'claude',
  projectId: 'project-1',
  projectDisplayName: 'project one',
  sessionTitle: 'Old recent name',
  lastActivity: '2026-08-21T09:30:00.000Z',
};

const CONTROLLER_ARGS = {
  projects: [],
  selectedProject: null,
  selectedSession: null,
  activeSessions: new Set<string>(),
  isLoading: false,
  isMobile: false,
  t,
  onRefresh: () => {},
  onProjectSelect: () => {},
  onSessionSelect: () => {},
  setCurrentProject: () => {},
  setSidebarVisible: () => {},
  sidebarVisible: true,
};

const sessionActions = (): SessionRowActions => ({
  activeRename: null,
  activeSessions: new Set<string>(),
  attentionSessionIds: new Set<string>(),
  onRenameDraftChange: () => {},
  onStartEditingSession: () => {},
  onCancelEditingSession: () => {},
  onSaveEditingSession: () => {},
  onDeleteSession: () => {},
});

type Controller = ReturnType<typeof useSidebarController>;

/**
 * The controller's latest value, published by the harness after each render.
 * A holder rather than a bare binding so the harness never reassigns anything
 * declared outside itself.
 */
const published: { current: Controller | null } = { current: null };

/**
 * The controller plus the Conversations list it feeds, mounted together so the
 * store and the rendered row are read from one tree — the row cannot be
 * asserted on a value the store does not hold.
 */
function Harness() {
  const controller = useSidebarController(CONTROLLER_ARGS);

  useEffect(() => {
    published.current = controller;
  }, [controller]);

  return (
    <SidebarRecentConversations
      conversations={controller.recentConversations}
      total={controller.recentConversationsTotal}
      hasMore={controller.recentConversationsHasMore}
      isLoading={controller.isRecentConversationsLoading}
      isLoadingMore={controller.isLoadingMoreRecentConversations}
      hasError={controller.recentConversationsError}
      selectedSession={null}
      currentTime={NOW}
      sessionActions={sessionActions()}
      onConversationSelect={() => {}}
      onLoadMore={() => {}}
      onRetry={() => {}}
      t={t}
    />
  );
}

const store = (): Controller => {
  assert.notEqual(published.current, null);
  return published.current as Controller;
};

/** Mounts the sidebar with both feeds loaded, as it is while the Conversations tab is open. */
const mountSidebar = async () => {
  const rendered = render(<Harness />, { wrapper });

  await waitFor(() => assert.equal(store().archivedSessions.length, 1));

  act(() => store().setSearchMode('conversations'));
  await waitFor(() => assert.equal(store().recentConversations.length, 1));

  return rendered;
};

beforeEach(() => {
  published.current = null;
  listeners.clear();
  localStorage.clear();
  apiMock.archivedProjects.mockReset().mockResolvedValue(json({ success: true, data: { projects: [] } }));
  apiMock.getArchivedSessions.mockReset().mockResolvedValue(
    json({ success: true, data: { sessions: [ARCHIVED_ROW] } }),
  );
  apiMock.recentConversations.mockReset().mockResolvedValue(
    json({ success: true, data: { conversations: [RECENT_ROW], total: 1, hasMore: false } }),
  );
  apiMock.renameSession.mockReset().mockResolvedValue(json({ success: true }));
  apiMock.migrateLegacyProjectStars.mockReset().mockResolvedValue(json({ success: true }));
});

test('a rename made here renames the Conversations row and the archived row without reloading either feed', async () => {
  const { getByTestId } = await mountSidebar();

  const rowText = () => getByTestId('recent-conversation-row').textContent ?? '';
  // Labels come from the feeds' own payloads rather than a constant, so a feed
  // that returned something else would red here instead of passing silently.
  assert.equal(store().recentConversations[0].sessionTitle, 'Old recent name');
  assert.equal(store().archivedSessions[0].sessionTitle, 'Old archived name');
  assert.match(rowText(), /Old recent name/);

  const recentFetchesBefore = apiMock.recentConversations.mock.calls.length;
  const archivedFetchesBefore = apiMock.getArchivedSessions.mock.calls.length;

  // One rename per surface, so each store is shown to move for its own session
  // rather than for a session the other one happens to share.
  await act(async () => {
    await store().updateSessionSummary('project-1', 's-recent', 'Renamed recent', 'claude');
    await store().updateSessionSummary('', 's-archived', 'Renamed archived', 'claude');
  });

  // Positive control: the name on both surfaces must actually change — a store
  // that never moved would satisfy every other assertion here.
  assert.notEqual(store().recentConversations[0].sessionTitle, 'Old recent name');
  assert.notEqual(store().archivedSessions[0].sessionTitle, 'Old archived name');
  assert.equal(store().recentConversations[0].sessionTitle, 'Renamed recent');
  assert.equal(store().archivedSessions[0].sessionTitle, 'Renamed archived');

  // And the row the user reads shows it.
  assert.match(rowText(), /Renamed recent/);
  assert.doesNotMatch(rowText(), /Old recent name/);

  // Patched in place: neither feed is re-listed, so no request is spent and the
  // pages already loaded past the first are kept.
  assert.equal(apiMock.recentConversations.mock.calls.length, recentFetchesBefore);
  assert.equal(apiMock.getArchivedSessions.mock.calls.length, archivedFetchesBefore);
  assert.equal(apiMock.renameSession.mock.calls.length, 2);
});

test('a rename of one session leaves the other rows of both surfaces alone', async () => {
  await mountSidebar();

  const archivedBefore = store().archivedSessions;

  await act(async () => {
    await store().updateSessionSummary('project-1', 's-someone-else', 'Not mine', 'claude');
  });

  assert.equal(store().recentConversations[0].sessionTitle, 'Old recent name');
  assert.equal(store().archivedSessions[0].sessionTitle, 'Old archived name');
  // A row that was not renamed keeps its object identity, so a rename cannot
  // invalidate a row it is not part of.
  assert.equal(store().archivedSessions[0], archivedBefore[0]);
});

test('an upsert for a session neither surface lists changes nothing', async () => {
  await mountSidebar();

  const recentBefore = store().recentConversations;
  const archivedBefore = store().archivedSessions;
  const recentFetchesBefore = apiMock.recentConversations.mock.calls.length;

  emit({
    kind: 'session_upserted',
    sessionId: 's-not-listed',
    provider: 'claude',
    session: { id: 's-not-listed', summary: 'Some other session' },
  } as ServerEvent);

  // The event names no project, so there is nothing to build a row from: both
  // stores keep their identity and the names on screen are untouched.
  assert.equal(store().recentConversations, recentBefore);
  assert.equal(store().archivedSessions, archivedBefore);
  assert.equal(store().recentConversations[0].sessionTitle, 'Old recent name');
  assert.equal(store().archivedSessions[0].sessionTitle, 'Old archived name');
  assert.equal(apiMock.recentConversations.mock.calls.length, recentFetchesBefore);
});

test('an upsert for a listed session renames its Conversations row without re-listing the feed', async () => {
  const { getByTestId } = await mountSidebar();

  const fetchesBefore = apiMock.recentConversations.mock.calls.length;

  emit({
    kind: 'session_upserted',
    sessionId: 's-recent',
    provider: 'claude',
    session: { id: 's-recent', summary: 'Renamed elsewhere' },
  } as ServerEvent);

  assert.equal(store().recentConversations[0].sessionTitle, 'Renamed elsewhere');
  assert.match(getByTestId('recent-conversation-row').textContent ?? '', /Renamed elsewhere/);
  assert.equal(apiMock.recentConversations.mock.calls.length, fetchesBefore);
});

test('an upsert with newer activity updates the row time and moves it to the top', async () => {
  await mountSidebar();

  const olderRow: RecentConversationListItem = {
    ...RECENT_ROW,
    sessionId: 's-older',
    sessionTitle: 'Older',
    lastActivity: '2026-08-21T09:00:00.000Z',
  };
  apiMock.recentConversations.mockResolvedValue(
    json({ data: { conversations: [olderRow, RECENT_ROW], total: 2, hasMore: false } }),
  );
  await act(async () => {
    store().reloadRecentConversations();
  });
  await waitFor(() => assert.equal(store().recentConversations.length, 2));
  assert.equal(store().recentConversations[0].sessionId, 's-older');

  emit({
    kind: 'session_upserted',
    sessionId: 's-recent',
    provider: 'claude',
    session: { id: 's-recent', summary: 'Old recent name', lastActivity: '2026-08-21T09:59:00.000Z' },
  } as ServerEvent);

  assert.equal(store().recentConversations[0].sessionId, 's-recent');
  assert.equal(store().recentConversations[0].lastActivity, '2026-08-21T09:59:00.000Z');

  // A stale delta must not rewind the row.
  const before = store().recentConversations;
  emit({
    kind: 'session_upserted',
    sessionId: 's-recent',
    provider: 'claude',
    session: { id: 's-recent', summary: 'Old recent name', lastActivity: '2026-08-21T08:00:00.000Z' },
  } as ServerEvent);
  assert.equal(store().recentConversations, before);
});

test('an upsert for a session created after the list loaded inserts its row at the top', async () => {
  const { getByTestId } = await mountSidebar();

  emit({
    kind: 'session_upserted',
    sessionId: 's-new',
    provider: 'claude',
    session: { id: 's-new', summary: 'Brand new', lastActivity: '2026-08-21T09:59:30.000Z' },
    project: { projectId: 'project-1', displayName: 'project one' },
  } as ServerEvent);

  assert.equal(store().recentConversations.length, 2);
  assert.equal(store().recentConversations[0].sessionId, 's-new');
  assert.equal(store().recentConversations[0].projectId, 'project-1');
  assert.equal(store().recentConversationsTotal, 2);
  assert.match(getByTestId('recent-conversations-list').textContent ?? '', /Brand new/);
});
