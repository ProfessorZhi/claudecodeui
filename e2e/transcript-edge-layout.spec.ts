import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// AC-220: the transcript pane's right gutter is sized to what is actually drawn
// at its edge, and the drawn scrollbar is grabbable on a touch screen.
//
// The draggable quick-settings handle and the floating export button that this
// criterion once also named were retired with the workspace-header overflow menu
// (`gap-workspace-header-overflow-menu-replaces-edge-controls`): the transcript's
// right edge now holds only the scrollbar and the tick column, and the handle
// readings (default position, clamping, storage write-back) have no subject.
// What remains — the gutter and the touch target — is read here.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir), on the shared `e2e-transcript-jump`
// seed. Readings come from elements this app draws (getBoundingClientRect /
// getComputedStyle); the native scrollbar is hidden by `scrollbar-width: none`
// (and Playwright's --hide-scrollbars), so its layout is not evidence of
// anything. Every leg but (g) uses a mouse; (g) uses a coarse-pointer touch
// context.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The long, 1200-turn fixture the rail readings share. */
const SESSION_ID = 'e2e-transcript-jump';

/** The three viewports the criterion names. */
const MOBILE = { name: 'mobile 390x844', size: { width: 390, height: 844 } } as const;
const TABLET = { name: 'tablet 820x1100', size: { width: 820, height: 1100 } } as const;
const WIDE = { name: 'wide 1440x900', size: { width: 1440, height: 900 } } as const;

// ── The geometry the criterion fixes, restated on the reading side ───────────
/** The scrollbar column: its 12px track inset 4px from the edge. */
const SCROLLBAR_COLUMN_PX = 16;
/** The fixed tick band on tablet. */
const TICK_BAND_GUTTER_PX = 72;
/** The tick column's own width and pitch. */
const TICK_COLUMN_W = 16;
const TICK_PITCH = 30;
/** The transcript content column's max width (`max-w-[54.25rem]`) and its px-4. */
const CONTENT_MAX_PX = 868;
const CONTENT_PAD_PX = 16;
/** The touch target's floor on a coarse pointer, and the drawn thumb's width. */
const GRAB_MIN_WIDTH = 32;
const GRAB_MIN_HEIGHT = 44;
const THUMB_WIDTH = 8;

/** Signs in, creating the account on the first run of the fixture database. */
const ensureSignedIn = async (page: Page) => {
  const shellReady = () =>
    page
      .locator('button:has-text("Create Account"), button:has-text("Settings"), #username')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true, () => false);

  await page.goto('/');
  let ready = await shellReady();
  for (let attempt = 0; !ready && attempt < 3; attempt += 1) {
    await page.reload().catch(() => undefined);
    ready = await shellReady();
  }
  if (!ready) throw new Error('the app shell never rendered; the page had no Create Account / Settings / #username');

  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  if (await createAccount.count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

/** Fetches the client's entry and its pre-bundled dependency before the page does, so the first navigation does not race Vite's optimizer. */
const OPTIMIZED_DEP_IN_TEXT = /from\s+"(\/node_modules\/\.vite\/deps\/[^"]+)"/;
const warmClientStartup = async (clientUrl: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
  const shell = await fetchWithin(new URL('/', clientUrl).href);
  await shell.text();
  const entry = await fetchWithin(new URL('/src/main.tsx', clientUrl).href);
  const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await entry.text())?.[1];
  if (specifier) {
    const dep = await fetchWithin(new URL(specifier, clientUrl).href);
    await dep.text().catch(() => undefined);
  }
};

/** Lets the app's service worker finish claiming the first document. */
const settleServiceWorker = (page: Page) =>
  page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    .catch(() => undefined);

/** A box in viewport coordinates. */
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** Everything one AC-220 reading compares. */
type EdgeReading = {
  pane: Box;
  panePaddingRight: number;
  content: Box;
  /** The content column's content box right edge — the furthest right any text reaches. */
  textRight: number;
  track: Box | null;
  thumb: Box | null;
  thumbWidth: number | null;
  /** The coarse pointer's hit layer, or null when none is drawn. */
  thumbHit: Box | null;
  /** The tick column, or null when it is not laid out. */
  column: Box | null;
  /** Every drawn tick mark's box, top to bottom. */
  markBoxes: Box[];
  /** The retired edge controls, which must not be drawn at all. */
  handleCount: number;
  exportAnchorCount: number;
  pointerCoarse: boolean;
};

const readEdge = (page: Page): Promise<EdgeReading> =>
  page.evaluate(() => {
    const boxOf = (el: Element | null): Box | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const content = pane?.querySelector('[data-transcript-content]') as HTMLElement | null;
    const contentPadRight = content ? Number.parseFloat(getComputedStyle(content).paddingRight) || 0 : 0;
    const thumb = document.querySelector('[data-scrollbar-thumb]');
    const columnBox = boxOf(document.querySelector('[data-turn-ticks]'));
    return {
      pane: boxOf(pane)!,
      panePaddingRight: pane ? Number.parseFloat(getComputedStyle(pane).paddingRight) || 0 : Number.NaN,
      content: boxOf(content)!,
      textRight: content ? content.getBoundingClientRect().right - contentPadRight : Number.NaN,
      track: boxOf(document.querySelector('[data-scrollbar-track]')),
      thumb: boxOf(thumb),
      thumbWidth: thumb ? Number.parseFloat(getComputedStyle(thumb).width) : null,
      thumbHit: boxOf(document.querySelector('[data-scrollbar-thumb-hit]')),
      column: columnBox && columnBox.height > 0 ? columnBox : null,
      markBoxes: Array.from(document.querySelectorAll('[data-turn-tick-mark]')).map((mark) => boxOf(mark)!),
      handleCount: document.querySelectorAll('[data-quick-settings-handle]').length,
      exportAnchorCount: document.querySelectorAll('[data-transcript-export-anchor]').length,
      pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    };
  });

/** The same reading with the numbers rounded, for failure messages. */
const shown = (reading: EdgeReading): string =>
  JSON.stringify(reading, (_key, value) => (typeof value === 'number' ? Math.round(value) : value));

/** Waits for a freshly loaded transcript to be drawn and measured. */
const settleTranscript = async (page: Page) => {
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(900);
};

/** The pane's own scroll offset, read on its own for a before/after comparison. */
const readScrollTop = (page: Page): Promise<number> =>
  page.evaluate(() => (document.querySelector('.chat-messages-pane') as HTMLElement).scrollTop);

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('AC-220 the transcript right-edge gutter and touch target', () => {
  let browser: Browser;
  let origin: string;
  let authToken: string;

  test.beforeAll(async ({ browser: testBrowser }) => {
    test.setTimeout(300_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);
    browser = testBrowser;

    const seed = await browser.newPage({ baseURL: clientUrl });
    await ensureSignedIn(seed);
    origin = new URL(seed.url()).origin;
    authToken = await seed.evaluate(() => window.localStorage.getItem('auth-token') ?? '');
    await seed.close();
    if (!authToken) throw new Error('no auth token to seed the viewport contexts with');
  });

  /** A fresh, already-signed-in page at one viewport; `touch` makes the primary pointer coarse. */
  const openAt = async (
    viewport: { readonly name: string; readonly size: { width: number; height: number } },
    touch = false,
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({
      viewport: viewport.size,
      hasTouch: touch,
      isMobile: touch,
    });
    await context.addInitScript((token) => {
      window.localStorage.setItem('auth-token', token);
    }, authToken);
    const page = await context.newPage();
    await page.goto(`${origin}/session/${SESSION_ID}`);
    await settleServiceWorker(page);
    await settleTranscript(page);
    return { context, page };
  };

  test('AC-220 (a) the phone keeps only the scrollbar column, and the text uses the rest', async () => {
    const { context, page } = await openAt(MOBILE);
    try {
      const reading = await readEdge(page);
      const where = `${MOBILE.name}: ${shown(reading)}`;

      // The gutter is the scrollbar's own column (16px, within 4px of it).
      expect(reading.panePaddingRight, `the phone gutter must be the scrollbar column at ${where}`)
        .toBeGreaterThanOrEqual(SCROLLBAR_COLUMN_PX);
      expect(reading.panePaddingRight, `the phone gutter must not be a fixed band at ${where}`)
        .toBeLessThanOrEqual(SCROLLBAR_COLUMN_PX + 4);

      // The text stops at the scrollbar's column and leaves no more blank than its
      // own column: the content column's right edge sits on the track's left edge.
      expect(reading.track, `the scrollbar must be drawn at ${where}`).not.toBeNull();
      expect(reading.textRight, `the text must not reach under the scrollbar at ${where}`)
        .toBeLessThanOrEqual(reading.track!.left + 1);
      expect(
        Math.abs(reading.content.right - reading.track!.left),
        `the text column must sit flush against the scrollbar column (content.right ${Math.round(reading.content.right)} vs track.left ${Math.round(reading.track!.left)}) at ${where}`,
      ).toBeLessThanOrEqual(8);

      // The message column gets the width back: at least 85% of the viewport.
      const textWidth = reading.content.width - 2 * CONTENT_PAD_PX;
      expect(textWidth, `the phone message column must be at least 85% of the viewport at ${where}`)
        .toBeGreaterThanOrEqual(0.85 * MOBILE.size.width);

      // No tick column below the breakpoint.
      expect(reading.column, `the tick column must not be drawn on the phone at ${where}`).toBeNull();
      expect(reading.markBoxes.every((box) => box.width === 0), `no tick may be laid out at ${where}`)
        .toBe(true);

      // The retired edge controls are gone.
      expect(reading.handleCount, `no quick-settings handle may remain at ${where}`).toBe(0);
      expect(reading.exportAnchorCount, `no floating export anchor may remain at ${where}`).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('AC-220 (b) the tablet keeps the full band and does not narrow the tick column', async () => {
    const { context, page } = await openAt(TABLET);
    try {
      const reading = await readEdge(page);
      const where = `${TABLET.name}: ${shown(reading)}`;

      expect(reading.column, `the tablet must draw the tick column at ${where}`).not.toBeNull();
      expect(Math.abs(reading.column!.width - TICK_COLUMN_W), `the tick column must stay ${TICK_COLUMN_W}px wide at ${where}`)
        .toBeLessThanOrEqual(1);
      expect(reading.panePaddingRight, `the tablet gutter must stay the full band at ${where}`)
        .toBeGreaterThanOrEqual(TICK_BAND_GUTTER_PX - 1);
      expect(reading.panePaddingRight, `the tablet gutter must not exceed the band at ${where}`)
        .toBeLessThanOrEqual(TICK_BAND_GUTTER_PX + 1);

      const centers = reading.markBoxes.map((box) => box.top + box.height / 2);
      for (let index = 1; index < centers.length; index += 1) {
        expect(
          Math.abs(centers[index] - centers[index - 1] - TICK_PITCH),
          `adjacent ticks must stay ${TICK_PITCH}px apart at ${where}`,
        ).toBeLessThanOrEqual(2);
      }

      expect(reading.handleCount, `no quick-settings handle may remain at ${where}`).toBe(0);
      expect(reading.exportAnchorCount, `no floating export anchor may remain at ${where}`).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('AC-220 (c) the wide viewport puts the chrome in the outer margin and keeps the text column whole', async () => {
    const { context, page } = await openAt(WIDE);
    try {
      const reading = await readEdge(page);
      const where = `${WIDE.name}: ${shown(reading)}`;

      expect(reading.panePaddingRight, `the wide gutter must shrink to nothing at ${where}`)
        .toBeLessThanOrEqual(8);
      expect(reading.column, `the wide viewport must draw the tick column at ${where}`).not.toBeNull();
      expect(reading.track, `the wide viewport must draw the scrollbar at ${where}`).not.toBeNull();

      // The chrome sits outside the content column: the tick column clears the
      // text column by 16px and the scrollbar is further right still.
      expect(
        reading.column!.left,
        `the tick column must clear the content column by 16px at ${where}`,
      ).toBeGreaterThanOrEqual(reading.content.right + 16);
      expect(reading.track!.left, `the scrollbar must sit outside the content column at ${where}`)
        .toBeGreaterThanOrEqual(reading.content.right);

      // The content column reaches its own max width, so the text is as wide as it
      // would be with no chrome at all.
      const expectedContentWidth = Math.min(CONTENT_MAX_PX, reading.pane.width - reading.panePaddingRight);
      expect(
        Math.abs(reading.content.width - expectedContentWidth),
        `the content column must reach its full width at ${where}`,
      ).toBeLessThanOrEqual(1);
      const textWidth = reading.content.width - 2 * CONTENT_PAD_PX;
      expect(Math.abs(textWidth - (expectedContentWidth - 2 * CONTENT_PAD_PX)), `the text width at ${where}`)
        .toBeLessThanOrEqual(1);

      expect(reading.handleCount, `no quick-settings handle may remain at ${where}`).toBe(0);
      expect(reading.exportAnchorCount, `no floating export anchor may remain at ${where}`).toBe(0);
    } finally {
      await context.close();
    }
  });

  test('AC-220 (g) a finger gets a wide, tall grab area that extends in from the screen edge', async () => {
    const { context, page } = await openAt(MOBILE, true);
    try {
      const reading = await readEdge(page);
      const where = `touch ${MOBILE.name}: ${shown(reading)}`;

      expect(reading.pointerCoarse, `this leg needs a coarse primary pointer at ${where}`).toBe(true);
      expect(reading.thumbHit, `a finger needs a hit layer at ${where}`).not.toBeNull();
      expect(reading.thumbHit!.width, `the grab area must be at least ${GRAB_MIN_WIDTH}px wide at ${where}`)
        .toBeGreaterThanOrEqual(GRAB_MIN_WIDTH);
      expect(reading.thumbHit!.height, `the grab area must be at least ${GRAB_MIN_HEIGHT}px tall at ${where}`)
        .toBeGreaterThanOrEqual(GRAB_MIN_HEIGHT);

      // It extends in from the screen edge toward the content, so the system's
      // edge gesture zone is not the only place to grab it.
      expect(reading.thumbHit!.right, `the grab area must stay on screen at ${where}`)
        .toBeLessThanOrEqual(reading.pane.right + 1);
      expect(
        reading.thumbHit!.left,
        `the grab area must reach in from the edge (left ${Math.round(reading.thumbHit!.left)} vs pane.right-32 ${Math.round(reading.pane.right - GRAB_MIN_WIDTH)}) at ${where}`,
      ).toBeLessThanOrEqual(reading.pane.right - GRAB_MIN_WIDTH + 1);

      // The drawn thumb is still the 8px lozenge.
      expect(reading.thumbWidth, `the drawn thumb must stay ${THUMB_WIDTH}px wide at ${where}`)
        .toBeCloseTo(THUMB_WIDTH, 0);

      // A real touch drag on the grab area moves the transcript. The pane opens
      // at the tail, so the drag runs upward — toward older turns — which is the
      // direction that can actually change `scrollTop`.
      const before = await readScrollTop(page);
      const box = reading.thumbHit!;
      const x = Math.round((box.left + box.right) / 2);
      const yStart = Math.round((box.top + box.bottom) / 2);
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yStart }] });
        for (let step = 1; step <= 8; step += 1) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y: yStart - Math.round((260 * step) / 8) }],
          });
          await page.waitForTimeout(20);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } finally {
        await cdp.detach();
      }
      await expect
        .poll(async () => Math.abs((await readScrollTop(page)) - before), {
          timeout: 10_000,
          message: `dragging the grab area must move the transcript at ${where}`,
        })
        .toBeGreaterThan(20);
    } finally {
      await context.close();
    }
  });
});
