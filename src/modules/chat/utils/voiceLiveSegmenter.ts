/**
 * The continuous-capture segmenter: the missing link between the streaming VAD's frame-by-frame
 * decisions and the segment pipeline's upload jobs.
 *
 * `voiceEndpoint.ts`'s `StreamingVad` answers "was this 20 ms frame speech?" and, from that,
 * where a sentence ends. `voiceSegments.ts`'s pipeline answers "what happens to a segment once it
 * is a job?" — ordinals, retries, reassembly. What neither owns is the step between them: turning
 * a live PCM stream into the *segments themselves*. That is this module, and it owns exactly five
 * rules, each of which is a decision rather than a detection one:
 *
 *   · FLUSH ON SILENCE (`DEFAULT_FLUSH_SILENCE_SEC`, 10 s). Once the buffered speech has been
 *     followed by this much continuous silence, it is emitted *however short it is*. This is the
 *     latency rule: without it a lone short utterance waits inside the buffer until the user
 *     presses stop, because the min-length floor below would otherwise step over every pause.
 *     The emitted segment does not carry the wait — it ends at the last speech frame, with only
 *     the usual trailing keep-gap. The wait after a segment is a property from a *real unit price*
 *     re-read (input ¥0.8 / output ¥2.7 per million tokens): a 15 s request costs ¥0.001–0.006, so
 *     a minute of speech cut into many requests is a fraction of a yuan a day. The recogniser's
 *     own latency (15–22 s on `dashscope-omni`) dwarfs the extra wait, so cost is not the reason
 *     to wait — but a cut is: a self-correction split across a pause is never resolved (see the
 *     constant below), so the flush errs late rather than early.
 *
 *   · MIN LENGTH (`DEFAULT_MIN_SEGMENT_SEC`, 20 s). A segment is not worth cutting at a *pause*
 *     until enough of it is speech. The original 30 s came from the same fixed-overhead cost model;
 *     the re-read above is why it drops to 20. While the buffered *speech* is under the floor, a
 *     pause does not end the segment: it is stepped over and kept (compressed, below). The silence
 *     flush above is the release valve for everything the floor would otherwise hold.
 *
 *   · CUT ON A PAUSE (`DEFAULT_CUT_PAUSE_SEC`, 2.0 s). Once the floor is reached, the segment ends
 *     at the first pause at least this long. A pause is the safest place a cut can land — no word
 *     is on it — so a pause cut carries no overlap.
 *
 *   · THE CEILING (`DEFAULT_MAX_SEGMENT_SEC`, 60 s). A run that reaches this much *emitted* audio
 *     with no long pause is force-cut at its quietest recent frame. A 60 s 16 kHz mono WAV is
 *     about 1.9 MB, comfortably inside `dashscope-omni`'s 10 MB whole-request budget. A forced
 *     cut lands inside speech by definition, so the next segment is pulled back across it by
 *     `OVERLAP_SEC` — the word on the cut appears in both halves for the text layer to dedupe.
 *
 *   · THE GAP FILTER (`DEFAULT_KEEP_GAP_SEC`, 1.0 s). A pause the min-length rule stepped over is
 *     silence the recogniser does not need in full. Gaps at or under the filter are kept
 *     sample-exact — a short pause is a punctuation cue (`pauseCues`), not waste — and only the
 *     excess of a *long* gap is dropped, down to the filter's length.
 *
 * WHY IT IS DRIVEN BY EVENTS AND NOT A SECOND DETECTOR. The frames' speech/silence decision is
 * the streaming VAD's, and a second copy of it here would be the drift the shared module exists
 * to prevent. So the segmenter is handed the audio (`push`) and the VAD's events, and it reads
 * boundaries straight off the events' sample offsets. The worklet that produces both is
 * `src/modules/chat/audio/voiceFrameProcessor.ts`.
 *
 * IT IS A PURE MODULE, AND IT IMPORTS ONLY THROUGH THE `@/` ALIAS. No DOM, no React, no clock,
 * no network: `push` is a function of the audio and the events. The `@/` alias (not a relative
 * path) is also what lets the offline truth harness load it unchanged — `experiments/voice-vad/
 * run.mjs` registers the same alias — so the module a browser runs is the module the T1 reading
 * is taken on.
 */

import { downsampleVoice, UPLOAD_SAMPLE_RATE } from '@/modules/chat/utils/audioDecode';
import { frameRms, type VadEvent } from '@/shared/voiceEndpoint';

/**
 * The shortest speech a segment may carry *before a pause ends it*. Below this the pause is
 * stepped over rather than cut on, so a short burst stays in the buffer waiting for either more
 * speech or the silence flush. It is a cost floor, not a latency one: the fixed ~407-token prompt
 * per request is why a segment is not cut at every breath. The original 30 s came from that model;
 * a re-read against the real unit price (input ¥0.8 / output ¥2.7 per million tokens) shows the
 * overhead is worth far less than that, so the floor drops to 20 s and `DEFAULT_FLUSH_SILENCE_SEC`
 * releases anything that never reaches it.
 */
export const DEFAULT_MIN_SEGMENT_SEC = 20;

/**
 * The continuous silence, after buffered speech, that emits the buffer regardless of how short it
 * is. This is the sentence's own end: a user who says one short phrase and then says nothing should
 * see text while still recording, not after a stop. It is measured in VAD frame counts rather than
 * against a wall clock, so a throttled (background) tab — where timers fire late and audio frames do
 * not — still flushes at the same point in the audio. The emitted segment ends at the last speech
 * frame; the wait itself is not carried into the upload.
 *
 * WHY 10 s, MEASURED. `docs/experiments/2026-10-04-voice-pause-split.md` drove the shipping
 * `dashscope-omni` adapter over a spoken self-correction (`改一下 A，嗯不对，应该是 B`) two ways,
 * paired on the same audio: sent whole, the correction resolves 60/60; cut at the pause (the cut
 * the segmenter makes when the pause exceeds this constant), it resolves 0/60 — the first half is
 * a standalone "change A" instruction and `dashscope-omni` carries no context across requests, so
 * nothing later can retract it. The loss is total at every tested pause (2, 5 and 10 s), so the
 * experiment's registered tie-break (no pause inside tolerance ⇒ least gap ⇒ tie broken to the
 * LARGER pause, because a later flush cuts fewer corrections and latency is the secondary term)
 * selects the largest tested value. The evidence is directional only (n=20 per cell).
 */
export const DEFAULT_FLUSH_SILENCE_SEC = 10;

/**
 * The longest a segment may grow without a long pause. 60 s of 16 kHz mono PCM is about 1.9 MB,
 * and its base64 body about 2.6 MB — inside `dashscope-omni`'s 10 MB whole-request budget with an
 * order of magnitude to spare. It is also the sweep's selected ceiling for the streaming VAD.
 */
export const DEFAULT_MAX_SEGMENT_SEC = 60;

/**
 * The pause length at which a segment that has reached the floor is cut.
 *
 * MEASURED, NOT ASSERTED. The proposal's provisional initial value was 0.8 s (its endpoint
 * sweep's starting point). On the ceiling's own test case — `corpus/long/L4-nonstop`, described as
 * continuous speech — that value is wrong: the file's *internal* silences (between the sub-runs a
 * single sentence is heard as) run up to 1.98 s, so a 0.8 s threshold cuts "continuous" input on
 * its own breaths and the input no longer reads as a ceiling test at all. 2.0 s is the shortest
 * whole level above that maximum, so L4 is cut only by `DEFAULT_MAX_SEGMENT_SEC`; anything a
 * speaker would call a sentence break is longer, and AC3's "a non-forced cut lands in a pause of
 * at least 0.8 s" is still satisfied with room to spare.
 */
export const DEFAULT_CUT_PAUSE_SEC = 2.0;

/** The length a stepped-over silence gap is compressed to. Gaps at or under it are untouched. */
export const DEFAULT_KEEP_GAP_SEC = 1.0;

/** How far the segment after a forced cut is pulled back, so the cut word is in both halves. */
export const OVERLAP_SEC = 0.4;

/** One upload-sized segment: its WAV bytes and where it sat in the input's own timebase. */
export type LiveSegment = {
  /** 16 kHz mono 16-bit PCM WAV, ready to be a request body. */
  wav: Uint8Array;
  /** Start of the segment in seconds from the stream's first sample (input timebase). */
  startSec: number;
  /** End of the segment in seconds (input timebase). For a pause cut this is the pause's start. */
  endSec: number;
  /** True when the segment ended on the ceiling rather than on a pause. */
  forced: boolean;
};

export type LiveSegmenterOptions = {
  /** The rate the input PCM is at. The output WAV is always `UPLOAD_SAMPLE_RATE` (16 kHz). */
  sampleRate: number;
  minSegmentSec?: number;
  maxSegmentSec?: number;
  cutPauseSec?: number;
  flushSilenceSec?: number;
  keepGapSec?: number;
  overlapSec?: number;
};

/** A segment before its WAV is built: frame bounds plus whether a cut (not the flush) closed it. */
type RawSegment = {
  startFrame: number;
  /** Exclusive end frame. */
  endFrame: number;
  forced: boolean;
  /** A cut closed it. `false` only for the trailing segment `flush` emits. */
  closed: boolean;
};

/** The result of one whole-buffer pass: the segments, how many a cut closed, and the frame flags. */
type Scan = {
  segments: RawSegment[];
  closedCount: number;
  flags: Uint8Array;
};

/** Frames the ceiling's quietest-frame search looks back over — two seconds, matching the reading. */
const FORCE_CUT_SEARCH_SEC = 2;

/**
 * Encodes 16-bit mono PCM as a canonical 44-byte-header WAV, as `Uint8Array` rather than `Blob`.
 *
 * The frontend's encoder (`audioDecode.ts`) hands back a `Blob` because that is what an upload
 * needs; this module's segments are judged by their bytes (a hash, a length), and a `Blob`'s bytes
 * are only reachable through an async read. The header layout is the same one — RIFF/WAVE, a
 * 16-byte `fmt ` chunk, mono, 16-bit — so a reader cannot tell the two apart.
 */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(clamped * 32_767), true);
  }
  return bytes;
}

/** Concatenate sample views into one buffer. */
function concatFloat(parts: Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A streaming segmenter. Feed it the PCM the worklet forwards (`push`) and the VAD's events
 * (either on the same `push` call or as they arrive), and it hands back each segment the moment a
 * cut closes it; `flush` emits the trailing segment when the stream ends.
 *
 * The audio is retained while it may still be part of a segment — the pending segment plus the
 * overlap window behind the last cut. Nothing before that is needed again, and callers with very
 * long streams can bound it by flushing periodically. (Retention is deliberately not trimmed in
 * place here: the whole-buffer pass below is the correctness surface, and index arithmetic that
 * mutates under it is the classic way a segmenter drifts between what a test sees and what ships.)
 */
export class LiveSegmenter {
  private readonly sampleRate: number;
  private readonly frameSize: number;
  private readonly framesPerSec: number;
  private readonly minFrames: number;
  private readonly maxFrames: number;
  private readonly cutPauseFrames: number;
  private readonly flushFrames: number;
  private readonly keepGapFrames: number;
  private readonly overlapFrames: number;
  private readonly forceCutSearchFrames: number;

  private buf: Float32Array;
  private written = 0;
  /** Per-frame energy, computed once per completed frame (chunk-size independent). */
  private readonly energies: number[] = [];
  /** The VAD's events, kept in `atSample` order. */
  private readonly events: VadEvent[] = [];
  /** How many segments have already been handed to the caller. */
  private emitted = 0;

  constructor(options: LiveSegmenterOptions) {
    const sampleRate = options.sampleRate;
    const frameSize = Math.max(1, Math.round(0.02 * sampleRate));
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.framesPerSec = sampleRate / frameSize;
    this.minFrames = Math.max(1, Math.round((options.minSegmentSec ?? DEFAULT_MIN_SEGMENT_SEC) * this.framesPerSec));
    this.maxFrames = Math.max(1, Math.round((options.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC) * this.framesPerSec));
    this.cutPauseFrames = Math.max(1, Math.round((options.cutPauseSec ?? DEFAULT_CUT_PAUSE_SEC) * this.framesPerSec));
    this.flushFrames = Math.max(1, Math.round((options.flushSilenceSec ?? DEFAULT_FLUSH_SILENCE_SEC) * this.framesPerSec));
    this.keepGapFrames = Math.max(0, Math.round((options.keepGapSec ?? DEFAULT_KEEP_GAP_SEC) * this.framesPerSec));
    this.overlapFrames = Math.max(0, Math.round((options.overlapSec ?? OVERLAP_SEC) * this.framesPerSec));
    this.forceCutSearchFrames = Math.max(1, Math.round(FORCE_CUT_SEARCH_SEC * this.framesPerSec));
    this.buf = new Float32Array(Math.max(frameSize * 64, 4096));
  }

  /**
   * Feeds one chunk of PCM. `atSample` is the chunk's first sample's offset from the stream's
   * start and must equal everything pushed before it, so a dropped or reordered chunk is a loud
   * error rather than a segment cut at the wrong place. `events` are the VAD events this chunk
   * completed — passing them here is what keeps a backdated boundary visible before the frame it
   * backdates is judged.
   *
   * Returns the segments a cut closed during this push; the trailing segment waits for `flush`.
   */
  push(samples: Float32Array, atSample: number, events: readonly VadEvent[] = []): LiveSegment[] {
    if (atSample !== this.written) {
      throw new Error(`LiveSegmenter: chunk at sample ${atSample} arrived after ${this.written} samples`);
    }
    this.ensure(this.written + samples.length);
    this.buf.set(samples, this.written);
    this.written += samples.length;

    if (events.length) {
      for (const event of events) this.events.push(event);
      this.events.sort((a, b) => a.atSample - b.atSample);
    }

    // Energies are computed exactly once per frame, on the global frame grid, so the same stream
    // yields the same energies however it was chunked.
    const frames = Math.floor(this.written / this.frameSize);
    for (let k = this.energies.length; k < frames; k += 1) {
      this.energies.push(frameRms(this.buf, k * this.frameSize, this.frameSize));
    }

    const scan = this.scan();
    const newly = scan.segments.slice(this.emitted, scan.closedCount);
    this.emitted = scan.closedCount;
    return newly.map((segment) => this.materialize(segment, scan.flags));
  }

  /** Ends the stream and emits the trailing segment (the one no cut closed). */
  flush(): LiveSegment[] {
    const scan = this.scan();
    const newly = scan.segments.slice(this.emitted);
    this.emitted = scan.segments.length;
    return newly.map((segment) => this.materialize(segment, scan.flags));
  }

  private ensure(capacity: number): void {
    if (capacity <= this.buf.length) return;
    let next = this.buf.length;
    while (next < capacity) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.buf.subarray(0, this.written));
    this.buf = grown;
  }

  /**
   * The whole-buffer pass: derive the frame flags from the events, then walk the frames applying
   * the five rules. Recomputed from scratch each `push` rather than carried incrementally, because
   * a VAD event is *backdated* — it names a boundary earlier than the frame it arrived on — and a
   * running counter would have to un-count frames it had already counted. The pass is O(frames)
   * of cheap work with the energies cached, and the emitted segments are stable: a cut needs the
   * event that defines it, and that event is present before the frame the cut is judged on.
   */
  private scan(): Scan {
    const frames = this.energies.length;
    const flags = new Uint8Array(frames);
    let ei = 0;
    let state = 0;
    for (let k = 0; k < frames; k += 1) {
      while (ei < this.events.length && Math.round(this.events[ei].atSample / this.frameSize) <= k) {
        state = this.events[ei].type === 'speechStart' ? 1 : 0;
        ei += 1;
      }
      flags[k] = state;
    }

    const segments: RawSegment[] = [];
    let pendingStart = -1;
    let speechFrames = 0;
    let outputFrames = 0;
    let lastSpeechFrame = -1;

    for (let i = 0; i < frames; i += 1) {
      if (flags[i] === 1) {
        if (pendingStart < 0) pendingStart = i;
        speechFrames += 1;
        outputFrames += 1;
        lastSpeechFrame = i;
      } else if (pendingStart >= 0 && lastSpeechFrame >= 0) {
        const gap = i - lastSpeechFrame;
        if (gap <= this.keepGapFrames) outputFrames += 1;

        // Both rules emit the same boundary — the frame after the last speech frame, so the
        // reported end is the silence's own beginning — and differ only in what they gate on.
        // The pause cut needs the floor; the silence flush does not, which is what lets a lone
        // short utterance go out. A run long enough for the floor is already cut at the shorter
        // pause threshold (2 s < 5 s), so the flush only ever fires for a buffered segment under
        // the floor. After either, the buffer is empty and continued silence produces nothing
        // until new speech opens the next segment.
        const pauseCut = speechFrames >= this.minFrames && gap >= this.cutPauseFrames;
        const silenceFlush = gap >= this.flushFrames;
        if (pauseCut || silenceFlush) {
          segments.push({ startFrame: pendingStart, endFrame: lastSpeechFrame + 1, forced: false, closed: true });
          pendingStart = -1;
          speechFrames = 0;
          outputFrames = 0;
          lastSpeechFrame = -1;
          continue;
        }
      }

      // The ceiling is checked on EVERY frame, not only on silence: the input it exists for is
      // the one with no silence to be checked on.
      if (pendingStart >= 0 && outputFrames >= this.maxFrames) {
        const from = Math.max(pendingStart + 1, i - this.forceCutSearchFrames);
        let cut = i;
        let best = this.energies[i];
        for (let f = from; f <= i; f += 1) {
          if (this.energies[f] < best) {
            best = this.energies[f];
            cut = f;
          }
        }
        segments.push({ startFrame: pendingStart, endFrame: cut + 1, forced: true, closed: true });
        const nextStart = Math.max(pendingStart + 1, cut + 1 - this.overlapFrames);
        pendingStart = nextStart;
        const re = this.recount(flags, nextStart, i);
        speechFrames = re.speech;
        outputFrames = re.output;
        lastSpeechFrame = re.lastSpeechFrame;
      }
    }

    if (pendingStart >= 0 && speechFrames > 0 && lastSpeechFrame >= 0) {
      segments.push({ startFrame: pendingStart, endFrame: lastSpeechFrame + 1, forced: false, closed: false });
    }
    return { segments, closedCount: segments.reduce((n, s) => n + (s.closed ? 1 : 0), 0), flags };
  }

  /** Re-derives a segment's counters over `[start, end]`, after a forced cut's overlap pull-back. */
  private recount(flags: Uint8Array, start: number, end: number): { speech: number; output: number; lastSpeechFrame: number } {
    let speech = 0;
    let output = 0;
    let lastSpeechFrame = -1;
    for (let t = start; t <= end; t += 1) {
      if (flags[t] === 1) {
        speech += 1;
        output += 1;
        lastSpeechFrame = t;
      } else if (lastSpeechFrame >= 0 && t - lastSpeechFrame <= this.keepGapFrames) {
        output += 1;
      }
    }
    return { speech, output, lastSpeechFrame };
  }

  /** Builds one segment's samples (gaps filtered) and its 16 kHz WAV. */
  private materialize(segment: RawSegment, flags: Uint8Array): LiveSegment {
    const { startFrame, endFrame } = segment;
    const parts: Float32Array[] = [];
    let prevEnd = -1;
    for (let k = startFrame; k < endFrame; ) {
      if (flags[k] === 0) {
        k += 1;
        continue;
      }
      let runEnd = k;
      while (runEnd < endFrame && flags[runEnd] === 1) runEnd += 1;
      if (prevEnd >= 0) {
        const keep = Math.min(k - prevEnd, this.keepGapFrames);
        if (keep > 0) {
          parts.push(this.buf.subarray(prevEnd * this.frameSize, (prevEnd + keep) * this.frameSize));
        }
      }
      parts.push(this.buf.subarray(k * this.frameSize, runEnd * this.frameSize));
      prevEnd = runEnd;
      k = runEnd;
    }

    const samples = concatFloat(parts);
    const uploaded = downsampleVoice(samples, this.sampleRate, UPLOAD_SAMPLE_RATE);
    return {
      wav: encodeWavPcm16(uploaded.samples, uploaded.sampleRate),
      startSec: (startFrame * this.frameSize) / this.sampleRate,
      endSec: (endFrame * this.frameSize) / this.sampleRate,
      forced: segment.forced,
    };
  }
}

/**
 * The batch convenience: segment a whole buffer with a whole event list, in one call.
 *
 * The offline truth harness measures a detector as `(samples, sampleRate) => segments`, so this is
 * the shape it reads. It is the same class the browser drives frame by frame — the harness's T1
 * reading is a reading of the shipping implementation, not a batch approximation of it.
 */
export function segmentLive(
  samples: Float32Array,
  sampleRate: number,
  events: readonly VadEvent[],
  options: Omit<LiveSegmenterOptions, 'sampleRate'> = {},
): LiveSegment[] {
  const segmenter = new LiveSegmenter({ sampleRate, ...options });
  const segments = segmenter.push(samples, 0, events);
  return [...segments, ...segmenter.flush()];
}
