import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import express from 'express';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'run-readback-'));
process.env.DATABASE_PATH = path.join(scratch, 'receipts.db');
process.env.JWT_SECRET = 'isolated-readback-fixture';
const database = await import('@/modules/database/index.js');
const { createChatRunRegistry } = await import('@/modules/websocket/index.js');
const { buildRunGet, mountMcpGateway, createMcpAuthMiddleware } = await import('../index.js');
const { createAccessTokensService } = await import('@/modules/oauth/index.js');
const { createNormalizedMessage } = await import('@/shared/utils.js');
await database.initializeDatabase();
database.getConnection().prepare('INSERT OR IGNORE INTO users(id,username,password_hash) VALUES(1,?,?)').run('run-reader', 'fixture');
after(() => database.closeConnection());
const receipts = (database as any).chatRunReceiptsDb;
let serial = 0;
function setup() {
  let at = 1_800_000_000_000;
  const registry = createChatRunRegistry({ retentionMs: 50, now: () => at, bootId: () => 'readback-boot', receipts } as any);
  const sessionId = `readback-${++serial}`;
  const run = registry.startRun({ appSessionId: sessionId, provider: 'claude', providerSessionId: 'native-session', connection: null, userId: 1, source: 'mcp' })!;
  const deps = { runs: registry, activity: { snapshot: () => null }, sessions: {
    fetchHistory: async () => ({ messages: [createNormalizedMessage({ kind: 'text', provider: 'claude', role: 'assistant', content: 'UNRELATED LATEST ANSWER' })] }),
  }, now: () => at, sleep: async () => { throw new Error('Snapshot must not wait.'); }, bootId: () => 'readback-boot' };
  return { registry, sessionId, run, deps, advance: (ms: number) => { at += ms; } };
}

async function callWire(port: number, token: string, name: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve(JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text)); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }));
  });
}

test('immediate terminal read uses its own run output and freezes elapsed time', async () => {
  const h = setup();
  h.run.writer.send(createNormalizedMessage({ id: 'own-assistant', kind: 'text', provider: 'claude', role: 'assistant', content: 'OWN RESULT' }));
  h.advance(250);
  h.run.writer.sendComplete({ exitCode: 0 });
  h.advance(5000);
  const result = await buildRunGet({ runId: h.run.runId, session: h.sessionId }, h.deps) as any;
  assert.equal(result.status, 'completed');
  assert.equal(result.lastAssistantMessage?.content, 'OWN RESULT');
  assert.equal(result.resultAttribution, 'run_events');
  assert.equal(result.elapsedMs, 250);
  assert.equal(result.durability, 'sqlite');
});

test('failed and aborted actual terminal receipts are distinct', async () => {
  for (const [exitCode, aborted, status] of [[1, false, 'failed'], [0, true, 'aborted']] as const) {
    const h = setup(); h.run.writer.sendComplete({ exitCode, aborted });
    const result = await buildRunGet({ runId: h.run.runId }, h.deps) as any;
    assert.equal(result.status, status);
    assert.equal(result.terminal.exitCode, exitCode);
    assert.equal(result.terminal.success, false);
  }
});

test('durable terminal receipt survives memory retention without attributing unrelated latest history', async () => {
  const h = setup(); h.run.writer.sendComplete({ exitCode: 0 }); h.advance(60_000);
  assert.equal(h.registry.getRunById(h.run.runId).status, 'unknown');
  const cold = createChatRunRegistry({ bootId: () => 'cold-boot', receipts } as any);
  const result = await buildRunGet({ runId: h.run.runId }, { ...h.deps, runs: cold, bootId: () => 'cold-boot' }) as any;
  assert.equal(result.status, 'completed'); assert.equal(result.durability, 'sqlite');
  assert.equal(result.lastAssistantMessage, null);
  assert.equal(result.resultAttribution, 'terminal_receipt');
});

test('missing run id is UNKNOWN and session context cannot prove no execution', async () => {
  const h = setup();
  await assert.rejects(() => buildRunGet({ runId: 'not-in-current-process', session: h.sessionId }, h.deps), (error: any) => {
    assert.equal(error.code, 'RUN_NOT_FOUND'); assert.equal(error.details.reason, 'unknown_in_current_process');
    assert.equal(error.details.retrySafe, false); assert.equal(error.details.mayHaveExecuted, true);
    assert.equal(error.details.fallback.attribution, 'session_history_unverified'); return true;
  });
});

test('a run id cannot be read as another requested session', async () => {
  const h = setup();
  await assert.rejects(() => buildRunGet({ runId: h.run.runId, session: 'other-session' }, h.deps), (error: any) => error.code === 'INVALID_ARGUMENT');
});

test('same owner receipt repository prevents identity retarget and terminal downgrade without message-body storage', () => {
  const h = setup(); h.run.writer.send(createNormalizedMessage({ id: 'candidate-native-id', kind: 'text', provider: 'claude', role: 'assistant', content: 'DO-NOT-COPY-TRANSCRIPT' })); h.run.writer.send(createNormalizedMessage({ id: 'final-only', kind: 'text', provider: 'claude', role: 'assistant', content: 'FINAL RUN SUMMARY' })); h.run.writer.sendComplete({ exitCode: 1 });
  assert.ok(receipts, 'existing SQLite must own the receipt repository');
  const record = receipts.read(h.run.runId);
  assert.ok(record.terminal); assert.equal(record.terminal.success, false);
  assert.throws(() => receipts.write({ ...record, sessionId: 'wrong-session' }));
  assert.throws(() => receipts.write({ ...record, status: 'running', terminal: null, completedAt: null }));
  const row = database.getConnection().prepare('SELECT * FROM chat_run_receipts WHERE run_id=?').get(h.run.runId);
  assert.equal(JSON.stringify(row).includes('DO-NOT-COPY-TRANSCRIPT'), false);
});

test('real separate processes reconstruct exact native output and keep unfinished previous boot UNKNOWN', () => {
  const fixture = fileURLToPath(new URL('./fixtures/run-readback-process.ts', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const mode of ['terminal', 'codex-terminal', 'unfinished']) {
    const childRoot = path.join(scratch, `process-${mode}`); mkdirSync(childRoot);
    const run = (phase: string) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx/esm', fixture, phase, childRoot, mode], {
        cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, TSX_TSCONFIG_PATH: path.join(repoRoot, 'server/tsconfig.json'), DATABASE_PATH: path.join(childRoot, 'shared.db') },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const line = result.stdout.split('\n').find((line) => line.startsWith('RESULT:'));
      assert.ok(line, result.stdout); return JSON.parse(line.slice(7));
    };
    const first = run('write'); const second = run('read');
    assert.notEqual(first.bootId, second.bootId, 'actual process boot identities must differ');
    if (mode !== 'unfinished') {
      assert.equal(second.result.status, 'completed'); assert.equal(second.result.durability, 'sqlite');
      assert.equal(second.result.runId, first.runId);
      assert.equal(second.result.lastAssistantMessage?.content, 'NATIVE EXACT RESULT');
      assert.equal(second.result.resultAttribution, mode === 'terminal' ? 'native_message_reference' : 'terminal_result_snapshot');
    } else {
      assert.equal(second.error.code, 'RUN_NOT_FOUND'); assert.equal(second.error.details.reason, 'unknown_after_restart');
      assert.equal(second.error.details.retrySafe, false);
    }
  }
});

test('actual MCP discovery marks override bound and historical placeholders unbound', async () => {
  const h = setup();
  database.getConnection().prepare('INSERT OR IGNORE INTO users(id,username,password_hash) VALUES(1,?,?)').run('run-reader', 'fixture');
  const tokens = createAccessTokensService({ now: () => new Date() });
  const issued = tokens.issueToken({ userId: 1, scopes: ['cloudcli:read'] }); assert.ok(issued.ok); if (!issued.ok) throw new Error('fixture token');
  const app = express(); app.use(express.json());
  mountMcpGateway(app, { env: { MCP_ENABLED: 'true' }, authorize: createMcpAuthMiddleware(tokens), readTools: { runGet: h.deps } as any });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const port = (server.address() as any).port;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const listing: any = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${issued.token.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text)));
      }); req.on('error', reject); req.end(body);
    });
    const byName = new Map<string, any>(listing.result.tools.map((tool: any) => [tool.name, tool]));
    assert.equal(byName.get('run_get')._meta['cloudcli/handlerBound'], true);
    assert.equal(byName.get('overview')._meta['cloudcli/handlerBound'], false);
    assert.equal(byName.get('quay_snapshot')._meta['cloudcli/handlerBound'], false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('registration persistence failure prevents admission before any provider can run', () => {
  const registry = createChatRunRegistry({ receipts: { write: () => { throw new Error('DB unavailable'); }, read: () => null } } as any);
  assert.throws(() => registry.startRun({ appSessionId: 'no-admission', provider: 'claude', providerSessionId: null, connection: null, userId: 1 }));
  assert.equal(registry.getRun('no-admission'), undefined);
});

test('post-effect terminal write failure is explicitly process-local and never durable completed after reconstruction', async () => {
  const store = { write: (receipt: any) => { if (receipt.terminal) throw new Error('Terminal write unavailable'); receipts.write(receipt); }, read: (id: string) => receipts.read(id) };
  const registry = createChatRunRegistry({ bootId: () => 'failed-write-boot', receipts: store } as any);
  const run = registry.startRun({ appSessionId: 'failed-terminal-write', provider: 'claude', providerSessionId: null, connection: null, userId: 1 })!;
  run.writer.sendComplete({ exitCode: 1 });
  const h = setup();
  const local = await buildRunGet({ runId: run.runId }, { ...h.deps, runs: registry, bootId: () => 'failed-write-boot' }) as any;
  assert.equal(local.status, 'failed'); assert.equal(local.durability, 'process_local');
  const cold = createChatRunRegistry({ receipts, bootId: () => 'after-write-failure' } as any);
  await assert.rejects(() => buildRunGet({ runId: run.runId }, { ...h.deps, runs: cold, bootId: () => 'after-write-failure' }), (error: any) => error.details.reason === 'unknown_after_restart');
});

test('actual CLI queue lifecycle is correlated to its UUID even when another run received the frame', async () => {
  const h = setup();
  const queued = h.registry.startRun({ appSessionId: h.sessionId, provider: 'claude', providerSessionId: 'native-session', connection: null, userId: 1, source: 'mcp', supersedeRunning: true })!;
  (h.registry as any).setRunQueuedInput(queued.runId, 'own-queued-uuid');
  const pending = await buildRunGet({ runId: queued.runId }, h.deps) as any;
  assert.equal(pending.status, 'queued'); assert.equal(pending.queue.uuid, 'own-queued-uuid');
  h.run.writer.send(createNormalizedMessage({ kind: 'command_lifecycle', provider: 'claude', commandUuid: 'own-queued-uuid', commandState: 'started' }));
  const started = await buildRunGet({ runId: queued.runId }, h.deps) as any;
  assert.equal(started.status, 'running'); assert.equal(started.queue.state, 'started');
  assert.equal((h.registry as any).getRunReadback(h.run.runId).queueState, null);
  queued.writer.sendComplete({ exitCode: 0 });
  assert.equal((await buildRunGet({ runId: queued.runId }, h.deps)).status, 'completed');
});

test('real Claude driver queue lookup selects this writer round instead of newest global UUID', async () => {
  const { ClaudeResidentHostDriver } = await import('@/modules/providers/index.js');
  const writerOne = {} as any; const writerTwo = {} as any;
  const state = { closed: false, rounds: [ { writer: writerOne, queuedUuids: ['uuid-one'] }, { writer: writerTwo, queuedUuids: ['uuid-two'] } ],
    queuedInputs: [ { uuid: 'uuid-one', startedAt: null }, { uuid: 'uuid-two', startedAt: null } ] };
  const driver = Object.create(ClaudeResidentHostDriver.prototype);
  driver.liveStateFor = () => state;
  assert.equal(driver.queuedInputUuid('session', writerOne), 'uuid-one');
  assert.equal(driver.queuedInputUuid('session', writerTwo), 'uuid-two');
  assert.equal(driver.queuedInputUuid('session', {}), null);
  assert.equal(driver.queuedInputUuid('session'), 'uuid-two', 'legacy no-writer lookup retains its explicit newest behavior');
});

test('an older eviction timer cannot delete a newer completed run', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const registry = createChatRunRegistry({ retentionMs: 100 });
  const input = { appSessionId: 'eviction-owner', provider: 'claude' as const, providerSessionId: null, connection: null, userId: 1 };
  const first = registry.startRun(input)!; first.writer.sendComplete({ exitCode: 0 });
  context.mock.timers.tick(50);
  const second = registry.startRun(input)!; second.writer.sendComplete({ exitCode: 0 });
  context.mock.timers.tick(50);
  assert.equal(registry.getRunById(second.runId).status, 'completed');
});


test('a lost real MCP send ACK does not stop the provider run; a new connection reads its exact terminal', async () => {
  const { chatRunRegistry, createChatControlService } = await import('@/modules/websocket/index.js');
  const { createMcpGatewayModule } = await import('../index.js');
  const sessionId = 'lost-mcp-ack-session';
  database.sessionsDb.createSession(sessionId, 'claude', scratch, 'Lost ACK fixture', new Date().toISOString(), new Date().toISOString(), null);
  let writer: any; let entered = 0; let release!: () => void; let request: http.ClientRequest;
  const held = new Promise<void>(resolve => { release = resolve; });
  const control = createChatControlService({ runtime: {
    hasRuntime: () => true,
    run: async (_provider: any, _command: any, _options: any, actualWriter: any) => {
      entered++; writer = actualWriter;
      request.destroy(new Error('intentional lost ACK'));
      await held;
      actualWriter.send(createNormalizedMessage({ id: 'lost-ack-own-result', kind: 'text', provider: 'claude', role: 'assistant', content: 'LOST ACK OWN RESULT' }));
      actualWriter.sendComplete({ exitCode: 0 });
    }, abort: async () => true,
  } } as any);
  const tokens = createAccessTokensService({ now: () => new Date() });
  const issued = tokens.issueToken({ userId: 1, scopes: ['cloudcli:read', 'cloudcli:session:send'] }); assert.ok(issued.ok); if (!issued.ok) throw new Error('fixture token');
  const runGet = { activity: { snapshot: () => null }, sessions: { fetchHistory: async () => ({ messages: [] }) }, now: () => Date.now(), sleep: async () => { throw new Error('No wait.'); }, bootId: () => chatRunRegistry.getRunReadback(chatRunRegistry.getRun(sessionId)!.runId)!.bootId };
  const app = express(); app.use(express.json());
  mountMcpGateway(app, createMcpGatewayModule({ env: { MCP_ENABLED: 'true' }, tokens, control,
    readTools: { runGet } as any, writeTools: { runGet: { deps: runGet, build: buildRunGet } },
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as any).port;
  try {
    await new Promise<void>((resolve, reject) => {
      request = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${issued.token.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => { res.resume(); reject(new Error('ACK should be lost before a response.')); });
      request.on('error', error => { if (error.message === 'intentional lost ACK') resolve(); else reject(error); });
      request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'session_send', arguments: { session: sessionId, message: 'held-task' } } }));
    });
    assert.equal(entered, 1); assert.ok(writer);
    const runId = chatRunRegistry.getRun(sessionId)!.runId;
    assert.equal(receipts.read(runId).status, 'running');
    const beforeBusy = (database.getConnection().prepare('SELECT COUNT(*) AS count FROM chat_run_receipts WHERE session_id=?').get(sessionId) as any).count;
    const busy = await callWire(port, issued.token.token, 'session_send', { session: sessionId, message: 'must-not-enqueue-while-busy' });
    assert.equal(busy.result.isError, true); assert.equal(busy.result.structuredContent.code, 'SESSION_BUSY');
    assert.equal(busy.result.structuredContent.details.runId, runId, 'the id is existing context, never a new ACK');
    assert.notEqual(busy.result.structuredContent.accepted, true);
    assert.equal(busy.result.structuredContent.queuedMessageUuid, undefined);
    assert.equal((database.getConnection().prepare('SELECT COUNT(*) AS count FROM chat_run_receipts WHERE session_id=?').get(sessionId) as any).count, beforeBusy);
    assert.equal(entered, 1, 'busy refusal must not execute or enqueue another task');
    release();
    // Test only: await the fixture's finite completion, never polling a server.
    await held; await new Promise<void>(resolve => setImmediate(resolve));
    const payload: any = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: `Bearer ${issued.token.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { try { resolve(JSON.parse(text.startsWith('event:') ? text.split('\n').find(line => line.startsWith('data:'))!.slice(5) : text)); } catch (error) { reject(error); } });
      }); req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_get', arguments: { runId, session: sessionId } } }));
    });
    assert.equal(payload.result.isError, undefined, JSON.stringify(payload));
    assert.equal(payload.result.structuredContent.status, 'completed');
    assert.equal(payload.result.structuredContent.lastAssistantMessage.content, 'LOST ACK OWN RESULT');
    assert.equal(entered, 1, 'reconnecting must not execute the task again');
  } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


test('Codex live item id is not a durable history id; bounded writer result survives instead', async () => {
  const { providerRegistry } = await import('@/modules/providers/index.js');
  const provider = providerRegistry.resolveProvider('codex').sessions;
  const raw = { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: 'HISTORY' } };
  const first = provider.normalizeMessage(raw, 'native'); const second = provider.normalizeMessage(raw, 'native');
  assert.notEqual(first[0].id, second[0].id, 'actual persisted history parser synthesizes a fresh id per read');
  const live = provider.normalizeMessage({ type: 'item', itemType: 'agent_message', itemId: 'item_0', message: { content: 'OWN CODEX RESULT' } }, 'native');
  const registry = createChatRunRegistry({ receipts } as any);
  const run = registry.startRun({ appSessionId: 'codex-proof', provider: 'codex', providerSessionId: 'native', connection: null, userId: 1 })!;
  run.writer.send(live[0]); run.writer.sendComplete({ exitCode: 0 });
  assert.equal(receipts.read(run.runId).assistantMessageId, null);
  assert.equal(receipts.read(run.runId).resultSnapshot.text, 'OWN CODEX RESULT');
});

test('terminal result snapshot has exact hashes and a UTF-8 safe 64KiB bound', async () => {
  const h = setup(); const text = '中'.repeat(22_000)+'END';
  h.run.writer.send(createNormalizedMessage({ id: 'large-final', kind: 'text', provider: 'claude', role: 'assistant', content: text })); h.run.writer.sendComplete({ exitCode: 0 });
  const snapshot = receipts.read(h.run.runId).resultSnapshot;
  assert.equal(snapshot.source, 'live-run-writer'); assert.equal(snapshot.completeness, 'final');
  assert.equal(snapshot.truncated, true); assert.ok(snapshot.storedBytes <= 64*1024);
  assert.equal(Buffer.byteLength(snapshot.text, 'utf8'), snapshot.storedBytes); assert.equal(snapshot.text.includes('�'), false);
  assert.equal(snapshot.utf8Bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(snapshot.sha256, createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(snapshot.storedSha256, createHash('sha256').update(snapshot.text, 'utf8').digest('hex'));
  const cold = createChatRunRegistry({ receipts, bootId: () => 'large-cold' } as any);
  const read = await buildRunGet({ runId: h.run.runId }, { ...h.deps, runs: cold, bootId: () => 'large-cold' }) as any;
  assert.equal(read.resultAttribution, 'terminal_result_snapshot'); assert.equal(read.lastAssistantMessage.content, snapshot.text);
});

test('failed/aborted snapshots stay partial, and late writer text cannot replace a terminal result', async () => {
  for (const aborted of [false, true]) {
    const h = setup(); h.run.writer.send(createNormalizedMessage({ id: 'before-failure', kind: 'text', provider: 'claude', role: 'assistant', content: 'PARTIAL OWN RESULT' }));
    h.run.writer.sendComplete({ exitCode: 1, aborted });
    h.run.writer.send(createNormalizedMessage({ id: 'too-late', kind: 'text', provider: 'claude', role: 'assistant', content: 'LATE MUST NOT REPLACE' }));
    assert.equal(receipts.read(h.run.runId).resultSnapshot.completeness, 'partial');
    const read = await buildRunGet({ runId: h.run.runId }, h.deps) as any;
    assert.equal(read.status, aborted ? 'aborted' : 'failed'); assert.equal(read.lastAssistantMessage.content, 'PARTIAL OWN RESULT');
    assert.equal(read.terminal.success, false);
  }
});


test('MCP busy acceptance without this writer queue UUID is unknown, never a fabricated successful ACK', async () => {
  const { chatRunRegistry, createChatControlService, BOOT_ID } = await import('@/modules/websocket/index.js');
  const { buildSessionSend } = await import('../index.js');
  const sessionId = 'queue-uuid-unknown-session';
  database.sessionsDb.createSession(sessionId, 'claude', scratch, 'Unknown queue fixture', new Date().toISOString(), new Date().toISOString(), null);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const control = createChatControlService({ runtime: { hasRuntime: () => true, acceptsBusyInput: () => true,
    queuedInputUuid: async () => null,
    run: async (_provider: any, _command: any, _options: any, writer: any) => { await held; writer.sendComplete({ exitCode: 0 }); }, abort: async () => true,
  } } as any);
  const runDeps = { runs: chatRunRegistry, activity: { snapshot: () => null }, sessions: { fetchHistory: async () => ({ messages: [] }) }, now: () => Date.now(), sleep: async () => { throw new Error('No wait.'); }, bootId: () => BOOT_ID };
  const deps = { control, runs: chatRunRegistry, runGet: { deps: runDeps, build: buildRunGet } };
  const ctx = { principal: { userId: 1, tokenId: 1, clientId: null, scopes: ['cloudcli:session:send'] } };
  try {
    const first = await buildSessionSend({ session: sessionId, message: 'first held task' }, ctx, deps);
    await assert.rejects(() => buildSessionSend({ session: sessionId, message: 'second uncertain task' }, ctx, deps), (error: any) => {
      assert.equal(error.code, 'QUEUE_ACCEPTANCE_UNKNOWN'); assert.equal(error.retryable, false);
      assert.notEqual(error.details.runId, first.runId, 'the uncertain run has its own registered ticket');
      assert.equal(error.details.retrySafe, false); assert.equal(error.details.mayHaveExecuted, true);
      assert.equal(receipts.read(error.details.runId).queuedMessageUuid, null);
      return true;
    });
  } finally { release(); await new Promise<void>(resolve => setImmediate(resolve)); }
});


test('opaque queue UUID cannot cross the emitting writer session or provider family', () => {
  const h = setup(); const shared = 'opaque-reused-uuid';
  h.registry.setRunQueuedInput(h.run.runId, shared);
  const other = h.registry.startRun({ appSessionId: 'other-queue-session', provider: 'claude', providerSessionId: 'other-native', connection: null, userId: 1 })!;
  other.writer.send(createNormalizedMessage({ kind: 'command_lifecycle', provider: 'claude', commandUuid: shared, commandState: 'cancelled' }));
  assert.equal(h.registry.getRunReadback(h.run.runId)!.queueState, 'queued');
  const foreign = h.registry.startRun({ appSessionId: h.sessionId, provider: 'codex', providerSessionId: 'other-family-native', connection: null, userId: 1, supersedeRunning: true })!;
  // The caller-visible label cannot override the receiving writer context.
  foreign.writer.send(createNormalizedMessage({ kind: 'command_lifecycle', provider: 'claude', commandUuid: shared, commandState: 'started' }));
  assert.equal(h.registry.getRunReadback(h.run.runId)!.queueState, 'queued');
});

test('late queue UUID binding cannot adopt cached lifecycle events from another session', () => {
  const h = setup(); const shared = 'late-reused-uuid';
  const other = h.registry.startRun({ appSessionId: 'other-late-queue-session', provider: 'claude', providerSessionId: 'other-native', connection: null, userId: 1 })!;
  other.writer.send(createNormalizedMessage({ kind: 'command_lifecycle', provider: 'claude', commandUuid: shared, commandState: 'started' }));
  h.registry.setRunQueuedInput(h.run.runId, shared);
  assert.equal(h.registry.getRunReadback(h.run.runId)!.queueState, 'queued');
});

test('terminal writer cannot retarget its native receipt or the newer current session', () => {
  const h = setup();
  database.sessionsDb.createSession(h.sessionId, 'claude', scratch, 'Owner fixture', new Date().toISOString(), new Date().toISOString(), null);
  h.run.writer.setSessionId('native-before-complete'); h.run.writer.sendComplete({ exitCode: 0 });
  const newer = h.registry.startRun({ appSessionId: h.sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: 1 })!;
  newer.writer.setSessionId('native-current-run');
  h.run.writer.setSessionId('native-old-writer-after-complete');
  assert.equal(receipts.read(h.run.runId).providerSessionId, 'native-before-complete');
  assert.equal(database.sessionsDb.getSessionById(h.sessionId)!.provider_session_id, 'native-current-run');
  assert.throws(() => receipts.write({ ...receipts.read(h.run.runId), providerSessionId: 'retarget-terminal' }));
});

test('running initialization binds native identity while superseded writer cannot replace current mapping', () => {
  const h = setup();
  database.sessionsDb.createSession(h.sessionId, 'claude', scratch, 'Owner fixture', new Date().toISOString(), new Date().toISOString(), null);
  h.run.writer.setSessionId('native-initial');
  assert.equal(database.sessionsDb.getSessionById(h.sessionId)!.provider_session_id, 'native-initial');
  const newer = h.registry.startRun({ appSessionId: h.sessionId, provider: 'claude', providerSessionId: null, connection: null, userId: 1, supersedeRunning: true })!;
  newer.writer.setSessionId('native-current'); h.run.writer.setSessionId('native-superseded');
  assert.equal(receipts.read(h.run.runId).providerSessionId, 'native-superseded');
  assert.equal(database.sessionsDb.getSessionById(h.sessionId)!.provider_session_id, 'native-current');
});

test('native message reference cannot read through a changed session mapping or family', async () => {
  const h = setup();
  h.run.writer.send(createNormalizedMessage({ id: 'opaque-assistant-id', kind: 'text', provider: 'claude', role: 'assistant', content: 'OWN SNAPSHOT' }));
  h.run.writer.sendComplete({ exitCode: 0 });
  const cold = createChatRunRegistry({ bootId: () => 'another-boot', receipts });
  for (const [nativeId, provider] of [['foreign-native', 'claude'], ['native-session', 'codex']] as const) {
    let foreignReads = 0;
    const result = await buildRunGet({ runId: h.run.runId }, { ...h.deps, runs: cold, bootId: () => 'another-boot', sessions: {
      ...h.deps.sessions, resolveProviderSessionId: () => nativeId, readSessionLifecycle: () => ({ provider }),
      fetchWindowAround: async () => { foreignReads++; return { messages: [createNormalizedMessage({ id: 'opaque-assistant-id', kind: 'text', provider, role: 'assistant', content: 'FOREIGN RESULT' })] }; },
    } } as any);
    assert.equal(foreignReads, 0); assert.equal((result as any).lastAssistantMessage.content, 'OWN SNAPSHOT');
    assert.equal((result as any).resultAttribution, 'terminal_result_snapshot');
  }
});

test('production gateway assembly advertises the actual SQLite admission receipt on a send ACK', async () => {
  const { createChatControlService } = await import('@/modules/websocket/index.js');
  const { createMcpGatewayModule } = await import('../index.js');
  const sessionId = 'durable-admission-ack';
  database.sessionsDb.createSession(sessionId, 'claude', scratch, 'ACK fixture', new Date().toISOString(), new Date().toISOString(), null);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const control = createChatControlService({ runtime: { hasRuntime: () => true, abort: async () => true,
    run: async (_provider: unknown, _command: unknown, _options: unknown, writer: any) => { await held; writer.sendComplete({ exitCode: 0 }); },
  } } as any);
  const tokens = createAccessTokensService({ now: () => new Date() });
  const issued = tokens.issueToken({ userId: 1, scopes: ['cloudcli:session:send'] }); assert.ok(issued.ok); if (!issued.ok) throw new Error('fixture');
  const runGet = { ...setup().deps }; const app = express(); app.use(express.json());
  mountMcpGateway(app, createMcpGatewayModule({ env: { MCP_ENABLED: 'true' }, tokens, control, writeTools: { runGet: { deps: runGet, build: buildRunGet } } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const ack = await callWire((server.address() as any).port, issued.token.token, 'session_send', { session: sessionId, message: 'held admission' });
    assert.equal(ack.result.isError, undefined); assert.equal(ack.result.structuredContent.durability, 'sqlite');
    assert.equal(receipts.read(ack.result.structuredContent.runId).status, 'running');
  } finally { release(); await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => server.close(() => resolve())); }
});
