/**
 * Synthetic timelines for measuring a VAD segmenter against exact truth.
 *
 * A timeline is real human speech (one file per sentence) laid out on a sampled timeline with
 * deterministic gaps, an optional noise overlay, and a truth list of the `[startSec, endSec]`
 * each sentence occupies. Because the layout is fixed by a seed, the same seed reproduces the
 * exact same samples and the exact same truth — so two detectors, or one detector under two
 * parameters, can be compared on *identical* audio. That paired property is the whole reason
 * this is synthesised rather than sampled: a corpus of real continuous speech has no truth.
 *
 * Two truths are offered:
 *   · T1 — `buildTimeline`: sentences chosen and spaced by seed, gaps from a family's
 *     distribution. The truth is exact because we placed every sample ourselves.
 *   · T2 — `buildCoraalTimeline`: CORAAL interview segments, whose file names carry the human
 *     annotator's own start/end times. The truth is human, and therefore coarse, but the speech
 *     is spontaneous rather than read.
 *
 * The one thing this module must not do is invent speech where there is none, or move a sample of
 * it: the truth-precision AC compares each interval's samples to the source byte-for-byte. So
 * noise is laid *only in the gaps* — a sentence's samples are copied verbatim, and the reading is
 * a "does the detector fire on noise-only time" reading, not a noisy-speech reading (stated as a
 * limitation in the snapshot's own `limitations`).
 *
 * No network, no recogniser, no credentials. Decoding is local: WAV natively, anything else
 * (LibriSpeech is FLAC) through the host's `ffmpeg` when it is present.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, relative } from 'node:path';

/**
 * @typedef {{ id: string, samples: Float32Array, sampleRate: number }} Source  a decoded sentence clip
 * @typedef {{ startSec: number, endSec: number, source?: number | string }} TruthInterval  a placed sentence
 * @typedef {{ samples: Float32Array, sampleRate: number, truth: TruthInterval[], durationSec: number, speechSec: number, silenceSec: number, family: string, seed: number | null, noise: string }} Timeline
 * @typedef {{ sentences: [number, number], gapMin: number, gapMax: number, lead: [number, number], tail: [number, number], longGapP: number, longGapMin?: number, longGapMax?: number }} GapSpec
 */

/** The rate everything is resampled to. LibriSpeech's own 16 kHz, matching P1's upload format. */
export const DEFAULT_RATE = 16000;

/** How many Coraal/mixed families exist; the grid axis called 间隔族 in the task. */
export const GAP_FAMILY_NAMES = ['dense', 'mixed', 'sparse', 'nonstop'];

/** The noise grid axis: no overlay, four SNRs against speech level, and an absolute room floor. */
export const NOISE_MODES = ['clean', 'snr30', 'snr20', 'snr10', 'snr5', 'floor'];

/**
 * Gap families. Each is a distribution over the silence *before* every sentence (the first one
 * included, so it is also the lead-in) and over the tail after the last. `longGapP` injects the
 * rare multi-second pause that makes `endpointMs` thresholds separable; `nonstop` has no long
 * gap at all, which is exactly the input a maximum-segment rule exists for.
 *
 * @type {Record<string, GapSpec>}
 */
export const GAP_FAMILIES = {
  dense: { sentences: [5, 8], gapMin: 0.3, gapMax: 1.5, lead: [0.3, 1.0], tail: [0.3, 1.0], longGapP: 0 },
  mixed: {
    sentences: [6, 9],
    gapMin: 0.5,
    gapMax: 2.5,
    lead: [1.0, 2.0],
    tail: [1.0, 2.0],
    longGapP: 0.18,
    longGapMin: 8,
    longGapMax: 20,
  },
  sparse: { sentences: [5, 7], gapMin: 8, gapMax: 45, lead: [3, 6], tail: [3, 6], longGapP: 0 },
  nonstop: { sentences: [8, 11], gapMin: 0.15, gapMax: 0.15, lead: [0.15, 0.3], tail: [0.15, 0.3], longGapP: 0 },
};

/**
 * 32-bit integer PRNG (mulberry32). Same seed => same stream, on every platform.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic 1/f-ish noise, peak-normalised to 1. Same character as tc-verify/tools/noise.mjs.
 * @param {number} length
 * @param {number} seed
 * @returns {Float32Array}
 */
export function pinkNoise(length, seed) {
  const rng = mulberry32(seed);
  const out = new Float32Array(length);
  for (let octave = 0; octave < 4; octave++) {
    const step = 1 << octave;
    const amp = 1 / (octave + 1);
    let hold = rng() * 2 - 1;
    for (let i = 0; i < length; i++) {
      if (i % step === 0) hold = rng() * 2 - 1;
      out[i] += hold * amp;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] /= peak;
  return out;
}

/**
 * Root-mean-square of a sample run.
 * @param {Float32Array} samples
 * @returns {number}
 */
export function rms(samples) {
  let acc = 0;
  for (let i = 0; i < samples.length; i++) acc += samples[i] * samples[i];
  return Math.sqrt(acc / Math.max(1, samples.length));
}

/**
 * Linear-interpolation resample. Callers use it only to bring a clip to `DEFAULT_RATE`.
 * @param {Float32Array} samples
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/**
 * Decode a 16-bit PCM RIFF/WAVE file into mono float samples.
 * @param {string} path
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeWavFile(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`not a RIFF file: ${path}`);
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`missing fmt or data chunk: ${path}`);
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error(`expected 16-bit PCM, got format=${fmt.format} bits=${fmt.bits}: ${path}`);
  }
  const frames = Math.floor(data.length / (fmt.channels * 2));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    samples[i] = acc / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples };
}

/**
 * Decode anything else (LibriSpeech is FLAC) through a local ffmpeg, resampled to `rate`.
 * @param {string} path
 * @param {number} rate
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeWithFfmpeg(path, rate) {
  const res = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', String(rate), '-'],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) {
    const reason = res.error ? res.error.message : String(res.stderr ?? '').trim().split('\n')[0];
    throw new Error(`ffmpeg could not decode ${path}: ${reason}`);
  }
  const buf = /** @type {Buffer} */ (res.stdout);
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return { sampleRate: rate, samples: new Float32Array(copy.buffer, 0, copy.byteLength / 4) };
}

/**
 * Decode one file, choosing the native WAV reader for `.wav` and ffmpeg otherwise.
 * @param {string} path
 * @param {number} [rate]
 * @returns {{ sampleRate: number, samples: Float32Array }}
 */
export function decodeAudioFile(path, rate = DEFAULT_RATE) {
  if (extname(path).toLowerCase() === '.wav') {
    const { sampleRate, samples } = decodeWavFile(path);
    return { sampleRate: rate, samples: resampleLinear(samples, sampleRate, rate) };
  }
  return decodeWithFfmpeg(path, rate);
}

/**
 * Every `.wav`/`.flac` under `root`, path-sorted so the pool is reproducible across machines.
 * @param {string} root
 * @returns {string[]}
 */
export function listAudioFiles(root) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir @returns {void} */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.wav' || ext === '.flac') found.push(full);
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Load a deterministic pool of single-sentence clips from `root`.
 *
 * A missing root, an unreadable tree, or a tree with no audio is a *hard* error naming the path —
 * never a silent fall back to a smaller set. A harness that shrinks its own corpus without saying
 * so reports a number no one can attribute, which is the one failure mode a measurement tool may
 * not have.
 *
 * `pool` caps how many clips are decoded into memory: a 2 703-file corpus is walked in full but
 * only an evenly-spaced slice is decoded, so a small corpus and a large one cost the same. The
 * slice is taken by stride over the sorted list and is itself reproducible.
 *
 * @param {string} root
 * @param {{ pool?: number, rate?: number }} [options]
 * @returns {{ root: string, totalFiles: number, pool: number, files: string[], sources: Source[] }}
 */
export function loadCorpus(root, { pool = 200, rate = DEFAULT_RATE } = {}) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`corpus root not found: ${root}`);
  }
  const files = listAudioFiles(root);
  if (!files.length) throw new Error(`no single-sentence audio (wav/flac) under corpus root: ${root}`);

  const stride = Math.max(1, Math.floor(files.length / pool));
  const selected = files.filter((_, i) => i % stride === 0).slice(0, pool);

  const sources = selected.map((path) => {
    const { samples } = decodeAudioFile(path, rate);
    return { id: relative(root, path), samples, sampleRate: rate };
  });
  return { root, totalFiles: files.length, pool: selected.length, files: selected, sources };
}

/**
 * A uniform sample in `[lo,hi)`, deterministic for a given rng state.
 * @param {() => number} rng
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function pickRange(rng, lo, hi) {
  return lo + rng() * (hi - lo);
}

/**
 * The silence before sentence `i` for a family, or the tail when `i === count`.
 * @param {() => number} rng
 * @param {GapSpec} spec
 * @param {boolean} isTail
 * @returns {number}
 */
function gapFor(rng, spec, isTail) {
  if (isTail) return pickRange(rng, spec.tail[0], spec.tail[1]);
  if (spec.longGapP > 0 && rng() < spec.longGapP) {
    return pickRange(rng, spec.longGapMin ?? spec.gapMin, spec.longGapMax ?? spec.gapMax);
  }
  return pickRange(rng, spec.gapMin, spec.gapMax);
}

/**
 * Target noise RMS, measured against the timeline's own speech level. `null` = no overlay.
 * @param {string} mode
 * @param {number} speechRms
 * @returns {number | null}
 */
export function noiseTargetRms(mode, speechRms) {
  if (mode === 'clean') return null;
  if (mode === 'floor') return 10 ** (-50 / 20); // -50 dBFS absolute room tone
  const m = /^snr(\d+)$/.exec(mode);
  if (!m) throw new Error(`unknown noise mode: ${mode}`);
  return speechRms / 10 ** (Number(m[1]) / 20);
}

/**
 * Build one T1 timeline.
 *
 * `sources` is a decoded pool (`{id, samples}` at `sampleRate`). Returns the samples, the truth,
 * and the timeline's own durations. `maxDurationSec` truncates the sentence count so one `sparse`
 * cell cannot run for minutes; it never truncates a placed sentence.
 *
 * @param {{ sources: Source[], seed: number, family: string, noise: string, sampleRate?: number, maxDurationSec?: number }} opts
 * @returns {Timeline}
 */
export function buildTimeline({ sources, seed, family, noise, sampleRate = DEFAULT_RATE, maxDurationSec = 90 }) {
  if (!sources.length) throw new Error('buildTimeline needs at least one source');
  const spec = GAP_FAMILIES[family];
  if (!spec) throw new Error(`unknown gap family: ${family}`);
  // Any `snrNN` is a level: `NOISE_MODES` names the default axis, but a caller (the parameter
  // sweep) may ask for a level between the default ones, and the overlay arithmetic is the same.
  if (noise !== 'clean' && noise !== 'floor' && !/^snr\d+$/.test(noise)) {
    throw new Error(`unknown noise mode: ${noise}`);
  }

  const rng = mulberry32(seed >>> 0);
  const wanted = Math.round(pickRange(rng, spec.sentences[0], spec.sentences[1]));
  const lead = pickRange(rng, spec.lead[0], spec.lead[1]);
  const tail = pickRange(rng, spec.tail[0], spec.tail[1]);

  /** The silence *before* sentence `i`; the first sentence's is the lead-in, not a family gap. */
  /** @type {{source:number, samples:Float32Array, gapSamples:number}[]} */
  const placed = [];
  let cursor = 0;
  for (let i = 0; i < wanted; i++) {
    const source = Math.floor(rng() * sources.length);
    const gapSamples = Math.round((i === 0 ? lead : gapFor(rng, spec, false)) * sampleRate);
    const samples = sources[source].samples;
    const projected = cursor + gapSamples + samples.length;
    if (placed.length && projected / sampleRate > maxDurationSec) break;
    placed.push({ source, samples, gapSamples });
    cursor = projected;
  }
  if (!placed.length) {
    const source = Math.floor(rng() * sources.length);
    const samples = sources[source].samples;
    const gapSamples = Math.round(lead * sampleRate);
    placed.push({ source, samples, gapSamples });
    cursor = gapSamples + samples.length;
  }
  cursor += Math.round(tail * sampleRate);

  const total = cursor;
  const samples = new Float32Array(total);
  const mask = new Uint8Array(total);
  const truth = [];
  let at = 0;
  for (let i = 0; i < placed.length; i++) {
    at += placed[i].gapSamples;
    const p = placed[i];
    samples.set(p.samples, at);
    mask.fill(1, at, at + p.samples.length);
    truth.push({ startSec: at / sampleRate, endSec: (at + p.samples.length) / sampleRate, source: p.source });
    at += p.samples.length;
  }

  let speechSamples = 0;
  for (let i = 0; i < total; i++) if (mask[i] === 1) speechSamples++;
  let speechAcc = 0;
  for (let i = 0; i < total; i++) if (mask[i] === 1) speechAcc += samples[i] * samples[i];
  const speechRms = Math.sqrt(speechAcc / Math.max(1, speechSamples));

  const target = noiseTargetRms(noise, speechRms);
  if (target !== null) {
    const silenceCount = total - speechSamples;
    const nz = pinkNoise(silenceCount, (seed * 2654435761) >>> 0);
    let k = 0;
    for (let i = 0; i < total; i++) {
      if (mask[i] === 0) samples[i] = Math.max(-1, Math.min(1, nz[k++] * target));
    }
  }

  return {
    samples,
    sampleRate,
    truth,
    durationSec: total / sampleRate,
    speechSec: speechSamples / sampleRate,
    silenceSec: (total - speechSamples) / sampleRate,
    family,
    seed,
    noise,
  };
}

/**
 * Load the fixed T3 samples (`corpus/long/L1..L4`), whose truth is the manifest the generator
 * wrote at construction time. These are the four points the proposal already read the shipping
 * detector on — including `L4`, back-to-back sentences with no real pause — so the harness can
 * record that reading in the same snapshot rather than only in a proposal's prose.
 *
 * @param {string} dir
 * @returns {{ id: string, samples: Float32Array, sampleRate: number, truth: TruthInterval[] }[]}
 */
export function loadLongCorpus(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`long corpus dir not found: ${dir}`);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error(`long corpus manifest not found: ${manifestPath}`);
  /** @type {{ id: string, segments: { startSec: number, endSec: number, source: string }[] }[]} */
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return manifest.map((sample) => {
    const { samples } = decodeAudioFile(join(dir, `${sample.id}.wav`), DEFAULT_RATE);
    return {
      id: sample.id,
      samples,
      sampleRate: DEFAULT_RATE,
      truth: sample.segments.map((s) => ({ startSec: s.startSec, endSec: s.endSec, source: s.source })),
    };
  });
}

/**
 * Build a T2 timeline from a CORAAL `*_segments/` directory.
 *
 * The file names carry the annotator's `start_end` seconds, so the truth is human, not synthesis:
 * `DCA_se1_ag3_f_01_1_0.4882_2.6009.wav` is the segment from 0.4882 s to 2.6009 s of the source
 * interview. Segments are placed at those absolute times over a silent bed of the interview's
 * length; the bed is silence because the segments *are* the annotated speech and the unannotated
 * remainder is what the annotator chose not to mark.
 *
 * @param {string} dir
 * @param {number} [rate]
 * @returns {Timeline}
 */
export function buildCoraalTimeline(dir, rate = DEFAULT_RATE) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`CORAAL segments dir not found: ${dir}`);
  const entries = [];
  for (const name of readdirSync(dir)) {
    const m = /_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)\.wav$/.exec(name);
    if (!m) continue;
    const startSec = Number(m[1]);
    const endSec = Number(m[2]);
    if (endSec > startSec) entries.push({ path: join(dir, name), startSec, endSec });
  }
  entries.sort((a, b) => a.startSec - b.startSec);
  if (!entries.length) throw new Error(`no timestamped CORAAL segments in: ${dir}`);

  const last = entries[entries.length - 1];
  const total = Math.round(last.endSec * rate);
  const samples = new Float32Array(total);
  const truth = [];
  for (const e of entries) {
    const { samples: clip } = decodeAudioFile(e.path, rate);
    const at = Math.round(e.startSec * rate);
    const room = Math.max(0, Math.min(clip.length, total - at));
    samples.set(clip.subarray(0, room), at);
    truth.push({ startSec: at / rate, endSec: (at + room) / rate, source: e.path });
  }
  const speechSec = truth.reduce((a, t) => a + (t.endSec - t.startSec), 0);
  return {
    samples,
    sampleRate: rate,
    truth,
    durationSec: total / rate,
    speechSec,
    silenceSec: total / rate - speechSec,
    family: 'coraal',
    seed: null,
    noise: 'clean',
  };
}
