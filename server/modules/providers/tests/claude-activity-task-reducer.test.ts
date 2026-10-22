import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeTaskReducer, earnsTaskTerminalRow, mapUpdatedStatus } from '@/modules/providers/index.js';
import type {
  ActivityTask,
  BackgroundTaskSummary,
  ClaudeTaskReducer,
  TaskState,
} from '@/modules/providers/index.js';

/**
 * The Task Reducer's criterion (AC-191).
 *
 * The fixtures are the frame sequence captured from real SDK runs on
 * 2026-10-01, replayed frame by frame. Each builder below names the shape's
 * source so the fixture can be re-derived rather than trusted:
 *
 *   · `system/task_started` / `task_updated` / `task_progress` /
 *     `task_notification` — the event timeline in
 *     `docs/proposals/claude-background-work-observability.md` §1.1 (the run's
 *     time/field table), with the nesting rule from §1.2 (a subagent's own Bash
 *     is a task whose `tool_use_id` is the inner tool and whose
 *     `parent_tool_use_id` is the outer Agent call).
 *   · Workflow — the same proposal §1.3 (`task_started{task_type:'local_workflow',
 *     workflow_name:'simple-workflow-ok'}`; `task_progress.description` is the
 *     step label).
 *   · Stop hook `background_tasks` — `docs/proposals/claude-session-activity-dock.md`
 *     §9.1 (`[{id, type, status, description, command}]`) and the SDK's
 *     `BackgroundTaskSummary` (`type` uses the friendly labels
 *     `shell`/`subagent`/`monitor`/`workflow`).
 *   · Foreground Bash backgrounded — §9.3 of the dock proposal (`backgroundTasks()`
 *     yields a `task_started{task_type:'local_bash'}` together with a
 *     `task_updated{patch:{is_backgrounded:true}}`).
 *
 * Where the record left a shape unpinned, the builder says so: the Monitor's own
 * `task_type` was never captured (the one Monitor task arrived as `local_bash`,
 * §1.1), so its `monitor` kind is only reachable through the Stop hook's
 * `type:'monitor'` label and is exercised in AC7 rather than on the frame path.
 */

/** One raw frame, as the run loop hands it to the normalizer. */
type Frame = Record<string, unknown>;

/**
 * The terminal-transition shape the reducer reports, read off the facade's own
 * return type so the criterion types its collector without a second export merely
 * to name it. A transition the facade can never produce cannot be asserted here.
 */
type Transition = ReturnType<ClaudeTaskReducer['observe']>[number];

const SESSION = 'claude-activity-task-reducer-1';

const SUBAGENT_ID = 'a69e-subagent';
const SUBAGENT_TOOL = 'toolu_01Vd-agent';
const INNER_BASH_ID = 'bm82-inner-bash';
const INNER_BASH_TOOL = 'toolu_inner_bash';
const BG_BASH_ID = 'b0i4-bg-bash';
const MONITOR_ID = 'bjzt-monitor';
const WORKFLOW_ID = 'workflow-1';
const FRONT_BASH_ID = 'front-bash-task-1';
const FRONT_BASH_TOOL = 'toolu_front_bash';

/** A frame-supplied end time, so `endedAt` can be read off the frame, not a clock. */
const COMPLETED_END_TIME = 1_759_277_000_000;

/** Prints a reading, so both the green main case and the red false form are visible. */
function say(message: string): void {
  process.stdout.write(`[task-reducer] ${message}\n`);
}

// ------------------------------------------------------------- frame builders --

/** §1.1 (12.1): a background agent. `parent_tool_use_id` is null on the top task. */
function subagentStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: SUBAGENT_ID,
    tool_use_id: SUBAGENT_TOOL,
    parent_tool_use_id: null,
    task_type: 'local_agent',
    subagent_type: 'general-purpose',
    description: 'Run the background agent',
    uuid: 'u-start-subagent',
    session_id: SESSION,
  };
}

/** §1.2 (50.8): the subagent's own Bash — nested, its parent is the Agent call. */
function innerBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: INNER_BASH_ID,
    tool_use_id: INNER_BASH_TOOL,
    parent_tool_use_id: SUBAGENT_TOOL,
    task_type: 'local_bash',
    description: 'sleep 12',
    uuid: 'u-start-inner-bash',
    session_id: SESSION,
  };
}

/** §1.1 (59.8): the nested Bash completes. */
function innerBashCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: INNER_BASH_ID,
    status: 'completed',
    summary: 'inner bash done',
    uuid: 'u-notification-inner-bash',
    session_id: SESSION,
  };
}

/** §1.5/§9.5: a subagent's `task_progress` describes its last action, not a step. */
function subagentProgress(description: string): Frame {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: SUBAGENT_ID,
    description,
    uuid: 'u-progress-subagent',
    session_id: SESSION,
  };
}

/** §1.1 (62.5): the subagent completes (a `task_updated` plus a `task_notification`). */
function subagentCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: SUBAGENT_ID,
    patch: { status: 'completed' },
    uuid: 'u-updated-subagent',
    session_id: SESSION,
  };
}

/** §1.1 (12.8): a background Bash. */
function backgroundBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: BG_BASH_ID,
    tool_use_id: 'toolu_bg_bash',
    task_type: 'local_bash',
    description: 'loop 3x sleep 4',
    uuid: 'u-start-bg-bash',
    session_id: SESSION,
  };
}

/** §1.1 (25.4)/(e): the background Bash ends with only a `task_updated` — no notification. */
function backgroundBashCompleted(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: BG_BASH_ID,
    patch: { status: 'completed', end_time: COMPLETED_END_TIME },
    uuid: 'u-updated-bg-bash',
    session_id: SESSION,
  };
}

/**
 * §1.1 (26.6): a Monitor is itself a task, and the capture shows its `task_type`
 * as `local_bash` — so on the frame path it reduces to `kind:'shell'`. The
 * `monitor` kind is only reachable through the Stop hook's `type:'monitor'`
 * label, which AC7 exercises.
 */
function monitorStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: MONITOR_ID,
    task_type: 'local_bash',
    description: 'Monitor task',
    uuid: 'u-start-monitor',
    session_id: SESSION,
  };
}

/** §1.1 (86.7) / §9.3: the Monitor is killed when its 60s timeout fires. */
function monitorKilled(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: MONITOR_ID,
    patch: { status: 'killed' },
    uuid: 'u-updated-monitor',
    session_id: SESSION,
  };
}

/** The `task_notification{status:'stopped'}` that accompanies the kill. */
function monitorStoppedNotification(): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: MONITOR_ID,
    status: 'stopped',
    summary: 'Monitor timed out',
    uuid: 'u-notification-monitor',
    session_id: SESSION,
  };
}

/** §1.3: a workflow run. */
function workflowStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: WORKFLOW_ID,
    tool_use_id: 'toolu_workflow',
    task_type: 'local_workflow',
    workflow_name: 'simple-workflow-ok',
    description: 'Run the workflow',
    uuid: 'u-start-workflow',
    session_id: SESSION,
  };
}

/** §1.3: `task_progress.description` is the workflow's current step label. */
function workflowProgress(description: string): Frame {
  return {
    type: 'system',
    subtype: 'task_progress',
    task_id: WORKFLOW_ID,
    description,
    uuid: `u-progress-${description}`,
    session_id: SESSION,
  };
}

/** §9.3: the plain foreground `tool_use` — deliberately **not** a task. */
function frontBashToolUse(): Frame {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: FRONT_BASH_TOOL, name: 'Bash', input: {} }],
    },
    parent_tool_use_id: null,
    uuid: 'u-tool-front-bash',
    session_id: SESSION,
  };
}

/** §9.3: the `task_started` the CLI emits when the foreground Bash is backgrounded. */
function frontBashStarted(): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: FRONT_BASH_ID,
    tool_use_id: FRONT_BASH_TOOL,
    task_type: 'local_bash',
    description: 'python3 -c "import time; time.sleep(20)"',
    uuid: 'u-start-front-bash',
    session_id: SESSION,
  };
}

/** §9.3: the `task_updated` that flips `is_backgrounded` on the same instant. */
function frontBashBackgrounded(): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: FRONT_BASH_ID,
    patch: { is_backgrounded: true },
    uuid: 'u-updated-front-bash',
    session_id: SESSION,
  };
}

// ------------------------------------------- terminal-transition frame builders --

/** A generic `task_started` for the AC1/AC2/AC6 arms, keyed by an explicit task id. */
function startedTask(taskId: string, taskType = 'local_bash', description = taskId): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    task_type: taskType,
    description,
    uuid: `u-start-${taskId}`,
    session_id: SESSION,
  };
}

/** A generic `task_updated` status patch. */
function updatedTask(taskId: string, status: string): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status },
    uuid: `u-updated-${taskId}`,
    session_id: SESSION,
  };
}

/** A generic terminal `task_notification`. */
function notifiedTask(taskId: string, status: string, summary: string): Frame {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    summary,
    uuid: `u-notification-${taskId}`,
    session_id: SESSION,
  };
}

/**
 * The `assistant` frame carrying a task's launching `tool_use`.
 *
 * Built to the shape measured on a real SDK run (0.3.165, 2026-10-04): a
 * foreground Bash's call had `input:{command}` with no `run_in_background`, a
 * background Bash's had `run_in_background:true`, and an `Agent`'s backgrounded
 * unless it opted out. It is fed *before* the `task_started` naming the task, in
 * the order the stream really delivers them.
 */
function toolUseLaunch(toolUseId: string, name: string, input: Record<string, unknown>): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name, input }] },
    uuid: `u-tool-${toolUseId}`,
    session_id: SESSION,
  };
}

/** A `task_started` naming the `tool_use` that launched it. */
function startedTaskFor(taskId: string, toolUseId: string, taskType = 'local_bash', description = taskId): Frame {
  return {
    ...startedTask(taskId, taskType, description),
    tool_use_id: toolUseId,
  };
}

/** The whole captured run, in arrival order, for the replay reading (AC8). */
function capturedFrameSequence(): Frame[] {
  return [
    subagentStarted(),
    backgroundBashStarted(),
    backgroundBashCompleted(),
    monitorStarted(),
    subagentProgress('Running sleep 12'),
    innerBashStarted(),
    innerBashCompleted(),
    subagentCompleted(),
    workflowStarted(),
    workflowProgress('Say OK: say-ok'),
    workflowProgress('Say OK: done'),
    frontBashToolUse(),
    frontBashStarted(),
    frontBashBackgrounded(),
    monitorKilled(),
    monitorStoppedNotification(),
  ];
}

// ------------------------------------------------------------ reading helpers --

/** The state of one task in one session's table, or `null` when it is absent. */
function taskState(reducer: ClaudeTaskReducer, sessionId: string, taskId: string): TaskState | null {
  const task = reducer.getTasks(sessionId).find((candidate) => candidate.taskId === taskId);
  return task ? task.state : null;
}

function taskOf(reducer: ClaudeTaskReducer, taskId: string): ActivityTask | undefined {
  return reducer.getTasks(SESSION).find((candidate) => candidate.taskId === taskId);
}

/**
 * (b) The reading both the main case and its false form share: feed the Monitor
 * start, the kill and the notification, and record the state right after the
 * kill and right after the notification.
 *
 * The kill pair is same-instant in the record, and the correct reducer reduces
 * both frames to `stopped`; a reducer that mapped `killed → failed` would still
 * be visible in `afterKill`, which is why both readings are returned.
 */
type MonitorTimeoutReading = { afterKill: TaskState | null; afterNotification: TaskState | null };

function readMonitorTimeout(reducer: ClaudeTaskReducer): MonitorTimeoutReading {
  reducer.observe(SESSION, monitorStarted());
  reducer.observe(SESSION, monitorKilled());
  const afterKill = taskState(reducer, SESSION, MONITOR_ID);
  reducer.observe(SESSION, monitorStoppedNotification());
  const afterNotification = taskState(reducer, SESSION, MONITOR_ID);
  return { afterKill, afterNotification };
}

/**
 * (d) The reading both the main case and its false form share: feed the plain
 * foreground `tool_use` (asking how many tasks the table holds for that tool),
 * then the backgrounding pair (asking how many, and whether the flag is set).
 */
type FrontBashReading = {
  beforeBackground: number;
  afterBackground: number;
  isBackgrounded: boolean | null;
};

function readFrontBashBackgrounding(reducer: ClaudeTaskReducer): FrontBashReading {
  reducer.observe(SESSION, frontBashToolUse());
  const beforeBackground = reducer
    .getTasks(SESSION)
    .filter((task) => task.toolUseId === FRONT_BASH_TOOL).length;

  reducer.observe(SESSION, frontBashStarted());
  reducer.observe(SESSION, frontBashBackgrounded());
  const after = reducer.getTasks(SESSION).filter((task) => task.toolUseId === FRONT_BASH_TOOL);
  return {
    beforeBackground,
    afterBackground: after.length,
    isBackgrounded: after[0] ? after[0].isBackgrounded : null,
  };
}

// ------------------------------------------------------------------- AC2 (a) --

test('AC2 a nested task recovers its parent from parent_tool_use_id', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, subagentStarted());
  reducer.observe(SESSION, innerBashStarted());

  const parent = taskOf(reducer, SUBAGENT_ID);
  const child = taskOf(reducer, INNER_BASH_ID);
  assert.ok(parent, 'the subagent task exists');
  assert.ok(child, 'the nested Bash task exists');
  assert.equal(parent.toolUseId, SUBAGENT_TOOL);
  assert.equal(child.parentTaskId, parent.taskId, 'the child points at the task owning its parent tool_use');
  assert.equal(child.parentTaskId, SUBAGENT_ID);
});

// --------------------------------------------------------------- AC3 (b) -----

test('AC3 a killed Monitor is stopped, not failed', () => {
  const reading = readMonitorTimeout(createClaudeTaskReducer());
  say(`(b) reading: afterKill=${String(reading.afterKill)} afterNotification=${String(reading.afterNotification)}`);

  assert.equal(reading.afterKill, 'stopped', 'task_updated{killed} is a stop, not an error');
  assert.notEqual(reading.afterKill, 'failed');
  assert.equal(reading.afterNotification, 'stopped', 'the paired notification agrees');
});

test('a stopped task carries no timestamp the frames never supplied', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, monitorStarted());
  reducer.observe(SESSION, monitorKilled());
  reducer.observe(SESSION, monitorStoppedNotification());

  const monitor = taskOf(reducer, MONITOR_ID);
  assert.ok(monitor);
  assert.equal('startedAt' in monitor, false, 'no frame carried a start time, so none may be invented');
  assert.equal('endedAt' in monitor, false, 'no frame carried an end time, so none may be invented');
});

// --------------------------------------------------------------- AC4 (c) -----

test('AC4 a workflow task carries its name and its latest step label', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, workflowStarted());
  reducer.observe(SESSION, workflowProgress('Say OK: say-ok'));
  reducer.observe(SESSION, workflowProgress('Say OK: done'));

  const workflow = taskOf(reducer, WORKFLOW_ID);
  assert.ok(workflow);
  assert.equal(workflow.kind, 'workflow');
  assert.equal(workflow.workflowName, 'simple-workflow-ok');
  assert.equal(workflow.stepLabel, 'Say OK: done', 'the most recent progress wins');
});

// --------------------------------------------------------------- AC5 (d) -----

test('AC5 a foreground tool is not a task until it is backgrounded', () => {
  const reading = readFrontBashBackgrounding(createClaudeTaskReducer());
  say(
    `(d) reading: beforeBackground=${reading.beforeBackground} afterBackground=${reading.afterBackground} ` +
      `isBackgrounded=${String(reading.isBackgrounded)}`,
  );

  assert.equal(reading.beforeBackground, 0, 'an assistant tool_use is never a task on its own');
  assert.equal(reading.afterBackground, 1, 'backgrounding creates the task');
  assert.equal(reading.isBackgrounded, true, 'the backgrounding flag is carried');
});

// --------------------------------------------------------------- AC6 (e) -----

test('AC6 a background Bash that only updates to completed still terminates', () => {
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, backgroundBashStarted());
  reducer.observe(SESSION, backgroundBashCompleted());

  const task = taskOf(reducer, BG_BASH_ID);
  assert.ok(task);
  assert.equal(task.state, 'completed', 'task_updated alone is a terminal state');
  assert.equal(task.endedAt, COMPLETED_END_TIME, 'the end time comes from the frame, not a clock');
});

// --------------------------------------------------------------- AC7 (f) -----

test('AC7 the Stop hook snapshot ends vanished tasks and backfills unseen ones', () => {
  const reducer = createClaudeTaskReducer();
  // A subagent that started and is still running when the turn ends.
  reducer.observe(SESSION, subagentStarted());
  assert.equal(taskState(reducer, SESSION, SUBAGENT_ID), 'running');

  const snapshotTaskId = 'stop-hook-monitor-1';
  const snapshot: BackgroundTaskSummary[] = [
    {
      id: snapshotTaskId,
      type: 'monitor',
      status: 'running',
      description: 'Monitor polling',
      tool: 'Bash',
    },
  ];
  reducer.reconcileStopHook(SESSION, snapshot);

  const vanished = taskOf(reducer, SUBAGENT_ID);
  assert.ok(vanished);
  assert.equal(vanished.state, 'ended', 'a running task the snapshot no longer names is over');
  assert.equal(vanished.endReason, 'unknown', 'and the cause is the unknown one');

  const backfilled = taskOf(reducer, snapshotTaskId);
  assert.ok(backfilled, 'a snapshot task the events never saw is backfilled');
  assert.equal(backfilled.origin, 'stop-hook-snapshot');
  assert.equal(backfilled.kind, 'monitor');
  assert.equal(backfilled.state, 'running');

  // The same snapshot again is a no-op: the reduction overwrites keys, never appends.
  const afterFirstReconcile = reducer.getTasks(SESSION);
  reducer.reconcileStopHook(SESSION, snapshot);
  assert.deepEqual(reducer.getTasks(SESSION), afterFirstReconcile);
});

// --------------------------------------------------------------- AC8 (g) -----

test('AC8 replaying the captured sequence reduces to the same table', () => {
  const sequence = capturedFrameSequence();

  const replayed = createClaudeTaskReducer();
  for (const frame of sequence) {
    replayed.observe(SESSION, frame);
  }
  const first = replayed.getTasks(SESSION);
  for (const frame of sequence) {
    replayed.observe(SESSION, frame);
  }
  assert.deepEqual(replayed.getTasks(SESSION), first, 'same-instance replay is idempotent');

  const instanceA = createClaudeTaskReducer();
  const instanceB = createClaudeTaskReducer();
  for (const frame of sequence) {
    instanceA.observe(SESSION, frame);
  }
  for (const frame of sequence) {
    instanceB.observe(SESSION, frame);
  }
  assert.deepEqual(instanceA.getTasks(SESSION), instanceB.getTasks(SESSION), 'two fresh instances agree');
  assert.deepEqual(instanceA.getTasks(SESSION), first);
});

// --------------------------------------------------------------- AC9 (h) -----

test('AC9 two sessions fed interleaved frames never read each other', () => {
  const sessionA = 'claude-activity-task-a';
  const sessionB = 'claude-activity-task-b';
  const reducer = createClaudeTaskReducer();

  reducer.observe(sessionA, subagentStarted());
  reducer.observe(sessionB, backgroundBashStarted());
  reducer.observe(sessionA, innerBashStarted());

  const aIds = reducer.getTasks(sessionA).map((task) => task.taskId);
  const bIds = reducer.getTasks(sessionB).map((task) => task.taskId);
  assert.deepEqual(aIds, [SUBAGENT_ID, INNER_BASH_ID]);
  assert.deepEqual(bIds, [BG_BASH_ID]);
  assert.ok(!aIds.includes(BG_BASH_ID), 'session A must not see B');
  assert.ok(!bIds.includes(SUBAGENT_ID), 'session B must not see A');
  assert.ok(!bIds.includes(INNER_BASH_ID), 'session B must not see A’s nested task');
  assert.deepEqual(reducer.getTasks('claude-activity-task-c'), [], 'an unobserved session is empty');
});

// -------------------------------------------------------------- AC10 (arms) --

test('AC10 false form (b): a reducer that calls killed “failed” reds the (b) reading', () => {
  const miswired = createClaudeTaskReducer({
    mapUpdatedStatus: (status) => (status === 'killed' ? 'failed' : mapUpdatedStatus(status)),
  });
  const reading = readMonitorTimeout(miswired);
  say(
    `(b) false form reading: afterKill=${String(reading.afterKill)} ` +
      `afterNotification=${String(reading.afterNotification)} (main case expects stopped)`,
  );

  // The main case's own assertion, applied to the variant, must throw — otherwise
  // `state === 'stopped'` was never discriminating.
  assert.throws(
    () => {
      assert.equal(reading.afterKill, 'stopped');
    },
    'a killed-as-failed reducer must red the (b) reading',
  );
  assert.equal(reading.afterKill, 'failed');
});

test('AC10 false form (d): a reducer that builds on tool_use reds the (d) reading', () => {
  const miswired = createClaudeTaskReducer({ taskOnToolUse: true });
  const reading = readFrontBashBackgrounding(miswired);
  say(
    `(d) false form reading: beforeBackground=${reading.beforeBackground} ` +
      `(main case expects 0) afterBackground=${reading.afterBackground} ` +
      `isBackgrounded=${String(reading.isBackgrounded)}`,
  );

  assert.throws(
    () => {
      assert.equal(reading.beforeBackground, 0);
    },
    'a tool_use-builds-a-task reducer must red the (d) reading',
  );
  assert.equal(reading.beforeBackground, 1);
});

// -------------------------------------------------------- the whole sequence -

test('the captured sequence reduces to one table with the expected terminal states', () => {
  const reducer = createClaudeTaskReducer();
  for (const frame of capturedFrameSequence()) {
    reducer.observe(SESSION, frame);
  }

  const byId = new Map(reducer.getTasks(SESSION).map((task) => [task.taskId, task]));
  assert.deepEqual(
    [...byId.keys()],
    [SUBAGENT_ID, BG_BASH_ID, MONITOR_ID, INNER_BASH_ID, WORKFLOW_ID, FRONT_BASH_ID],
    'one row per task the SDK named, in first-seen order',
  );
  assert.equal(byId.get(SUBAGENT_ID)?.state, 'completed');
  assert.equal(byId.get(BG_BASH_ID)?.state, 'completed');
  assert.equal(byId.get(MONITOR_ID)?.state, 'stopped');
  assert.equal(byId.get(INNER_BASH_ID)?.state, 'completed');
  assert.equal(byId.get(INNER_BASH_ID)?.parentTaskId, SUBAGENT_ID);
  assert.equal(byId.get(WORKFLOW_ID)?.state, 'running');
  assert.equal(byId.get(WORKFLOW_ID)?.stepLabel, 'Say OK: done');
  assert.equal(byId.get(FRONT_BASH_ID)?.state, 'running');
  assert.equal(byId.get(FRONT_BASH_ID)?.isBackgrounded, true);
});

// --------------------------------- terminal transitions (gap-task-terminal-…) --
//
// The user-facing requirement this pins: when a background task crosses into a
// terminal state, the reduction reports the crossing exactly once, from any of the
// four sources the SDK and the Stop hook can end a task through — so the
// `forwardNormalizedFrames` seam can turn it into one durable transcript line
// without a de-duplication clock of its own.

test('AC1 a terminal transition is reported exactly once across a replayed sequence', () => {
  const reported: Transition[] = [];
  const reducer = createClaudeTaskReducer({ onTaskTerminal: (transition) => reported.push(transition) });

  // A start, then the two terminal frames a task can carry (the `task_updated`
  // patch and the `task_notification` that sometimes accompanies it) — then the
  // whole sequence again, which is what a snapshot/reconnect replay does.
  const sequence = [
    backgroundBashStarted(),
    backgroundBashCompleted(),
    notifiedTask(BG_BASH_ID, 'completed', 'background bash done'),
  ];
  for (const frame of sequence) {
    reducer.observe(SESSION, frame);
  }
  for (const frame of sequence) {
    reducer.observe(SESSION, frame);
  }

  say(`AC1 onTaskTerminal fired ${reported.length} time(s) across a replayed sequence (expect 1)`);
  assert.equal(reported.length, 1, 'the crossing is reported once, not once per terminal frame or replay');
  assert.equal(reported[0].taskId, BG_BASH_ID);
  assert.equal(reported[0].from, 'running', 'the transition names the non-terminal state it left');
  assert.equal(reported[0].to, 'completed');
  assert.equal(reported[0].kind, 'shell');
});

test('AC2 every terminal source yields exactly one transition with its own terminal state', () => {
  // Each source drives a task of its own, so "exactly one transition" is a
  // statement about that source and not about a task another source also ended.
  const cases: Array<{ label: string; taskId: string; to: TaskState; started: Frame; terminal: Frame }> = [
    {
      label: 'task_notification(completed)',
      taskId: 'ac2-note-completed',
      to: 'completed',
      started: startedTask('ac2-note-completed'),
      terminal: notifiedTask('ac2-note-completed', 'completed', 'done'),
    },
    {
      label: 'task_notification(failed)',
      taskId: 'ac2-note-failed',
      to: 'failed',
      started: startedTask('ac2-note-failed'),
      terminal: notifiedTask('ac2-note-failed', 'failed', 'boom'),
    },
    {
      label: 'task_notification(stopped)',
      taskId: 'ac2-note-stopped',
      to: 'stopped',
      started: startedTask('ac2-note-stopped'),
      terminal: notifiedTask('ac2-note-stopped', 'stopped', 'stopped'),
    },
    {
      label: 'task_updated{completed} (no notification)',
      taskId: 'ac2-upd-completed',
      to: 'completed',
      started: startedTask('ac2-upd-completed'),
      terminal: updatedTask('ac2-upd-completed', 'completed'),
    },
    {
      label: 'task_updated{killed}',
      taskId: 'ac2-upd-killed',
      to: 'stopped',
      started: startedTask('ac2-upd-killed'),
      terminal: updatedTask('ac2-upd-killed', 'killed'),
    },
  ];

  for (const arm of cases) {
    const reducer = createClaudeTaskReducer();
    reducer.observe(SESSION, arm.started);
    const transitions = reducer.observe(SESSION, arm.terminal);
    say(`AC2 ${arm.label}: ${transitions.length} transition(s) -> ${String(transitions[0]?.to)}`);
    assert.equal(transitions.length, 1, `${arm.label} must report exactly one transition`);
    assert.equal(transitions[0].taskId, arm.taskId);
    assert.equal(transitions[0].from, 'running');
    assert.equal(transitions[0].to, arm.to);
  }

  // The fourth source is the Stop hook: a still-running task the snapshot no
  // longer names is over for a cause the stream never stated.
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, startedTask('ac2-stop-ended'));
  const transitions = reducer.reconcileStopHook(SESSION, []);
  say(`AC2 Stop hook snapshot: ${transitions.length} transition(s) -> ${String(transitions[0]?.to)}`);
  assert.equal(transitions.length, 1, 'the Stop hook snapshot reports exactly one transition');
  assert.equal(transitions[0].taskId, 'ac2-stop-ended');
  assert.equal(transitions[0].from, 'running');
  assert.equal(transitions[0].to, 'ended');

  // A task the snapshot backfills straight into a terminal state never crossed
  // anything, so it is not a transition — the snapshot is not the task ending.
  const backfill = createClaudeTaskReducer();
  const backfilled = backfill.reconcileStopHook(SESSION, [
    { id: 'ac2-backfilled', type: 'shell', status: 'completed', description: 'already over' },
  ]);
  say(`AC2 backfilled-terminal: ${backfilled.length} transition(s) (expect 0)`);
  assert.equal(backfilled.length, 0, 'a task born terminal has no crossing to report');
});

test('AC6 false form (g): reporting on every terminal frame reds the exactly-once reading', () => {
  const countFor = (mutations: Parameters<typeof createClaudeTaskReducer>[0] = {}): number => {
    const reported: Transition[] = [];
    const reducer = createClaudeTaskReducer({
      ...mutations,
      onTaskTerminal: (transition) => reported.push(transition),
    });
    const sequence = [
      backgroundBashStarted(),
      backgroundBashCompleted(),
      notifiedTask(BG_BASH_ID, 'completed', 'background bash done'),
    ];
    for (const frame of sequence) {
      reducer.observe(SESSION, frame);
    }
    for (const frame of sequence) {
      reducer.observe(SESSION, frame);
    }
    return reported.length;
  };

  const green = countFor();
  say(`AC6 main reading: onTaskTerminal fired ${green} time(s) (expect 1)`);
  assert.equal(green, 1);

  const mutated = countFor({ terminalOnEveryFrame: true });
  say(`AC6 false form reading: onTaskTerminal fired ${mutated} time(s) (expect > 1)`);
  assert.throws(
    () => {
      assert.equal(mutated, 1);
    },
    'reporting on every terminal frame must red the exactly-once reading',
  );
  assert.ok(mutated > 1, 'the mutation really re-reports, it does not merely stay the same');
});

// ------------------------------- the terminal-row criterion (gap-shell-…) -----
//
// The transition alone is not yet a transcript row: the forwarder asks
// `earnsTaskTerminalRow` whether this crossing is one the transcript needs. The
// three classes below are the whole discrimination the criterion has to make —
// a foreground command (already on its tool card: no row), a real background
// task (nothing else says it ended: one row), and a task the CLI notifies about
// itself (its own row exists: no second one).

/** One class of command, driven from its launch frame to its terminal frame. */
type CriterionArm = {
  label: string;
  /** The expected verdict: does this crossing earn a server-emitted row? */
  earns: boolean;
  frames: Frame[];
};

/**
 * Drives one arm and reports both readings: whether the crossing earns a row,
 * and how many times the transition fired across a replayed sequence (which must
 * stay exactly one — a re-report would emit the row twice).
 */
function readCriterionArm(arm: CriterionArm): { earns: boolean; fired: number } {
  const reported: Transition[] = [];
  const reducer = createClaudeTaskReducer({ onTaskTerminal: (transition) => reported.push(transition) });
  for (const frame of arm.frames) {
    reducer.observe(SESSION, frame);
  }
  for (const frame of arm.frames) {
    reducer.observe(SESSION, frame);
  }
  const first = reported[0];
  assert.ok(first, `${arm.label}: the arm must produce a terminal transition at all`);
  return { earns: earnsTaskTerminalRow(first), fired: reported.length };
}

test('AC2 the criterion tells foreground, background and CLI-notified tasks apart', () => {
  const arms: CriterionArm[] = [
    {
      // A foreground Bash: no `run_in_background` on its call, and the SDK ends it
      // with an announced notification whose summary is the description/command.
      label: 'foreground Bash (task_notification)',
      earns: false,
      frames: [
        toolUseLaunch('toolu_crit_fg', 'Bash', { command: 'echo fg-short-ok' }),
        startedTaskFor('crit-fg', 'toolu_crit_fg', 'local_bash', 'echo fg-short-ok'),
        notifiedTask('crit-fg', 'completed', 'echo fg-short-ok'),
      ],
    },
    {
      // A real background Bash: `run_in_background:true` on its call, ended by the
      // silent `task_updated{completed}` that no other row expresses.
      label: 'background Bash (task_updated)',
      earns: true,
      frames: [
        toolUseLaunch('toolu_crit_bg', 'Bash', { command: 'sleep 25', run_in_background: true }),
        startedTaskFor('crit-bg', 'toolu_crit_bg', 'local_bash', 'sleep 25'),
        updatedTask('crit-bg', 'completed'),
      ],
    },
    {
      // A subagent: genuinely background work, but the CLI mirrors its end into a
      // `<task-notification>` row of its own, so a server row would be a second one.
      label: 'CLI-notified subagent',
      earns: false,
      frames: [
        toolUseLaunch('toolu_crit_agent', 'Agent', { description: 'run in background' }),
        startedTaskFor('crit-agent', 'toolu_crit_agent', 'local_agent', 'run in background'),
        updatedTask('crit-agent', 'completed'),
      ],
    },
  ];

  const readings = arms.map((arm) => ({ label: arm.label, expected: arm.earns, ...readCriterionArm(arm) }));
  for (const reading of readings) {
    say(
      `AC2 ${reading.label}: earns row=${String(reading.earns)} (expect ${String(reading.expected)}), ` +
        `transitions across replay=${reading.fired}`,
    );
  }

  assert.deepEqual(
    readings.map((reading) => reading.earns),
    [false, true, false],
    'the criterion must give 不报 / 报 / 不报 for foreground / background / CLI-notified',
  );
  for (const reading of readings) {
    assert.equal(reading.fired, 1, `${reading.label}: the crossing is reported exactly once across a replay`);
  }
});

test('AC2 a foreground tool that is later backgrounded flips to earning a row', () => {
  // The second signal the criterion reads: `backgroundTasks(toolUseId)` moves a
  // running foreground command to the background, which the stream shows as a
  // `task_updated{is_backgrounded:true}`. From that instant its end is a real
  // background task's end and earns the row — while the plain foreground arm
  // above, which never got the flip, does not.
  const reducer = createClaudeTaskReducer();
  reducer.observe(SESSION, frontBashToolUse());
  // The launch alone crosses nothing, so there is no transition to judge yet.
  assert.equal(reducer.observe(SESSION, frontBashStarted()).length, 0);

  // The backgrounding pair the dock proposal §9.3 records: `task_started` came in
  // with the plain foreground call, then `is_backgrounded` flips on the same
  // instant `backgroundTasks(toolUseId)` returns true.
  reducer.observe(SESSION, frontBashBackgrounded());

  const foregroundBeforeFlip = createClaudeTaskReducer();
  foregroundBeforeFlip.observe(SESSION, frontBashToolUse());
  foregroundBeforeFlip.observe(SESSION, frontBashStarted());
  const notFlipped = foregroundBeforeFlip.observe(SESSION, updatedTask(FRONT_BASH_ID, 'completed'));
  assert.equal(earnsTaskTerminalRow(notFlipped[0]), false, 'without the flip the end earns no row');

  const flipped = reducer.observe(SESSION, updatedTask(FRONT_BASH_ID, 'completed'));
  say(
    `AC2 backgrounded-foreground: transitions=${flipped.length}, ` +
      `earns row=${String(earnsTaskTerminalRow(flipped[0]))} (expect true); ` +
      `unflipped earns row=${String(earnsTaskTerminalRow(notFlipped[0]))} (expect false)`,
  );
  assert.equal(flipped.length, 1, 'the flip does not itself report a crossing');
  assert.equal(earnsTaskTerminalRow(flipped[0]), true, 'after the flip the end earns a row');
});
