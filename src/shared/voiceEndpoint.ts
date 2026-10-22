/**
 * Source-independent voice-activity detection: the frame decision, the streaming state
 * machine, and the endpointing that turns a speech run into upload-sized segments.
 *
 * `voiceTrim.ts` ran this decision as a batch — decode the whole clip, take the 15th
 * percentile of *its* frame energies as the noise floor, and flag frames against it.
 * That is correct for a clip that is already in memory and wrong for capture that is
 * still arriving: a live stream has no "whole clip" to take a percentile of, and a
 * dictation that never stops talking has no silence for the batch floor to find. This
 * module is that decision extracted so both paths can share it — the thresholds are
 * defined exactly once, here, and `voiceTrim.ts` imports them; a second copy of
 * `0.8 * ENTER_FACTOR` is the drift this split exists to prevent.
 *
 * Two things are added over the batch decision, and only two:
 *
 *   · a sliding noise floor — the low percentile of the last few seconds of *candidate
 *     silence* frames, rather than of the whole input. Candidate silence is a frame the
 *     current floor already calls quiet, so a long unbroken speech run cannot push the
 *     floor up into the speech and silence the detector against itself.
 *
 *   · endpointing — a sentence ends after `endpointMs` of continuous silence, and a run
 *     that reaches `maxSegmentSec` without a pause is force-cut at its quietest frame so
 *     one upload cannot exceed a provider's inline-body limit. Consecutive segments
 *     overlap, so a word sitting on a cut appears in both halves for the text layer to
 *     deduplicate.
 *
 * Everything here is a pure function of its arguments — no DOM, no React, no clock, no
 * network, no sample buffer retained. It is streaming in the sense that matters for
 * capture: it holds one 20 ms frame and two per-frame arrays (energy, flag), never the
 * audio.
 */

/**
 * Frame length for the energy detector. 20 ms is the shortest span that still contains a
 * pitch period for a low voice (~50 Hz), so a frame's RMS tracks loudness rather than the
 * waveform's instantaneous phase.
 */
export const FRAME_MS = 20;

/**
 * VAD thresholds, relative to the measured noise floor. `ENTER` is above `EXIT`; that gap
 * is the hysteresis that stops the decision flapping on frames near the boundary.
 * `SPEECH_FRAMES_TO_START` (60 ms of speech before committing) rejects clicks, key taps and
 * breaths; `SILENCE_FRAMES_TO_END` (300 ms before committing to an end) is longer than a
 * stop closure inside a word, so a plosive does not split one utterance in two.
 *
 * These six constants are the single definition the batch path and the streaming path
 * share. `src/shared/tests/voiceEndpoint.test.ts` greps for that, and `voiceTrim.ts`
 * imports them from here rather than declaring its own.
 */
export const ENTER_FACTOR = 3.0;
export const EXIT_FACTOR = 1.8;
export const SPEECH_FRAMES_TO_START = 3;
export const SILENCE_FRAMES_TO_END = 15;

/**
 * Padding kept around each detected speech region, before and after. The first phoneme of
 * a word and the final consonant are quieter than the threshold, so cutting exactly at the
 * detected boundary reliably clips them. Pre-roll is shorter than post-roll because a stop
 * consonant at the end of a word is the quieter of the two.
 */
export const PRE_ROLL_MS = 120;
export const POST_ROLL_MS = 180;

/** The percentile of frame energies taken as the noise floor, on both paths. */
export const NOISE_PERCENTILE = 0.15;

/**
 * The percentile of *recent* frame energies the sliding floor is read at.
 *
 * Lower than the batch path's, and it has to be: a four-second window in the middle of a
 * sentence is mostly speech, so the 15th percentile of it is a speech level. The floor needs a
 * percentile low enough that the window's own quiet tail — the pause inside the sentence, the
 * gap before it — is what it reads, which is exactly what the whole-clip 15th percentile gets
 * for free and a sliding window does not.
 */
export const NOISE_WINDOW_PERCENTILE = 0.15;

/**
 * The sliding floor is a percentile of the recent frame energies, kept as a log-spaced histogram
 * so a window of many seconds costs no sort per frame.
 *
 * The window is deliberately long and fed *every* frame, not just frames some earlier guess
 * called quiet. A percentile is a property of a population: the whole-clip 15th percentile the
 * batch path takes sits in the gaps only because speech frames dilute the population, so a short
 * window — or one that already excludes the loud frames — reads a *lower* quantile of the noise
 * and turns every gap into a false trigger. A long window over all frames reproduces the batch
 * population locally, which is what makes the two agree.
 */
const NOISE_WINDOW_BUCKETS = 160;
const NOISE_WINDOW_LOG_MIN = -6;
const NOISE_WINDOW_LOG_MAX = 1;

/**
 * The floor the noise estimate is never allowed below. A frame of digital silence measures
 * exactly 0, and a threshold of `0 * ENTER_FACTOR` would call every non-zero frame speech;
 * this keeps the ratio meaningful. It is far below any real noise floor.
 */
export const MIN_FRAME_ENERGY = 1e-6;

/**
 * A sentence ends after this much silence.
 *
 * 400 ms is not a guess: it is the value the T1 parameter sweep selected
 * (`experiments/voice-vad/fixtures/sweep.json`, rule `prereg.endpointSelection`,
 * recorded in `docs/experiments/2026-10-04-voice-vad-sweep.md`). Over 675 synthesised
 * timelines the 400 ms level was the smallest endpoint whose pooled over-segmentation rate
 * (0.044) stayed under the pre-registered 0.05 bound while miss rate stayed at 0 and
 * start-deviation p95 at 0.14 s; the longer levels merge sentences separated by an
 * ordinary pause and blow start-deviation p95 up to 3.7 s (800 ms) and 14.3 s (1600 ms).
 */
const DEFAULT_ENDPOINT_MS = 400;

/**
 * A run with no pause is force-cut at this length.
 *
 * 60 s is the sweep's selected value (`prereg.maxSegmentSelection`): the largest level with
 * zero `maxSegmentSec` violations, and therefore the fewest forced cuts (0 across the
 * no-real-pause cells, against 199 at 10 s). A 60 s 16 kHz mono WAV is about 1.9 MB, far
 * under the inline-body limit the ceiling exists for. The sweep's top level is 60 s, so the
 * optimum could lie beyond it — recorded as a limitation of the sweep, not of this value.
 */
const DEFAULT_MAX_SEGMENT_SEC = 60;

/** How much consecutive segments overlap, so a word on a cut appears in both. */
const DEFAULT_OVERLAP_SEC = 0.3;

/** How much recent audio the sliding noise floor is read over. */
const DEFAULT_NOISE_WINDOW_SEC = 30;

/**
 * Frames pushed into the noise window before the detector commits to any decision.
 *
 * Without this the very first frames would be judged against the floor's initial value, and
 * a stream that opens on room tone would be judged before its own floor is measurable. Half
 * a second of calibration is short enough that a sentence after a normal lead-in is not
 * delayed beyond it.
 */
const BOOTSTRAP_FRAMES = 25;

/** The trailing window a forced cut searches for its quietest frame. */
const FORCE_CUT_SEARCH_SEC = 2;

/** Backdating a transition by `SPEECH_FRAMES_TO_START`/`SILENCE_FRAMES_TO_END` frames. */
const MAX_BACKDATE_FRAMES = Math.max(SPEECH_FRAMES_TO_START, SILENCE_FRAMES_TO_END);

/** The VAD state: 0 is silence, 1 is speech. A number rather than a boolean to match the bit flags. */
export type VadState = 0 | 1;

/** A transition of the frame decision, backdated to the first frame of its evidence run. */
export type VadEvent = {
  type: 'speechStart' | 'speechEnd';
  /** Sample offset of the transition, from the start of the stream. */
  atSample: number;
};

/** One upload-sized speech region, in seconds from the start of the stream. */
export type VoiceSegment = {
  startSec: number;
  endSec: number;
  /**
   * True when this segment's end is a `maxSegmentSec` force-cut rather than an endpoint or
   * the end of the input. The text layer keys deduplication off these cuts, and the T1
   * metrics exclude them from the "cut inside a sentence" rate — a forced cut is a
   * deliberate ceiling, not a detector mistake.
   */
  forced: boolean;
};

/** The sliding noise estimate's mode. `fixed` exists only as a falsification control. */
export type NoiseFloorMode = 'sliding' | 'fixed';

export type StreamingVadOptions = {
  sampleRate: number;
  /** Silence this long ends a sentence. Provisional default 0.8 s. */
  endpointMs?: number;
  /** A segment longer than this is force-cut. Provisional default 30 s. */
  maxSegmentSec?: number;
  /** Seconds consecutive segments overlap. Default 0.4 s. */
  overlapSec?: number;
  /** Seconds of recent candidate-silence the sliding floor is read over. Default 2 s. */
  noiseWindowSec?: number;
  /**
   * Test/falsification knobs, defaulted to production behaviour. They exist so the T1
   * criteria can prove each rule is load-bearing: disabling the ceiling must red the
   * length bound, fixing the floor must red the room-tone false-alarm reading, and
   * shortening the endpoint must red the over/mid-cut readings.
   */
  maxSegmentEnabled?: boolean;
  noiseFloorMode?: NoiseFloorMode;
  /** The constant floor `noiseFloorMode: 'fixed'` uses. Defaults to `MIN_FRAME_ENERGY`. */
  fixedNoiseFloor?: number;
  /** Override the silence run that ends a sentence, in frames. Defaults to `endpointMs`. */
  endpointFramesOverride?: number;
};

/** One hysteresis step's outcome: the state it moved to, its run length, and the event it produced. */
export type FrameStep = {
  state: VadState;
  /** How many consecutive frames have disagreed with the previous state. */
  run: number;
  event: 'none' | 'speechStart' | 'speechEnd';
};

/**
 * The hysteresis thresholds for a measured noise floor.
 *
 * `exit` is floored at 60% of `enter` so a very low floor cannot collapse the hysteresis
 * band to nothing; that keeps a pair of thresholds even when the ratio is computed from a
 * near-zero floor.
 */
export function thresholdsFor(noise: number): { enter: number; exit: number } {
  const enter = noise * ENTER_FACTOR;
  const exit = Math.max(noise * EXIT_FACTOR, enter * 0.6);
  return { enter, exit };
}

/**
 * One frame of the hysteresis decision, as a pure function of the frame's energy and the
 * state that preceded it. This is the whole of the frame judgement; the batch path runs it
 * over computed flags in `frameFlags`, the streaming path runs it frame by frame.
 */
export function stepFrame(energy: number, state: VadState, run: number, noise: number): FrameStep {
  const { enter, exit } = thresholdsFor(noise);
  const threshold = state ? exit : enter;
  const above = energy >= threshold;
  if (above === Boolean(state)) return { state, run: 0, event: 'none' };

  const nextRun = run + 1;
  const need = state ? SILENCE_FRAMES_TO_END : SPEECH_FRAMES_TO_START;
  if (nextRun < need) return { state, run: nextRun, event: 'none' };

  const nextState: VadState = state ? 0 : 1;
  return { state: nextState, run: 0, event: nextState ? 'speechStart' : 'speechEnd' };
}

/**
 * Frame-level speech/silence decisions, with hysteresis, over a whole buffer.
 *
 * The transition is *backdated* by the number of frames the decision needed: the state only
 * becomes trustworthy after `need` agreeing frames, but the boundary belongs where the
 * evidence started, not where the counter ran out. Without that, every region would begin
 * `need` frames late and the run-up to each word would be trimmed away.
 *
 * This is the batch path's decision, kept here so both paths read the same thresholds and
 * the same backdating rule. `voiceTrim.ts` imports it.
 */
export function frameFlags(energies: Float64Array, noise: number): Uint8Array {
  const { enter, exit } = thresholdsFor(noise);

  const flags = new Uint8Array(energies.length);
  let state: VadState = 0;
  let run = 0;

  for (let i = 0; i < energies.length; i++) {
    const above = energies[i] >= (state ? exit : enter);
    if (above !== Boolean(state)) {
      run++;
      const need = state ? SILENCE_FRAMES_TO_END : SPEECH_FRAMES_TO_START;
      if (run >= need) {
        state = state ? 0 : 1;
        run = 0;
        for (let k = Math.max(0, i - need + 1); k <= i; k++) flags[k] = state;
      }
    } else {
      run = 0;
    }
    flags[i] = state;
  }

  return flags;
}

/** Root-mean-square of `frame` samples starting at `from`. */
export function frameRms(samples: Float32Array, from: number, frame: number): number {
  let acc = 0;
  for (let i = 0; i < frame; i++) {
    const v = samples[from + i];
    acc += v * v;
  }
  return Math.sqrt(acc / frame);
}

/** The log-spaced histogram bucket an energy falls in. */
function bucketFor(energy: number): number {
  const span = NOISE_WINDOW_LOG_MAX - NOISE_WINDOW_LOG_MIN;
  const t = (Math.log10(Math.max(energy, 1e-9)) - NOISE_WINDOW_LOG_MIN) / span;
  const bucket = Math.round(t * (NOISE_WINDOW_BUCKETS - 1));
  return Math.max(0, Math.min(NOISE_WINDOW_BUCKETS - 1, bucket));
}

/** The energy a bucket stands for, at its centre — a hair above the true value, which errs toward silence. */
function bucketValue(bucket: number): number {
  const span = NOISE_WINDOW_LOG_MAX - NOISE_WINDOW_LOG_MIN;
  const t = (bucket + 0.5) / (NOISE_WINDOW_BUCKETS - 1);
  return 10 ** (NOISE_WINDOW_LOG_MIN + t * span);
}

/**
 * A streaming VAD over 20 ms frames.
 *
 * `push` takes audio as it arrives, in whatever chunk sizes the caller has, and returns the
 * events those samples produced. `flush` ends the stream and returns the segments. The
 * frame grid is fixed by `sampleRate`, so a chunk boundary can never move a frame: the same
 * samples pushed as 1, 160, 320 or 4800 at a time produce the same frames, the same events
 * and the same segments.
 */
export class StreamingVad {
  private readonly sampleRate: number;
  private readonly frame: number;
  private readonly endpointFrames: number;
  private readonly maxSegmentFrames: number;
  private readonly overlapFrames: number;
  private readonly preFrames: number;
  private readonly postFrames: number;
  private readonly noiseWindowFrames: number;
  private readonly forceCutSearchFrames: number;
  private readonly maxSegmentEnabled: boolean;
  private readonly noiseFloorMode: NoiseFloorMode;
  private readonly fixedNoiseFloor: number;
  private readonly maxSegmentSec: number;

  /** Buffered samples that do not yet make a frame. */
  private pending: Float32Array;
  private pendingCount = 0;

  /** The sliding floor's histogram and its ring of bucket indices, one entry per frame. */
  private readonly noiseCounts: Int32Array;
  private readonly noiseRing: Int32Array;
  private noiseRingPos = 0;
  private noiseRingSize = 0;
  private noise: number;

  private state: VadState = 0;
  private run = 0;
  private frameIndex = 0;

  /** One entry per processed frame. Kept for the whole stream: 1 byte + 8 bytes per 20 ms. */
  private readonly energies: number[] = [];
  private readonly flags: number[] = [];
  /** Per frame: `energy < enter`. The endpoint's definition of silence — see `buildSegments`. */
  private readonly quiet: boolean[] = [];

  constructor(options: StreamingVadOptions) {
    const sampleRate = options.sampleRate;
    const frame = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
    this.sampleRate = sampleRate;
    this.frame = frame;
    this.maxSegmentSec = options.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC;
    this.endpointFrames =
      options.endpointFramesOverride ??
      Math.max(1, Math.round(((options.endpointMs ?? DEFAULT_ENDPOINT_MS) / 1000) * sampleRate / frame));
    this.maxSegmentFrames = Math.max(1, Math.round((this.maxSegmentSec * sampleRate) / frame));
    this.overlapFrames = Math.max(0, Math.round(((options.overlapSec ?? DEFAULT_OVERLAP_SEC) * sampleRate) / frame));
    this.preFrames = Math.max(0, Math.round(PRE_ROLL_MS / FRAME_MS));
    this.postFrames = Math.max(0, Math.round(POST_ROLL_MS / FRAME_MS));
    this.noiseWindowFrames = Math.max(
      BOOTSTRAP_FRAMES,
      Math.round(((options.noiseWindowSec ?? DEFAULT_NOISE_WINDOW_SEC) * sampleRate) / frame),
    );
    this.forceCutSearchFrames = Math.max(1, Math.round((FORCE_CUT_SEARCH_SEC * sampleRate) / frame));
    this.maxSegmentEnabled = options.maxSegmentEnabled ?? true;
    this.noiseFloorMode = options.noiseFloorMode ?? 'sliding';
    this.fixedNoiseFloor = options.fixedNoiseFloor ?? MIN_FRAME_ENERGY;
    this.noise = this.noiseFloorMode === 'fixed' ? this.fixedNoiseFloor : MIN_FRAME_ENERGY;
    this.noiseCounts = new Int32Array(NOISE_WINDOW_BUCKETS);
    this.noiseRing = new Int32Array(this.noiseWindowFrames);
    this.pending = new Float32Array(frame);
  }

  /** Feeds `chunk` into the detector and returns the events it completed. */
  push(chunk: Float32Array): VadEvent[] {
    const events: VadEvent[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const room = this.frame - this.pendingCount;
      const take = Math.min(room, chunk.length - offset);
      this.pending.set(chunk.subarray(offset, offset + take), this.pendingCount);
      this.pendingCount += take;
      offset += take;
      if (this.pendingCount === this.frame) {
        this.pendingCount = 0;
        const energy = frameRms(this.pending, 0, this.frame);
        this.processFrame(energy, events);
      }
    }
    return events;
  }

  /** Ends the stream and returns its segments, ordered, in seconds. */
  flush(): VoiceSegment[] {
    return this.buildSegments();
  }

  /**
   * Feeds one already-measured frame energy.
   *
   * The AudioWorklet path frames the audio on the audio thread and can hand the decision the
   * frame it already computed; feeding the energy rather than the samples is what lets a real
   * worklet run and a caller replay its exact frames through the same state machine.
   */
  pushFrameEnergy(energy: number): VadEvent[] {
    const events: VadEvent[] = [];
    this.processFrame(energy, events);
    return events;
  }

  /**
   * The detector's speech *firing*, one region per hysteresis speech run, pre/post roll
   * applied and touching regions merged — the same geometry the batch detector's
   * `vadSegments` has.
   *
   * This is what the T1 false-alarm reading must be taken on. `flush()`'s segments are upload
   * chunks: they deliberately carry a sub-endpoint pause inside them, because that is what
   * "one sentence" means to an endpointing segmenter. Counting that carried silence as a
   * false trigger would be measuring the endpoint rule, not the detector.
   */
  regions(): VoiceSegment[] {
    const total = this.flags.length;
    const raw: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && this.flags[i] === 1;
      if (on && start < 0) start = i;
      else if (!on && start >= 0) {
        raw.push([Math.max(0, start - this.preFrames), Math.min(total, i + this.postFrames)]);
        start = -1;
      }
    }
    const merged: [number, number][] = [];
    for (const [a, b] of raw) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged.map(([a, b]) => ({
      startSec: (a * this.frame) / this.sampleRate,
      endSec: (b * this.frame) / this.sampleRate,
      forced: false,
    }));
  }

  /** The noise floor the detector currently holds. Read by the T1 criterion's readings. */
  get noiseFloor(): number {
    return this.noise;
  }

  /**
   * One frame's decision plus the floor update.
   *
   * The floor is updated *after* the decision, so a frame is judged against the floor that
   * preceded it and the update can never change that frame's own verdict. During the
   * bootstrap the detector records candidate silence but commits to nothing — the state
   * stays 0 — so the first decisions are made against a measured floor rather than the
   * initial constant.
   */
  private processFrame(energy: number, events: VadEvent[]): void {
    const bootstrapping = this.frameIndex < BOOTSTRAP_FRAMES;

    if (!bootstrapping) {
      const step = stepFrame(energy, this.state, this.run, this.noise);
      this.state = step.state;
      this.run = step.run;
      if (step.event !== 'none') {
        const need = step.event === 'speechStart' ? SPEECH_FRAMES_TO_START : SILENCE_FRAMES_TO_END;
        const backdateFrom = Math.max(0, this.frameIndex - need + 1);
        for (let k = backdateFrom; k < this.frameIndex; k++) this.flags[k] = this.state;
        events.push({
          type: step.event,
          atSample: backdateFrom * this.frame,
        });
      }
    } else {
      this.state = 0;
      this.run = 0;
    }

    this.energies.push(energy);
    this.flags.push(this.state);
    this.frameIndex++;

    // Every frame feeds the floor. See NOISE_WINDOW_PERCENTILE: a percentile is a property of a
    // population, and a window that already excludes the loud frames reads a lower quantile of
    // the noise than the batch path does.
    if (this.noiseFloorMode !== 'fixed') this.updateNoiseFloor(energy);
    this.quiet.push(energy < thresholdsFor(this.noise).enter);
  }

  /** Adds one frame to the sliding histogram (evicting the oldest) and re-reads the floor. */
  private updateNoiseFloor(energy: number): void {
    const ring = this.noiseRing;
    if (this.noiseRingSize === this.noiseWindowFrames) {
      this.noiseCounts[ring[this.noiseRingPos]]--;
    } else {
      this.noiseRingSize++;
    }
    const bucket = bucketFor(energy);
    ring[this.noiseRingPos] = bucket;
    this.noiseCounts[bucket]++;
    this.noiseRingPos = (this.noiseRingPos + 1) % this.noiseWindowFrames;
    this.noise = Math.max(
      MIN_FRAME_ENERGY,
      this.floorPercentile(this.noiseCounts, this.noiseRingSize, NOISE_WINDOW_PERCENTILE),
    );
  }

  /** The energy at the requested percentile of the histogram, as the bucket's centre. */
  private floorPercentile(counts: Int32Array, size: number, p: number): number {
    if (size <= 0) return MIN_FRAME_ENERGY;
    const target = Math.max(1, Math.ceil(p * size));
    let acc = 0;
    for (let b = 0; b < NOISE_WINDOW_BUCKETS; b++) {
      acc += counts[b];
      if (acc >= target) return bucketValue(b);
    }
    return bucketValue(NOISE_WINDOW_BUCKETS - 1);
  }

  /**
   * Turns the frame flags into segments.
   *
   * Speech runs separated by less than the endpoint gap are one sentence; a longer gap ends
   * it. Each utterance is then cut into pieces no longer than `maxSegmentSec`, each forced
   * cut landing on the quietest frame of the trailing search window so it damages as little
   * speech as possible. Pre/post roll are applied to the outer edges, later pieces overlap
   * their predecessor, and a final clamp guarantees no segment exceeds the ceiling.
   */
  private buildSegments(): VoiceSegment[] {
    const frame = this.frame;
    const total = this.flags.length;
    if (!total) return [];

    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && this.flags[i] === 1;
      if (on && start < 0) start = i;
      else if (!on && start >= 0) {
        runs.push([start, i]);
        start = -1;
      }
    }

    // Quiet prefix sums, so "is there an endpoint-length stretch of below-enter frames between
    // these two speech runs" is answerable in one subtraction per start.
    const quietPrefix = new Int32Array(total + 1);
    for (let i = 0; i < total; i++) quietPrefix[i + 1] = quietPrefix[i] + (this.quiet[i] ? 1 : 0);
    const hasEndSizedQuiet = (from: number, to: number): boolean => {
      if (to - from < this.endpointFrames) return false;
      for (let b = from; b + this.endpointFrames <= to; b++) {
        if (quietPrefix[b + this.endpointFrames] - quietPrefix[b] === this.endpointFrames) return true;
      }
      return false;
    };

    // Two speech runs are one sentence unless `endpointMs` of true silence separates them. The
    // silence is measured against the *enter* threshold — the same evidence that starts speech —
    // and not against the hysteresis state: in a noisy gap the state can stay on through spikes
    // for far longer than the endpoint, and measuring against it would fuse two sentences into
    // one upload, exactly the failure the endpoint exists to prevent.
    const utterances: [number, number][] = [];
    for (const [a, b] of runs) {
      const last = utterances[utterances.length - 1];
      if (last && a - last[1] < this.endpointFrames) last[1] = b;
      else if (last && !hasEndSizedQuiet(last[1], a)) last[1] = b;
      else utterances.push([a, b]);
    }

    const pieces: { start: number; end: number; forced: boolean }[] = [];
    for (const [uStart, uEnd] of utterances) {
      let pos = uStart;
      while (this.maxSegmentEnabled && uEnd - pos > this.maxSegmentFrames) {
        const target = pos + this.maxSegmentFrames;
        const from = Math.max(pos + 1, target - this.forceCutSearchFrames);
        const to = Math.min(uEnd - 1, target);
        let cut = target;
        let best = Infinity;
        for (let f = from; f <= to; f++) {
          if (this.energies[f] < best) {
            best = this.energies[f];
            cut = f;
          }
        }
        pieces.push({ start: pos, end: cut, forced: true });
        pos = cut;
      }
      pieces.push({ start: pos, end: uEnd, forced: false });
    }

    const segments: VoiceSegment[] = [];
    for (let i = 0; i < pieces.length; i++) {
      let startFrame = pieces[i].start;
      let endFrame = pieces[i].end;
      startFrame -= this.preFrames;
      // The overlap exists so a word sitting on a forced cut appears in both halves. An
      // endpoint boundary falls in silence — no word is on it — so the next segment is NOT
      // pulled back across it; doing so would move every start away from the sentence it
      // names and show up as start deviation for no gain.
      if (i > 0 && pieces[i - 1].forced) startFrame -= this.overlapFrames;
      if (!pieces[i].forced) endFrame += this.postFrames;
      startFrame = Math.max(0, Math.min(total, startFrame));
      endFrame = Math.max(0, Math.min(total, endFrame));
      if (endFrame <= startFrame) continue;

      let startSec = (startFrame * frame) / this.sampleRate;
      const endSec = (endFrame * frame) / this.sampleRate;
      // The ceiling is the criterion; the rolls and the overlap are not allowed to break it,
      // so the last word is the start being pulled forward rather than the end falling back.
      // With the ceiling disabled (a falsification control) nothing is clamped either, or the
      // control could not produce the overlong segment it exists to produce.
      if (this.maxSegmentEnabled && endSec - startSec > this.maxSegmentSec) {
        startSec = endSec - this.maxSegmentSec;
      }
      segments.push({ startSec, endSec, forced: pieces[i].forced });
    }

    return segments;
  }
}

/**
 * The `(samples, sampleRate) => segments` interface the T1 truth harness measures.
 *
 * It is the streaming detector run over a whole buffer at once — the same code the
 * AudioWorklet path drives frame by frame — so a reading taken here is a reading of the
 * implementation that ships, not of a batch approximation of it.
 */
export function detectVoiceSegments(
  samples: Float32Array,
  sampleRate: number,
  options: Omit<StreamingVadOptions, 'sampleRate'> = {},
): VoiceSegment[] {
  const vad = new StreamingVad({ sampleRate, ...options });
  vad.push(samples);
  return vad.flush();
}

/** Re-exported so callers that only need the backdating bound do not restate it. */
export const VAD_BACKDATE_FRAMES = MAX_BACKDATE_FRAMES;
