import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/index.js';

// The Claude SDK only emits Anthropic's raw streaming events when
// `includePartialMessages` is on, and it wraps each one: the frame's own `type`
// is `stream_event` and the event the normalizer has to read sits under
// `event`. A normalizer that dispatches on the outer shape therefore never
// matches, and `stream_delta`/`stream_end` stay unreachable — which is what a
// transcript that is supposed to grow in place depends on.
//
// The settled `assistant` record remains the authority and is asserted here as
// well: the partial frames are transient, and the contract is that unwrapping
// them changes nothing about how a finished row normalizes.

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-stream-event-1';

/** One partial frame, as the SDK hands it to the runtime loop. */
const streamEvent = (event: Record<string, unknown>) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: null,
  uuid: 'u-stream-1',
  session_id: SESSION_ID,
});

test('a wrapped content_block_delta becomes one stream_delta carrying its text', () => {
  const rows = provider.normalizeMessage(
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
    SESSION_ID,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'stream_delta');
  assert.equal(rows[0].content, 'Hel');
  assert.equal(rows[0].sessionId, SESSION_ID);
  assert.equal(rows[0].provider, 'claude');
});

test('a wrapped content_block_stop becomes one stream_end and ends with no text', () => {
  const rows = provider.normalizeMessage(
    streamEvent({ type: 'content_block_stop', index: 0 }),
    SESSION_ID,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'stream_end');
  assert.equal(rows[0].sessionId, SESSION_ID);
  assert.equal(rows[0].provider, 'claude');
});

test('every other wrapped event is dropped rather than rendered as a row', () => {
  // The type is the discriminator: a `content_block_stop`-less run still
  // delivers message_start/message_delta/message_stop around the deltas, and
  // any of them read as a message would put a bubble in the transcript for
  // something the user never saw.
  for (const event of [
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ]) {
    assert.deepEqual(provider.normalizeMessage(streamEvent(event), SESSION_ID), [], event.type);
  }
});

test('the unwrapping reads the delta, so a delta with no text sends nothing', () => {
  // A `text_delta` with an empty `text` would flush a zero-length update to
  // every client; the streaming path is keyed on content, not on the frame.
  assert.deepEqual(
    provider.normalizeMessage(
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } }),
      SESSION_ID,
    ),
    [],
  );
});

test('the settled assistant record still normalizes to its own text row', () => {
  // The authority the streaming path must not disturb: the whole reply lands as
  // one `assistant` record and becomes exactly one text row, whatever partial
  // frames preceded it.
  const rows = provider.normalizeMessage({
    type: 'assistant',
    uuid: 'u-assistant-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    session_id: SESSION_ID,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Hello there' }] },
  }, SESSION_ID);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'text');
  assert.equal(rows[0].role, 'assistant');
  assert.equal(rows[0].content, 'Hello there');
  // Not a streaming row: the settled record is not re-labelled by the unwrap.
  assert.notEqual(rows[0].kind, 'stream_delta');
});
