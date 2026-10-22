import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { useRef } from 'react';
import { act, render } from '@testing-library/react';

import { useLazyRowObserver } from '@/modules/chat/hooks/useLazyRowObserver';
import LazyMessageRow from '@/modules/chat/transcript/LazyMessageRow';

/**
 * Drivable IntersectionObserver stand-in: jsdom has none, so these tests
 * install one and fire its callback by hand to walk a row through the
 * near-viewport / far-away transitions.
 */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  observed: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    StubIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.observed.push(element);
  }

  unobserve(element: Element): void {
    this.observed = this.observed.filter((observed) => observed !== element);
  }

  disconnect(): void {
    this.observed = [];
  }
}

function fireIntersection(
  observer: StubIntersectionObserver,
  target: Element,
  isIntersecting: boolean,
  rect: { width: number; height: number } = { width: 100, height: 40 },
): void {
  act(() => {
    observer.callback(
      [{ target, isIntersecting, boundingClientRect: rect } as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  });
}

function Harness({
  initiallyNearViewport,
  estimatedHeightPerMessage,
  messageCount,
}: {
  initiallyNearViewport: boolean;
  estimatedHeightPerMessage?: number;
  messageCount?: number;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lazyRows = useLazyRowObserver(scrollContainerRef);
  return (
    <div ref={scrollContainerRef}>
      <LazyMessageRow
        lazyRows={lazyRows}
        timestamp="2026-01-01T00:00:00.000Z"
        initiallyNearViewport={initiallyNearViewport}
        estimatedHeightPerMessage={estimatedHeightPerMessage}
        messageCount={messageCount}
      >
        <span data-testid="row-content">expensive content</span>
      </LazyMessageRow>
    </div>
  );
}

afterEach(() => {
  StubIntersectionObserver.instances = [];
  vi.unstubAllGlobals();
});

describe('LazyMessageRow', () => {
  it('starts far rows as an addressable placeholder instead of mounting content', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container, queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).toBeNull();
    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]');
    expect(wrapper).not.toBeNull();
    // With no estimate in hand the placeholder falls back to the flat constant.
    expect((wrapper as HTMLElement).style.height).toBe('100px');
  });

  it('sizes a never-measured placeholder by the transcript estimate instead of the flat constant', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container } = render(
      <Harness initiallyNearViewport={false} estimatedHeightPerMessage={250} messageCount={1} />,
    );

    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]') as HTMLElement;
    // One 250px message stands in at 250px, not the flat 100px that made a tall
    // conversation's first centring land 150px short of the row's real height.
    expect(wrapper.style.height).toBe('250px');
  });

  it('scales the estimate by the messages a collapsed row stands for', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container } = render(
      <Harness initiallyNearViewport={false} estimatedHeightPerMessage={120} messageCount={4} />,
    );

    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]') as HTMLElement;
    expect(wrapper.style.height).toBe('480px');
  });

  it('prefers a measured height over the estimate once the row has been measured', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId, container } = render(
      <Harness initiallyNearViewport estimatedHeightPerMessage={250} />,
    );
    expect(queryByTestId('row-content')).not.toBeNull();

    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { value: 412, configurable: true });

    fireIntersection(observer, wrapper, false);

    expect(queryByTestId('row-content')).toBeNull();
    expect((container.querySelector('[data-message-timestamp]') as HTMLElement).style.height).toBe('412px');
  });

  it('falls back to the flat constant when the estimate is not usable', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { container } = render(
      <Harness initiallyNearViewport={false} estimatedHeightPerMessage={0} messageCount={3} />,
    );

    const wrapper = container.querySelector('[data-message-timestamp="2026-01-01T00:00:00.000Z"]') as HTMLElement;
    expect(wrapper.style.height).toBe('100px');
  });

  it('unmounts to a placeholder of the measured height and remounts when near again', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    expect(queryByTestId('row-content')).not.toBeNull();

    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;
    Object.defineProperty(wrapper, 'offsetHeight', { value: 123, configurable: true });

    fireIntersection(observer, wrapper, false);
    expect(queryByTestId('row-content')).toBeNull();
    expect(wrapper.style.height).toBe('123px');

    fireIntersection(observer, wrapper, true);
    expect(queryByTestId('row-content')).not.toBeNull();
    expect(wrapper.style.height).toBe('');
  });

  it('ignores the zero-rect non-intersections a hidden tab reports', () => {
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);

    const { queryByTestId } = render(<Harness initiallyNearViewport />);
    const observer = StubIntersectionObserver.instances[0];
    const wrapper = observer.observed[0] as HTMLElement;

    fireIntersection(observer, wrapper, false, { width: 0, height: 0 });

    expect(queryByTestId('row-content')).not.toBeNull();
  });

  it('keeps every row mounted where IntersectionObserver does not exist', () => {
    const { queryByTestId } = render(<Harness initiallyNearViewport={false} />);

    expect(queryByTestId('row-content')).not.toBeNull();
    expect(StubIntersectionObserver.instances).toHaveLength(0);
  });
});
