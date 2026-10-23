import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { AppTab, Project } from '@/shared/types';

/**
 * The Quay tab's gate: only a project the listing marked `hasQuayConfig` offers
 * the view. Kept as a pure function so `WorkspaceMain` and its test read the
 * same rule instead of restating `Boolean(project?.hasQuayConfig)`.
 */
export const isQuayTabVisible = (project: Project | null): boolean => Boolean(project?.hasQuayConfig);

/**
 * Closes the Quay tab when the selected project no longer offers it.
 *
 * Mirrors WorkspaceMain's Tasks/Browser guards: a tab that is no longer in the
 * list must not stay the active view, so a project switch — or a Tier-1 reading
 * that flips to false — snaps back to chat rather than leaving an unreachable
 * pane mounted.
 */
export function useEnsureQuayTabVisible(
  shouldShowQuayTab: boolean,
  activeTab: AppTab,
  setActiveTab: Dispatch<SetStateAction<AppTab>>,
): void {
  useEffect(() => {
    if (!shouldShowQuayTab && activeTab === 'quay') {
      setActiveTab('chat');
    }
  }, [shouldShowQuayTab, activeTab, setActiveTab]);
}
