import fs from 'node:fs/promises';
import path from 'node:path';
const [phase, root, mode] = process.argv.slice(2);
const resolvedRoot = await fs.realpath(root);
const allowedRoot = await fs.realpath(process.env.TMPDIR!);
if (!path.isAbsolute(root) || root !== resolvedRoot || !root.startsWith(allowedRoot + path.sep)) throw new Error('Fixture root must be an owned artifact TMPDIR descendant without symlinks.');
process.env.DATABASE_PATH = path.join(root, 'shared.db');
process.env.JWT_SECRET = 'isolated-process-readback-fixture';
const db = await import('@/modules/database/index.js');
const { chatRunRegistry, BOOT_ID } = await import('@/modules/websocket/index.js');
const { providerRegistry, sessionsService } = await import('@/modules/providers/index.js');
const { buildRunGet } = await import('../../index.js');
await db.initializeDatabase();
const family = mode.startsWith('codex-') ? 'codex' : 'claude';
const sessionId = `native-readback-${mode}`;
const nativeId = `native-provider-${mode}`;
if (phase === 'write') {
  const transcript = path.join(root, 'native.jsonl');
  const raw = { type: 'assistant', uuid: 'native-assistant-uuid', timestamp: new Date().toISOString(), sessionId: nativeId, message: { role: 'assistant', content: [{ type: 'text', text: 'NATIVE EXACT RESULT' }] } };
  await fs.writeFile(transcript, JSON.stringify(raw)+'\n');
  db.sessionsDb.createSession(sessionId, family, root, 'Native history fixture', new Date().toISOString(), new Date().toISOString(), null);
  db.sessionsDb.assignProviderSessionId(sessionId, nativeId);
  db.getConnection().prepare('UPDATE sessions SET jsonl_path=? WHERE session_id=?').run(transcript, sessionId);
  const run = chatRunRegistry.startRun({ appSessionId: sessionId, provider: family, providerSessionId: nativeId, connection: null, userId: 1, source: 'mcp' })!;
  if (mode !== 'unfinished') {
    const normalized = providerRegistry.resolveProvider(family).sessions.normalizeMessage(family === 'claude' ? raw : { type: 'item', itemType: 'agent_message', itemId: 'item_0', message: { content: 'NATIVE EXACT RESULT' } }, nativeId);
    for (const message of normalized) run.writer.send(message);
    if (mode === 'codex-provider-turn') {
      for (const message of providerRegistry.resolveProvider(family).sessions.normalizeMessage({ type: 'turn_complete' }, nativeId)) run.writer.send(message);
    } else run.writer.sendComplete({ exitCode: 0 });
    const later = { ...raw, uuid: 'later-unrelated-uuid', message: { role: 'assistant', content: [{ type: 'text', text: 'LATER DIFFERENT RESULT' }] } };
    await fs.appendFile(transcript, JSON.stringify(later)+'\n');
    const next = chatRunRegistry.startRun({ appSessionId: sessionId, provider: family, providerSessionId: nativeId, connection: null, userId: 1, source: 'mcp' })!;
    const laterNormalized = providerRegistry.resolveProvider(family).sessions.normalizeMessage(family === 'claude' ? later : { type: 'item', itemType: 'agent_message', itemId: 'item_0', message: { content: 'LATER DIFFERENT RESULT' } }, nativeId);
    for (const message of laterNormalized) next.writer.send(message);
    next.writer.sendComplete({ exitCode: 0 });
  }
  await fs.writeFile(path.join(root, 'reference.json'), JSON.stringify({ runId: run.runId }));
  console.log('RESULT:'+JSON.stringify({ runId: run.runId, bootId: BOOT_ID }));
} else {
  const { runId } = JSON.parse(await fs.readFile(path.join(root, 'reference.json'), 'utf8'));
  const deps = { runs: chatRunRegistry, activity: { snapshot: () => null }, sessions: sessionsService, now: () => Date.now(), sleep: async () => { throw new Error('No wait.'); }, bootId: () => BOOT_ID };
  try {
    const result = await buildRunGet({ runId, session: sessionId }, deps);
    console.log('RESULT:'+JSON.stringify({ bootId: BOOT_ID, result }));
  } catch (error: any) { console.log('RESULT:'+JSON.stringify({ bootId: BOOT_ID, error: { code: error.code, details: error.details } })); }
}
db.closeConnection();
