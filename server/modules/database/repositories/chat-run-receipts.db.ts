import { createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { CHAT_RUN_RECEIPTS_TABLE_SCHEMA_SQL } from '@/modules/database/schema.js';
import type { ChatRunReceipt, ChatRunReceiptStore } from '@/shared/types.js';

const initialized = new WeakSet<object>();
function connection() {
  const db = getConnection();
  // Normal production bootstrap migrates first. Lazy owner initialization also
  // supports existing internal registry consumers that run before full boot.
  if (!initialized.has(db)) { db.exec(CHAT_RUN_RECEIPTS_TABLE_SCHEMA_SQL); initialized.add(db); }
  return db;
}

/** Existing SQLite backing for the sole chatRunRegistry owner; no dispatch logic. */
export const chatRunReceiptsDb: ChatRunReceiptStore = {
  write(receipt) {
    // Whitelist references and structured facts: never accidentally persist a
    // full Run/event object or a transcript body handed through a wider type.
    const clean: ChatRunReceipt = {
      runId: receipt.runId, sessionId: receipt.sessionId, provider: receipt.provider,
      providerSessionId: receipt.providerSessionId, source: receipt.source,
      bootId: receipt.bootId, status: receipt.status, startedAt: receipt.startedAt,
      completedAt: receipt.completedAt, lastSeq: receipt.lastSeq,
      queued: receipt.queued, queuedMessageUuid: receipt.queuedMessageUuid,
      queueState: receipt.queueState, assistantMessageId: receipt.assistantMessageId,
      resultSnapshot: !receipt.resultSnapshot ? null : {
        text: receipt.resultSnapshot.text, messageId: receipt.resultSnapshot.messageId,
        timestamp: receipt.resultSnapshot.timestamp, source: receipt.resultSnapshot.source,
        completeness: receipt.resultSnapshot.completeness, truncated: receipt.resultSnapshot.truncated,
        utf8Bytes: receipt.resultSnapshot.utf8Bytes, storedBytes: receipt.resultSnapshot.storedBytes,
        sha256: receipt.resultSnapshot.sha256, storedSha256: receipt.resultSnapshot.storedSha256,
      },
      terminal: receipt.terminal === null ? null : {
        exitCode: receipt.terminal.exitCode, success: receipt.terminal.success, aborted: receipt.terminal.aborted,
      },
    };
    if (clean.terminal === null ? clean.status !== 'running' || clean.completedAt !== null
      : clean.status === 'running' || clean.completedAt === null || (clean.status === 'aborted') !== clean.terminal.aborted) {
      throw new Error('Run receipt lifecycle is inconsistent.');
    }
    if (clean.resultSnapshot) {
      const snapshot = clean.resultSnapshot;
      const length = Buffer.byteLength(snapshot.text, 'utf8');
      const final = clean.terminal?.success === true && clean.terminal.exitCode === 0 && !clean.terminal.aborted;
      if (!clean.terminal || length > 64 * 1024 || snapshot.storedBytes !== length || snapshot.utf8Bytes < length
        || snapshot.truncated !== (snapshot.utf8Bytes > length) || snapshot.source !== 'live-run-writer'
        || snapshot.completeness !== (final ? 'final' : 'partial')
        || snapshot.storedSha256 !== createHash('sha256').update(snapshot.text, 'utf8').digest('hex')
        || (!snapshot.truncated && snapshot.sha256 !== snapshot.storedSha256)) {
        throw new Error('Run result snapshot bounds, ownership or hash is inconsistent.');
      }
    }
    const result = connection().prepare(`
      INSERT INTO chat_run_receipts(run_id,session_id,boot_id,started_at,terminal,receipt_json)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET terminal=excluded.terminal,receipt_json=excluded.receipt_json
      WHERE chat_run_receipts.session_id=excluded.session_id
        AND chat_run_receipts.boot_id=excluded.boot_id
        AND chat_run_receipts.started_at=excluded.started_at
        AND json_extract(chat_run_receipts.receipt_json,'$.provider')=json_extract(excluded.receipt_json,'$.provider')
        AND json_extract(chat_run_receipts.receipt_json,'$.source')=json_extract(excluded.receipt_json,'$.source')
        AND (chat_run_receipts.terminal=0 OR (excluded.terminal=1
          AND json_extract(chat_run_receipts.receipt_json,'$.terminal')=json_extract(excluded.receipt_json,'$.terminal')
          AND json_extract(chat_run_receipts.receipt_json,'$.completedAt')=json_extract(excluded.receipt_json,'$.completedAt')
          AND json_extract(chat_run_receipts.receipt_json,'$.resultSnapshot') IS json_extract(excluded.receipt_json,'$.resultSnapshot')))
    `).run(clean.runId,clean.sessionId,clean.bootId,clean.startedAt,clean.terminal === null ? 0 : 1,JSON.stringify(clean));
    if (result.changes !== 1) throw new Error('Run receipt identity conflict or terminal downgrade.');
  },
  read(runId) {
    const row = connection().prepare('SELECT run_id,session_id,boot_id,started_at,receipt_json FROM chat_run_receipts WHERE run_id=?').get(runId) as { run_id: string; session_id: string; boot_id: string; started_at: number; receipt_json: string } | undefined;
    if (!row) return null;
    const receipt = JSON.parse(row.receipt_json) as ChatRunReceipt;
    if (receipt.runId !== row.run_id || receipt.sessionId !== row.session_id || receipt.bootId !== row.boot_id || receipt.startedAt !== row.started_at) throw new Error('Stored Run receipt identity is inconsistent.');
    return receipt;
  },
};
