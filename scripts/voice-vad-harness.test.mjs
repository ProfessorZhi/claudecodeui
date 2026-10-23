#!/usr/bin/env node
/**
 * The VAD truth harness judges a segmenter against construction-time truth, so the two things
 * that must be pinned down here are (1) that the truth really is exact and (2) that the metrics
 * can actually go red. A measuring tool whose ruler stretches, or whose needle never moves, is
 * worse than none: it produces numbers that look like evidence.
 *
 * Each of the four wrong detectors below is a shape a segmenter can take, and each must move
 * exactly the metric it is meant to:
 *
 *   ① always "speech"        => false-alarm seconds per hour of silence saturates at 3600
 *   ② always "no speech"     => miss rate is exactly 1
 *   ③ every boundary 0.5 s early => start-deviation p50 >= 0.5 s
 *   ④ a cut at each sentence midpoint => mid-cut rate is exactly 1
 *
 * The synthetic sources are pure tone bursts, not corpus speech, so the "real detector" leg has a
 * known answer: one burst = one sentence, no internal pauses. The corpus-based baseline lives in
 * `experiments/voice-vad/fixtures/baseline.json` and is exercised, corpus-free, by `--offline`.
 *
 * Run with `node --test scripts/voice-vad-harness.test.mjs` (AC-1's literal command).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import http from 'node:http';
import https from 'node:https';

import { DEFAULT_RATE, buildTimeline } from '../experiments/voice-vad/timeline.mjs';
import { computeMetrics } from '../experiments/voice-vad/metrics.mjs';

const RUN = fileURLToPath(new URL('../experiments/voice-vad/run.mjs', import.meta.url));
const HARNESS_DIR = fileURLToPath(new URL('../experiments/voice-vad/', import.meta.url));

// The frontend's `@/` source-root alias, resolved for this plain-node process. The shipping
// detector reaches its shared endpoint module through the alias the browser build, the
// type-checker and the unit transform all resolve — this hook is the same mapping for the one
// place those toolchains do not reach. It must be registered before the dynamic import below.
const SRC_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return { url: pathToFileURL(join(SRC_ROOT, specifier.slice(2)) + '.ts').href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// The shipping detector, imported by a runtime-resolved URL so this file stays type-checkable
// as a plain-mjs `scripts/` test (an explicit `.ts` specifier is not one the tsconfig allows).
const voiceTrimModule = await import(new URL('../src/shared/voiceTrim.ts', import.meta.url).href);

/**
 * @type {(samples: Float32Array, sampleRate: number) => { stats: { vadSegments: { startSec: number, endSec: number }[] } }}
 */
const trimVoiceAudio = voiceTrimModule.trimVoiceAudio;

/**
 * A pure tone burst: constant energy, so the detector's decision is unambiguous.
 * @param {number} seconds
 * @param {number} freq
 * @param {number} [rate]
 * @param {number} [amp]
 * @returns {Float32Array}
 */
function tone(seconds, freq, rate = DEFAULT_RATE, amp = 0.4) {
  const n = Math.round(seconds * rate);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return s;
}

const SOURCES = [
  { id: 'burst-a', sampleRate: DEFAULT_RATE, samples: tone(1.6, 180) },
  { id: 'burst-b', sampleRate: DEFAULT_RATE, samples: tone(2.1, 240) },
  { id: 'burst-c', sampleRate: DEFAULT_RATE, samples: tone(1.2, 300) },
  { id: 'burst-d', sampleRate: DEFAULT_RATE, samples: tone(2.4, 150) },
  { id: 'burst-e', sampleRate: DEFAULT_RATE, samples: tone(1.8, 210) },
  { id: 'burst-f', sampleRate: DEFAULT_RATE, samples: tone(2.0, 270) },
];

/**
 * @param {{ seed: number, family: string, noise: string }} opts
 * @returns {ReturnType<typeof buildTimeline>}
 */
function build(opts) {
  return buildTimeline({ sources: SOURCES, sampleRate: DEFAULT_RATE, ...opts });
}

/**
 * @param {Float32Array} samples
 * @returns {string}
 */
function hashSamples(samples) {
  return createHash('sha256')
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest('hex');
}

/**
 * Sample indices a truth interval occupies; exact because the builder places whole samples.
 * @param {{ startSec: number, endSec: number }} t
 * @returns {{ from: number, to: number }}
 */
function bounds(t) {
  return { from: Math.round(t.startSec * DEFAULT_RATE), to: Math.round(t.endSec * DEFAULT_RATE) };
}

/**
 * Assert every truth interval's samples equal its source, sample for sample.
 * @param {ReturnType<typeof buildTimeline>} tl
 * @returns {void}
 */
function assertIntervalsAreSource(tl) {
  for (const t of tl.truth) {
    const { from, to } = bounds(t);
    const src = SOURCES[Number(t.source)].samples;
    assert.equal(to - from, src.length, `interval ${t.startSec}-${t.endSec} length`);
    const firstMismatch = (() => {
      for (let k = 0; k < src.length; k++) if (tl.samples[from + k] !== src[k]) return k;
      return -1;
    })();
    assert.equal(firstMismatch, -1, `interval ${t.startSec}-${t.endSec} diverges from its source at +${firstMismatch}`);
  }
}

/**
 * Add a cut at the midpoint of every truth interval — the "forced midpoint cut" wrong detector.
 * @param {{ startSec: number, endSec: number }[]} segments
 * @param {{ startSec: number, endSec: number }[]} truth
 * @returns {{ startSec: number, endSec: number }[]}
 */
function addMidpointCuts(segments, truth) {
  const cut = segments.map((s) => ({ ...s }));
  for (const t of truth) {
    const mid = (t.startSec + t.endSec) / 2;
    const idx = cut.findIndex((s) => s.startSec < mid && s.endSec > mid);
    if (idx >= 0) {
      const s = cut[idx];
      cut.splice(idx, 1, { startSec: s.startSec, endSec: mid }, { startSec: mid, endSec: s.endSec });
    } else {
      cut.push({ startSec: mid, endSec: mid });
    }
  }
  return cut;
}

/** Throw on any network entry point. The harness never uses one; this makes that checkable. */
function installNoNetworkGuard() {
  const boom = () => {
    throw new Error('NO_NETWORK guard: network call attempted');
  };
  const g = /** @type {{ fetch?: unknown }} */ (globalThis);
  g.fetch = boom;
  for (const mod of [/** @type {any} */ (http), /** @type {any} */ (https)]) {
    mod.request = boom;
    mod.get = boom;
  }
}

test('a seed reproduces the timeline byte-for-byte', () => {
  const a = build({ seed: 1234, family: 'mixed', noise: 'snr10' });
  const b = build({ seed: 1234, family: 'mixed', noise: 'snr10' });
  assert.equal(a.samples.length, b.samples.length);
  assert.equal(hashSamples(a.samples), hashSamples(b.samples), 'samples differ between two builds of one seed');
  assert.deepEqual(a.truth, b.truth, 'truth differ between two builds of one seed');
  assert.ok(a.truth.length > 0, 'timeline has no truth');
});

test('truth intervals are exact, ascending and disjoint, and the gaps are silence', () => {
  const tl = build({ seed: 7, family: 'dense', noise: 'clean' });
  assert.ok(tl.truth.length > 0);
  for (let i = 0; i < tl.truth.length; i++) {
    if (i > 0) assert.ok(tl.truth[i].startSec >= tl.truth[i - 1].endSec, `interval ${i} overlaps ${i - 1}`);
  }
  assertIntervalsAreSource(tl);

  const mask = new Uint8Array(tl.samples.length);
  for (const t of tl.truth) {
    const { from, to } = bounds(t);
    mask.fill(1, from, to);
  }
  let nonSilentGap = -1;
  for (let i = 0; i < tl.samples.length; i++) {
    if (mask[i] === 0 && tl.samples[i] !== 0) {
      nonSilentGap = i;
      break;
    }
  }
  assert.equal(nonSilentGap, -1, `clean timeline has a non-zero sample outside every interval at ${nonSilentGap}`);
});

test('noise is laid only in the gaps, never over a sentence', () => {
  const tl = build({ seed: 9, family: 'mixed', noise: 'floor' });
  assertIntervalsAreSource(tl);

  const mask = new Uint8Array(tl.samples.length);
  for (const t of tl.truth) {
    const { from, to } = bounds(t);
    mask.fill(1, from, to);
  }
  let gapEnergy = 0;
  for (let i = 0; i < tl.samples.length; i++) if (mask[i] === 0) gapEnergy += tl.samples[i] * tl.samples[i];
  assert.ok(gapEnergy > 0, 'a floor-noise timeline has silent gaps — the noise overlay did not land');
});

test('four wrong detectors each drive their own metric red', () => {
  const tl = build({ seed: 3, family: 'mixed', noise: 'clean' });
  const real = trimVoiceAudio(tl.samples, tl.sampleRate).stats.vadSegments.map((s) => ({
    startSec: s.startSec,
    endSec: s.endSec,
  }));
  assert.ok(real.length > 0, 'the shipping detector found no speech in the synthetic timeline');

  /** @param {{ startSec: number, endSec: number }[]} segments @returns {ReturnType<typeof computeMetrics>} */
  const measure = (segments) =>
    computeMetrics({ truth: tl.truth, segments, durationSec: tl.durationSec, silenceSec: tl.silenceSec });

  const base = measure(real);
  assert.ok(base.missRate < 1, 'baseline already misses every sentence — the fake forms would be vacuous');
  assert.ok(base.midCutRate < 1, 'baseline already cuts every sentence — ④ would be vacuous');

  // ① a detector that calls the whole timeline speech.
  const allSpeech = measure([{ startSec: 0, endSec: tl.durationSec }]);
  const allSpeechRate = allSpeech.falseAlarmSecPerHour ?? 0;
  const baseRate = base.falseAlarmSecPerHour ?? 0;
  assert.ok(allSpeechRate > 10 * Math.max(baseRate, 1), `① did not raise false alarms: ${allSpeechRate} vs ${baseRate}`);
  assert.ok(Math.abs(allSpeechRate - 3600) < 1, '① should saturate at one hour of false speech per hour');

  // ② a detector that never fires.
  const noSpeech = measure([]);
  assert.equal(noSpeech.missRate, 1, '② must miss every sentence');

  // ③ the real detection, translated 0.5 s earlier: the onset deviation must read >= 0.5 s.
  const shifted = measure(real.map((s) => ({ startSec: s.startSec - 0.5, endSec: s.endSec - 0.5 })));
  assert.ok(
    shifted.startDeviationP50 !== null && shifted.startDeviationP50 >= 0.5,
    `③ onset deviation p50 should be >= 0.5 s, got ${shifted.startDeviationP50}`,
  );

  // ④ a cut forced at every sentence midpoint.
  const midcut = measure(addMidpointCuts(real, tl.truth));
  assert.equal(midcut.midCutRate, 1, '④ must cut every sentence mid-way');
});

test('a missing corpus is named and fails, never silently shrunk', () => {
  const missing = '/nonexistent/voice-vad-corpus-xyz';
  /** @type {any} */
  let failure = null;
  try {
    execFileSync(process.execPath, [RUN], {
      env: { ...process.env, VAD_CORPUS: missing, VAD_SEEDS: '1' },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'run.mjs exited 0 with no corpus at all');
  assert.notEqual(failure.status, 0, 'run.mjs must exit non-zero when the corpus is missing');
  assert.match(String(failure.stderr), /voice-vad-corpus-xyz/, `the missing path was not named; stderr=${failure.stderr}`);
});

test('--offline recomputes every reading from the frozen snapshot, corpus-free and no-network', () => {
  const out = execFileSync(process.execPath, [RUN, '--offline'], {
    env: { ...process.env, NO_NETWORK: '1' },
    encoding: 'utf8',
  });
  const coverage = /coverage: cells=(\d+)\/(\d+)/.exec(out);
  assert.ok(coverage, `no coverage line in --offline output:\n${out}`);
  const covered = Number(coverage[1]);
  assert.ok(covered >= 600, `snapshot covers ${covered} timelines < 600`);
  assert.equal(covered, Number(coverage[2]), 'the single-factor scan has a missing cell');
  assert.match(out, /t3=L4-nonstop.*overlong=1/, 'the snapshot must record the L4 single-request weakness');
});

test('the deterministic core calls no network API and runs under the guard', () => {
  installNoNetworkGuard();
  // In-process: building and measuring must not touch the network (the guard would throw).
  const tl = build({ seed: 11, family: 'sparse', noise: 'floor' });
  const metrics = computeMetrics({
    truth: tl.truth,
    segments: [{ startSec: 0, endSec: 1 }],
    durationSec: tl.durationSec,
    silenceSec: tl.silenceSec,
  });
  assert.ok(Number.isFinite(metrics.missRate));

  for (const name of ['timeline.mjs', 'metrics.mjs']) {
    const src = readFileSync(join(HARNESS_DIR, name), 'utf8');
    for (const primitive of ['fetch(', 'node:http', 'node:https', 'node:net', 'WebSocket', 'XMLHttpRequest']) {
      assert.ok(!src.includes(primitive), `${name} mentions a network primitive: ${primitive}`);
    }
  }
});
