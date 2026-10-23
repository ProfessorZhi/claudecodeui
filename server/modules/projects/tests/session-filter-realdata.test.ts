/**
 * Real-data landing criterion for the per-project session-name filter (GOAL-002 / AC-102).
 *
 * Unlike the neighbouring `projects-session-filter.integration.test.ts`, which drives a
 * hand-built 30-row fixture, this file runs against a **read-only snapshot of this machine's
 * real store** (`~/.cloudcli/auth.db`). The original file is never opened for writing: the
 * snapshot is taken through SQLite's own online backup API from a read-only connection, and
 * `DATABASE_PATH` is pointed at the copy, so the real store stays untouched even though the
 * test writes a project rule through the production PUT route.
 *
 * Every expected number is derived from that snapshot at run time. What is pinned is the
 * *contract*: the read paths must agree with the independently recomputed hidden/visible
 * split — exactly, not merely approximately — because hiding a human's own session is as much
 * a failure as leaking an auto session.
 *
 * Two properties this criterion has to hold to stay usable as an instrument:
 *
 *  1. **The snapshot is a consistent point, not a copy of a live file.** This store runs
 *     `journal_mode=delete`, so a writer that is mid-commit keeps its uncommitted state in the
 *     rollback journal (`auth.db-journal`) and not in the `-wal`/`-shm` sidecars; a hand-rolled
 *     file copy can therefore capture half a transaction. The backup API reads the source
 *     through a read transaction, so no concurrent commit can tear the snapshot, whatever the
 *     journal mode is.
 *  2. **No assertion's truth may depend on which sessions this machine touched most recently.**
 *     The paginated reader orders by `datetime(COALESCE(updated_at, created_at)) DESC`, so the
 *     head of the real stream is a moving property of the machine's live activity: a criterion
 *     that asserts "the newest real page mixes hidden and visible rows" flips red and green on
 *     an unchanged tree. Everything the assertions need is located in the snapshot's own order
 *     instead, so the verdict is a function of the filter mechanism and not of today's data.
 *
 * A failure must also be attributable: the first line this file writes to stderr is
 * `__REALDATA_FAIL__ <cause> [readings: ...]`, which still names the cause in an excerpt that
 * clips everything after it.
 *
 * Missing real store => hard failure, never `skip`: the criterion is worthless if it silently
 * passes where the data it claims to measure does not exist.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { searchConversations, sessionsService } from '@/modules/providers/index.js';
import projectsRoutes from '@/modules/projects/projects.routes.js';

/** The rule the operator sets for the claudecodeui project in the real app. */
const HIDE_RULE = '-(task-worker|selector|fix-worker)$';
/** Same rule, recompiled here so the expectation never borrows the code under test. */
const AUTO_SESSION_REGEX = /-(?:task-worker|selector|fix-worker)$/i;
const REAL_DATABASE_PATH = path.join(homedir(), '.cloudcli', 'auth.db');
const PAGE_SIZE = 5;
const MAX_TITLE_RESULTS = 200;
const PAGINATION_GUARD = 10_000;
/** Leading token of every line this file writes to stderr when something fails. */
const FAILURE_MARKER = '__REALDATA_FAIL__';
/** Upper bound on the cause carried by that line — a gate excerpt clips it, so keep it short. */
const CAUSE_MAX_CHARS = 300;

type SessionRow = { session_id: string; custom_name?: string | null };

type SessionSummary = { id: string; provider: string; summary: string; lastActivity: string };

type Page = {
  sessions: SessionSummary[];
  sessionMeta: { total: number; hasMore: boolean; hiddenCount: number };
  hiddenCount: number;
};

/** A row of the snapshot plus the title every read path reports for it. */
type SessionProbe = {
  id: string;
  title: string;
  /** How many rows of the snapshot the title search matches for this title — its window is capped. */
  matches: number;
};

type Expectation = {
  projectPath: string;
  projectId: string;
  /** Every non-archived session of the project, ordered exactly as the SQL reader orders it. */
  allIds: string[];
  hiddenIds: string[];
  visibleIds: string[];
  /** The rows the title-search read path is asserted on, picked from the snapshot. */
  hiddenProbe: SessionProbe;
  visibleProbe: SessionProbe;
};

type RealDataContext = {
  baseUrl: string;
  expectation: Expectation;
  projectId: string;
  /** Re-opens the SQLite connection against the same snapshot, simulating an app restart. */
  reopenDatabase: () => Promise<void>;
};

/**
 * Readings in force when a failure fired, appended to the marker line so an excerpt that keeps
 * only that line still carries the numbers the verdict was formed on.
 */
let currentReadings = '';

function noteReadings(readings: string): void {
  currentReadings = readings;
}

/**
 * Writes the one-line cause of a failure to the stream the caller captures, then the caller
 * rethrows so the test still fails.
 *
 * `node --test` runs each file in a child process whose stdout *and* stderr are piped back into
 * the runner's stdout, so a `console.error` from inside a test never reaches the stderr an outer
 * caller sees — and quay's acceptance runner folds only stderr into a failure reason, which is
 * how a red criterion ends up recorded as "no attributable cause". Writing to the runner's own
 * stderr fd keeps the cause on the stream the gate reads; when that fd is unreachable (a runner
 * that closed it, or a platform without `/proc`) the line goes to our own stderr instead of
 * being dropped.
 */
function reportCause(cause: string): void {
  const clipped = cause.length > CAUSE_MAX_CHARS ? `${cause.slice(0, CAUSE_MAX_CHARS)}…` : cause;
  const line = `${FAILURE_MARKER} ${clipped}${currentReadings}\n`;
  try {
    const runnerStderr = fs.openSync(`/proc/${process.ppid}/fd/2`, 'a');
    try {
      fs.writeSync(runnerStderr, line);
    } finally {
      fs.closeSync(runnerStderr);
    }
  } catch {
    process.stderr.write(line);
  }
}

/** First line of a thrown value's message: the marker line has to stay one readable line. */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? '';
}

/** Shortens a free-form title for the marker line, which is clipped by the gate's excerpt. */
function clip(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Runs a criterion body, making any failure attributable before it propagates. */
async function attributable(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    reportCause(firstLine(error));
    throw error;
  }
}

/**
 * The title the read paths report for a row — `custom_name` when it is non-empty, the session id
 * otherwise. Mirrored from the provider search's own projection (`toSummaryText`) so the
 * expectation never borrows the code under test.
 */
function projectedTitle(row: SessionRow): string {
  const customName = typeof row.custom_name === 'string' ? row.custom_name.trim() : '';
  if (customName) {
    return customName;
  }
  const fallback = typeof row.session_id === 'string' ? row.session_id.trim() : '';
  if (!fallback) {
    return row.session_id;
  }
  return fallback.length > 50 ? `${fallback.slice(0, 50)}...` : fallback;
}

function resolveRealProjectPath(): string {
  const override = process.env.SESSION_FILTER_REALDATA_PROJECT_PATH?.trim();
  if (override) {
    return override;
  }

  const rows = projectsDb.getProjectPaths() as Array<{ project_path: string }>;
  const match = rows.find((row) => /\/claudecodeui\/?$/.test(row.project_path.trim()));
  assert.ok(
    match,
    `no project row ending in "/claudecodeui" in the copied real store; set SESSION_FILTER_REALDATA_PROJECT_PATH to pick another one`,
  );
  return match.project_path;
}

/**
 * Takes a transactionally consistent snapshot of the real store and returns the temp copy.
 *
 * The live store is opened read-only (`SQLITE_OPEN_READONLY`, i.e. `mode=ro`) and the copy is
 * streamed out of it by SQLite's online backup API, which reads the source through a read
 * transaction: a writer committing mid-copy cannot produce a torn snapshot, and no sidecar has
 * to be remembered by hand. Fails closed when the real store is absent.
 */
async function takeRealSnapshot(): Promise<{ directory: string; databasePath: string }> {
  try {
    const info = await stat(REAL_DATABASE_PATH);
    assert.ok(info.isFile() && info.size > 0, 'not a non-empty file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `real store unavailable at ${REAL_DATABASE_PATH} (${code})\n${detail}\n` +
        'this criterion must run on a read-only snapshot of the real database and deliberately fails closed instead of skipping',
    );
  }

  const directory = await mkdtemp(path.join(tmpdir(), 'session-filter-realdata-'));
  const databasePath = path.join(directory, 'auth.db');
  const source = new Database(REAL_DATABASE_PATH, { readonly: true, fileMustExist: true });
  try {
    await source.backup(databasePath);
  } finally {
    source.close();
  }

  return { directory, databasePath };
}

/**
 * Picks the row the title-search path is asserted on.
 *
 * The search caps its window at `MAX_TITLE_RESULTS` and sorts it by match position and then by
 * recency, so a title shared by more rows than the cap could push the asserted row out of the
 * window — a verdict that depends on how many same-named sessions the store happens to hold.
 * Choosing the *rarest* title of the family (and the newest row carrying it) keeps the asserted
 * row at the head of a short window for any snapshot, not just for today's row counts. Match
 * counting mirrors the search's own rule: a row counts when its title *contains* the query.
 */
function pickProbe(family: SessionRow[], allRows: SessionRow[]): SessionProbe {
  const titles = [...new Set(family.map((row) => projectedTitle(row)))];
  const countMatches = (title: string): number => {
    const needle = title.toLocaleLowerCase();
    return allRows.filter((row) => projectedTitle(row).toLocaleLowerCase().includes(needle)).length;
  };

  let best = titles[0];
  let bestMatches = Number.POSITIVE_INFINITY;
  for (const title of titles) {
    const matches = countMatches(title);
    if (matches < bestMatches) {
      best = title;
      bestMatches = matches;
    }
  }

  // `family` arrives in the SQL reader's order, so the first row carrying the rarest title is
  // also the newest one — the head of the search's window for that title.
  const row = family.find((candidate) => projectedTitle(candidate) === best);
  assert.ok(row, `no row of the snapshot carries the picked title ${best}`);
  return { id: row.session_id, title: best, matches: bestMatches };
}

/**
 * Recomputes the hidden/visible split straight from the snapshot, using an independently
 * compiled regex over the session names. This is the number the read paths must reproduce; it
 * shares no code with the SQL visibility clause under test.
 */
function deriveExpectation(projectId: string, projectPath: string): Expectation {
  const rows = sessionsDb.getSessionsByProjectPathPage(
    projectPath,
    Number.MAX_SAFE_INTEGER,
    0,
  ) as SessionRow[];
  const allIds = rows.map((row) => row.session_id);
  const isAuto = (row: SessionRow): boolean => AUTO_SESSION_REGEX.test(row.custom_name ?? '');
  const hiddenRows = rows.filter(isAuto);
  const visibleRows = rows.filter((row) => !isAuto(row));
  const hiddenIds = hiddenRows.map((row) => row.session_id);
  const visibleIds = visibleRows.map((row) => row.session_id);

  assert.ok(allIds.length > 0, `the real store holds no sessions for ${projectPath}`);
  assert.ok(hiddenIds.length > 0, `no session of ${projectPath} matches ${HIDE_RULE}; the criterion would be vacuous`);
  assert.ok(visibleIds.length > 0, `every session of ${projectPath} matches ${HIDE_RULE}; the rule would be over-broad`);

  const allRows = sessionsDb.getAllSessions() as SessionRow[];
  return {
    projectPath,
    projectId,
    allIds,
    hiddenIds,
    visibleIds,
    hiddenProbe: pickProbe(hiddenRows, allRows),
    visibleProbe: pickProbe(visibleRows, allRows),
  };
}

async function withRealDatabase(run: (context: RealDataContext) => Promise<void>): Promise<void> {
  const { directory, databasePath } = await takeRealSnapshot();
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const projectPath = resolveRealProjectPath();
  const project = projectsDb.getProjectPath(projectPath);
  assert.ok(project, `project row missing for ${projectPath} in the copied real store`);
  const expectation = deriveExpectation(project.project_id, projectPath);

  const readings =
    ` [readings: project=${projectPath} total=${expectation.allIds.length}` +
    ` hidden=${expectation.hiddenIds.length} visible=${expectation.visibleIds.length}` +
    ` hiddenProbe="${clip(expectation.hiddenProbe.title)}"#${expectation.hiddenProbe.matches}` +
    ` visibleProbe="${clip(expectation.visibleProbe.title)}"#${expectation.visibleProbe.matches}]`;
  noteReadings(readings);
  console.log(`__REALDATA__${readings}`);

  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoutes);
  app.use((error: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ error: { message: error.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      expectation,
      projectId: project.project_id,
      reopenDatabase: async () => {
        closeConnection();
        await initializeDatabase();
      },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

async function putFilter(baseUrl: string, projectId: string, hide: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/projects/${projectId}/session-filter`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hide }),
  });
}

async function getPage(baseUrl: string, projectId: string, query: string): Promise<Page> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/sessions?${query}`);
  assert.equal(response.status, 200, `GET sessions?${query} answered ${response.status}`);
  return response.json() as Promise<Page>;
}

/** Walks every page of a query and returns the collected rows in stream order. */
async function readAllPages(
  baseUrl: string,
  projectId: string,
  query: string,
  expectedTotal: number,
): Promise<SessionSummary[]> {
  const collected: SessionSummary[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    assert.ok(offset < PAGINATION_GUARD, `pagination did not terminate after ${offset} rows`);
    const page = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=${offset}${query}`);
    assert.equal(page.sessionMeta.total, expectedTotal, 'total must stay constant across pages');
    assert.equal(page.hiddenCount, page.sessionMeta.hiddenCount, 'top-level hiddenCount must mirror sessionMeta');
    collected.push(...page.sessions);
    if (!page.sessionMeta.hasMore) break;
  }
  return collected;
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

test('real-data: the rule set through the PUT route hides exactly the auto sessions on every read path', () =>
  attributable(async () => {
    await withRealDatabase(async ({ baseUrl, projectId, expectation, reopenDatabase }) => {
      const saved = await putFilter(baseUrl, projectId, [HIDE_RULE]);
      assert.equal(saved.status, 200, 'the real PUT route must accept the rule');

      // --- read path 1: paginated project session list over real HTTP ----------
      const visible = await readAllPages(baseUrl, projectId, '', expectation.visibleIds.length);
      const visibleIds = visible.map((session) => session.id);

      assert.deepEqual(
        sorted(visibleIds),
        sorted(expectation.visibleIds),
        'the visible page set must equal the independently recomputed visible set — no extra session, none dropped',
      );
      assert.equal(new Set(visibleIds).size, visibleIds.length, 'paging must not repeat a session');
      for (const session of visible) {
        assert.ok(
          !AUTO_SESSION_REGEX.test(session.summary),
          `auto session ${session.id} (${session.summary}) leaked into the visible list`,
        );
      }

      const firstPage = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);
      assert.equal(firstPage.sessionMeta.hiddenCount, expectation.hiddenIds.length);
      assert.equal(
        firstPage.sessionMeta.hasMore,
        PAGE_SIZE < expectation.visibleIds.length,
        'hasMore must describe the filtered stream, not the unfiltered one',
      );

      // --- includeHidden restores the full store ---------------------------------
      const unfiltered = await readAllPages(
        baseUrl,
        projectId,
        '&includeHidden=true',
        expectation.allIds.length,
      );
      assert.deepEqual(
        sorted(unfiltered.map((session) => session.id)),
        sorted(expectation.allIds),
        'includeHidden=true must return every real session of the project, hidden ones included',
      );
      const unfilteredFirstPage = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0&includeHidden=true`);
      assert.equal(unfilteredFirstPage.sessionMeta.hiddenCount, 0, 'nothing is hidden when includeHidden=true');
      assert.deepEqual(
        unfilteredFirstPage.sessions.map((session) => session.id),
        expectation.allIds.slice(0, PAGE_SIZE),
        'the unfiltered first page must be the newest real sessions, in the order the SQL reader produces',
      );

      // --- keepSessionIds: a running auto session stays visible ------------------
      const runningAutoSessionId = expectation.hiddenIds[0];
      const kept = await getPage(
        baseUrl,
        projectId,
        `limit=${PAGE_SIZE}&offset=0&keepSessionIds=${encodeURIComponent(runningAutoSessionId)}`,
      );
      assert.equal(kept.sessionMeta.total, expectation.visibleIds.length + 1, 'a kept session joins the visible total');
      assert.equal(kept.sessionMeta.hiddenCount, expectation.hiddenIds.length - 1, 'a kept session stops being counted hidden');
      const keptIds: string[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await getPage(
          baseUrl,
          projectId,
          `limit=${PAGE_SIZE}&offset=${offset}&keepSessionIds=${encodeURIComponent(runningAutoSessionId)}`,
        );
        keptIds.push(...page.sessions.map((session) => session.id));
        if (!page.sessionMeta.hasMore) break;
      }
      assert.deepEqual(
        sorted(keptIds),
        sorted([...expectation.visibleIds, runningAutoSessionId]),
        'keepSessionIds must add exactly the listed session and nothing else',
      );

      // --- read path 2: recent-session aggregation --------------------------------
      const recentProbe = sessionsService.listRecentSessions(1, 0);
      const recent = sessionsService.listRecentSessions(Math.max(recentProbe.total, 1), 0);
      const recentIds = new Set(recent.conversations.map((conversation) => conversation.sessionId));
      for (const hiddenId of expectation.hiddenIds) {
        assert.ok(!recentIds.has(hiddenId), `recent sessions leaked auto session ${hiddenId}`);
      }
      assert.equal(recent.conversations.length, recent.total, 'the recent window covers every visible session');
      for (const visibleId of expectation.visibleIds) {
        assert.ok(recentIds.has(visibleId), `recent sessions dropped the human session ${visibleId}`);
      }

      // --- read path 3: title search flags the hidden hits ------------------------
      // Both probes come from the snapshot: the query is the probe row's own title and the
      // assertion is about that row, so the precondition ("this project has a title the search
      // must match, and a human title it must not") can never be a statement about what the live
      // search happened to return first. A hit for the hidden probe is the flag the sidebar
      // relies on; a miss for the human probe is the same read path declining to over-hide.
      const hiddenSearch = await searchConversations(expectation.hiddenProbe.title, MAX_TITLE_RESULTS);
      const hiddenHit = hiddenSearch.titleResults.find((result) => result.sessionId === expectation.hiddenProbe.id);
      assert.ok(
        hiddenHit,
        `title search for the snapshot's own hidden title "${clip(expectation.hiddenProbe.title)}" (shared by ${expectation.hiddenProbe.matches} rows) returned no row for ${expectation.hiddenProbe.id}`,
      );
      assert.equal(hiddenHit.filtered, true, `the title search must flag the hidden row ${expectation.hiddenProbe.id}`);
      assert.equal(
        AUTO_SESSION_REGEX.test(hiddenHit.sessionTitle),
        true,
        `the title search reported "${hiddenHit.sessionTitle}" for a session the rule hides`,
      );

      const visibleSearch = await searchConversations(expectation.visibleProbe.title, MAX_TITLE_RESULTS);
      const visibleHit = visibleSearch.titleResults.find((result) => result.sessionId === expectation.visibleProbe.id);
      assert.ok(
        visibleHit,
        `title search for the snapshot's own human title "${clip(expectation.visibleProbe.title)}" (shared by ${expectation.visibleProbe.matches} rows) returned no row for ${expectation.visibleProbe.id}`,
      );
      assert.equal(visibleHit.filtered, false, `the title search must not flag the human row ${expectation.visibleProbe.id}`);

      const projectSessionIds = new Set(expectation.allIds);
      const projectTitleResults = hiddenSearch.titleResults.filter((result) => projectSessionIds.has(result.sessionId));
      assert.ok(projectTitleResults.length > 0, 'the title search must match the real auto sessions of this project');
      for (const result of projectTitleResults) {
        const matchesRule = AUTO_SESSION_REGEX.test(result.sessionTitle);
        assert.equal(
          result.filtered,
          matchesRule,
          `title search flagged ${result.sessionId} (${result.sessionTitle}) filtered=${result.filtered}`,
        );
        const isHidden = expectation.hiddenIds.includes(result.sessionId);
        assert.equal(matchesRule, isHidden, 'a title match is hidden exactly when the independently recomputed set says so');
      }

      // --- the rule outlives a database restart -----------------------------------
      await reopenDatabase();
      assert.equal(
        projectsDb.getProjectSessionFilterById(projectId),
        JSON.stringify({ hide: [HIDE_RULE] }),
        'the rule must still be stored after the connection is reopened',
      );
      const afterRestart = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);
      assert.equal(afterRestart.sessionMeta.total, expectation.visibleIds.length);
      assert.equal(afterRestart.sessionMeta.hiddenCount, expectation.hiddenIds.length);
    });
  }));

/**
 * Anti-fake guard, executable rather than narrated: the unfiltered stream is what a
 * client that filtered *after* pagination would see. Its first page is drawn from every
 * session and its total is the full store, so the assertions above (total == visible
 * count, hasMore describing the filtered stream) cannot hold for that shape.
 */
test('real-data: server-side filtering is what makes total/hasMore describe the visible stream', () =>
  attributable(async () => {
    await withRealDatabase(async ({ baseUrl, projectId, expectation }) => {
      assert.equal((await putFilter(baseUrl, projectId, [HIDE_RULE])).status, 200);

      const clientSideShape = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0&includeHidden=true`);
      const serverSideShape = await getPage(baseUrl, projectId, `limit=${PAGE_SIZE}&offset=0`);

      console.log(
        `__REALDATA_ANTIFAKE__ client-shape total=${clientSideShape.sessionMeta.total} rows=${clientSideShape.sessions.length} | server-shape total=${serverSideShape.sessionMeta.total} rows=${serverSideShape.sessions.length}`,
      );

      assert.equal(clientSideShape.sessionMeta.total, expectation.allIds.length);
      assert.equal(serverSideShape.sessionMeta.total, expectation.visibleIds.length);
      assert.notEqual(
        serverSideShape.sessionMeta.total,
        clientSideShape.sessionMeta.total,
        'the filtered stream must report its own total, not the unfiltered one',
      );
      assert.deepEqual(
        clientSideShape.sessions.map((session) => session.id),
        expectation.allIds.slice(0, PAGE_SIZE),
        'the client-side shape starts at the newest overall session, whatever its name',
      );
      assert.deepEqual(
        serverSideShape.sessions.map((session) => session.id),
        expectation.visibleIds.slice(0, PAGE_SIZE),
        'the server-side shape starts at the newest visible session',
      );
      assert.ok(
        serverSideShape.sessions.every((session) => !AUTO_SESSION_REGEX.test(session.summary)),
        'every row of the filtered first page must be a session the rule does not match',
      );

      // Row-level counterpart of the total/hasMore contrast, located in the snapshot's own order
      // rather than in "which rows this machine touched most recently": find the first page
      // boundary at which the snapshot itself places a hidden session. A client that filtered
      // after pagination renders that session on this page; the server-side stream never does,
      // on any page. The snapshot's order makes that boundary exist whenever the store holds a
      // hidden session at all, so the assertion cannot go vacuous on a quiet machine.
      const hiddenIds = new Set(expectation.hiddenIds);
      const firstHiddenIndex = expectation.allIds.findIndex((id) => hiddenIds.has(id));
      assert.ok(firstHiddenIndex >= 0, 'the snapshot lists no hidden session at all');
      const mixedOffset = Math.floor(firstHiddenIndex / PAGE_SIZE) * PAGE_SIZE;
      const mixedPage = await getPage(
        baseUrl,
        projectId,
        `limit=${PAGE_SIZE}&offset=${mixedOffset}&includeHidden=true`,
      );
      assert.deepEqual(
        mixedPage.sessions.map((session) => session.id),
        expectation.allIds.slice(mixedOffset, mixedOffset + PAGE_SIZE),
        'the unfiltered page must be the snapshot rows at this offset',
      );
      const mixedHidden = mixedPage.sessions.filter((session) => hiddenIds.has(session.id));
      console.log(
        `__REALDATA_ANTIFAKE__ mixed page offset=${mixedOffset} hidden=${mixedHidden.length} visible=${mixedPage.sessions.length - mixedHidden.length}`,
      );
      assert.ok(
        mixedHidden.length > 0,
        `the snapshot places no hidden session on the page at offset ${mixedOffset}, so this project no longer needs the rule`,
      );

      const serverStreamIds = new Set(
        (await readAllPages(baseUrl, projectId, '', expectation.visibleIds.length)).map((session) => session.id),
      );
      for (const session of mixedHidden) {
        assert.ok(
          !serverStreamIds.has(session.id),
          `auto session ${session.id} reached the filtered stream, so it would render for a server-side filter too`,
        );
      }
    });
  }));
