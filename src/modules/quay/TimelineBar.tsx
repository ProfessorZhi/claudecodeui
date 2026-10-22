import { cn } from '@/shared/utils';

/** One interval drawn on a `TimelineBar`, in Unix epoch milliseconds. */export type TimelineBarRange = {
  /** Interval start, Unix epoch milliseconds. */
  startMs: number;
  /** Interval end, Unix epoch milliseconds. */
  endMs: number;
  /** Status key selecting the bar's colour (`green`/`red`/`landed`/…). */
  state: string;
  /** Human-readable tooltip text shown by the native `<title>`. */
  label: string;
};

type TimelineBarProps = {
  /** Intervals to draw, in any order; the window spans their full extent. */
  ranges: TimelineBarRange[];
  /** Text shown in place of the SVG when there are no ranges. */
  emptyText: string;
  /** Prefix for the component's test ids: the container, each `<rect>`, and the empty state. */
  testId: string;
};

// The bar is drawn in a fixed 100x20 coordinate space and stretched to the host
// width with `preserveAspectRatio="none"`, so the layout never depends on the
// rendered pixel size (SVG has no measurable width inside jsdom).
const PLOT_WIDTH = 100;
const PLOT_HEIGHT = 20;
const PLOT_TOP = 4;
const BAR_HEIGHT = 12;
/** A zero-length interval would be invisible, so every rect keeps at least this width. */
const MIN_BAR_WIDTH = 0.6;

/** Colour per status key; both test rounds (`green`/`red`) and fan-in outcomes (`landed`/`failed`) map onto the same palette. */
const STATE_TEXT_CLASSES: Record<string, string> = {
  green: 'text-green-500',
  landed: 'text-green-500',
  red: 'text-red-500',
  failed: 'text-red-500',
  'exited-not-landed': 'text-amber-500',
};
const DEFAULT_STATE_CLASS = 'text-gray-400';

/**
 * Used by the Quay panel's Tests and Fan-in cards to draw a single-lane timeline
 * of recent records. It maps each interval's `[startMs, endMs]` onto a shared
 * percentage window (`X(t) = (t - windowStart) / windowSpan * plotWidth`, the
 * same coordinate maths quay's own `renderTimelineBarSvg` uses), so overlapping
 * or adjacent records keep their relative positions. `title` children give each
 * rect a native tooltip; the component is display-only and owns no state.
 */
export default function TimelineBar({ ranges, emptyText, testId }: TimelineBarProps) {
  if (ranges.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
        {emptyText}
      </p>
    );
  }

  const windowStart = Math.min(...ranges.map((range) => range.startMs));
  const windowEnd = Math.max(...ranges.map((range) => range.endMs));
  // Guard a single-instant window (all intervals zero-length) so the divisor is never 0.
  const windowSpan = Math.max(1, windowEnd - windowStart);
  const toX = (timeMs: number): number => ((timeMs - windowStart) / windowSpan) * PLOT_WIDTH;

  return (
    <svg
      viewBox={`0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="timeline"
      className="h-6 w-full"
      data-testid={testId}
    >
      {ranges.map((range, index) => {
        const left = toX(range.startMs);
        return (
          <rect
            key={`${range.label}-${index}`}
            x={left}
            y={PLOT_TOP}
            width={Math.max(MIN_BAR_WIDTH, toX(Math.max(range.endMs, range.startMs + 1)) - left)}
            height={BAR_HEIGHT}
            fill="currentColor"
            className={cn(STATE_TEXT_CLASSES[range.state] ?? DEFAULT_STATE_CLASS)}
            data-testid={`${testId}-rect`}
          >
            <title>{range.label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
