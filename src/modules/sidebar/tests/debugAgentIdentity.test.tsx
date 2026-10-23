import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { test, vi } from 'vitest';

import { LLMProviderLogo } from '@/shared/ui';
import type { LLMProvider } from '@/shared/types';

/**
 * A session from the debug agent must be identifiable as one, by name and by mark.
 *
 * ADR-003 decision 2 keeps the runtime provider id out of `LLMProvider`, so every
 * place that renders a provider has a case it was never written to expect — and
 * every one of those places has a default that reads as claude. Falling through is
 * therefore silent: a debug session would be shown as a Claude session, with the
 * right shape and the wrong identity, and no reader could tell.
 *
 * So these tests render the real components instead of reading the maps they
 * consult, and each one carries the control that makes it falsifiable: the same
 * assertion on an id with no entry anywhere. That control is what "the identity
 * was withheld" looks like from the outside, and it is the reading the checks
 * below would produce if the entry were dropped.
 */

// The id the backend registers under (`DEBUG_AGENT_PROVIDER_ID`). The frontend
// cannot import it — `src` does not reach into `server` — so it is written here
// as the string it is, which is how it arrives in production too: from the
// session row's provider column.
const DEBUG_AGENT_PROVIDER_ID = 'debug';
const SESSION_NAME = 'debug-agent-fixture';

// The sidebar reads both capability sets; the resident one is stubbed empty so the
// "convert to resident" item stays out of the menu this test asserts on.
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set<string>(),
  useResidentProviders: () => new Set<string>(),
}));
vi.mock('@/modules/sidebar/hooks/useProviderSessionIdCopy', () => ({
  useProviderSessionIdCopy: () => ({
    copyState: 'idle',
    copyLabel: 'Copy session ID',
    setOptionsOpen: () => {},
    handleCopyAction: () => {},
    isCopyPending: false,
    CopyStateIcon: () => null,
  }),
}));

const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');

const t = ((key: string) => key) as unknown as TFunction;

/** The row's provider text slot, reached the way a user reaches it. */
const openRowOptions = (provider: string): { slot: string; label: string } => {
  render(
    <SessionOptions
      sessionId="s1"
      sessionName={SESSION_NAME}
      provider={provider as LLMProvider}
      projectId="project-1"
      isProcessing={false}
      isEditing={false}
      renameDraft=""
      onRenameDraftChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      onDeleteSession={() => {}}
      t={t}
    />,
  );
  fireEvent.click(screen.getByLabelText(`Session options for ${SESSION_NAME}`));

  // The menu header carries the row's title and, in the line under it, the
  // provider. Reading the header and dropping the title keeps this to the text a
  // reader sees, without pinning the markup between the two lines.
  const header = screen.getByText(SESSION_NAME).parentElement?.textContent ?? '';
  assert.ok(header.startsWith(SESSION_NAME), `unexpected menu header ${JSON.stringify(header)}`);

  const slot = header.slice(SESSION_NAME.length);
  return { slot, label: slot.replace(/\s*session$/, '').trim() };
};

test('a debug session row names its provider, and never as Claude', () => {
  const { slot, label } = openRowOptions(DEBUG_AGENT_PROVIDER_ID);

  assert.notEqual(label.length, 0, `the provider text slot rendered ${JSON.stringify(slot)} — empty`);
  assert.notEqual(label, 'Claude', `the provider text slot rendered ${JSON.stringify(slot)}`);
  assert.equal(label, 'Debug Agent', `the provider text slot rendered ${JSON.stringify(slot)}`);

  console.log(
    `[AC4] session row provider text slot for provider=${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)}: ` +
      `rendered ${JSON.stringify(slot)}, label ${JSON.stringify(label)}`,
  );
});

test('the same slot withholds the identity when no entry exists', () => {
  // The control. `claud` is not a provider anyone has an entry for, so this is
  // the reading a missing `debug` entry would produce: the slot keeps its place
  // in the row and loses its content, which is precisely the failure the check
  // above has to be able to see.
  const { slot, label } = openRowOptions('claud');

  assert.equal(screen.queryByText('Debug Agent session'), null);
  assert.equal(slot.includes('Debug Agent'), false);
  assert.equal(label, '', `the slot named a provider nobody has an entry for: ${JSON.stringify(slot)}`);

  console.log(`[AC4] control — provider="claud" renders the slot as ${JSON.stringify(slot)}`);
});

const markFor = (provider: string): string => {
  const { container, unmount } = render(<LLMProviderLogo provider={provider} />);
  const markup = container.innerHTML;
  unmount();
  return markup;
};

test('the debug agent renders a mark of its own, not the fall-through', () => {
  const claudeMark = markFor('claude');
  const unrecognisedMark = markFor('not-a-provider');
  const debugMark = markFor(DEBUG_AGENT_PROVIDER_ID);

  // The control first: an unrecognised provider really is rendered as the claude
  // mark, so the next assertion is about a branch that exists rather than about a
  // component that happens to render something different every time.
  assert.equal(
    unrecognisedMark,
    claudeMark,
    'an unrecognised provider no longer falls through to the claude mark — this check needs a new control',
  );
  assert.notEqual(debugMark, claudeMark, 'the debug agent renders the claude mark');

  const { container, getByLabelText } = render(
    <LLMProviderLogo provider={DEBUG_AGENT_PROVIDER_ID} />,
  );
  const ariaLabel = getByLabelText('Debug Agent').getAttribute('aria-label');
  assert.notEqual(ariaLabel, 'Claude');

  console.log(
    `[AC4] LLMProviderLogo mark for provider=${JSON.stringify(DEBUG_AGENT_PROVIDER_ID)}: ` +
      `aria-label ${JSON.stringify(ariaLabel)}, ${debugMark.length} chars (claude's: ${claudeMark.length}, ` +
      `unrecognised provider's: ${unrecognisedMark.length})`,
  );
  assert.ok(container.querySelector('svg'));
});
