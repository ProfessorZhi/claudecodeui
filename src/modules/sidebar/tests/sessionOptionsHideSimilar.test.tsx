import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import type { Project } from '@/shared/types';

/** "Hide similar" in the session menu opens the rules editor with a derived rule, unsaved. */

const previewMock = vi.fn();
const saveMock = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    previewProjectSessionFilter: (...args: unknown[]) => previewMock(...args),
    saveProjectSessionFilter: (...args: unknown[]) => saveMock(...args),
  },
}));
// The sidebar reads both capability sets; the resident one is stubbed empty so the
// "convert to resident" item stays out of the menu this test asserts on.
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set<string>(),
  useResidentProviders: () => new Set<string>(),
}));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({
    copyState: 'idle', copyLabel: 'Copy session ID', setOptionsOpen: () => {},
    handleCopyAction: () => {}, isCopyPending: false, CopyStateIcon: () => null,
  }),
}));

const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');
const { default: SessionFilterEditor } = await import('@/modules/sidebar/SessionFilterEditor');

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  defaultNS: 'sidebar',
  resources: { en: { sidebar: enSidebar } },
  interpolation: { escapeValue: false },
});
const t = i18n.t.bind(i18n) as unknown as React.ComponentProps<typeof SessionOptions>['t'];

const projectWith = (hide: string[]) => ({
  projectId: 'project-1',
  displayName: 'Repo',
  fullPath: '/repo',
  sessionFilter: hide.length > 0 ? { hide } : null,
  sessions: [],
  sessionMeta: { total: 0, hasMore: false, hiddenCount: 0 },
}) as unknown as Project;

/** Mirrors Sidebar's wiring: the menu action sets the seed name and opens the editor. */
function Harness({ project }: { project: Project }) {
  const [seed, setSeed] = React.useState<string | null>(null);
  return (
    <>
      <SessionOptions
        sessionId="s1"
        sessionName="claudecodeui-task-worker"
        provider="claude"
        projectId="project-1"
        isProcessing={false}
        isEditing={false}
        renameDraft=""
        onRenameDraftChange={() => {}}
        onStartEditingSession={() => {}}
        onCancelEditingSession={() => {}}
        onSaveEditingSession={() => {}}
        onDeleteSession={() => {}}
        onHideSimilar={setSeed}
        t={t}
      />
      {seed !== null && (
        <SessionFilterEditor project={project} seedSessionName={seed} onClose={() => setSeed(null)} onSaved={() => {}} t={t} />
      )}
    </>
  );
}

const openHideSimilar = () => {
  fireEvent.click(screen.getByLabelText('Session options for claudecodeui-task-worker'));
  fireEvent.click(screen.getByText('Hide similar'));
};

beforeEach(() => {
  previewMock.mockReset();
  saveMock.mockReset();
  previewMock.mockResolvedValue({ ok: true, json: async () => ({ data: { preview: null } }) });
});

test('hide similar opens the editor with the derived rule appended and saves nothing', () => {
  render(<Harness project={projectWith(['^old$'])} />);
  openHideSimilar();

  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  assert.equal(textarea.value, '^old$\nclaudecodeui-task-worker');
  assert.equal(saveMock.mock.calls.length, 0);
});

test('a rule that is already present is not appended again', () => {
  render(<Harness project={projectWith(['claudecodeui-task-worker'])} />);
  openHideSimilar();

  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  assert.equal(textarea.value, 'claudecodeui-task-worker');
  assert.ok(screen.getByText('This rule already exists'));
  assert.equal(saveMock.mock.calls.length, 0);
});
