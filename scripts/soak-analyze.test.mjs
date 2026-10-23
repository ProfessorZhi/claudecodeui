#!/usr/bin/env node
// Unit test for the pure half of the soak harness (gap-server-soak-harness, AC-1).
//
// The analyzer is the only thing that decides red or green in this harness, and it decides on
// reports produced by a process the test cannot control (a real server, a leaking stub). So the
// one place its judgement can be pinned down is here, on synthetic series whose answer is known by
// construction. Each case below is one of the shapes a soak run can have; the two that matter most
// are the ones that would make the harness useless if it got them wrong:
//
//   · (b) a linear climb must be RED and the verdict must name the series and the slope — an
//     analyzer that reds "something" is not a measurement;
//   · (c) a warm-up hump (caches filling, then settling) must be GREEN — redding it would make the
//     harness cry wolf at every real run, which is how a leak detector gets switched off.
//
// Run with `node --test scripts/soak-analyze.test.mjs` (AC-1's literal command).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_THRESHOLDS,
    MIN_SERIES_SAMPLES,
    REQUIRED_ACTIONS,
    SERIES,
    analyzeSoakReport,
    linearRegression,
    median,
} from './soak-analyze.mjs';

const MIB = 1024 * 1024;
const WARMUP_SECONDS = 20;
const DURATION_SECONDS = 120;
const INTERVAL_SECONDS = 5;
const COOLDOWN_SECONDS = 24;

/**
 * One fixture sample. Every series is a required number here (unlike the analyzer's `Sample`, where
 * a series may be missing); `phase` is the fixture's own convenience and is not part of the report
 * contract — it lets a case say "this series bends during the cool-down" without arithmetic.
 *
 * @typedef {object} FixtureSample
 * @property {number} t
 * @property {'warmup'|'drive'|'cooldown'} phase
 * @property {number} rssBytes
 * @property {number} vmHwmBytes
 * @property {number} heapUsedBytes
 * @property {number} fdCount
 * @property {number} threadCount
 * @property {number} childCount
 * @property {number} cgroupMemoryBytes
 * @property {number} sessionScopeCount
 */

/**
 * Build a well-formed report: every required series present, ≥ MIN_SERIES_SAMPLES samples inside
 * the drive window, and every required agitator action non-zero. Individual cases then bend ONE
 * series, so a red can only come from the shape the case is about.
 *
 * @param {{
 *   series?: Record<string, (t: number, phase: 'warmup'|'drive'|'cooldown') => number>,
 *   actions?: Record<string, number>,
 *   gcProbes?: import('./soak-analyze.mjs').GcProbe[],
 * }} [overrides]
 */
function makeReport(overrides = {}) {
    const series = overrides.series ?? {};
    /**
     * @param {string} key
     * @param {number} baseline
     * @param {number} t
     * @param {'warmup'|'drive'|'cooldown'} phase
     * @returns {number}
     */
    const value = (key, baseline, t, phase) => (series[key] ? series[key](t, phase) : baseline);

    /** @type {FixtureSample[]} */
    const samples = [];
    const total = WARMUP_SECONDS + DURATION_SECONDS + COOLDOWN_SECONDS;
    for (let t = 0; t <= total; t += INTERVAL_SECONDS) {
        const phase = t < WARMUP_SECONDS ? 'warmup' : t < WARMUP_SECONDS + DURATION_SECONDS ? 'drive' : 'cooldown';
        samples.push({
            t,
            phase,
            rssBytes: value('rssBytes', 200 * MIB, t, phase),
            vmHwmBytes: value('vmHwmBytes', 260 * MIB, t, phase),
            heapUsedBytes: value('heapUsedBytes', 40 * MIB, t, phase),
            fdCount: value('fdCount', 42, t, phase),
            threadCount: value('threadCount', 11, t, phase),
            childCount: value('childCount', 3, t, phase),
            cgroupMemoryBytes: value('cgroupMemoryBytes', 300 * MIB, t, phase),
            sessionScopeCount: value('sessionScopeCount', 0, t, phase),
        });
    }

    return {
        schema: 'soak-report/1',
        durationSeconds: DURATION_SECONDS,
        warmupSeconds: WARMUP_SECONDS,
        samplingIntervalMs: INTERVAL_SECONDS * 1000,
        samples,
        actions: {
            sessionsCreated: 4,
            chatSends: 9,
            aborts: 2,
            wsNormalCloses: 6,
            wsHalfOpen: 2,
            slowClients: 3,
            transcriptLinesAppended: 500,
            transcriptBytesAppended: 8 * MIB,
            searches: 12,
            shellPtyOpens: 2,
            ...overrides.actions,
        },
        ...(overrides.gcProbes ? { gcProbes: overrides.gcProbes } : {}),
    };
}

/** The drive window is what the slope is fitted on; assert the fixture really has enough of it. */
test('fixture: the synthetic report carries enough in-window samples to be judged', () => {
    const report = makeReport();
    const drive = report.samples.filter((s) => s.phase === 'drive');
    assert.ok(drive.length >= MIN_SERIES_SAMPLES, `drive samples ${drive.length} must be >= ${MIN_SERIES_SAMPLES}`);
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `baseline fixture must be green, got:\n${verdict.lines.join('\n')}`);
});

test('(a) a flat run is green and every judged series is reported', () => {
    const verdict = analyzeSoakReport(makeReport());
    assert.equal(verdict.ok, true, verdict.lines.join('\n'));
    const judged = verdict.series.filter((entry) => entry.judged === true).map((entry) => entry.name);
    for (const definition of SERIES) {
        assert.ok(judged.includes(definition.label), `series ${definition.label} must be judged, got ${judged.join(',')}`);
    }
    assert.ok(verdict.lines.some((line) => line.includes('VERDICT green')), 'verdict line must say green');
});

test('(b) a linear climb is red, and the verdict names the series and the slope', () => {
    // 4x the published threshold: unambiguously a leak whatever the noise floor is re-derived to,
    // which keeps this case about the RULE (a climb over the line reds and is named) rather than
    // about the constant.
    const slopePerSecond = 4 * DEFAULT_THRESHOLDS.rssBytesPerSecond;
    const report = makeReport({
        series: {
            rssBytes: (t, phase) => (phase === 'warmup' ? 200 * MIB : 200 * MIB + slopePerSecond * (t - WARMUP_SECONDS)),
        },
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, false, 'a linear RSS climb must be red');

    const failure = verdict.failures.find((line) => line.includes('series=rss'));
    assert.ok(failure, `a FAIL line must name series=rss, got:\n${verdict.lines.join('\n')}`);
    const match = /slope=([-\d.]+)B\/s/.exec(failure ?? '');
    assert.ok(match, `the FAIL line must carry the slope, got: ${failure}`);
    assert.ok(Number(match[1]) > DEFAULT_THRESHOLDS.rssBytesPerSecond,
        `the printed slope ${match?.[1]} must exceed the threshold ${DEFAULT_THRESHOLDS.rssBytesPerSecond}`);
    assert.ok((failure ?? '').includes(`threshold=${DEFAULT_THRESHOLDS.rssBytesPerSecond.toFixed(2)}`),
        'the FAIL line must carry the threshold it was measured against');
    assert.ok((failure ?? '').includes('成因'), 'the FAIL line must carry the cause, not just the numbers');
});

test('(b2) a linear heap climb is red as well (the second slope series)', () => {
    const report = makeReport({
        series: {
            heapUsedBytes: (t, phase) => (phase === 'warmup' ? 40 * MIB : 40 * MIB + 4 * DEFAULT_THRESHOLDS.heapUsedBytesPerSecond * (t - WARMUP_SECONDS)),
        },
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, false, 'a linear heap climb must be red');
    assert.ok(verdict.failures.some((line) => line.includes('series=heapUsed')), verdict.lines.join('\n'));
});

test('(c) rise-then-fall (cache warm-up through the drive window) is green', () => {
    // A hump: it climbs to +80MiB at the middle of the drive window and comes back to the start
    // value by the end. Its regression slope is ~0 and it must never be called a leak.
    const report = makeReport({
        series: {
            rssBytes: (t, phase) => {
                if (phase !== 'drive') return 200 * MIB;
                const progress = (t - WARMUP_SECONDS) / DURATION_SECONDS;
                return 200 * MIB + 80 * MIB * Math.sin(Math.PI * progress);
            },
        },
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `a hump must not be read as a leak:\n${verdict.lines.join('\n')}`);
    const rss = verdict.series.find((entry) => entry.name === 'rss');
    assert.ok(rss && typeof rss.peak === 'number' && rss.peak > 240 * MIB, 'the hump really is in the data (peak > +40MiB)');
});

test('(d) fd/child counts that do not come back after cooling are red', () => {
    const report = makeReport({
        series: {
            fdCount: (t, phase) => (phase === 'cooldown' ? 42 + 30 : 42),
            childCount: (t, phase) => (phase === 'cooldown' ? 3 + 9 : 3),
        },
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, false, 'a residual that never returns must be red');
    const fd = verdict.failures.find((line) => line.includes('series=fds'));
    assert.ok(fd, `a FAIL line must name series=fds, got:\n${verdict.lines.join('\n')}`);
    assert.ok(/residual=[\d.]+/.test(fd ?? ''), 'the residual line must carry the measured residual');
    assert.ok((fd ?? '').includes(`threshold=${DEFAULT_THRESHOLDS.fdCountResidual.toFixed(2)}`), 'and the tolerance it exceeded');
    assert.ok(verdict.failures.some((line) => line.includes('series=children')), 'the child-count residual must red too');
});

test('(d2) counts that DO return to baseline within tolerance are green', () => {
    const report = makeReport({
        series: {
            // Peak during the drive, back to the baseline value (plus a tolerance-sized remainder) at cooldown.
            fdCount: (t, phase) => (phase === 'drive' ? 70 : phase === 'cooldown' ? 42 + 4 : 42),
            sessionScopeCount: (t, phase) => (phase === 'drive' ? 2 : 0),
        },
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `a returning count must be green:\n${verdict.lines.join('\n')}`);
});

test('(e) growth inside the warm-up window is not counted against the run', () => {
    // Cold-start growth: 120MiB -> 320MiB across the warm-up window, then dead flat while agitated.
    // It is real growth and it is not a leak; the warm-up window is what separates the two.
    const report = makeReport({
        series: {
            rssBytes: (t, phase) => (phase === 'warmup' ? 120 * MIB + 50 * MIB * t : 320 * MIB),
        },
    });
    const warmupFirst = report.samples[0].rssBytes;
    const warmupLast = report.samples.find((s) => s.phase === 'drive')?.rssBytes;
    assert.ok(typeof warmupFirst === 'number' && typeof warmupLast === 'number' && warmupLast > warmupFirst + 100 * MIB,
        'the fixture really does grow during the warm-up window');

    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `warm-up growth must not red the run:\n${verdict.lines.join('\n')}`);
    const rss = verdict.series.find((entry) => entry.name === 'rss');
    assert.equal(rss?.slope, 0, 'the fitted slope must be the drive window only, i.e. zero here');
});

test('(f) a required action that never ran is red and names which one', () => {
    for (const action of REQUIRED_ACTIONS) {
        const report = makeReport({ actions: { [action.key]: 0 } });
        const verdict = analyzeSoakReport(report);
        assert.equal(verdict.ok, false, `${action.key}=0 must red the run`);
        const failure = verdict.failures.find((line) => line.includes(`action=${action.key}`));
        assert.ok(failure, `the failure must name ${action.key}, got:\n${verdict.lines.join('\n')}`);
        assert.ok((failure ?? '').includes(action.label), 'the failure must carry the human label too');
    }
});

test('(g) a required series with too few in-window samples cannot be judged and is red', () => {
    const report = makeReport();
    // Keep the series but thin the drive window down to 3 samples: below MIN_SERIES_SAMPLES.
    const thinned = {
        ...report,
        samples: report.samples.filter((s) => s.phase !== 'drive' || s.t < WARMUP_SECONDS + 3 * INTERVAL_SECONDS),
    };
    const verdict = analyzeSoakReport(thinned);
    assert.equal(verdict.ok, false, 'a run whose series cannot be fitted must not be silently green');
    assert.ok(verdict.failures.some((line) => line.includes('样本')), verdict.lines.join('\n'));
});

test('(j) a target that disappears mid-window is red, and the verdict names the process, not the sampler', () => {
    // The 2026-09-25 failure: the server exited at t=100s of a 120s window. Every series then reads
    // "too few samples", which blames the sampler; the run must instead name the lost process.
    const report = makeReport();
    const goneFrom = WARMUP_SECONDS + 3 * INTERVAL_SECONDS;
    const withGoneTarget = {
        ...report,
        samples: report.samples.map((s) => (s.t >= goneFrom ? { ...s, rssBytes: null } : s)),
    };
    const verdict = analyzeSoakReport(withGoneTarget);
    assert.equal(verdict.ok, false, 'a run whose target vanished must not be green');
    assert.ok(
        verdict.failures.some((line) => line.includes('target=process')),
        `the verdict must name the lost target, got:\n${verdict.lines.join('\n')}`,
    );
    assert.equal(verdict.readings.targetGoneAt, goneFrom, 'the reading must say WHEN the target was lost');
});

test('(j2) one unreadable tick is tolerated as a transient /proc read, not called a death', () => {
    const report = makeReport();
    const hiccupAt = WARMUP_SECONDS + 3 * INTERVAL_SECONDS;
    const withHiccup = {
        ...report,
        samples: report.samples.map((s) => (s.t === hiccupAt ? { ...s, rssBytes: null } : s)),
    };
    const verdict = analyzeSoakReport(withHiccup);
    assert.equal(verdict.readings.targetGoneAt, null, 'a single null tick is a hiccup, not a death');
    assert.equal(verdict.ok, true, `one dropped tick must not red the run:\n${verdict.lines.join('\n')}`);
});

test('(h) a report missing an entire required series is red, not skipped', () => {
    const report = makeReport();
    const stripped = {
        ...report,
        samples: report.samples.map((sample) => {
            const { fdCount: _fdCount, ...rest } = sample;
            return rest;
        }),
    };
    const verdict = analyzeSoakReport(stripped);
    assert.equal(verdict.ok, false, 'a missing required series must red the run');
    assert.ok(verdict.failures.some((line) => line.includes('fds')), verdict.lines.join('\n'));
});

test('(i) the SERIES table only names thresholds that exist, and thresholds are positive', () => {
    for (const definition of SERIES) {
        const threshold = /** @type {Record<string, number>} */ (/** @type {unknown} */ (DEFAULT_THRESHOLDS))[definition.threshold];
        assert.ok(typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0,
            `SERIES entry ${definition.label} names threshold ${definition.threshold}, which is not a positive number`);
    }
    const liveSet = DEFAULT_THRESHOLDS.liveSetGrowthBytes;
    assert.ok(typeof liveSet === 'number' && Number.isFinite(liveSet) && liveSet > 0,
        'liveSetGrowthBytes must be a positive number of bytes');
    const perSession = DEFAULT_THRESHOLDS.liveSetBytesPerSession;
    assert.ok(typeof perSession === 'number' && Number.isFinite(perSession) && perSession > 0,
        'liveSetBytesPerSession must be a positive number of bytes');
});

test('(i2) no threshold has been inflated out of usefulness', () => {
    // The other half of (b)/(b2): those cases prove the rule fires when a series crosses the line,
    // and this one proves the line is somewhere a leak detector can live. A raw-slope threshold of
    // "as much as the churn happens to produce, times ten" would pass (b) trivially, so the bound
    // is asserted here with the reason it is what it is: the spec'd agitation measures ~5MB/s of
    // garbage, and a backstop an order of magnitude above that is the most this series may carry.
    assert.ok(DEFAULT_THRESHOLDS.rssBytesPerSecond <= 64 * MIB,
        `rssBytesPerSecond=${DEFAULT_THRESHOLDS.rssBytesPerSecond} is past the point where a raw RSS slope detects anything`);
    assert.ok(DEFAULT_THRESHOLDS.heapUsedBytesPerSecond <= 64 * MIB,
        `heapUsedBytesPerSecond=${DEFAULT_THRESHOLDS.heapUsedBytesPerSecond} is past the point where a raw heap slope detects anything`);
    // The live-set rule is the sharp one, so it is bounded much tighter: it may not be loosened
    // into the raw series' territory just because the raw series is noisy. Both halves are bounded —
    // a floor big enough to swallow a leak, or an allowance that lets every session cost megabytes,
    // would each on their own make the rule decorative.
    assert.ok(DEFAULT_THRESHOLDS.liveSetGrowthBytes <= 512 * MIB,
        `liveSetGrowthBytes=${DEFAULT_THRESHOLDS.liveSetGrowthBytes} would no longer catch a leak that matters over a server's uptime`);
    assert.ok(DEFAULT_THRESHOLDS.liveSetBytesPerSession <= 4 * MIB,
        `liveSetBytesPerSession=${DEFAULT_THRESHOLDS.liveSetBytesPerSession} is a per-session allowance no session's own state justifies`);
});

test('(k) a live-object graph that keeps growing past the budget is red, and the verdict says so', () => {
    const growth = DEFAULT_THRESHOLDS.liveSetGrowthBytes * 3;
    const report = makeReport({
        gcProbes: [
            { t: WARMUP_SECONDS, snapshotBytes: 43 * MIB, nodeCount: 500_000, sessionsCreated: 3 },
            { t: WARMUP_SECONDS + 30, snapshotBytes: 43 * MIB + growth / 2, nodeCount: 700_000, sessionsCreated: 60 },
            { t: WARMUP_SECONDS + DURATION_SECONDS, snapshotBytes: 43 * MIB + growth, nodeCount: 900_000, sessionsCreated: 110 },
        ],
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, false, 'a growing LIVE object graph is a leak, whatever the raw series do');
    const failure = verdict.failures.find((line) => line.includes('probe=live-set'));
    assert.ok(failure, `the failure must name the probe rule, got:\n${verdict.lines.join('\n')}`);
    assert.ok((failure ?? '').includes('成因'), 'the FAIL line must carry the cause');
    // The line must show BOTH halves of the budget it was measured against: a reader has to be able to
    // tell "over the flat floor" from "over what this run's sessions were allowed to cost".
    assert.ok((failure ?? '').includes(`floor=${(DEFAULT_THRESHOLDS.liveSetGrowthBytes / MIB).toFixed(2)}MiB`),
        `the FAIL line must carry the floor, got: ${failure}`);
    assert.ok((failure ?? '').includes('budget='), `the FAIL line must carry the resulting budget, got: ${failure}`);
    assert.ok((failure ?? '').includes('allowance='), `and the per-session allowance it came from, got: ${failure}`);
    assert.ok((failure ?? '').includes('perSession='),
        'the FAIL line must carry the per-session reading, which is how a reader tells workload from leak');
    assert.equal(verdict.readings.liveSetGrowthBytes, growth, 'the reading must carry the measured growth');
    assert.equal(verdict.readings.liveNodesFirst, 500_000);
    assert.equal(verdict.readings.liveNodesLast, 900_000);
});

test('(k1) growth ABOVE the floor but inside the per-session budget is GREEN — open sessions cost memory', () => {
    // The whole reason the budget has two halves. A long run creates thousands of sessions, and a
    // server holding an open session's state is not leaking. This fixture grows 2x the floor, so a
    // floor-only rule would red it; the 300 sessions it also created buy it the rest.
    const growth = DEFAULT_THRESHOLDS.liveSetGrowthBytes * 2;
    const sessionsAdded = 300;
    const budget = DEFAULT_THRESHOLDS.liveSetGrowthBytes + sessionsAdded * DEFAULT_THRESHOLDS.liveSetBytesPerSession;
    assert.ok(growth > DEFAULT_THRESHOLDS.liveSetGrowthBytes, 'the case is only interesting above the floor');
    assert.ok(growth < budget, 'and only interesting below the budget the sessions buy');
    const report = makeReport({
        gcProbes: [
            { t: WARMUP_SECONDS, snapshotBytes: 43 * MIB, sessionsCreated: 10 },
            { t: WARMUP_SECONDS + DURATION_SECONDS, snapshotBytes: 43 * MIB + growth, sessionsCreated: 10 + sessionsAdded },
        ],
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `workload-proportional growth must not red the run:\n${verdict.lines.join('\n')}`);
    const ok = verdict.lines.find((line) => line.includes('OK   probe=live-set'));
    assert.ok(ok, 'the probe rule must report OK');
    assert.ok((ok ?? '').includes('measuredPerSession='), `the OK line must still print the measured cost, got: ${ok}`);
    assert.ok((ok ?? '').includes(`sessions=10->${10 + sessionsAdded}`), 'and the session span it was amortised over');
});

test('(k1b) growth with NO new sessions reds on the floor — the pure time-proportional leak', () => {
    // No workload to explain the growth: this is the shape a real leak has, and it must not be
    // amortised away by the per-session half of the budget.
    const report = makeReport({
        gcProbes: [
            { t: WARMUP_SECONDS, snapshotBytes: 43 * MIB, sessionsCreated: 226 },
            { t: WARMUP_SECONDS + DURATION_SECONDS, snapshotBytes: 43 * MIB + DEFAULT_THRESHOLDS.liveSetGrowthBytes * 2, sessionsCreated: 226 },
        ],
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, false, 'growth with no workload to explain it is a leak');
    const failure = verdict.failures.find((line) => line.includes('probe=live-set'));
    assert.ok((failure ?? '').includes('sessions=226->226'), `the line must show the session count did not move, got: ${failure}`);
    assert.ok((failure ?? '').includes('纯时间增长'), 'and the cause must say the growth is time-proportional');
});

test('(k2) raw growth with a FLAT live set is green — that is garbage, not a leak', () => {
    // The shape the first real run produced: RSS and heapUsed climb hard across the drive window
    // because the collector has not run, while the snapshots show the live object graph hardly
    // moving. Redding this is what would make the harness cry wolf on every healthy server.
    const report = makeReport({
        series: {
            rssBytes: (t, phase) => (phase === 'warmup' ? 200 * MIB : 200 * MIB + 5 * MIB * (t - WARMUP_SECONDS)),
            heapUsedBytes: (t, phase) => (phase === 'warmup' ? 40 * MIB : 40 * MIB + 5 * MIB * (t - WARMUP_SECONDS)),
        },
        gcProbes: [
            { t: WARMUP_SECONDS, snapshotBytes: 43 * MIB, nodeCount: 480_000, sessionsCreated: 4 },
            { t: WARMUP_SECONDS + 60, snapshotBytes: 45 * MIB, nodeCount: 490_000, sessionsCreated: 120 },
            { t: WARMUP_SECONDS + DURATION_SECONDS, snapshotBytes: 44 * MIB, nodeCount: 486_000, sessionsCreated: 226 },
        ],
    });
    const verdict = analyzeSoakReport(report);
    assert.equal(verdict.ok, true, `garbage must not read as a leak:\n${verdict.lines.join('\n')}`);
    assert.ok(verdict.lines.some((line) => line.includes('OK   probe=live-set')), 'the probe rule must report OK');
});

test('(k3) a report with no usable snapshots SKIPs the live-set rule instead of passing it', () => {
    const absent = analyzeSoakReport(makeReport());
    const skip = absent.lines.find((line) => line.includes('SKIP probe=live-set'));
    assert.ok(skip, `a run without snapshots must say so:\n${absent.lines.join('\n')}`);
    assert.ok(skip.includes('未判定') || skip.includes('不是通过'), 'the SKIP line must say the rule was not judged, not that it passed');
    assert.equal(absent.readings.probeCount, 0);
    // A drive report always carries probes; the AC-2 stubs (no --diagnostic-dir) legitimately do not,
    // so absence may not by itself red a run — but a probe whose snapshot could not be written is the
    // same SKIP, and must not be counted as a reading.
    const unreadable = analyzeSoakReport(makeReport({
        gcProbes: [{ t: WARMUP_SECONDS, snapshotBytes: null, note: 'no-snapshot' }],
    }));
    assert.ok(unreadable.lines.some((line) => line.includes('SKIP probe=live-set')), 'an unwritten snapshot is not a reading');
    assert.equal(unreadable.ok, true, 'and it does not red a run on its own');
});

test('linearRegression: fitted slope, exactness on a straight line, and the degenerate cases', () => {
    assert.equal(linearRegression([[0, 0], [1, 2], [2, 4]]).slope, 2);
    assert.equal(linearRegression([[0, 5], [1, 5], [2, 5]]).slope, 0);
    assert.equal(linearRegression([[3, 7]]).slope, 0, 'one point has no slope');
    assert.equal(linearRegression([]).slope, 0, 'no points has no slope');
    const fitted = linearRegression([[0, 1], [1, 3], [2, 5], [3, 7]]);
    assert.equal(fitted.slope, 2);
    assert.equal(fitted.intercept, 1);
    assert.equal(fitted.r2, 1, 'a perfect line has r2 = 1');
});

test('median: even and odd counts', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([]), 0);
});
