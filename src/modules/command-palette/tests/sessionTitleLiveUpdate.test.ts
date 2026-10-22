import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

/**
 * The command palette lists a project's sessions from one page fetched when it
 * opens. A rename that happened afterwards left it showing the name the session
 * had at that moment — the same staleness the sidebar's list had.
 *
 * The fix is a subscription to the app-wide `session_upserted` delta, which
 * patches the one row in place. Re-listing the project instead would spend a
 * request and drop every result past the first page, so the row must change
 * without the fetch being repeated — which is what the call-count assertions
 * below pin. Removing the subscription entirely turns the first case red.
 */

const apiMock = vi.hoisted(() => ({
  projectSessions: vi.fn(),
}));

vi.mock('@/shared/api', () => ({ api: apiMock }));

const { useSessionsSource } = await import('@/modules/command-palette/hooks/useSessionsSource');

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const PROJECT_ID = 'project-1';

/** The event listeners the hook registered through `useWebSocket`. */
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

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(
    WebSocketContext.Provider,
    { value: { ws: null, sendMessage: () => {}, subscribe, isConnected: true } },
    children,
  );

const upsert = (projectId: string | null, sessionId: string, summary: string) => ({
  kind: 'session_upserted',
  sessionId,
  provider: 'claude',
  project: projectId === null ? null : { projectId },
  session: { id: sessionId, summary },
}) as ServerEvent;

beforeEach(() => {
  listeners.clear();
  apiMock.projectSessions.mockReset().mockResolvedValue(
    json({
      sessions: [
        { id: 's-here', summary: 'Old label' },
        { id: 's-other', summary: 'Untouched label' },
      ],
    }),
  );
});

const mountPanel = async (projectId: string | undefined = PROJECT_ID) => {
  const rendered = renderHook(() => useSessionsSource(projectId, true), { wrapper });
  await waitFor(() => assert.equal(rendered.result.current.length, 2));
  return rendered;
};

test('an upsert for a listed session renames its row without re-listing the project', async () => {
  const { result } = await mountPanel();

  const labelOf = (id: string) => result.current.find((row) => row.id === id)?.label;
  assert.equal(labelOf('s-here'), 'Old label');

  const fetchesBefore = apiMock.projectSessions.mock.calls.length;

  emit(upsert(PROJECT_ID, 's-here', 'Renamed elsewhere'));

  // Positive control: the row the panel shows must actually change.
  assert.equal(labelOf('s-here'), 'Renamed elsewhere');
  assert.notEqual(labelOf('s-here'), 'Old label');
  // Only that row moves.
  assert.equal(labelOf('s-other'), 'Untouched label');

  // Patched in place: no request spent and the loaded page keeps its results.
  assert.equal(apiMock.projectSessions.mock.calls.length, fetchesBefore);
  assert.equal(apiMock.projectSessions.mock.calls.length, 1);
});

test('an upsert for another project leaves the panel alone', async () => {
  const { result } = await mountPanel();

  const before = result.current;
  const fetchesBefore = apiMock.projectSessions.mock.calls.length;

  emit(upsert('project-2', 's-here', 'Renamed elsewhere'));

  assert.equal(result.current, before);
  assert.equal(result.current.find((row) => row.id === 's-here')?.label, 'Old label');
  assert.equal(apiMock.projectSessions.mock.calls.length, fetchesBefore);
});

test('an upsert for a session the loaded page does not contain is not inserted', async () => {
  const { result } = await mountPanel();

  const before = result.current;

  emit(upsert(PROJECT_ID, 's-not-on-this-page', 'Some other session'));

  // The event patches a row, it never grows the page: a session past the first
  // page stays out of a list it was never part of.
  assert.equal(result.current, before);
  assert.equal(result.current.length, 2);
});

test('an upsert for a listed session whose title did not change keeps the row identity', async () => {
  const { result } = await mountPanel();

  const before = result.current;

  emit(upsert(PROJECT_ID, 's-here', 'Old label'));

  assert.equal(result.current, before);
  assert.equal(result.current.find((row) => row.id === 's-here')?.label, 'Old label');
});

test('two renames of the same session in a row both land', async () => {
  const { result } = await mountPanel();

  emit(upsert(PROJECT_ID, 's-here', 'First rename'));
  assert.equal(result.current.find((row) => row.id === 's-here')?.label, 'First rename');

  emit(upsert(PROJECT_ID, 's-here', 'Second rename'));
  assert.equal(result.current.find((row) => row.id === 's-here')?.label, 'Second rename');
  assert.equal(apiMock.projectSessions.mock.calls.length, 1);
});
