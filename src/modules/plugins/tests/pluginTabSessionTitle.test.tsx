import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { test, vi } from 'vitest';

import { getSessionTitle } from '@/shared/utils';
import type { ProjectSession } from '@/shared/types';

/**
 * A plugin tab is handed the selected session through `session.title`, and that
 * field used to be resolved as `title || name || id` while the workspace header,
 * the document title and the sidebar all read `getSessionTitle`. A tab could
 * therefore label the selected session with a stale name or with the raw id
 * while everything around it agreed. These cases pin the tab to that authority.
 *
 * The plugin module is served through the plugin asset endpoint the component
 * really fetches from and really imports, so what is asserted below is the
 * context an actual plugin receives — not a re-statement of the expression
 * under test. That is what makes the anti-fake arm meaningful: swapping the
 * implementation back to `title || name || id` turns these red.
 */

/** The plugin's own source: it writes the session title it was handed onto its container. */
const PLUGIN_SOURCE = `
export function mount(container, host) {
  const render = (ctx) => {
    container.setAttribute('data-session-title', ctx.session ? ctx.session.title : '');
  };
  render(host.context);
  host.onContextChange(render);
}
`;

const ENABLED_PLUGIN = [{ name: 'probe', enabled: true, entry: 'index.js' }];

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleTheme: () => {} }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/modules/plugins/context/PluginsContext', () => ({
  usePlugins: () => ({
    plugins: ENABLED_PLUGIN,
    loading: false,
    pluginsError: null,
    refreshPlugins: async () => {},
    installPlugin: async () => ({ success: true }),
    uninstallPlugin: async () => ({ success: true }),
    updatePlugin: async () => ({ success: true }),
    togglePlugin: async () => ({ success: true, error: null }),
  }),
}));

vi.mock('@/shared/api', () => ({
  api: {
    plugins: {
      asset: async () => new Response(PLUGIN_SOURCE, { status: 200 }),
    },
  },
}));

const { PluginTabContent } = await import('@/modules/plugins');

/**
 * jsdom has no `URL.createObjectURL` and no blob module loader, so the fetched
 * plugin source is handed back as a `data:` URL — which Node's loader does
 * understand. The Blob is stubbed alongside it because its text must be read
 * synchronously to build that URL.
 */
class ReadableBlob {
  readonly text: string;

  constructor(parts: string[]) {
    this.text = parts.join('');
  }
}

vi.stubGlobal('Blob', ReadableBlob);
(URL as unknown as { createObjectURL: (blob: unknown) => string }).createObjectURL = (blob) =>
  `data:text/javascript;base64,${Buffer.from((blob as ReadableBlob).text).toString('base64')}`;
URL.revokeObjectURL = () => {};

/** The title the mounted plugin last reported, or null while it has not mounted yet. */
const mountedTitle = (host: HTMLElement): string | null =>
  host.querySelector('[data-session-title]')?.getAttribute('data-session-title') ?? null;

const renderTab = (selectedSession: ProjectSession | null) => {
  const host = document.createElement('div');
  document.body.appendChild(host);

  return {
    host,
    ...render(
      <PluginTabContent pluginName="probe" selectedProject={null} selectedSession={selectedSession} />,
      { container: host },
    ),
  };
};

/** Waits until the plugin has mounted, then returns the title it reported. */
const reportedTitle = async (host: HTMLElement): Promise<string | null> => {
  await waitFor(() => assert.notEqual(mountedTitle(host), null));
  return mountedTitle(host);
};

test('a session whose only name is its summary reaches the plugin as that summary', async () => {
  // The discriminating case: the old expression fell past `summary` to the id.
  const session: ProjectSession = { id: 's-summary', summary: 'Renamed by summary' };
  const { host } = renderTab(session);

  assert.equal(await reportedTitle(host), 'Renamed by summary');
  assert.equal(mountedTitle(host), getSessionTitle(session));
});

test('a Cursor session whose only name is its `name` reaches the plugin as that name', async () => {
  const session: ProjectSession = { id: 's-name', name: 'Cursor name', __provider: 'cursor' };
  const { host } = renderTab(session);

  assert.equal(await reportedTitle(host), 'Cursor name');
  assert.equal(mountedTitle(host), getSessionTitle(session));
});

test('a session with neither a summary nor a name gets whatever the authority says, not the id', async () => {
  const session: ProjectSession = { id: 's-unnamed' };
  const { host } = renderTab(session);

  const title = await reportedTitle(host);
  // No value is invented here: the contract is `getSessionTitle` itself, which
  // owns the fallback for an unnamed session.
  assert.equal(title, getSessionTitle(session));
  assert.notEqual(title, session.id);
});

test('a rename is pushed into the already-mounted plugin instead of waiting for a remount', async () => {
  const before: ProjectSession = { id: 's-live', summary: 'Before' };
  const after: ProjectSession = { id: 's-live', summary: 'After' };
  const { host, rerender } = renderTab(before);

  assert.equal(await reportedTitle(host), 'Before');

  rerender(
    <PluginTabContent pluginName="probe" selectedProject={null} selectedSession={after} />,
  );

  await waitFor(() => assert.equal(mountedTitle(host), 'After'));
});
