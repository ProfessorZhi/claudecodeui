import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The sidebar splitter in a real browser: what a pointer drag does to the panel
 * and to storage, and what a touch-only device is given instead.
 *
 * This is the only place the device gate is proven against a real engine. A jsdom
 * test can only assert the policy against a double it wrote itself; whether
 * `(pointer: coarse) and (hover: none)` is what a touch device actually answers —
 * and whether a 1024px-wide touch device still docks its sidebar at the width it
 * was left at, with no splitter to change it — can only be read here.
 *
 * Nothing here stubs a media query, a pointer event or a drag: the device the
 * browser reports is the device the app reads, the mouse is a real one, and the
 * touch sequence goes through Chromium's own input pipeline.
 */

/** The docked panel, named by the splitter's own `aria-controls` and used here as the address of the sidebar. */
const PANEL = '#sidebar-panel';
/** The window-splitter handle. Its absence is the whole of the touch leg's claim. */
const SEPARATOR = '[role="separator"]';
/** The transcript pane, for the regression reading that resizing must not move what is being read. */
const PANE = '.chat-messages-pane';

/**
 * The touch-only signal the splitter must gate on, both halves required.
 *
 * `'ontouchstart' in window` is NOT the same question — it is false under this
 * emulation, so a hook sniffing for it would read a touch device as a keyboard
 * one and offer it a 6px target to aim a finger at.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The width the panel has always opened at; every absolute reading below is stated against it. */
const DEFAULT_WIDTH_PX = 288;
const MIN_WIDTH_PX = 220;
const MAX_WIDTH_PX = 480;
/**
 * The width planted in storage before a leg that must not act on it.
 *
 * Chosen below the drawer's own `max-w-sm` (384px) so a panel that wrongly applied
 * it would really be 250px wide, rather than being clamped back to the drawer's
 * width and hiding the mistake.
 */
const PLANTED_WIDTH_PX = 250;
/** The session playwright.config.ts seeds 24 turns into, for the reading-position regression. */
const TRANSCRIPT_SESSION_ID = 'e2e-transcript-follow';

/**
 * Both legs share one `DATABASE_PATH` (playwright.config.ts sets one for the whole run), so the account
 * is created at most once and every later navigation logs in instead. Same helper as
 * e2e/mobile-composer-send-key.spec.ts, for the same reason.
 */
const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

/**
 * Signs in once for the whole file.
 *
 * `test.use({ hasTouch, isMobile, viewport })` is per-describe, so each leg gets its own browser context
 * and the default `page` fixture starts unauthenticated. Re-running onboarding per leg would cost more
 * than the whole budget, so the session is captured here and replayed into each leg by `restoreSession`.
 */
const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

/** Puts the captured session into a context that the `test.use` options already built. */
const restoreSession = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/** Opens the workspace and waits for the sidebar to be laid out, so no reading lands on a panel still being sized. */
const openWorkspace = async (page: Page) => {
  await restoreSession(page);
  await page.goto('/');
  await expect(page.locator(PANEL)).toBeAttached({ timeout: 30_000 });
  await settleLayout(page);
};

/** One animation frame, which is where a style written by a pointer handler becomes a laid-out box. */
const settleLayout = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  }));

/** The media features the browser really reports, each half printed separately so a wrong premise names the half that was wrong. */
const readMediaFeatures = (page: Page) =>
  page.evaluate((touchQuery) => ({
    touchOnly: window.matchMedia(touchQuery).matches,
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    hoverNone: window.matchMedia('(hover: none)').matches,
    // The sniff the design warns about: false under touch emulation, so it cannot stand in for the query above.
    ontouchstart: 'ontouchstart' in window,
    touchPoints: navigator.maxTouchPoints,
    innerWidth: window.innerWidth,
  }), TOUCH_ONLY_QUERY);

/** The widest the sidebar may be at this window, derived rather than written down so the reading is of this window. */
const maxWidthIn = (innerWidth: number): number =>
  Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, Math.round(innerWidth * 0.5)));

/** What the panel is actually laid out at, which is the reading every claim below is stated in. */
const readPanelWidth = (page: Page): Promise<number> =>
  page.locator(PANEL).evaluate((element) => Math.round(element.getBoundingClientRect().width));

/** The panel's inline width, which only the docked layout is supposed to have at all. */
const readPanelInlineWidth = (page: Page): Promise<string> =>
  page.locator(PANEL).evaluate((element) => (element as HTMLElement).style.width);

/** What the browser has stored, read as the raw string rather than through the app's parser. */
const readStoredWidth = (page: Page): Promise<string | null> =>
  page.evaluate(() => window.localStorage.getItem('sidebarWidth'));

/** The splitter's accessible readings, so the value it announces can be compared with the box it draws. */
const readSeparatorAria = (page: Page) =>
  page.locator(SEPARATOR).evaluate((element) => ({
    valueNow: element.getAttribute('aria-valuenow'),
    valueMin: element.getAttribute('aria-valuemin'),
    valueMax: element.getAttribute('aria-valuemax'),
    orientation: element.getAttribute('aria-orientation'),
    controls: element.getAttribute('aria-controls'),
    label: element.getAttribute('aria-label'),
  }));

/** Where a drag on the splitter has to aim: the handle's own centre, which sits on the panel's right border. */
const separatorCentre = async (page: Page) => {
  const box = await page.locator(SEPARATOR).boundingBox();
  expect(box, 'the splitter must have a box to be dragged by').not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
};

/** Drags the splitter to `targetX` in real steps, sampling the panel on the way, and releases there. */
const dragSeparatorTo = async (page: Page, targetX: number, onSample?: (x: number) => Promise<void>) => {
  const from = await separatorCentre(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = 3;
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((targetX - from.x) * step) / steps);
    await page.mouse.move(x, from.y);
    await settleLayout(page);
    if (onSample) await onSample(x);
  }
  await page.mouse.up();
  await settleLayout(page);
};

/** The transcript pane's reading position, with how much of it is left below the fold. */
const readReadingPosition = async (page: Page) =>
  page.locator(PANE).evaluate((element) => ({
    scrollTop: Math.round(element.scrollTop),
    gap: Math.round(element.scrollHeight - element.scrollTop - element.clientHeight),
    panes: document.querySelectorAll('.chat-messages-pane').length,
  }));

/**
 * Waits for the pane to stop moving, then reports where it stopped.
 *
 * The pane keeps following a transcript that is still laying out, so a reading taken
 * one frame after a gesture can be a reading of the frame before the app finished with
 * it — and a resize measurement that lands there says something about timing, not
 * about the sidebar.
 */
const waitForSettledPane = async (page: Page) => {
  let previous: Awaited<ReturnType<typeof readReadingPosition>> | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readReadingPosition(page);
    if (previous && current.scrollTop === previous.scrollTop && current.gap === previous.gap) {
      stable += 1;
      if (stable >= 3) return current;
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(60);
  }
  throw new Error(`the transcript pane never stopped moving; the last reading was ${JSON.stringify(previous)}`);
};

/**
 * Scrolls to the bottom and keeps re-scrolling while the pane grows under the gesture.
 *
 * A single `scrollTop = scrollHeight` lands where the bottom was at that instant: a row
 * that mounts afterwards pushes the real bottom further down, and the pane then reads as
 * "not at the bottom" through no fault of the resize being measured.
 */
const pinPaneToBottom = async (page: Page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.locator(PANE).evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const reading = await waitForSettledPane(page);
    if (reading.gap <= 1) return reading;
  }
  return readReadingPosition(page);
};

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async ({ browser }) => {
  await bootstrapAuth(browser);
});

test.describe('the sidebar splitter on a touch-only device', () => {
  // Viewport and touch come from ONE place on purpose. `page.setViewportSize` flips the width but not
  // the pointer media features, and a CDP metrics override outlives its session while touch emulation
  // does not — splitting them across two calls is how a 1024px-wide viewport ends up measured as a phone.
  // 1024px is above the 768px drawer breakpoint on purpose: this leg's claim is about a WIDE touch
  // device, which docks its sidebar and is still given no splitter for it.
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

  test('a touch-only device is given no splitter and no touch drag can change the width', async ({ page }) => {
    await openWorkspace(page);

    // PREMISE, asserted before any behaviour: without these the whole leg passes on a desktop config.
    const features = await readMediaFeatures(page);
    console.log('TOUCH media features', JSON.stringify(features));
    expect(
      features.pointerCoarse,
      `this leg needs a coarse primary pointer; (pointer: coarse) read ${features.pointerCoarse} in ${JSON.stringify(features)}`,
    ).toBe(true);
    expect(
      features.hoverNone,
      `this leg needs a device with no hover; (hover: none) read ${features.hoverNone} in ${JSON.stringify(features)}`,
    ).toBe(true);
    expect(
      features.touchOnly,
      `both halves must hold together; ${TOUCH_ONLY_QUERY} read ${features.touchOnly} in ${JSON.stringify(features)}`,
    ).toBe(true);
    expect(
      features.innerWidth >= 768,
      `this leg is about a WIDE touch device whose sidebar is docked, not the drawer; innerWidth read ${features.innerWidth}`,
    ).toBe(true);

    // The docked panel still takes the width it was left at — "no splitter" is not "no width".
    await page.evaluate((width) => window.localStorage.setItem('sidebarWidth', String(width)), PLANTED_WIDTH_PX);
    await page.reload();
    await expect(page.locator(PANEL)).toBeAttached({ timeout: 30_000 });
    await settleLayout(page);
    const planted = await readPanelWidth(page);
    expect(
      planted,
      `a wide touch device must still dock at the stored width; the panel rendered ${planted}px for a stored ${PLANTED_WIDTH_PX}px`,
    ).toBe(PLANTED_WIDTH_PX);

    // PREMISE for the whole task: the handle is absent, said as the actual DOM reading.
    const separatorCount = await page.locator(SEPARATOR).count();
    expect(
      separatorCount,
      `a touch-only device must be given no [role="separator"]; the document has ${separatorCount} of them and ${TOUCH_ONLY_QUERY} read ${features.touchOnly}`,
    ).toBe(0);

    const storedBefore = await readStoredWidth(page);
    const widthBefore = await readPanelWidth(page);

    // A real touch sequence across the sidebar's right edge, where the splitter would have been.
    const box = await page.locator(PANEL).boundingBox();
    expect(box, 'the sidebar must have a box to drag across').not.toBeNull();
    const edgeX = Math.round(box!.x + box!.width);
    const midY = Math.round(box!.y + box!.height / 2);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: points.map((point, index) => ({ x: point.x, y: point.y, id: index })),
      });

    const touches: { type: string; x: number }[] = [];
    await touch('touchStart', [{ x: edgeX, y: midY }]);
    touches.push({ type: 'touchStart', x: edgeX });
    for (const step of [40, 90, 140]) {
      const x = edgeX - step;
      await touch('touchMove', [{ x, y: midY }]);
      await settleLayout(page);
      touches.push({ type: 'touchMove', x });
    }
    await touch('touchEnd', []);
    await settleLayout(page);

    const widthAfter = await readPanelWidth(page);
    const storedAfter = await readStoredWidth(page);
    console.log('TOUCH drag readings', JSON.stringify({ touches, widthBefore, widthAfter, storedBefore, storedAfter }));
    expect(
      { width: widthAfter, stored: storedAfter },
      `a touch drag must change nothing: the panel read ${widthBefore}px before and ${widthAfter}px after, `
        + `storage read ${JSON.stringify(storedBefore)} before and ${JSON.stringify(storedAfter)} after`,
    ).toEqual({ width: widthBefore, stored: storedBefore });

    // POSITIVE CONTROL, in the same profile: hand the page a pointer and the splitter appears, announcing
    // the very width the panel is docked at. This is what proves the two legs differ by the device alone.
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1024, height: 768, deviceScaleFactor: 1, mobile: false,
    });
    await expect
      .poll(async () => page.locator(SEPARATOR).count(), {
        message: 'unplugging the touch device must produce the splitter without a reload',
      })
      .toBe(1);
    const pointerAria = await readSeparatorAria(page);
    const pointerWidth = await readPanelWidth(page);
    console.log('POINTER after the device flip', JSON.stringify({ pointerAria, pointerWidth }));
    expect(
      pointerAria.valueNow,
      `the splitter that appeared must announce the width the panel was already docked at; it announced `
        + `${pointerAria.valueNow} while the panel rendered ${pointerWidth}px`,
    ).toBe(String(pointerWidth));
    expect(
      pointerWidth,
      `handing the page a pointer must not move the panel; it rendered ${pointerWidth}px where the touch device had it at ${widthAfter}px`,
    ).toBe(widthAfter);
  });
});

test.describe('the sidebar splitter on a pointer device', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the splitter follows the pointer, persists on release, and stops at its bounds', async ({ page }) => {
    await openWorkspace(page);

    // PREMISE: the mirror of the touch leg's — the same query must be false here, which is what makes that leg evidence.
    const features = await readMediaFeatures(page);
    console.log('POINTER media features', JSON.stringify(features));
    expect(
      features.touchOnly,
      `this leg needs a pointer device; ${TOUCH_ONLY_QUERY} read ${features.touchOnly} in ${JSON.stringify(features)}`,
    ).toBe(false);

    const ceiling = maxWidthIn(features.innerWidth);
    const opened = await readPanelWidth(page);
    expect(
      opened,
      `an install that has never been dragged must open at ${DEFAULT_WIDTH_PX}px, not ${opened}px`,
    ).toBe(DEFAULT_WIDTH_PX);
    expect(await readStoredWidth(page), 'nothing may be written before the first drag').toBeNull();

    const aria = await readSeparatorAria(page);
    expect(aria, `the splitter must be the window-splitter pattern; it reads ${JSON.stringify(aria)}`).toEqual({
      valueNow: String(opened),
      valueMin: String(MIN_WIDTH_PX),
      valueMax: String(ceiling),
      orientation: 'vertical',
      controls: 'sidebar-panel',
      label: expect.any(String) as unknown as string,
    });
    expect(aria.label, 'the splitter must carry a non-empty accessible name').toBeTruthy();

    // The drag itself, sampled on the way: the panel has to follow the pointer, not the release.
    const from = await separatorCentre(page);
    const samples: { at: number; width: number; expected: number }[] = [];
    const targetX = Math.round(from.x + 120);
    await dragSeparatorTo(page, targetX, async (x) => {
      samples.push({ at: x, width: await readPanelWidth(page), expected: Math.min(opened + (x - Math.round(from.x)), ceiling) });
    });
    const released = await readPanelWidth(page);
    const storedAfterDrag = await readStoredWidth(page);
    console.log('POINTER drag readings', JSON.stringify({ opened, from: Math.round(from.x), samples, released, storedAfterDrag, ceiling }));

    expect(samples.length, 'a drag must be sampled at least twice to say it follows the pointer').toBeGreaterThanOrEqual(2);
    for (const sample of samples) {
      expect(
        sample.width,
        `mid-drag at x=${sample.at} the panel rendered ${sample.width}px; following the pointer from ${opened}px meant ${sample.expected}px`,
      ).toBe(sample.expected);
    }
    expect(
      released,
      `the drag ended at x=${targetX} from x=${Math.round(from.x)}, so the panel must rest at ${samples.at(-1)!.expected}px; it rendered ${released}px`,
    ).toBe(samples.at(-1)!.expected);
    expect(
      storedAfterDrag,
      `releasing the pointer must store the width it was released at (${released}px); storage reads ${JSON.stringify(storedAfterDrag)}`,
    ).toBe(String(released));

    // And the stored width is what the next visit opens at.
    await page.reload();
    await expect(page.locator(PANEL)).toBeAttached({ timeout: 30_000 });
    await settleLayout(page);
    const afterReload = await readPanelWidth(page);
    expect(
      afterReload,
      `a reload must reopen at the stored width; the panel rendered ${afterReload}px for a stored ${JSON.stringify(await readStoredWidth(page))}`,
    ).toBe(released);

    // The bounds, driven past both ends rather than to them.
    await dragSeparatorTo(page, 5);
    const atFloor = await readPanelWidth(page);
    expect(
      atFloor,
      `dragging far past the left edge must stop at the ${MIN_WIDTH_PX}px floor; the panel rendered ${atFloor}px`,
    ).toBe(MIN_WIDTH_PX);

    await dragSeparatorTo(page, features.innerWidth - 5);
    const atCeiling = await readPanelWidth(page);
    expect(
      atCeiling,
      `dragging far past the right edge must stop at ${ceiling}px (min(${MAX_WIDTH_PX}, 50vw of ${features.innerWidth})); the panel rendered ${atCeiling}px`,
    ).toBe(ceiling);
    expect(
      await readStoredWidth(page),
      `the ceiling drag must store the clamped width, not the raw pointer position`,
    ).toBe(String(ceiling));

    // The reset, on the real double click.
    await page.locator(SEPARATOR).dblclick();
    await settleLayout(page);
    const afterReset = await readPanelWidth(page);
    expect(
      afterReset,
      `a double click must hand the sidebar back its shipped width of ${DEFAULT_WIDTH_PX}px; it rendered ${afterReset}px`,
    ).toBe(DEFAULT_WIDTH_PX);
    expect(
      await readStoredWidth(page),
      'the reset must reach storage too, or the next visit reopens at the dragged width',
    ).toBe(String(DEFAULT_WIDTH_PX));
  });

  test('resizing leaves the transcript exactly where it was being read', async ({ page }) => {
    // Nothing about the splitter is the subject here: the claim is that the transcript pane — a sibling that
    // shares this flex row — does not move under the reader when the sidebar's width changes.
    await openWorkspace(page);
    await page.goto(`/session/${TRANSCRIPT_SESSION_ID}`);
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await page.locator(PANE).evaluate((element) => { element.scrollTop = 600; });

    const before = await waitForSettledPane(page);
    expect(before.panes, `the seeded transcript must be the only pane on screen; found ${before.panes}`).toBe(1);
    expect(before.scrollTop, `the pane must have scrolled away from the top before the sidebar is resized`).toBeGreaterThan(0);

    // Narrow, then wide again: the two directions a drag moves through.
    const handle = await separatorCentre(page);
    await dragSeparatorTo(page, Math.round(handle.x - 140));
    const narrowed = await waitForSettledPane(page);
    await dragSeparatorTo(page, Math.round(handle.x + 140));
    const restored = await waitForSettledPane(page);
    console.log('TRANSCRIPT reading position', JSON.stringify({ before, narrowed, restored }));
    expect(
      { narrowed: narrowed.scrollTop, restored: restored.scrollTop },
      `two resizes must leave the reader where they were: the pane read scrollTop=${before.scrollTop} before, `
        + `${narrowed.scrollTop} after narrowing and ${restored.scrollTop} after widening`,
    ).toEqual({ narrowed: before.scrollTop, restored: before.scrollTop });

    // And pinned to the bottom, it is still pinned.
    const pinnedBefore = await pinPaneToBottom(page);
    expect(pinnedBefore.gap, `the pane must be scrolled to the bottom before the last resize; gap read ${pinnedBefore.gap}`).toBeLessThanOrEqual(1);
    const pinnedHandle = await separatorCentre(page);
    await dragSeparatorTo(page, Math.round(pinnedHandle.x - 140));
    const pinnedAfter = await waitForSettledPane(page);
    console.log('TRANSCRIPT pinned reading', JSON.stringify({ pinnedBefore, pinnedAfter }));
    expect(
      pinnedAfter.gap,
      `a pane pinned to the bottom must stay there: the gap below the fold read ${pinnedBefore.gap}px before and ${pinnedAfter.gap}px after`,
    ).toBeLessThanOrEqual(1);
  });
});

test.describe('the sidebar splitter on a narrow pointer device', () => {
  // Below the 768px drawer breakpoint: the sidebar is the drawer, whatever pointer the device has.
  test.use({ viewport: { width: 767, height: 900 } });

  test('the drawer is given no splitter and ignores any stored width', async ({ page }) => {
    await openWorkspace(page);

    // PREMISE: this leg is about the drawer, so the pointer gate must be the *false* half of the story.
    const features = await readMediaFeatures(page);
    console.log('NARROW media features', JSON.stringify(features));
    expect(
      features.touchOnly,
      `this leg must isolate the mobile half of the gate, so the touch query has to be false; it read ${features.touchOnly}`,
    ).toBe(false);
    expect(
      features.innerWidth < 768,
      `this leg needs the drawer layout; innerWidth read ${features.innerWidth}`,
    ).toBe(true);

    await page.evaluate((width) => window.localStorage.setItem('sidebarWidth', String(width)), PLANTED_WIDTH_PX);
    await page.reload();
    await expect(page.locator(PANEL)).toBeAttached({ timeout: 30_000 });
    await settleLayout(page);

    const separatorCount = await page.locator(SEPARATOR).count();
    expect(
      separatorCount,
      `the drawer sizes itself, so it must be given no [role="separator"]; the document has ${separatorCount} and innerWidth read ${features.innerWidth}`,
    ).toBe(0);

    const inline = await readPanelInlineWidth(page);
    expect(
      inline,
      `the drawer must pin no inline width, or it stops being 85vw max-w-sm; it reads ${JSON.stringify(inline)}`,
    ).toBe('');

    // Open the drawer and read it as the user sees it: a docked panel would have taken the stored width.
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('button', { name: 'Close sidebar' })).toBeVisible({ timeout: 15_000 });
    await settleLayout(page);
    const drawerWidth = await readPanelWidth(page);
    console.log('NARROW drawer reading', JSON.stringify({ drawerWidth, planted: PLANTED_WIDTH_PX, inline }));
    expect(
      drawerWidth,
      `the drawer must keep its own width, not the stored ${PLANTED_WIDTH_PX}px; it rendered ${drawerWidth}px`,
    ).not.toBe(PLANTED_WIDTH_PX);
  });
});
