import { useEffect, useMemo } from 'react';

import type { ChatMessage } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/** One entry in the input outline drawer: a user input the reader can jump to. */
export type InputOutlineEntry = {
  /** The input's transcript anchor id — the jump destination the server resolves. */
  id: string;
  timestamp: string;
  /** The first ~80 characters of the input's text, line breaks flattened. */
  preview: string;
};

type UseInputOutlineArgs = {
  isActive: boolean;
  sessionId: string | null;
  sessionStore: SessionStore;
  /** The transcript as rendered, used to append inputs the outline does not know yet. */
  chatMessages: ChatMessage[];
};

/** One flattened line, the same shape the server's outline preview has. */
function previewOf(content: string | undefined): string {
  return (content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Lists a session's user inputs for the outline drawer.
 *
 * The server outline indexes the whole conversation, including inputs this
 * client has never loaded, so the drawer can offer a destination the transcript
 * does not hold yet. An input sent while the session is open is not in that
 * outline until the server reindexes, so any rendered user message whose anchor
 * id the outline does not name is appended after it.
 */
export function useInputOutline({
  isActive,
  sessionId,
  sessionStore,
  chatMessages,
}: UseInputOutlineArgs): InputOutlineEntry[] {
  // Idempotent in the store: a second call for the same session is a no-op.
  useEffect(() => {
    if (!isActive || !sessionId) return;
    void sessionStore.fetchOutline?.(sessionId);
  }, [isActive, sessionId, sessionStore]);

  const outline = sessionId ? sessionStore.getOutline?.(sessionId) ?? null : null;

  return useMemo<InputOutlineEntry[]>(() => {
    const entries: InputOutlineEntry[] = (outline?.turns ?? []).map((turn) => ({
      id: turn.id,
      timestamp: turn.timestamp,
      preview: turn.preview,
    }));
    const knownIds = new Set(entries.map((entry) => entry.id));
    for (const message of chatMessages) {
      if (message.type !== 'user') continue;
      const id = message.transcriptAnchorId;
      if (!id || knownIds.has(id)) continue;
      knownIds.add(id);
      entries.push({ id, timestamp: String(message.timestamp), preview: previewOf(message.content) });
    }
    return entries;
  }, [outline, chatMessages]);
}
