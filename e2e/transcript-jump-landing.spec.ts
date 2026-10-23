import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-221: clicking a turn tick or the scrollbar track places the target row fully
// inside the transcript's viewport and keeps it there — on a conversation whose
// rows are far taller than the flat placeholder the pane used to stand in for
// them. The reading is in-page `performance.now()` throughout: the probe starts
// sampling on the real pointerup and records the row's own geometry each frame,
// so "how long until it landed" and "did it stay" are measured from the page,
// never from the test's own wall clock.
//
// The failure this exists to catch is not "the jump scrolls to the wrong turn".
// It is that the jump's first write centres the target against rows that are
// still placeholders; the rows around it then mount as the widened window
// commits, grow to their real height, and push the target back out of the
// viewport — with nothing to correct it afterwards. The tall fixture
// (`e2e-transcript-jump-tall`, six-paragraph assistant rows) makes that push
// hundreds of pixels; the shared short fixture (`e2e-transcript-jump`) is the
// control that the correction does not disturb a conversation whose rows were
// already close to their stand-in.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). Nothing is stubbed: the outline the
// rail indexes comes from `GET /api/providers/sessions/:id/outline`, and every
// landing is a real jump through the shared `?around=<id>` window read.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** The tall-row session the criterion's main readings are taken on. */
const TALL_SESSION_ID = 'e2e-transcript-jump-tall';
const TALL_SESSION_NAME = 'transcript-jump-tall';
const TALL_PROJECT_NAME = 'transcript-jump-tall-workspace';
/** User turns the tall fixture carries. */
const TALL_TOTAL_TURNS = 300;
/** The shared short-row fixture, kept as the control. */
const SHORT_SESSION_ID = 'e2e-transcript-jump';
const SHORT_SESSION_NAME = 'transcript-jump';
const SHORT_PROJECT_NAME = 'transcript-jump-workspace';
const SHORT_TOTAL_TURNS = 1200;

/**
 * The three viewports the contract names: the phone clicks the track (its tick
 * column is `hidden md:flex`), the tablet and the wide desktop click ticks.
 *
 * `AC221_VIEWPORT` / `AC221_CLICKS` narrow this file while it is being developed
 * or re-measured; the shipped defaults are the contract's full grid.
 */
const ALL_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844, mode: 'track' as const },
  { name: 'tablet', width: 820, height: 1100, mode: 'tick' as const },
  { name: 'wide', width: 1280, height: 1200, mode: 'tick' as const },
];
const VIEWPORTS = process.env.AC221_VIEWPORT
  ? ALL_VIEWPORTS.filter((viewport) => viewport.name === process.env.AC221_VIEWPORT)
  : ALL_VIEWPORTS;
/** Jumps per viewport. Three viewports × eight is the contract's 24 clicks. */
const CLICKS_PER_VIEWPORT = Number(process.env.AC221_CLICKS ?? 8);
/** How long the target's position must stay put after it lands, in milliseconds. */
const HOLD_MS = 1_500;
/** The most the target may move over the hold window, in CSS pixels. */
const HOLD_TOLERANCE_PX = 2;
/** The p95 budget from click to the row being placed and staying placed. */
const SETTLE_P95_BUDGET_MS = 200;
/** The ceiling on how long the probe waits for a landing before calling it a miss. */
const LANDING_WAIT_MS = 4_000;

type OutlineTurn = { id: string; index: number; timestamp: string; preview: string };
type ViewportSpec = (typeof VIEWPORTS)[number];

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

/** The outline turn for a 1-indexed displayed turn number, matched on its own preview text. */
const turnFor = (turns: OutlineTurn[], displayTurn: number): OutlineTurn => {
  const turn = turns.find((entry) => entry.preview.startsWith(`Turn ${displayTurn}.`))
    ?? turns[displayTurn - 1];
  if (!turn) throw new Error(`no outline turn for turn ${displayTurn}`);
  return turn;
};

/** Opens a seeded session through the sidebar's own link. */
const openSeededSession = async (
  page: Page,
  sessionId: string,
  sessionName: string,
  projectName: string,
) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${projectName}`) }).first();
  // Addressed by its exact href, not by its display name: the two fixtures'
  // names share a prefix (`transcript-jump` / `transcript-jump-tall`), and a
  // hasText match would open the wrong one.
  const sessionLink = () => page.locator(`a[href="/session/${sessionId}"]`);
  await expect(projectRow(), `indexing ${sessionName} must register its project`).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink().isVisible().catch(() => false)) break;
    await projectRow().click();
    try {
      await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
      break;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(sessionLink()).toBeVisible({ timeout: 30_000 });
  await sessionLink().click({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
};

/** Reads a session's outline over the app's own REST route, from inside the page so it carries the auth token. */
const readOutline = (page: Page, sessionId: string): Promise<{ status: number; body: string }> =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/outline`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, sessionId);

/** The transcript row for a turn, addressed by the id the outline reported. */
const rowFor = (page: Page, turnId: string) => page.locator(`[data-message-anchor-id="${turnId}"]`);

/** Reads the pane's geometry once a frame's layout has settled. */
const readGeometry = (page: Page): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number; gap: number }> =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          setTimeout(() => {
            const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
            resolve({
              scrollTop: pane.scrollTop,
              scrollHeight: pane.scrollHeight,
              clientHeight: pane.clientHeight,
              gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
            });
          }, 0);
        });
      }),
  );

/** Waits for the pane to stop moving and returns where it stopped. */
const waitForSettledPane = async (page: Page) => {
  let previous: { scrollTop: number; gap: number } | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readGeometry(page);
    if (previous && Math.abs(current.scrollTop - previous.scrollTop) < 0.5 && Math.abs(current.gap - previous.gap) < 0.5) {
      stable += 1;
      if (stable >= 3) return current;
    } else {
      stable = 0;
    }
    previous = current;
    await page.waitForTimeout(80);
  }
  throw new Error('the transcript pane never stopped moving');
};

/**
 * The in-page probe, installed before the app boots.
 *
 * `__armLandingProbe` starts sampling the row the jump highlights, one sample per
 * animation frame, under a stable id. The `pointerup` listener stamps `t0` — the
 * same origin the task's own on-device readings used — so every latency below is
 * measured from the real input, not from the test runner's round trip. Sampling
 * continues until `__stopLandingProbe`; the spec then reads the whole trace and
 * derives the landing, the settle time and the hold from it.
 */
const installLandingProbe = () => {
  const probe = {
    samples: [] as {
      t: number;
      rowId: string | null;
      rowTop: number | null;
      rowBottom: number | null;
      rowH: number | null;
      paneH: number;
      scrollTop: number;
    }[],
    t0: 0,
    running: false,
  };
  (window as unknown as { __landingProbe: typeof probe }).__landingProbe = probe;

  (window as unknown as { __armLandingProbe: () => void }).__armLandingProbe = () => {
    probe.samples = [];
    probe.t0 = 0;
    probe.running = true;
    const step = () => {
      if (!probe.running) return;
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const row = document.querySelector(
        '[data-message-anchor-id].search-highlight-flash',
      ) as HTMLElement | null;
      if (pane) {
        const paneRect = pane.getBoundingClientRect();
        const rowRect = row ? row.getBoundingClientRect() : null;
        probe.samples.push({
          t: performance.now(),
          rowId: row ? row.getAttribute('data-message-anchor-id') : null,
          rowTop: rowRect ? rowRect.top - paneRect.top : null,
          rowBottom: rowRect ? rowRect.bottom - paneRect.top : null,
          rowH: rowRect ? rowRect.height : null,
          paneH: pane.clientHeight,
          scrollTop: pane.scrollTop,
        });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  (window as unknown as { __stopLandingProbe: () => typeof probe.samples }).__stopLandingProbe = () => {
    probe.running = false;
    return probe.samples;
  };

  // The real input that starts a jump: the pointer coming up on the tick or the
  // track. Recorded in the page, so it is the same clock the samples use.
  window.addEventListener(
    'pointerup',
    () => {
      if (probe.running && probe.t0 === 0) probe.t0 = performance.now();
    },
    true,
  );
};

type ProbeSample = {
  t: number;
  rowId: string | null;
  rowTop: number | null;
  rowBottom: number | null;
  rowH: number | null;
  paneH: number;
  scrollTop: number;
};

type LandingReading = {
  landed: boolean;
  targetId: string | null;
  settleMs: number | null;
  holdPx: number | null;
  holdDurationMs: number | null;
  centerOffsetPx: number | null;
  rowHeightPx: number | null;
  frames: number;
  /** The target row's position each ~40ms, for the evidence log. */
  timeline?: string;
};

/**
 * Derives the landing reading from the probe's trace.
 *
 * The target is the row the last samples carry — the row the jump highlighted.
 * It counts as landed only if it ended fully inside the pane and had stopped
 * moving: the reading walks back from the end over the final run in which the
 * row was fully visible and never moved more than the hold tolerance from one
 * frame to the next, and requires that run to cover the whole hold window. The
 * settle time is when that run began, measured from the pointerup — so a row
 * that was briefly visible and then pushed around is credited with the moment it
 * really came to rest, not the moment it first appeared. A row that never
 * stabilised is a miss.
 */
function analyseLanding(samples: ProbeSample[], t0: number): LandingReading {
  const empty: LandingReading = {
    landed: false, targetId: null, settleMs: null, holdPx: null, holdDurationMs: null,
    centerOffsetPx: null, rowHeightPx: null, frames: 0,
  };
  if (!(t0 > 0)) return empty;
  const post = samples.filter((sample) => sample.t >= t0);
  const withRow = post.filter((sample) => sample.rowId !== null);
  if (withRow.length === 0) return empty;
  const targetId = withRow[withRow.length - 1].rowId;
  const rows = post.filter((sample) => sample.rowId === targetId && sample.rowTop !== null);
  if (rows.length < 3) return { ...empty, targetId, frames: rows.length };
  const fully = (sample: ProbeSample) => sample.rowTop! >= -1 && sample.rowBottom! <= sample.paneH + 1;

  // The final run in which the row was placed and still.
  let start = rows.length - 1;
  while (start > 0) {
    const previous = rows[start - 1];
    const current = rows[start];
    if (fully(previous) && fully(current) && Math.abs(current.rowTop! - previous.rowTop!) <= HOLD_TOLERANCE_PX) {
      start -= 1;
    } else {
      break;
    }
  }
  if (!fully(rows[start])) return { ...empty, targetId, frames: rows.length };

  const after = rows.slice(start);
  const tops = after.map((sample) => sample.rowTop!);
  const final = rows[rows.length - 1];
  const holdDurationMs = Math.round(after[after.length - 1].t - after[0].t);
  const holdPx = Number((Math.max(...tops) - Math.min(...tops)).toFixed(2));
  return {
    landed: holdPx <= HOLD_TOLERANCE_PX && holdDurationMs >= HOLD_MS - 150,
    targetId,
    settleMs: Math.round(rows[start].t - t0),
    holdPx,
    holdDurationMs,
    centerOffsetPx: Number((((final.rowTop! + final.rowBottom!) / 2) - final.paneH / 2).toFixed(1)),
    rowHeightPx: final.rowH,
    frames: rows.length,
  };
}

/** A compact per-frame timeline of the target row, for the evidence log. */
function landingTimeline(samples: ProbeSample[], t0: number): string {
  const post = samples.filter((sample) => sample.t >= t0 && sample.rowId !== null);
  const withRow = post.filter((sample) => sample.rowTop !== null);
  if (withRow.length === 0) return 'no target row observed';
  const targetId = withRow[withRow.length - 1].rowId;
  const rows = withRow.filter((sample) => sample.rowId === targetId);
  const points: string[] = [];
  let lastLogged = -Infinity;
  for (const sample of rows) {
    const elapsed = sample.t - t0;
    if (elapsed - lastLogged < 40) continue;
    lastLogged = elapsed;
    points.push(`${Math.round(elapsed)}:${Math.round(sample.rowTop!)}`);
  }
  return points.join(' ');
}

/** The percentile of a sorted copy, nearest-rank. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

/**
 * Drops any highlight left by an earlier jump.
 *
 * A jump's highlight lasts four seconds, and the probe reads the highlighted
 * row, so two jumps inside that window (every click here is) would leave two
 * rows marked and the probe could sample the wrong one. Clearing first makes the
 * only highlighted row the one the next click lands on.
 */
const clearHighlights = (page: Page) =>
  page.evaluate(() => {
    for (const row of Array.from(document.querySelectorAll('.search-highlight-flash'))) {
      row.classList.remove('search-highlight-flash');
    }
  });

/** Starts a probe, performs a real click, waits for the landing and the hold, returns the reading. */
const measureJump = async (page: Page, click: () => Promise<void>): Promise<LandingReading> => {
  await clearHighlights(page);
  await page.evaluate(() => (window as unknown as { __armLandingProbe: () => void }).__armLandingProbe());
  await click();
  // Wait for the row to be fully visible AND still for a run of frames, not just
  // visible once: the placement is what the correction then holds.
  const deadline = Date.now() + LANDING_WAIT_MS;
  let settled = false;
  while (Date.now() < deadline) {
    settled = await page.evaluate((tolerance) => {
      const probe = (window as unknown as {
        __landingProbe: { samples: ProbeSample[]; t0: number };
      }).__landingProbe;
      const post = probe.samples.filter((sample) => probe.t0 > 0 && sample.t >= probe.t0 && sample.rowId !== null && sample.rowTop !== null);
      if (post.length < 8) return false;
      const id = post[post.length - 1].rowId;
      const rows = post.filter((sample) => sample.rowId === id);
      if (rows.length < 8) return false;
      const tail = rows.slice(-8);
      for (let index = 0; index < tail.length; index += 1) {
        const sample = tail[index];
        const fully = sample.rowTop! >= -1 && sample.rowBottom! <= sample.paneH + 1;
        if (!fully) return false;
        if (index > 0 && Math.abs(sample.rowTop! - tail[index - 1].rowTop!) > tolerance) return false;
      }
      return true;
    }, HOLD_TOLERANCE_PX);
    if (settled) break;
    await page.waitForTimeout(40);
  }
  // Hold: keep sampling for the whole window, then read the trace.
  await page.waitForTimeout(HOLD_MS + 120);
  const trace = await page.evaluate(() => (window as unknown as { __stopLandingProbe: () => ProbeSample[] }).__stopLandingProbe());
  const t0 = await page.evaluate(() => (window as unknown as { __landingProbe: { t0: number } }).__landingProbe.t0);
  return { ...analyseLanding(trace, t0), timeline: landingTimeline(trace, t0) };
};

/** Clicks the scrollbar track at a fraction of its height, avoiding the thumb. */
const clickTrackAt = async (page: Page, fraction: number) => {
  const track = page.locator('[data-scrollbar-track]');
  const box = await track.boundingBox();
  if (!box) throw new Error('the scrollbar track has no box to click');
  let y = box.y + Math.max(6, Math.min(box.height - 6, fraction * box.height));
  const thumb = await page.locator('[data-scrollbar-thumb]').boundingBox();
  if (thumb && y > thumb.y - 6 && y < thumb.y + thumb.height + 6) {
    y = thumb.y > box.y + box.height / 2 ? box.y + box.height * 0.15 : box.y + box.height * 0.85;
  }
  await page.mouse.click(box.x + box.width / 2, y);
};

/** The turn ids the tick column is drawing right now. */
const drawnTickIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-turn-tick]'))
      .map((tick) => tick.getAttribute('data-turn-id') ?? '')
      .filter((id) => id.length > 0),
  );

/** Clicks a drawn tick with a real mouse, at its own box centre. */
const clickTick = async (page: Page, turnId: string) => {
  const box = await page.locator(`[data-turn-id="${turnId}"]`).boundingBox();
  if (!box) throw new Error(`the rail is not drawing a tick for ${turnId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/**
 * Drives one viewport's eight jumps.
 *
 * The phone has no tick column, so every jump is a track click. The tablet and
 * the wide desktop click ticks: one track click parks the window in the middle
 * of the conversation, which re-centres the tick column there, and the remaining
 * seven jumps click ticks the column is drawing — the same "click a tick" the
 * contract names, without walking the window across hundreds of turns.
 */
const runViewportJumps = async (
  page: Page,
  viewport: ViewportSpec,
  turns: OutlineTurn[],
): Promise<LandingReading[]> => {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(200);
  const readings: LandingReading[] = [];

  if (viewport.mode === 'track') {
    for (let index = 0; index < CLICKS_PER_VIEWPORT; index += 1) {
      const fraction = 0.15 + (index / CLICKS_PER_VIEWPORT) * 0.7;
      const reading = await measureJump(page, () => clickTrackAt(page, fraction));
      readings.push(reading);
    }
    return readings;
  }

  // Park the tick column mid-conversation, then click the ticks it draws.
  const parked = await measureJump(page, () => clickTrackAt(page, 0.4 + Math.random() * 0.2));
  readings.push(parked);
  const used = new Set<string>(parked.targetId ? [parked.targetId] : []);
  let guard = 0;
  while (readings.length < CLICKS_PER_VIEWPORT && guard < 60) {
    guard += 1;
    const drawn = await drawnTickIds(page);
    const candidate = drawn.find((id) => !used.has(id) && turns.some((turn) => turn.id === id));
    if (!candidate) {
      // The window's ticks are all spent; move the window with the track.
      const reading = await measureJump(page, () => clickTrackAt(page, 0.2 + Math.random() * 0.6));
      readings.push(reading);
      if (reading.targetId) used.add(reading.targetId);
      continue;
    }
    used.add(candidate);
    const reading = await measureJump(page, () => clickTick(page, candidate));
    readings.push(reading);
  }
  return readings;
};

test.describe.configure({ mode: 'serial', timeout: 600_000 });

test.describe('transcript jump landing on tall rows', () => {
  let page: Page;
  let tallTurns: OutlineTurn[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    await page.addInitScript(installLandingProbe);
    await page.bringToFront();
    await page.setViewportSize({ width: ALL_VIEWPORTS[1].width, height: ALL_VIEWPORTS[1].height });

    await ensureSignedIn(page);
    await settleServiceWorker(page);
    await openSeededSession(page, TALL_SESSION_ID, TALL_SESSION_NAME, TALL_PROJECT_NAME);
    await waitForSettledPane(page);

    const outline = await readOutline(page, TALL_SESSION_ID);
    expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
    tallTurns = (JSON.parse(outline.body) as { data?: { turns?: OutlineTurn[] } }).data?.turns ?? [];
    expect(tallTurns.length, 'the tall outline must carry every user turn of the seeded session').toBe(TALL_TOTAL_TURNS);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('AC-221 every jump lands on its target and holds there, on the tall fixture', async () => {
    test.setTimeout(600_000);
    const allReadings: { viewport: string; reading: LandingReading }[] = [];
    for (const viewport of VIEWPORTS) {
      const readings = await runViewportJumps(page, viewport, tallTurns);
      for (const reading of readings) allReadings.push({ viewport: viewport.name, reading });
    }

    const settleTimes = allReadings
      .map(({ reading }) => reading.settleMs)
      .filter((value): value is number => value !== null);
    const p95 = percentile(settleTimes, 0.95);
    console.log('[AC-221] landings:', JSON.stringify(allReadings.map(({ viewport, reading }) => ({
      viewport,
      landed: reading.landed,
      settleMs: reading.settleMs,
      holdPx: reading.holdPx,
      holdDurationMs: reading.holdDurationMs,
      centerOffsetPx: reading.centerOffsetPx,
      rowHeightPx: reading.rowHeightPx,
      timeline: reading.timeline,
    })), null, 0));
    console.log(`[AC-221] clicks=${allReadings.length} settle p50=${percentile(settleTimes, 0.5)}ms p95=${p95}ms max=${Math.max(0, ...settleTimes)}ms`);

    const missed = allReadings.filter(({ reading }) => !reading.landed);
    expect(
      missed,
      `every click must land its target row fully inside the viewport; these did not: ${JSON.stringify(missed.map(({ viewport, reading }) => ({ viewport, targetId: reading.targetId, frames: reading.frames })))}`,
    ).toEqual([]);

    const drifting = allReadings.filter(({ reading }) => reading.landed && (reading.holdPx ?? Infinity) > HOLD_TOLERANCE_PX);
    expect(
      drifting,
      `the target must stay within ${HOLD_TOLERANCE_PX}px for ${HOLD_MS}ms after landing; these moved: ${JSON.stringify(drifting.map(({ viewport, reading }) => ({ viewport, holdPx: reading.holdPx })))}`,
    ).toEqual([]);

    expect(
      p95,
      `click-to-settle p95 must be ≤${SETTLE_P95_BUDGET_MS}ms across ${allReadings.length} clicks (settle times: ${JSON.stringify(settleTimes)})`,
    ).toBeLessThanOrEqual(SETTLE_P95_BUDGET_MS);
  });

  test('AC-221 a real input during the correction window is not overwritten', async () => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: ALL_VIEWPORTS[2].width, height: ALL_VIEWPORTS[2].height });
    await page.waitForTimeout(200);

    // A jump, then a wheel immediately after it lands — inside the window the
    // correction is armed for. The wheel's offset must stand.
    const parked = await measureJump(page, () => clickTrackAt(page, 0.5));
    expect(parked.landed, 'the jump before the gesture must land').toBe(true);

    await clearHighlights(page);
    await page.evaluate(() => (window as unknown as { __armLandingProbe: () => void }).__armLandingProbe());
    const track = page.locator('[data-scrollbar-track]');
    const box = await track.boundingBox();
    if (!box) throw new Error('the scrollbar track has no box');
    const paneBox = await page.locator(PANE).boundingBox();
    if (!paneBox) throw new Error('the pane has no box');
    await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.55);
    // Land first, then take the pane back with a wheel while the window is open.
    await page.waitForTimeout(250);
    const beforeWheel = await readGeometry(page);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(400);
    // The offset the wheel asked for must still be there, and the jumped-to row
    // must no longer be centred — a live correction would have pulled both back.
    const afterWindow = await page.evaluate(() => {
      const probe = (window as unknown as {
        __landingProbe: { samples: { rowId: string | null }[] };
      }).__landingProbe;
      const withId = probe.samples.filter((sample) => sample.rowId !== null);
      const targetId = withId.length > 0 ? withId[withId.length - 1].rowId : null;
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
      const row = targetId
        ? (document.querySelector(`[data-message-anchor-id="${CSS.escape(targetId)}"]`) as HTMLElement | null)
        : null;
      const paneRect = pane.getBoundingClientRect();
      const rowRect = row ? row.getBoundingClientRect() : null;
      return {
        scrollTop: pane.scrollTop,
        targetId,
        paneRect: { top: Math.round(paneRect.top), bottom: Math.round(paneRect.bottom), height: pane.clientHeight, scrollHeight: pane.scrollHeight },
        rowRect: rowRect ? { top: Math.round(rowRect.top), bottom: Math.round(rowRect.bottom) } : null,
        rowCenterOffset: rowRect ? Math.round((rowRect.top + rowRect.bottom) / 2 - (paneRect.top + paneRect.bottom) / 2) : null,
      };
    });
    await page.evaluate(() => (window as unknown as { __stopLandingProbe: () => unknown }).__stopLandingProbe());
    console.log(`[AC-221] input release: before=${beforeWheel.scrollTop} after=${JSON.stringify(afterWindow)}`);
    expect(
      Math.abs(afterWindow.scrollTop - beforeWheel.scrollTop),
      'the offset a wheel asked for must stand 400ms later — the correction must not pull the pane back to where it was',
    ).toBeGreaterThan(100);
    expect(
      afterWindow.rowCenterOffset === null ? Infinity : Math.abs(afterWindow.rowCenterOffset),
      'the jumped-to row must no longer be centred after the user wheeled away from it',
    ).toBeGreaterThan(100);
  });

  test('AC-221 never-measured placeholders carry the transcript estimate, not the flat constant', async () => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: ALL_VIEWPORTS[1].width, height: ALL_VIEWPORTS[1].height });
    await page.waitForTimeout(200);
    // Park mid-conversation so the window is full of unmounted placeholder rows.
    await clickTrackAt(page, 0.5);
    await page.waitForTimeout(400);

    const reading = await page.evaluate(() => {
      const content = document.querySelector('[data-transcript-content]');
      const placeholders: number[] = [];
      const measured: number[] = [];
      for (const row of Array.from(content?.children ?? []) as HTMLElement[]) {
        if (!row.hasAttribute('data-message-timestamp')) continue;
        const height = row.getBoundingClientRect().height;
        if (height <= 0) continue;
        if (row.hasAttribute('data-row-measured')) measured.push(height);
        else placeholders.push(height);
      }
      const track = document.querySelector('[data-scrollbar-track]');
      const estimate = Number.parseFloat(track?.getAttribute('data-px-per-message') ?? '0');
      return { placeholders, measured, estimate };
    });
    const placeholderMedian = percentile(reading.placeholders, 0.5);
    console.log('[AC-221] placeholder reading:', JSON.stringify({
      placeholderCount: reading.placeholders.length,
      measuredCount: reading.measured.length,
      estimate: reading.estimate,
      placeholderMedian,
      measuredMedian: percentile(reading.measured, 0.5),
    }));
    expect(reading.placeholders.length, 'the parked window must hold unmounted placeholder rows to read').toBeGreaterThan(2);
    expect(reading.estimate, 'the rail must publish its px-per-message estimate').toBeGreaterThan(0);
    // The estimate is the pane's own px-per-message, so a 1-message placeholder
    // must be about that; the flat 100px constant is what the mutation restores,
    // and it sits far below the tall fixture's estimate.
    expect(
      placeholderMedian,
      `a never-measured placeholder must carry the transcript estimate (${reading.estimate}px/message), not 100px; median was ${placeholderMedian} of ${JSON.stringify(reading.placeholders)}`,
    ).toBeGreaterThan(reading.estimate * 0.6);
    expect(placeholderMedian).toBeLessThan(reading.estimate * 1.4);
  });

  test('AC-221 the short-row fixture still lands (control)', async () => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: ALL_VIEWPORTS[2].width, height: ALL_VIEWPORTS[2].height });
    const outline = await readOutline(page, SHORT_SESSION_ID);
    expect(outline.status).toBe(200);
    const turns = (JSON.parse(outline.body) as { data?: { turns?: OutlineTurn[] } }).data?.turns ?? [];
    expect(turns.length).toBe(SHORT_TOTAL_TURNS);

    await openSeededSession(page, SHORT_SESSION_ID, SHORT_SESSION_NAME, SHORT_PROJECT_NAME);
    await waitForSettledPane(page);

    const readings: LandingReading[] = [];
    for (const fraction of [0.25, 0.5, 0.75]) {
      readings.push(await measureJump(page, () => clickTrackAt(page, fraction)));
    }
    console.log('[AC-221] short-fixture landings:', JSON.stringify(readings));
    const missed = readings.filter((reading) => !reading.landed);
    expect(missed, `short-fixture jumps must still land: ${JSON.stringify(missed)}`).toEqual([]);
    const drifting = readings.filter((reading) => (reading.holdPx ?? Infinity) > HOLD_TOLERANCE_PX);
    expect(drifting, `short-fixture jumps must still hold: ${JSON.stringify(drifting)}`).toEqual([]);
  });
});
