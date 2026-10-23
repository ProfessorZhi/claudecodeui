/**
 * Time-interval metrics for a VAD segmenter, measured against construction-time truth.
 *
 * The question "is this segmenter any good" is a question about a *partition of time*: where
 * does each utterance start and end, which ones did the detector miss, where did it fire on
 * nothing but room tone, and where did it slice a sentence in half. All of those are answerable
 * from two lists of `[startSec, endSec)` intervals — the truth and the detector's output — and
 * from nothing else. Nothing here reads audio, calls a recogniser, or touches the network:
 * a metric that needed any of those would not be a metric of the *segmenter*.
 *
 * The definitions are chosen so that each one can be driven red by a detector that is wrong in a
 * specific way (see `## AC` 指标自检 and scripts/voice-vad-harness.test.mjs). A metric no wrong
 * detector can move is not measuring anything, so the exact shape of each definition matters:
 *
 *   · `missRate`        — a truth sentence no detected segment overlaps. All-silence => 1.
 *   · `oversegRate`     — a truth sentence overlapped by two or more detected segments.
 *   · `midCutRate`      — a truth sentence with a detected segment *boundary* strictly inside it.
 *                         "A cut at the midpoint of every sentence" => 1. This is the term that
 *                         distinguishes a forced max-length cut (excluded by the caller) from a
 *                         cut the detector chose, which is the failure that damages a transcript.
 *   · `falseAlarm*`     — detected speech outside every truth interval, normalised by the
 *                         timeline's own non-speech duration. All-speech => large. The count form
 *                         is blind to a single segment that swallows the whole timeline (it
 *                         overlaps truth), so the seconds-per-hour form is the one the AC pins.
 *   · `start/endDeviation` — |detected boundary - truth boundary|, per sentence, p50/p95.
 *   · `maxSegmentViolations` — detected segments longer than a caller-supplied ceiling. The
 *                         current batch detector has no ceiling, so this is where a timeline of
 *                         back-to-back sentences shows up as one long request.
 *
 * Truth intervals are assumed non-overlapping and ascending; the timeline builder guarantees it.
 */

/** A detected segment longer than this many seconds is a violation. 120 s is the streaming
 *  design's provisional ceiling (see the proposal's L4 finding): past it a single request no
 *  longer fits the provider's inline-body limit. */
export const DEFAULT_MAX_SEGMENT_SEC = 120;

/**
 * @typedef {{ startSec: number, endSec: number }} Interval
 */

/**
 * Length of `[a0,a1) ∩ [b0,b1)`, zero when they do not overlap.
 * @param {number} a0
 * @param {number} a1
 * @param {number} b0
 * @param {number} b1
 * @returns {number}
 */
function overlapSec(a0, a1, b0, b1) {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi > lo ? hi - lo : 0;
}

/**
 * Wilson score interval for a binomial proportion, at 95%. Returns `[lo, hi]` clamped to [0,1],
 * or `[0, 1]` for an empty denominator. A rate with no interval is a rate whose precision is
 * unknown; the point estimate alone cannot say whether a difference is real.
 * @param {number} successes
 * @param {number} trials
 * @returns {[number, number]}
 */
export function wilsonInterval(successes, trials) {
  if (!trials) return [0, 1];
  const z = 1.959963984540054;
  const phat = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = phat + (z * z) / (2 * trials);
  const margin = z * Math.sqrt((phat * (1 - phat)) / trials + (z * z) / (4 * trials * trials));
  return [Math.max(0, (centre - margin) / denom), Math.min(1, (centre + margin) / denom)];
}

/**
 * Nearest-rank percentile, or `null` for an empty set — never a fabricated 0.
 * @param {number[]} values
 * @param {number} p
 * @returns {number | null}
 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Merge possibly-overlapping/unsorted segments into disjoint runs, clipped to the timeline.
 * @param {Interval[]} segments
 * @param {number} durationSec
 * @returns {Interval[]}
 */
export function mergeSegments(segments, durationSec) {
  const clipped = segments
    .map((s) => ({ startSec: Math.max(0, s.startSec), endSec: Math.min(durationSec, s.endSec) }))
    .filter((s) => s.endSec > s.startSec)
    .sort((a, b) => a.startSec - b.startSec);
  const out = [];
  for (const s of clipped) {
    const last = out[out.length - 1];
    if (last && s.startSec <= last.endSec) last.endSec = Math.max(last.endSec, s.endSec);
    else out.push({ ...s });
  }
  return out;
}

/**
 * Every reading the harness reports, for one timeline.
 *
 * `silenceSec` is the timeline's truth non-speech duration; when it is 0 the two per-hour rates
 * are `null` (undefined) rather than a division by zero. `durationSec` only clips the detected
 * output to the timeline so a detector cannot score on time that was never generated.
 *
 * @param {{ truth: Interval[], segments: Interval[], durationSec: number, silenceSec: number, maxSegmentSec?: number, outputSec?: number | null }} opts
 */
export function computeMetrics({
  truth,
  segments,
  durationSec,
  silenceSec,
  maxSegmentSec = DEFAULT_MAX_SEGMENT_SEC,
  outputSec = null,
}) {
  const nTruth = truth.length;
  let miss = 0;
  let over = 0;
  let mid = 0;
  const startMag = [];
  const startSigned = [];
  const endMag = [];

  for (const T of truth) {
    let covered = 0;
    let best = null;
    let bestOverlap = 0;
    let interior = false;
    for (const s of segments) {
      const ov = overlapSec(T.startSec, T.endSec, s.startSec, s.endSec);
      if (ov > 0) {
        covered++;
        if (ov > bestOverlap) {
          bestOverlap = ov;
          best = s;
        }
      }
      if (s.startSec > T.startSec && s.startSec < T.endSec) interior = true;
      if (s.endSec > T.startSec && s.endSec < T.endSec) interior = true;
    }
    if (covered === 0) miss++;
    if (covered >= 2) over++;
    if (interior) mid++;
    if (best) {
      const ds = best.startSec - T.startSec;
      startSigned.push(ds);
      startMag.push(Math.abs(ds));
      endMag.push(Math.abs(best.endSec - T.endSec));
    }
  }

  const union = mergeSegments(segments, durationSec);
  let detectedSec = 0;
  let insideSec = 0;
  let silentRuns = 0;
  for (const u of union) {
    detectedSec += u.endSec - u.startSec;
    let overlapsTruth = false;
    for (const T of truth) {
      const ov = overlapSec(u.startSec, u.endSec, T.startSec, T.endSec);
      insideSec += ov;
      if (ov > 0) overlapsTruth = true;
    }
    if (!overlapsTruth) silentRuns++;
  }
  const falseSec = Math.max(0, detectedSec - insideSec);
  /** @param {number} value @returns {number | null} */
  const perHour = (value) => (silenceSec > 0 ? (value / silenceSec) * 3600 : null);

  return {
    truthCount: nTruth,
    segmentCount: segments.length,
    missCount: miss,
    oversegCount: over,
    midCutCount: mid,
    missRate: nTruth ? miss / nTruth : 0,
    oversegRate: nTruth ? over / nTruth : 0,
    midCutRate: nTruth ? mid / nTruth : 0,
    missRateCI: wilsonInterval(miss, nTruth),
    oversegRateCI: wilsonInterval(over, nTruth),
    midCutRateCI: wilsonInterval(mid, nTruth),
    startDeviationP50: percentile(startMag, 0.5),
    startDeviationP95: percentile(startMag, 0.95),
    startDeviationSignedP50: percentile(startSigned, 0.5),
    endDeviationP50: percentile(endMag, 0.5),
    endDeviationP95: percentile(endMag, 0.95),
    deviationN: startMag.length,
    falseAlarmSecPerHour: perHour(falseSec),
    falseAlarmCountPerHour: perHour(silentRuns),
    maxSegmentViolations: segments.filter((s) => s.endSec - s.startSec > maxSegmentSec).length,
    // The batch detector emits ONE output for the whole timeline, so the reading that matters
    // for "would this be one overlong request" is its own output length, not a segment length.
    outputSec,
    outputOverlong: outputSec === null ? null : outputSec > maxSegmentSec,
  };
}

/**
 * Median of the finite values, or `null` when none — so an aggregate never invents a reading.
 * @param {(number | null | undefined)[]} values
 * @returns {number | null}
 */
function medianOf(values) {
  /** @type {number[]} */
  const finite = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) finite.push(v);
  return finite.length ? percentile(finite, 0.5) : null;
}

/**
 * Mean of the finite values, or `null`.
 * @param {(number | null | undefined)[]} values
 * @returns {number | null}
 */
function meanOf(values) {
  /** @type {number[]} */
  const finite = [];
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v)) finite.push(v);
  if (!finite.length) return null;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

/**
 * Fold per-timeline readings into one summary.
 *
 * Rates are pooled by mean; deviations by the median of the per-timeline percentiles (a median of
 * medians, so one pathological timeline cannot drag the headline the way a pooled set would);
 * violations are summed. Each group carries its timeline count, because a mean over three
 * timelines and a mean over three hundred must not print the same.
 *
 * @param {ReturnType<typeof computeMetrics>[]} metricsList
 */
export function aggregateMetrics(metricsList) {
  if (!metricsList.length) return null;
  const pooledTruth = metricsList.reduce((a, m) => a + m.truthCount, 0);
  /** @param {(m: ReturnType<typeof computeMetrics>) => number} pick @returns {number} */
  const sum = (pick) => metricsList.reduce((a, m) => a + pick(m), 0);
  /** @param {(m: ReturnType<typeof computeMetrics>) => number} pick @returns {number} */
  const pooledRate = (pick) => (pooledTruth ? sum(pick) / pooledTruth : 0);
  return {
    timelines: metricsList.length,
    pooledTruth,
    // The point estimate pooled over sentences, matching the Wilson denominator (per-timeline
    // means are kept below but would not sit inside a pooled interval).
    missRatePooled: pooledRate((m) => m.missCount),
    oversegRatePooled: pooledRate((m) => m.oversegCount),
    midCutRatePooled: pooledRate((m) => m.midCutCount),
    missRateCI: wilsonInterval(sum((m) => m.missCount), pooledTruth),
    oversegRateCI: wilsonInterval(sum((m) => m.oversegCount), pooledTruth),
    midCutRateCI: wilsonInterval(sum((m) => m.midCutCount), pooledTruth),
    missRateMean: meanOf(metricsList.map((m) => m.missRate)),
    oversegRateMean: meanOf(metricsList.map((m) => m.oversegRate)),
    midCutRateMean: meanOf(metricsList.map((m) => m.midCutRate)),
    startDeviationP50Median: medianOf(metricsList.map((m) => m.startDeviationP50)),
    startDeviationP95Median: medianOf(metricsList.map((m) => m.startDeviationP95)),
    endDeviationP50Median: medianOf(metricsList.map((m) => m.endDeviationP50)),
    endDeviationP95Median: medianOf(metricsList.map((m) => m.endDeviationP95)),
    falseAlarmSecPerHourMean: meanOf(metricsList.map((m) => m.falseAlarmSecPerHour)),
    maxSegmentViolationsTotal: metricsList.reduce((a, m) => a + m.maxSegmentViolations, 0),
    timelinesWithViolation: metricsList.filter((m) => m.maxSegmentViolations > 0).length,
    maxOutputSec: Math.max(...metricsList.map((m) => (typeof m.outputSec === 'number' ? m.outputSec : 0))),
    overlongOutputTimelines: metricsList.filter((m) => m.outputOverlong === true).length,
  };
}

/**
 * One-line-per-group human summary. Numbers only; no verdicts.
 * @param {string} label
 * @param {ReturnType<typeof aggregateMetrics> | null} agg
 * @returns {string}
 */
export function formatAggregate(label, agg) {
  if (!agg) return `${label}: (no timelines)`;
  /** @param {number | null} v @param {number} n @returns {string} */
  const f = (v, n) => (v === null || !Number.isFinite(v) ? '-' : v.toFixed(n));
  /** @param {[number, number] | undefined} pair @returns {string} */
  const ci = (pair) => (pair ? `[${f(pair[0], 4)},${f(pair[1], 4)}]` : '[-]');
  return (
    `${label}: n=${agg.timelines} truth=${agg.pooledTruth} ` +
    `miss=${f(agg.missRatePooled, 4)}${ci(agg.missRateCI)} ` +
    `over=${f(agg.oversegRatePooled, 4)}${ci(agg.oversegRateCI)} ` +
    `midCut=${f(agg.midCutRatePooled, 4)}${ci(agg.midCutRateCI)} ` +
    `startDev p50/p95=${f(agg.startDeviationP50Median, 4)}/${f(agg.startDeviationP95Median, 4)} ` +
    `endDev p50/p95=${f(agg.endDeviationP50Median, 4)}/${f(agg.endDeviationP95Median, 4)} ` +
    `falseAlarm/hr=${f(agg.falseAlarmSecPerHourMean, 2)} ` +
    `maxSegViolations=${agg.maxSegmentViolationsTotal}(${agg.timelinesWithViolation} timelines) ` +
    `maxOut=${f(agg.maxOutputSec, 1)}s overlong=${agg.overlongOutputTimelines}`
  );
}
