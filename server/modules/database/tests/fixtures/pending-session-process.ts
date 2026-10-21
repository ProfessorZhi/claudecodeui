import path from 'node:path';
import { realpathSync } from 'node:fs';

const [phase, root] = process.argv.slice(2);
if (!path.isAbsolute(root) || realpathSync(root) !== root || !root.startsWith(realpathSync(process.env.TMPDIR!) + path.sep)) {
  throw new Error('Fixture root must be an owned artifact TMPDIR descendant without symlinks.');
}
process.env.DATABASE_PATH = path.join(root, 'sessions.db');
const db = await import('@/modules/database/index.js');
await db.initializeDatabase();
if (phase === 'write') {
  for (const provider of ['claude', 'codex']) db.sessionsDb.createAppSession(`pending-${provider}`, provider, root);
  db.sessionsDb.createAppSession('bound-app', 'claude', root);
  db.sessionsDb.assignProviderSessionId('bound-app', 'real-native-bound');
  db.sessionsDb.createSession('discovered-native', 'codex', root);
}
const rows = db.getConnection().prepare('SELECT session_id,provider_session_id FROM sessions ORDER BY session_id').all();
console.log('RESULT:' + JSON.stringify({ pid: process.pid, rows }));
db.closeConnection();
