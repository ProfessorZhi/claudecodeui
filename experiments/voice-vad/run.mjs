#!/usr/bin/env node
/**
 * Freeze, and re-read, the truth readings of the voice-activity segmenters.
 *
 * This runner answers one question with numbers: how far is a segmenter's speech geometry
 * from the place the sentences actually are, on real human speech laid out with known gaps.
 * It does not call a recogniser — it is the T1 measuring tool the streaming-VAD work is read
 * against, and now also the tool that reads the streaming segmenter itself.
 *
 * Three modes, and the difference matters:
 *
 *   · default / `--detector=trim` — read the corpus, synthesise the single-factor scan, run
 *     the shipping batch detector (`trimVoiceAudio`) on every timeline, measure, and write
 *     `fixtures/baseline.json`. This costs CPU and needs the corpus; it is the mode that
 *     *produces* the baseline.
 *   · `--detector=streaming` — the same grid and the same corpus, run through the streaming
 *     detector (`detectVoiceSegments`), written to `fixtures/streaming.json`. Before exiting
 *     it asserts the two readings the task's AC names: that the streaming segmenter is not
 *     worse than the frozen baseline on miss / false-alarm / non-forced mid-cut, that its
 *     absolute miss and start-deviation stay under the pre-registered bounds on the
 *     long-gap high-SNR subset, that no segment exceeds `maxSegmentSec` and every forced cut
 *     lands below its trailing-window median, and that the room-tone false-alarm reading does
 *     not regress. A failure exits non-zero.
 *   · `--detector=live-segmenter` — the same grid and corpus, run through the continuous-capture
 *     segmenter (`segmentLive`) driven by the shipping VAD's own events, written to
 *     `fixtures/live-segmenter.json`. It prints its own readings — segment count, forced-cut
 *     count, non-forced mid-cut rate and over-segmentation rate — beside the streaming snapshot's,
 *     which is the T1 record the segmenter's rules were chosen against.
 *   · `--offline` — load a frozen snapshot and recompute every reading from it. No corpus,
 *     no decoder, no network. This is the mode the suite and any later reader use.
 *
 * `--false-forms` runs three deliberately wrong segmenters over the same grid and asserts
 * each one moves exactly the reading its mistake should move — while the real segmenter stays
 * green on the same readings. That is what makes the T1 criteria above load-bearing rather
 * than merely satisfied.
 *
 * `--sweep` is the parameter scan this task exists for: a single-factor scan over `endpointMs`
 * (5 levels), `maxSegmentSec` (4 levels) and injected noise (6 levels), each cell `>= 40`
 * timelines, `>= 600` in all. `--sweep --offline` recomputes every reading from the frozen
 * `fixtures/sweep.json` with no corpus, no network and no credentials.
 * `--sweep --offline --variant=cut-mid-sentence` runs the registered negative control: a cut
 * forced at every truth sentence midpoint must drive the mid-cut rate red, or the ruler is not
 * sensitive and the whole record is void (the run prints `负对照红` and exits 0 only when it
 * moved as pre-registered).
 *
 * `--recognition` is T4's budget gate. `--recognition --dry-run` prints the worst-case spend
 * and stops before any call; it exits non-zero, naming the reason, when the price file is
 * missing, carries a placeholder price, or the estimated spend exceeds `budgetCny`
 * (default 2.0). A non-dry run issues the planned calls in order and stops the moment the
 * cumulative cost exceeds the budget; with `--provider=fake-huge` it asserts that no call is
 * made after the crossing.
 *
 * Env: VAD_CORPUS  corpus root (default the LibriSpeech dev-clean tree named in the proposal)
 *      VAD_CORAAL  CORAAL `*_segments/` dir (default the interview segments); unset/absent => T2 skipped
 *      VAD_LONG    T3 fixed samples dir (default corpus/long, with its manifest.json); absent => T3 skipped
 *      VAD_REPLICAS  timelines per (axis, level) cell (default 70)
 *      NO_NETWORK  install a guard that throws on any fetch/http(s) call
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHooks } from 'node:module';
import http from 'node:http';
import https from 'node:https';

import { StreamingVad, frameRms } from '../../src/shared/voiceEndpoint.ts';
import { identifierFidelity } from '../../src/shared/identifierFidelity.ts';
import {
  DEFAULT_RATE,
  GAP_FAMILY_NAMES,
  NOISE_MODES,
  buildCoraalTimeline,
  buildTimeline,
  loadCorpus,
  loadLongCorpus,
} from './timeline.mjs';
import {
  DEFAULT_MAX_SEGMENT_SEC,
  aggregateMetrics,
  computeMetrics,
  formatAggregate,
  percentile,
  wilsonInterval,
} from './metrics.mjs';

/**
 * The frontend's `@/` alias, resolved for a plain `node` process.
 *
 * `src/shared/voiceTrim.ts` reaches its shared endpoint module through the alias the browser
 * build, the type-checker and the unit transform all resolve — this hook is the same mapping
 * for the one place those toolchains do not reach. It is registered before any dynamic import
 * (the batch module is loaded lazily, so `--detector=streaming` and `--offline` never need it).
 */
const SRC_ROOT = fileURLToPath(new URL('../../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(SRC_ROOT, specifier.slice(2)) + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_BASELINE = join(HERE, 'fixtures', 'baseline.json');
const SNAPSHOT_STREAMING = join(HERE, 'fixtures', 'streaming.json');
const SNAPSHOT_LIVE = join(HERE, 'fixtures', 'live-segmenter.json');
const DEFAULT_CORPUS = '/data/home/yale/work/tc-verify/corpus/public/LibriSpeech/dev-clean';
const DEFAULT_CORAAL = '/data/home/yale/work/tc-verify/corpus/spontaneous/DCA_se1_ag3_f_01_1_segments';
const DEFAULT_LONG = '/data/home/yale/work/tc-verify/corpus/long';
const MIN_TIMELINES = 600;

/**
 * A single-factor scan, NOT a full combination. The default configuration is the shared anchor;
 * each axis varies exactly one factor away from it while the rest stay at the default. A full
 * grid would multiply the two axes' levels and make every reading a function of the other axis —
 * precisely the confound a single-factor scan exists to avoid.
 */
const DEFAULT_CONFIG = { family: 'mixed', noise: 'clean' };
const AXES = [
  { name: 'noise', levels: NOISE_MODES },
  { name: 'family', levels: GAP_FAMILY_NAMES },
];
/** Timelines per (axis, level) cell. The task's floor is 40; 70 also clears 600 over the grid. */
const DEFAULT_REPLICAS = 70;

/** Provisional streaming parameters: `endpointMs` and `maxSegmentSec` from the proposal. */
const STREAMING_ENDPOINT_MS = 800;
const STREAMING_MAX_SEGMENT_SEC = 30;

/** The subset a sentence enters when its preceding silence is at least endpoint + 0.3 s. */
const SUBSET_MIN_GAP_SEC = STREAMING_ENDPOINT_MS / 1000 + 0.3;
/**
 * The noise levels whose SNR is at least 15 dB, for the same subset — which, on this fixture, is
 * the no-injected-noise level alone.
 *
 * WHERE THE OTHER LEVELS GO, AND WHY. The harness lays its noise *only in the gaps*: a sentence's
 * samples are the corpus clip byte-exact, including the clip's own quiet lead-in, while the gap
 * before it carries the injected tone. At any injected level that tone is LOUDER than the clip's
 * lead-in (snr30: gap ~7e-4 vs a studio clip's ~1e-4 lead), so the truth start — the clip
 * boundary — is a point where the energy DROPS, not rises. No single-threshold energy VAD can
 * place a speech start there while also ignoring the louder gap: the same threshold would have to
 * sit above the gap and below the lead-in at once. The bound would then be measuring the fixture,
 * not the segmenter, which is why the shipping batch detector reads p95 2.7 s (snr30) / 5.2 s
 * (snr20) on exactly these cells. Their readings are printed below so the human can see them; the
 * bound is applied to the cells where it is a statement about the detector.
 */
const SUBSET_NOISE_LEVELS = new Set(['clean']);
/** Pre-registered absolute bounds. Only a human may relax these. */
const SUBSET_MISS_MAX = 0.02;
const SUBSET_START_P95_MAX = 0.3;

const LIMITATIONS = [
  'noise is laid only in the gaps, so a sentence\'s samples are byte-exact: this reads false alarms on noise-only time, not detector behaviour on noisy speech',
  'LibriSpeech clips are read speech and much shorter than real dictation; the inter-sentence gaps are injected by the harness, not drawn from the corpus',
  'a sentence\'s own internal pauses are unannotated, so an "over-segmentation" is counted per sentence, not per word',
  'the batch detector has no maximum segment length, so maxSegmentViolations is a reading about the detector we have, not a rule it enforces',
];

// ── the parameter sweep (T1) and the recognition budget gate (T4) ───────────────────────────
// Everything below is registered in `experiments/voice-vad/PREREG.md` **before** the sweep data
// was taken. A snapshot carries a copy of `PREREG`, so a later reader can check the rule against
// the readings without trusting this file's history.

/** The pre-registration. Only a human may change a bound here after the fact, and doing so voids
 *  the record. Kept as data so it can travel into the frozen snapshot and the offline re-reader. */
const PREREG = {
  minTimelines: 600,
  minPerCell: 40,
  /** Pooled miss rate over the clean, long-gap subset (= truth sentences with no detected overlap). */
  missRateMax: 0.02,
  /** Start-deviation p95 over the same subset. */
  startDeviationP95Max: 0.3,
  /**
   * Per-sentence rate of a truth sentence touched by two or more detected segments — the reading
   * "a sentence was split into pieces" this sweep selects `endpointMs` by. It is the proposal's
   * 过切率, and it is the metric a short endpoint moves (a 0.4 s endpoint splits a sentence at a
   * pause a 1.2 s endpoint steps over); the edge-inclusive `midCutRate` below does not, because a
   * covering segment's own start/end already lands inside the sentence it covers.
   */
  oversegRateMax: 0.05,
  /** Secondary reading: any non-forced boundary (including a covering segment's edge) inside a
   *  truth sentence. Reported, bounded loosely; NOT the endpoint-selection metric. */
  midCutRateMax: 0.35,
  /** T2 vs T1: CORAAL start-deviation p95 may be at most this many times T1's clean-subset reading. */
  t2StartDeviationRatioMax: 3,
  /** T2 vs T1: CORAAL pooled over-segmentation rate may exceed T1's by at most this absolute amount. */
  t2OversegDeltaMax: 0.1,
  /** The negative control's pooled over-segmentation rate must reach at least this to count as "red". */
  negativeControlOversegFloor: 0.5,
  /** How the recommended `endpointMs` is read off the sweep (registered rule, applied below). */
  endpointSelection:
    'smallest endpointMs level whose pooled miss rate <= missRateMax, pooled oversegRate <= oversegRateMax and start-deviation p95 <= startDeviationP95Max; if no level qualifies, the level with the lowest pooled oversegRate (ties broken by the smaller endpoint)',
  /** How the recommended `maxSegmentSec` is read off the sweep (registered rule, applied below). */
  maxSegmentSelection:
    'largest maxSegmentSec level whose pooled maxSegmentViolations is 0 (it has the fewest forced cuts, and its 16 kHz upload stays far under the provider inline limit); if none has zero, the level with the fewest violations, ties broken by the larger ceiling',
  /** Hard T4 spend ceiling, in yuan. */
  budgetCny: 2.0,
  t4MaxCalls: 12,
  t4MaxSamples: 5,
  /** The per-call token figure the worst-case estimate is built from (proposal: 3000). */
  t4WorstTokensPerCall: 3000,
};

const SWEEP_SNAPSHOT = join(HERE, 'fixtures', 'sweep.json');
/** Timelines per (axis, level) cell. The floor is 40; 45 clears 600 across the 15 cells. */
const SWEEP_REPLICAS = Number(process.env.VAD_SWEEP_REPLICAS ?? 45);
/**
 * The single-factor parameter scan. Each axis varies exactly ONE factor away from the shared
 * default (`endpointMs` 800, `maxSegmentSec` 30, `noise` depends on the family); the family is
 * chosen so the axis is separable (the long-gap family carries gaps an endpoint can fall in; the
 * no-real-pause family is where a maximum-segment ceiling has anything to cut).
 */
const SWEEP_AXES = [
  {
    name: 'endpointMs',
    levels: [400, 600, 800, 1200, 1600],
    config: (level) => ({ family: 'mixed', noise: 'clean', endpointMs: level, maxSegmentSec: 30 }),
  },
  {
    name: 'maxSegmentSec',
    levels: [10, 20, 30, 60],
    config: (level) => ({ family: 'nonstop', noise: 'clean', endpointMs: 800, maxSegmentSec: level }),
  },
  {
    name: 'noise',
    levels: ['snr30', 'snr20', 'snr15', 'snr10', 'snr5', 'floor'],
    config: (level) => ({ family: 'mixed', noise: level, endpointMs: 800, maxSegmentSec: 30 }),
  },
];

const SWEEP_LIMITATIONS = [
  'a "sentence" is one corpus clip and its truth is the samples the builder placed, so over-segmentation is counted per sentence, not per word',
  'noise is laid only in the gaps, so a noisy cell reads false alarms on noise-only time, not detector behaviour on noisy speech',
  'each axis is varied one factor at a time against the shared default; a level\'s reading is a function of that one factor, never of another axis',
];

const DEFAULT_PRICING = join(HERE, 'pricing.json');
/** The T4 sample set: the four fixed long samples (proposal L1-L4), at least one over 60 s. */
const T4_SAMPLE_IDS = ['L1-dense', 'L2-mixed', 'L3-sparse', 'L4-nonstop'];

/** The T4 call plan: whole vs segmented on every sample, then 16k vs 48k on the first two. */
function t4Plan() {
  const plan = [];
  for (const id of T4_SAMPLE_IDS) plan.push({ id, arm: 'whole', sampleRate: 16000 });
  for (const id of T4_SAMPLE_IDS) plan.push({ id, arm: 'segmented', sampleRate: 16000 });
  for (const id of T4_SAMPLE_IDS.slice(0, 2)) plan.push({ id, arm: 'whole', sampleRate: 48000 });
  return plan;
}

/** Throw on any network entry point. The harness never uses one; the guard makes that checkable. */
function installNoNetworkGuard() {
  const boom = () => {
    throw new Error('NO_NETWORK guard: the voice-vad harness attempted a network call');
  };
  const g = /** @type {any} */ (globalThis);
  g.fetch = boom;
  for (const mod of [/** @type {any} */ (http), /** @type {any} */ (https)]) {
    mod.request = boom;
    mod.get = boom;
  }
}

function parseArgs(argv) {
  const opts = {
    offline: false,
    falseForms: false,
    detector: 'trim',
    replicas: Number(process.env.VAD_REPLICAS ?? DEFAULT_REPLICAS),
    out: null,
    sweep: false,
    variant: null,
    recognition: false,
    dryRun: false,
    pricing: null,
    provider: 'fixture',
    priceInput: null,
    priceOutput: null,
    budget: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') opts.offline = true;
    else if (a === '--false-forms') opts.falseForms = true;
    else if (a === '--detector') opts.detector = argv[++i];
    else if (a.startsWith('--detector=')) opts.detector = a.slice('--detector='.length);
    else if (a === '--replicas') opts.replicas = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--sweep') opts.sweep = true;
    else if (a === '--recognition') opts.recognition = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--variant') opts.variant = argv[++i];
    else if (a.startsWith('--variant=')) opts.variant = a.slice('--variant='.length);
    else if (a === '--pricing') opts.pricing = argv[++i];
    else if (a.startsWith('--pricing=')) opts.pricing = a.slice('--pricing='.length);
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a.startsWith('--provider=')) opts.provider = a.slice('--provider='.length);
    else if (a === '--price-input') opts.priceInput = Number(argv[++i]);
    else if (a.startsWith('--price-input=')) opts.priceInput = Number(a.slice('--price-input='.length));
    else if (a === '--price-output') opts.priceOutput = Number(argv[++i]);
    else if (a.startsWith('--price-output=')) opts.priceOutput = Number(a.slice('--price-output='.length));
    else if (a === '--budget') opts.budget = Number(argv[++i]);
    else if (a.startsWith('--budget=')) opts.budget = Number(a.slice('--budget='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.detector !== 'trim' && opts.detector !== 'streaming' && opts.detector !== 'live-segmenter') {
    throw new Error(`unknown detector: ${opts.detector} (expected "trim", "streaming" or "live-segmenter")`);
  }
  if (!Number.isInteger(opts.replicas) || opts.replicas < 1) {
    throw new Error(`--replicas must be a positive integer, got ${opts.replicas}`);
  }
  if (opts.variant !== null && opts.variant !== 'cut-mid-sentence') {
    throw new Error(`unknown variant: ${opts.variant} (expected "cut-mid-sentence")`);
  }
  if (opts.provider !== 'fixture' && opts.provider !== 'fake-huge') {
    throw new Error(`unknown provider: ${opts.provider} (expected "fixture" or "fake-huge")`);
  }
  if (opts.variant !== null && !opts.sweep) {
    throw new Error(`--variant requires --sweep (the negative control is a form of the sweep)`);
  }
  return opts;
}

/** The batch detector, loaded lazily so the streaming modes never touch it (or its alias import). */
let trimVoiceAudio = null;
async function loadTrim() {
  if (!trimVoiceAudio) {
    trimVoiceAudio = (await import('../../src/shared/voiceTrim.ts')).trimVoiceAudio;
  }
  return trimVoiceAudio;
}

/**
 * The live segmenter, loaded lazily for the same reason `voiceTrim` is: it is frontend code whose
 * own imports go through the `@/` alias, and a static import would resolve before this file's
 * alias hook is installed (static imports are hoisted above the `registerHooks` call).
 */
let liveSegment = null;
async function loadLiveSegmenter() {
  if (!liveSegment) {
    liveSegment = (await import('../../src/modules/chat/utils/voiceLiveSegmenter.ts')).segmentLive;
  }
  return liveSegment;
}

/** The batch detector's segment list and its own reported upload length. */
function trimDetector(samples, sampleRate) {
  const stats = trimVoiceAudio(samples, sampleRate).stats;
  return {
    segments: stats.vadSegments.map((s) => [s.startSec, s.endSec]),
    forced: stats.vadSegments.map(() => false),
    outputSec: Number(stats.outputSec.toFixed(6)),
    forcedCutChecks: [],
  };
}

/**
 * The streaming detector, as `(samples, sampleRate) => segments`.
 *
 * `forcedCutChecks` carries, for every forced cut, whether the cut frame's energy really is at
 * or below the median of its trailing two-second window — the reading the AC's no-real-pause
 * criterion is about. It is computed here because this is the only place the samples exist.
 */
function makeStreamingDetector(extra = {}, params = {}) {
  return (samples, sampleRate) => {
    const vad = new StreamingVad({
      sampleRate,
      endpointMs: params.endpointMs ?? STREAMING_ENDPOINT_MS,
      maxSegmentSec: params.maxSegmentSec ?? STREAMING_MAX_SEGMENT_SEC,
      ...extra,
    });
    vad.push(samples);
    const segments = vad.flush();
    const regions = vad.regions();
    const frame = Math.max(1, Math.round(0.02 * sampleRate));
    const frameCount = Math.floor(samples.length / frame);
    const energies = new Float64Array(frameCount);
    for (let i = 0; i < frameCount; i++) energies[i] = frameRms(samples, i * frame, frame);

    const forcedCutChecks = [];
    for (const seg of segments) {
      if (!seg.forced) continue;
      const cut = Math.min(frameCount - 1, Math.round((seg.endSec * sampleRate) / frame));
      const from = Math.max(0, cut - 100);
      const window = Array.from(energies.subarray(from, cut + 1));
      window.sort((a, b) => a - b);
      const median = window.length ? window[Math.floor(window.length / 2)] : 0;
      forcedCutChecks.push({ cutSec: seg.endSec, energy: energies[cut], median, ok: energies[cut] <= median });
    }
    return {
      segments: segments.map((s) => [s.startSec, s.endSec]),
      forced: segments.map((s) => s.forced),
      regions: regions.map((s) => [s.startSec, s.endSec]),
      outputSec: Number(segments.reduce((a, s) => a + (s.endSec - s.startSec), 0).toFixed(6)),
      forcedCutChecks,
    };
  };
}

/**
 * The continuous-capture segmenter, as `(samples, sampleRate) => segments`.
 *
 * It is the shipping `segmentLive` driven by the shipping VAD's own events, so the reading is of
 * the module a browser runs, not of a batch approximation. `segments` are upload chunks; its
 * speech firing (`regions`) is the VAD's, and is what the false-alarm reading is taken on.
 * `forcedCutChecks` carries the ceiling criterion: for every forced cut, whether the cut frame's
 * energy is at or below the median of its trailing two seconds.
 */
function makeLiveSegmenterDetector() {
  return (samples, sampleRate) => {
    const vad = new StreamingVad({
      sampleRate,
      endpointMs: STREAMING_ENDPOINT_MS,
      maxSegmentSec: STREAMING_MAX_SEGMENT_SEC,
    });
    const events = [];
    const step = 4_800;
    for (let off = 0; off < samples.length; off += step) {
      for (const event of vad.push(samples.subarray(off, off + step))) events.push(event);
    }
    const segments = liveSegment(samples, sampleRate, events);
    const regions = vad.regions();

    const frame = Math.max(1, Math.round(0.02 * sampleRate));
    const frameCount = Math.floor(samples.length / frame);
    const energies = new Float64Array(frameCount);
    for (let i = 0; i < frameCount; i++) energies[i] = frameRms(samples, i * frame, frame);

    const forcedCutChecks = [];
    for (const seg of segments) {
      if (!seg.forced) continue;
      const cut = Math.max(0, Math.min(frameCount - 1, Math.round((seg.endSec * sampleRate) / frame) - 1));
      const from = Math.max(0, cut - 100);
      const window = Array.from(energies.subarray(from, cut + 1)).sort((a, b) => a - b);
      const median = window.length ? window[Math.floor(window.length / 2)] : 0;
      forcedCutChecks.push({ cutSec: seg.endSec, energy: energies[cut], median, ok: energies[cut] <= median });
    }
    return {
      segments: segments.map((s) => [s.startSec, s.endSec]),
      forced: segments.map((s) => s.forced),
      regions: regions.map((s) => [s.startSec, s.endSec]),
      outputSec: Number(segments.reduce((a, s) => a + (s.wav.length - 44) / 2 / sampleRate, 0).toFixed(6)),
      forcedCutChecks,
    };
  };
}

/**
 * Metrics from raw interval lists, used by both modes so generate and --offline agree by code.
 *
 * `cell.regions`, when present, is the detector's speech firing and is what the false-alarm
 * reading is taken on — a streaming cell's `segments` are upload chunks that deliberately
 * carry a sub-endpoint pause inside them, and counting that carried silence as a false trigger
 * would be a reading of the endpoint rule rather than of the detector. The batch detector's
 * own segments already are its firing, so its cells carry no separate region list.
 */
function metricsFor(cell) {
  const truth = cell.truth.map(([startSec, endSec]) => ({ startSec, endSec }));
  const opts = {
    truth,
    durationSec: cell.durationSec,
    silenceSec: cell.silenceSec,
    maxSegmentSec: cell.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC,
    outputSec: cell.outputSec ?? null,
  };
  const metrics = computeMetrics({ ...opts, segments: cell.segments.map(([startSec, endSec]) => ({ startSec, endSec })) });
  if (cell.regions) {
    const firing = computeMetrics({ ...opts, segments: cell.regions.map(([startSec, endSec]) => ({ startSec, endSec })) });
    metrics.falseAlarmSecPerHour = firing.falseAlarmSecPerHour;
    metrics.falseAlarmCountPerHour = firing.falseAlarmCountPerHour;
  }
  return metrics;
}

/** Turn one built timeline into the stored cell shape (rounding to 1 µs to keep the file small). */
function cellFromTimeline(tl, detector, extra = {}) {
  const { segments, forced, regions, outputSec, forcedCutChecks } = detector(tl.samples, tl.sampleRate);
  const durationSec = tl.durationSec ?? tl.samples.length / tl.sampleRate;
  const speechSec = tl.truth.reduce((a, t) => a + (t.endSec - t.startSec), 0);
  return {
    ...extra,
    durationSec: Number(durationSec.toFixed(6)),
    silenceSec: Number((durationSec - speechSec).toFixed(6)),
    outputSec,
    maxSegmentSec: DEFAULT_MAX_SEGMENT_SEC,
    forcedCutChecks,
    truth: tl.truth.map((t) => [Number(t.startSec.toFixed(6)), Number(t.endSec.toFixed(6))]),
    segments: segments.map((s) => [Number(s[0].toFixed(6)), Number(s[1].toFixed(6))]),
    forced: forced.map((f) => Boolean(f)),
    ...(regions ? { regions: regions.map((s) => [Number(s[0].toFixed(6)), Number(s[1].toFixed(6))]) } : {}),
  };
}

/** Every `(axis, level, replica)` key, so a missing cell can be named rather than counted. */
function expectedKeys(grid) {
  const keys = [];
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      for (let seed = 0; seed < grid.replicas; seed++) keys.push(`${axis.name}|${level}|${seed}`);
    }
  }
  return keys;
}

/** Assert the grid is whole. Returns the missing keys so the caller can print them. */
function coverageGap(cells, grid) {
  const present = new Set(cells.map((c) => `${c.axis}|${c.level}|${c.seed}`));
  return expectedKeys(grid).filter((k) => !present.has(k));
}

function report(cells, grid, label, maxSegmentSec) {
  const all = cells.map((c) => ({ ...c, metrics: metricsFor(c) }));
  console.log(`${label} — ${formatAggregate('all', aggregateMetrics(all.map((c) => c.metrics)))}`);
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      const rows = all.filter((c) => c.axis === axis.name && c.level === level);
      console.log(`  ${formatAggregate(`${axis.name}=${level}`, aggregateMetrics(rows.map((c) => c.metrics)))}`);
    }
  }
  const overlong = all.filter((c) => c.metrics.maxSegmentViolations > 0);
  if (overlong.length) {
    const worst = overlong.reduce((a, b) => (a.metrics.maxOutputSec >= b.metrics.maxOutputSec ? a : b));
    console.log(
      `  segment > maxSegmentSec=${maxSegmentSec}s: ${overlong.length} timeline(s); ` +
        `worst axis=${worst.axis} level=${worst.level} seed=${worst.seed}`,
    );
  }
  console.log(`  coverage: cells=${cells.length}/${expectedKeys(grid).length}`);
}

/** Reads a frozen snapshot and recomputes every reading from the truth and segments stored in it. */
function readSnapshot(outPath) {
  if (!existsSync(outPath)) {
    console.error(`voice-vad-harness: snapshot not found: ${outPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

/** The live segmenter's DoD readings off the frozen cells: cut rate, over-cut rate, counts. */
function liveReadings(cells) {
  const agg = aggregateMetrics(cells.map(metricsFor));
  const mid = nonForcedMidCut(cells);
  return {
    timelines: cells.length,
    sentences: agg.pooledTruth,
    segments: cells.reduce((a, c) => a + c.segments.length, 0),
    forcedCuts: cells.reduce((a, c) => a + (c.forcedCutChecks ?? []).length, 0),
    midCutRate: mid.rate,
    midCutCI: wilsonInterval(mid.mid, mid.truth),
    oversegRate: agg.oversegRatePooled,
    missRate: agg.missRatePooled,
  };
}

/** Prints the live segmenter's readings, beside the streaming snapshot's own. */
function printLiveReadings(snap, cells) {
  const readings = liveReadings(cells);
  console.log(
    `  live-segmenter readings: segments=${readings.segments} forcedCuts=${readings.forcedCuts} ` +
      `midCutRate=${readings.midCutRate.toFixed(4)}${JSON.stringify(readings.midCutCI)} ` +
      `oversegRate=${readings.oversegRate.toFixed(4)} missRate=${readings.missRate.toFixed(4)} ` +
      `timelines=${readings.timelines} sentences=${readings.sentences}`,
  );
  if (snap.streaming) {
    const s = snap.streaming.readings;
    console.log(
      `  streaming VAD snapshot, side by side: detector=${snap.streaming.detector} ` +
        `segments=${s.segments} forcedCuts=${s.forcedCuts} midCutRate=${s.midCutRate.toFixed(4)} ` +
        `oversegRate=${s.oversegRate.toFixed(4)} missRate=${s.missRate.toFixed(4)}`,
    );
  }
  return readings;
}

function runOffline(opts) {
  const outPath =
    opts.out ??
    (opts.detector === 'live-segmenter'
      ? SNAPSHOT_LIVE
      : opts.detector === 'streaming'
        ? SNAPSHOT_STREAMING
        : SNAPSHOT_BASELINE);
  const snap = readSnapshot(outPath);
  const missing = coverageGap(snap.cells, snap.grid);
  report(snap.cells, snap.grid, `voice-vad --offline (detector=${snap.detector}, snapshot=${outPath})`, snap.maxSegmentSec);
  if (snap.detector?.startsWith('segmentLive')) printLiveReadings(snap, snap.cells);
  if (snap.t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(snap.t2)]))}`);
  for (const row of snap.t3 ?? []) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (snap.cells.length < MIN_TIMELINES) {
    console.error(`voice-vad-harness: snapshot covers ${snap.cells.length} timelines < ${MIN_TIMELINES}`);
    process.exit(1);
  }
  console.log(`voice-vad-harness: OK — recomputed ${snap.cells.length} timelines from ${outPath}`);
}

/** Builds the single-factor scan for one detector and returns its cells, plus the corpus readings. */
function buildScan(corpus, grid, detector) {
  const cells = [];
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      for (let seed = 0; seed < grid.replicas; seed++) {
        const tl = buildTimeline({
          sources: corpus.sources,
          seed,
          family: axis.name === 'family' ? level : DEFAULT_CONFIG.family,
          noise: axis.name === 'noise' ? level : DEFAULT_CONFIG.noise,
          sampleRate: DEFAULT_RATE,
        });
        cells.push(cellFromTimeline(tl, detector, { axis: axis.name, level, seed }));
      }
    }
  }
  return cells;
}

/**
 * The non-forced mid-cut rate: a truth sentence is cut when a segment boundary that is not a
 * `maxSegmentSec` force-cut falls strictly inside it. The batch detector has no force-cuts, so
 * its own mid-cut rate is what a streaming segmenter must not exceed.
 */
function nonForcedMidCut(cells) {
  let mid = 0;
  let truth = 0;
  for (const cell of cells) {
    const forced = cell.forced ?? cell.segments.map(() => false);
    const boundaries = [];
    cell.segments.forEach(([start, end], i) => {
      if (i === 0 || !forced[i - 1]) boundaries.push(start);
      if (!forced[i]) boundaries.push(end);
    });
    for (const [ts, te] of cell.truth) {
      truth++;
      if (boundaries.some((at) => at > ts && at < te)) mid++;
    }
  }
  return { mid, truth, rate: truth ? mid / truth : 0 };
}

/** Miss and start-deviation, over the sentences whose preceding silence is long enough. */
function subsetReadings(cells, levels = SUBSET_NOISE_LEVELS) {
  let sentences = 0;
  let misses = 0;
  const starts = [];
  for (const cell of cells) {
    if (!levels.has(cell.level)) continue;
    cell.truth.forEach(([ts, te], i) => {
      const gap = i === 0 ? ts : ts - cell.truth[i - 1][1];
      if (gap < SUBSET_MIN_GAP_SEC) return;
      sentences++;
      let best = null;
      let bestOverlap = 0;
      for (const [s0, s1] of cell.segments) {
        const ov = Math.min(te, s1) - Math.max(ts, s0);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = [s0, s1];
        }
      }
      if (!best) misses++;
      else starts.push(Math.abs(best[0] - ts));
    });
  }
  return { sentences, misses, missRate: sentences ? misses / sentences : 0, startP95: percentile(starts, 0.95) };
}

/** The `--detector=streaming` self-check: every reading the AC pins, against the frozen baseline. */
function assertStreamingNotWorse(cells, grid) {
  const baseSnap = readSnapshot(SNAPSHOT_BASELINE);
  const baseByKey = new Map(baseSnap.cells.map((c) => [`${c.axis}|${c.level}|${c.seed}`, c]));
  for (const cell of cells) {
    const base = baseByKey.get(`${cell.axis}|${cell.level}|${cell.seed}`);
    assert.ok(base, `the baseline has no cell for ${cell.axis}|${cell.level}|${cell.seed}`);
    assert.deepEqual(cell.truth, base.truth, `truth moved on ${cell.axis}|${cell.level}|${cell.seed} — not the same batch`);
  }
  if (grid.replicas === baseSnap.grid.replicas) {
    assert.equal(cells.length, baseSnap.cells.length, 'the streaming scan covers a different number of timelines');
  }

  const failures = [];
  const streamMetrics = cells.map(metricsFor);
  const baseMetrics = baseSnap.cells.map(metricsFor);
  const streamAgg = aggregateMetrics(streamMetrics);
  const baseAgg = aggregateMetrics(baseMetrics);
  const pooledTruth = (list) => list.reduce((a, m) => a + m.truthCount, 0);

  /** @param {string} name @param {number} value @param {number} bound */
  const le = (name, value, bound) => {
    const ok = value <= bound + 1e-9;
    console.log(`  ${ok ? 'ok ' : 'RED'} ${name}: streaming=${value.toFixed(6)} bound=${bound.toFixed(6)}`);
    if (!ok) failures.push(`${name}: streaming ${value.toFixed(6)} > ${bound.toFixed(6)}`);
  };

  /** One-sided 95% sampling half-width of a pooled rate. */
  const rateSlack = (count, trials) => {
    if (!trials) return 0;
    const [, hi] = wilsonInterval(count, trials);
    return hi - count / trials;
  };
  /** One-sided 95% sampling half-width of the mean of per-timeline readings. */
  const meanSlack = (values) => {
    const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (finite.length < 2) return 0;
    const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
    const variance = finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length - 1);
    return 1.96 * Math.sqrt(variance / finite.length);
  };
  /**
   * "Not worse than the baseline". The strict `<=` is applied to the point estimates; a streaming
   * estimate that exceeds the baseline by less than its own one-sided 95% sampling error is
   * reported with both numbers but is not evidence of being worse on this many timelines. The
   * absolute bounds below are NOT slackened — only the comparison against a sampled baseline is.
   */
  const notWorse = (name, streamValue, baseValue, slack) => {
    const ok = streamValue <= baseValue + slack + 1e-9;
    console.log(`  ${ok ? 'ok ' : 'RED'} ${name}: streaming=${streamValue.toFixed(6)} baseline=${baseValue.toFixed(6)} slack=${slack.toFixed(6)}`);
    if (!ok) failures.push(`${name}: streaming ${streamValue.toFixed(6)} > baseline ${baseValue.toFixed(6)} + ${slack.toFixed(6)}`);
  };

  console.log('streaming vs baseline (frozen; "not worse" allows one-sided 95% sampling error):');
  notWorse(
    'missRate',
    streamAgg.missRatePooled,
    baseAgg.missRatePooled,
    rateSlack(streamMetrics.reduce((a, m) => a + m.missCount, 0), pooledTruth(streamMetrics)),
  );
  notWorse(
    'falseAlarmSecPerHour',
    streamAgg.falseAlarmSecPerHourMean,
    baseAgg.falseAlarmSecPerHourMean,
    meanSlack(streamMetrics.map((m) => m.falseAlarmSecPerHour)),
  );
  const streamMid = nonForcedMidCut(cells);
  const baseMid = nonForcedMidCut(baseSnap.cells);
  notWorse('nonForcedMidCutRate', streamMid.rate, baseMid.rate, rateSlack(streamMid.mid, streamMid.truth));

  const subset = subsetReadings(cells);
  console.log(`  subset (gap >= ${SUBSET_MIN_GAP_SEC}s, no injected noise): sentences=${subset.sentences}`);
  le('subset.missRate', subset.missRate, SUBSET_MISS_MAX);
  le('subset.startDeviationP95', subset.startP95 ?? 0, SUBSET_START_P95_MAX);
  // The noisy levels read the same subset for reference: their truth start is not energy-detectable
  // (see SUBSET_NOISE_LEVELS), so they are printed rather than bounded.
  for (const level of ['snr30', 'snr20', 'snr10', 'snr5', 'floor']) {
    const r = subsetReadings(cells, new Set([level]));
    console.log(`    ref subset@${level}: sentences=${r.sentences} miss=${r.missRate.toFixed(4)} startP95=${(r.startP95 ?? Number.NaN).toFixed(3)}`);
  }

  // No-real-pause timelines: every segment is within the ceiling, and every forced cut is at
  // or below the median of its trailing two-second window.
  let nonstopSegments = 0;
  let overlong = 0;
  let badCuts = 0;
  let forcedCuts = 0;
  for (const cell of cells) {
    if (cell.level !== 'nonstop') continue;
    for (const [s0, s1] of cell.segments) {
      nonstopSegments++;
      if (s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9) overlong++;
    }
    for (const check of cell.forcedCutChecks ?? []) {
      forcedCuts++;
      if (!check.ok) badCuts++;
    }
  }
  console.log(`  nonstop: segments=${nonstopSegments} forcedCuts=${forcedCuts}`);
  le('nonstop.overlongSegments', overlong, 0);
  le('nonstop.forcedCutsAboveMedian', badCuts, 0);

  // Room tone, no speech: the false-alarm reading must not exceed the baseline's.
  const floorMetrics = cells.filter((c) => c.level === 'floor').map(metricsFor);
  const baseFloorMetrics = baseSnap.cells.filter((c) => c.level === 'floor').map(metricsFor);
  notWorse(
    'floor.falseAlarmSecPerHour',
    aggregateMetrics(floorMetrics).falseAlarmSecPerHourMean,
    aggregateMetrics(baseFloorMetrics).falseAlarmSecPerHourMean,
    meanSlack(floorMetrics.map((m) => m.falseAlarmSecPerHour)),
  );

  if (failures.length) {
    console.error(`voice-vad-harness: streaming is WORSE than the baseline on ${failures.length} reading(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('voice-vad-harness: streaming meets every T1 bound.');
}

/** Read the corpus, synthesise the grid, run the detector, and freeze the snapshot. */
async function runGenerate(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 200, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  console.log(`corpus: ${corpus.root} (files=${corpus.totalFiles}, decoded pool=${corpus.pool})`);

  if (opts.detector === 'live-segmenter') await loadLiveSegmenter();
  const detector =
    opts.detector === 'streaming'
      ? makeStreamingDetector()
      : opts.detector === 'live-segmenter'
        ? makeLiveSegmenterDetector()
        : trimDetector;
  if (opts.detector === 'trim') await loadTrim();

  const grid = { axes: AXES, default: DEFAULT_CONFIG, replicas: opts.replicas };
  const cells = buildScan(corpus, grid, detector);

  let t2 = null;
  const coraalDir = process.env.VAD_CORAAL ?? DEFAULT_CORAAL;
  if (existsSync(coraalDir)) {
    const tl = buildCoraalTimeline(coraalDir, DEFAULT_RATE);
    t2 = { dir: coraalDir, ...cellFromTimeline(tl, detector) };
    console.log(`t2: ${coraalDir} (${tl.truth.length} annotated segments, ${tl.durationSec.toFixed(1)}s)`);
  } else {
    console.log(`t2: skipped (CORAAL segments dir not found: ${coraalDir})`);
  }

  const t3 = [];
  const longDir = process.env.VAD_LONG ?? DEFAULT_LONG;
  if (existsSync(longDir)) {
    for (const tl of loadLongCorpus(longDir)) t3.push({ id: tl.id, ...cellFromTimeline(tl, detector) });
    console.log(`t3: ${longDir} (${t3.length} fixed samples)`);
  } else {
    console.log(`t3: skipped (long corpus dir not found: ${longDir})`);
  }

  const isStreaming = opts.detector === 'streaming';
  const isLive = opts.detector === 'live-segmenter';
  const snapshot = {
    schema: 1,
    detector: isLive
      ? 'segmentLive@src/modules/chat/utils/voiceLiveSegmenter.ts'
      : isStreaming
        ? 'detectVoiceSegments@src/shared/voiceEndpoint.ts'
        : 'trimVoiceAudio@src/shared/voiceTrim.ts',
    sampleRate: DEFAULT_RATE,
    maxSegmentSec: isStreaming ? STREAMING_MAX_SEGMENT_SEC : DEFAULT_MAX_SEGMENT_SEC,
    ...(isStreaming ? { endpointMs: STREAMING_ENDPOINT_MS } : {}),
    grid,
    corpus: { root: corpus.root, totalFiles: corpus.totalFiles, pool: corpus.pool },
    limitations: isLive
      ? [
          ...LIMITATIONS,
          'the live segmenter carries the streaming VAD\'s own speech firing, so it inherits its false alarms and its over-segmentation-in-a-sentence counting',
          'gaps the min-length rule steps over are compressed to 1.0 s in the emitted audio, so outputSec is shorter than the summed input spans',
        ]
      : LIMITATIONS,
    cells,
    t2,
    t3,
  };
  if (isLive) {
    // The readings this task exists to read, and the streaming snapshot's own beside them.
    snapshot.readings = liveReadings(cells);
    if (existsSync(SNAPSHOT_STREAMING)) {
      const streamSnap = JSON.parse(readFileSync(SNAPSHOT_STREAMING, 'utf8'));
      snapshot.streaming = {
        detector: streamSnap.detector,
        endpointMs: streamSnap.endpointMs,
        maxSegmentSec: streamSnap.maxSegmentSec,
        readings: liveReadings(streamSnap.cells),
      };
    }
  }
  const outPath = opts.out ?? (isLive ? SNAPSHOT_LIVE : isStreaming ? SNAPSHOT_STREAMING : SNAPSHOT_BASELINE);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`);

  report(cells, grid, `voice-vad ${opts.detector} (detector=${snapshot.detector})`, snapshot.maxSegmentSec);
  if (isLive) printLiveReadings(snapshot, cells);
  if (t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(t2)]))}`);
  for (const row of t3) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }
  console.log(`snapshot written: ${outPath} (${cells.length} cells)`);

  const missing = coverageGap(cells, grid);
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (cells.length < MIN_TIMELINES) {
    console.error(`voice-vad-harness: ${cells.length} timelines < ${MIN_TIMELINES}`);
    process.exit(1);
  }

  if (isStreaming) assertStreamingNotWorse(cells, grid);
}

/**
 * Three deliberately wrong segmenters, each of which must move exactly one reading — while the
 * real segmenter stays green on the same readings. This is the falsification half of the T1
 * criteria: a bound nothing can break is not a bound.
 */
async function runFalseForms(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 120, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  const replicas = Math.min(opts.replicas, 20);
  const grid = { axes: AXES, default: DEFAULT_CONFIG, replicas };
  console.log(`false-forms: corpus pool=${corpus.pool}, replicas=${replicas} (${replicas * grid.axes.reduce((a, x) => a + x.levels.length, 0)} timelines/detector)`);

  const real = buildScan(corpus, grid, makeStreamingDetector());
  const noCeiling = buildScan(corpus, grid, makeStreamingDetector({ maxSegmentEnabled: false }));
  const fixedFloor = buildScan(corpus, grid, makeStreamingDetector({ noiseFloorMode: 'fixed' }));
  const oneFrameEndpoint = buildScan(corpus, grid, makeStreamingDetector({ endpointFramesOverride: 1 }));

  const realMid = nonForcedMidCut(real);
  const realFloor = aggregateMetrics(real.filter((c) => c.level === 'floor').map(metricsFor));
  const realOverlong = real.reduce((a, c) => a + (c.level === 'nonstop' ? c.segments.filter(([s0, s1]) => s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9).length : 0), 0);

  const failures = [];
  /** @param {string} name @param {boolean} moved @param {string} reading */
  const moved = (name, condition, reading) => {
    console.log(`  ${condition ? 'ok ' : 'RED'} ${name}: ${reading}`);
    if (!condition) failures.push(name);
  };

  // Positive control first: the real segmenter must be green on the readings the fakes break.
  moved('control.noOverlongSegment', realOverlong === 0, `overlong=${realOverlong}`);
  moved('control.hasForcedCuts', real.some((c) => c.level === 'nonstop' && (c.forcedCutChecks ?? []).length > 0), 'nonstop timelines carry a force-cut');

  // ① Remove the maxSegment ceiling => the length bound breaks.
  const noCeilingOverlong = noCeiling.reduce((a, c) => a + (c.level === 'nonstop' ? c.segments.filter(([s0, s1]) => s1 - s0 > STREAMING_MAX_SEGMENT_SEC + 1e-9).length : 0), 0);
  moved('form1.noCeiling', noCeilingOverlong > 0, `overlong segments=${noCeilingOverlong}`);

  // ② Replace the sliding floor with a fixed constant => room-tone false alarms explode.
  const fixedFloorAgg = aggregateMetrics(fixedFloor.filter((c) => c.level === 'floor').map(metricsFor));
  const floorBase = realFloor?.falseAlarmSecPerHourMean ?? 0;
  moved(
    'form2.fixedFloor',
    (fixedFloorAgg?.falseAlarmSecPerHourMean ?? 0) > Math.max(floorBase * 2, floorBase + 60),
    `floor falseAlarm/secPerHour real=${floorBase.toFixed(1)} fixed=${(fixedFloorAgg?.falseAlarmSecPerHourMean ?? 0).toFixed(1)}`,
  );

  // ③ Shorten the endpoint decision to one frame => over-segmentation and mid-cuts rise.
  const oneFrameMid = nonForcedMidCut(oneFrameEndpoint);
  moved(
    'form3.oneFrameEndpoint',
    oneFrameMid.rate > realMid.rate + 1e-6,
    `nonForcedMidCut real=${realMid.rate.toFixed(4)} one-frame=${oneFrameMid.rate.toFixed(4)}`,
  );

  if (failures.length) {
    console.error(`voice-vad-harness: ${failures.length} false-form(s) did not go red: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('voice-vad-harness: every false form went red and the real segmenter stayed green.');
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The T1 parameter sweep
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Every `(axis, level, replica)` key of the sweep grid, so a missing cell can be named. */
function sweepExpectedKeys(grid) {
  const keys = [];
  for (const axis of grid.axes) {
    for (const level of axis.levels) {
      for (let seed = 0; seed < grid.replicas; seed++) keys.push(`${axis.name}|${level}|${seed}`);
    }
  }
  return keys;
}

/** The sweep's missing cells, if any. */
function sweepCoverageGap(cells, grid) {
  const present = new Set(cells.map((c) => `${c.axis}|${c.level}|${c.seed}`));
  return sweepExpectedKeys(grid).filter((k) => !present.has(k));
}

/**
 * The pooled non-forced mid-cut rate, the metric the endpoint axis is chosen by.
 *
 * A `maxSegmentSec` force-cut lands inside a sentence by design, so counting it would make the
 * no-real-pause cells read as though the detector were slicing sentences in half. The ceiling is
 * read on its own axis (`maxSegmentViolations`, `forcedCutChecks`); the mid-cut rate excludes it.
 */
function pooledNonForcedMidCut(cells) {
  let mid = 0;
  let truth = 0;
  for (const cell of cells) {
    const forced = cell.forced ?? cell.segments.map(() => false);
    const boundaries = [];
    cell.segments.forEach(([start, end], i) => {
      if (i === 0 || !forced[i - 1]) boundaries.push(start);
      if (!forced[i]) boundaries.push(end);
    });
    for (const [ts, te] of cell.truth) {
      truth++;
      if (boundaries.some((at) => at > ts && at < te)) mid++;
    }
  }
  return { mid, truth, rate: truth ? mid / truth : 0, ci: wilsonInterval(mid, truth) };
}

/** Per-cell sample counts and confidence intervals — the readings AC3 requires in the snapshot. */
function summarizeSweep(cells) {
  const groups = new Map();
  for (const c of cells) {
    const key = `${c.axis}|${c.level}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [key, list] of groups) {
    const [axis, level] = key.split('|');
    const agg = aggregateMetrics(list.map(metricsFor));
    const midCut = pooledNonForcedMidCut(list);
    // Violations are counted here with the same 1e-9 tolerance the streaming self-check uses: the
    // detector's clamp lands a segment at exactly its ceiling, and float subtraction can read that
    // as a hair over.
    const maxSegViol = list.reduce((a, c) => {
      const ceiling = c.maxSegmentSec ?? DEFAULT_MAX_SEGMENT_SEC;
      return a + c.segments.filter(([s0, s1]) => s1 - s0 > ceiling + 1e-9).length;
    }, 0);
    const forcedCuts = list.reduce((a, c) => a + (c.forcedCutChecks ?? []).length, 0);
    out.push({
      axis,
      level,
      timelines: list.length,
      truthCount: agg.pooledTruth,
      missRate: agg.missRatePooled,
      missRateCI: agg.missRateCI,
      oversegRate: agg.oversegRatePooled,
      oversegRateCI: agg.oversegRateCI,
      midCutRate: midCut.rate,
      midCutRateCI: midCut.ci,
      startDeviationP95: agg.startDeviationP95Median,
      endDeviationP95: agg.endDeviationP95Median,
      falseAlarmSecPerHour: agg.falseAlarmSecPerHourMean,
      maxSegmentViolations: maxSegViol,
      forcedCuts,
      format:
        `axis=${axis} level=${level} n=${list.length} truth=${agg.pooledTruth} ` +
        `miss=${agg.missRatePooled.toFixed(4)}${JSON.stringify(agg.missRateCI)} ` +
        `over=${agg.oversegRatePooled.toFixed(4)}${JSON.stringify(agg.oversegRateCI)} ` +
        `midCut=${midCut.rate.toFixed(4)} ` +
        `startDevP95=${(agg.startDeviationP95Median ?? Number.NaN).toFixed(4)} ` +
        `falseAlarm/hr=${(agg.falseAlarmSecPerHourMean ?? Number.NaN).toFixed(2)} ` +
        `maxSegViol=${maxSegViol} forcedCuts=${forcedCuts}`,
    });
  }
  return out;
}

/**
 * Apply the registered selection rules to the sweep summary. This is the ONLY place a recommended
 * parameter is derived, so the result record, the frozen snapshot and the shipped constant cannot
 * disagree about which rule produced them.
 */
function recommendParams(summary, prereg) {
  const byAxisAlignment = (axis) =>
    summary.filter((s) => s.axis === axis).sort((a, b) => Number(a.level) - Number(b.level));
  const ep = byAxisAlignment('endpointMs');
  const epCandidates = ep.filter(
    (s) =>
      s.missRate <= prereg.missRateMax &&
      s.oversegRate <= prereg.oversegRateMax &&
      (s.startDeviationP95 ?? Infinity) <= prereg.startDeviationP95Max,
  );
  const epPick =
    epCandidates[0] ??
    [...ep].sort((a, b) => a.oversegRate - b.oversegRate || Number(a.level) - Number(b.level))[0];
  const ms = byAxisAlignment('maxSegmentSec');
  const msZero = ms.filter((s) => s.maxSegmentViolations === 0);
  const msPool = msZero.length ? msZero : ms;
  const msPick = [...msPool].sort(
    (a, b) => a.maxSegmentViolations - b.maxSegmentViolations || Number(b.level) - Number(a.level),
  )[0];
  return {
    endpointMs: Number(epPick.level),
    maxSegmentSec: Number(msPick.level),
    endpointBasis: epPick.format,
    maxSegmentBasis: msPick.format,
    endpointRule: prereg.endpointSelection,
    maxSegmentRule: prereg.maxSegmentSelection,
  };
}

/** A cut at the midpoint of every truth sentence — the registered negative control. */
function cutMidSentence(segments, truth) {
  const out = segments.map(([startSec, endSec]) => ({ startSec, endSec }));
  for (const [ts, te] of truth) {
    const mid = (ts + te) / 2;
    const idx = out.findIndex((s) => s.startSec < mid && s.endSec > mid);
    if (idx >= 0) {
      const s = out[idx];
      out.splice(idx, 1, { startSec: s.startSec, endSec: mid }, { startSec: mid, endSec: s.endSec });
    } else {
      out.push({ startSec: mid, endSec: mid });
    }
  }
  return out;
}

/** Apply `--variant` to a frozen cell's segments; `null` is the unmodified detector output. */
function variantCell(cell, variant) {
  if (!variant) return cell;
  if (variant === 'cut-mid-sentence') {
    const segments = cutMidSentence(cell.segments, cell.truth);
    return {
      ...cell,
      segments: segments.map((s) => [Number(s.startSec.toFixed(6)), Number(s.endSec.toFixed(6))]),
      forced: segments.map(() => false),
    };
  }
  throw new Error(`unknown variant: ${variant}`);
}

/** Read the corpus, build the single-factor parameter scan, freeze it to `fixtures/sweep.json`. */
async function runSweepGenerate(opts) {
  const corpusRoot = process.env.VAD_CORPUS ?? DEFAULT_CORPUS;
  let corpus;
  try {
    corpus = loadCorpus(corpusRoot, { pool: 200, rate: DEFAULT_RATE });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(1);
  }
  console.log(`sweep corpus: ${corpus.root} (files=${corpus.totalFiles}, decoded pool=${corpus.pool})`);

  const grid = { axes: SWEEP_AXES.map((a) => ({ name: a.name, levels: a.levels })), replicas: SWEEP_REPLICAS };
  const cells = [];
  for (const axis of SWEEP_AXES) {
    for (const level of axis.levels) {
      const cfg = axis.config(level);
      const detector = makeStreamingDetector({}, { endpointMs: cfg.endpointMs, maxSegmentSec: cfg.maxSegmentSec });
      for (let seed = 0; seed < SWEEP_REPLICAS; seed++) {
        const tl = buildTimeline({
          sources: corpus.sources,
          seed,
          family: cfg.family,
          noise: cfg.noise,
          sampleRate: DEFAULT_RATE,
        });
        const cell = cellFromTimeline(tl, detector, {
          axis: axis.name,
          level,
          seed,
          endpointMs: cfg.endpointMs,
          maxSegmentSec: cfg.maxSegmentSec,
          family: cfg.family,
          noise: cfg.noise,
        });
        // The ceiling this cell was run under — `metricsFor` reads it from here, not from the
        // detector's own default, so a 10 s cell's violations are counted against 10 s.
        cell.maxSegmentSec = cfg.maxSegmentSec;
        cells.push(cell);
      }
    }
  }

  // T2 — the human-annotated CORAAL interview segments.
  const coraalDir = process.env.VAD_CORAAL ?? DEFAULT_CORAAL;
  let t2 = null;
  if (existsSync(coraalDir)) {
    const tl = buildCoraalTimeline(coraalDir, DEFAULT_RATE);
    if (tl.truth.length < 200) {
      console.error(`voice-vad-harness: CORAAL has ${tl.truth.length} annotated segments < 200`);
      process.exit(1);
    }
    t2 = { dir: coraalDir, segmentsAnnotated: tl.truth.length, ...cellFromTimeline(tl, makeStreamingDetector()) };
    console.log(`sweep t2: ${coraalDir} (${tl.truth.length} annotated segments, ${tl.durationSec.toFixed(1)}s)`);
  } else {
    console.log(`sweep t2: skipped (CORAAL segments dir not found: ${coraalDir})`);
  }

  // T3 — the fixed long samples, as regression points.
  const longDir = process.env.VAD_LONG ?? DEFAULT_LONG;
  const t3 = [];
  if (existsSync(longDir)) {
    for (const tl of loadLongCorpus(longDir)) t3.push({ id: tl.id, ...cellFromTimeline(tl, makeStreamingDetector()) });
    console.log(`sweep t3: ${longDir} (${t3.length} fixed samples)`);
  }

  // T4 — the budget-gated recognition plan, run against the deterministic offline fixture
  // recogniser. The pricing file is passed explicitly (the committed `pricing.json` is a
  // placeholder a human fills in), because T4's whole point is that the price is an input.
  const pricing = loadPricingFile(opts.pricing ?? DEFAULT_PRICING, opts);
  const recognition = computeRecognitionGroup({ pricing, providerName: opts.provider, longDir });

  const summary = summarizeSweep(cells);
  const recommendation = recommendParams(summary, PREREG);
  const snapshot = {
    schema: 2,
    detector: 'detectVoiceSegments@src/shared/voiceEndpoint.ts',
    sampleRate: DEFAULT_RATE,
    defaults: {
      endpointMs: STREAMING_ENDPOINT_MS,
      maxSegmentSec: STREAMING_MAX_SEGMENT_SEC,
      overlapSec: 0.3,
      noiseWindowSec: 30,
    },
    grid,
    prereg: PREREG,
    recommendation,
    corpus: { root: corpus.root, totalFiles: corpus.totalFiles, pool: corpus.pool },
    limitations: [...LIMITATIONS, ...SWEEP_LIMITATIONS],
    t2,
    t3,
    recognition,
    cells,
    cells_summary: summary,
  };

  const outPath = opts.out ?? SWEEP_SNAPSHOT;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snapshot)}\n`);

  console.log(`voice-vad sweep (detector=${snapshot.detector}, snapshot=${outPath})`);
  for (const row of summary) console.log(`  ${row.format}`);
  if (t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(t2)]))}`);
  for (const row of t3) console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  console.log(
    `  recognition: provider=${recognition.provider} calls=${recognition.callCount} n=${recognition.sampleCount} ` +
      `cost=¥${recognition.costCny} ≤ budget=¥${recognition.budgetCny}`,
  );
  console.log(
    `  recommendation: endpointMs=${recommendation.endpointMs} maxSegmentSec=${recommendation.maxSegmentSec} ` +
      `(endpoint basis: ${recommendation.endpointBasis}; segment basis: ${recommendation.maxSegmentBasis})`,
  );

  const missing = sweepCoverageGap(cells, grid);
  const thinCells = grid.axes.flatMap((a) =>
    a.levels.map((l) => ({ axis: a.name, level: l, n: cells.filter((c) => c.axis === a.name && c.level === l).length })),
  ).filter((x) => x.n < PREREG.minPerCell);
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (cells.length < PREREG.minTimelines) {
    console.error(`voice-vad-harness: sweep covers ${cells.length} timelines < ${PREREG.minTimelines}`);
    process.exit(1);
  }
  if (thinCells.length) {
    console.error(`voice-vad-harness: ${thinCells.length} cell(s) below ${PREREG.minPerCell}: ${thinCells.map((x) => `${x.axis}=${x.level}(${x.n})`).join(', ')}`);
    process.exit(1);
  }
  console.log(`voice-vad-harness: OK — ${cells.length} timelines across ${summary.length} cells, min cell ${Math.min(...summary.map((s) => s.timelines))}`);
}

/** Recompute the sweep from the frozen snapshot: corpus-free, network-free, credential-free. */
function runSweepOffline(opts) {
  const outPath = opts.out ?? SWEEP_SNAPSHOT;
  const snap = readSnapshot(outPath);
  const missing = sweepCoverageGap(snap.cells, snap.grid);
  const cells = snap.cells.map((c) => variantCell(c, opts.variant));
  const summary = summarizeSweep(cells);

  console.log(`voice-vad --sweep --offline (variant=${opts.variant ?? 'none'}, snapshot=${outPath})`);
  for (const row of summary) console.log(`  ${row.format}`);
  if (snap.t2) console.log(`  ${formatAggregate('t2=coraal', aggregateMetrics([metricsFor(snap.t2)]))}`);
  for (const row of snap.t3 ?? []) {
    console.log(`  ${formatAggregate(`t3=${row.id}`, aggregateMetrics([metricsFor(row)]))}`);
  }

  const minPerCell = snap.prereg?.minPerCell ?? PREREG.minPerCell;
  const minTimelines = snap.prereg?.minTimelines ?? PREREG.minTimelines;
  const thinCells = snap.grid.axes.flatMap((a) =>
    a.levels.map((l) => ({ axis: a.name, level: l, n: snap.cells.filter((c) => c.axis === a.name && c.level === l).length })),
  ).filter((x) => x.n < minPerCell);
  if (missing.length) {
    console.error(`voice-vad-harness: ${missing.length} missing grid cell(s), first: ${missing[0]}`);
    process.exit(1);
  }
  if (snap.cells.length < minTimelines) {
    console.error(`voice-vad-harness: snapshot covers ${snap.cells.length} timelines < ${minTimelines}`);
    process.exit(1);
  }
  if (thinCells.length) {
    console.error(`voice-vad-harness: ${thinCells.length} cell(s) below ${minPerCell}: ${thinCells.map((x) => `${x.axis}=${x.level}(${x.n})`).join(', ')}`);
    process.exit(1);
  }

  if (opts.variant === 'cut-mid-sentence') {
    // The control is read on the cells the endpoint rule is registered on — the clean,
    // long-gap endpointMs axis — not on the noisy cells, whose false alarms are a different
    // reading. Both the real and the variant readings come from the SAME subset, so the
    // comparison is paired.
    const subset = (list) => list.filter((c) => c.axis === 'endpointMs');
    const floor = snap.prereg?.negativeControlOversegFloor ?? PREREG.negativeControlOversegFloor;
    const bound = snap.prereg?.oversegRateMax ?? PREREG.oversegRateMax;
    const realOver = aggregateMetrics(subset(snap.cells).map(metricsFor)).oversegRatePooled;
    const variantOver = aggregateMetrics(subset(cells).map(metricsFor)).oversegRatePooled;
    console.log(
      `negative-control (endpointMs axis, clean/mixed): real overseg=${realOver.toFixed(4)} ` +
        `variant overseg=${variantOver.toFixed(4)} (real bound=${bound}, red floor=${floor})`,
    );
    const moved = realOver <= bound && variantOver >= floor && variantOver > realOver;
    if (!moved) {
      console.error(
        `negative-control did not move as pre-registered: real=${realOver.toFixed(4)} variant=${variantOver.toFixed(4)}; ` +
          'the ruler is not sensitive — this record is void and must be redone',
      );
      process.exit(1);
    }
    console.log('负对照红: cut-mid-sentence 把中途切率（过切率）按 PREREG 登记的方向推过了红色下限，量具敏感');
  }

  const recommendation = recommendParams(summary, snap.prereg ?? PREREG);
  console.log(
    `recommendation: endpointMs=${recommendation.endpointMs} maxSegmentSec=${recommendation.maxSegmentSec} ` +
      `(endpoint basis: ${recommendation.endpointBasis}; segment basis: ${recommendation.maxSegmentBasis})`,
  );

  console.log(`voice-vad-harness: OK — recomputed ${snap.cells.length} timelines from ${outPath}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The T4 recognition budget gate
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A price is a placeholder when the human has not filled it in: absent, non-numeric or <= 0. */
function priceIsPlaceholder(value) {
  return typeof value !== 'number' || !Number.isFinite(value) || value <= 0;
}

/**
 * Read the price file, applying explicit CLI overrides. Every failure names its cause — a
 * missing file, an unparseable file and a placeholder price are three different facts and must
 * not print the same line, because the budget gate's job is to say WHY it refused.
 */
function loadPricingFile(path, overrides = {}) {
  if (!existsSync(path)) {
    throw Object.assign(new Error(`pricing file not found: ${path}`), {
      reason: `缺 pricing.json：未找到单价文件 ${path}`,
    });
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw Object.assign(new Error(`pricing file is not valid JSON: ${path}`), {
      reason: `单价文件无法解析：${path}`,
    });
  }
  let inputPerMillionCny = raw.inputPerMillionCny;
  let outputPerMillionCny = raw.outputPerMillionCny;
  let budgetCny = typeof raw.budgetCny === 'number' ? raw.budgetCny : PREREG.budgetCny;
  if (typeof overrides.priceInput === 'number' && Number.isFinite(overrides.priceInput)) inputPerMillionCny = overrides.priceInput;
  if (typeof overrides.priceOutput === 'number' && Number.isFinite(overrides.priceOutput)) outputPerMillionCny = overrides.priceOutput;
  if (typeof overrides.budget === 'number' && Number.isFinite(overrides.budget)) budgetCny = overrides.budget;
  if (priceIsPlaceholder(inputPerMillionCny) || priceIsPlaceholder(outputPerMillionCny)) {
    throw Object.assign(new Error('pricing file carries a placeholder price'), {
      reason:
        `单价为占位值：inputPerMillionCny=${JSON.stringify(inputPerMillionCny)} ` +
        `outputPerMillionCny=${JSON.stringify(outputPerMillionCny)}（人须从控制台填入真实单价，worker 不得猜测）`,
    });
  }
  return { budgetCny, inputPerMillionCny, outputPerMillionCny };
}

/** The worst-case spend a plan can produce: every call at the registered token ceiling. */
function worstCaseCostCny(calls, tokensPerCall, outputPerMillionCny) {
  return (calls * tokensPerCall * outputPerMillionCny) / 1e6;
}

/** What one call actually cost at the price file's rates. */
function callCostCny(usage, pricing) {
  return (usage.inputTokens * pricing.inputPerMillionCny + usage.outputTokens * pricing.outputPerMillionCny) / 1e6;
}

/** The T4 sample table: identity, reference text and the segmented-upload duration. */
function loadRecognitionSamples(longDir) {
  const manifestPath = join(longDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw Object.assign(new Error(`long-corpus manifest not found: ${manifestPath}`), {
      reason: `T4 需要长样本清单：未找到 ${manifestPath}`,
    });
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const byId = new Map();
  for (const m of manifest) {
    const segs = m.segments ?? [];
    byId.set(m.id, {
      id: m.id,
      durationSec: m.durationSec,
      reference: segs.map((s) => s.text).join('，'),
      segmentedText: segs.map((s) => s.text).join('，'),
      segmentedSec: segs.reduce((a, s) => a + (s.endSec - s.startSec), 0),
    });
  }
  return byId;
}

/**
 * The deterministic offline stand-in recogniser.
 *
 * It is NOT a recogniser and is never called one: it reads the reference text back and models an
 * upload's token cost from its duration. It exists so the budget gate — the rule this task can
 * actually enforce offline — is exercised end to end, and so the frozen snapshot's `recognition`
 * group records the plan, the accounting and the identifier axis on real reference text. The
 * real-service confirmation is a human step (price file + credential) and is left open in the
 * results record rather than claimed here.
 */
function fixtureProvider(samplesById) {
  return {
    name: 'fixture',
    transcribe({ id, arm, sampleRate }) {
      const s = samplesById.get(id);
      const text = arm === 'segmented' ? s.segmentedText : s.reference;
      const durationSec = arm === 'segmented' ? s.segmentedSec : s.durationSec;
      return {
        text,
        durationSec,
        usage: {
          // Audio at ~7 tokens/s (the proposal's measured slope), scaled by upload rate, plus the
          // fixed prompt the deployment sends.
          inputTokens: Math.round((sampleRate / 16000) * durationSec * 7) + 407,
          outputTokens: 120 + (text.length % 80),
        },
      };
    },
  };
}

/** A provider whose every answer carries an enormous usage — the cumulative-budget falsifier. */
function hugeUsageProvider(samplesById) {
  return {
    name: 'fake-huge',
    transcribe({ id, arm }) {
      const s = samplesById.get(id);
      return {
        text: arm === 'segmented' ? s.segmentedText : s.reference,
        durationSec: s.durationSec,
        usage: { inputTokens: 2_000_000, outputTokens: 2_000_000 },
      };
    },
  };
}

/** Identifier survival of one arm's transcripts against the reference text, verbatim. */
function survivalFor(calls, samplesById) {
  let total = 0;
  let survived = 0;
  for (const call of calls) {
    const reading = identifierFidelity(samplesById.get(call.id).reference, call.text);
    total += reading.total;
    survived += reading.survived;
  }
  return { total, survived, rate: total ? survived / total : null };
}

/** Sentence-punctuation marks in one arm's transcripts. */
function punctuationFor(calls) {
  return calls.reduce((a, c) => a + (c.text.match(/[，。？！,?!.]/g) ?? []).length, 0);
}

/**
 * Run the T4 plan against a provider under the budget gate and return the group that goes into
 * the snapshot. The calls run in plan order; the loop stops BEFORE issuing a call once the
 * cumulative cost has crossed `budgetCny`, so no call is made after the budget is gone, and the
 * readings taken so far are kept.
 */
function computeRecognitionGroup({ pricing, providerName, longDir }) {
  const samplesById = loadRecognitionSamples(longDir);
  const plan = t4Plan();
  const worst = worstCaseCostCny(plan.length, PREREG.t4WorstTokensPerCall, pricing.outputPerMillionCny);
  if (worst > pricing.budgetCny) {
    throw Object.assign(new Error('estimated worst-case spend exceeds the budget'), {
      reason: `预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny}（calls=${plan.length}, ${PREREG.t4WorstTokensPerCall} tokens/call, ¥${pricing.outputPerMillionCny}/M）`,
    });
  }
  const provider = providerName === 'fake-huge' ? hugeUsageProvider(samplesById) : fixtureProvider(samplesById);
  const calls = [];
  let cumulative = 0;
  let stoppedOnBudget = false;
  for (const step of plan) {
    if (cumulative > pricing.budgetCny) {
      stoppedOnBudget = true;
      break;
    }
    const result = provider.transcribe(step);
    const cost = callCostCny(result.usage, pricing);
    cumulative += cost;
    calls.push({
      index: calls.length,
      id: step.id,
      arm: step.arm,
      sampleRate: step.sampleRate,
      durationSec: Number(result.durationSec.toFixed(3)),
      usage: result.usage,
      costCny: Number(cost.toFixed(6)),
      text: result.text,
    });
  }
  const usage = calls.reduce(
    (a, c) => ({ inputTokens: a.inputTokens + c.usage.inputTokens, outputTokens: a.outputTokens + c.usage.outputTokens }),
    { inputTokens: 0, outputTokens: 0 },
  );
  usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const at16 = (arm) => calls.filter((c) => c.arm === arm && c.sampleRate === 16000);
  const at48 = (arm) => calls.filter((c) => c.arm === arm && c.sampleRate === 48000);
  return {
    provider: provider.name,
    plan: { samples: T4_SAMPLE_IDS, arms: ['whole@16k', 'segmented@16k', 'whole@48k'], plannedCalls: plan.length },
    callCount: calls.length,
    sampleCount: T4_SAMPLE_IDS.length,
    stoppedOnBudget,
    budgetCny: pricing.budgetCny,
    pricing: { inputPerMillionCny: pricing.inputPerMillionCny, outputPerMillionCny: pricing.outputPerMillionCny },
    worstCaseCny: Number(worst.toFixed(6)),
    usage,
    costCny: Number(cumulative.toFixed(6)),
    readings: {
      wholeIdentifierSurvival: survivalFor(at16('whole'), samplesById),
      segmentedIdentifierSurvival: survivalFor(at16('segmented'), samplesById),
      whole48kIdentifierSurvival: survivalFor(at48('whole'), samplesById),
      wholePunctuationMarkers: punctuationFor(at16('whole')),
      segmentedPunctuationMarkers: punctuationFor(at16('segmented')),
      whole48kPunctuationMarkers: punctuationFor(at48('whole')),
    },
    calls,
    note:
      'deterministic offline fixture provider: it models the budget gate, the call accounting and the ' +
      'identifier axis on the samples\' own reference text. It does not model acoustic cut damage, so its ' +
      'readings CONFIRM NOTHING about the shipping recogniser — the real-service run is a human step gated ' +
      'on a filled pricing.json and a credential, and is left open in docs/experiments/2026-10-04-voice-vad-sweep.md.',
  };
}

/** `--recognition`: the budget gate. Dry run stops before any call; the run stops at the budget. */
async function runRecognition(opts) {
  let pricing;
  try {
    pricing = loadPricingFile(opts.pricing ?? DEFAULT_PRICING, opts);
  } catch (err) {
    console.error(`voice-vad-harness: ${err.reason ?? err.message}`);
    process.exit(3);
  }
  const plan = t4Plan();
  const worst = worstCaseCostCny(plan.length, PREREG.t4WorstTokensPerCall, pricing.outputPerMillionCny);

  if (opts.dryRun) {
    if (worst > pricing.budgetCny) {
      console.error(
        `voice-vad-harness: 预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny} ` +
          `（calls=${plan.length}, ${PREREG.t4WorstTokensPerCall} tokens/call, ¥${pricing.outputPerMillionCny}/M output）`,
      );
      process.exit(3);
    }
    console.log(
      `预估最坏花费 = ¥${worst.toFixed(4)}（calls=${plan.length}, ${PREREG.t4WorstTokensPerCall} tokens/call, ` +
        `¥${pricing.outputPerMillionCny}/M output）≤ budgetCny=¥${pricing.budgetCny}`,
    );
    return;
  }

  if (worst > pricing.budgetCny) {
    console.error(
      `voice-vad-harness: 预估花费 ¥${worst.toFixed(4)} > budgetCny=¥${pricing.budgetCny} —— 未发起任何调用`,
    );
    process.exit(3);
  }

  const longDir = process.env.VAD_LONG ?? DEFAULT_LONG;
  let group;
  try {
    group = computeRecognitionGroup({ pricing, providerName: opts.provider, longDir });
  } catch (err) {
    console.error(`voice-vad-harness: ${err.reason ?? err.message}`);
    process.exit(err.reason?.includes('budget') ? 3 : 1);
  }

  if (opts.provider === 'fake-huge') {
    let running = 0;
    let afterCrossing = 0;
    for (const c of group.calls) {
      if (running > pricing.budgetCny) afterCrossing++;
      running += c.costCny;
    }
    if (afterCrossing > 0) {
      console.error(`voice-vad-harness: 累计超预算后仍发起了 ${afterCrossing} 次调用`);
      process.exit(1);
    }
    console.log(
      `累计预算闸: 发起 ${group.callCount} 次调用后停发；累计 ¥${group.costCny} 越过 budgetCny=¥${pricing.budgetCny}，` +
        `其后再无新调用（已有 ${group.callCount} 条读数已落盘）`,
    );
  }

  const outPath = opts.out ?? SWEEP_SNAPSHOT;
  const snap = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { schema: 2 };
  snap.recognition = group;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(snap)}\n`);
  console.log(
    `recognition: provider=${group.provider} calls=${group.callCount} n=${group.sampleCount} ` +
      `cost=¥${group.costCny} budget=¥${group.budgetCny} stoppedOnBudget=${group.stoppedOnBudget}; written ${outPath}`,
  );
}

async function main() {
  if (process.env.NO_NETWORK) installNoNetworkGuard();
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`voice-vad-harness: ${err.message}`);
    process.exit(2);
  }
  if (opts.recognition) await runRecognition(opts);
  else if (opts.sweep) {
    if (opts.offline) runSweepOffline(opts);
    else await runSweepGenerate(opts);
  } else if (opts.falseForms) await runFalseForms(opts);
  else if (opts.offline) runOffline(opts);
  else await runGenerate(opts);
}

await main();
