import path from 'node:path';

import type { Router } from 'express';

import type { IProvider } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeWriter } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse, readObjectRecord } from '@/shared/utils.js';

import {
  evaluateScenarioExpectations,
  releaseDebugAgentRun,
  type DebugAgentRunReading,
} from './debug-agent.engine.js';
import { debugAgentControlPlaneRouter, readDebugAgentGate } from './debug-agent.gate.js';
import type { DebugAgentHostDriver } from './debug-agent.host-driver.js';
import {
  armDebugAgentScenario,
  readArmedDebugAgentScenario,
  type ArmedDebugAgentScenario,
} from './debug-agent.runtime.js';
import type { DebugAgentLifecycleMode } from './debug-agent.scenario.js';

/**
 * The debug agent's dev-only control plane: the HTTP endpoints behind the three
 * operations ADR-003 decision 1 names — arm a scenario, advance the clock, read
 * the engine's self-check result — plus the one read the busy-send criterion
 * needs of a process rather than of an artifact: what that process is holding in
 * its queue (`GET /queue`). `POST /release` is the fourth action, and it is not a
 * fourth *operation* in decision 1's sense: it states nothing new about the run,
 * it only lets a caller that is watching the run's frames say when the scenario's
 * `await-release` barrier may open.
 *
 * Why HTTP, and nothing else (decision 6). None of the three needs server push,
 * so a WebSocket would buy a handshake, an auth path and reconnect semantics for
 * nothing; and a CLI script would bypass the auth middleware, turning the face
 * into "any process on this host may drive it", while also becoming a second
 * entry point competing with this one over which is the control plane.
 *
 * Two things this module deliberately does NOT own:
 *
 *  - **Whether any of it exists.** The router belongs to `debug-agent.gate.ts`,
 *    which is the only reader of the gate variable and the only module allowed
 *    to decide whether the face is attached (`mountDebugAgentControlPlane` is a
 *    no-op while the gate is closed). Registering here, onto the router that
 *    module hands out, keeps the decision in one place: a closed gate means the
 *    endpoints were never registered as well as never mounted.
 *  - **The engine.** `POST /clock` drives the armed scenario through the
 *    product's own runtime dispatcher rather than calling `runDebugAgentScenario`
 *    here: the frames a run emits are the product's normalizer's output, and the
 *    session↔frame mapping belongs to that chain. The two dependencies that reach
 *    outside this module are injected for that reason — see
 *    {@link DebugAgentControlPlaneSeams} — because this module may not import the
 *    providers module (the registry imports this module's barrel to register the
 *    debug provider, so the edge back would close a cycle).
 *
 * The security boundary is the gate, not the credential (decision 6): the routes
 * run under the same `authenticateToken` every other protected route uses, which
 * answers "who are you". Only the gate answers "does this exist".
 */

/**
 * What the control plane needs from the rest of the server, injected.
 *
 * Both members are functions rather than values, and both are called only from
 * inside a request handler: the object `server/index.ts` builds must not resolve
 * a provider — or read a runtime — while the gate is closed, because "closed"
 * means this face does not exist, not that it is guarded.
 *
 * Consumed by `server/index.ts`, which is the one module that imports both sides
 * of the cycle this injection exists to avoid.
 */
export type DebugAgentControlPlaneSeams = {
  /**
   * Drives the scenario armed for `sessionId` through the product's runtime
   * dispatcher, writing every frame to `writer`. Resolves to the run's own
   * `{ reading, evaluation }`.
   */
  driveScenario(input: {
    sessionId: string;
    cwd: string;
    projectPath: string;
    writer: ProviderRuntimeWriter;
  }): Promise<unknown>;
  /**
   * The provider whose `sessions` (the product's normalizer) and
   * `sessionSynchronizer` (an indexer pointed at the fixture home) this face
   * reuses, so an armed scenario is listable and its rows normalize the way the
   * product normalizes them.
   */
  resolveProvider(): IProvider;
  /**
   * What opened the run this session currently has, or `null` when it has none.
   *
   * The one fact about an unattended turn that the transcript cannot show: the
   * rows it wrote are on disk and readable by anyone, but "a *run* was opened
   * for it, by the host layer, and not by a client" lives in the run registry.
   * Published here so a criterion can read it off the same HTTP face that drove
   * the scenario, which is what makes "the turn really opened a run" a reading
   * about the production path rather than about a seam the criterion wired
   * itself.
   *
   * Optional, and an absent reader answers `null`: the seams object is built by
   * the composition root, and a criterion that drives this face without a run
   * registry (the control-plane criterion does) has no runs to report. `null`
   * says exactly that and is what the caller already has to handle for a session
   * whose turn opened none.
   */
  readRunSource?(sessionId: string): string | null;
  /**
   * Stores the lifecycle mode an armed scenario's seed asks for.
   *
   * Injected for the reason every other seam here is: the column belongs to the
   * sessions module, which this one may not import. Optional, and an absent
   * writer refuses a scenario that seeds `resident` — see
   * `DebugAgentArmInput.setSessionLifecycleMode`.
   */
  setSessionLifecycleMode?(input: {
    appSessionId: string;
    mode: DebugAgentLifecycleMode;
  }): void;
};

/**
 * What "advance the clock" leaves behind for "read the self-check result".
 *
 * It holds the ARMING (a path) and the RUN (the engine's own step observations),
 * never an evaluation: the check is recomputed from the artifact on every read,
 * so a transcript that changed after the run changes the answer. Caching the
 * evaluation here would make this endpoint a second reporter of the engine's
 * self-report, which is the one thing it must not be.
 */
type DebugAgentRunRecord = {
  armed: ArmedDebugAgentScenario;
  reading: DebugAgentRunReading;
};

/** Run records, keyed by the session id the scenario was armed under. */
const runRecords = new Map<string, DebugAgentRunRecord>();

/** The actions, as paths under {@link DEBUG_AGENT_CONTROL_PLANE_PATH}. */
const SCENARIOS_PATH = '/scenarios';
const CLOCK_PATH = '/clock';
const RELEASE_PATH = '/release';
const SELF_CHECK_PATH = '/self-check';
const QUEUE_PATH = '/queue';

function refuse(message: string, code: string, statusCode: number): never {
  throw new AppError(message, { code, statusCode });
}

/** A required non-empty string from a parsed JSON body. */
function readBodyString(body: AnyRecord | null, field: string): string {
  const value = body?.[field];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return refuse(
    `The request body's "${field}" must be a non-empty string.`,
    'DEBUG_AGENT_REQUEST_INVALID',
    400,
  );
}

/** A required non-empty string from the query string. */
function readQueryString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  return refuse(
    `The "${field}" query parameter must be a non-empty string.`,
    'DEBUG_AGENT_REQUEST_INVALID',
    400,
  );
}

/**
 * Refuses a scenario whose project path is not inside the gate's fixture home.
 *
 * The fixture home is what makes a debug run's writes disposable: every row a
 * scenario writes lands under `DEBUG_AGENT_HOME`, and a scenario that could name
 * a project path outside it would write into a real project's transcripts. The
 * refusal is a 403 rather than a 404 because the caller is authenticated and the
 * path exists — this is an authorization answer about a path, which is the same
 * shape `file-tree.service.ts` gives a path escaping its project root
 * (`PATH_OUTSIDE_PROJECT`, 403), and it is what keeps "no credential" (401) and
 * "credential, wrong path" (403) from collapsing into one reading.
 */
function assertInsideFixtureHome(projectPath: string): void {
  const home = readDebugAgentGate().home;
  const resolved = path.resolve(projectPath);
  const inside = home !== null && (resolved === home || resolved.startsWith(home + path.sep));

  if (!inside) {
    return refuse(
      `projectPath ${JSON.stringify(projectPath)} is outside the debug agent fixture home (${JSON.stringify(home)}); this face writes only under DEBUG_AGENT_HOME.`,
      'DEBUG_AGENT_PROJECT_OUTSIDE_FIXTURE_HOME',
      403,
    );
  }
}

/**
 * The run's reading, read off the dispatcher's return value.
 *
 * `unknown` rather than a typed return because the seam crosses a module
 * boundary: what comes back is whatever the runtime resolved to, and a build
 * whose runtime answered with something else must fail here, naming the session,
 * rather than have the self-check read fields off it that are not there.
 */
function readRunReading(value: unknown, sessionId: string): DebugAgentRunReading {
  const reading = readObjectRecord(readObjectRecord(value)?.reading);

  if (!reading || !readObjectRecord(reading.before) || !Array.isArray(reading.steps)) {
    return refuse(
      `The run for session "${sessionId}" returned no reading, so there is nothing to check against the artifact.`,
      'DEBUG_AGENT_RUN_READING_MISSING',
      500,
    );
  }

  return reading as unknown as DebugAgentRunReading;
}

/**
 * Registers the endpoints onto the gate's control-plane router and returns
 * that same router, so the caller can attach exactly what it just registered.
 *
 * Consumed by `server/index.ts`, inside the branch that the gate opened — a
 * closed gate registers nothing, which is half of why a closed gate has nothing
 * to reach.
 */
export function registerDebugAgentControlPlaneRoutes(seams: DebugAgentControlPlaneSeams): Router {
  const router = debugAgentControlPlaneRouter;

  // Arm a scenario: write its seed rows into the fixture home and index them, so
  // the session is listable, selectable and sendable before anything drives it.
  router.post(
    SCENARIOS_PATH,
    asyncHandler(async (req, res) => {
      const body = readObjectRecord(req.body);
      const projectPath = readBodyString(body, 'projectPath');
      assertInsideFixtureHome(projectPath);

      const provider = seams.resolveProvider();
      const armed = await armDebugAgentScenario({
        projectPath,
        scenario: body?.scenario,
        synchronizeTranscript: (filePath) => provider.sessionSynchronizer.synchronizeFile(filePath),
        ...(seams.setSessionLifecycleMode
          ? { setSessionLifecycleMode: seams.setSessionLifecycleMode }
          : {}),
      });

      res.json(createApiSuccessResponse({
        sessionId: armed.sessionId,
        providerSessionId: armed.providerSessionId,
        transcriptPath: armed.transcriptPath,
        projectPath: armed.projectPath,
        seedRows: armed.seedRows,
      }));
    }),
  );

  // Advance the clock: drive the armed scenario, recording the frames the run
  // produced and the reading it left. Nothing about the artifact is computed
  // here — that is the self-check's job, off disk.
  router.post(
    CLOCK_PATH,
    asyncHandler(async (req, res) => {
      const sessionId = readBodyString(readObjectRecord(req.body), 'sessionId');
      const armed = readArmedDebugAgentScenario(sessionId);

      if (!armed) {
        return refuse(
          `No debug agent scenario is armed for session "${sessionId}".`,
          'DEBUG_AGENT_SCENARIO_NOT_ARMED',
          404,
        );
      }

      const frames: unknown[] = [];
      const writer: ProviderRuntimeWriter = {
        send(data: unknown): void {
          frames.push(data);
        },
      };

      const reading = readRunReading(
        await seams.driveScenario({
          sessionId: armed.sessionId,
          cwd: armed.projectPath,
          projectPath: armed.projectPath,
          writer,
        }),
        armed.sessionId,
      );

      runRecords.set(armed.sessionId, { armed, reading });

      res.json(createApiSuccessResponse({
        sessionId: armed.sessionId,
        transcriptPath: armed.transcriptPath,
        frames: frames.length,
        reading,
        // Read after the walk, because the run this reports is opened *by* a
        // step in it. A completed run stays in the registry, so a turn that
        // already ended is still the answer to "what opened the last one".
        runSource: seams.readRunSource?.(armed.sessionId) ?? null,
      }));
    }),
  );

  // Release the armed scenario's walk: the one step whose timing is the caller's
  // rather than the clock's. A scenario that arms `await-release` blocks there
  // until this lands, which is how a criterion states "the events behind this
  // point fire once my own reading window has closed" instead of trusting a fixed
  // offset to outrun its own clicks on whatever host it happens to run on.
  //
  // An unarmed session is refused the way `/clock` refuses it — a release with no
  // run behind it is a request about something that does not exist — and the
  // count is the whole of the answer. It is deliberately NOT an error to release a
  // walk that has already passed its barrier or already ended: the caller is a
  // browser that cannot know which side of the barrier it is on, and `woken: 0`
  // says exactly that.
  router.post(
    RELEASE_PATH,
    asyncHandler(async (req, res) => {
      const sessionId = readBodyString(readObjectRecord(req.body), 'sessionId');
      const armed = readArmedDebugAgentScenario(sessionId);

      if (!armed) {
        return refuse(
          `No debug agent scenario is armed for session "${sessionId}", so there is no run to release.`,
          'DEBUG_AGENT_SCENARIO_NOT_ARMED',
          404,
        );
      }

      res.json(createApiSuccessResponse({
        sessionId: armed.sessionId,
        released: true,
        // The walk is addressed by the same id `/clock` drives it under, which is
        // the engine's own key — see `runDebugAgentScenario`'s `appSessionId`.
        woken: releaseDebugAgentRun(armed.sessionId),
      }));
    }),
  );

  // Read the self-check result: the artifact, as it stands at this request.
  //
  // The row count and the grow readings are re-read from the transcript here,
  // not taken from the run's report — a scenario that was edited, appended to or
  // re-run between the two calls must show up in this answer. With no record for
  // the session there is a 404 naming the record that is missing, which is a
  // different thing from the closed gate's answer (see the module's criterion:
  // closed means the path is not here at all, and the SPA catch-all serves the
  // frontend shell for it).
  router.get(
    SELF_CHECK_PATH,
    asyncHandler(async (req, res) => {
      const sessionId = readQueryString(req.query.sessionId, 'sessionId');
      const record = runRecords.get(sessionId);

      if (!record) {
        return refuse(
          `No self-check record for session "${sessionId}": no run has been driven under that id in this process.`,
          'DEBUG_AGENT_NO_SELF_CHECK_RECORD',
          404,
        );
      }

      const provider = seams.resolveProvider();
      const evaluation = evaluateScenarioExpectations({
        scenario: record.armed.scenario,
        transcriptPath: record.armed.transcriptPath,
        reading: record.reading,
        sessionId: record.armed.providerSessionId,
        normalizeMessage: (raw, rawSessionId) =>
          provider.sessions.normalizeMessage(raw, rawSessionId),
      });

      res.json(createApiSuccessResponse({
        sessionId,
        transcriptPath: record.armed.transcriptPath,
        rows: evaluation.rows,
        rowsDelta: evaluation.rowsDelta,
        lastRowBytes: evaluation.lastRowBytes,
        missingContent: evaluation.missingContent,
        grows: evaluation.grows,
        lastRowGrew: evaluation.lastRowGrew,
        failures: evaluation.failures,
      }));
    }),
  );

  // What the process is holding, and what it did with what it was asked to take
  // back — the only reading that can tell "the withdrawal reached the host" from
  // "the client stopped drawing the row".
  //
  // Read through the provider the registry resolved, not through a second queue
  // kept here: the queue belongs to the running process, and a copy on this side
  // would be a reading about this endpoint rather than about the host. The driver
  // is optional on the interface, so a provider that has none answers with empty
  // lists rather than a 404 — "this process was handed nothing" and "this provider
  // cannot be asked" are different facts, and only the first is what an empty
  // queue means.
  router.get(
    QUEUE_PATH,
    asyncHandler(async (req, res) => {
      const sessionId = readQueryString(req.query.sessionId, 'sessionId');
      const driver = seams.resolveProvider().hostDriver as Partial<DebugAgentHostDriver> | undefined;
      const reading = driver?.readCommandQueue?.(sessionId) ?? null;

      res.json(createApiSuccessResponse({
        sessionId,
        supported: reading !== null,
        queued: reading?.queued ?? [],
        withdrawRequested: reading?.withdrawRequested ?? [],
        withdrawn: reading?.withdrawn ?? [],
        controlResponses: reading?.controlResponses ?? [],
      }));
    }),
  );

  return router;
}
