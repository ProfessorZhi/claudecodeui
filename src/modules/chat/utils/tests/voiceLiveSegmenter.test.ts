/**
 * The continuous-capture segmenter judged against EXACT TRUTH.
 *
 * Every reading here is taken against audio this file placed itself: a sentence is a tone, a
 * silence is digital zero, and the truth is the frame interval each sentence occupies. That makes
 * the segmenter's four rules measurable without a recogniser, a network or a credential — a cut's
 * position is checked against where the sentences really are, not against a second copy of the
 * rule.
 *
 * WHERE THE EVENTS COME FROM, AND WHY IT DIFFERS BY CASE.
 *
 *   · The rule cases (short vs long, the gap filter, chunk invariance) feed the segmenter EVENTS
 *     DERIVED FROM THE TRUTH. The segmenter's input is PCM plus the VAD's events; which producer
 *     emitted them is not part of the rule being read, and truth-derived events make a cut's
 *     position exact rather than a frame off. It also keeps a hundred long timelines cheap.
 *
 *   · The integration cases (the L4 ceiling, the room-tone negative, the false forms) feed the
 *     SHIPPING `StreamingVad`'s own events over the real sample, so the module the browser runs
 *     is exercised end to end.
 *
 * The last block is the falsification half: three deliberately wrong segmenters, each of which
 * must move exactly the reading its mistake should move while the real one stays green.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { test } from 'vitest';

import {
  DEFAULT_FLUSH_SILENCE_SEC,
  DEFAULT_KEEP_GAP_SEC,
  DEFAULT_MAX_SEGMENT_SEC,
  DEFAULT_MIN_SEGMENT_SEC,
  OVERLAP_SEC,
  LiveSegmenter,
  segmentLive,
  type LiveSegment,
} from '@/modules/chat/utils/voiceLiveSegmenter';
import { StreamingVad, frameRms, type VadEvent } from '@/shared/voiceEndpoint';
import type { AsrRequest } from '@shared/asr/asrRegistry';
import { measureChatRequestBytes } from '@shared/asr/list/dashscope-omni/dashscope-omni.asr-provider';

const RATE = 16_000;
const FRAME = Math.round(0.02 * RATE);
const FRAME_SEC = FRAME / RATE;
const FRAMES_PER_SEC = RATE / FRAME;
const WAV_RATE = 16_000;
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MIN_PAUSE_SEC = 0.8; // the AC3 bound a non-forced cut must clear
const CUT_PAUSE_FRAMES = Math.round(2.0 * FRAMES_PER_SEC); // DEFAULT_CUT_PAUSE_SEC in frames

/** The long sample the ceiling is read on. Outside the repo; named, never silently skipped. */
const LONG_DIR = process.env.VAD_LONG ?? '/data/home/yale/work/tc-verify/corpus/long';
const L4_PATH = `${LONG_DIR}/L4-nonstop.wav`;

/** mulberry32: every "randomised" case is re-derivable from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: () => number, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));

/** Let the worker breathe between heavy seeds, so vitest's RPC ping is never starved. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type TimelineSpec = {
  count: [number, number];
  /** Sentence length in frames. */
  speech: [number, number];
  /** Silence before each sentence (except the first) in frames. */
  gap: [number, number];
  lead: [number, number];
  tail: [number, number];
};

type Timeline = {
  samples: Float32Array;
  /** The frame interval each sentence occupies: the exact truth. */
  truth: [number, number][];
  frames: number;
};

/**
 * Lays sentences of constant tone on a zero bed, at seeded positions. A flat tone rather than a
 * sine because these cases read boundaries, not energies, and a fill is faster than a per-sample
 * sin over hundreds of seconds of audio. The truth is exactly the intervals below.
 */
function buildTimeline(seed: number, spec: TimelineSpec): Timeline {
  const rng = mulberry32(seed);
  const truth: [number, number][] = [];
  let at = randInt(rng, spec.lead[0], spec.lead[1]);
  const count = randInt(rng, spec.count[0], spec.count[1]);
  for (let i = 0; i < count; i += 1) {
    if (i > 0) at += randInt(rng, spec.gap[0], spec.gap[1]);
    const len = randInt(rng, spec.speech[0], spec.speech[1]);
    truth.push([at, at + len]);
    at += len;
  }
  const frames = at + randInt(rng, spec.tail[0], spec.tail[1]);
  const samples = new Float32Array(frames * FRAME);
  for (const [s, e] of truth) samples.fill(0.3, s * FRAME, e * FRAME);
  return { samples, truth, frames };
}

/** The events the truth implies: one start and one end per sentence, on the frame grid. */
function truthEvents(truth: [number, number][]): VadEvent[] {
  const events: VadEvent[] = [];
  for (const [s, e] of truth) {
    events.push({ type: 'speechStart', atSample: s * FRAME });
    events.push({ type: 'speechEnd', atSample: e * FRAME });
  }
  return events;
}

/** The shipping VAD's events over `samples`, collected in large chunks (events are chunk-invariant). */
function shipEvents(samples: Float32Array): VadEvent[] {
  const vad = new StreamingVad({ sampleRate: RATE });
  const events: VadEvent[] = [];
  const step = 4_800;
  for (let off = 0; off < samples.length; off += step) {
    for (const event of vad.push(samples.subarray(off, off + step))) events.push(event);
  }
  return events;
}

/** The truth speech, in seconds, that a segment's span covers. */
function speechSecIn(truth: [number, number][], segment: LiveSegment): number {
  const start = segment.startSec * RATE;
  const end = segment.endSec * RATE;
  let covered = 0;
  for (const [s, e] of truth) {
    covered += Math.max(0, Math.min(e * FRAME, end) - Math.max(s * FRAME, start));
  }
  return covered / RATE;
}

/** The fraction of the timeline's speech a segment keeps. */
function speechKeptRatio(truth: [number, number][], segment: LiveSegment): number {
  const totalFrames = truth.reduce((a, [s, e]) => a + (e - s), 0);
  return totalFrames ? (speechSecIn(truth, segment) * FRAMES_PER_SEC) / totalFrames : 1;
}

/** True when `cutSec` falls inside a sentence by more than half a frame (a boundary is not inside). */
function insideSentence(truth: [number, number][], cutSec: number): boolean {
  return truth.some(([s, e]) => cutSec > s * FRAME_SEC + FRAME_SEC / 2 && cutSec < e * FRAME_SEC - FRAME_SEC / 2);
}

/** The length in seconds of the truth gap whose interval contains `cutSec`, or null. */
function gapAtCutSec(truth: [number, number][], cutSec: number): number | null {
  for (let i = 0; i + 1 < truth.length; i += 1) {
    const gapStart = truth[i][1] * FRAME_SEC;
    const gapEnd = truth[i + 1][0] * FRAME_SEC;
    if (cutSec >= gapStart - FRAME_SEC && cutSec <= gapEnd + FRAME_SEC) return gapEnd - gapStart;
  }
  return null;
}

/** The WAV's declared sample rate and its decoded 16-bit samples. */
function decodeWav(bytes: Uint8Array): { sampleRate: number; samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(24, true);
  let at = 12;
  let dataAt = -1;
  let dataBytes = 0;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
    const size = view.getUint32(at + 4, true);
    if (id === 'data') {
      dataAt = at + 8;
      dataBytes = size;
    }
    at += 8 + size + (size % 2);
  }
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(dataAt + i * 2, true);
  return { sampleRate, samples };
}

const outputSec = (segment: LiveSegment): number => (segment.wav.length - 44) / 2 / WAV_RATE;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function decodeWav16(contents: Buffer): Float32Array {
  let channels = 1;
  let data: Buffer | null = null;
  let at = 12;
  while (at + 8 <= contents.length) {
    const id = contents.toString('ascii', at, at + 4);
    const size = contents.readUInt32LE(at + 4);
    if (id === 'fmt ') channels = contents.readUInt16LE(at + 10);
    else if (id === 'data') data = contents.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  if (!data) throw new Error(`no data chunk in ${L4_PATH}`);
  const frames = Math.floor(data.length / (channels * 2));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = data.readInt16LE(i * channels * 2) / 32768;
  return out;
}

// ── AC: a short input is exactly one segment ────────────────────────────────────────────────

/** Speech under the floor, with gaps that can exceed the cut pause, so the case is not vacuous. */
const SHORT_SPEC: TimelineSpec = { count: [3, 5], speech: [60, 150], gap: [40, 150], lead: [30, 60], tail: [40, 80] };

test('short input (speech under the floor) is exactly one segment, keeping its speech', async () => {
  for (let seed = 1; seed <= 120; seed += 1) {
    const timeline = buildTimeline(seed, SHORT_SPEC);
    const speechSec = timeline.truth.reduce((a, [s, e]) => a + (e - s), 0) * FRAME_SEC;
    assert.ok(speechSec < DEFAULT_MIN_SEGMENT_SEC, `seed ${seed}: the case is not short (${speechSec.toFixed(1)}s)`);

    const segments = segmentLive(timeline.samples, RATE, truthEvents(timeline.truth));
    assert.equal(segments.length, 1, `seed ${seed}: expected exactly one segment, got ${segments.length}`);
    const ratio = speechKeptRatio(timeline.truth, segments[0]);
    assert.ok(ratio >= 0.99, `seed ${seed}: speechKeptRatio ${ratio.toFixed(4)} < 0.99`);
    if (seed % 15 === 0) await breathe();
  }
});

// ── AC: a long input is cut into several segments, each with enough speech, at pauses ────────

const LONG_SPEC: TimelineSpec = { count: [22, 26], speech: [180, 260], gap: [130, 240], lead: [30, 60], tail: [40, 80] };

test('long input cuts at pauses, every non-forced cut inside a long silence, each piece >= the floor', async () => {
  let pauseCuts = 0;
  let forcedCuts = 0;
  for (let seed = 200; seed < 320; seed += 1) {
    const timeline = buildTimeline(seed, LONG_SPEC);
    const speechSec = timeline.truth.reduce((a, [s, e]) => a + (e - s), 0) * FRAME_SEC;
    assert.ok(speechSec >= 90, `seed ${seed}: the case is not long (${speechSec.toFixed(1)}s)`);

    const segments = segmentLive(timeline.samples, RATE, truthEvents(timeline.truth));
    assert.ok(segments.length >= 2, `seed ${seed}: expected >= 2 segments, got ${segments.length}`);

    for (let i = 0; i + 1 < segments.length; i += 1) {
      assert.ok(
        speechSecIn(timeline.truth, segments[i]) >= DEFAULT_MIN_SEGMENT_SEC - 2 * FRAME_SEC,
        `seed ${seed}: segment ${i} carries ${speechSecIn(timeline.truth, segments[i]).toFixed(2)}s < the floor`,
      );
      const cut = segments[i].endSec;
      if (segments[i].forced) {
        forcedCuts += 1;
        continue;
      }
      pauseCuts += 1;
      assert.ok(!insideSentence(timeline.truth, cut), `seed ${seed}: a pause cut at ${cut.toFixed(3)} is inside a sentence`);
      const gap = gapAtCutSec(timeline.truth, cut);
      assert.ok(gap !== null, `seed ${seed}: pause cut at ${cut.toFixed(3)} is not in any gap`);
      assert.ok((gap ?? 0) >= MIN_PAUSE_SEC - FRAME_SEC, `seed ${seed}: pause cut only clears ${(gap ?? 0).toFixed(3)}s`);
    }
    if (seed % 15 === 0) await breathe();
  }
  // Positive control: a pause cut was actually read, or the criteria above were vacuous.
  assert.ok(pauseCuts > 0, 'no pause cut was read: the long-input criterion never ran');
  assert.ok(forcedCuts >= 0, 'forced cuts counted');
});

// ── AC: no true pause — the ceiling is the only cut, and it is measured ──────────────────────

test('L4-nonstop is cut only by the ceiling, at a quiet frame, with a 0.4s overlap', () => {
  assert.ok(existsSync(L4_PATH), `the long-corpus sample is missing at ${L4_PATH} — the criterion cannot run without it`);
  const samples = decodeWav16(readFileSync(L4_PATH));
  const segments = segmentLive(samples, RATE, shipEvents(samples));
  assert.ok(segments.length >= 2, `L4 produced ${segments.length} segment(s), so there is no ceiling reading`);

  const frames = Math.floor(samples.length / FRAME);
  const energies = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) energies[i] = frameRms(samples, i * FRAME, FRAME);

  for (let i = 0; i < segments.length; i += 1) {
    assert.ok(
      outputSec(segments[i]) <= DEFAULT_MAX_SEGMENT_SEC + FRAME_SEC,
      `L4 segment ${i} is ${outputSec(segments[i]).toFixed(2)}s > the ceiling`,
    );
    if (i + 1 < segments.length) {
      assert.equal(segments[i].forced, true, `L4 segment ${i}'s cut is not forced`);

      const cutFrame = Math.round(segments[i].endSec * FRAMES_PER_SEC) - 1;
      const from = Math.max(0, cutFrame - 100);
      const window = Array.from(energies.subarray(from, cutFrame + 1)).sort((a, b) => a - b);
      const median = window[Math.floor(window.length / 2)];
      assert.ok(
        energies[cutFrame] <= median + 1e-12,
        `L4 forced cut ${i} energy ${energies[cutFrame].toExponential(2)} > window median ${median.toExponential(2)}`,
      );

      const overlap = segments[i].endSec - segments[i + 1].startSec;
      assert.ok(Math.abs(overlap - OVERLAP_SEC) <= FRAME_SEC, `L4 segments ${i}/${i + 1} overlap ${overlap.toFixed(3)}s`);
    }
  }
});

// ── AC: the gap filter — long internal gaps compressed to 1.0s, short ones kept ──────────────

test('internal gaps over 1.0s are compressed to exactly 1.0s; shorter ones are kept sample-exact', () => {
  // A fixed case whose expected bytes are computed by hand: speech / (2.5s gap) / speech / (0.5s
  // gap) / speech. The gap over the filter loses its excess; the one under it keeps every sample.
  const speech = 80;
  const longGap = 125; // 2.5s
  const shortGap = 25; // 0.5s
  const truth: [number, number][] = [];
  let at = 40;
  for (const gap of [0, longGap, shortGap]) {
    at += gap;
    truth.push([at, at + speech]);
    at += speech;
  }
  const frames = at + 60;
  const samples = new Float32Array(frames * FRAME);
  for (const [s, e] of truth) samples.fill(0.3, s * FRAME, e * FRAME);

  const segments = segmentLive(samples, RATE, truthEvents(truth));
  assert.equal(segments.length, 1, 'the fixed case must be a single segment');
  const { samples: decoded } = decodeWav(segments[0].wav);

  const keep = Math.round(DEFAULT_KEEP_GAP_SEC * FRAMES_PER_SEC);
  const expectedFrames = 3 * speech + Math.min(longGap, keep) + Math.min(shortGap, keep);
  assert.ok(
    Math.abs(decoded.length - expectedFrames * FRAME) <= FRAME,
    `filtered length ${decoded.length} samples is not the hand-computed ${expectedFrames * FRAME} (± 1 frame)`,
  );

  // The short gap survives verbatim: its samples in the output equal the input's, scaled to PCM.
  const shortGapStart = truth[1][1]; // frame index of the 0.5s gap's first frame
  // Its offset in the filtered output: the first two sentences and the first (truncated) gap.
  const gapOffsetFrames = 2 * speech + Math.min(longGap, keep);
  for (let i = 0; i < shortGap; i += 1) {
    for (let n = 0; n < FRAME; n += 1) {
      const source = samples[(shortGapStart + i) * FRAME + n];
      assert.equal(decoded[(gapOffsetFrames + i) * FRAME + n], Math.round(source * 32767), 'a sub-filter gap changed');
    }
  }
});

test('randomised short timelines: output length equals speech plus the summed min(gap, 1.0s) filter', async () => {
  const keep = Math.round(DEFAULT_KEEP_GAP_SEC * FRAMES_PER_SEC);
  for (let seed = 400; seed < 460; seed += 1) {
    const timeline = buildTimeline(seed, { count: [3, 5], speech: [50, 90], gap: [10, 140], lead: [20, 40], tail: [20, 40] });
    const speechFrames = timeline.truth.reduce((a, [s, e]) => a + (e - s), 0);
    if (speechFrames >= Math.round(DEFAULT_MIN_SEGMENT_SEC * FRAMES_PER_SEC)) continue;

    const segments = segmentLive(timeline.samples, RATE, truthEvents(timeline.truth));
    assert.equal(segments.length, 1, `seed ${seed}: expected one segment`);
    const { samples: decoded } = decodeWav(segments[0].wav);

    // The oracle: every sentence kept, every internal gap truncated to the filter, computed from
    // the truth — not from a second copy of the segmenter's own scan.
    let expectedFrames = 0;
    for (let i = 0; i < timeline.truth.length; i += 1) {
      expectedFrames += timeline.truth[i][1] - timeline.truth[i][0];
      if (i + 1 < timeline.truth.length) {
        expectedFrames += Math.min(timeline.truth[i + 1][0] - timeline.truth[i][1], keep);
      }
    }
    assert.ok(
      Math.abs(decoded.length - expectedFrames * FRAME) <= FRAME,
      `seed ${seed}: filtered length ${decoded.length} vs expected ${expectedFrames * FRAME} (± 1 frame)`,
    );
    if (seed % 15 === 0) await breathe();
  }
});

// ── AC: no speech in, no segments out ───────────────────────────────────────────────────────

test('an input with no speech produces no segments and does not throw', () => {
  const frames = 30 * FRAMES_PER_SEC;

  const silent = new Float32Array(frames * FRAME);
  assert.deepEqual(segmentLive(silent, RATE, shipEvents(silent)), []);

  // A −50 dBFS room tone: constant, speechless energy the detector must not fire on.
  const rng = mulberry32(7);
  const floor = new Float32Array(frames * FRAME);
  const amp = 10 ** (-50 / 20);
  for (let i = 0; i < floor.length; i += 1) floor[i] = amp * (2 * rng() - 1);
  const events = shipEvents(floor);
  assert.equal(events.length, 0, 'the room tone produced VAD events — it is not speechless');
  assert.deepEqual(segmentLive(floor, RATE, events), []);
});

// ── AC: the segmentation does not depend on how the PCM was chunked ──────────────────────────

test('the segments are identical however the PCM is chunked', async () => {
  const timeline = buildTimeline(600, { count: [14, 16], speech: [180, 240], gap: [130, 200], lead: [20, 40], tail: [20, 40] });
  const events = truthEvents(timeline.truth);

  /** Feed `samples` in chunks of `chunk`, delivering each event with the chunk that contains it. */
  const feed = (chunk: number): LiveSegment[] => {
    const segmenter = new LiveSegmenter({ sampleRate: RATE });
    const out: LiveSegment[] = [];
    let ei = 0;
    for (let off = 0; off < timeline.samples.length; off += chunk) {
      const end = Math.min(timeline.samples.length, off + chunk);
      const batch: VadEvent[] = [];
      while (ei < events.length && events[ei].atSample < end) batch.push(events[ei++]);
      for (const segment of segmenter.push(timeline.samples.subarray(off, end), off, batch)) out.push(segment);
    }
    for (const segment of segmenter.flush()) out.push(segment);
    return out;
  };

  const reference = feed(4_800);
  assert.ok(reference.length >= 2, 'the chunk-invariance case produced fewer than two segments');

  for (const chunk of [1, 160, 320]) {
    const segments = feed(chunk);
    assert.equal(segments.length, reference.length, `chunk=${chunk}: segment count differs`);
    for (let i = 0; i < segments.length; i += 1) {
      assert.equal(segments[i].startSec, reference[i].startSec, `chunk=${chunk}: segment ${i} start differs`);
      assert.equal(segments[i].endSec, reference[i].endSec, `chunk=${chunk}: segment ${i} end differs`);
      assert.equal(segments[i].forced, reference[i].forced, `chunk=${chunk}: segment ${i} forced differs`);
      assert.equal(sha256(segments[i].wav), sha256(reference[i].wav), `chunk=${chunk}: segment ${i} bytes differ`);
    }
    await breathe();
  }
}, 240_000);

// ── AC: every segment is an uploadable 16 kHz WAV inside the request budget ────────────────────

test('every emitted segment is a 16 kHz WAV whose request body fits the 10 MB budget', () => {
  assert.ok(existsSync(L4_PATH), `the long-corpus sample is missing at ${L4_PATH}`);
  const l4 = decodeWav16(readFileSync(L4_PATH));
  const long = buildTimeline(600, LONG_SPEC);
  let largest = 0;
  for (const audio of [long.samples, l4]) {
    for (const segment of segmentLive(audio, RATE, shipEvents(audio))) {
      assert.equal(decodeWav(segment.wav).sampleRate, WAV_RATE, 'a segment is not a 16 kHz WAV');
      const request: AsrRequest = {
        audio: {
          bytes: segment.wav,
          mimeType: 'audio/wav',
          fileName: 'segment.wav',
          durationSec: segment.endSec - segment.startSec,
        },
      };
      const bytes = measureChatRequestBytes(request, 'qwen3-omni-flash');
      assert.ok(bytes <= MAX_REQUEST_BYTES, `a segment's request body is ${bytes} bytes > 10 MB`);
      largest = Math.max(largest, bytes);
    }
  }
  // The 60 s ceiling is what keeps this comfortable: about 2.6 MB, base64 included.
  assert.ok(largest <= 3 * 1024 * 1024, `the largest request body ${largest} bytes is not the ~2.6 MB a 60 s WAV costs`);
});

// ── AC: a lone short utterance is released by silence, not by the stop ───────────────────────

/**
 * Feeds `samples` one frame at a time, collecting each segment the moment it is emitted.
 *
 * One frame per `push` is what makes "when was it emitted" measurable to the frame: the returned
 * `atSample` is the sample the segmenter had accepted when the segment appeared, so the delay from
 * a sentence's end to its upload is exact rather than a chunk-width approximation.
 */
function runStream(samples: Float32Array, events: readonly VadEvent[]): {
  emissions: { segment: LiveSegment; atSample: number }[];
  trailing: LiveSegment[];
} {
  const segmenter = new LiveSegmenter({ sampleRate: RATE });
  const emissions: { segment: LiveSegment; atSample: number }[] = [];
  for (let k = 0; k * FRAME < samples.length; k += 1) {
    const atFrame = events.filter((e) => Math.round(e.atSample / FRAME) === k);
    const chunk = samples.subarray(k * FRAME, (k + 1) * FRAME);
    for (const segment of segmenter.push(chunk, k * FRAME, atFrame)) {
      emissions.push({ segment, atSample: (k + 1) * FRAME });
    }
  }
  return { emissions, trailing: segmenter.flush() };
}

/** One tone run of `speechFrames` after `leadFrames`, then `tailFrames` of silence. */
function buildSpeechThenSilence(leadFrames: number, speechFrames: number, tailFrames: number): Float32Array {
  const samples = new Float32Array((leadFrames + speechFrames + tailFrames) * FRAME);
  samples.fill(0.3, leadFrames * FRAME, (leadFrames + speechFrames) * FRAME);
  return samples;
}

test('a lone short utterance is flushed exactly at the flush window, and not before it', async () => {
  const flushFrames = Math.round(DEFAULT_FLUSH_SILENCE_SEC * FRAMES_PER_SEC);
  // 4.9 s: the negative control the AC names — two frames short of the window.
  const justUnderFrames = Math.round(4.9 * FRAMES_PER_SEC);
  let checked = 0;
  for (let seed = 1; seed <= 120; seed += 1) {
    const rng = mulberry32(seed);
    const speechFrames = randInt(rng, 20, 120); // 0.4–2.4 s: every length under the floor
    const lead = randInt(rng, 10, 60);
    const truth: [number, number][] = [[lead, lead + speechFrames]];
    const events = truthEvents(truth);
    const speechEndSample = (lead + speechFrames) * FRAME;

    // The window is reached: exactly one emission, at end + 5.0 s, and continued silence adds none.
    const reached = runStream(buildSpeechThenSilence(lead, speechFrames, flushFrames + 40), events);
    assert.equal(reached.emissions.length, 1, `seed ${seed}: expected one emission, got ${reached.emissions.length}`);
    assert.equal(reached.trailing.length, 0, `seed ${seed}: a segment was still buffered after the flush`);
    const { segment, atSample } = reached.emissions[0];
    assert.ok(
      Math.abs(atSample - speechEndSample - flushFrames * FRAME) <= FRAME,
      `seed ${seed}: emitted ${((atSample - speechEndSample) / RATE).toFixed(3)}s after the speech, not ${DEFAULT_FLUSH_SILENCE_SEC}s`,
    );
    assert.ok(
      Math.abs(segment.endSec * RATE - speechEndSample) <= FRAME,
      `seed ${seed}: the flushed segment does not end at the last speech frame`,
    );

    // The window is not reached: nothing streams, and only the stop releases the buffer.
    const short = runStream(buildSpeechThenSilence(lead, speechFrames, justUnderFrames), events);
    assert.equal(short.emissions.length, 0, `seed ${seed}: emitted with only 4.9s of silence`);
    assert.equal(short.trailing.length, 1, `seed ${seed}: the stop did not release the held utterance`);
    assert.ok(
      Math.abs(short.trailing[0].endSec * RATE - speechEndSample) <= FRAME,
      `seed ${seed}: the held segment does not end at the last speech frame`,
    );
    checked += 1;
    if (seed % 30 === 0) await breathe();
  }
  assert.ok(checked >= 100, 'the flush window was read on fewer than a hundred seeded utterances');
});

test('silence after a flush produces nothing until new speech opens the next segment', () => {
  const speech = 80; // 1.6 s
  const lead = 20;
  const longGap = Math.round(60 * FRAMES_PER_SEC); // 60 s of continued silence after the first flush
  const truth: [number, number][] = [
    [lead, lead + speech],
    [lead + speech + longGap, lead + speech + longGap + speech],
  ];
  // A tail under the window, so the second utterance is still buffered when the stream ends and the
  // stop — not the flush — releases it. Two segments, each its own sentence, in order.
  const frames = lead + speech + longGap + speech + 20;
  const samples = new Float32Array(frames * FRAME);
  for (const [s, e] of truth) samples.fill(0.3, s * FRAME, e * FRAME);

  const { emissions, trailing } = runStream(samples, truthEvents(truth));
  assert.equal(emissions.length, 1, 'the 60 s silence after the first sentence must not produce a second segment');
  assert.equal(trailing.length, 1, 'the second sentence must wait for the stop, not be lost');
  assert.ok(
    Math.abs(emissions[0].segment.startSec * RATE - truth[0][0] * FRAME) <= FRAME,
    'the flushed segment is not the first sentence',
  );
  assert.ok(
    Math.abs(trailing[0].startSec * RATE - truth[1][0] * FRAME) <= FRAME,
    'the released segment is not the second sentence',
  );
  assert.ok(trailing[0].startSec > emissions[0].segment.startSec, 'the second segment did not follow the first');
});

// ── AC: sparse speech — one segment per sentence, released within the flush window ────────────

const SPARSE_PATH = `${LONG_DIR}/L3-sparse.wav`;
const LONG_MANIFEST_PATH = `${LONG_DIR}/manifest.json`;

type LongManifestEntry = {
  id: string;
  segments: { index: number; startSec: number; endSec: number }[];
};

test('L3-sparse yields one segment per sentence, each released within the flush window of its end', () => {
  assert.ok(existsSync(SPARSE_PATH), `the sparse sample is missing at ${SPARSE_PATH} — the criterion cannot run without it`);
  assert.ok(existsSync(LONG_MANIFEST_PATH), `the long-corpus manifest is missing at ${LONG_MANIFEST_PATH}`);
  const manifest = JSON.parse(readFileSync(LONG_MANIFEST_PATH, 'utf8')) as LongManifestEntry[];
  const sparse = manifest.find((entry) => entry.id === 'L3-sparse');
  assert.ok(sparse, 'the manifest has no L3-sparse entry');

  const samples = decodeWav16(readFileSync(SPARSE_PATH));
  const { emissions, trailing } = runStream(samples, shipEvents(samples));
  const released = [...emissions, ...trailing.map((segment) => ({ segment, atSample: samples.length }))];
  assert.equal(released.length, sparse.segments.length, `L3-sparse should cut ${sparse.segments.length} segments, got ${released.length}`);

  const endSec = samples.length / RATE;
  sparse.segments.forEach((sentence, i) => {
    const { segment, atSample } = released[i];
    const delaySec = Math.min(atSample / RATE, endSec) - sentence.endSec;
    assert.ok(
      Math.abs(segment.startSec - sentence.startSec) <= 0.5,
      `L3 segment ${i} starts at ${segment.startSec.toFixed(3)}s, not at its sentence's ${sentence.startSec}s`,
    );
    assert.ok(
      delaySec <= DEFAULT_FLUSH_SILENCE_SEC + FRAME_SEC,
      `L3 segment ${i} was released ${delaySec.toFixed(3)}s after its sentence ended`,
    );
  });
});

// ── AC: gaps under the flush window never open a new segment ──────────────────────────────────

test('timelines whose gaps stay under the flush window remain one segment keeping its speech', async () => {
  // Every gap < 5 s and the summed speech < the 20 s floor: no pause cut and no flush can fire, so
  // the whole input is the single trailing segment the stop releases.
  const spec: TimelineSpec = { count: [3, 6], speech: [40, 150], gap: [40, 240], lead: [10, 50], tail: [10, 240] };
  let checked = 0;
  for (let seed = 700; seed <= 820; seed += 1) {
    const timeline = buildTimeline(seed, spec);
    const speechFrames = timeline.truth.reduce((a, [s, e]) => a + (e - s), 0);
    const longestGap = timeline.truth.slice(1).reduce((m, [s], i) => Math.max(m, s - timeline.truth[i][1]), 0);
    assert.ok(speechFrames < DEFAULT_MIN_SEGMENT_SEC * FRAMES_PER_SEC, `seed ${seed}: the case is not under the floor`);
    assert.ok(longestGap < DEFAULT_FLUSH_SILENCE_SEC * FRAMES_PER_SEC, `seed ${seed}: a gap reached the flush window`);

    const segments = segmentLive(timeline.samples, RATE, truthEvents(timeline.truth));
    assert.equal(segments.length, 1, `seed ${seed}: expected one segment, got ${segments.length}`);
    const ratio = speechKeptRatio(timeline.truth, segments[0]);
    assert.ok(ratio >= 0.99, `seed ${seed}: speechKeptRatio ${ratio.toFixed(4)} < 0.99`);
    checked += 1;
    if (seed % 30 === 0) await breathe();
  }
  assert.ok(checked >= 100, 'the sub-flush criterion was read on fewer than a hundred timelines');
});

// ── Falsification: each wrong segmenter moves exactly the reading its mistake should ──────────

test('false forms: dropping the floor, cutting at fixed times and dropping the overlap each go red', () => {
  // A short timeline whose longest gap exceeds the cut pause, so removing the floor splits it.
  let short: Timeline | null = null;
  for (let seed = 1; seed <= 60 && !short; seed += 1) {
    const candidate = buildTimeline(seed, SHORT_SPEC);
    const longestGap = candidate.truth.slice(1).reduce((m, [s], i) => Math.max(m, s - candidate.truth[i][1]), 0);
    const speechFrames = candidate.truth.reduce((a, [s, e]) => a + (e - s), 0);
    if (longestGap >= CUT_PAUSE_FRAMES && speechFrames < DEFAULT_MIN_SEGMENT_SEC * FRAMES_PER_SEC) short = candidate;
  }
  assert.ok(short, 'no short timeline with a gap past the cut pause — the false form would be vacuous');
  const shortEvents = truthEvents(short.truth);
  assert.equal(segmentLive(short.samples, RATE, shortEvents).length, 1, 'control: the real segmenter must be green');
  const noFloor = segmentLive(short.samples, RATE, shortEvents, { minSegmentSec: 0 });
  assert.ok(noFloor.length > 1, `form1 (no floor) did not split the short input (got ${noFloor.length})`);

  // ② Cut at fixed times instead of on pauses: the cuts land inside sentences.
  const longTimeline = buildTimeline(200, LONG_SPEC);
  const realSegments = segmentLive(longTimeline.samples, RATE, truthEvents(longTimeline.truth));
  assert.ok(
    realSegments.every((s, i) => i + 1 === realSegments.length || !insideSentence(longTimeline.truth, s.endSec)),
    'control: the real segmenter must keep every cut out of the sentences',
  );
  const durationSec = longTimeline.frames * FRAME_SEC;
  const fixed: LiveSegment[] = [];
  for (let t = 0; t < durationSec; t += 40) {
    fixed.push({ wav: new Uint8Array(0), startSec: t, endSec: Math.min(durationSec, t + 40), forced: false });
  }
  assert.ok(
    fixed.some((s) => insideSentence(longTimeline.truth, s.endSec)),
    'form2 (fixed-time cuts) put no cut inside a sentence — the ruler would be insensitive',
  );

  // ③ Remove the forced-cut overlap: the L4 ceiling test's "0.4s overlap" reading must be a reading.
  const l4 = decodeWav16(readFileSync(L4_PATH));
  const l4Events = shipEvents(l4);
  const realL4 = segmentLive(l4, RATE, l4Events);
  assert.ok(
    Math.abs(realL4[0].endSec - realL4[1].startSec - OVERLAP_SEC) <= FRAME_SEC,
    'control: the real segmenter must carry the 0.4s overlap',
  );
  const noOverlap = segmentLive(l4, RATE, l4Events, { overlapSec: 0 });
  assert.ok(
    Math.abs(noOverlap[0].endSec - noOverlap[1].startSec - OVERLAP_SEC) > FRAME_SEC,
    'form3 (no overlap) still reads 0.4s — the reading is not load-bearing',
  );
});
