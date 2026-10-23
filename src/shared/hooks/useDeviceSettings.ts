import { useEffect, useState } from 'react';

/**
 * The viewport height, in CSS pixels, below which a touch-only device takes the short tier.
 *
 * Height, and not width, because a phone in landscape is *wide*: 844px clears `md` comfortably, so
 * every width-keyed rule in the app reads it as a small desktop and hands it the desktop's chrome —
 * a 57px header, a 57px composer row, 24px of composer padding — while it has only ~330px of screen
 * to pay for them with, once a browser's own toolbar is drawn. Measured before this tier existed:
 * 844x330 left the transcript 126px, and a 20-line draft pushed the submit button off the viewport
 * entirely. This constant is the axis those rules cannot see.
 *
 * 480 sits above every landscape phone (320-390 tall before browser chrome) and below any window a
 * desktop is actually worked in. Height alone does not decide the tier — see the touch-only half
 * below, which is what keeps a short desktop *window* on the layout a desktop was designed for.
 */
export const SHORT_VIEWPORT_MAX_HEIGHT_PX = 480;

/**
 * The media query that means "this device is a touch-only device": a coarse primary pointer (a
 * finger) and no hover.
 *
 * Both halves rather than either: a touchscreen laptop reports a coarse pointer for its touchscreen
 * while its primary pointer stays fine, and a phone with a mouse attached reports hover. The same
 * query `useSendOnEnter` reads for Enter's behaviour, and the same one `useSidebarResize` reads for
 * its splitter — this hook reads it for the height tier, whose premise is a device whose chrome has
 * nowhere else to go.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

type UseDeviceSettingsOptions = {
  mobileBreakpoint?: number;
  shortViewportMaxHeight?: number;
  trackMobile?: boolean;
  trackPWA?: boolean;
};

const getIsMobile = (mobileBreakpoint: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerWidth < mobileBreakpoint;
};

const getIsShortHeight = (shortViewportMaxHeight: number): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.innerHeight < shortViewportMaxHeight;
};

const getIsTouchOnly = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(TOUCH_ONLY_QUERY).matches;
};

const getIsPWA = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean(navigatorWithStandalone.standalone) ||
    document.referrer.includes('android-app://')
  );
};

export function useDeviceSettings(options: UseDeviceSettingsOptions = {}) {
  const {
    mobileBreakpoint = 768,
    shortViewportMaxHeight = SHORT_VIEWPORT_MAX_HEIGHT_PX,
    trackMobile = true,
    trackPWA = true
  } = options;

  const [isMobile, setIsMobile] = useState<boolean>(() => (
    trackMobile ? getIsMobile(mobileBreakpoint) : false
  ));
  // The height half of the short tier, held as state rather than read during render because three
  // surfaces draw a different structure on that tier — the composer's row, the transcript's bottom
  // padding, the workspace header's padding — and a rotation has to redraw all three without any of
  // them changing for another reason. A value read at render time would leave the landscape layout
  // in place after the device was turned upright.
  const [isShortHeight, setIsShortHeight] = useState<boolean>(() => (
    trackMobile ? getIsShortHeight(shortViewportMaxHeight) : false
  ));
  // The device half. Read once and then followed, for the same reason `useSendOnEnter` follows it:
  // the query can flip while the app is open — a tablet docked to a keyboard, a mouse paired to a
  // phone — and a tier that turned on at a phone's height must turn off when the device stops
  // being one.
  const [isTouchOnly, setIsTouchOnly] = useState<boolean>(() => (
    trackMobile ? getIsTouchOnly() : false
  ));
  const [isPWA, setIsPWA] = useState<boolean>(() => (
    trackPWA ? getIsPWA() : false
  ));

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined') {
      return;
    }

    // One listener drives both viewport signals: they are read from the same event, and a caller
    // that opts out of viewport tracking (`trackMobile: false`, which the sidebar does because it
    // reads neither) has no use for either of them.
    const checkViewport = () => {
      setIsMobile(getIsMobile(mobileBreakpoint));
      setIsShortHeight(getIsShortHeight(shortViewportMaxHeight));
    };

    checkViewport();
    window.addEventListener('resize', checkViewport);

    return () => {
      window.removeEventListener('resize', checkViewport);
    };
  }, [mobileBreakpoint, shortViewportMaxHeight, trackMobile]);

  useEffect(() => {
    if (!trackMobile || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia(TOUCH_ONLY_QUERY);
    const onChange = () => setIsTouchOnly(query.matches);
    onChange();

    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [trackMobile]);

  useEffect(() => {
    if (!trackPWA || typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const checkPWA = () => {
      setIsPWA(getIsPWA());
    };

    checkPWA();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', checkPWA);
      return () => {
        mediaQuery.removeEventListener('change', checkPWA);
      };
    }

    mediaQuery.addListener(checkPWA);
    return () => {
      mediaQuery.removeListener(checkPWA);
    };
  }, [trackPWA]);

  // Derived, not stored: the tier is the conjunction of the two readings, and holding a third copy
  // of it would be one more thing that can disagree with its own inputs.
  return { isMobile, isPWA, isShortTouchViewport: isShortHeight && isTouchOnly };
}
