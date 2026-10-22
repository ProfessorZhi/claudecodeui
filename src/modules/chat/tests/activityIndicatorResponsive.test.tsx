import assert from 'node:assert/strict';

import { act, render, renderHook, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import ChatComposer from '@/modules/chat/composer/ChatComposer';
import ChatMessagesPane from '@/modules/chat/transcript/ChatMessagesPane';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type {
  ActivityConnection,
  ChatMessage,
  NormalizedMessage,
  Project,
  ProjectSession,
  ProviderModelActions,
  ServerEvent,
  SessionActivity,
} from '@/shared/types';

/**
 * The running turn's status is one surface at every viewport.
 *
 * From `md` up it used to be a tab-shaped strip the composer hung off the input's
 * top edge — floating, and therefore over the transcript, which is why the pane
 * reserved space for it — and below `md` a compact line at the end of the list.
 * Those were two mount sites for one component, and the pair could disagree. They
 * are one surface now: an in-flow status line at the end of the message flow, at
 * every width and height, carrying no control of its own. The composer's submit
 * button is the one stop entry on every tier.
 *
 * jsdom parses no Tailwind and lays nothing out, so what these cases read is what
 * the DOM can answer: which surface exists at which width, what it contains,
 * where the inline line sits in the document, and which classes the pane's
 * padding is built from. The tier is switched by the signal the components
 * themselves read — `window.innerWidth` against the `md` boundary — so an
 * implementation that switched on some other signal would take the same branch
 * here and these cases would pass against a second copy of the rule. That the real
 * box really scrolls with its messages, really does not overlap the last one, and
 * really exposes one Stop is the browser probe's job, not a unit test's.
 */

const MOBILE_WIDTH = 390;
/** One pixel under the `md` boundary: the narrow tier's own edge. */
const NARROW_EDGE_WIDTH = 767;
const DESKTOP_WIDTH = 768;
const WIDE_DESKTOP_WIDTH = 1280;

/** A fixed clock, so an elapsed reading is a number the case can name. */
const START = Date.parse('2026-01-01T00:00:00.000Z');
const EXIT_ANIMATION_MS = 220;

const ACTIVITY: SessionActivity = {
  statusText: 'Reviewing',
  canInterrupt: true,
  startedAt: START,
};

/** The session these cases report on; the dock ignores frames for any other id. */
const SESSION_ID = 'session-a';

/**
 * An in-memory liveness channel, so a case can hand the dock frames without a
 * socket. The elapsed reading now comes from what the server says (`asOf`) and
 * not from the local clock, so a case that wants a number to read must send one.
 */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection: ActivityConnection = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isConnected: true,
  };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

/** A hello frame for the running turn, with the threshold the server would announce. */
const subscribedFrame = (timestamp = START, overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: 60_000,
  timestamp: new Date(timestamp).toISOString(),
  ...overrides,
});

/** A bare heartbeat that advances the server's `asOf` without changing the turn. */
const heartbeatFrame = (timestamp: number): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  timestamp: new Date(timestamp).toISOString(),
});

/** The signal both surfaces read for the tier (`useDeviceSettings`). */
const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

/**
 * The second signal the same hook reads. jsdom's own window is 768px tall — the tall tier — so a
 * case that does not set this keeps reading the surface it read before the height tier existed.
 */
const setViewportHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
};

/** A phone held sideways: 844px clears `md`, and 330px is a real landscape height with browser chrome. */
const LANDSCAPE_WIDTH = 844;
const LANDSCAPE_HEIGHT = 330;
const TALL_HEIGHT = 900;

/**
 * The device the render is on. The short tier reads this beside the height, so the double has to
 * answer it: one that said "no" to every query would leave the tier unreachable.
 */
const device = { touchOnly: false };
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/** jsdom ships no media queries; the width rule is `innerWidth`, and this is the device rule. */
const installMatchMedia = () => {
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === TOUCH_ONLY_QUERY ? device.touchOnly : false;
    },
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
};

/**
 * The dock's one marker.
 *
 * The two surfaces this file used to tell apart — the composer's tab-shaped
 * strip and the transcript's compact in-flow line — are one component behind one
 * attribute now, and one mount site: the pane's scroll column. What is no longer
 * possible is for the two to be two different things: there is no second slot to
 * find and no variant to pick.
 */
const DOCK = '[data-activity-dock]';
const PANE_SELECTOR = '.chat-messages-pane';

const dockIn = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLElement>(DOCK);

/** What the dock reads, or a named absence — a case that finds nothing must say so, not print "undefined". */
const describeDock = (view: { container: HTMLElement }) => {
  const row = dockIn(view);
  return row ? `<${row.tagName.toLowerCase()} class="${row.className}">${row.textContent ?? ''}` : '<no activity dock>';
};

const paneOf = (view: { container: HTMLElement }) =>
  view.container.querySelector<HTMLElement>(PANE_SELECTOR);

const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};

const messages: ChatMessage[] = [
  { type: 'user', content: 'question', timestamp: '2026-01-01T00:00:00.000Z' },
  { type: 'assistant', content: 'answer', timestamp: '2026-01-01T00:00:01.000Z' },
];

/**
 * The pane's own props, only as far as a transcript with messages needs them.
 * `hasActivityIndicator` is the composer's reading of "a turn is running and no
 * permission request has taken the status over"; `activity` is the same turn.
 */
const paneProps = (overrides: Partial<React.ComponentProps<typeof ChatMessagesPane>> = {}) => ({
  scrollContainerRef: { current: null },
  scrollContentRef: () => undefined,
  onWheel: () => undefined,
  onTouchMove: () => undefined,
  isLoadingSessionMessages: false,
  isProcessing: true,
  hasActivityIndicator: true,
  activity: ACTIVITY,
  chatMessages: messages,
  selectedSession: { id: 'session-a' } as ProjectSession,
  currentSessionId: 'session-a',
  provider: 'claude' as const,
  setProvider: () => undefined,
  textareaRef: { current: null },
  providerModels: { claude: 'claude-sonnet-4-5' },
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
  selectedProject: project,
  showThinking: true,
  ...overrides,
});

const renderPane = (
  width: number,
  overrides: Partial<React.ComponentProps<typeof ChatMessagesPane>> = {},
  height: number = TALL_HEIGHT,
  touchOnly: boolean = false,
) => {
  setViewportWidth(width);
  setViewportHeight(height);
  device.touchOnly = touchOnly;
  // The real preferences owner, not a stub: a message row reads the voice
  // preference to decide whether to offer its speak control, and a stub would
  // be a second implementation of what the row is entitled to read.
  const view = render(
    <UiPreferencesProvider>
      <ChatMessagesPane {...(paneProps(overrides) as React.ComponentProps<typeof ChatMessagesPane>)} />
    </UiPreferencesProvider>,
  );
  const pane = paneOf(view);
  assert.ok(pane, `the pane must render its scroll container (${PANE_SELECTOR})`);
  return { view, pane };
};

/**
 * The composer's own props, only as far as a render with no transcript beside it
 * needs them. This case reads only whether the composer's subtree contains a
 * dock — the composer no longer knows the surface exists.
 */
const composerProps = () => ({
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: ACTIVITY,
  isLoading: true,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: ['default'],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: 'medium',
  availableEffortOptions: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
  onSelectEffort: () => undefined,
  model: 'claude-sonnet-4-5-20250929',
  availableModelOptions: [{ value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' }],
  onSelectModel: () => undefined,
  modelsLoading: false,
  tokenBudget: null,
  onShowTokenUsage: () => undefined,
  slashCommandsCount: 0,
  onToggleCommandMenu: () => undefined,
  hasInput: false,
  onClearInput: () => undefined,
  onSubmit: () => undefined,
  isDragActive: false,
  queuedDraft: null,
  isEditingSentMessage: false,
  onCancelEditMessage: () => undefined,
  scheduledMessages: [],
  onScheduleMessage: () => undefined,
  onCancelScheduledMessage: () => undefined,
  onEditQueuedDraft: () => undefined,
  onDeleteQueuedDraft: () => undefined,
  attachedFiles: [],
  onRemoveAttachment: () => undefined,
  fileErrors: new Map<string, string>(),
  showFileDropdown: false,
  filteredFiles: [],
  selectedFileIndex: 0,
  onSelectFile: () => undefined,
  filteredCommands: [],
  selectedCommandIndex: 0,
  onCommandSelect: () => undefined,
  onCloseCommandMenu: () => undefined,
  isCommandMenuOpen: false,
  frequentCommands: [],
  getRootProps: () => ({}),
  getInputProps: () => ({}),
  openAttachmentPicker: () => undefined,
  inputHighlightRef: { current: null },
  renderInputWithMentions: () => null,
  textareaRef: { current: null },
  input: '',
  onVoiceTranscript: () => undefined,
  scope: 'session-a',
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Ask anything',
  isTextareaExpanded: false,
});

const renderComposer = (width: number) => {
  setViewportWidth(width);
  setViewportHeight(TALL_HEIGHT);
  device.touchOnly = false;
  return render(
    <UiPreferencesProvider>
      <ChatComposer {...(composerProps() as React.ComponentProps<typeof ChatComposer>)} />
    </UiPreferencesProvider>,
  );
};

// The real voice hooks ask the backend whether a provider is configured; the
// composer render below is about the status surface, not the mic, so the two
// hooks are doubled the way the composer's own responsive file doubles them.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => false }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

beforeEach(() => {
  installMatchMedia();
  setViewportWidth(WIDE_DESKTOP_WIDTH);
  setViewportHeight(TALL_HEIGHT);
  device.touchOnly = false;
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Every accessible button whose name says stop, inside a subtree — the reading the criterion counts. */
const stopButtons = (root: HTMLElement) => within(root).queryAllByRole('button', { name: /stop/i });

test('(a) the status line reads the activity and the elapsed time, and offers no control', () => {
  // At every viewport the running turn is drawn the same way: an in-flow line
  // that carries no interrupt control, because the composer's submit is the one
  // stop entry. A dock that drew a control anyway would be a second one, and that
  // is the count this case exists to keep at zero.
  const { connection, push } = makeConnection();
  const view = render(
    React.createElement(ActivityIndicator, {
      activity: ACTIVITY,
      sessionId: SESSION_ID,
      connection,
    }),
  );
  push(subscribedFrame());
  const row = dockIn(view);
  assert.ok(row, `the dock must render a status line (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);

  const text = row.textContent ?? '';
  assert.ok(text.includes('Reviewing'), `the status line must name the activity; it reads "${text}"`);
  assert.ok(text.includes('0s'), `the status line must show the elapsed time; it reads "${text}"`);

  const found = stopButtons(row);
  assert.equal(
    found.length,
    0,
    `no status line may carry a Stop — the composer's submit button is the one stop entry; it carries ${found.length}: ${row.outerHTML}`,
  );
  assert.equal(
    (row.outerHTML.match(/aria-label/gi) ?? []).length,
    0,
    `the status line must expose no named control at all; it reads ${row.outerHTML}`,
  );
});

test('(b) from md up the pane draws the status line at the end of the message flow, in the flow', () => {
  // The column the transcript's content-growth follow observes is the node the
  // pane hands to `scrollContentRef`. Capturing it here is what lets the case
  // assert the status line is inside *that* box rather than merely inside the
  // pane: a line rendered beside the column would scroll with the message list
  // and still be invisible to the follow. This is the desktop reading — the
  // former tab's viewport — and the same shape is asserted for every tier below.
  let observedColumn: HTMLDivElement | null = null;
  const { view, pane } = renderPane(WIDE_DESKTOP_WIDTH, {
    scrollContentRef: (node: HTMLDivElement | null) => {
      observedColumn = node;
    },
  });
  const row = dockIn(view);
  assert.ok(row, `the desktop pane must render the inline status line; DOM: ${view.container.innerHTML.slice(0, 400)}`);

  assert.ok(
    pane.contains(row),
    `the status line must live inside the scroll container, or it could not scroll with the messages; it reads ${describeDock(view)}`,
  );
  assert.ok(observedColumn, 'premise: the pane must hand its content column to the follow');
  assert.ok(
    (observedColumn as HTMLDivElement | null)?.contains(row),
    `the status line must be inside the column the content-growth follow observes, or its growth would not be followed; it reads ${describeDock(view)}`,
  );

  const rows = Array.from(pane.querySelectorAll('[data-message-timestamp]'));
  assert.ok(rows.length > 0, 'premise: the pane must have rendered message rows');
  const lastRow = rows[rows.length - 1];
  assert.ok(
    (lastRow.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    `the status line must come after the last message in the document; it reads ${describeDock(view)}`,
  );

  const positional = Array.from(row.classList).filter((name) => /^(absolute|fixed)$/.test(name));
  assert.deepEqual(
    positional,
    [],
    `the status line must stay in the flow — no absolute or fixed positioning; class="${row.className}"`,
  );
});

test('(c) the desktop composer subtree holds no activity dock', () => {
  const view = renderComposer(WIDE_DESKTOP_WIDTH);
  const shell = view.container.querySelector<HTMLElement>('.chat-composer-shell');
  assert.ok(shell, 'premise: the composer must render its shell (so the reading is about a render that happened)');
  assert.equal(
    shell.querySelectorAll(DOCK).length,
    0,
    `the composer must draw no status surface of its own; DOM: ${shell.innerHTML.slice(0, 400)}`,
  );
  assert.equal(
    view.container.querySelectorAll(DOCK).length,
    0,
    'exactly zero docks, however they are found',
  );
});

test('(d) the status line plays its exit animation when the activity clears, at either tier', () => {
  // The component owns the collapse, not the pane's mount decision: the line is
  // mounted for the whole time the pane is, and `activity` going null is what
  // animates it out. The reading is the same at a phone width and a desktop one —
  // there is no second surface whose teardown could differ.
  const readings: string[] = [];

  for (const width of [MOBILE_WIDTH, WIDE_DESKTOP_WIDTH]) {
    setViewportWidth(width);
    const view = render(
      React.createElement(ActivityIndicator, { activity: ACTIVITY }),
    );
    const mounted = dockIn(view);
    assert.ok(mounted, `premise: the status line must be mounted while the turn runs (${width}px)`);

    act(() => {
      view.rerender(React.createElement(ActivityIndicator, { activity: null }));
    });

    const exiting = dockIn(view);
    readings.push(`${width}px at +0ms ${exiting ? 'present' : 'gone'}${exiting ? ` (class="${exiting.className}")` : ''}`);
    assert.ok(
      exiting,
      `the status line must stay mounted through its exit animation; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      exiting.className.includes('chat-activity-exit'),
      `the status line must animate out rather than disappear; readings: ${readings.join(' | ')}`,
    );

    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    const after = dockIn(view);
    readings.push(`${width}px at +${EXIT_ANIMATION_MS}ms ${after ? 'present' : 'gone'}`);
    assert.equal(
      after,
      null,
      `the status line must be gone once the exit animation has run; readings: ${readings.join(' | ')}`,
    );

    view.unmount();
  }
});

test('(e) the elapsed reading follows the server clock and ignores the local one', () => {
  const readings: string[] = [];
  const elapsedOf = (view: { container: HTMLElement }) => {
    const matched = (view.container.textContent ?? '').match(/\d+m \d+s|\d+s/);
    return matched ? matched[0] : '<no elapsed reading>';
  };

  const { connection, push } = makeConnection();
  const view = render(
    React.createElement(ActivityIndicator, { activity: ACTIVITY, sessionId: SESSION_ID, connection }),
  );

  // A threshold far past the window below, so the local-clock step cannot degrade the dock and the
  // reading it produces is about the clock source alone.
  push(subscribedFrame(START, { unreachableAfterMs: 600_000 }));

  const atStart = elapsedOf(view);
  readings.push(`at ${new Date(START).toISOString()}: "${atStart}"`);
  assert.equal(atStart, '0s', `a turn the server just anchored must read 0s; readings: ${readings.join(' | ')}`);

  // Time passing on the client is not evidence of anything: with no frame, the reading holds.
  act(() => {
    vi.advanceTimersByTime(65_000);
  });
  const afterClock = elapsedOf(view);
  readings.push(`after a 65s local-clock step: "${afterClock}"`);
  assert.equal(
    afterClock,
    '0s',
    `the elapsed reading must not be driven by the client's clock; readings: ${readings.join(' | ')}`,
  );

  // A server frame does move it: the reading is the server's own `asOf` minus the turn's anchor.
  push(heartbeatFrame(START + 65_000));
  const later = elapsedOf(view);
  readings.push(`at server +65s: "${later}"`);
  assert.equal(
    later,
    '1m 5s',
    `the reading must advance with the server's clock; readings: ${readings.join(' | ')}`,
  );
});

test('(e) the tier no longer changes where the status line is drawn', () => {
  // Every viewport now draws the same surface. A build that kept the tab for any
  // width or height would show a dock in the composer's shell, or none in the
  // pane, in one of these cells — so each cell reads both.
  const readings: string[] = [];

  const cells = [
    { label: 'mobile', width: MOBILE_WIDTH, height: TALL_HEIGHT, touchOnly: false },
    { label: 'narrow edge (767)', width: NARROW_EDGE_WIDTH, height: TALL_HEIGHT, touchOnly: false },
    { label: 'desktop edge (768)', width: DESKTOP_WIDTH, height: TALL_HEIGHT, touchOnly: false },
    { label: 'wide desktop', width: WIDE_DESKTOP_WIDTH, height: TALL_HEIGHT, touchOnly: false },
    { label: 'short landscape', width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT, touchOnly: true },
  ] as const;

  for (const cell of cells) {
    const { view, pane } = renderPane(cell.width, {}, cell.height, cell.touchOnly);
    const row = dockIn(view);
    readings.push(`${cell.label}: dock=${row ? 'in the pane' : 'absent'}`);
    assert.ok(
      row,
      `the status line must be in the pane at ${cell.label}; DOM: ${view.container.innerHTML.slice(0, 300)}`,
    );
    assert.ok(pane.contains(row), `the status line must be inside the scroll container at ${cell.label}`);
    const positional = Array.from(row.classList).filter((name) => /^(absolute|fixed)$/.test(name));
    assert.deepEqual(positional, [], `the status line must stay in the flow at ${cell.label}; class="${row.className}"`);
    // And nothing is reserved for a floating tab that is not drawn.
    assert.equal(
      Array.from(pane.classList).includes('pb-12'),
      false,
      `a pane that carries the line itself must not also reserve the tab's space; class="${pane.className}"`,
    );
    view.unmount();
  }
});

test('the pane\'s bottom space no longer depends on the turn', () => {
  const readings: string[] = [];
  const paddingOf = (className: string) => className.split(/\s+/).filter((name) => /^pb-/.test(name)).join(' ');

  for (const width of [MOBILE_WIDTH, NARROW_EDGE_WIDTH, DESKTOP_WIDTH, WIDE_DESKTOP_WIDTH]) {
    const running = renderPane(width);
    const idle = renderPane(width, { hasActivityIndicator: false, activity: null });
    readings.push(`@${width} running: "${paddingOf(running.pane.className)}" idle: "${paddingOf(idle.pane.className)}"`);
    assert.equal(
      paddingOf(running.pane.className),
      paddingOf(idle.pane.className),
      `a running turn must not change the pane's bottom space at any width; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      running.pane.className.includes('pb-12'),
      false,
      `the tab's reserved space must be gone at every width; readings: ${readings.join(' | ')}`,
    );
    running.view.unmount();
    idle.view.unmount();
  }
});

/* ------------------------------------------------------------------------- *
 * The status line is growth the transcript's follow already answers
 * ------------------------------------------------------------------------- */

/**
 * The other half of the placement decision.
 *
 * A status line in the flow is not enough on its own: while it sits at the end
 * of the transcript, the reader who is at the bottom must stay there as the line
 * arrives and as its elapsed reading widens, and the reader who has taken the
 * scroll over must not be dragged back by it. The pane answers both by putting
 * the line inside the content column the follow already observes, so its growth
 * is answered by the code that answers every other growth — under the same
 * "the user has not scrolled away" gate. The arm is run at a phone width and at a
 * desktop one, because the line is one surface on both and neither may be the
 * only one the follow answers.
 *
 * jsdom lays nothing out, so this case cannot measure a row. What it does
 * instead is take the two things the browser would report — the column is taller
 * (declared by the fixture) and the notification that a column resized has
 * arrived — and read what the follow wrote. The line's *presence in the observed
 * column* is pinned by case (b) above, against the pane's own ref wiring; the
 * two together are the claim, and neither is complete alone.
 */

const FOLLOW_SESSION_ID = 'session-a';

/** Animation frames the follow deferred its write to; the case below runs them by hand. */
let pendingFrames: FrameRequestCallback[] = [];

const runFrames = () => {
  const frames = pendingFrames;
  pendingFrames = [];
  for (const frame of frames) {
    frame(0);
  }
};

/**
 * A scroll container whose geometry the case declares. jsdom reports
 * scrollHeight/clientHeight as 0 and swallows every scrollTop assignment, so a
 * fixture that did not declare them could only ever observe the trivial case.
 *
 * Each write records the bottom as it stood at that moment. The case has two
 * growths in it, so the container's bottom when the reads are compared is not
 * the bottom a write had to hit — recording both is what keeps the assertion
 * "this write landed on the bottom" true for every write and not just the last.
 */
function createFollowContainer(scrollHeight: number, clientHeight: number) {
  const element = document.createElement('div');
  const writes: Array<{ top: number; bottom: number }> = [];
  let height = scrollHeight;
  let viewport = clientHeight;
  let top = scrollHeight - clientHeight;

  Object.defineProperty(element, 'scrollHeight', { get: () => height });
  Object.defineProperty(element, 'clientHeight', { get: () => viewport });
  Object.defineProperty(element, 'scrollTop', {
    get: () => top,
    set: (next: number) => {
      top = next;
      writes.push({ top: next, bottom: height - viewport });
    },
  });

  return {
    element: element as HTMLDivElement,
    writes,
    /** The offset a pinned viewport sits at. */
    get bottom() {
      return height - viewport;
    },
    get scrollTop() {
      return top;
    },
    /** Grows the content the way a taller last row — or a status line arriving — does. */
    grow: (delta: number) => {
      height += delta;
    },
    /** Moves the viewport the way a gesture does: no write is recorded. */
    scrollTo: (next: number) => {
      top = next;
    },
  };
}

/** Stands in for the browser's ResizeObserver, which jsdom does not ship. */
class FakeResizeObserver {
  static latest: FakeResizeObserver | null = null;
  readonly observed: Element[] = [];
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.latest = this;
  }

  observe(target: Element) {
    this.observed.push(target);
  }

  unobserve() {}

  disconnect() {
    this.observed.length = 0;
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const buildMessage = (index: number, timestamp: string): NormalizedMessage => ({
  id: `m-${index}`,
  kind: 'text',
  role: index % 2 === 0 ? 'user' : 'assistant',
  provider: 'claude',
  sessionId: FOLLOW_SESSION_ID,
  content: `message ${index}`,
  timestamp,
} as NormalizedMessage);

/** A hydrated slot, so the session-loading effect takes its early return instead of re-fetching. */
function createSessionStore(messagesBySession: Map<string, NormalizedMessage[]>) {
  const slotFor = (sessionId: string) => ({
    fetchedAt: 1,
    status: 'idle' as const,
    total: messagesBySession.get(sessionId)?.length ?? 0,
    hasMore: false,
    offset: messagesBySession.get(sessionId)?.length ?? 0,
  });

  return {
    fetchFromServer: vi.fn(async (sessionId: string) => slotFor(sessionId)),
    fetchMore: vi.fn(async (sessionId: string) => ({ slot: slotFor(sessionId), prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async (sessionId: string) => ({
      slot: slotFor(sessionId),
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((sessionId: string) => messagesBySession.get(sessionId) ?? []),
    getSessionSlot: vi.fn((sessionId: string) => slotFor(sessionId)),
  };
}

/** How much of the row's shape the case declares, in the pixels the browser would have reported. */
const ROW_ARRIVAL_PX = 20;
const ELAPSED_WIDENING_PX = 2;

describe("the transcript's content-growth follow over the inline status line", () => {
  beforeEach(() => {
    pendingFrames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrames.push(callback);
      return pendingFrames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // The hook reads the session's token usage once per session; a stubbed fetch
    // answers it without reaching the network, and this case is not about it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        headers: { get: () => null },
        json: async () => ({}),
      })),
    );
    FakeResizeObserver.latest = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Renders the session-state hook over a resizable container with the case's
   * content column attached to the follow, and settles the baseline layout —
   * the session-open scroll and the attach-time resize, both drained and
   * asserted quiet, so that every write the case reads afterwards is the follow
   * answering the growth the case declares.
   */
  async function mountFollowArm(withRow: boolean, width: number) {
    setViewportWidth(width);
    const session = { id: FOLLOW_SESSION_ID } as ProjectSession;
    const messagesBySession = new Map([
      [FOLLOW_SESSION_ID, [buildMessage(0, '2026-01-01T00:00:00.000Z')]],
    ]);
    const store = createSessionStore(messagesBySession);

    const { useChatSessionState } = await import('@/modules/chat/hooks/useChatSessionState');
    const { result, rerender } = renderHook(
      ({ session: current }: { session: ProjectSession }) =>
        useChatSessionState({
          isActive: true,
          selectedProject: project,
          selectedSession: current,
          ws: null,
          sendMessage: vi.fn(),
          resetStreamingState: vi.fn(),
          statusCheckSentAtRef: { current: new Map() },
          lastSeqRef: { current: new Map() },
          sessionStore: store as never,
        }),
      { initialProps: { session } },
    );

    const container = createFollowContainer(5000, 500);
    const content = document.createElement('div');
    document.body.appendChild(content);

    // The status line goes where the pane puts it: as a child of the column the
    // follow observes. Rendering it through a real root over that node is what
    // makes the reading below something the line can affect — a line rendered
    // anywhere else could not, whatever the follow wrote.
    const rowView = withRow
      ? render(
          React.createElement(ActivityIndicator, { activity: ACTIVITY }),
          { container: content },
        )
      : null;

    // The order React really commits in: the content column is the pane's child,
    // so its ref callback runs while the pane's ref is still null, and the render
    // below is what runs the layout effect that points the observer at it.
    act(() => {
      (result.current.scrollContentRef as unknown as (node: HTMLDivElement | null) => void)(content);
    });
    (result.current.scrollContainerRef as { current: HTMLDivElement | null }).current = container.element;
    act(() => {
      rerender({ session });
    });

    const observer = FakeResizeObserver.latest;
    assert.ok(observer, 'premise: attaching the content column must install a ResizeObserver');
    assert.deepEqual(
      observer.observed,
      [content, container.element],
      'premise: the content column and the pane it scrolls in are both watched',
    );

    // The session-open scroll is a writer of its own, and it is armed late: the
    // effect that starts it bails while the hook is still loading, so it is the
    // store's fetch settling — a microtask, not a frame — that arms it. A fixed
    // number of frames would therefore be enough or not depending on when that
    // microtask lands, and a chain that re-arms every frame while the height is
    // still changing would survive a longer one. So it is driven to completion
    // instead: flush the pending work, drain the frames that arms, and repeat
    // until a whole round raises nothing. Its writes would otherwise land in the
    // windows below and be read as the follow reacting to growth that had not
    // happened yet — the reading would then be of the wrong writer entirely.
    let rounds = 0;
    for (; rounds < 12; rounds += 1) {
      await act(async () => {
        await Promise.resolve();
      });
      act(() => {
        runFrames();
      });
      // A pane with nowhere to scroll is held at one offset whatever a writer
      // asks for; the fixture assigns rather than clamps, so the clamp is
      // applied here — and the chain's own writes are what the round is about.
      container.scrollTo(Math.min(container.scrollTop, container.bottom));
      const quiet = container.writes.length === 0 && pendingFrames.length === 0;
      container.writes.length = 0;
      if (quiet) break;
    }
    assert.ok(
      rounds < 12,
      'premise: the session-open scroll must go quiet before the window below opens, not keep re-arming',
    );

    // The baseline: the follow judges a resize against the layout before it, so
    // the attach-time layout has to be delivered once before anything is asked.
    act(() => {
      observer.emit();
    });
    act(() => {
      runFrames();
    });
    container.writes.length = 0;

    return { container, content, observer, rowView, result };
  }

  /** The status text changing, as the row it belongs to re-renders in place. */
  const ACTIVITY_WIDER: SessionActivity = { ...ACTIVITY, statusText: 'Finalizing' };

  test('growth from the status line reads exactly as growth from any other row', async () => {
    const readings: string[] = [];
    const modes = [
      { name: 'pinned', owns: false, drifts: false, follows: true },
      { name: 'owned', owns: true, drifts: false, follows: false },
      { name: 'scrolled up', owns: true, drifts: true, follows: false },
    ] as const;

    for (const width of [MOBILE_WIDTH, WIDE_DESKTOP_WIDTH]) {
      const byArm: Record<string, Array<{ top: number; bottom: number }>> = {};

      for (const mode of modes) {
        for (const withRow of [true, false]) {
          const armName = `@${width} ${mode.name}, ${withRow ? 'with' : 'without'} the status line`;
          const { container, content, observer, rowView, result } = await mountFollowArm(withRow, width);

          if (withRow) {
            const row = rowView?.container.querySelector<HTMLElement>(DOCK);
            assert.ok(row, 'premise: the status line must have mounted inside the content column');
            assert.ok(
              content.contains(row),
              'premise: the observed column must contain the status line, or its growth could not reach the follow',
            );
          }

          if (mode.drifts) {
            // A drag that carried the viewport off the bottom; the offset moves and
            // no write is recorded, exactly as a gesture leaves it.
            container.scrollTo(container.bottom - 300);
          }
          if (mode.owns) {
            act(() => {
              result.current.setIsUserScrolledUp(true);
            });
          }

          // The line arriving: it is in the column, so the column is taller, and
          // the browser says so.
          container.grow(ROW_ARRIVAL_PX);
          act(() => {
            observer.emit();
          });
          act(() => {
            runFrames();
          });

          if (withRow) {
            const before = rowView?.container.textContent ?? '';
            act(() => {
              rowView?.rerender(
                React.createElement(ActivityIndicator, {
                  activity: ACTIVITY_WIDER,
                }),
              );
            });
            const after = rowView?.container.textContent ?? '';
            assert.notEqual(
              after,
              before,
              `premise: the elapsed reading must have advanced on the row the follow just answered; it still reads "${after}"`,
            );
          }

          // ...and the reading widening is growth too, in the same row.
          container.grow(ELAPSED_WIDENING_PX);
          act(() => {
            observer.emit();
          });
          act(() => {
            runFrames();
          });

          const writes = [...container.writes];
          byArm[armName] = writes;
          readings.push(`${armName}: ${writes.length} write(s) ${JSON.stringify(writes.map((write) => write.top))}`);

          if (mode.follows) {
            assert.ok(
              writes.length > 0,
              `a reader at the bottom must be carried down by the status line's growth; readings: ${readings.join(' | ')}`,
            );
            const stray = writes.filter((write) => write.top !== write.bottom);
            assert.deepEqual(
              stray,
              [],
              `every follow write must land on the bottom as it stood when the write was made; readings: ${readings.join(' | ')}`,
            );
          } else {
            assert.deepEqual(
              writes,
              [],
              `a reader who has taken the scroll over must not be moved by the status line — zero programmatic writes; readings: ${readings.join(' | ')}`,
            );
          }
        }
      }

      for (const mode of modes) {
        const withRow = byArm[`@${width} ${mode.name}, with the status line`];
        const withoutRow = byArm[`@${width} ${mode.name}, without the status line`];
        assert.deepEqual(
          withRow,
          withoutRow,
          `the status line must not change the follow's reading at ${width}px, ${mode.name}: with it wrote ${JSON.stringify(withRow?.map((write) => write.top))}, without it ${JSON.stringify(withoutRow?.map((write) => write.top))} — ${readings.join(' | ')}`,
        );
      }
    }
  });
});
