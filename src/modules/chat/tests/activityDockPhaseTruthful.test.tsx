import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityConnection, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The dock's label is a function of the phase the server reported — and of
 * nothing else.
 *
 * These cases drive the dock through its own in-memory liveness channel and read
 * the two things the running label is made of: the `data-activity-phase` the dock
 * publishes and the label element's text. They are the fast feedback for the
 * shape `e2e/activity-dock-truthful.spec.ts -g "AC-187"` proves against a real
 * browser, real server and real debug-agent turn.
 *
 * What the pair of controls pins, in opposite directions:
 *
 *   - the label is the locale's word for the phase (a `tool` phase names its
 *     tool), so "the phase is read" cannot pass against a dock that draws
 *     nothing; and
 *   - the label does NOT change while the phase holds, across six seconds of
 *     local time, so the old rotating word cannot come back unnoticed.
 */

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'session-phase';
const UNREACHABLE_AFTER_MS = 900;

/** A running turn: the dock is in-turn because the local table says so. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

const DOCK = '[data-activity-dock]';
const LABEL = '[data-activity-label]';

/** An in-memory liveness channel, so the case can hand the hook frames with no socket. */
const makeConnection = () => {
  const listeners = new Set<(event: ServerEvent) => void>();
  const connection: ActivityConnection = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isConnected: true,
  };
  const push = (event: ServerEvent) => {
    act(() => {
      for (const listener of [...listeners]) listener(event);
    });
  };
  return { connection, push };
};

const subscribedFrame = (phase: string, toolName: string | null = null): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  phase,
  toolName,
  timestamp: new Date(START).toISOString(),
});

const heartbeatFrame = (timestamp: number, phase: string, toolName: string | null = null): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  phase,
  toolName,
  timestamp: new Date(timestamp).toISOString(),
});

const dockOf = (view: { container: HTMLElement }): HTMLElement => {
  const dock = view.container.querySelector<HTMLElement>(DOCK);
  assert.ok(dock, `the dock must be on screen (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return dock;
};

/**
 * The dock's running label, read off the label element and with the shimmer's
 * trailing ellipsis stripped — the text a reader sees, not the animation.
 */
const labelOf = (view: { container: HTMLElement }): string => {
  const label = dockOf(view).querySelector<HTMLElement>(LABEL);
  assert.ok(label, `the dock must carry a label element (${LABEL})`);
  return (label.textContent ?? '').replace(/[…]+$/, '').replace(/\.+$/, '').trim();
};

/** Interpolates the shipped `phases.tool` value the way the dock does. */
const expectedToolLabel = (tool: string): string =>
  (enChat.claudeStatus.phases.tool as string).replace('{{tool}}', tool);

/** One second of local time, safely under the announced silence budget. */
const STEP_MS = 800;

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
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the activity dock speaks the server phase', () => {
  test('the label is the locale word for the phase, and a tool phase names its tool', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    // The thinking phase: a positive control — the label must be the locale's
    // own word, so a dock that drew nothing cannot pass the cases below.
    push(subscribedFrame('thinking'));
    readings.push(`thinking: phase=${dockOf(view).getAttribute('data-activity-phase')} label=${JSON.stringify(labelOf(view))}`);
    assert.equal(dockOf(view).getAttribute('data-activity-phase'), 'thinking', readings.join(' | '));
    assert.equal(
      labelOf(view),
      enChat.claudeStatus.phases.thinking,
      `the label must be the locale's thinking word; readings: ${readings.join(' | ')}`,
    );

    // The tool phase: the label carries the tool's real name, taken from the
    // server's frame and not from any lookup table.
    push(heartbeatFrame(START + STEP_MS, 'tool', 'Bash'));
    readings.push(`tool: phase=${dockOf(view).getAttribute('data-activity-phase')} label=${JSON.stringify(labelOf(view))}`);
    assert.equal(dockOf(view).getAttribute('data-activity-phase'), 'tool', readings.join(' | '));
    assert.equal(
      labelOf(view),
      expectedToolLabel('Bash'),
      `the label must name the pending tool; readings: ${readings.join(' | ')}`,
    );
    assert.ok(labelOf(view).includes('Bash'), `the tool's name must appear in the label; readings: ${readings.join(' | ')}`);

    // The writing phase.
    push(heartbeatFrame(START + STEP_MS * 2, 'writing'));
    readings.push(`writing: phase=${dockOf(view).getAttribute('data-activity-phase')} label=${JSON.stringify(labelOf(view))}`);
    assert.equal(dockOf(view).getAttribute('data-activity-phase'), 'writing', readings.join(' | '));
    assert.equal(
      labelOf(view),
      enChat.claudeStatus.phases.writing,
      `the label must be the locale's writing word; readings: ${readings.join(' | ')}`,
    );
  });

  test('the label holds for six seconds inside one phase — it does not rotate', () => {
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame('tool', 'Bash'));
    const samples: string[] = [labelOf(view)];
    const phases: string[] = [dockOf(view).getAttribute('data-activity-phase') ?? ''];

    // Six seconds of local time, a fresh beat every step so the dock never reads
    // unreachable — the same phase reported every time.
    const SAMPLES = 8;
    for (let step = 1; step <= SAMPLES; step += 1) {
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
      push(heartbeatFrame(START + STEP_MS * (step + 1), 'tool', 'Bash'));
      samples.push(labelOf(view));
      phases.push(dockOf(view).getAttribute('data-activity-phase') ?? '');
    }

    const spanMs = STEP_MS * SAMPLES;
    console.log(`dock.stable.span=${spanMs}ms phases=${JSON.stringify(phases)} samples=${JSON.stringify(samples)}`);
    assert.ok(spanMs >= 5_000, `the stability window must cover at least five seconds (got ${spanMs}ms)`);
    assert.ok(samples.length >= 6, `the window must take at least six readings (got ${samples.length})`);
    assert.deepEqual(
      [...new Set(phases)],
      ['tool'],
      `every reading must land in the tool phase; phases were ${JSON.stringify(phases)}`,
    );
    assert.deepEqual(
      [...new Set(samples)],
      [expectedToolLabel('Bash')],
      `the label must not change while the phase holds; samples were ${JSON.stringify(samples)}`,
    );
  });

  test('no turn is no dock: with no activity and no anchor the dock is not rendered', () => {
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection: makeConnection().connection,
      }),
    );

    assert.equal(
      view.container.querySelector(DOCK),
      null,
      'an ended (idle) turn must draw no dock at all',
    );
  });
});

describe('a dock with no session ignores another session\'s frames', () => {
  test('a running session\'s hello and beat do not raise the dock on a fresh New Session draft', () => {
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: null,
        connection,
      }),
    );

    push(subscribedFrame('thinking'));
    push(heartbeatFrame(START + STEP_MS, 'thinking'));

    assert.equal(
      view.container.querySelector(DOCK),
      null,
      'frames for another session must not anchor a turn on a dock that has no session',
    );
  });
});
