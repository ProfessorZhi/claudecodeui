import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { test, vi } from 'vitest';

import { AskUserQuestionPanel } from '@/modules/chat/tools/InteractiveRenderers/AskUserQuestionPanel';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { PendingPermissionRequest, Question } from '@/shared/types';

/**
 * The keyboard contract of the AskUserQuestion panel's "Other" answer box.
 *
 * The box was an `<input type="text">` until a long answer was found to stay on one line, scrolling sideways
 * underneath the decorative `Enter` hint. It is a textarea now, and that change moved two things a jsdom test can
 * hold honestly — the contract that Enter advances, and the escape hatch that makes a multi-line answer possible
 * at all:
 *
 *   - Enter still submits on the last question and advances on the others. That contract is unchanged, and this
 *     file is what says so.
 *   - Shift+Enter does NOT advance. It is the only way to put a newline in an answer now that the control can
 *     hold one, so a regression here would silently remove multi-line answers rather than break anything visible.
 *
 * What is deliberately NOT tested here: that the box wraps, and that the hint does not cover it. jsdom has no line
 * breaking, no box model and no `scrollWidth`, so any assertion of those here would be a claim about the DOM shape
 * dressed up as a measurement. `e2e/ask-user-question-other-input.spec.ts` reads them off real Chromium geometry;
 * this file stays out of its way rather than duplicating it with a weaker instrument.
 *
 * i18next is initialised with the real English bundle so the box is found by the placeholder the user actually
 * reads, rather than by a test id that would survive the label being deleted.
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

/** The placeholder the English bundle renders for the answer box — the anchor every case below finds it by. */
const OTHER_PLACEHOLDER = 'Type your answer...';

/** One question with two options, the shape the AskUserQuestion tool sends. */
const question = (overrides: Partial<Question> = {}): Question => ({
  question: 'Which approach should this change take?',
  header: 'Approach',
  multiSelect: false,
  options: [{ label: 'Narrow the change' }, { label: 'Widen the change' }],
  ...overrides,
});

/** Renders the panel for the given questions and returns the decision spy it reports through. */
const renderPanel = (questions: Question[]) => {
  const onDecision = vi.fn();
  const request: PendingPermissionRequest = {
    requestId: 'req-1',
    toolName: 'AskUserQuestion',
    input: { questions },
    sessionId: 'session-1',
    receivedAt: new Date(),
  };
  render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);
  // The box only exists once "Other..." is chosen — the same two steps the user takes.
  fireEvent.click(screen.getByRole('button', { name: /Other/ }));
  return { onDecision, box: screen.getByPlaceholderText(OTHER_PLACEHOLDER) };
};

test('Enter in the answer box submits when it is the last question', () => {
  const { onDecision, box } = renderPanel([question()]);
  fireEvent.change(box, { target: { value: 'A narrower cut' } });
  fireEvent.keyDown(box, { key: 'Enter' });

  assert.equal(onDecision.mock.calls.length, 1, 'Enter on the last question must submit');
  const [requestId, decision] = onDecision.mock.calls[0] as [string, { allow?: boolean; updatedInput?: unknown }];
  assert.equal(requestId, 'req-1');
  assert.equal(decision.allow, true);
  // The typed answer has to travel with the decision — the panel's whole purpose is to carry it back.
  assert.deepEqual(
    (decision.updatedInput as { answers?: Record<string, string> }).answers,
    { 'Which approach should this change take?': 'A narrower cut' },
  );
});

test('Shift+Enter in the answer box does not submit, so an answer can hold a newline', () => {
  const { onDecision, box } = renderPanel([question()]);
  fireEvent.change(box, { target: { value: 'First line' } });
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });

  assert.equal(
    onDecision.mock.calls.length,
    0,
    'Shift+Enter must be left to the browser — submitting on it would make a multi-line answer impossible',
  );
});

test('Enter in the answer box advances instead of submitting while questions remain', () => {
  const { onDecision, box } = renderPanel([question(), question({ question: 'And how wide?' })]);
  fireEvent.change(box, { target: { value: 'First answer' } });
  fireEvent.keyDown(box, { key: 'Enter' });

  assert.equal(onDecision.mock.calls.length, 0, 'a non-final question must not submit the whole prompt');
  assert.ok(
    screen.getByText('2/2'),
    'the panel must have moved to the second question rather than staying on the first',
  );
});
