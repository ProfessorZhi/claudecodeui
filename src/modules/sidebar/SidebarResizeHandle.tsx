import type { TFunction } from 'i18next';

import type { SidebarResizeHandleHandlers } from '@/shared/types';

type SidebarResizeHandleProps = {
  /** Width the sidebar is rendered at, which is also the separator's value. */
  width: number;
  /** Bounds the splitter may commit, reported so assistive technology announces them. */
  minWidth: number;
  maxWidth: number;
  /** True while a drag is in flight, which is when the handle shows its active state. */
  isResizing: boolean;
  /** The drag, keyboard and reset handlers from useSidebarResize. */
  handlers: SidebarResizeHandleHandlers;
  /** Element id of the panel this splitter sizes, so `aria-controls` names it. */
  panelId: string;
  t: TFunction;
};

/**
 * Used by SidebarContent as the desktop splitter that widens and narrows the
 * sidebar; the mobile drawer renders SidebarContent without it.
 *
 * A separator with a tab stop is the window-splitter pattern: it is focusable,
 * it reports its value, and the arrow keys move it, so the width is reachable
 * without a pointer. The hit area straddles the panel's right border, where the
 * cursor is already aiming, and is transparent until hovered.
 */
export default function SidebarResizeHandle({
  width,
  minWidth,
  maxWidth,
  isResizing,
  handlers,
  panelId,
  t,
}: SidebarResizeHandleProps) {
  const label = t('resizeHandle.label');

  return (
    <div
      {...handlers}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={panelId}
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title={label}
      // `touch-none` keeps the drag off the scroll gesture; the colour is the
      // only affordance, so it appears on hover, on focus and while dragging.
      className={`absolute inset-y-0 -right-0.5 z-10 w-1.5 cursor-col-resize touch-none transition-colors ${
        isResizing ? 'bg-primary/60' : 'bg-transparent hover:bg-primary/40 focus-visible:bg-primary/40'
      }`}
    />
  );
}
