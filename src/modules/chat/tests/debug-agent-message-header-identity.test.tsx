/**
 * A debug agent's reply is headed by the debug agent — in the name, not only in the mark.
 *
 * THE CLAIM, IN ONE SENTENCE. A message header carries two readings of the same identity: the
 * provider mark's accessible name and the provider name drawn beside it. For `provider: 'debug'`
 * both must say "Debug Agent"; for an id this build does not know, the name still falls back to
 * Claude, because the header has to draw *some* name and the fallback is what says "not a name of
 * its own" rather than nothing.
 *
 * WHY THE TWO READINGS ARE ONE ASSERTION. The app already drew the debug agent's beaker for
 * `provider: 'debug'` (`LLMProviderLogo`) while the name beside it read "Claude" — the mark and the
 * name disagreed about the same message, and the name is the half a screen reader announces as
 * text. Asserting only the name would let a future mark change drift away from it; asserting only
 * the mark would have passed against the defect. So the header is read as a pair, and every locale
 * is read as a pair.
 *
 * WHY THE UNKNOWN-PROVIDER ARM IS LOAD-BEARING. Without it, the cheapest way to make the first arm
 * pass is to delete the chain's final `t('messageTypes.claude')` — which turns "the header names
 * the unknown provider Claude" into "the header names it nothing", a silent blank where a label
 * used to be. That arm is red for such an implementation, so the fix can only be the `debug`
 * branch itself.
 *
 * WHAT IS REAL HERE. The locales are not listed in this file: the directories under
 * `src/modules/i18n/locales/` are enumerated at run time and each one's `chat.json` is read as
 * data, so a language added by a later commit is covered without editing this criterion, and a
 * locale that never received the key fails rather than falling back to English. The rendered
 * component is the shipped `MessageComponent`; i18next is a real instance over those same files
 * with `fallbackLng` off, so a missing key reds instead of being masked by the English copy.
 *
 * WHAT THIS FILE DOES NOT CLAIM. That the server reports `provider: 'debug'` for a debug session —
 * that is the session listing's own criterion. Here the provider id is given.
 *
 * Run: npx vitest run src/modules/chat/tests/debug-agent-message-header-identity.test.tsx
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

/* ─── The shipped locales, read from the tree rather than listed ─────────── */

// `process.cwd()` rather than `import.meta.url`: under vitest's jsdom environment `import.meta.url`
// is not a `file:` URL, so `fileURLToPath` throws at collection. The suite is always launched from
// the repository root.
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

/** Every directory the app ships translations in, enumerated at run time. */
const shippedLocales = (): string[] =>
  readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const readChatLocale = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'chat.json'), 'utf8')) as Record<string, unknown>;

/** The shipped value of a `messageTypes.*` key, or `undefined` when the locale has no such key. */
const messageTypeLabel = (locale: string, key: string): unknown =>
  (readChatLocale(locale).messageTypes as Record<string, unknown> | undefined)?.[key];

const LOCALES = shippedLocales();

await i18next.use(initReactI18next).init({
  lng: 'en',
  // Off on purpose: with a fallback left on, a locale that never received the key would render the
  // English copy and this file's per-locale readings would hold over a locale with no copy at all.
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: Object.fromEntries(
    LOCALES.map((locale) => [locale, { chat: readChatLocale(locale) }]),
  ) as unknown as Record<string, Record<string, string>>,
  interpolation: { escapeValue: false },
});

/* ─── The header, as the two readings it carries ─────────────────────────── */

const DEBUG_REPLY = 'a scripted reply from the debug provider.';

const assistantMessage = (): ChatMessage => ({
  type: 'assistant',
  content: DEBUG_REPLY,
  timestamp: '2026-08-21T10:00:00.000Z',
});

const createDiff = (): DiffLine[] => [];

/**
 * The mark's accessible name and the provider name printed beside it.
 *
 * The mark is the only `svg[role="img"]` a plain reply renders, and the header is the nearest
 * ancestor carrying the header's own layout class — so the name is read from the same row as the
 * mark rather than from anywhere else in the message.
 */
const readHeader = (container: HTMLElement): { markName: string; providerName: string } => {
  const mark = container.querySelector('svg[role="img"]');
  assert.ok(mark, 'expected the message header to render a provider mark');
  const header = mark.closest('.space-x-3');
  assert.ok(header, 'expected the provider mark to sit inside a message header row');
  const nameNode = header.querySelector('.font-medium');
  assert.ok(nameNode, 'expected the message header to print a provider name beside the mark');
  return {
    markName: mark.getAttribute('aria-label') ?? '',
    providerName: (nameNode.textContent ?? '').trim(),
  };
};

const renderHeader = (provider: string): { markName: string; providerName: string } => {
  // MessageSpeakControl reads the voice preference, so the real provider is needed rather than a stub.
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent
        message={assistantMessage()}
        prevMessage={null}
        createDiff={createDiff}
        provider={provider}
      />
    </UiPreferencesProvider>,
  );
  return readHeader(container);
};

/* ─── The readings ───────────────────────────────────────────────────────── */

test('a debug agent reply is headed by the debug agent, mark and name alike', async () => {
  await i18next.changeLanguage('en');
  const { markName, providerName } = renderHeader('debug');

  assert.equal(
    providerName,
    'Debug Agent',
    `the header of a debug agent reply must name the debug agent, but it read ${JSON.stringify(providerName)}`,
  );
  assert.equal(
    markName,
    providerName,
    `the mark says ${JSON.stringify(markName)} while the name beside it says ${JSON.stringify(providerName)}`,
  );
});

test('an id this build does not know still falls back to Claude', async () => {
  await i18next.changeLanguage('en');
  const { markName, providerName } = renderHeader('unknown-provider-xyz');

  assert.equal(
    providerName,
    messageTypeLabel('en', 'claude'),
    `an unrecognised provider must still be named Claude, but the header read ${JSON.stringify(providerName)}`,
  );
  assert.equal(
    markName,
    providerName,
    `the mark says ${JSON.stringify(markName)} while the name beside it says ${JSON.stringify(providerName)}`,
  );
});

test('every shipped locale names the debug agent, and its mark agrees', async () => {
  assert.ok(LOCALES.length > 0, 'expected at least one shipped locale directory');

  for (const locale of LOCALES) {
    const label = messageTypeLabel(locale, 'debug');
    assert.equal(
      typeof label,
      'string',
      `${locale}/chat.json: messageTypes.debug must be a string like its siblings, read ${JSON.stringify(label)}`,
    );
    assert.notEqual(
      (label as string).trim(),
      '',
      `${locale}/chat.json: messageTypes.debug is empty`,
    );

    // Nothing stays mounted while the language changes, so no earlier tree re-renders outside act.
    cleanup();
    await i18next.changeLanguage(locale);

    const { markName, providerName } = renderHeader('debug');
    assert.equal(
      providerName,
      label,
      `${locale}: the header of a debug agent reply must read ${JSON.stringify(label)}, but it read ${JSON.stringify(providerName)}`,
    );
    assert.equal(
      markName,
      providerName,
      `${locale}: the mark says ${JSON.stringify(markName)} while the name beside it says ${JSON.stringify(providerName)}`,
    );
  }

  cleanup();
  await i18next.changeLanguage('en');
});
