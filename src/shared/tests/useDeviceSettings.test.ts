import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import {
  SHORT_VIEWPORT_MAX_HEIGHT_PX,
  useDeviceSettings,
} from '@/shared/hooks/useDeviceSettings';

/**
 * The short tier is the only thing in the app read from the viewport's *height*, and it is the only
 * layout decision read from the device as well as the viewport. Both halves are load-bearing and
 * each has its own case below, because getting either wrong has a cost that was paid once already:
 *
 * - Without the height half, a phone in landscape (844 wide, 330 tall) is handed the desktop chrome
 *   and left with a 126px transcript.
 * - Without the device half, a *desktop window* shorter than the threshold — DevTools docked to the
 *   bottom, a window that is not maximised — gets the phone's layout. That shipped, and it put the
 *   composer's keyboard hint (which a touch device hides at every width) onto the same row as the
 *   controls, crushing the input to 138px of an 866px box. No landscape case in the suite could see
 *   it, because every one of them emulates a touch device.
 */

/** jsdom's own window, restored before each case because the viewport is a writable global. */
const JSDOM_WIDTH = 1024;
const JSDOM_HEIGHT = 768;

const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

/** The device the case is running on, as the matchMedia double answers it. */
const device = { touchOnly: false };

/**
 * The listeners the hook attached to the touch query, so a case can flip the device and have the
 * hook hear it. The other queries the hook asks about answer `false` and are never listened to.
 */
let touchListeners: Array<() => void> = [];

const installMatchMedia = () => {
  touchListeners = [];
  window.matchMedia = ((query: string) => {
    const isTouchQuery = query === TOUCH_ONLY_QUERY;
    return {
      // A getter, not a snapshot: a real `MediaQueryList.matches` is live, and the hook's change
      // handler reads it after the device has flipped.
      get matches() {
        return isTouchQuery ? device.touchOnly : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        if (isTouchQuery) touchListeners.push(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        if (isTouchQuery) touchListeners = touchListeners.filter((entry) => entry !== listener);
      },
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
};

/** Docks a keyboard: the device stops being touch-only, and the hook is told. */
const dockKeyboard = () => {
  device.touchOnly = false;
  for (const listener of [...touchListeners]) listener();
};

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
};

beforeEach(() => {
  installMatchMedia();
  device.touchOnly = false;
  setViewport(JSDOM_WIDTH, JSDOM_HEIGHT);
});

test('on a touch device the tier turns on below the threshold and not at it', () => {
  device.touchOnly = true;
  setViewport(844, SHORT_VIEWPORT_MAX_HEIGHT_PX - 1);
  const below = renderHook(() => useDeviceSettings());
  assert.equal(below.result.current.isShortTouchViewport, true);
  below.unmount();

  setViewport(844, SHORT_VIEWPORT_MAX_HEIGHT_PX);
  const at = renderHook(() => useDeviceSettings());
  assert.equal(at.result.current.isShortTouchViewport, false);
});

test('a short window on a mouse-and-keyboard device is NOT the tier', () => {
  // The regression this half exists for. 1440x450 is a real desktop window (a docked DevTools pane
  // leaves exactly this), and the phone layout on it put the keyboard hint row — visible here
  // because the device has a keyboard, hidden on touch at every width — into the inline row, where
  // it took 467px of an 866px composer and left the input 138px.
  device.touchOnly = false;
  setViewport(1440, 450);

  const { result } = renderHook(() => useDeviceSettings());

  assert.equal(result.current.isShortTouchViewport, false);
});

test('a tall touch viewport is not the tier', () => {
  // The other half of the conjunction: a phone upright has the height to afford the stacked
  // composer and the floating status tab, so it must not be pulled onto the tier by its device.
  device.touchOnly = true;
  setViewport(390, 844);

  const { result } = renderHook(() => useDeviceSettings());
  assert.equal(result.current.isShortTouchViewport, false);
  assert.equal(result.current.isMobile, true);
});

test('height alone decides the height half, independently of the width rule', () => {
  // A phone in landscape: wide enough for `md` and far too short for the desktop chrome. The pair
  // is the point — `isMobile` is false here, so a tier derived from the width rule alone can never
  // reach this viewport.
  device.touchOnly = true;
  setViewport(844, 330);
  const landscapePhone = renderHook(() => useDeviceSettings());
  assert.equal(landscapePhone.result.current.isShortTouchViewport, true);
  assert.equal(landscapePhone.result.current.isMobile, false);
});

test("jsdom's own window is the tall tier", () => {
  const { result } = renderHook(() => useDeviceSettings());

  assert.equal(result.current.isShortTouchViewport, false);
});

test('a resize re-reads the tier, so a rotation does not keep the old layout', () => {
  device.touchOnly = true;
  setViewport(390, 844);
  const { result } = renderHook(() => useDeviceSettings());
  assert.equal(result.current.isShortTouchViewport, false);

  act(() => {
    setViewport(844, 330);
    window.dispatchEvent(new Event('resize'));
  });

  assert.equal(result.current.isShortTouchViewport, true);
});

test('the device half is followed, not read once: docking a keyboard leaves the tier', () => {
  // A tablet in landscape with a keyboard docked reports hover, so the tier has to turn off without
  // the viewport changing. `useSendOnEnter` follows the same query for the same reason.
  device.touchOnly = true;
  setViewport(900, 400);
  const { result } = renderHook(() => useDeviceSettings());
  assert.equal(result.current.isShortTouchViewport, true);

  act(() => {
    dockKeyboard();
  });

  assert.equal(result.current.isShortTouchViewport, false);
});

test('a caller that opts out of viewport tracking is never told it is short', () => {
  // The one option that gates the resize listener gates this signal with it. Stated as a test
  // rather than left implicit because the coupling is invisible at the call site.
  device.touchOnly = true;
  setViewport(844, 330);
  const { result } = renderHook(() => useDeviceSettings({ trackMobile: false }));

  assert.equal(result.current.isShortTouchViewport, false);
});

test('a device with no matchMedia at all is not treated as touch', () => {
  // `trackPWA: false` because the PWA reading asks matchMedia too, and this case is about the tier's
  // answer on an environment that cannot be asked at all — jsdom before the setup file installs its
  // fallback, and any browser old enough to lack the API.
  vi.stubGlobal('matchMedia', undefined);
  setViewport(844, 330);

  const { result } = renderHook(() => useDeviceSettings({ trackPWA: false }));

  assert.equal(result.current.isShortTouchViewport, false);
  vi.unstubAllGlobals();
  installMatchMedia();
});
