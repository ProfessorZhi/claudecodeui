import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { test } from 'vitest';

import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/modules/chat/transcript/Reasoning';

/**
 * The reasoning block's trigger-to-body gap must collapse with the body.
 *
 * `CollapsibleContent` is a permanently mounted, height-animated element: closed it
 * only drives `grid-rows-[0fr]` and lets the `overflow-hidden` layer inside it
 * collapse to zero height — the element itself never unmounts. A vertical margin or
 * padding on that element therefore survives the collapse and keeps reserving its
 * space while closed, so a 20px "Thought for a few seconds" label renders as a 36px
 * row. The gap belongs *inside* the clipped layer, where it is part of the height
 * that reaches zero.
 *
 * jsdom parses no Tailwind and lays nothing out, so `getComputedStyle(...).marginTop`
 * here is the lazy value — a stylesheet-free constant that would make any assertion
 * written off it pass vacuously. What the DOM *can* answer is which element carries
 * the vertical-spacing utility, and that is the structural fact these cases read: the
 * collapsing container bears none, and the gap is borne by the clipped layer inside
 * it. The geometry that a margin really disappears (36px → 20px) is the browser
 * probe's job, not a unit test's.
 *
 * The two cases are split so that they redden independently, which is what stops
 * one one-way change from satisfying both: (a) is the collapse leg (the container
 * must not reserve the gap) and (b) is the do-not-over-correct leg (the gap must
 * still exist when open). Deleting the 16px outright passes (a) and fails (b);
 * leaving it on the collapsing container passes (b) and fails (a).
 */

/** A vertical margin/padding utility on any element: `mt-4`, `py-2`, `-mt-1`, `space-y-3`. */
const VERTICAL_SPACING = /^-?(?:m|p)(?:t|b|y)?-|^-?space-y-/;
/** The 16px step of that scale, which is the gap this task is about. */
const SPACING_16 = /^-?(?:m|p)(?:t|b|y)?-4$|^-?space-y-4$/;

const verticalSpacingClasses = (el: Element): string[] =>
  Array.from(el.classList).filter((name) => VERTICAL_SPACING.test(name));

const has16pxGap = (el: Element): boolean => verticalSpacingClasses(el).some((name) => SPACING_16.test(name));

const renderReasoning = (open: boolean) =>
  render(
    <Reasoning open={open}>
      <ReasoningTrigger />
      <ReasoningContent>the reasoning body</ReasoningContent>
    </Reasoning>,
  );

/**
 * The height-animated container `CollapsibleContent` renders: the element the open
 * flag collapses, and the one the defect hung the margin on. Selected by its `grid`
 * class rather than by `data-state`, because the outer `Collapsible` wrapper and the
 * trigger also carry a `data-state` attribute.
 */
const collapsingGrid = (view: { container: HTMLElement }): HTMLElement => {
  const grid = view.container.querySelector<HTMLElement>('div.grid');
  assert.ok(
    grid,
    `premise: ReasoningContent must render the height-animated grid container; DOM: ${view.container.innerHTML}`,
  );
  return grid;
};

/** The `overflow-hidden` clip layer `CollapsibleContent` wraps the body in. */
const clipLayer = (grid: HTMLElement): HTMLElement => {
  const clip = grid.querySelector<HTMLElement>('.overflow-hidden');
  assert.ok(clip, `premise: CollapsibleContent must wrap its body in the overflow-hidden clip layer; grid: ${grid.outerHTML}`);
  return clip;
};

test('(a) collapsed: the collapsing container bears no vertical spacing, and the gap sits inside the clip layer', () => {
  const view = renderReasoning(false);
  const grid = collapsingGrid(view);

  assert.equal(
    grid.getAttribute('data-state'),
    'closed',
    `premise: open=false must close the height-animated container; it reads "${grid.getAttribute('data-state')}"`,
  );

  // The defect itself: a vertical margin (or padding) on the collapsing container
  // survives `grid-rows-[0fr]` and keeps reserving space while closed. The element
  // is never unmounted, so nothing about the closed state removes it.
  const onGrid = verticalSpacingClasses(grid);
  assert.deepEqual(
    onGrid,
    [],
    `the collapsing container must carry no vertical margin or padding — those do not collapse with grid-rows-[0fr] and reserve their space while closed; it carries ${JSON.stringify(onGrid)} (class="${grid.className}")`,
  );

  // ...and the gap must be *inside* the clipped layer, not on the container or on
  // any ancestor of it: spacing above the clip is spacing the collapse cannot reach.
  const clip = clipLayer(grid);
  const region = [grid, ...Array.from(grid.querySelectorAll<HTMLElement>('*'))];
  const outsideClip = region
    .filter((el) => !clip.contains(el))
    .filter((el) => verticalSpacingClasses(el).length > 0);
  assert.deepEqual(
    outsideClip.map((el) => `<${el.tagName.toLowerCase()} class="${el.className}">`),
    [],
    `the 16px gap must live inside the overflow-hidden clip layer, not on the collapsing container or anything above it; it is borne by ${JSON.stringify(outsideClip.map((el) => el.className))}`,
  );
});

test('(b) open: the 16px trigger-to-body gap is preserved', () => {
  const view = renderReasoning(true);
  const grid = collapsingGrid(view);

  assert.equal(
    grid.getAttribute('data-state'),
    'open',
    `premise: open=true must expand the height-animated container; it reads "${grid.getAttribute('data-state')}"`,
  );
  assert.ok(
    grid.classList.contains('grid-rows-[1fr]'),
    `premise: an open container must be on the expanded grid row; it reads "${grid.className}"`,
  );

  const trigger = view.container.querySelector<HTMLElement>('button[data-state]');
  assert.ok(trigger, `premise: ReasoningTrigger must render; DOM: ${view.container.innerHTML}`);
  assert.ok(
    trigger.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING,
    'premise: the collapsed content must follow the trigger in the document, or their gap is not the one under test',
  );

  /*
   * Deliberately asks only that the gap *exists* somewhere in the collapsing
   * container's subtree — not where in it the gap sits. Where it sits is case
   * (a)'s question. If this case also pinned the location it would go red with
   * (a) on any implementation that leaves the 16px on the collapsing container,
   * and the pair would stop reddening independently: the defect "(a) is red ⇒
   * the expanded state is intact" is exactly what the independence is for.
   */
  const region = [grid, ...Array.from(grid.querySelectorAll<HTMLElement>('*'))];
  const gapBearers = region.filter(has16pxGap);
  assert.ok(
    gapBearers.length > 0,
    `the expanded trigger-to-body gap must survive the fix: an open Reasoning must still bear a 16px vertical step in its collapsing container; the container carries ${JSON.stringify(region.map((el) => el.className))}`,
  );
});
