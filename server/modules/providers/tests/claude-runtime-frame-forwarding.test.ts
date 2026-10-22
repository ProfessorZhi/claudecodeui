import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider, forwardNormalizedFrames, readSessionTurn } from '@/modules/providers/index.js';
import { activityAnnouncement, chatRunRegistry } from '@/modules/websocket/index.js';

// The run loop's SDK message handler used to inline the whole "normalize this
// SDK event, carry the wrapper's parentToolUseId, drop the subagent prompt echo,
// send each frame" block. Both neighbours of that block have their own
// coverage — `claude-stream-event-unwrap.test.ts` pins what the normalizer
// produces, `chat-run-registry.test.ts` pins what a writer does with a frame —
// and the block in between had none: a deleted `writer.send` there left every
// test green while no partial frame ever reached the client. These cases drive
// the extracted loop with a fake writer, so the forwarding itself is the thing
// under test.

type Frame = Record<string, unknown>;

/** A stand-in for the run writer (`ws`) that records what it is handed. */
function recordingWriter(): { frames: Array<Frame>; send: (message: Frame) => void } {
  const frames: Array<Frame> = [];
  return {
    frames,
    send: (message: Frame) => {
      frames.push(message);
    },
  };
}

const SESSION_ID = 'claude-frame-forwarding-1';

/** Prints a reading, so the green main case is visible next to its expectation. */
function say(message: string): void {
  process.stdout.write(`[frame-forwarding] ${message}\n`);
}

test('every normalized frame is handed to the writer, in order', () => {
  const writer = recordingWriter();
  // Kinds the other cases do not use, so a defect local to one of them (a
  // dropped `stream_delta`, a missed echo filter, a lost parentToolUseId) reds
  // its own case instead of this one.
  const frames = [
    { kind: 'text', content: 'first' },
    { kind: 'tool_use', content: 'second' },
    { kind: 'thinking', content: 'third' },
  ];

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant' },
    sessionId: SESSION_ID,
    normalizeMessage: () => frames,
    writer,
  });

  // Order is the assertion, so the contents are distinct and not in any sorted
  // order: a forwarder that reordered or deduped would show up here.
  assert.deepEqual(
    writer.frames.map((frame) => frame.content),
    ['first', 'second', 'third'],
  );
});

test('a partial SDK frame is not swallowed on its way to the writer', () => {
  // The real normalizer, not a stub: this is the whole point of the seam. The
  // partial frame becomes a `stream_delta`, and the forwarder has to actually
  // hand that frame over — it carries the in-place transcript growth the client
  // renders, and reading the normalizer's output alone cannot prove it left.
  const provider = new ClaudeSessionsProvider();
  const writer = recordingWriter();

  forwardNormalizedFrames({
    transformedMessage: {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      parent_tool_use_id: null,
      uuid: 'u-stream-1',
      session_id: SESSION_ID,
    },
    sessionId: SESSION_ID,
    normalizeMessage: (raw: unknown, sessionId: string | null) => provider.normalizeMessage(raw, sessionId),
    writer,
  });

  assert.equal(writer.frames.length, 1);
  assert.equal(writer.frames[0].kind, 'stream_delta');
  assert.equal(writer.frames[0].content, 'Hel');
});

test('a subagent prompt echo is dropped instead of forwarded', () => {
  const writer = recordingWriter();
  const echo = { kind: 'text', role: 'user', parentToolUseId: 'toolu_agent', content: 'Investigate' };
  const kept = { kind: 'text', role: 'assistant', content: 'On it' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [echo, kept],
    writer,
  });

  assert.deepEqual(writer.frames, [kept]);
});

test("the SDK wrapper's parentToolUseId is carried onto a frame that lacks one", () => {
  const writer = recordingWriter();
  const child = { kind: 'text', role: 'assistant', content: 'working' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant', parentToolUseId: 'toolu_agent' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [child],
    writer,
  });

  assert.equal(writer.frames.length, 1);
  assert.equal(writer.frames[0].parentToolUseId, 'toolu_agent');
});

test("a frame's own parentToolUseId is not overwritten by the wrapper's", () => {
  // The other half of the carry rule: a frame that already knows which tool call
  // it belongs to must keep it, or a nested subagent's rows would all be
  // re-parented to the outermost one.
  const writer = recordingWriter();
  const child = { kind: 'text', role: 'assistant', content: 'working', parentToolUseId: 'toolu_inner' };

  forwardNormalizedFrames({
    transformedMessage: { type: 'assistant', parentToolUseId: 'toolu_outer' },
    sessionId: SESSION_ID,
    normalizeMessage: () => [child],
    writer,
  });

  assert.equal(writer.frames[0].parentToolUseId, 'toolu_inner');
});

// ---------------------------------------------------------------------------
// gap-activity-turn-phase-id-space-mismatch (AC1/AC2)
//
// The turn tracker used to be fed the id the *normalizer* addresses the run by
// (the provider-native id the SDK reports) while the activity frames read it
// back with the **app session id** the browser subscribes with. Two id spaces,
// one Map: every read missed and answered `idle`, so the dock stayed on the
// fallback `Working…` label with no timer for a turn that was really running.
// The two cases below pin the fixed contract — the tracker is keyed by the app
// session id — with a distinct provider id in play so a regression that keys by
// `sessionId` again reds the first case instead of passing on a coincidence.
// ---------------------------------------------------------------------------

/** The app session id the activity frames read the turn back under. */
const APP_SESSION_ID = 'app-session-frame-forwarding-1';
/** The provider-native id the run's frames are routed by; deliberately different. */
const PROVIDER_SESSION_ID = 'provider-session-frame-forwarding-1';

/** An `assistant` message carrying the `tool_use` block that starts a tool phase. */
function toolUseFrame(id: string, name: string): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    uuid: `u-tool-${id}`,
    session_id: PROVIDER_SESSION_ID,
  };
}

test('the turn phase is readable under the app session id while the turn runs (AC1)', () => {
  const writer = recordingWriter();

  // A real turn with a tool call: the run loop hands the forwarder the provider
  // id for routing/normalization but the app id for the phase key.
  forwardNormalizedFrames({
    transformedMessage: toolUseFrame('toolu_ff_1', 'Bash'),
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });

  // The reading the activity heartbeat transports to the browser.
  const announcement = activityAnnouncement(APP_SESSION_ID);
  assert.notEqual(
    announcement.phase,
    'idle',
    'the heartbeat reported idle for a running turn — the phase was written under a different id space than it is read under',
  );
  assert.equal(announcement.phase, 'tool', `the phase is ${announcement.phase}, not the running tool`);
  assert.equal(announcement.toolName, 'Bash', 'the pending tool name did not survive the read');

  // The same read through the tracker's own facade, so the two entry points AC1
  // names cannot disagree: a run keyed by the provider id would answer `idle`
  // here and leave the raw tracking key non-idle.
  const raw = readSessionTurn(APP_SESSION_ID);
  assert.equal(raw.phase, 'tool');
  assert.equal(raw.toolName, 'Bash');
});

test('the phase falls back to idle when the turn’s result arrives (AC2)', () => {
  const writer = recordingWriter();

  forwardNormalizedFrames({
    transformedMessage: toolUseFrame('toolu_ff_2', 'Bash'),
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });
  assert.equal(
    readSessionTurn(APP_SESSION_ID).phase,
    'tool',
    'precondition: the turn is not in the tool phase, so the fallback below would be vacuous',
  );

  forwardNormalizedFrames({
    transformedMessage: { type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID },
    sessionId: PROVIDER_SESSION_ID,
    turnSessionId: APP_SESSION_ID,
    normalizeMessage: () => [],
    writer,
  });

  assert.equal(
    activityAnnouncement(APP_SESSION_ID).phase,
    'idle',
    'the result frame did not return the same query to idle — the tracker reports a turn that has ended',
  );
  assert.equal(readSessionTurn(APP_SESSION_ID).phase, 'idle');
});

// ---------------------------------------------------------------------------
// gap-task-terminal-transition-transcript-row (AC3/AC4)
//
// A task crossing into a terminal state must leave one transcript line, produced
// by the server's reduction and carried on the same sequenced, replayable stream
// as every other frame — not only pushed once. These cases drive the real
// forwarder with the real gateway writer (`chatRunRegistry`), so the assertions
// are about what a reconnecting client would actually replay, and about the
// de-duplication against the CLI's own `<task-notification>` row.
// ---------------------------------------------------------------------------

/** A `system/task_started` frame, as the run loop hands it to the forwarder. */
function taskStartedFrame(sessionId: string, taskId: string, taskType: string, toolUseId?: string): Frame {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    task_type: taskType,
    description: `task ${taskId}`,
    uuid: `u-start-${taskId}`,
    session_id: sessionId,
  };
}

/**
 * The `assistant` frame carrying the `tool_use` that launches a task — the only
 * frame that sees the call's own `input`, and the one the reducer reads the
 * background/foreground answer off (`run_in_background`).
 */
function toolUseLaunchFrame(sessionId: string, toolUseId: string, name: string, background: boolean): Frame {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name,
          input: name === 'Bash'
            ? { command: background ? 'sleep 25' : 'echo fg-short-ok', ...(background ? { run_in_background: true } : {}) }
            : { description: 'run in background', run_in_background: background },
        },
      ],
    },
    uuid: `u-tool-${toolUseId}`,
    session_id: sessionId,
  };
}

/** A `system/task_updated` status patch — where a background shell terminates. */
function taskUpdatedFrame(sessionId: string, taskId: string, status: string): Frame {
  return {
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status },
    uuid: `u-updated-${taskId}`,
    session_id: sessionId,
  };
}

test('AC3 a terminal transition is forwarded as one replayable task_notification frame', () => {
  const appSessionId = 'claude-frame-forwarding-terminal-ac3';
  chatRunRegistry.clearAll();
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(run, 'the run starts, so its writer sequences and buffers the frames');
  const writer = run.writer;
  const feed = (frame: Frame) =>
    forwardNormalizedFrames({
      transformedMessage: frame,
      sessionId: appSessionId,
      turnSessionId: appSessionId,
      normalizeMessage: () => [],
      writer,
    });

  // A background shell: its launching `tool_use` carries `run_in_background:true`,
  // and it terminates only through `task_updated{completed}` — no
  // `task_notification` frame and no CLI row of its own.
  const taskId = 'ac3-bg-bash';
  feed(toolUseLaunchFrame(appSessionId, 'toolu_ac3_bg', 'Bash', true));
  feed(taskStartedFrame(appSessionId, taskId, 'local_bash', 'toolu_ac3_bg'));
  feed(taskUpdatedFrame(appSessionId, taskId, 'completed'));

  const replayed = chatRunRegistry.replayEvents(appSessionId, 0);
  const terminal = replayed.filter((message) => message.kind === 'task_notification');
  say(`AC3 replayed task_notification frames: ${terminal.length} (expect 1)`);
  assert.equal(terminal.length, 1, 'exactly one terminal frame is in the replay buffer');
  assert.equal(terminal[0].status, 'completed', 'the frame carries the terminal status');
  assert.equal(terminal[0].taskId, taskId, 'the frame is joinable to the task table by task id');
  assert.equal(
    terminal[0].id,
    `task-terminal:${taskId}:completed`,
    'the frame id is stable: task id plus terminal state',
  );
  assert.equal(typeof terminal[0].seq, 'number', 'the gateway writer sequenced the frame for replay');

  // A re-subscribe replays the same buffered sequence; the frame is still there,
  // and still only one — the reducer reports a crossing exactly once.
  const replayedAgain = chatRunRegistry
    .replayEvents(appSessionId, 0)
    .filter((message) => message.kind === 'task_notification');
  assert.equal(replayedAgain.length, 1, 'the replay carries the same single frame, not a second one');
  assert.equal(replayedAgain[0].id, terminal[0].id, 'the replayed frame is the identical event');

  chatRunRegistry.clearAll();
});

test('AC4 a subagent terminal adds no second row beside the CLI notification', () => {
  const appSessionId = 'claude-frame-forwarding-dedup-ac4';
  chatRunRegistry.clearAll();
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(run, 'the run starts');
  const writer = run.writer;
  const feed = (frame: Frame) =>
    forwardNormalizedFrames({
      transformedMessage: frame,
      sessionId: appSessionId,
      turnSessionId: appSessionId,
      normalizeMessage: () => [],
      writer,
    });

  // A background agent: the CLI enqueues a `<task-notification>` user row for it,
  // so it already has a terminal line — the server must add none.
  feed(toolUseLaunchFrame(appSessionId, 'toolu_ac4_agent', 'Agent', true));
  feed(taskStartedFrame(appSessionId, 'ac4-subagent', 'local_agent', 'toolu_ac4_agent'));
  feed(taskUpdatedFrame(appSessionId, 'ac4-subagent', 'completed'));

  // A background shell: the CLI writes nothing, so the server frame is the line.
  feed(toolUseLaunchFrame(appSessionId, 'toolu_ac4_shell', 'Bash', true));
  feed(taskStartedFrame(appSessionId, 'ac4-shell', 'local_bash', 'toolu_ac4_shell'));
  feed(taskUpdatedFrame(appSessionId, 'ac4-shell', 'completed'));

  const frames = chatRunRegistry.replayEvents(appSessionId, 0);
  const serverRows = (taskId: string) =>
    frames.filter((message) => message.kind === 'task_notification' && message.taskId === taskId).length;
  // The transcript projection for one task's terminal: the CLI's own notification
  // row (1 for the agent — the CLI mirrors it; 0 for the shell) plus every
  // server-emitted terminal frame for that task.
  const projectedRows = (taskId: string, cliRows: number) => cliRows + serverRows(taskId);

  say(
    `AC4 subagent rows: ${projectedRows('ac4-subagent', 1)} (cli 1 + server ${serverRows('ac4-subagent')}); ` +
      `shell rows: ${projectedRows('ac4-shell', 0)} (cli 0 + server ${serverRows('ac4-shell')})`,
  );
  assert.equal(serverRows('ac4-subagent'), 0, 'the subagent gets no server frame beside the CLI row');
  assert.equal(projectedRows('ac4-subagent', 1), 1, 'the subagent transcript shows exactly one terminal line');
  assert.equal(serverRows('ac4-shell'), 1, 'the shell gets exactly one server frame');
  assert.equal(projectedRows('ac4-shell', 0), 1, 'the shell transcript shows exactly one terminal line');

  chatRunRegistry.clearAll();
});

// ---------------------------------------------------------------------------
// gap-shell-terminal-row-only-true-background (AC1/AC6)
//
// The previous task made a terminal transition leave a transcript line. It
// decided which transitions those were by *kind* alone, and a foreground Bash is
// the same kind as a background one — so every command that finished also left a
// row whose text was the command itself (measured on a real session: 26 such rows
// over 4680px, a `white-space: normal` span up to 72 lines tall). Those rows were
// a duplicate receipt — the tool card already shows the result — and because the
// line is not a tool row it cut every work segment it landed in.
//
// The criterion now reads the call's own `input` (`run_in_background`), which the
// `assistant` frame carries before the `task_started` names the task. These cases
// drive the real forwarder through a real run writer and read the frames a
// reconnecting client would replay, so "no row" and "one row" are facts about the
// shipped path.
// ---------------------------------------------------------------------------

/** Feeds one frame through the real forwarder, with the criterion optionally replaced. */
function feedThrough(
  appSessionId: string,
  writer: Parameters<typeof forwardNormalizedFrames>[0]['writer'],
  frame: Frame,
  runsTaskTerminalRow?: (transition: Parameters<NonNullable<Parameters<typeof forwardNormalizedFrames>[0]['runsTaskTerminalRow']>>[0]) => boolean,
): void {
  forwardNormalizedFrames({
    transformedMessage: frame,
    sessionId: appSessionId,
    turnSessionId: appSessionId,
    normalizeMessage: () => [],
    writer,
    ...(runsTaskTerminalRow ? { runsTaskTerminalRow } : {}),
  });
}

/**
 * Drives one command's whole terminal lifecycle and returns how many
 * `task_notification` frames the run's replay buffer holds for its task.
 *
 * `background` is the launching call's own flag; `terminal` is the frame kind the
 * SDK really ends each case with (a foreground command arrives as an announced
 * `task_notification` carrying its description; a background one as a silent
 * `task_updated{completed}`).
 */
function readTerminalRowCount(
  appSessionId: string,
  taskId: string,
  toolUseId: string,
  background: boolean,
  terminal: 'notification' | 'updated',
  runsTaskTerminalRow?: Parameters<typeof feedThrough>[3],
): number {
  chatRunRegistry.clearAll();
  const run = chatRunRegistry.startRun({
    appSessionId,
    provider: 'claude',
    providerSessionId: null,
    connection: null,
    userId: null,
  });
  assert.ok(run, 'the run starts, so its writer sequences and buffers the frames');
  const feed = (frame: Frame) => feedThrough(appSessionId, run.writer, frame, runsTaskTerminalRow);

  feed(toolUseLaunchFrame(appSessionId, toolUseId, 'Bash', background));
  feed(taskStartedFrame(appSessionId, taskId, 'local_bash', toolUseId));
  if (terminal === 'notification') {
    feed({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status: 'completed',
      // The SDK's foreground summariser sends the call's description as the
      // summary; with none, the command itself. Either way: no status word.
      summary: background ? 'task ' + taskId : 'echo fg-short-ok',
      uuid: `u-notification-${taskId}`,
      session_id: appSessionId,
    });
  } else {
    feed(taskUpdatedFrame(appSessionId, taskId, 'completed'));
  }

  const rows = chatRunRegistry
    .replayEvents(appSessionId, 0)
    .filter((message) => message.kind === 'task_notification' && message.taskId === taskId);
  const count = rows.length;
  chatRunRegistry.clearAll();
  return count;
}

test('AC1 a foreground command leaves no row; a background command leaves exactly one', () => {
  const foreground = readTerminalRowCount(
    'claude-frame-forwarding-fg-ac1',
    'ac1-fg-bash',
    'toolu_ac1_fg',
    false,
    'notification',
  );
  const background = readTerminalRowCount(
    'claude-frame-forwarding-bg-ac1',
    'ac1-bg-bash',
    'toolu_ac1_bg',
    true,
    'updated',
  );

  say(`AC1 foreground Bash task_notification frames: ${foreground} (expect 0)`);
  say(`AC1 background Bash task_notification frames: ${background} (expect 1)`);
  assert.equal(foreground, 0, 'a foreground command must not add a terminal row beside its own tool card');
  assert.equal(background, 1, 'a background command must still leave exactly one terminal row');
});

test('AC6 a criterion that is always true reds the AC1 foreground reading', () => {
  // Distinct session and task ids per arm: the Task Reducer is a module-level
  // singleton keyed by session id and reports a task's crossing only once, so a
  // second run of the same id would read 0 for a reason that has nothing to do
  // with the criterion under test.
  const green = readTerminalRowCount(
    'claude-frame-forwarding-main-ac6',
    'ac6-fg-bash-main',
    'toolu_ac6_fg_main',
    false,
    'notification',
  );
  say(`AC6 main reading: foreground task_notification frames: ${green} (expect 0)`);
  assert.equal(green, 0);

  const mutated = readTerminalRowCount(
    'claude-frame-forwarding-falseform-ac6',
    'ac6-fg-bash-mutated',
    'toolu_ac6_fg_mutated',
    false,
    'notification',
    () => true,
  );
  say(`AC6 false form reading: foreground task_notification frames: ${mutated} (expect > 0)`);
  assert.throws(
    () => {
      assert.equal(mutated, 0);
    },
    'a criterion that is always true must red the foreground reading',
  );
  assert.equal(mutated, 1, 'the mutation really emits the row, it does not merely stay the same');
});
