/**
 * The Schedule Tracker: reduces Claude's scheduled work — cron jobs and one-shot
 * wakeups (`ScheduleWakeup`) — into a per-session table, with `nextFireAt`.
 *
 * Scheduled work is **not a task**: the SDK emits no `task_*` events for it
 * (proposal §1.3 of `claude-session-activity-dock.md` — the `CronCreate` and
 * `ScheduleWakeup` rows have no event stream). The only evidence is three-fold:
 *
 *  - a `CronCreate` / `CronDelete` / `ScheduleWakeup` `tool_use` block and its
 *    paired `tool_result` text, present only while the turn is running; and
 *  - the Stop hook's `session_crons` list, which the CLI reports at the end of a
 *    turn and which is the **complete, authoritative** schedule list (proposal
 *    §4.7: "更好的做法是以 Stop hook 为准").
 *
 * Three invariants are load-bearing and are what the criterion pins:
 *
 *  - **The Stop hook is the authority, and its snapshot is whole.** A
 *    `session_crons` list replaces the session's table outright: an entry the
 *    list no longer names is deleted. That is exactly how "触发后消失" reads —
 *    a `ScheduleWakeup` that fired is simply absent from the next list, so it
 *    leaves the table with no separate cancel event.
 *  - **A tool result only ever builds a provisional row.** While the turn runs,
 *    `CronCreate`/`ScheduleWakeup` results put a `source:'tool-call'` row in the
 *    table so a caller is not blind until the turn ends; the next Stop hook
 *    overwrites it with the authoritative row (`source:'stop-hook'`).
 *  - **`nextFireAt` is a pure evaluation — expression plus injected base minute,
 *    never a local clock read.** There is no `Date.now()` reachable except the
 *    injected clock (default `Date.now`), so the same table can be re-derived
 *    field-for-field at a fixed base, the same discipline the Turn Tracker and
 *    Task Reducer follow.
 *
 * State is per tracker instance and keyed by session id, so two sessions fed
 * interleaved frames cannot read each other's schedules. A module-level
 * singleton would pass every single-session test and fail exactly the
 * cross-talk one.
 *
 * Consumed by the providers module's public facade (`index.ts`) and, through it,
 * by the criterion `claude-activity-schedules.test.ts` (AC-192), which drives
 * this tracker with readings captured from a real run on 2026-10-01
 * (`docs/proposals/claude-session-activity-dock.md` §1.3, §4.7, §9.1/§9.4). A
 * future activity aggregator reads it instead of the host driver's lease
 * ledger, which keeps only `id`/`recurring` for the keep-alive reason and
 * computes no fire time at all.
 */

// ---------------------------------------------------------------- vocabulary --

/**
 * The kind of scheduled work a row represents.
 *
 * - `cron`   — recurring work (`SessionCronEntry.recurring:true`).
 * - `wakeup` — a one-shot fire at a single instant: `ScheduleWakeup`, and any
 *              `SessionCronEntry` the list reports with `recurring:false`
 *              (proposal §9.1 shows the wakeup represented this way, its
 *              `schedule` an absolute minute expression like `"58 20 * * *"`).
 */
export type ScheduleKind = 'cron' | 'wakeup';

/**
 * Where a row came from.
 *
 * - `tool-call` — built provisionally from a `CronCreate`/`ScheduleWakeup`
 *                 `tool_result` during the turn; overwritten by the next Stop
 *                 hook.
 * - `stop-hook` — built from the authoritative `session_crons` snapshot.
 */
export type ScheduleSource = 'tool-call' | 'stop-hook';

/**
 * One row of a session's schedule table.
 *
 * Every optional field is **absent** (not present with value `undefined`) when
 * the source never supplied it, so a caller reads "does this schedule carry a
 * fire time" as `'nextFireAt' in schedule`. `nextFireAt` is minute-granular:
 * epoch ms that always lands on a whole minute (seconds and milliseconds zero).
 */
export type ActivitySchedule = {
  scheduleId: string;
  kind: ScheduleKind;
  /** The cron expression (Stop hook) or a provisional human description (tool call). */
  spec: string;
  recurring: boolean;
  /** The prompt the CLI submits when the schedule fires. */
  prompt?: string;
  /** The next fire instant, minute-granular epoch ms; absent when unevaluable. */
  nextFireAt?: number;
  /** The auto-expiry instant (creation + {@link CRON_MAX_AGE_MS}). */
  expiresAt?: number;
  source: ScheduleSource;
  /**
   * The SDK `tool_use_id` a provisional (`source:'tool-call'`) row was built
   * from, for a `CronCreate` whose authoritative id only the result text names.
   *
   * Carried **beside** `scheduleId`, not instead of it: AC-192's contract keeps
   * `scheduleId` equal to the CLI's own job id (the id the next Stop hook names),
   * while the lease-derivation parity path (AC-195) needs the `tool_use_id` the
   * driver's `inferHeldWork` keys its inferred lease by. A `source:'stop-hook'`
   * row never carries this field — the CLI has named the id by then.
   */
  toolUseId?: string;
};

/**
 * One entry of the Stop hook's `session_crons` list — the shape the SDK passes
 * through `options.hooks.Stop` (its `SessionCronSummary` in `sdk.d.ts`).
 * Defined here rather than imported so this tracker carries no runtime
 * dependency on the SDK, the same discipline the Turn Tracker and Task Reducer
 * follow: the criterion must prove the reduction is signal-driven, not a side
 * effect of a live process.
 */
export type SessionCronEntry = {
  id: string;
  /** Standard 5-field cron expression in local time, e.g. `"0 9 * * 1-5"`. */
  schedule: string;
  /** False for a one-shot wakeup; true for work that re-fires on every match. */
  recurring: boolean;
  /** Prompt text submitted when the schedule fires. */
  prompt: string;
};

/**
 * The tracker instance: one per consumer, holding its own per-session tables.
 * `getSchedules` hands back fresh copies, so a caller cannot corrupt the
 * reduction by mutating what it read.
 */
export type ClaudeScheduleTracker = {
  observe(sessionId: string, frame: unknown): void;
  reconcileStopHook(sessionId: string, sessionCrons: SessionCronEntry[]): void;
  getSchedules(sessionId: string): ActivitySchedule[];
};

/**
 * The tracker's construction options.
 *
 * `now` is the injected clock `nextFireAt` and `expiresAt` are evaluated
 * against; it defaults to `Date.now` so production reads the wall clock while a
 * criterion can pin a base minute and re-derive the table deterministically.
 *
 * The two remaining knobs are **test-only mutation seams**, the same "a
 * documented seam the criterion mutates through" pattern the Task Reducer uses:
 * the criterion's false-form arms build a mis-wired tracker through them and
 * feed it the *same* reading function as the main case, to prove the main
 * readings actually discriminate rather than passing vacuously.
 */
export type ClaudeScheduleTrackerOptions = {
  /** Injected clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  /** False form (1): ignore `ScheduleWakeup`, building rows from `CronCreate` only. */
  ignoreWakeupTools?: boolean;
  /** False form (2): `reconcileStopHook` only adds/updates, never deletes. */
  appendOnlyStopHook?: boolean;
};

/**
 * The CLI's own self-description: a cron "Auto-expires after 7 days"
 * (§9.1). Mirrored here as a literal rather than imported from the host driver
 * (`list/claude/claude-host-driver.provider.ts`), which this service is required
 * to stay free of — the criterion reads the seven-day delta directly, so the
 * two copies are pinned by the same number.
 */
const CRON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ------------------------------------------------------------ frame reading --

/**
 * Narrows an unknown frame to a plain object.
 *
 * Written here rather than imported from `@/shared/utils.js` on purpose: that
 * module pulls in `node:fs`/`express`, and this tracker must stay free of
 * filesystem, process and network imports so its criterion proves the table is
 * built from frames and not from the host.
 */
function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** The first capture group of `pattern` in `text`, or `null`. */
function matchFirst(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match && typeof match[1] === 'string' ? match[1] : null;
}

/**
 * The plain text of a `tool_result` block. The SDK renders it either as a bare
 * string or as an array of `{type:'text', text}` parts; both are flattened so a
 * schedule description split across parts is still readable.
 */
function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = readRecord(part);
        return record && typeof record.text === 'string' ? record.text : '';
      })
      .join('\n');
  }
  return '';
}

// ---------------------------------------------------------------- cron math --

/**
 * Parses one 5-field cron segment into the set of values it matches, or `null`
 * when the segment is malformed. Supported: `*`, a number, the every-n form
 * (`*` followed by `/n`), a `lo-hi` range, `lo/n` (from `lo` to the field
 * maximum), and comma-separated lists of those. Deliberately small — the
 * criterion pins an every-2-minute form, `*` and a fixed `58 20 * * *`, and no
 * more syntax is claimed than is exercised.
 */
function parseCronField(spec: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    const segment = part.trim();
    if (!segment) {
      return null;
    }
    let step = 1;
    let range = segment;
    const slash = segment.indexOf('/');
    if (slash >= 0) {
      range = segment.slice(0, slash);
      step = Number.parseInt(segment.slice(slash + 1), 10);
      if (!Number.isInteger(step) || step <= 0) {
        return null;
      }
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [loText, hiText] = range.split('-');
      lo = Number.parseInt(loText, 10);
      hi = Number.parseInt(hiText, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        return null;
      }
    } else {
      lo = Number.parseInt(range, 10);
      hi = slash >= 0 ? max : lo;
      if (!Number.isInteger(lo)) {
        return null;
      }
    }
    if (lo < min || hi > max || lo > hi) {
      return null;
    }
    for (let value = lo; value <= hi; value += step) {
      values.add(value);
    }
  }
  return values.size > 0 ? values : null;
}

/**
 * The next instant a 5-field cron expression fires, strictly after `nowMs`, as
 * minute-granular epoch ms; `null` when the expression is malformed or matches
 * no minute within eight years. Evaluated in local time (the CLI states the
 * expression is local), with no clock read of its own: the base comes in as an
 * argument.
 */
function nextCronFireAt(expression: string, nowMs: number): number | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }
  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const daysOfMonth = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  // Day-of-week accepts 0-7 so both the 0=Sunday and 7=Sunday spellings match.
  const daysOfWeek = parseCronField(parts[4], 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
    return null;
  }

  // Standard cron's day rule: with both the day-of-month and day-of-week fields
  // restricted, a day matches if either does; otherwise every restricted field
  // must match.
  const domRestricted = parts[2].trim() !== '*';
  const dowRestricted = parts[4].trim() !== '*';
  const base = new Date(nowMs);
  const maxDays = 366 * 8;

  for (let offset = 0; offset <= maxDays; offset += 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset);
    if (!months.has(day.getMonth() + 1)) {
      continue;
    }
    const domOk = daysOfMonth.has(day.getDate());
    const dowOk = daysOfWeek.has(day.getDay()) || (daysOfWeek.has(7) && day.getDay() === 0);
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) {
      continue;
    }
    for (let hour = 0; hour < 24; hour += 1) {
      if (!hours.has(hour)) {
        continue;
      }
      for (let minute = 0; minute < 60; minute += 1) {
        if (!minutes.has(minute)) {
          continue;
        }
        const candidate = new Date(
          base.getFullYear(),
          base.getMonth(),
          base.getDate() + offset,
          hour,
          minute,
          0,
          0,
        ).getTime();
        if (candidate > nowMs) {
          return candidate;
        }
      }
    }
  }
  return null;
}

/** Rounds an instant up to the next whole minute (`ceil`), keeping minute granularity. */
function ceilToMinute(instantMs: number): number {
  return Math.ceil(instantMs / 60_000) * 60_000;
}

/**
 * The delay a `ScheduleWakeup` result text states, in seconds.
 *
 * §1.3/§4.7: a wakeup asked for 60 seconds lands in the text as "in 115s"
 * because the CLI rounds to the next whole minute, so the number read here is
 * the CLI's own rounded delay.
 */
function parseDelaySeconds(text: string): number | null {
  const match = /in\s+(\d+)\s*s\b/i.exec(text);
  if (!match) {
    return null;
  }
  const seconds = Number.parseInt(match[1], 10);
  return Number.isFinite(seconds) ? seconds : null;
}

// ----------------------------------------------------------------- reduction --

/** The mutable per-session row; `materialize` turns it into the public shape. */
type SessionSchedule = {
  scheduleId: string;
  kind: ScheduleKind;
  spec: string;
  recurring: boolean;
  prompt?: string;
  nextFireAt?: number;
  expiresAt?: number;
  source: ScheduleSource;
  toolUseId?: string;
};

/** One session's state: the table, plus the `tool_use` pairing pending its result. */
type SessionState = {
  schedules: Map<string, SessionSchedule>;
  toolCalls: Map<string, { name: string; input: Record<string, unknown> | null }>;
};

/** The public, fresh copy of a row, omitting every field the source never supplied. */
function materialize(record: SessionSchedule): ActivitySchedule {
  const out: ActivitySchedule = {
    scheduleId: record.scheduleId,
    kind: record.kind,
    spec: record.spec,
    recurring: record.recurring,
    source: record.source,
  };
  if (record.prompt !== undefined) {
    out.prompt = record.prompt;
  }
  if (record.nextFireAt !== undefined) {
    out.nextFireAt = record.nextFireAt;
  }
  if (record.expiresAt !== undefined) {
    out.expiresAt = record.expiresAt;
  }
  if (record.toolUseId !== undefined) {
    out.toolUseId = record.toolUseId;
  }
  return out;
}

/**
 * Builds a provisional row from a `CronCreate` `tool_result`.
 *
 * The row's id is the job id the CLI's result text names ("Scheduled recurring
 * job <id> …"), not the `tool_use.id`; the next Stop hook carries the same id,
 * so the authoritative snapshot overrides this same key and only `source` and
 * `spec` change. The fire time is evaluated from the `tool_use` input's `cron`
 * expression, never a clock: the injected base minute is passed in.
 */
function applyCronCreateResult(
  state: SessionState,
  toolUseId: string,
  input: Record<string, unknown> | null,
  text: string,
  nowMs: number,
): void {
  const id =
    matchFirst(text, /scheduled recurring job\s+([A-Za-z0-9_-]+)/i) ??
    matchFirst(text, /\bjob\s+([A-Za-z0-9_-]+)/i);
  if (!id) {
    return;
  }
  const cronExpression = typeof input?.cron === 'string' ? input.cron : null;
  const recurring = input?.recurring !== false;
  const humanSchedule = matchFirst(text, /\(([^)]*\bevery\b[^)]*)\)/i);
  const record: SessionSchedule = {
    scheduleId: id,
    kind: recurring ? 'cron' : 'wakeup',
    // Provisional spec is the CLI's human description ("Every 2 minutes"); the
    // Stop hook later replaces it with the absolute expression.
    spec: humanSchedule ?? cronExpression ?? 'cron',
    recurring,
    source: 'tool-call',
    expiresAt: nowMs + CRON_MAX_AGE_MS,
    // The lease-parity path keys an inferred cron lease by the SDK `tool_use_id`
    // (the driver's `inferHeldWork` does), so the provisional row carries it
    // beside the CLI id the result text named.
    toolUseId,
  };
  if (typeof input?.prompt === 'string') {
    record.prompt = input.prompt;
  }
  if (cronExpression) {
    const next = nextCronFireAt(cronExpression, nowMs);
    if (next !== null) {
      record.nextFireAt = next;
    }
  }
  state.schedules.set(id, record);
}

/**
 * Builds a provisional row from a `ScheduleWakeup` `tool_result`.
 *
 * The result text names no id, so the `tool_use.id` is the provisional key; the
 * Stop hook's `session_crons` entry (a `recurring:false` row) then supersedes it
 * under the CLI's own id. The fire time rounds the stated delay up to the next
 * whole minute (AC4): the CLI's own "in 115s" already lands on a minute, and
 * the tracker must not report second precision.
 */
function applyWakeupResult(
  state: SessionState,
  toolUseId: string,
  input: Record<string, unknown> | null,
  text: string,
  nowMs: number,
): void {
  const delaySeconds =
    parseDelaySeconds(text) ??
    (typeof input?.delaySeconds === 'number' && Number.isFinite(input.delaySeconds)
      ? input.delaySeconds
      : null);
  const targetClock = matchFirst(text, /scheduled for\s+(\d{1,2}:\d{2}(?::\d{2})?)/i);
  const record: SessionSchedule = {
    scheduleId: toolUseId,
    kind: 'wakeup',
    spec: targetClock ?? (delaySeconds !== null ? `in ${delaySeconds}s` : 'wakeup'),
    recurring: false,
    source: 'tool-call',
    expiresAt: nowMs + CRON_MAX_AGE_MS,
    toolUseId,
  };
  if (typeof input?.prompt === 'string') {
    record.prompt = input.prompt;
  }
  if (delaySeconds !== null) {
    record.nextFireAt = ceilToMinute(nowMs + delaySeconds * 1000);
  }
  state.schedules.set(toolUseId, record);
}

/**
 * Creates a Schedule Tracker.
 *
 * Consumed by the providers module's public facade (`index.ts`) and, through it,
 * by the schedule criterion (`claude-activity-schedules.test.ts`). It is the
 * module's answer to "which cron jobs and wakeups is this session holding, and
 * when does each next fire" — the read model a future activity aggregator and
 * REST/WS schedule surface consume instead of the host driver's keep-alive
 * lease ledger.
 */
export function createClaudeScheduleTracker(
  options: ClaudeScheduleTrackerOptions = {},
): ClaudeScheduleTracker {
  const now = options.now ?? Date.now;
  const sessions = new Map<string, SessionState>();

  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (!state) {
      state = { schedules: new Map(), toolCalls: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  };

  const observe = (sessionId: string, frame: unknown): void => {
    const record = readRecord(frame);
    if (!record) {
      return;
    }

    if (record.type === 'assistant') {
      const message = readRecord(record.message);
      const content = message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        const toolUse = readRecord(block);
        if (toolUse?.type !== 'tool_use' || typeof toolUse.name !== 'string') {
          continue;
        }
        // Only the schedule tools are paired here; everything else on the
        // stream is another reducer's business.
        if (
          toolUse.name !== 'CronCreate' &&
          toolUse.name !== 'ScheduleWakeup' &&
          toolUse.name !== 'CronDelete'
        ) {
          continue;
        }
        const id = typeof toolUse.id === 'string' ? toolUse.id : '';
        if (!id) {
          continue;
        }
        stateFor(sessionId).toolCalls.set(id, { name: toolUse.name, input: readRecord(toolUse.input) });
      }
      return;
    }

    if (record.type !== 'user') {
      return;
    }
    const message = readRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) {
      return;
    }
    const state = stateFor(sessionId);
    for (const block of content) {
      const toolResult = readRecord(block);
      if (toolResult?.type !== 'tool_result') {
        continue;
      }
      const toolUseId = typeof toolResult.tool_use_id === 'string' ? toolResult.tool_use_id : '';
      if (!toolUseId) {
        continue;
      }
      const call = state.toolCalls.get(toolUseId);
      if (!call) {
        continue;
      }
      const text = toolResultText(toolResult);
      if (call.name === 'CronCreate') {
        applyCronCreateResult(state, toolUseId, call.input, text, now());
      } else if (call.name === 'ScheduleWakeup') {
        if (!options.ignoreWakeupTools) {
          applyWakeupResult(state, toolUseId, call.input, text, now());
        }
      }
      // CronDelete is remembered but its result is deliberately not applied: the
      // SDK exposes no control request to cancel a schedule, and the
      // authoritative removal is the next Stop hook's whole-override (proposal
      // §0.1-3 / §4.7). Applying it here would invent a deletion the authority
      // has not confirmed.
      state.toolCalls.delete(toolUseId);
    }
  };

  /**
   * Reconciles the table against the Stop hook's `session_crons` snapshot — the
   * complete, authoritative list. The override is **whole**: a schedule the list
   * no longer names is deleted (this is "触发后消失"), and a schedule it names is
   * created or overwritten as `source:'stop-hook'`. Running it twice on the same
   * snapshot is a no-op the second time — the table overwrites keys, it never
   * appends.
   */
  const reconcileStopHook = (sessionId: string, sessionCrons: SessionCronEntry[]): void => {
    const state = stateFor(sessionId);
    const snapshotIds = new Set<string>();
    for (const entry of sessionCrons) {
      if (entry && typeof entry.id === 'string' && entry.id) {
        snapshotIds.add(entry.id);
      }
    }

    if (!options.appendOnlyStopHook) {
      for (const id of [...state.schedules.keys()]) {
        if (!snapshotIds.has(id)) {
          state.schedules.delete(id);
        }
      }
    }

    for (const entry of sessionCrons) {
      if (!entry || typeof entry.id !== 'string' || !entry.id) {
        continue;
      }
      const existing = state.schedules.get(entry.id);
      const recurring = entry.recurring !== false;
      const spec = typeof entry.schedule === 'string' ? entry.schedule : existing?.spec ?? '';
      const record: SessionSchedule = {
        scheduleId: entry.id,
        kind: recurring ? 'cron' : 'wakeup',
        spec,
        recurring,
        source: 'stop-hook',
        // Preserve an id's original expiry rather than sliding it forward on
        // every snapshot: the seven days are counted from creation, exactly the
        // reason the host driver's `cronsFromStopList` preserves it.
        expiresAt: existing?.expiresAt ?? now() + CRON_MAX_AGE_MS,
      };
      const prompt = typeof entry.prompt === 'string' ? entry.prompt : existing?.prompt;
      if (prompt !== undefined) {
        record.prompt = prompt;
      }
      const next = nextCronFireAt(spec, now());
      if (next !== null) {
        record.nextFireAt = next;
      }
      state.schedules.set(entry.id, record);
    }
  };

  const getSchedules = (sessionId: string): ActivitySchedule[] => {
    const state = sessions.get(sessionId);
    if (!state) {
      return [];
    }
    return Array.from(state.schedules.values()).map(materialize);
  };

  return { observe, reconcileStopHook, getSchedules };
}
