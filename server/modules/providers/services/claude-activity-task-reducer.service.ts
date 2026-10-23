/**
 * The Task Reducer: reduces Claude's raw SDK frame stream into a per-session
 * table of background tasks — the Task-dimension sibling of the Turn Tracker
 * (`claude-turn-phase.service.ts`, AC-186: same "one stable key per entity,
 * event-sourced, no local clock" discipline).
 *
 * The normalizer that turns SDK frames into transcript rows is lossy for this
 * question on purpose: a `system/task_started` frame survives as a bare
 * `task_id` (the host driver's lease ledger only needs that), and its
 * `task_type`, `workflow_name`, `description`, `parent_tool_use_id`,
 * `is_backgrounded`, terminal status and notification summary are dropped. So
 * the seam that still sees the whole frame is the raw message the run loop hands
 * the normalizer — the same `transformedMessage` the Turn Tracker consumes — and
 * that is what this reducer reads.
 *
 * Three invariants are load-bearing and are what the criterion pins:
 *
 *  - **A task exists only where the SDK says one started.** The table is built on
 *    `task_started` (and the Stop hook's snapshot), never on an `assistant`
 *    `tool_use`: a foreground tool is not a task until `backgroundTasks(toolUseId)`
 *    turns it into one, which the stream shows as a `task_started` together with
 *    a `task_updated{patch:{is_backgrounded:true}}`. A reducer that created a row
 *    on every `tool_use` would invent tasks the SDK never named.
 *  - **`stopped` is not `failed`.** A killed task — `task_updated{status:'killed'}`
 *    and/or `task_notification{status:'stopped'}` — is `stopped`, the state a
 *    `stopTask` call or a Monitor's timeout produces, not an error. `ended` is a
 *    third, distinct state: a task the Stop hook's snapshot no longer names is
 *    over for a cause the stream never stated (`endReason:'unknown'`), and it is
 *    deliberately not folded into `stopped`.
 *  - **No local clock, stable keys.** There is no `Date.now()` in this file:
 *    a timestamp appears only when a frame carries one. Replaying the same frame
 *    sequence — on one instance or on two fresh ones — reduces to the same table
 *    field-for-field, because every task is keyed by its SDK `task_id` and each
 *    frame overwrites that key rather than appending.
 *  - **A terminal transition is reported exactly once.** When a task crosses from
 *    `running`/`blocked` into a terminal state, `observe` / `reconcileStopHook`
 *    return a {@link ClaudeTaskTransition} describing it (and, when constructed
 *    with `onTaskTerminal`, hand it to that sink). The crossing is what is
 *    reported, not the terminal state: a replayed sequence, a repeated Stop-hook
 *    snapshot, or a second terminal frame for a task already settled reports
 *    nothing. That exactly-once rule is what lets a consumer turn the transition
 *    into one durable transcript line without a de-duplication clock of its own.
 *
 * State is per reducer instance and keyed by session id, so two sessions fed
 * interleaved frames cannot read each other's tasks. A module-level singleton
 * would pass every single-session test and fail exactly the cross-talk one.
 *
 * Consumed by the providers module's public facade (`index.ts`) and, through it,
 * by the criterion `claude-activity-task-reducer.test.ts`, which drives this
 * reducer with frame sequences captured from real SDK runs on 2026-10-01 (see
 * `docs/proposals/claude-background-work-observability.md` §1 and
 * `docs/proposals/claude-session-activity-dock.md` §1/§9).
 */

// ---------------------------------------------------------------- vocabulary --

/**
 * The kind of work a task represents, normalized from the SDK's `task_type` and,
 * for a task backfilled from the Stop hook, from `BackgroundTaskSummary.type`.
 *
 * - `subagent` — a background agent (`task_type:'local_agent'`)
 * - `shell`    — a background shell (`task_type:'local_bash'`)
 * - `monitor`  — a Monitor's polling task
 * - `workflow` — a workflow run (`task_type:'local_workflow'`)
 * - `other`    — a task type this build does not recognize
 */
export type TaskKind = 'subagent' | 'shell' | 'monitor' | 'workflow' | 'other';

/**
 * A task's lifecycle state, each value named for the signal that produces it.
 *
 * - `running`   — started and not yet settled.
 * - `blocked`   — `task_updated{status:'paused'}`. Inferred as "blocked on a user
 *                 decision" — the capture never reproduced a `paused` frame, so
 *                 this mapping is an inference (proposal §1.4 / §9.4).
 * - `completed` — the task finished.
 * - `failed`    — the task errored (`task_notification{status:'failed'}`).
 * - `stopped`   — the task was ended by a stop (`task_updated{status:'killed'}`
 *                 or `task_notification{status:'stopped'}`), not by an error.
 * - `ended`     — the Stop hook's snapshot no longer names a still-running task
 *                 and the stream never said why.
 */
export type TaskState = 'running' | 'blocked' | 'completed' | 'failed' | 'stopped' | 'ended';

/** Where a task's row came from: an SDK `task_*` frame, or a Stop hook snapshot entry. */
export type TaskOrigin = 'sdk-event' | 'stop-hook-snapshot';

/**
 * One row of a session's task table.
 *
 * Every optional field is **absent** (not present with value `undefined`) when
 * the frames never supplied it, so a caller reads "did this task ever carry a
 * timestamp" as `'startedAt' in task`. `description` and `isBackgrounded` are
 * always present.
 */
export type ActivityTask = {
  taskId: string;
  kind: TaskKind;
  state: TaskState;
  /** The `tool_use` block that launched this task, for joining a transcript card. */
  toolUseId?: string;
  /** The task whose `tool_use` this task was launched from, when it nests. */
  parentTaskId?: string;
  /** True once `backgroundTasks()` moved a foreground task to the background. */
  isBackgrounded: boolean;
  /** `task_started.workflow_name`, for a `kind:'workflow'` task. */
  workflowName?: string;
  /** The latest `task_progress.description`, the workflow's current step label. */
  stepLabel?: string;
  description: string;
  /** `task_notification.summary`, the terminal one-line result. */
  summary?: string;
  /** Present only on a row ended by the Stop hook snapshot with no stated cause. */
  endReason?: 'unknown';
  origin: TaskOrigin;
  /** Frame-supplied start time; absent unless a frame carried one (never a clock). */
  startedAt?: number;
  /** Frame-supplied end time; absent unless a frame carried one (never a clock). */
  endedAt?: number;
};

/**
 * One entry of the Stop hook's `background_tasks` snapshot — the shape the SDK
 * passes through `options.hooks.Stop` (its `BackgroundTaskSummary` in `sdk.d.ts`).
 * Defined here rather than imported so this reducer carries no runtime
 * dependency on the SDK, the same discipline the Turn Tracker follows: the
 * criterion must prove the reduction is signal-driven, not a side effect of a
 * live process.
 */
export type BackgroundTaskSummary = {
  id: string;
  type: string;
  status: string;
  description: string;
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
};

/**
 * One **terminal transition** of a task — the moment a task leaves a non-terminal
 * state (`running`/`blocked`) and settles into a terminal one (`completed`,
 * `failed`, `stopped`, `ended`).
 *
 * This is the reduction's *event*, as opposed to `getTasks`'s *state*. It exists
 * because the user-facing requirement is "when a background task stops, leave one
 * line in the transcript" and that line has to be produced by the same
 * signal-driven reduction the task table is: the seam that owns the transition
 * owns the emission. All four terminal sources funnel through it — the SDK's
 * `task_updated` / `task_notification` frames and the Stop hook's snapshot — so a
 * consumer never has to re-derive "did this really just end, and if so why".
 *
 * Reported exactly once per task: the crossing is observed on the first terminal
 * frame, and replaying the same sequence (or a Stop hook reconciliation running
 * twice) never reports it again.
 */
export type ClaudeTaskTransition = {
  /** The session whose table the transition happened in. */
  sessionId: string;
  taskId: string;
  kind: TaskKind;
  /** The non-terminal state the task left (`running` or `blocked`). */
  from: TaskState;
  /** The terminal state it settled into. */
  to: TaskState;
  /** The `tool_use` block that launched the task, when a frame named one. */
  toolUseId?: string;
  description: string;
  /** `task_notification.summary`, when the terminal frame carried one. */
  summary?: string;
  /** Frame-supplied end time, absent unless the terminal frame carried one. */
  endedAt?: number;
  /**
   * Whether the task is a **real background task**: its launching `tool_use`
   * carried `run_in_background:true` (or was an Agent that did not opt out), or a
   * `task_updated{is_backgrounded:true}` moved it to the background.
   *
   * This is the criterion that separates a background task's end — which nothing
   * else in the transcript expresses, so the server has to leave a line — from a
   * foreground command's end, whose result the same tool card's `tool_result`
   * already carries (see {@link earnsTaskTerminalRow}). Measured on a real SDK run
   * (0.3.165, 2026-10-04): a foreground Bash's launching `tool_use` has no
   * `run_in_background` and its end arrives as an announced
   * `task_notification{summary:<description>}`, while a `run_in_background:true`
   * Bash's `tool_use` carries the flag and its end arrives as a silent
   * `task_updated{completed}` (or a `task_notification{stopped}` when killed).
   */
  background: boolean;
};

/**
 * The reducer instance: one per consumer, holding its own per-session tables.
 * `getTasks` hands back fresh objects, so a caller cannot corrupt the reduction
 * by mutating what it read.
 *
 * `observe` and `reconcileStopHook` **return the terminal transitions that call
 * produced** (usually an empty array) — the emission face of the same reduction.
 * They return rather than push because the module-level instance is shared by
 * every run, while the writer a frame must be sent through belongs to one run and
 * one frame; the forwarder that owns the writer reads the return value. A caller
 * that wants push semantics instead can pass `onTaskTerminal` when constructing.
 */
export type ClaudeTaskReducer = {
  observe(sessionId: string, frame: unknown): ClaudeTaskTransition[];
  reconcileStopHook(sessionId: string, backgroundTasks: BackgroundTaskSummary[]): ClaudeTaskTransition[];
  getTasks(sessionId: string): ActivityTask[];
};

/**
 * Test-only mutation seams.
 *
 * Production calls `createClaudeTaskReducer()` with no argument and gets the
 * documented reduction. The criterion's false-form arms build a **mis-wired**
 * reducer through these knobs — `killed` reported as `failed`, a row built on a
 * plain `tool_use` — and feed it the *same* reading function as the main case, to
 * prove the main readings actually discriminate rather than passing vacuously.
 * This is the same "a documented seam the criterion mutates through" pattern the
 * resident host driver uses for its `userSettingsPath`.
 */
export type ClaudeTaskReducerMutations = {
  /** Replace the `task_updated.status` / `task_notification.status` mapping. */
  mapUpdatedStatus?: (status: string) => TaskState | null;
  /** Build a task on every `assistant` `tool_use` (the (d) rule, inverted). */
  taskOnToolUse?: boolean;
  /**
   * Push sink for terminal transitions, for a consumer that wants them as they
   * happen rather than as the return value of `observe` / `reconcileStopHook`.
   * Production leaves it unset (the forwarder reads the return value); the
   * criterion uses it so "the callback fired exactly once" is the assertion.
   */
  onTaskTerminal?: (transition: ClaudeTaskTransition) => void;
  /**
   * Report a transition on **every** terminal frame instead of only on the
   * crossing into a terminal state (the (g) rule, inverted). This is the false
   * form the exactly-once criterion reds: with it on, replaying a sequence whose
   * task is already terminal emits the transition again.
   */
  terminalOnEveryFrame?: boolean;
};

// ------------------------------------------------------------ frame reading --

/**
 * Narrows an unknown frame to a plain object.
 *
 * Written here rather than imported from `@/shared/utils.js` on purpose: that
 * module pulls in `node:fs`/`express`, and this reducer must stay free of
 * filesystem, process and network imports so its criterion proves the table is
 * built from frames and not from the host.
 */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** A non-null string field, or `null` when the frame does not carry one. */
function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** The first of `keys` whose value is a finite number; `null` when none is. */
function numericField(record: Record<string, unknown> | null, keys: string[]): number | null {
  if (!record) {
    return null;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/** The first `tool_use` block inside an `assistant` message, or `null`. */
function firstToolUseBlock(frame: Record<string, unknown>): Record<string, unknown> | null {
  const message = readRecord(frame.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const record = readRecord(block);
    if (record?.type === 'tool_use') {
      return record;
    }
  }
  return null;
}

/** The states from which a task cannot move again. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'stopped',
  'ended',
]);

function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Moves a task's state, remembering the non-terminal state it came from the one
 * time it crosses into a terminal state.
 *
 * Every place a frame assigns `task.state` goes through here, so "the task just
 * ended" is decided in one spot rather than re-derived by each apply function.
 * A later terminal frame for a task already terminal changes nothing, which is
 * what makes `terminalFrom` a record of the *first* crossing and nothing else.
 */
function setTaskState(task: SessionTask, next: TaskState): void {
  if (!isTerminal(task.state) && isTerminal(next)) {
    task.terminalFrom = task.state;
  }
  task.state = next;
}

/**
 * Reports every terminal transition this call to the reduction produced.
 *
 * Called once at the end of `observe` / `reconcileStopHook`, after the whole
 * frame has been applied, so the transition carries the fields the same frame
 * wrote (`summary`, `endedAt`) rather than a half-applied row. Returns the
 * transitions and, when `emit` is given, hands each to it too — the two faces of
 * one emission. A task is reported at most once: `terminalReported` latches on
 * the first terminal frame, so a replayed sequence (or a Stop hook reconciling
 * twice) cannot produce a second line. `everyFrame` is the criterion's false
 * form: with it on, the latch is ignored and every terminal frame re-reports.
 */
function settleTerminalTransitions(
  state: SessionTasks,
  sessionId: string,
  emit: ((transition: ClaudeTaskTransition) => void) | undefined,
  everyFrame: boolean,
): ClaudeTaskTransition[] {
  const transitions: ClaudeTaskTransition[] = [];
  for (const task of state.tasks.values()) {
    // Only a crossing counts: a task still running, or one the Stop hook
    // backfilled directly into a terminal state, never had a transition.
    if (task.terminalFrom === undefined || !isTerminal(task.state)) {
      continue;
    }
    if (task.terminalReported && !everyFrame) {
      continue;
    }
    task.terminalReported = true;

    const transition: ClaudeTaskTransition = {
      sessionId,
      taskId: task.taskId,
      kind: task.kind,
      from: task.terminalFrom,
      to: task.state,
      description: task.description,
      background: task.background,
    };
    if (task.toolUseId !== undefined) {
      transition.toolUseId = task.toolUseId;
    }
    if (task.summary !== undefined) {
      transition.summary = task.summary;
    }
    if (task.endedAt !== undefined) {
      transition.endedAt = task.endedAt;
    }

    transitions.push(transition);
    emit?.(transition);
  }
  return transitions;
}

/**
 * The `task_updated.status` / `task_notification.status` → `TaskState` mapping.
 *
 * `killed → stopped` is the load-bearing line: a killed task is one that was
 * stopped, not one that failed, and the criterion's false-form arm flips exactly
 * this mapping to prove the main reading notices. Exported (through the module
 * barrel) so that arm can delegate every other status to the real table instead
 * of restating it.
 */
export function mapUpdatedStatus(status: string): TaskState | null {
  switch (status) {
    case 'killed':
      return 'stopped';
    case 'paused':
      return 'blocked';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
    default:
      return null;
  }
}

/**
 * The `task_started.task_type` → `TaskKind` mapping.
 *
 * The Monitor's own `task_type` string was never captured (the one Monitor task
 * in the record arrived as `local_bash`, §1.1), so the monitor branch is an
 * inference: any unrecognized type that mentions "monitor" reads as `monitor`,
 * everything else unknown is `other`. The test fixture notes where this bites.
 */
function kindFromTaskType(taskType: unknown): TaskKind {
  if (typeof taskType !== 'string') {
    return 'other';
  }
  switch (taskType) {
    case 'local_agent':
    case 'agent':
    case 'subagent':
      return 'subagent';
    case 'local_bash':
    case 'bash':
    case 'shell':
      return 'shell';
    case 'local_workflow':
    case 'workflow':
      return 'workflow';
    default:
      return /monitor/i.test(taskType) ? 'monitor' : 'other';
  }
}

/** `BackgroundTaskSummary.type` → `TaskKind` (the Stop hook's friendly labels). */
function kindFromSnapshotType(type: unknown): TaskKind {
  if (typeof type !== 'string') {
    return 'other';
  }
  switch (type.toLowerCase()) {
    case 'shell':
      return 'shell';
    case 'subagent':
    case 'agent':
      return 'subagent';
    case 'monitor':
      return 'monitor';
    case 'workflow':
      return 'workflow';
    default:
      return 'other';
  }
}

/**
 * The task kinds whose end the CLI already mirrors into the transcript.
 *
 * A background agent, a workflow run and a Monitor each make the CLI enqueue a
 * `<task-notification>` user row (`useChatMessages.ts` → `parseTaskNotification`),
 * so they already have a line and a server-emitted one would sit beside it as a
 * second copy. A background **shell** makes no such row, which is the gap
 * {@link buildTaskTerminalFrame}'s caller closes.
 */
export const CLI_NOTIFIED_TASK_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>([
  'subagent',
  'workflow',
  'monitor',
]);

/**
 * Whether a terminal transition earns a **server-emitted** transcript row.
 *
 * Two conditions, both necessary:
 *
 *  - the CLI does not already notify about this kind ({@link CLI_NOTIFIED_TASK_KINDS});
 *  - the task is a real background task (`transition.background`) rather than a
 *    foreground command the SDK happens to report as a task. A foreground
 *    command's end is already expressed by its own `tool_use` card — the
 *    `tool_result` and, on the dock, the task state — so emitting a line for it
 *    is a duplicate receipt, and one that fragments the work segment it lands in.
 *
 * This is the single decision point the forwarder reads, so the criterion's
 * per-class readings (foreground: no row; background: one row; CLI-notified
 * subagent: no row) are readings of this function and not of a render path.
 */
export function earnsTaskTerminalRow(transition: ClaudeTaskTransition): boolean {
  return transition.background && !CLI_NOTIFIED_TASK_KINDS.has(transition.kind);
}

/**
 * Whether a `tool_use` block launches work that outlives the foreground.
 *
 * The reducer's own reader rather than the provider's `startsBackgroundWork`:
 * that one lives in the provider, which imports this module, and answers "does
 * this SDK message hold the process open" (it counts Monitor/Workflow-style
 * deferred tools that never take a `run_in_background` input). Here the question
 * is narrower — was *this* call a background one — and only the tools whose input
 * actually carries the flag can answer it: `Bash` opts in with `=== true`, an
 * `Agent` backgrounds unless it explicitly opts out.
 */
function blockLaunchesBackgroundTask(block: Record<string, unknown> | null): boolean {
  if (!block || typeof block.name !== 'string') {
    return false;
  }
  const input = readRecord(block.input);
  if (block.name === 'Bash') {
    return input?.run_in_background === true;
  }
  if (block.name === 'Agent' || block.name === 'Task') {
    return input?.run_in_background !== false;
  }
  return false;
}

/** A backfilled snapshot task's status, defaulting to `running` for an unknown word. */
function snapshotStatusToState(status: unknown): TaskState {
  if (typeof status === 'string') {
    const mapped = mapUpdatedStatus(status);
    if (mapped !== null) {
      return mapped;
    }
  }
  return 'running';
}

// ----------------------------------------------------------------- reduction --

/** The internal reduction for one session; the pairing map never leaves this file. */
type SessionTasks = {
  tasks: Map<string, SessionTask>;
  /** `tool_use_id` → the task that tool call launched, for parent recovery. */
  toolUseToTaskId: Map<string, string>;
  /**
   * `tool_use_id` → whether that tool call launched its work in the background.
   *
   * Recorded when the `assistant` frame carrying the `tool_use` is observed —
   * the only frame that sees the call's `input`, and one that arrives before the
   * `task_started` naming the task. It is an auxiliary index, not a task table:
   * observing a `tool_use` still creates no row (the (d) invariant), it only
   * records what the call said about itself so `task_started` can read it back.
   */
  backgroundToolUse: Map<string, boolean>;
};

/** The mutable per-session row; `materialize` turns it into the public shape. */
type SessionTask = {
  taskId: string;
  kind: TaskKind;
  state: TaskState;
  toolUseId?: string;
  parentTaskId?: string;
  isBackgrounded: boolean;
  /**
   * Whether this is a real background task — see {@link ClaudeTaskTransition.background}.
   * Latched true by either signal (the launching `tool_use`'s `run_in_background`,
   * or a `task_updated{is_backgrounded:true}`) and never cleared.
   */
  background: boolean;
  workflowName?: string;
  stepLabel?: string;
  description: string;
  summary?: string;
  endReason?: 'unknown';
  origin: TaskOrigin;
  startedAt?: number;
  endedAt?: number;
  /**
   * The non-terminal state this task left the one time it crossed into a terminal
   * state. Absent for a task that was born terminal (a Stop-hook backfill whose
   * snapshot status was already terminal), which is exactly the case that must
   * NOT be reported as a transition.
   */
  terminalFrom?: TaskState;
  /**
   * True once this task's terminal transition has been reported. Internal state
   * only — never materialized — so a replay of the same sequence reports nothing
   * a second time while `getTasks` stays field-for-field identical.
   */
  terminalReported?: boolean;
};

/** Creates the row for `taskId` if it does not exist; an existing row is returned as-is. */
function ensureTask(state: SessionTasks, taskId: string): SessionTask {
  let task = state.tasks.get(taskId);
  if (!task) {
    task = {
      taskId,
      kind: 'other',
      state: 'running',
      isBackgrounded: false,
      background: false,
      description: '',
      origin: 'sdk-event',
    };
    state.tasks.set(taskId, task);
  }
  return task;
}

/** The public, fresh copy of a row, omitting every field the frames never supplied. */
function materialize(task: SessionTask): ActivityTask {
  const out: ActivityTask = {
    taskId: task.taskId,
    kind: task.kind,
    state: task.state,
    isBackgrounded: task.isBackgrounded,
    description: task.description,
    origin: task.origin,
  };
  if (task.toolUseId !== undefined) {
    out.toolUseId = task.toolUseId;
  }
  if (task.parentTaskId !== undefined) {
    out.parentTaskId = task.parentTaskId;
  }
  if (task.workflowName !== undefined) {
    out.workflowName = task.workflowName;
  }
  if (task.stepLabel !== undefined) {
    out.stepLabel = task.stepLabel;
  }
  if (task.summary !== undefined) {
    out.summary = task.summary;
  }
  if (task.endReason !== undefined) {
    out.endReason = task.endReason;
  }
  if (task.startedAt !== undefined) {
    out.startedAt = task.startedAt;
  }
  if (task.endedAt !== undefined) {
    out.endedAt = task.endedAt;
  }
  return out;
}

/** (a) `task_started`: the only frame that creates a task, and the nesting link. */
function applyTaskStarted(state: SessionTasks, frame: Record<string, unknown>): void {
  const taskId = stringField(frame, 'task_id');
  if (!taskId) {
    return;
  }
  const task = ensureTask(state, taskId);
  task.kind = kindFromTaskType(frame.task_type);
  task.origin = 'sdk-event';

  const workflowName = stringField(frame, 'workflow_name');
  if (workflowName !== null) {
    task.workflowName = workflowName;
  }
  const description = stringField(frame, 'description');
  if (description !== null) {
    task.description = description;
  }

  const toolUseId = stringField(frame, 'tool_use_id');
  if (toolUseId !== null) {
    task.toolUseId = toolUseId;
    state.toolUseToTaskId.set(toolUseId, taskId);
    // The launch's own signal, read back from the `assistant` frame the same
    // stream carried before this `task_started`. Absent (never observed) leaves
    // the task foreground, which is also what a plain `tool_use` means.
    if (state.backgroundToolUse.get(toolUseId) === true) {
      task.background = true;
    }
  }
  // A nested task's `parent_tool_use_id` names the `tool_use` that launched its
  // parent's agent, so the parent task is whichever task owns that tool_use.
  const parentToolUseId = stringField(frame, 'parent_tool_use_id');
  if (parentToolUseId !== null) {
    const parentTaskId = state.toolUseToTaskId.get(parentToolUseId);
    if (parentTaskId) {
      task.parentTaskId = parentTaskId;
    }
  }

  // A replayed `task_started` for a task that already settled must not resurrect
  // it: the later frames in the same sequence re-apply the real terminal state.
  if (!isTerminal(task.state)) {
    task.state = 'running';
  }
  if (frame.is_backgrounded === true) {
    task.isBackgrounded = true;
    task.background = true;
  }

  const startedAt = numericField(frame, ['started_at', 'start_time', 'startedAt']);
  if (startedAt !== null) {
    task.startedAt = startedAt;
  }
}

/** (b)/(e) `task_updated`: a status patch, and where a background Bash terminates. */
function applyTaskUpdated(
  state: SessionTasks,
  frame: Record<string, unknown>,
  mapStatus: (status: string) => TaskState | null,
): void {
  const taskId = stringField(frame, 'task_id');
  if (!taskId) {
    return;
  }
  const task = ensureTask(state, taskId);
  task.origin = 'sdk-event';
  const patch = readRecord(frame.patch) ?? frame;

  const status = stringField(patch, 'status') ?? stringField(frame, 'status');
  if (status !== null) {
    const next = mapStatus(status);
    if (next !== null) {
      setTaskState(task, next);
    }
  }
  if (patch.is_backgrounded === true || frame.is_backgrounded === true) {
    task.isBackgrounded = true;
    // `backgroundTasks(toolUseId)` moves a running foreground command to the
    // background; from that instant it is a real background task and its end
    // earns the line a background task's end earns.
    task.background = true;
  }

  const description = stringField(patch, 'description');
  if (description !== null) {
    task.description = description;
  }
  const toolUseId = stringField(patch, 'tool_use_id');
  if (toolUseId !== null) {
    task.toolUseId = toolUseId;
    state.toolUseToTaskId.set(toolUseId, taskId);
  }
  const parentToolUseId = stringField(patch, 'parent_tool_use_id');
  if (parentToolUseId !== null) {
    const parentTaskId = state.toolUseToTaskId.get(parentToolUseId);
    if (parentTaskId) {
      task.parentTaskId = parentTaskId;
    }
  }

  const endedAt = numericField(patch, ['end_time', 'ended_at', 'endedAt']);
  if (endedAt !== null) {
    task.endedAt = endedAt;
  }
}

/** (c) `task_progress`: the latest description is a workflow's current step label. */
function applyTaskProgress(state: SessionTasks, frame: Record<string, unknown>): void {
  const taskId = stringField(frame, 'task_id');
  if (!taskId) {
    return;
  }
  const task = ensureTask(state, taskId);
  const description = stringField(frame, 'description');
  // The step label is the workflow's business — a subagent's `task_progress`
  // describes its last action, not a step, so it does not set this field.
  if (description !== null && task.kind === 'workflow') {
    task.stepLabel = description;
  }
}

/** (b) `task_notification`: the terminal status, its summary and end time. */
function applyTaskNotification(
  state: SessionTasks,
  frame: Record<string, unknown>,
  mapStatus: (status: string) => TaskState | null,
): void {
  const taskId = stringField(frame, 'task_id');
  if (!taskId) {
    return;
  }
  const task = ensureTask(state, taskId);
  task.origin = 'sdk-event';

  const status = stringField(frame, 'status');
  if (status !== null) {
    const next = mapStatus(status);
    if (next !== null) {
      setTaskState(task, next);
    }
  }
  const summary = stringField(frame, 'summary');
  if (summary !== null) {
    task.summary = summary;
  }
  const endedAt = numericField(frame, ['end_time', 'ended_at', 'endedAt']);
  if (endedAt !== null) {
    task.endedAt = endedAt;
  }
}

/**
 * Creates a Task Reducer.
 *
 * Consumed by the providers module's public facade (`index.ts`) and, through it,
 * by the task-reducer criterion (`claude-activity-task-reducer.test.ts`). It is
 * the module's answer to "which background work is this session still holding,
 * and what is each one doing" — the read model a future activity aggregator and
 * REST/WS task surface consume instead of the lease ledger's bare ids.
 */
export function createClaudeTaskReducer(mutations: ClaudeTaskReducerMutations = {}): ClaudeTaskReducer {
  const sessions = new Map<string, SessionTasks>();
  const mapStatus = mutations.mapUpdatedStatus ?? mapUpdatedStatus;

  const stateFor = (sessionId: string): SessionTasks => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { tasks: new Map(), toolUseToTaskId: new Map(), backgroundToolUse: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const observe = (sessionId: string, frame: unknown): ClaudeTaskTransition[] => {
    const record = readRecord(frame);
    if (!record) {
      return [];
    }

    // (d): the table is built only where the SDK says a task started. An
    // `assistant` `tool_use` — a foreground tool about to run — is deliberately
    // not a task here; it becomes one only through the `task_started` the CLI
    // emits when the tool is backgrounded. The `taskOnToolUse` mutation inverts
    // exactly this rule so the criterion can prove the main reading notices.
    if (record.type === 'assistant') {
      // The `assistant` frame is the only one that sees a call's `input`, and it
      // arrives before the `task_started` naming the task that call launches — so
      // this is where a call's own background/foreground answer is recorded. It
      // creates no task row: the table is still built only on `task_started`.
      const state = stateFor(sessionId);
      const message = readRecord(record.message);
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const entry of content) {
          const block = readRecord(entry);
          if (block?.type !== 'tool_use' || typeof block.id !== 'string') {
            continue;
          }
          state.backgroundToolUse.set(block.id, blockLaunchesBackgroundTask(block));
          // A task that was already named for this call (a frame ordering the SDK
          // has not been seen to produce, but which costs nothing to survive)
          // picks the flag up retroactively.
          const taskId = state.toolUseToTaskId.get(block.id);
          const task = taskId ? state.tasks.get(taskId) : undefined;
          if (task && state.backgroundToolUse.get(block.id) === true) {
            task.background = true;
          }
        }
      }
      if (mutations.taskOnToolUse) {
        const block = firstToolUseBlock(record);
        const toolUseId = typeof block?.id === 'string' ? block.id : '';
        if (toolUseId) {
          const task = ensureTask(state, toolUseId);
          task.toolUseId = toolUseId;
        }
      }
      return [];
    }

    if (record.type !== 'system') {
      return [];
    }

    switch (record.subtype) {
      case 'task_started':
        applyTaskStarted(stateFor(sessionId), record);
        break;
      case 'task_updated':
        applyTaskUpdated(stateFor(sessionId), record, mapStatus);
        break;
      case 'task_progress':
        applyTaskProgress(stateFor(sessionId), record);
        break;
      case 'task_notification':
        applyTaskNotification(stateFor(sessionId), record, mapStatus);
        break;
      default:
        return [];
    }

    // Settle after the whole frame is applied, so a transition this frame caused
    // carries the fields the same frame wrote (`summary`, `endedAt`) and not a
    // half-applied row.
    return settleTerminalTransitions(
      stateFor(sessionId),
      sessionId,
      mutations.onTaskTerminal,
      mutations.terminalOnEveryFrame === true,
    );
  };

  /**
   * (f) Reconciles the table against the Stop hook's `background_tasks` snapshot,
   * in both directions: a running task the snapshot no longer names is `ended`
   * (cause unknown), and a task the snapshot names but the events never did is
   * backfilled as `stop-hook-snapshot`. Running it twice on the same snapshot is
   * a no-op the second time — the reduction overwrites keys, it never appends.
   */
  const reconcileStopHook = (sessionId: string, backgroundTasks: BackgroundTaskSummary[]): ClaudeTaskTransition[] => {
    const state = stateFor(sessionId);
    const snapshotIds = new Set<string>();
    for (const entry of backgroundTasks) {
      if (entry && typeof entry.id === 'string') {
        snapshotIds.add(entry.id);
      }
    }

    for (const task of state.tasks.values()) {
      if (!isTerminal(task.state) && !snapshotIds.has(task.taskId)) {
        setTaskState(task, 'ended');
        task.endReason = 'unknown';
      }
    }

    for (const entry of backgroundTasks) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        continue;
      }
      if (state.tasks.has(entry.id)) {
        continue;
      }
      const task: SessionTask = {
        taskId: entry.id,
        kind: kindFromSnapshotType(entry.type),
        state: snapshotStatusToState(entry.status),
        description: typeof entry.description === 'string' ? entry.description : '',
        isBackgrounded: true,
        // The snapshot only ever names background work — that is what the Stop
        // hook reports — so a backfilled task is a background task by definition.
        background: true,
        origin: 'stop-hook-snapshot',
      };
      if (typeof entry.name === 'string' && entry.name) {
        task.workflowName = entry.name;
      }
      state.tasks.set(entry.id, task);
    }

    // Only the `ended` crossings above are transitions; a task backfilled straight
    // into a terminal status never crossed anything and is not reported.
    return settleTerminalTransitions(
      state,
      sessionId,
      mutations.onTaskTerminal,
      mutations.terminalOnEveryFrame === true,
    );
  };

  const getTasks = (sessionId: string): ActivityTask[] => {
    const state = sessions.get(sessionId);
    if (!state) {
      return [];
    }
    return Array.from(state.tasks.values()).map(materialize);
  };

  return { observe, reconcileStopHook, getTasks };
}
