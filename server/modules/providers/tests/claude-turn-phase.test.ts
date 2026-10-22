import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeTurnTracker } from '@/modules/providers/index.js';
import type { TurnState } from '@/modules/providers/index.js';

/**
 * The Turn Tracker's criterion (AC-186).
 *
 * The fixtures are the frame sequence captured from a real SDK run on
 * 2026-10-01, replayed frame by frame. Each builder below names the shape's
 * source so the fixture can be re-derived rather than trusted:
 *
 *   · `system/thinking_tokens`      — `SDKThinkingTokensMessage` in the SDK's
 *                                     `sdk.d.ts`; the run emitted 215 of them
 *                                     and the server currently ignores all.
 *   · wrapped `content_block_delta` — shape pinned by
 *                                     `claude-stream-event-unwrap.test.ts`.
 *   · `assistant` `tool_use`        — shape from `claude-host-per-run.test.ts`'s
 *                                     `toolMessage()` and §1.2's task table.
 *   · `user` `tool_result`          — shape from `claude-sessions.test.ts`.
 *   · `permission_request/resolved` — the run writer's frames, shape from
 *                                     `claude-resident-permissions.test.ts`.
 *   · `system/compact_boundary`     — shape pinned by `claude-compaction.test.ts`.
 *   · `result`                      — shape from `claude-host-per-run.test.ts`.
 *
 * The captured run emitted **zero** `tool_progress` frames (§1 of
 * `claude-background-work-observability.md`); the duration assertion below is
 * built on that absence.
 */

/** One raw frame, as the run loop hands it to the normalizer. */
type Frame = Record<string, unknown>;

const SESSION = 'claude-turn-phase-1';
const REQUEST_ID = 'perm-186-1';

/** `system/thinking_tokens` — the live thinking-token estimate. */
function thinkingTokens(estimatedTokens: number): Frame {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimatedTokens,
    estimated_tokens_delta: estimatedTokens,
    uuid: 'u-thinking-186',
    session_id: SESSION,
  };
}

/** A `stream_event`-wrapped text `content_block_delta` (the `stream_delta`). */
function textDelta(text: string): Frame {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: 'u-delta-186',
    session_id: SESSION,
  };
}

/** An `assistant` message carrying a `tool_use` block; `parent` marks a subagent. */
function toolUse(id: string, name: string, parent: string | null = null): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    parent_tool_use_id: parent,
    uuid: `u-tool-${id}`,
    session_id: SESSION,
  };
}

/** A settled `assistant` text message — no tool, so no phase of its own. */
function assistantText(text: string): Frame {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: 'u-assistant-text-186',
    session_id: SESSION,
  };
}

/** The `user` message carrying the `tool_result` paired to a `tool_use` id. */
function toolResult(toolUseId: string, parent: string | null = null): Frame {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
    parent_tool_use_id: parent,
    uuid: `u-result-${toolUseId}`,
    session_id: SESSION,
  };
}

/** A `system/compact_boundary` (the live `compact_metadata` spelling). */
function compactBoundary(): Frame {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 1_240_000, post_tokens: 18_000, duration_ms: 45_000 },
    uuid: 'u-compact-186',
    session_id: SESSION,
  };
}

/** The turn's terminal `result`. */
const RESULT: Frame = { type: 'result', subtype: 'success', session_id: SESSION };

/** A settled `system` frame that carries no phase signal. */
const INIT: Frame = { type: 'system', subtype: 'init', session_id: SESSION };

/**
 * The captured turn, in arrival order: a thinking block, streamed text, a Read
 * tool with its result, a compaction, a Bash tool with its result, then the
 * turn's result.
 */
function capturedFrameSequence(): Frame[] {
  return [
    thinkingTokens(180),
    thinkingTokens(275),
    textDelta('Running the '),
    textDelta('check now.'),
    toolUse('toolu_186_read', 'Read'),
    assistantText('Reading the file…'),
    toolResult('toolu_186_read'),
    compactBoundary(),
    toolUse('toolu_186_bash', 'Bash'),
    toolResult('toolu_186_bash'),
    RESULT,
  ];
}

// ---------------------------------------------------------------- AC1..AC3 --

test('AC2 thinking comes from a real thinking_tokens signal', () => {
  const tracker = createClaudeTurnTracker();
  // The frame is what moves it: the same reducer sits at idle until it arrives,
  // and a settled system frame that carries no phase signal never moves it.
  assert.equal(tracker.getTurn(SESSION).phase, 'idle');
  tracker.observe(SESSION, INIT);
  assert.equal(tracker.getTurn(SESSION).phase, 'idle');
  tracker.observe(SESSION, thinkingTokens(120));
  assert.equal(tracker.getTurn(SESSION).phase, 'thinking');
});

test('AC3 writing comes from a real streamed text delta', () => {
  const tracker = createClaudeTurnTracker();
  assert.equal(tracker.getTurn(SESSION).phase, 'idle');
  tracker.observe(SESSION, textDelta('Hel'));
  assert.equal(tracker.getTurn(SESSION).phase, 'writing');
});

test('AC3 a partial frame that carries no text is not writing', () => {
  const tracker = createClaudeTurnTracker();
  // `content_block_stop` arrives on the same wrapper but is not a text delta;
  // claiming `writing` for it would put a phase on every tool boundary.
  tracker.observe(SESSION, {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    uuid: 'u-stop-186',
    session_id: SESSION,
  });
  assert.equal(tracker.getTurn(SESSION).phase, 'idle');
});

// ---------------------------------------------------------------- AC4 ------

test('AC4 tool is named from the tool_use block and ends only on its paired tool_result', () => {
  const tracker = createClaudeTurnTracker();
  tracker.observe(SESSION, thinkingTokens(10));

  tracker.observe(SESSION, toolUse('toolu_186_a', 'Bash'));
  let turn = tracker.getTurn(SESSION);
  assert.equal(turn.phase, 'tool');
  assert.equal(turn.toolName, 'Bash');

  // The reverse form of this criterion is "the tool ends on the next assistant
  // message": a settled assistant message arriving while the tool runs must
  // leave the turn in `tool`, with the name still from the `tool_use` block.
  tracker.observe(SESSION, assistantText('Still running…'));
  turn = tracker.getTurn(SESSION);
  assert.equal(turn.phase, 'tool', 'a following assistant message must not end the tool');
  assert.equal(turn.toolName, 'Bash');

  // Nor does a result for some other tool call.
  tracker.observe(SESSION, toolResult('toolu_186_other'));
  assert.equal(tracker.getTurn(SESSION).phase, 'tool', 'an unpaired tool_result must not end the tool');

  // Only the result carrying this call's id does.
  tracker.observe(SESSION, toolResult('toolu_186_a'));
  turn = tracker.getTurn(SESSION);
  assert.notEqual(turn.phase, 'tool');
  assert.equal(turn.toolName, null);
});

// ---------------------------------------------------------------- AC5 ------

test('AC5 a permission request waits and its resolution restores the phase it interrupted', () => {
  const tracker = createClaudeTurnTracker();
  tracker.observe(SESSION, toolUse('toolu_186_b', 'Bash'));
  assert.equal(tracker.getTurn(SESSION).phase, 'tool');

  tracker.observePermission(SESSION, { kind: 'permission_request', requestId: REQUEST_ID });
  assert.equal(tracker.getTurn(SESSION).phase, 'awaitingPermission');

  tracker.observePermission(SESSION, { kind: 'permission_resolved', requestId: REQUEST_ID });
  // The prompt interrupted a tool; resolution returns there, not to idle.
  assert.equal(tracker.getTurn(SESSION).phase, 'tool');

  // And the paired result still ends the tool the prompt had paused.
  tracker.observe(SESSION, toolResult('toolu_186_b'));
  assert.notEqual(tracker.getTurn(SESSION).phase, 'tool');
});

// ---------------------------------------------------------------- AC6, AC7 -

test('AC6 a compact boundary is compacting', () => {
  const tracker = createClaudeTurnTracker();
  tracker.observe(SESSION, compactBoundary());
  assert.equal(tracker.getTurn(SESSION).phase, 'compacting');
});

test('AC7 a result returns the turn to idle and clears the tool name', () => {
  const tracker = createClaudeTurnTracker();
  tracker.observe(SESSION, toolUse('toolu_186_c', 'Read'));
  assert.equal(tracker.getTurn(SESSION).toolName, 'Read');

  tracker.observe(SESSION, RESULT);
  const turn = tracker.getTurn(SESSION);
  assert.equal(turn.phase, 'idle');
  assert.equal(turn.toolName, null);
});

// ---------------------------------------------------------------- AC8 ------

test('AC8 with no tool_progress frame the duration stays null at every step', () => {
  const frames = capturedFrameSequence();
  assert.equal(
    frames.filter((frame) => frame.type === 'tool_progress').length,
    0,
    'the captured run emitted no tool_progress, so this sequence has no elapsed-time signal',
  );

  const tracker = createClaudeTurnTracker();
  for (const frame of frames) {
    tracker.observe(SESSION, frame);
    assert.equal(
      tracker.getTurn(SESSION).toolDurationMs,
      null,
      'no frame carries an elapsed time, so none may be invented from a clock',
    );
  }
});

// ---------------------------------------------------------------- AC9 ------

test('AC9 two sessions fed interleaved frames never read each other', () => {
  const sessionA = 'claude-turn-phase-a';
  const sessionB = 'claude-turn-phase-b';
  const tracker = createClaudeTurnTracker();

  tracker.observe(sessionA, thinkingTokens(5));
  tracker.observe(sessionB, toolUse('toolu_186_b', 'Bash'));
  tracker.observe(sessionA, textDelta('hi'));

  const a = tracker.getTurn(sessionA);
  const b = tracker.getTurn(sessionB);
  assert.equal(a.phase, 'writing', 'session A reads its own phase');
  assert.equal(a.toolName, null, 'session A must not inherit session B tool name');
  assert.equal(b.phase, 'tool', 'session B reads its own phase');
  assert.equal(b.toolName, 'Bash');

  // Ending B's tool leaves A exactly where it was.
  tracker.observe(sessionB, toolResult('toolu_186_b'));
  assert.equal(tracker.getTurn(sessionA).phase, 'writing');
  assert.notEqual(tracker.getTurn(sessionB).phase, 'tool');

  // A session never observed is idle, not whatever the last one did.
  assert.equal(tracker.getTurn('claude-turn-phase-c').phase, 'idle');
});

// ---------------------------------------------------------------- AC10 -----

test('AC10 subagent frames do not rewrite the main line', () => {
  const tracker = createClaudeTurnTracker();
  tracker.observe(SESSION, thinkingTokens(5));
  const before = tracker.getTurn(SESSION);

  tracker.observe(SESSION, toolUse('toolu_sub', 'Bash', 'toolu_parent'));
  tracker.observe(SESSION, toolResult('toolu_sub', 'toolu_parent'));

  assert.deepEqual(tracker.getTurn(SESSION), before, 'a subagent tool call must not move the main phase');
  assert.equal(tracker.getTurn(SESSION).phase, 'thinking');
  assert.equal(tracker.getTurn(SESSION).toolName, null);

  // The resident path re-spells the marker as `parentToolUseId`; either
  // spelling means the same sidechain.
  tracker.observe(SESSION, {
    ...toolUse('toolu_sub2', 'Read'),
    parent_tool_use_id: null,
    parentToolUseId: 'toolu_parent',
  });
  assert.deepEqual(tracker.getTurn(SESSION), before);
});

// ------------------------------------------------------- the whole sequence -

test('the captured turn ends idle with no tool named', () => {
  const tracker = createClaudeTurnTracker();

  // Walk the sequence and record the phase after each frame, to show the
  // reduction moves with the signals rather than sticking.
  const seen: string[] = [];
  for (const frame of capturedFrameSequence()) {
    tracker.observe(SESSION, frame);
    seen.push(tracker.getTurn(SESSION).phase);
  }

  // thinking, thinking, writing, writing, tool, tool (the assistant message
  // does not end it), writing (the Read result restores), compacting, tool,
  // compacting (the Bash result restores), idle.
  assert.deepEqual(seen, [
    'thinking',
    'thinking',
    'writing',
    'writing',
    'tool',
    'tool',
    'writing',
    'compacting',
    'tool',
    'compacting',
    'idle',
  ]);

  const end: TurnState = tracker.getTurn(SESSION);
  assert.deepEqual(end, { phase: 'idle', toolName: null, toolDurationMs: null });
});
