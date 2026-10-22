import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import { getSessionTitle } from '@/shared/utils';
import type { LLMProvider, ProjectSession, ServerEvent } from '@/shared/types';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';

export type SessionResult = {
  id: string;
  label: string;
  provider?: LLMProvider;
};

const SESSION_RESULT_LIMIT = 50;

type SessionsResponse = {
  sessions?: ProjectSession[];
};

/**
 * The `kind: session_upserted` delta as the panel needs it: the app session id,
 * the owning project and the row the server says that session now has.
 *
 * Mirrors the client-side shape `useProjectsState` reads; the wire producer is
 * `server/modules/websocket/services/session-upsert-broadcast.service.ts`.
 */
type SessionUpsertedEvent = ServerEvent & {
  sessionId?: string;
  provider?: LLMProvider;
  session?: ProjectSession;
  project?: { projectId: string } | null;
};

export function useSessionsSource(projectId: string | undefined, enabled: boolean) {
  const { subscribe } = useWebSocket();

  const fetchedSessions = useApiSource<SessionResult, SessionsResponse>({
    enabled: enabled && !!projectId,
    deps: [projectId],
    fetcher: (signal) =>
      api.projectSessions(projectId!, { limit: SESSION_RESULT_LIMIT, offset: 0 }, { signal }),
    parse: (data) => {
      return (data.sessions ?? []).map<SessionResult>((s) => ({
        id: s.id,
        label: (s.title || s.summary || s.name || s.id) as string,
        provider: (s.__provider || s.provider) as LLMProvider | undefined,
      }));
    },
  });

  /**
   * The loaded page plus every rename that arrived while it was on screen.
   *
   * Held separately from the fetch result so a `session_upserted` patches one
   * row in place: re-listing the project for a rename would spend a request and
   * discard the results past the first page, so the panel would visibly shrink
   * every time a session is renamed anywhere.
   */
  const [sessions, setSessions] = useState<SessionResult[]>(fetchedSessions);

  // A page the server just sent already reflects every rename so far, so it
  // replaces the patched list outright. (The fetch result keeps its identity
  // between requests, so this runs once per response, not once per render.)
  useEffect(() => {
    setSessions(fetchedSessions);
  }, [fetchedSessions]);

  useEffect(() => subscribe((event) => {
    if (event.kind !== 'session_upserted') {
      return;
    }

    const upsert = event as SessionUpsertedEvent;
    // Only this project's sessions: the panel lists one project, and an upsert
    // from any other must leave it untouched.
    if (!projectId || !upsert.sessionId || !upsert.session) {
      return;
    }
    if (upsert.project?.projectId !== projectId) {
      return;
    }

    // `getSessionTitle` is the authority the workspace header already uses. The
    // delta carries no `__provider`, so stamp the event's provider on before
    // asking it — a Cursor row is titled by name, every other row by summary.
    const title = getSessionTitle({ ...upsert.session, __provider: upsert.provider });

    setSessions((previous) => {
      const index = previous.findIndex((row) => row.id === upsert.sessionId);
      // Only a row the panel is already showing is patched; the event never
      // inserts, so a session outside the loaded page stays out of it.
      if (index < 0 || previous[index].label === title) {
        return previous;
      }

      const next = [...previous];
      next[index] = { ...next[index], label: title };
      return next;
    });
  }), [projectId, subscribe]);

  return sessions;
}
