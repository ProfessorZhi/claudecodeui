/**
 * AC-200: a Monitor's consecutive events fold into one transcript row.
 *
 * THE CLAIM. `useChatMessages`'s projection annotates every Monitor event the
 * harness injects (a `<task-notification>` whose body carries an `<event>`) with
 * its task id and its event body, and `collapseMonitorEventRows` folds the
 * maximal adjacent run for one task into a single row carrying the description,
 * the count and every event body. The fold is keyed on `monitorTaskId` and on
 * nothing else: an ordinary row, a Monitor event with no task id, and a Monitor
 * event for a different task all end the run. A run that saw a timeout reads
 * `'stopped'` — a thing that ended, never `type: 'error'`.
 *
 * WHAT IS LOAD-BEARING HERE.
 *  - The raw `normalizedToChatMessages` output is NOT folded: it stays one row
 *    per source row, so search, export and anchors still see every event. A
 *    fold that happened inside the projection would show up as a shorter raw
 *    list and red here.
 *  - The "different tasks don't merge" reading is judged against a deliberately
 *    WRONG fold keyed on the event's text (`collapseByContentEquality`). With
 *    two different tasks publishing the same text, the wrong fold scores one row
 *    instead of two, so this file's own reading can go red — the main assertion
 *    has resolution rather than being a green that cannot fail.
 *  - The input arrays are snapshotted before the calls and compared after: a
 *    fold that mutated the rows or the array it was handed would red on that.
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  collapseMonitorEventRows,
  normalizedToChatMessages,
} from '@/modules/chat/hooks/useChatMessages';
import type { ChatMessage, NormalizedMessage } from '@/shared/types';

/** Base for every fixture row; fields a case cares about are overridden. */
const message = (overrides: Partial<NormalizedMessage>): NormalizedMessage => ({
  id: 'row',
  sessionId: 's1',
  timestamp: '2026-10-04T00:00:00.000Z',
  provider: 'claude',
  kind: 'text',
  role: 'user',
  ...overrides,
});

/**
 * One raw Monitor event exactly as the harness injects it: a
 * `<task-notification>` whose body carries `<task-id>` and `<event>` instead of
 * a background agent's `<result>`.
 */
const monitorMessage = (
  taskId: string,
  event: string,
  id: string,
  summary = 'Monitor event: watch the queue',
): NormalizedMessage =>
  message({
    id,
    content: [
      '<task-notification>',
      `<task-id>${taskId}</task-id>`,
      `<summary>${summary}</summary>`,
      `<event>${event}</event>`,
      '</task-notification>',
    ].join('\n'),
  });

/** An ordinary assistant turn, used as the row that separates two runs. */
const assistantMessage = (content: string, id: string): NormalizedMessage =>
  message({ id, role: 'assistant', content });

/** The rows a fold produced for runs of Monitor events. */
const monitorRows = (rows: ChatMessage[]): ChatMessage[] =>
  rows.filter((row) => row.isMonitorCollapse === true);

/**
 * A deliberately WRONG fold: it groups Monitor events by the TEXT of their
 * body instead of by the task that published them.
 *
 * It is not shipped anywhere — it exists only as the negative control below, so
 * the "different task ids stay separate" reading is shown to be able to go red
 * (with two tasks publishing the same text, this fold scores one row, not two).
 */
function collapseByContentEquality(rows: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let run: ChatMessage[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const first = run[0];
    const events = run.map((row) => String(row.monitorEvent ?? ''));
    out.push({
      ...first,
      type: 'assistant',
      isTaskNotification: true,
      isMonitorCollapse: true,
      monitorTaskId: first.monitorTaskId,
      monitorDescription: first.monitorDescription,
      monitorEventCount: events.length,
      monitorEvents: events,
      monitorStatus: events.some((event) => /Monitor timed out/.test(event))
        ? 'stopped'
        : 'completed',
    });
    run = [];
  };

  for (const row of rows) {
    const foldable = row.isMonitorEvent === true;
    if (foldable && run.length > 0 && row.content === run[0].content) {
      run.push(row);
    } else if (foldable) {
      flush();
      run = [row];
    } else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

describe('collapseMonitorEventRows', () => {
  it('AC2 — folds the adjacent events of one task into a single row', () => {
    const messages = [
      monitorMessage('task-A', 'tick 1', 'r1'),
      monitorMessage('task-A', 'tick 2', 'r2'),
      monitorMessage('task-A', 'tick 3', 'r3'),
    ];

    const collapsed = collapseMonitorEventRows(normalizedToChatMessages(messages));
    const rows = monitorRows(collapsed);

    assert.equal(rows.length, 1, 'a single run must collapse to a single row');
    assert.equal(rows[0].type, 'assistant', 'the collapsed row keeps the notification styling');
    assert.equal(rows[0].monitorTaskId, 'task-A');
    assert.equal(rows[0].monitorEventCount, 3);
    assert.deepEqual(rows[0].monitorEvents, ['tick 1', 'tick 2', 'tick 3']);
    assert.equal(rows[0].monitorDescription, 'Monitor event: watch the queue');
  });

  it('AC3 — the raw projection stays lossless and no input is mutated', () => {
    const messages = [
      monitorMessage('task-A', 'tick 1', 'r1'),
      monitorMessage('task-A', 'tick 2', 'r2'),
      monitorMessage('task-B', 'tick 3', 'r3'),
    ];
    const before = messages.map((row) => JSON.stringify(row));

    const raw = normalizedToChatMessages(messages);

    // One row per source message, in order: the annotation is additive, so the
    // raw projection still contains every event.
    assert.equal(raw.length, messages.length, 'the raw projection must not drop rows');
    assert.deepEqual(raw.map((row) => row.monitorEvent), ['tick 1', 'tick 2', 'tick 3']);
    assert.ok(raw.every((row) => row.isMonitorEvent === true), 'each raw row must be annotated');
    assert.ok(
      raw.every((row) => row.isMonitorCollapse === undefined),
      'the raw projection must not fold',
    );

    // Folding is a new projection: neither the source rows nor the raw rows are touched.
    const collapsed = collapseMonitorEventRows(raw);
    assert.notEqual(collapsed, raw, 'the fold must return a new array');
    assert.ok(
      raw.every((row) => row.isMonitorCollapse === undefined),
      'folding must not mark the rows it was handed',
    );
    assert.deepEqual(messages.map((row) => JSON.stringify(row)), before, 'the input was mutated');
  });

  it('AC4 — a run that saw a timeout reads stopped, never an error', () => {
    const timedOut = monitorRows(collapseMonitorEventRows(normalizedToChatMessages([
      monitorMessage('task-T', 'tick 1', 'r1'),
      monitorMessage('task-T', '[Monitor timed out — re-arm if needed.]', 'r2'),
    ])));

    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].monitorStatus, 'stopped');
    assert.notEqual(timedOut[0].type, 'error', 'a stopped monitor is not an error');

    // The control: the same shape with no timeout reads 'completed', so
    // 'stopped' is a reading of the events rather than a constant.
    const completed = monitorRows(collapseMonitorEventRows(normalizedToChatMessages([
      monitorMessage('task-T', 'tick 1', 'r1'),
      monitorMessage('task-T', 'tick 2', 'r2'),
    ])));
    assert.equal(completed[0].monitorStatus, 'completed');
  });

  it('AC5 — two tasks publishing the same text are not merged', () => {
    const sameText = 'heartbeat ok';
    const messages = [
      monitorMessage('task-A', sameText, 'r1'),
      monitorMessage('task-B', sameText, 'r2'),
    ];

    const rows = monitorRows(collapseMonitorEventRows(normalizedToChatMessages(messages)));

    assert.equal(rows.length, 2, 'the task id — not the text — is the grouping key');
    assert.deepEqual(rows.map((row) => row.monitorTaskId), ['task-A', 'task-B']);
    assert.ok(rows.every((row) => row.monitorEventCount === 1));
  });

  it('AC6 — an intervening message ends the run, so the two halves stay apart', () => {
    const messages = [
      monitorMessage('task-A', 'a1', 'r1'),
      monitorMessage('task-A', 'a2', 'r2'),
      assistantMessage('a normal line', 'r3'),
      monitorMessage('task-A', 'a3', 'r4'),
      monitorMessage('task-A', 'a4', 'r5'),
    ];

    const collapsed = collapseMonitorEventRows(normalizedToChatMessages(messages));
    const rows = monitorRows(collapsed);

    assert.equal(rows.length, 2, 'the ordinary row is a boundary, not a join');
    assert.deepEqual(rows[0].monitorEvents, ['a1', 'a2']);
    assert.deepEqual(rows[1].monitorEvents, ['a3', 'a4']);
    assert.equal(collapsed.length, 3, 'the separator keeps its own row between the two runs');
    assert.equal(collapsed[1].isMonitorCollapse, undefined);
    assert.equal(collapsed[1].content, 'a normal line');
  });

  it('AC7 — a text-keyed fold scores red on the same reading', () => {
    const messages = [
      monitorMessage('task-A', 'heartbeat ok', 'r1'),
      monitorMessage('task-B', 'heartbeat ok', 'r2'),
    ];
    const raw = normalizedToChatMessages(messages);

    // The one reading both arms are judged by.
    const readMergedRuns = (rows: ChatMessage[]): number => monitorRows(rows).length;

    const shipped = readMergedRuns(collapseMonitorEventRows(raw));
    const fake = readMergedRuns(collapseByContentEquality(raw));

    // Printed so the green and red readings are both visible in the run log.
    console.log(
      `different task ids stay separate: shipped=${shipped} (green) fake=${fake} (red)`,
    );

    assert.equal(shipped, 2, 'the shipped fold keeps the two tasks apart');
    assert.equal(fake, 1, 'a text-keyed fold merges them, so this reading must go red for it');
    assert.ok(fake < shipped, 'the fake form must fail the reading, not pass it');
  });
});
