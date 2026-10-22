import { getSessionInfo, renameSession as renameClaudeSession } from '@anthropic-ai/claude-agent-sdk';

import type { IProviderSessionRename } from '@/shared/interfaces.js';

/**
 * Reads and writes a session's name in Claude Code's own store.
 *
 * Claude Code owns the name; this app's copy of it is a cache. Two operations,
 * and the second is what keeps the cache honest:
 *
 * - `renameSession` appends a `custom-title` entry to the session's JSONL file,
 *   which is where the CLI reads a session's name from for its resume list, its
 *   session search, and `/resume` argument completion. Going through the SDK
 *   rather than appending the line here is deliberate — the entry's shape is
 *   the CLI's contract, not this app's, and the same SDK call is what the fork
 *   path uses to title a new session.
 * - `readSessionTitle` asks Claude Code what the session is called
 *   (`getSessionInfo(...).summary` — documented as "custom title, auto-generated
 *   summary, or first prompt"). This is the authoritative answer, and it is the
 *   one the app stores; it is deliberately *not* the app's own ladder over the
 *   transcript, which reads a different question (`agentName || customTitle ||
 *   aiTitle || ...` is what the CLI displays *inside* a session, not what its
 *   session list calls it).
 *
 * Consumed by: `sessionsService.renameSessionById`, which resolves this through
 * the provider registry and stores the name this reports.
 */
export class ClaudeRenameProvider implements IProviderSessionRename {
  async renameSession(input: {
    providerSessionId: string;
    projectPath: string;
    title: string;
  }): Promise<void> {
    // `dir` is the session's working directory, which the SDK encodes into the
    // `~/.claude/projects/<encoded>` folder name itself — passing that folder
    // makes it encode an already-encoded path and find nothing. Same reasoning
    // as the fork provider's `dir`, and the same reason the session's own
    // working directory is what the caller has to hand over.
    await renameClaudeSession(input.providerSessionId, input.title, { dir: input.projectPath });
  }

  async readSessionTitle(input: {
    providerSessionId: string;
    projectPath: string;
  }): Promise<string | null> {
    const info = await getSessionInfo(input.providerSessionId, { dir: input.projectPath });
    const summary = typeof info?.summary === 'string' ? info.summary.trim() : '';
    return summary.length > 0 ? summary : null;
  }
}
