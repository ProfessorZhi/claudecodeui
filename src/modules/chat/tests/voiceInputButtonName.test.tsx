import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import VoiceInputButton from '@/modules/chat/composer/VoiceInputButton';
import enChat from '@/modules/i18n/locales/en/chat.json';

/**
 * The composer's icon buttons had no accessible name.
 *
 * `PromptInputButton` shows its `tooltip` in a self-drawn layer, which produces
 * neither a `title` attribute nor an accessible name — so the mic and clear
 * buttons were anonymous, and the commands button's only text was its badge
 * count, which made "11" the name a screen reader announced instead of "show all
 * commands". The assertions below go through `getByRole`, not through the
 * attribute: a name added to the wrong element, or one that never reaches the
 * button, still renders and would satisfy an attribute check.
 *
 * Real translations rather than a stub `t`, because the point is the name a user
 * actually hears, and the mic's name has to follow the recording state.
 */

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const renderButton = (state: 'idle' | 'recording' | 'transcribing') =>
  render(React.createElement(VoiceInputButton, { state, onToggle: () => {} }));

test('an idle mic carries the dictation name', () => {
  const { getByRole } = renderButton('idle');

  assert.equal(
    getByRole('button', { name: 'Voice input' }).getAttribute('type'),
    'button',
    'the mic must be reachable by its dictation name',
  );
});

test('a recording mic carries the stop name instead of the dictation one', () => {
  const { getByRole, queryByRole } = renderButton('recording');

  assert.ok(
    getByRole('button', { name: 'Stop recording' }),
    'while recording the button has to announce that pressing it stops',
  );
  assert.equal(
    queryByRole('button', { name: 'Voice input' }),
    null,
    'the idle name must not survive into the recording state — otherwise a screen reader cannot tell the states apart',
  );
});
