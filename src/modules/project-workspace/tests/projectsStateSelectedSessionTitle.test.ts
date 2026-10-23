import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * Regression guard for the selected session's denormalized title.
 *
 * `selectedSession` is a copy of one row of `projects`, so a `session_upserted`
 * delta used to move only the sidebar. The workspace header (`WorkspaceTitle`),
 * the document title, the export filename and the composer's session label all
 * read the copy, so they kept the old name until an unrelated refresh happened
 * to re-derive it. The visible case is a session created in this client: it is
 * selected under the id the event itself carries, which the alias branch below
 * never matches, and the provider's generated `ai-title` arrives later as one
 * more upsert.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const APP_SESSION_ID = 'app-1';
const OTHER_SESSION_ID = 'app-2';
const PROVIDER_SESSION_ID = 'native-1';

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
};

type ServerEventListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ServerEventListener>();

const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

type UpsertOverrides = {
  sessionId?: string;
  providerSessionId?: string | null;
  summary?: string;
  provider?: string;
};

const buildUpsert = ({
  sessionId = APP_SESSION_ID,
  providerSessionId = null,
  summary = 'generated title',
  provider = 'claude',
}: UpsertOverrides = {}) => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId,
  provider,
  session: {
    id: sessionId,
    summary,
    messageCount: 0,
    lastActivity: '2026-01-01T00:00:00.000Z',
  },
  project: {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
  },
  timestamp: '2026-01-01T00:00:00.000Z',
});

const renderProjectsState = async (navigate: ReturnType<typeof vi.fn>, urlSessionId: string) => {
  const { useProjectsState } = await import('@/modules/project-workspace');

  return renderHook(() =>
    useProjectsState({
      sessionId: urlSessionId,
      navigate: navigate as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

/**
 * Renders the hook on a single-project payload and selects the row with
 * `selectedId`, so `selectedSession` is the copy a real workspace holds.
 *
 * The seeded row carries `__provider` matching the upsert's provider on purpose:
 * the URL→session effect re-normalizes the selection only when the id or the
 * provider differs, and letting it fire would rewrite `selectedSession` from the
 * project list — a second, unrelated path to the same field, which would let a
 * broken merge still read as a pass.
 */
const renderWithSelection = async (
  sessions: ProjectSession[],
  selectedId: string,
  navigate = vi.fn(),
) => {
  respondWith([buildProject(sessions)]);
  const rendered = await renderProjectsState(navigate, selectedId);

  await waitFor(() => {
    assert.ok(rendered.result.current.projects[0]?.sessions?.length);
  });

  const selectedRow = rendered.result.current.projects[0]?.sessions?.find(
    (session) => session.id === selectedId,
  );
  assert.ok(selectedRow, `fixture must seed a row with id ${selectedId}`);

  act(() => {
    rendered.result.current.handleSessionSelect(selectedRow);
  });
  assert.equal(rendered.result.current.selectedSession?.id, selectedId);

  return { ...rendered, navigate };
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
});

// Warms the module graph below, so its cold compile is charged to hookTimeout
// rather than to the first case's testTimeout.
//
// `renderProjectsState` re-evaluates the hook per case (afterEach resets the
// registry, which is what keeps module-scope state from leaking between cases),
// and Vite caches the *compiled* output across that reset. So the graph's compile
// is paid once per worker, by whichever case imports it first — measured 2.7–3.0s
// against a 5000ms case budget, i.e. 60% of it gone before the case asserts
// anything. Under CPU contention that overshoots and the case dies at 5005ms
// (`Test timed out in 5000ms`) while every other case in the file runs in ~150ms.
// Warming here moves the compile out of every case's budget without changing what
// any case asserts, and without dropping `resetModules` (the isolation it provides
// is the point).
beforeAll(async () => {
  await import('@/modules/project-workspace');
});

afterEach(() => {
  vi.resetModules();
});

test('an upsert that names the selected session updates the selected copy', async () => {
  const { result } = await renderWithSelection(
    [{ id: APP_SESSION_ID, summary: 'derived', __provider: 'claude' }],
    APP_SESSION_ID,
  );

  const refetchesBefore = projectsResponse.mock.calls.length;

  await act(async () => {
    emit(buildUpsert({ summary: 'generated title' }));
  });

  assert.equal(result.current.selectedSession?.summary, 'generated title');
  assert.deepEqual(
    projectsResponse.mock.calls.length,
    refetchesBefore,
    'the title must arrive over the socket, without refetching the project list',
  );
});

test('an upsert carrying a blank summary keeps the title on screen', async () => {
  const { result } = await renderWithSelection(
    [{ id: APP_SESSION_ID, summary: 'derived', __provider: 'claude' }],
    APP_SESSION_ID,
  );

  // A fresh session broadcasts an empty `custom_name` moments before the disk
  // indexer fills it in; adopting it would flash the header back to the
  // "New Session" placeholder.
  await act(async () => {
    emit(buildUpsert({ summary: '' }));
  });

  assert.equal(result.current.selectedSession?.summary, 'derived');
});

test('an upsert with an unchanged summary keeps the selected object identity', async () => {
  const { result } = await renderWithSelection(
    [{ id: APP_SESSION_ID, summary: 'derived', __provider: 'claude' }],
    APP_SESSION_ID,
  );

  const selectedBefore = result.current.selectedSession;

  await act(async () => {
    emit(buildUpsert({ summary: 'derived' }));
  });

  assert.ok(
    Object.is(result.current.selectedSession, selectedBefore),
    'an upsert that changes nothing must not re-render the main content tree',
  );
});

test('an upsert for another session leaves the selection alone but updates the list', async () => {
  const { result } = await renderWithSelection(
    [
      { id: APP_SESSION_ID, summary: 'derived', __provider: 'claude' },
      { id: OTHER_SESSION_ID, summary: 'other', __provider: 'claude' },
    ],
    APP_SESSION_ID,
  );

  const selectedBefore = result.current.selectedSession;

  await act(async () => {
    emit(buildUpsert({ sessionId: OTHER_SESSION_ID, summary: 'other renamed' }));
  });

  assert.ok(
    Object.is(result.current.selectedSession, selectedBefore),
    'a background session upsert must not touch the selected copy',
  );
  assert.equal(
    result.current.projects[0]?.sessions?.find((session) => session.id === OTHER_SESSION_ID)?.summary,
    'other renamed',
    'the event must have been delivered — otherwise the identity assertion proves nothing',
  );
});

test('an upsert that merges a provider alias still updates and rewrites the id', async () => {
  const navigate = vi.fn();
  const { result } = await renderWithSelection(
    [{ id: PROVIDER_SESSION_ID, summary: 'indexed from disk', __provider: 'opencode' }],
    PROVIDER_SESSION_ID,
    navigate,
  );
  navigate.mockClear();

  await act(async () => {
    emit(buildUpsert({
      sessionId: APP_SESSION_ID,
      providerSessionId: PROVIDER_SESSION_ID,
      provider: 'opencode',
      summary: 'merged session',
    }));
  });

  assert.equal(result.current.selectedSession?.id, APP_SESSION_ID);
  assert.equal(result.current.selectedSession?.summary, 'merged session');
  assert.deepEqual(navigate.mock.calls, [[`/session/${APP_SESSION_ID}`]]);
});
