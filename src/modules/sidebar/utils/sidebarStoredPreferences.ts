import type { ProjectSortOrder } from '@/shared/types';
import { readUserPreference } from '@/shared/userSettings';

export const readProjectSortOrder = (): ProjectSortOrder => (
  readUserPreference<ProjectSortOrder>('projectSortOrder', 'name') === 'date' ? 'date' : 'name'
);

const LEGACY_STARRED_PROJECTS_STORAGE_KEY = 'starredProjects';

/**
 * Reads legacy project stars from localStorage (used only for one-time migration to backend).
 */
export const readLegacyStarredProjectIds = (): string[] => {
  try {
    const saved = localStorage.getItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
    if (!saved) {
      return [];
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
};

/**
 * Clears the legacy localStorage stars key after migration to backend completes.
 */
export const clearLegacyStarredProjectIds = () => {
  try {
    localStorage.removeItem(LEGACY_STARRED_PROJECTS_STORAGE_KEY);
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};

const SHOWN_HIDDEN_PROJECTS_STORAGE_KEY = 'sidebarShownHiddenSessionProjects';

/**
 * Reads the ids of projects whose name-filtered sessions this browser shows temporarily.
 * Browser-local on purpose: it never changes the project's stored rules.
 */
export const readShownHiddenProjectIds = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed)
      ? parsed.map((value) => String(value).trim()).filter((value) => value.length > 0)
      : [];
  } catch {
    return [];
  }
};

const SIDEBAR_WIDTH_STORAGE_KEY = 'sidebarWidth';

/**
 * Exactly the shape {@link writeStoredSidebarWidth} writes: an optional sign and
 * a run of digits, and nothing else.
 *
 * A permissive parse is not good enough here, because `Number.parseInt` answers
 * with a *number* for several strings that are not widths: `'abc'` gives NaN,
 * but `'0x10'` gives 0 and `'12px'` gives 12. Both of those reach the clamp as a
 * plausible-looking small width and land the sidebar on its 220px floor, so a
 * corrupted key looks like a deliberate narrow sidebar instead of a key to
 * ignore — and the user has no way to widen it back except by dragging.
 */
const STORED_WIDTH_PATTERN = /^-?\d+$/;

/**
 * Reads the sidebar width the user dragged to, in px, or null when they never
 * dragged it or the stored value is not a width. Browser-local on purpose: how
 * much room navigation deserves is a property of the screen it is on, not of
 * the account.
 */
export const readStoredSidebarWidth = (): number | null => {
  try {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (saved === null || !STORED_WIDTH_PATTERN.test(saved)) {
      return null;
    }

    const parsed = Number.parseInt(saved, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/** Persists the sidebar width in px, so the next visit opens at the width the user left it at. */
export const writeStoredSidebarWidth = (width: number) => {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // Keep the drag responsive even if storage is unavailable; the width holds for this session either way.
  }
};

/** Persists the temporary "show hidden sessions" project ids; an empty list removes the key. */
export const writeShownHiddenProjectIds = (projectIds: Iterable<string>) => {
  try {
    const ids = [...projectIds];
    if (ids.length === 0) {
      localStorage.removeItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY);
      return;
    }
    localStorage.setItem(SHOWN_HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Keep UI responsive even if storage is unavailable.
  }
};
