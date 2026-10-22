/**
 * `dashscope-omni` carries the service's own usage counts out as `meta.usage`.
 *
 * The service states them in the chat envelope (`usage.prompt_tokens_details.audio_tokens`, …) and the
 * adapter used to drop them, so a saved second could be claimed but never read. Nested counts are
 * flattened one level with dotted keys; anything that is not a finite number is not a reading.
 *
 * Run: npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-dashscope-usage.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import '../../../../shared/asr/asrRegistry.js';

/** The adapter is entered after the registry: the reverse order is a TDZ (see voice-provider-dispatch.test.ts). */
const dashscopeOmni = await import(
  '../../../../shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.js'
);

const envelope = (content: string, usage?: unknown): string =>
  JSON.stringify({ choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) });

test('readUsage flattens nested counts and drops non-numbers', () => {
  const usage = dashscopeOmni.readUsage(
    envelope('x', {
      prompt_tokens: 514,
      total_tokens: 1554,
      prompt_tokens_details: { audio_tokens: 107, text_tokens: 407, note: 'ignored' },
      model: 'ignored',
    }),
  );
  assert.deepEqual(usage, {
    prompt_tokens: 514,
    total_tokens: 1554,
    'prompt_tokens_details.audio_tokens': 107,
    'prompt_tokens_details.text_tokens': 407,
  });
});

test('readUsage is undefined when the body states no usage or is not JSON', () => {
  assert.equal(dashscopeOmni.readUsage(envelope('x')), undefined);
  assert.equal(dashscopeOmni.readUsage(envelope('x', {})), undefined);
  assert.equal(dashscopeOmni.readUsage('not json'), undefined);
});

test('transcribe puts the usage on meta for both the written and the degraded answer', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5 };
  const invoke = async (content: string) =>
    dashscopeOmni.transcribe(
      { audio: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav', fileName: 'c.wav' } },
      {
        baseUrl: 'https://dashscope.aliyuncs.com',
        apiKey: 'k',
        model: 'm',
        timeoutMs: 1000,
        fetchImpl: async () => new Response(envelope(content, usage), { status: 200 }),
      },
    );

  const written = await invoke(JSON.stringify({ instruction: '改一下 a.ts', transcript: 't' }));
  assert.ok(written.ok);
  assert.deepEqual(written.meta?.usage, usage);

  const degraded = await invoke('plain prose, no object');
  assert.ok(degraded.ok);
  assert.equal(degraded.style, 'verbatim');
  assert.deepEqual(degraded.meta?.usage, usage);
});
