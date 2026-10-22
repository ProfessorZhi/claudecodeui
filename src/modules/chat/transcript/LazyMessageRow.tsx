import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { ChatMessage } from '@/shared/types';
import type { LazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';

/**
 * Mounts a transcript row's real content only while the row is near the
 * viewport, and swaps it for a fixed-height placeholder otherwise.
 *
 * The transcript renders every loaded message into the DOM, so "Load all" on a
 * long session used to commit tens of thousands of markdown/tool subtrees at
 * once — a gigabyte-scale tab. The wrapper element here always stays in the
 * DOM (carrying the row's `data-message-timestamp`, so search jumps and scroll
 * anchors keep working against unmounted rows), while the expensive subtree
 * exists only inside a band around the viewport.
 *
 * The placeholder reuses the row's last measured height, so scrolling back
 * through previously seen content changes no scroll geometry at all. A row
 * never yet measured has no such height, and a flat 100px stands in for it —
 * which is 2.5× short for a tall conversation's paragraphs, so a jump that
 * centres the target against those placeholders lands hundreds of pixels off.
 * The estimate therefore comes from the transcript's own content model: the
 * running average pixels a single message occupies, times how many messages the
 * row stands for. `ESTIMATED_ROW_HEIGHT_PX` is only the fallback for a render
 * that has no estimate yet (nothing measurable in the window, or a standalone
 * render outside the pane).
 */

/** Placeholder height for rows that have never been measured and have no estimate to use. */
const ESTIMATED_ROW_HEIGHT_PX = 100;

type LazyMessageRowProps = {
  lazyRows: LazyRowObserver | null;
  /** Mirrors the row's own `data-message-timestamp`, present even while unmounted. */
  timestamp: ChatMessage['timestamp'] | undefined;
  /**
   * The row's transcript anchor id, when it has one, published as
   * `data-message-anchor-id` on the persistent wrapper.
   *
   * This is what a jump addresses: the wrapper exists whether or not the row's
   * content is currently mounted, so an id lookup finds a target that no
   * timestamp can disambiguate (two turns sharing one millisecond) and that a
   * content-only attribute would miss until the row were already on screen.
   */
  anchorId?: string | null;
  /**
   * Rows near the tail render their content on first commit so the initial
   * scroll-to-bottom measures real heights; everything older starts as a
   * placeholder and mounts when scrolled toward.
   */
  initiallyNearViewport: boolean;
  /**
   * The transcript's running average pixels per message, or 0 when nothing is
   * measurable yet. A never-measured row's placeholder is `messageCount × this`,
   * so an unmounted row stands in for roughly its real height.
   */
  estimatedHeightPerMessage?: number;
  /**
   * How many messages this row stands for — 1 for an ordinary row, the member
   * count for a collapsed work segment (which is what the content model counts).
   */
  messageCount?: number;
  children: ReactNode;
};

export default function LazyMessageRow({
  lazyRows,
  timestamp,
  anchorId,
  initiallyNearViewport,
  estimatedHeightPerMessage = 0,
  messageCount = 1,
  children,
}: LazyMessageRowProps) {
  const [isNearViewport, setIsNearViewport] = useState(initiallyNearViewport);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const elementRef = useRef<HTMLDivElement | null>(null);
  /** This row's placeholder height, latched once an estimate is available. */
  const placeholderHeightRef = useRef<number | null>(null);

  const handleNearViewportChange = useCallback((nextIsNearViewport: boolean) => {
    if (!nextIsNearViewport) {
      // Measured now, while the content is still in the DOM, so the placeholder
      // that replaces it occupies exactly the same space. A row that was never
      // mounted has no content in the DOM — its element is already the 100px
      // placeholder, and capturing that would record a placeholder as this row's
      // real height (which the scrollbar's pixel estimate must never take for a
      // measurement).
      const element = elementRef.current;
      if (element && element.firstElementChild) {
        const height = element.offsetHeight;
        if (height > 0) {
          setMeasuredHeight(height);
        }
      }
    }
    setIsNearViewport(nextIsNearViewport);
  }, []);

  useEffect(() => {
    const element = elementRef.current;
    if (!lazyRows || !element) return undefined;
    return lazyRows.observe(element, handleNearViewportChange);
  }, [lazyRows, handleNearViewportChange]);

  const isMounted = lazyRows === null || isNearViewport;

  // A mounted row has its real height in the DOM; an unmounted one whose height
  // was captured before it left keeps a placeholder of exactly that height. Either
  // way the row's height is knowable, which is what the scrollbar's pixel model
  // reads to tell a measured row from a never-measured one (whose placeholder is
  // not a measurement and must not estimate the conversation).
  const heightIsKnown = isMounted || measuredHeight !== null;

  // The placeholder for a row that has never been measured: the transcript's own
  // average pixels per message, times the messages this row stands for. The flat
  // constant is the fallback until an estimate exists.
  //
  // Latched at the first render that has an estimate, and never moved after. The
  // estimate is a running average, so it keeps moving as rows mount and measure —
  // and a placeholder that resized every time it moved would change the height of
  // content *above* a viewport the reader had left, which browser scroll anchoring
  // then converts into a scrollTop the reader did not ask for. A row's stand-in is
  // therefore fixed once it is known, the way its measured height is; the newest
  // rows rendered by a jump or a page read are the ones that take the fresh value.
  if (placeholderHeightRef.current === null && estimatedHeightPerMessage > 0 && messageCount > 0) {
    placeholderHeightRef.current = estimatedHeightPerMessage * messageCount;
  }
  const placeholderHeight = placeholderHeightRef.current ?? ESTIMATED_ROW_HEIGHT_PX;

  return (
    <div
      ref={elementRef}
      data-message-timestamp={timestamp || undefined}
      data-message-anchor-id={anchorId || undefined}
      data-row-measured={heightIsKnown ? 'true' : undefined}
      style={isMounted ? undefined : { height: measuredHeight ?? placeholderHeight }}
    >
      {isMounted ? children : null}
    </div>
  );
}
