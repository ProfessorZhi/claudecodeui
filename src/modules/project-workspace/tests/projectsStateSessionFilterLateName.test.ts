import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the project session-name filter on freshly created sessions.
 *
 * A new session is first broadcast with an empty name (which matches no rule, so it
 * used to be inserted and marked for attention) and gets its real name in a later
 * upsert. Neither the later upsert nor the attention keep-alive re-applied the
 * filter, so quay worker sessions showed up in the sidebar despite matching a rule.
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

type ServerEventListener = (event: Record<string, unknown>) => void;
const listeners = new Set<ServerEventListener>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions: [{ id: 'human-1', summary: 'human work', __provider: 'claude' }],
  sessionMeta: { hasMore: false, total: 1, hiddenCount: 0 },
  sessionFilter: { hide: ['-task-worker$'] },
};

const buildUpsert = (sessionId: string, summary: string) => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId: null,
  provider: 'claude',
  session: { id: sessionId, summary, messageCount: 0, lastActivity: '2026-01-01T00:00:00.000Z' },
  project: { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo', isStarred: false },
  timestamp: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  listeners.clear();
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [project] });
});

beforeAll(async () => {
  await import('@/modules/project-workspace');
});

afterEach(() => {
  vi.resetModules();
});

const renderState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace');
  const rendered = renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn() as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
  await waitFor(() => assert.equal(rendered.result.current.projects[0]?.sessions?.length, 1));
  return rendered;
};

test('a session named after its first nameless upsert is hidden and counted once', async () => {
  const { result } = await renderState();

  await act(async () => {
    emit(buildUpsert('worker-1', ''));
  });

  await act(async () => {
    emit(buildUpsert('worker-1', 'repo-task-worker'));
  });
  await act(async () => {
    emit(buildUpsert('worker-1', 'repo-task-worker'));
  });

  const [loaded] = result.current.projects;
  assert.deepEqual(loaded?.sessions?.map((session) => session.id), ['human-1']);
  assert.equal(loaded?.sessionMeta?.hiddenCount, 1);
  assert.equal(loaded?.sessionMeta?.total, 1);
});

test('a visible session renamed to match a rule is hidden', async () => {
  const { result } = await renderState();

  await act(async () => {
    emit(buildUpsert('human-1', 'repo-task-worker'));
  });

  const [loaded] = result.current.projects;
  assert.deepEqual(loaded?.sessions?.map((session) => session.id), []);
  assert.equal(loaded?.sessionMeta?.hiddenCount, 1);
  assert.equal(loaded?.sessionMeta?.total, 0);
});

test('a non-matching new session stays visible', async () => {
  const { result } = await renderState();

  await act(async () => {
    emit(buildUpsert('human-2', 'another human session'));
  });

  const [loaded] = result.current.projects;
  assert.deepEqual(loaded?.sessions?.map((session) => session.id).sort(), ['human-1', 'human-2']);
  assert.equal(loaded?.sessionMeta?.hiddenCount, 0);
});
