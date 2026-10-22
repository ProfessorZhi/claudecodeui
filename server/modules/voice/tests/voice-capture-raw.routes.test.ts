/**
 * The raw-corpus HTTP surface: `POST /api/voice/capture/raw` and `GET /api/voice/capture`, plus the
 * `listenId` field `/transcribe` carries through to the capture row.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-raw.test.ts` reads the seam BELOW the
 * transport — the switch, the file, the row. This one reads the transport itself: that the route
 * parses the upload, calls the service, and answers; that the capability reading `GET
 * /api/voice/capture` agrees with the switch; and that a `listenId` text field reaches the service
 * for `/transcribe` and is absent from the call when the request carries none.
 *
 * THE ROUTER IS DRIVEN AS THE MIDDLEWARE IT IS, not through a listening socket: a test that bound a
 * port would be reporting the host's ephemeral-port lottery on the runs where it went red. The two
 * multipart parsers are stand-ins, so the route's own parse/call/respond shape is what is measured.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { VoiceService, VoiceSettings, VoiceSettingsService } from '@/shared/types.js';

import { createVoiceCapture, createVoiceCaptureAudioSink } from '../voice-capture.js';
import { createVoiceRouter } from '../voice.routes.js';
import { createVoiceService } from '../voice.service.js';

const DEFAULTS = {
  baseUrl: 'https://voice.example/v1',
  apiKey: 'server-key',
  sttModel: 'whisper-1',
  ttsModel: 'tts-1',
  ttsVoice: 'alloy',
  providerId: '',
};

const NO_SETTINGS: VoiceSettings = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  providerId: '',
  dashscopeEndpoint: '',
  dashscopeApiKey: '',
  dashscopeModel: '',
};

const settingsService: VoiceSettingsService = {
  getSettings: () => NO_SETTINGS,
  saveSettings: () => ({ ok: false, status: 400, error: 'unused' }),
  maskForReadback: (settings) => settings,
};

const scratch = (): string => mkdtempSync(path.join(os.tmpdir(), 'voice-capture-raw-routes-'));

/** The port shape the raw routes need: a switch and a real sink, so "no directory" is measurable. */
function rawPort(raw: boolean, directory: string) {
  return createVoiceCapture({
    mode: 'audio',
    log: { info: () => undefined },
    instanceSalt: 'criterion',
    audio: createVoiceCaptureAudioSink({ directory }),
    raw,
  });
}

/** A real service over the given port, so the switch the routes read is the port's own. */
function realService(capture: ReturnType<typeof rawPort>): VoiceService {
  return createVoiceService({
    defaults: DEFAULTS,
    timeoutMs: 1_000,
    fetchBackend: async () => new Response('{}', { status: 200 }),
    logger: { info: () => undefined },
    capture,
  });
}

type RouteInit = {
  method?: string;
  url: string;
  file?: { buffer: Buffer; mimetype?: string; originalname?: string };
  body?: Record<string, unknown>;
};

type Outcome = { status: number; body: unknown };

/**
 * Invokes the router as middleware for one request and resolves with the first response it writes.
 *
 * The parsers are stubs that set `request.file` from the fixture and call back with no error, so the
 * route's own logic — reading the fields, calling the service, formatting the answer — is what runs.
 * The service is the one the current test installed with `useService`.
 */
function callRoute(service: VoiceService, init: RouteInit): Promise<Outcome> {
  const parser = (request: unknown, _response: unknown, callback: (error?: unknown) => void) => {
    (request as { file?: unknown }).file = init.file;
    callback(undefined);
  };
  const router = createVoiceRouter({
    voiceService: service,
    voiceSettingsService: settingsService,
    // This file drives the raw-corpus upload; the lexicon's own routes are not
    // reached, so an inert service keeps the dependency named without a store.
    lexiconService: {
      observeSentText: () => {},
      importFromHistory: async () => ({ importedMessages: 0, tokenCount: 0 }),
      list: () => [],
      clear: () => {},
    },
    parseAudioUpload: parser,
    parseRawAudioUpload: parser,
  });

  return new Promise<Outcome>((resolve, reject) => {
    // Express's default status is 200; a handler that calls `json` without naming one answers 200, so
    // the harness starts there rather than at 0 (which would read every un-named success as a refusal).
    let status = 200;
    const request = {
      method: init.method ?? 'POST',
      url: init.url,
      headers: {},
      body: init.body ?? {},
    };
    const response = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        resolve({ status, body: payload });
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        resolve({ status, body: undefined });
      },
    };
    router(
      request as never,
      response as never,
      (error?: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

// ── AC5: the capability reading agrees with the switch ────────────────────────────────────────

test('AC5 GET /api/voice/capture reports the switch', async () => {
  const root = scratch();
  try {
    const on = await callRoute(realService(rawPort(true, path.join(root, 'on'))), {
      method: 'GET',
      url: '/capture',
    });
    const off = await callRoute(realService(rawPort(false, path.join(root, 'off'))), {
      method: 'GET',
      url: '/capture',
    });

    process.stdout.write(`GET /capture on=${JSON.stringify(on.body)} off=${JSON.stringify(off.body)}\n`);
    assert.deepEqual(on.body, { raw: true });
    assert.deepEqual(off.body, { raw: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC2 (route half) and AC3 (route half): POST /capture/raw ──────────────────────────────────

test('AC2 the raw route writes no file and creates no directory when the switch is off', async () => {
  const root = scratch();
  const directory = path.join(root, 'off');
  try {
    const outcome = await callRoute(realService(rawPort(false, directory)), {
      url: '/capture/raw',
      file: { buffer: Buffer.from('raw-off-sentinel', 'utf8'), mimetype: 'audio/wav', originalname: 'r.wav' },
      body: { listenId: 'listen-off' },
    });

    process.stdout.write(
      `POST raw off status=${outcome.status} body=${JSON.stringify(outcome.body)} dir=${existsSync(directory)}\n`,
    );
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { stored: false });
    assert.equal(existsSync(directory), false, 'a switch-off deployment must not create the directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AC3 the raw route writes the upload byte for byte when the switch is on', async () => {
  const root = scratch();
  const directory = path.join(root, 'on');
  const bytes = Buffer.from(`raw-route-${process.pid}:${'z'.repeat(32)}`, 'utf8');
  try {
    const outcome = await callRoute(realService(rawPort(true, directory)), {
      url: '/capture/raw',
      file: { buffer: bytes, mimetype: 'audio/wav', originalname: 'r.wav' },
      body: { listenId: 'listen-on' },
    });

    const file = path.join(directory, 'raw-listen-on.bin');
    process.stdout.write(
      `POST raw on status=${outcome.status} body=${JSON.stringify(outcome.body)} file=${existsSync(file)}\n`,
    );
    assert.equal(outcome.status, 200);
    assert.deepEqual(outcome.body, { stored: true });
    assert.equal(existsSync(file), true, 'the route must have written raw-<listenId>.bin');
    assert.equal(readFileSync(file).equals(bytes), true, 'and the bytes must be the upload`s own');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a raw request with no listenId is refused like a missing upload', async () => {
  const root = scratch();
  try {
    const outcome = await callRoute(realService(rawPort(true, path.join(root, 'none'))), {
      url: '/capture/raw',
      file: { buffer: Buffer.from('x'), mimetype: 'audio/wav', originalname: 'r.wav' },
      body: {},
    });

    process.stdout.write(`POST raw no-listenId status=${outcome.status} body=${JSON.stringify(outcome.body)}\n`);
    assert.equal(outcome.status, 400);
    assert.equal((outcome.body as { code?: string }).code, 'UNSUPPORTED_MIME');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── AC7 (the request half): `/transcribe` carries listenId through only when it is there ───────

test('AC7 /transcribe passes listenId to the service only when the request carries one', async () => {
  const seen: { hasKey: boolean; listenId?: string }[] = [];
  const spy: VoiceService = {
    getHealth: () => ({ ok: false, status: 500, error: 'unused' }),
    transcribe: async (input) => {
      seen.push({ hasKey: 'listenId' in input, listenId: input.listenId });
      return { ok: true, value: { text: 'ok' } };
    },
    synthesizeSpeech: async () => ({ ok: false, status: 500, error: 'unused' }),
    captureRaw: () => ({ ok: true, value: { stored: false } }),
    captureState: () => ({ raw: false }),
  };

  const audio = { buffer: Buffer.from('audio'), mimetype: 'audio/wav', originalname: 'a.wav' };
  const withId = await callRoute(spy, { url: '/transcribe', file: audio, body: { listenId: 'listen-7' } });
  const withoutId = await callRoute(spy, { url: '/transcribe', file: audio, body: {} });

  process.stdout.write(
    `transcribe listenId seen=${JSON.stringify(seen)} statuses=${withId.status},${withoutId.status}\n`,
  );
  assert.equal(seen[0]?.hasKey, true);
  assert.equal(seen[0]?.listenId, 'listen-7');
  // The key must be ABSENT from the call rather than present-and-undefined: the route spreads it in
  // only when the field was there, so this is the transport-side half of the row's own absence.
  assert.equal(seen[1]?.hasKey, false);
});
