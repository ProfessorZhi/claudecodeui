import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AnyRecord, CommandLifecycleState, MessageOrigin } from '@/shared/types.js';
import {
  CLAUDE_TASK_NOTIFICATION_SUBTYPE,
  CLAUDE_TASK_PROGRESS_SUBTYPE,
  CLAUDE_TASK_STARTED_SUBTYPE,
  CLAUDE_TASK_UPDATED_SUBTYPE,
  CLAUDE_TOOL_RESULT_BLOCK_TYPE,
  CLAUDE_TOOL_USE_BLOCK_TYPE,
  COMMAND_LIFECYCLE_ROW_TYPE,
} from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

import { getDebugAgentProjectsRoot } from './debug-agent.gate.js';
import {
  loadScenario,
  resolveScenarioLifecycleMode,
  type DebugAgentLifecycleMode,
  type DebugAgentScenario,
} from './debug-agent.scenario.js';

/**
 * The debug agent's transcript face: the claude dialect's row shapes, the file
 * operations the engine drives them with, and the armed-scenario store a run
 * looks its script up in.
 *
 * This is the ONE place that knows the dialect's field names, which is the whole
 * point of the split ADR-003 decision 4 asks for: the engine decides WHEN a row
 * is written, this module decides WHAT a row looks like, and the normalizer —
 * the product's own, reused rather than reimplemented — decides what a frame
 * made from that row contains.
 *
 * Nothing here names a frame kind or an event: the rows below are written and
 * read, and the wire shapes are whatever `sessions.normalizeMessage` makes of
 * them.
 */

/** The row shape written for one conversation turn in the claude dialect. */
type DebugAgentMessageRowInput = {
  sessionId: string;
  cwd: string;
  role: string;
  text: string;
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  /**
   * What started this turn, for a turn nobody typed.
   *
   * The one field on these rows that the claude dialect does not have, and it is
   * here because the dialect has nowhere else to put it: a turn the host layer
   * opened is, on the wire and on disk, a `user` row with a prompt, and the only
   * thing that tells it apart from a turn a person typed is the cause the
   * scenario stated. Writing it as a row field keeps it where every other fact
   * about the message is — and the provider that owns this dialect is what lifts
   * it onto the normalized message, so nothing downstream has to know it was ever
   * a row field.
   *
   * Omitted (not `undefined`-valued) for a typed turn, so a row written by a
   * person and a row written by the host layer differ on disk rather than only
   * in the reader's interpretation.
   */
  origin?: MessageOrigin;
};

/**
 * Builds one conversation row: a JSON object carrying the session id and cwd the
 * indexer reads, and the uuid that decides the normalized message's id.
 *
 * The role is written twice — as the row's `type` and inside `message` — because
 * that is the dialect's own redundancy, not this module's choice.
 */
export function buildMessageRow(input: DebugAgentMessageRowInput): AnyRecord {
  return {
    type: input.role,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    ...(input.origin ? { origin: input.origin } : {}),
    message: {
      role: input.role,
      content: [{ type: 'text', text: input.text }],
    },
  };
}

/**
 * Builds the claude dialect's thinking-token estimate row.
 *
 * It carries no `message`: on the wire this is the `system`/`thinking_tokens`
 * signal a turn emits while the model is still reasoning, and — like the real
 * SDK record — it is a statement about the turn rather than a transcript row, so
 * the product's normalizer drops it. It is written here because the debug agent
 * describes what the CLI *writes*, and the phase a browser reads is reduced from
 * that row by the frame forwarder — this module names no frame.
 */
export function buildThinkingTokensRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
}): AnyRecord {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
  };
}

/**
 * Builds the assistant row whose single content block is a pending tool call.
 *
 * The block's type is the dialect's own name, referenced through the shared
 * constant rather than spelled here — the vocabulary guard rejects the literal
 * in this module (ADR-003 decision 7), exactly as it does for a frame kind. The
 * `id` is what a later result row pairs with, and the `name` is the tool the
 * dock reads.
 */
export function buildToolUseRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  toolUseId: string;
  name: string;
  /**
   * The tool's input, when the step states one. A `CronCreate` plan's expression
   * and prompt ride here; every other call this module writes carries `{}`, the
   * shape a call with no stated input has always had.
   */
  toolInput?: Record<string, unknown>;
}): AnyRecord {
  return {
    type: 'assistant',
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: CLAUDE_TOOL_USE_BLOCK_TYPE,
          id: input.toolUseId,
          name: input.name,
          input: input.toolInput ?? {},
        },
      ],
    },
  };
}

/**
 * Builds the user row whose single content block is the paired tool result.
 *
 * `tool_use_id` is what moves the turn off the tool phase: the reducer pairs it
 * with the `tool_use` block's id and only then lets the turn continue.
 */
export function buildToolResultRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  toolUseId: string;
  text: string;
}): AnyRecord {
  return {
    type: 'user',
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: CLAUDE_TOOL_RESULT_BLOCK_TYPE,
          tool_use_id: input.toolUseId,
          content: input.text,
        },
      ],
    },
  };
}

/**
 * Builds the partial-assistant stream event that carries a text delta.
 *
 * This is the one row whose whole content is a fragment of a message still being
 * written: the product's normalizer turns it into the in-place transcript growth
 * a client renders, and the reducer reads the same delta as the `writing` phase.
 */
export function buildTextDeltaRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  text: string;
}): AnyRecord {
  return {
    type: 'stream_event',
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: input.text },
    },
  };
}

/**
 * Builds the turn's terminal record — the row that says the turn is over.
 *
 * It is deliberately the dialect's own shape and nothing more; the reducer reads
 * it as "this turn has ended" and returns the session to `idle`.
 */
export function buildTurnResultRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
}): AnyRecord {
  return {
    type: 'result',
    subtype: 'success',
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
  };
}

/**
 * Builds the row that starts a background task.
 *
 * On the wire this is the `system`/`task_started` signal the CLI emits when a
 * tool call is backgrounded (or a workflow run begins); the product's Task
 * Reducer reads `task_id`, `task_type`, `description` and the `tool_use_id` that
 * joins the task to the transcript card that launched it. The subtype is taken
 * from the shared vocabulary rather than spelled here — this module may not name
 * a wire kind or event (ADR-003 decision 7, enforced by
 * `tests/debug-agent-vocabulary-guard.test.ts`).
 */
export function buildTaskStartedRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  taskId: string;
  taskType: string;
  description: string;
  /** The `tool_use` the card was drawn from; `null` for a task with no card. */
  toolUseId: string | null;
  /** The frame-supplied start instant (epoch ms), so a reader can compute elapsed. */
  startedAt: number;
}): AnyRecord {
  return {
    type: 'system',
    subtype: CLAUDE_TASK_STARTED_SUBTYPE,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    task_id: input.taskId,
    task_type: input.taskType,
    description: input.description,
    started_at: input.startedAt,
    ...(input.toolUseId ? { tool_use_id: input.toolUseId } : {}),
  };
}

/** Builds the row that advances a task's latest-progress description. */
export function buildTaskProgressRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  taskId: string;
  description: string;
}): AnyRecord {
  return {
    type: 'system',
    subtype: CLAUDE_TASK_PROGRESS_SUBTYPE,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    task_id: input.taskId,
    description: input.description,
  };
}

/** Builds the row that patches a task's lifecycle status. */
export function buildTaskUpdatedRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  taskId: string;
  status: string;
  /**
   * True when this patch is the one that says the task is a background task.
   *
   * Written into the patch as `is_backgrounded` — the dialect's own field name
   * for it. It is what the Task Reducer reads as "this task moved to the
   * background", and it is deliberately part of the patch rather than a
   * top-level field, matching the real SDK frame the reducer was written
   * against.
   */
  isBackgrounded?: boolean;
  /** The frame-supplied end instant (epoch ms), when the patch settled the task. */
  endedAt?: number;
}): AnyRecord {
  return {
    type: 'system',
    subtype: CLAUDE_TASK_UPDATED_SUBTYPE,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    task_id: input.taskId,
    patch: {
      status: input.status,
      ...(input.isBackgrounded === true ? { is_backgrounded: true } : {}),
      ...(input.endedAt !== undefined ? { ended_at: input.endedAt } : {}),
    },
  };
}

/** Builds the row that carries a task's terminal status and one-line summary. */
export function buildTaskNotificationRow(input: {
  sessionId: string;
  cwd: string;
  timestamp: string;
  uuid: string;
  parentUuid: string | null;
  taskId: string;
  status: string;
  summary: string;
  /** The frame-supplied end instant (epoch ms), so a reader can compute duration. */
  endedAt?: number;
}): AnyRecord {
  return {
    type: 'system',
    subtype: CLAUDE_TASK_NOTIFICATION_SUBTYPE,
    uuid: input.uuid,
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    task_id: input.taskId,
    status: input.status,
    summary: input.summary,
    ...(input.endedAt !== undefined ? { end_time: input.endedAt } : {}),
  };
}

/**
 * Builds the row that names a session, so the session is listable by name before
 * anything drives it. It carries `sessionId`/`cwd` like any other row, which is
 * what keeps a fixture transcript readable by the same code as a real one.
 */
export function buildTitleRow(input: { sessionId: string; cwd: string; title: string; timestamp: string }): AnyRecord {
  return {
    type: 'custom-title',
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    customTitle: input.title,
  };
}

/**
 * Builds the row that says where one pushed command is in the CLI's own queue.
 *
 * The row's type is the dialect's, taken from the shared vocabulary rather than
 * written out here: this module may not name a wire kind or event (ADR-003
 * decision 7, enforced by `tests/debug-agent-vocabulary-guard.test.ts`), and the
 * dialect's `command_lifecycle` row is exactly the kind of name that is both
 * the artifact's field and the frame's kind. Importing the dialect's own name
 * keeps "which string is this?" answerable in one place, and keeps the
 * row → frame mapping where it belongs — in the product's normalizer.
 *
 * `command_uuid` is the uuid the host assigned when it wrote the command, and
 * the CLI echoes it back verbatim; it is what makes a pushed message and this
 * row the same object to every reader downstream.
 */
export function buildCommandLifecycleRow(input: {
  sessionId: string;
  cwd: string;
  commandUuid: string;
  state: CommandLifecycleState;
  timestamp: string;
}): AnyRecord {
  return {
    type: COMMAND_LIFECYCLE_ROW_TYPE,
    sessionId: input.sessionId,
    cwd: input.cwd,
    timestamp: input.timestamp,
    command_uuid: input.commandUuid,
    state: input.state,
  };
}

/**
 * Rewrites one row's text in place, keeping every other field — the uuid above
 * all, which is what makes the rewrite the same message with different content
 * instead of a second message.
 *
 * Refuses a row that has no text part to grow rather than inventing one: a
 * silently-created part would turn "grow" into "row" and leave a scenario
 * asserting in-place growth against a row that was never grown.
 */
export function growRowText(row: AnyRecord, text: string): AnyRecord {
  const message = readObjectRecord(row.message);
  const content = message?.content;
  if (!message || !Array.isArray(content)) {
    return refuse(`cannot grow a row of type ${JSON.stringify(row.type)}: it is not a message row`);
  }

  const textPartIndex = content.findIndex((part: unknown) => readObjectRecord(part)?.type === 'text');
  if (textPartIndex === -1) {
    return refuse(`cannot grow a row of type ${JSON.stringify(row.type)}: it carries no text part`);
  }

  const parts = content.map((part: unknown, index: number) =>
    index === textPartIndex ? { ...readObjectRecord(part), text } : part,
  );

  return { ...row, message: { ...message, content: parts } };
}

/**
 * The directory a project's transcripts are grouped under.
 *
 * The indexer reads a transcript's session id and cwd from the ROWS, never from
 * this name, so the grouping is cosmetic — it is here so a fixture transcript
 * sits exactly where a real one would, and no reader can tell them apart by
 * shape.
 */
export function encodeProjectBucket(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Writes a transcript from scratch: one JSON object per line, parent directories
 * created first.
 *
 * Synchronous on purpose. The engine's whole contract is "the row is on disk
 * before its frame is forwarded", and a synchronous write is what makes that
 * ordering structural instead of a promise the next `await` could reorder.
 */
export function writeTranscript(filePath: string, rows: AnyRecord[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
}

/** Appends one row to a transcript, creating the file if the seed has not. */
export function appendTranscriptRow(filePath: string, row: AnyRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

/**
 * Writes the row a prompt somebody typed becomes, and hands the row back so its
 * caller can forward the frame it normalizes to.
 *
 * This is the ONE writer of a typed turn's row, and it exists because the run
 * that answers a typed turn walks a scenario rather than producing the prompt:
 * the engine's `row` steps write what the scenario says, and nothing in the walk
 * has ever seen the text the person sent. Without this row the prompt lives only
 * in the client that typed it — the live view shows it and a reload loses it,
 * because a transcript that never recorded it is what the REST read returns.
 *
 * No `origin`, and that is the whole difference from a turn the host layer
 * opened: the field answers "what started this turn", and a turn a person typed
 * was started by that person rather than by anything the scenario could name (see
 * {@link DebugAgentMessageRowInput.origin}). Omitting it is what makes the two
 * kinds of row differ on disk rather than only in a reader's interpretation.
 *
 * The parent link is read from disk at the moment of the write, exactly as the
 * engine's own append does, so the row chains onto whatever the transcript holds
 * right now instead of onto whatever a caller believed it held.
 *
 * An empty prompt writes nothing and returns null: there is no text to record,
 * and a row with no content would be a message the person never sent. The caller
 * is expected to have nothing to forward in that case either.
 */
export function appendTypedTurnRow(input: {
  transcriptPath: string;
  sessionId: string;
  cwd: string;
  text: string;
}): AnyRecord | null {
  if (input.text.trim().length === 0) {
    return null;
  }

  const parent = readTranscriptShape(input.transcriptPath).lastRow;
  const row = buildMessageRow({
    sessionId: input.sessionId,
    cwd: input.cwd,
    role: 'user',
    text: input.text,
    uuid: crypto.randomUUID(),
    parentUuid: typeof parent?.uuid === 'string' ? parent.uuid : null,
    timestamp: new Date().toISOString(),
  });

  appendTranscriptRow(input.transcriptPath, row);
  return row;
}

/**
 * Replaces the last row of a transcript with whatever `grow` returns, keeping
 * the replaced row's uuid.
 *
 * The uuid is re-applied here rather than left to the caller: "grow keeps the
 * uuid" is the invariant every read-back depends on, so it is enforced where the
 * write happens instead of being a convention each caller remembers.
 */
export function rewriteLastTranscriptRow(
  filePath: string,
  grow: (row: AnyRecord) => AnyRecord,
): AnyRecord {
  const rows = readTranscriptRows(filePath);
  const last = rows.at(-1);
  if (!last) {
    return refuse('cannot rewrite the last row of an empty transcript');
  }

  const grown = { ...grow(last), uuid: last.uuid };
  rows[rows.length - 1] = grown;
  writeTranscript(filePath, rows);
  return grown;
}

/**
 * Reads a transcript's rows. A line that does not parse is an error rather than
 * a skipped line: this function is what the run's own read-back measures the
 * artifact with, and a reader that silently ignored damage would report a
 * healthy transcript for a file nothing downstream can index.
 */
export function readTranscriptRows(filePath: string): AnyRecord[] {
  return readTranscriptLines(filePath).map((line, index) => {
    const parsed = readObjectRecord(JSON.parse(line) as unknown);
    if (!parsed) {
      return refuse(`${path.basename(filePath)}:${index + 1} is not a JSON object`);
    }

    return parsed;
  });
}

/** The transcript's non-empty lines, in file order. */
export function readTranscriptLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

/** What one read of a transcript can say about it. Everything here comes off disk. */
export type DebugAgentTranscriptShape = {
  rows: number;
  lastRowBytes: number;
  lastRow: AnyRecord | null;
};

/**
 * Reads a transcript's shape — row count, byte length of the last line, and the
 * last row itself — in exactly one read.
 *
 * The byte length is taken from the line as written rather than from a
 * re-serialization of the parsed row, so a reading of "the last row grew" is a
 * statement about the file's own bytes and cannot be satisfied by a rewrite that
 * changed nothing on disk.
 */
export function readTranscriptShape(filePath: string): DebugAgentTranscriptShape {
  const lines = readTranscriptLines(filePath);
  const lastLine = lines.at(-1);

  return {
    rows: lines.length,
    lastRowBytes: lastLine === undefined ? 0 : Buffer.byteLength(lastLine, 'utf8'),
    lastRow: lastLine === undefined ? null : (readObjectRecord(JSON.parse(lastLine) as unknown) ?? null),
  };
}

/** Arming refuses through the same error type the scenario loader uses. */
function refuse(reason: string): never {
  throw new AppError(`Debug agent scenario refused: ${reason}`, {
    code: 'DEBUG_AGENT_SCENARIO_INVALID',
    statusCode: 400,
  });
}

/**
 * A scenario that has been written to a fixture home and indexed, waiting to be
 * driven.
 */
export type ArmedDebugAgentScenario = {
  /**
   * The session id the armed scenario is addressed by: the one recorded on the
   * indexed row, and the id a run is started for.
   */
  sessionId: string;
  /** The id inside the transcript rows; equal to `sessionId` for a freshly armed scenario. */
  providerSessionId: string;
  transcriptPath: string;
  projectPath: string;
  /** Rows the seed wrote; the run's own row delta is measured from here. */
  seedRows: number;
  scenario: DebugAgentScenario;
};

export type DebugAgentArmInput = {
  projectPath: string;
  /** The scenario document; validated before anything is written. */
  scenario: unknown;
  /**
   * Indexes the seeded transcript, returning the session id it recorded.
   *
   * Injected because this module may not reach the providers module (that edge
   * would close a cycle through the registry that registers this provider), and
   * because arming an unindexed transcript would hand back a session nobody can
   * list, select or send to.
   */
  synchronizeTranscript: (filePath: string) => Promise<string | null>;
  /**
   * Records the mode the seeded session is stored under, once the indexer has
   * created its row.
   *
   * Called after the row exists because the stored mode is a column on it, and
   * before the caller can start a run because the mode is read at dispatch
   * time: a run started against a session still stored `per-run` would take the
   * per-run path no matter what the scenario seeded.
   *
   * Optional, and a scenario seeding `resident` with no seam wired is REFUSED
   * rather than run: the document asked for a process lifetime this build has
   * nowhere to record, and a run that quietly proceeded would produce the
   * per-run substitute under a document that says otherwise — a reading nobody
   * could attribute to a cause.
   */
  setSessionLifecycleMode?: (input: {
    appSessionId: string;
    mode: DebugAgentLifecycleMode;
  }) => void;
};

/** Armed scenarios, keyed by the session id a run is started for. */
const armedScenarios = new Map<string, ArmedDebugAgentScenario>();

/**
 * Writes a scenario's seed rows into the fixture home and indexes them, so the
 * session is listable, selectable and sendable BEFORE it is driven.
 *
 * The order is the contract: rows first, then the index. A run started against a
 * session whose row does not exist yet would fail to resolve its transcript, and
 * one started against a transcript whose row exists but has no path would have
 * its frames diverge from a history that answers with nothing.
 */
export async function armDebugAgentScenario(input: DebugAgentArmInput): Promise<ArmedDebugAgentScenario> {
  const scenario = loadScenario(input.scenario);

  const projectsRoot = getDebugAgentProjectsRoot();
  if (!projectsRoot) {
    return refuse('the debug agent gate is closed, so there is no fixture home to write into');
  }

  const projectPath = path.resolve(input.projectPath);
  const providerSessionId = crypto.randomUUID();
  const transcriptPath = path.join(
    projectsRoot,
    encodeProjectBucket(projectPath),
    `${providerSessionId}.jsonl`,
  );
  const timestamp = new Date().toISOString();

  // The title row goes first so the LAST row of the seed is a message row: that
  // is the row an in-place growth attaches to, and a scenario is free to open
  // with one.
  writeTranscript(transcriptPath, [
    buildTitleRow({ sessionId: providerSessionId, cwd: projectPath, title: scenario.seed.title, timestamp }),
    buildMessageRow({
      sessionId: providerSessionId,
      cwd: projectPath,
      role: 'user',
      text: scenario.seed.userText,
      uuid: crypto.randomUUID(),
      parentUuid: null,
      timestamp,
    }),
  ]);

  const indexedSessionId = await input.synchronizeTranscript(transcriptPath);
  if (indexedSessionId !== providerSessionId) {
    return refuse(
      `the seeded transcript was not indexed as "${providerSessionId}" (the indexer said ${JSON.stringify(indexedSessionId)}), so the session would not be listable`,
    );
  }

  // The mode is written after the index and before anything can run, and the
  // refusal is about the build rather than the document: `per-run` is what an
  // unseamed build already does, so only a seeded `resident` needs somewhere to
  // put it. Read through the resolver, not off the field: a seed with no mode at
  // all asks for `per-run` and must not be refused for having asked nothing.
  const lifecycleMode = resolveScenarioLifecycleMode(scenario.seed);

  if (lifecycleMode !== 'per-run' && !input.setSessionLifecycleMode) {
    return refuse(
      `seed.lifecycleMode is ${JSON.stringify(lifecycleMode)} but this build has nowhere to record it, so the session would run as "per-run" instead`,
    );
  }

  input.setSessionLifecycleMode?.({
    appSessionId: providerSessionId,
    mode: lifecycleMode,
  });

  const armed: ArmedDebugAgentScenario = {
    sessionId: providerSessionId,
    providerSessionId,
    transcriptPath,
    projectPath,
    seedRows: 2,
    scenario,
  };

  armedScenarios.set(armed.sessionId, armed);
  return armed;
}

/**
 * The scenario armed for a session, or null when that session has none.
 *
 * A run looks its script up by the id it was started for, which is also the id
 * the armed rows were indexed under — there is no second mapping to keep in
 * step.
 */
export function readArmedDebugAgentScenario(sessionId: string): ArmedDebugAgentScenario | null {
  return armedScenarios.get(sessionId) ?? null;
}

/** Drops one armed scenario. Returns whether there was one. */
export function disarmDebugAgentScenario(sessionId: string): boolean {
  return armedScenarios.delete(sessionId);
}
