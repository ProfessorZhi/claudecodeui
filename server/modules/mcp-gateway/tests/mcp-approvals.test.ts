/**
 * AC-274 criterion: MCP `approvals_list` reports the pending tool approvals —
 * request id, session, tool, input summary and waited time — expanding an
 * `AskUserQuestion` into its questions and options, and `approval_answer` decides
 * one through the shared control service's `answerApproval` verb: `allow` reaches
 * the runtime's `resolveToolApproval`, `message` rides alongside it, and an
 * `AskUserQuestion`'s `answers` is forwarded AS `updatedInput`. A request that is
 * no longer in the registry is, since AC-287, an `isError` envelope
 * `APPROVAL_NOT_FOUND` whose `details.reason` tells a timed-out request
 * (`expired`) apart from one this runtime never minted (`never_issued`) — the
 * envelope's sentence still says the request "expired or does not exist" —
 * WITHOUT calling the resolver, and a token lacking `cloudcli:approve` is
 * refused before the handler with a `denied` audit row.
 *
 * Everything below is real except the approval SOURCE. A real express 4
 * application carries the production `/mcp` mount behind the production token
 * middleware; the client is the MCP SDK's own `Client` over
 * `StreamableHTTPClientTransport`; the database is a real better-sqlite3 file in
 * a temp directory; the control service is the real `createChatControlService`
 * (its shared access entry, its in-registry precheck and its `answers ->
 * updatedInput` mapping are all the production ones). Only the provider RUNTIME
 * is a fake: `getPendingApprovalsForSession` answers a mutable fixture and
 * `resolveToolApproval` is a spy, so "was the resolver called, with what" is a
 * reading this criterion takes rather than infers. The clock is injected so
 * `waitedMs` is exactly assertable. The overview tool (AC-247) is mounted for
 * real with an activity reader that pins one session to `awaitingPermission`.
 *
 * The transport is handed a `node:http`-based `fetch`. `listen(0)` on this host
 * lands on a port undici refuses often enough to red a suite run at random
 * (AC-240/245/248/249/271/272/273's criteria document the same hazard).
 *
 * Readings, one leg each:
 *   (a) `approvals_list({session})`: two entries — a `Bash` one (`inputSummary`
 *       contains `echo hi`, `waitedMs === 3000`) and an `AskUserQuestion` one
 *       whose question text and option label/description are the fixture's;
 *   (b) `approval_answer` allow=true and allow=false+message reach
 *       `resolveToolApproval` exactly once each with the same decision;
 *   (c) an `AskUserQuestion`'s `answers` arrives as the decision's `updatedInput`;
 *   (d) a removed (timed-out) and a never-seen requestId are APPROVAL_NOT_FOUND
 *       errors with distinct `details.reason` (`expired` / `never_issued`), the
 *       sentence "expired or does not exist" on both, and no resolver call;
 *   (e) a read-only token's `approval_answer` is refused with one `denied` audit
 *       row and no resolver call; the `cloudcli:approve` token's call succeeds;
 *   (f) `approvals_list({})`'s pending session set equals `overview()`'s
 *       `awaitingPermission` set, and a session with neither is in neither.
 *
 * The false forms (AC9) mutate the implementation after this criterion is green;
 * they are recorded in the task's change notes.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

// --------------------------------------------------------------------------
// A scratch HOME is set before any aliased module is imported, so settings reads
// land on an empty directory (the posture AC-168/272/273's criteria take).
// --------------------------------------------------------------------------
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mcp-approvals-'));
const SCRATCH_HOME = path.join(SCRATCH, 'home');
process.env.HOME = SCRATCH_HOME;
process.env.JWT_SECRET = 'mcp-approvals-test-secret';
delete process.env.VITE_IS_PLATFORM;
mkdirSync(SCRATCH_HOME, { recursive: true });

const { closeConnection, getConnection, initializeDatabase } = await import(
  '@/modules/database/index.js'
);
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { sessionsService } = await import('@/modules/providers/index.js');
const { createChatControlService } = await import('@/modules/websocket/index.js');
const { MCP_GATEWAY_PATH, createMcpAuthMiddleware, mountMcpGateway } = await import('../index.js');

type AnyRecord = Record<string, unknown>;

// --------------------------- fixture identities ---------------------------

const USER_ONE = 1;
const READ_SCOPE = 'cloudcli:read';
const APPROVE_SCOPE = 'cloudcli:approve';
/** The pinned "now" so `waitedMs` is exactly assertable. */
const NOW = 1_700_000_000_000;
/** The ordinary tool's request id and the wait the criterion seeds for it. */
const R_NORMAL = 'req-normal';
const WAITED_MS = 3_000;
/** The `AskUserQuestion` request id. */
const R_ASK = 'req-ask';

/** One line of this criterion's readings. The readings are the evidence. */
function say(line: string): void {
  console.log(`mcp-approvals ${line}`);
}

// --------------------------- HTTP: a node:http based fetch ---------------------------

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

// --------------------------- tool result parsing ---------------------------

type ToolCall = { isError: boolean; text: string; payload: AnyRecord | null };

function parseToolResult(result: unknown): ToolCall {
  const call = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const blocks = Array.isArray(call.content) ? call.content : [];
  const text = blocks.map((block) => (block as { type?: string; text?: string }).text ?? '').join('');
  let payload: AnyRecord | null = null;
  // AC-284: a FAILURE now carries its machine fields in `structuredContent`
  // (`{ code, message, retryable, details? }`) instead of a JSON string stuffed
  // into the text. Read that first; a SUCCESS payload is still the text body.
  if (call.isError === true && typeof call.structuredContent === 'object' && call.structuredContent !== null) {
    payload = call.structuredContent as AnyRecord;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      payload = typeof parsed === 'object' && parsed !== null ? (parsed as AnyRecord) : null;
    } catch {
      payload = null;
    }
  }
  return { isError: call.isError === true, text, payload };
}

/** An audit row as this criterion reads it back. */
type AuditRow = { id: number; tool: string; outcome: string; denied_scopes: string | null };

// --------------------------- the fake runtime ---------------------------

type PendingSeed = {
  requestId: string;
  sessionId: string;
  toolName: string;
  input: unknown;
  receivedAt: Date;
};

/**
 * The approval source the criterion owns: a mutable per-session pending map and a
 * `resolveToolApproval` spy. Only the two members the approval verbs read are
 * implemented — the control service is handed this object as its `runtime`, and
 * the two approval verbs touch nothing else.
 */
function createFakeRuntime(seeds: PendingSeed[]) {
  const pendingBySession = new Map<string, PendingSeed[]>();
  for (const seed of seeds) {
    const bucket = pendingBySession.get(seed.sessionId) ?? [];
    bucket.push(seed);
    pendingBySession.set(seed.sessionId, bucket);
  }
  const resolveCalls: Array<{ requestId: string; decision: AnyRecord }> = [];

  /**
   * Ids this fake has HELD — the arm's stand-in for the runtime's own held
   * ledger.
   *
   * AC-287 has the control service ask the runtime WHY an absent `requestId` is
   * absent, so the fake answers from the set it was seeded with: a seed that
   * `removePending` dropped is `'expired'`, an id it never held is
   * `'never_issued'`. This mirrors the real claude runtime (a held id outlives
   * both the pending entry and `cleanup()`), so the expired/never-seen split the
   * MCP tool reports is read from a runtime that really carries it rather than
   * left to the control service's conservative `'expired'` default.
   */
  const heldIds = new Set<string>(seeds.map((seed) => seed.requestId));

  return {
    getPendingApprovalsForSession(sessionId: string): PendingSeed[] {
      return pendingBySession.get(sessionId) ?? [];
    },
    resolveToolApproval(requestId: string, decision: unknown): void {
      resolveCalls.push({ requestId, decision: decision as AnyRecord });
    },
    /** AC-287: why an absent id is absent — held-then-dropped, or never minted here. */
    classifyMissingApproval(requestId: string): 'expired' | 'never_issued' {
      return heldIds.has(requestId) ? 'expired' : 'never_issued';
    },
    /** Removes every pending entry for `requestId` — the timeout transition. */
    removePending(requestId: string): void {
      for (const [sessionId, bucket] of pendingBySession) {
        pendingBySession.set(
          sessionId,
          bucket.filter((entry) => entry.requestId !== requestId),
        );
      }
    },
    resolveCalls,
    /** Appends one pending entry after boot (used by the two-request leg). */
    addPending(seed: PendingSeed): void {
      const bucket = pendingBySession.get(seed.sessionId) ?? [];
      bucket.push(seed);
      pendingBySession.set(seed.sessionId, bucket);
      // Held from here on, exactly as the runtime's ledger records at arm time.
      heldIds.add(seed.requestId);
    },
  };
}

/** Counts how many times the spy saw `requestId`. */
function resolveCountFor(calls: Array<{ requestId: string }>, requestId: string): number {
  return calls.filter((call) => call.requestId === requestId).length;
}

// --------------------------- the harness ---------------------------

type HarnessOptions = {
  label: string;
  /**
   * The pending fixture the fake runtime starts with. A factory so the session id
   * — minted inside the harness — can key the seeds.
   */
  pending: (sessionId: string, coldSessionId: string) => PendingSeed[];
  /** Session ids the overview's activity reader pins to `awaitingPermission`. */
  awaiting?: (sessionId: string, coldSessionId: string) => string[];
};

type Harness = {
  sessionId: string;
  coldSessionId: string;
  call(name: string, args?: AnyRecord, which?: 'read' | 'approve'): Promise<ToolCall>;
  resolveCalls: Array<{ requestId: string; decision: AnyRecord }>;
  addPending(seed: PendingSeed): void;
  removePending(requestId: string): void;
  /** Session ids the `approvals_list({})` reading reports (deduplicated). */
  listedSessions(): Promise<string[]>;
  /** Session ids the `overview` reading reports as `awaitingPermission`. */
  awaitingSessions(): Promise<string[]>;
  auditRows(): AuditRow[];
};

/**
 * Boots one arm: a fresh temp database + project directory, two real sessions,
 * the real control service over the fake runtime, both tokens, and the
 * production `/mcp` mount carrying the stage-3 read tools (so `overview` is real)
 * plus the stage-6 resident tools (so the two approval tools register).
 */
async function withHarness(options: HarnessOptions, run: (harness: Harness) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(SCRATCH, 'arm-'));
  const fixtureProject = path.join(tempDirectory, options.label);
  mkdirSync(fixtureProject, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'mcp-approvals.db');
  await initializeDatabase();
  getConnection()
    .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(USER_ONE, 'owner', 'hash');

  const primary = sessionsService.createAppSession('claude', fixtureProject, 'primary seed');
  const sessionId = primary.sessionId;
  const cold = sessionsService.createAppSession('claude', fixtureProject, 'cold seed');
  const coldSessionId = cold.sessionId;

  const fakeRuntime = createFakeRuntime(options.pending(sessionId, coldSessionId));
  const control = createChatControlService({
    runtime: fakeRuntime as never,
    listApprovalSessionIds: () => [sessionId, coldSessionId],
  });

  const tokens = createAccessTokensService({ now: () => new Date() });
  const readToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac274-read',
    scopes: [READ_SCOPE],
    expiresInDays: 30,
  });
  const approveToken = tokens.issueToken({
    userId: USER_ONE,
    name: 'ac274-approve',
    scopes: [READ_SCOPE, APPROVE_SCOPE],
    expiresInDays: 30,
  });
  if (!readToken.ok || !approveToken.ok) {
    throw new Error('the harness must mint both tokens');
  }

  const awaiting = new Set((options.awaiting ?? ((primaryId: string) => [primaryId]))(sessionId, coldSessionId));
  const sessionRow = (id: string) => ({
    sessionId: id,
    provider: 'claude',
    projectId: null,
    sessionTitle: `title ${id}`,
    lastActivity: null,
  });

  // The overview tool (AC-247) is mounted for real. Its activity reader pins the
  // awaiting session(s); its session listing carries both sessions so the filter
  // has something to select from and something to exclude.
  const readDeps = {
    projects: {
      getProjectsWithSessions: async () => [],
      getArchivedProjectsWithSessions: async () => [],
      getProjectSessionsPage: async () => ({ projectId: '', sessions: [] }),
    },
    sessions: {
      listRecentSessions: () => ({
        conversations: [sessionRow(sessionId), sessionRow(coldSessionId)],
        total: 2,
      }),
      readSessionLifecycle: () => null,
      fetchHistory: async () => ({ messages: [], total: 0 }),
      fetchOutline: async () => ({ total: 0, turns: [] }),
      fetchWindowAround: async () => ({ messages: [], startIndex: 0, total: 0 }),
    },
    hosts: { snapshot: () => [], liveHostForSession: () => null },
    runs: { listRunningRuns: () => [], listRecentRuns: () => [] },
    quay: { hasQuayConfig: () => false, readCached: () => null, refresh: async () => null },
    activity: {
      snapshot: (id: string) => (awaiting.has(id) ? { turn: { phase: 'awaitingPermission' } } : null),
    },
    now: () => NOW,
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize: createMcpAuthMiddleware(tokens),
    readTools: readDeps as never,
    residentTools: {
      control: control as never,
      approvals: { control: control as never, now: () => NOW },
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const endpoint = new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`);

  const connect = async (token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: nodeFetch,
    });
    const client = new Client({ name: 'ac274-criterion', version: '0.0.0' });
    await client.connect(transport);
    return { client, transport };
  };

  const read = await connect(readToken.token.token);
  const approve = await connect(approveToken.token.token);

  const callWith = async (which: 'read' | 'approve', name: string, args: AnyRecord): Promise<ToolCall> =>
    parseToolResult(
      await (which === 'approve' ? approve.client : read.client).callTool({
        name,
        arguments: args,
      } as Parameters<Client['callTool']>[0]),
    );

  try {
    await run({
      sessionId,
      coldSessionId,
      call: (name, args = {}, which = 'read') => callWith(which, name, args),
      resolveCalls: fakeRuntime.resolveCalls,
      addPending: (seed) => fakeRuntime.addPending(seed),
      removePending: (requestId) => fakeRuntime.removePending(requestId),
      async listedSessions() {
        const call = await callWith('read', 'approvals_list', {});
        const approvals = (call.payload?.approvals ?? []) as Array<{ session: string }>;
        return [...new Set(approvals.map((entry) => entry.session))].sort();
      },
      async awaitingSessions() {
        const call = await callWith('read', 'overview', {});
        const rows = (call.payload?.awaitingPermission ?? []) as Array<{ sessionId: string }>;
        return [...new Set(rows.map((row) => row.sessionId))].sort();
      },
      auditRows() {
        return getConnection()
          .prepare('SELECT id, tool, outcome, denied_scopes FROM mcp_audit_log ORDER BY id ASC')
          .all() as AuditRow[];
      },
    });
  } finally {
    await read.transport.close().catch(() => undefined);
    await approve.transport.close().catch(() => undefined);
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

// --------------------------- fixtures ---------------------------

/** The ordinary tool's pending entry: a `Bash` call that has waited 3 seconds. */
function normalPending(sessionId: string): PendingSeed {
  return {
    requestId: R_NORMAL,
    sessionId,
    toolName: 'Bash',
    input: { command: 'echo hi' },
    receivedAt: new Date(NOW - WAITED_MS),
  };
}

/** The `AskUserQuestion` pending entry whose expansion is asserted verbatim. */
function askPending(sessionId: string, requestId = R_ASK): PendingSeed {
  return {
    requestId,
    sessionId,
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: '选哪个？',
          header: '选择',
          options: [
            { label: 'A', description: '甲' },
            { label: 'B', description: '乙' },
          ],
        },
      ],
    },
    receivedAt: new Date(NOW - 1_000),
  };
}

/** Reads the `approvals` array out of an `approvals_list` result. */
function approvalsOf(call: ToolCall): AnyRecord[] {
  return (call.payload?.approvals ?? []) as AnyRecord[];
}

/** Finds one approval entry by request id, asserting it is present. */
function entryFor(call: ToolCall, requestId: string): AnyRecord {
  const entry = approvalsOf(call).find((row) => row.requestId === requestId);
  assert.ok(entry, `approvals_list must carry ${requestId} (payload=${JSON.stringify(call.payload)})`);
  return entry;
}

// --------------------------- (a) list + expansion ---------------------------

test('(a) approvals_list reports both kinds and expands AskUserQuestion', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'list',
      pending: (sessionId) => [normalPending(sessionId), askPending(sessionId)],
    },
    async (harness) => {
      const call = await harness.call('approvals_list', { session: harness.sessionId });
      say(`(a) isError=${call.isError} payload=${JSON.stringify(call.payload)}`);

      assert.equal(call.isError, false, `approvals_list must not error (text=${call.text})`);
      const approvals = approvalsOf(call);
      assert.equal(approvals.length, 2, 'the fixture seeds exactly two pending approvals');

      const normal = entryFor(call, R_NORMAL);
      assert.equal(normal.session, harness.sessionId, 'the entry names its session');
      assert.equal(normal.toolName, 'Bash', 'the entry names its tool');
      assert.equal(
        String(normal.inputSummary).includes('echo hi'),
        true,
        'the ordinary entry summary must carry the command',
      );
      assert.equal(normal.waitedMs, WAITED_MS, 'waitedMs is computed from the injected clock');

      const ask = entryFor(call, R_ASK);
      const questions = (ask.questions ?? []) as AnyRecord[];
      assert.equal(questions.length, 1, 'the AskUserQuestion entry expands one question');
      assert.equal(questions[0].question, '选哪个？', 'the question text is expanded');
      const options = (questions[0].options ?? []) as Array<AnyRecord>;
      assert.equal(options.length, 2, 'both options are expanded');
      assert.equal(options[0].label, 'A');
      assert.equal(options[0].description, '甲');
      assert.equal(options[1].label, 'B');
      assert.equal(options[1].description, '乙');

      // The positive control the SPEC asks for: both kinds in ONE reading, so an
      // empty list and a non-expanding list each fail this leg.
      const kinds = approvals.map((row) => row.toolName).sort();
      assert.deepEqual(kinds, ['AskUserQuestion', 'Bash'], 'both a normal tool and an AskUserQuestion are present');
    },
  );
});

// --------------------------- (b) allow + message forwarding ---------------------------

test('(b) approval_answer forwards allow and message to resolveToolApproval once each', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'answer',
      pending: (sessionId) => [normalPending(sessionId)],
    },
    async (harness) => {
      const second = { ...normalPending(harness.sessionId), requestId: 'req-second', input: { command: 'ls' } };
      harness.addPending(second);

      const allow = await harness.call('approval_answer', { requestId: R_NORMAL, allow: true }, 'approve');
      const deny = await harness.call(
        'approval_answer',
        { requestId: 'req-second', allow: false, message: '不行' },
        'approve',
      );
      say(`(b) allowIsError=${allow.isError} allowPayload=${JSON.stringify(allow.payload)}`);
      say(`(b) denyIsError=${deny.isError} denyPayload=${JSON.stringify(deny.payload)}`);
      say(`(b) resolveCalls=${JSON.stringify(harness.resolveCalls)}`);

      assert.equal(allow.isError, false, `allow=true must succeed (text=${allow.text})`);
      assert.equal(deny.isError, false, `allow=false must succeed (text=${deny.text})`);
      assert.equal(resolveCountFor(harness.resolveCalls, R_NORMAL), 1, 'the resolver sees R_normal exactly once');
      assert.equal(resolveCountFor(harness.resolveCalls, 'req-second'), 1, 'the resolver sees req-second exactly once');

      const first = harness.resolveCalls.find((call) => call.requestId === R_NORMAL);
      assert.equal(first?.decision.allow, true, 'the allow decision reaches the runtime');
      const secondCall = harness.resolveCalls.find((call) => call.requestId === 'req-second');
      assert.equal(secondCall?.decision.allow, false, 'the deny decision reaches the runtime');
      assert.equal(secondCall?.decision.message, '不行', 'the message is forwarded verbatim');
    },
  );
});

// --------------------------- (c) answers -> updatedInput ---------------------------

test('(c) an AskUserQuestion answers argument arrives as updatedInput', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'answers',
      pending: (sessionId) => [askPending(sessionId)],
    },
    async (harness) => {
      const answers = { '选哪个？': 'A' };
      const call = await harness.call(
        'approval_answer',
        { requestId: R_ASK, allow: true, answers },
        'approve',
      );
      say(`(c) isError=${call.isError} payload=${JSON.stringify(call.payload)}`);
      say(`(c) decision=${JSON.stringify(harness.resolveCalls[0]?.decision)}`);

      assert.equal(call.isError, false, `the answers call must succeed (text=${call.text})`);
      assert.equal(resolveCountFor(harness.resolveCalls, R_ASK), 1, 'the resolver is called once');
      const decision = harness.resolveCalls[0]?.decision;
      assert.deepEqual(decision?.updatedInput, answers, 'answers is forwarded AS updatedInput, verbatim');
      assert.equal(decision?.allow, true, 'the allow decision rides alongside updatedInput');
    },
  );
});

// --------------------------- (d) expired / not found ---------------------------

test('(d) expired and never-seen request ids are APPROVAL_NOT_FOUND, reasons apart, without resolving', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'expired',
      pending: (sessionId) => [normalPending(sessionId)],
    },
    async (harness) => {
      // Expiry is the registry losing the id — the timeout transition.
      const before = await harness.call('approvals_list', { session: harness.sessionId });
      assert.ok(entryFor(before, R_NORMAL), 'the request must be listed while it is still in the registry');
      harness.removePending(R_NORMAL);

      const expired = await harness.call('approval_answer', { requestId: R_NORMAL, allow: true }, 'approve');
      const never = await harness.call('approval_answer', { requestId: 'req-never', allow: true }, 'approve');
      say(`(d) expiredIsError=${expired.isError} expiredPayload=${JSON.stringify(expired.payload)}`);
      say(`(d) neverIsError=${never.isError} neverPayload=${JSON.stringify(never.payload)}`);
      say(`(d) resolveCounts=${JSON.stringify(harness.resolveCalls)}`);

      // AC-287: a reference naming no live request is an ERROR, not an `ok:false`
      // reading. The old assertion (`isError === false`) pinned the shape this
      // task moves off the wire; the replacements below are strictly stronger —
      // they name the code, the cause, and its discrimination, none of which the
      // old reading could express.
      assert.equal(expired.isError, true, `an expired request is an error (text=${expired.text})`);
      assert.equal(expired.payload?.code, 'APPROVAL_NOT_FOUND', 'the expired error carries APPROVAL_NOT_FOUND');
      assert.equal(
        (expired.payload?.details as AnyRecord | undefined)?.reason,
        'expired',
        'a removed request was HELD, so it is expired',
      );
      assert.equal(never.isError, true, `a never-seen request is an error (text=${never.text})`);
      assert.equal(never.payload?.code, 'APPROVAL_NOT_FOUND', 'the never-seen error carries APPROVAL_NOT_FOUND');
      assert.equal(
        (never.payload?.details as AnyRecord | undefined)?.reason,
        'never_issued',
        'an id this runtime never held is never_issued',
      );
      assert.notEqual(
        (expired.payload?.details as AnyRecord | undefined)?.reason,
        (never.payload?.details as AnyRecord | undefined)?.reason,
        'the two causes are distinguished, not collapsed into one code',
      );
      assert.equal(
        String(expired.payload?.message ?? expired.text).includes('expired or does not exist'),
        true,
        'the expired reading says the request expired or does not exist',
      );
      assert.equal(
        String(never.payload?.message ?? never.text).includes('expired or does not exist'),
        true,
        'the never-seen reading says the request expired or does not exist',
      );
      assert.equal(resolveCountFor(harness.resolveCalls, R_NORMAL), 0, 'an expired request never reaches the resolver');
      assert.equal(resolveCountFor(harness.resolveCalls, 'req-never'), 0, 'a never-seen request never reaches the resolver');
    },
  );
});

// --------------------------- (e) scope ---------------------------

test('(e) a read-only token is denied with one denied audit row and no resolve', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'scope',
      pending: (sessionId) => [normalPending(sessionId)],
    },
    async (harness) => {
      const beforeRows = harness.auditRows();
      const denied = await harness.call('approval_answer', { requestId: R_NORMAL, allow: true }, 'read');
      const afterDenied = harness.auditRows();
      say(`(e) deniedIsError=${denied.isError} text=${JSON.stringify(denied.text)}`);
      say(`(e) newRows=${JSON.stringify(afterDenied.slice(beforeRows.length))}`);
      say(`(e) resolveCallsAfterDenied=${harness.resolveCalls.length}`);

      assert.equal(denied.isError, true, 'a token without cloudcli:approve is refused');
      const newRows = afterDenied.slice(beforeRows.length);
      assert.equal(newRows.length, 1, 'exactly one audit row is added for the denied call');
      assert.equal(newRows[0].tool, 'approval_answer', 'the denied row names the tool');
      assert.equal(newRows[0].outcome, 'denied', 'the denied row records the refusal');
      // AC-286: the denied row carries the scope the caller was missing.
      assert.deepEqual(
        JSON.parse(newRows[0].denied_scopes ?? 'null'),
        [APPROVE_SCOPE],
        'the denied row must carry the missing approve scope',
      );
      assert.equal(harness.resolveCalls.length, 0, 'the denied call never reaches the resolver');

      // Positive control: the token that carries cloudcli:approve is let through.
      const allowed = await harness.call('approval_answer', { requestId: R_NORMAL, allow: true }, 'approve');
      say(`(e) allowedIsError=${allowed.isError} payload=${JSON.stringify(allowed.payload)}`);
      say(`(e) resolveCallsAfterApprove=${harness.resolveCalls.length}`);
      assert.equal(allowed.isError, false, `the approve token is let through (text=${allowed.text})`);
      assert.equal(resolveCountFor(harness.resolveCalls, R_NORMAL), 1, 'the resolve token reaches the resolver once');
    },
  );
});

// --------------------------- (f) overview consistency ---------------------------

test('(f) the pending session set equals overview awaitingPermission, and neither carries the idle session', { concurrency: false }, async () => {
  await withHarness(
    {
      label: 'overview',
      pending: (sessionId) => [normalPending(sessionId), askPending(sessionId)],
      // Pin only the primary session to awaitingPermission; the cold session has
      // neither a pending approval nor the phase, so it must be in neither set.
      awaiting: (sessionId) => [sessionId],
    },
    async (harness) => {
      const listed = await harness.listedSessions();
      const awaiting = await harness.awaitingSessions();
      say(`(f) listedSessions=${JSON.stringify(listed)}`);
      say(`(f) awaitingSessions=${JSON.stringify(awaiting)}`);
      say(`(f) coldSessionId=${harness.coldSessionId}`);

      assert.deepEqual(listed, [harness.sessionId], 'the pending set names the waiting session');
      assert.deepEqual(awaiting, [harness.sessionId], 'the overview awaiting set names the same session');
      assert.deepEqual(listed, awaiting, 'the two readings agree');
      assert.equal(listed.includes(harness.coldSessionId), false, 'the idle session is not listed as pending');
      assert.equal(awaiting.includes(harness.coldSessionId), false, 'the idle session is not awaiting permission');
    },
  );
});
