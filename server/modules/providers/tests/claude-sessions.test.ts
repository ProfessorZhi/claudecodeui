import assert from 'node:assert/strict';
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { buildLookupMap } from '@/shared/utils.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-provider-db-'));

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

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

/**
 * Writes a minimal valid Claude JSONL session file with enough fields for
 * `extractFirstValidJsonlData` to parse `sessionId` and `cwd`.
 *
 * `firstPrompt: null` puts the CLI's own bookkeeping entry where the user's
 * first message would be. The head still parses — both `sessionId` and `cwd`
 * ride on that entry — but nothing in the file names the session, which is the
 * shape a transcript has when the indexer has to fall through to the names
 * below the transcript: the history file, or the placeholder.
 */
async function writeSessionJsonl(
  dirPath: string,
  fileName: string,
  lines: string[],
  options: { firstPrompt?: string | null } = {},
): Promise<string> {
  const filePath = path.join(dirPath, fileName);
  const firstPrompt = options.firstPrompt === undefined ? 'first prompt' : options.firstPrompt;
  const head = [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: 'test-session-1' }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'test-session-1' }),
    firstPrompt === null
      ? JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          isMeta: true,
          type: 'user',
          message: { role: 'user', content: '<system-reminder>Session context loaded</system-reminder>' },
          uuid: 'msg-1',
          timestamp: '2026-07-10T00:00:00.000Z',
          cwd: '/workspace/demo',
          sessionId: 'test-session-1',
        })
      : JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          type: 'user',
          message: { role: 'user', content: firstPrompt },
          uuid: 'msg-1',
          timestamp: '2026-07-10T00:00:00.000Z',
          cwd: '/workspace/demo',
          sessionId: 'test-session-1',
        }),
  ];
  const content = [...head, ...lines, ''].join('\n');
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

const SESSION_ID = 'claude-session-1';
const AGENT_ID = 'a1b2c3d4e5f60718';
const AGENT_TOOL_USE_ID = 'toolu_agent_1';

/**
 * Writes the transcript pair current Claude versions produce for one async
 * subagent: the parent session, and the agent's own transcript plus sidecar
 * metadata under `<session>/subagents/`.
 */
async function writeClaudeSubagentSession(projectDirectory: string): Promise<string> {
  const parentPath = path.join(projectDirectory, `${SESSION_ID}.jsonl`);
  const subagentDirectory = path.join(projectDirectory, SESSION_ID, 'subagents');
  await mkdir(subagentDirectory, { recursive: true });

  const parentLines = [
    {
      type: 'assistant',
      uuid: 'assistant-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: AGENT_TOOL_USE_ID,
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'Survey the repo', prompt: 'Look around' },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'launch-ack-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:00:01.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: AGENT_TOOL_USE_ID,
          content: 'Async agent launched successfully. agentId: internal bookkeeping',
        }],
      },
      toolUseResult: {
        isAsync: true,
        status: 'async_launched',
        agentId: AGENT_ID,
        description: 'Survey the repo',
        resolvedModel: 'claude-opus-5',
      },
    },
    {
      type: 'user',
      uuid: 'notification-1',
      sessionId: SESSION_ID,
      timestamp: '2026-08-21T10:05:00.000Z',
      message: {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            '<task-notification>',
            `<task-id>${AGENT_ID}</task-id>`,
            `<tool-use-id>${AGENT_TOOL_USE_ID}</tool-use-id>`,
            '<status>completed</status>',
            '<summary>Agent "Survey the repo" finished</summary>',
            '<result>The repo has two packages.</result>',
            '</task-notification>',
          ].join('\n'),
        }],
      },
    },
  ];
  await writeFile(parentPath, `${parentLines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

  const agentLines = [
    {
      type: 'assistant',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-08-21T10:00:30.000Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'Starting the survey.' },
          { type: 'tool_use', id: 'toolu_child_1', name: 'Read', input: { file_path: '/repo/package.json' } },
        ],
      },
    },
    {
      type: 'user',
      isSidechain: true,
      agentId: AGENT_ID,
      timestamp: '2026-08-21T10:00:31.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_child_1', content: '{"name":"repo"}' }],
      },
    },
  ];
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.jsonl`),
    `${agentLines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  await writeFile(
    path.join(subagentDirectory, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'Explore', description: 'Survey the repo', toolUseId: AGENT_TOOL_USE_ID, spawnDepth: 1 }),
    'utf8',
  );

  return parentPath;
}

test('Claude history attaches a subagent transcript stored under the session directory', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-subagent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      assert.ok(agentRow, 'the Agent call must be in the transcript');
      assert.equal(agentRow.subagent?.id, AGENT_ID);
      assert.equal(agentRow.subagent?.type, 'Explore');
      assert.equal(agentRow.subagent?.description, 'Survey the repo');
      assert.equal(agentRow.subagent?.status, 'completed');

      // The agent's own work — prose and tool calls — comes from its separate
      // transcript, which is the file the previous lookup never found.
      assert.equal(agentRow.subagentTools?.length, 2);
      assert.equal(agentRow.subagentTools?.[0].kind, 'text');
      assert.equal(agentRow.subagentTools?.[1].toolName, 'Read');
      assert.equal(agentRow.subagentTools?.[1].toolResult?.content, '{"name":"repo"}');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history folds an agent task notification into the call that spawned it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-notification-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      // The launch acknowledgement is internal bookkeeping; the agent's answer
      // is what belongs on its card.
      assert.equal(agentRow?.toolResult?.content, 'The repo has two packages.');

      const strayNotification = history.messages.find(
        (message) => typeof message.content === 'string' && message.content.includes('<task-notification>'),
      );
      assert.equal(strayNotification, undefined, 'the folded notification must not also render on its own');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/** Strips the `<task-notification>` turn so the agent has no reported outcome. */
async function dropTaskNotification(parentPath: string): Promise<void> {
  const raw = await readFile(parentPath, 'utf8');
  await writeFile(
    parentPath,
    `${raw.split('\n').filter((line) => line && !line.includes('task-notification')).join('\n')}\n`,
    'utf8',
  );
}

test('Claude history reads a missing notification off the agent\'s own transcript', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-finished-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);
    await dropTaskNotification(parentPath);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      // The notification can be compacted out of a long session. The agent's
      // transcript ends on a resolved tool call, so it finished — reporting it
      // as still running would leave a spinner on the card forever.
      assert.equal(agentRow?.subagent?.status, 'completed');
      assert.equal(agentRow?.toolResult?.content, '', 'the launch acknowledgement must never show as a result');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history keeps an agent running when its transcript stops mid tool call', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-running-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);
    await dropTaskNotification(parentPath);

    // Drop the child tool result: the agent is mid-call, which is the only
    // in-file evidence that it is still working.
    const agentPath = path.join(tempRoot, SESSION_ID, 'subagents', `agent-${AGENT_ID}.jsonl`);
    const agentRaw = await readFile(agentPath, 'utf8');
    await writeFile(
      agentPath,
      `${agentRaw.split('\n').filter((line) => line && !line.includes('tool_result')).join('\n')}\n`,
      'utf8',
    );

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );

      assert.equal(agentRow?.subagent?.status, 'running');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Claude history trims a subagent timeline down to a preview', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-big-agent-'));

  try {
    const parentPath = await writeClaudeSubagentSession(tempRoot);

    // One child command with a very large output, which is what makes an
    // agent-heavy session's history payload balloon.
    const hugeOutput = 'x'.repeat(50_000);
    const agentPath = path.join(tempRoot, SESSION_ID, 'subagents', `agent-${AGENT_ID}.jsonl`);
    const agentRaw = await readFile(agentPath, 'utf8');
    const enlarged = agentRaw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line) as { message?: { content?: Array<{ type?: string; content?: string }> } };
        for (const part of entry.message?.content ?? []) {
          if (part.type === 'tool_result') {
            part.content = hugeOutput;
          }
        }
        return JSON.stringify(entry);
      })
      .join('\n');
    await writeFile(agentPath, `${enlarged}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Subagent session', now, now, parentPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, {
        providerSessionId: SESSION_ID,
      });
      const agentRow = history.messages.find(
        (message) => message.kind === 'tool_use' && message.toolId === AGENT_TOOL_USE_ID,
      );
      const childResult = String(agentRow?.subagentTools?.[1].toolResult?.content ?? '');

      assert.ok(childResult.length < 6000, `nested output must be trimmed, got ${childResult.length}`);
      assert.match(childResult, /more characters$/, 'the trim must say how much was omitted');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

const EDIT_SESSION_ID = 'claude-edit-session';

/**
 * Writes a transcript where one prompt was edited: the replacement shares a
 * parent with the original, which is the shape Claude's resume-partway leaves
 * behind. Nothing is deleted from the file.
 */
async function writeEditedTranscript(projectDirectory: string): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${EDIT_SESSION_ID}.jsonl`);
  const rows = [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'first answer' }] },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'original second prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:03.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'answer to be replaced' }] },
    },
    // The edit: same parent as u2, written later.
    {
      type: 'user', uuid: 'u2b', parentUuid: 'a1', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'edited second prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a2b', parentUuid: 'u2b', sessionId: EDIT_SESSION_ID,
      timestamp: '2026-08-23T10:00:05.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'answer to the edit' }] },
    },
  ];

  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('an edited prompt replaces the one it superseded instead of stacking on it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-edit-history-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(EDIT_SESSION_ID, {
        providerSessionId: EDIT_SESSION_ID,
      });
      const texts = history.messages.map((message) => message.content);

      assert.deepEqual(texts, [
        'first prompt',
        'first answer',
        'edited second prompt',
        'answer to the edit',
      ]);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

/**
 * The transcript a resident-session edit leaves behind.
 *
 * A resident session ends every turn with its `prompt_snapshot` /
 * `stop_hook_summary` block. The prompt sent and then abandoned parents onto
 * that block, and the replacement — appended by the rebuilt host — resumes at
 * the kept assistant turn, so its parent is that turn and the two prompts share
 * an *ancestor*, never a literal parent.
 *
 * `followUp` switches the tail to the negative control: a fresh prompt sent
 * after an abort, which parents onto the interrupt marker instead and must
 * survive the prune.
 */
function residentEditRows(sessionId: string, followUp: boolean) {
  const turnEnd = [
    {
      type: 'attachment', uuid: 'snap1', parentUuid: 'a1', sessionId, timestamp: '2026-08-23T10:00:02.000Z',
      attachment: { type: 'prompt_snapshot' },
    },
    {
      type: 'system', uuid: 'hook1', parentUuid: 'snap1', sessionId, subtype: 'stop_hook_summary',
      timestamp: '2026-08-23T10:00:03.000Z',
    },
  ];

  return [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-08-23T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId, timestamp: '2026-08-23T10:00:01.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'first answer' }] },
    },
    ...turnEnd,
    {
      type: 'user', uuid: 'u2', parentUuid: 'hook1', sessionId, timestamp: '2026-08-23T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'abandoned prompt' }] },
    },
    {
      type: 'user', uuid: 'u2i', parentUuid: 'u2', sessionId, timestamp: '2026-08-23T10:00:05.000Z',
      message: { role: 'user', content: '[Request interrupted by user]' },
    },
    followUp
      ? {
          type: 'user', uuid: 'u3', parentUuid: 'u2i', sessionId, timestamp: '2026-08-23T10:00:06.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'fresh question' }] },
        }
      : {
          type: 'user', uuid: 'u2b', parentUuid: 'a1', sessionId, timestamp: '2026-08-23T10:00:06.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'replacement prompt' }] },
        },
    followUp
      ? {
          type: 'assistant', uuid: 'a3', parentUuid: 'u3', sessionId, timestamp: '2026-08-23T10:00:07.000Z',
          message: {
            role: 'assistant', model: 'claude-opus-5',
            content: [{ type: 'text', text: 'answer to the fresh question' }],
          },
        }
      : {
          type: 'assistant', uuid: 'a2b', parentUuid: 'u2b', sessionId, timestamp: '2026-08-23T10:00:07.000Z',
          message: {
            role: 'assistant', model: 'claude-opus-5',
            content: [{ type: 'text', text: 'answer to the replacement' }],
          },
        },
  ];
}

test('an edit that resumes partway prunes the prompt the turn-end block hid from the parent check', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-edit-history-'));
  const sessionId = 'claude-resident-edit-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    const rows = residentEditRows(sessionId, false);
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Resident edit', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, {
        providerSessionId: sessionId,
      });

      assert.deepEqual(history.messages.map((message) => message.content), [
        'first prompt',
        'first answer',
        'replacement prompt',
        'answer to the replacement',
      ]);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a prompt sent after an abort keeps the abandoned prompt instead of looking like an edit', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-resident-abort-followup-'));
  const sessionId = 'claude-resident-abort-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    const rows = residentEditRows(sessionId, true);
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Resident abort follow-up', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, {
        providerSessionId: sessionId,
      });

      // A follow-up anchors onto the interrupt marker, not the branch point, so
      // the aborted prompt was abandoned, not replaced — both stay.
      assert.deepEqual(history.messages.map((message) => message.content), [
        'first prompt',
        'first answer',
        'abandoned prompt',
        'fresh question',
        'answer to the fresh question',
      ]);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('parallel tool calls are not mistaken for an edit', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-parallel-tools-'));
  const sessionId = 'claude-parallel-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    // One assistant turn issuing two tools: each tool_result parents onto the
    // same row, so this row has two children — a branch point that must not be
    // pruned, or tool output disappears from every transcript in the app.
    const rows = [
      {
        type: 'user', uuid: 'p1', parentUuid: null, sessionId,
        timestamp: '2026-08-23T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'do two things' }] },
      },
      {
        type: 'assistant', uuid: 'pa1', parentUuid: 'p1', sessionId,
        timestamp: '2026-08-23T10:00:01.000Z',
        message: {
          role: 'assistant', model: 'claude-opus-5',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a' } }],
        },
      },
      {
        type: 'user', uuid: 'pr1', parentUuid: 'pa1', sessionId,
        timestamp: '2026-08-23T10:00:02.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contents of a' }] },
      },
      {
        type: 'user', uuid: 'pr2', parentUuid: 'pa1', sessionId,
        timestamp: '2026-08-23T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'contents of b' }] },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Parallel tools', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(sessionId, {
        providerSessionId: sessionId,
      });

      assert.equal(
        history.messages.some((message) => message.content === 'do two things'),
        true,
      );
      const toolRow = history.messages.find((message) => message.kind === 'tool_use');
      assert.ok(toolRow, 'the tool call survives');
      assert.equal(toolRow?.toolResult?.content, 'contents of a');
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolving an edit anchor returns the assistant turn before it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-edit-anchor-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);
      const provider = new ClaudeSessionsProvider();

      // Resuming is inclusive of the row it names, so replacing `u2b` must
      // resume through `a1` — naming `u2b` itself would leave the prompt being
      // replaced in context.
      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'u2b'),
        { found: true, resumeThroughId: 'a1' },
      );

      // Nothing precedes the first prompt, so the conversation starts over.
      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'u1'),
        { found: true, resumeThroughId: null },
      );

      assert.deepEqual(
        await provider.resolveEditAnchor(EDIT_SESSION_ID, 'not-in-transcript'),
        { found: false, resumeThroughId: null },
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('user turns carry the transcript uuid so they can be edited', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-anchor-ids-'));

  try {
    const transcriptPath = await writeEditedTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(EDIT_SESSION_ID, 'claude', tempRoot, 'Edited session', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(EDIT_SESSION_ID, {
        providerSessionId: EDIT_SESSION_ID,
      });

      const userRows = history.messages.filter((message) => message.role === 'user');
      assert.deepEqual(
        userRows.map((message) => message.transcriptAnchorId),
        ['u1', 'u2b'],
      );
      // Assistant rows are never an anchor: the UI only offers editing on a
      // turn the user typed.
      assert.equal(
        history.messages.some((message) => message.role !== 'user' && message.transcriptAnchorId),
        false,
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolving an edit anchor skips rows that are not conversation turns', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-anchor-skip-'));
  const sessionId = 'claude-anchor-skip-session';

  try {
    const transcriptPath = path.join(tempRoot, `${sessionId}.jsonl`);
    // An attachment row sits between the assistant turn and the next prompt.
    // Resuming names an assistant message, so the walk has to pass over it —
    // naming the attachment would resume at something the SDK cannot address.
    const rows = [
      {
        type: 'user', uuid: 'su1', parentUuid: null, sessionId,
        timestamp: '2026-08-23T10:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'assistant', uuid: 'sa1', parentUuid: 'su1', sessionId,
        timestamp: '2026-08-23T10:00:01.000Z',
        message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'attachment', uuid: 'sat1', parentUuid: 'sa1', sessionId,
        timestamp: '2026-08-23T10:00:02.000Z',
      },
      {
        type: 'user', uuid: 'su2', parentUuid: 'sat1', sessionId,
        timestamp: '2026-08-23T10:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'second prompt' }] },
      },
    ];
    await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(sessionId, 'claude', tempRoot, 'Anchor skip', now, now, transcriptPath);

      assert.deepEqual(
        await new ClaudeSessionsProvider().resolveEditAnchor(sessionId, 'su2'),
        { found: true, resumeThroughId: 'sa1' },
      );
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fork anchors (assistant replies)
// ---------------------------------------------------------------------------

const FORK_SESSION_ID = 'claude-fork-session';

/**
 * A two-turn transcript whose first turn interleaves a tool call: the assistant
 * narrates, then calls a tool, then answers. The fork anchor must land on each
 * turn's *final* text answer (a2, a3), never on the mid-turn narration (a1) nor
 * on the user prompts.
 */
async function writeMultiTurnTranscript(projectDirectory: string): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${FORK_SESSION_ID}.jsonl`);
  const rows = [
    {
      type: 'user', uuid: 'u1', parentUuid: null, sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    },
    {
      type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:01.000Z',
      message: {
        role: 'assistant', model: 'claude-opus-5',
        content: [
          { type: 'text', text: 'let me check.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    },
    {
      type: 'user', uuid: 'u2', parentUuid: 'a1', sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:02.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    },
    {
      type: 'assistant', uuid: 'a2', parentUuid: 'u2', sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:03.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'first answer' }] },
    },
    {
      type: 'user', uuid: 'u3', parentUuid: 'a2', sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:04.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'second question' }] },
    },
    {
      type: 'assistant', uuid: 'a3', parentUuid: 'u3', sessionId: FORK_SESSION_ID,
      timestamp: '2026-08-23T10:00:05.000Z',
      message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'second answer' }] },
    },
  ];

  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

test('each turn ends with one fork anchor on its final assistant answer', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-fork-anchors-'));

  try {
    const transcriptPath = await writeMultiTurnTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(FORK_SESSION_ID, 'claude', tempRoot, 'Fork session', now, now, transcriptPath);

      const history = await new ClaudeSessionsProvider().fetchHistory(FORK_SESSION_ID, {
        providerSessionId: FORK_SESSION_ID,
      });

      // Exactly one anchored assistant message per turn — and it is the answer,
      // not the narration that preceded the tool call.
      const anchored = history.messages.filter((message) => message.forkAnchorId);
      assert.deepEqual(
        anchored.map((message) => [message.role, message.content, message.forkAnchorId]),
        [
          ['assistant', 'first answer', 'a2'],
          ['assistant', 'second answer', 'a3'],
        ],
      );

      // The assistant row squeezed between the tool call and its result carries
      // text but is not the turn's end, so it must not offer a fork.
      const narration = history.messages.find((message) => message.content === 'let me check.');
      assert.ok(narration);
      assert.equal(narration.forkAnchorId, undefined);

      // User prompts are edit anchors, never fork anchors; their
      // `transcriptAnchorId` is unchanged by this field's arrival.
      const userRows = history.messages.filter((message) => message.role === 'user');
      assert.deepEqual(userRows.map((message) => message.transcriptAnchorId), ['u1', 'u3']);
      assert.equal(userRows.some((message) => message.forkAnchorId), false);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('a running session withholds the final turn\'s fork anchor, then restores it', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-fork-running-'));

  try {
    const transcriptPath = await writeMultiTurnTranscript(tempRoot);

    await withIsolatedDatabase(async () => {
      const now = new Date().toISOString();
      sessionsDb.createSession(FORK_SESSION_ID, 'claude', tempRoot, 'Fork session', now, now, transcriptPath);

      const readAnchors = async (running: boolean) => {
        const history = await new ClaudeSessionsProvider().fetchHistory(FORK_SESSION_ID, {
          providerSessionId: FORK_SESSION_ID,
          running,
        });
        return history.messages
          .filter((message) => message.forkAnchorId)
          .map((message) => message.forkAnchorId);
      };

      // While the last turn is still being written, only the settled turn 1
      // offers a fork; the in-flight turn 2 does not.
      assert.deepEqual(await readAnchors(true), ['a2']);
      // Idle, the final answer is anchored too — the positive control against a
      // reader that simply never writes the last turn's anchor.
      assert.deepEqual(await readAnchors(false), ['a2', 'a3']);
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildLookupMap
// ---------------------------------------------------------------------------

test('buildLookupMap returns first-seen value when key appears multiple times', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-lookup-'));
  const filePath = path.join(tmp, 'history.jsonl');
  try {
    await writeFile(
      filePath,
      [
        JSON.stringify({ sessionId: 's1', display: 'first-message' }),
        JSON.stringify({ sessionId: 's1', display: 'second-message' }),
        JSON.stringify({ sessionId: 's2', display: 'only-message' }),
      ].join('\n'),
      'utf8',
    );

    const map = await buildLookupMap(filePath, 'sessionId', 'display');

    assert.equal(map.size, 2);
    assert.equal(map.get('s1'), 'first-message');
    assert.equal(map.get('s2'), 'only-message');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('buildLookupMap returns empty map for missing file', async () => {
  const map = await buildLookupMap(path.join(os.tmpdir(), 'does-not-exist.jsonl'), 'k', 'v');
  assert.equal(map.size, 0);
});

test('buildLookupMap returns empty map for empty file', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-lookup-'));
  const filePath = path.join(tmp, 'empty.jsonl');
  try {
    await writeFile(filePath, '', 'utf8');
    const map = await buildLookupMap(filePath, 'k', 'v');
    assert.equal(map.size, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('buildLookupMap skips rows with non-string key or value', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-lookup-'));
  const filePath = path.join(tmp, 'history.jsonl');
  try {
    await writeFile(
      filePath,
      [
        JSON.stringify({ sessionId: 123, display: 'not-a-string-key' }),
        JSON.stringify({ sessionId: 's1', display: 456 }),
        JSON.stringify({ sessionId: 's1', display: 'valid-entry' }),
      ].join('\n'),
      'utf8',
    );

    const map = await buildLookupMap(filePath, 'sessionId', 'display');
    assert.equal(map.size, 1);
    assert.equal(map.get('s1'), 'valid-entry');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractSessionTitle — tested via synchronizeFile
// ---------------------------------------------------------------------------

test('synchronizeFile uses ai-title from JSONL when no DB custom_name exists', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-aititle-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    // Create ~/.claude/history.jsonl with a competing display name.
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      path.join(claudeHome, 'history.jsonl'),
      JSON.stringify({ sessionId: 'test-session-1', display: 'user-first-prompt-from-history' }) + '\n',
      'utf8',
    );

    // Write session JSONL with ai-title before last-prompt.
    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI generated title', sessionId: 'test-session-1' }),
      JSON.stringify({
        parentUuid: 'msg-1',
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        type: 'assistant',
        uuid: 'msg-2',
      }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'test-session-1' }),
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result, 'synchronizeFile should return a session id');
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, 'AI generated title');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('synchronizeFile uses custom-title from JSONL when no DB custom_name and no ai-title', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-customtitle-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');

    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({
        parentUuid: 'msg-1',
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        type: 'assistant',
        uuid: 'msg-2',
      }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Renamed via cli', sessionId: 'test-session-1' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'test-session-1' }),
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, 'Renamed via cli');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('synchronizeFile falls back to history.jsonl display when JSONL has no title events', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-fallback-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      path.join(claudeHome, 'history.jsonl'),
      JSON.stringify({ sessionId: 'test-session-1', display: 'fallback display name' }) + '\n',
      'utf8',
    );

    // Session JSONL with NO ai-title, custom-title, or last-prompt — and no
    // first prompt either, so the transcript offers the indexer no name at all
    // and the fallback chain below it is what the assertion is about.
    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({
        parentUuid: 'msg-1',
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        type: 'assistant',
        uuid: 'msg-2',
      }),
    ], { firstPrompt: null });

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, 'fallback display name');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('synchronizeFile falls back to Untitled Claude Session when all sources are empty', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-untitled-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');

    // Session JSONL with NO title events at all, and nothing to derive one
    // from: with the history file empty as well, every naming source is empty.
    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({
        parentUuid: 'msg-1',
        isSidechain: false,
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        type: 'assistant',
        uuid: 'msg-2',
      }),
    ], { firstPrompt: null });

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, 'Untitled Claude Session');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Priority: manual rename > JSONL title > inferred name > history.jsonl
// ---------------------------------------------------------------------------

test('synchronizeFile preserves a renamed session over JSONL and history.jsonl', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-dbwins-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      path.join(claudeHome, 'history.jsonl'),
      JSON.stringify({ sessionId: 'test-session-1', display: 'history-display-name' }) + '\n',
      'utf8',
    );

    // Write session JSONL with competing ai-title.
    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'JSONL ai title', sessionId: 'test-session-1' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'test-session-1' }),
    ]);

    await withIsolatedDatabase(async () => {
      // Pre-seed the DB, then rename through the same path the sidebar uses —
      // that rename is a user decision, which is what the name has to record.
      sessionsDb.createSession(
        'test-session-1',
        'claude',
        workspacePath,
        'first prompt',
      );
      sessionsDb.updateSessionCustomName('test-session-1', 'Sidebar custom name');

      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      // A rename outranks JSONL ai-title AND history.jsonl display.
      assert.equal(session?.custom_name, 'Sidebar custom name');
      assert.equal(session?.name_source, 'manual');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('synchronizeFile does NOT treat "Untitled Claude Session" in DB as a real custom_name', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-untitled-db-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');

    // Session JSONL with an ai-title that should win over the DB default.
    await writeSessionJsonl(workspacePath, 'test-session-1.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Real AI title from JSONL', sessionId: 'test-session-1' }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'test-session-1' }),
    ]);

    await withIsolatedDatabase(async () => {
      // Seed with the default fallback name — should be ignored.
      sessionsDb.createSession(
        'test-session-1',
        'claude',
        workspacePath,
        'Untitled Claude Session',
      );

      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(workspacePath, 'test-session-1.jsonl'),
      );

      assert.ok(result);
      const session = sessionsDb.getSessionById(result!);
      assert.equal(session?.custom_name, 'Real AI title from JSONL');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('synchronizeFile skips subagent transcripts', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-subagent-'));
  const workspacePath = path.join(tmp, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const claudeHome = path.join(tmp, '.claude');
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');

    // Create a file whose path contains "subagents".
    const subagentsDir = path.join(workspacePath, 'test-session-1', 'subagents');
    await mkdir(subagentsDir, { recursive: true });
    await writeSessionJsonl(subagentsDir, 'agent-1.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Subagent title', sessionId: 'test-session-1' }),
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      const result = await synchronizer.synchronizeFile(
        path.join(subagentsDir, 'agent-1.jsonl'),
      );

      // Subagent transcripts should be silently skipped (return null).
      assert.equal(result, null);
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('synchronizeFile skips non-jsonl files', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    const synchronizer = new ClaudeSessionSynchronizer();
    const result = await synchronizer.synchronizeFile('/tmp/not-a-jsonl.txt');
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Last activity: read from transcript content, never from the file's mtime
// ---------------------------------------------------------------------------

const ACTIVITY_SESSION_ID = 'claude-activity-session';
const CONTENT_TIMESTAMP = '2026-01-05T00:00:00.000Z';
const APPENDED_TIMESTAMP = '2026-01-06T12:00:00.000Z';

/** An atime old enough that any read of the file moves it under `relatime`. */
const UNREAD_ATIME = new Date('2020-01-01T00:00:00.000Z');

/**
 * Writes a Claude transcript whose content reports activity at
 * `contentTimestamp` and ends on the timestamp-less bookkeeping records a real
 * transcript is flushed with.
 */
async function writeActivityTranscript(
  projectDirectory: string,
  contentTimestamp: string,
): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${ACTIVITY_SESSION_ID}.jsonl`);
  const rows = [
    {
      type: 'user', uuid: 'au1', sessionId: ACTIVITY_SESSION_ID, cwd: '/workspace/demo',
      timestamp: contentTimestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'a prompt' }] },
    },
    { type: 'last-prompt', sessionId: ACTIVITY_SESSION_ID, lastPrompt: 'a prompt' },
    { type: 'cost-state', sessionId: ACTIVITY_SESSION_ID },
  ];
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

/** Writes one indexable Claude transcript carrying a single timestamped turn. */
async function writeScanTranscript(projectDirectory: string, sessionId: string): Promise<string> {
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  const rows = [
    {
      type: 'user', uuid: 'su1', sessionId, cwd: '/workspace/demo',
      timestamp: '2026-08-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
  ];
  await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return transcriptPath;
}

/**
 * Waits until the filesystem's creation clock has clearly moved past `after`.
 *
 * The scan cursor compares against a transcript's birthtime, and tmpfs stamps
 * creation times from a coarse timer — a file written immediately after a
 * `new Date()` can carry a birthtime a millisecond *before* it, and would then
 * be filtered out as already-indexed. Waiting a tick past the cursor is what
 * makes "a transcript appeared after the last scan" true rather than lucky.
 */
async function waitPastBirthtime(after: Date): Promise<void> {
  const deadline = after.getTime() + 20;
  while (Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Creates `<tmp>/.claude/projects/demo` beside an empty name-lookup file. */
async function createClaudeProjectsDir(tmp: string): Promise<string> {
  const claudeHome = path.join(tmp, '.claude');
  const projectsPath = path.join(claudeHome, 'projects', 'demo');
  await mkdir(projectsPath, { recursive: true });
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');
  return projectsPath;
}

test('last activity comes from transcript content, not the file mtime', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-activity-'));
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const projectsPath = await createClaudeProjectsDir(tmp);
    const transcriptPath = await writeActivityTranscript(projectsPath, CONTENT_TIMESTAMP);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // Control: the row a fresh index writes already carries the activity the
      // transcript reports, even though the transcript's mtime is "now".
      assert.equal(await synchronizer.synchronize(), 1);
      assert.equal(
        sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at,
        CONTENT_TIMESTAMP,
        'indexing must record the activity the transcript reports',
      );

      // (a) A filesystem-level touch — what an external rewrite or a CLI's own
      // flush does — leaves the reading exactly where it was.
      await utimes(transcriptPath, new Date(), new Date());
      await synchronizer.synchronizeFile(transcriptPath);
      const afterTouch = sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at;
      console.log(`touch: before=${CONTENT_TIMESTAMP} after=${afterTouch}`);
      assert.equal(
        afterTouch,
        CONTENT_TIMESTAMP,
        'a touch that changes no content must not move last activity',
      );

      // (b) A record that does report activity moves it, and moves it to that
      // record's own timestamp.
      await appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant', uuid: 'aa1', sessionId: ACTIVITY_SESSION_ID,
          timestamp: APPENDED_TIMESTAMP,
          message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a later answer' }] },
        })}\n`,
        'utf8',
      );
      await synchronizer.synchronizeFile(transcriptPath);
      const afterAppend = sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at;
      console.log(`append: before=${afterTouch} after=${afterAppend}`);
      assert.equal(afterAppend, APPENDED_TIMESTAMP);

      // The transcript's mtime is "now" by this point, so a reading taken from
      // it could not have produced the value asserted above.
      const { mtime } = await stat(transcriptPath);
      assert.ok(mtime.toISOString() > APPENDED_TIMESTAMP, 'the mtime must be the uninformative one');
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a scan does not read the transcripts its cursor excludes', { concurrency: false }, async () => {
  const scanSessionIds = ['scan-a', 'scan-b', 'scan-c', 'scan-d'];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-scan-cursor-'));
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const projectsPath = await createClaudeProjectsDir(tmp);
    const transcriptPaths: string[] = [];
    for (const sessionId of scanSessionIds) {
      transcriptPaths.push(await writeScanTranscript(projectsPath, sessionId));
    }

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // Control: the fixture is indexable, so a later zero means the cursor
      // excluded these files rather than that nothing was ever there.
      assert.equal(await synchronizer.synchronize(), scanSessionIds.length);

      // Every transcript is now excluded by the cursor and made unreadable, so
      // a scan that opens one for its content fails on it, while a scan that
      // only stats it processes nothing at all.
      const cursor = new Date();
      for (const transcriptPath of transcriptPaths) {
        await chmod(transcriptPath, 0o000);
      }

      try {
        assert.equal(await synchronizer.synchronize(cursor), 0);

        // Control: the same scan still reaches the directory and picks up the
        // file that is genuinely new, so the zero above is a real zero.
        await waitPastBirthtime(cursor);
        const freshPath = await writeScanTranscript(projectsPath, 'scan-new');
        assert.ok((await stat(freshPath)).birthtime > cursor, 'the control transcript must look new');
        assert.equal(await synchronizer.synchronize(cursor), 1);
      } finally {
        for (const transcriptPath of transcriptPaths) {
          await chmod(transcriptPath, 0o644);
        }
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('a scan does not open the transcripts its cursor excludes', { concurrency: false }, async () => {
  const scanSessionIds = ['open-a', 'open-b', 'open-c', 'open-d'];
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-scan-open-'));
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const projectsPath = await createClaudeProjectsDir(tmp);
    const transcriptPaths: string[] = [];
    for (const sessionId of scanSessionIds) {
      transcriptPaths.push(await writeScanTranscript(projectsPath, sessionId));
    }

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), scanSessionIds.length);

      // A read is the only thing that moves an atime parked this far in the
      // past, which makes "was this file opened?" directly observable — the
      // scan is asked about the work it did, not about how long it took.
      const cursor = new Date();
      for (const transcriptPath of transcriptPaths) {
        await utimes(transcriptPath, UNREAD_ATIME, new Date('2026-01-01T00:00:00.000Z'));
      }

      assert.equal(await synchronizer.synchronize(cursor), 0);

      // Control: the probe does see reads. A transcript that is genuinely new
      // work must come back with its atime moved, or the assertions below
      // would pass on a filesystem that never records them at all.
      await waitPastBirthtime(cursor);
      const freshPath = await writeScanTranscript(projectsPath, 'open-new');
      assert.ok((await stat(freshPath)).birthtime > cursor, 'the control transcript must look new');
      await utimes(freshPath, UNREAD_ATIME, new Date('2026-01-01T00:00:00.000Z'));
      assert.equal(await synchronizer.synchronize(cursor), 1);
      assert.notEqual(
        (await stat(freshPath)).atime.toISOString(),
        UNREAD_ATIME.toISOString(),
        'the probe must see the read of a transcript that is new work',
      );

      for (const transcriptPath of transcriptPaths) {
        assert.equal(
          (await stat(transcriptPath)).atime.toISOString(),
          UNREAD_ATIME.toISOString(),
          `${path.basename(transcriptPath)} was opened by a scan that should have skipped it`,
        );
      }
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('an already-indexed row is re-derived from its transcript, not left on the mtime', { concurrency: false }, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-activity-backfill-'));
  const restoreHomeDir = patchHomeDir(tmp);

  try {
    const projectsPath = await createClaudeProjectsDir(tmp);
    const transcriptPath = await writeActivityTranscript(projectsPath, CONTENT_TIMESTAMP);

    await withIsolatedDatabase(async () => {
      const synchronizer = new ClaudeSessionSynchronizer();

      // Exactly the shape of an index written before content was read: a row
      // already in the database whose activity is the transcript's mtime.
      const mtimeReading = (await stat(transcriptPath)).mtime.toISOString();
      sessionsDb.createSession(
        ACTIVITY_SESSION_ID,
        'claude',
        '/workspace/demo',
        'an already-indexed session',
        mtimeReading,
        mtimeReading,
        transcriptPath,
      );
      assert.equal(sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at, mtimeReading);

      // The cursor already covers the transcript, so the scan itself processes
      // no files. Nothing else would ever revisit this row — the cursor filters
      // on birthtime and the watcher only fires on a change — which leaves the
      // re-derivation pass as the only thing that can move it.
      assert.equal(await synchronizer.synchronize(new Date()), 0);
      assert.equal(
        sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at,
        CONTENT_TIMESTAMP,
        'the stale row must be re-derived from its transcript',
      );

      // The pass is keyed, not repeated: a row left stale again must stay
      // stale, or every sidebar refresh would be re-reading every transcript.
      sessionsDb.updateSessionUpdatedAt(ACTIVITY_SESSION_ID, mtimeReading);
      assert.equal(await synchronizer.synchronize(new Date()), 0);
      assert.equal(sessionsDb.getSessionById(ACTIVITY_SESSION_ID)?.updated_at, mtimeReading);
    });
  } finally {
    restoreHomeDir();
    await rm(tmp, { recursive: true, force: true });
  }
});
