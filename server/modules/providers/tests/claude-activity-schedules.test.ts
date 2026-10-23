import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeScheduleTracker } from '@/modules/providers/index.js';
import type {
  ActivitySchedule,
  ClaudeScheduleTracker,
  SessionCronEntry,
} from '@/modules/providers/index.js';

/**
 * The Schedule Tracker's criterion (AC-192).
 *
 * Scheduled work has no event stream: the only readings are the
 * `CronCreate`/`ScheduleWakeup` tool calls and their result texts while a turn
 * runs, and the Stop hook's `session_crons` snapshot at the turn's end. The
 * fixtures below are those readings captured from a real run on 2026-10-01
 * (`docs/proposals/claude-session-activity-dock.md`), each builder naming the
 * shape's source so the fixture can be re-derived rather than trusted:
 *
 *   · `CronCreate` result text — §1.3/§9.1 ("Scheduled recurring job <id>
 *     (Every minute). Session-only … Auto-expires after 7 days. Use CronDelete
 *     to cancel sooner."). The job id is taken from §9.1 so the same id appears
 *     in the Stop hook list and the override is observable in place.
 *   · `ScheduleWakeup` result text — §1.3 ("Next wakeup scheduled for 20:47:00
 *     (in 110s). …"); §4.7 records the 60-second request landing as "in 115s"
 *     because the CLI rounds to the next whole minute.
 *   · `session_crons` — §9.1's two-entry list, verbatim: the every-2-minute
 *     recurring cron and the `58 20 * * *` `recurring:false` wakeup. The list
 *     after the wakeup fires is §9.1's own note ("唤醒触发后，下一次 Stop hook 的
 *     清单里只剩 cron").
 *   · `CronCreate`/`ScheduleWakeup` input shapes — the SDK's `CronCreateInput`
 *     (`{cron, prompt, recurring?}`) and `ScheduleWakeupInput`
 *     (`{delaySeconds, reason, prompt}`) in `sdk-tools.d.ts`.
 *
 * The base minute is a fixed local instant, injected through the factory's
 * clock: there is no `Date.now()` on the reduction path, so every `nextFireAt`
 * below is re-derivable from the expression plus this base.
 */

/** One raw frame, as the run loop hands it to the normalizer. */
type Frame = Record<string, unknown>;

const SESSION = 'claude-activity-schedules-1';

/** A fixed local base minute (2026-10-01 20:56:00) — the injected clock reading. */
const BASE = new Date(2026, 9, 1, 20, 56, 0, 0).getTime();

/** §9.1: the recurring cron's authoritative id, schedule and prompt. */
const CRON_ID = '5c79b8ae';
const CRON_SCHEDULE = '*/2 * * * *';
const CRON_PROMPT = 'cron-fired';

/** §9.1: the one-shot wakeup, represented as a `recurring:false` cron entry. */
const WAKEUP_ID = '7263511e';
const WAKEUP_SCHEDULE = '58 20 * * *';
const WAKEUP_PROMPT = 'wake-fired';

/** The `tool_use` ids for the in-turn calls; the wakeup's result names no id. */
const CRON_TOOL = 'toolu_192_cron';
const WAKE_TOOL = 'toolu_192_wakeup';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Prints a reading, so both the green main case and the red false form are visible. */
function say(message: string): void {
  process.stdout.write(`[schedule-tracker] ${message}\n`);
}

// ------------------------------------------------------------- frame builders --

/** A `CronCreate` `tool_use` (§9.1; input shape from `CronCreateInput`). */
function cronToolUse(toolUseId: string, cron: string, prompt: string, recurring = true): Frame {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'CronCreate', input: { cron, prompt, recurring } }],
    },
    parent_tool_use_id: null,
    uuid: `u-${toolUseId}`,
    session_id: SESSION,
  };
}

/** A `ScheduleWakeup` `tool_use` (input shape from `ScheduleWakeupInput`). */
function wakeToolUse(toolUseId: string, delaySeconds: number, prompt: string): Frame {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'ScheduleWakeup',
          input: { delaySeconds, reason: 'keep the loop alive', prompt },
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: `u-${toolUseId}`,
    session_id: SESSION,
  };
}

/** The `user` message carrying a `tool_result` paired to a `tool_use` id. */
function toolResult(toolUseId: string, text: string): Frame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] },
    parent_tool_use_id: null,
    uuid: `u-result-${toolUseId}`,
    session_id: SESSION,
  };
}

/** §1.3/§9.1: the `CronCreate` result text, naming the job id and a human schedule. */
function cronCreateResultText(id: string, humanSchedule: string): string {
  return (
    `Scheduled recurring job ${id} (${humanSchedule}). Session-only. ` +
    'Auto-expires after 7 days. Use CronDelete to cancel sooner.'
  );
}

/** §1.3/§4.7: the `ScheduleWakeup` result text, naming the clock time and a rounded delay. */
function wakeupResultText(clock: string, delaySeconds: number): string {
  return (
    `Next wakeup scheduled for ${clock} (in ${delaySeconds}s). ` +
    'Nothing more to do this turn — the harness re-invokes you when the wakeup fires.'
  );
}

/** One Stop hook `session_crons` entry (§9.1; shape from `SessionCronSummary`). */
function cronEntry(
  id: string,
  schedule: string,
  recurring: boolean,
  prompt: string,
): SessionCronEntry {
  return { id, schedule, recurring, prompt };
}

/** §9.1: the authoritative list while both the cron and the wakeup are pending. */
function stopHookList(): SessionCronEntry[] {
  return [
    cronEntry(CRON_ID, CRON_SCHEDULE, true, CRON_PROMPT),
    cronEntry(WAKEUP_ID, WAKEUP_SCHEDULE, false, WAKEUP_PROMPT),
  ];
}

/** §9.1: the next Stop hook after the wakeup fired — the cron alone remains. */
function stopHookListAfterWakeFired(): SessionCronEntry[] {
  return [cronEntry(CRON_ID, CRON_SCHEDULE, true, CRON_PROMPT)];
}

// ---------------------------------------------------------------- readings --

function scheduleById(tracker: ClaudeScheduleTracker, id: string): ActivitySchedule | undefined {
  return tracker.getSchedules(SESSION).find((schedule) => schedule.scheduleId === id);
}

/**
 * Feeds the in-turn tool-call sequence: a `CronCreate` followed by a
 * `ScheduleWakeup`, each with its result text. No Stop hook is seen, so every
 * row this produces is `source:'tool-call'`.
 */
function feedToolCallSequence(tracker: ClaudeScheduleTracker): void {
  tracker.observe(SESSION, cronToolUse(CRON_TOOL, CRON_SCHEDULE, CRON_PROMPT));
  tracker.observe(SESSION, toolResult(CRON_TOOL, cronCreateResultText(CRON_ID, 'Every 2 minutes')));
  tracker.observe(SESSION, wakeToolUse(WAKE_TOOL, 115, WAKEUP_PROMPT));
  tracker.observe(SESSION, toolResult(WAKE_TOOL, wakeupResultText('20:58:00', 115)));
}

/**
 * (1) The reading both the main case and its false form share: after the tool
 * calls, is there a wakeup row at all? A tracker that recognizes `CronCreate`
 * but ignores `ScheduleWakeup` answers `undefined` here.
 */
function readWakeupPresence(tracker: ClaudeScheduleTracker): ActivitySchedule | undefined {
  feedToolCallSequence(tracker);
  return tracker.getSchedules(SESSION).find((schedule) => schedule.kind === 'wakeup');
}

/**
 * (2) The reading both the main case and its false form share: reconcile the
 * two-entry list, then the list from after the wakeup fired, and report whether
 * the fired wakeup is still present. A tracker that only accumulates (never
 * deletes on the whole-override) leaves it present.
 */
function readFiredDisappearance(tracker: ClaudeScheduleTracker): { before: boolean; after: boolean } {
  tracker.reconcileStopHook(SESSION, stopHookList());
  const before = tracker.getSchedules(SESSION).some((schedule) => schedule.scheduleId === WAKEUP_ID);
  tracker.reconcileStopHook(SESSION, stopHookListAfterWakeFired());
  const after = tracker.getSchedules(SESSION).some((schedule) => schedule.scheduleId === WAKEUP_ID);
  return { before, after };
}

// ------------------------------------------------------------------- AC2 ------

test('AC2 both crons and wakeups enter the table from the authoritative Stop hook list', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  tracker.reconcileStopHook(SESSION, stopHookList());

  const rows = tracker.getSchedules(SESSION);
  assert.equal(rows.length, 2, 'both list entries are in the table');

  const cron = scheduleById(tracker, CRON_ID);
  const wakeup = scheduleById(tracker, WAKEUP_ID);
  assert.ok(cron, 'the recurring entry is present');
  assert.ok(wakeup, 'the one-shot entry is present');
  assert.equal(cron.kind, 'cron', 'recurring:true ⇒ kind cron');
  assert.equal(cron.recurring, true);
  assert.equal(cron.spec, CRON_SCHEDULE, 'spec is the list schedule, field for field');
  assert.equal(cron.prompt, CRON_PROMPT);
  assert.equal(cron.source, 'stop-hook');
  assert.equal(wakeup.kind, 'wakeup', 'recurring:false ⇒ kind wakeup');
  assert.equal(wakeup.recurring, false);
  assert.equal(wakeup.spec, WAKEUP_SCHEDULE, 'the wakeup carries its absolute minute expression');
  assert.equal(wakeup.prompt, WAKEUP_PROMPT);
});

// ------------------------------------------------------------------- AC3 ------

test('AC3 nextFireAt is evaluated from the 5-field expression at the injected base minute', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  tracker.reconcileStopHook(SESSION, [
    cronEntry('ac3-star', '* * * * *', true, 'p'),
    cronEntry('ac3-every2', '*/2 * * * *', true, 'p'),
    cronEntry('ac3-58-20', '58 20 * * *', true, 'p'),
  ]);

  const star = scheduleById(tracker, 'ac3-star');
  const every2 = scheduleById(tracker, 'ac3-every2');
  const fixed = scheduleById(tracker, 'ac3-58-20');
  assert.ok(star, 'the every-minute row exists');
  assert.ok(every2, 'the */2 row exists');
  assert.ok(fixed, 'the fixed-minute row exists');

  assert.equal(star.nextFireAt, BASE + 60_000, '"* * * * *" fires at the next minute (20:57)');
  assert.equal(every2.nextFireAt, BASE + 120_000, '"*/2 * * * *" fires at the next even minute (20:58)');
  assert.equal(fixed.nextFireAt, BASE + 120_000, '"58 20 * * *" fires at 20:58 local');

  for (const row of [star, every2, fixed]) {
    const fireAt = row.nextFireAt;
    assert.ok(fireAt !== undefined, 'a cron row carries a fire time');
    assert.equal(fireAt % 60_000, 0, 'minute granularity: seconds and milliseconds are zero');
  }
});

// ------------------------------------------------------------------- AC4 ------

test('AC4 a wakeup delay lands on a whole minute, never second precision', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  const wakeup = readWakeupPresence(tracker);
  assert.ok(wakeup, 'the ScheduleWakeup tool result builds a row');

  // "in 115s" from 20:56:00 is 20:57:55, which must round up to 20:58:00.
  assert.equal(wakeup.nextFireAt, BASE + 120_000, 'the wakeup rounds up to the next whole minute');
  assert.equal(wakeup.nextFireAt % 60_000, 0, 'minute granularity, not the raw in-115s instant');
  assert.notEqual(wakeup.nextFireAt, BASE + 115_000, 'the second-precision instant is not what is reported');
});

// ------------------------------------------------------------------- AC5 ------

test('AC5 tool results build provisional rows before any Stop hook', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  feedToolCallSequence(tracker);

  const rows = tracker.getSchedules(SESSION);
  assert.equal(rows.length, 2, 'both tool results put a row in the table with no Stop hook seen');
  assert.ok(
    rows.every((row) => row.source === 'tool-call'),
    'every provisional row is source tool-call',
  );

  const cron = scheduleById(tracker, CRON_ID);
  assert.ok(cron, 'the CronCreate result named the job id');
  assert.equal(cron.kind, 'cron');
  assert.equal(cron.spec, 'Every 2 minutes', 'the provisional spec is the CLI description');
  assert.equal(cron.prompt, CRON_PROMPT);

  const wakeup = rows.find((row) => row.kind === 'wakeup');
  assert.ok(wakeup, 'the ScheduleWakeup result built a wakeup row');
  assert.equal(wakeup.source, 'tool-call');
  assert.equal(wakeup.prompt, WAKEUP_PROMPT);
});

// ------------------------------------------------------------------- AC6 ------

test('AC6 the Stop hook overrides the provisional rows with the authoritative list', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  feedToolCallSequence(tracker);
  // The provisional wakeup is keyed by its tool-use id, since the result text
  // names no id; the Stop hook supersedes it under the CLI's own id.
  assert.ok(scheduleById(tracker, WAKE_TOOL), 'the provisional wakeup uses the tool_use id as its key');

  tracker.reconcileStopHook(SESSION, stopHookList());

  const rows = tracker.getSchedules(SESSION);
  assert.deepEqual(
    rows.map((row) => row.scheduleId).sort(),
    [CRON_ID, WAKEUP_ID].sort(),
    'the table is exactly the authoritative list',
  );
  assert.ok(
    rows.every((row) => row.source === 'stop-hook'),
    'every row is now source stop-hook',
  );
  const cron = scheduleById(tracker, CRON_ID);
  const wakeup = scheduleById(tracker, WAKEUP_ID);
  assert.ok(cron, 'the cron survived the override under its own id');
  assert.ok(wakeup, 'the wakeup entered under the CLI id');
  assert.equal(cron.spec, CRON_SCHEDULE, 'spec becomes the absolute minute expression');
  assert.equal(wakeup.spec, WAKEUP_SCHEDULE);
  assert.equal(wakeup.kind, 'wakeup');
  assert.equal(scheduleById(tracker, WAKE_TOOL), undefined, 'the tool-use-keyed provisional row is gone');
});

// ------------------------------------------------------------------- AC7 ------

test('AC7 a fired wakeup is absent from the next Stop hook list and leaves the table', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  const reading = readFiredDisappearance(tracker);

  assert.equal(reading.before, true, 'the wakeup is present while the list names it');
  assert.equal(reading.after, false, 'the whole-override deletes it once the list stops naming it');
  assert.deepEqual(
    tracker.getSchedules(SESSION).map((schedule) => schedule.scheduleId),
    [CRON_ID],
    'only the still-scheduled cron remains',
  );
});

// ------------------------------------------------------------------- AC8 ------

test('AC8 crons and wakeups carry a 7-day expiry from creation', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  tracker.reconcileStopHook(SESSION, stopHookList());

  const cron = scheduleById(tracker, CRON_ID);
  const wakeup = scheduleById(tracker, WAKEUP_ID);
  assert.ok(cron, 'the cron row exists');
  assert.ok(wakeup, 'the wakeup row exists');
  assert.ok(cron.expiresAt !== undefined, 'the cron carries an expiry');
  assert.equal(cron.expiresAt - BASE, SEVEN_DAYS_MS, 'seven days from creation — the host driver CRON_MAX_AGE_MS');
  assert.equal(wakeup.expiresAt, BASE + SEVEN_DAYS_MS, 'a one-shot wakeup also carries an expiry');
});

// ------------------------------------------------------------------- AC9 ------

test('AC9 two schedules in the same minute stay two independent rows', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });
  tracker.reconcileStopHook(SESSION, [
    cronEntry('ac9-a', '58 20 * * *', true, 'a'),
    cronEntry('ac9-b', '58 20 * * *', true, 'b'),
  ]);

  const rows = tracker.getSchedules(SESSION);
  assert.equal(rows.length, 2, 'the same fire minute does not merge the rows');
  assert.equal(new Set(rows.map((row) => row.scheduleId)).size, 2, 'the ids stay distinct');
  assert.deepEqual(
    rows.map((row) => row.nextFireAt),
    [BASE + 120_000, BASE + 120_000],
    'both fire at the same minute',
  );
});

// -------------------------------------------------------------- AC10 (arms) --

test('AC10 false form (1): a tracker that ignores ScheduleWakeup reds the wakeup reading', () => {
  const miswired = createClaudeScheduleTracker({ now: () => BASE, ignoreWakeupTools: true });
  const wakeup = readWakeupPresence(miswired);
  say(`(1) false form reading: wakeupRow=${String(wakeup)} (main case expects a wakeup row)`);

  // The main case's own assertion, applied to the variant, must throw — otherwise
  // "a wakeup row exists" was never discriminating.
  assert.throws(
    () => {
      assert.ok(wakeup, 'a wakeup row exists after the ScheduleWakeup result');
    },
    'a CronCreate-only tracker must red the wakeup reading',
  );
  assert.equal(wakeup, undefined);
});

test('AC10 false form (2): a tracker not calibrated by the Stop hook reds the disappearance reading', () => {
  const miswired = createClaudeScheduleTracker({ now: () => BASE, appendOnlyStopHook: true });
  const reading = readFiredDisappearance(miswired);
  say(
    `(2) false form reading: before=${String(reading.before)} after=${String(reading.after)} ` +
      '(main case expects before=true after=false)',
  );

  assert.throws(
    () => {
      assert.equal(reading.after, false);
    },
    'an append-only tracker must red the disappearance reading',
  );
  assert.equal(reading.before, true);
  assert.equal(reading.after, true);
});

// -------------------------------------------------------- the whole sequence -

test('the captured sequence builds, calibrates, and drops the fired wakeup', () => {
  const tracker = createClaudeScheduleTracker({ now: () => BASE });

  // In-turn: two provisional rows.
  feedToolCallSequence(tracker);
  assert.deepEqual(
    tracker.getSchedules(SESSION).map((schedule) => schedule.source),
    ['tool-call', 'tool-call'],
  );

  // Turn end: the authoritative list overrides them.
  tracker.reconcileStopHook(SESSION, stopHookList());
  assert.deepEqual(
    tracker.getSchedules(SESSION).map((schedule) => [schedule.scheduleId, schedule.source]),
    [
      [CRON_ID, 'stop-hook'],
      [WAKEUP_ID, 'stop-hook'],
    ],
  );

  // The wakeup fires: the next list drops it, and so does the table.
  tracker.reconcileStopHook(SESSION, stopHookListAfterWakeFired());
  assert.deepEqual(
    tracker.getSchedules(SESSION).map((schedule) => schedule.scheduleId),
    [CRON_ID],
  );

  // A session never observed is empty, not whatever the last one held.
  assert.deepEqual(tracker.getSchedules('claude-activity-schedules-2'), []);
});
