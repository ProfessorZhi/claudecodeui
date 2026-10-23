import * as React from 'react';

import { cn } from '@/shared/utils';

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  /**
   * Classes for the element that actually scrolls, which is the inner box and not the one
   * `className` lands on.
   *
   * A caller needs this for the one thing that cannot be said about a child: `scroll-padding`, which
   * tells every scroll-into-view inside this scrollport to keep a strip clear at the top. The sidebar
   * uses it for the project header it pins there — `scroll-margin` on the rows cannot do that job,
   * because it would have to be repeated on every focusable element inside them, and the one the
   * browser scrolls to is whatever focus landed on (the row's own options button, say).
   */
  viewportClassName?: string;
};

/** Used by the file-tree and sidebar modules for consistently styled scroll containers. */
export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, viewportClassName, children, ...props }, ref) => (
    <div className={cn(className, 'relative overflow-hidden')} {...props}>
      {/* Inner container keeps border radius while allowing momentum scrolling on touch devices. */}
      <div
        ref={ref}
        className={cn('h-full w-full overflow-auto rounded-[inherit]', viewportClassName)}
        style={{
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  )
);

ScrollArea.displayName = 'ScrollArea';

