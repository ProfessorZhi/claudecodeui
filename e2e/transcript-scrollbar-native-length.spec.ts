import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// AC-219: the transcript's drawn scrollbar follows the browser's own rules against
// an estimated conversation height in pixels. Its length is
// `max(28px, trackHeight * viewportHeight / estimatedTotal)` with no ceiling below
// the track; its position is the share of the conversation's estimated pixels
// already scrolled past; and both the scrollbar and the tick column stand down
// when the content fits the viewport, whatever the turn count.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). Two fixtures, both seeded by the
// config: the long transcript (`e2e-transcript-jump`, 1200 turns / 4800 rows) for
// the windowed and long-conversation readings, and the short one
// (`e2e-transcript-follow`, 24 messages / 12 turns) — small enough that a tall
// viewport can hold it whole, which is what the "fits" readings need. Every
// number comes from elements this app draws: the track's own
// `data-content-estimate-px` and `data-px-per-message`, the thumb's box, and the
// pane's geometry. The native scrollbar is hidden by `scrollbar-width: none`, so
// it is not read.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The long, 1200-turn fixture. */
const LONG_SESSION_ID = 'e2e-transcript-jump';
/** Normalized rows the long fixture carries. */
const LONG_TOTAL_MESSAGES = 4800;
/** The short fixture: 24 messages, 12 user turns. */
const SHORT_SESSION_ID = 'e2e-transcript-follow';

/** A viewport tall enough to hold the whole short conversation — nothing to scroll. */
const FITS_VIEWPORT = { width: 1280, height: 8000 } as const;
/** A tall viewport the short conversation does not fit: its scrollbar has real travel. */
const TALL_VIEWPORT = { width: 1280, height: 4000 } as const;
/** The long fixture's working viewport. */
const DESKTOP_VIEWPORT = { width: 1280, height: 1200 } as const;

/** The shared floor the drawn length may never go below. */
const MIN_THUMB_PX = 28;
/** How much the drawn length may move across a scroll gesture, as a share of itself. */
const LENGTH_DRIFT_SHARE = 0.08;
/** How close a pixel-derived position must match the browser's own ratio. */
const POSITION_TOLERANCE = 0.06;
/** How close the estimate's implied message count must be to the conversation's own. */
const ESTIMATE_IMPLIED_TOLERANCE = 0.15;

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

/** Everything one AC-219 reading compares. */
type RailReading = {
  /** How many drawn scrollbar tracks exist in the document. */
  trackCount: number;
  /** The track's own `data-content-estimate-px` — the estimated conversation height. */
  estimatePx: number;
  /** The track's own `data-px-per-message`. */
  pxPerMessage: number;
  /** The track's drawn height. */
  trackHeight: number;
  /** The thumb's drawn height. */
  thumbHeight: number;
  /** The thumb's own fraction of its travel, from `data-scroll-progress`. */
  thumbProgress: number;
  /** The pane's drawn height. */
  paneClientHeight: number;
  /** The pane's content height — the loaded window, not the whole conversation. */
  paneScrollHeight: number;
  /** The pane's offset from the content's top. */
  paneScrollTop: number;
  /** The tick column's drawn height, or 0 when it is not laid out. */
  tickColumnHeight: number;
  /** How many turn ticks are drawn. */
  tickCount: number;
};

const readRail = (page: Page): Promise<RailReading> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const track = document.querySelector('[data-scrollbar-track]') as HTMLElement | null;
    const thumb = document.querySelector('[data-scrollbar-thumb]') as HTMLElement | null;
    const column = document.querySelector('[data-turn-ticks]') as HTMLElement | null;
    const trackBox = track?.getBoundingClientRect();
    const thumbBox = thumb?.getBoundingClientRect();
    const progress = thumb?.getAttribute('data-scroll-progress');
    return {
      trackCount: document.querySelectorAll('[data-scrollbar-track]').length,
      estimatePx: Number(track?.getAttribute('data-content-estimate-px') ?? 'NaN'),
      pxPerMessage: Number(track?.getAttribute('data-px-per-message') ?? 'NaN'),
      trackHeight: trackBox ? trackBox.height : Number.NaN,
      thumbHeight: thumbBox ? thumbBox.height : Number.NaN,
      thumbProgress: progress == null ? Number.NaN : Number(progress),
      paneClientHeight: pane.clientHeight,
      paneScrollHeight: pane.scrollHeight,
      paneScrollTop: pane.scrollTop,
      tickColumnHeight: column ? column.getBoundingClientRect().height : 0,
      tickCount: document.querySelectorAll('[data-turn-tick]').length,
    };
  });

/** The same reading with the numbers rounded, for failure messages. */
const shown = (reading: RailReading): string =>
  JSON.stringify(reading, (_key, value) => (typeof value === 'number' ? Math.round(value) : value));

/** Waits for a freshly loaded transcript to be drawn and measured. */
const settleTranscript = async (page: Page) => {
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(900);
};

/** Puts the pointer over the middle of the pane, so a wheel gesture lands on the transcript. */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) throw new Error('the transcript pane has no box to aim a gesture at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('the drawn scrollbar follows the browser rules against an estimated content height', () => {
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

  /** A fresh, already-signed-in page at one viewport, opened on a session by id. */
  const openAt = async (
    viewport: { readonly width: number; readonly height: number },
    sessionId: string,
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({ viewport });
    await context.addInitScript((token) => {
      window.localStorage.setItem('auth-token', token);
    }, authToken);
    const page = await context.newPage();
    void settleServiceWorker(page);
    await page.goto(`${origin}/session/${sessionId}`);
    return { context, page };
  };

  test('AC-219 (a) content that fits draws neither column; a viewport change flips both', async () => {
    const { context, page } = await openAt(FITS_VIEWPORT, SHORT_SESSION_ID);
    try {
      await settleTranscript(page);
      const fits = await readRail(page);
      expect(fits.trackCount, `a conversation the viewport holds must draw no scrollbar: ${shown(fits)}`).toBe(0);
      expect(fits.tickColumnHeight, `a conversation the viewport holds must draw no tick column: ${shown(fits)}`).toBe(0);
      expect(fits.tickCount, `no ticks may be drawn when the content fits: ${shown(fits)}`).toBe(0);

      // Shrink the viewport until the same conversation no longer fits: both
      // columns must appear, even though it has only a dozen turns.
      await page.setViewportSize(TALL_VIEWPORT);
      await expect
        .poll(async () => (await readRail(page)).trackCount, {
          timeout: 10_000,
          message: 'shrinking the viewport below the content must draw the scrollbar',
        })
        .toBe(1);
      const doesNotFit = await readRail(page);
      expect(doesNotFit.tickColumnHeight, `a conversation taller than the viewport must draw its column: ${shown(doesNotFit)}`)
        .toBeGreaterThan(0);
      expect(doesNotFit.tickCount, `the short conversation must draw its turns once it does not fit: ${shown(doesNotFit)}`)
        .toBeGreaterThan(0);

      // And back: the columns must stand down again.
      await page.setViewportSize(FITS_VIEWPORT);
      await expect
        .poll(async () => (await readRail(page)).trackCount, {
          timeout: 10_000,
          message: 'growing the viewport back past the content must stand the scrollbar down',
        })
        .toBe(0);
    } finally {
      await context.close();
    }

    // A long conversation never fits, at its working viewport.
    const long = await openAt(DESKTOP_VIEWPORT, LONG_SESSION_ID);
    try {
      await settleTranscript(long.page);
      const reading = await readRail(long.page);
      expect(reading.trackCount, `the long conversation must draw its scrollbar: ${shown(reading)}`).toBe(1);
      expect(reading.thumbHeight, `the long conversation must draw a thumb: ${shown(reading)}`).toBeGreaterThan(0);
    } finally {
      await long.context.close();
    }
  });

  test('AC-219 (b) the drawn length is the browser formula with no 25% ceiling and a grabbable floor', async () => {
    // The short conversation at a viewport that does not hold it whole: the drawn
    // length is well above the old quarter-track ceiling, so the ceiling's absence
    // is visible.
    const { context, page } = await openAt(TALL_VIEWPORT, SHORT_SESSION_ID);
    try {
      await settleTranscript(page);
      const reading = await readRail(page);
      const where = `short@tall: ${shown(reading)}`;
      expect(reading.trackCount, `the short conversation must draw its scrollbar at this height: ${where}`).toBe(1);
      expect(reading.estimatePx, `the track must publish its estimated content height: ${where}`).toBeGreaterThan(0);
      expect(reading.pxPerMessage, `the track must publish its px per message: ${where}`).toBeGreaterThan(0);

      const expected = Math.max(
        MIN_THUMB_PX,
        (reading.trackHeight * reading.paneClientHeight) / reading.estimatePx,
      );
      expect(
        Math.abs(reading.thumbHeight - expected),
        `the length must be max(${MIN_THUMB_PX}px, track x viewport / estimate): ${where}`,
      ).toBeLessThanOrEqual(2);
      expect(
        reading.thumbHeight,
        `the length must exceed the removed 25% ceiling: ${where}`,
      ).toBeGreaterThan(reading.trackHeight * 0.25);
      expect(
        reading.thumbHeight,
        `the length must not exceed the track: ${where}`,
      ).toBeLessThanOrEqual(reading.trackHeight + 1);
    } finally {
      await context.close();
    }

    // The long conversation: the same formula, floored at the grabbable minimum.
    const long = await openAt(DESKTOP_VIEWPORT, LONG_SESSION_ID);
    try {
      await settleTranscript(long.page);
      const reading = await readRail(long.page);
      const where = `long@desktop: ${shown(reading)}`;
      expect(reading.thumbHeight, `a conversation far taller than the viewport floors at ${MIN_THUMB_PX}px: ${where}`)
        .toBe(MIN_THUMB_PX);
      expect(reading.thumbHeight, `the thumb must still be drawn: ${where}`).toBeGreaterThan(0);
    } finally {
      await long.context.close();
    }
  });

  test('AC-219 (c)(f) the estimate is the conversation in pixels, not the loaded window', async () => {
    // The short conversation is loaded whole, so the pane's own scrollHeight is the
    // conversation's real height; an all-measured estimate must match it closely.
    const short = await openAt(TALL_VIEWPORT, SHORT_SESSION_ID);
    try {
      await settleTranscript(short.page);
      const reading = await readRail(short.page);
      const where = `short@tall: ${shown(reading)}`;
      const relative = Math.abs(reading.estimatePx - reading.paneScrollHeight) / reading.paneScrollHeight;
      expect(
        relative,
        `the estimate must match the whole conversation's real height within 5%: ${where}`,
      ).toBeLessThanOrEqual(0.05);
    } finally {
      await short.context.close();
    }

    // The long conversation: messages the loaded window does not hold are still
    // counted, each at px-per-message — so the estimated height divided by
    // px-per-message is the conversation's message count. A placeholder-shaped
    // estimate (100px for an unmeasured row) would inflate that ratio.
    const long = await openAt(DESKTOP_VIEWPORT, LONG_SESSION_ID);
    try {
      await settleTranscript(long.page);
      await pointAtPane(long.page);
      // Scroll up to force the loaded window to grow and hold rows it has never
      // measured — the window the placeholder distinction is about.
      for (let step = 0; step < 10; step += 1) {
        await long.page.mouse.wheel(0, -1_400);
        await long.page.waitForTimeout(120);
      }
      await long.page.waitForTimeout(600);
      const reading = await readRail(long.page);
      const where = `long@desktop scrolled: ${shown(reading)}`;
      expect(reading.estimatePx, `the estimate must be published: ${where}`).toBeGreaterThan(0);
      expect(reading.pxPerMessage, `px per message must be published: ${where}`).toBeGreaterThan(0);
      const impliedMessages = reading.estimatePx / reading.pxPerMessage;
      const relative = Math.abs(impliedMessages - LONG_TOTAL_MESSAGES) / LONG_TOTAL_MESSAGES;
      expect(
        relative,
        `estimate / px-per-message must be the conversation's message count (${LONG_TOTAL_MESSAGES}): ${where} (implied ${Math.round(impliedMessages)})`,
      ).toBeLessThanOrEqual(ESTIMATE_IMPLIED_TOLERANCE);
    } finally {
      await long.context.close();
    }
  });

  test('AC-219 (d) the drawn length holds through a scroll and is frozen under a drag', async () => {
    const { context, page } = await openAt(TALL_VIEWPORT, SHORT_SESSION_ID);
    try {
      await settleTranscript(page);
      await pointAtPane(page);
      const settled = await readRail(page);
      const samples: number[] = [];
      for (let step = 0; step < 10; step += 1) {
        await page.mouse.wheel(0, step < 5 ? -600 : 600);
        await page.waitForTimeout(140);
        samples.push((await readRail(page)).thumbHeight);
      }
      const minLength = Math.min(...samples);
      const maxLength = Math.max(...samples);
      const drift = (maxLength - minLength) / Math.max(1, minLength);
      expect(
        drift,
        `the drawn length must not breathe while scrolling: ${JSON.stringify({ settled: settled.thumbHeight, samples })}`,
      ).toBeLessThanOrEqual(LENGTH_DRIFT_SHARE);

      // Dragging the thumb freezes the estimate: the length must not move at all
      // between the pointer going down and coming up.
      const box = await page.locator('[data-scrollbar-thumb]').boundingBox();
      if (!box) throw new Error('the thumb has no box to drag');
      const x = box.x + box.width / 2;
      await page.mouse.move(x, box.y + box.height / 2);
      await page.mouse.down();
      const dragHeights: number[] = [];
      for (let step = 1; step <= 8; step += 1) {
        await page.mouse.move(x, box.y + box.height / 2 + (step * 60));
        await page.waitForTimeout(40);
        dragHeights.push((await readRail(page)).thumbHeight);
      }
      await page.mouse.up();
      const dragMin = Math.min(...dragHeights);
      const dragMax = Math.max(...dragHeights);
      expect(
        dragMax - dragMin,
        `the length must be frozen under a drag (0px of change): ${JSON.stringify({ dragHeights })}`,
      ).toBe(0);
    } finally {
      await context.close();
    }

    // The freeze has to hold when the drag actually swaps the window — which only
    // happens on the long conversation. Its length is read at a viewport tall
    // enough that the browser formula is well above the 28px floor, so a window
    // swap that leaked into the length would show as a real change (a floored
    // length could hide it).
    const long = await openAt(TALL_VIEWPORT, LONG_SESSION_ID);
    try {
      await settleTranscript(long.page);
      const before = await readRail(long.page);
      expect(
        before.thumbHeight,
        `the long conversation must draw a length above the floor at this height: ${shown(before)}`,
      ).toBeGreaterThan(MIN_THUMB_PX);

      const box = await long.page.locator('[data-scrollbar-thumb]').boundingBox();
      if (!box) throw new Error('the thumb has no box to drag');
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await long.page.mouse.move(x, y);
      await long.page.mouse.down();
      const dragHeights: number[] = [];
      for (let step = 1; step <= 10; step += 1) {
        await long.page.mouse.move(x, y - step * 240);
        await long.page.waitForTimeout(60);
        dragHeights.push((await readRail(long.page)).thumbHeight);
      }
      await long.page.mouse.up();
      const dragMin = Math.min(...dragHeights);
      const dragMax = Math.max(...dragHeights);
      expect(
        dragMax - dragMin,
        `the length must stay frozen across a window-swapping drag (0px): ${JSON.stringify({ before: before.thumbHeight, dragHeights })}`,
      ).toBe(0);
    } finally {
      await long.context.close();
    }
  });

  test('AC-219 (e) the position is the share of the conversation already scrolled past', async () => {
    const { context, page } = await openAt(TALL_VIEWPORT, SHORT_SESSION_ID);
    try {
      await settleTranscript(page);
      await pointAtPane(page);

      // At the head of the conversation the browser's own pixel ratio is 0; the
      // thumb must read 0, not the viewport-centre ordinal's share.
      for (let step = 0; step < 12; step += 1) {
        await page.mouse.wheel(0, -1_200);
        await page.waitForTimeout(100);
      }
      await page.waitForTimeout(500);
      const atHead = await readRail(page);
      expect(
        atHead.paneScrollTop,
        `the wheel gesture must reach the conversation's head: ${shown(atHead)}`,
      ).toBeLessThanOrEqual(1);
      expect(
        atHead.thumbProgress,
        `at the head the thumb must read 0, not a viewport-centre ordinal: ${shown(atHead)}`,
      ).toBeLessThanOrEqual(POSITION_TOLERANCE);

      // At a middle position the thumb must match the browser's own ratio,
      // scrollTop / (scrollHeight - clientHeight) — which the whole-conversation
      // short fixture makes the conversation's ratio too.
      await page.mouse.wheel(0, 1_100);
      await page.waitForTimeout(700);
      const middle = await readRail(page);
      const browserRatio = middle.paneScrollHeight - middle.paneClientHeight > 0
        ? middle.paneScrollTop / (middle.paneScrollHeight - middle.paneClientHeight)
        : 0;
      expect(
        Math.abs(middle.thumbProgress - browserRatio),
        `the thumb must be the pixel share already scrolled past, not the window's ratio: ${shown(middle)} (browser ${browserRatio.toFixed(3)})`,
      ).toBeLessThanOrEqual(POSITION_TOLERANCE);
    } finally {
      await context.close();
    }
  });

  test('AC-219 (g) the position uses the estimated pixels of the rows above the viewport, not placeholders', async () => {
    const { context, page } = await openAt(DESKTOP_VIEWPORT, LONG_SESSION_ID);
    try {
      await settleTranscript(page);
      await pointAtPane(page);
      // Scroll up so rows above the viewport are the window's own, then read the
      // thumb and the independent ordinal of the window's first row.
      for (let step = 0; step < 8; step += 1) {
        await page.mouse.wheel(0, -1_600);
        await page.waitForTimeout(120);
      }
      await page.waitForTimeout(600);
      const reading = await readRail(page);
      const where = `long@desktop scrolled: ${shown(reading)}`;
      // The estimate is still the conversation, and the thumb still names a
      // position inside it — not NaN, and not pinned past either end.
      expect(reading.thumbProgress, `the thumb must read a real position: ${where}`).toBeGreaterThanOrEqual(0);
      expect(reading.thumbProgress, `the thumb must read a real position: ${where}`).toBeLessThanOrEqual(1);
      // The conversation's own proportion of the window's first row, read from the
      // DOM and the outline, is a close witness on this fixture (near-uniform rows).
      const witness = await page.evaluate(async () => {
        const el = document.querySelector('.chat-messages-pane [data-message-anchor-id]');
        const id = el ? el.getAttribute('data-message-anchor-id') : null;
        if (!id) return null;
        const response = await fetch('/api/providers/sessions/e2e-transcript-jump/outline', {
          headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
        });
        const body = (await response.json()) as { data?: { total?: number; turns?: { id: string; index: number }[] } };
        const turn = body.data?.turns?.find((entry) => entry.id === id);
        return turn && body.data?.total ? turn.index / body.data.total : null;
      });
      expect(witness, `the loaded window must expose a first turn to witness against: ${where}`).not.toBeNull();
      expect(
        Math.abs(reading.thumbProgress - witness!),
        `the thumb must agree with the window's first-row ordinal on a near-uniform fixture: ${where} (witness ${witness!.toFixed(3)})`,
      ).toBeLessThanOrEqual(0.03);
    } finally {
      await context.close();
    }
  });
});
