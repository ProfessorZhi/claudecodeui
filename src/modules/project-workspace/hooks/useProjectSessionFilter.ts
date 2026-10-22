import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { api } from '@/shared/api';
import type { Project, ProjectSession, SessionHiddenByProjectFilter } from '@/shared/types';
import { readShownHiddenProjectIds, writeShownHiddenProjectIds } from '@/modules/sidebar';

type ProjectSessionsPage = Pick<Project, 'sessions' | 'sessionMeta'>;

const MIN_RELOAD_PAGE_SIZE = 20;

const compiledMatcherCache = new Map<string, (name: string) => boolean>();

/** Same semantics as the backend matcher: unanchored, case-insensitive, any rule hides. Bad rules are ignored. */
const getSessionNameMatcher = (hide: string[]): ((name: string) => boolean) => {
  const cacheKey = JSON.stringify(hide);
  let matcher = compiledMatcherCache.get(cacheKey);
  if (!matcher) {
    const regexes: RegExp[] = [];
    for (const pattern of hide) {
      try {
        regexes.push(new RegExp(pattern, 'i'));
      } catch {
        // The server validates rules on save; a stale invalid row simply hides nothing.
      }
    }
    matcher = (name) => regexes.some((regex) => regex.test(name));
    compiledMatcherCache.set(cacheKey, matcher);
  }
  return matcher;
};

/**
 * True when a freshly pushed session must stay out of the project's visible list:
 * the project has rules that match its name, it is not kept visible
 * (running / attention / selected) and the browser is not temporarily showing hidden sessions.
 */
export const isSessionHiddenByProjectFilter: SessionHiddenByProjectFilter = (
  project: Project,
  session: ProjectSession,
  keepSessionIds: ReadonlySet<string>,
  isShowingHidden: boolean,
): boolean => {
  const rules = project.sessionFilter?.hide ?? [];
  if (isShowingHidden || rules.length === 0 || keepSessionIds.has(String(session.id))) {
    return false;
  }
  return getSessionNameMatcher(rules)(session.summary ?? '');
};

type UseProjectSessionFilterArgs = {
  projects: Project[];
  setProjects: Dispatch<SetStateAction<Project[]>>;
  /** Session ids that must stay visible despite the filter, read at request time. */
  getKeepSessionIds: () => string[];
};

/**
 * Owns the sidebar's per-project session-name filter runtime: the browser-local
 * "show hidden" set, keepSessionIds for every session request and page reloads.
 * Consumed by useProjectsState.
 */
export function useProjectSessionFilter({ projects, setProjects, getKeepSessionIds }: UseProjectSessionFilterArgs) {
  // Projects whose filtered sessions this browser temporarily shows; mirrored to localStorage so it survives a reload.
  const [showHiddenProjectIds, setShowHiddenProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(readShownHiddenProjectIds()),
  );
  const showHiddenRef = useRef(showHiddenProjectIds);
  showHiddenRef.current = showHiddenProjectIds;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const keepIdsRef = useRef(getKeepSessionIds);
  keepIdsRef.current = getKeepSessionIds;

  /** includeHidden + keepSessionIds for a project's next session request. */
  const getSessionRequestOptions = useCallback((projectId: string) => ({
    includeHidden: showHiddenRef.current.has(projectId),
    keepSessionIds: keepIdsRef.current(),
  }), []);

  const fetchPage = useCallback(async (projectId: string, limit: number, showHidden: boolean) => {
    const keepSessionIds = keepIdsRef.current();
    const readPage = async (includeHidden: boolean): Promise<ProjectSessionsPage> => {
      const response = await api.projectSessions(projectId, { limit, offset: 0, includeHidden, keepSessionIds });
      if (!response.ok) {
        throw new Error(`Failed to load sessions for project ${projectId}`);
      }
      return (await response.json()) as ProjectSessionsPage;
    };

    const filteredPage = await readPage(false);
    if (!showHidden) {
      return filteredPage;
    }
    // The server reports hiddenCount as 0 when includeHidden is set, so keep the filtered request's count.
    const fullPage = await readPage(true);
    return {
      ...fullPage,
      sessionMeta: { ...fullPage.sessionMeta, hiddenCount: filteredPage.sessionMeta?.hiddenCount ?? 0 },
    };
  }, []);

  /**
   * Re-requests a project's first page(s). `replace` swaps the loaded list (rules
   * changed / toggled off); otherwise the page is unioned into what is already loaded.
   */
  const reloadProjectSessions = useCallback(async (
    projectId: string,
    { showHidden, replace }: { showHidden: boolean; replace: boolean },
  ) => {
    const project = projectsRef.current.find((candidate) => candidate.projectId === projectId);
    const limit = Math.max(MIN_RELOAD_PAGE_SIZE, project?.sessions?.length ?? 0);
    const page = await fetchPage(projectId, limit, showHidden);

    setProjects((previousProjects) => previousProjects.map((candidate) => {
      if (candidate.projectId !== projectId) {
        return candidate;
      }

      const incoming = page.sessions ?? [];
      const incomingIds = new Set(incoming.map((session) => String(session.id)));
      const sessions = replace
        ? incoming
        : [...incoming, ...(candidate.sessions ?? []).filter((session) => !incomingIds.has(String(session.id)))];
      const total = Number(page.sessionMeta?.total ?? sessions.length);
      return {
        ...candidate,
        sessions,
        sessionMeta: {
          ...candidate.sessionMeta,
          ...page.sessionMeta,
          total,
          hasMore: sessions.length < total,
        },
      };
    }));
  }, [fetchPage, setProjects]);

  /** Flips the browser-local "show hidden" flag for a project and reloads it accordingly. */
  const toggleShowHidden = useCallback((projectId: string) => {
    const next = new Set(showHiddenRef.current);
    const showHidden = !next.has(projectId);
    if (showHidden) {
      next.add(projectId);
    } else {
      next.delete(projectId);
    }
    showHiddenRef.current = next;
    setShowHiddenProjectIds(next);
    writeShownHiddenProjectIds(next);
    void reloadProjectSessions(projectId, { showHidden, replace: !showHidden }).catch((error) => {
      console.error('Error reloading project sessions:', error);
    });
  }, [reloadProjectSessions]);

  /** After a rules save: adopt the saved rules locally (drives incremental matching) and reload the list. */
  const handleSessionFilterSaved = useCallback(async (projectId: string, hide: string[]) => {
    setProjects((previousProjects) => previousProjects.map((candidate) => (
      candidate.projectId === projectId
        ? { ...candidate, sessionFilter: hide.length > 0 ? { hide } : null }
        : candidate
    )));
    await reloadProjectSessions(projectId, { showHidden: showHiddenRef.current.has(projectId), replace: true });
  }, [reloadProjectSessions, setProjects]);

  /** After a full project fetch, re-expands the projects this browser shows unfiltered. */
  const reloadShownHiddenProjects = useCallback((loadedProjects: Project[]) => {
    for (const project of loadedProjects) {
      if (showHiddenRef.current.has(project.projectId) && (project.sessionMeta?.hiddenCount ?? 0) > 0) {
        void reloadProjectSessions(project.projectId, { showHidden: true, replace: false }).catch((error) => {
          console.error('Error reloading project sessions:', error);
        });
      }
    }
  }, [reloadProjectSessions]);

  // Drop ids of projects that no longer exist so the persisted set does not grow forever.
  useEffect(() => {
    if (projects.length === 0) {
      return;
    }
    const known = new Set(projects.map((project) => project.projectId));
    const stale = [...showHiddenRef.current].filter((projectId) => !known.has(projectId));
    if (stale.length === 0) {
      return;
    }
    const next = new Set([...showHiddenRef.current].filter((projectId) => known.has(projectId)));
    showHiddenRef.current = next;
    setShowHiddenProjectIds(next);
    writeShownHiddenProjectIds(next);
  }, [projects]);

  return {
    showHiddenProjectIds,
    showHiddenRef,
    getSessionRequestOptions,
    toggleShowHidden,
    handleSessionFilterSaved,
    reloadShownHiddenProjects,
  };
}
