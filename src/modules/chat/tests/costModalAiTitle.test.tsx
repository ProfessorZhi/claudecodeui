import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { CommandModalPayload, CostCommandData } from '@/shared/types';

/**
 * The `/cost` modal's meta card listed the provider and the model, and nothing
 * about what the session is actually called.
 *
 * The title shown has to be the one Claude generated — not the session's name,
 * which a rename or a first-message fallback can have replaced — and the server
 * omits it entirely for every session whose transcript has none, so the modal
 * has to render nothing at all in that case rather than an "Unknown" row.
 *
 * Real translations rather than a stub `t`, and the real modal rather than
 * `CostContent` in isolation: the label has to reach the rendered output
 * through the dialog, and the ordering assertion below is about where it lands
 * inside the meta card.
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

const costPayload = (data: CostCommandData): CommandModalPayload => ({ kind: 'cost', data });

const renderCostModal = (data: CostCommandData) =>
  render(
    <CommandResultModal
      payload={costPayload(data)}
      onClose={() => {}}
      providerModelCatalog={{}}
      providerModelActions={{} as never}
      activeProvider="claude"
      activeProviderModel="sonnet"
      currentSessionId="session-1"
      onSelectProviderModel={async () => ({ scope: 'default', model: 'sonnet' })}
    />,
  );

/** Offset of the last element whose exact text is `text`, or -1. */
const positionOf = (text: string): number => {
  const matches = Array.from(document.querySelectorAll('p')).filter(
    (element) => element.textContent === text,
  );
  const last = matches[matches.length - 1];
  if (!last) {
    return -1;
  }

  return Array.from(document.querySelectorAll('p')).indexOf(last);
};

test('the meta card shows the generated ai-title under the provider and model', () => {
  renderCostModal({
    tokenUsage: { used: 1200, total: 4000 },
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    aiTitle: 'Generated From The Chat',
  });

  assert.equal(positionOf('AI title') >= 0, true, 'the AI title label must be rendered');
  assert.equal(positionOf('Generated From The Chat') >= 0, true, 'the generated title must be rendered');

  const providerAt = positionOf('Provider');
  const modelAt = positionOf('Model');
  const labelAt = positionOf('AI title');
  assert.equal(providerAt >= 0 && modelAt >= 0, true, 'the existing rows must still be there');
  assert.equal(
    labelAt > modelAt && labelAt > providerAt,
    true,
    'the generated title belongs after the provider and model it describes',
  );
});

test('the meta card renders no AI title row when the field is absent', () => {
  renderCostModal({
    tokenUsage: { used: 1200, total: 4000 },
    provider: 'claude',
    model: 'claude-sonnet-4-5',
  });

  assert.equal(positionOf('AI title'), -1, 'no title must mean no row, not a placeholder');
  assert.equal(positionOf('Unknown') >= 0, false, 'and no "Unknown" standing in for it');
  assert.equal(positionOf('Provider') >= 0, true, 'the rest of the meta card is untouched');
  assert.equal(positionOf('claude-sonnet-4-5') >= 0, true);
});

test('the meta card renders no AI title row for a blank title', () => {
  renderCostModal({
    tokenUsage: { used: 1200, total: 4000 },
    provider: 'claude',
    model: 'claude-sonnet-4-5',
    aiTitle: '   ',
  });

  assert.equal(positionOf('AI title'), -1, 'a whitespace-only title is as absent as a missing one');
});
