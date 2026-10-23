/**
 * The Lease Deriver: projects the per-session Task table (AC-191) and Schedule
 * table (AC-192) into the set of held-work leases the resident host driver
 * already reports — the second derivation path the activity-dock proposal
 * (`docs/proposals/claude-session-activity-dock.md` §4) calls for beside the
 * existing one (`observeHeldWorkEvent` + `reconcileHeldWork` + `inferHeldWork`
 * in `list/claude/claude-host-driver.provider.ts`).
 *
 * This module is the **deriving** half of a parity criterion, not a replacement
 * for the existing path: the criterion (`claude-activity-lease-parity.test.ts`)
 * feeds one real frame sequence into both the live driver and these two
 * reducers, then compares the two lease sets frame by frame. Production keeps
 * running the driver's own path; convergence is deliberately left to a later
 * task.
 *
 * Three invariants are load-bearing and are what the criterion pins:
 *
 *  - **No local clock.** `now` is an argument and the only source of time: the
 *    projection never reads `Date.now()`, so a criterion can re-derive the same
 *    leases at a fixed instant and compare them against a driver sharing the
 *    injected clock. `expiresAt` is only a fallback for a schedule the table
 *    never dated; when the table carries one, it is passed through untouched —
 *    which is what makes a job the CLI keeps naming keep its first expiry on
 *    both paths.
 *  - **A monitor folds into `background-task`.** The existing resident path has
 *    no `monitor` lease: a Monitor's `task_started` arrives as a `background-task`
 *    reason like any other task (`observeHeldWorkEvent`), and the `monitor` kind
 *    belongs to the per-run path this criterion does not compare. The projection
 *    therefore reproduces the resident path's shape exactly: every live task
 *    becomes a `background-task` lease regardless of its own kind (proposal
 *    §5.4 of `claude-background-work-observability.md`, "resident 从不产出
 *    monitor 租约的差异需要一并处理").
 *  - **A terminal task is dropped.** `state ∉ {completed, failed, stopped,
 *    ended}` holds a lease; anything else is gone. This is the rule the two
 *    false-form arms of the criterion invert (one terminal class at a time) to
 *    prove the main parity reading actually discriminates.
 *
 * The schedule projection carries the existing path's **id-namespace handoff**
 * (proposal §4 对齐义务): while a cron only has tool-call evidence, the driver's
 * `inferHeldWork` keys its inferred lease by the SDK `tool_use_id`, so the
 * derived lease must be keyed the same way or the two paths disagree on the
 * frame the `CronCreate` lands. The schedule table itself keeps the CLI id the
 * result text names (`scheduleId`, AC-192's contract); the provisional
 * `toolUseId` rides alongside and is what the derived lease is keyed by *until
 * the Stop hook names the CLI id*, after which the row is `source:'stop-hook'`
 * and `scheduleId` is used. That is exactly the `tool_use_id → CLI id` handoff
 * `claude-resident-idle.test.ts` leg (4) asserts on the driver side
 * ("the CLI-named id replaces the tool-call guess").
 *
 * The function is pure: same tables + same `now` ⇒ same leases, in a stable
 * order (by `kind`, then `id`) so a frame-by-frame comparison is deterministic.
 */

import type { HostLease } from '@/shared/types.js';

import { CRON_MAX_AGE_MS } from '../list/claude/claude-host-driver.provider.js';

import type { ActivityTask, TaskState } from './claude-activity-task-reducer.service.js';
import type { ActivitySchedule } from './claude-activity-schedules.service.js';

// ---------------------------------------------------------------- vocabulary --

/** The arguments the projection reads: the two tables and the shared instant. */
export type HeldWorkLeaseInput = {
  /** The Task table for one session (`createClaudeTaskReducer().getTasks`). */
  tasks: ActivityTask[];
  /** The Schedule table for the same session (`createClaudeScheduleTracker().getSchedules`). */
  schedules: ActivitySchedule[];
  /** The instant every undated expiry is counted from; never a local clock read. */
  now: number;
};

/**
 * Test-only mutation seams.
 *
 * Production calls `deriveHeldWorkLeases(input)` and gets the documented
 * projection. The criterion's false-form arms build a **mis-wired** deriver
 * through these knobs — one that leaks a terminal state it should have dropped —
 * and feed it the *same* frame sequence and the *same* comparison, to prove the
 * main reading reds where it should rather than passing vacuously. This is the
 * same "a documented seam the criterion mutates through" pattern the Task
 * Reducer and Schedule Tracker already use.
 */
export type LeaseDeriverMutations = {
  /**
   * Terminal states the projection must NOT drop — the leases for tasks in
   * these states are leaked. False form (i) leaks `stopped` (misses the
   * `task_notification` terminal); false form (ii) leaks `ended` (misses the
   * Stop-hook "the list no longer names it" terminal).
   */
  leakTerminalStates?: TaskState[];
};

// ------------------------------------------------------------------- states --

/** The states from which a task cannot move again, and which hold no lease. */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'stopped',
  'ended',
]);

// ---------------------------------------------------------------- projection --

/** `kind` then `id` — the stable order the criterion's set comparison relies on. */
function byKindThenId(left: HostLease, right: HostLease): number {
  if (left.kind !== right.kind) {
    return left.kind < right.kind ? -1 : 1;
  }
  const leftId = 'id' in left ? left.id : '';
  const rightId = 'id' in right ? right.id : '';
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? -1 : 1;
}

/**
 * Projects the Task and Schedule tables into the resident path's held-work
 * leases. See the module doc comment for the three invariants and the
 * id-namespace handoff.
 */
export function deriveHeldWorkLeases(
  input: HeldWorkLeaseInput,
  mutations: LeaseDeriverMutations = {},
): HostLease[] {
  const leaked = new Set<TaskState>(mutations.leakTerminalStates ?? []);
  const leases: HostLease[] = [];

  // A schedule — cron or one-shot wakeup — is a `cron` reason on the resident
  // path: a `recurring:false` wakeup is still `kind:'cron'`, the same reading
  // `cronsFromStopList` makes. Only a provisional (tool-call) row is flagged
  // `inferred`, mirroring `inferHeldWork`.
  for (const schedule of input.schedules) {
    const id =
      schedule.source === 'tool-call' && schedule.toolUseId
        ? schedule.toolUseId
        : schedule.scheduleId;
    const lease: HostLease = {
      kind: 'cron',
      id,
      recurring: schedule.recurring,
      expiresAt: schedule.expiresAt ?? input.now + CRON_MAX_AGE_MS,
    };
    if (schedule.source === 'tool-call') {
      lease.inferred = true;
    }
    leases.push(lease);
  }

  // A live task is a `background-task` reason — the Monitor kind folds in here,
  // because the resident path never produced a `monitor` lease to compare with.
  for (const task of input.tasks) {
    if (TERMINAL_STATES.has(task.state) && !leaked.has(task.state)) {
      continue;
    }
    leases.push({ kind: 'background-task', id: task.taskId });
  }

  return leases.sort(byKindThenId);
}
