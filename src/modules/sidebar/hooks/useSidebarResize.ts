import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import {
  readStoredSidebarWidth,
  writeStoredSidebarWidth,
} from '@/modules/sidebar/utils/sidebarStoredPreferences';

/**
 * The width the sidebar has always opened at — Tailwind's `w-72` — kept as the
 * default so an install that never drags the splitter looks exactly as before.
 */
const DEFAULT_WIDTH_PX = 288;
/** Below this the header's button row and the project rows stop fitting on one line. */
const MIN_WIDTH_PX = 220;
/** Above this the transcript has given up too much of the window to navigation. */
const MAX_WIDTH_PX = 480;
/** The sidebar never takes more than half the window, however wide that window was when it was dragged. */
const MAX_VIEWPORT_FRACTION = 0.5;
/** Arrow-key step on the splitter; the shifted step is the coarse one. */
const KEYBOARD_STEP_PX = 16;
const KEYBOARD_STEP_COARSE_PX = 64;

/**
 * The widest the sidebar may be right now: the policy ceiling, lowered on a
 * window too narrow to give half of itself away.
 */
const readMaxWidth = (): number => {
  if (typeof window === 'undefined') {
    return MAX_WIDTH_PX;
  }

  const viewportMax = Math.round(window.innerWidth * MAX_VIEWPORT_FRACTION);
  return Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, viewportMax));
};

const clampWidth = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_WIDTH_PX;
  }

  return Math.min(Math.max(Math.round(value), MIN_WIDTH_PX), readMaxWidth());
};

/**
 * The media query that means "a finger is the only pointer here": a coarse
 * primary pointer and no hover.
 *
 * Both halves are required rather than either, the same rule useSendOnEnter
 * applies to the composer's Enter key: a touchscreen laptop reports a coarse
 * pointer for its touchscreen while its primary pointer stays fine, and a phone
 * with a mouse attached reports hover, so either half alone would take the
 * splitter away from a machine whose user has a pointer.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

let touchOnlyQuery: MediaQueryList | null = null;
const readTouchOnlyQuery = (): MediaQueryList => (touchOnlyQuery ??= window.matchMedia(TOUCH_ONLY_QUERY));

function subscribeToTouchOnlyPointer(onChange: () => void): () => void {
  const media = readTouchOnlyQuery();
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * True while a drag on the sidebar would be a finger drag.
 *
 * One shared `MediaQueryList` serves every caller, so the sidebar re-renders on
 * the gesture a device offers changing — a tablet gaining a trackpad — and on
 * nothing else.
 */
function useTouchOnlyPointer(): boolean {
  return useSyncExternalStore(subscribeToTouchOnlyPointer, () => readTouchOnlyQuery().matches);
}

type UseSidebarResizeOptions = {
  /** True in the touch layout, where the sidebar is a drawer of the drawer's own width. */
  isMobile: boolean;
};

/**
 * Owns the sidebar's width: where it is dragged to, where the keyboard puts it,
 * and where it is remembered.
 *
 * A drag writes the width straight onto the root element and commits it — state
 * and storage — only on release. The sidebar rebuilds its project list props on
 * every render, so a width held in state during the drag would re-render every
 * project and session row at pointer-move rate; the element rewrite touches one
 * style property instead, and the commit then lands on the value already on
 * screen, so the release is invisible.
 */
export function useSidebarResize({ isMobile }: UseSidebarResizeOptions) {
  const isTouchOnlyPointer = useTouchOnlyPointer();
  // Two ways a device gets no splitter. The drawer sizes itself. And a
  // touch-only device has no pointer to aim at a 6px target with: the same drag
  // is a finger drag on the panel, where it fights the sidebar's own scroll, and
  // the width it would leave behind is a desktop arrangement chosen by accident.
  const canResize = !isMobile && !isTouchOnlyPointer;

  // Read synchronously so the first paint is already the stored width, the same
  // trade every other sidebar preference makes.
  const [width, setWidth] = useState<number>(() => {
    const stored = readStoredSidebarWidth();
    return stored === null ? DEFAULT_WIDTH_PX : clampWidth(stored);
  });
  // True between pointer-down and release, so the root can lock the page cursor.
  const [isResizing, setIsResizing] = useState(false);
  // Held as state rather than read during render so a window resize updates the
  // ceiling the handle announces, not just the one a drag is clamped against.
  const [maxWidth, setMaxWidth] = useState(readMaxWidth);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Pointer x where the drag started, null when no drag is in flight.
  const dragStartXRef = useRef<number | null>(null);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH_PX);
  // The width the drag has reached but not yet committed.
  const draggedWidthRef = useRef(DEFAULT_WIDTH_PX);

  /** Commits a width the user chose: state for this render, storage for the next visit. */
  const commitWidth = useCallback((next: number) => {
    setWidth(next);
    writeStoredSidebarWidth(next);
  }, []);

  // A window too narrow for the committed width must clamp it, but that is the
  // window's doing and not a choice, so this path deliberately skips storage.
  useEffect(() => {
    if (!canResize) {
      return undefined;
    }

    const handleWindowResize = () => {
      setMaxWidth(readMaxWidth());
      setWidth((current) => clampWidth(current));
    };

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [canResize]);

  // Held for the whole drag: without it, dragging across the transcript selects
  // its text, and the cursor only reads as a resize over the 6px handle.
  useEffect(() => {
    if (!isResizing) {
      return undefined;
    }

    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;

    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';

    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [isResizing]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canResize || event.button !== 0) {
      return;
    }

    // The cursor spends most of the drag outside the handle, over the chat, so
    // without capture the moves would stop arriving as soon as it left.
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = width;
    draggedWidthRef.current = width;
    setIsResizing(true);
  }, [canResize, width]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartXRef.current === null) {
      return;
    }

    const next = clampWidth(dragStartWidthRef.current + (event.clientX - dragStartXRef.current));
    draggedWidthRef.current = next;

    const node = rootRef.current;
    if (node) {
      node.style.width = `${next}px`;
    }
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartXRef.current === null) {
      return;
    }

    dragStartXRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setIsResizing(false);
    commitWidth(draggedWidthRef.current);
  }, [commitWidth]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_COARSE_PX : KEYBOARD_STEP_PX;

    let requested: number | null = null;
    if (event.key === 'ArrowLeft') {
      requested = width - step;
    } else if (event.key === 'ArrowRight') {
      requested = width + step;
    } else if (event.key === 'Home') {
      requested = MIN_WIDTH_PX;
    } else if (event.key === 'End') {
      requested = readMaxWidth();
    }

    if (requested === null) {
      return;
    }

    // The key is the resize, so the page must not also scroll with it.
    event.preventDefault();
    commitWidth(clampWidth(requested));
  }, [commitWidth, width]);

  const resetWidth = useCallback(() => {
    commitWidth(DEFAULT_WIDTH_PX);
  }, [commitWidth]);

  return {
    // Always a width: a device with no splitter still gets the docked panel at
    // the width it is stored at, it just cannot change it.
    width,
    /** False when this device renders no splitter at all; the caller renders no handle. */
    canResize,
    minWidth: MIN_WIDTH_PX,
    maxWidth,
    isResizing,
    rootRef,
    handleProps: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
      onKeyDown: handleKeyDown,
      onDoubleClick: resetWidth,
    },
  };
}
