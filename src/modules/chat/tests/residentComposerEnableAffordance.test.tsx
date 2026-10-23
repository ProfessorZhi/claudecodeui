import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import React from 'react';
import { afterEach, test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { ResidentToggle } from '@/modules/chat/composer/ResidentConsentNotice';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The composer no longer carries a resident switch — the affordance lives only on the new-session
 * empty state's model card.
 *
 * jsdom parses no Tailwind and renders no real host listing, but the decision this criterion is about
 * is a structural one: does the switch's `<button>` exist inside the composer at all, for either a
 * session stored `resident` or one stored `per-run`? It must not, in either case — the composer is not
 * a place a session is converted any more. What a real browser lays out on the two existing sessions
 * plus the empty state is the e2e probe's job (`e2e/resident-ui-layout.spec.ts`), not a unit test's.
 *
 * The reading is an absence, and an absence is only evidence when the same selector finds the thing
 * somewhere. So the two composer cases are paired with a direct render of `ResidentToggle` — the very
 * component the empty state mounts — which must publish `[data-resident-enable="true"]`. That is the
 * positive control: the marker is live, and the composer lacks it by removal rather than by the
 * selector never matching.
 *
 * The last case is the ledger's own reading of the removal: the module-level one-shot (the
 * `set…ResidentIntent` / `consume…ResidentIntent` pair) that used to carry the intent from the
 * composer to the send path must be gone from every source file under `src/`. The pair's own names
 * are assembled from fragments below so this test does not reintroduce the very strings it searches
 * for.
 */

const SESSION_ID = 'session-under-test';

/** The marker `ResidentToggle` publishes, and the one the composer must not. */
const ENABLE = '[data-resident-enable="true"]';

/**
 * The host snapshot the composer reads, held mutable so each case can state the session's stored mode.
 *
 * `useSessionHosts` is the one seam doubled here: in jsdom there is no server to answer
 * `GET /api/session-hosts`, and the criterion is about what the component does with the answer, not
 * about how the answer is fetched. The real `findSessionHostState` is left in place, so the lookup the
 * component performs is the shipping one.
 */
const { hostFixture } = vi.hoisted(() => ({
  hostFixture: { snapshot: null as SessionHostsSnapshot | null },
}));

vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: hostFixture.snapshot,
      error: null,
      loading: false,
      refresh: async () => undefined,
      start: async () => undefined,
      close: async () => undefined,
    }),
  };
});

// The voice chain is not what this criterion is about; a plain install keeps the mic button the
// composer always draws from reaching for a recorder, a debug entry or a trim switch it has no reason
// to have. Same doubles as `chatComposerResponsive.test.tsx`.
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  // VAD on, the shipped default: keeps this whole-module replacement complete.
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
}));
vi.mock('@/modules/chat/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    toggle: () => undefined,
    stop: () => undefined,
    transcribeFile: () => undefined,
    clipSlot: null,
    clipPlayState: { original: 'idle', trimmed: 'idle' },
    toggleClipPlayback: () => undefined,
  }),
}));

/** A snapshot naming exactly one session and its stored mode — everything `findSessionHostState` reads. */
const snapshotWith = (sessionId: string, lifecycleMode: string): SessionHostsSnapshot => ({
  hosts: [],
  sessions: [{ appSessionId: sessionId, provider: 'claude', lifecycleMode, running: false, reason: null }],
});

/** jsdom implements no media queries at all; the composer's device rules must still find an answer. */
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
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 });
};

/**
 * The composer's props, only as far as a render with no turn, no attachments and no menus needs them.
 *
 * Taken from `chatComposerResponsive.test.tsx`, whose scaffold this file shares: every prop the
 * composer destructures without a default has to be present, and this is the known-good set.
 */
const baseProps = () => ({
  sessionId: SESSION_ID,
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
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
  scope: SESSION_ID,
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

/** Renders the real composer against the fixture snapshot and reports the switch marker it publishes. */
const renderComposer = () => {
  installMatchMedia();
  const view = render(
    React.createElement(ChatComposer, baseProps() as unknown as React.ComponentProps<typeof ChatComposer>),
  );
  assert.ok(
    view.container.querySelector('.chat-composer-shell'),
    'the composer must render its shell, or the counts below are readings of nothing',
  );
  return {
    switches: view.container.querySelectorAll(ENABLE).length,
  };
};

/** Every source file under `src/`, so the ledger reading below scans the whole tree. */
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
  const full = path.join(dir, entry);
  if (statSync(full).isDirectory()) return sourceFiles(full);
  return /\.(ts|tsx)$/.test(entry) ? [full] : [];
});

afterEach(() => {
  hostFixture.snapshot = null;
  document.body.innerHTML = '';
});

test('a per-run session already has no switch in the composer — the affordance is the empty state\'s', () => {
  hostFixture.snapshot = snapshotWith(SESSION_ID, 'per-run');
  const reading = renderComposer();
  assert.equal(
    reading.switches,
    0,
    'the composer is no longer a place a session becomes resident: the switch belongs to the '
      + 'new-session empty state, and a per-run session with a transcript must not draw one',
  );
});

test('a resident session has no switch in the composer either', () => {
  hostFixture.snapshot = snapshotWith(SESSION_ID, 'resident');
  const reading = renderComposer();
  assert.equal(
    reading.switches,
    0,
    'and a resident session draws none for the same reason — the composer draws no switch in either mode',
  );
});

test('the switch marker is live — the empty state\'s ResidentToggle still publishes it', () => {
  const view = render(
    React.createElement(ResidentToggle, { enabled: false, onToggle: () => undefined }),
  );
  assert.equal(
    view.container.querySelectorAll(ENABLE).length,
    1,
    'the absence above is only evidence while the same selector finds the switch where it does live; '
      + 'if this leg went to 0 the composer cases would be reading a dead selector',
  );
  document.body.innerHTML = '';
});

test('the module-level resident one-shot is gone from every source file', () => {
  // Assembled from fragments so this file does not itself contain the identifiers it scans for.
  const retiredNames = [
    ['setPending', 'ResidentIntent'].join(''),
    ['consumePending', 'ResidentIntent'].join(''),
  ];
  const retired = new RegExp(retiredNames.join('|'));
  const stale = sourceFiles(path.resolve(process.cwd(), 'src')).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return retired.test(source) ? [path.relative(process.cwd(), file)] : [];
  });
  assert.deepEqual(
    stale,
    [],
    'the intent travels as an argument from ChatInterface into useChatComposerState; a module-level '
      + 'one-shot would let a send into an existing session read a position the user set elsewhere',
  );
});
