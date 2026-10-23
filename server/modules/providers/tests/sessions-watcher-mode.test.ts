import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  resolvePollIntervalMs,
  resolveWatcherMode,
  watchProviderRoot,
  type ResolvedWatcherMode,
  type WatcherMode,
  type WatcherModeProbe,
} from '@/modules/providers/services/sessions-watcher.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * The criterion for "the session watcher no longer polls unconditionally".
 *
 * Three readings, none of them optional:
 *
 *  (i)   THE DECISION IS A FUNCTION OF ITS INPUTS. `resolveWatcherMode` is
 *        driven over the full table — `auto`/`native`/`poll` × probe
 *        success/failure — because the interesting cases are the ones where a
 *        mechanism is NOT used, and those are invisible in production until a
 *        host has the wrong filesystem. The two refusals are asserted as
 *        refusals: an explicit `native` that cannot be honoured must error
 *        rather than hand the operator the polling clock it was asked to avoid,
 *        and an unrecognised value must fall back to `auto` AND say so, because
 *        a silent fallback is indistinguishable from a typo that took effect.
 *
 *  (ii)  THE TWO MECHANISMS REALLY DELIVER, on a real temporary root through the
 *        real watcher. Native events must announce a new transcript within 2 s;
 *        polling must announce it within one poll period plus a second. Both
 *        arms assert the SAME path they wrote, so neither can pass on an event
 *        about something else, and the poll arm asserts the resolution it ran on
 *        really carried the 6 s floor — otherwise "polling worked" would be a
 *        reading about a faster interval than the one production uses.
 *
 *  (iii) A FAILED NATIVE WATCHER DOES NOT GO DEAF. An `ENOSPC` is injected into
 *        a running native watcher (chokidar cannot be asked for a specific
 *        errno, and an unwatchable root cannot be staged on demand), and the
 *        criterion then reads the mode back and proves a later append is still
 *        noticed. The pre-task code logged the error and kept a watcher that
 *        could no longer fire, which is exactly what this arm would have caught.
 *
 * Native arms pass `nativeAvailable: true` as their probe rather than running
 * one: the probe's own answer is an environment fact, and a criterion that
 * depended on the CI host's inotify state would red for a reason that has
 * nothing to do with the code under test. That the probe and the production
 * wiring are correct on a real root is what the debug agent's external-write
 * criterion reads, on the boot path, in a child of its own.
 */

/** The provider whose artifact shape this criterion watches for. */
const PROVIDER: LLMProvider = 'claude';

/** The probe result a host that can serve native events reports. */
const NATIVE_OK: WatcherModeProbe = { nativeAvailable: true, reason: 'criterion-supplied probe' };

/** The probe result a container or network root reports. */
const NATIVE_FAILED: WatcherModeProbe = {
  nativeAvailable: false,
  reason: 'native watcher errored during the probe: ENOSPC',
};

/** How long a native `add` may take. Generous next to the microseconds it costs. */
const NATIVE_EVENT_BUDGET_MS = 2_000;

/**
 * The extra slack the polling arms allow on top of one poll period.
 *
 * Measured 2026-09-27 (`sessions-watcher-mode.test.ts` under fleet concurrency, three separate
 * fan-in rounds): standalone this arm lands the append 6021-6026ms after the write — right at the
 * `POLL_INTERVAL_MIN_MS` floor with almost no overhead — but under load it once took 8383ms, well
 * past the old 1s slack (7000ms window). 1s of slack against a 6s floor is a ~14% margin, which a
 * moderately busy fleet eats. 4s keeps the same shape (still a bound, not "wait forever") while
 * giving real headroom against scheduler jitter.
 */
const POLL_WINDOW_SLACK_MS = 4_000;

/** How often the arms look at what they have collected. */
const OBSERVATION_TICK_MS = 25;

/**
 * How long an arm waits after `whenReady` before it changes anything.
 *
 * Not part of any criterion: it exists so the case measures a settled watcher,
 * not the arming gap between the first walk finishing and the watches being
 * live. See `observeNewTranscript` for the reading that motivates it.
 */
const WATCHER_ARM_SETTLE_MS = 300;

type ObservedEvent = { eventType: string; filePath: string };

/** Runs one body against a fresh temp root, removing it either way. */
async function withTempRoot<T>(run: (rootPath: string) => Promise<T>): Promise<T> {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'sessions-watcher-mode-'));
  try {
    return await run(rootPath);
  } finally {
    rmSync(rootPath, { recursive: true, force: true });
  }
}

/** The transcript path both real-filesystem arms write and then look for. */
function transcriptPathFor(rootPath: string): string {
  return path.join(rootPath, 'project-a', 'session.jsonl');
}

/**
 * Waits until the observer has handed `filePath` to the sink, or the window
 * elapses.
 *
 * The loop's bound is the assertion; the elapsed value it returns is a reading,
 * not a lower bound — nothing here claims delivery takes any particular amount
 * of time, only that it lands inside the window.
 */
async function waitForPath(
  observed: ObservedEvent[],
  filePath: string,
  windowMs: number
): Promise<{ elapsedMs: number | null; observed: ObservedEvent[] }> {
  const startedAt = Date.now();
  for (;;) {
    if (observed.some((event) => event.filePath === filePath)) {
      return { elapsedMs: Date.now() - startedAt, observed: [...observed] };
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed >= windowMs) {
      return { elapsedMs: null, observed: [...observed] };
    }

    await delay(Math.min(OBSERVATION_TICK_MS, windowMs - elapsed));
  }
}

/**
 * Starts one root's watcher with `resolution`, waits for its first walk to
 * finish, writes a transcript, and reports what was handed to the sink along
 * with the mode the watcher ended up in.
 */
async function observeNewTranscript(
  rootPath: string,
  resolution: ResolvedWatcherMode,
  windowMs: number
): Promise<{ mode: WatcherMode; expectedPath: string; elapsedMs: number | null; observed: ObservedEvent[] }> {
  const expectedPath = transcriptPathFor(rootPath);
  const observed: ObservedEvent[] = [];

  const handle = await watchProviderRoot({
    provider: PROVIDER,
    rootPath,
    resolution,
    trackedFileCount: 0,
    onFileEvent: (eventType, filePath) => {
      observed.push({ eventType, filePath });
    },
  });

  try {
    await handle.whenReady();

    // `whenReady` resolves when the first walk ends, which is not the same moment
    // the watches are live: a change written into that gap is not replayed, so a
    // native arm can lose one. Measured on this machine's real corpus (200
    // project directories) a write in the first second after ready was missed in
    // 3 runs out of 3 and delivered in ~0.5 s on all 7 runs that wrote after a
    // settle. Settling first keeps this case about delivery rather than about
    // how long arming takes — the window measured below still starts at the
    // write, so it is a settled watcher that has to answer, not a fast one.
    await delay(WATCHER_ARM_SETTLE_MS);

    // Written strictly after the first walk, so the file can only be an `add`:
    // a file the walk finds is initial state and `ignoreInitial` suppresses it.
    writeFileSync(expectedPath, '{"type":"user"}\n');
    const { elapsedMs } = await waitForPath(observed, expectedPath, windowMs);

    return { mode: handle.mode(), expectedPath, elapsedMs, observed };
  } finally {
    await handle.close();
  }
}

test('resolveWatcherMode: the request × the probe decide usePolling and the interval', () => {
  const files = 5_000;
  const backedOff = resolvePollIntervalMs(files);
  assert.ok(
    backedOff > POLL_INTERVAL_MIN_MS,
    `the table needs a corpus whose interval is above the floor, or two rows read the same: ${backedOff}`
  );

  const cases: Array<{
    name: string;
    requested: string | undefined;
    probe: WatcherModeProbe | null;
    mode: WatcherMode;
    usePolling: boolean;
    interval: number;
  }> = [
    {
      name: 'auto + probe ok -> native',
      requested: 'auto',
      probe: NATIVE_OK,
      mode: 'native',
      usePolling: false,
      interval: 0,
    },
    {
      name: 'auto + probe failed -> poll, backed off',
      requested: 'auto',
      probe: NATIVE_FAILED,
      mode: 'poll',
      usePolling: true,
      interval: backedOff,
    },
    {
      name: 'unset -> auto -> native when the probe succeeds',
      requested: undefined,
      probe: NATIVE_OK,
      mode: 'native',
      usePolling: false,
      interval: 0,
    },
    {
      name: 'unset -> auto -> poll when the probe fails',
      requested: undefined,
      probe: NATIVE_FAILED,
      mode: 'poll',
      usePolling: true,
      interval: backedOff,
    },
    {
      name: 'empty string -> auto, not an unknown value',
      requested: '',
      probe: NATIVE_OK,
      mode: 'native',
      usePolling: false,
      interval: 0,
    },
    {
      name: 'poll + probe ok -> still poll (the operator already decided)',
      requested: 'poll',
      probe: NATIVE_OK,
      mode: 'poll',
      usePolling: true,
      interval: backedOff,
    },
    {
      name: 'poll + no probe run -> poll',
      requested: 'poll',
      probe: null,
      mode: 'poll',
      usePolling: true,
      interval: backedOff,
    },
    {
      name: 'POLL (uppercased) -> poll',
      requested: 'POLL',
      probe: null,
      mode: 'poll',
      usePolling: true,
      interval: backedOff,
    },
    {
      name: 'native + probe ok -> native',
      requested: 'native',
      probe: NATIVE_OK,
      mode: 'native',
      usePolling: false,
      interval: 0,
    },
  ];

  for (const entry of cases) {
    const lines: string[] = [];
    const resolved = resolveWatcherMode(entry.requested, entry.probe, files, (line) => lines.push(line));

    assert.deepEqual(
      { mode: resolved.mode, usePolling: resolved.options.usePolling, interval: resolved.options.interval },
      { mode: entry.mode, usePolling: entry.usePolling, interval: entry.interval },
      entry.name
    );
    assert.equal(
      resolved.options.binaryInterval,
      resolved.options.interval,
      `${entry.name}: both polling clocks must be the same period`
    );
    assert.deepEqual(lines, [resolved.note], `${entry.name}: exactly one mode line, and it is the returned note`);
  }
});

test('resolveWatcherMode: an explicit native request refuses to degrade when the probe failed', () => {
  for (const probe of [NATIVE_FAILED, null]) {
    const lines: string[] = [];
    assert.throws(
      () => resolveWatcherMode('native', probe, 5_000, (line) => lines.push(line)),
      /CLOUDCLI_WATCHER_MODE=native/,
      `native with probe ${JSON.stringify(probe)} must error rather than fall back to the polling clock it was asked to avoid`
    );
    assert.deepEqual(lines, [], 'a refusal is not a resolution and must not be announced as one');
  }

  // The control that keeps the refusal from being vacuous: the SAME failing
  // probe under `auto` is a fallback, not an error.
  const lines: string[] = [];
  const resolved = resolveWatcherMode('auto', NATIVE_FAILED, 5_000, (line) => lines.push(line));
  assert.equal(resolved.mode, 'poll', 'auto must still degrade on the probe that native refuses');
  assert.equal(lines.length, 1, 'and it must say so');
});

test('resolveWatcherMode: an unrecognised value falls back to auto and says so in one line', () => {
  const lines: string[] = [];
  const resolved = resolveWatcherMode('polling', NATIVE_OK, 10, (line) => lines.push(line));

  assert.equal(resolved.mode, 'native', 'the fallback is auto, which this probe then resolves to native');
  assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(lines)}`);
  assert.ok(lines[0].includes('"polling"'), `the line must quote the value it rejected: ${lines[0]}`);
  assert.ok(lines[0].includes('falling back to auto'), `the line must name the fallback: ${lines[0]}`);

  // Same value, failing probe: it must land where `auto` lands, which is how the
  // assertion above is known to be about `auto` rather than about `native`.
  const degraded: string[] = [];
  const degradedResolved = resolveWatcherMode('polling', NATIVE_FAILED, 10, (line) => degraded.push(line));
  assert.equal(degradedResolved.mode, 'poll', 'an unrecognised value must behave as auto on both probe outcomes');
  assert.ok(degraded[0].includes('"polling"'), `the degraded line must still quote the value: ${degraded[0]}`);
});

test('resolvePollIntervalMs: floored at the pre-task 6s, monotonic in the file count, clamped at the ceiling', () => {
  const counts = [0, 1, 1_000, 5_000, 50_000, 1_000_000];
  const readings = counts.map((count) => ({ count, interval: resolvePollIntervalMs(count) }));

  assert.equal(readings[0].interval, POLL_INTERVAL_MIN_MS, 'zero files must be exactly the period the watcher used before');
  for (let index = 1; index < readings.length; index += 1) {
    assert.ok(
      readings[index].interval >= readings[index - 1].interval,
      `the interval must never shrink as the corpus grows: ${JSON.stringify(readings)}`
    );
  }

  assert.equal(
    resolvePollIntervalMs(50_000),
    POLL_INTERVAL_MAX_MS,
    `a corpus past the ceiling must be clamped to it: ${JSON.stringify(readings)}`
  );
  assert.equal(
    resolvePollIntervalMs(1_000_000),
    POLL_INTERVAL_MAX_MS,
    'and the clamp must hold however large the corpus gets'
  );
  assert.ok(
    resolvePollIntervalMs(5_000) > POLL_INTERVAL_MIN_MS,
    'the 5 000-file corpus this task measured must poll less often than the floor'
  );

  // Degenerate inputs are the floor, not NaN: the count comes from a walk that
  // can be interrupted, and a NaN period would make chokidar poll continuously.
  for (const degenerate of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolvePollIntervalMs(degenerate), POLL_INTERVAL_MIN_MS, `resolvePollIntervalMs(${degenerate})`);
  }
});

test('a real root: native events announce a new transcript inside 2s, polling inside one poll period', async () => {
  const nativeResolution = resolveWatcherMode('native', NATIVE_OK, 0, () => undefined);
  const pollResolution = resolveWatcherMode('poll', null, 0, () => undefined);
  assert.equal(
    pollResolution.options.interval,
    POLL_INTERVAL_MIN_MS,
    'the polling arm must run on the floor interval, or it is not reading the mechanism production degrades to'
  );

  const native = await withTempRoot(async (rootPath) => {
    mkdirSync(path.dirname(transcriptPathFor(rootPath)), { recursive: true });
    return observeNewTranscript(rootPath, nativeResolution, NATIVE_EVENT_BUDGET_MS);
  });

  assert.equal(native.mode, 'native', 'the native arm must actually be running on native events');
  assert.equal(
    native.elapsedMs !== null,
    true,
    `the native watcher must announce the new transcript within ${NATIVE_EVENT_BUDGET_MS}ms: ${JSON.stringify(native.observed)}`
  );
  assert.ok(
    (native.elapsedMs as number) <= NATIVE_EVENT_BUDGET_MS,
    `native delivery took ${native.elapsedMs}ms, over the ${NATIVE_EVENT_BUDGET_MS}ms budget`
  );
  assert.deepEqual(
    native.observed.map((event) => event.filePath),
    native.observed.map(() => native.expectedPath),
    `the native arm must only report the path it wrote: ${JSON.stringify(native.observed)}`
  );

  const pollWindowMs = POLL_INTERVAL_MIN_MS + POLL_WINDOW_SLACK_MS;
  const poll = await withTempRoot(async (rootPath) => {
    mkdirSync(path.dirname(transcriptPathFor(rootPath)), { recursive: true });
    return observeNewTranscript(rootPath, pollResolution, pollWindowMs);
  });

  assert.equal(poll.mode, 'poll', 'the polling arm must actually be running on the polling clock');
  assert.equal(
    poll.elapsedMs !== null,
    true,
    `the polling watcher must announce the new transcript within ${pollWindowMs}ms: ${JSON.stringify(poll.observed)}`
  );
  assert.ok(
    (poll.elapsedMs as number) <= pollWindowMs,
    `polling delivery took ${poll.elapsedMs}ms, over the ${pollWindowMs}ms window`
  );
  assert.deepEqual(
    poll.observed.map((event) => event.filePath),
    poll.observed.map(() => poll.expectedPath),
    `the polling arm must only report the path it wrote: ${JSON.stringify(poll.observed)}`
  );

  // Both arms received the same path SHAPE — an absolute path naming the very
  // file each wrote — so "an event arrived" cannot be a reading about a
  // different file in a differently-rooted watcher.
  assert.equal(path.isAbsolute(native.expectedPath), true, 'the expected path is absolute');
  assert.equal(path.basename(native.expectedPath), path.basename(poll.expectedPath), 'both arms watch one file shape');
});

test('a native watcher that errors hands the root to polling and keeps observing it', async () => {
  await withTempRoot(async (rootPath) => {
    const transcriptPath = transcriptPathFor(rootPath);
    mkdirSync(path.dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, '{"type":"user"}\n');

    const observed: ObservedEvent[] = [];
    const resolution = resolveWatcherMode('native', NATIVE_OK, 0, () => undefined);
    const handle = await watchProviderRoot({
      provider: PROVIDER,
      rootPath,
      resolution,
      trackedFileCount: 0,
      onFileEvent: (eventType, filePath) => {
        observed.push({ eventType, filePath });
      },
    });

    try {
      await handle.whenReady();
      assert.equal(handle.mode(), 'native', 'the arm must start native, or the degradation below is a no-op');
      assert.equal(handle.degradations(), 0, 'nothing has degraded yet');

      handle.emitError(
        new Error('ENOSPC: System limit for number of file watchers reached, watch /root/project-a')
      );

      assert.equal(
        handle.mode(),
        'poll',
        'an error on the native watcher must switch the root to polling, not leave it watching with a dead descriptor'
      );
      assert.equal(handle.degradations(), 1, 'the switch must be recorded as one degradation');

      // The switch put a NEW watcher in place; its first walk is what makes the
      // append below a `change` rather than part of the initial state.
      await handle.whenReady();
      const before = observed.length;
      const windowMs = POLL_INTERVAL_MIN_MS + POLL_WINDOW_SLACK_MS;
      appendFileSync(transcriptPath, '{"type":"assistant"}\n');
      const { elapsedMs } = await waitForPath(observed, transcriptPath, windowMs);

      assert.equal(
        elapsedMs !== null,
        true,
        `the degraded watcher must still notice an append within ${windowMs}ms: ${JSON.stringify(observed)}`
      );
      assert.ok(
        (elapsedMs as number) <= windowMs,
        `the degraded watcher took ${elapsedMs}ms, over the ${windowMs}ms window`
      );
      assert.deepEqual(
        observed.slice(before).map((event) => event.filePath),
        observed.slice(before).map(() => transcriptPath),
        'the only path reported after the degradation must be the one that was appended to'
      );

      // Nothing below polling: a second error is reported and polling continues.
      handle.emitError(new Error('ENOSPC again'));
      assert.equal(handle.mode(), 'poll', 'a polling watcher has no lower mechanism to fall back to');
      assert.equal(handle.degradations(), 1, 'and must not count as a second degradation');
    } finally {
      await handle.close();
    }
  });
});
