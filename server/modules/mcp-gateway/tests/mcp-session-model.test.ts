import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const root = mkdtempSync(path.join(os.tmpdir(), 'session-model-'));
process.env.DATABASE_PATH = path.join(root, 'model.db');
const db = await import('@/modules/database/index.js');
const { sessionsService, providerModelsService, providerCapabilitiesService } = await import('@/modules/providers/index.js');
const { buildSessionCreate, buildSessionCreateDeps } = await import('../index.js');
await db.initializeDatabase();
after(() => db.closeConnection());
const ctx = { principal: { userId: 1, scopes: [], tokenId: 'fixture' } } as any;
// The catalog reader arrived with 1.40 (`providerModelsService.assertSelectableModel`).
// These cases exercise the PERSISTENCE mechanics, so they name fixture models that
// no real catalog lists; the guard must stay out of their way and is proven by
// `session_create`'s own argument tests instead.
const fixtureModels = {
  ...providerModelsService,
  assertSelectableModel: async (_provider: string, model: string): Promise<string> => model,
};
let calls = 0;
function wiring(overrides: Record<string, unknown> = {}) {
  return buildSessionCreateDeps({
    projects: { getProjectPaths: () => [{ project_id: 'fixture', custom_project_name: null, project_path: root }] as any },
    sessions: sessionsService, capabilities: providerCapabilitiesService, models: fixtureModels,
    control: { send: async (_caller: unknown, input: any) => {
      calls++;
      const row = db.sessionsDb.getSessionById(input.sessionId)!;
      assert.equal(row.model, input.options.model);
      assert.equal(row.permission_mode, input.options.permissionMode);
      return { ok: true, runId: 'same-owner-run', queued: false };
    } } as any,
    ...overrides,
  });
}
function rowCount() { return (db.getConnection().prepare('SELECT count(*) AS count FROM sessions').get() as any).count; }

test('explicit model and max permission persist for both families with no model turn', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const permissionMode = 'bypassPermissions';
    const before = calls;
    const result = await buildSessionCreate({ project: 'fixture', provider, model: ` ${provider}-explicit-fixture `, permissionMode }, ctx, wiring());
    const row = db.sessionsDb.getSessionById(result.sessionId)!;
    const effective = await providerModelsService.resolveSessionModel(provider, { sessionId: result.sessionId });
    assert.equal(row.model, `${provider}-explicit-fixture`); assert.equal(row.permission_mode, permissionMode);
    assert.equal(effective.model, row.model); assert.equal(effective.source, 'session');
    assert.equal(effective.permissionMode, permissionMode); assert.equal(effective.provider, provider);
    assert.equal(calls, before); assert.equal(result.runId, undefined);
  }
});

test('dontAsk is accepted where the provider declares it and refused where it does not', async () => {
  // The mode an unattended run needs: the session must exist and the row must
  // carry the mode, or the create is a session that still waits for a person.
  const created = await buildSessionCreate(
    { project: 'fixture', provider: 'claude', permissionMode: 'dontAsk' }, ctx, wiring());
  const row = db.sessionsDb.getSessionById(created.sessionId)!;
  assert.equal(row.permission_mode, 'dontAsk');

  // The other half of the same matrix: a provider that never declared the mode
  // refuses it before a row exists, rather than recording a preference its
  // runtime cannot honour.
  const before = rowCount();
  await assert.rejects(
    () => buildSessionCreate({ project: 'fixture', provider: 'codex', permissionMode: 'dontAsk' }, ctx, wiring()),
    (e: any) => e.code === 'UNSUPPORTED_PERMISSION_MODE'
      && (e.details?.supported as string[]).includes('bypassPermissions')
      && !(e.details?.supported as string[]).includes('dontAsk'),
  );
  assert.equal(rowCount(), before);
});

test('opening send receives the verified model and max permission after their SQLite write', async () => {
  const before = calls;
  const result = await buildSessionCreate({ project: 'fixture', provider: 'codex', model: 'codex-first-fixture', permissionMode: 'bypassPermissions', message: 'fixture only' }, ctx, wiring());
  assert.equal(calls, before + 1); assert.equal(result.runId, 'same-owner-run');
});

test('omitted model preserves native defaults and original send shape', async () => {
  let sent: any;
  const result = await buildSessionCreate({ project: 'fixture', provider: 'claude', message: 'fixture only' }, ctx, wiring({ control: { send: async (_: unknown, input: unknown) => { sent = input; return { ok: true, runId: 'native-default' }; } } }));
  assert.equal(db.sessionsDb.getSessionById(result.sessionId)!.model, null);
  assert.deepEqual(sent, { sessionId: result.sessionId, content: 'fixture only' });
});

test('explicit model without persistence and readback owner refuses before row creation', async () => {
  const before = rowCount();
  await assert.rejects(() => buildSessionCreate({ project: 'fixture', model: 'explicit' }, ctx, wiring({ models: { setSessionPermissionMode: providerModelsService.setSessionPermissionMode } })), (e: any) => e.code === 'MCP_TOOL_NOT_IMPLEMENTED');
  assert.equal(rowCount(), before);
});

test('a setter echo without actual session persistence cannot claim model applied or start a run', async () => {
  const before = calls;
  // The row-writing adapter also drops the selection here, so the pre-fix
  // three-parameter shape and the echoing setter together are the ONLY places
  // the model could land — which is what this case is about. With the selection
  // intact the create itself records the model, and an echoing setter would be
  // merely redundant rather than load-bearing.
  const droppingSessions = {
    ...sessionsService,
    createAppSession: (provider: string, projectPath: string, initialMessage: string) =>
      sessionsService.createAppSession(provider as any, projectPath, initialMessage),
  };
  await assert.rejects(() => buildSessionCreate({ project: 'fixture', model: 'must-be-persisted', message: 'do not run' }, ctx, wiring({ sessions: droppingSessions as any, models: {
    ...fixtureModels,
    setSessionModel: (provider: string, sessionId: string, model: string) => ({ provider, sessionId, model, source: 'session' }),
  } })), (e: any) => {
    assert.equal(e.code, 'SESSION_CONFIGURATION_FAILED'); assert.equal(e.details.mayHaveCreatedSession, true);
    assert.ok(db.sessionsDb.getSessionById(e.details.sessionId)); assert.equal(e.details.retrySafe, false); return true;
  });
  assert.equal(calls, before);
});

test('configuration write failure retains actual created identity and never sends', async () => {
  const before = calls;
  await assert.rejects(() => buildSessionCreate({ project: 'fixture', model: 'explicit', message: 'do not run' }, ctx, wiring({ models: {
    ...fixtureModels, setSessionModel: () => { throw new Error('fixture write failure'); },
  } })), (e: any) => e.code === 'SESSION_CONFIGURATION_FAILED' && !!db.sessionsDb.getSessionById(e.details.sessionId));
  assert.equal(calls, before);
});

test('empty explicit model is rejected before any row', async () => {
  const before = rowCount();
  await assert.rejects(() => buildSessionCreate({ project: 'fixture', model: '  ' }, ctx, wiring()), (e: any) => e.code === 'INVALID_ARGUMENT');
  assert.equal(rowCount(), before);
});
