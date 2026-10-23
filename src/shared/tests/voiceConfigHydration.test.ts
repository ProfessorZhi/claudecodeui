import assert from 'node:assert/strict';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { transcribeVoice } from '@/shared/api';
import {
  readVoiceConfig,
  resetVoiceConfig,
  VOICE_CONFIG_DEFAULTS,
  VOICE_CONFIG_STORAGE_KEY,
  whenVoiceConfigReady,
} from '@/shared/voiceConfig';

/**
 * How the voice settings arrive, and what changes because they now arrive
 * asynchronously.
 *
 * Three things have to hold, and none of them can be checked from the store's
 * own file: the settings come from the server; the first voice call of a session
 * waits for them instead of mistaking "not loaded yet" for "no backend
 * configured" and quietly posting the recording to the CloudCLI proxy; and the
 * pre-server `voiceConfig` localStorage key is imported once and then removed,
 * so the API key stops living in browser storage without the user losing the
 * configuration they already had.
 *
 * `fetch` is the seam rather than `@/shared/api`, because the last of those is
 * a statement about `transcribeVoice` itself — the real one has to run.
 */

type FakeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
};

/** Only `ok`, `status`, `json()`, `text()` and `headers.get()` are ever read. */
function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const CONFIG_URL = '/api/voice/config';
const PROXY_TRANSCRIBE_URL = '/api/voice/transcribe';
const USER_BACKEND_ORIGIN = 'https://voice.example.test';

const SERVER_SETTINGS = {
  baseUrl: `${USER_BACKEND_ORIGIN}/v1`,
  apiKey: 'sk-server-key',
  sttModel: 'whisper-large-v3',
  ttsModel: 'playai-tts',
  ttsVoice: 'Arista-PlayAI',
  ttsFormat: 'mp3',
};

const LEGACY_SETTINGS = {
  baseUrl: 'https://legacy.example.test/v1',
  apiKey: 'sk-legacy-key',
  sttModel: 'whisper-legacy',
  ttsModel: 'tts-legacy',
  ttsVoice: 'legacy-voice',
  ttsFormat: 'wav',
};

/**
 * What either payload above reads back as, and what the whole-document save of
 * it carries.
 *
 * Both fixtures name only the six fields that predate the recogniser's own, and
 * that is deliberate — they are what an older server and an older browser key
 * actually hold. Read back they are the whole document: the settings are stored
 * as ONE document and an absent column is the empty string, so keeping the two
 * sides of every comparison below in that same shape is what lets them stay
 * exact rather than loosened to a subset.
 */
const asStored = (fields: Record<string, string>) => ({ ...VOICE_CONFIG_DEFAULTS, ...fields });

let requests: { url: string; method: string; body: unknown }[] = [];
let configBody: unknown = SERVER_SETTINGS;
let configStatus = 200;
/** Held open to observe the state of a caller while the settings are in flight. */
let configGate: { promise: Promise<void>; release: () => void } | null = null;
let saveResponse: () => FakeResponse = () => jsonResponse(SERVER_SETTINGS);

const requestedUrls = () => requests.map((request) => request.url);

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  requests.push({ url, method, body: init?.body });

  if (url === CONFIG_URL) {
    if (method === 'PUT') {
      return saveResponse();
    }
    if (configGate) {
      await configGate.promise;
    }
    return jsonResponse(configBody, configStatus);
  }

  if (url.startsWith(USER_BACKEND_ORIGIN)) {
    return jsonResponse({ text: 'transcribed by the user backend' });
  }

  // Everything else, including the proxy, answers but is never expected: the
  // assertions below name the URLs they require, so a call that lands here shows
  // up as a missing direct call rather than as a silent success.
  return jsonResponse({ text: 'transcribed by the CloudCLI proxy' });
});

beforeEach(() => {
  requests = [];
  configBody = SERVER_SETTINGS;
  configStatus = 200;
  configGate = null;
  saveResponse = () => jsonResponse(SERVER_SETTINGS);
  localStorage.clear();
  resetVoiceConfig();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  resetVoiceConfig();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the settings are read from the server for the signed-in user', async () => {
  await whenVoiceConfigReady();

  assert.deepEqual(readVoiceConfig(), asStored(SERVER_SETTINGS));
  assert.deepEqual(requestedUrls(), [CONFIG_URL]);
});

test('the first voice call waits for the settings instead of falling through to the proxy', async () => {
  const gate = deferred();
  configGate = gate;

  const call = transcribeVoice(new Blob(['audio']), 'recording.webm');

  // The call has not chosen an endpoint yet: the settings it decides from are
  // still in flight. Choosing now would read the empty defaults and post the
  // recording to the proxy, which is the failure this whole move exists to
  // avoid — the user's backend would look unconfigured on every fresh load.
  expect(requestedUrls()).toEqual([CONFIG_URL]);

  gate.release();
  await call;

  expect(requestedUrls()).toEqual([CONFIG_URL, `${USER_BACKEND_ORIGIN}/v1/audio/transcriptions`]);
  expect(requestedUrls()).not.toContain(PROXY_TRANSCRIBE_URL);
});

test('a voice call with the settings already loaded goes straight to the user’s backend', async () => {
  await whenVoiceConfigReady();
  requests = [];

  await transcribeVoice(new Blob(['audio']), 'recording.webm');

  assert.deepEqual(requestedUrls(), [`${USER_BACKEND_ORIGIN}/v1/audio/transcriptions`]);
  assert.equal(
    (requests[0].body as FormData).get('model'),
    'whisper-large-v3',
    'the stored speech-to-text model is the one sent',
  );
});

test('a legacy localStorage key is imported into the empty server and then removed', async () => {
  localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(LEGACY_SETTINGS));
  configBody = VOICE_CONFIG_DEFAULTS;

  await whenVoiceConfigReady();

  // Adopted, so voice keeps working for a user whose settings only ever existed
  // in this browser...
  assert.deepEqual(readVoiceConfig(), asStored(LEGACY_SETTINGS));

  // ...pushed to the server as one document...
  const put = requests.find((request) => request.url === CONFIG_URL && request.method === 'PUT');
  assert.ok(put, 'the legacy settings must be sent to the server');
  assert.deepEqual(JSON.parse(String(put.body)), asStored(LEGACY_SETTINGS));

  // ...and only then removed. This is the moment the API key stops living in
  // browser storage.
  assert.equal(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY), null);
});

test('a legacy key whose import was refused stays behind to be retried', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(LEGACY_SETTINGS));
  configBody = VOICE_CONFIG_DEFAULTS;
  saveResponse = () => jsonResponse({ error: 'storage unavailable' }, 500);

  await whenVoiceConfigReady();

  // Deleting the key on a refused write would destroy the only copy of a
  // configuration the server never received.
  assert.equal(
    localStorage.getItem(VOICE_CONFIG_STORAGE_KEY),
    JSON.stringify(LEGACY_SETTINGS),
  );
  // The values are still in memory, so this session can still use them.
  assert.deepEqual(readVoiceConfig(), asStored(LEGACY_SETTINGS));
});

test('a server that already has settings wins over the legacy key, which is removed', async () => {
  localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(LEGACY_SETTINGS));
  configBody = SERVER_SETTINGS;

  await whenVoiceConfigReady();

  assert.deepEqual(readVoiceConfig(), asStored(SERVER_SETTINGS));
  assert.equal(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY), null);
  // The other profile's older values must not overwrite what was saved
  // elsewhere, so the legacy document is never sent.
  assert.equal(
    requests.some((request) => request.method === 'PUT'),
    false,
  );
});

test('a legacy key holding something unusable is removed rather than re-read forever', async () => {
  localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, '{not json');
  configBody = VOICE_CONFIG_DEFAULTS;

  await whenVoiceConfigReady();

  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
  assert.equal(localStorage.getItem(VOICE_CONFIG_STORAGE_KEY), null);
});

test('an unreachable server keeps the legacy key, so a transient failure costs nothing', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  localStorage.setItem(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(LEGACY_SETTINGS));
  configStatus = 500;
  configBody = { error: 'database is locked' };

  await whenVoiceConfigReady();

  assert.equal(
    localStorage.getItem(VOICE_CONFIG_STORAGE_KEY),
    JSON.stringify(LEGACY_SETTINGS),
  );
  assert.deepEqual(readVoiceConfig(), VOICE_CONFIG_DEFAULTS);
});
