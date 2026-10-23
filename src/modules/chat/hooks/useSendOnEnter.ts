import { useEffect, useState } from 'react';

/**
 * The media query that means "this device is a touch-only device": a coarse primary pointer
 * (a finger) and no hover.
 *
 * Both halves are required rather than either. A touchscreen laptop reports a coarse pointer
 * for its touchscreen while its primary pointer stays fine, and a phone with a mouse attached
 * reports hover; treating one alone as "touch" would move Enter's behaviour on machines that
 * have a real keyboard.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

const readTouchOnly = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(TOUCH_ONLY_QUERY).matches;
};

/** What the composer's Enter key should do on this device, and why. */
export type ComposerSendKey = {
  /** True when a bare Enter submits; false when it must insert a newline instead. */
  sendOnEnter: boolean;
  /** True on a touch-only device, where the send button is the only way to submit. */
  touchOnly: boolean;
};

/**
 * Resolves the composer's Enter behaviour for the device in hand.
 *
 * A touch-only device never sends on Enter, whatever the stored preference says: a soft
 * keyboard has no Shift key, so an Enter-to-send default there leaves the user no way to
 * insert a newline at all — which is why Enter is the newline key in every comparable app on
 * touch, and why Slack and Teams scope their equivalent setting to desktop and web only.
 * Where a keyboard does exist, the user's own `sendByCtrlEnter` decides.
 *
 * Read by useChatComposerState for the keydown and by ChatComposer for the hint it prints, so
 * the key's behaviour and the sentence describing it cannot disagree.
 */
export function useSendOnEnter(sendByCtrlEnter?: boolean): ComposerSendKey {
  const [touchOnly, setTouchOnly] = useState<boolean>(readTouchOnly);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const query = window.matchMedia(TOUCH_ONLY_QUERY);
    const onChange = () => setTouchOnly(query.matches);
    // The query can flip while the composer is open — a tablet docked to a keyboard, a mouse
    // paired to a phone — so the composer has to follow it rather than read it once.
    query.addEventListener('change', onChange);
    onChange();

    return () => query.removeEventListener('change', onChange);
  }, []);

  return { sendOnEnter: !touchOnly && !sendByCtrlEnter, touchOnly };
}
