import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * AC1: the host listing is read on the socket's schedule, not on a clock.
 *
 * Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
 * Nothing about the reading is stubbed: the count below is assembled from the browser's own request ledger,
 * the store is the shipped `useSessionHosts` singleton, and the socket is the app's real websocket. The page
 * is signed in by replaying the session `beforeAll` captured, so the case spends its budget on the window it
 * measures rather than on onboarding.
 *
 * The defect this replaces was a 1000ms `setInterval`: with the socket up and the tab idle, the page issued
 * ~30 reads of `GET /api/session-hosts` in 30s, each one a listing that had not changed. The change moves the
 * change signal onto the socket (`hosts_changed` frames) and demotes the timer to a fallback — 30s while the
 * socket is up, 2s while it is down. This file is the reading that says the first half really happened.
 *
 * The measurement is deliberately not "count the reads for 30s and hope". A count alone cannot tell a store
 * that reads once and then stops from one whose subscriber never mounted (0 reads passes `<= 2` vacuously),
 * and it cannot tell the connected cadence from the disconnected one. So three readings are taken, in order:
 *
 *   (i)  the store really read — a session row is drawn first, because `ResidentMark` is the component that
 *        calls `useSessionHosts`, and the store is a module singleton that polls only while someone is
 *        subscribed. With no row on screen, a count of zero would be a reading of an empty fixture.
 *   (ii) the socket is really up — the store is watched until it has been silent for 3s. That is already
 *        impossible at the disconnected cadence (a read every 2s) and is the normal state at the connected
 *        one, so the last read before the silence is a baseline the socket, and not the fallback, produced.
 *   (iii) the next read after that baseline is ~30s away, and the 30s window from it holds at most two reads.
 *
 * (ii) and (iii) are what make the number mean something: a store still on the 1s clock fails (iii) with a
 * gap near 1s, one that never left the disconnected fallback fails (ii) by never going quiet, and one whose
 * subscriber never mounted fails (i). The `a1s-pollWouldHaveBeen` line in the log is the baseline the old
 * behaviour would have produced, so the drop is legible from the output alone.
 */

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The one endpoint the store reads. */
const HOSTS_PATH = '/api/session-hosts';
/** The connected cadence: the interval this criterion is about, and the width of the measured window. */
const CONNECTED_INTERVAL_MS = 30_000;
/** The largest number of reads a 30s window may hold. */
const MAX_READS_PER_WINDOW = 2;
/** Silence long enough that the disconnected fallback (2s) cannot explain it, short enough to be free. */
const QUIET_PROOF_MS = 3_000;
/** How long the socket is given to come up before the quiet probe calls it absent. */
const CONNECT_BUDGET_MS = 18_000;
/** How long the store is given to make its first read once a subscriber is on screen. */
const FIRST_READ_BUDGET_MS = 15_000;
/**
 * How long the next read after the baseline is waited for.
 *
 * Longer than the interval on purpose: this is a wait, not the assertion — the gap itself is asserted below,
 * so a store that reads early is caught by the assertion rather than by this deadline, and one that never
 * reads again is the only thing that reaches it.
 */
const NEXT_READ_BUDGET_MS = 36_000;

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

/**
 * Signs in once for the whole file — the account is created on the first run against the fixture database.
 *
 * Every case gets its own browser context, so the default `page` fixture starts unauthenticated; re-running
 * onboarding per case would cost more than the case. Same helper as `e2e/resident-enter-send.spec.ts`,
 * including the bounded retry: the first navigation pays for the client's whole module graph.
 */
const ensureSignedIn = async (page: Page) => {
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  const arrived = createAccount.or(settings).or(page.locator('#username')).first();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/').catch(() => undefined);
    try {
      await expect(arrived).toBeVisible({ timeout: 15_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_000);
    }
  }
  if (lastError !== null) {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the app never reached a sign-in, onboarding or signed-in screen at ${page.url()}: `
        + `${body.replace(/\s+/g, ' ').trim().slice(0, 400) || '<empty body>'}`,
    );
  }

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

const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the case cannot authenticate');
  }
};

/** Puts the captured session into the case's own context before the first navigation. */
const restoreSession = (page: Page) =>
  page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key!, token!);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);

/**
 * Draws a session row, which is what subscribes the store.
 *
 * `useSessionHosts` is a module-level store with no subscribers until a component calls it, and every such
 * component draws a session: the sidebar mark, the composer, the activity dock, the resident status bar.
 * The cross-project recents list is the cheapest to reach — one click, and every seeded session is a row —
 * so it is preferred; if it is empty the project rows are expanded instead, which is where the seeded
 * transcripts are reached from the projects tab. Either way the reading below is of a page whose store is
 * really subscribed.
 */
const mountSubscriber = async (page: Page) => {
  const sessionLink = page.locator('a[href^="/session/"]');
  const visibleWithin = (timeout: number) =>
    sessionLink.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);

  const tab = page
    .getByRole('button', { name: 'Conversations', exact: true })
    .filter({ visible: true })
    .first();
  await expect(tab, "the sidebar's own mode tabs must be on screen").toBeVisible({ timeout: 25_000 });
  await tab.click();
  if (await visibleWithin(10_000)) return;

  // The recents list can be empty on a fresh data dir; the project list is what the seeded transcripts are
  // reached from there. The rows are toggles, so a click landing mid-render is retried by the loop.
  const projects = page.getByRole('button', { name: /workspace/i });
  const count = await projects.count();
  for (let index = 0; index < count; index += 1) {
    await projects.nth(index).click().catch(() => undefined);
    if (await visibleWithin(3_000)) return;
  }
};

/**
 * Waits until the store has been silent long enough that only the connected cadence explains it, and returns
 * the last read before that silence.
 *
 * While the socket is down the fallback reads every 2s, so 3s of silence cannot happen; once it is up the
 * interval is 30s and silence is the normal state. Every read during the probe resets the clock, so the value
 * returned is always a read that really was followed by ≥3s of nothing — a connect-edge pull, or a tick of
 * the long interval, but never a tick of the short one.
 */
const waitForConnectedBaseline = async (page: Page, reads: number[]): Promise<number> => {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let lastCount = reads.length;
  let quietSince = Date.now();

  while (Date.now() - quietSince < QUIET_PROOF_MS) {
    if (Date.now() > deadline) {
      const gaps = reads.slice(1).map((at, index) => at - reads[index]).join(', ');
      throw new Error(
        `the store never stopped reading at the disconnected cadence (inter-read gaps: [${gaps}] ms) — the `
          + 'websocket never came up, so a cadence read here would be the fallback timer and not the socket',
      );
    }
    await page.waitForTimeout(200);
    if (reads.length !== lastCount) {
      lastCount = reads.length;
      quietSince = Date.now();
    }
  }

  return reads[reads.length - 1];
};

test.describe.configure({ mode: 'serial' });

test.describe('the host listing is read on the socket schedule', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await bootstrapAuth(browser);
  });

  test('a connected idle page reads GET /api/session-hosts at the 30s cadence, not once a second', async ({ page }) => {
    /** Every read of the endpoint, timestamped where the browser asked for it. */
    const reads: number[] = [];
    page.on('request', (request) => {
      try {
        if (new URL(request.url()).pathname === HOSTS_PATH) reads.push(Date.now());
      } catch {
        // A URL that cannot be parsed is not this endpoint.
      }
    });

    await restoreSession(page);
    await page.goto('/');

    // (i) A session row is drawn, so the store has a subscriber and a read of zero would mean something.
    await mountSubscriber(page);
    await expect.poll(() => reads.length, {
      timeout: FIRST_READ_BUDGET_MS,
      message: 'the mounted subscriber never drove a read of GET /api/session-hosts',
    }).toBeGreaterThanOrEqual(1);

    // (ii) The socket is up: the store has gone quiet for longer than the disconnected fallback allows.
    const baseline = await waitForConnectedBaseline(page, reads);
    const readsBeforeWindow = reads.length;

    // (iii) The next read, and the window it opens.
    const deadline = Date.now() + NEXT_READ_BUDGET_MS;
    while (reads.length === readsBeforeWindow && Date.now() < deadline) {
      await page.waitForTimeout(200);
    }

    const gap = reads.length > readsBeforeWindow ? reads[readsBeforeWindow] - baseline : -1;
    const inWindow = reads.filter(
      (at) => at >= baseline && at <= baseline + CONNECTED_INTERVAL_MS,
    ).length;
    const allGaps = reads.slice(1).map((at, index) => at - reads[index]).join(', ');
    console.log(
      `hosts-poll-rate connected gapMs=${gap} readsInWindow=${inWindow} windowMs=${CONNECTED_INTERVAL_MS} `
        + `a1s-pollWouldHaveBeen≈${CONNECTED_INTERVAL_MS / 1_000}`,
    );

    expect(
      reads.length,
      `the store made no read in the ${NEXT_READ_BUDGET_MS / 1_000}s after its baseline — a connected store `
        + 'reads at 30s, so either the socket dropped (2s fallback) or the timer stopped',
    ).toBeGreaterThan(readsBeforeWindow);
    expect(
      gap,
      `the next read must come at the connected cadence; ~1s is the clock this change removed and ~2s is the `
        + `disconnected fallback (all inter-read gaps: [${allGaps}] ms)`,
    ).toBeGreaterThanOrEqual(CONNECTED_INTERVAL_MS - 1_000);
    expect(
      inWindow,
      `a ${CONNECTED_INTERVAL_MS / 1_000}s window must hold at most ${MAX_READS_PER_WINDOW} reads of `
        + `${HOSTS_PATH}; it held ${inWindow}`,
    ).toBeLessThanOrEqual(MAX_READS_PER_WINDOW);
  });
});
