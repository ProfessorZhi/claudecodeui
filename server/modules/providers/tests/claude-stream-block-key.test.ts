import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider, forwardNormalizedFrames } from '@/modules/providers/index.js';
import { countOpenStreamBlocks } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// Claude's live streaming frames carry no identity of their own: a `stream_delta`
// is keyed only by the SDK's random frame id, and the settled block-level
// `assistant` record names no index at all. Without a join key a client can only
// fold a streaming fragment onto the row it becomes by comparing text and hoping
// the two are adjacent — and the duplicate pair that leaves behind is erased by a
// page reload, which is the defect this field exists to make fixable.
//
// These cases drive the real normalizer through the real live exit
// (`forwardNormalizedFrames`) with the frame order captured from
// `@anthropic-ai/claude-agent-sdk` 0.3.165 with `includePartialMessages: true`
// for a "thinking → text → Bash → text" turn:
//
//   message_start{id} → content_block_start{index} → content_block_delta{index}…
//     → assistant(that block's settled record) → content_block_stop{index}
//
// and the next message restarts `index` at 0 under a new `message.id`. The join
// key is `<message.id>:<index>`, and it has to land on a block's streaming
// fragments, the `stream_end` that closes it, and its settled record alike.

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-stream-block-key-1';
const OTHER_SESSION_ID = 'claude-stream-block-key-2';

/** The message id the captured first message ran under. */
const MESSAGE_ONE_ID = 'msg_01AAAAAAAA';
/** The message id the captured second message ran under. */
const MESSAGE_TWO_ID = 'msg_02BBBBBBBB';

type Frame = Record<string, unknown>;

/** A stand-in for the run writer that records what it is handed (per-run or resident). */
function recordingWriter(): { frames: Frame[]; send: (message: Frame) => void } {
  const frames: Frame[] = [];
  return {
    frames,
    send: (message: Frame) => {
      frames.push(message);
    },
  };
}

/** Feeds SDK frames through the live exit, exactly as the run loop and host driver do. */
function drive(
  writer: { send: (message: Frame) => void },
  frames: Frame[],
  sessionId: string = SESSION_ID,
): void {
  for (const frame of frames) {
    forwardNormalizedFrames({
      transformedMessage: frame,
      sessionId,
      normalizeMessage: (raw: unknown, sid: string | null) => provider.normalizeMessage(raw, sid),
      writer,
    });
  }
}

/**
 * One wrapped Anthropic streaming event, as the SDK hands it over.
 *
 * A subagent's frames travel with `parent_tool_use_id`, which the run loop's
 * `transformMessage` (and the resident host's `transformResidentMessage`) copies
 * onto `parentToolUseId`; the test drives the post-transform shape, so it sets
 * both.
 */
function streamEvent(event: Frame, parentToolUseId?: string): Frame {
  return {
    type: 'stream_event',
    event,
    parent_tool_use_id: parentToolUseId ?? null,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    uuid: 'u-stream-1',
    session_id: SESSION_ID,
  };
}

/** One settled block-level `assistant` record: content holds a single block. */
function settled(
  uuid: string,
  messageId: string,
  content: Frame[],
  parentToolUseId?: string,
): Frame {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-10-01T00:00:00.000Z',
    session_id: SESSION_ID,
    message: { id: messageId, role: 'assistant', content },
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId, parentToolUseId } : {}),
  };
}

/** The captured frame order for one message: thinking (0) → text (1) → Bash (2). */
function threeBlockMessage(messageId: string): Frame[] {
  return [
    streamEvent({ type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } }),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'weighing' } }),
    settled('u-think-1', messageId, [{ type: 'thinking', thinking: 'weighing' }]),
    streamEvent({ type: 'content_block_stop', index: 0 }),
    streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hi there' } }),
    settled('u-text-1', messageId, [{ type: 'text', text: 'Hi there' }]),
    streamEvent({ type: 'content_block_stop', index: 1 }),
    streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } }),
    streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } }),
    settled('u-tool-1', messageId, [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi' } }]),
    streamEvent({ type: 'content_block_stop', index: 2 }),
    streamEvent({ type: 'message_stop' }),
  ];
}

test('a streaming fragment and the stream_end that closes its block carry the block key', () => {
  const writer = recordingWriter();
  drive(writer, threeBlockMessage(MESSAGE_ONE_ID));

  // Every streaming byte of the message, in order: each fragment reads the index
  // of the block it is growing, and the stream_end that closes a block reads that
  // same index — the thinking block at 0, the text block at 1, Bash at 2.
  const streamed = writer.frames.filter(
    (frame) => frame.kind === 'stream_delta' || frame.kind === 'stream_end',
  );
  assert.deepEqual(
    streamed.map((frame) => ({ kind: frame.kind, blockKey: frame.blockKey })),
    [
      { kind: 'stream_end', blockKey: `${MESSAGE_ONE_ID}:0` },
      { kind: 'stream_delta', blockKey: `${MESSAGE_ONE_ID}:1` },
      { kind: 'stream_end', blockKey: `${MESSAGE_ONE_ID}:1` },
      { kind: 'stream_end', blockKey: `${MESSAGE_ONE_ID}:2` },
    ],
  );

  const delta = writer.frames.find((frame) => frame.kind === 'stream_delta');
  assert.equal(delta?.content, 'Hi there');
});

test('each block’s settled record — text, thinking and tool_use — carries its block key', () => {
  const writer = recordingWriter();
  drive(writer, threeBlockMessage(MESSAGE_ONE_ID));

  // The settled records the stream settles into, in block order. The text row
  // keeps the id it always had (`<uuid>_<partIndex>`): the key is added, nothing
  // about the existing identity moves.
  const settledRows = writer.frames.filter(
    (frame) => frame.kind === 'text' || frame.kind === 'thinking' || frame.kind === 'tool_use',
  );
  assert.deepEqual(
    settledRows.map((frame) => ({ kind: frame.kind, id: frame.id, blockKey: frame.blockKey })),
    [
      { kind: 'thinking', id: 'u-think-1_0', blockKey: `${MESSAGE_ONE_ID}:0` },
      { kind: 'text', id: 'u-text-1_0', blockKey: `${MESSAGE_ONE_ID}:1` },
      { kind: 'tool_use', id: 'u-tool-1_0', blockKey: `${MESSAGE_ONE_ID}:2` },
    ],
  );

  const textRow = writer.frames.find((frame) => frame.kind === 'text');
  assert.equal(textRow?.content, 'Hi there');
});

test('thinking and tool_use blocks carry their own key, and a second message restarts at index 0', () => {
  const writer = recordingWriter();
  drive(writer, threeBlockMessage(MESSAGE_ONE_ID));
  drive(writer, [
    streamEvent({ type: 'message_start', message: { id: MESSAGE_TWO_ID, role: 'assistant', content: [] } }),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Second message' } }),
    settled('u-text-2', MESSAGE_TWO_ID, [{ type: 'text', text: 'Second message' }]),
    streamEvent({ type: 'content_block_stop', index: 0 }),
    streamEvent({ type: 'message_stop' }),
  ]);

  const thinking = writer.frames.find((frame) => frame.kind === 'thinking');
  assert.equal(thinking?.blockKey, `${MESSAGE_ONE_ID}:0`);

  const toolUse = writer.frames.find((frame) => frame.kind === 'tool_use');
  assert.equal(toolUse?.blockKey, `${MESSAGE_ONE_ID}:2`);

  const secondText = writer.frames.find((frame) => frame.id === 'u-text-2_0');
  assert.equal(secondText?.blockKey, `${MESSAGE_TWO_ID}:0`);
  // Same index, different message — the id is what keeps the two keys apart.
  assert.notEqual(secondText?.blockKey, `${MESSAGE_ONE_ID}:0`);
});

test('the history read path never stamps a blockKey, even with a live block open on the same provider', () => {
  const writer = recordingWriter();
  // Leave the live path mid-block: `message_start` + `content_block_start` make
  // the tracker's "currently open block" non-empty.
  drive(writer, [
    streamEvent({ type: 'message_start', message: { id: 'msg_live', role: 'assistant', content: [] } }),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  ]);
  // Positive control: something really is open, so "no key" below is the read
  // path's doing rather than an empty tracker.
  assert.equal(countOpenStreamBlocks(writer), 1);

  // The same provider instance, asked for one history `assistant` row.
  const rows = provider.normalizeMessage(
    settled('u-history-1', 'msg_history', [{ type: 'text', text: 'read from disk' }]),
    SESSION_ID,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].content, 'read from disk');
  assert.equal(rows[0].blockKey, undefined);
  assert.ok(!('blockKey' in rows[0]));
});

test('interleaved sessions and a subagent never share a block', () => {
  const writer = recordingWriter();
  const messageA = 'msg_session_a';
  const messageB = 'msg_session_b';
  const messageSub = 'msg_subagent';

  drive(writer, [streamEvent({ type: 'message_start', message: { id: messageA, role: 'assistant', content: [] } })], SESSION_ID);
  drive(writer, [streamEvent({ type: 'message_start', message: { id: messageB, role: 'assistant', content: [] } })], OTHER_SESSION_ID);
  drive(writer, [streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })], SESSION_ID);
  drive(writer, [streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })], OTHER_SESSION_ID);
  drive(writer, [streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'from A' } })], SESSION_ID);
  drive(writer, [streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'from B' } })], OTHER_SESSION_ID);

  const deltas = writer.frames.filter((frame) => frame.kind === 'stream_delta');
  assert.deepEqual(deltas.map((frame) => frame.blockKey), [`${messageA}:1`, `${messageB}:0`]);

  // Leave the main session open at index 2, then interleave a subagent's own
  // stream events (they carry `parentToolUseId`).
  drive(writer, [streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })], SESSION_ID);
  drive(writer, [
    streamEvent({ type: 'message_start', message: { id: messageSub, role: 'assistant', content: [] } }, 'toolu_sub'),
    streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'toolu_sub'),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'subagent' } }, 'toolu_sub'),
  ], SESSION_ID);
  drive(writer, [streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'main again' } })], SESSION_ID);

  const subDelta = writer.frames.find((frame) => frame.content === 'subagent');
  const mainDelta = writer.frames.find((frame) => frame.content === 'main again');
  assert.equal(subDelta?.blockKey, `${messageSub}:0`);
  // The main line's key is unchanged by the subagent's interleaved stream.
  assert.equal(mainDelta?.blockKey, `${messageA}:2`);
});

test('a settled record after message_stop carries no key, and finished messages leave no tracker entries', () => {
  const writer = recordingWriter();
  drive(writer, threeBlockMessage(MESSAGE_ONE_ID));
  // `message_stop` closed the message, so nothing is open any more.
  assert.equal(countOpenStreamBlocks(writer), 0);

  drive(writer, [settled('u-orphan-1', MESSAGE_ONE_ID, [{ type: 'text', text: 'after the message ended' }])]);
  const orphan = writer.frames[writer.frames.length - 1];
  assert.equal(orphan.kind, 'text');
  // It does not inherit the key of the block that was last open.
  assert.equal(orphan.blockKey, undefined);
  assert.ok(!('blockKey' in orphan));

  // A hundred finished messages leave nothing for the session behind.
  const manyWriter = recordingWriter();
  for (let index = 0; index < 100; index++) {
    drive(manyWriter, threeBlockMessage(`msg_${index}`));
  }
  assert.equal(countOpenStreamBlocks(manyWriter), 0);
});

test('the resident call shape — a plain writer object — reaches the same keyed frames', () => {
  // The resident host drives the same exit with the same message shape (its
  // `transformResidentMessage` maps `parent_tool_use_id` exactly as the per-run
  // `transformMessage` does) and a writer object that only has to support
  // `send`, so a fake one stands in for the real writer here.
  const writer = recordingWriter();
  drive(writer, threeBlockMessage(MESSAGE_ONE_ID));

  const delta = writer.frames.find((frame) => frame.kind === 'stream_delta');
  const textRow = writer.frames.find((frame) => frame.kind === 'text');
  assert.equal(delta?.blockKey, `${MESSAGE_ONE_ID}:1`);
  assert.equal(textRow?.blockKey, `${MESSAGE_ONE_ID}:1`);
});
