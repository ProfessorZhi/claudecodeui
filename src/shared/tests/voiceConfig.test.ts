import assert from 'node:assert/strict';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { configRequest, saveConfigRequest } = vi.hoisted(() => ({
  configRequest: vi.fn(),
  saveConfigRequest: vi.fn(),
}));

// The settings live in module memory and reach the server through `api`, so the
// endpoint map is replaced wholesale: no test here may touch the network.
vi.mock('@/shared/api', () => ({
  api: {
    voice: {
      config: configRequest,
      saveConfig: saveConfigRequest,
    },
  },
}));

import {
  readVoiceConfig,
  resetVoiceConfig,
  updateVoiceConfig,
  VOICE_CONFIG_DEFAULTS,
  VOICE_CONFIG_STORAGE_KEY,
  voiceConfigHeaders,
  whenVoiceConfigReady,
} from '@/shared/voiceConfig';

/**
 * `voiceConfigHeaders` decides what leaves the browser: it attaches the user's
 * own API key to the voice proxy request. An empty field must be omitted rather
 * than sent blank, because the server falls back to its env defaults only for
 * headers that are absent — sending `x-voice-api-key: ''` would authenticate
 * every user's transcription against nothing.
 *
 * The settings themselves now arrive from the server rather than from
 * localStorage, so these cases set the store the way the app does: by hydrating
 * it from an answer. `voiceConfigHydration.test.ts` covers the migration and the
 * call paths; this file covers what the store holds and what it emits.
 */

/** A `Response`-shaped value; only `ok`, `status` and `json()` are ever read. */
const jsonResponse = (body: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Replaces the in-memory copy with what the server answers for `settings`. */
async function loadFromServer(settings: unknown, ok = true): Promise<void> {
  resetVoiceConfig();
  configRequest.mockResolvedValue(jsonResponse(settings, ok));
  await whenVoiceConfigReady();
}

beforeEach(() => {
  localStorage.clear();
  configRequest.mockReset();
  saveConfigRequest.mockReset();
  saveConfigRequest.mockResolvedValue(jsonResponse(VOICE_CONFIG_DEFAULTS));
  resetVoiceConfig();
  configRequest.mockResolvedValue(jsonResponse(VOICE_CONFIG_DEFAULTS));
});

afterEach(() => {
  // Also drops any debounced save still waiting to fire, so it cannot land in
  // the middle of the next case.
  resetVoiceConfig();
  vi.useRealTimers();
});

test("the server's saved settings read back field for field", async () => {
  await loadFromServer({
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-test',
    sttModel: 'whisper-large-v3',
    ttsModel: 'playai-tts',
    ttsVoice: 'Arista-PlayAI',
    ttsFormat: 'mp3',
  });

  // The answer names the six fields that predate the recogniser's own; it reads
  // back as the whole document, because one document is what the server stores
  // and an absent column is the empty string.
  assert.deepEqual(readVoiceConfig(), {
    ...VOICE_CONFIG_DEFAULTS,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-test',
    sttModel: 'whisper-large-v3',
    ttsModel: 'playai-tts',
    ttsVoice: 'Arista-PlayAI',
    ttsFormat: 'mp3',
  });
});

test('a user with nothing saved sends no headers at all', async () => {
  await loadFromServer(VOICE_CONFIG_DEFAULTS);

  assert.deepEqual(voiceConfigHeaders(), {});
});

test('an empty api key is omitted, not sent blank', async () => {
  await loadFromServer({ apiKey: '', sttModel: 'whisper-1' });

  const headers = voiceConfigHeaders();
  assert.equal('x-voice-api-key' in headers, false);
  assert.equal(headers['x-voice-stt-model'], 'whisper-1');
});

test('each configured field maps to its own header', async () => {
  await loadFromServer({
    apiKey: 'sk-test',
    sttModel: 'whisper-1',
    ttsModel: 'tts-1',
    ttsVoice: 'alloy',
    ttsFormat: 'mp3',
  });

  assert.deepEqual(voiceConfigHeaders(), {
    'x-voice-api-key': 'sk-test',
    'x-voice-stt-model': 'whisper-1',
    'x-voice-tts-model': 'tts-1',
    'x-voice-tts-voice': 'alloy',
    'x-voice-tts-format': 'mp3',
  });
});

test('baseUrl is never sent as a header', async () => {
  // It is the client's own target, not something the proxy is told to trust.
  await loadFromServer({ baseUrl: 'https://example.test', apiKey: 'sk-test' });

  assert.deepEqual(Object.keys(voiceConfigHeaders()), ['x-voice-api-key']);
});

test('a whitespace-only tts format is treated as unset', async () => {
  await loadFromServer({ ttsFormat: '   ' });

  assert.deepEqual(voiceConfigHeaders(), {});
});

test('a padded tts format is trimmed before being sent', async () => {
  await loadFromServer({ ttsFormat: '  mp3  ' });

  assert.equal(voiceConfigHeaders()['x-voice-tts-format'], 'mp3');
});

test('a non-string field is discarded rather than coerced into a header', async () => {
  await loadFromServer({ apiKey: 12345, sttModel: 'whisper-1' });

  assert.deepEqual(voiceConfigHeaders(), { 'x-voice-stt-model': 'whisper-1' });
  assert.equal(readVoiceConfig().apiKey, '');
});

test('an answer that is not a settings object leaves the defaults in place', async () => {
  await loadFromServer(['apiKey']);

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
});

test('a settings request that failed leaves the empty defaults rather than throwing', async () => {
  // This runs on the voice-call path; a throw here would break voice input
  // rather than degrade it to the server's own configuration.
  await loadFromServer({}, false);

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
  assert.deepEqual(voiceConfigHeaders(), {});
});

test('each read returns its own object, so a caller cannot mutate the store', async () => {
  const first = readVoiceConfig();
  first.apiKey = 'leaked';

  assert.equal(readVoiceConfig().apiKey, '');
  assert.equal(VOICE_CONFIG_DEFAULTS.apiKey, '');
});

test('an edit is visible to every reader immediately', async () => {
  updateVoiceConfig({ apiKey: 'sk-typed' });

  assert.equal(readVoiceConfig().apiKey, 'sk-typed');
  assert.equal(voiceConfigHeaders()['x-voice-api-key'], 'sk-typed');
});

test('an edit the save could not deliver stays in memory', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  saveConfigRequest.mockRejectedValue(new Error('offline'));

  vi.useFakeTimers();
  updateVoiceConfig({ baseUrl: 'https://api.groq.com/openai/v1' });
  await vi.advanceTimersByTimeAsync(400);

  expect(saveConfigRequest).toHaveBeenCalledTimes(1);
  assert.equal(readVoiceConfig().baseUrl, 'https://api.groq.com/openai/v1');
  consoleError.mockRestore();
});

test('a patch leaves the fields it does not mention alone', async () => {
  await loadFromServer({ apiKey: 'sk-test', sttModel: 'whisper-1' });

  updateVoiceConfig({ sttModel: 'whisper-large-v3' });

  assert.deepEqual(readVoiceConfig(), {
    ...VOICE_CONFIG_DEFAULTS,
    apiKey: 'sk-test',
    sttModel: 'whisper-large-v3',
  });
});

test('typing collapses into one save of the whole document', async () => {
  vi.useFakeTimers();

  updateVoiceConfig({ baseUrl: 'https://api.groq.com/openai/v1' });
  updateVoiceConfig({ apiKey: 'sk-' });
  updateVoiceConfig({ apiKey: 'sk-secret' });

  expect(saveConfigRequest).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(400);

  expect(saveConfigRequest).toHaveBeenCalledTimes(1);
  assert.deepEqual(saveConfigRequest.mock.calls[0][0], {
    ...VOICE_CONFIG_DEFAULTS,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'sk-secret',
  });
});

test('an edit never writes the settings back into browser storage', async () => {
  vi.useFakeTimers();

  updateVoiceConfig({ apiKey: 'sk-must-not-be-persisted' });
  await vi.advanceTimersByTimeAsync(400);

  assert.equal(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY), null);
  assert.equal(localStorage.length, 0);
});

test('a session change drops the previous session’s settings before the next read', async () => {
  await loadFromServer({ apiKey: 'sk-first-session' });
  assert.equal(readVoiceConfig().apiKey, 'sk-first-session');

  // The next session's token: `whenVoiceConfigReady` must not hand the previous
  // user's key to a caller while the new fetch is in flight.
  localStorage.setItem('auth-token', 'session-two');
  configRequest.mockResolvedValue(jsonResponse({ apiKey: 'sk-second-session' }));
  const ready = whenVoiceConfigReady();

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);

  await ready;

  assert.equal(readVoiceConfig().apiKey, 'sk-second-session');
});
