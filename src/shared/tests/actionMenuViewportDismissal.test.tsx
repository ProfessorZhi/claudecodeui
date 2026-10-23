import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { ActionMenu } from '@/shared/ui';

/**
 * The row menu is a portal opened over a scrollable list, and its viewport-change
 * listener used to be installed the instant it opened. That made a clipped row's
 * first ⋯ click open and immediately close the menu: mousedown focuses the
 * trigger, the browser scrolls the nearest scrollable ancestor to reveal the
 * focused element, and that scroll event — dispatched in the same frame's
 * rendering steps, before animation-frame callbacks — hit the brand-new listener.
 * A real user saw the menu flash and nothing else, so its items could never be
 * clicked.
 *
 * These cases pin both halves of the contract: the scroll the opening interaction
 * itself causes must not dismiss the menu, while a scroll from a later, genuinely
 * user-driven interaction still must.
 */

const ITEMS = [
  { key: 'rename', label: 'Rename session', onSelect: () => {} },
  { key: 'hide-similar', label: 'Hide similar', onSelect: () => {} },
];

/** A scrollable list holding the menu's trigger, the way the sidebar's ScrollArea does. */
function Harness() {
  return (
    <div data-testid="scroller" style={{ overflow: 'auto', height: 120 }}>
      <ActionMenu
        label="Session options"
        ariaLabel="Session options for clipped-row"
        iconOnly
        portal
        items={ITEMS}
      />
    </div>
  );
}

const scroller = () => screen.getByTestId('scroller');
const trigger = () => screen.getByLabelText('Session options for clipped-row');
const menu = () => screen.queryByRole('menu');

/** Runs the deferred arming: the listeners are installed inside the next frame's callback. */
const nextFrame = () => act(async () => {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
});

test('the scroll an opening click causes does not dismiss the menu it opened', () => {
  render(<Harness />);

  fireEvent.click(trigger());
  assert.ok(menu(), 'the click opens the menu');

  // The clipped trigger's focus scroll, dispatched before the arming frame runs.
  fireEvent.scroll(scroller());
  assert.ok(menu(), 'the scroll the opening click induced must not close the menu');

  // The menu is not merely present but usable: its items can be reached and clicked.
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide similar' }));
  assert.equal(menu(), null, 'selecting an item closes the menu');
});

test('a scroll from a later interaction still dismisses the menu', async () => {
  render(<Harness />);

  fireEvent.click(trigger());
  fireEvent.scroll(scroller());
  assert.ok(menu(), 'the opening scroll is swallowed');

  await nextFrame();
  fireEvent.scroll(scroller());

  assert.equal(menu(), null, 'an independent scroll dismisses the menu');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
});

/**
 * The other half of the arming frame's timing assumption.
 *
 * The two cases above both dispatch the opening scroll *before* running the arming frame, which
 * is the order the browser uses only while rendering keeps up: the scroll steps of a frame run
 * before that frame's animation-frame callbacks, so a scroll caused in the click's own frame
 * always beats the frame that arms the listener. Slower rendering breaks that: the same scroll
 * can be dispatched in a later frame, after the listener is armed, and the menu closes on the
 * click that opened it again.
 *
 * This case opens the menu and runs the arming frame without any scroll first, so the armed
 * listener cannot know whether the first scroll it sees is a user's or that slowed-down opening
 * scroll. It must therefore let it through — and only it: the second scroll is a viewport change
 * that no click of ours caused, so it must dismiss the menu.
 */
test('a scroll that arrives only after the arming frame is tolerated once, then dismisses', async () => {
  render(<Harness />);

  fireEvent.click(trigger());
  assert.ok(menu(), 'the click opens the menu');

  await nextFrame();
  fireEvent.scroll(scroller());
  assert.ok(menu(), 'a scroll the arming frame never saw before it armed must not close the menu');

  fireEvent.scroll(scroller());
  assert.equal(menu(), null, 'a further scroll dismisses the menu');
});
