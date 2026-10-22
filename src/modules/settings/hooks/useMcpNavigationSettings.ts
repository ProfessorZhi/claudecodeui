import { useCallback, useEffect, useState } from 'react';

/**
 * This device's answer to an incoming MCP navigation request: `accept` opens it without
 * asking, `ask` confirms first, `reject` refuses. Stored in this browser's localStorage, so
 * the choice belongs to the device rather than to the account.
 */
export type McpNavigationPolicy = 'accept' | 'ask' | 'reject';

/** localStorage key holding this browser's chosen MCP navigation policy. */
export const MCP_NAVIGATION_POLICY_STORAGE_KEY = 'mcpNavigationPolicy';

/** localStorage key holding this browser's user-editable device name. */
export const MCP_DEVICE_NAME_STORAGE_KEY = 'mcpNavigationDeviceName';

/** Every policy the UI offers, in the order the settings section lists them. */
const MCP_NAVIGATION_POLICIES: readonly McpNavigationPolicy[] = ['accept', 'ask', 'reject'];

/**
 * The policy a device falls back to when it has not chosen one — and when what it stored
 * cannot be read: `ask` is safe because it neither opens nor silently refuses a navigation
 * the user never saw.
 */
const DEFAULT_MCP_NAVIGATION_POLICY: McpNavigationPolicy = 'ask';

/** Narrows an arbitrary stored value to a policy; unset or junk is not one. */
const isMcpNavigationPolicy = (value: unknown): value is McpNavigationPolicy =>
  typeof value === 'string' && (MCP_NAVIGATION_POLICIES as readonly string[]).includes(value);

/** The User-Agent of the browser this code runs in, or '' outside a browser. */
const readUserAgent = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent);

/**
 * The browser family named in a User-Agent string, at the coarsest granularity that stays
 * recognisable to a person. Ordered so the specific tokens win: Edge and Opera also say
 * "Chrome", and every Chromium browser also says "Safari".
 */
const detectBrowserName = (userAgent: string): string => {
  if (/Edg[eo]?\/|Edge\//.test(userAgent)) {
    return 'Edge';
  }
  if (/OPR\/|Opera/.test(userAgent)) {
    return 'Opera';
  }
  if (/Firefox\/|FxiOS/.test(userAgent)) {
    return 'Firefox';
  }
  if (/Chrome\/|CriOS/.test(userAgent)) {
    return 'Chrome';
  }
  if (/Safari\//.test(userAgent)) {
    return 'Safari';
  }
  return 'Browser';
};

/**
 * The operating-system family named in a User-Agent string. Android and iOS are matched
 * before Linux and macOS, because their User-Agents also contain "Linux" / "Mac OS X".
 */
const detectOsName = (userAgent: string): string => {
  if (/Android/.test(userAgent)) {
    return 'Android';
  }
  if (/iPhone|iPad|iPod/.test(userAgent)) {
    return 'iOS';
  }
  if (/Windows/.test(userAgent)) {
    return 'Windows';
  }
  if (/Mac OS X|Macintosh/.test(userAgent)) {
    return 'macOS';
  }
  if (/Linux|X11/.test(userAgent)) {
    return 'Linux';
  }
  return 'Unknown system';
};

/**
 * Derives a human-readable default device name from a User-Agent string, e.g. "Chrome · Linux".
 * Deliberately coarse — the browser family and the OS family only — so the name carries
 * neither a version number nor anything that identifies the machine, which is what makes it
 * safe to publish to the server when the user never names the device themselves.
 */
const deriveDefaultDeviceName = (userAgent: string): string =>
  `${detectBrowserName(userAgent)} · ${detectOsName(userAgent)}`;

/** The effective name for a stored value: the trimmed stored name, or the derived default. */
const resolveDeviceName = (stored: string | null): string =>
  stored !== null && stored.trim().length > 0
    ? stored.trim()
    : deriveDefaultDeviceName(readUserAgent());

/**
 * Reads this device's MCP navigation policy straight from localStorage, without React.
 * Anything unset, unrecognised, or unreadable answers `ask`, so a caller (a WS reply, a
 * navigation executor) never has to distinguish "no choice" from "no storage".
 */
export const readMcpNavigationPolicy = (): McpNavigationPolicy => {
  try {
    const stored = localStorage.getItem(MCP_NAVIGATION_POLICY_STORAGE_KEY);
    return isMcpNavigationPolicy(stored) ? stored : DEFAULT_MCP_NAVIGATION_POLICY;
  } catch {
    return DEFAULT_MCP_NAVIGATION_POLICY;
  }
};

/**
 * Writes this device's MCP navigation policy straight to localStorage, without React. Used
 * by features that let the user settle a decision permanently (the navigation prompt's
 * "always accept" / "always reject"), so a reader mounted afterwards — the settings section —
 * sees the new choice without a reload. Storage failures are swallowed: the choice then
 * applies only to the current page's lifetime, which is still better than throwing inside a
 * websocket handler.
 */
export const writeMcpNavigationPolicy = (policy: McpNavigationPolicy): void => {
  try {
    localStorage.setItem(MCP_NAVIGATION_POLICY_STORAGE_KEY, policy);
  } catch {
    // The caller's in-memory choice still applies while this page lives.
  }
};

/**
 * Reads this device's name straight from localStorage, without React. An unset or blank
 * stored name answers the User-Agent-derived default, so the device always has a name.
 */
export const readDeviceName = (): string => {
  try {
    return resolveDeviceName(localStorage.getItem(MCP_DEVICE_NAME_STORAGE_KEY));
  } catch {
    return resolveDeviceName(null);
  }
};

type UseMcpNavigationSettingsResult = {
  policy: McpNavigationPolicy;
  deviceName: string;
  setPolicy: (policy: McpNavigationPolicy) => void;
  setDeviceName: (name: string) => void;
};

/**
 * Owns this device's MCP navigation policy and name for the settings UI: seeds them from
 * localStorage on first render, writes each change back, and mirrors changes made in the
 * browser's other tabs. Consumed by McpNavigationSection; non-component code (a WS reply, a
 * navigation executor) uses the pure readers above instead.
 */
export function useMcpNavigationSettings(): UseMcpNavigationSettingsResult {
  // The chosen policy this tab renders, seeded straight from storage so the first paint
  // already reflects the device's choice rather than flickering from the default.
  const [policy, setPolicyState] = useState<McpNavigationPolicy>(readMcpNavigationPolicy);
  // The name this tab renders: the stored name, or the derived default when none is set.
  const [deviceName, setDeviceNameState] = useState<string>(readDeviceName);

  // Another tab of this same browser changing either value fires a `storage` event here
  // (never in the tab that wrote it); without this listener the tabs would disagree until a
  // reload. The event carries the new value, so a removed key re-derives the default name
  // rather than keeping a stale one.
  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === MCP_NAVIGATION_POLICY_STORAGE_KEY) {
        setPolicyState(
          isMcpNavigationPolicy(event.newValue) ? event.newValue : DEFAULT_MCP_NAVIGATION_POLICY,
        );
      } else if (event.key === MCP_DEVICE_NAME_STORAGE_KEY) {
        setDeviceNameState(resolveDeviceName(event.newValue));
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const setPolicy = useCallback((next: McpNavigationPolicy) => {
    setPolicyState(next);
    try {
      localStorage.setItem(MCP_NAVIGATION_POLICY_STORAGE_KEY, next);
    } catch {
      // Keep the choice for this session even when storage is unavailable.
    }
  }, []);

  const setDeviceName = useCallback((next: string) => {
    const trimmed = next.trim();
    setDeviceNameState(resolveDeviceName(trimmed));
    try {
      if (trimmed.length === 0) {
        localStorage.removeItem(MCP_DEVICE_NAME_STORAGE_KEY);
      } else {
        localStorage.setItem(MCP_DEVICE_NAME_STORAGE_KEY, trimmed);
      }
    } catch {
      // Keep the name for this session even when storage is unavailable.
    }
  }, []);

  return { policy, deviceName, setPolicy, setDeviceName };
}
