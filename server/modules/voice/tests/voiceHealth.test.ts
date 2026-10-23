import assert from 'node:assert/strict';
import test from 'node:test';

import { listProviders } from '../../../../shared/asr/asrRegistry.js';
import { createVoiceService } from '../voice.service.js';

/**
 * The health reading and the two request paths' treatment of an unregistered provider id.
 *
 * What these tests are for: the health endpoint's answer used to be a statement about the
 * server process's environment, which is the wrong question once the user has a backend of
 * their own. The first test below is the case that reading got wrong — a server with no voice
 * environment at all and a user who configured everything — and the rest pin the state that
 * used to be undefined: an id no adapter claims.
 */

const SERVER_DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

/** A user who saved their own backend; the server process has nothing configured. */
const USER_SETTINGS = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: 'gsk-user',
  sttModel: 'whisper-large-v3',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

const NO_USER_SETTINGS = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
};

/** Counts every outbound call, so "no silent fallback" can be read as "nothing was sent". */
function createSpyFetch(): { calls: string[]; fetchBackend: (url: string) => Promise<Response> } {
  const calls: string[] = [];
  return {
    calls,
    fetchBackend: async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    },
  };
}

test('AC1: a user-configured backend reads as configured on a server with no voice environment', () => {
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const health = service.getHealth({ settings: USER_SETTINGS });

  assert.equal(health.ok, true);
  assert.equal(health.ok && health.value.configured, true, 'the user configured a backend, so the link is configured');
});

test('AC1: neither side configured is still reported as unconfigured', () => {
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const health = service.getHealth({ settings: NO_USER_SETTINGS });
  assert.equal(health.ok && health.value.configured, false);
});

test('AC2: every registered provider is listed with the registry\'s own capability declaration', () => {
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const health = service.getHealth({ settings: USER_SETTINGS });
  assert.equal(health.ok, true);
  if (!health.ok) return;

  // Compared against the registry rather than against a literal, so a provider added or
  // changed there is what the payload has to match — a hardcoded expectation here would pass
  // while the payload drifted from the table it claims to republish.
  //
  // THE `configured` COLUMN IS DERIVED FROM THE SAME DECLARATION THE PAYLOAD READS, and the
  // derivation is the whole subject of this task: a provider that declares credential fields of its
  // own can only be reached with the USER's pair, and `USER_SETTINGS` above is a document with the
  // six shared fields and nothing else — so such a provider must read as NOT configured, while
  // every provider reached through the deployment's backend still reads as configured. Writing
  // `true` here would assert the opposite of what the payload is supposed to say and would keep
  // passing only while the reading ignored provider declarations.
  //
  // TWO COLUMNS NEED MORE THAN THE CREDENTIAL DECLARATION NOW, and both are restated here in the
  // payload's own terms rather than read off the service, so a row that drifted from its declaration
  // still fails this assertion:
  //
  //   · `configured` — a recogniser THIS PROCESS RUNS is not configured by an address at all, so it
  //     reads as configured whenever it declares no credential fields of its own; the remote
  //     providers keep the reading they have always had. `USER_SETTINGS` above holds a `baseUrl`, so
  //     the remote rows are configured for the same reason they were before.
  //   · `runtime` — ASKED of the adapter that declares one, exactly as the payload asks it. A
  //     provider reached over the network declares none, so its row is built WITHOUT the key
  //     (absence, not `undefined`), which is the shape the payload produces and the shape the client
  //     branches on.
  const registry = listProviders().map((adapter) => {
    const runtime = adapter.runtime?.();
    return {
      id: adapter.id,
      label: adapter.id,
      capabilities: adapter.capabilities,
      configured:
        adapter.capabilities.locality !== 'remote'
          ? true
          : adapter.credentials !== undefined
            ? false
            : Boolean(USER_SETTINGS.baseUrl || SERVER_DEFAULTS.baseUrl),
      credentialFields: adapter.credentials,
      ...(runtime === undefined ? {} : { runtime }),
    };
  });
  assert.deepEqual(health.value.providers, registry);
  assert.deepEqual(
    health.value.providers.map((provider) => provider.id),
    listProviders().map((adapter) => adapter.id),
  );
  assert.equal(health.value.provider, listProviders()[0]?.id);
  // A capability field that the UI branches on, asserted to have travelled intact rather than
  // merely to have a key of that name.
  assert.equal(health.value.providers[0]?.capabilities.maxInlineRequestBytes, listProviders()[0]?.capabilities.maxInlineRequestBytes);

  // THE SECOND DECLARATION, read the same way: the row that declares credential fields of its own
  // publishes them, field for field, and the row that declares none says so by absence. This is
  // what the settings form renders its inputs from, so "the declaration reached the payload" is
  // the reading that has to exist here rather than in the client, which cannot see the registry.
  //
  // Asserted against the registry's own objects, never against the three names this checkout
  // happens to register: a literal here would keep passing while the payload and the declaration it
  // claims to republish drifted apart, which is the failure this whole republishing exists to make
  // impossible.
  const declaring = health.value.providers.filter((provider) => provider.credentialFields !== undefined);
  assert.ok(declaring.length > 0, 'at least one registered provider declares credential fields of its own');
  for (const provider of health.value.providers) {
    const adapter = listProviders().find((candidate) => candidate.id === provider.id);
    assert.deepEqual(
      provider.credentialFields,
      adapter?.credentials,
      `${provider.id}: the published declaration must be the registry's own`,
    );
  }
  // The reading, printed rather than only asserted: which rows declare, and the shape the settings
  // form will render from. The names are the declaration's own, so this line is a reading of the
  // payload and not a second copy of it.
  console.log(
    `voice-health providers=${health.value.providers.length} declaring=[${declaring.map((provider) => provider.id).join(',')}]`
      + ` first-declaration=${JSON.stringify(declaring[0]?.credentialFields ?? null)}`,
  );
});

test('AC3 proxy face: an unregistered override id is refused and nothing is sent', async () => {
  const spy = createSpyFetch();
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS, baseUrl: 'https://voice.example/v1', apiKey: 'sk-server' },
    timeoutMs: 1_000,
    fetchBackend: spy.fetchBackend,
  });

  const result = await service.transcribe({
    audio: { bytes: Buffer.from('audio'), mimeType: 'audio/webm', fileName: 'a.webm' },
    overrides: { providerId: 'whisper-turbo' },
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 400);
  assert.match(result.ok === false ? result.error : '', /whisper-turbo/, 'the refusal names the id it could not serve');
  assert.deepEqual(spy.calls, [], 'an unregistered id must not be served by the default provider');
});

test('AC3 proxy face: a registered override id still transcribes', async () => {
  const spy = createSpyFetch();
  const registered = listProviders()[0]?.id ?? '';
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS, baseUrl: 'https://voice.example/v1', apiKey: 'sk-server' },
    timeoutMs: 1_000,
    fetchBackend: spy.fetchBackend,
  });

  const result = await service.transcribe({
    audio: { bytes: Buffer.from('audio'), mimeType: 'audio/webm', fileName: 'a.webm' },
    overrides: { providerId: registered },
  });

  assert.equal(result.ok, true);
  assert.equal(spy.calls.length, 1, 'a registered id must still reach the backend');
});

test('AC3 health face: an unregistered effective provider id is refused, not silently defaulted', () => {
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS, providerId: 'multimodal-v2', baseUrl: 'https://voice.example/v1' },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const health = service.getHealth({ settings: USER_SETTINGS });

  assert.equal(health.ok, false);
  assert.equal(health.ok === false && health.status, 503);
  assert.match(health.ok === false ? health.error : '', /multimodal-v2/);
});

test('AC4: the configured field keeps its position and its boolean meaning', () => {
  const service = createVoiceService({
    defaults: { ...SERVER_DEFAULTS, baseUrl: 'https://voice.example/v1' },
    timeoutMs: 1_000,
    fetchBackend: async () => {
      throw new Error('the health reading must not call anything');
    },
  });

  const health = service.getHealth({ settings: NO_USER_SETTINGS });
  assert.equal(health.ok, true);
  if (!health.ok) return;

  // The consumer's reading, spelled the way it reads it: `data?.configured === true`.
  const payload = JSON.parse(JSON.stringify(health.value)) as { configured?: unknown };
  assert.equal(payload.configured === true, true);
});
