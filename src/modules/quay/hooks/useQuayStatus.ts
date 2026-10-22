import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { QuaySnapshot } from '@/shared/types';

/**
 * The four states `QuayPanel` renders. Kept as a discriminated union so the
 * panel can never show a snapshot and an error at once.
 */
export type QuayPanelView =
  | { status: 'not-configured' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; snapshot: QuaySnapshot };

type UseQuayStatusResult = {
  view: QuayPanelView;
  /** Re-fetches the snapshot, bypassing the backend's TTL cache. */
  refresh: () => void;
};

/**
 * Loads one project's Tier-2 quay snapshot for `QuayPanel`.
 *
 * The fetch only runs while the Quay tab is active and the project actually has
 * a `.quay/config.yml`; both conditions are the caller's gate against spawning
 * the quay CLI for a project that never opted in. Responses are tagged with a
 * request id so a slow reply for a previously selected project cannot overwrite
 * the current one's view.
 */
export function useQuayStatus(
  projectId: string | null,
  hasQuayConfig: boolean,
  isActive: boolean,
): UseQuayStatusResult {
  const [fetchedView, setFetchedView] = useState<QuayPanelView>({ status: 'loading' });
  const requestIdRef = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    if (!projectId) {
      return;
    }

    const requestId = (requestIdRef.current += 1);
    setFetchedView({ status: 'loading' });

    try {
      const response = await api.quaySnapshot(projectId, { refresh });
      if (requestIdRef.current !== requestId) {
        return;
      }

      if (!response.ok) {
        setFetchedView({ status: 'error', message: `Failed to load quay status (HTTP ${response.status})` });
        return;
      }

      const snapshot = (await response.json()) as QuaySnapshot;
      if (requestIdRef.current !== requestId) {
        return;
      }

      setFetchedView({ status: 'loaded', snapshot });
    } catch (error) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      setFetchedView({ status: 'error', message: error instanceof Error ? error.message : 'Failed to load quay status' });
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !hasQuayConfig || !isActive) {
      return;
    }

    void load(false);
  }, [projectId, hasQuayConfig, isActive, load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  // The not-configured reading is derived during render rather than pushed into
  // state, so a project without quay never even transiently shows a stale snapshot.
  const view: QuayPanelView = (!projectId || !hasQuayConfig)
    ? { status: 'not-configured' }
    : fetchedView;

  return { view, refresh };
}
