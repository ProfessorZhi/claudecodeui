import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The criterion for the debug agent's fixture HOME isolation (ADR-003
 * "fixture HOME 隔离与清理", decision 3, and 后续任务 8).
 *
 * Why this is a fix surface and not tidiness: `session-synchronizer.service.ts`
 * records the failure it is built around — a test run that pointed at the real
 * `~/.claude` left a transcript there, and because the observer reacts to
 * `add`/`change` but not to `unlink`, the sidebar kept a permanent entry that
 * opened an empty "Untitled" session. The debug agent writes files, so the
 * question "where does it write, and what happens to the index when the file
 * goes away" is the difference between a fixture and an incident.
 *
 * The four readings, and why each one is separate:
 *
 *  (1) ISOLATION — the run's artifacts are on disk, and they are under the root
 *      the gate named (`DEBUG_AGENT_HOME`), not the root a class field reading
 *      `os.homedir()` would produce. This item is deliberately POSITIVE. It must
 *      stay green under the anti-fake variant below, which *moves* the gate root
 *      into the process home: there, every artifact is still under the gate root,
 *      and it has to be — otherwise the variant would red on this item and the
 *      criterion would not be measuring "did it write to the home" at all. The
 *      negative half of the sentence lives in item (2), and that is where the
 *      variant is caught.
 *  (2) REAL HOME — the process home (`os.homedir()`, the directory a fallback to
 *      it lands in) gained NOTHING during the run: entry count and latest
 *      modification time, read before and after. Two readings because either one
 *      alone is fooled — a same-second write leaves the mtime where it was, and a
 *      write-then-delete leaves the count where it was.
 *  (3) TEARDOWN — the fixture root is gone, whole, after teardown.
 *  (4) CLEANUP ORDER — the index was given its chance to converge while the root
 *      still existed, and the row really was reclaimed. This is the one that has
 *      to be structured rather than asserted in prose: `pruneOrphanedSessions`
 *      drops a row only while the row's containing directory still exists, so
 *      "delete the root, then assert the index is clean" is the wrong order — the
 *      moment the directory goes, the row can never be reclaimed, which is
 *      exactly the shape of the incident above.
 *
 * Item (2) is what separates this criterion from "the fixture was cleaned up".
 * "The fixture root was deleted" is completely blind to "the product wrote into
 * the real home" — and the latter is the incident. So the real home's own
 * readings are an assertion here, not a footnote.
 *
 * Why every reading comes from a CHILD process. The gate is evaluated once per
 * process at first read, and the registry builds the debug provider during module
 * evaluation, so whether the fixture exists at all is decided before any test body
 * runs. Each arm therefore re-executes this file in a child with the gate open,
 * `HOME` redirected into a scratch directory and `DATABASE_PATH` inside it, so no
 * arm can reach the machine's real `~/.claude`, its real database, or a stale
 * fixture root. The two sibling criteria in this directory do the same; the three
 * files share no code because the readings differ.
 */

// --------------------------- constants ---------------------------

// Spelled through constants so this file never becomes a second reader of the
// gate variable: `debug-agent-gate.test.ts` scans everything under `server/` for
// a direct read of it outside the gate module, and this file must pass that scan.
const GATE_VAR = 'DEBUG_AGENT';
const GATE_HOME_VAR = 'DEBUG_AGENT_HOME';
const PROBE_VAR = 'DEBUG_AGENT_FIXTURE_ISOLATION_PROBE';
const MODE_VAR = 'DEBUG_AGENT_FIXTURE_ISOLATION_MODE';
const ORDER_VAR = 'DEBUG_AGENT_FIXTURE_ISOLATION_ORDER';
const PROBE_MARKER = '__DEBUG_AGENT_FIXTURE_ISOLATION_READING__';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '../../../..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SELF = fileURLToPath(import.meta.url);

/** Bound on a whole child, so a hung arm cannot stall the suite. */
const CHILD_TIMEOUT_MS = 150_000;

/** The seed's own text, and the row the engine writes on the scenario clock. */
const SEED_USER_TEXT = 'the seed row the arming step wrote into the fixture home';
const ROW_TEXT = 'a row the engine wrote on the scenario clock';

/** Title row + seed row (the arming step), then the scenario's one `row` step. */
const SEED_ROWS = 2;
const EXPECTED_ROWS = SEED_ROWS + 1;

/**
 * Where the fixture root comes from, and the order teardown runs in.
 *
 * `FALSIFICATION SWITCHES` — these two constants are the two one-line changes
 * the criterion's anti-fake arms are about. Both default to the honest build;
 * flipping either one must make the first test below RED, and each red has to
 * land on the item it is about:
 *
 *  - `HONEST_FIXTURE_HOME = 'process-home'` ⇒ the fixture root IS the process
 *    home. Item (2) must be the failure (the home gained entries); item (1) must
 *    stay green, because the artifacts are still under the gate root — the root
 *    moved. That is the difference between "it wrote to the wrong place" and
 *    "it did not clean up", and it is the whole reason item (1) is positive.
 *  - `HONEST_TEARDOWN_ORDER = 'remove-then-converge'` ⇒ the root is deleted
 *    before the index is given its chance to converge. Item (4) must be the
 *    failure, naming the index row left behind; nothing was written to the wrong
 *    place, so item (2) must stay green.
 *
 * The same two values are driven explicitly by the anti-fake arms below, so both
 * falsifications are re-runnable without editing anything; the switches exist so
 * the *honest* arm can be made to fail on demand, which is what "the command must
 * exit non-zero" needs.
 */
const HONEST_FIXTURE_HOME: FixtureHomeChoice = 'gate-root';
const HONEST_TEARDOWN_ORDER: TeardownOrder = 'converge-then-remove';

type FixtureHomeChoice = 'gate-root' | 'process-home';
type TeardownOrder = 'converge-then-remove' | 'remove-then-converge';
type ChildMode = 'isolated' | 'real-home' | 'reversed-order';

/** Everything a child needs to know that is not already in its environment. */
const MODES: Record<ChildMode, { fixtureHome: FixtureHomeChoice; order: TeardownOrder }> = {
  // The honest arm runs whatever the two switches above say, so flipping either
  // one turns THIS arm — the one the criterion test judges — into the fake.
  isolated: { fixtureHome: HONEST_FIXTURE_HOME, order: HONEST_TEARDOWN_ORDER },
  // The ADR's 取假变体: the fixture is pointed at the process home, i.e. at the
  // real `~/.claude` the incident was about.
  'real-home': { fixtureHome: 'process-home', order: 'converge-then-remove' },
  // The reversed cleanup order: the root goes first, so the row can never be
  // reclaimed.
  'reversed-order': { fixtureHome: 'gate-root', order: 'remove-then-converge' },
};

// --------------------------- the reading ---------------------------

/**
 * One directory's own accounting. `latestMtimeMs` is the newest modification
 * time in the tree rather than the directory's own, so a write buried a level
 * down still moves it; `entries` counts the tree, so a create-then-remove that
 * leaves the mtime alone still shows up. Neither reading alone is enough.
 */
type HomeAccounting = {
  exists: boolean;
  entries: number;
  latestMtimeMs: number | null;
};

type FixtureIsolationReading = {
  mode: ChildMode;
  gate: { enabled: boolean; home: string | null; reason: string };
  /** (1) — the run's artifacts, and the root they are under. */
  isolation: {
    gateRoot: string | null;
    transcriptPath: string;
    projectPath: string;
    /** The transcript lies under the root the gate named. */
    transcriptUnderGateRoot: boolean;
    transcriptExists: boolean;
    transcriptRows: number;
    expectedRows: number;
    /** Every path under the fixture root while the run's output was on disk. */
    artifactsUnderGateRoot: string[];
  };
  /** (2) — the process home's own accounting, around the whole run. */
  home: {
    path: string;
    before: HomeAccounting;
    after: HomeAccounting;
    /** The run's transcript sits under the process home. */
    artifactUnderProcessHome: boolean;
    /** `<home>/.claude/projects` — where a class field reading `os.homedir()` writes. */
    processHomeProjectsRoot: string;
    processHomeProjectsRootExistsAfter: boolean;
    /** Everything left under `<home>/.claude` once teardown is done. */
    processHomeClaudeEntriesAfter: string[];
  };
  /** (3) — the root, after teardown. */
  teardown: {
    fixtureRoot: string | null;
    rootExistedBeforeTeardown: boolean;
    rootExistsAfterTeardown: boolean;
  };
  /** (4) — the order, and whether the index row was actually reclaimed. */
  order: {
    order: TeardownOrder;
    rootExistedAtConverge: boolean;
    rowIndexedBeforeConverge: boolean;
    prunedOrphans: number;
    pruneFailures: string[];
    rowIndexedAfterConverge: boolean;
  };
  session: { sessionId: string; providerSessionId: string };
  /** The run really produced output: frames the provider runtime handed its writer. */
  output: { frames: number };
  /** Bound on a hang, so the parent can tell "no reading" from "still running". */
  tookMs: number;
};

// --------------------------- child process ---------------------------

/** Every entry under a directory, relative, sorted. */
function listTree(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const found: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      found.push(nextRelative);
      if (entry.isDirectory()) {
        walk(path.join(absolute, entry.name), nextRelative);
      }
    }
  };

  walk(dir, '');
  return found.sort();
}

function readHomeAccounting(dir: string): HomeAccounting {
  if (!fs.existsSync(dir)) {
    return { exists: false, entries: 0, latestMtimeMs: null };
  }

  let latestMtimeMs = fs.statSync(dir).mtimeMs;
  let entries = 0;
  const walk = (absolute: string): void => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      entries += 1;
      const next = path.join(absolute, entry.name);
      try {
        latestMtimeMs = Math.max(latestMtimeMs, fs.statSync(next).mtimeMs);
      } catch {
        // Raced away between readdir and stat; the count still saw it.
      }
      if (entry.isDirectory()) {
        walk(next);
      }
    }
  };

  walk(dir);
  return { exists: true, entries, latestMtimeMs };
}

/**
 * Takes one arm's reading.
 *
 * The steps are the delivery chain in the order the criterion is about: the gate
 * resolves a root, a scenario is armed into it, the product's own runtime drives
 * it, the artifacts are read back, and teardown converges the index before it
 * removes the root.
 */
async function readFixtureIsolation(mode: ChildMode): Promise<FixtureIsolationReading> {
  const startedAt = Date.now();

  // Imported here rather than at the top so `HOME`, `DATABASE_PATH` and the gate
  // variables are already in the environment when the registry evaluates. The
  // gate is cached at first read and the provider is built during module
  // evaluation, so an import at file scope would freeze the wrong decision.
  const { initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
  const { providerRuntimeService, sessionSynchronizerService } = await import('@/modules/providers/index.js');
  const {
    DEBUG_AGENT_PROVIDER_ID,
    armDebugAgentScenario,
    getDebugAgentProjectsRoot,
    readDebugAgentGate,
  } = await import('../index.js');
  const { readTranscriptRows } = await import('../debug-agent.runtime.js');

  const order = process.env[ORDER_VAR];
  if (order !== 'converge-then-remove' && order !== 'remove-then-converge') {
    throw new Error(`unknown teardown order ${JSON.stringify(order)}`);
  }

  // The process home is the "real home" for this criterion: it is what
  // `os.homedir()` answers, which is the path a class field that fell back to it
  // would write into. It is read before anything is armed, and again after
  // teardown, so the two readings bracket the whole run.
  const processHome = os.homedir();
  const homeBefore = readHomeAccounting(processHome);

  const gate = readDebugAgentGate();
  const gateRoot = getDebugAgentProjectsRoot();
  if (!gate.enabled || !gateRoot) {
    throw new Error(`this arm needs the gate open and rooted; gate said ${JSON.stringify(gate)}`);
  }

  await initializeDatabase();

  const scenario = {
    version: 1 as const,
    dialect: 'claude' as const,
    home: 'gate' as const,
    transcript: { mode: 'per-row-jsonl' as const },
    seed: { title: 'fixture isolation', userText: SEED_USER_TEXT },
    steps: [{ at: 0, op: 'row' as const, role: 'assistant' as const, text: ROW_TEXT }],
    expect: { rows: { delta: 1 }, content: { mustContain: [ROW_TEXT] } },
  };

  const armed = await armDebugAgentScenario({
    projectPath: path.join(gateRoot, 'workspace'),
    scenario,
    synchronizeTranscript: async (filePath: string) => {
      const result = await sessionSynchronizerService.synchronizeProviderFile(
        DEBUG_AGENT_PROVIDER_ID as never,
        filePath,
      );
      return result.sessionId;
    },
  });

  // A full production run: the runtime the chat path drives, with the product's
  // own normalizer behind it. Rows first, frames second (ADR-003 decision 4), so
  // by the time this resolves the artifact is on disk.
  const frames: unknown[] = [];
  await providerRuntimeService.run(
    DEBUG_AGENT_PROVIDER_ID as never,
    'chat',
    { sessionId: armed.sessionId },
    { send: (frame: unknown) => frames.push(frame), setSessionId: () => {} } as never,
  );

  // ---- (1) the artifacts, read while they are still on disk ----
  const artifactsUnderGateRoot = listTree(gateRoot);
  const transcriptUnderGateRoot =
    path.resolve(armed.transcriptPath).startsWith(`${path.resolve(gateRoot)}${path.sep}`);
  const transcriptExists = fs.existsSync(armed.transcriptPath);
  const transcriptRows = transcriptExists ? readTranscriptRows(armed.transcriptPath).length : 0;
  const artifactUnderProcessHome = path
    .resolve(armed.transcriptPath)
    .startsWith(`${path.resolve(processHome)}${path.sep}`);

  const rowIndexedBeforeConverge = Boolean(sessionsDb.getSessionByProviderSessionId(armed.providerSessionId));

  // ---- teardown: the artifact goes first, then the index converges, then the
  // root. The reversed arm swaps the last two, which is the wrong order the ADR
  // names: a row is only reclaimable while its directory still exists.
  fs.rmSync(armed.transcriptPath);

  const rootExistedBeforeTeardown = fs.existsSync(gateRoot);
  let rootExistedAtConverge = false;
  let prunedOrphans = 0;
  let pruneFailures: string[] = [];

  const converge = async (): Promise<void> => {
    const result = await sessionSynchronizerService.synchronizeSessions();
    prunedOrphans = result.prunedOrphans;
    pruneFailures = result.failures;
  };

  if (order === 'converge-then-remove') {
    rootExistedAtConverge = fs.existsSync(gateRoot);
    await converge();
    // Only now is the root removed — the order the boundary semantics require.
    fs.rmSync(gateRoot, { recursive: true, force: true });
  } else {
    fs.rmSync(gateRoot, { recursive: true, force: true });
    rootExistedAtConverge = fs.existsSync(gateRoot);
    await converge();
  }

  const rowIndexedAfterConverge = Boolean(sessionsDb.getSessionByProviderSessionId(armed.providerSessionId));
  const rootExistsAfterTeardown = fs.existsSync(gateRoot);
  // Belt and braces: the wrong order leaves the directory in place for the
  // convergence step, so a build that removed it anyway is still caught here.
  if (fs.existsSync(gateRoot)) {
    fs.rmSync(gateRoot, { recursive: true, force: true });
  }

  const processHomeProjectsRoot = path.join(processHome, '.claude', 'projects');

  return {
    mode,
    gate,
    isolation: {
      gateRoot,
      transcriptPath: armed.transcriptPath,
      projectPath: armed.projectPath,
      transcriptUnderGateRoot,
      transcriptExists,
      transcriptRows,
      expectedRows: EXPECTED_ROWS,
      artifactsUnderGateRoot,
    },
    home: {
      path: processHome,
      before: homeBefore,
      after: readHomeAccounting(processHome),
      artifactUnderProcessHome,
      processHomeProjectsRoot,
      processHomeProjectsRootExistsAfter: fs.existsSync(processHomeProjectsRoot),
      processHomeClaudeEntriesAfter: listTree(path.join(processHome, '.claude')),
    },
    teardown: {
      fixtureRoot: gateRoot,
      rootExistedBeforeTeardown,
      rootExistsAfterTeardown,
    },
    order: {
      order,
      rootExistedAtConverge,
      rowIndexedBeforeConverge,
      prunedOrphans,
      pruneFailures,
      rowIndexedAfterConverge,
    },
    session: { sessionId: armed.sessionId, providerSessionId: armed.providerSessionId },
    output: { frames: frames.length },
    tookMs: Date.now() - startedAt,
  };
}

// --------------------------- parent process ---------------------------

type ChildRun =
  | { ok: true; reading: FixtureIsolationReading }
  | { ok: false; stdout: string; stderr: string; error: string };

/**
 * Runs one arm in a child.
 *
 * `HOME` is redirected into a scratch directory and `DATABASE_PATH` points inside
 * it, so no arm can reach the machine's real `~/.claude` or its real database —
 * including the arm that is supposed to do work. The gate variables are cleared
 * from the inherited environment before being set, so a value the caller happened
 * to export cannot decide an arm. The fixture home is a third directory inside the
 * same scratch, except in the `real-home` arm, where pointing it at the process
 * home IS the falsification.
 */
function runChild(mode: ChildMode): Promise<ChildRun> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), `debug-agent-fixture-isolation-${mode}-`));
  const home = path.join(scratch, 'home');
  const fixtureHome = path.join(scratch, 'fixture');
  // Created empty on purpose: the criterion reads this directory's accounting, and
  // a directory that does not exist has no reading to compare against.
  mkdirSync(home, { recursive: true });

  const databasePath = path.join(scratch, 'fixture-isolation.db');
  writeFileSync(databasePath, '');

  const config = MODES[mode];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_PATH: databasePath,
    [PROBE_VAR]: '1',
    [MODE_VAR]: mode,
    [ORDER_VAR]: config.order,
  };
  delete env[GATE_VAR];
  delete env[GATE_HOME_VAR];
  env[GATE_VAR] = 'on';
  env[GATE_HOME_VAR] = config.fixtureHome === 'process-home' ? home : fixtureHome;

  return new Promise<ChildRun>((resolve) => {
    execFile(
      process.execPath,
      [TSX_CLI, '--tsconfig', 'server/tsconfig.json', SELF],
      { cwd: REPO_ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: CHILD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';
        const line = out
          .split('\n')
          .filter((entry) => entry.startsWith(PROBE_MARKER))
          .pop();

        if (!line) {
          resolve({
            ok: false,
            stdout: out,
            stderr: err,
            error: error ? `${error.name}: ${error.message}` : 'the probe child printed no reading',
          });
          return;
        }

        resolve({ ok: true, reading: JSON.parse(line.slice(PROBE_MARKER.length)) as FixtureIsolationReading });
      },
    );
  }).finally(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
}

/** The reading, or a red carrying the child's own output so a failure is readable. */
function requireReading(run: ChildRun, arm: string): FixtureIsolationReading {
  if (!run.ok) {
    throw new Error(
      `${arm}: the probe child printed no reading (${run.error})\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    );
  }

  return run.reading;
}

// --------------------------- the criterion ---------------------------

type Verdict = { failures: string[]; steps: string[] };

/**
 * The criterion, as one function so every arm is judged by the same code.
 *
 * `homeAccounting` is AC4's contrast, not a convenience: with it off, item (2) is
 * replaced by item (3), i.e. by "the fixture root was deleted". The two are not the
 * same reading, and the contrast below is what shows it — the `real-home` arm is
 * caught by (2) and completely missed by a criterion that only asks whether the
 * directory was cleaned up.
 */
function evaluateCriterion(reading: FixtureIsolationReading, options: { homeAccounting: boolean }): Verdict {
  const { isolation, home, teardown, order } = reading;
  const failures: string[] = [];
  const steps: string[] = [];

  // ---- (1) the artifacts are under the root the gate named ----
  if (!isolation.transcriptUnderGateRoot) {
    failures.push(
      `(1) the run's transcript ${isolation.transcriptPath} is not under the gate root ${JSON.stringify(isolation.gateRoot)}, so the fixture root the gate named is not where the artifact landed`,
    );
  }
  if (!isolation.transcriptExists) {
    failures.push(`(1) the run's transcript ${isolation.transcriptPath} is not on disk`);
  }
  if (isolation.transcriptRows !== isolation.expectedRows) {
    failures.push(
      `(1) the transcript has ${isolation.transcriptRows} row(s); the seed (${SEED_ROWS}) plus the scenario's one row step is ${isolation.expectedRows}`,
    );
  }
  steps.push(
    `(1) gate root ${isolation.gateRoot ?? '<none>'}; transcript under it: ${isolation.transcriptUnderGateRoot}; on disk: ${isolation.transcriptExists} with ${isolation.transcriptRows}/${isolation.expectedRows} row(s); ${isolation.artifactsUnderGateRoot.length} path(s) under the root: ${JSON.stringify(isolation.artifactsUnderGateRoot)}`,
  );

  // ---- (2) the real home gained nothing ----
  if (!options.homeAccounting) {
    steps.push(
      `(2) [REPLACED BY (3)] the home accounting is not part of this verdict: ${home.path} entries ${home.before.entries} -> ${home.after.entries}, latest mtime ${home.before.latestMtimeMs} -> ${home.after.latestMtimeMs}`,
    );
  } else {
    if (home.after.entries !== home.before.entries) {
      failures.push(
        `(2) the real home gained entries during this run: ${home.path} went from ${home.before.entries} to ${home.after.entries} (${JSON.stringify(home.processHomeClaudeEntriesAfter)} left under .claude)`,
      );
    }
    if (home.after.latestMtimeMs !== home.before.latestMtimeMs) {
      failures.push(
        `(2) the real home's latest modification time moved during this run: ${home.path} ${home.before.latestMtimeMs} -> ${home.after.latestMtimeMs}`,
      );
    }
    if (home.artifactUnderProcessHome) {
      failures.push(
        `(2) the run's transcript ${isolation.transcriptPath} sits under the real home ${home.path}; the fixture root must come from the gate variable and never from os.homedir()`,
      );
    }
    if (home.processHomeProjectsRootExistsAfter) {
      failures.push(
        `(2) ${home.processHomeProjectsRoot} exists after the run, which is where a class field reading os.homedir() writes`,
      );
    }
    steps.push(
      `(2) real home ${home.path}: entries ${home.before.entries} -> ${home.after.entries}, latest mtime ${home.before.latestMtimeMs} -> ${home.after.latestMtimeMs}; transcript under the home: ${home.artifactUnderProcessHome}; ${home.processHomeProjectsRoot} exists after: ${home.processHomeProjectsRootExistsAfter}; ${JSON.stringify(home.processHomeClaudeEntriesAfter)} left under .claude`,
    );
  }

  // ---- (3) the fixture root is gone, whole ----
  if (!teardown.rootExistedBeforeTeardown) {
    failures.push(`(3) the fixture root ${teardown.fixtureRoot ?? '<none>'} did not exist before teardown, so the deletion below is vacuous`);
  }
  if (teardown.rootExistsAfterTeardown) {
    failures.push(`(3) the fixture root ${teardown.fixtureRoot ?? '<none>'} still exists after teardown; it must be removed whole`);
  }
  steps.push(
    `(3) fixture root ${teardown.fixtureRoot ?? '<none>'}: existed before teardown ${teardown.rootExistedBeforeTeardown}, exists after ${teardown.rootExistsAfterTeardown}`,
  );

  // ---- (4) the index converged while the root still existed ----
  if (!order.rootExistedAtConverge) {
    failures.push(
      `(4) the fixture root was already gone when the index was converged (order: ${order.order}); pruneOrphanedSessions only drops a row while its containing directory still exists, so this order can never reclaim it`,
    );
  }
  if (!order.rowIndexedBeforeConverge) {
    failures.push(
      `(4) the session was not in the index before the convergence step, so "the row was reclaimed" would be vacuous`,
    );
  }
  if (order.rowIndexedAfterConverge) {
    failures.push(
      `(4) the index row for session ${reading.session.providerSessionId} was still in the sessions index after the convergence step (prunedOrphans=${order.prunedOrphans}, order: ${order.order}); the cleanup order must let the index converge before the root goes`,
    );
  }
  if (order.prunedOrphans < 1) {
    failures.push(
      `(4) the convergence step reclaimed no row (prunedOrphans=${order.prunedOrphans}, failures=${JSON.stringify(order.pruneFailures)}), so nothing shows the row could be reclaimed in this order`,
    );
  }
  steps.push(
    `(4) order ${order.order}: row indexed before converge ${order.rowIndexedBeforeConverge}; root existed at converge ${order.rootExistedAtConverge}; prunedOrphans ${order.prunedOrphans}; row indexed after converge ${order.rowIndexedAfterConverge}; prune failures ${JSON.stringify(order.pruneFailures)}`,
  );

  return { failures, steps };
}

/** Prints every reading the criterion is built on, so a run is auditable from its output. */
function describe(reading: FixtureIsolationReading): string {
  const verdict = evaluateCriterion(reading, { homeAccounting: true });
  const weakened = evaluateCriterion(reading, { homeAccounting: false });

  return [
    `[mode] ${reading.mode} (${reading.tookMs}ms)`,
    `[gate] ${reading.gate.enabled ? 'OPEN' : 'CLOSED'} (${reading.gate.reason}); fixture home=${reading.gate.home ?? '<none>'}`,
    `[run] ${reading.output.frames} frame(s) handed to the runtime's writer for session ${reading.session.sessionId}`,
    ...verdict.steps,
    `[criterion] failures=${JSON.stringify(verdict.failures)}`,
    `[criterion, home accounting replaced by (3)] failures=${JSON.stringify(weakened.failures)}`,
  ].join('\n');
}

if (process.env[PROBE_VAR] === '1') {
  // Child mode: take the reading for this arm, print one line, exit.
  const mode = process.env[MODE_VAR] as ChildMode | undefined;
  if (mode !== 'isolated' && mode !== 'real-home' && mode !== 'reversed-order') {
    throw new Error(`unknown probe mode ${JSON.stringify(mode)}`);
  }

  const reading = await readFixtureIsolation(mode);
  console.log(`${PROBE_MARKER}${JSON.stringify(reading)}`);
} else {
  // Three arms, started together: each is almost entirely module load plus one
  // scenario walk, and they share nothing — separate scratch HOME, separate
  // fixture root, separate database, separate index.
  const runs = {
    honest: runChild('isolated'),
    realHome: runChild('real-home'),
    reversedOrder: runChild('reversed-order'),
  };
  registerCriteria(runs);
}

function registerCriteria(runs: {
  honest: Promise<ChildRun>;
  realHome: Promise<ChildRun>;
  reversedOrder: Promise<ChildRun>;
}): void {
  test('the fixture root comes from the gate, the real home is untouched, and teardown converges the index before it removes the root', async () => {
    const reading = requireReading(await runs.honest, 'honest');
    console.log(describe(reading));

    // The premises, asserted rather than assumed: this arm had a gate root, it
    // was not the process home, and the run really produced output. Without them
    // every reading below would pass for a build that did nothing at all.
    assert.equal(reading.gate.enabled, true, 'this arm needs the gate open');
    assert.notEqual(reading.isolation.gateRoot, null, 'the gate must have named a fixture root');
    assert.equal(RUN_MODE_IS_HONEST(reading), true, `this arm must run the honest configuration (${reading.mode})`);
    assert.ok(reading.output.frames > 0, 'the run must have produced output, or the readings are about nothing');

    const verdict = evaluateCriterion(reading, { homeAccounting: true });

    // ---- (2) is the reading this criterion exists for: the real home's own
    // accounting, not a conclusion drawn from "the fixture was cleaned up" ----
    assert.ok(
      reading.home.before.entries === reading.home.after.entries,
      `the real home must gain no entries: ${reading.home.before.entries} -> ${reading.home.after.entries} (${JSON.stringify(reading.home.processHomeClaudeEntriesAfter)} left under .claude)`,
    );
    assert.equal(
      reading.home.after.latestMtimeMs,
      reading.home.before.latestMtimeMs,
      `the real home's latest mtime must not move: ${reading.home.before.latestMtimeMs} -> ${reading.home.after.latestMtimeMs}`,
    );
    assert.equal(
      reading.home.artifactUnderProcessHome,
      false,
      'the run must not write under the process home',
    );

    // ---- (3) and (4), through the shared criterion ----
    assert.deepEqual(verdict.failures, [], `the criterion must be clean:\n${verdict.failures.join('\n')}`);

    // The item (4) readings, spelled out here as well because they are the ones
    // a criterion written in prose would get wrong.
    assert.equal(reading.order.rowIndexedBeforeConverge, true, 'the session must be in the index before the convergence step');
    assert.equal(reading.order.rootExistedAtConverge, true, 'the root must outlive the convergence step');
    assert.ok(reading.order.prunedOrphans >= 1, `the convergence step must reclaim the row (prunedOrphans=${reading.order.prunedOrphans})`);
    assert.equal(reading.order.rowIndexedAfterConverge, false, 'and the row must be gone afterwards');
  });

  test('anti-fake: pointing the fixture root at the real home reds item (2), not item (1) or item (3)', async () => {
    const reading = requireReading(await runs.realHome, 'real-home');
    console.log(describe(reading));

    const verdict = evaluateCriterion(reading, { homeAccounting: true });

    // The fake is a GOOD fake: the run really produces its artifacts, and it
    // really tears its root down. Nothing below would be a fair comparison
    // against a fake that simply failed to write.
    assert.ok(reading.output.frames > 0, 'the fake must actually run, or it proves nothing about the criterion');
    assert.equal(reading.isolation.transcriptRows, EXPECTED_ROWS, 'the fake must really write the transcript');
    assert.equal(reading.teardown.rootExistsAfterTeardown, false, 'and it must really remove its root');

    // The red is on (2) — the real home gained what the fixture wrote.
    assert.ok(
      verdict.failures.some((failure) => failure.startsWith('(2)')),
      `this variant must fail on (2); failures were ${JSON.stringify(verdict.failures)}`,
    );
    assert.notEqual(
      reading.home.after.entries,
      reading.home.before.entries,
      'and the reading behind (2) must be a real change, not a criterion artefact',
    );

    // ...and NOT on (1) or (3). This is the load-bearing half: a red on (3)
    // would mean the criterion is catching "it did not clean up" rather than
    // "it wrote to the wrong place", and the ADR's incident is the latter.
    assert.deepEqual(
      verdict.failures.filter((failure) => failure.startsWith('(1)')),
      [],
      `the variant must not fail on (1): the artifacts are still under the gate root — the root moved${JSON.stringify(verdict.failures)}`,
    );
    assert.deepEqual(
      verdict.failures.filter((failure) => failure.startsWith('(3)')),
      [],
      `the variant must not fail on (3): the fixture root really is removed${JSON.stringify(verdict.failures)}`,
    );
    // (4) is clean too: this fake converges before it removes.
    assert.deepEqual(
      verdict.failures.filter((failure) => failure.startsWith('(4)')),
      [],
      `the variant must not fail on (4)${JSON.stringify(verdict.failures)}`,
    );
  });

  test('anti-fake: removing the root before the index converges reds item (4), naming the leftover index row', async () => {
    const reading = requireReading(await runs.reversedOrder, 'reversed-order');
    console.log(describe(reading));

    const verdict = evaluateCriterion(reading, { homeAccounting: true });

    assert.equal(reading.order.order, 'remove-then-converge', 'this arm must run the reversed order');
    assert.equal(reading.order.rootExistedAtConverge, false, 'the root must already be gone at the convergence step');
    assert.equal(
      reading.order.rowIndexedAfterConverge,
      true,
      'the wrong order must leave the index row behind — that is the failure the order rule exists for',
    );

    const item4 = verdict.failures.filter((failure) => failure.startsWith('(4)'));
    assert.ok(item4.length > 0, `this variant must fail on (4); failures were ${JSON.stringify(verdict.failures)}`);
    assert.ok(
      item4.some((failure) => failure.includes(reading.session.providerSessionId)),
      `the (4) failure must name the leftover index row; failures were ${JSON.stringify(item4)}`,
    );

    // Everything else is clean: this fake writes in the right place and removes
    // its root, so a red elsewhere would mean the items are not separable.
    for (const prefix of ['(1)', '(2)', '(3)']) {
      assert.deepEqual(
        verdict.failures.filter((failure) => failure.startsWith(prefix)),
        [],
        `the reversed order must not fail on ${prefix}${JSON.stringify(verdict.failures)}`,
      );
    }
  });

  test('the home accounting is not the teardown reading: with item (2) replaced by item (3), the real-home fake passes unnoticed', async () => {
    const reading = requireReading(await runs.realHome, 'real-home');

    const full = evaluateCriterion(reading, { homeAccounting: true });
    const weakened = evaluateCriterion(reading, { homeAccounting: false });

    // The fake is caught by (2) ...
    assert.ok(
      full.failures.some((failure) => failure.startsWith('(2)')),
      `the full criterion must catch the fake on (2); failures were ${JSON.stringify(full.failures)}`,
    );
    // ... and completely missed once (2) is replaced by (3): the criterion that
    // only asks "was the directory deleted" is green here, against the very build
    // that wrote into the real home. That is the contrast AC4 is about — the two
    // readings are not the same thing.
    assert.deepEqual(
      weakened.failures,
      [],
      `a criterion that only asserts the root was deleted must be blind to this fake; failures were ${JSON.stringify(weakened.failures)}`,
    );
    assert.ok(
      weakened.steps.some((step) => step.includes('[REPLACED BY (3)]')),
      'and the weakened verdict must say that the home accounting was replaced rather than checked',
    );
  });
}

/** The honest arm is the one whose configuration the two switches decide. */
function RUN_MODE_IS_HONEST(reading: FixtureIsolationReading): boolean {
  return reading.mode === 'isolated';
}
