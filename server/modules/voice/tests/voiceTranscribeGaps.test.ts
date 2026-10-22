import assert from 'node:assert/strict';
import test from 'node:test';

import type { AsrCapabilities } from '../../../../shared/asr/asrRegistry.js';
import { createVoiceRouter } from '../voice.routes.js';
import { budgetRefusal, containerRefusal, createVoiceService } from '../voice.service.js';

const defaults = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

const NO_USER_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

function audioOf(bytes: number, mimeType = 'audio/webm') {
  return { bytes: Buffer.alloc(bytes), mimeType, fileName: 'recording.webm' };
}

/**
 * The semantic code a gate refused with, or `undefined` when it let the upload through.
 *
 * The gates return a result union, so the code only exists on the branch that refused; reading it
 * through here keeps each case's assertion on the one field it is about.
 */
function codeOf(result: { ok: boolean; code?: string } | null): string | undefined {
  return result !== null && !result.ok ? result.code : undefined;
}

/** The declaration the registry publishes for the id the service resolves when none is named. */
function effectiveDeclaration(): AsrCapabilities {
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async () => new Response('{}', { status: 200 }),
  });
  const health = service.getHealth({ settings: NO_USER_SETTINGS });
  assert.equal(health.ok, true);
  const providers = health.ok ? health.value.providers : [];
  const effective = health.ok ? health.value.provider : '';
  const provider = providers.find((entry) => entry.id === effective);
  assert.ok(provider, 'the health reading must publish the effective provider');
  return provider.capabilities;
}

/**
 * Drives the shipping service with a counting transport, so "refused before the upstream was read"
 * is a counter rather than an inference from the absence of a side effect.
 */
async function transcribe(audio: { bytes: Buffer; mimeType: string; fileName: string }) {
  let upstreamCalls = 0;
  const service = createVoiceService({
    defaults,
    timeoutMs: 1_000,
    fetchBackend: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    },
  });

  return { result: await service.transcribe({ audio, overrides: {} }), upstreamCalls };
}

// ── gap one: the container whitelist is the selected provider's declaration ───────────────────

test('a declared container is accepted, bare and with parameters', async () => {
  for (const mimeType of ['audio/webm', 'audio/webm;codecs=opus', 'AUDIO/WEBM']) {
    const { result, upstreamCalls } = await transcribe(audioOf(1_000, mimeType));
    assert.deepEqual(result, { ok: true, value: { text: 'hello' } }, `${mimeType} should be accepted`);
    assert.equal(upstreamCalls, 1, `${mimeType} should reach the backend exactly once`);
  }
});

test('a container outside the declaration is refused with the semantic code and no upstream call', async () => {
  const { result, upstreamCalls } = await transcribe(audioOf(1_000, 'audio/x-m4a'));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 415);
  assert.equal(result.ok === false && result.code, 'UNSUPPORTED_MIME');
  assert.equal(upstreamCalls, 0, 'an unsupported container must not cost a transcription request');
});

test('the container gate reads the declaration it is handed rather than a constant', () => {
  const declaration = effectiveDeclaration();
  const narrow: AsrCapabilities = { ...declaration, acceptsMime: ['audio/ogg'] };

  assert.equal(containerRefusal(declaration, 'p', 'audio/webm'), null, 'the declared type is accepted');
  assert.equal(codeOf(containerRefusal(narrow, 'p', 'audio/webm')), 'UNSUPPORTED_MIME');
  assert.equal(containerRefusal(narrow, 'p', 'audio/ogg'), null);
});

// ── gap two: the size limit is two layers, and the provider layer is the declaration ──────────

test('an upload past the provider budget is refused with OVERSIZE and no upstream call', async () => {
  const declaration = effectiveDeclaration();
  const { result, upstreamCalls } = await transcribe(audioOf(declaration.maxInlineRequestBytes + 1));

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 413);
  assert.equal(result.ok === false && result.code, 'OVERSIZE');
  assert.equal(upstreamCalls, 0);
});

test('an upload inside the provider budget is sent', async () => {
  const declaration = effectiveDeclaration();
  const { result, upstreamCalls } = await transcribe(audioOf(declaration.maxInlineRequestBytes));

  assert.equal(result.ok, true);
  assert.equal(upstreamCalls, 1, 'the budget is a line, not a wall');
});

test('the budget gate reads the declaration it is handed rather than a constant', () => {
  const declaration = effectiveDeclaration();
  const permissive: AsrCapabilities = { ...declaration, maxInlineRequestBytes: 4_000 };
  const strict: AsrCapabilities = { ...declaration, maxInlineRequestBytes: 2_000 };

  assert.equal(budgetRefusal(permissive, 'p', 3_000), null);
  assert.equal(codeOf(budgetRefusal(strict, 'p', 3_000)), 'OVERSIZE');
});

// ── the transport layer of the same limit, and the status it owes ─────────────────────────────

type RouteOutcome = { status: number; body: { error?: string; code?: string } };

/**
 * Drives the shipping router with a parser stand-in.
 *
 * The router is invoked as the middleware function it is rather than through a listening socket:
 * this reads the handler the server actually mounts, and a test that had to bind a port would be
 * reporting the platform's ephemeral-port lottery on the runs where it went red.
 */
function postThroughRouter(uploadError: unknown): RouteOutcome {
  const router = createVoiceRouter({
    voiceService: {
      getHealth: () => ({ ok: false, status: 500, error: 'unused' }),
      transcribe: async () => ({ ok: true, value: { text: '' } }),
      synthesizeSpeech: async () => ({ ok: false, status: 500, error: 'unused' }),
      // This file drives the upload parser's refusals, which are decided before the raw-corpus
      // surface is reached; the two members exist so the fake is a complete `VoiceService`.
      captureRaw: () => ({ ok: true, value: { stored: false } }),
      captureState: () => ({ raw: false }),
    },
    voiceSettingsService: {
      getSettings: () => NO_USER_SETTINGS,
      saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
      // The readback face is a no-op here: this file drives the upload parser's refusals, which are
      // decided before any settings are read, and a stand-in with a mask of its own would be
      // asserting something about a layer this test never reaches.
      maskForReadback: (settings) => settings,
    },
    // This file drives the upload parser's refusals; the lexicon is a dependency
    // of the router it must name, and is never reached from these requests.
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: (_request, _response, callback) => callback(uploadError),
    // The raw endpoint's parser is never reached here — this file drives `/transcribe` — so it is a
    // pass-through that answers "no error" without touching the request.
    parseRawAudioUpload: (_request, _response, callback) => callback(undefined),
  });

  let status = 0;
  let body: RouteOutcome['body'] = {};
  const request = { method: 'POST', url: '/transcribe', headers: {} } as unknown as Parameters<typeof router>[0];
  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: RouteOutcome['body']) {
      body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as Parameters<typeof router>[1];

  router(request, response, (error?: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });

  return { status, body };
}

test('the transport ceiling reports 413 rather than 400 when it is what refused', () => {
  const tooLarge = Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' });
  const outcome = postThroughRouter(tooLarge);

  assert.equal(outcome.status, 413, 'a size refusal is not a malformed-request refusal');
  assert.equal(outcome.body.code, 'OVERSIZE');
  assert.match(String(outcome.body.error), /File too large/);
});

test('a parser failure that is not the ceiling is still 400 and carries the vocabulary code', () => {
  const outcome = postThroughRouter(new Error('Unexpected field'));

  assert.equal(outcome.status, 400);
  // The reading this test used to pin was `code === undefined`. The envelope changed with the
  // failure-contract task: every refusal the transcription path answers now names a vocabulary
  // member, and the malformed-upload branch names the same one the container gate does (see
  // `MALFORMED_UPLOAD_CODE`). The status is unchanged — that half of the old reading still holds.
  assert.equal(outcome.body.code, 'UNSUPPORTED_MIME');
  assert.match(String(outcome.body.error), /Unexpected field/);
});
