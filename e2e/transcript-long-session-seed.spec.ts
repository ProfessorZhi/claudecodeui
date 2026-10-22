import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-seed: the shared long-session fixture exists and is what GOAL-017's four real-browser criteria need — a
// transcript far longer than the first screen, whose REST total is at least 4800, whose first screen holds only
// the tail (the earliest user turn in the DOM is past 1000), and whose 600th and 601st turns share one
// millisecond while their ids stay distinct.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
// Nothing here is stubbed: the session is a real Claude transcript seeded into the run's isolated HOME before
// the server booted and indexed by the backend's own synchronizer (see `seedTranscriptJumpTranscript` in
// playwright.config.ts), and it is opened through the sidebar's own link rather than by writing the store.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The row class `MessageComponent` draws. */
const ROW = '.chat-message';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-jump';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-jump';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-jump-workspace';
/** The REST total floor: 4 drawn rows per turn over the seed's 1200 turns. */
const MIN_TOTAL = 4800;
/** The first screen must show only the tail — its earliest user turn is deeper than this. */
const MIN_FIRST_TURN = 1000;
/** The displayed number of the first of the two turns that share one millisecond. */
const TIE_TURN = 600;
/** Fixed viewport, so the first screen's mounted band is reproducible run to run. */
const VIEWPORT = { width: 1280, height: 1200 };

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

/** Lets the app's service worker finish claiming the first document, so the measured navigation is not the load it holes. */
const settleServiceWorker = (page: Page) =>
  page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    .catch(() => undefined);

/** The sidebar row for the seeded session. */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

type HistoryPage = { status: number; body: string };

/**
 * Reads the persisted history over the app's own REST route, from inside the page so it carries the token the
 * UI stored. Omitting `limit` asks for the whole transcript, which is what makes `total` the reading below.
 */
const readHistory = (page: Page, sessionId: string): Promise<HistoryPage> =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/messages`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, sessionId);

type HistoryMessage = { id?: string; timestamp?: string; role?: string; kind?: string; content?: string };

/**
 * Opens the seeded session through the sidebar's own link — never by writing the store or the URL.
 *
 * The project row is a toggle, so a click that lands while the sidebar is still re-rendering would leave it
 * collapsed; the loop clicks until the row is really on screen, then the link itself is clicked once.
 */
const openSeededSession = async (page: Page) => {
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink(page).isVisible().catch(() => false)) {
      break;
    }
    await projectRow().click();
    try {
      await expect(sessionLink(page)).toBeVisible({ timeout: 10_000 });
      break;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(sessionLink(page)).toBeVisible({ timeout: 30_000 });
  await sessionLink(page).click({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  await expect(page.locator(`${PANE} ${ROW}`).first()).toBeVisible({ timeout: 30_000 });
};

/** The earliest user-turn number drawn in the first screen's DOM, read before any scroll. */
const earliestUserTurnInDom = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-message-style="user"]'))
      .map((row) => /Turn (\d+)\./.exec(row.textContent || '')?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY),
  );

test.describe.configure({ timeout: 120_000 });

test.describe('long-session seed', () => {
  test('AC-seed the seeded session is long, tail-loaded, and carries the same-millisecond tie', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);
    await ensureSignedIn(page);
    await settleServiceWorker(page);

    await openSeededSession(page);

    // Reading (i): the persisted transcript is the long one — the REST total counts every drawn row.
    const history = await readHistory(page, SESSION_ID);
    expect(history.status, `GET /messages did not answer: ${history.body.slice(0, 400)}`).toBe(200);
    const data = (JSON.parse(history.body) as { data?: { total?: number; messages?: HistoryMessage[] } }).data;
    expect(data, `the history response carried no data: ${history.body.slice(0, 400)}`).toBeTruthy();
    const total = data?.total ?? 0;
    expect(
      total,
      `the seeded transcript must be at least ${MIN_TOTAL} drawn rows; GET /messages reported ${total}`,
    ).toBeGreaterThanOrEqual(MIN_TOTAL);

    // Reading (ii): the first screen holds only the tail — the earliest mounted user turn is deep in the
    // transcript, so none of GOAL-017's target turns have entered the DOM yet.
    const earliestTurn = await earliestUserTurnInDom(page);
    expect(
      earliestTurn,
      `the first screen must draw only the tail; its earliest user turn was ${earliestTurn}`,
    ).toBeGreaterThan(MIN_FIRST_TURN);

    // Reading (iii): the 600th and 601st turns share one instant but are two rows. Read from the persisted
    // history, where each row's own timestamp and id survive.
    const messages = data?.messages ?? [];
    const userTurn = (n: number) =>
      messages.find((message) => message.kind === 'text' && message.role === 'user' && (message.content ?? '').startsWith(`Turn ${n}. `));
    const tied = userTurn(TIE_TURN);
    const next = userTurn(TIE_TURN + 1);
    expect(tied, `no user row for turn ${TIE_TURN} in the history`).toBeTruthy();
    expect(next, `no user row for turn ${TIE_TURN + 1} in the history`).toBeTruthy();
    expect(
      tied?.timestamp,
      `turns ${TIE_TURN} and ${TIE_TURN + 1} must share one millisecond: ${tied?.timestamp} vs ${next?.timestamp}`,
    ).toBe(next?.timestamp);
    expect(
      tied?.id,
      `the tied turns must still be two rows (same id ${tied?.id} on both)`,
    ).not.toBe(next?.id);
  });
});
