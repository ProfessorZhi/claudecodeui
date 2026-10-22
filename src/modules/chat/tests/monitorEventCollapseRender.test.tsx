/**
 * AC-200 (render arm): the collapsed Monitor row is one line you can open.
 *
 * THE CLAIM. A row marked `isMonitorCollapse` is drawn as `📡 <description> ·
 * <N events>` and offers a disclosure (`<details>`) holding every event body,
 * and a run whose status is `'stopped'` is drawn as stopped — amber, with the
 * stopped label — and NEVER as an error: no red avatar, no error row type.
 *
 * WHY THE READINGS ARE TAKEN OFF THE DOM. The description, the count and the
 * event list are asserted from what the shipped `MessageComponent` renders, not
 * from an internal call tally, so "it draws them" is the rendered fact the AC
 * says it is. The count is read twice with different inputs (3 then 1) so a
 * hardcoded string is caught: the label must follow the row's own count.
 *
 * WHY A STOPPED ARM AND NO ERROR ARM. The error avatar is the default branch's
 * `bg-red-600` circle. The stopped arm proves the collapsed branch is taken
 * (not the error branch) and that the row carries its own status, so the
 * "not an error" half is measured on the same DOM as the "is stopped" half.
 *
 * The i18next instance is real, over the shipped `en/chat.json`, with
 * `fallbackLng` off: the expected copy is read back from that same file, so a
 * missing key reds instead of being masked by a fallback string.
 *
 * Run: npx vitest run src/modules/chat/tests/monitorEventCollapseRender.test.tsx
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

/** The shipped English chat bundle, read as data so the expected copy is the file's. */
const EN_CHAT = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales', 'en', 'chat.json'), 'utf8'),
) as { misc: Record<string, string> };

await i18next.use(initReactI18next).init({
  lng: 'en',
  // Off on purpose: a key that never reached the bundle must render as the key
  // (a red) rather than the English copy passing the assertion.
  fallbackLng: false,
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: EN_CHAT } },
  interpolation: { escapeValue: false },
});

/** The English count label for `count`, read from the shipped plural keys. */
const expectedCount = (count: number): string => {
  const key = count === 1 ? 'monitorEventsCount_one' : 'monitorEventsCount_other';
  return EN_CHAT.misc[key].replace('{{count}}', String(count));
};

/** One collapsed row, with only the fields a case cares about overridden. */
const collapseMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  type: 'assistant',
  content: 'Monitor event: watch the queue',
  timestamp: '2026-10-04T00:00:00.000Z',
  isTaskNotification: true,
  isMonitorCollapse: true,
  monitorTaskId: 'task-A',
  monitorDescription: 'Monitor event: watch the queue',
  monitorEventCount: 3,
  monitorEvents: ['tick 1', 'tick 2', 'tick 3'],
  monitorStatus: 'completed',
  ...overrides,
});

const createDiff = (): DiffLine[] => [];

const renderCollapse = (message: ChatMessage): HTMLElement => {
  const { container } = render(
    <UiPreferencesProvider>
      <MessageComponent message={message} prevMessage={null} createDiff={createDiff} provider="claude" />
    </UiPreferencesProvider>,
  );
  return container;
};

/** The single collapsed row the component draws. */
const requireCollapseRow = (container: HTMLElement): HTMLElement => {
  const row = container.querySelector('[data-monitor-collapse]');
  assert.ok(row, 'expected the collapsed Monitor row to render');
  return row as HTMLElement;
};

test('a collapsed run draws its description and count, with the events expandable', () => {
  const description = 'watching the deploy queue';
  const container = renderCollapse(collapseMessage({ monitorDescription: description }));
  const row = requireCollapseRow(container);
  const text = row.textContent ?? '';

  assert.ok(
    text.includes(description),
    `the row must draw the monitor's own description, read ${JSON.stringify(text)}`,
  );
  assert.ok(
    text.includes(expectedCount(3)),
    `the row must draw the event count ${JSON.stringify(expectedCount(3))}, read ${JSON.stringify(text)}`,
  );

  // The disclosure exists and holds every event body, in order.
  const details = row.querySelector('details');
  assert.ok(details, 'the row must offer an expandable event list');
  const events = Array.from(details.querySelectorAll('li')).map((li) => (li.textContent ?? '').trim());
  assert.deepEqual(events, ['tick 1', 'tick 2', 'tick 3'], 'the disclosure must list every event body');

  assert.ok(row.querySelector('.bg-green-400'), 'a completed run uses the completed (green) marker');
});

test('the count is a reading of the row, not a constant', () => {
  const single = requireCollapseRow(renderCollapse(
    collapseMessage({ monitorEventCount: 1, monitorEvents: ['tick 1'] }),
  ));
  const singleText = single.textContent ?? '';

  assert.ok(singleText.includes(expectedCount(1)), `a one-event run must read ${expectedCount(1)}`);
  assert.ok(!singleText.includes(expectedCount(3)), 'the count must follow the row, not be fixed at three');
});

test('a stopped run reads as stopped and draws no error avatar', () => {
  const container = renderCollapse(collapseMessage({
    monitorStatus: 'stopped',
    monitorEventCount: 2,
    monitorEvents: ['tick 1', '[Monitor timed out — re-arm if needed.]'],
  }));
  const row = requireCollapseRow(container);

  assert.equal(row.getAttribute('data-monitor-status'), 'stopped', 'the row must carry the stopped status');
  assert.ok(
    (row.textContent ?? '').includes(EN_CHAT.misc.monitorStopped),
    `a stopped run must say ${JSON.stringify(EN_CHAT.misc.monitorStopped)}`,
  );
  assert.ok(row.querySelector('.bg-amber-400'), 'a stopped run uses the stopped (amber) marker');

  // Not the error branch: no red avatar, no error-styled row anywhere in the tree.
  assert.equal(container.querySelector('.bg-red-600'), null, 'a stopped monitor must not draw the red error avatar');
  assert.equal(container.querySelector('[data-message-style="error"]'), null, 'a stopped monitor is not an error row');
});
