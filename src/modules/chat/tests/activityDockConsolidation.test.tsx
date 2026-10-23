import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import i18next from 'i18next';
import React from 'react';
import { initReactI18next } from 'react-i18next';
import { beforeEach, describe, test, vi } from 'vitest';

import ActivityIndicator from '@/modules/chat/composer/ActivityIndicator';
import { classifyRunningSessions } from '@/shared/hooks/useSessionHosts';
import enChat from '@/modules/i18n/locales/en/chat.json';
import type {
  ActivityConnection,
  ServerEvent,
  SessionActivity,
  SessionHostsSnapshot,
} from '@/shared/types';

/**
 * One dock, and one answer about a session — in milliseconds.
 *
 * The page used to give four answers to "is this session working": a tab-shaped
 * strip hanging off the composer, a compact line at the end of the transcript,
 * the resident status bar's own busy/idle word (read off a one-second
 * `/api/session-hosts` poll), and the sidebar's running view, badge and send
 * button. Every pair of them could disagree, and the pair that actually did was
 * the dock against everything downstream of that poll.
 *
 * This file pins the two halves of the consolidation that a browser run would
 * take a minute to say, and pins them as *readings that could have gone the other
 * way*:
 *
 *   - exactly one `[data-activity-dock]` exists, and the two markers the old
 *     surfaces published (the `.chat-activity-tab` class and the
 *     `chat-activity-inline` slot) match nothing at all;
 *   - the dock's reading and the sidebar's classification of the same session are
 *     the same answer, in both directions — turn in flight and turn over. The
 *     second arm is the control: without it, a page that drew no dock and
 *     classified nothing as running would satisfy the first.
 *
 * What this cannot prove is that a *real* server's frames drive both — that is
 * `e2e/activity-dock-truthful.spec.ts -g "AC-188"`, on a real page against a real
 * debug-agent turn. Here the frame source is in memory, which is the point:
 * milliseconds, and the reason named when it goes red.
 */

const SESSION_ID = 'session-consolidation';
const START = Date.parse('2026-01-01T00:00:00.000Z');
const EXIT_ANIMATION_MS = 220;

/** The turn these cases are about: a real one, from the client's activity table. */
const ACTIVITY: SessionActivity = {
  statusText: 'Reviewing',
  canInterrupt: true,
  startedAt: START,
};

/** An in-memory liveness channel, so the dock runs without a socket. */
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

/** The hello the server sends a subscriber: it is the frame that asserts a turn. */
const subscribedFrame = (isProcessing: boolean): ServerEvent => ({
  kind: 'chat_subscribed',
  sessionId: SESSION_ID,
  isProcessing,
  bootId: 'boot-1',
  rev: 1,
  unreachableAfterMs: 60_000,
  timestamp: new Date(START).toISOString(),
});

/** A host listing holding one resident session, so the classification has a second group to place. */
const HOST_LISTING: SessionHostsSnapshot = {
  hosts: [
    {
      hostId: 'host-consolidation',
      provider: 'claude',
      mode: 'resident',
      state: 'idle',
      pid: 4242,
      startedAt: START,
      closeReason: null,
      closeDetail: null,
      bindings: [
        {
          appSessionId: SESSION_ID,
          providerSessionId: 'provider-consolidation',
          state: 'idle',
          leases: [],
          lastActivityAt: START,
          peerName: 'resident@host',
        },
      ],
    },
  ],
  sessions: [
    {
      appSessionId: SESSION_ID,
      provider: 'claude',
      lifecycleMode: 'resident',
      running: false,
      reason: null,
    },
  ],
} as unknown as SessionHostsSnapshot;

const DOCK = '[data-activity-dock]';
/** The two markers the pre-consolidation surfaces published. Neither may match anything. */
const LEGACY_MARKERS = ['.chat-activity-tab', '[data-slot="chat-activity-inline"]'] as const;

const dockState = (container: HTMLElement): string | null =>
  container.querySelector(DOCK)?.getAttribute('data-activity-state') ?? null;

const legacyHits = (container: HTMLElement): string[] =>
  LEGACY_MARKERS.filter((marker) => container.querySelector(marker) !== null);

beforeEach(() => {
  vi.useFakeTimers({ now: START });
  return () => vi.useRealTimers();
});

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['chat'],
  defaultNS: 'chat',
  resources: { en: { chat: enChat } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

describe('one dock, and one classification of the session', () => {
  test('with a turn in flight: one dock, no legacy surface, and the sidebar says running too', () => {
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: ACTIVITY,
        sessionId: SESSION_ID,
        connection,
      }),
    );
    push(subscribedFrame(true));

    const docks = view.container.querySelectorAll(DOCK);
    const legacy = legacyHits(view.container);
    const state = dockState(view.container);
    const { running, residentIdle } = classifyRunningSessions(new Set([SESSION_ID]), HOST_LISTING);
    console.log(
      `turn: docks=${docks.length} legacy=${JSON.stringify(legacy)} dock.state=${state} `
      + `sidebar.running=${JSON.stringify(running)} sidebar.residentIdle=${JSON.stringify(residentIdle)}`,
    );

    assert.equal(docks.length, 1, 'a session draws exactly one dock, however many surfaces it has');
    assert.deepEqual(
      legacy,
      [],
      'neither of the pre-consolidation markers may match: the tab class and the inline slot are gone, '
        + 'not merely hidden',
    );
    assert.equal(state, 'in-turn', 'the dock reads the server\'s own frame as a turn');
    assert.deepEqual(running, [SESSION_ID], 'and the sidebar classifies the same session as running');
    assert.deepEqual(residentIdle, [], 'and not as a resident process held open — the two groups are disjoint');

    view.unmount();
  });

  test('with the turn over: a resident session\'s dock is gone like any other, and the sidebar still holds its process', () => {
    // The arm the old page failed, and the one that changed. The dock used to stay on screen between
    // turns for a resident session, reading `idle`, because it carried the arrow that opened the
    // process's facts. Those facts are the header pill's now (see `ResidentSessionBadge`), so the
    // dock has nothing to report once the turn ends and draws nothing — for this session exactly as
    // for one that is not resident. What must stay true is the *agreement*: the dock has seen the
    // turn end, and the sidebar classifies the same session from the same activity table at the same
    // instant. A page whose sidebar still consulted the one-second host poll would classify it as
    // running off the poll's lease while the dock had already gone: `sidebar.running` would be
    // `["session-consolidation"]` against no dock at all. That is the window
    // `e2e/activity-dock-truthful.spec.ts` opens on a real server; this is the same disagreement in
    // the small. The resident process itself is still reported — by the sidebar's other group.
    const { connection, push } = makeConnection();
    const view = render(
      React.createElement(ActivityIndicator, {
        activity: null,
        sessionId: SESSION_ID,
        connection,
      }),
    );
    // A resident session with nothing in flight: the hello itself says so.
    push(subscribedFrame(false));
    act(() => {
      vi.advanceTimersByTime(EXIT_ANIMATION_MS);
    });

    const docks = view.container.querySelectorAll(DOCK);
    const legacy = legacyHits(view.container);
    const { running, residentIdle } = classifyRunningSessions(new Set<string>(), HOST_LISTING);
    console.log(
      `idle: docks=${docks.length} legacy=${JSON.stringify(legacy)} `
      + `sidebar.running=${JSON.stringify(running)} sidebar.residentIdle=${JSON.stringify(residentIdle)}`,
    );

    assert.equal(docks.length, 0, 'with no turn there is nothing to report: no dock, resident or not');
    assert.deepEqual(legacy, [], 'and nothing publishes the old markers in its place');
    assert.deepEqual(running, [], 'the sidebar counts no turn in flight, from the same activity table');
    assert.deepEqual(residentIdle, [SESSION_ID], 'and places the held-open process in the other group');

    view.unmount();
  });
});
