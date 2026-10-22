import assert from 'node:assert/strict';

import { act, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import ResidentSessionBadge from '@/modules/chat/transcript/ResidentSessionBadge';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type {
  ChatMessage,
  Project,
  ProjectSession,
  ProviderModelActions,
} from '@/shared/types';

/**
 * The resident surface is not the transcript's.
 *
 * The status bar used to be a row of its own above the transcript's scroll
 * container: the transcript reserved space for it, and whether it was inside or
 * outside the `overflow-y-auto` box was a real question with a real symptom — a
 * bar inside the box scrolled with the messages and came to rest over the row
 * below it. The bar is gone, and so is the dock's arrow that replaced it: the
 * resident facts are the panel of the pill in the workspace header, which is
 * outside the transcript altogether. So the reading this file holds is the
 * structural half of that move, stated on a resident session:
 *
 *   - the **transcript** carries no resident surface at all — no bar, no address,
 *     no pid, no busy/idle word — so there is no row above the messages for one,
 *     and nothing inside the pane for the scroll to carry over a row;
 *   - and the very same selectors **do** match the panel the pill draws, which is
 *     what keeps the first reading from passing against a page that simply
 *     dropped the resident surface.
 *
 * Both arms are read on real rendered trees — the pane with its own props, and
 * the pill on a resident session — and neither is asserted against a value this
 * file also wrote.
 *
 * jsdom parses no Tailwind and lays nothing out, so whether the panel is really
 * reachable by a pointer at 780x493 is the browser probe's job
 * (`e2e/resident-ui-layout.spec.ts -g "resident pill"` opens it on a real page); this case is the
 * structure that makes it so.
 */

const RESIDENT_SESSION_ID = 'session-resident';

/** The pane's own selector. */
const PANE_SELECTOR = '.chat-messages-pane';

/**
 * Every marker the resident surface used to put on the page, and the identity and
 * lifecycle markers the pill's panel still carries. The first list must not match
 * inside the transcript; the second must match inside the pill's panel.
 */
const ACTIVITY_MARKERS = [
  '[data-resident-status-bar]',
  '[data-resident-ui-state]',
  '[data-resident-state-text]',
  '[data-resident-lease-summary]',
  '[data-lease-kind]',
] as const;
const PANEL_MARKERS = [
  '[data-resident-address]',
  '[data-resident-pid-text]',
  '[data-resident-copy]',
  '[data-resident-close]',
] as const;

/**
 * The `GET /api/session-hosts` answer the panel renders from: one resident
 * session, held by one idle host.
 *
 * Built inside `vi.hoisted` because the mock below is hoisted above the imports
 * and would otherwise read this before it exists. Only the hook is replaced —
 * `findSessionHost`, `findSessionHostState` and `findBinding` are the real ones,
 * run against this snapshot — so the answer the panel draws itself from is the
 * same code path the page runs.
 */
const { snapshot } = vi.hoisted(() => {
  const appSessionId = 'session-resident';
  const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    snapshot: {
      hosts: [
        {
          hostId: 'host-1',
          provider: 'claude' as const,
          mode: 'resident',
          state: 'idle',
          pid: 4242,
          startedAt,
          closeReason: null,
          closeDetail: null,
          bindings: [
            {
              appSessionId,
              providerSessionId: 'provider-session-1',
              state: 'idle',
              leases: [],
              lastActivityAt: startedAt,
              peerName: 'resident-host',
            },
          ],
        },
      ],
      sessions: [
        {
          appSessionId,
          provider: 'claude' as const,
          lifecycleMode: 'resident',
          running: true,
          reason: null,
        },
      ],
    },
  };
});

vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot,
      error: null,
      loading: false,
      refresh: async () => undefined,
      start: async () => undefined,
      close: async () => undefined,
    }),
  };
});

/** jsdom ships no media queries; the device rule the pane reads is the width one. */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

/** One assistant turn: enough for the pane to be in its ordinary, non-empty state. */
const messages: ChatMessage[] = [
  { type: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:00.000Z' },
];

/** The pane's own props, only as far as a transcript with a message needs them. */
const paneProps = (): React.ComponentProps<typeof ChatMessagesPane> => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  chatMessages: messages,
  selectedSession: { id: RESIDENT_SESSION_ID } as ProjectSession,
  currentSessionId: RESIDENT_SESSION_ID,
  provider: 'claude' as const,
  setProvider: () => undefined,
  textareaRef: { current: null },
  providerModels: { claude: 'claude-sonnet-4-5', cursor: 'cursor-small', codex: 'codex-mini', opencode: 'opencode-default' },
  setProviderModel: () => undefined,
  providerModelCatalog: {},
  providerModelActions: {} as ProviderModelActions,
  providerModelsLoading: false,
  tasksEnabled: false,
  isTaskMasterInstalled: null,
  setInput: () => undefined,
  isLoadingMoreMessages: false,
  hasMoreMessages: false,
  totalMessages: messages.length,
  sessionMessagesCount: messages.length,
  visibleMessageCount: messages.length,
  visibleMessages: messages,
  loadEarlierMessages: () => undefined,
  loadAllMessages: () => undefined,
  allMessagesLoaded: true,
  isLoadingAllMessages: false,
  loadAllJustFinished: false,
  showLoadAllOverlay: false,
  createDiff: () => undefined,
  onGrantToolPermission: () => ({ success: true }),
  selectedProject: project,
});

const renderPane = () => {
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane {...paneProps()} />
    </UiPreferencesProvider>,
  );
  const pane = view.container.querySelector<HTMLElement>(PANE_SELECTOR);
  assert.ok(pane, `the pane must render its scroll container (${PANE_SELECTOR})`);
  return { view, pane };
};

/**
 * The pill as a resident session draws it, with its panel opened.
 *
 * The panel is a portal to `body`, so it is read from `document` and not from the render container:
 * that it is *not* inside the container is the point of it, and the first arm above reads the pane
 * for exactly that reason.
 */
const renderOpenBadge = () => {
  const view = render(React.createElement(ResidentSessionBadge, { sessionId: RESIDENT_SESSION_ID }));
  const badge = view.container.querySelector<HTMLElement>('[data-resident-badge]');
  assert.ok(badge, 'premise: a resident session must draw the pill that opens its panel');
  act(() => {
    fireEvent.click(badge);
  });
  const panel = document.querySelector<HTMLElement>('[data-resident-badge-panel]');
  assert.ok(panel, 'premise: the pill must open the panel');
  return { view, panel };
};

beforeEach(() => {
  installMatchMedia();
  setViewportWidth(1280);
});

afterEach(() => {
  vi.useRealTimers();
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

test('(a) a resident transcript carries no resident surface of its own', () => {
  const { view, pane } = renderPane();

  const found = ACTIVITY_MARKERS.filter((marker) => pane.querySelector(marker) !== null);
  console.log(`transcript.residentMarkers=${JSON.stringify(found)}`);
  assert.deepEqual(
    found,
    [],
    'the transcript must carry no resident surface — not a bar, not a busy/idle word, not a lease count; '
      + `the header pill is where those live, and the pane found ${JSON.stringify(found)}`,
  );

  // And nothing outside the pane either: the row the bar used to occupy is not merely
  // re-parented somewhere else in this tree.
  const outside = ACTIVITY_MARKERS.filter(
    (marker) => view.container.querySelector(marker) !== null && pane.querySelector(marker) === null,
  );
  console.log(`transcript.outsideResidentMarkers=${JSON.stringify(outside)}`);
  assert.deepEqual(outside, [], 'the resident surface must not be drawn anywhere in the transcript tree');
  view.unmount();
});

test('(b) the same markers do match the pill\'s panel, so (a) is not a reading of a dropped surface', () => {
  const { view, panel } = renderOpenBadge();

  const missing = PANEL_MARKERS.filter((marker) => panel.querySelector(marker) === null);
  console.log(`badge.panelMarkers.missing=${JSON.stringify(missing)}`);
  assert.deepEqual(
    missing,
    [],
    'the identity and lifecycle controls must exist somewhere — the pill\'s panel — or the absence in (a) '
      + `would be satisfied by deleting the resident surface rather than merging it; missing ${JSON.stringify(missing)}`,
  );
  assert.equal(
    (panel.textContent ?? '').includes('4242'),
    true,
    `the panel must carry the host's own pid; it reads ${JSON.stringify(panel.textContent)}`,
  );
  view.unmount();
});
