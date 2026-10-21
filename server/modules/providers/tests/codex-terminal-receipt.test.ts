import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadEvent } from '@openai/codex-sdk';

const root = mkdtempSync(path.join(os.tmpdir(), 'codex-terminal-'));
process.env.DATABASE_PATH = path.join(root, 'receipts.db');
const db = await import('@/modules/database/index.js');
const { providerRegistry } = await import('../index.js');
const { createChatRunRegistry } = await import('@/modules/websocket/index.js');
const { buildRunGet } = await import('@/modules/mcp-gateway/index.js');
await db.initializeDatabase(); after(() => db.closeConnection());
db.getConnection().prepare('INSERT OR IGNORE INTO users(id,username,password_hash) VALUES(1,?,?)').run('typed-terminal-fixture', 'no-login-fixture');
const codex = providerRegistry.resolveProvider('codex');
let sequence = 0;

async function replay(t: any, events: ThreadEvent[], abort = false) {
  const sessionId = `typed-codex-${++sequence}`;
  db.sessionsDb.createAppSession(sessionId, 'codex', root);
  const registry = createChatRunRegistry({ receipts: db.chatRunReceiptsDb, bootId: () => 'typed-producer' });
  const run = registry.startRun({ appSessionId: sessionId, provider: 'codex', providerSessionId: null, connection: null, userId: 1, source: 'mcp' })!;
  t.mock.method(Codex.prototype, 'startThread', () => ({ id: 'typed-native', async runStreamed() {
    return { events: (async function* () { for (const event of events) {
      if (abort && event.type === 'turn.completed') {
        await codex.runtime!.abort(sessionId);
        run.writer.sendComplete({ exitCode: 1, aborted: true });
      }
      yield event;
    } })() };
  } }) as unknown as Thread);
  await codex.runtime!.run('fixture event replay only', { sessionId, cwd: root }, run.writer, {
    resolveProviderSessionId: () => null, resolveResumeModel: async () => 'fixture-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fixture-model' }),
    normalizeMessage: (raw, id) => codex.sessions.normalizeMessage(raw, id), isProviderInstalled: async () => true,
  });
  const deps = { runs: registry, sessions: { fetchHistory: async () => ({ messages: [] }) }, activity: { snapshot: () => null }, now: () => Date.now(), sleep: async () => { throw new Error('No wait'); }, bootId: () => 'typed-producer' };
  return { result: await buildRunGet({ runId: run.runId }, deps), receipt: db.chatRunReceiptsDb.read(run.runId)!, cold: async () => buildRunGet({ runId: run.runId }, { ...deps, runs: createChatRunRegistry({ receipts: db.chatRunReceiptsDb, bootId: () => 'typed-cold' }), bootId: () => 'typed-cold' }) };
}
const started = { type: 'thread.started', thread_id: 'typed-native' } as const;
const text = { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OWN TYPED RESULT' } } as const;
const completed = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } } as const;
const failed = { type: 'turn.failed', error: { message: 'typed provider failure' } } as const;

test('actual Codex typed completion normalizer freezes success without inventing a process exit code', async t => {
  const h = await replay(t, [started, text, completed]);
  assert.equal(h.result.status, 'completed'); assert.equal(h.receipt.terminal!.success, true);
  assert.equal(h.receipt.terminal!.exitCode, null);
  assert.equal((h.receipt.terminal as any).completionSource, 'provider-turn-completed');
  assert.equal(h.receipt.resultSnapshot!.completeness, 'final');
  const cold = await h.cold(); assert.equal(cold.status, 'completed');
  assert.equal(cold.lastAssistantMessage!.content, 'OWN TYPED RESULT'); assert.equal(cold.resultAttribution, 'terminal_result_snapshot');
});

test('assistant text plus normal iterator EOF without typed completion remains unknown and partial', async t => {
  const h = await replay(t, [started, text]);
  assert.equal(h.result.status, 'unknown'); assert.equal(h.receipt.terminal!.success, null);
  assert.equal(h.receipt.terminal!.exitCode, null); assert.equal(h.receipt.resultSnapshot!.completeness, 'partial');
});

test('typed provider failure never becomes successful from text or a later completion event', async t => {
  for (const events of [[started, text, failed], [started, text, failed, completed]]) {
    const h = await replay(t, events); assert.equal(h.result.status, 'failed');
    assert.equal(h.receipt.terminal!.success, false); assert.equal(h.receipt.resultSnapshot!.completeness, 'partial');
    t.mock.restoreAll();
  }
});

test('actual abort before a typed completion remains aborted, never successful', async t => {
  const h = await replay(t, [started, text, completed], true);
  assert.equal(h.result.status, 'aborted'); assert.equal(h.receipt.terminal!.success, false);
  assert.equal(h.receipt.resultSnapshot!.completeness, 'partial');
});
