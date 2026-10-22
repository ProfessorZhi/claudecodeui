import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { useOutlineHandleDrag } from '@/modules/chat/outline/useOutlineHandleDrag';

/**
 * The outline handle's vertical position is clamped in pixels against the header's bottom
 * edge and the composer's top edge, not against a fixed percentage of the viewport.
 *
 * jsdom has no layout, so the two marker elements the hook measures are stood in with
 * fixed `getBoundingClientRect` values: header bottom at 57px, composer top at 569px.
 */

const STORAGE_KEY = 'inputOutlineHandlePosition';
const HANDLE_SIZE = 38;
const GAP = 12;

const setViewportHeight = (height: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

const addMarker = (attribute: string, rect: { top: number; bottom: number }) => {
  const element = document.createElement('div');
  element.setAttribute(attribute, '');
  element.getBoundingClientRect = () => ({ ...rect, left: 0, right: 0, width: 0, height: 0, x: 0, y: rect.top, toJSON: () => ({}) });
  document.body.appendChild(element);
};

beforeEach(() => {
  localStorage.clear();
  setViewportHeight(700);
  addMarker('data-app-header', { top: 0, bottom: 57 });
  addMarker('data-chat-composer', { top: 569, bottom: 700 });
});

afterEach(() => {
  document.body.innerHTML = '';
});

test('desktop: a saved 10% on a short viewport is lifted below the header, and the saved value is untouched', () => {
  setViewportHeight(493);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ y: 10 }));

  const { result } = renderHook(() => useOutlineHandleDrag({ isMobile: false }));

  const centrePct = Number.parseFloat(String(result.current.handleStyle.top));
  const topPx = (centrePct / 100) * 493 - HANDLE_SIZE / 2;
  assert.ok(topPx >= 57 + GAP - 0.01, `handle top ${topPx}px must sit at least ${GAP}px under the 57px header`);
  assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), { y: 10 });
});

test('desktop: a position already clear of the header and composer is left alone', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ y: 50 }));

  const { result } = renderHook(() => useOutlineHandleDrag({ isMobile: false }));

  assert.equal(result.current.handleStyle.top, '50%');
});

test('mobile: the bottom offset is held between the composer and the header', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ y: 10 }));
  const low = renderHook(() => useOutlineHandleDrag({ isMobile: true }));
  const lowBottomPx = Number.parseFloat(String(low.result.current.handleStyle.bottom));
  assert.ok(lowBottomPx >= 700 - 569 + GAP - 0.01, `bottom offset ${lowBottomPx}px must clear the composer by ${GAP}px`);

  localStorage.setItem(STORAGE_KEY, JSON.stringify({ y: 90 }));
  const high = renderHook(() => useOutlineHandleDrag({ isMobile: true }));
  const highTopPx = 700 - Number.parseFloat(String(high.result.current.handleStyle.bottom)) - HANDLE_SIZE;
  assert.ok(highTopPx >= 57 + GAP - 0.01, `handle top ${highTopPx}px must sit at least ${GAP}px under the header`);
});

test('a resize re-derives the clamp without rewriting the saved preference', () => {
  setViewportHeight(900);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ y: 5 }));
  const { result } = renderHook(() => useOutlineHandleDrag({ isMobile: false }));
  const before = Number.parseFloat(String(result.current.handleStyle.top));

  act(() => {
    setViewportHeight(400);
    window.dispatchEvent(new Event('resize'));
  });

  const after = Number.parseFloat(String(result.current.handleStyle.top));
  assert.ok((after / 100) * 400 - HANDLE_SIZE / 2 >= 57 + GAP - 0.01, 'still under the header after the viewport shrank');
  assert.ok(after > before, 'a shorter viewport pushes the percentage up to keep the same pixel floor');
  assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), { y: 10 });
});
