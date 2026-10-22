import assert from 'node:assert/strict';

import { act, render, renderHook } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test, vi } from 'vitest';

import ChatComposer from '@/modules/chat/composer/ChatComposer';
import { useSendOnEnter } from '@/modules/chat/hooks/useSendOnEnter';
import enChat from '@/modules/i18n/locales/en/chat.json';
import { api } from '@/shared/api';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import type * as UserSettings from '@/shared/userSettings';
import { writeUserPreference, writeUserPreferences } from '@/shared/userSettings';
import type { QueuedDraft } from '@/shared/types';

/**
 * On a phone the soft keyboard's Return sent the message, and it had no Shift to offer as the
 * newline alternative — so a touch-only device had no way to insert a newline at all, and an
 * empty Enter was a dead key that neither sent nor broke the line.
 *
 * The fix is a device-scoped send key: `useSendOnEnter` resolves Enter's behaviour from the
 * *input capabilities* of the device in hand.
 *
 * The composer no longer prints a hint for such a device at all. Every sentence it could print
 * names a keyboard key — Enter, Shift+Enter, Ctrl+Enter — and a soft keyboard has none of them,
 * so there is no wording that would be true; the row is hidden instead, at every width. What a
 * touch device *does* still gets said, by the button: tapping it sends, and tapping it while a
 * turn runs queues.
 *
 * These tests hold the two halves that jsdom can hold honestly: the policy (which device gets
 * which behaviour, and that it never writes itself into the account preference) and the hint
 * the user reads. jsdom implements no media queries, so the double below is the "device"; that
 * the browser really answers `(pointer: coarse) and (hover: none)` for a touch device — and that
 * the hidden row really has `display: none` at every viewport width — is the e2e spec's job,
 * not something a unit test can stand in for.
 */

/** The query the hook must ask about — the double answers only this exact string, so a renamed query fails here. */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/** The mocked module's own shape, taken from the namespace import so the two cannot drift. */
type UserSettingsModule = typeof UserSettings;

vi.mock('@/shared/userSettings', async (importOriginal) => {
  const actual = await importOriginal<UserSettingsModule>();
  // Replaced rather than spied on: what the tests below read is the call count, and a spy left
  // on a module namespace is not the binding the hook would reach for.
  return { ...actual, writeUserPreference: vi.fn() };
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

type MediaDouble = {
  /** Flips the device between touch-only and keyboard, notifying the hook the way a real `change` event would. */
  setTouchOnly: (matches: boolean) => void;
};

/**
 * Stands in for `window.matchMedia`, which jsdom does not implement.
 *
 * `matches` is a getter rather than a snapshot so a flip is observable, and only `TOUCH_ONLY_QUERY`
 * can ever answer true: a hook that asked a different question would be told "not touch" and the
 * touch cells below would fail rather than pass on a loose double.
 */
const installMatchMedia = (initialTouchOnly: boolean): MediaDouble => {
  let touchOnly = initialTouchOnly;
  const listeners = new Set<() => void>();

  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === TOUCH_ONLY_QUERY && touchOnly;
    },
    media: query,
    onchange: null,
    addEventListener: (_event: 'change', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_event: 'change', listener: () => void) => {
      listeners.delete(listener);
    },
    addListener: (listener: () => void) => {
      listeners.add(listener);
    },
    removeListener: (listener: () => void) => {
      listeners.delete(listener);
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  return {
    setTouchOnly: (matches) => {
      touchOnly = matches;
      for (const listener of listeners) {
        listener();
      }
    },
  };
};

/** What the composer resolved for one device. */
type SendKeyReading = { sendOnEnter: boolean; touchOnly: boolean };

/** Resolves the send key for one cell of the (device × stored preference) matrix. */
const readSendKey = (touchOnly: boolean, sendByCtrlEnter: boolean): SendKeyReading => {
  installMatchMedia(touchOnly);
  const view = renderHook(() => useSendOnEnter(sendByCtrlEnter));
  const reading = { ...view.result.current };
  view.unmount();
  return reading;
};

/**
 * All four cells, read together.
 *
 * Every cell's failure message carries this, because a wrong cell is only diagnosable next to the
 * other three: `{sendOnEnter:true, touchOnly:true}` means the device gate was read but ignored,
 * `{sendOnEnter:false, touchOnly:false}` means the preference was, and both differ from a plain
 * inversion of either input.
 */
const readMatrix = (): Record<string, SendKeyReading> => ({
  'touch×pref-off': readSendKey(true, false),
  'touch×pref-on': readSendKey(true, true),
  'keyboard×pref-off': readSendKey(false, false),
  'keyboard×pref-on': readSendKey(false, true),
});

const matrixMessage = (cell: string, matrix: Record<string, SendKeyReading>) =>
  `${cell} is wrong; the four cells read ${JSON.stringify(matrix)}`;

test('a touch-only device with the preference off: Enter is the newline key, not the send key', () => {
  const matrix = readMatrix();

  assert.deepEqual(
    matrix['touch×pref-off'],
    { sendOnEnter: false, touchOnly: true },
    matrixMessage('touch×pref-off', matrix),
  );
});

test('a touch-only device with the preference on: the preference does not change the answer', () => {
  const matrix = readMatrix();

  assert.deepEqual(
    matrix['touch×pref-on'],
    { sendOnEnter: false, touchOnly: true },
    matrixMessage('touch×pref-on', matrix),
  );
});

test('a device with a keyboard and the preference off: Enter sends', () => {
  const matrix = readMatrix();

  assert.deepEqual(
    matrix['keyboard×pref-off'],
    { sendOnEnter: true, touchOnly: false },
    matrixMessage('keyboard×pref-off', matrix),
  );
});

test('a device with a keyboard and the preference on: Enter breaks the line, Ctrl+Enter sends', () => {
  const matrix = readMatrix();

  assert.deepEqual(
    matrix['keyboard×pref-on'],
    { sendOnEnter: false, touchOnly: false },
    matrixMessage('keyboard×pref-on', matrix),
  );
});

test('the device resolution follows a mid-session change, so a docked tablet is not stuck', () => {
  const media = installMatchMedia(true);
  const view = renderHook(() => useSendOnEnter(false));

  assert.deepEqual(
    { ...view.result.current },
    { sendOnEnter: false, touchOnly: true },
    'the hook must start from the media query, not from a default',
  );

  // A keyboard attached to a tablet flips the query while the composer is open; the key has to
  // follow it rather than keep the value it read on first paint.
  act(() => media.setTouchOnly(false));

  assert.deepEqual(
    { ...view.result.current },
    { sendOnEnter: true, touchOnly: false },
    'attaching a keyboard must hand Enter back to the preference without a reload',
  );
  view.unmount();
});

/** The preference debounce is 400ms; waiting it out keeps a seeded write from being counted against the leg. */
const PREFERENCE_WRITE_DEBOUNCE_MS = 400;
const settlePreferenceServerWrites = () =>
  new Promise((resolve) => setTimeout(resolve, PREFERENCE_WRITE_DEBOUNCE_MS + 100));

test('resolving the send key for a device writes nothing into the account preference', async () => {
  const media = installMatchMedia(true);
  // The implementation is stubbed because the *seeding* write below must go through the real
  // debounce and the real store; jsdom has no server to accept the resulting request.
  const savePreferences = vi
    .spyOn(api.user, 'savePreferences')
    .mockResolvedValue({} as Response);

  // Both stored values, because the tempting bug has two shapes: pinning the preference to true on
  // touch ("Enter must break the line, so make the setting say so") and pinning it to false.
  for (const stored of [false, true]) {
    writeUserPreferences({ uiPreferences: { ...readStoredUiPreferences(), sendByCtrlEnter: stored } });
    await settlePreferenceServerWrites();
    assert.equal(
      readStoredUiPreferences().sendByCtrlEnter,
      stored,
      `the leg must start from the stored sendByCtrlEnter=${stored} it means to test`,
    );

    vi.mocked(writeUserPreference).mockClear();
    savePreferences.mockClear();

    const view = renderHook(() => useSendOnEnter(readStoredUiPreferences().sendByCtrlEnter));
    // Both directions of the flip, so a hook that only stayed quiet on its first resolution is caught.
    act(() => media.setTouchOnly(false));
    act(() => media.setTouchOnly(true));
    view.unmount();

    assert.equal(
      readStoredUiPreferences().sendByCtrlEnter,
      stored,
      `a touch-only device must leave the stored sendByCtrlEnter=${stored} alone: it decides its own `
        + 'Enter behaviour and writes nothing back, which is the scope Slack and Teams give the same setting',
    );
    assert.equal(
      vi.mocked(writeUserPreference).mock.calls.length,
      0,
      'the device resolution must not write a preference through the local store',
    );
    assert.equal(
      savePreferences.mock.calls.length,
      0,
      'the device resolution must not push a preference to the account either',
    );
  }
});

/** Everything the composer needs to render, taken from the component itself so the two cannot drift. */
type ComposerProps = React.ComponentProps<typeof ChatComposer>;

/** Base props for rendering the real composer; only the ones a hint case varies are overridden. */
const COMPOSER_PROPS: ComposerProps = {
  pendingPermissionRequests: [],
  handlePermissionDecision: () => undefined,
  handleGrantToolPermission: () => ({ success: true }),
  activity: null,
  isLoading: false,
  onAbortSession: () => undefined,
  permissionMode: 'default',
  availablePermissionModes: [],
  onSelectPermissionMode: () => undefined,
  providerLabel: 'Claude',
  effort: '',
  availableEffortOptions: [],
  onSelectEffort: () => undefined,
  model: 'test-model',
  availableModelOptions: [],
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
  inputHighlightRef: React.createRef<HTMLDivElement>(),
  renderInputWithMentions: (text: string) => text,
  textareaRef: React.createRef<HTMLTextAreaElement>(),
  input: '',
  scope: null,
  projectId: null,
  isActive: true,
  onInputChange: () => undefined,
  onTextareaClick: () => undefined,
  onTextareaKeyDown: () => undefined,
  onTextareaPaste: () => undefined,
  onTextareaScrollSync: () => undefined,
  onTextareaInput: () => undefined,
  placeholder: 'Type your message...',
  isTextareaExpanded: false,
  sendByCtrlEnter: false,
};

/** Renders the real composer and returns its hint line, which is the only place the send key is described. */
const renderHint = (overrides: Partial<ComposerProps> = {}): { text: string; className: string } => {
  const { container } = render(
    <UiPreferencesProvider>
      <ChatComposer {...COMPOSER_PROPS} {...overrides} />
    </UiPreferencesProvider>,
  );
  const hint = container.querySelector('div.basis-full');
  assert.ok(hint, 'the composer must render its hint line at all');
  return { text: hint.textContent ?? '', className: hint.getAttribute('class') ?? '' };
};

const QUEUED_DRAFT: QueuedDraft = { content: 'queued', attachments: [] };

/** Every wording the composer can still print — the four keyboard branches, read off the locale file. */
const KEYBOARD_WORDINGS = new Set<string>([
  enChat.input.hintText.enter,
  enChat.input.hintText.ctrlEnter,
  enChat.input.hintText.queue,
  enChat.input.hintText.updateQueued,
]);

test('a touch-only device is shown no hint at any width, and no touch wording survives to be shown', () => {
  installMatchMedia(true);

  // The hint row is `basis-full`, so it costs the footer a whole line — and a touch-only device is
  // the one class of device with the least vertical room to spare. It is hidden rather than
  // reworded, because every sentence the composer can print names a key a soft keyboard does not
  // have. `hidden` alone, never `hidden lg:block`: that pair would lift the hiding at ≥1024px and
  // hand a landscape tablet the keyboard wording, whose Shift its soft keyboard cannot press.
  const cases: { name: string; props: Partial<ComposerProps> }[] = [
    { name: 'idle, preference off', props: { sendByCtrlEnter: false } },
    { name: 'idle, preference on', props: { sendByCtrlEnter: true } },
    { name: 'mid-turn, nothing queued', props: { sendByCtrlEnter: false, isLoading: true, input: 'hello' } },
    {
      name: 'mid-turn, a draft queued',
      props: { sendByCtrlEnter: false, isLoading: true, input: 'hello', queuedDraft: QUEUED_DRAFT },
    },
  ];

  for (const { name, props } of cases) {
    const hint = renderHint(props);
    assert.ok(
      /\bhidden\b/.test(hint.className),
      `a touch device must be shown no hint (${name}); the row's class read ${JSON.stringify(hint.className)}`,
    );
    assert.ok(
      !hint.className.includes('lg:block'),
      `the hiding must hold at every width, so nothing may lift it at lg (${name}): `
        + `${JSON.stringify(hint.className)}`,
    );
    // The convergence, stated positively: with the touch branches gone, what a touch device resolves
    // is one of the keyboard wordings. A revived touch branch — even via a `defaultValue` fallback —
    // puts a string here that is in no locale file.
    assert.ok(
      KEYBOARD_WORDINGS.has(hint.text),
      `a touch device must resolve to a keyboard wording, not to wording of its own (${name}): `
        + `${JSON.stringify(hint.text)} is in none of ${JSON.stringify([...KEYBOARD_WORDINGS])}`,
    );
  }
});

test('a device with a keyboard prints the same hint it printed before, character for character', () => {
  installMatchMedia(false);

  const cases: { name: string; props: Partial<ComposerProps>; expected: string }[] = [
    { name: 'preference off', props: { sendByCtrlEnter: false }, expected: enChat.input.hintText.enter },
    { name: 'preference on', props: { sendByCtrlEnter: true }, expected: enChat.input.hintText.ctrlEnter },
    {
      name: 'mid-turn, nothing queued',
      props: { sendByCtrlEnter: false, isLoading: true, input: 'hello' },
      expected: enChat.input.hintText.queue,
    },
    {
      name: 'mid-turn, a draft queued',
      props: { sendByCtrlEnter: false, isLoading: true, input: 'hello', queuedDraft: QUEUED_DRAFT },
      expected: enChat.input.hintText.updateQueued,
    },
  ];

  for (const { name, props, expected } of cases) {
    const hint = renderHint(props);
    assert.equal(
      hint.text,
      expected,
      `with a keyboard, ${name} must print exactly the string the locale file ships: the composer `
        + `printed ${JSON.stringify(hint.text)}, the locale file holds ${JSON.stringify(expected)}`,
    );
  }

  // The positive control for the touch case above: "hidden, but never lg:block" must not be
  // reachable by deleting the class everywhere, because a keyboard device keeps the hiding it
  // always had — invisible below lg, visible from lg up.
  const keyboardHint = renderHint({ sendByCtrlEnter: false });
  assert.ok(
    /\bhidden\b/.test(keyboardHint.className) && keyboardHint.className.includes('lg:block'),
    `a keyboard hint keeps its below-lg hiding: ${JSON.stringify(keyboardHint.className)}`,
  );
});
