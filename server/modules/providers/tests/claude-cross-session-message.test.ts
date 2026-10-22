import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

/**
 * The history projection of a message another session sent.
 *
 * A real CLI persists a peer message as a `user` row that is BOTH
 * `isMeta: true` (the marker the projection hides injected skill bodies and
 * caveats under) AND carries a first-class `origin: { kind: 'peer', … }`, with
 * the sender's words wrapped in a `cross-session-message` transport envelope.
 * The `isMeta` test alone dropped that row whole, so the receiving session's
 * transcript showed neither the message nor the divider that names it — while
 * the same turn's trigger was reported live. These two cases pin both halves of
 * the fix: the real row must reach history with its cause, and a truly internal
 * `isMeta` row must still be hidden.
 *
 * The rows below are transcribed from a real transcript on disk (a peer
 * message `99e21b71…` received from `7869a79b…`), not invented here: the point
 * of the criterion is that the test's row shape and the CLI's row shape are the
 * same on the field the gate reads.
 */

const PEER_SESSION_ID = 'claude-cross-session-peer';
const INTERNAL_SESSION_ID = 'claude-cross-session-internal';

/** The sending session's address, as the CLI records it on the row's `origin`. */
const SENDER_NAME = 'ready/todo/needs-human 任务队列推进';
/** The sender's own words — what a reader must see, in place of the envelope. */
const MESSAGE_BODY = '想跟你对一下 manager-tick-core 的两个缺陷：先是 eval 期直接崩，修好插值后也仍然只能在插件自己的开发工作区跑。';
const SEED_USER_TEXT = 'a turn the reader typed';
const INTERNAL_SKILL_TEXT = 'Base directory for this skill: /repo/.claude/skills/example';
const INTERNAL_CONTINUE_TEXT = 'Continue from where you left off.';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cross-session-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A transcript head the CLI writes before any conversation turn, addressed to one session. */
function headRows(sessionId: string): string[] {
  return [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: SEED_USER_TEXT },
      uuid: 'typed-1',
      timestamp: '2026-10-03T23:30:00.000Z',
      cwd: '/workspace/demo',
      sessionId,
    }),
  ];
}

/** The transport envelope the CLI wraps a peer message's body in, attributes included. */
function peerEnvelope(body: string, sender: string): string {
  return 'Another Claude session sent a message:\n'
    + `<cross-session-message from="uds:/run/user/1004/cc-socks/2789130.sock" from-name="${sender}" from-mode="bypass">\n`
    + `${body}\n`
    + '</cross-session-message>';
}

/** Writes one JSONL transcript and returns its path. */
async function writeTranscript(sessionId: string, lines: string[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-cross-session-'));
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, [...headRows(sessionId), ...lines, ''].join('\n'), 'utf8');
  return filePath;
}

/** Runs the provider's own history read (the projection `fetchHistory` delegates to) for one transcript. */
async function readHistory(sessionId: string, transcriptPath: string): Promise<NormalizedMessage[]> {
  const now = new Date().toISOString();
  sessionsDb.createSession(sessionId, 'claude', path.dirname(transcriptPath), 'cross-session', now, now, transcriptPath);
  const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, {
    providerSessionId: sessionId,
  });
  return history.messages;
}

test('history surfaces a real cross-session row with its origin and the sender\'s body', { concurrency: false }, async () => {
  const transcriptPath = await writeTranscript(PEER_SESSION_ID, [
    JSON.stringify({
      parentUuid: 'typed-1',
      isSidechain: false,
      isMeta: true,
      userType: 'external',
      type: 'user',
      origin: {
        kind: 'peer',
        from: 'uds:/run/user/1004/cc-socks/2789130.sock',
        verifiedPeerPid: 2789130,
        msg_id: 'caa8132b-6c4e-4642-94aa-565b8da059ef',
        name: SENDER_NAME,
        fromMode: 'bypass',
        body: MESSAGE_BODY,
      },
      message: { role: 'user', content: peerEnvelope(MESSAGE_BODY, SENDER_NAME) },
      uuid: 'peer-1',
      timestamp: '2026-10-03T23:41:00.000Z',
      cwd: '/workspace/demo',
      sessionId: PEER_SESSION_ID,
    }),
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const messages = await readHistory(PEER_SESSION_ID, transcriptPath);

      const withOrigin = messages.filter((message) => message.origin !== undefined);
      console.log(
        `messages.withOrigin=${withOrigin.length} `
        + `triggers=${JSON.stringify(withOrigin.map((message) => message.origin?.trigger))} `
        + `senders=${JSON.stringify(withOrigin.map((message) => message.origin?.sender))}`,
      );

      assert.equal(
        withOrigin.length,
        1,
        'exactly one history message must carry the cause the row stated — the red baseline reads 0',
      );
      const peer = withOrigin[0];
      assert.equal(peer.origin?.trigger, 'cross-session');
      assert.equal(peer.origin?.sender, SENDER_NAME);

      console.log(`peer.content=${JSON.stringify(peer.content)}`);
      assert.equal(
        peer.content,
        MESSAGE_BODY,
        'the row must show the sender\'s body, not the transport envelope',
      );
      assert.equal(
        messages.some((message) => typeof message.content === 'string' && message.content.includes('cross-session-message')),
        false,
        'the transport envelope must not survive into the transcript',
      );

      // The control: a projection that dropped every user row would satisfy the
      // line above, so a turn the reader typed must still be on the page.
      assert.equal(
        messages.some((message) => message.content === SEED_USER_TEXT),
        true,
        'a turn the reader typed is the positive control for the row above',
      );
    });
  } finally {
    await rm(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('history still hides an isMeta row that states no peer origin', { concurrency: false }, async () => {
  const transcriptPath = await writeTranscript(INTERNAL_SESSION_ID, [
    // A skill body: `isMeta`, no origin, content the prefix check also knows.
    JSON.stringify({
      parentUuid: 'typed-1',
      isSidechain: false,
      isMeta: true,
      type: 'user',
      message: { role: 'user', content: `${INTERNAL_SKILL_TEXT}\n\n# Example\n...` },
      uuid: 'meta-skill-1',
      timestamp: '2026-10-03T23:35:00.000Z',
      cwd: '/workspace/demo',
      sessionId: INTERNAL_SESSION_ID,
    }),
    // The discriminating row: `isMeta`, no origin, and content NO prefix check
    // catches — a real synthetic turn the CLI injects (observed on disk). Only
    // the `isMeta` gate hides it, so broadening the exemption to "admit every
    // `isMeta` row" leaks it and reddens this case.
    JSON.stringify({
      parentUuid: 'meta-skill-1',
      isSidechain: false,
      isMeta: true,
      type: 'user',
      message: { role: 'user', content: INTERNAL_CONTINUE_TEXT },
      uuid: 'meta-continue-1',
      timestamp: '2026-10-03T23:36:00.000Z',
      cwd: '/workspace/demo',
      sessionId: INTERNAL_SESSION_ID,
    }),
  ]);

  try {
    await withIsolatedDatabase(async () => {
      const messages = await readHistory(INTERNAL_SESSION_ID, transcriptPath);

      const leaked = messages.filter(
        (message) => typeof message.content === 'string'
          && (message.content.includes(INTERNAL_SKILL_TEXT) || message.content.includes(INTERNAL_CONTINUE_TEXT)),
      );
      console.log(`internal.leaked=${leaked.length} contents=${JSON.stringify(leaked.map((message) => message.content))}`);
      assert.equal(leaked.length, 0, 'an `isMeta` row with no peer origin must stay hidden');
      assert.equal(
        messages.filter((message) => message.origin !== undefined).length,
        0,
        'the negative control states no cause, so no message may carry one',
      );

      // The same positive control as the first case: the read ran, and only the
      // two internal rows are absent.
      assert.equal(
        messages.some((message) => message.content === SEED_USER_TEXT),
        true,
        'a turn the reader typed is the positive control for the two rows above',
      );
    });
  } finally {
    await rm(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});
