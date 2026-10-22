/**
 * gap-mcp-session-search criterion: `session_search` answers over REAL transcripts.
 *
 * Everything below is real. A real express 4 application carries the production
 * `/mcp` mount behind the production token middleware; the client is the MCP
 * SDK's own `Client` over `StreamableHTTPClientTransport`; the database is a
 * real better-sqlite3 file in a temp directory; the sessions are real rows whose
 * transcripts are real Claude JSONL files on disk, scanned by the SAME ripgrep
 * engine the session-search route uses (`@vscode/ripgrep` through
 * `sessionConversationsSearchService.search`, imported from the providers
 * barrel — never by path). No fixture stubs the scan.
 *
 * The transport is handed a `node:http`-based `fetch`: `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240's criterion documents the same hazard), and the SDK's transport
 * `fetch` seam avoids it without giving up the SDK client.
 *
 * Readings, one leg each:
 *   (a) a message containing the term is hit, and the hit's `messageId` fed
 *       back through `session_read({ mode: 'around', aroundId })` returns the
 *       SAME message text verbatim;
 *   (b) the `project` filter returns only that project's hits;
 *   (c) a term nothing contains is `results: []`, not an error;
 *   (d) more hits than `limit` returns a `cursor`, and the next call with that
 *       cursor sees the subsequent, disjoint sessions;
 *   (e) a mount that wires no `sessionSearch` refuses by name with
 *       `MCP_TOOL_NOT_IMPLEMENTED`.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased module is pulled in — and every application module
// below therefore comes in dynamically (the order AC-245's criterion
// established).
process.env.JWT_SECRET = 'mcp-session-search-test-secret';
delete process.env.VITE_IS_PLATFORM;

const { closeConnection, getConnection, initializeDatabase, sessionsDb } = await import('@/modules/database/index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionConversationsSearchService, sessionsService } = await import('@/modules/providers/index.js');
const { getProjectsWithSessions } = await import('@/modules/projects/index.js');
const {
  MCP_GATEWAY_PATH,
  MCP_TOOL_NOT_IMPLEMENTED_CODE,
  createMcpAuthMiddleware,
  mountMcpGateway,
} = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- the clock ---------------------------

/** The injected instant every relative reading is measured against. */
const NOW_ISO = '2026-09-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const now = (): number => NOW_MS;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const ALPHA_DIR_NAME = 'alpha-workspace';
const BETA_DIR_NAME = 'beta-workspace';

const SESSION_A1 = 'search-fixture-alpha-one';
const SESSION_A2 = 'search-fixture-alpha-two';
const SESSION_A3 = 'search-fixture-alpha-three';
const SESSION_B1 = 'search-fixture-beta-one';

/** The one literal term every planted message carries — a token no other text in this repo contains. */
const KEYWORD = 'zebraword';

/**
 * The alpha-one user message, planted verbatim. Short enough that the engine's
 * 150-character snippet window covers it whole (keyword at offset 13 < the
 * half-window of 75), so `snippet === TARGET_TEXT` is a real verbatim tie and
 * not an accident of truncation.
 */
const TARGET_TEXT = 'Remember the zebraword decision we agreed at the kickoff.';
/** The raw JSONL uuid of that message — the id the search must hand back as `messageId`. */
const A1_MATCH_UUID = 'u-a1-zebraword';

const A1_UPDATED_AT = '2026-09-01T11:00:00.000Z';
const A2_UPDATED_AT = '2026-09-01T10:00:00.000Z';
const A3_UPDATED_AT = '2026-09-01T09:00:00.000Z';
const B1_UPDATED_AT = '2026-09-01T08:00:00.000Z';

// --------------------------- transcript fixture ---------------------------

function userRow(uuid: string, parentUuid: string | null, timestamp: string, sessionId: string, text: string): AnyRecord {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function assistantRow(uuid: string, parentUuid: string, timestamp: string, sessionId: string, text: string): AnyRecord {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp,
    sessionId,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

/** Alpha-one: ONE matching user message — the verbatim target the round trip reads back. */
function buildAlphaOneRows(): AnyRecord[] {
  return [
    userRow(A1_MATCH_UUID, null, '2026-09-01T10:59:00.000Z', SESSION_A1, TARGET_TEXT),
    assistantRow('a-a1-1', A1_MATCH_UUID, '2026-09-01T10:59:01.000Z', SESSION_A1, 'Noted, one decision.'),
    userRow('u-a1-2', 'a-a1-1', '2026-09-01T10:59:02.000Z', SESSION_A1, 'Thanks.'),
    assistantRow('a-a1-2', 'u-a1-2', '2026-09-01T10:59:03.000Z', SESSION_A1, 'You are welcome.'),
  ];
}

/** Alpha-two: TWO matching user messages, so its score outranks the single-match sessions. */
function buildAlphaTwoRows(): AnyRecord[] {
  return [
    userRow('u-a2-1', null, '2026-09-01T10:58:00.000Z', SESSION_A2, 'The zebraword plan starts tomorrow.'),
    assistantRow('a-a2-1', 'u-a2-1', '2026-09-01T10:58:01.000Z', SESSION_A2, 'Understood.'),
    userRow('u-a2-2', 'a-a2-1', '2026-09-01T10:58:02.000Z', SESSION_A2, 'And the zebraword owner is Dana.'),
    assistantRow('a-a2-2', 'u-a2-2', '2026-09-01T10:58:03.000Z', SESSION_A2, 'Recorded.'),
  ];
}

function buildAlphaThreeRows(): AnyRecord[] {
  return [
    userRow('u-a3-1', null, '2026-09-01T10:57:00.000Z', SESSION_A3, 'Retro: the zebraword rollout worked.'),
    assistantRow('a-a3-1', 'u-a3-1', '2026-09-01T10:57:01.000Z', SESSION_A3, 'Good to hear.'),
  ];
}

function buildBetaOneRows(): AnyRecord[] {
  return [
    userRow('u-b1-1', null, '2026-09-01T10:56:00.000Z', SESSION_B1, 'The zebraword review is scheduled.'),
    assistantRow('a-b1-1', 'u-b1-1', '2026-09-01T10:56:01.000Z', SESSION_B1, 'Calendar noted.'),
  ];
}

/**
 * The deterministic ordering `session_search` promises: score first (match
 * count, then the whole-query phrase bonus, then a recency tier), then session
 * id. Alpha-two carries two matches, so it leads; the three single-match
 * sessions tie on score and order by id.
 */
const EXPECTED_SESSION_ORDER = [SESSION_A2, SESSION_A1, SESSION_A3, SESSION_B1];

async function writeTranscript(projectDirectory: string, sessionId: string, rows: AnyRecord[]): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

/** The SDK client's `fetch`, over `node:http` — see the module doc for why. */
const nodeFetch: FetchLike = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(String(url));
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              responseHeaders.set(key, value);
            } else if (Array.isArray(value)) {
              for (const entry of value) {
                responseHeaders.append(key, entry);
              }
            }
          }
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: responseHeaders }));
        });
      },
    );
    request.on('error', reject);
    if (body !== null) {
      request.write(body);
    }
    request.end();
  });

// --------------------------- harness ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null; structured: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks
    .map((block) => (block as { type?: string; text?: string }).text ?? '')
    .join('');
  let payload: AnyRecord | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
  } catch {
    payload = null;
  }
  return {
    isError: call.isError === true,
    text,
    payload,
    structured: (call.structuredContent as AnyRecord | undefined) ?? null,
  };
}

type Harness = {
  readClient: Client;
  /**
   * A `cloudcli:read` connection that never calls `tools/list`. The SDK Client
   * caches each tool's output validator from `tools/list` and then validates a
   * call's `structuredContent` against it — including an `isError` failure
   * (AC-284's envelope), which no tool's success schema matches. Error probes
   * go through this cold client, exactly as AC-284's criterion does.
   */
  probeClient: Client;
  transport: StreamableHTTPClientTransport;
  probeTransport: StreamableHTTPClientTransport;
  call: (name: string, args?: AnyRecord) => Promise<ToolCall>;
  callWith: (client: Client, name: string, args?: AnyRecord) => Promise<ToolCall>;
};

type Fixture = {
  projectAlphaId: string;
  projectBetaId: string;
};

/**
 * Runs `run` against a fresh temp database, the real project/session services
 * and the production `/mcp` mount carrying `session_search`.
 *
 * `wireSessionSearch: false` mounts the SAME read tool set with the
 * `sessionSearch` deps omitted, so the body-table refusal form is what `(e)`
 * reads. The `hosts`/`runs` members are honest stubs: no leg of this criterion
 * reads a host or a run, and the tools that would are registered from the same
 * table either way.
 */
async function withSessionSearch(
  run: (harness: Harness, fixture: Fixture) => Promise<void>,
  options: { wireSessionSearch?: boolean } = {},
): Promise<void> {
  const wireSessionSearch = options.wireSessionSearch ?? true;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'mcp-session-search-'));
  const alphaDirectory = path.join(tempDirectory, ALPHA_DIR_NAME);
  const betaDirectory = path.join(tempDirectory, BETA_DIR_NAME);
  await mkdir(alphaDirectory, { recursive: true });
  await mkdir(betaDirectory, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'session-search.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  // ---- sessions and their real transcripts ----
  const a1Transcript = await writeTranscript(alphaDirectory, SESSION_A1, buildAlphaOneRows());
  const a2Transcript = await writeTranscript(alphaDirectory, SESSION_A2, buildAlphaTwoRows());
  const a3Transcript = await writeTranscript(alphaDirectory, SESSION_A3, buildAlphaThreeRows());
  const b1Transcript = await writeTranscript(betaDirectory, SESSION_B1, buildBetaOneRows());
  sessionsDb.createSession(
    SESSION_A1, 'claude', alphaDirectory, 'Alpha zebraword kickoff', A1_UPDATED_AT, A1_UPDATED_AT, a1Transcript,
  );
  sessionsDb.createSession(
    SESSION_A2, 'claude', alphaDirectory, 'Alpha zebraword follow-up', A2_UPDATED_AT, A2_UPDATED_AT, a2Transcript,
  );
  sessionsDb.createSession(
    SESSION_A3, 'claude', alphaDirectory, 'Alpha zebraword retrospective', A3_UPDATED_AT, A3_UPDATED_AT, a3Transcript,
  );
  sessionsDb.createSession(
    SESSION_B1, 'claude', betaDirectory, 'Beta zebraword review', B1_UPDATED_AT, B1_UPDATED_AT, b1Transcript,
  );

  // ---- the tokens ----
  const tokens = createAccessTokensService({ now: () => new Date(NOW_MS) });
  const readToken = tokens.issueToken({ userId: USER_ONE, name: 'mcp-search', scopes: ['cloudcli:read'], expiresInDays: 30 });
  if (!readToken.ok) {
    throw new Error('the harness must mint a cloudcli:read token');
  }

  // ---- the app and the real mount ----
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: {
      projects: {
        getProjectsWithSessions,
        getArchivedProjectsWithSessions: async () => [],
        getProjectSessionsPage: async (projectId: string) => ({
          projectId,
          sessions: [],
          total: 0,
        }),
      },
      sessions: sessionsService,
      // Not read by any leg here: only `session_search` and `session_read` are
      // exercised, and neither touches a host or a run store.
      hosts: { snapshot: () => [], liveHostForSession: () => null },
      runs: { listRunningRuns: () => [] },
      now,
      ...(wireSessionSearch
        ? { sessionSearch: { search: (input) => sessionConversationsSearchService.search(input), now } }
        : {}),
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${readToken.token.token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'gap-mcp-session-search-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect();
  const probe = await connect();

  const callWith = async (client: Client, name: string, args: AnyRecord = {}): Promise<ToolCall> =>
    parseToolResult(await client.callTool({ name, arguments: args } as Parameters<Client['callTool']>[0]));

  try {
    const projects = await getProjectsWithSessions({ skipSynchronization: true, includeHidden: true });
    const projectAlphaId = projects.find((project) => project.path === alphaDirectory)?.projectId ?? null;
    const projectBetaId = projects.find((project) => project.path === betaDirectory)?.projectId ?? null;
    assert.ok(projectAlphaId && projectBetaId, 'both fixture projects must be registered');

    await run(
      {
        readClient: read.client,
        probeClient: probe.client,
        transport: read.transport,
        probeTransport: probe.transport,
        call: (name, args = {}) => callWith(read.client, name, args),
        callWith,
      },
      { projectAlphaId, projectBetaId },
    );
  } finally {
    await read.transport.close().catch(() => undefined);
    await probe.transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** The session ids of a successful `session_search` reading, in the order returned. */
function hitIds(call: ToolCall): string[] {
  return ((call.payload?.results as AnyRecord[] | undefined) ?? []).map((hit) => String(hit.sessionId));
}

// --------------------------- (a) search -> around round trip ---------------------------

test('(a) a real transcript hit round-trips its messageId into session_read(mode: around)', { concurrency: false }, async () => {
  await withSessionSearch(async (harness, fixture) => {
    const search = await harness.call('session_search', { query: KEYWORD });
    console.log(`[a] session_search(${KEYWORD}) isError=${search.isError} payload=${JSON.stringify(search.payload)}`);
    assert.equal(search.isError, false, 'a populated search must not be an error');
    assert.equal(search.payload?.query, KEYWORD, 'the reading must echo the query it answered');
    // Five matches live in four sessions: alpha-two carries two, the others one.
    // `totalMatches` counts MATCHES, so it is 5 while `results.length` is 4.
    assert.equal(search.payload?.totalMatches, 5, 'every planted match must be counted');

    const results = (search.payload?.results ?? []) as AnyRecord[];
    assert.equal(results.length, 4, 'all four fixture sessions mention the term');

    const hit = results.find((candidate) => candidate.sessionId === SESSION_A1);
    assert.ok(hit, 'the alpha-one session must be among the hits');
    assert.equal(hit.provider, 'claude');
    assert.equal(hit.projectId, fixture.projectAlphaId, 'the hit must name the project that owns the session');
    assert.equal(hit.projectDisplayName, ALPHA_DIR_NAME);
    assert.equal(hit.sessionTitle, 'Alpha zebraword kickoff', 'the title channel must populate the hit');
    assert.equal((hit.lastActivity as AnyRecord | null)?.iso, A1_UPDATED_AT, 'the hit must carry the session activity stamp');

    const matches = (hit.matches ?? []) as AnyRecord[];
    assert.equal(matches.length, 1, 'alpha-one carries exactly one matching message');
    const match = matches[0];
    console.log(`[a] alpha-one match = ${JSON.stringify(match)}`);
    assert.equal(match.role, 'user', 'the planted message is a user row');
    assert.equal(match.messageId, A1_MATCH_UUID, 'the hit must hand back the raw JSONL uuid as the message id');
    assert.equal(match.snippet, TARGET_TEXT, 'the snippet must be the matched message text verbatim');
    assert.equal(match.timestamp !== null && match.timestamp !== undefined, true, 'the match must carry its own timestamp');

    const highlights = (match.highlights ?? []) as AnyRecord[];
    assert.ok(highlights.length > 0, 'a matched snippet must carry at least one highlight');
    for (const highlight of highlights) {
      assert.equal(
        String(match.snippet).slice(Number(highlight.start), Number(highlight.end)),
        KEYWORD,
        'every highlight must bracket the searched term inside the snippet',
      );
    }

    // ---- the round trip the AC names: messageId -> session_read(around) ----
    const read = await harness.call('session_read', {
      session: SESSION_A1,
      mode: 'around',
      aroundId: match.messageId,
      before: 0,
      after: 0,
    });
    console.log(`[a] session_read(around ${String(match.messageId)}) isError=${read.isError} content=${JSON.stringify(read.payload?.content)}`);
    assert.equal(read.isError, false, 'the search-supplied id must resolve');
    const content = String(read.payload?.content ?? '');
    const lines = content.split('\n');
    assert.equal(lines.length, 1, 'before=0/after=0 must return exactly the one message');
    assert.ok(
      lines[0].endsWith(`user: ${TARGET_TEXT}`),
      `the window must render the SAME message verbatim, saw ${JSON.stringify(lines[0])}`,
    );
    assert.ok(content.includes(TARGET_TEXT), 'the target text must survive the round trip unchanged');
  });
});

// --------------------------- (b) project filter ---------------------------

test('(b) the project filter returns only that project\'s hits', { concurrency: false }, async () => {
  await withSessionSearch(async (harness, fixture) => {
    const unfiltered = await harness.call('session_search', { query: KEYWORD });
    console.log(`[b] unfiltered -> ${JSON.stringify(hitIds(unfiltered))}`);
    assert.equal(hitIds(unfiltered).length, 4, 'the control must see all four sessions (non-vacuity for the filter)');

    const alpha = await harness.call('session_search', { query: KEYWORD, project: fixture.projectAlphaId });
    console.log(`[b] project=alpha -> ${JSON.stringify(hitIds(alpha))} total=${String(alpha.payload?.totalMatches)}`);
    assert.equal(alpha.isError, false, 'a legal project filter must not error');
    assert.deepEqual([...hitIds(alpha)].sort(), [SESSION_A1, SESSION_A2, SESSION_A3].sort());
    assert.equal(alpha.payload?.totalMatches, 4, 'alpha holds four matches across its three sessions');
    for (const hit of (alpha.payload?.results ?? []) as AnyRecord[]) {
      assert.equal(hit.projectId, fixture.projectAlphaId, 'every returned hit must belong to the filter project');
    }

    const beta = await harness.call('session_search', { query: KEYWORD, project: fixture.projectBetaId });
    console.log(`[b] project=beta -> ${JSON.stringify(hitIds(beta))} total=${String(beta.payload?.totalMatches)}`);
    assert.equal(beta.isError, false);
    assert.deepEqual(hitIds(beta), [SESSION_B1], 'the beta filter must return only the beta session');
    assert.equal(beta.payload?.totalMatches, 1);

    // The two filtered readings partition the unfiltered set exactly.
    assert.deepEqual(
      [...hitIds(alpha), ...hitIds(beta)].sort(),
      [...hitIds(unfiltered)].sort(),
      'the two project filters must partition the unfiltered hits',
    );
  });
});

// --------------------------- (c) no hits is an empty result, not an error ---------------------------

test('(c) a term no transcript contains is results: [] rather than an error', { concurrency: false }, async () => {
  await withSessionSearch(async (harness) => {
    const none = await harness.call('session_search', { query: 'xyzzyplughnoterm' });
    console.log(`[c] session_search(absent term) isError=${none.isError} payload=${JSON.stringify(none.payload)}`);
    assert.equal(none.isError, false, 'nothing-matches is exactly what the caller asked, so it is a reading');
    assert.equal(none.payload?.query, 'xyzzyplughnoterm');
    assert.deepEqual(none.payload?.results, [], 'an empty result must be an empty array, not a missing field');
    assert.equal(none.payload?.totalMatches, 0);
    assert.equal(none.payload?.moreAvailable, false, 'an empty page has nothing after it');
    assert.equal(
      Object.prototype.hasOwnProperty.call(none.payload ?? {}, 'cursor'),
      false,
      'an empty reading must not offer a cursor to a page that does not exist',
    );
  });
});

// --------------------------- (d) limit + cursor ---------------------------

test('(d) hits beyond limit return a cursor that pages to the next sessions', { concurrency: false }, async () => {
  await withSessionSearch(async (harness) => {
    const all = await harness.call('session_search', { query: KEYWORD, limit: 4 });
    const allIds = hitIds(all);
    console.log(`[d] limit=4 -> ${JSON.stringify(allIds)} total=${String(all.payload?.totalMatches)} more=${String(all.payload?.moreAvailable)}`);
    assert.deepEqual(allIds, EXPECTED_SESSION_ORDER, 'the deterministic score-then-id ordering must hold');
    assert.equal(all.payload?.moreAvailable, false, 'the whole set fits, so no page remains');
    assert.equal(all.payload?.totalMatches, 5, 'totalMatches is the whole filtered count');

    const first = await harness.call('session_search', { query: KEYWORD, limit: 2 });
    console.log(`[d] limit=2 -> ${JSON.stringify(hitIds(first))} more=${String(first.payload?.moreAvailable)} cursor=${JSON.stringify(first.payload?.cursor)}`);
    assert.equal(first.isError, false, 'a legal limit must not error');
    assert.deepEqual(hitIds(first), allIds.slice(0, 2), 'the first page must be the head of the same ordering');
    assert.equal(first.payload?.moreAvailable, true, 'four sessions with a page of two leaves more');
    assert.equal(first.payload?.totalMatches, 5, 'totalMatches counts past the page');
    const cursor = first.payload?.cursor;
    assert.equal(typeof cursor, 'string', 'a truncated page must hand back a cursor');

    const second = await harness.call('session_search', { query: KEYWORD, limit: 2, cursor: String(cursor) });
    console.log(`[d] limit=2 cursor=... -> ${JSON.stringify(hitIds(second))} more=${String(second.payload?.moreAvailable)}`);
    assert.equal(second.isError, false, 'a cursor continuation must not error');
    assert.deepEqual(hitIds(second), allIds.slice(2), 'the continuation must be the SUBSEQUENT sessions');
    assert.equal(second.payload?.moreAvailable, false, 'the second page is the last');
    assert.equal(
      Object.prototype.hasOwnProperty.call(second.payload ?? {}, 'cursor'),
      false,
      'the last page must not offer a further cursor',
    );

    // The two pages are disjoint and their union is the whole set.
    assert.deepEqual(
      [...hitIds(first), ...hitIds(second)],
      allIds,
      'paging must neither duplicate nor lose a session',
    );
  });
});

// --------------------------- (e) unwired refusal ---------------------------

test('(e) a mount without sessionSearch refuses by name with MCP_TOOL_NOT_IMPLEMENTED', { concurrency: false }, async () => {
  await withSessionSearch(
    async (harness) => {
      const refusal = await harness.callWith(harness.probeClient, 'session_search', { query: 'anything' });
      console.log(`[e] unwired session_search -> isError=${refusal.isError} text=${JSON.stringify(refusal.text)}`);
      assert.equal(refusal.isError, true, 'an unwired mount must refuse rather than answer');
      assert.equal(
        refusal.structured?.code,
        MCP_TOOL_NOT_IMPLEMENTED_CODE,
        `the refusal must carry ${MCP_TOOL_NOT_IMPLEMENTED_CODE}`,
      );
      const details = refusal.structured?.details as AnyRecord | undefined;
      assert.equal(details?.tool, 'session_search', 'the refusal must name the tool');
    },
    { wireSessionSearch: false },
  );
});
