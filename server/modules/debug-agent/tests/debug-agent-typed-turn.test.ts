import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDatabase } from '@/modules/database/index.js';
import {
  ClaudeSessionSynchronizer,
  forwardNormalizedFrames,
  providerRegistry,
  providerRuntimeService,
  sessionsService,
} from '@/modules/providers/index.js';
import { chatRunRegistry, handleChatConnection } from '@/modules/websocket/index.js';
import type { AnyRecord, LLMProvider, ProviderRuntimeWriter } from '@/shared/types.js';

import {
  armDebugAgentScenario,
  DEBUG_AGENT_PROVIDER_ID,
  evaluateScenarioExpectations,
  readDebugAgentGate,
  type DebugAgentRunReading,
  type DebugAgentScenario,
  type DebugAgentScenarioEvaluation,
} from '../index.js';
import { releaseDebugAgentRun, runDebugAgentScenario } from '../debug-agent.engine.js';
import { buildMessageRow, readTranscriptRows, writeTranscript } from '../debug-agent.runtime.js';

/**
 * The criterion for a typed turn: the prompt a person sends through the chat
 * transport must become a row in the transcript, and the REST read must return
 * it.
 *
 * Why the frames criterion does not cover this. `debug-agent-frames.test.ts`
 * (AC-124) drives the armed scenario through `POST /api/debug-agent/clock`, which
 * replays the scenario's own steps. Every row that arm sees is one the document
 * asked for — the seed's, or a step's. A prompt somebody *typed* arrives by a
 * different road: the chat transport's dispatch, carrying the text as the turn's
 * command. No step of any scenario has seen it, so the walk a typed turn starts
 * writes the assistant's answer and nothing else, and the user's own sentence is
 * never recorded. A build with that hole shows a live conversation that loses the
 * user's sentences at the next reload, and every existing criterion stays green
 * because none of them takes the typed road.
 *
 * Why the arm drives the socket handler rather than the runtime dispatcher. A
 * dispatch built by hand would have to reproduce the transport's options bag, and
 * the field this criterion turns on — the flag saying "this command is a message
 * somebody composed" — lives in that bag. A criterion that set the flag itself
 * would stay green on a build whose transport had stopped setting it, which is
 * the whole failure being measured. So the arm opens a fake socket and sends
 * `chat.send` through `handleChatConnection`, the same handler the websocket
 * server calls for a browser: the options bag, the run registration and the
 * dispatch are the product's, and nothing here restates them.
 *
 * What the two legs measure, and why both. The transcript leg is the artifact: a
 * row of `role: 'user'` whose text is what was sent, on disk under the fixture
 * root. The REST leg is the reader — `GET /api/providers/sessions/:id/messages`
 * reads those rows back through the product's own history service, which is what
 * a reload does. A build that forwarded the prompt as a frame without writing it
 * satisfies neither, and that is the false form this file runs as its own second
 * case rather than asserting about in prose.
 *
 * Why one child process per arm. The gate is evaluated once per process, the run
 * path opens the process's database, and the fixture home is a per-run scratch
 * directory, so a child per arm is the only way to take a reading without the
 * previous arm's state in it.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: the gate criterion asserts that, outside the gate module,
// `server/` contains no direct read of it, and this file must pass that check.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_TYPED_TURN_PROBE';
const MODE_VAR = 'DEBUG_AGENT_TYPED_TURN_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_TYPED_TURN_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/** The module the falsifying arm copies, and the directory its copies live in. */
const PROVIDER_MODULE = path.join(TEST_DIR, '..', 'debug-agent.provider.ts');
const MODULE_DIR = path.dirname(PROVIDER_MODULE);

/** The repository-relative path this file must be, so the criterion cannot become a glob. */
const SELF_RELATIVE_PATH = 'server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts';

/**
 * The prefix every temp copy carries.
 *
 * The name is load-bearing in two places: `server/tsconfig.json` excludes
 * `./**\/__criterion-falsify-*` from the program, so a copy written and removed
 * inside one test case cannot make a concurrently-running `npm run typecheck`
 * fail with `TS6053: File ... not found`; and the module directory is shared, so
 * the prefix is also what tells a copy apart from product source.
 */
const TEMP_PREFIX = '__criterion-falsify-typed-turn-';

/**
 * The flag the chat transport stamps on a turn whose `command` is a message
 * somebody composed — the value of `CHAT_TURN_OPTION` in `@/shared/types.ts`.
 *
 * Spelled rather than imported, and deliberately: this file has to LOAD against
 * a build that has not added the flag yet, or the red the criterion is supposed
 * to show on that build would be a module-resolution error rather than the
 * assertion below it (with the row-type sequence a reader needs). The false-form
 * arm's own control covers the cost of the duplication: if the key is ever
 * renamed without this line, the mutant writes nothing to forward and "the
 * prompt must still reach the wire" fails loudly instead of passing quietly.
 */
const TURN_FLAG = 'chatTurn';

/** The prompt this arm sends. Distinctive enough that a hit cannot be a seed row. */
const TYPED_TEXT = 'TYPED-TURN-MARKER: please summarise the migration guide';

/** The seed text, so a reading can tell "the prompt landed" from "the seed did". */
const SEED_TEXT = 'please summarise the release notes';

/** The assistant text the walk writes — the positive control that the run really ran. */
const WALK_TEXT = 'the migration guide covers two releases';

/**
 * What the control plane's own drive puts in `command`.
 *
 * The control reading below dispatches through the same runtime entry with this
 * label and no turn flag, which is exactly the shape `POST /api/debug-agent/clock`
 * takes. Nothing that reaches the transcript may carry it.
 */
const WALK_LABEL = 'debug agent control plane';

/**
 * The scenario one arm drives: one assistant row and a pause.
 *
 * No host step, deliberately. The walk a typed turn starts is not what this
 * criterion is about, and a host step would make the reading depend on a process
 * being bound. What matters is that the walk writes rows of its own, so a build
 * that recorded the prompt shows it *in addition* to the scenario's output rather
 * than instead of it.
 */
const SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: 'debug agent typed turn fixture', userText: SEED_TEXT },
  steps: [
    { at: 0, op: 'row', role: 'assistant', text: WALK_TEXT },
    { at: 20, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [WALK_TEXT] } },
};

type ChildMode = 'typed' | 'frames-only';

/** One transcript row, trimmed to the fields the readings below use. */
type RowReading = { type: string; text: string; uuid: string | null; hasOrigin: boolean };

/** One frame as it reached the socket, trimmed to what the readings below use. */
type FrameReading = { kind: string; id: string | null; seq: number | null; contentText: string | null };

type TypedTurnReading = {
  gate: { enabled: boolean; home: string | null; reason: string };
  mode: string;
  transcript: {
    path: string;
    /** Rows the seed wrote, re-measured rather than taken from the run's report. */
    rowsBefore: number;
    /** Rows on disk after the typed dispatch, before the control one. */
    rowsAfterTyped: number;
    /** Rows on disk at the end of the arm. */
    rowsAfter: number;
    /** Every row's `type`, in file order at the end of the arm — what a red has to show. */
    sequence: string[];
    /** The rows the control dispatch added, as `type:text`. */
    controlRows: string[];
    /** The assistant text the walk wrote, so a red cannot be "nothing ran". */
    walkTextPresent: boolean;
    /** Every row on disk at the end, as `type:text`. */
    text: string;
  };
  /** Rows whose text is exactly the prompt this arm sent, as read off disk. */
  typedRows: RowReading[];
  /** The normalized message ids of those rows. */
  typedRowIds: string[];
  /** Rows whose text is the control plane's label: must be none. */
  labelledRows: RowReading[];
  frames: FrameReading[];
  /** Frames carrying a message. The run's end marker carries an id but no content. */
  frameIds: string[];
  /** Frames whose content is the prompt: what a frames-only build leaves behind. */
  typedFrames: { id: string | null; seq: number | null }[];
  history: { count: number; total: number; ids: string[] };
  coverage: {
    /** The prompt's message ids that the REST read does not contain. */
    typedMissingFromHistory: string[];
    /** The prompt's message ids that no frame carried. */
    typedMissingFromFrames: string[];
    /** Ids a frame carried that the REST read does not contain. */
    framesNotInHistory: string[];
    /** Ids the prompt's own frames carried that the REST read does not contain. */
    typedFramesMissingFromHistory: string[];
  };
  evaluation: DebugAgentScenarioEvaluation;
  run: DebugAgentRunReading;
  /** Where the falsifying arm's copies went, so the parent can clean them up too. */
  tempFiles: string[];
  /** What the falsifying arm's mutation did to the copy, as a reading. */
  mutation: { source: string; applied: boolean; detail: string } | null;
};

// --------------------------- child process ---------------------------

/**
 * Writes the falsifying arm's two copies and returns their paths plus a reading.
 *
 * The form is `frames-only`: the row a typed turn's prompt becomes is built and
 * forwarded, and never appended. It is produced by mutating the SHIPPING source
 * rather than by writing a second implementation — `debug-agent.provider.ts` is
 * copied with one token changed (its runtime import re-pointed at a wrapper
 * beside it), and the wrapper re-exports the real runtime while replacing
 * `appendTypedTurnRow` with a build-only version. Everything else in the copied
 * provider is byte-identical to what ships, so the only difference between the
 * two arms is the missing write.
 *
 * `export *` rather than a second runtime is what keeps the arm honest: the
 * armed-scenario map, the row builder and the transcript readers all still come
 * from the ONE real runtime module, so the mutant is the same program with a
 * write removed rather than a program that resembles it.
 */
function writeFramesOnlyVariant(): {
  provider: string;
  wrapper: string;
  mutation: TypedTurnReading['mutation'];
} {
  const stem = `${TEMP_PREFIX}${process.pid}`;
  const wrapper = path.join(MODULE_DIR, `${stem}-runtime.ts`);
  const provider = path.join(MODULE_DIR, `${stem}-provider.ts`);

  writeFileSync(
    wrapper,
    [
      `import { randomUUID } from 'node:crypto';`,
      ``,
      `import { buildMessageRow, readTranscriptShape } from './debug-agent.runtime.js';`,
      ``,
      `export * from './debug-agent.runtime.js';`,
      ``,
      `/** frames-only: builds the row a typed turn becomes and never writes it. */`,
      `export function appendTypedTurnRow(input: {`,
      `  transcriptPath: string;`,
      `  sessionId: string;`,
      `  cwd: string;`,
      `  text: string;`,
      `}): Record<string, unknown> | null {`,
      `  if (input.text.trim().length === 0) {`,
      `    return null;`,
      `  }`,
      ``,
      `  const parent = readTranscriptShape(input.transcriptPath).lastRow;`,
      `  return buildMessageRow({`,
      `    sessionId: input.sessionId,`,
      `    cwd: input.cwd,`,
      `    role: 'user',`,
      `    text: input.text,`,
      `    uuid: randomUUID(),`,
      `    parentUuid: typeof parent?.uuid === 'string' ? parent.uuid : null,`,
      `    timestamp: new Date().toISOString(),`,
      `  });`,
      `}`,
      ``,
    ].join('\n'),
    'utf8',
  );

  const source = readFileSync(PROVIDER_MODULE, 'utf8');
  const from = `from './debug-agent.runtime.js';`;
  const to = `from './${stem}-runtime.js';`;
  const hits = source.split(from).length - 1;
  const mutated = source.replace(from, to);
  writeFileSync(provider, mutated, 'utf8');

  return {
    provider,
    wrapper,
    mutation: {
      source: PROVIDER_MODULE,
      applied: hits === 1 && mutated !== source,
      detail: `re-pointed ${hits} runtime import(s) at ${path.basename(wrapper)}, which re-exports the real runtime with a build-only appendTypedTurnRow`,
    },
  };
}

/** One transcript row, as this file reads it. */
function readRow(raw: AnyRecord): RowReading {
  const message = (raw.message ?? {}) as { content?: { text?: unknown }[] };
  const first = Array.isArray(message.content) ? message.content[0] : undefined;
  return {
    type: typeof raw.type === 'string' ? raw.type : '<none>',
    text: typeof first?.text === 'string' ? first.text : '',
    uuid: typeof raw.uuid === 'string' ? raw.uuid : null,
    hasOrigin: raw.origin !== undefined,
  };
}

/** One frame, as this file reads it. */
function readFrame(frame: AnyRecord): FrameReading {
  return {
    kind: typeof frame.kind === 'string' ? frame.kind : '<none>',
    id: typeof frame.id === 'string' ? frame.id : null,
    seq: typeof frame.seq === 'number' ? frame.seq : null,
    contentText: typeof frame.content === 'string' ? frame.content : null,
  };
}

/**
 * The dependencies the registry gives the shipping provider, handed to the
 * falsifying arm's copy so the two programs differ only in the mutated line.
 */
function providerDependencies() {
  return {
    base: providerRegistry.resolveProvider('claude'),
    forwardFrames: forwardNormalizedFrames,
    createSessionSynchronizer: (options: { home: string; providerId: string }) =>
      new ClaudeSessionSynchronizer(options),
  };
}

/**
 * Opens a fake chat socket and sends one `chat.send` through the real handler.
 *
 * The socket is the smallest thing `handleChatConnection` uses — `on(message)`,
 * `on(close)`, `readyState` and `send` — so the transport runs its own code path
 * with no HTTP server and no browser in the loop. What that buys is that the
 * options bag, the run registration and the dispatch below are the product's:
 * nothing in this file restates what the transport puts on a turn.
 */
async function sendOverChatSocket(input: {
  sessionId: string;
  content: string;
  frames: FrameReading[];
}): Promise<void> {
  let messageHandler: ((raw: unknown) => Promise<void>) | null = null;

  const socket = {
    readyState: 1,
    send(data: string): void {
      input.frames.push(readFrame(JSON.parse(data) as AnyRecord));
    },
    on(event: string, handler: (raw: unknown) => Promise<void>): void {
      if (event === 'message') {
        messageHandler = handler;
      }
    },
  };

  handleChatConnection(
    socket as unknown as Parameters<typeof handleChatConnection>[0],
    { user: { id: 'typed-turn-criterion' } } as unknown as Parameters<typeof handleChatConnection>[1],
    { runtime: providerRuntimeService } as unknown as Parameters<typeof handleChatConnection>[2],
  );

  assert.ok(messageHandler, 'the socket handler must register a message listener');

  await (messageHandler as (raw: unknown) => Promise<void>)(
    JSON.stringify({
      type: 'chat.send',
      sessionId: input.sessionId,
      content: input.content,
      options: { attachments: [] },
    }),
  );
}

async function readTypedTurn(mode: ChildMode): Promise<TypedTurnReading> {
  await initializeDatabase();

  const fixtureHome = process.env[GATE_HOME_VAR] ?? '';
  const provider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);

  const armed = await armDebugAgentScenario({
    projectPath: path.join(fixtureHome, 'workspace'),
    scenario: SCENARIO,
    synchronizeTranscript: (filePath) => provider.sessionSynchronizer.synchronizeFile(filePath),
  });

  const frames: FrameReading[] = [];
  const tempFiles: string[] = [];
  let mutation: TypedTurnReading['mutation'] = null;
  let outcome: unknown = null;

  /** Every row on disk right now, as this file reads it. */
  const snapshot = (): RowReading[] => readTranscriptRows(armed.transcriptPath).map(readRow);
  let rowsAfterTyped = snapshot();

  try {
    if (mode === 'frames-only') {
      const variant = writeFramesOnlyVariant();
      tempFiles.push(variant.provider, variant.wrapper);
      mutation = variant.mutation;

      // The mutant is built here rather than resolved from the registry: the
      // registry holds the shipping provider under the runtime id, and this
      // arm's whole point is to read a program with one line missing. It is
      // given the same three dependencies the registry gives the real one, and
      // the same turn flag the transport sets — so the only thing it lacks is
      // the write.
      const mutantModule = (await import(variant.provider)) as typeof import('../debug-agent.provider.js');
      const mutant = mutantModule.createDebugAgentProvider(providerDependencies());
      assert.ok(mutant, 'the frames-only copy must build a provider while the gate is open');

      const run = chatRunRegistry.startRun({
        appSessionId: armed.sessionId,
        provider: DEBUG_AGENT_PROVIDER_ID as LLMProvider,
        providerSessionId: armed.providerSessionId,
        connection: {
          readyState: 1,
          send(data: string): void {
            frames.push(readFrame(JSON.parse(data) as AnyRecord));
          },
        } as never,
        userId: null,
      });
      assert.ok(run, 'the run registry refused to start a run for the armed session');

      outcome = await mutant.runtime.run(
        TYPED_TEXT,
        {
          sessionId: armed.sessionId,
          cwd: armed.projectPath,
          projectPath: armed.projectPath,
          [TURN_FLAG]: true,
        },
        run.writer,
        {
          resolveProviderSessionId: () => armed.providerSessionId,
          resolveResumeModel: async () => undefined,
          getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }),
          normalizeMessage: (raw, sessionId) => mutant.sessions.normalizeMessage(raw, sessionId),
          isProviderInstalled: async () => true,
        },
      );
    } else {
      // The typed road: a `chat.send` frame through the transport's own socket
      // handler, which builds the options bag, registers the run and dispatches.
      await sendOverChatSocket({ sessionId: armed.sessionId, content: TYPED_TEXT, frames });
      rowsAfterTyped = snapshot();

      // The control reading, and the half AC-124 depends on: the very same
      // runtime entry, dispatched the way the control plane's clock advance
      // dispatches it — a label in `command` and no turn flag. Nothing it writes
      // may be a user row carrying that label.
      await providerRuntimeService.run(
        DEBUG_AGENT_PROVIDER_ID as LLMProvider,
        WALK_LABEL,
        { sessionId: armed.sessionId, cwd: armed.projectPath, projectPath: armed.projectPath },
        { send: (): void => {} } as ProviderRuntimeWriter,
      );
    }
  } finally {
    for (const file of tempFiles) {
      rmSync(file, { force: true });
    }
  }

  // The history leg, driven the way the frontend drives it after a `complete`:
  // `GET /api/providers/sessions/:id/messages` parses the query, calls exactly
  // this service method, and wraps the result in an envelope. The router itself
  // is not reachable from this module — the providers barrel does not export it,
  // and reaching into its file would cross the module boundary the backend
  // standards draw — so the leg starts one hop below HTTP, at the call the route
  // handler makes. `limit: null` and `offset: 0` are what a request with neither
  // query parameter resolves to.
  const history = await sessionsService.fetchHistory(armed.sessionId, { limit: null, offset: 0 });

  // Read whole, and filtered on the raw rows: the prompt's message ids come from
  // normalizing the very rows that are on disk, so "the row exists" and "the id
  // exists" cannot drift into two different readings.
  const rawRows = readTranscriptRows(armed.transcriptPath);
  const rows = rawRows.map(readRow);
  const typedRawRows = rawRows.filter((raw) => readRow(raw).text === TYPED_TEXT);
  // The control dispatch's own rows: everything on disk past the typed turn's
  // snapshot. Kept as its own segment so "the label was not recorded" is a
  // reading about that dispatch rather than about the file as a whole.
  const controlRows = rows
    .slice(rowsAfterTyped.length)
    .map((row) => `${row.type}:${row.text}`);
  const typedRows = typedRawRows.map(readRow);
  const typedRowIds = typedRawRows.flatMap((raw) =>
    provider.sessions
      .normalizeMessage(raw, armed.providerSessionId)
      .map((message) => message.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );

  // A produced message reaches the socket as a frame carrying that message's
  // content. The run's end marker also carries an id, but no message: it names
  // the end of the run rather than a row, so it is counted separately rather than
  // filtered out silently.
  const messageFrames = frames.filter(({ id, contentText }) => id !== null && contentText !== null);
  const frameIds = [...new Set(messageFrames.map(({ id }) => id as string))];
  const typedFrames = frames
    .filter(({ contentText }) => contentText === TYPED_TEXT)
    .map(({ id, seq }) => ({ id, seq }));
  const historyIds = history.messages
    .map(({ id }) => id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  const dispatched = outcome as
    | { reading: DebugAgentRunReading; evaluation: DebugAgentScenarioEvaluation }
    | null;

  return {
    gate: readDebugAgentGate(),
    mode,
    transcript: {
      path: armed.transcriptPath,
      rowsBefore: armed.seedRows,
      rowsAfterTyped: rowsAfterTyped.length,
      rowsAfter: rows.length,
      sequence: rows.map((row) => row.type),
      controlRows,
      walkTextPresent: rows.some((row) => row.text === WALK_TEXT),
      text: rows.map((row) => `${row.type}:${row.text}`).join('\n'),
    },
    typedRows,
    typedRowIds,
    labelledRows: rows.filter((row) => row.text === WALK_LABEL),
    frames,
    frameIds,
    typedFrames,
    history: { count: history.messages.length, total: history.total, ids: historyIds },
    coverage: {
      typedMissingFromHistory: typedRowIds.filter((id) => !historyIds.includes(id)),
      typedMissingFromFrames: typedRowIds.filter((id) => !frameIds.includes(id)),
      framesNotInHistory: frameIds.filter((id) => !historyIds.includes(id)),
      typedFramesMissingFromHistory: typedFrames
        .map(({ id }) => id)
        .filter((id): id is string => id !== null && !historyIds.includes(id)),
    },
    evaluation: dispatched?.evaluation ?? {
      rows: 0,
      rowsDelta: 0,
      lastRowBytes: 0,
      missingContent: [],
      grows: [],
      lastRowGrew: false,
      failures: [],
    },
    run: dispatched?.reading ?? { before: { rows: 0, lastRowBytes: 0, lastRow: null }, steps: [] },
    tempFiles,
    mutation,
  };
}

// --------------------------- parent process ---------------------------

type ChildRun = { reading: TypedTurnReading; scratch: string };

/**
 * Runs one child in one mode. `HOME` is redirected into a scratch directory for
 * every mode, and `DATABASE_PATH` points inside it, so no arm can reach the
 * machine's real `~/.claude` or its real database.
 */
function runChild(mode: ChildMode): ChildRun {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-typed-turn-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'typed-turn.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
    [GATE_VAR]: 'on',
    [GATE_HOME_VAR]: fixtureHome,
  };

  let stdout = '';
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
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`probe child (${mode}) exited non-zero.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }

  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(PROBE_MARKER))
    .pop();

  assert.ok(line, `probe child (${mode}) printed no reading; stdout was:\n${stdout}\n--- stderr ---\n${stderr}`);
  const reading = JSON.parse(line.slice(PROBE_MARKER.length)) as TypedTurnReading;

  // The child removes its own copies; this is the second half of that, for the
  // case where it was killed before its `finally` ran. A leftover copy would be
  // untracked product source in a shared directory, so it is removed rather than
  // merely reported.
  for (const file of reading.tempFiles) {
    rmSync(file, { force: true });
  }

  return { reading, scratch };
}

function describeTypedTurn(reading: TypedTurnReading): string {
  return [
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); home=${reading.gate.home ?? '<none>'}`,
    `[mode] ${reading.mode}${reading.mutation ? ` — mutation applied=${reading.mutation.applied}: ${reading.mutation.detail}` : ''}`,
    `[AC1 rows] file ${reading.transcript.rowsBefore} -> ${reading.transcript.rowsAfter} rows; row-type sequence ${JSON.stringify(reading.transcript.sequence)}; walk text on disk=${reading.transcript.walkTextPresent}`,
    `[AC1 typed] ${reading.typedRows.length} row(s) carry the sent text; ids ${JSON.stringify(reading.typedRowIds)}; rows ${JSON.stringify(reading.typedRows)}`,
    `[control walk] rows carrying the control plane's label ${JSON.stringify(reading.labelledRows)}; scenario walk failures ${JSON.stringify(reading.evaluation.failures)}`,
    `[AC2 rest] history ${JSON.stringify(reading.history.ids)} (${reading.history.count} message(s), total ${reading.history.total}); typed ids missing from history ${JSON.stringify(reading.coverage.typedMissingFromHistory)}`,
    `[AC2 frames] message frames ${JSON.stringify(reading.frameIds)}; frames carrying the sent text ${JSON.stringify(reading.typedFrames)}; typed ids missing from frames ${JSON.stringify(reading.coverage.typedMissingFromFrames)}; frames not in history ${JSON.stringify(reading.coverage.framesNotInHistory)}`,
    `[artifact] ${reading.transcript.text}`,
  ].join('\n');
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the reading for this mode, print one line, exit.
  const mode = process.env[MODE_VAR];
  if (mode !== 'typed' && mode !== 'frames-only') {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  const reading = await readTypedTurn(mode);
  console.log(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  registerCriteria();
}

function registerCriteria(): void {
  test('a typed turn writes its prompt into the transcript, and the REST read returns it', () => {
    const { reading, scratch } = runChild('typed');

    try {
      console.log(describeTypedTurn(reading));

      assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');

      // ---- The walk ran, so a missing prompt cannot be "nothing happened" ----
      assert.equal(
        reading.transcript.walkTextPresent,
        true,
        `回放缺失: the scenario's own row is not on disk, so this arm measured nothing; row-type sequence was ${JSON.stringify(reading.transcript.sequence)}`,
      );

      // ---- AC1: the prompt is a row on disk, with the text that was sent ----
      assert.equal(
        reading.typedRows.length,
        1,
        `用户打字不落行: the transcript holds ${reading.typedRows.length} row(s) whose text is the sent prompt; the arm's row-type sequence was ${JSON.stringify(reading.transcript.sequence)}; rows were ${JSON.stringify(reading.transcript.text)}`,
      );
      const [typedRow] = reading.typedRows;
      assert.equal(typedRow.type, 'user', 'the prompt must land as a `user` row');
      assert.equal(typedRow.text, TYPED_TEXT, 'the row must carry the text that was sent, not a paraphrase of it');
      assert.ok(typedRow.uuid, 'the row must carry a uuid, or nothing downstream can address it');
      // The one field that tells a typed row apart from a row the host layer
      // opened: a person typed this one, so there is no cause to state.
      assert.equal(
        typedRow.hasOrigin,
        false,
        'a typed turn states no origin; the field is the cause of a turn nobody typed',
      );

      // ---- AC2: the REST read returns that row ----
      assert.ok(reading.typedRowIds.length > 0, 'the typed row must normalize to a message id');
      assert.deepEqual(
        reading.coverage.typedMissingFromHistory,
        [],
        `REST 缺打字行: the history read does not contain the prompt's message id(s); typed ids ${JSON.stringify(reading.typedRowIds)} vs history ids ${JSON.stringify(reading.history.ids)}; the difference is ${JSON.stringify(reading.coverage.typedMissingFromHistory)}`,
      );

      // The wire leg. A row that reached only the disk would show a client a
      // conversation that changes under it at the next reload, so the prompt's
      // own row must be one of the messages the socket saw.
      assert.deepEqual(
        reading.coverage.typedMissingFromFrames,
        [],
        `实时缺打字行: no frame carried the prompt's message id; typed ids ${JSON.stringify(reading.typedRowIds)} vs frame ids ${JSON.stringify(reading.frameIds)}`,
      );
      assert.deepEqual(
        reading.coverage.framesNotInHistory,
        [],
        `历史缺消息: a frame reached the socket that the REST read does not contain ${JSON.stringify(reading.coverage.framesNotInHistory)}`,
      );

      // ---- The control reading: a driver's label is not a message ----
      //
      // The arm also drove the same session through the same runtime entry with
      // the control plane's shape — a label in `command`, no turn flag — and
      // nothing from it may be recorded as a message. Without this the criterion
      // would be satisfied by a build that recorded every dispatch's command as
      // if somebody had sent it, which is the reading AC-124's `/clock` arm
      // exists to prevent.
      assert.deepEqual(
        reading.labelledRows,
        [],
        `控制面标签被当成消息: a dispatch whose command is the control plane's label was recorded as a message: ${JSON.stringify(reading.labelledRows)}`,
      );
      assert.deepEqual(
        reading.transcript.controlRows,
        [`assistant:${WALK_TEXT}`],
        `the control dispatch must write exactly the rows its scenario asks for (${SCENARIO.expect.rows.delta}) and nothing else, so its command was not recorded as a row; it wrote ${JSON.stringify(reading.transcript.controlRows)}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /**
   * The false form, run rather than asserted about: a build that forwards the
   * prompt and never writes it.
   *
   * Both readings above have to fail here, and this case is what makes the green
   * above mean something. The mutation is one token of the shipping provider
   * (`debug-agent.provider.ts`) — its runtime import re-pointed at a wrapper that
   * re-exports the real runtime with a build-only `appendTypedTurnRow`. So the
   * only difference between the two arms is the missing write.
   *
   * The reading that carries this case is `typedFramesMissingFromHistory`: the
   * prompt reached the socket, so a client would have drawn it, and the REST read
   * that a reload performs does not contain it. That is the divergence itself,
   * measured on one run, and it is what the shipping build must not produce.
   */
  test('the frames-only form — forward the prompt, write nothing — fails both readings', () => {
    const { reading, scratch } = runChild('frames-only');

    try {
      console.log(describeTypedTurn(reading));

      assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');
      assert.ok(reading.mutation, 'the falsifying arm must record how it mutated the copy');
      assert.equal(
        reading.mutation.applied,
        true,
        `the mutation did not apply, so this arm read the shipping build and proves nothing: ${JSON.stringify(reading.mutation)}`,
      );

      // The positive control that keeps the two reds below from being "the arm
      // did nothing at all": the walk ran, so the program really executed.
      assert.equal(
        reading.transcript.walkTextPresent,
        true,
        `回放缺失: the scenario's own row is not on disk, so the mutant never ran; row-type sequence was ${JSON.stringify(reading.transcript.sequence)}`,
      );

      // AC1 fails on this form: the prompt is not a row on disk.
      assert.equal(
        reading.typedRows.length,
        0,
        `this form must not write the prompt, but ${reading.typedRows.length} row(s) carry it; row-type sequence was ${JSON.stringify(reading.transcript.sequence)}`,
      );

      // AC2 fails on this form: the prompt reached the socket and the REST read
      // has no counterpart for it. Both halves are asserted, because either one
      // alone would be satisfied by an arm that did nothing.
      assert.ok(
        reading.typedFrames.length > 0,
        `the false form must still put the prompt on the wire, or it is testing an arm that sent nothing: frames ${JSON.stringify(reading.frames)}`,
      );
      assert.ok(
        reading.coverage.typedFramesMissingFromHistory.length > 0,
        `REST 缺打字行: this form's prompt frames are all present in history (${JSON.stringify(reading.coverage.typedFramesMissingFromHistory)}), so the reading above would not have caught it`,
      );
      assert.equal(
        reading.coverage.typedFramesMissingFromHistory.length,
        reading.typedFrames.filter(({ id }) => id !== null).length,
        'every prompt frame this form sent must be absent from the REST read: the divergence is the whole point of the false form',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /**
   * The file that runs must be the file the criterion names.
   *
   * The command names one path rather than a glob, because a glob that matches
   * nothing makes `node --test` exit 0 — a green that a deleted criterion would
   * also produce. This reading pins the other half of that: the module the runner
   * loaded is the one at that path, so a rename cannot leave the criterion
   * pointing at a file that no longer exists while some other file answers.
   */
  test('the file that ran is the path the criterion names', () => {
    assert.equal(
      SELF,
      path.join(REPO_ROOT, SELF_RELATIVE_PATH),
      'the running module must be the file the criterion command names',
    );
  });

  /**
   * The `await-release` step, read on the artifact rather than on the walk's word.
   *
   * The step exists so a criterion can say "the events behind this point fire once
   * my own reading window has closed" instead of trusting a fixed clock offset that
   * a loaded host outruns. What has to hold for that is exactly two things, and
   * both are read off the file: the walk STOPS at the barrier — the row behind it
   * is not on disk while the step is un-released, no matter how long the caller
   * waits — and it GOES ON once the release is stated. A build where the step were
   * a no-op would pass the second reading alone, which is why the first one is
   * taken first, and why the assertion after the release is a row count and not the
   * run's own verdict.
   *
   * Driven directly, with no gate and no database: `runDebugAgentScenario` walks a
   * transcript file and nothing else, so the reading needs neither, and keeping it
   * out of a child process keeps it fast enough to run beside the socket arms.
   */
  test('an await-release step holds the walk until the release is stated, and then lets it go', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'debug-agent-release-barrier-'));
    const transcriptPath = path.join(scratch, 'walk.jsonl');
    const sessionId = 'release-barrier-provider-session';
    const appSessionId = 'release-barrier-app-session';
    const timestamp = new Date().toISOString();

    try {
      writeTranscript(transcriptPath, [
        buildMessageRow({
          sessionId,
          cwd: scratch,
          role: 'user',
          text: 'seed row the walk chains onto',
          uuid: randomUUID(),
          parentUuid: null,
          timestamp,
        }),
      ]);
      const seedRows = readTranscriptRows(transcriptPath).length;

      const scenario: DebugAgentScenario = {
        version: 1,
        dialect: 'claude',
        home: 'gate',
        transcript: { mode: 'per-row-jsonl' },
        seed: { title: 'release barrier fixture', userText: 'seed row the walk chains onto' },
        steps: [
          { at: 0, op: 'row', role: 'assistant', text: 'the row in front of the barrier' },
          { at: 10, op: 'await-release' },
          { at: 20, op: 'row', role: 'assistant', text: 'the row behind the barrier' },
        ],
        expect: { rows: { delta: 2 }, content: { mustContain: ['the row behind the barrier'] } },
      };

      const walk = runDebugAgentScenario({
        scenario,
        sessionId,
        appSessionId,
        cwd: scratch,
        transcriptPath,
        writer: { send: () => undefined },
        normalizeMessage: () => [],
        forwardFrames: () => undefined,
      });

      // Long enough that a walk which never parked would have written both rows.
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(
        readTranscriptRows(transcriptPath).length,
        seedRows + 1,
        'the barrier must hold the walk: only the row in front of it may be on disk while it is un-released',
      );

      assert.equal(releaseDebugAgentRun(appSessionId), 1, 'the release must wake the one waiter parked at the barrier');

      const reading = await walk;
      assert.equal(
        readTranscriptRows(transcriptPath).length,
        seedRows + 2,
        'once released, the walk must write the row behind the barrier',
      );
      assert.equal(
        releaseDebugAgentRun(appSessionId),
        0,
        'a second release, after the run has ended, must report that it woke nobody rather than fail',
      );

      // The barrier is a step like any other as far as the artifact is concerned:
      // it adds nothing, so a scenario's own row count still describes the walk.
      const evaluation = evaluateScenarioExpectations({
        scenario,
        transcriptPath,
        reading,
        sessionId,
        normalizeMessage: () => [],
      });
      assert.deepEqual(
        evaluation.failures,
        [],
        `the barrier must not disturb the artifact's own verdict: ${JSON.stringify(evaluation.failures)}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
