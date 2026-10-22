import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { setVoiceProviderProfile, transcribeVoice } from '@/shared/api';
import { resetVoiceConfig, VOICE_CONFIG_DEFAULTS } from '@/shared/voiceConfig';
import { tryResolve } from '@shared/asr/asrRegistry';

/**
 * The shared backend (`baseUrl`, `apiKey`, `sttModel`) has the lowest priority: the Recognition
 * service the user saved decides the route, and only a remote recogniser reached directly may use
 * those fields.
 *
 * The settings below are the shape that went wrong in use — a Groq address and key left behind in
 * the shared fields after the user chose a local recogniser. `fetch` is the seam, so the real
 * `transcribeVoice` runs and the assertions read which URLs it actually called.
 */

const CONFIG_URL = '/api/voice/config';
const PROXY_URL = '/api/voice/transcribe';
const SHARED_ORIGIN = 'https://api.groq.test';

const LEFTOVER_SHARED_BACKEND = {
  baseUrl: `${SHARED_ORIGIN}/openai/v1`,
  apiKey: 'sk-left-behind',
  sttModel: 'whisper-large-v3-turbo',
};

let storedSettings: Record<string, unknown> = {};
let calls: { url: string; headers: Record<string, string> }[] = [];

const sharedBackendCalls = () => calls.filter((call) => call.url.startsWith(SHARED_ORIGIN));
const proxyCalls = () => calls.filter((call) => call.url === PROXY_URL);

beforeEach(() => {
  calls = [];
  storedSettings = {};
  resetVoiceConfig();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url === CONFIG_URL) {
        return new Response(JSON.stringify({ ...VOICE_CONFIG_DEFAULTS, ...storedSettings }), { status: 200 });
      }
      return new Response(JSON.stringify({ text: 'transcribed' }), { status: 200 });
    }),
  );
});

afterEach(() => {
  setVoiceProviderProfile(null);
  resetVoiceConfig();
  vi.unstubAllGlobals();
});

/** The capabilities the registry declares for `id`; the test fails loudly if the id is gone. */
function declared(id: string) {
  const adapter = tryResolve(id);
  expect(adapter, `the registry no longer registers '${id}'`).not.toBeNull();
  return adapter!.capabilities;
}

test('a local recogniser never reaches the shared backend, whatever address and key it left behind', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: 'sensevoice-local' };
  setVoiceProviderProfile({ id: 'sensevoice-local', capabilities: declared('sensevoice-local') });

  const response = await transcribeVoice(new Blob(['audio']), 'recording.wav');

  expect(response.status).toBe(200);
  expect(sharedBackendCalls()).toEqual([]);
  expect(proxyCalls()).toHaveLength(1);
  expect(proxyCalls()[0].headers['x-voice-provider']).toBe('sensevoice-local');
});

test('the saved choice wins over a stale or missing health reading', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: 'sensevoice-local' };

  // Nothing published yet: the old behaviour fell through to the shared backend here.
  await transcribeVoice(new Blob(['audio']), 'recording.wav');
  expect(sharedBackendCalls()).toEqual([]);
  expect(proxyCalls()[0].headers['x-voice-provider']).toBe('sensevoice-local');

  // A reading published for the provider the user used BEFORE saving: the header follows the
  // saved choice, not the reading.
  calls = [];
  setVoiceProviderProfile({ id: 'dashscope-omni', capabilities: declared('dashscope-omni') });
  await transcribeVoice(new Blob(['audio']), 'recording.wav');
  expect(sharedBackendCalls()).toEqual([]);
  expect(proxyCalls()[0].headers['x-voice-provider']).toBe('sensevoice-local');
});

test('dashscope-omni goes through the server and never to the shared backend', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: 'dashscope-omni' };

  await transcribeVoice(new Blob(['audio']), 'recording.wav');

  expect(sharedBackendCalls()).toEqual([]);
  expect(proxyCalls()[0].headers['x-voice-provider']).toBe('dashscope-omni');
});

test('control: a remote recogniser reached directly still uses the shared backend', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: 'openai-compatible' };

  await transcribeVoice(new Blob(['audio']), 'recording.wav');

  expect(sharedBackendCalls()).toHaveLength(1);
  expect(proxyCalls()).toEqual([]);
});

test('control: no saved provider keeps the pre-provider behaviour — the shared backend, directly', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: '' };

  await transcribeVoice(new Blob(['audio']), 'recording.wav');

  expect(sharedBackendCalls()).toHaveLength(1);
  expect(proxyCalls()).toEqual([]);
});

test('a saved id this build does not register is refused instead of falling through to the shared backend', async () => {
  storedSettings = { ...LEFTOVER_SHARED_BACKEND, providerId: 'no-such-recogniser' };

  const response = await transcribeVoice(new Blob(['audio']), 'recording.wav');

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('no-such-recogniser') });
  expect(sharedBackendCalls()).toEqual([]);
  expect(proxyCalls()).toEqual([]);
});
