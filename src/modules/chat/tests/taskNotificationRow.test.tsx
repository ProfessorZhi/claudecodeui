/**
 * gap-shell-terminal-row-only-true-background (AC3/AC4, render arm): the
 * task-notification row is ONE line that says which task and what state.
 *
 * THE CLAIM, in two halves.
 *
 *  (AC3) A row whose summary is a whole command — measured on a real session at
 *  4040 characters over 72 lines, drawn in a `white-space: normal` span that
 *  stood 404px tall — is drawn as one line: no newline survives into the text
 *  node, the span carries the truncation styling, and the untruncated text is
 *  still readable in `title`. The row also names its status rather than relying
 *  on the colour of a dot: `completed` / `failed` / `stopped` / `ended` appears
 *  in the row's own text.
 *
 *  (AC4) A summary that is only the task's description or command is prefixed
 *  with its status word; a summary that already names a status is left alone.
 *
 * WHY THE READINGS ARE TAKEN OFF THE DOM. "One line" and "the full text is still
 * there" are claims about what a reader gets, so they are read from the rendered
 * node — its text node, its class list and its `title` attribute — and not from
 * an internal call tally.
 *
 * Run: npx vitest run src/modules/chat/tests/taskNotificationRow.test.tsx
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { test } from 'vitest';

import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';
import type { ChatMessage, DiffLine } from '@/shared/types';

const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as Record<string, unknown>;

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: EN_CHAT } },
  interpolation: { escapeValue: false },
});

/** One task-notification row, with only the fields a case cares about overridden. */
const notificationMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: 'sleep 25',
  timestamp: '2026-10-04T00:00:00.000Z',
  isTaskNotification: true,
  taskStatus: 'completed',
  ...overrides,
});

const createDiff = (): DiffLine[] => [];

const renderRow = (message: ChatMessage): HTMLElement => {
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
  return container;
};

/** The one span the notification branch draws the row's text into. */
const requireTextNode = (container: HTMLElement): HTMLElement => {
  const node = container.querySelector('[data-task-notification-text]');
  assert.ok(node, 'expected the task-notification row to render its text span');
  return node as HTMLElement;
};

/** Every text node under `root`, so "no newline survives" is not read off textContent alone. */
function textNodes(root: Node): string[] {
  const out: string[] = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      out.push(child.nodeValue ?? '');
    } else {
      out.push(...textNodes(child));
    }
  }
  return out;
}

// ------------------------------------------------------------------- AC3 -----

test('AC3 a 4000-character, 72-line summary is drawn as one truncated line', () => {
  // The measured worst case: 72 lines of a real command, ~4000 characters.
  const longSummary = Array.from({ length: 72 }, (_, index) => `line-${index}-${'x'.repeat(48)}`).join('\n');
  assert.ok(longSummary.length > 4000, 'precondition: the fixture is at least the measured 4000 characters');
  assert.equal(longSummary.split('\n').length, 72, 'precondition: the fixture is the measured 72 lines');

  const container = renderRow(notificationMessage({ content: longSummary, taskStatus: 'completed' }));
  const node = requireTextNode(container);

  // One line: no newline, and no text node anywhere in the row carries one.
  const classes = node.className;
  assert.ok(!classes.includes('whitespace-pre'), `the span must not preserve newlines, read ${JSON.stringify(classes)}`);
  assert.ok(classes.includes('truncate'), `the span must carry the truncation style, read ${JSON.stringify(classes)}`);
  assert.ok(classes.includes('whitespace-nowrap'), `the span must not wrap, read ${JSON.stringify(classes)}`);
  assert.ok(
    textNodes(node).every((text) => !text.includes('\n')),
    `no text node may carry a newline, read ${JSON.stringify(textNodes(node))}`,
  );
  assert.ok(!(node.textContent ?? '').includes('\n'), 'the rendered text must be one line');

  // The full text survives in `title`, so truncation loses nothing.
  const title = node.getAttribute('title') ?? '';
  assert.ok(title.includes(longSummary), 'the untruncated summary must be readable from the title attribute');
  assert.ok(title.includes('line-71-'), 'precondition: the title carries the last line too');

  // The row names its status, not only a coloured dot.
  assert.ok(
    /\b(completed|failed|stopped|ended)\b/.test(node.textContent ?? ''),
    `the row must name its status, read ${JSON.stringify(node.textContent)}`,
  );
});

test('AC3 each terminal status is named in the row text', () => {
  for (const status of ['completed', 'failed', 'stopped', 'ended']) {
    const container = renderRow(notificationMessage({ content: 'sleep 25', taskStatus: status }));
    const text = requireTextNode(container).textContent ?? '';
    assert.ok(text.includes(status), `a ${status} row must say ${status}, read ${JSON.stringify(text)}`);
  }
});

// ------------------------------------------------------------------- AC4 -----

test('AC4 a summary that is only the command is prefixed with its status', () => {
  // The SDK sends the description — or, with none, the command itself — as the
  // summary. Neither carries a status word, so the row adds one.
  const container = renderRow(notificationMessage({ content: 'grep -rn TODO src/', taskStatus: 'completed' }));
  const text = requireTextNode(container).textContent ?? '';

  assert.ok(
    /^completed\b/i.test(text),
    `the row text must begin with its status word, read ${JSON.stringify(text)}`,
  );
  assert.ok(text.includes('grep -rn TODO src/'), 'the command must still be readable');
});

test('AC4 a summary that already names a status is not prefixed twice', () => {
  // The server's own fallback already carries the state word; so does a CLI
  // notification that says the task stopped. Neither gets a second one.
  const fallback = requireTextNode(renderRow(
    notificationMessage({ content: 'Background task completed: sleep 25', taskStatus: 'completed' }),
  )).textContent ?? '';
  assert.equal(fallback, 'Background task completed: sleep 25', 'an already-statused summary is shown as it is');

  const stopped = requireTextNode(renderRow(
    notificationMessage({ content: 'Background task stopped: sleep 25', taskStatus: 'stopped' }),
  )).textContent ?? '';
  assert.equal(stopped, 'Background task stopped: sleep 25', 'a stopped summary is not re-labelled');

  const prefixedOnce = (fallback.match(/completed/gi) ?? []).length;
  assert.equal(prefixedOnce, 1, `the status word must appear exactly once, read ${JSON.stringify(fallback)}`);
});
