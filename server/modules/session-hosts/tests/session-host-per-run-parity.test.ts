/**
 * Criterion for AC-155: the client-visible frames of a chat run are unchanged
 * by the session-host layer.
 *
 * Every sequence below is driven through the application's real dispatch
 * surface — `handleChatConnection` for `chat.send` / `chat.abort` /
 * `chat.subscribe`, the real `chatRunRegistry` for sequencing and replay, the
 * production `providerRuntimeService` singleton for the run itself — with only
 * each provider's *process* forged. The comparison is against
 * `fixtures/per-run-frame-baseline.json`, recorded on the tree that predates the
 * per-run wrapper, so "identical" here means identical to what a browser
 * received before the wrapper existed.
 *
 * The comparison is a zero-difference claim, which is the kind that is easiest to
 * make true by accident. Four things keep it honest, and each prints its reading:
 *
 * 1. Every sequence must be non-trivial (AC3) — a positive control on the input,
 *    so "equal" cannot be satisfied by two empty streams.
 * 2. The wrapper must actually be on the path (AC4) — otherwise a reverted
 *    `provider-runtime.service` would compare the old tree against itself and
 *    pass while proving nothing.
 * 3. The comparator itself must flag a dropped frame and an appended one (AC6) —
 *    the detection path the two falsifying variants rely on.
 * 4. The recording must be reproducible (AC7) — otherwise the baseline and the
 *    live reading are two samples of a noisy process.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { sessionHostManager } from '@/modules/session-hosts/index.js';

import {
  MID_STREAM_LAST_SEQ,
  PROVIDER_IDS,
  SCENARIO_IDS,
  UNSTABLE_FRAME_FIELDS,
  compareFrames,
  projectFrames,
  readBaseline,
  runScenario,
  type Baseline,
  type Frame,
  type FrameSequence,
  type ProviderId,
  type ScenarioId,
} from './per-run-frame-scenarios.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout the criterion is measuring, used to date the fixture's claim. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
/** The path whose presence or absence dates a tree relative to the host layer. */
const HOST_MODULE_PATH = 'server/modules/session-hosts/index.ts';

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** True when `revision`'s tree contains the session-host module. */
function revisionHasHostModule(revision: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `${revision}:${HOST_MODULE_PATH}`], {
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function kindsOf(frames: FrameSequence): string {
  return frames.map((frame) => String(frame.kind)).join(',');
}

type Reading = {
  provider: ProviderId;
  scenario: ScenarioId;
  /** Frames exactly as the socket received them, before projection. */
  raw: FrameSequence;
  frames: FrameSequence;
};

type HostReading = {
  provider: ProviderId;
  sessionId: string;
  /** Every host the manager knew about at that moment, in any mode. */
  total: number;
  /** The hosts carrying this session as a `per-run` binding. */
  matching: number;
  detail: string;
};

const hostReadings = new Map<ProviderId, HostReading>();
let drivePromise: Promise<Reading[]> | null = null;

/**
 * Drives the 16 scenarios once and memoises them, so the readings the later
 * assertions quote are the same ones the earlier ones printed.
 */
function readings(): Promise<Reading[]> {
  drivePromise ??= (async () => {
    const collected: Reading[] = [];
    for (const provider of PROVIDER_IDS) {
      for (const scenario of SCENARIO_IDS) {
        const run = await runScenario(
          provider,
          scenario,
          scenario === 'turn'
            ? {
              onInFlight: ({ sessionId }) => {
                const hosts = sessionHostManager.snapshot();
                const bound = hosts.filter(
                  (host) => host.mode === 'per-run' && host.bindings.has(sessionId),
                );
                hostReadings.set(provider, {
                  provider,
                  sessionId,
                  total: hosts.length,
                  matching: bound.length,
                  detail: bound
                    .map((host) => `${host.hostId}(mode=${host.mode} state=${host.state})`)
                    .join(' '),
                });
              },
            }
            : {},
        );
        collected.push({
          provider,
          scenario,
          raw: run.frames,
          frames: projectFrames(run.frames),
        });
      }
    }
    return collected;
  })();
  return drivePromise;
}

async function baselineOrFail(): Promise<Baseline> {
  const baseline = await readBaseline();
  assert.ok(
    baseline,
    'the committed baseline fixture is missing — record it on the pre-wrapper tree first',
  );
  return baseline;
}

function framesFor(baseline: Baseline, provider: ProviderId, scenario: ScenarioId): FrameSequence {
  const record = baseline.records.find(
    (candidate) => candidate.provider === provider && candidate.scenario === scenario,
  );
  assert.ok(record, `baseline has no record for ${provider}/${scenario}`);
  return record.frames;
}

// ---------------------------
//----------------- READINGS ------------
test('AC2/AC3: sixteen recordings through the real dispatch surface, each non-trivial', async () => {
  const all = await readings();
  const baseline = await baselineOrFail();

  for (const reading of all) {
    console.log(
      `provider=${reading.provider} scenario=${reading.scenario} ` +
        `frames=${reading.frames.length} kinds=${kindsOf(reading.frames)}`,
    );
  }
  assert.equal(all.length, PROVIDER_IDS.length * SCENARIO_IDS.length);
  assert.equal(new Set(all.map((reading) => `${reading.provider}/${reading.scenario}`)).size, all.length);

  for (const reading of all) {
    assert.ok(
      reading.frames.length > 0,
      `${reading.provider}/${reading.scenario} recorded no frames at all`,
    );
  }

  for (const provider of PROVIDER_IDS) {
    const turn = all.find((r) => r.provider === provider && r.scenario === 'turn');
    assert.ok(turn);
    const completes = turn.frames.filter((frame) => frame.kind === 'complete');
    assert.equal(completes.length, 1, `${provider}/turn must end in exactly one terminal complete`);
    // `exitCode`/`aborted` are printed by presence, not by value: the wrapper must
    // not drop them from a `complete` that carries them, but codex's own emitter
    // never sets either — a per-provider difference the baseline already records
    // and the projection is not allowed to launder into a uniform shape.
    console.log(
      `provider=${provider} turn complete=1 ` +
        `hasExitCode=${'exitCode' in completes[0]} hasAborted=${'aborted' in completes[0]} ` +
        `exitCode=${String(completes[0].exitCode)} aborted=${String(completes[0].aborted)}`,
    );

    const busy = all.find((r) => r.provider === provider && r.scenario === 'busy');
    assert.ok(busy);
    const refusals = busy.frames.filter((frame) => frame.kind === 'protocol_error');
    assert.equal(
      refusals.length,
      1,
      `${provider}/busy must carry exactly one RUN_IN_PROGRESS protocol_error for the ` +
        `refused second send (found ${refusals.length}; kinds=${kindsOf(busy.frames)})`,
    );
    assert.equal(
      refusals[0].code,
      'RUN_IN_PROGRESS',
      `${provider}/busy must refuse the second send while the first is running`,
    );

    const replay = all.find((r) => r.provider === provider && r.scenario === 'replay');
    assert.ok(replay);
    const acks = replay.frames.filter((frame) => frame.kind === 'chat_subscribed');
    assert.equal(acks.length, 1, `${provider}/replay must carry exactly one subscribe ack`);
    const ackIndex = replay.frames.indexOf(acks[0]);
    // Buffered frames the subscribe replayed, i.e. everything the observer
    // received after the ack that the registry had already sequenced — the
    // terminal `complete` is excluded because the forges emit it after the gate
    // opens, so counting it would credit the replay with a frame it did not
    // deliver.
    const replayed = replay.frames
      .slice(ackIndex + 1)
      .filter((frame) => frame.kind !== 'complete')
      .filter((frame) => typeof frame.seq === 'number' && frame.seq > MID_STREAM_LAST_SEQ);
    assert.ok(
      replayed.length >= 1,
      `${provider}/replay replayed nothing after lastSeq=${MID_STREAM_LAST_SEQ}`,
    );
    assert.ok(
      typeof acks[0].lastSeq === 'number' && acks[0].lastSeq > MID_STREAM_LAST_SEQ,
      `${provider}/replay subscribed after the stream had already passed lastSeq=${MID_STREAM_LAST_SEQ}`,
    );
    console.log(
      `provider=${provider} replay ackLastSeq=${String(acks[0].lastSeq)} ` +
        `replayed=${replayed.length} kinds=${kindsOf(replayed)}`,
    );
  }

  // The baseline is read here too so a fixture that lost records fails on the
  // same run that prints the readings, not silently later.
  assert.equal(baseline.records.length, all.length);
});

test('AC4: the session-host layer is on the path, and every sequence matches the baseline', async () => {
  const all = await readings();
  const baseline = await baselineOrFail();

  for (const provider of PROVIDER_IDS) {
    const reading = hostReadings.get(provider);
    assert.ok(reading, `${provider}: no host snapshot was taken while the turn was in flight`);
    console.log(
      `provider=${provider} session=${reading.sessionId} hosts=${reading.total} ` +
        `mode=per-run=${reading.matching} ${reading.detail}`,
    );
    assert.equal(
      reading.matching,
      1,
      `${provider}: exactly one per-run host must be bound to the in-flight session`,
    );
  }

  for (const reading of all) {
    const expected = framesFor(baseline, reading.provider, reading.scenario);
    const diff = compareFrames(expected, reading.frames);
    assert.ok(diff.equal, `${reading.provider}/${reading.scenario}: ${diff.reason}`);
  }
  console.log(
    `baseline compared: ${all.length} sequences, ${all.reduce(
      (total, reading) => total + reading.frames.length,
      0,
    )} frames, 0 differences (projection drops ${UNSTABLE_FRAME_FIELDS.join(' + ')})`,
  );
});

// ---------------------------
//----------------- FIXTURE PROVENANCE ------------
test('AC5: the baseline was recorded before the host layer existed', async () => {
  const baseline = await baselineOrFail();
  const recordedAtCommit = baseline.recordedAtCommit;
  const head = git(['rev-parse', 'HEAD']);

  const recordedHasModule = revisionHasHostModule(recordedAtCommit);
  const headHasModule = revisionHasHostModule('HEAD');
  console.log(
    `leg1 recordedAtCommit=${recordedAtCommit} containsHostModule=${recordedHasModule} -> ${
      recordedHasModule ? 'FAIL' : 'PASS'
    }`,
  );
  console.log(
    `leg2 HEAD=${head} containsHostModule=${headHasModule} -> ${headHasModule ? 'PASS' : 'FAIL'}`,
  );

  assert.equal(
    recordedHasModule,
    false,
    `leg 1 failed: the baseline claims ${recordedAtCommit}, but that tree already contains ${HOST_MODULE_PATH}`,
  );
  assert.equal(
    headHasModule,
    true,
    `leg 2 failed: HEAD (${head}) does not contain ${HOST_MODULE_PATH}, so the wrapper is not on this tree`,
  );
});

// ---------------------------
//----------------- COMPARATOR SELF-TEST ------------
test('AC6: the comparator flags a dropped frame and an appended one', async () => {
  const baseline = await baselineOrFail();
  const sample = framesFor(baseline, 'claude', 'turn');
  const lastFrame = sample[sample.length - 1];
  assert.ok(lastFrame, 'the sample sequence is empty, so the self-test proves nothing');

  const missingVerdict = compareFrames(sample, sample.slice(0, -1));
  console.log(`comparator baseline-minus-last-frame -> ${missingVerdict.reason}`);
  assert.equal(missingVerdict.equal, false);
  assert.equal(missingVerdict.missingIndex, sample.length - 1);
  assert.ok(
    missingVerdict.reason?.includes(JSON.stringify(lastFrame)),
    'the missing-frame verdict must name the frame that went missing',
  );

  const synthetic: Frame = {
    kind: 'complete',
    provider: sample[0].provider,
    sessionId: sample[0].sessionId,
    actualSessionId: sample[0].sessionId,
    exitCode: 0,
    success: true,
    aborted: false,
    seq: sample.length + 1,
  };
  const extraVerdict = compareFrames(sample, [...sample, synthetic]);
  console.log(`comparator baseline-plus-synthetic-complete -> ${extraVerdict.reason}`);
  assert.equal(extraVerdict.equal, false);
  assert.equal(extraVerdict.extraIndex, sample.length);
  assert.ok(
    extraVerdict.reason?.includes(JSON.stringify(synthetic)),
    'the extra-frame verdict must name the frame that was appended',
  );
});

// ---------------------------
//----------------- RECORDING DETERMINISM ------------
test('AC7: a re-run of the same scenario projects to the same bytes', async () => {
  // The "first run" of each pair is the reading the earlier tests already took,
  // not a fresh drive: that makes the comparison span the whole file's wall
  // clock instead of two adjacent calls, and it keeps this test to four drives
  // rather than eight — the criterion is run under a hard timeout by the
  // promotion gate, and the machine it runs on is often heavily oversubscribed.
  const all = await readings();
  const pairs: Array<[ProviderId, ScenarioId]> = [
    ['claude', 'turn'],
    ['codex', 'busy'],
    ['cursor', 'replay'],
    ['opencode', 'turn'],
  ];

  let projectionIsLoadBearing = false;
  for (const [provider, scenario] of pairs) {
    const first = all.find((r) => r.provider === provider && r.scenario === scenario);
    assert.ok(first, `${provider}/${scenario} was never driven`);
    const second = await runScenario(provider, scenario);
    const run1 = first.frames;
    const run2 = projectFrames(second.frames);
    const rawEqual = JSON.stringify(first.raw) === JSON.stringify(second.frames);
    const equal = compareFrames(run1, run2).equal;
    console.log(
      `provider=${provider} scenario=${scenario} run1=${run1.length} run2=${run2.length} ` +
        `rawEqual=${rawEqual} equal=${equal}`,
    );
    assert.ok(equal, `${provider}/${scenario}: two runs of the same scenario projected differently`);
    if (!rawEqual) {
      projectionIsLoadBearing = true;
    }
  }

  // If projection dropped nothing, the two runs would also be raw-equal — and
  // then the drop list would be dead weight nobody had justified. Seeing it
  // drop something is what makes `UNSTABLE_FRAME_FIELDS` a reading rather than a
  // guess.
  assert.ok(
    projectionIsLoadBearing,
    `no pair differed before projection, so dropping ${UNSTABLE_FRAME_FIELDS.join(' + ')} is unjustified`,
  );
});
