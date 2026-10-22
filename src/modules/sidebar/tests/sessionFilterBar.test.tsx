import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import React, { useState } from 'react';
import { beforeEach, test, vi } from 'vitest';

import zhSidebar from '@/modules/i18n/locales/zh-CN/sidebar.json';
import type { Project } from '@/shared/types';

/**
 * The bottom "hidden N · show · edit rules" bar of a project's session list and
 * the browser-local "show hidden" switch behind it. "Show" must only change what
 * this browser requests (includeHidden=true) and remember it locally; it must
 * never touch the project's stored rules.
 */

const projectSessionsMock = vi.fn();
const saveFilterMock = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projectSessions: (...args: unknown[]) => projectSessionsMock(...args),
    saveProjectSessionFilter: (...args: unknown[]) => saveFilterMock(...args),
  },
}));

vi.mock('@/modules/sidebar/SidebarSessionItem', () => ({
  default: ({ session }: { session: { id: string } }) => React.createElement('div', { 'data-testid': 'session-row' }, session.id),
}));

const { default: SidebarProjectSessions } = await import('@/modules/sidebar/SidebarProjectSessions');
const { useProjectSessionFilter } = await import('@/modules/project-workspace');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'zh-CN',
  defaultNS: 'sidebar',
  resources: { 'zh-CN': { sidebar: zhSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof SidebarProjectSessions>['t'];

const VISIBLE_SESSIONS = Array.from({ length: 14 }, (_, index) => ({
  id: `visible-${index}`,
  summary: `visible ${index}`,
  lastActivity: '2026-08-21T10:00:00.000Z',
}));
const ALL_SESSIONS = [
  ...VISIBLE_SESSIONS,
  ...Array.from({ length: 114 }, (_, index) => ({
    id: `hidden-${index}`,
    summary: `x-task-worker ${index}`,
    lastActivity: '2026-08-20T10:00:00.000Z',
  })),
];

const makeProject = (hiddenCount: number): Project => ({
  projectId: 'project-1',
  displayName: 'Repo',
  fullPath: '/repo',
  sessionFilter: { hide: ['-(task-worker)$'] },
  sessions: VISIBLE_SESSIONS,
  sessionMeta: { total: 14, hasMore: false, hiddenCount },
}) as unknown as Project;

const renderSessions = (project: Project, isShowingHidden = false) => {
  const onToggleShowHidden = vi.fn();
  const onEditSessionFilter = vi.fn();
  const view = render(
    React.createElement(SidebarProjectSessions, {
      project,
      isExpanded: true,
      sessions: (project.sessions ?? []) as never,
      selectedSession: null,
      initialSessionsLoaded: true,
      hasMoreSessions: false,
      isLoadingMoreSessions: false,
      activeSessions: new Set<string>(),
      attentionSessionIds: new Set<string>(),
      currentTime: new Date('2026-08-21T10:00:00.000Z'),
      sessionRenameId: null,
      sessionRenameDraft: '',
      onRenameDraftChange: () => {},
      onStartEditingSession: () => {},
      onCancelEditingSession: () => {},
      onSaveEditingSession: () => {},
      onProjectSelect: () => {},
      onSessionSelect: () => {},
      onDeleteSession: () => {},
      onLoadMoreSessions: () => {},
      onNewSession: () => {},
      isShowingHiddenSessions: isShowingHidden,
      onToggleShowHidden,
      onEditSessionFilter,
      t,
    }),
  );
  return { ...view, onToggleShowHidden, onEditSessionFilter };
};

beforeEach(() => {
  localStorage.clear();
  projectSessionsMock.mockReset();
  saveFilterMock.mockReset();
  projectSessionsMock.mockImplementation(async (_projectId: string, options: { includeHidden?: boolean }) => ({
    ok: true,
    json: async () => (options.includeHidden
      ? { sessions: ALL_SESSIONS, sessionMeta: { total: 128, hasMore: false, hiddenCount: 0 } }
      : { sessions: VISIBLE_SESSIONS, sessionMeta: { total: 14, hasMore: false, hiddenCount: 114 } }),
  }));
});

test('the bar is absent when nothing is hidden and shows the count otherwise', () => {
  const none = renderSessions(makeProject(0));
  assert.equal(none.queryByTestId('session-filter-bar'), null);
  none.unmount();

  const some = renderSessions(makeProject(114));
  assert.ok(some.getByTestId('session-filter-bar').textContent?.includes('已隐藏 114 个'));

  fireEvent.click(some.getByText('显示'));
  assert.equal(some.onToggleShowHidden.mock.calls[0][0], 'project-1');
  fireEvent.click(some.getByText('编辑规则'));
  assert.equal(some.onEditSessionFilter.mock.calls[0][0].projectId, 'project-1');
});

test('while showing hidden sessions the bar offers to collapse them again', () => {
  const view = renderSessions(makeProject(114), true);
  assert.ok(view.getByText('收起'));
});

const renderFilterHook = () => renderHook(() => {
  const [projects, setProjects] = useState<Project[]>([makeProject(114)]);
  const filter = useProjectSessionFilter({
    projects,
    setProjects,
    getKeepSessionIds: () => ['running-1', 'selected-1'],
  });
  return { ...filter, projects };
});

test('show re-requests with includeHidden=true, persists locally, survives a reload and collapses again', async () => {
  const first = renderFilterHook();

  act(() => first.result.current.toggleShowHidden('project-1'));
  await waitFor(() => assert.equal(first.result.current.projects[0].sessions?.length, 128));

  const requestedHidden = projectSessionsMock.mock.calls.filter(([, options]) => options.includeHidden === true);
  assert.equal(requestedHidden.length, 1);
  assert.deepEqual(requestedHidden[0][1].keepSessionIds, ['running-1', 'selected-1']);
  assert.deepEqual(JSON.parse(localStorage.getItem('sidebarShownHiddenSessionProjects') ?? '[]'), ['project-1']);
  // The bar keeps its count while everything is shown: the server reports 0 under includeHidden.
  assert.equal(first.result.current.projects[0].sessionMeta?.hiddenCount, 114);
  // Showing is browser-local: the project's stored rules are never written.
  assert.equal(saveFilterMock.mock.calls.length, 0);
  first.unmount();

  // "Refresh": a fresh hook instance reads the persisted choice.
  const second = renderFilterHook();
  assert.ok(second.result.current.showHiddenProjectIds.has('project-1'));
  assert.equal(second.result.current.getSessionRequestOptions('project-1').includeHidden, true);

  projectSessionsMock.mockClear();
  act(() => second.result.current.toggleShowHidden('project-1'));
  await waitFor(() => assert.equal(second.result.current.projects[0].sessions?.length, 14));
  assert.ok(projectSessionsMock.mock.calls.every(([, options]) => options.includeHidden === false));
  assert.equal(localStorage.getItem('sidebarShownHiddenSessionProjects'), null);
  assert.equal(second.result.current.getSessionRequestOptions('project-1').includeHidden, false);
  assert.equal(saveFilterMock.mock.calls.length, 0);
});
