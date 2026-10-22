import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, render, within } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type { ActivityConnection, ServerEvent, SessionActivity } from '@/shared/types';

/**
 * The dock's honest reading when the server stops answering.
 *
 * These cases drive the freshness machine through the dock's own in-memory
 * liveness channel — no socket, no network — and read what the surface
 * publishes: `data-activity-state`, the text, the stop control's `disabled`
 * attribute, and the server-derived elapsed reading. The browser criterion
 * (`e2e/activity-dock-truthful.spec.ts`) proves the same shape against a real
 * server; this file is the fast feedback that pins the decisions without the
 * twenty-second boot.
 *
 * The positive control matters as much as the negative: an in-turn dock must
 * still carry one of the six rotating action words, or "the word is gone when
 * unreachable" would pass against a dock that never drew a word at all.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_ROOT = path.resolve(HERE, '../../i18n/locales');

/** The six rotating action words, in every locale the app ships; the dock must drop all of them. */
const SIX_WORDS = [...new Set(
  fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = path.join(LOCALES_ROOT, entry.name, 'chat.json');
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        claudeStatus?: { actions?: Record<string, string> };
      };
      return Object.values(parsed.claudeStatus?.actions ?? {});
    })
    .filter((word): word is string => typeof word === 'string' && word.length > 0),
)];

const START = Date.parse('2026-01-01T00:00:00.000Z');
const SESSION_ID = 'session-a';
const UNREACHABLE_AFTER_MS = 900;
/** The hook's own one-second poll is what carries a threshold crossing back into React. */
const POLL_STEP_MS = 1_000;

/** `statusText: null` so the label falls through to the rotating word — the thing this file reads. */
const ACTIVITY: SessionActivity = { statusText: null, canInterrupt: true, startedAt: START };

const DOCK = '[data-activity-dock]';

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

const subscribedFrame = (overrides: Partial<ServerEvent> = {}): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing: true,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: UNREACHABLE_AFTER_MS,
  timestamp: new Date(START).toISOString(),
  ...overrides,
});

const heartbeatFrame = (
  timestamp: number,
  phase?: string,
  isProcessing?: boolean,
): ServerEvent => ({
  kind: 'activity.heartbeat',
  sessionId: SESSION_ID,
  bootId: 'boot-1',
  rev: 1,
  // A beat carries the server's reduced phase; a beat without one is a bare
  // liveness ping that says nothing about the turn (a server that predates it).
  ...(phase === undefined ? {} : { phase }),
  // The run registry's own in-flight bit, the authority over "is the turn over".
  // Absent from a server that predates the field, where the phase alone decides.
  ...(isProcessing === undefined ? {} : { isProcessing }),
  timestamp: new Date(timestamp).toISOString(),
});

const dockOf = (view: { container: HTMLElement }) => {
  const dock = view.container.querySelector<HTMLElement>(DOCK);
  assert.ok(dock, `the dock must be on screen (${DOCK}); DOM: ${view.container.innerHTML.slice(0, 400)}`);
  return dock;
};

/** The dock's published state, or `absent` when there is no dock element at all. */
const dockStateOf = (view: { container: HTMLElement }): string =>
  view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-state') ?? 'absent';

/** The dock's published server-derived elapsed, or null when it publishes none. */
const dockElapsedOf = (view: { container: HTMLElement }): string | null =>
  view.container.querySelector<HTMLElement>(DOCK)?.getAttribute('data-activity-elapsed-ms') ?? null;

/** Six seconds of local time, far past any server frame this case sends. */
const LOCAL_STEP_MS = 6_000;

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

describe('the activity dock under a partition', () => {
  test('unreachable: the six words are gone, the clock is frozen, and the dock offers no interrupt control', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    // With fresh evidence the dock is the running turn, and it does carry a word.
    push(subscribedFrame());
    const freshDock = dockOf(view);
    const freshText = freshDock.textContent ?? '';
    readings.push(`fresh: state=${freshDock.getAttribute('data-activity-state')} text="${freshText}"`);
    assert.equal(
      freshDock.getAttribute('data-activity-state'),
      'in-turn',
      `a fresh frame must read in-turn; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      SIX_WORDS.some((word) => freshText.includes(word)),
      `positive control: an in-turn dock must carry one of the six words; readings: ${readings.join(' | ')}`,
    );

    // No frame arrives. Past the server's announced threshold the dock must stop speaking for the turn.
    act(() => {
      vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + POLL_STEP_MS);
    });

    const dock = dockOf(view);
    const text = dock.textContent ?? '';
    const state = dock.getAttribute('data-activity-state');
    const hits = SIX_WORDS.filter((word) => text.includes(word));
    readings.push(`unreachable: state=${state} text="${text}" hits=${JSON.stringify(hits)}`);
    assert.equal(state, 'unreachable', `silence past the threshold must read unreachable; readings: ${readings.join(' | ')}`);
    assert.deepEqual(
      hits,
      [],
      `no rotating action word may survive into the unreachable dock (any locale); readings: ${readings.join(' | ')}`,
    );

    // The elapsed reading is frozen: local time moves, the number does not.
    const frozenBefore = dock.getAttribute('data-activity-elapsed-ms');
    const textBefore = text.match(/\d+s|\d+m \d+s/)?.[0] ?? '<none>';
    act(() => {
      vi.advanceTimersByTime(LOCAL_STEP_MS);
    });
    const frozenAfter = dockOf(view).getAttribute('data-activity-elapsed-ms');
    const textAfter = (dockOf(view).textContent ?? '').match(/\d+s|\d+m \d+s/)?.[0] ?? '<none>';
    readings.push(`frozen: before=${frozenBefore}ms after=${frozenAfter}ms text "${textBefore}" -> "${textAfter}"`);
    assert.notEqual(frozenBefore, null, `an unreachable turn must still report its last server-derived elapsed; readings: ${readings.join(' | ')}`);
    assert.equal(
      frozenAfter,
      frozenBefore,
      `the elapsed reading must be frozen while unreachable, not re-driven by the local clock; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      textAfter,
      textBefore,
      `the elapsed text must read the same across local time; readings: ${readings.join(' | ')}`,
    );

    // The dock has no interrupt control at all any more, on any tier: the composer's
    // submit button is the one stop entry. What the unreachable state still owes the
    // reader is the connection's own sentence — asserted above, where the frozen
    // elapsed and the absence of the six words are read. (The main button's disabled
    // state and its visible reason are pinned in `chatComposerResponsive.test.tsx`,
    // on the control that actually carries them.)
    const stops = within(dock).queryAllByRole('button', { name: /stop/i });
    readings.push(`stop controls in the dock=${stops.length}`);
    assert.equal(
      stops.length,
      0,
      `the dock must carry no interrupt control — the composer's submit is the one stop entry; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      (dock.outerHTML.match(/aria-label/gi) ?? []).length,
      0,
      `the dock must expose no named control at all; readings: ${readings.join(' | ')}`,
    );
  });

  test('a failed send is a state of its own, and a live turn is never relabelled by it', () => {
    const readings: string[] = [];

    // Nothing is running and the send failed: the dock speaks the failure. This
    // is the reading the browser criterion takes — and the one a retained local
    // "processing" mark would keep out of reach.
    const failedView = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection: makeConnection().connection,
        sendFailed: true,
      }),
    );
    const failedDock = dockOf(failedView);
    const failedState = failedDock.getAttribute('data-activity-state');
    const failedText = failedDock.textContent ?? '';
    const failedHits = SIX_WORDS.filter((word) => failedText.includes(word));
    readings.push(`send-failed: state=${failedState} text="${failedText}" hits=${JSON.stringify(failedHits)}`);
    assert.equal(
      failedState,
      'send-failed',
      `a failed send with no turn must publish its own state; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      failedText.trim().length > 0,
      `the failed-send dock must say something, not draw an empty element; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      failedText.includes(enChat.claudeStatus.sendFailed.title),
      `the dock must carry the shipped failure wording; readings: ${readings.join(' | ')}`,
    );
    assert.deepEqual(
      failedHits,
      [],
      `a failed send is not a turn: no rotating action word may appear; readings: ${readings.join(' | ')}`,
    );

    // A session the local table still reports as running is NOT relabelled: the
    // turn reading wins, so keeping the send-time mark (the defect) leaves the
    // dock claiming a turn instead of reporting the failure.
    const markedView = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection: makeConnection().connection,
        sendFailed: true,
      }),
    );
    const markedState = dockOf(markedView).getAttribute('data-activity-state');
    readings.push(`retained-mark: state=${markedState}`);
    assert.notEqual(
      markedState,
      'send-failed',
      `a retained processing mark must keep the dock off the failed-send state; readings: ${readings.join(' | ')}`,
    );
  });

  test('recovery: a frame after the partition returns the dock to the turn, with the clock carried forward', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    act(() => {
      vi.advanceTimersByTime(UNREACHABLE_AFTER_MS + POLL_STEP_MS);
    });
    assert.equal(
      dockOf(view).getAttribute('data-activity-state'),
      'unreachable',
      `premise: the partition must have degraded the dock; readings: ${readings.join(' | ')}`,
    );

    // A heartbeat after the gap: the turn's anchor survived, so the elapsed is the whole span,
    // not a clock restarted at the moment the frame arrived.
    const RESTART_MS = 30_000;
    push(heartbeatFrame(START + RESTART_MS));
    const dock = dockOf(view);
    const elapsed = Number(dock.getAttribute('data-activity-elapsed-ms'));
    readings.push(`recovered: state=${dock.getAttribute('data-activity-state')} elapsed=${elapsed}ms restart-would-be=0ms`);
    assert.equal(
      dock.getAttribute('data-activity-state'),
      'in-turn',
      `a frame must restore the turn; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      elapsed,
      RESTART_MS,
      `the elapsed must be measured from the turn's first anchor, not from the recovery frame; readings: ${readings.join(' | ')}`,
    );
    assert.notEqual(
      elapsed,
      0,
      `a clock restarted at recovery would read 0; readings: ${readings.join(' | ')}`,
    );
  });
});

/*
 * The turn a hello opened, and the beat that ends it.
 *
 * A page that subscribes while a turn is running learns the turn from the
 * `chat_subscribed` hello (`isProcessing`), which pins the dock's elapsed anchor.
 * The turn then ends while the page watches: the server reduces the turn's own
 * frames and stamps `phase: "idle"` onto the next `activity.heartbeat`. That beat
 * is the only evidence a live page gets that the turn is over — there is no new
 * socket message and no re-subscribe — so it has to be the frame that clears the
 * anchor. These cases pin that, and the control that keeps the fix from being a
 * deletion of the anchoring path.
 */

describe('the activity dock when the server ends the turn', () => {
  // AC1: the beat clears the anchor. A hello pins a running turn; the server's own
  // idle report takes it back — no reload, no re-subscribe.
  test('AC1 an idle heartbeat clears the anchor a hello pinned: the dock leaves in-turn', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    // The local table has already forgotten the turn, so the anchor is the only
    // claim left standing — exactly the state the deployed defect was stuck in.
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    readings.push(`after hello: state=${dockStateOf(view)} elapsed=${dockElapsedOf(view)}`);
    assert.equal(
      dockStateOf(view),
      'in-turn',
      `the hello's isProcessing must pin a running turn; readings: ${readings.join(' | ')}`,
    );

    push(heartbeatFrame(START + 5_000, 'idle'));
    readings.push(`after idle beat: state=${dockStateOf(view)} elapsed=${dockElapsedOf(view)}`);
    assert.notEqual(
      dockStateOf(view),
      'in-turn',
      `the server's own idle report must end the turn; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      dockStateOf(view),
      'absent',
      `with no turn there is nothing for the dock to draw; readings: ${readings.join(' | ')}`,
    );
  });

  // AC2: the positive control. The fix connects the clearing path; it must not be
  // "never pin an anchor at all", which would pass AC1 trivially.
  test('AC2 control: a hello that opens a turn and hears no idle beat stays in-turn', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    readings.push(`after hello: state=${dockStateOf(view)}`);
    assert.equal(
      dockStateOf(view),
      'in-turn',
      `the hello must still pin a turn — the clearing path must not delete the anchoring; readings: ${readings.join(' | ')}`,
    );

    // A running phase is confirmation, not an ending: the turn is carried forward.
    push(heartbeatFrame(START + 5_000, 'thinking'));
    readings.push(`after running beat: state=${dockStateOf(view)}`);
    assert.equal(
      dockStateOf(view),
      'in-turn',
      `a running phase must carry the turn forward, not end it; readings: ${readings.join(' | ')}`,
    );
  });

  // AC3: the clock stops with the turn. Two idle beats five seconds apart must not
  // move the elapsed reading — the defect was exactly this number climbing once a
  // second against a server that had already said the turn was over.
  test('AC3 after the server reports idle the elapsed reading stops growing', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    const open = dockStateOf(view);
    readings.push(`open: state=${open} elapsed=${dockElapsedOf(view)}`);
    assert.equal(open, 'in-turn', `premise: the hello pins a running turn; readings: ${readings.join(' | ')}`);

    // The first beat after the turn ended. The defect advanced the clock here.
    push(heartbeatFrame(START + 5_000, 'idle'));
    const first = dockElapsedOf(view);
    const firstState = dockStateOf(view);
    readings.push(`idle@0s: state=${firstState} elapsed=${first}`);

    // Five seconds and a second idle beat later, the reading must be unchanged.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    push(heartbeatFrame(START + 10_000, 'idle'));
    const second = dockElapsedOf(view);
    const secondState = dockStateOf(view);
    readings.push(`idle@5s: state=${secondState} elapsed=${second}`);

    assert.notEqual(
      firstState,
      'in-turn',
      `the server's idle report must end the turn before the clock is read; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      second,
      first,
      `the elapsed reading must not grow after the server reported idle; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      second,
      null,
      `an ended turn owes no elapsed reading at all; readings: ${readings.join(' | ')}`,
    );
  });
});

/*
 * The turn that is still running while the phase tracker has no phase.
 *
 * The phase tracker reads `idle` for any session it never saw a phase-carrying
 * frame for, so its `idle` covers both "the turn ended" and "the turn is
 * running but silent". Only the run registry can tell the two apart, and the
 * server folds its own in-flight bit onto every heartbeat. These cases pin that
 * the bit — not the phase — decides, while the fallback (a server without the
 * bit) still ends the turn on `idle` exactly as before.
 */
describe('the activity dock when the run is in flight but the phase is idle', () => {
  // AC3/AC4: a running run whose tracker reports `idle` must keep the anchor the
  // hello pinned, so the server-derived elapsed stays finite and the dock stays a turn.
  test('AC3 an idle phase on a run still in flight keeps the anchor and the server-derived clock', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    readings.push(`after hello: state=${dockStateOf(view)} elapsed=${dockElapsedOf(view)}`);
    assert.equal(
      dockStateOf(view),
      'in-turn',
      `the hello's isProcessing must pin a running turn; readings: ${readings.join(' | ')}`,
    );

    // The frame the defect misread: the tracker says `idle`, the registry says in-flight.
    push(heartbeatFrame(START + 5_000, 'idle', true));
    const state = dockStateOf(view);
    const elapsed = Number(dockElapsedOf(view));
    readings.push(`after idle beat on a live run: state=${state} elapsed=${dockElapsedOf(view)}`);
    assert.equal(
      state,
      'in-turn',
      `an idle phase on a run the registry says is in flight must not end the turn; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      dockElapsedOf(view),
      String(5_000),
      `the recovered dock must report the server-derived elapsed, not a cleared anchor; readings: ${readings.join(' | ')}`,
    );
    assert.ok(
      Number.isFinite(elapsed),
      `the elapsed must be a finite server-derived number, not NaN; readings: ${readings.join(' | ')}`,
    );
  });

  // AC4: the positive control `873f91d2` added — a run the registry reports ended
  // clears the anchor, so a finished turn does not count up forever.
  test('AC4 the registry ending the run clears the anchor, whatever the phase still says', () => {
    const readings: string[] = [];
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );

    push(subscribedFrame());
    assert.equal(
      dockStateOf(view),
      'in-turn',
      `premise: the hello pins a running turn; readings: ${readings.join(' | ')}`,
    );

    // The run ended, but the tracker still holds its last phase — the exact lag
    // the authority exists to cover. The registry's bit is what ends the turn.
    push(heartbeatFrame(START + 5_000, 'thinking', false));
    readings.push(`after ended run: state=${dockStateOf(view)} elapsed=${dockElapsedOf(view)}`);
    assert.equal(
      dockStateOf(view),
      'absent',
      `an ended run must clear the anchor even while the phase still says thinking; readings: ${readings.join(' | ')}`,
    );
    assert.equal(
      dockElapsedOf(view),
      null,
      `an ended turn owes no elapsed reading; readings: ${readings.join(' | ')}`,
    );
  });
});
