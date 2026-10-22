import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import TimelineBar, { type TimelineBarRange } from '@/modules/quay/TimelineBar';

const RANGES: TimelineBarRange[] = [
  { startMs: 1000, endMs: 1500, state: 'green', label: 'first' },
  { startMs: 2000, endMs: 2600, state: 'red', label: 'second' },
  { startMs: 3000, endMs: 3100, state: 'green', label: 'third' },
];

const rectsOf = (container: HTMLElement): Element[] =>
  Array.from(container.querySelectorAll('[data-testid="bar-rect"]'));

test('TimelineBar renders one rect per range', () => {
  const { container } = render(<TimelineBar ranges={RANGES} emptyText="none" testId="bar" />);

  assert.equal(rectsOf(container).length, 3);
});

test('TimelineBar positions rects monotonically in time over a shared window', () => {
  const { container } = render(<TimelineBar ranges={RANGES} emptyText="none" testId="bar" />);

  const xs = rectsOf(container).map((rect) => Number(rect.getAttribute('x')));
  // The first range starts at the window start, so its x is the plot origin.
  assert.equal(xs[0], 0);
  assert.ok(
    xs.every((x, index) => index === 0 || x > xs[index - 1]!),
    `expected strictly increasing x, got ${xs.join(', ')}`,
  );
});

test('TimelineBar exposes each range as a native title tooltip', () => {
  const { container } = render(<TimelineBar ranges={RANGES} emptyText="none" testId="bar" />);

  const titles = Array.from(container.querySelectorAll('[data-testid="bar-rect"] title')).map((title) => title.textContent);
  assert.deepEqual(titles, ['first', 'second', 'third']);
});

test('TimelineBar gives a zero-length range a visible minimum width', () => {
  const { container } = render(
    <TimelineBar
      ranges={[
        { startMs: 1000, endMs: 1000, state: 'landed', label: 'instant' },
        { startMs: 5000, endMs: 5000, state: 'landed', label: 'instant-2' },
      ]}
      emptyText="none"
      testId="bar"
    />,
  );

  const rects = rectsOf(container);
  assert.equal(rects.length, 2);
  assert.ok(rects.every((rect) => Number(rect.getAttribute('width')) > 0));
});

test('TimelineBar renders the empty state when there are no ranges', () => {
  const { getByTestId, container } = render(<TimelineBar ranges={[]} emptyText="nothing here" testId="bar" />);

  assert.match(getByTestId('bar-empty').textContent ?? '', /nothing here/);
  assert.equal(container.querySelector('[data-testid="bar-rect"]'), null);
});
