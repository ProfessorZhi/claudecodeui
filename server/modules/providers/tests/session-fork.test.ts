import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { sessionHostManager } from '@/modules/session-hosts/index.js';
import type { IProviderFork } from '@/shared/interfaces.js';

const SOURCE_ID = 'fork-source';

type ForkCall = {
  providerSessionId: string;
  jsonlPath: string;
  upToAnchorId?: string;
  title?: string;
};

async function withForkableClaude(
  runTest: (context: { calls: ForkCall[]; directory: string }) => Promise<void>,
  options: { disableFork?: boolean } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-fork-'));
  const sourcePath = path.join(directory, 'native-source.jsonl');
  const forkedPath = path.join(directory, 'native-fork.jsonl');
  await writeFile(sourcePath, '{}\n', 'utf8');
  await writeFile(forkedPath, '{}\n', 'utf8');

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const calls: ForkCall[] = [];
  const claude = providerRegistry.resolveProvider('claude') as { fork?: IProviderFork };
  const realFork = claude.fork;
  const replacement = options.disableFork
    ? undefined
    : {
      forkSession: async (input: ForkCall) => {
        calls.push(input);
        return { providerSessionId: 'native-fork', jsonlPath: forkedPath };
      },
    } as IProviderFork;

  Object.defineProperty(claude, 'fork', { value: replacement, configurable: true, writable: true });

  try {
    await runTest({ calls, directory });
  } finally {
    Object.defineProperty(claude, 'fork', { value: realFork, configurable: true, writable: true });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function seedSource(directory: string): void {
  const now = new Date().toISOString();
  sessionsDb.createSession(
    SOURCE_ID,
    'claude',
    directory,
    'Original session',
    now,
    now,
    path.join(directory, 'native-source.jsonl'),
  );
  sessionsDb.assignProviderSessionId(SOURCE_ID, 'native-source');
}

test('a fork becomes an independent session that points back at its source', async () => {
  await withForkableClaude(async ({ calls, directory }) => {
    seedSource(directory);

    const result = await sessionsService.forkSessionById(SOURCE_ID, { upToAnchorId: 'uuid-3' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerSessionId, 'native-source');
    assert.equal(calls[0].upToAnchorId, 'uuid-3');

    const forked = sessionsDb.getSessionById(result.sessionId);
    assert.ok(forked);
    // Written before the watcher can see the new file, so it is never indexed
    // a second time under its provider-native id.
    assert.equal(forked?.provider_session_id, 'native-fork');
    assert.equal(forked?.jsonl_path, path.join(directory, 'native-fork.jsonl'));
    assert.equal(forked?.forked_from_session_id, SOURCE_ID);
    // The branch inherits the source's name rather than gaining a "(fork)"
    // suffix: the sidebar draws the lineage from forked_from_session_id, and a
    // suffix inside the name is the first thing an ellipsis eats on a narrow row.
    assert.equal(forked?.custom_name, 'Original session');
    // The old shape named the branch by appending a marker to the source name.
    // Asserted as a literal so this stays a real negative control: the branch
    // name must not carry the suffix the sidebar can no longer rely on.
    assert.notEqual(forked?.custom_name, 'Original session (fork)');

    // The source is untouched: this is "try two approaches", not a move.
    const source = sessionsDb.getSessionById(SOURCE_ID);
    assert.equal(source?.provider_session_id, 'native-source');
    assert.equal(source?.custom_name, 'Original session');
  });
});

test('a fork inherits the model, effort, and permission mode of the conversation it branched from', async () => {
  await withForkableClaude(async ({ directory }) => {
    seedSource(directory);
    sessionsDb.setSessionModel(SOURCE_ID, 'claude-opus-5');
    sessionsDb.setSessionEffort(SOURCE_ID, 'xhigh');
    sessionsDb.setSessionPermissionMode(SOURCE_ID, 'plan');

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    const forked = sessionsDb.getSessionById(result.sessionId);
    assert.equal(forked?.model, 'claude-opus-5');
    assert.equal(forked?.effort, 'xhigh');
    // The branch continues the same conversation, so it continues with the
    // mode that conversation was running in rather than snapping back to the
    // provider default.
    assert.equal(forked?.permission_mode, 'plan');
  });
});

test('a fork inherits the lifecycle mode of the conversation it branched from, without starting a host', async () => {
  await withForkableClaude(async ({ directory }) => {
    seedSource(directory);
    sessionsDb.setSessionLifecycleMode(SOURCE_ID, 'resident');

    const hostsBefore = sessionHostManager.snapshot().length;
    const result = await sessionsService.forkSessionById(SOURCE_ID);

    const sourceMode = sessionsDb.getSessionLifecycleMode(SOURCE_ID);
    const forkedMode = sessionsDb.getSessionLifecycleMode(result.sessionId);
    const forkedRow = sessionsDb.getSessionById(result.sessionId);
    // A host "started by the fork" is one that serves the new session: nothing
    // else in this path opens a host, so a non-zero count here is exactly the
    // regression this reading exists to catch.
    const hostsStartedByFork = sessionHostManager
      .snapshot()
      .filter((host) => host.bindings.has(result.sessionId)).length;
    const hostsAfter = sessionHostManager.snapshot().length;

    console.log(
      `sourceMode=${sourceMode} forkedMode=${forkedMode} hostsStartedByFork=${hostsStartedByFork}`,
    );

    assert.equal(sourceMode, 'resident', 'the source must really be resident for this to be a test');
    // The branch continues the same conversation, so it continues under the same
    // lifecycle mode rather than snapping back to the column default. AC-169's
    // "a fork does not inherit" was overturned by the human ruling of
    // 2026-10-07 (see docs/proposals/claude-resident-sessions.md §13.5).
    assert.equal(forkedMode, 'resident', 'a fork must inherit the source lifecycle mode');
    assert.equal(forkedRow?.forked_from_session_id, SOURCE_ID, 'the fork must point back at its source');
    // The mode is a stored preference, not a running process: forking copies the
    // value and starts nothing, so no host serves the new session until its
    // first turn is sent.
    assert.equal(hostsStartedByFork, 0, 'forking must not start a host for the new session');
    assert.equal(hostsAfter, hostsBefore, 'forking must not change the host population');
  });
});

test('a fork of a per-run session stays per-run', async () => {
  await withForkableClaude(async ({ directory }) => {
    seedSource(directory);

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    const sourceMode = sessionsDb.getSessionLifecycleMode(SOURCE_ID);
    const forkedMode = sessionsDb.getSessionLifecycleMode(result.sessionId);

    console.log(`sourceMode=${sourceMode} forkedMode=${forkedMode}`);

    // Positive control against "always write resident": a per-run source has no
    // mode to hand down, so the branch stays per-run.
    assert.equal(sourceMode, 'per-run');
    assert.equal(forkedMode, 'per-run', 'a per-run source must not produce a resident fork');
  });
});

test('a fork of a session that never sent a mode records none either', async () => {
  await withForkableClaude(async ({ directory }) => {
    seedSource(directory);

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    assert.equal(sessionsDb.getSessionById(result.sessionId)?.permission_mode, null);
  });
});

test('forking replaces a row the watcher already made for the new transcript', async () => {
  await withForkableClaude(async ({ directory }) => {
    seedSource(directory);
    // The watcher wins the race and indexes the fork under its native id.
    const now = new Date().toISOString();
    sessionsDb.createSession(
      'native-fork',
      'claude',
      directory,
      'Indexed by the watcher',
      now,
      now,
      path.join(directory, 'native-fork.jsonl'),
    );

    const result = await sessionsService.forkSessionById(SOURCE_ID);

    assert.equal(sessionsDb.getSessionById('native-fork'), null);
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.provider_session_id, 'native-fork');
  });
});

test('a session with no transcript yet cannot be forked', async () => {
  await withForkableClaude(async ({ directory }) => {
    // An app-created session that has never run: no provider id, no transcript.
    sessionsDb.createAppSession('never-ran', 'claude', directory, 'Never ran');

    await assert.rejects(
      () => sessionsService.forkSessionById('never-ran'),
      (error: Error & { code?: string }) => error.code === 'FORK_SOURCE_NOT_READY',
    );
  });
});

test('a provider without the capability is refused rather than silently ignored', async () => {
  await withForkableClaude(
    async ({ directory }) => {
      seedSource(directory);

      await assert.rejects(
        () => sessionsService.forkSessionById(SOURCE_ID),
        (error: Error & { code?: string }) => error.code === 'FORK_NOT_SUPPORTED',
      );
    },
    { disableFork: true },
  );
});

test('forking a session that does not exist is a 404', async () => {
  await withForkableClaude(async () => {
    await assert.rejects(
      () => sessionsService.forkSessionById('no-such-session'),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// real SDK fork, anchored on an assistant reply
// ---------------------------------------------------------------------------

/** The SDK sanitizes a project path by replacing every non-alphanumeric with `-`. */
const encodeProjectDir = (projectPath: string): string => projectPath.replace(/[^a-zA-Z0-9]/g, '-');

const REAL_FORK_SOURCE_ID = 'real-fork-source';
const REAL_FORK_PROJECT_PATH = '/workspace/demo';
// Real UUIDs: the SDK validates both the session id and `upToMessageId` against
// a uuid shape and refuses anything else before it ever looks the session up.
const REAL_FORK_PROVIDER_SESSION_ID = '77777777-7777-4777-8777-777777777777';
const U1 = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222222';
const U2 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const U3 = '55555555-5555-4555-8555-555555555555';
const A3 = '66666666-6666-4666-8666-666666666666';

/**
 * A two-turn transcript whose first turn calls a tool, so a fork cut at the
 * first answer has a tool_use to leave behind. Written where the SDK looks for
 * it: `<CLAUDE_CONFIG_DIR>/projects/<sanitized-cwd>/<id>.jsonl`.
 */
async function writeRealForkTranscript(configDir: string, providerSessionId: string): Promise<string> {
  const projectsDir = path.join(configDir, 'projects', encodeProjectDir(REAL_FORK_PROJECT_PATH));
  await mkdir(projectsDir, { recursive: true });
  const rows = [
    { type: 'user', uuid: U1, parentUuid: null, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:00.000Z', message: { role: 'user', content: 'first question' } },
    { type: 'assistant', uuid: A1, parentUuid: U1, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'let me check.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }] } },
    { type: 'user', uuid: U2, parentUuid: A1, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
    { type: 'assistant', uuid: A2, parentUuid: U2, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] } },
    { type: 'user', uuid: U3, parentUuid: A2, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:04.000Z', message: { role: 'user', content: 'second question' } },
    { type: 'assistant', uuid: A3, parentUuid: U3, sessionId: providerSessionId, cwd: REAL_FORK_PROJECT_PATH, timestamp: '2026-08-23T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] } },
  ];
  const transcriptPath = path.join(projectsDir, `${providerSessionId}.jsonl`);
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('a fork cut at an assistant forkAnchorId ends at that reply with no dangling tool_use', { concurrency: false }, async () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'session-fork-real-'));
  const configDir = path.join(tempRoot, '.claude');
  const providerSessionId = REAL_FORK_PROVIDER_SESSION_ID;

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();

  try {
    const transcriptPath = await writeRealForkTranscript(configDir, providerSessionId);
    const now = new Date().toISOString();
    sessionsDb.createSession(
      REAL_FORK_SOURCE_ID,
      'claude',
      REAL_FORK_PROJECT_PATH,
      'Original session',
      now,
      now,
      transcriptPath,
    );
    sessionsDb.assignProviderSessionId(REAL_FORK_SOURCE_ID, providerSessionId);

    // The anchor comes from the field the product writes, not from a literal:
    // this is what the fork button would send. `CLAUDE_CONFIG_DIR` is what the
    // real SDK resolves its projects directory from, so the fixture above is
    // where it will look.
    const history = await new ClaudeSessionsProvider().fetchHistory(REAL_FORK_SOURCE_ID, {
      providerSessionId,
      projectPath: REAL_FORK_PROJECT_PATH,
    });
    const firstAnswer = history.messages.find((message) => message.content === 'first answer');
    assert.ok(firstAnswer, 'the first turn’s answer should be in the transcript');
    const forkAnchorId = firstAnswer.forkAnchorId;
    assert.equal(forkAnchorId, A2, 'the first turn’s fork anchor is its final assistant row');

    process.env.CLAUDE_CONFIG_DIR = configDir;
    const result = await sessionsService.forkSessionById(REAL_FORK_SOURCE_ID, { upToAnchorId: forkAnchorId });

    const forked = sessionsDb.getSessionById(result.sessionId);
    assert.ok(forked?.jsonl_path, 'the fork should record where its transcript landed');
    const forkedRows = (await readFile(forked.jsonl_path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } });

    // The SDK appends a `custom-title` bookkeeping row of its own; the product's
    // last *message* row is what the conversation ends on.
    const messageRows = forkedRows.filter((row) => row.type === 'user' || row.type === 'assistant');
    const lastRow = messageRows[messageRows.length - 1];
    assert.equal(lastRow?.type, 'assistant');
    assert.deepEqual(lastRow?.message?.content, [{ type: 'text', text: 'first answer' }]);
    // Nothing from the second turn leaked into the branch.
    assert.equal(messageRows.some((row) => JSON.stringify(row.message?.content ?? '').includes('second')), false);

    const toolUseIds: string[] = [];
    const toolResultIds: string[] = [];
    for (const row of messageRows) {
      const content = row.message?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const part of content as Array<{ type?: string; id?: string; tool_use_id?: string }>) {
        if (part.type === 'tool_use' && part.id) {
          toolUseIds.push(part.id);
        }
        if (part.type === 'tool_result' && part.tool_use_id) {
          toolResultIds.push(part.tool_use_id);
        }
      }
    }
    const danglingToolUse = toolUseIds.filter((id) => !toolResultIds.includes(id));
    assert.deepEqual(danglingToolUse, []);
    console.log(`danglingToolUse=${danglingToolUse.length} lastRow=assistant`);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
