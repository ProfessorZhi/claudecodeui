import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDatabase } from '@/modules/database/index.js';
import {
  forwardNormalizedFrames,
  providerRegistry,
  providerRuntimeService,
  readSessionTurn,
  sessionsService,
} from '@/modules/providers/index.js';
import { WS_OPEN_STATE, chatRunRegistry } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, NormalizedMessage, ProviderRuntimeWriter } from '@/shared/types.js';

import {
  DEBUG_AGENT_PROVIDER_ID,
  armDebugAgentScenario,
  readDebugAgentGate,
  type DebugAgentRunReading,
  type DebugAgentScenario,
  type DebugAgentScenarioEvaluation,
} from '../index.js';
import {
  buildTextDeltaRow,
  buildThinkingTokensRow,
  buildToolResultRow,
  buildToolUseRow,
  buildTurnResultRow,
  readTranscriptLines,
  readTranscriptRows,
} from '../debug-agent.runtime.js';

/**
 * The criterion for ADR-003 decision 4: a debug agent run must write a real-shaped
 * transcript, and every frame it produces must be a normalization of a row that is
 * on disk.
 *
 * A `complete` makes every client re-fetch the session's history over REST. That
 * is why "live and history agree" cannot be asserted from one side: a run that
 * forwards frames without writing shows a client a conversation whose history is
 * empty (frames-only), and a run that writes rows without forwarding them shows a
 * history nobody saw arrive (rows-only). This file pins both directions at once,
 * by measuring the SAME run three ways — the frames that reached the socket, the
 * file the run left on disk, and the history the REST read returns — and requiring
 * each produced message to appear in all three.
 *
 * Why every reading comes from a CHILD process. The gate is evaluated once per
 * process, the run path opens the process's database, and the scenario's fixture
 * home is a per-run scratch directory, so a child per arm is the only way to take
 * a reading without the previous arm's state in it. This mirrors the gate
 * criterion's own shape; the two files share no code because the readings differ.
 *
 * What is deliberately NOT here: no frame-kind or event name appears anywhere in
 * this module, including this file. The frames below are selected by "carries an
 * id", which is a property of a normalized message and not a vocabulary of the
 * debug agent's own — the row shapes are in `debug-agent.runtime.ts`, and the
 * frames are whatever the product's normalizer makes of them.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: the gate criterion asserts that, outside the gate module,
// `server/` contains no direct read of it, and this file must pass that check.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_FRAMES_PROBE';
const MODE_VAR = 'DEBUG_AGENT_FRAMES_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_FRAMES_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);
const TYPES_MODULE = path.join(REPO_ROOT, 'server', 'shared', 'types.ts');

/**
 * The union line this criterion pins: the runtime provider id must not become a
 * member of it. Widening the union would make half of the gate criterion vacuous
 * (every id in the union resolves by construction), so the line is asserted here
 * rather than left to review.
 */
const PROVIDER_UNION_LINE = "export type LLMProvider = 'claude' | 'codex' | 'cursor' | 'opencode';";

/**
 * The scenario one `frames` child drives: two rows (the row count moves) and one
 * in-place growth between them (the byte count moves, the row count does not).
 * Both operations are in the same run on purpose — a build that implemented them
 * as one thing could satisfy either reading alone and not both.
 */
const SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: {
    title: 'debug agent frames fixture',
    userText: 'please summarise the release notes',
  },
  steps: [
    { at: 30, op: 'row', role: 'assistant', text: 'the release notes cover three areas' },
    { at: 60, op: 'grow', text: 'the release notes cover three areas, and the third one is still being written out' },
    { at: 90, op: 'row', role: 'user', text: 'thanks — and what about the migration guide?' },
  ],
  expect: {
    rows: { delta: 2 },
    content: {
      mustContain: [
        'the third one is still being written out',
        'what about the migration guide?',
      ],
    },
  },
};

type FailureReading = { errorName: string; code: string | null; statusCode: number | null; message: string };
type Outcome = { ok: true; id: string } | ({ ok: false } & FailureReading);

/** One frame as it reached the socket, trimmed to what the readings below use. */
type FrameReading = { kind: string; id: string | null; seq: number | null; contentLength: number | null };

type FramesReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  transcript: {
    path: string;
    rowsBefore: number;
    rowsAfter: number;
    /** The whole fixture transcript; small by construction, and what a red has to show. */
    text: string;
  };
  run: DebugAgentRunReading;
  evaluation: DebugAgentScenarioEvaluation;
  seed: { rows: number; ids: string[] };
  produced: { rows: number; ids: string[] };
  frames: FrameReading[];
  /** Frames that carry a produced message's content — see the reading below. */
  frameIds: string[];
  /** Frames that carry no message: the run's own end marker. */
  endMarkers: number;
  seqs: number[];
  history: { count: number; total: number; ids: string[] };
  coverage: {
    producedNotInFrames: string[];
    producedNotInHistory: string[];
    framesNotInHistory: string[];
    seedIdsMissingFromHistory: string[];
    intersection: string[];
  };
};

type RegistryReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  providerIds: string[];
  debug: Outcome;
  typo: Outcome;
  debugNormalized: string | null;
  typoNormalized: string | null;
};

// --------------------------- child process ---------------------------

function outcomeOf(run: () => unknown): Outcome {
  try {
    const provider = run() as { id: string };
    return { ok: true, id: provider.id };
  } catch (error) {
    const typed = error as { name?: string; code?: string; statusCode?: number; message?: string };
    return {
      ok: false,
      errorName: typed.name ?? 'Error',
      code: typeof typed.code === 'string' ? typed.code : null,
      statusCode: typeof typed.statusCode === 'number' ? typed.statusCode : null,
      message: typed.message ?? String(error),
    };
  }
}

/** Blanks the requested id out of a failure, so two failures compare literally. */
function normalizeFailure(outcome: Outcome, requestedId: string): string | null {
  return outcome.ok ? null : outcome.message.replaceAll(requestedId, '<id>');
}

function readRegistry(): RegistryReading {
  const gate = readDebugAgentGate();
  const debug = outcomeOf(() => providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID));
  const typo = outcomeOf(() => providerRegistry.resolveProvider('claud'));

  return {
    gate,
    providerIds: providerRegistry.listProviders().map(({ id }) => id),
    debug,
    typo,
    debugNormalized: normalizeFailure(debug, DEBUG_AGENT_PROVIDER_ID),
    typoNormalized: normalizeFailure(typo, 'claud'),
  };
}

/**
 * Drives one armed scenario through the product's own chain — run registry, then
 * the runtime dispatcher — and measures the result against the socket, the disk
 * and the history the REST read returns.
 *
 * The chain is the product's, not a shortcut around it: `chatRunRegistry.startRun`
 * is what assigns `seq` and remaps the session id, and `providerRuntimeService.run`
 * is what builds the runtime context whose `normalizeMessage` is the provider's own.
 * A test that called the runtime directly would prove nothing about `seq`, and one
 * that normalized rows itself would prove nothing about the frames.
 */
async function readFrames(): Promise<FramesReading> {
  await initializeDatabase();

  const fixtureHome = process.env[GATE_HOME_VAR] ?? '';
  const provider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);

  const armed = await armDebugAgentScenario({
    projectPath: path.join(fixtureHome, 'workspace'),
    scenario: SCENARIO,
    synchronizeTranscript: (filePath) => provider.sessionSynchronizer.synchronizeFile(filePath),
  });

  const frames: FrameReading[] = [];
  const connection = {
    readyState: WS_OPEN_STATE,
    send(data: string): void {
      const frame = JSON.parse(data) as Record<string, unknown>;
      frames.push({
        kind: typeof frame.kind === 'string' ? frame.kind : '<none>',
        id: typeof frame.id === 'string' ? frame.id : null,
        seq: typeof frame.seq === 'number' ? frame.seq : null,
        contentLength: typeof frame.content === 'string' ? frame.content.length : null,
      });
    },
  };

  const run = chatRunRegistry.startRun({
    appSessionId: armed.sessionId,
    provider: DEBUG_AGENT_PROVIDER_ID as LLMProvider,
    providerSessionId: armed.providerSessionId,
    connection,
    userId: null,
  });
  assert.ok(run, 'the run registry refused to start a run for the armed session');

  const outcome = (await providerRuntimeService.run(
    DEBUG_AGENT_PROVIDER_ID as LLMProvider,
    'debug agent scenario',
    { sessionId: armed.sessionId, cwd: armed.projectPath, projectPath: armed.projectPath },
    run.writer,
  )) as { reading: DebugAgentRunReading; evaluation: DebugAgentScenarioEvaluation };

  // The history leg, driven the way the frontend drives it after a `complete`:
  // `GET /api/providers/sessions/:sessionId/messages` parses the query, calls
  // exactly this service method, and wraps the result in an envelope. The router
  // itself is not reachable from this module — the providers barrel does not
  // export it, and reaching into its file would cross the module boundary the
  // backend standards draw — so the leg starts one hop below HTTP, at the call
  // the route handler makes. `limit: null` and `offset: 0` are what a request
  // with neither query parameter resolves to.
  const history = await sessionsService.fetchHistory(armed.sessionId, { limit: null, offset: 0 });

  const normalize = (row: unknown): NormalizedMessage[] =>
    provider.sessions.normalizeMessage(row, armed.providerSessionId);
  const idsOf = (rows: unknown[]): string[] => {
    const ids: string[] = [];
    for (const row of rows) {
      for (const message of normalize(row)) {
        if (typeof message.id === 'string' && message.id.length > 0 && !ids.includes(message.id)) {
          ids.push(message.id);
        }
      }
    }

    return ids;
  };

  const rows = readTranscriptRows(armed.transcriptPath);
  const seedIds = idsOf(rows.slice(0, armed.seedRows));
  const producedIds = idsOf(rows.slice(armed.seedRows));

  // A produced message reaches the socket as a frame carrying that message's
  // content. The run's end marker also carries an id, but no message: it names
  // the end of the run rather than a row, so it can never be in the history and
  // is counted separately instead of being filtered out silently.
  const messageFrames = frames.filter(({ id, contentLength }) => id !== null && contentLength !== null);
  const frameIds = [...new Set(messageFrames.map(({ id }) => id as string))];
  const endMarkers = frames.length - messageFrames.length;
  const historyIds = history.messages
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const seqs = frames.map(({ seq }) => seq).filter((seq): seq is number => seq !== null);

  // `rowsBefore` is the seed's own row count, re-measured rather than taken from
  // the run's report: the two numbers the row/grow boundary is about must both be
  // readings of the file.
  return {
    gate: readDebugAgentGate(),
    transcript: {
      path: armed.transcriptPath,
      rowsBefore: armed.seedRows,
      rowsAfter: rows.length,
      text: readTranscriptLines(armed.transcriptPath).join('\n'),
    },
    run: outcome.reading,
    evaluation: outcome.evaluation,
    seed: { rows: armed.seedRows, ids: seedIds },
    produced: { rows: rows.length - armed.seedRows, ids: producedIds },
    frames,
    frameIds,
    endMarkers,
    seqs,
    history: { count: history.messages.length, total: history.total, ids: historyIds },
    coverage: {
      producedNotInFrames: producedIds.filter((id) => !frameIds.includes(id)),
      producedNotInHistory: producedIds.filter((id) => !historyIds.includes(id)),
      framesNotInHistory: frameIds.filter((id) => !historyIds.includes(id)),
      seedIdsMissingFromHistory: seedIds.filter((id) => !historyIds.includes(id)),
      intersection: frameIds.filter((id) => historyIds.includes(id)),
    },
  };
}

// --------------------------- parent process ---------------------------

type ChildMode = 'frames' | 'gate-open' | 'gate-closed';

type ChildRun<Reading> = { reading: Reading; scratch: string; home: string; fixtureHome: string; stderr: string };

/**
 * Runs one child in one mode. `HOME` is redirected into a scratch directory for
 * every mode, and `DATABASE_PATH` points inside it, so no arm can reach the
 * machine's real `~/.claude` or its real database — including the modes that are
 * supposed to do work.
 */
function runChild<Reading>(mode: ChildMode): ChildRun<Reading> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-frames-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'frames.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
  };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];

  if (mode !== 'gate-closed') {
    env[GATE_VAR] = 'on';
    env[GATE_HOME_VAR] = fixtureHome;
  }

  let stdout: string;
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    }) as unknown as string;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    stderr = failure.stderr ?? String(error);
    stdout = failure.stdout ?? '';
    throw new Error(`probe child (${mode}) exited non-zero.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }

  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(PROBE_MARKER))
    .pop();

  assert.ok(line, `probe child (${mode}) printed no reading; stdout was:\n${stdout}`);

  return {
    reading: JSON.parse(line.slice(PROBE_MARKER.length)) as Reading,
    scratch,
    home,
    fixtureHome,
    stderr,
  };
}

/** The strictly-increasing check, kept separate so the reading and the verdict cannot drift. */
function firstNonIncreasing(seqs: number[]): string | null {
  for (let index = 1; index < seqs.length; index += 1) {
    if (seqs[index] <= seqs[index - 1]) {
      return `seq ${seqs[index]} at index ${index} does not exceed ${seqs[index - 1]}`;
    }
  }

  return seqs.length === 0 ? 'no frame carried a seq at all' : null;
}

function describeFrames(reading: FramesReading): string {
  const { evaluation, produced, frameIds, history, coverage } = reading;

  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[AC1(a) rows] file ${reading.transcript.rowsBefore} -> ${reading.transcript.rowsAfter} rows, delta ${evaluation.rowsDelta} (expected ${SCENARIO.expect.rows.delta}); missing content ${JSON.stringify(evaluation.missingContent)}`,
    `[AC1(b) grow] ${evaluation.grows.length} grow(s); ${
      evaluation.grows
        .map(
          (grow) =>
            `steps[${grow.stepIndex}] rows ${grow.rowsBefore}->${grow.rowsAfter}, last row ${grow.bytesBefore}->${grow.bytesAfter} bytes, id ${JSON.stringify(grow.idBefore)}->${JSON.stringify(grow.idAfter)}, content changed=${grow.contentChanged}`,
        )
        .join(' | ') || '<none>'
    }; lastRowGrew=${evaluation.lastRowGrew}`,
    `[AC1(c) ids] produced ${JSON.stringify(produced.ids)} from ${produced.rows} written row(s); frames carrying a message ${JSON.stringify(frameIds)} (+${reading.endMarkers} end marker frame(s) carrying none); history ${JSON.stringify(history.ids)} (${history.count} message(s), total ${history.total}); intersection ${JSON.stringify(coverage.intersection)}; missing from frames ${JSON.stringify(coverage.producedNotInFrames)}; missing from history ${JSON.stringify(coverage.producedNotInHistory)}; frames not in history ${JSON.stringify(coverage.framesNotInHistory)}; seed ids missing from history ${JSON.stringify(coverage.seedIdsMissingFromHistory)}`,
    `[AC1(d) seq] ${JSON.stringify(reading.seqs)}; first non-increasing: ${firstNonIncreasing(reading.seqs) ?? 'none'}`,
    `[evaluation] failures ${JSON.stringify(evaluation.failures)}`,
  ].join('\n');
}

function describeRegistry(reading: RegistryReading): string {
  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[ids] ${JSON.stringify(reading.providerIds)}`,
    `[resolve('${DEBUG_AGENT_PROVIDER_ID}')] ${reading.debug.ok ? `resolved -> ${reading.debug.id}` : `${reading.debug.errorName}/${reading.debug.code}/${reading.debug.statusCode}`}`,
    `[resolve('claud')] ${reading.typo.ok ? `resolved -> ${reading.typo.id}` : `${reading.typo.errorName}/${reading.typo.code}/${reading.typo.statusCode}`}`,
    `[normalized] debug=${JSON.stringify(reading.debugNormalized)} typo=${JSON.stringify(reading.typoNormalized)}`,
  ].join('\n');
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the reading for this mode, print one line, exit.
  const mode = process.env[MODE_VAR];
  const reading =
    mode === 'frames' ? await readFrames() : mode === 'gate-open' || mode === 'gate-closed' ? readRegistry() : null;

  if (!reading) {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  console.log(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  registerCriteria();
}

function registerCriteria(): void {
  test('a run forwards every message it wrote, and writes every message it forwarded', () => {
    const { reading, scratch } = runChild<FramesReading>('frames');

    try {
      console.log(describeFrames(reading));

      assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');

      // ---- AC1(a): the rows really landed, and the content is really in the file ----
      assert.equal(
        reading.evaluation.rowsDelta,
        SCENARIO.expect.rows.delta,
        `磁盘零行: the run wrote ${reading.evaluation.rowsDelta} row(s) (${reading.transcript.rowsBefore} -> ${reading.transcript.rowsAfter} on disk); the scenario expects ${SCENARIO.expect.rows.delta}`,
      );
      assert.equal(
        reading.transcript.rowsAfter - reading.transcript.rowsBefore,
        SCENARIO.expect.rows.delta,
        'the delta the file shows must be the delta the scenario asked for',
      );
      assert.deepEqual(reading.evaluation.missingContent, [], 'every `mustContain` entry must be in the file');
      for (const entry of SCENARIO.expect.content.mustContain) {
        assert.ok(
          reading.transcript.text.includes(entry),
          `磁盘零行: the transcript does not contain ${JSON.stringify(entry)}`,
        );
      }

      // ---- AC1(b): row count held, bytes grew, same message id, different content ----
      assert.equal(reading.evaluation.grows.length, 1, 'the scenario grows exactly one row');
      const [grow] = reading.evaluation.grows;
      assert.equal(grow.rowsBefore, grow.rowsAfter, 'a grow must not change the row count');
      assert.ok(grow.bytesAfter > grow.bytesBefore, `a grow must grow the row (${grow.bytesBefore} -> ${grow.bytesAfter} bytes)`);
      assert.ok(grow.idBefore !== null && grow.idAfter !== null, 'both readings must normalize to a message id');
      assert.equal(grow.idAfter, grow.idBefore, 'a grow rewrites one message rather than replacing it');
      assert.equal(grow.contentChanged, true, 'a grow must change the content of that one message');
      assert.equal(reading.evaluation.lastRowGrew, true, 'every grow in this run grew in place');

      // The row/grow boundary, in one place: the run both added rows AND grew one
      // in place, so a build that implemented the two as one thing cannot satisfy
      // this pair.
      assert.ok(reading.transcript.rowsAfter - reading.transcript.rowsBefore > 0, 'rows were added');
      assert.ok(grow.rowsAfter === grow.rowsBefore, 'and one row was grown without adding any');

      // ---- AC1(c): the three measurements agree, per message ----
      assert.ok(
        reading.endMarkers >= 1,
        'the run must report its own end; without that frame a client never learns the run finished',
      );
      assert.ok(
        reading.produced.ids.length >= SCENARIO.expect.rows.delta,
        `磁盘零行: the run's ${reading.produced.rows} written row(s) produced ${reading.produced.ids.length} message id(s)`,
      );
      assert.deepEqual(
        reading.coverage.producedNotInFrames,
        [],
        `a row on disk was never forwarded: ${JSON.stringify(reading.coverage.producedNotInFrames)}`,
      );
      assert.deepEqual(
        reading.coverage.producedNotInHistory,
        [],
        `history 缺消息: the REST read does not contain every message the run produced (${JSON.stringify(reading.coverage.producedNotInHistory)})`,
      );
      assert.deepEqual(
        reading.coverage.framesNotInHistory,
        [],
        `历史缺消息: a frame reached the socket that the REST read does not contain (${JSON.stringify(reading.coverage.framesNotInHistory)})`,
      );
      assert.deepEqual(
        reading.coverage.intersection.slice().sort(),
        reading.produced.ids.slice().sort(),
        'the intersection of the two id sets must cover every message this run produced',
      );

      // The control that keeps the three sets from agreeing by being empty: the
      // seed rows were indexed before the run, so the history leg must show them
      // too. Without this, a history reader that returned nothing at all would
      // make "every produced id is in history" vacuously satisfiable.
      assert.ok(reading.seed.ids.length > 0, 'the seed wrote at least one message row');
      assert.deepEqual(
        reading.coverage.seedIdsMissingFromHistory,
        [],
        'the history leg must read the seeded rows as well, or it is not reading this transcript',
      );

      // ---- AC1(d): seq comes from the run registry, and is strictly increasing ----
      assert.equal(reading.seqs.length, reading.frames.length, 'every frame carries a seq');
      assert.equal(firstNonIncreasing(reading.seqs), null, `seq must strictly increase: ${JSON.stringify(reading.seqs)}`);
      assert.equal(reading.seqs[0], 1, 'the run registry starts a run at seq 1');
      assert.equal(reading.frames.at(-1)?.seq, reading.seqs.length, 'seq numbers are contiguous for this run');

      assert.deepEqual(reading.evaluation.failures, [], 'the scenario met its own expectations');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the runtime id resolves while the gate is open, and never joins the union', () => {
    const { reading: open, scratch: openScratch } = runChild<RegistryReading>('gate-open');
    const { reading: closed, scratch: closedScratch } = runChild<RegistryReading>('gate-closed');

    try {
      console.log(`--- gate open ---\n${describeRegistry(open)}`);
      console.log(`--- gate closed ---\n${describeRegistry(closed)}`);

      // The open arm reads the REAL provider — the one the registry built and
      // registered itself — not a stand-in registered by the test.
      assert.equal(open.gate.enabled, true, 'the open arm must have the gate open');
      assert.equal(open.debug.ok, true, `resolveProvider('${DEBUG_AGENT_PROVIDER_ID}') must succeed while the gate is open`);
      assert.ok(
        open.providerIds.includes(DEBUG_AGENT_PROVIDER_ID),
        `listProviders() must include the runtime id, got ${JSON.stringify(open.providerIds)}`,
      );
      assert.equal(open.typo.ok, false, 'the typo control must still fail while the gate is open');

      // The closed arm: the key was never written, so the id fails exactly as a
      // typo does — same class, code, status, and a message that differs only by
      // the id that was asked for.
      assert.equal(closed.gate.enabled, false, 'the closed arm must have the gate closed');
      assert.equal(closed.debug.ok, false, 'the runtime id must not resolve while the gate is closed');
      assert.equal(closed.typo.ok, false, 'the typo control must fail');
      assert.equal(
        closed.providerIds.includes(DEBUG_AGENT_PROVIDER_ID),
        false,
        `listProviders() must not carry the runtime id, got ${JSON.stringify(closed.providerIds)}`,
      );

      const debugFailure = closed.debug as { ok: false } & FailureReading;
      const typoFailure = closed.typo as { ok: false } & FailureReading;
      assert.equal(debugFailure.errorName, typoFailure.errorName, 'a closed gate must fail like a typo (error class)');
      assert.equal(debugFailure.code, typoFailure.code, 'a closed gate must fail like a typo (code)');
      assert.equal(debugFailure.statusCode, typoFailure.statusCode, 'a closed gate must fail like a typo (status)');
      assert.equal(
        closed.debugNormalized,
        closed.typoNormalized,
        'the failure message must be identical once the requested id is blanked out',
      );

      // The false form of this criterion: adding the id to the union would make
      // "it resolves" true by construction for every gate state.
      const unionLine = fs
        .readFileSync(TYPES_MODULE, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('export type LLMProvider ='));
      console.log(`[union] ${TYPES_MODULE}: ${unionLine ?? '<line not found>'}`);
      assert.equal(unionLine, PROVIDER_UNION_LINE, 'the provider union must not have gained a member');
    } finally {
      rmSync(openScratch, { recursive: true, force: true });
      rmSync(closedScratch, { recursive: true, force: true });
    }
  });

  /**
   * The turn-phase steps, driven through the product's own row → frame edge.
   *
   * This is the fast, server-side half of AC-187's chain: the runtime builders
   * above write the rows a phase is reduced from, `forwardNormalizedFrames` is
   * the one seam both the real run loop and the debug agent use, and the phase
   * the dock later speaks for is read back with the same accessor the activity
   * frames use. No child process and no database: the reduction is pure, so the
   * reading is the reduction's own.
   */
  test('the phase steps drive a session through thinking, tool, writing and idle', () => {
    const provider = providerRegistry.resolveProvider('claude');
    const normalizeMessage = provider.sessions.normalizeMessage.bind(provider.sessions);
    const sessionId = `phase-probe-${process.pid}`;
    const cwd = '/tmp/phase-probe';
    const timestamp = new Date().toISOString();
    const toolUseId = 'phase-probe-tool';
    const sent: unknown[] = [];
    const writer = {
      send: (message: unknown) => {
        sent.push(message);
      },
    } as unknown as ProviderRuntimeWriter;

    const feed = (row: AnyRecord): void => {
      forwardNormalizedFrames({ transformedMessage: row, sessionId, normalizeMessage, writer });
    };
    const phase = () => readSessionTurn(sessionId);

    assert.equal(phase().phase, 'idle', 'a session the forwarder has not seen reads idle');

    feed(buildThinkingTokensRow({ sessionId, cwd, timestamp, uuid: 'p1', parentUuid: null }));
    assert.equal(phase().phase, 'thinking', 'a thinking-token estimate is the thinking phase');

    feed(buildToolUseRow({ sessionId, cwd, timestamp, uuid: 'p2', parentUuid: null, toolUseId, name: 'Bash' }));
    assert.equal(phase().phase, 'tool', 'a pending tool call is the tool phase');
    assert.equal(phase().toolName, 'Bash', 'the tool phase names the tool the row carried');

    feed(buildToolResultRow({ sessionId, cwd, timestamp, uuid: 'p3', parentUuid: null, toolUseId, text: 'done' }));
    feed(buildTextDeltaRow({ sessionId, cwd, timestamp, uuid: 'p4', parentUuid: null, text: 'writing' }));
    assert.equal(phase().phase, 'writing', 'the paired result leaves the tool phase, and a text delta is writing');
    assert.equal(phase().toolName, null, 'no tool remains pending once its result has arrived');

    feed(buildTurnResultRow({ sessionId, cwd, timestamp, uuid: 'p5', parentUuid: null }));
    assert.equal(phase().phase, 'idle', 'the turn record returns the session to idle');

    assert.ok(
      sent.length >= 3,
      `the phase rows must reach the writer as frames (got ${sent.length})`,
    );
  });
}
