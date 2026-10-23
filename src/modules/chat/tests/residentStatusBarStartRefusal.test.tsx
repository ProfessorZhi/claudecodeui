import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

// A type-only alias for the mocked module below, so its `importOriginal` call can name the module's
// type without an `import()` annotation (which this repo's lint forbids) and without a runtime
// import (the factory is hoisted above every statement in this file, so a value import would be
// evaluated too late for it to see). Erased before that hoisting runs, like the sibling criterion's.
import type * as SessionHostsModule from '@/shared/hooks/useSessionHosts';
import type { SessionHostsSnapshot } from '@/shared/types';

/**
 * The frontend half of the on-demand start: what the resident surface does with a refusal.
 *
 * The claim this file holds is narrow and entirely local. When the server refuses
 * a [start], the refusal must be *readable* — on the surface the control is
 * pressed from, without anything else having to be opened first — and the surface
 * must go on showing that the session has no process, because it has none. Before
 * the fix the request was issued and its answer was thrown away: the verb returned
 * a bare `Response` nobody inspected, so a 409 and a 200 were the same event and
 * the refusal was rendered, at best, into a panel that was not mounted.
 *
 * The surface is the activity dock's expanded panel now (see
 * `ActivityIndicator`), which is always drawn open — the dock owns the collapsed
 * row, and a reader reaches the panel by opening *it*. So the readings below are
 * about the panel body itself, and "the refusal did not have to open anything" is
 * a fact about where the paragraph is drawn rather than a claim about a popover
 * this file would have to keep shut.
 *
 * The verb under test is the real one. `useSessionHosts` is mocked — it is a
 * module-scope poller with no test seam, and the two sibling criteria mock it for
 * the same reason — but its `start` is wired to `api.sessionHosts.start`, so the
 * refusal travels through `readApiJson` in `src/shared/api.ts`, which is the code
 * that changed. Only the two things a jsdom test cannot own are substituted: the
 * snapshot source (the poll, replaced by a listing this file sets) and `fetch`.
 *
 * What this file does NOT claim: that a start really makes a session run. That is
 * the server's reading, held by `server/modules/session-hosts/tests/
 * resident-ondemand-start-route.test.ts` (the 200 and the `running: true` row) and
 * by the browser criterion. Here the answer is a stub, so "the session is now
 * running" is *given* to the bar, never proven by it — which is exactly the split
 * that lets this file run in milliseconds.
 *
 * What is proven, in the two arms that need each other:
 *
 *   (1) the refusal: with a 409 in flight and then answered, the control reports
 *       the wait (`data-resident-start-pending`), the server's sentence appears
 *       verbatim in `[data-resident-action-error]`, the panel still reports no
 *       process (`pid —`), and `[data-resident-start]` is still there to press
 *       again.
 *   (2) the positive control: a 200 produces no refusal text, and once the listing
 *       says the session is running the control is gone and the panel reports the
 *       host's own pid. Without this arm the first one would also pass against a
 *       surface that rendered an error paragraph unconditionally.
 *
 * Falsification (run and recorded in the completion record): with `readApiJson`
 * removed from `api.sessionHosts.start` — the pre-fix shape, where the response is
 * awaited and discarded — arm (1) reds on the error paragraph being absent: a 409
 * is no longer a throw, so nothing reaches the surface's handler.
 */

const SESSION_ID = 'session-start-refused';
const STARTED_PID = 4242;
/** The server's refusal, worded as the route words it. */
const REFUSAL_MESSAGE =
  `Session "${SESSION_ID}" is stored as "per-run"; only a resident session can be started on demand.`;

const t = ((key: string) => key) as unknown as TFunction;

/** The shape `authenticatedFetch` reads off a response: `ok`, `status`, `json`, and two header reads. */
type StubResponse = {
  ok: boolean;
  status: number;
  headers: { get: () => null };
  json: () => Promise<unknown>;
};

/**
 * State shared with the mocks, which are hoisted above every other statement here.
 *
 * `snapshot` is the listing the next render reads; `response` is what the next
 * request answers with, already-resolved or a promise the arm settles itself;
 * `requests` records what was actually sent, so "the verb really went out" is
 * read rather than assumed.
 */
const harness = vi.hoisted(() => ({
  snapshot: null as unknown,
  response: null as unknown,
  requests: [] as string[],
}));

vi.mock('@/shared/hooks/useSessionHosts', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionHostsModule>();
  // The real verb through the real API layer. A `start` that rejected on its own
  // would make this file pass against the bug it exists to catch.
  const { api } = await import('@/shared/api');

  return {
    ...actual,
    useSessionHosts: () => ({
      snapshot: harness.snapshot as SessionHostsSnapshot,
      error: null,
      loading: false,
      refresh: async () => undefined,
      start: (appSessionId: string) => api.sessionHosts.start(appSessionId),
      close: async () => undefined,
    }),
  };
});

const ResidentPanel = (await import('@/modules/chat/transcript/ResidentStatusBar')).default;

/** A listing where the session is stored resident and nothing is running for it. */
function unstartedListing(): SessionHostsSnapshot {
  return {
    hosts: [],
    sessions: [
      {
        appSessionId: SESSION_ID,
        provider: 'claude',
        lifecycleMode: 'resident',
        running: false,
        reason: 'no-live-host',
      },
    ],
  } as unknown as SessionHostsSnapshot;
}

/** The same session, once a host is up: what the poll would publish after a real start. */
function runningListing(): SessionHostsSnapshot {
  const now = Date.now();
  return {
    hosts: [
      {
        hostId: 'host-started',
        provider: 'claude',
        mode: 'resident',
        state: 'idle',
        pid: STARTED_PID,
        startedAt: now,
        closeReason: null,
        closeDetail: '',
        bindings: [
          {
            appSessionId: SESSION_ID,
            providerSessionId: 'provider-session-started',
            state: 'idle',
            leases: [],
            lastActivityAt: now,
            peerName: 'resident@local',
          },
        ],
      },
    ],
    sessions: [
      {
        appSessionId: SESSION_ID,
        provider: 'claude',
        lifecycleMode: 'resident',
        running: true,
        reason: null,
      },
    ],
  } as unknown as SessionHostsSnapshot;
}

function jsonResponse(status: number, body: unknown): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

/** The route's refusal, in the envelope `readApiJson` unwraps. */
function refusalResponse(): StubResponse {
  return jsonResponse(409, {
    success: false,
    error: { code: 'LIFECYCLE_MODE_NOT_RESIDENT', message: REFUSAL_MESSAGE },
  });
}

/** The route's success, in the same envelope. */
function acceptedResponse(): StubResponse {
  return jsonResponse(200, {
    success: true,
    data: { hostId: 'host-started', sessionId: SESSION_ID, mode: 'resident', pid: STARTED_PID },
  });
}

/** A promise the arm settles when it wants the request to complete. */
function deferred(): { promise: Promise<StubResponse>; resolve: (value: StubResponse) => void } {
  let resolve!: (value: StubResponse) => void;
  const promise = new Promise<StubResponse>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One line of this criterion's readings, printed rather than merely asserted. */
function say(line: string): void {
  console.log(`resident-start-refusal ${line}`);
}

function renderPanel() {
  return render(createElement(ResidentPanel, { sessionId: SESSION_ID, t }));
}

/** The [start] control, which only a session with no live process offers. */
function startControl(container: HTMLElement): HTMLButtonElement {
  const control = container.querySelector('[data-resident-start]');
  assert.ok(control, 'the panel must offer [start] for a resident session with nothing running');
  return control as HTMLButtonElement;
}

/**
 * The pid the panel prints — the listing's own reading of which process holds the
 * session, and the one fact that moves when a start succeeds. It replaces the
 * `data-resident-ui-state` word this file used to read: the panel has no busy/idle
 * word of its own any more, and the pid is a stronger reading of the same state
 * because it cannot be produced by the component's own vocabulary.
 */
function pidReading(container: HTMLElement): string {
  return (container.querySelector('[data-resident-pid-text]')?.textContent ?? '').trim();
}

/** Lets every pending microtask and the timer queue run, inside React's act. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The verb really went out, once, to the start endpoint — not to a mock's imagination. */
function assertOneStartRequest(): void {
  assert.equal(harness.requests.length, 1, 'exactly one request was sent');
  assert.equal(
    harness.requests[0].endsWith(`/api/session-hosts/${SESSION_ID}/start`),
    true,
    'and it was the on-demand start verb',
  );
}

beforeEach(() => {
  harness.requests.length = 0;
  harness.response = refusalResponse();
  vi.stubGlobal('fetch', async (url: unknown): Promise<StubResponse> => {
    harness.requests.push(String(url));
    return (await harness.response) as StubResponse;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the resident panel and an on-demand start', () => {
  it('shows the server\'s refusal on the panel and keeps reporting no process', async () => {
    harness.snapshot = unstartedListing();
    const gate = deferred();
    harness.response = gate.promise;

    const { container } = renderPanel();
    const control = startControl(container);

    fireEvent.click(control);
    assert.equal(
      control.dataset.residentStartPending,
      'true',
      'the control reports the wait, so a slow start is not indistinguishable from a dead one',
    );
    assert.equal(control.disabled, true, 'and cannot be pressed twice while it is in flight');
    assert.equal(
      document.querySelector('[data-resident-action-error]'),
      null,
      'nothing has been refused yet',
    );
    say(`pending data-resident-start-pending=${control.dataset.residentStartPending} disabled=${control.disabled}`);

    await act(async () => {
      gate.resolve(refusalResponse());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const error = container.querySelector('[data-resident-action-error]');
    say(
      `refused status=409 message="${error?.textContent ?? ''}" ` +
      `pid="${pidReading(container)}" pending=${control.dataset.residentStartPending}`,
    );

    assert.ok(error, 'the refusal must be readable where the control was pressed');
    assert.equal(error.textContent, REFUSAL_MESSAGE, 'and the server\'s sentence must travel verbatim');
    assert.equal(pidReading(container), 'pid —', 'nothing started, so the panel still reports no process');
    assert.ok(
      container.querySelector('[data-resident-start]'),
      'and the control is still there to press again',
    );
    assert.equal(control.dataset.residentStartPending, 'false', 'the wait is over');
    assert.equal(control.disabled, false, 'and the control is usable again');
    assertOneStartRequest();
  });

  // The positive control. If this arm ever shows an error paragraph too, arm (1) is measuring the
  // paragraph's existence rather than the refusal's arrival, and its green means nothing.
  it('control: an accepted start shows no refusal, and the control retires once the listing says running', async () => {
    harness.snapshot = unstartedListing();
    harness.response = acceptedResponse();

    const { container, rerender } = renderPanel();
    fireEvent.click(startControl(container));
    await settle();

    assert.equal(
      container.querySelector('[data-resident-action-error]'),
      null,
      'a start the server accepted is not a refusal',
    );
    assert.ok(
      container.querySelector('[data-resident-start]'),
      'and the control is still drawn until the listing says otherwise',
    );

    // The listing the next render reads is the one the server would publish once the host is up.
    // Given to the bar, not proven by it — see the file header.
    harness.snapshot = runningListing();
    rerender(createElement(ResidentPanel, { sessionId: SESSION_ID, t }));

    assert.equal(pidReading(container), `pid ${STARTED_PID}`, 'the panel reports the host the listing names');
    assert.equal(
      container.querySelector('[data-resident-start]'),
      null,
      'a session that is already running offers nothing to start',
    );
    say(`control status=200 pid="${pidReading(container)}" startControl=${container.querySelector('[data-resident-start]') === null ? 'absent' : 'present'}`);
    assertOneStartRequest();
  });
});
