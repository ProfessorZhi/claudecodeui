/**
 * The client half of the raw (pre-VAD) corpus: when a listen uploads its raw audio, whether the
 * deployment's switch gates it, and that the upload never holds up the text.
 *
 * WHAT THIS FILE IS THE CRITERION FOR. `voice-capture-raw*.test.ts` (server) own the endpoint and the
 * file. This one owns the browser's decision to use it: the switch read from `GET /api/voice/capture`
 * gates every upload (`isVoiceRawCaptureEnabled`), the raw upload carries the SAME `listenId` as the
 * listen's `/transcribe` requests, and — the property that matters most — the corpus upload is fired
 * AFTER the text and NEVER awaited, so a raw endpoint that hangs cannot delay a single word.
 *
 * THE TWO FALSE FORMS THIS FILE IS BUILT TO CATCH:
 *   · "the switch is ignored" — the off case would then call `captureRawVoice`, and the zero below
 *     would not be a zero.
 *   · "the raw upload is awaited before the submit" — the never-resolving double in the blocking case
 *     would then stop the send from ever happening. The test stops with `send: true` and requires the
 *     send to arrive anyway, so an awaited implementation reds it by construction rather than by a
 *     text mutation (a hook mutation harness would have to copy the hook's whole import graph).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useVoiceInput } from '@/modules/chat/hooks/useVoiceInput';
import { createFakeVoiceCapture } from '@/modules/chat/tests/voiceCaptureTestHarness';

import type * as SharedApi from '@/shared/api';
import type * as SharedVoiceConfig from '@/shared/voiceConfig';

const { transcribeVoice, captureRawVoice } = vi.hoisted(() => ({
  transcribeVoice: vi.fn(),
  captureRawVoice: vi.fn(),
}));

/** The deployment's raw-capture switch, as `isVoiceRawCaptureEnabled` reports it. Flipped per case. */
const deployment = vi.hoisted(() => ({ rawCapture: false }));

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedApi>();
  return {
    transcribeVoice,
    captureRawVoice,
    synthesizeVoice: vi.fn(),
    voiceConfigSignature: () => 'test-signature',
    // The recogniser's answer is read through the shipping parse; only the endpoint is cut.
    parseTranscriptionResponse: actual.parseTranscriptionResponse,
    effectivePauseCuesDeclaration: actual.effectivePauseCuesDeclaration,
  };
});

// The switch is the deployment's; the hook only reads it. Doubled so a case decides what it says,
// and so nothing here performs the once-per-token fetch (`hydrateVoiceRawCapture`).
//
// THE REST OF THE MODULE STAYS REAL, and it has to: the hook reads the USER's recording switch
// (`readVoiceConfig`) on the very transcription path these cases drive, to decide whether to look
// for the record id the recogniser's answer carries. A double that returned only the two exports
// above would erase that accessor, and the listen would fail for a reason that has nothing to do
// with the raw corpus — which is exactly what happened when the lookup was added. The real one
// answers the shipped default (recording on), so a case here reads the same settings a fresh user
// has rather than a second copy of the defaults.
vi.mock('@/shared/voiceConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedVoiceConfig>();
  return {
    ...actual,
    isVoiceRawCaptureEnabled: () => deployment.rawCapture,
    hydrateVoiceRawCapture: async () => undefined,
  };
});

// A plain install: no debug reading, VAD on, the shipped caps.
vi.mock('@/shared/voiceDebug', () => ({
  isVoiceDebugEnabled: () => false,
  isVoiceTrimEnabled: () => false,
  isVoiceVadEnabled: () => true,
  // The silence flush's window switch: absent means the shipped 5 s default, which these cases run under.
  voiceDebugFlushSilenceSec: () => undefined,
  voiceDebugIdleSec: () => undefined,
  voiceDebugMinSegmentSec: () => undefined,
  voiceDebugOriginalCapSec: () => undefined,
}));

let capture = createFakeVoiceCapture();

beforeEach(() => {
  capture = createFakeVoiceCapture();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
  });
  let counter = 0;
  URL.createObjectURL = (() => `blob:raw-${++counter}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as unknown as typeof URL.revokeObjectURL;

  deployment.rawCapture = false;
  transcribeVoice.mockReset();
  transcribeVoice.mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'hello' }) });
  captureRawVoice.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1024 });
});

/** A hook view plus the spies its listen reports through. */
function renderVoice() {
  const onTranscript = vi.fn();
  const onError = vi.fn();
  const view = renderHook(() =>
    useVoiceInput(onTranscript, onError, { scope: 'session-a', isActive: true, captureEngine: capture.engine }),
  );
  return { view, onTranscript, onError };
}

/** One full mic press: start, speak for `heldMs`, stop (optionally sending), and drain the tail. */
async function record(
  view: { result: { current: ReturnType<typeof useVoiceInput> } },
  heldMs: number,
  send = false,
): Promise<void> {
  await act(async () => {
    view.result.current.toggle();
  });
  await act(async () => {
    capture.speak(heldMs / 1000);
  });
  await act(async () => {
    view.result.current.stop({ send });
  });
  await act(async () => {});
}

describe('raw capture upload', () => {
  test('the switch off produces no raw request for a whole listen', async () => {
    const { view, onTranscript } = renderVoice();
    await record(view, 1_500);

    // The premise first: the listen really happened, so a zero below is the switch's doing rather
    // than a recording that never ran.
    await waitFor(() => assert.equal(transcribeVoice.mock.calls.length, 1));
    assert.equal(onTranscript.mock.calls.length >= 1, true, 'the transcript still reaches the composer');
    assert.equal(captureRawVoice.mock.calls.length, 0, 'a switch-off deployment must send no raw upload');
  });

  test('the switch on uploads the raw audio paired to the listen id', async () => {
    deployment.rawCapture = true;
    captureRawVoice.mockResolvedValue({ ok: true, status: 200, json: async () => ({ stored: true }) });
    const { view } = renderVoice();
    await record(view, 1_500);

    await waitFor(() => assert.equal(captureRawVoice.mock.calls.length, 1));
    const [listenId, blob, filename] = captureRawVoice.mock.calls[0] as [string, Blob, string];
    // The SAME id the listen's transcription carried: the pairing is the whole point of the corpus.
    const transcribeListenId = (transcribeVoice.mock.calls[0] as unknown[])[2];
    process.stdout.write(
      `raw-upload listenId=${listenId} transcribeListenId=${String(transcribeListenId)} ` +
        `blobType=${blob.type} filename=${filename}\n`,
    );
    assert.match(listenId, /^listen-/);
    assert.equal(listenId, transcribeListenId, 'the raw row and the trimmed rows must share one listen id');
    assert.equal(blob instanceof Blob, true);
    assert.equal(blob.type, 'audio/wav');
  });

  test('a raw upload that never resolves does not hold up the send', async () => {
    deployment.rawCapture = true;
    // The never-resolving double: an implementation that awaited this before submitting would never
    // submit, and the wait below would time out — which is the mutation this case exists to catch.
    captureRawVoice.mockImplementation(() => new Promise(() => undefined));
    const { view, onTranscript } = renderVoice();
    await record(view, 1_500, true);

    await waitFor(() => {
      const sent = onTranscript.mock.calls.some((call) => call[1] === true);
      assert.equal(sent, true, 'the send must happen even while the raw upload is still in flight');
    });
    assert.equal(captureRawVoice.mock.calls.length, 1, 'the raw upload was still fired');
  });
});
