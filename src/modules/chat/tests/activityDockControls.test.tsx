import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test } from 'vitest';

import ActivityDockPanel from '@/modules/chat/transcript/ActivityDockPanel';
import {
  applyActivityFrame,
  resetSessionActivityStore,
} from '@/modules/chat/hooks/useSessionActivity';
import { findPendingForegroundTool } from '@/modules/chat/hooks/useActivityControls';
import WebSocketContext from '@/shared/context/WebSocketContext';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityTaskView, ChatMessage } from '@/shared/types';

/**
 * The dock's two controls, at the unit.
 *
 * The browser criterion (`e2e/activity-dock-background.spec.ts -g "AC-199"`) is
 * the authority on "a real click on a real page places a real frame". This file
 * pins the properties that make that criterion meaningful, without the boot:
 *
 *   - the panel lists **live** tasks only: a settled task has no row at all, so
 *     every listed row carries a stop control — the selector's count is the row
 *     count, by construction rather than by hiding or disabling a control;
 *   - a running foreground tool carries a background control, addressed by its
 *     own `tool_use` id;
 *   - a click **sends exactly one frame** and writes no local state — the row's
 *     state moves only when the store receives a frame;
 *   - an `unreachable` liveness disables both controls and draws a reason beside
 *     each.
 *
 * The store is reset per test so a frame from one case cannot leak into the
 * next; the panel reads it through `useSessionActivity`, the same path the page
 * uses.
 */

const SESSION_ID = 'session-controls';

const RUNNING_TASK: ActivityTaskView = {
  taskId: 'task-running',
  kind: 'shell',
  state: 'running',
  isBackgrounded: true,
  description: 'Long build',
  origin: 'sdk-event',
  startedAt: 1_000,
};

const TERMINAL_TASK: ActivityTaskView = {
  taskId: 'task-done',
  kind: 'subagent',
  state: 'completed',
  isBackgrounded: true,
  description: 'Explore the repo',
  origin: 'sdk-event',
  startedAt: 1_000,
  endedAt: 4_000,
};

const FOREGROUND_TOOL = { toolUseId: 'toolu-fg-1', toolName: 'Bash' };

type SentFrame = Record<string, unknown>;

/** A recording socket context: the panel's only transport, and the reading this file takes. */
function makeSocket(): { sent: SentFrame[]; value: React.ContextType<typeof WebSocketContext> } {
  const sent: SentFrame[] = [];
  const value = {
    ws: null,
    isConnected: true,
    sendMessage: (message: unknown) => {
      sent.push(message as SentFrame);
    },
    subscribe: () => () => {},
    // The panel's other reader (`useSessionActivity`) also uses the context; the
    // shape above is the whole of what it touches.
  } as unknown as React.ContextType<typeof WebSocketContext>;
  return { sent, value };
}

function renderPanel(options: {
  liveness?: 'fresh' | 'unreachable';
  foregroundTool?: typeof FOREGROUND_TOOL | null;
  socket: React.ContextType<typeof WebSocketContext>;
}) {
  return render(
    React.createElement(
      WebSocketContext.Provider,
      { value: options.socket },
      React.createElement(ActivityDockPanel, {
        sessionId: SESSION_ID,
        liveness: options.liveness ?? 'fresh',
        foregroundTool: options.foregroundTool ?? null,
      }),
    ),
  );
}

const framesOfType = (sent: SentFrame[], type: string): SentFrame[] =>
  sent.filter((frame) => frame.type === type);

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

beforeEach(() => {
  resetSessionActivityStore();
  cleanup();
});

describe('activity dock controls', () => {
  test('the live task carries the stop control, and a settled task leaves the panel', () => {
    applyActivityFrame({ sessionId: SESSION_ID, rev: 1, tasks: [RUNNING_TASK, TERMINAL_TASK], schedules: [] });
    const { sent, value } = makeSocket();
    const { container } = renderPanel({ socket: value });

    const stopButtons = container.querySelectorAll('[data-task-stop]');
    console.log(`controls.stopButtons=${stopButtons.length}`);
    assert.equal(stopButtons.length, 1, 'exactly the live task may carry a stop control');
    assert.equal(stopButtons[0].getAttribute('data-task-id'), 'task-running');

    // The settled task is in the frame but not in the panel: it has no row, which is the stronger
    // form of "a terminal row renders no stop control" — there is no row to carry one.
    // Boolean, not `assert.equal(node, null)`: the latter hangs the reporter by serializing a live
    // DOM element whenever it goes red.
    assert.ok(
      container.querySelector('[data-activity-task-row][data-task-id="task-done"]') === null,
      'a terminal task must not be listed',
    );

    fireEvent.click(stopButtons[0]);
    const stopFrames = framesOfType(sent, 'chat.stop-task');
    console.log(`controls.stopFrames=${JSON.stringify(stopFrames)}`);
    assert.equal(stopFrames.length, 1, 'a click places exactly one stop request');
    assert.equal(stopFrames[0].sessionId, SESSION_ID);
    assert.equal(stopFrames[0].taskId, 'task-running');
    assert.equal(
      typeof stopFrames[0].requestId === 'string' && (stopFrames[0].requestId as string).length > 0,
      true,
      'the request must carry a non-empty requestId',
    );

    // No optimistic write: the row is unchanged until a frame says otherwise.
    const runningRow = container.querySelector('[data-activity-task-row][data-task-id="task-running"]');
    assert.equal(runningRow!.getAttribute('data-task-state'), 'running', 'a click must not change the row');

    // The event (the store frame) is what moves it — and the control leaves with it.
    act(() => {
      applyActivityFrame({
        sessionId: SESSION_ID,
        rev: 2,
        tasks: [{ ...RUNNING_TASK, state: 'stopped', endedAt: 9_000 }, TERMINAL_TASK],
        schedules: [],
      });
    });
    // Only the frame may settle the task — and a settled task is no longer listed, so its row is
    // gone rather than drawn without a control. Both tasks are terminal now, so the task section
    // (and with no plan and no foreground tool, the whole panel) has nothing left to draw.
    assert.ok(
      container.querySelector('[data-activity-task-row][data-task-id="task-running"]') === null,
      'only the frame may settle the task, and a settled task leaves the panel',
    );
    assert.equal(
      container.querySelectorAll('[data-activity-task-row]').length,
      0,
      'no live task is left to list',
    );
    assert.ok(container.querySelector('[data-activity-dock-panel]') === null, 'an empty panel is not drawn');
  });

  test('a running foreground tool carries a background control addressed by its tool_use id', () => {
    const { sent, value } = makeSocket();
    const { container } = renderPanel({ socket: value, foregroundTool: FOREGROUND_TOOL });

    const row = container.querySelector('[data-foreground-tool-row]');
    assert.ok(row, 'a pending foreground tool must have a row');
    assert.equal(row!.getAttribute('data-tool-use-id'), 'toolu-fg-1');

    const button = container.querySelector('[data-background-tool]');
    assert.ok(button, 'the foreground tool must carry a background control');
    fireEvent.click(button!);

    const backgroundFrames = framesOfType(sent, 'chat.background-task');
    console.log(`controls.backgroundFrames=${JSON.stringify(backgroundFrames)}`);
    assert.equal(backgroundFrames.length, 1, 'a click places exactly one background request');
    assert.equal(backgroundFrames[0].sessionId, SESSION_ID);
    assert.equal(backgroundFrames[0].toolUseId, 'toolu-fg-1');
    assert.equal(
      typeof backgroundFrames[0].requestId === 'string' && (backgroundFrames[0].requestId as string).length > 0,
      true,
      'the request must carry a non-empty requestId',
    );

    // Nothing local moved: no task row appeared, and the request was the only effect.
    assert.equal(container.querySelectorAll('[data-activity-task-row]').length, 0, 'a click must not fabricate a task row');
  });

  test('an unreachable dock disables both controls and draws a reason beside each', () => {
    applyActivityFrame({ sessionId: SESSION_ID, rev: 1, tasks: [RUNNING_TASK], schedules: [] });
    const { sent, value } = makeSocket();
    const { container } = renderPanel({ socket: value, liveness: 'unreachable', foregroundTool: FOREGROUND_TOOL });

    const stopButton = container.querySelector<HTMLButtonElement>('[data-task-stop]');
    const backgroundButton = container.querySelector<HTMLButtonElement>('[data-background-tool]');
    assert.ok(stopButton, 'the running task must still draw its stop control');
    assert.ok(backgroundButton, 'the foreground tool must still draw its background control');

    const reasons = [...container.querySelectorAll('[data-control-disabled-reason]')]
      .map((node) => node.textContent ?? '');
    console.log(`controls.unreachable: stopDisabled=${stopButton!.disabled} bgDisabled=${backgroundButton!.disabled} reasons=${JSON.stringify(reasons)}`);

    assert.equal(stopButton!.disabled, true, 'an unreachable stop control must be disabled');
    assert.equal(backgroundButton!.disabled, true, 'an unreachable background control must be disabled');
    assert.ok(reasons.length >= 2, 'each disabled control must draw its own reason');
    assert.ok(reasons.every((text) => text.trim().length > 0), 'a reason must not be blank');
    assert.equal(sent.some((frame) => frame.type === 'chat.stop-task'), false, 'a disabled control places nothing');
  });
});

describe('findPendingForegroundTool', () => {
  const toolUse = (id: string, withResult: boolean): ChatMessage => ({
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00.000Z',
    isToolUse: true,
    toolName: 'Bash',
    toolId: id,
    toolResult: withResult ? { content: 'done', isError: false } : null,
  });

  test('an unpaired tool_use is pending; a paired one is not', () => {
    assert.equal(findPendingForegroundTool([toolUse('a', true)]), null, 'a paired tool is not pending');
    assert.deepEqual(
      findPendingForegroundTool([toolUse('a', true), toolUse('b', false)]),
      { toolUseId: 'b', toolName: 'Bash' },
      'the unpaired tool is the pending one',
    );
    // With two unpaired, the last one is pending — matching the server's tracker.
    assert.deepEqual(
      findPendingForegroundTool([toolUse('a', false), toolUse('b', false)]),
      { toolUseId: 'b', toolName: 'Bash' },
      'the most recent unpaired tool is the pending one',
    );
    assert.equal(findPendingForegroundTool(null), null);
    assert.equal(findPendingForegroundTool([]), null);
  });
});
