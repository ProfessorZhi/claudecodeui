import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { StreamingVad, detectVoiceSegments } from '../src/shared/voiceEndpoint';

/*
 * The streaming detector, run in a real `AudioWorklet` and compared to the pure function on the
 * same samples.
 *
 * The two T1 readings say the algorithm places its cuts and onsets right on synthesised truth;
 * they say nothing about whether a browser's audio thread produces the same frames. So this spec
 * injects a real corpus sample into a real `OfflineAudioContext`, lets the shipped
 * `voiceFrameProcessor` frame it on the audio thread, and reconstructs the segments from the
 * frame energies it reports. The result must be the pure function's own output — the worklet is
 * the same detector, one frame behind the audio, not a second one.
 *
 * The sample lives outside the repo. A missing fixture is named and fails, never skipped: a run
 * that quietly measured nothing is the one failure a measurement may not have.
 */

const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const LONG_DIR = process.env.VAD_LONG ?? '/data/home/yale/work/tc-verify/corpus/long';
const SAMPLE_ID = 'L2-mixed';
const SAMPLE_RATE = 16_000;
const ENDPOINT_MS = 800;
const MAX_SEGMENT_SEC = 30;

/** Minimal 16-bit PCM RIFF reader, matching the harness so both sides decode byte-for-byte. */
function decodeWav(buf: Buffer): Float32Array {
  expect(buf.toString('ascii', 0, 4), 'not a RIFF file').toBe('RIFF');
  let channels = 1;
  let data: Buffer | null = null;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') channels = buf.readUInt16LE(at + 10);
    else if (id === 'data') data = buf.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data chunk in ${SAMPLE_ID}`);
  const frames = Math.floor(data.length / (channels * 2));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += data.readInt16LE((i * channels + c) * 2) / 32768;
    out[i] = acc / channels;
  }
  return out;
}

/** The frame messages the worklet posts back, in order. */
type FrameMessage = { type: 'frame'; rms: number; atSample: number };

test('the AudioWorklet streams the same frame decisions as the pure function', async ({ page }) => {
  test.setTimeout(60_000);

  const wavPath = path.join(LONG_DIR, `${SAMPLE_ID}.wav`);
  expect(
    fs.existsSync(wavPath),
    `the long-corpus sample is missing at ${wavPath} — the criterion cannot run without it`,
  ).toBe(true);
  const samples = decodeWav(fs.readFileSync(wavPath));
  const frame = Math.round(0.02 * SAMPLE_RATE);
  const expectedFrames = Math.floor(samples.length / frame);

  // The reference: the pure function on exactly these samples, with the same parameters.
  const reference = detectVoiceSegments(samples, SAMPLE_RATE, {
    endpointMs: ENDPOINT_MS,
    maxSegmentSec: MAX_SEGMENT_SEC,
  });
  expect(reference.length, 'the fixture produced no segments, so the comparison would be vacuous').toBeGreaterThan(0);

  await page.goto('/');
  const wavBase64 = fs.readFileSync(wavPath).toString('base64');

  const worklet = await page.evaluate(
    async ({ bytesBase64, clientUrl }): Promise<{ frames: FrameMessage[]; pcmSamples: number; pcmCount: number }> => {
      const binary = atob(bytesBase64);
      const buf = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);

      // Decode in the page, byte-for-byte as the harness does, so the worklet sees the same samples.
      const view = new DataView(buf.buffer);
      let channels = 1;
      let dataAt = -1;
      let dataLen = 0;
      let at = 12;
      while (at + 8 <= buf.length) {
        const id = String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]);
        const size = view.getUint32(at + 4, true);
        if (id === 'fmt ') channels = view.getUint16(at + 10, true);
        else if (id === 'data') {
          dataAt = at + 8;
          dataLen = size;
        }
        at += 8 + size + (size % 2);
      }
      if (dataAt < 0) throw new Error('the injected WAV carried no data chunk');
      const frames = Math.floor(dataLen / (channels * 2));
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += view.getInt16(dataAt + (i * channels + c) * 2, true) / 32768;
        mono[i] = acc / channels;
      }

      const context = new OfflineAudioContext(1, mono.length, 16000);
      await context.audioWorklet.addModule(`${clientUrl}/src/modules/chat/audio/voiceFrameProcessor.ts`);
      const node = new AudioWorkletNode(context, 'voice-frame-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: { sampleRate: 16000, vad: { endpointMs: 800, maxSegmentSec: 30 } },
      });

      const received: FrameMessage[] = [];
      // The raw PCM the worklet forwards, as sample counts: the segmenter's input, whose total
      // duration must be the injected audio's.
      let pcmSamples = 0;
      let pcmCount = 0;
      node.port.onmessage = (message: MessageEvent) => {
        if (message.data?.type === 'frame') received.push(message.data as FrameMessage);
        else if (message.data?.type === 'pcm') {
          pcmSamples += (message.data.samples as Float32Array).length;
          pcmCount += 1;
        }
      };

      const buffer = context.createBuffer(1, mono.length, 16000);
      buffer.copyToChannel(mono, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(node);
      node.connect(context.destination);
      source.start();
      await context.startRendering();
      // Port messages from the audio thread are delivered asynchronously and `startRendering`
      // resolves as soon as the last quantum has run, which is before the last of them arrive.
      // Drain until the count stops moving, bounded so a genuinely stuck port still fails fast.
      let settled = 0;
      for (let waited = 0; waited < 3_000; waited += 100) {
        const before = received.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (received.length === before) {
          settled += 100;
          if (settled >= 500) break;
        } else settled = 0;
      }
      return { frames: received, pcmSamples, pcmCount };
    },
    { bytesBase64: wavBase64, clientUrl: CLIENT_URL },
  );

  // The worklet forwards the audio itself, not only its energy: the PCM frames the segmenter
  // buffers must cover the injected samples to within a frame. A worklet that dropped the PCM —
  // or forwarded the wrong buffer — leaves the segmenter with nothing to upload.
  const workletPcm = worklet.pcmSamples;
  const injectedSec = samples.length / SAMPLE_RATE;
  const forwardedSec = workletPcm / SAMPLE_RATE;
  expect(worklet.pcmCount, 'the worklet forwarded no PCM frames').toBeGreaterThan(0);
  expect(
    Math.abs(injectedSec - forwardedSec),
    `the worklet forwarded ${forwardedSec.toFixed(3)}s of PCM for ${injectedSec.toFixed(3)}s injected`,
  ).toBeLessThanOrEqual(0.05);

  const workletFrames = worklet.frames;

  // The worklet frames the audio at its own boundary; the render pads the tail to a whole quantum,
  // so only the frames the pure function would also form are compared.
  const frames = workletFrames.slice(0, expectedFrames);
  expect(frames.length, `the worklet reported ${frames.length} frames, expected ${expectedFrames}`).toBe(expectedFrames);
  expect(frames[123].atSample).toBe(123 * frame);

  // Replay the worklet's own frame energies through the shared state machine. Identical frames
  // give identical flags, so identical segments — the claim being made about the worklet is that
  // its framing is the pure function's.
  const replayed = new StreamingVad({ sampleRate: SAMPLE_RATE, endpointMs: ENDPOINT_MS, maxSegmentSec: MAX_SEGMENT_SEC });
  for (const message of frames) replayed.pushFrameEnergy(message.rms);
  const fromWorklet = replayed.flush();

  expect(fromWorklet.length).toBe(reference.length);
  for (let i = 0; i < reference.length; i++) {
    expect(Math.abs(fromWorklet[i].startSec - reference[i].startSec)).toBeLessThan(1e-6);
    expect(Math.abs(fromWorklet[i].endSec - reference[i].endSec)).toBeLessThan(1e-6);
    expect(fromWorklet[i].forced).toBe(reference[i].forced);
  }
  console.log(
    `[voice-streaming-vad] ${SAMPLE_ID}: ${frames.length} worklet frames, ${reference.length} segments, identical to the pure function`,
  );
});
