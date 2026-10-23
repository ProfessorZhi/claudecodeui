/**
 * This browser's identity for the MCP client registry.
 *
 * Two ids, deliberately at different lifetimes:
 *
 *  - `deviceId` lives in localStorage, so it survives reloads, restarts and new
 *    tabs, and only "clear site data" replaces it. It is what an external MCP
 *    caller selects when it wants *this device* — a websocket connection id
 *    cannot serve that role, because it changes on every reconnect.
 *  - `tabId` lives in sessionStorage, so a reload of one tab keeps it while a
 *    second tab open in the same browser gets a different one. It is what tells
 *    two tabs of one device apart in a device's `tabs[]` listing.
 *
 * Both are published to the server once per connection (the `ui.hello` frame in
 * `WebSocketContext`), which is the single point in time identity is announced:
 * nothing here polls, and nothing reports on a schedule.
 *
 * Storage is best effort. A browser that blocks it (private mode, disabled
 * cookies, a storage getter that throws) must not break the connection, so every
 * read degrades to an in-memory random value that stays stable for the page's
 * lifetime instead of throwing.
 */

/** localStorage key holding this browser's stable device identity. */
const DEVICE_ID_STORAGE_KEY = 'mcpDeviceId';

/** sessionStorage key holding this tab's identity. */
const TAB_ID_STORAGE_KEY = 'mcpTabId';

/**
 * The in-memory fallback for each key, used only when storage cannot be reached
 * or refuses to hold the value. Module state, so it lasts as long as the page.
 */
const memoryIdentities = new Map<string, string>();

/** A random identifier, preferring the platform UUID generator. */
const randomIdentity = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * One of the two Web Storage areas, or null when it cannot be reached.
 *
 * The lookup itself is inside the `try` on purpose: `window.localStorage` can
 * throw a SecurityError before it returns anything, so the accessor — not just
 * the read — is what has to be guarded.
 */
const storageAreaOrNull = (area: 'localStorage' | 'sessionStorage'): Storage | null => {
  try {
    if (typeof window === 'undefined') {
      return null;
    }
    return window[area] ?? null;
  } catch {
    return null;
  }
};

/**
 * Reads the identity under `key`, creating and persisting one when there is none.
 *
 * A stored value always wins, which is what makes "clear site data then ask
 * again" produce a new id: the empty storage is read as "no value yet", not as
 * "the page remembers one". The memory fallback is consulted only when storage
 * is unreachable or refuses the write.
 */
const readOrCreateIdentity = (area: 'localStorage' | 'sessionStorage', key: string): string => {
  const storage = storageAreaOrNull(area);

  if (storage) {
    try {
      const stored = storage.getItem(key);
      if (stored !== null && stored !== '') {
        memoryIdentities.set(key, stored);
        return stored;
      }

      const created = randomIdentity();
      memoryIdentities.set(key, created);
      storage.setItem(key, created);
      return created;
    } catch {
      // The read or the write was refused: fall through to the memory value,
      // which the line above has already seeded.
    }
  }

  const remembered = memoryIdentities.get(key);
  if (remembered !== undefined) {
    return remembered;
  }
  const created = randomIdentity();
  memoryIdentities.set(key, created);
  return created;
};

/**
 * This browser's stable device id. Stable across reloads and tabs while the
 * site's data survives; a fresh value once it is cleared. Never throws.
 */
export const getDeviceId = (): string => readOrCreateIdentity('localStorage', DEVICE_ID_STORAGE_KEY);

/**
 * This tab's id. Stable across reloads of the same tab, distinct in every other
 * tab of the same browser. Never throws.
 */
export const getTabId = (): string => readOrCreateIdentity('sessionStorage', TAB_ID_STORAGE_KEY);
