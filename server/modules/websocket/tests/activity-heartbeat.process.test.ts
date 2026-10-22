/**
 * AC-182: the business heartbeat, measured on a real server process.
 *
 * The server already has a websocket-protocol `ping` (see
 * `attachWebSocketHeartbeat`), but a browser cannot see it: it is not a
 * message, so page JavaScript has no way to tell whether the server is still
 * there. This criterion drives the thing that a client CAN see — an
 * `activity.heartbeat` business frame carrying `bootId` and `rev`, emitted on a
 * fixed beat to a subscribed session — and measures its four load-bearing
 * properties on the real process an operator runs, not on an in-process double:
 *
 *  1. the beat is real: over N shortened beat periods a subscribed socket reads
 *     at least N-1 frames, each carrying both `bootId` and `rev`;
 *  2. `bootId` is stable inside one process: the hello frame and every heartbeat
 *     agree;
 *  3. a `SIGKILL`ed server goes silent: the socket closes and no further frame
 *     arrives;
 *  4. a restarted server reports a different `bootId`, which is what lets a
 *     client discard every local "in progress" assumption.
 *
 * The second case reads the shipped defaults and what the server announces for
 * them: the process criterion shortens the beat with environment variables so it
 * fits its budget, so the shipped numbers have to be asserted against a server
 * that was NOT shortened, and against the implementation's own exported
 * constants rather than literals copied into the test.
 *
 * ## What would make this criterion lie
 *
 * A green run whose frames came from a process other than the one it booted, a
 * `bootId` read off a variable instead of off the wire, or a "silent" reading
 * taken without ever having heard a beat. Each is closed here: the frames are
 * read from a real websocket to the booted child, the bootId comes from the
 * `chat_subscribed` hello the server sent, and the silence leg only counts after
 * the beat proved itself alive and then only after the socket actually closed.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import WebSocket from 'ws';

import {
  ACTIVITY_HEARTBEAT_INTERVAL_MS,
  ACTIVITY_UNREACHABLE_AFTER_MS,
} from '@/modules/websocket/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The checkout this criterion measures: its own repository root. */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const SERVER_ENTRY = 'server/index.ts';
const PROVIDER = 'claude';

/** The ambient port the operator's own server uses; a boot that inherited it is a failure. */
const AMBIENT_PORT = 3001;

/** The shortened beat the pacing legs use; the shipped numbers are asserted separately. */
const BEAT_MS = 200;
const UNREACHABLE_MS = 600;
/** How many beats the pacing leg reads, and the floor it must clear (N-1). */
const BEATS = 5;
const BEAT_FLOOR = BEATS - 1;
/** The silent window after `SIGKILL` during which no frame may arrive. */
const SILENT_WINDOW_MS = 800;

/** How long the server is given to answer `/health` after being spawned. */
const BOOT_TIMEOUT_MS = 25_000;
/** How long a single expected frame is given to arrive. */
const FRAME_TIMEOUT_MS = 10_000;

/** The process-level budget. See `guard` for why it is a function. */
const BUDGET_MS = 55_000;
const STARTED_AT = Date.now();

/**
 * The exit code a run at `elapsedMs` owes against `budgetMs`.
 *
 * A pure function so the threshold is falsifiable in both directions instead of
 * being a `setTimeout` nobody can test: over budget answers 3, at or under it
 * answers 0. Both returns are asserted below, which is what makes "the guard is
 * load-bearing" a reading rather than a claim.
 */
export function guard({ elapsedMs, budgetMs }: { elapsedMs: number; budgetMs: number }): number {
  return elapsedMs > budgetMs ? 3 : 0;
}

const budgetTimer = setTimeout(() => {
  const elapsed = Date.now() - STARTED_AT;
  console.error(
    `[budget] budget-ms=${BUDGET_MS} elapsed-ms=${elapsed} exit=3 — the heartbeat boundary did not ` +
      'finish inside its process budget (a process-level kill, not a node:test case failure).',
  );
  process.exit(guard({ elapsedMs: elapsed, budgetMs: BUDGET_MS }));
}, BUDGET_MS);
// Unref'd so the guard cannot itself hold the process open once the legs finish.
budgetTimer.unref();

// -------------------------------------------------------------------- helpers

/** Polls a predicate until it holds, and says what it was waiting for when it gives up. */
async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** Every `activity.heartbeat` frame the socket has received, in order. */
function heartbeatsOf(chat: ChatSocket): Array<Record<string, unknown>> {
  return chat.frames.filter((frame) => frame.kind === 'activity.heartbeat');
}

// ------------------------------------------------------------------- the server

type ServerReading = {
  /** The `detached` spawn's pid: the process *group* leader, not the server itself. */
  leaderPid: number;
  port: number;
  logPath: string;
  logText(): string;
  /** Signals the whole process group, so the `npx`/`sh`/`tsx` wrappers die with the server. */
  stop(signal: NodeJS.Signals): void;
};

/**
 * Boots a real server: `tsx server/index.ts`, in its own process group, with its
 * output on a file descriptor.
 *
 * The log goes to a file rather than a pipe because a pipe nobody drains fills
 * and blocks the server that is being measured. The environment is scrubbed of
 * the ambient shell's database, host, port and credentials, so the child can
 * only see the values this criterion hands it — the ambient database path in
 * particular is not overridable by `HOME`, and a child that inherited it would
 * write the operator's real database.
 *
 * `shorten` sets the two heartbeat environment overrides so the pacing legs read
 * several beats inside the budget; a boot that does not shorten reports the
 * shipped defaults, which is what the second case measures.
 */
async function bootServer(input: { tempRoot: string; shorten: boolean }): Promise<ServerReading> {
  const port = await freePort();
  const logPath = path.join(input.tempRoot, `server-${port}.log`);
  const logFd = fs.openSync(logPath, 'a');

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'DATABASE_PATH',
    'HOST',
    'SERVER_PORT',
    'JWT_SECRET',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ACTIVITY_HEARTBEAT_INTERVAL_MS',
    'ACTIVITY_UNREACHABLE_AFTER_MS',
  ]) {
    delete env[name];
  }
  Object.assign(env, {
    DATABASE_PATH: path.join(input.tempRoot, 'auth.db'),
    HOME: path.join(input.tempRoot, 'home'),
    CLAUDE_CONFIG_DIR: path.join(input.tempRoot, 'claude-config'),
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
  });
  if (input.shorten) {
    env.ACTIVITY_HEARTBEAT_INTERVAL_MS = String(BEAT_MS);
    env.ACTIVITY_UNREACHABLE_AFTER_MS = String(UNREACHABLE_MS);
  }

  const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  const leaderPid = child.pid;
  assert.ok(leaderPid !== undefined, 'the server child has no pid; the boot never happened');

  const reading: ServerReading = {
    leaderPid,
    port,
    logPath,
    logText: () => {
      try {
        return fs.readFileSync(logPath, 'utf8');
      } catch {
        return '';
      }
    },
    stop: (signal) => {
      try {
        // Negative pid targets the whole process group this boot owns.
        process.kill(-leaderPid, signal);
      } catch {
        // The group is already gone.
      }
    },
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `The server on port ${port} never answered /health within ${BOOT_TIMEOUT_MS}ms.\n` +
          `--- ${logPath} ---\n${reading.logText().slice(-4000)}`,
      );
    }
    await sleep(150);
  }

  return reading;
}

/**
 * Mints a revocable observation token against the criterion's own database.
 *
 * `/ws` sits behind websocket auth and the session REST route behind
 * `authenticateToken`, and the token has to be signed with the secret of the
 * database the server is using — a temporary one, so this is the only way to get
 * a credential for it. The tool refuses when `JWT_SECRET` is reachable from the
 * environment, which is why the boot environment drops it and so does this call.
 */
async function mintToken(databasePath: string, outPath: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JWT_SECRET;

  const result = spawnSync(
    'node',
    ['scripts/mint-token.mjs', 'mint', '--db', databasePath, '--out', outPath],
    { cwd: REPO_ROOT, env, encoding: 'utf8' },
  );
  assert.equal(
    result.status,
    0,
    `mint-token refused: ${result.stderr || result.stdout || '(no output)'}`,
  );

  return fs.readFileSync(outPath, 'utf8').trim();
}

/** Creates a real app session (`POST /api/providers/sessions`) and returns its id. */
async function createSession(port: number, token: string, projectPath: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/api/providers/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: PROVIDER, projectPath, initialMessage: '' }),
  });
  const text = await response.text();
  assert.ok(
    response.status === 201 || response.status === 200,
    `session creation answered ${response.status}: ${text}`,
  );
  const body = JSON.parse(text) as { data?: { sessionId?: string } };
  const sessionId = body.data?.sessionId;
  assert.ok(typeof sessionId === 'string' && sessionId.length > 0, `no session id in ${text}`);
  return sessionId;
}

// ------------------------------------------------------------------- chat socket

type ChatSocket = {
  socket: WebSocket;
  /** Everything the server has sent, in order. */
  frames: Array<Record<string, unknown>>;
  /** Resolves once the socket is closed or has errored — either end of the connection. */
  closed: Promise<void>;
  close(): void;
};

async function connectChat(port: number, token: string): Promise<ChatSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const frames: Array<Record<string, unknown>> = [];

  socket.on('message', (raw: Buffer) => {
    try {
      frames.push(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    } catch {
      // A frame this criterion cannot read is not a frame it can act on.
    }
  });

  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (error: Error) => reject(error));
  });

  return {
    socket,
    frames,
    closed,
    close: () => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** Waits for the first frame of `kind` and returns it. */
async function waitForFrame(
  chat: ChatSocket,
  kind: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  await waitFor(() => chat.frames.some((frame) => frame.kind === kind), timeoutMs, `a "${kind}" frame`);
  return chat.frames.find((frame) => frame.kind === kind) as Record<string, unknown>;
}

/** Subscribes one socket to one session and returns the hello frame it answers with. */
async function subscribe(chat: ChatSocket, sessionId: string): Promise<Record<string, unknown>> {
  chat.socket.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId }] }));
  return await waitForFrame(chat, 'chat_subscribed', FRAME_TIMEOUT_MS);
}

// -------------------------------------------------------------------------- tests

test('a subscribed session is beaten with activity.heartbeat, and a killed server goes silent', async () => {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'activity-heartbeat-'));
  await fsp.mkdir(path.join(tempRoot, 'home'), { recursive: true });
  await fsp.mkdir(path.join(tempRoot, 'claude-config'), { recursive: true });

  const booted: ServerReading[] = [];
  const chats: ChatSocket[] = [];
  try {
    const databasePath = path.join(tempRoot, 'auth.db');

    // ---- leg 1: the beat is real, and the boot id is stable inside the process ----
    const first = await bootServer({ tempRoot, shorten: true });
    booted.push(first);
    assert.notEqual(first.port, AMBIENT_PORT, 'the boot inherited the ambient port instead of a probed one');

    const token = await mintToken(databasePath, path.join(tempRoot, 'token'));
    const sessionId = await createSession(first.port, token, tempRoot);

    const chat = await connectChat(first.port, token);
    chats.push(chat);
    const hello = await subscribe(chat, sessionId);
    const helloBootId = hello.bootId;
    assert.ok(
      typeof helloBootId === 'string' && helloBootId.length > 0,
      `the hello frame carried no bootId: ${JSON.stringify(hello)}`,
    );
    console.log(
      `activity.hello bootId=${helloBootId} heartbeatIntervalMs=${String(hello.heartbeatIntervalMs)} ` +
        `unreachableAfterMs=${String(hello.unreachableAfterMs)}`,
    );

    // Wait for the beat to prove itself, then read what it proved. The window is
    // generously longer than N periods so a slow boot cannot turn into a missing
    // beat; the floor is still N-1, so a server that skipped beats stays red.
    //
    // The wait is deliberately non-throwing: whichever way it ends, the reading
    // below is the verdict, so a server that never beats fails with the frame
    // count the criterion is about rather than with a bare timeout.
    await waitFor(
      () => heartbeatsOf(chat).length >= BEATS,
      BEAT_MS * (BEATS + 4),
      `${BEATS} activity.heartbeat frames`,
    ).catch(() => undefined);
    const beats = heartbeatsOf(chat);
    assert.ok(
      beats.length >= BEAT_FLOOR,
      `read ${beats.length} activity.heartbeat frame(s) over ${BEATS} beat periods; expected at least ${BEAT_FLOOR}`,
    );
    // The run registry's own in-flight bit, carried on the beat and read from
    // the registry at beat time. It is the authority a client uses to tell a
    // finished turn from a running turn whose phase tracker has no phase, and it
    // must agree with the same session's hello (both read one registry).
    const helloIsProcessing = hello.isProcessing;
    assert.equal(
      typeof helloIsProcessing,
      'boolean',
      `the hello carried no boolean isProcessing: ${JSON.stringify(hello)}`,
    );
    for (const frame of beats) {
      assert.equal(frame.sessionId, sessionId, `a heartbeat was addressed to the wrong session: ${JSON.stringify(frame)}`);
      assert.ok(
        typeof frame.bootId === 'string' && frame.bootId.length > 0,
        `a heartbeat carried no bootId: ${JSON.stringify(frame)}`,
      );
      assert.ok(
        typeof frame.rev === 'number' && Number.isFinite(frame.rev),
        `a heartbeat carried no rev: ${JSON.stringify(frame)}`,
      );
      assert.equal(
        typeof frame.isProcessing,
        'boolean',
        `a heartbeat carried no boolean isProcessing (the run-in-flight authority): ${JSON.stringify(frame)}`,
      );
      assert.equal(
        frame.isProcessing,
        helloIsProcessing,
        `the heartbeat's isProcessing disagrees with the same session's hello: ${JSON.stringify(frame)} vs ${JSON.stringify(helloIsProcessing)}`,
      );
    }

    // The same boot id in the hello and in every beat. This is what a client
    // compares across reconnects, so a value that moved between frames would
    // report a restart that never happened.
    const bootIds = new Set<string>([helloBootId, ...beats.map((frame) => frame.bootId as string)]);
    const revisions = [...new Set(beats.map((frame) => frame.rev))];
    console.log(
      `activity.beats count=${beats.length} bootIds=${JSON.stringify([...bootIds])} revs=${JSON.stringify(revisions)}`,
    );
    assert.equal(
      bootIds.size,
      1,
      `the hello and the heartbeats disagree about the boot id: ${JSON.stringify([...bootIds])}`,
    );

    // ---- leg 2: SIGKILL is the path no graceful shutdown covers ----
    const beatsAtKill = heartbeatsOf(chat).length;
    assert.ok(beatsAtKill > 0, 'the silence leg started before a single beat was heard');
    first.stop('SIGKILL');
    await chat.closed;
    const framesAtClose = chat.frames.length;
    await sleep(SILENT_WINDOW_MS);
    const beatsAfter = heartbeatsOf(chat).length;
    console.log(
      `activity.kill beats-before=${beatsAtKill} frames-at-close=${framesAtClose} ` +
        `frames-after=${chat.frames.length} beats-after=${beatsAfter}`,
    );
    assert.equal(
      chat.frames.length,
      framesAtClose,
      `frames kept arriving after the server was killed (${framesAtClose} -> ${chat.frames.length})`,
    );
    assert.equal(beatsAfter, beatsAtKill, 'a heartbeat arrived after the server was killed');

    // ---- leg 3: a restarted process reports a different boot id ----
    const second = await bootServer({ tempRoot, shorten: true });
    booted.push(second);
    const secondToken = await mintToken(databasePath, path.join(tempRoot, 'token-2'));
    const secondSession = await createSession(second.port, secondToken, tempRoot);
    const secondChat = await connectChat(second.port, secondToken);
    chats.push(secondChat);
    const secondHello = await subscribe(secondChat, secondSession);
    console.log(`activity.restart first=${helloBootId} second=${String(secondHello.bootId)}`);
    assert.notEqual(
      secondHello.bootId,
      helloBootId,
      'the restarted process reused the first process bootId, so a client cannot see the restart',
    );

    // ---- the budget reading, with the threshold asserted on both sides ----
    const overBudget = guard({ elapsedMs: BUDGET_MS + 1, budgetMs: BUDGET_MS });
    const underBudget = guard({ elapsedMs: 0, budgetMs: BUDGET_MS });
    console.log(`guard({elapsedMs:${BUDGET_MS + 1},budgetMs:${BUDGET_MS}})=${overBudget}`);
    console.log(`guard({elapsedMs:0,budgetMs:${BUDGET_MS}})=${underBudget}`);
    assert.equal(overBudget, 3, 'the budget guard does not answer 3 when it is over budget');
    assert.equal(underBudget, 0, 'the budget guard does not answer 0 when it is under budget');
    console.log(`budget-ms=${BUDGET_MS} elapsed-ms=${Date.now() - STARTED_AT}`);
  } finally {
    for (const chat of chats) {
      chat.close();
    }
    for (const server of booted) {
      server.stop('SIGKILL');
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});

test('the shipped heartbeat defaults are announced to a client at subscribe time', async () => {
  // The constants are the one place the shipped numbers live; the assertion is
  // against them, not against literals copied into this file, so a build that
  // changed one without the other cannot pass.
  assert.equal(ACTIVITY_HEARTBEAT_INTERVAL_MS, 5_000, 'the shipped heartbeat interval is not 5000ms');
  assert.equal(ACTIVITY_UNREACHABLE_AFTER_MS, 15_000, 'the shipped unreachable threshold is not 15000ms');

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'activity-heartbeat-defaults-'));
  await fsp.mkdir(path.join(tempRoot, 'home'), { recursive: true });
  await fsp.mkdir(path.join(tempRoot, 'claude-config'), { recursive: true });

  const booted: ServerReading[] = [];
  const chats: ChatSocket[] = [];
  try {
    // Not shortened, so the announced values are the shipped ones.
    const server = await bootServer({ tempRoot, shorten: false });
    booted.push(server);
    const token = await mintToken(path.join(tempRoot, 'auth.db'), path.join(tempRoot, 'token'));
    const sessionId = await createSession(server.port, token, tempRoot);

    const chat = await connectChat(server.port, token);
    chats.push(chat);
    const hello = await subscribe(chat, sessionId);
    console.log(
      `activity.defaults intervalMs=${String(hello.heartbeatIntervalMs)} unreachableAfterMs=${String(hello.unreachableAfterMs)}`,
    );
    assert.equal(
      hello.heartbeatIntervalMs,
      ACTIVITY_HEARTBEAT_INTERVAL_MS,
      `the hello announced ${String(hello.heartbeatIntervalMs)}, not the shipped ${ACTIVITY_HEARTBEAT_INTERVAL_MS}ms heartbeat`,
    );
    assert.equal(
      hello.unreachableAfterMs,
      ACTIVITY_UNREACHABLE_AFTER_MS,
      `the hello announced ${String(hello.unreachableAfterMs)}, not the shipped ${ACTIVITY_UNREACHABLE_AFTER_MS}ms threshold`,
    );
    assert.ok(
      typeof hello.bootId === 'string' && hello.bootId.length > 0,
      `the default-boot hello carried no bootId: ${JSON.stringify(hello)}`,
    );
  } finally {
    for (const chat of chats) {
      chat.close();
    }
    for (const server of booted) {
      server.stop('SIGKILL');
    }
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
});
