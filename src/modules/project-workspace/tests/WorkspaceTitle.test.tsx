import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import enCommon from '@/modules/i18n/locales/en/common.json';
import WorkspaceTitle from '@/modules/project-workspace/WorkspaceTitle';

/**
 * `WorkspaceTitle.getTabTitle` returns the workspace header's heading text. The Quay branch
 * used to `return 'quay'` — a bare literal that never went through `t()` — so the header
 * read lowercase `quay` while every other branch was translated. These cases render the real
 * component and read the heading it produces, because the defect is the *value* the branch
 * returns, not a prop it receives.
 */

// The title component subscribes to the plugins store for plugin-tab display names; the Quay
// branch never consults it, so an empty store is enough and keeps the render off the network.
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [], loading: false, pluginsError: null }),
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const PROJECT: Project = {
  projectId: 'quay-i18n-probe',
  displayName: 'Quay 探针项目名称',
  fullPath: '/home/odoo/workspace/quay-i18n-probe',
};

/** The one `<h2>` WorkspaceTitle renders for a non-chat tab, read as trimmed text. */
function headingText(container: HTMLElement): string {
  const heading = container.querySelector('h2');
  assert.ok(heading, 'WorkspaceTitle must render an h2 heading for a non-chat tab');
  return (heading.textContent ?? '').trim();
}

test('the Quay header title comes from tabs.quay, not the bare literal "quay"', () => {
  const { container } = render(
    <WorkspaceTitle
      activeTab="quay"
      selectedProject={PROJECT}
      selectedSession={null}
      shouldShowTasksTab={false}
      shouldShowQuayTab
    />,
  );

  // The English bundle must not itself hold the literal, or the two assertions below would
  // both pass over a header that still shows the defect.
  assert.notEqual(enCommon.tabs.quay, 'quay', 'the en bundle must carry a real label for tabs.quay');

  const text = headingText(container);
  assert.notEqual(
    text,
    'quay',
    `the Quay header must not fall back to the bare literal "quay"; heading was ${JSON.stringify(text)}`,
  );
  assert.equal(
    text,
    enCommon.tabs.quay,
    `the Quay header must equal tabs.quay from the translation table; heading was ${JSON.stringify(text)}`,
  );
});

// Reverse control: the Quay branch is gated on `shouldShowQuayTab`, so with the flag off the
// heading must fall through to the generic fallback rather than leak the Quay label.
test('without shouldShowQuayTab the heading falls through to the project fallback', () => {
  const { container } = render(
    <WorkspaceTitle
      activeTab="quay"
      selectedProject={PROJECT}
      selectedSession={null}
      shouldShowTasksTab={false}
    />,
  );

  assert.equal(
    headingText(container),
    enCommon.misc.projectFallback,
    'a Quay tab that is not offered must not render the Quay label',
  );
});
