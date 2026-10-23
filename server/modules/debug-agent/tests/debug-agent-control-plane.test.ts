import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import express from 'express';

import { authenticateToken, authRoutes } from '@/modules/auth/index.js';
import { initializeDatabase } from '@/modules/database/index.js';
import {
  providerModelsService,
  providerRegistry,
  providerRuntimeService,
  sessionsService,
} from '@/modules/providers/index.js';
import { createStaticAssetsMiddleware } from '@/modules/static-assets/index.js';
import type { LLMProvider } from '@/shared/types.js';

import {
  DEBUG_AGENT_CONTROL_PLANE_PATH,
  DEBUG_AGENT_PROVIDER_ID,
  debugAgentControlPlaneRouter,
  mountDebugAgentControlPlane,
  readDebugAgentGate,
  registerDebugAgentControlPlaneRoutes,
  type DebugAgentControlPlaneSeams,
  type DebugAgentScenario,
} from '../index.js';
import { buildMessageRow, readTranscriptLines } from '../debug-agent.runtime.js';

/**
 * The criterion for ADR-003 decisions 1, 3 and 6: the debug agent's dev-only
 * control plane is an HTTP face that exists only while the gate is open, and
 * whose three actions answer questions about the artifact rather than about
 * themselves.
 *
 * The three readings this file takes, and why each needs its own leg:
 *
 *  - **The three actions are reachable, and they refuse distinguishably.** A face
 *    that always answered `200` with an empty body would satisfy "reachable" and
 *    tell a caller nothing, so each action is read back by its own answer: arming
 *    returns the session it indexed, advancing the clock returns the run and the
 *    frames it forwarded, and the self-check answers with the record — or with a
 *    404 that NAMES the record it does not have, which is not the same thing as
 *    the closed gate's answer. The credential cases are read as a pair, because
 *    the two only mean anything against each other: no credential is 401, a valid
 *    credential naming a path outside the fixture home is 403, and neither is the
 *    other.
 *  - **The closed gate does not answer as the control plane.** `200 text/html`
 *    (the SPA shell) rather than `200 application/json`. This is measured, never
 *    assumed — and it is why no assertion below names a status code for the
 *    closed side. A criterion written as "closed ⇒ 404" would be red against a
 *    correct build AND blind to a tampered one (the tampered build answers 404 as
 *    well), so the second criterion carries a positive control showing the
 *    reading move when the gate stops deciding.
 *  - **The self-check reads the artifact, not the run's self-report.** The check
 *    is read, the fixture transcript is appended to out of band, and the check is
 *    read again: the row count has to follow the file. An endpoint that returned
 *    the numbers the run reported would answer with the count it saw during the
 *    run — the same count both times — which is the false form this criterion
 *    exists to catch.
 *
 * Why every reading comes from a CHILD process. The gate is evaluated once per
 * process and the fixture home is a per-run scratch directory, so a child per
 * gate state is the only way to take a reading without the previous state in it.
 * This mirrors the gate and frames criteria; the three files share no code
 * because their readings differ.
 *
 * Why the requests go over `node:http` rather than `fetch`. `fetch` (undici)
 * refuses a fixed list of ports, and this host hands out ephemeral ports across
 * the whole 1024–65535 range, so `listen(0)` lands on a refused port often enough
 * to red a suite run at random for a reason unrelated to what is measured here.
 * `node:http` has no such list.
 */

// Spelled through constants so this file never becomes a second reader of the
// gate variable: the gate criterion asserts that, outside the gate module,
// `server/` contains no direct read of it, and this file must pass that check.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_CONTROL_PLANE_PROBE';
const MODE_VAR = 'DEBUG_AGENT_CONTROL_PLANE_MODE';
const PROBE_MARKER = '__DEBUG_AGENT_CONTROL_PLANE_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/**
 * Two modules the providers barrel does not publish, loaded by absolute path.
 *
 * The capabilities matrix and the provider router are the two branches AC4 asks
 * about, and only the RAW lookup is unreachable through any published edge — "the
 * route refuses the id", "no row in the list" and "the consumer falls back" are
 * all read over real HTTP or through the barrel below. A static deep import is
 * exactly what `boundaries/dependencies` forbids for a backend module (measured:
 * it errors with "Cross-module imports must go through that module's barrel
 * file"). The specifiers are therefore computed at runtime, and these are
 * MEASUREMENTS of what those modules answer, not edges in the product's graph.
 */
const CAPABILITIES_MODULE = path.join(
  REPO_ROOT,
  'server',
  'modules',
  'providers',
  'services',
  'provider-capabilities.service.ts',
);
const PROVIDER_ROUTES_MODULE = path.join(REPO_ROOT, 'server', 'modules', 'providers', 'provider.routes.ts');

/**
 * The scenario driven through the control plane's own endpoints: one appended row
 * and one in-place growth. Two different artifact movements on purpose — a build
 * that conflated them could satisfy either reading alone.
 */
const SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: {
    title: 'debug agent control plane fixture',
    userText: 'summarise the control plane actions',
  },
  steps: [
    { at: 30, op: 'row', role: 'assistant', text: 'there are three actions on this face' },
    { at: 60, op: 'grow', text: ', and the third one reads the artifact back' },
  ],
  expect: {
    rows: { delta: 1 },
    content: { mustContain: [', and the third one reads the artifact back'] },
  },
};

/**
 * The scenario the release action is read against: a walk that parks at
 * `await-release` and does not write the row behind it until it is released.
 *
 * The barrier is deliberately NOT the last step and the one in front of it is a
 * plain row, so the artifact says which side of the barrier the walk got to: a
 * build where `await-release` was a no-op would write both rows without anyone
 * releasing anything, and its `expect.rows.delta` (two) would still be met — which
 * is why the reading below is taken while the walk is parked, on the row count,
 * and not on the run's own verdict.
 */
const RELEASE_SCENARIO: DebugAgentScenario = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: {
    title: 'debug agent release-barrier fixture',
    userText: 'park at the barrier until the control plane releases it',
  },
  steps: [
    { at: 10, op: 'row', role: 'assistant', text: 'before the barrier' },
    { at: 20, op: 'await-release' },
    { at: 30, op: 'row', role: 'assistant', text: 'after the barrier' },
  ],
  expect: {
    rows: { delta: 2 },
    content: { mustContain: ['before the barrier', 'after the barrier'] },
  },
};

/** Written by this file, never by the control plane — see the artifact criterion. */
const OUT_OF_BAND_TEXT = 'a row nobody asked the control plane to write';

/**
 * How long the parked-walk reading waits before it believes the barrier held.
 *
 * The walk's last step before the barrier is at 10ms, so a run that never parked
 * would have written both rows long before this. Long enough that a slow host
 * cannot make the reading vacuous, short enough that the child's own startup
 * budget is untouched.
 */
const PARKED_SETTLE_MS = 400;

type ChildMode = 'open' | 'closed' | 'closed-forced-mount';

/** One HTTP reading, trimmed to what the criteria compare. */
type HttpReading = {
  label: string;
  method: string;
  requestPath: string;
  credential: 'token' | 'none';
  status: number;
  contentType: string | null;
  /** `error.code` from the failure envelope, or null when the answer was a success. */
  errorCode: string | null;
  /** The answer's own opening bytes, so a red shows what actually replied. */
  bodyHead: string;
};

type Exchange = { reading: HttpReading; body: string };

type SelfCheckReading = {
  status: number;
  rows: number;
  rowsDelta: number;
  lastRowBytes: number;
  lastRowGrew: boolean;
  failures: string[];
};

type CapabilitiesReading = {
  /** The raw `getProviderCapabilities(DEBUG_AGENT_PROVIDER_ID)` answer, as printed. */
  direct: { typeofValue: string; json: string };
  /** The success envelope `createApiSuccessResponse` would build around it. */
  envelope: string;
  /** `GET /api/providers/capabilities` — the payload the frontend consumes. */
  listRoute: { status: number; providerIds: string[] };
  /** `GET /api/providers/:provider/capabilities`, read for both ids. */
  perProviderRoute: { claude: HttpReading; debug: HttpReading };
  /** The frontend's own two loops, replayed over that real payload. */
  frontend: { rowFound: boolean; forkable: boolean };
  /** The barrel-published consumer, driven twice on ONE session row. */
  consumer: { claude: string | null; debug: string | null; sessionId: string };
};

type ControlPlaneReading = {
  mode: ChildMode;
  gate: { enabled: boolean; home: string | null; reason: string };
  mounted: boolean;
  register: { status: number; hasToken: boolean };
  /** Read while the gate is open; null when this child's gate was closed. */
  open: {
    arm: HttpReading;
    armNoCredential: HttpReading;
    armOutsideFixtureHome: HttpReading;
    clock: HttpReading;
    clockUnknownSession: HttpReading;
    selfCheck: HttpReading;
    selfCheckNoRecord: HttpReading;
    armed: { sessionId: string; providerSessionId: string; transcriptPath: string; seedRows: number } | null;
    frames: number | null;
    steps: number | null;
    /** The release action, read on both sides of its barrier and on an unarmed session. */
    release: {
      /** The clock request for the parked walk, taken while the walk is still parked. */
      parkedClockRows: number;
      /** The same transcript's row count once the release has been stated. */
      releasedRows: number;
      /** How many waiters the release reported waking. */
      woken: number | null;
      /** The parked walk's own clock request, which only answers once it is released. */
      clock: HttpReading;
      /** The release stated again, on a run that has already finished. */
      again: HttpReading;
      /** The release stated for a session with no armed scenario. */
      unarmed: HttpReading;
      /** The release stated with no credential. */
      noCredential: HttpReading;
    };
  } | null;
  /** The self-check before and after an out-of-band append, with the file's own counts. */
  artifact: {
    transcriptPath: string;
    linesBefore: number;
    linesAfter: number;
    before: SelfCheckReading | null;
    after: SelfCheckReading | null;
  } | null;
  capabilities: CapabilitiesReading | null;
  /** Read on every mode: what this path answers under this gate state. */
  closed: { withToken: HttpReading; withoutToken: HttpReading };
};

// --------------------------- HTTP ---------------------------

function request(
  baseUrl: string,
  method: string,
  requestPath: string,
  options: { label: string; token?: string; body?: unknown },
): Promise<Exchange> {
  const url = new URL(requestPath, baseUrl);
  const payload = options.body === undefined ? null : JSON.stringify(options.body);
  const headers: Record<string, string> = {};
  if (payload !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  return new Promise<Exchange>((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            body,
            reading: {
              label: options.label,
              method,
              requestPath,
              credential: options.token ? 'token' : 'none',
              status: res.statusCode ?? 0,
              contentType: res.headers['content-type'] ?? null,
              errorCode: readErrorCode(body),
              bodyHead: body.slice(0, 80).replace(/\s+/g, ' '),
            },
          });
        });
      },
    );

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * The refusal's own code, from either shape the product uses.
 *
 * A refusal raised as an `AppError` rides the shared envelope
 * (`{success:false, error:{code,...}}`), while the auth middleware answers in its
 * own older shape (`{error, code}`) with the code at the top level. This criterion
 * is about WHICH refusal a caller got, so it reads the code wherever the product
 * puts it rather than assuming one envelope and reporting `null` for the other.
 */
function readErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown }; code?: unknown };
    if (typeof parsed.error?.code === 'string') {
      return parsed.error.code;
    }

    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

/** `data` from a success envelope, or null when the answer was not one. */
function readData<T>(body: string): T | null {
  try {
    const parsed = JSON.parse(body) as { success?: boolean; data?: T };
    return parsed.success === true && parsed.data !== undefined ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The lines a transcript really holds — the same filter `readTranscriptLines` applies. */
function countLines(filePath: string): number {
  return readTranscriptLines(filePath).length;
}

// --------------------------- child process ---------------------------

/**
 * The seams `server/index.ts` builds, built the same way here.
 *
 * Duplicated rather than imported because the entrypoint starts a listener when
 * it is loaded. That the entrypoint passes these two closures is pinned by the
 * gate criterion's wiring check; what they DO is pinned by the three actions this
 * file drives over real HTTP.
 */
function createSeams(): DebugAgentControlPlaneSeams {
  return {
    driveScenario: ({ sessionId, cwd, projectPath, writer }) => {
      const provider = providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID);
      return providerRuntimeService.run(
        provider.id,
        'debug agent control plane',
        { sessionId, cwd, projectPath },
        writer,
      );
    },
    resolveProvider: () => providerRegistry.resolveProvider(DEBUG_AGENT_PROVIDER_ID),
  };
}

/**
 * Boots an application assembled the way `server/index.ts` assembles it: the auth
 * routes, the provider routes, the control plane (registered and attached only
 * where the gate lets it), then the real static-assets middleware with its SPA
 * catch-all and the real error middleware. Everything below is requested over a
 * real socket.
 */
async function readControlPlane(mode: ChildMode): Promise<ControlPlaneReading> {
  await initializeDatabase();

  const providerRoutesModule = (await import(pathToFileURL(PROVIDER_ROUTES_MODULE).href)) as {
    default: express.Router;
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/auth', authRoutes);
  app.use('/api/providers', authenticateToken, providerRoutesModule.default);

  const mounted = mountDebugAgentControlPlane(app, authenticateToken);
  if (mounted) {
    registerDebugAgentControlPlaneRoutes(createSeams());
  } else if (mode === 'closed-forced-mount') {
    // The positive control: the same router at the same path while the gate is
    // closed, which is what a build that dropped the gate check would leave
    // behind. Registering the endpoints onto it is the act the entrypoint
    // performs inside the branch the gate opened.
    registerDebugAgentControlPlaneRoutes(createSeams());
    app.use(DEBUG_AGENT_CONTROL_PLANE_PATH, authenticateToken, debugAgentControlPlaneRouter);
  }

  const scratch = mkdtempSync(path.join(os.tmpdir(), 'debug-agent-control-plane-static-'));
  writeFileSync(path.join(scratch, 'index.html'), '<!doctype html><title>spa shell</title>');
  app.use(
    createStaticAssetsMiddleware({
      distDir: scratch,
      publicDir: scratch,
      onMissingIndex: (_req, res) => res.status(500).send('no built index'),
    }),
  );
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const typed = error as { statusCode?: number; code?: string; message?: string };
    if (typeof typed?.statusCode === 'number' && typeof typed.code === 'string') {
      return res.status(typed.statusCode).json({
        success: false,
        error: { code: typed.code, message: typed.message },
      });
    }

    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(error) } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    return await probe(baseUrl, mode, mounted);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A real credential, minted the way the product mints one.
 *
 * The register route is the only published export that signs a token — the auth
 * barrel does not carry `generateToken` — so going through it keeps this probe on
 * the product's own auth path rather than on a hand-rolled JWT.
 */
async function mintToken(baseUrl: string): Promise<{ status: number; token: string | null }> {
  const exchange = await request(baseUrl, 'POST', '/api/auth/register', {
    label: 'register',
    body: { username: 'control-plane-probe', password: 'control-plane-probe' },
  });

  // The auth routes answer with the token as a SIBLING of `success` rather than
  // inside `data` (`auth.service.ts` returns `{success, user, token}`), so this
  // one reading is taken off the top level rather than through `readData`.
  let token: string | null = null;
  try {
    const parsed = JSON.parse(exchange.body) as { token?: unknown };
    token = typeof parsed.token === 'string' ? parsed.token : null;
  } catch {
    token = null;
  }

  return { status: exchange.reading.status, token };
}

async function probe(baseUrl: string, mode: ChildMode, mounted: boolean): Promise<ControlPlaneReading> {
  const gate = readDebugAgentGate();
  const registration = await mintToken(baseUrl);
  const token = registration.token ?? undefined;

  const closedPath = `${DEBUG_AGENT_CONTROL_PLANE_PATH}/self-check?sessionId=not-a-session`;
  const reading: ControlPlaneReading = {
    mode,
    gate,
    mounted,
    register: { status: registration.status, hasToken: token !== undefined },
    open: null,
    artifact: null,
    capabilities: null,
    closed: {
      withToken: (await request(baseUrl, 'GET', closedPath, { label: 'closed self-check (credential)', token })).reading,
      withoutToken: (await request(baseUrl, 'GET', closedPath, { label: 'closed self-check (no credential)' })).reading,
    },
  };

  if (!mounted) {
    return reading;
  }

  const fixtureHome = process.env[GATE_HOME_VAR] ?? '';
  const projectPath = path.join(fixtureHome, 'workspace');
  const arm = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/scenarios`, {
    label: 'arm',
    token,
    body: { projectPath, scenario: SCENARIO },
  });
  const armed = readData<{ sessionId: string; providerSessionId: string; transcriptPath: string; seedRows: number }>(
    arm.body,
  );

  const armNoCredential = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/scenarios`, {
    label: 'arm (no credential)',
    body: { projectPath, scenario: SCENARIO },
  });
  const armOutsideFixtureHome = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/scenarios`, {
    label: 'arm (credential, path outside the fixture home)',
    token,
    // A sibling of the fixture home, never inside it: `os.tmpdir()` is the scratch
    // directory's parent, so this cannot be under the gate's home.
    body: { projectPath: path.join(os.tmpdir(), 'debug-agent-control-plane-outside'), scenario: SCENARIO },
  });

  const clock = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/clock`, {
    label: 'advance the clock',
    token,
    body: { sessionId: armed?.sessionId ?? '' },
  });
  const clockBody = readData<{ frames: number; reading: { steps: unknown[] } }>(clock.body);

  const clockUnknownSession = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/clock`, {
    label: 'advance the clock (unarmed session)',
    token,
    body: { sessionId: 'not-a-session' },
  });

  const selfCheckPath = `${DEBUG_AGENT_CONTROL_PLANE_PATH}/self-check?sessionId=${encodeURIComponent(armed?.sessionId ?? '')}`;
  const selfCheck = await request(baseUrl, 'GET', selfCheckPath, { label: 'self-check', token });
  const selfCheckNoRecord = await request(
    baseUrl,
    'GET',
    `${DEBUG_AGENT_CONTROL_PLANE_PATH}/self-check?sessionId=not-a-session`,
    { label: 'self-check (no record)', token },
  );

  // ---- the release action, read on the run it releases --------------------------
  // A second armed scenario whose walk parks at `await-release`, driven by a clock
  // request that is deliberately NOT awaited: the walk is in flight and blocked,
  // which is the only state the action exists for. The reading is the artifact —
  // one row count while parked, another once released — because a build where the
  // barrier was a no-op would write both rows with nobody releasing anything and
  // its own verdict (`expect.rows.delta`) would still hold.
  const barrierArm = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/scenarios`, {
    label: 'arm (await-release)',
    token,
    body: { projectPath, scenario: RELEASE_SCENARIO },
  });
  const barrierArmed = readData<{ sessionId: string; transcriptPath: string }>(barrierArm.body);
  const barrierSessionId = barrierArmed?.sessionId ?? '';
  const parkedClock = request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/clock`, {
    label: 'advance the clock (walk parked at await-release)',
    token,
    body: { sessionId: barrierSessionId },
  });
  await new Promise((resolve) => setTimeout(resolve, PARKED_SETTLE_MS));
  const parkedClockRows = barrierArmed ? countLines(barrierArmed.transcriptPath) : -1;

  const release = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/release`, {
    label: 'release (walk parked)',
    token,
    body: { sessionId: barrierSessionId },
  });
  const releaseBody = readData<{ released: boolean; woken: number }>(release.body);
  // The walks finish before their clock requests answer, so this is not a race
  // against the row the release unblocked.
  const parkedClockExchange = await parkedClock;
  const releasedRows = barrierArmed ? countLines(barrierArmed.transcriptPath) : -1;

  const releaseAgain = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/release`, {
    label: 'release (run already ended)',
    token,
    body: { sessionId: barrierSessionId },
  });
  const releaseUnarmed = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/release`, {
    label: 'release (unarmed session)',
    token,
    body: { sessionId: 'not-a-session' },
  });
  const releaseNoCredential = await request(baseUrl, 'POST', `${DEBUG_AGENT_CONTROL_PLANE_PATH}/release`, {
    label: 'release (no credential)',
    body: { sessionId: barrierSessionId },
  });

  reading.open = {
    arm: arm.reading,
    armNoCredential: armNoCredential.reading,
    armOutsideFixtureHome: armOutsideFixtureHome.reading,
    clock: clock.reading,
    clockUnknownSession: clockUnknownSession.reading,
    selfCheck: selfCheck.reading,
    selfCheckNoRecord: selfCheckNoRecord.reading,
    armed: armed
      ? {
          sessionId: armed.sessionId,
          providerSessionId: armed.providerSessionId,
          transcriptPath: armed.transcriptPath,
          seedRows: armed.seedRows,
        }
      : null,
    frames: clockBody?.frames ?? null,
    steps: clockBody?.reading?.steps?.length ?? null,
    release: {
      parkedClockRows,
      releasedRows,
      woken: releaseBody ? releaseBody.woken : null,
      clock: parkedClockExchange.reading,
      again: releaseAgain.reading,
      unarmed: releaseUnarmed.reading,
      noCredential: releaseNoCredential.reading,
    },
  };

  if (armed) {
    const linesBefore = countLines(armed.transcriptPath);

    // Out of band: written by this file, not by the control plane, so a reading
    // that came from the run's own report cannot follow it.
    appendFileSync(
      armed.transcriptPath,
      `${JSON.stringify(
        buildMessageRow({
          sessionId: armed.providerSessionId,
          cwd: projectPath,
          role: 'user',
          text: OUT_OF_BAND_TEXT,
          uuid: randomUUID(),
          parentUuid: null,
          timestamp: new Date().toISOString(),
        }),
      )}\n`,
      'utf8',
    );

    const after = await request(baseUrl, 'GET', selfCheckPath, {
      label: 'self-check (after an out-of-band append)',
      token,
    });

    reading.artifact = {
      transcriptPath: armed.transcriptPath,
      linesBefore,
      linesAfter: countLines(armed.transcriptPath),
      before: readSelfCheck(selfCheck),
      after: readSelfCheck(after),
    };
  }

  reading.capabilities = await readCapabilities(baseUrl, token, projectPath);
  return reading;
}

/** The run's own shape, as the self-check reports it. Every field comes off the artifact at request time. */
function readSelfCheck(exchange: Exchange): SelfCheckReading | null {
  const data = readData<{
    rows?: number;
    rowsDelta?: number;
    lastRowBytes?: number;
    lastRowGrew?: boolean;
    failures?: string[];
  }>(exchange.body);

  return data === null
    ? null
    : {
        status: exchange.reading.status,
        rows: data.rows ?? -1,
        rowsDelta: data.rowsDelta ?? -1,
        lastRowBytes: data.lastRowBytes ?? -1,
        lastRowGrew: data.lastRowGrew === true,
        failures: data.failures ?? [],
      };
}

async function readCapabilities(
  baseUrl: string,
  token: string | undefined,
  projectPath: string,
): Promise<CapabilitiesReading> {
  const { providerCapabilitiesService } = (await import(pathToFileURL(CAPABILITIES_MODULE).href)) as {
    providerCapabilitiesService: {
      getProviderCapabilities(provider: LLMProvider): unknown;
      listAllProviderCapabilities(): { provider: string; supportsSessionForking: boolean }[];
    };
  };

  // The raw value. The parameter is typed `LLMProvider`, so the call cannot even
  // be SPELLED for an id outside that union without a cast — which is itself half
  // of what this reading is about.
  const direct = providerCapabilitiesService.getProviderCapabilities(DEBUG_AGENT_PROVIDER_ID as LLMProvider);

  // ---- the route branch, over real HTTP ----
  const listed = await request(baseUrl, 'GET', '/api/providers/capabilities', { label: 'capabilities list', token });
  const rows = readData<{ providers?: { provider: string; supportsSessionForking?: boolean }[] }>(listed.body)
    ?.providers ?? [];
  const perProviderRoute = {
    claude: (
      await request(baseUrl, 'GET', '/api/providers/claude/capabilities', { label: 'claude capabilities', token })
    ).reading,
    debug: (
      await request(baseUrl, 'GET', `/api/providers/${DEBUG_AGENT_PROVIDER_ID}/capabilities`, {
        label: 'debug capabilities',
        token,
      })
    ).reading,
  };

  // ---- the frontend branch, replayed over that real payload ----
  // `useProviderCapabilities.ts` indexes the rows by `row.provider`, and
  // `useSessionForkingProviders` iterates the indexed values keeping the rows
  // whose `supportsSessionForking` is set. The hook itself needs a DOM, so its two
  // loops are reproduced here — over the answer the server actually gave, not over
  // a description of it.
  const byProvider: Record<string, { provider: string; supportsSessionForking?: boolean }> = {};
  for (const row of rows) {
    byProvider[row.provider] = row;
  }
  const forkable = Object.values(byProvider).some(
    (row) => Boolean(row?.supportsSessionForking) && row.provider === DEBUG_AGENT_PROVIDER_ID,
  );

  // ---- the consumer the barrel does publish, driven twice on ONE session row ----
  // The only difference between the two calls is the provider id: a mode the
  // matrix lists is recorded, and the same mode for the runtime id is refused
  // because the matrix has nothing to list. That refusal IS the fallback branch
  // (`getProviderCapabilities(provider)?.permissionModes ?? []`) being taken.
  const session = sessionsService.createAppSession('claude', projectPath, 'capability probe');
  const claudeMode = providerModelsService.setSessionPermissionMode('claude', session.sessionId, 'default');
  const debugMode = providerModelsService.setSessionPermissionMode(
    DEBUG_AGENT_PROVIDER_ID as LLMProvider,
    session.sessionId,
    'default',
  );

  return {
    direct: { typeofValue: typeof direct, json: JSON.stringify(direct) ?? 'undefined' },
    envelope: JSON.stringify({ success: true, data: direct }),
    listRoute: { status: listed.reading.status, providerIds: rows.map(({ provider }) => provider) },
    perProviderRoute,
    frontend: { rowFound: DEBUG_AGENT_PROVIDER_ID in byProvider, forkable },
    consumer: {
      claude: claudeMode?.permissionMode ?? null,
      debug: debugMode?.permissionMode ?? null,
      sessionId: session.sessionId,
    },
  };
}

// --------------------------- parent process ---------------------------

type ChildRun = { reading: ControlPlaneReading; scratch: string };

/**
 * Runs one child in one gate state. `HOME` is redirected into a scratch directory
 * and `DATABASE_PATH` points inside it, so no arm can reach the machine's real
 * `~/.claude` or its real database. `JWT_SECRET` is set so importing the auth
 * middleware never evaluates the app-config database, and the platform flag is
 * cleared so the middleware answers with JWTs rather than the single-user
 * shortcut — both are premises of the 401/403 readings.
 */
function runChild(mode: ChildMode): ChildRun {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-control-plane-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'control-plane.db');
  writeFileSync(databasePath, '');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    JWT_SECRET: 'debug-agent-control-plane-probe-secret',
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
  };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];
  delete env.VITE_IS_PLATFORM;

  // Only the OPEN mode opens the gate. The forced-mount control must stay closed —
  // it is the reading of a build that attached the router anyway.
  if (mode === 'open') {
    env[GATE_VAR] = 'on';
    env[GATE_HOME_VAR] = fixtureHome;
  }

  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF], {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }) as unknown as string;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error(
      `probe child (${mode}) exited non-zero.\n--- stdout ---\n${failure.stdout ?? ''}\n--- stderr ---\n${failure.stderr ?? String(error)}`,
    );
  }

  const line = stdout
    .split('\n')
    .filter((entry) => entry.startsWith(PROBE_MARKER))
    .pop();

  assert.ok(line, `probe child (${mode}) printed no reading; stdout was:\n${stdout}`);

  return { reading: JSON.parse(line.slice(PROBE_MARKER.length)) as ControlPlaneReading, scratch };
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take this mode's reading, print one line, exit without registering tests.
  const mode = process.env[MODE_VAR] as ChildMode | undefined;
  if (mode !== 'open' && mode !== 'closed' && mode !== 'closed-forced-mount') {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  console.log(`${PROBE_MARKER}${JSON.stringify(await readControlPlane(mode))}`);
} else {
  registerCriteria();
}

/** One line per reading, so a red shows what answered on each side. */
function describeHttp(reading: HttpReading): string {
  return `[${reading.label}] ${reading.method} ${reading.requestPath} credential=${reading.credential} -> ${reading.status} ${reading.contentType ?? '<no content-type>'}${reading.errorCode ? ` code=${reading.errorCode}` : ''} :: ${JSON.stringify(reading.bodyHead)}`;
}

function describeSelfCheck(label: string, reading: SelfCheckReading | null): string {
  return reading === null
    ? `[${label}] <no reading>`
    : `[${label}] ${reading.status} rows=${reading.rows} rowsDelta=${reading.rowsDelta} lastRowBytes=${reading.lastRowBytes} lastRowGrew=${reading.lastRowGrew} failures=${JSON.stringify(reading.failures)}`;
}

/** True when an answer is a control-plane JSON answer rather than the SPA shell. */
function isControlPlaneAnswer(reading: HttpReading): boolean {
  return (reading.contentType ?? '').includes('application/json');
}

function registerCriteria(): void {
  test('the three actions answer while the gate is open, and the closed gate does not answer as the control plane', () => {
    const { reading: open, scratch: openScratch } = runChild('open');
    const { reading: closed, scratch: closedScratch } = runChild('closed');

    try {
      const controlPlane = open.open;
      assert.ok(controlPlane, 'the open arm must have taken the three-action reading');
      console.log(
        [
          `[gate] ${open.gate.enabled ? 'OPEN' : 'CLOSED'} (${open.gate.reason}); home=${open.gate.home ?? '<none>'}`,
          `[register] ${open.register.status}, token minted=${open.register.hasToken}`,
          describeHttp(controlPlane.arm),
          describeHttp(controlPlane.clock),
          describeHttp(controlPlane.selfCheck),
          describeHttp(controlPlane.selfCheckNoRecord),
          describeHttp(controlPlane.clockUnknownSession),
          describeHttp(controlPlane.armNoCredential),
          describeHttp(controlPlane.armOutsideFixtureHome),
          '--- the release barrier ---',
          `[release] parked rows=${controlPlane.release.parkedClockRows} released rows=${controlPlane.release.releasedRows} woken=${controlPlane.release.woken}`,
          describeHttp(controlPlane.release.clock),
          describeHttp(controlPlane.release.again),
          describeHttp(controlPlane.release.unarmed),
          describeHttp(controlPlane.release.noCredential),
          '--- gate closed: the same path, both credentials ---',
          `[gate] ${closed.gate.enabled ? 'OPEN' : 'CLOSED'} (${closed.gate.reason})`,
          describeHttp(closed.closed.withToken),
          describeHttp(closed.closed.withoutToken),
        ].join('\n'),
      );

      assert.equal(open.gate.enabled, true, 'the open arm must have the gate open');
      assert.equal(open.mounted, true, 'the open arm must have attached the control plane');
      assert.equal(open.register.status, 200, 'the credential must come from the real register route');
      assert.equal(open.register.hasToken, true, 'registering must mint a token');

      // ---- the three actions, each read by its own answer ----
      assert.equal(controlPlane.arm.status, 200, `arming must answer 200: ${describeHttp(controlPlane.arm)}`);
      assert.ok(
        isControlPlaneAnswer(controlPlane.arm),
        `arming must answer as the control plane: ${describeHttp(controlPlane.arm)}`,
      );
      assert.ok(controlPlane.armed, 'arming must return the session it wrote and indexed');
      assert.equal(controlPlane.armed.seedRows, 2, 'the seed writes a title row and one message row');

      assert.equal(
        controlPlane.clock.status,
        200,
        `advancing the clock must answer 200: ${describeHttp(controlPlane.clock)}`,
      );
      assert.ok(
        controlPlane.frames !== null && controlPlane.frames > 0,
        `a run that wrote rows must have forwarded frames, got ${controlPlane.frames}`,
      );
      assert.equal(controlPlane.steps, SCENARIO.steps.length, 'the reading must report every step the scenario asked for');

      assert.equal(
        controlPlane.selfCheck.status,
        200,
        `the self-check must answer 200 for a driven session: ${describeHttp(controlPlane.selfCheck)}`,
      );
      assert.ok(isControlPlaneAnswer(controlPlane.selfCheck), 'the self-check must answer as the control plane');

      // ---- the missing-record 404 is DISTINGUISHABLE, not merely non-200 ----
      assert.equal(
        controlPlane.selfCheckNoRecord.status,
        404,
        `an absent record must be a 404 rather than an empty 200: ${describeHttp(controlPlane.selfCheckNoRecord)}`,
      );
      assert.equal(
        controlPlane.selfCheckNoRecord.errorCode,
        'DEBUG_AGENT_NO_SELF_CHECK_RECORD',
        'the 404 must name the record it does not have, so it is distinguishable from every other 404',
      );
      assert.equal(
        controlPlane.clockUnknownSession.status,
        404,
        `an unarmed session must be distinguishable too: ${describeHttp(controlPlane.clockUnknownSession)}`,
      );
      assert.equal(controlPlane.clockUnknownSession.errorCode, 'DEBUG_AGENT_SCENARIO_NOT_ARMED');

      // ---- 401 and 403, read against each other ----
      assert.equal(
        controlPlane.armNoCredential.status,
        401,
        `no credential must be 401: ${describeHttp(controlPlane.armNoCredential)}`,
      );
      assert.equal(controlPlane.armNoCredential.errorCode, 'AUTH_TOKEN_INVALID');
      assert.equal(
        controlPlane.armOutsideFixtureHome.status,
        403,
        `a valid credential naming a path outside the fixture home must be 403: ${describeHttp(controlPlane.armOutsideFixtureHome)}`,
      );
      assert.equal(controlPlane.armOutsideFixtureHome.errorCode, 'DEBUG_AGENT_PROJECT_OUTSIDE_FIXTURE_HOME');
      assert.notEqual(
        controlPlane.armNoCredential.status,
        controlPlane.armOutsideFixtureHome.status,
        'the two refusals must not share a status code',
      );
      assert.notEqual(
        controlPlane.armNoCredential.errorCode,
        controlPlane.armOutsideFixtureHome.errorCode,
        'the two refusals must not share a code either',
      );

      // ---- the release barrier: the walk is held, and the release is what lets it go ----
      assert.equal(
        controlPlane.release.parkedClockRows,
        controlPlane.armed.seedRows + 1,
        `while the walk is parked its barrier must hold the row behind it back: ${controlPlane.release.parkedClockRows} line(s) on disk`,
      );
      assert.equal(
        controlPlane.release.woken,
        1,
        'the release must report waking the one waiter the parked barrier registered',
      );
      assert.equal(
        controlPlane.release.releasedRows,
        controlPlane.armed.seedRows + 2,
        `once released, the walk must write the row behind the barrier: ${controlPlane.release.releasedRows} line(s) on disk`,
      );
      assert.equal(
        controlPlane.release.clock.status,
        200,
        `the parked walk must finish once it is released: ${describeHttp(controlPlane.release.clock)}`,
      );
      assert.equal(controlPlane.release.clock.errorCode, null, 'a released walk is a success, not a refusal');

      // ---- releasing is an answer, not a failure, when there is nothing to release ----
      assert.equal(
        controlPlane.release.again.status,
        200,
        `releasing a run that has already finished must answer: ${describeHttp(controlPlane.release.again)}`,
      );
      assert.equal(
        controlPlane.release.unarmed.status,
        404,
        `an unarmed session must be refused the way the clock refuses it: ${describeHttp(controlPlane.release.unarmed)}`,
      );
      assert.equal(controlPlane.release.unarmed.errorCode, 'DEBUG_AGENT_SCENARIO_NOT_ARMED');
      assert.equal(
        controlPlane.release.noCredential.status,
        401,
        `the release must be behind the same credential as every other action: ${describeHttp(controlPlane.release.noCredential)}`,
      );
      assert.equal(controlPlane.release.noCredential.errorCode, 'AUTH_TOKEN_INVALID');

      // ---- the closed gate: measured as an ABSENT face, never as a status ----
      assert.equal(closed.gate.enabled, false, 'the closed arm must have the gate closed');
      assert.equal(closed.mounted, false, 'the closed arm must not have attached anything');

      for (const [label, reading] of [
        ['with a credential', closed.closed.withToken],
        ['without a credential', closed.closed.withoutToken],
      ] as const) {
        assert.equal(
          isControlPlaneAnswer(reading),
          false,
          `${label}: the closed gate must not answer as the control plane: ${describeHttp(reading)}`,
        );
        assert.ok(
          (reading.contentType ?? '').includes('text/html'),
          `${label}: the closed path falls through to the SPA shell: ${describeHttp(reading)}`,
        );
        assert.ok(
          reading.bodyHead.includes('<!doctype html'),
          `${label}: the answer must be the frontend shell, not a control-plane body: ${describeHttp(reading)}`,
        );
      }

      // The DoD's (a), literally: the two sides' readings differ byte-for-byte.
      assert.notEqual(
        closed.closed.withToken.contentType,
        controlPlane.selfCheck.contentType,
        'the closed reading and the open reading must be byte-different',
      );
    } finally {
      rmSync(openScratch, { recursive: true, force: true });
      rmSync(closedScratch, { recursive: true, force: true });
    }
  });

  test('the reading is discriminating: attaching the same router while closed turns the closed path into a control-plane answer', () => {
    const { reading: closed, scratch: closedScratch } = runChild('closed');
    const { reading: forced, scratch: forcedScratch } = runChild('closed-forced-mount');

    try {
      console.log(
        [
          `[closed]        ${describeHttp(closed.closed.withToken)}`,
          `[closed]        ${describeHttp(closed.closed.withoutToken)}`,
          `[force-mounted] ${describeHttp(forced.closed.withToken)}`,
          `[force-mounted] ${describeHttp(forced.closed.withoutToken)}`,
        ].join('\n'),
      );

      assert.equal(closed.gate.enabled, false);
      assert.equal(forced.gate.enabled, false, 'the control must keep the gate closed');
      assert.equal(forced.mounted, false, 'the control attaches the router DESPITE the gate, as a tampered build would');

      // The control's point: the reading moves when the gate stops deciding, so
      // the criterion above is measuring the gate rather than passing by accident.
      assert.equal(
        isControlPlaneAnswer(forced.closed.withToken),
        true,
        `with the router attached, the closed path answers as the control plane: ${describeHttp(forced.closed.withToken)}`,
      );
      assert.equal(forced.closed.withToken.errorCode, 'DEBUG_AGENT_NO_SELF_CHECK_RECORD');
      assert.equal(isControlPlaneAnswer(forced.closed.withoutToken), true);
      assert.equal(forced.closed.withoutToken.status, 401);
      assert.equal(forced.closed.withoutToken.errorCode, 'AUTH_TOKEN_INVALID');
      assert.notEqual(
        forced.closed.withToken.contentType,
        closed.closed.withToken.contentType,
        'the tampered reading must differ from the correct one',
      );

      // Why a criterion written as "closed ⇒ 404" would NOT catch that build: the
      // tampered one answers 404 as well. A 404-shaped criterion would pass it.
      assert.equal(
        forced.closed.withToken.status,
        404,
        'the tampered build answers 404 too — a 404-shaped criterion would be blind to it',
      );
    } finally {
      rmSync(closedScratch, { recursive: true, force: true });
      rmSync(forcedScratch, { recursive: true, force: true });
    }
  });

  test('the self-check reads the artifact, so a row written after the run moves its answer', () => {
    const { reading, scratch } = runChild('open');

    try {
      const artifact = reading.artifact;
      assert.ok(artifact, 'the open arm must have driven a scenario and read the check twice');

      console.log(
        [
          `[transcript] ${artifact.transcriptPath}`,
          `[file] ${artifact.linesBefore} line(s) -> ${artifact.linesAfter} after the out-of-band append`,
          describeSelfCheck('self-check before the append', artifact.before),
          describeSelfCheck('self-check after the append ', artifact.after),
        ].join('\n'),
      );

      assert.ok(artifact.before && artifact.after, 'both readings must have parsed');

      // The check the run itself would call passing.
      assert.deepEqual(
        artifact.before.failures,
        [],
        'the scenario met its own expectations, so the self-check has no failures to report yet',
      );
      assert.equal(artifact.before.lastRowGrew, true, 'the run grew a row in place');

      // The artifact is the source of truth, before and after.
      assert.equal(
        artifact.before.rows,
        artifact.linesBefore,
        `the row count must be the file's own line count (${artifact.before.rows} vs ${artifact.linesBefore})`,
      );
      assert.equal(
        artifact.after.rows,
        artifact.linesAfter,
        `after the append the row count must be the file's own new count (${artifact.after.rows} vs ${artifact.linesAfter})`,
      );

      // The falsifier. A self-check that repeated the numbers the run reported
      // would answer with the count it saw during the run — the same count both
      // times — and this pair is what makes that impossible: the second read moved
      // by exactly the one line nobody told the control plane about.
      assert.equal(
        artifact.linesAfter,
        artifact.linesBefore + 1,
        'this criterion needs the out-of-band write to have landed',
      );
      assert.equal(
        artifact.after.rows,
        artifact.before.rows + 1,
        `返回引擎自述: the second read must follow the file (${artifact.before.rows} -> ${artifact.after.rows}); a cached self-report would repeat ${artifact.before.rows}`,
      );
      assert.equal(
        artifact.after.rowsDelta,
        artifact.before.rowsDelta + 1,
        "the delta is measured against the run's own baseline, so it must follow the file too",
      );

      // And the expectations were re-judged as well, which is only possible if they
      // were re-evaluated at request time.
      assert.ok(
        artifact.after.failures.some((failure) => failure.startsWith('rows:')),
        `the re-read must also re-judge the expectations: ${JSON.stringify(artifact.after.failures)}`,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test('the capability matrix has no entry for the runtime id, and every consumer falls back', () => {
    const { reading, scratch } = runChild('open');

    try {
      const capabilities = reading.capabilities;
      assert.ok(capabilities, 'the open arm must have taken the capability reading');

      console.log(
        [
          `[raw]      getProviderCapabilities('${DEBUG_AGENT_PROVIDER_ID}') -> ${capabilities.direct.typeofValue} (JSON.stringify: ${capabilities.direct.json})`,
          `[raw]      the envelope around it: ${capabilities.envelope}`,
          `[route]    GET /api/providers/capabilities -> ${capabilities.listRoute.status}, providers=${JSON.stringify(capabilities.listRoute.providerIds)}`,
          `[route]    ${describeHttp(capabilities.perProviderRoute.claude)}`,
          `[route]    ${describeHttp(capabilities.perProviderRoute.debug)}`,
          `[frontend] useProviderCapabilities indexes by row.provider -> a row for '${DEBUG_AGENT_PROVIDER_ID}' is present=${capabilities.frontend.rowFound}; useSessionForkingProviders keeps it=${capabilities.frontend.forkable}`,
          `[consumer] setSessionPermissionMode('claude', ${capabilities.consumer.sessionId}, 'default') -> ${JSON.stringify(capabilities.consumer.claude)}`,
          `[consumer] setSessionPermissionMode('${DEBUG_AGENT_PROVIDER_ID}', ${capabilities.consumer.sessionId}, 'default') -> ${JSON.stringify(capabilities.consumer.debug)}`,
        ].join('\n'),
      );

      // The value itself. The matrix is keyed by the `LLMProvider` union and the
      // runtime id is deliberately outside it (ADR-003 decision 2), so the lookup
      // answers nothing at all.
      assert.equal(capabilities.direct.typeofValue, 'undefined', 'the lookup must answer nothing for the runtime id');
      assert.equal(capabilities.envelope, '{"success":true}', 'the `data` key disappears with the value');

      // ---- the route branch, over real HTTP ----
      assert.equal(capabilities.listRoute.status, 200, 'the list route the frontend consumes must answer');
      assert.equal(
        capabilities.listRoute.providerIds.includes(DEBUG_AGENT_PROVIDER_ID),
        false,
        `the list route must not advertise the runtime id, got ${JSON.stringify(capabilities.listRoute.providerIds)}`,
      );
      assert.equal(capabilities.perProviderRoute.claude.status, 200, 'the control: the route works for a union member');
      assert.equal(
        capabilities.perProviderRoute.debug.status,
        400,
        `the per-provider route refuses the runtime id before any lookup: ${describeHttp(capabilities.perProviderRoute.debug)}`,
      );
      assert.equal(capabilities.perProviderRoute.debug.errorCode, 'UNSUPPORTED_PROVIDER');

      // ---- the frontend branch, replayed over the route's real payload ----
      assert.equal(capabilities.frontend.rowFound, false, 'no row for the id means no affordance to offer');
      assert.equal(
        capabilities.frontend.forkable,
        false,
        'the optional chain over a missing row degrades to false rather than throwing',
      );

      // ---- the barrel-published consumer, both providers on ONE session row ----
      assert.equal(capabilities.consumer.claude, 'default', 'a listed mode must be recorded');
      assert.equal(
        capabilities.consumer.debug,
        null,
        'the runtime id must take the fallback (`?? []`) and record nothing, rather than throw',
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
