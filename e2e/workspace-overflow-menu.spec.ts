import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// AC-222: the session page's top bar carries one ⋯ overflow menu at its far
// right — outside the tab strip — that holds the conversation export and the
// quick settings. The two edge controls that used to live on the transcript's
// right edge (the draggable quick-settings handle and the floating export
// button) are gone, so that edge holds only the scrollbar and the ticks.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir), on the long fixture it seeds: the
// 1200-turn transcript `e2e-transcript-jump`, reached through the sidebar the
// way a reader would.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The seeded long fixture and the sidebar name its project is reached by. */
const SESSION_ID = 'e2e-transcript-jump';
const PROJECT_NAME = 'transcript-jump-workspace';

const TRIGGER = '[data-workspace-menu-trigger]';
const MENU = '[data-workspace-menu]';
const ITEM = (key: string) => `[data-workspace-menu-item="${key}"]`;

/** Every item the criterion names, in the groups the menu draws them. */
const EXPECTED_ITEMS = [
  'export-html',
  'export-markdown',
  'export-json',
  'showRawParameters',
  'showThinking',
  'sendByCtrlEnter',
  'darkMode',
  'language',
] as const;

/** The two viewports the criterion names. */
const MOBILE = { name: 'mobile 390x844', size: { width: 390, height: 844 } } as const;
const DESKTOP = { name: 'desktop 1280x800', size: { width: 1280, height: 800 } } as const;

/** The minimum touch target the criterion requires for a menu row. */
const MIN_TOUCH_TARGET_PX = 44;

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

/** Waits for a freshly loaded transcript to be drawn and measured. */
const settleTranscript = async (page: Page) => {
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(750);
};

/** A box in viewport coordinates. */
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** Everything one menu reading compares. */
type MenuReading = {
  open: boolean;
  box: Box | null;
  viewport: { width: number; height: number };
  items: { key: string | null; text: string; checked: string | null; height: number }[];
};

const readMenu = (page: Page): Promise<MenuReading> =>
  page.evaluate(() => {
    const menu = document.querySelector('[data-workspace-menu]');
    const rect = menu?.getBoundingClientRect();
    const items = Array.from(document.querySelectorAll('[data-workspace-menu-item]')).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        key: el.getAttribute('data-workspace-menu-item'),
        text: (el.textContent ?? '').trim(),
        checked: el.getAttribute('aria-checked'),
        height: r.height,
      };
    });
    return {
      open: menu !== null,
      box: rect
        ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
        : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      items,
    };
  });

/** The right-edge reading: the two retired controls, and any clickable left in the edge band. */
type EdgeReading = {
  handleCount: number;
  exportAnchorCount: number;
  edgeLeft: number;
  paneRight: number;
  offenders: string[];
};

const readEdge = (page: Page): Promise<EdgeReading> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    if (!pane) throw new Error('the transcript pane is not mounted');
    const paneRect = pane.getBoundingClientRect();

    // The band the criterion calls the right edge: from the left of the rail's
    // own chrome (the tick column and the drawn scrollbar) to the pane's right.
    let edgeLeft = paneRect.right;
    for (const selector of ['[data-turn-ticks]', '[data-scrollbar-thumb]']) {
      const el = document.querySelector(selector);
      const r = el?.getBoundingClientRect();
      if (r && r.width > 0) edgeLeft = Math.min(edgeLeft, r.left);
    }

    const offenders = Array.from(
      document.querySelectorAll('button, a, select, input, [role="button"], [role="slider"], [tabindex]'),
    )
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx < edgeLeft || cx > paneRect.right) return false;
        if (cy < paneRect.top || cy > paneRect.bottom) return false;
        // The transcript rail's own chrome is the edge's intended occupant.
        if (el.closest('[data-scrollbar-thumb], [data-scrollbar-track], [data-turn-tick]')) return false;
        return true;
      })
      .map((el) => `${el.tagName.toLowerCase()}:${(el.textContent ?? '').trim().slice(0, 40)}`);

    return {
      handleCount: document.querySelectorAll('[data-quick-settings-handle]').length,
      exportAnchorCount: document.querySelectorAll('[data-transcript-export-anchor]').length,
      edgeLeft,
      paneRight: paneRect.right,
      offenders,
    };
  });

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('the workspace header carries one overflow menu and the transcript edge is clear', () => {
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

  /** A fresh, already-signed-in page at one viewport. */
  const openAt = async (
    viewport: { readonly name: string; readonly size: { width: number; height: number } },
  ): Promise<{ context: BrowserContext; page: Page }> => {
    const narrow = viewport.name === MOBILE.name;
    const context = await browser.newContext({
      viewport: viewport.size,
      hasTouch: narrow,
      isMobile: narrow,
      acceptDownloads: true,
    });
    await context.addInitScript((token) => {
      window.localStorage.setItem('auth-token', token);
    }, authToken);
    const page = await context.newPage();
    return { context, page };
  };

  /** Opens the seeded long session directly, the way the transcript specs reach it. */
  const openLongSession = async (page: Page) => {
    await page.goto(`${origin}/session/${SESSION_ID}`);
    await settleServiceWorker(page);
    await settleTranscript(page);
  };

  const openMenu = async (page: Page) => {
    await page.locator(TRIGGER).click();
    await expect(page.locator(MENU)).toBeVisible({ timeout: 5_000 });
  };

  test('AC-222 (a)(b)(c) the ⋯ menu holds every group, keeps the toggles open, and the right edge is clear', async () => {
    for (const viewport of [MOBILE, DESKTOP]) {
      const { context, page } = await openAt(viewport);
      try {
        await openLongSession(page);

        await expect(page.locator(TRIGGER), `the ⋯ trigger must be visible at ${viewport.name}`).toBeVisible();
        await openMenu(page);
        const reading = await readMenu(page);
        const where = `${viewport.name}: ${JSON.stringify(reading.items.map((item) => item.key))}`;

        // ── (a) every group the criterion names is in the menu ────────────────
        const keys = reading.items.map((item) => item.key);
        for (const expected of EXPECTED_ITEMS) {
          expect(keys, `the menu must offer ${expected} at ${where}`).toContain(expected);
        }
        for (const item of reading.items) {
          expect(item.text.length, `menu item ${item.key} must carry a label at ${where}`).toBeGreaterThan(0);
        }

        // ── (e) the menu fits the viewport and its rows are touch-sized ───────
        expect(reading.box, `the menu must be laid out at ${where}`).not.toBeNull();
        expect(reading.box!.left, `the menu must not run off the left edge at ${where}`).toBeGreaterThanOrEqual(0);
        expect(reading.box!.right, `the menu must not run off the right edge at ${where}`)
          .toBeLessThanOrEqual(reading.viewport.width + 1);
        expect(reading.box!.top, `the menu must not run off the top edge at ${where}`).toBeGreaterThanOrEqual(0);
        expect(reading.box!.bottom, `the menu must not run off the bottom edge at ${where}`)
          .toBeLessThanOrEqual(reading.viewport.height + 1);
        if (viewport.name === MOBILE.name) {
          expect(reading.box!.width, `the mobile menu must not exceed the viewport at ${where}`)
            .toBeLessThanOrEqual(reading.viewport.width);
        }
        for (const item of reading.items) {
          expect(item.height, `menu item ${item.key} must be at least ${MIN_TOUCH_TARGET_PX}px tall at ${where}`)
            .toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX - 1);
        }

        // ── (b) a switch applies immediately and keeps the menu open ──────────
        const before = await page.getAttribute(ITEM('showRawParameters'), 'aria-checked');
        await page.locator(ITEM('showRawParameters')).click();
        await expect(page.locator(MENU), `a switch must not close the menu at ${where}`).toBeVisible();
        const after = await page.getAttribute(ITEM('showRawParameters'), 'aria-checked');
        expect(after, `the switch must flip at ${where}`).not.toBe(before);
        // Flip it back, so the run leaves no changed preference behind.
        await page.locator(ITEM('showRawParameters')).click();
        await expect(page.locator(ITEM('showRawParameters'))).toHaveAttribute('aria-checked', before ?? 'false');

        await page.keyboard.press('Escape');
        await expect(page.locator(MENU)).toHaveCount(0);

        // ── (c) the transcript's right edge holds no handle and no float button ─
        const edge = await readEdge(page);
        expect(edge.handleCount, `no quick-settings handle may remain at ${where}`).toBe(0);
        expect(edge.exportAnchorCount, `no floating export anchor may remain at ${where}`).toBe(0);
        expect(
          edge.offenders,
          `the right edge (x ${Math.round(edge.edgeLeft)}..${Math.round(edge.paneRight)}) may hold only the rail at ${where}`,
        ).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });

  test('AC-222 (b) each export item downloads its own format and closes the menu', async () => {
    const { context, page } = await openAt(DESKTOP);
    try {
      await openLongSession(page);

      const formats: Array<[string, string]> = [
        ['export-html', '.html'],
        ['export-markdown', '.md'],
        ['export-json', '.json'],
      ];
      for (const [key, suffix] of formats) {
        await openMenu(page);
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 120_000 }),
          page.locator(ITEM(key)).click(),
        ]);
        expect(
          download.suggestedFilename().endsWith(suffix),
          `${key} must download a ${suffix} file, got ${download.suggestedFilename()}`,
        ).toBe(true);
        await expect(page.locator(MENU), `selecting ${key} must close the menu`).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });

  test('AC-222 (d) with no session open the menu has no export group', async () => {
    const { context, page } = await openAt(DESKTOP);
    try {
      await page.goto(`${origin}/`);
      await settleServiceWorker(page);
      // Selecting the project without a session leaves the chat pane with nothing
      // to export, which is exactly the state that must hide the group.
      const projectRow = page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
      await expect(projectRow, 'the seeded project must be listed').toBeVisible({ timeout: 30_000 });
      await projectRow.click();
      await expect(page.locator(PANE)).toBeVisible({ timeout: 15_000 });

      await openMenu(page);
      const reading = await readMenu(page);
      const keys = reading.items.map((item) => item.key);
      expect(keys.filter((key) => key?.startsWith('export-')), 'no export item may show without messages').toEqual([]);
      for (const expected of ['showRawParameters', 'showThinking', 'sendByCtrlEnter', 'darkMode', 'language']) {
        expect(keys, `the non-export groups must still show: ${expected}`).toContain(expected);
      }
    } finally {
      await context.close();
    }
  });
});
