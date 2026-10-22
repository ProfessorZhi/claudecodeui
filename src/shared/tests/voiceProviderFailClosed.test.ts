import { listProviders } from '@shared/asr/asrRegistry';
import { afterEach, expect, test, vi } from 'vitest';

import { setVoiceProviderProfile, transcribeVoice } from '@/shared/api';
import { resetVoiceConfig } from '@/shared/voiceConfig';

/**
 * The client half of the unregistered-provider rule.
 *
 * The direct path is the one that leaves the browser straight for the user's own endpoint, so
 * it is the face where a wrong provider costs the most: there is no server in the middle to
 * notice. These tests pin that the refusal is driven by what the health reading published and
 * by nothing else — no table of known ids lives here, and with nothing published there is
 * nothing to refuse.
 */

const REGISTERED = listProviders()[0];

afterEach(() => {
  setVoiceProviderProfile(null);
  resetVoiceConfig();
  vi.unstubAllGlobals();
});

test('AC3 direct face: an id the registry does not know is refused, and no request is made', async () => {
  expect(REGISTERED, 'this case needs at least one registered provider to be meaningful').toBeDefined();
  setVoiceProviderProfile({ id: 'multimodal-v2', capabilities: REGISTERED.capabilities });

  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);

  const response = await transcribeVoice(new Blob(['audio']), 'recording.webm');

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toMatchObject({
    error: expect.stringContaining('multimodal-v2'),
  });
});

test('AC3 direct face: a registered id is not refused — the positive control', async () => {
  setVoiceProviderProfile({ id: REGISTERED.id, capabilities: REGISTERED.capabilities });

  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);

  const response = await transcribeVoice(new Blob(['audio']), 'recording.webm');

  expect(fetchSpy).toHaveBeenCalled();
  expect(response.status).toBe(200);
});

test('AC6: with no health reading published the client refuses nothing — it holds no list of its own', async () => {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ text: 'hello' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);

  const response = await transcribeVoice(new Blob(['audio']), 'recording.webm');

  // An implementation that carried its own provider table would have an opinion here. This one
  // only knows what the health reading told it, which is the property that keeps the client
  // from disagreeing with the server about which providers exist.
  expect(fetchSpy).toHaveBeenCalled();
  expect(response.status).toBe(200);
});
