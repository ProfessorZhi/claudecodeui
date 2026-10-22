/**
 * The `ui_open_session` criterion (gap-mcp-ui-open-session).
 *
 * The tool tells ONE connected browser to open a session and position it, and it
 * answers with the DELIVERY reading rather than with the user's decision. Every
 * leg below drives the REAL navigation service (`createUiNavigationService`) over
 * fake browser connections and reads the REAL tool (`buildUiOpenSession`), so the
 * frames a fake browser records are the frames the service wrote and the acks it
 * sends back are routed through the service's own `handleAck` / `handleResult` —
 * the same entry points the chat gateway's dispatch calls. Nothing between the
 * tool and the record is stubbed.
 *
 * One leg (`INSUFFICIENT_SCOPE`) is driven over a real `/mcp` mount behind the
 * production audited wrapper, because the scope refusal is the transport's and
 * cannot be exercised in process.
 *
 * Readings, one leg-group each:
 *   (1) device resolution — `client` is omittable with one device, REQUIRED with
 *       several (the refusal lists the candidates), `NO_CLIENT` with none, and a
 *       named reference resolves to exactly one device (`TARGET_AMBIGUOUS` with
 *       candidates, `CLIENT_NOT_FOUND` with the query); only the selected device
 *       is ever written to.
 *   (2) the delivery reading — `shown` ⇒ `pending_user`, `applied` ⇒ `applied`,
 *       `declined` ⇒ `declined`, silence ⇒ `unresponsive` — and the call returns
 *       at the ack, never waiting for a `ui.navigate_result`.
 *   (3) the retained record — a later `ui.navigate_result` mutates it in place,
 *       `ui_visible_context`'s `navigations[]` reflects it and is filterable by
 *       `navigationId`, an unknown id is dropped, and the log is pruned past 50
 *       records / 10 minutes.
 *   (4) the throttle, the scope refusal, the absent self-target guard, and the
 *       last-opened write: the 7th call a minute is `RATE_LIMITED` (the limit read
 *       from the exported constant), a token without `cloudcli:navigate` is
 *       `INSUFFICIENT_SCOPE`, a call against a live self-referential turn is NOT
 *       refused, and only a final `applied` writes last-opened.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';
import type { RequestHandler } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AnyRecord, RealtimeClientConnection, UiClientDevice, UiNavigationAck, UiNavigationRecord } from '@/shared/types.js';
import type { McpPrincipal } from '../mcp-gateway.auth.js';
import type { McpUiOpenSessionDeps, UiOpenSessionRateLimiter } from '../mcp-ui-open-session.js';
import type { McpUiVisibleContextDeps } from '../mcp-ui-visible-context.js';
import type { UiNavigationService } from '@/modules/websocket/index.js';
import type { McpWriteToolDeps } from '../index.js';

// `auth.middleware.ts` resolves the JWT secret at module-load time and
// `shared/utils.ts` freezes IS_PLATFORM on first import, so the environment is
// set before any aliased application module is pulled in — every application
// module below therefore comes in dynamically.
process.env.JWT_SECRET = 'mcp-ui-open-session-test-secret';
delete process.env.VITE_IS_PLATFORM;

// The audited wrapper writes one `mcp_audit_log` row per call, so the one leg
// that reaches the real mount needs a database with the CURRENT schema.
const dbDirectory = mkdtempSync(path.join(tmpdir(), 'mcp-ui-open-session-'));
process.env.DATABASE_PATH = path.join(dbDirectory, 'audit.db');
const { accessTokensDb, closeConnection, getConnection, initializeDatabase, oauthClientsDb } =
  await import('@/modules/database/index.js');
await initializeDatabase();

const { ACCESS_TOKEN_SCOPES } = await import('@/modules/oauth/index.js');
const {
  createUiNavigationService,
  WS_OPEN_STATE,
  UI_NAVIGATION_MAX_RECORDS,
  UI_NAVIGATION_RETENTION_MS,
} = await import('@/modules/websocket/index.js');
const {
  buildUiOpenSession,
  createUiOpenSessionRateLimiter,
  MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE,
  UI_OPEN_SESSION_RATE_WINDOW_MS,
} = await import('../mcp-ui-open-session.js');
const { buildUiVisibleContext } = await import('../mcp-ui-visible-context.js');
const { MCP_ERROR_CODES, McpToolError } = await import('../mcp-error-envelope.js');
const { MCP_GATEWAY_PATH, MCP_STAGE4_WRITE_TOOLS, mountMcpGateway } = await import('../index.js');
// The ONE principal-name resolution and its two fixed labels, imported from the
// module that owns them (same module, so a direct path is the barrel's equal):
// the bar's requester must be THIS resolution's output, not a test-local echo.
const { MCP_CLIENT_NAME_MAX_LENGTH, PERSONAL_TOKEN_LABEL } = await import('../mcp-write-notification.js');

/** `navigate` is the sixth scope, appended last so the five positional reads keep their index. */
const NAVIGATE_SCOPE = ACCESS_TOKEN_SCOPES[5] as string;

/** A principal as the transport hands it to the handler. */
function principal(overrides: Partial<McpPrincipal> = {}): McpPrincipal {
  return { userId: 1, tokenId: 1, clientId: 'client-1', scopes: [...ACCESS_TOKEN_SCOPES], ...overrides };
}

// =====================================================================
// the in-process rig: the real navigation service over fake browsers
// =====================================================================

/** One fake browser tab: the connection the server writes to, and what it answers with. */
type FakeTab = {
  /** The identity the registry announced for this tab. */
  identity: { deviceId: string; tabId: string; deviceName: string };
  /** When this tab's identity reached the server, ordering a device's tabs. */
  connectedAt: number;
  /** The live connection; `readyState` follows {@link FakeTab.closed}. */
  connection: RealtimeClientConnection;
  /** Every `ui.navigate` frame the server wrote to this tab, in order. */
  frames: AnyRecord[];
  /** The delivery ack this tab answers with; null makes it silent (the timeout arm). */
  ack: UiNavigationAck | null;
  /** A closed tab is never written to and never acks. */
  closed: boolean;
};

/** One fake tab with a live connection object. */
function makeTab(
  identity: FakeTab['identity'],
  overrides: Partial<Pick<FakeTab, 'connectedAt' | 'ack' | 'closed'>> = {},
): FakeTab {
  const tab: FakeTab = {
    identity,
    connectedAt: overrides.connectedAt ?? 1,
    frames: [],
    // `overrides.ack ?? 'applied'` would turn an explicit null (the silent arm)
    // back into 'applied'; the property's PRESENCE is what selects the default.
    ack: 'ack' in overrides ? overrides.ack ?? null : 'applied',
    closed: overrides.closed ?? false,
    connection: {
      readyState: WS_OPEN_STATE,
      send: () => undefined,
    },
  };
  tab.connection.readyState = tab.closed ? 3 : WS_OPEN_STATE;
  return tab;
}

/** The rig: the fake browsers, the real service, and the deps the tool is built from. */
type Rig = {
  tabs: FakeTab[];
  service: UiNavigationService;
  deps: McpUiOpenSessionDeps;
  /** The roster the tool resolves `client` against, built from the tabs. */
  listUiClients: () => UiClientDevice[];
};

/** The roster, built from the tabs the way the real registry builds it. */
function roster(tabs: FakeTab[]): UiClientDevice[] {
  const byDevice = new Map<string, UiClientDevice>();
  for (const tab of tabs) {
    let device = byDevice.get(tab.identity.deviceId);
    if (!device) {
      device = { deviceId: tab.identity.deviceId, deviceName: tab.identity.deviceName, tabs: [] };
      byDevice.set(tab.identity.deviceId, device);
    }
    device.tabs.push({ tabId: tab.identity.tabId, deviceName: tab.identity.deviceName, connectedAt: tab.connectedAt });
  }
  for (const device of byDevice.values()) {
    device.tabs.sort((left, right) => left.connectedAt - right.connectedAt);
  }
  return [...byDevice.values()];
}

/**
 * Builds a rig over the real navigation service.
 *
 * The `send` seam records the frame on the tab and, for a responding tab, acks it
 * on a microtask through the service's own `handleAck` — the same asynchronous
 * shape a real browser has, so "return at the delivery ack" is exercised rather
 * than "return synchronously". A silent tab records the frame and never answers,
 * which is what drives the timeout arm.
 */
function createRig(
  tabs: FakeTab[],
  options: { recordApplied?: (sessionId: string, at: number) => void; now?: () => number; rateLimiter?: UiOpenSessionRateLimiter } = {},
): Rig {
  const now = options.now ?? (() => Date.now());
  let service!: UiNavigationService;
  service = createUiNavigationService({
    listTargets: (deviceId) =>
      tabs
        .filter((tab) => tab.identity.deviceId === deviceId)
        .map((tab) => ({ connection: tab.connection, ...tab.identity, connectedAt: tab.connectedAt })),
    now,
    recordApplied: options.recordApplied,
    send: (connection, frame) => {
      const tab = tabs.find((candidate) => candidate.connection === connection);
      if (!tab) {
        return;
      }
      const written = frame as AnyRecord;
      tab.frames.push(written);
      if (tab.ack === null) {
        return;
      }
      const status = tab.ack;
      queueMicrotask(() => {
        service.handleAck(connection, {
          type: 'ui.navigate_ack',
          navigationId: written.navigationId,
          deviceId: tab.identity.deviceId,
          tabId: tab.identity.tabId,
          status,
        });
      });
    },
  });

  const listUiClients = (): UiClientDevice[] => roster(tabs);
  return {
    tabs,
    service,
    listUiClients,
    deps: {
      listUiClients,
      navigate: (request) => service.navigate(request),
      rateLimiter: options.rateLimiter,
    },
  };
}

/** The tool error as a TYPE, since {@link McpToolError} is imported as a value. */
type ToolError = InstanceType<typeof McpToolError>;

/** Asserts a rejected `buildUiOpenSession` is an {@link McpToolError} with `code`, returning it. */
async function refusal(run: () => Promise<unknown>, code: string): Promise<ToolError> {
  let captured: ToolError | null = null;
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof McpToolError, `expected an McpToolError, got ${String(error)}`);
    assert.equal(error.code, code, `expected code ${code}`);
    captured = error;
    return true;
  });
  assert.ok(captured !== null, 'assert.rejects must have produced a tool error');
  return captured;
}

// =====================================================================
// (1) device resolution
// =====================================================================

test('(1) with one device the client may be omitted, and only that device is written to', async () => {
  const laptop = makeTab({ deviceId: 'dev-laptop', tabId: 'l-1', deviceName: 'Laptop' }, { ack: 'applied' });
  const phone = makeTab({ deviceId: 'dev-phone', tabId: 'p-1', deviceName: 'Phone' }, { ack: 'shown' });
  const rig = createRig([laptop, phone]);

  // Omitted `client` with SEVERAL devices is refused — the ambiguity is not guessed at.
  const ambiguous = await refusal(
    () => buildUiOpenSession(rig.deps, { session: 'sess-1' }, principal()),
    MCP_ERROR_CODES.CLIENT_REQUIRED.code,
  );
  const candidates = (ambiguous.details as AnyRecord).candidates as AnyRecord[];
  assert.deepEqual(candidates.map((candidate) => candidate.id).sort(), ['dev-laptop', 'dev-phone']);
  assert.equal(laptop.frames.length, 0, 'a refused call must not write to any device');
  assert.equal(phone.frames.length, 0);

  // Naming one device writes to it and to no other.
  const payload = await buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'laptop' }, principal());
  assert.equal(payload.device.deviceId, 'dev-laptop');
  assert.equal(payload.status, 'applied');
  assert.equal(laptop.frames.length, 1, 'the named device receives exactly one frame');
  assert.equal(phone.frames.length, 0, 'the other device is never written to');
  assert.equal(laptop.frames[0].type, 'ui.navigate');
  assert.equal(laptop.frames[0].sessionId, 'sess-1');
  assert.equal(laptop.frames[0].navigationId, payload.navigationId, 'the frame carries the minted id');
});

test('(1) a single device is chosen without a client, and no device at all is NO_CLIENT', async () => {
  const only = makeTab({ deviceId: 'dev-only', tabId: 'o-1', deviceName: 'Only Browser' }, { ack: 'applied' });
  const single = createRig([only]);

  const payload = await buildUiOpenSession(single.deps, { session: 'sess-7' }, principal());
  assert.equal(payload.device.deviceId, 'dev-only', 'a lone device needs no id echoed back');
  assert.equal(only.frames.length, 1);

  const empty = createRig([]);
  const refusalError = await refusal(
    () => buildUiOpenSession(empty.deps, { session: 'sess-7' }, principal()),
    MCP_ERROR_CODES.NO_CLIENT.code,
  );
  assert.deepEqual((refusalError.details as AnyRecord).candidates, [], 'no browsers means no candidates');
});

test('(1) a named client that is ambiguous is refused with candidates, a miss with the query', async () => {
  const one = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Meeting Room' });
  const two = makeTab({ deviceId: 'dev-2', tabId: 't-2', deviceName: 'Meeting Room Two' });
  const rig = createRig([one, two]);

  const ambiguous = await refusal(
    () => buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'meeting room' }, principal()),
    MCP_ERROR_CODES.TARGET_AMBIGUOUS.code,
  );
  const candidates = (ambiguous.details as AnyRecord).candidates as AnyRecord[];
  assert.deepEqual(candidates.map((candidate) => candidate.id).sort(), ['dev-1', 'dev-2']);
  assert.equal(one.frames.length, 0, 'an ambiguous reference must not fall back to writing anywhere');
  assert.equal(two.frames.length, 0);

  const missing = await refusal(
    () => buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'does-not-exist' }, principal()),
    MCP_ERROR_CODES.CLIENT_NOT_FOUND.code,
  );
  assert.match(missing.message, /does-not-exist/, 'the refusal must carry the query that matched nothing');
  const offered = (missing.details as AnyRecord).candidates as AnyRecord[];
  assert.deepEqual(
    offered.map((candidate) => candidate.id).sort(),
    ['dev-1', 'dev-2'],
    'a miss offers the connected devices so the caller can retry with a real one',
  );
  assert.equal(one.frames.length, 0, 'a miss must not write anywhere');
  assert.equal(two.frames.length, 0);
});

// =====================================================================
// (2) the delivery reading; the call does not wait for the user
// =====================================================================

test('(2) the ack maps to the delivery status, and the call returns at the ack', async () => {
  const ask = makeTab({ deviceId: 'dev-ask', tabId: 'a-1', deviceName: 'Ask' }, { ack: 'shown' });
  const accept = makeTab({ deviceId: 'dev-accept', tabId: 'c-1', deviceName: 'Accept' }, { ack: 'applied' });
  const reject = makeTab({ deviceId: 'dev-reject', tabId: 'r-1', deviceName: 'Reject' }, { ack: 'declined' });
  const rig = createRig([ask, accept, reject]);

  const asked = await buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'dev-ask' }, principal());
  assert.equal(asked.status, 'pending_user', 'a shown bar is a pending decision, not a verdict');

  const accepted = await buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'dev-accept' }, principal());
  assert.equal(accepted.status, 'applied');

  const declined = await buildUiOpenSession(rig.deps, { session: 'sess-1', client: 'dev-reject' }, principal());
  assert.equal(declined.status, 'declined');

  // The call resolved on the ACK: no tab ever sent a `ui.navigate_result`, so a
  // tool that waited for the user's decision would still be pending here.
  const records = rig.service.listNavigations();
  assert.equal(records.length, 3);
  assert.ok(records.every((record) => record.status !== 'unresponsive'));
});

test('(2) a silent device resolves unresponsive at the delivery window', async () => {
  const silent = makeTab({ deviceId: 'dev-silent', tabId: 's-1', deviceName: 'Silent' }, { ack: null });
  const rig = createRig([silent]);

  const startedAt = Date.now();
  const payload = await buildUiOpenSession(rig.deps, { session: 'sess-1' }, principal());
  const elapsed = Date.now() - startedAt;

  assert.equal(payload.status, 'unresponsive', 'nobody listened, so the instruction did not land');
  assert.equal(silent.frames.length, 1, 'the frame was still written to the silent tab');
  assert.ok(elapsed >= 1_300, `the call must wait the delivery window out, saw ${elapsed}ms`);
  assert.ok(elapsed < 3_000, `the call must not wait far past the window, saw ${elapsed}ms`);
});

// =====================================================================
// (3) the retained record
// =====================================================================

test('(3) a later result updates the record, visible in ui_visible_context and filterable by id', async () => {
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'shown' });
  const rig = createRig([tab]);

  const payload = await buildUiOpenSession(rig.deps, { session: 'sess-1' }, principal());
  assert.equal(payload.status, 'pending_user');
  assert.equal(rig.service.listNavigations(payload.navigationId)[0].status, 'pending_user');

  // The user decides later; the tool has long since returned, and the result
  // names the RECORD by id.
  const handled = rig.service.handleResult(tab.connection, {
    type: 'ui.navigate_result',
    navigationId: payload.navigationId,
    deviceId: 'dev-1',
    tabId: 't-1',
    status: 'applied',
  });
  assert.equal(handled, true, 'a well-formed result for a retained record is applied');
  const updated = rig.service.listNavigations(payload.navigationId)[0];
  assert.equal(updated.status, 'applied');
  assert.equal(updated.tabId, 't-1', 'the result names the tab that carried the decision');

  // The reading `ui_visible_context` publishes, filterable by navigationId.
  const contextDeps: McpUiVisibleContextDeps = {
    listUiClients: rig.listUiClients,
    requestUiState: async () => [],
    listNavigations: (navigationId) => rig.service.listNavigations(navigationId),
  };
  const all = await buildUiVisibleContext(contextDeps, {});
  assert.equal(all.navigations.length, 1);
  assert.equal(all.navigations[0].navigationId, payload.navigationId);
  assert.equal(all.navigations[0].status, 'applied');

  const filtered = await buildUiVisibleContext(contextDeps, { navigationId: payload.navigationId });
  assert.equal(filtered.navigations.length, 1);
  const none = await buildUiVisibleContext(contextDeps, { navigationId: 'zzz-not-a-navigation' });
  assert.deepEqual(none.navigations, [], 'an unknown id narrows to nothing, not to everything');

  // An unknown result id is dropped: nothing is minted and nothing is mutated.
  assert.equal(
    rig.service.handleResult(tab.connection, {
      type: 'ui.navigate_result',
      navigationId: 'zzz-not-a-navigation',
      deviceId: 'dev-1',
      tabId: 't-1',
      status: 'applied',
    }),
    false,
    'a result for an id the log does not hold must be dropped',
  );
  assert.equal(rig.service.listNavigations().length, 1, 'a dropped result mints no record');
});

test('(3) records are pruned past 50 entries and past 10 minutes', async () => {
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'applied' });

  // Past 50: the oldest is retired on the next read.
  const many = createRig([tab]);
  const ids: string[] = [];
  for (let index = 0; index < UI_NAVIGATION_MAX_RECORDS + 1; index += 1) {
    const payload = await buildUiOpenSession(many.deps, { session: `sess-${index}` }, principal());
    ids.push(payload.navigationId);
  }
  const retained = many.service.listNavigations();
  assert.equal(retained.length, UI_NAVIGATION_MAX_RECORDS, 'the log is bounded at 50 records');
  assert.ok(!retained.some((record) => record.navigationId === ids[0]), 'the oldest record is retired');
  assert.ok(retained.some((record) => record.navigationId === ids[ids.length - 1]), 'the newest record is retained');

  // Past 10 minutes: a record the retention window retired is absent on read.
  let clock = 1_000_000;
  const timed = createRig([makeTab({ deviceId: 'dev-2', tabId: 't-2', deviceName: 'Browser' }, { ack: 'applied' })], {
    now: () => clock,
  });
  const one = await buildUiOpenSession(timed.deps, { session: 'sess-1' }, principal());
  assert.equal(timed.service.listNavigations().length, 1);
  clock += UI_NAVIGATION_RETENTION_MS + 1;
  assert.deepEqual(timed.service.listNavigations(), [], 'a record older than the retention window is gone');
  assert.deepEqual(timed.service.listNavigations(one.navigationId), [], 'and filtering cannot resurrect it');
});

// =====================================================================
// (4) the throttle, the scope refusal, the guard, and the last-opened write
// =====================================================================

test('(4) the 7th call in a minute is RATE_LIMITED, read from the exported limit', async () => {
  let clock = 0;
  const limiter = createUiOpenSessionRateLimiter({ now: () => clock });
  const tab = makeTab({ deviceId: 'dev-1', tabId: 't-1', deviceName: 'Browser' }, { ack: 'applied' });
  const rig = createRig([tab], { rateLimiter: limiter });
  const caller = principal({ tokenId: 7 });

  for (let index = 0; index < MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE; index += 1) {
    const payload = await buildUiOpenSession(rig.deps, { session: 'sess-1' }, caller);
    assert.equal(payload.status, 'applied');
  }
  assert.equal(
    tab.frames.length,
    MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE,
    'each allowed call wrote exactly one frame',
  );

  const limited = await refusal(
    () => buildUiOpenSession(rig.deps, { session: 'sess-1' }, caller),
    MCP_ERROR_CODES.RATE_LIMITED.code,
  );
  const details = limited.details as AnyRecord;
  assert.equal(details.limit, MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE, 'the reading names the exported limit');
  assert.equal(details.windowMs, UI_OPEN_SESSION_RATE_WINDOW_MS);
  assert.equal(tab.frames.length, MCP_UI_OPEN_SESSION_RATE_LIMIT_PER_MINUTE, 'a refused call writes no frame');

  // A DIFFERENT token has its own budget.
  const other = principal({ tokenId: 8 });
  const allowed = await buildUiOpenSession(rig.deps, { session: 'sess-1' }, other);
  assert.equal(allowed.status, 'applied', 'the throttle is per token, not global');

  // Once the window slides, the first token is allowed again.
  clock += UI_OPEN_SESSION_RATE_WINDOW_MS + 1;
  const recovered = await buildUiOpenSession(rig.deps, { session: 'sess-1' }, caller);
  assert.equal(recovered.status, 'applied', 'the window is a sliding reading, not a permanent ban');
});

test('(4) only a final applied writes last-opened, never a pending, declined or ignored outcome', async () => {
  const applied: Array<{ sessionId: string; at: number }> = [];
  const recordApplied = (sessionId: string, at: number): void => {
    applied.push({ sessionId, at });
  };

  // (a) an ask device: the delivery is pending_user, and a later `declined` is no write.
  const ask = makeTab({ deviceId: 'dev-ask', tabId: 'a-1', deviceName: 'Ask' }, { ack: 'shown' });
  const rig = createRig([ask], { recordApplied });
  const pending = await buildUiOpenSession(rig.deps, { session: 'sess-pending' }, principal());
  assert.equal(applied.length, 0, 'a pending decision writes nothing');
  rig.service.handleResult(ask.connection, {
    type: 'ui.navigate_result',
    navigationId: pending.navigationId,
    deviceId: 'dev-ask',
    tabId: 'a-1',
    status: 'declined',
  });
  assert.equal(applied.length, 0, 'a declined navigation writes nothing');

  // (b) the same record later becomes `applied`: exactly one write.
  rig.service.handleResult(ask.connection, {
    type: 'ui.navigate_result',
    navigationId: pending.navigationId,
    deviceId: 'dev-ask',
    tabId: 'a-1',
    status: 'applied',
  });
  assert.equal(applied.length, 1, 'one write on entering applied');
  assert.equal(applied[0].sessionId, 'sess-pending');
  assert.equal(typeof applied[0].at, 'number', 'the write carries the moment of the transition');

  // (c) a duplicate `applied` is not a second write.
  rig.service.handleResult(ask.connection, {
    type: 'ui.navigate_result',
    navigationId: pending.navigationId,
    deviceId: 'dev-ask',
    tabId: 'a-1',
    status: 'applied',
  });
  assert.equal(applied.length, 1, 'the transition into applied is written once, not once per frame');

  // (d) an accept device's delivery ack IS final, so it writes last-opened.
  const accept = makeTab({ deviceId: 'dev-accept', tabId: 'c-1', deviceName: 'Accept' }, { ack: 'applied' });
  const accepted = createRig([accept], { recordApplied });
  await buildUiOpenSession(accepted.deps, { session: 'sess-accept' }, principal());
  assert.deepEqual(applied.map((entry) => entry.sessionId), ['sess-pending', 'sess-accept']);

  // (e) `ignored` is a dismissal, not an opening.
  const settled = createRig([makeTab({ deviceId: 'dev-i', tabId: 'i-1', deviceName: 'I' }, { ack: 'shown' })], {
    recordApplied,
  });
  const ignored = await buildUiOpenSession(settled.deps, { session: 'sess-ignored' }, principal());
  settled.service.handleResult(settled.tabs[0].connection, {
    type: 'ui.navigate_result',
    navigationId: ignored.navigationId,
    deviceId: 'dev-i',
    tabId: 'i-1',
    status: 'ignored',
  });
  assert.equal(applied.length, 2, 'ignored / expired / superseded never write last-opened');
});

// =====================================================================
// (5) the requester the bar reads: a resolved NAME, never a null
// =====================================================================

/**
 * Inserts the owning user if it is not already there. `access_tokens.user_id`
 * is a real foreign key (`INIT_SCHEMA_SQL` turns `foreign_keys` on), so a token
 * row cannot name a user that does not exist.
 */
function seedRequesterOwner(): void {
  getConnection()
    .prepare('INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, ?)')
    .run(1, 'requester-owner', 'hash');
}

/** A unique token hash per inserted row, so the UNIQUE column never collides. */
let patSequence = 0;

/** Inserts one PAT row and returns its id, so a principal can name it by `tokenId`. */
function issuePat(name: string | null): number {
  patSequence += 1;
  seedRequesterOwner();
  return accessTokensDb.insert({
    userId: 1,
    tokenHash: `requester-pat-hash-${patSequence}`,
    tokenPrefix: `requester-pat-${patSequence}`,
    name,
    scopes: NAVIGATE_SCOPE,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date(0).toISOString(),
  });
}

/** The `navigations[]` reading, built exactly as the server builds it (the real rig's log). */
async function visibleNavigations(rig: Rig): Promise<AnyRecord[]> {
  const contextDeps: McpUiVisibleContextDeps = {
    listUiClients: rig.listUiClients,
    requestUiState: async () => [],
    listNavigations: (navigationId) => rig.service.listNavigations(navigationId),
  };
  const context = await buildUiVisibleContext(contextDeps, {});
  return context.navigations as unknown as AnyRecord[];
}

test('(5) a PAT names the bar by its token name, and the record carries the same string', async () => {
  const tab = makeTab({ deviceId: 'dev-r', tabId: 'r-1', deviceName: 'Reader' }, { ack: 'applied' });
  const rig = createRig([tab]);
  const patId = issuePat('probe-ui-open');

  const payload = await buildUiOpenSession(
    rig.deps,
    { session: 'sess-r' },
    // A personal access token has NO OAuth client — this is the shape that used
    // to leave `requestedBy` null and the bar showing the bare fallback.
    principal({ clientId: null, tokenId: patId }),
  );

  assert.equal(tab.frames.length, 1, 'the call writes exactly one frame');
  assert.equal(tab.frames[0].requester, 'probe-ui-open', 'the frame names the asking PAT');
  assert.equal(payload.status, 'applied');
  assert.equal(
    rig.service.listNavigations(payload.navigationId)[0].requestedBy,
    'probe-ui-open',
    'the record carries the resolved name',
  );
  const visible = await visibleNavigations(rig);
  assert.equal(visible[0].requestedBy, tab.frames[0].requester, 'ui_visible_context agrees with the frame');
});

test('(5) an OAuth token names the bar by its client display name', async () => {
  const tab = makeTab({ deviceId: 'dev-o', tabId: 'o-1', deviceName: 'OAuth Reader' }, { ack: 'applied' });
  const rig = createRig([tab]);
  oauthClientsDb.insert({
    clientId: 'oauth-probe-client',
    clientSecretHash: null,
    clientName: 'Claude Desktop',
    redirectUris: '[]',
    metadata: '{}',
    createdVia: 'dcr',
    createdAt: new Date(0).toISOString(),
  });

  const payload = await buildUiOpenSession(
    rig.deps,
    { session: 'sess-o' },
    principal({ clientId: 'oauth-probe-client', tokenId: 999_999 }),
  );

  assert.equal(
    tab.frames[0].requester,
    'Claude Desktop',
    'an OAuth client is named by its display name, not by its opaque id',
  );
  assert.equal(rig.service.listNavigations(payload.navigationId)[0].requestedBy, 'Claude Desktop');
});

test('(5) a nameless PAT still names the bar with a fixed label, never null', async () => {
  const tab = makeTab({ deviceId: 'dev-n', tabId: 'n-1', deviceName: 'Nameless' }, { ack: 'applied' });
  const rig = createRig([tab]);
  const patId = issuePat(null);

  const payload = await buildUiOpenSession(
    rig.deps,
    { session: 'sess-n' },
    principal({ clientId: null, tokenId: patId }),
  );

  const requester = tab.frames[0].requester;
  assert.equal(typeof requester, 'string', 'the frame always carries a string');
  assert.equal(requester, PERSONAL_TOKEN_LABEL, 'a nameless PAT falls back to the fixed label');
  assert.notEqual(requester, 'null', 'the literal "null" must never reach the bar');
  assert.equal(rig.service.listNavigations(payload.navigationId)[0].requestedBy, PERSONAL_TOKEN_LABEL);
});

test('(5) an over-long name is cut to the bounded length on both the frame and the record', async () => {
  const tab = makeTab({ deviceId: 'dev-t', tabId: 't-1', deviceName: 'Truncating' }, { ack: 'applied' });
  const rig = createRig([tab]);
  const longName = 'x'.repeat(MCP_CLIENT_NAME_MAX_LENGTH + 6);
  const patId = issuePat(longName);

  const payload = await buildUiOpenSession(
    rig.deps,
    { session: 'sess-t' },
    principal({ clientId: null, tokenId: patId }),
  );

  const requester = tab.frames[0].requester;
  assert.equal(typeof requester, 'string');
  assert.equal(requester.length, MCP_CLIENT_NAME_MAX_LENGTH, 'the name is bounded to the fixed length');
  assert.equal(requester, longName.slice(0, MCP_CLIENT_NAME_MAX_LENGTH), 'the head of the name survives');
  assert.equal(rig.service.listNavigations(payload.navigationId)[0].requestedBy, requester);
});

// =====================================================================
// (4) the scope refusal and the absent self-target guard, over a real mount
// =====================================================================

/** The SDK client's `fetch`, over `node:http`, so a port undici refuses cannot red this criterion. */
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

/** A live gateway write tool on the target session — the maximal self-target turn. */
const LIVE_SELF_TARGET_TURN = {
  phase: 'tool' as const,
  toolName: 'mcp__anything__session_send',
  toolDurationMs: 5,
};

/**
 * Boots one real `/mcp` mount with `ui_open_session` wired to a recorder, behind a
 * principal stamped with `scopes`. The self-target guard is configured with this
 * very tool in its write-tool set and a LIVE tool turn on the target — the
 * maximal setup a guard would need to refuse it — so a call that is not refused
 * proves the tool is deliberately outside both the protected-op set and the
 * `protect` wrapper.
 */
async function withGateway(
  scopes: readonly string[],
  run: (call: (args: AnyRecord) => Promise<AnyRecord>, navigateCalls: AnyRecord[]) => Promise<void>,
): Promise<void> {
  const navigateCalls: AnyRecord[] = [];
  const authorize: RequestHandler = (_req, res, next) => {
    res.locals.mcpPrincipal = { userId: 1, tokenId: 1, clientId: 'client-1', scopes: [...scopes] };
    next();
  };
  const uiOpenSession: McpUiOpenSessionDeps = {
    listUiClients: () => [
      { deviceId: 'dev-1', deviceName: 'Laptop', tabs: [{ tabId: 't-1', deviceName: 'Laptop', connectedAt: 1 }] },
    ],
    navigate: async (request) => {
      navigateCalls.push({ ...request });
      const record: UiNavigationRecord = {
        navigationId: 'nav-1',
        deviceId: request.deviceId,
        deviceName: request.deviceName,
        tabId: 't-1',
        sessionId: request.sessionId,
        at: request.at,
        requestedBy: request.requestedBy,
        requestedAt: 1,
        updatedAt: 1,
        status: 'applied',
      };
      return record;
    },
  };

  const app = express();
  app.use(express.json({ limit: '50mb' }));
  mountMcpGateway(app, {
    env: { MCP_ENABLED: 'true' },
    authorize,
    writeTools: { uiOpenSession } as unknown as McpWriteToolDeps,
    selfTarget: {
      readTurn: () => LIVE_SELF_TARGET_TURN,
      writeToolNames: [...MCP_STAGE4_WRITE_TOOLS.map((tool) => tool.name), 'ui_open_session'],
    },
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${MCP_GATEWAY_PATH}`), {
    fetch: nodeFetch,
  });
  // Never lists tools, so the SDK's output-validator cache stays cold and an
  // error envelope (which does not match the tool's output schema) is returned
  // rather than thrown as `-32602`.
  const client = new Client({ name: 'ui-open-session-probe', version: '0.0.0' });
  await client.connect(transport);

  try {
    await run(async (args) => {
      const result = await client.callTool({ name: 'ui_open_session', arguments: args } as Parameters<Client['callTool']>[0]);
      return result as unknown as AnyRecord;
    }, navigateCalls);
  } finally {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('(4) a token without cloudcli:navigate is refused INSUFFICIENT_SCOPE naming the scope', async () => {
  await withGateway([ACCESS_TOKEN_SCOPES[0] as string], async (call, navigateCalls) => {
    const result = await call({ session: 'sess-1' });
    assert.equal(result.isError, true, 'a token without the scope must be refused');
    const structured = result.structuredContent as AnyRecord;
    assert.equal(structured.code, MCP_ERROR_CODES.INSUFFICIENT_SCOPE.code);
    const required = (structured.details as AnyRecord).requiredScopes as string[];
    assert.ok(required.includes(NAVIGATE_SCOPE), `the missing set must name "${NAVIGATE_SCOPE}"`);
    assert.match(String(structured.message), new RegExp(NAVIGATE_SCOPE), 'the message must name the scope verbatim');
    assert.equal(navigateCalls.length, 0, 'a scope refusal must never reach the navigation service');
  });
});

test('(4) a fully scoped call executes against its own live turn — no SELF_TARGET', async () => {
  await withGateway(ACCESS_TOKEN_SCOPES, async (call, navigateCalls) => {
    const result = await call({ session: 'sess-1' });
    assert.notEqual(
      (result.structuredContent as AnyRecord)?.code,
      'SELF_TARGET',
      'opening the caller own session must not be refused by the self-target guard',
    );
    assert.notEqual(result.isError, true, `expected a payload, got ${JSON.stringify(result)}`);
    const structured = result.structuredContent as AnyRecord;
    assert.equal(structured.navigationId, 'nav-1');
    assert.equal(structured.status, 'applied');
    assert.deepEqual(structured.device, { deviceId: 'dev-1', deviceName: 'Laptop' });
    assert.equal(navigateCalls.length, 1, 'the call reached the navigation service exactly once');
    assert.equal(navigateCalls[0].sessionId, 'sess-1');
    assert.equal(
      navigateCalls[0].requestedBy,
      'client-1',
      'an OAuth client with no display-name row is named by its id, never left null',
    );
  });
});

// The one leg with a real mount has written its audit rows; close the connection
// so the temp database can be removed.
after(() => {
  closeConnection();
  rmSync(dbDirectory, { recursive: true, force: true });
});
