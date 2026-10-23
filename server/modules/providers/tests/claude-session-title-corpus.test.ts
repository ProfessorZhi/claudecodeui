import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

/**
 * Whether the name this app stores for a session is the name the Claude Code
 * CLI would display for it, checked transcript by transcript.
 *
 * The reader in the synchronizer and the ladder below are two independent
 * implementations of one rule — the reader's is the one the app runs, the
 * ladder is written here from the CLI's own definition — and the corpus is the
 * ground they are compared on. A test that asserted the reader against itself
 * would agree by construction and prove nothing; this one reds the moment the
 * two disagree about a transcript, which is the only thing the app's users can
 * see.
 *
 * The corpus is frozen and generated in-test so the comparison is runnable on
 * any machine: transcripts in the shapes the CLI actually writes — the
 * bookkeeping entries a session opens with, dozens of title entries rewritten
 * round after round, and the angle-bracket metadata blocks that are `user`
 * entries but not anything a user typed.
 */

/** One fixture class. The name is what the positive control reports by. */
type CorpusClass =
  | 'revised-ai-title'
  | 'custom-title-after-ai-title'
  | 'agent-name-only'
  | 'single-ai-title';

type CorpusTranscript = {
  id: string;
  corpusClass: CorpusClass;
  /** The entries after the head, in file order. */
  body: Record<string, unknown>[];
};

/**
 * The CLI's own title ladder, over one transcript's entries.
 *
 * `agentName || customTitle || aiTitle || summary || firstPrompt`, each taken
 * as the *last* entry of its type because the CLI rewrites the title entries
 * near the end of a file as a conversation goes on, and then
 * `sessionId.slice(0, 8)`. `summary` is absent by construction: it is session
 * metadata the CLI keeps outside the transcript, not an entry type a reader can
 * find in one (0 of this machine's 1282 transcripts carries a `summary` entry).
 *
 * The last rung is the one place the app deliberately differs — it names an
 * unnameable session "Untitled Claude Session" rather than after a fragment of
 * its id — which is why no fixture below reaches it.
 */
function cliLadder(entries: Record<string, unknown>[], sessionId: string): string {
  let agentName: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;

  for (const entry of entries) {
    if (entry.sessionId !== sessionId) {
      continue;
    }
    if (entry.type === 'agent-name' && isNonBlankString(entry.agentName)) {
      agentName = entry.agentName;
    } else if (entry.type === 'custom-title' && isNonBlankString(entry.customTitle)) {
      customTitle = entry.customTitle;
    } else if (entry.type === 'ai-title' && isNonBlankString(entry.aiTitle)) {
      aiTitle = entry.aiTitle;
    }
  }

  return agentName ?? customTitle ?? aiTitle
    ?? firstPrompt(entries, sessionId)
    ?? sessionId.slice(0, 8);
}

/**
 * The same ladder with one rule reverted to what the reader used to do: the
 * *first* `ai-title` is taken, and the scan stops there.
 *
 * This is the positive control's reader. It exists to show that the corpus can
 * tell the two rules apart at all — an assertion that a broken implementation
 * would also pass is not a test of the implementation.
 */
function firstAiTitleWins(entries: Record<string, unknown>[], sessionId: string): string {
  let agentName: string | undefined;
  let customTitle: string | undefined;

  for (const entry of entries) {
    if (entry.sessionId !== sessionId) {
      continue;
    }
    if (entry.type === 'agent-name' && isNonBlankString(entry.agentName)) {
      agentName = entry.agentName;
    } else if (entry.type === 'custom-title' && isNonBlankString(entry.customTitle)) {
      customTitle = entry.customTitle;
    } else if (entry.type === 'ai-title' && isNonBlankString(entry.aiTitle)) {
      return agentName ?? customTitle ?? entry.aiTitle;
    }
  }

  return agentName ?? customTitle ?? firstPrompt(entries, sessionId) ?? sessionId.slice(0, 8);
}

/** The session's first prompt, by the CLI's rule for reading one out of a transcript. */
function firstPrompt(entries: Record<string, unknown>[], sessionId: string): string | undefined {
  for (const entry of entries) {
    if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) {
      continue;
    }
    if (entry.sessionId !== sessionId) {
      continue;
    }
    const content = (entry.message as Record<string, unknown> | undefined)?.content;
    const parts = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((part) =>
            part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
              && typeof (part as Record<string, unknown>).text === 'string'
              ? [(part as Record<string, unknown>).text as string]
              : [],
          )
        : [];

    for (const part of parts) {
      // A slash command names the command, not the session, and the metadata
      // blocks the CLI appends (`<system-reminder>`, `<local-command-stdout>`,
      // ...) are its own bookkeeping. Neither is what the user typed.
      if (/^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/.test(part)) {
        continue;
      }
      return part;
    }
  }

  return undefined;
}

const isNonBlankString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/** One transcript line as the CLI writes it. */
const line = (sessionId: string, cwd: string, event: Record<string, unknown>): Record<string, unknown> => ({
  sessionId,
  cwd,
  ...event,
});

/** Counts out uuids so the corpus is the same file on every run. */
let entryCounter = 0;

const userEntry = (sessionId: string, cwd: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line(sessionId, cwd, {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: `user-${entryCounter++}`,
    timestamp: '2026-07-10T00:00:00.000Z',
    ...extra,
  });

const assistantEntry = (sessionId: string, cwd: string, text: string) =>
  line(sessionId, cwd, {
    type: 'assistant',
    uuid: `assistant-${entryCounter++}`,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });

/**
 * The head every real transcript opens with: two bookkeeping entries, then the
 * metadata blocks the CLI writes for its own use, then the user's first prompt.
 */
const head = (sessionId: string, cwd: string, prompt: string): Record<string, unknown>[] => [
  line(sessionId, cwd, { type: 'mode', mode: 'normal' }),
  line(sessionId, cwd, { type: 'permission-mode', permissionMode: 'default' }),
  userEntry(sessionId, cwd, '<system-reminder>Context loaded for this session</system-reminder>', {
    isMeta: true,
    uuid: 'meta-1',
  }),
  userEntry(sessionId, cwd, [{ type: 'text', text: prompt }], { uuid: 'msg-1' }),
];

/**
 * The title block the CLI re-appends every round: `last-prompt`, `custom-title`
 * and `ai-title` go out together, which is why a real transcript holds dozens of
 * entries of each type and only the last of each is current.
 */
const titleRound = (
  sessionId: string,
  cwd: string,
  round: { lastPrompt: string; customTitle?: string; aiTitle: string },
): Record<string, unknown>[] => [
  line(sessionId, cwd, { type: 'last-prompt', lastPrompt: round.lastPrompt }),
  ...(round.customTitle !== undefined
    ? [line(sessionId, cwd, { type: 'custom-title', customTitle: round.customTitle })]
    : []),
  line(sessionId, cwd, { type: 'ai-title', aiTitle: round.aiTitle }),
];

const ROUNDS = 30;
const filler = (sessionId: string, cwd: string, text: string) => assistantEntry(sessionId, cwd, text);

const CORPUS: CorpusTranscript[] = [
  {
    // The title is revised as the conversation goes on: every earlier entry is
    // a draft of a name the CLI has already replaced.
    id: 'corpus-revised-ai-title',
    corpusClass: 'revised-ai-title',
    body: [
      ...Array.from({ length: ROUNDS }, (_, round) =>
        titleRound('corpus-revised-ai-title', '/workspace/corpus', {
          lastPrompt: `prompt of round ${round}`,
          aiTitle: round === ROUNDS - 1 ? 'The Final Title' : `Draft Title ${round}`,
        }),
      ).flat(),
      filler('corpus-revised-ai-title', '/workspace/corpus', 'and the answer to the last round'),
    ],
  },
  {
    // A `/rename` lands *after* the title it belongs to, as a lone
    // `custom-title` at the end of the file — so the ladder, not the order the
    // entries appear in, has to decide which of the two names the session has.
    id: 'corpus-custom-title-after-ai-title',
    corpusClass: 'custom-title-after-ai-title',
    body: [
      ...titleRound('corpus-custom-title-after-ai-title', '/workspace/corpus', {
        lastPrompt: 'how do I index a repo?',
        aiTitle: 'Generated Title',
      }),
      filler('corpus-custom-title-after-ai-title', '/workspace/corpus', 'the conversation carries on'),
      line('corpus-custom-title-after-ai-title', '/workspace/corpus', {
        type: 'custom-title',
        customTitle: 'Renamed By Hand',
      }),
    ],
  },
  {
    // The agent that owns the session names it, and its name outranks
    // everything below it — including a `custom-title` when both are present.
    id: 'corpus-agent-name-only',
    corpusClass: 'agent-name-only',
    body: [
      line('corpus-agent-name-only', '/workspace/corpus', {
        type: 'agent-name',
        agentName: 'The Agent That Owns This',
      }),
      filler('corpus-agent-name-only', '/workspace/corpus', 'the conversation carries on'),
    ],
  },
  {
    // A session titled once and never re-titled, with a `last-prompt` that says
    // something else: the two rules agree here, which is what makes it a
    // control for the fixtures that red.
    id: 'corpus-single-ai-title',
    corpusClass: 'single-ai-title',
    body: [
      ...titleRound('corpus-single-ai-title', '/workspace/corpus', {
        lastPrompt: 'the last thing I typed',
        aiTitle: 'Generated Title',
      }),
      filler('corpus-single-ai-title', '/workspace/corpus', 'and then the session ended'),
    ],
  },
];

/** One corpus transcript's entries, in file order, with the head in place. */
const entriesOf = (transcript: CorpusTranscript): Record<string, unknown>[] => [
  ...head(transcript.id, '/workspace/corpus', 'how do I index a repo?'),
  ...transcript.body,
];

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-title-corpus-db-'));

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

/**
 * Writes the frozen corpus out and runs the real synchronizer over it, the way
 * discovery does, returning the name the app stored for each transcript.
 */
async function readCorpus(): Promise<Map<string, string | null>> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-title-corpus-home-'));
  const workspacePath = path.join(temporaryRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const claudeHome = path.join(temporaryRoot, '.claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(path.join(claudeHome, 'history.jsonl'), '', 'utf8');

  const originalHome = os.homedir;
  (os as any).homedir = () => temporaryRoot;

  try {
    const synchronizer = new ClaudeSessionSynchronizer();
    const names = new Map<string, string | null>();

    await withIsolatedDatabase(async () => {
      for (const transcript of CORPUS) {
        const transcriptPath = path.join(workspacePath, `${transcript.id}.jsonl`);
        const content = [...entriesOf(transcript), ''].map((entry) => JSON.stringify(entry)).join('\n');
        await writeFile(transcriptPath, content, 'utf8');
        await synchronizer.synchronizeFile(transcriptPath);
      }

      const { sessionsDb } = await import('@/modules/database/index.js');
      for (const transcript of CORPUS) {
        names.set(transcript.id, sessionsDb.getSessionById(transcript.id)?.custom_name ?? null);
      }
    });

    return names;
  } finally {
    (os as any).homedir = originalHome;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test('every corpus transcript is named what the CLI ladder would name it', async () => {
  const names = await readCorpus();

  const divergences: Array<{ id: string; corpusClass: CorpusClass; reader: string | null; ladder: string }> = [];
  for (const transcript of CORPUS) {
    const entries = entriesOf(transcript);
    const ladderName = cliLadder(entries, transcript.id);
    const readerName = names.get(transcript.id) ?? null;
    console.log(
      `[corpus] ${transcript.corpusClass} ${transcript.id}: reader=${JSON.stringify(readerName)} ladder=${JSON.stringify(ladderName)}`,
    );
    if (readerName !== ladderName) {
      divergences.push({ id: transcript.id, corpusClass: transcript.corpusClass, reader: readerName, ladder: ladderName });
    }
  }

  assert.deepEqual(divergences, [], 'the reader must name every transcript what the CLI ladder names it');
});

test('the corpus tells the reader apart from a reader that stops at the first ai-title', async () => {
  const names = await readCorpus();

  // The positive control: the rule this task removed, applied to the same
  // transcripts. If the corpus could not tell the two apart, the assertion
  // above would hold for both readers and would be evidence of nothing.
  const staleDivergences = CORPUS
    .map((transcript) => {
      const entries = entriesOf(transcript);
      return {
        id: transcript.id,
        corpusClass: transcript.corpusClass,
        stale: firstAiTitleWins(entries, transcript.id),
        ladder: cliLadder(entries, transcript.id),
      };
    })
    .filter(({ stale, ladder }) => stale !== ladder);

  console.log('[control] transcripts the first-ai-title rule would misname:', JSON.stringify(staleDivergences, null, 2));
  assert.ok(staleDivergences.length > 0, 'the control must red somewhere, or the corpus proves nothing');

  // And the reds must be the revision fixtures: a session whose ai-title was
  // rewritten, and one renamed after it was titled. The other two classes are
  // named the same by either rule, so a red from them would mean the corpus —
  // not the rule under test — is what changed.
  const redClasses = [...new Set(staleDivergences.map(({ corpusClass }) => corpusClass))].sort();
  assert.deepEqual(redClasses, ['custom-title-after-ai-title', 'revised-ai-title']);

  // The same transcripts the control misnames are the ones the real reader gets
  // right, which is what a revert of the rule would break.
  for (const { id } of staleDivergences) {
    const transcript = CORPUS.find((candidate) => candidate.id === id)!;
    const ladderName = cliLadder(entriesOf(transcript), id);
    assert.equal(
      names.get(id) ?? null,
      ladderName,
      `${id}: the stored name must be the ladder's, so reverting the rule reds this suite`,
    );
  }
});
