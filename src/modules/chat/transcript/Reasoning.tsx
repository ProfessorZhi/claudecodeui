import * as React from 'react';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';

import { cn } from '@/shared/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Shimmer } from '@/shared/ui';

/* ─── Context ────────────────────────────────────────────────────── */

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = React.createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = React.useContext(ReasoningContext);
  if (!context) {
    throw new Error('Reasoning components must be used within Reasoning');
  }
  return context;
};

/* ─── Reasoning (root) ───────────────────────────────────────────── */

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export type ReasoningProps = {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
} & React.HTMLAttributes<HTMLDivElement>;

/** Discloses an assistant turn's reasoning text; used by MessageComponent. */
export const Reasoning = React.memo<ReasoningProps>(
  ({
    className,
    isStreaming = false,
    open: controlledOpen,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    const isExplicitlyClosed = defaultOpen === false;

    // Controllable open state
    const [internalOpen, setInternalOpen] = React.useState(resolvedDefaultOpen);
    const isControlled = controlledOpen !== undefined;
    const isOpen = isControlled ? controlledOpen : internalOpen;
    const setIsOpen = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setInternalOpen(next);
        onOpenChange?.(next);
      },
      [isControlled, onOpenChange]
    );

    // Duration tracking
    const [duration, setDuration] = React.useState<number | undefined>(durationProp);
    const hasEverStreamedRef = React.useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = React.useState(false);
    const startTimeRef = React.useRef<number | null>(null);

    // Sync external duration prop
    React.useEffect(() => {
      if (durationProp !== undefined) setDuration(durationProp);
    }, [durationProp]);

    // Track streaming start/end for duration
    React.useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming]);

    // Auto-open when streaming starts
    React.useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true);
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

    // Auto-close after streaming ends
    React.useEffect(() => {
      if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);
        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

    const contextValue = React.useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen }),
      [duration, isOpen, isStreaming, setIsOpen]
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          open={isOpen}
          onOpenChange={setIsOpen}
          className={cn('not-prose', className)}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  }
);
Reasoning.displayName = 'Reasoning';

/* ─── ReasoningTrigger ───────────────────────────────────────────── */

export type ReasoningTriggerProps = {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number): React.ReactNode => {
  if (isStreaming || duration === 0) {
    return <Shimmer>Thinking...</Shimmer>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

/** Toggle of Reasoning, used by MessageComponent. */
export const ReasoningTrigger = React.memo<ReasoningTriggerProps>(
  ({
    className,
    children,
    getThinkingMessage = defaultGetThinkingMessage,
    ...props
  }) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
          className
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="h-4 w-4" />
            {getThinkingMessage(isStreaming, duration)}
            <ChevronDownIcon
              className={cn(
                'h-4 w-4 transition-transform',
                isOpen ? 'rotate-180' : 'rotate-0'
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  }
);
ReasoningTrigger.displayName = 'ReasoningTrigger';

/* ─── ReasoningContent ───────────────────────────────────────────── */

export type ReasoningContentProps = {
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>;

/** Body of Reasoning, used by MessageComponent. */
export const ReasoningContent = React.memo<ReasoningContentProps>(
  ({ className, children, ...props }) => (
    <CollapsibleContent className={cn('text-sm text-muted-foreground', className)} {...props}>
      {/*
       * The 16px gap between the trigger and the body lives *inside* the collapse
       * box, on the layer `CollapsibleContent` clips with `overflow-hidden`.
       *
       * `CollapsibleContent` is a permanently mounted, height-animated element: when
       * closed it only drives `grid-rows-[0fr]` and lets the clipped inner layer
       * collapse to zero height — the element itself never unmounts. A `margin` (or
       * `padding`) on that element therefore does not collapse with the height and
       * keeps reserving its 16px while closed, turning a 20px label into a 36px row.
       * Padding on the clipped layer is inside the zero-height box, so it collapses
       * with it, and when open it reproduces the exact same 16px gap.
       */}
      <div className="pt-4">{children}</div>
    </CollapsibleContent>
  )
);
ReasoningContent.displayName = 'ReasoningContent';
