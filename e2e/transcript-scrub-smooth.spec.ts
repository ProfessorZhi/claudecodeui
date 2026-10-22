import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-218: scrubbing the drawn scrollbar moves the transcript with the pointer,
// frame by frame; the release settles at once instead of paying a rest pause and
// a fixed placement timer; the thumb tracks the transcript continuously instead
// of in turn-sized stairs; and the window reads a drag needs are serialised
// (one in flight, newest position wins) rather than fired concurrently.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir), on the shared long fixture seeded by
// `seedTranscriptJumpTranscript` — 1200 user turns, four drawn rows per turn.
// Every reading comes from in-page instrumentation: `performance.now()` at the
// pointer events, a start/end-stamped fetch log, and a per-frame rAF sampler of
// `scrollTop` and the thumb's own `data-scroll-progress`. No wall clock, and no
// pixel-derived position: the content's position is the absolute ordinal of the
// turn at the viewport's top edge, read from the outline the server reports.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-jump';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-jump';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-jump-workspace';
/** Fixed desktop viewport, so the rail lays out and the pane is a known size. */
const VIEWPORT = { width: 1280, height: 1200 };
/** The criterion's ceiling, from pointerup to the last scroll change. */
const SETTLE_P95_MS = 150;
/** The in-window ceiling, where nothing has to be read. */
const IN_WINDOW_SETTLE_P95_MS = 100;
/** The share of frames that must have the content within this of the thumb, after the first stretch. */
const FOLLOW_TOLERANCE = 0.03;
/** Frames before this long after the drag began are not judged — the first read is still landing. */
const FOLLOW_WARMUP_MS = 250;
/** The largest share of the track the thumb may jump between adjacent sampled frames. */
const MAX_THUMB_JUMP = 0.005;
/** One wheel tick for the continuity gesture, in CSS pixels. */
const WHEEL_STEP_PX = 260;
/** The frame interval ceiling, in milliseconds. */
const FRAME_P95_MS = 33;

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

/**
 * The in-page instruments every reading in this file comes from.
 *
 * Installed before the app loads so no request or pointer is missed: a fetch log
 * with a start and an end per `/messages` call (the interval check the discipline
 * leg needs), the pointer down/up instants, and a rAF sampler that records
 * `scrollTop`, the thumb's own `data-scroll-progress`, and the content's ordinal
 * fraction — the absolute subscript of the turn at the viewport's top edge,
 * resolved against the outline the page stores under `__ordinalById`.
 */
const instrument = () => {
  const w = window as unknown as Record<string, any>;
  w.__scrubFetches = [];
  const originalFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/messages')) return originalFetch(input, init);
    const record = { url, start: performance.now(), end: -1 };
    w.__scrubFetches.push(record);
    const pending = originalFetch(input, init);
    const finish = () => {
      if (record.end < 0) record.end = performance.now();
    };
    pending.then(finish, finish);
    return pending;
  }) as typeof window.fetch;

  w.__ordinalById = {};
  w.__lastTurnIndex = 1;
  w.__lastPointerDown = -1;
  w.__lastPointerUp = -1;
  window.addEventListener('pointerdown', () => {
    w.__lastPointerDown = performance.now();
  }, true);
  window.addEventListener('pointerup', () => {
    w.__lastPointerUp = performance.now();
  }, true);

  w.__samples = [];
  w.__sampling = false;
  w.__scrollEvents = 0;
  window.addEventListener('scroll', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && target.classList && target.classList.contains('chat-messages-pane')) w.__scrollEvents += 1;
  }, true);
  w.__startSampler = () => {
    w.__samples = [];
    w.__sampling = true;
    let last = performance.now();
    const tick = () => {
      if (!w.__sampling) return;
      const now = performance.now();
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const thumb = document.querySelector('[data-scrollbar-thumb]');
      let contentFraction: number | null = null;
      if (pane) {
        const paneTop = pane.getBoundingClientRect().top;
        // The rows are in transcript order and their tops increase together, so
        // the sampler itself must not scan them: a per-frame instrument that
        // costs O(rows) would distort the frame interval it is measuring.
        const rows = Array.from(pane.querySelectorAll('[data-message-anchor-id]'));
        let lo = 0;
        let hi = rows.length - 1;
        let found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if ((rows[mid] as HTMLElement).getBoundingClientRect().top <= paneTop + 1) {
            found = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        const current = found >= 0 ? rows[found].getAttribute('data-message-anchor-id') : null;
        const ordinal = current === null ? null : w.__ordinalById[current];
        contentFraction = typeof ordinal === 'number' ? ordinal / w.__lastTurnIndex : null;
      }
      w.__samples.push({
        t: now,
        dt: now - last,
        top: pane ? pane.scrollTop : Number.NaN,
        height: pane ? pane.scrollHeight : Number.NaN,
        progress: thumb ? Number(thumb.getAttribute('data-scroll-progress')) : Number.NaN,
        contentFraction,
      });
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  w.__stopSampler = () => {
    w.__sampling = false;
    return w.__samples;
  };
};

type Sample = { t: number; dt: number; top: number; height: number; progress: number; contentFraction: number | null };
type FetchRecord = { url: string; start: number; end: number };
type OutlineTurn = { id: string; index: number; timestamp: string; preview: string };

/** The sidebar row for the seeded session. */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/** Opens the seeded session through the sidebar's own link. */
const openSeededSession = async (page: Page) => {
  const link = sessionLink(page);
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await link.isVisible().catch(() => false)) break;
    await projectRow().click();
    try {
      await expect(link).toBeVisible({ timeout: 10_000 });
      break;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(link).toBeVisible({ timeout: 30_000 });
  await link.click({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
};

/** Reads the session's outline from inside the page and stores its ordinal map for the sampler. */
const installOutline = async (page: Page): Promise<{ turns: OutlineTurn[]; total: number }> => {
  const outline = await page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/outline`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, SESSION_ID);
  expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
  const data = (JSON.parse(outline.body) as { data?: { total?: number; turns?: OutlineTurn[] } }).data;
  const turns = data?.turns ?? [];
  const total = data?.total ?? 0;
  await page.evaluate(({ entries, count }) => {
    const w = window as unknown as Record<string, any>;
    w.__ordinalById = Object.fromEntries(entries.map((entry: OutlineTurn) => [entry.id, entry.index]));
    w.__lastTurnIndex = entries.length > 0 ? entries[entries.length - 1].index : Math.max(1, count - 1);
  }, { entries: turns, count: total });
  return { turns, total };
};

type TrackBox = { top: number; height: number; thumbTop: number; thumbH: number; x: number };

/** The track and thumb geometry, read together so a drag's y positions are self-consistent. */
const readTrackBox = (page: Page): Promise<TrackBox> =>
  page.evaluate(() => {
    const track = document.querySelector('[data-scrollbar-track]') as HTMLElement;
    const thumb = document.querySelector('[data-scrollbar-thumb]') as HTMLElement;
    const t = track.getBoundingClientRect();
    const b = thumb.getBoundingClientRect();
    return { top: t.top, height: t.height, thumbTop: b.top, thumbH: b.height, x: b.left + b.width / 2 };
  });

/** The y a fraction names, inverting the thumb's own centre-anchored geometry. */
const yForFraction = (box: TrackBox, fraction: number): number => {
  const travel = Math.max(1, box.height - box.thumbH);
  return box.top + box.thumbH / 2 + fraction * travel;
};

/**
 * Drags the thumb to a fraction with the real mouse and returns the in-page
 * readings for the gesture: the pointerup instant, the samples, and the fetch log.
 */
const dragTo = async (
  page: Page,
  fraction: number,
  options: { steps?: number; stepMs?: number; holdMs?: number } = {},
) => {
  const { steps = 30, stepMs = 20, holdMs = 500 } = options;
  const box = await readTrackBox(page);
  const startY = box.thumbTop + box.thumbH / 2;
  const endY = yForFraction(box, fraction);
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    w.__scrubFetches.length = 0;
    w.__lastPointerDown = -1;
    w.__lastPointerUp = -1;
    w.__startSampler();
  });
  await page.mouse.move(box.x, startY);
  await page.mouse.down();
  for (let index = 1; index <= steps; index += 1) {
    await page.mouse.move(box.x, startY + ((endY - startY) * index) / steps);
    if (stepMs > 0) await page.waitForTimeout(stepMs);
  }
  if (holdMs > 0) await page.waitForTimeout(holdMs);
  await page.mouse.up();
  return { endY };
};

/** Waits for the pane to stop moving, then reads the whole gesture's instruments. */
const settleAndRead = async (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ tUp: number; samples: Sample[]; fetches: FetchRecord[] }>((resolve) => {
        const w = window as unknown as Record<string, any>;
        const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
        let lastTop = pane.scrollTop;
        let stable = 0;
        let frames = 0;
        const tick = () => {
          frames += 1;
          if (pane.scrollTop === lastTop) stable += 1;
          else {
            stable = 0;
            lastTop = pane.scrollTop;
          }
          // A bounded wait, so a reading that never stops moving reports its
          // samples rather than hanging the case.
          if (stable >= 20 || frames > 400) {
            resolve({ tUp: w.__lastPointerUp, samples: w.__stopSampler(), fetches: w.__scrubFetches.slice() });
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

/** The last time `scrollTop` changed at or after the pointerup, in milliseconds after it. */const settleMsAfterRelease = (samples: Sample[], tUp: number): number => {
  let last = -1;
  for (let index = 1; index < samples.length; index += 1) {
    const sample = samples[index];
    if (sample.t < tUp) continue;
    if (sample.top !== samples[index - 1].top) last = sample.t;
  }
  return last < 0 ? 0 : Math.round(last - tUp);
};

/** The `around` id of a messages request, or null for a tail page. */
const aroundOf = (url: string): string | null => new URL(url, 'http://localhost').searchParams.get('around');

/** The p95 of a numeric reading, in the given unit. */
const p95 = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))];
};

/** The p95 frame interval over a span of samples. */
const frameP95 = (samples: Sample[]): number => p95(samples.slice(1).map((sample) => sample.dt));

/** The turn of the outline nearest a fraction of the conversation. */
const turnAt = (turns: OutlineTurn[], fraction: number, lastTurnIndex: number): OutlineTurn => {
  const target = fraction * lastTurnIndex;
  let nearest = turns[0];
  for (const turn of turns) {
    if (Math.abs(turn.index - target) < Math.abs(nearest.index - target)) nearest = turn;
  }
  return nearest;
};

/** The first anchored row of the loaded window, as a fraction of the conversation. */
const windowFirstRowFraction = async (page: Page, turns: OutlineTurn[], lastTurnIndex: number): Promise<number | null> =>
  page.evaluate(({ map }) => {
    const element = document.querySelector('.chat-messages-pane [data-message-anchor-id]');
    const id = element ? element.getAttribute('data-message-anchor-id') : null;
    return id === null ? null : (map[id] ?? null);
  }, { map: Object.fromEntries(turns.map((turn) => [turn.id, turn.index / lastTurnIndex])) });

/**
 * Where the loaded window is, in conversation fractions: its first and last
 * turn row, and the turn the viewport's top edge sits on. The in-window drag leg
 * aims inside this span — that is what "a position reachable within the loaded
 * window" means.
 */
const readScrubCoverage = (page: Page): Promise<{ contentFraction: number; min: number; max: number }> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const w = window as unknown as Record<string, any>;
    const last = w.__lastTurnIndex as number;
    const paneTop = pane.getBoundingClientRect().top;
    const rows = Array.from(pane.querySelectorAll('[data-message-anchor-id]')) as HTMLElement[];
    let first: number | null = null;
    let top: number | null = null;
    let current: number | null = null;
    for (const row of rows) {
      const ordinal = w.__ordinalById[row.getAttribute('data-message-anchor-id') ?? ''];
      if (typeof ordinal !== 'number') continue;
      if (first === null) first = ordinal;
      top = ordinal;
      if (row.getBoundingClientRect().top <= paneTop + 1) current = ordinal;
      else break;
    }
    return {
      contentFraction: (current ?? first ?? 0) / last,
      min: (first ?? 0) / last,
      max: (top ?? 0) / last,
    };
  });

/** Whether any `/messages` request's interval overlaps another's. */
const overlappingInterval = (fetches: FetchRecord[]): FetchRecord | null => {
  const spanning = fetches.map((fetch) => ({ ...fetch, end: fetch.end < 0 ? Number.POSITIVE_INFINITY : fetch.end }));
  spanning.sort((a, b) => a.start - b.start);
  for (let index = 1; index < spanning.length; index += 1) {
    if (spanning[index].start < spanning[index - 1].end) return spanning[index];
  }
  return null;
};

test.describe.configure({ mode: 'serial', timeout: 420_000 });

test('AC-218 scrubbing follows the pointer, settles on release, and keeps the thumb continuous', async ({ page }) => {
  test.setTimeout(420_000);
  const clientUrl = test.info().project.use.baseURL;
  if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
  await warmClientStartup(clientUrl);

  await page.addInitScript(instrument);
  await page.setViewportSize(VIEWPORT);
  await ensureSignedIn(page);
  await settleServiceWorker(page);
  await openSeededSession(page);
  await page.waitForTimeout(2_000);

  const { turns, total } = await installOutline(page);
  expect(turns.length, 'the outline must carry every user turn of the seeded session').toBeGreaterThan(100);
  const lastTurnIndex = turns[turns.length - 1].index;
  expect(lastTurnIndex, 'the outline must report absolute message subscripts').toBeGreaterThan(total / 2);
  const windowFraction = 100 / lastTurnIndex;

  // ── (a) the content follows the pointer, frame by frame ────────────────────
  // A real mouse drag from the tail to the middle of the track, in the
  // criterion's own cadence, then held still so a rebound would show.
  const far = await dragTo(page, 0.5, { steps: 30, stepMs: 20, holdMs: 500 });
  const farRead = await settleAndRead(page);
  const farSamples = farRead.samples;
  const farDuring = farSamples.filter((sample) => sample.t < farRead.tUp);
  const topChanges = farDuring.filter((sample, index) => index > 0 && sample.top !== farDuring[index - 1].top).length;
  expect(topChanges, `dragging must move the content while the pointer moves: ${JSON.stringify({ samples: farDuring.length, topChanges })}`)
    .toBeGreaterThan(0);

  const tDown = await page.evaluate(() => (window as unknown as Record<string, any>).__lastPointerDown);
  const judged = farSamples.filter(
    (sample) => sample.t >= tDown + FOLLOW_WARMUP_MS && sample.t <= farRead.tUp + 50 && sample.contentFraction !== null,
  );
  const agreeing = judged.filter(
    (sample) => Math.abs(sample.progress - (sample.contentFraction as number)) <= FOLLOW_TOLERANCE,
  ).length;
  const movePhase = farSamples.filter((sample) => sample.t >= tDown && sample.t <= farRead.tUp - 500);
  const holdPhase = farSamples.filter((sample) => sample.t > farRead.tUp - 500 && sample.t <= farRead.tUp);
  console.log(`AC-218 (a) readings ${JSON.stringify({
    topChanges,
    judged: judged.length,
    agreeing,
    share: judged.length > 0 ? agreeing / judged.length : 0,
    frameP95: frameP95(farSamples),
    moveP95: frameP95(movePhase),
    holdP95: frameP95(holdPhase),
    over33: farSamples.filter((sample) => sample.dt > 33).length,
    frames: farSamples.length,
    fetches: farRead.fetches.length,
    worst: judged
      .map((sample) => Math.abs(sample.progress - (sample.contentFraction as number)))
      .sort((a, b) => b - a)
      .slice(0, 6)
      .map((value) => Number(value.toFixed(3))),
    fetchAt: farRead.fetches.slice(0, 40).map((fetch) => {
      const id = aroundOf(fetch.url);
      const turn = turns.find((entry) => entry.id === id);
      return turn ? Number((turn.index / lastTurnIndex).toFixed(3)) : null;
    }),
  })}`);
  expect(
    judged.length,
    `the drag must have produced frames to judge: ${JSON.stringify({ tDown, tUp: farRead.tUp, samples: farSamples.length })}`,
  ).toBeGreaterThan(8);
  expect(
    agreeing / judged.length,
    `after warm-up the content must sit within ${FOLLOW_TOLERANCE} of the thumb in >=90% of frames: ${JSON.stringify({
      judged: judged.length,
      agreeing,
    })}`,
  ).toBeGreaterThanOrEqual(0.9);
  expect(frameP95(farSamples), `frame interval p95 must stay under ${FRAME_P95_MS}ms during the drag`).toBeLessThanOrEqual(FRAME_P95_MS);

  // ── (b) reads are serialised, and only the released position survives ──────
  const overlap = overlappingInterval(farRead.fetches);
  expect(
    overlap,
    `no two /messages requests may overlap while scrubbing: ${JSON.stringify(farRead.fetches.map((fetch) => ({ start: Math.round(fetch.start), end: Math.round(fetch.end), around: aroundOf(fetch.url) })))}`,
  ).toBeNull();
  const releasedTurn = turnAt(turns, 0.5, lastTurnIndex);
  const requestsAroundReleased = farRead.fetches.filter(
    (fetch) => fetch.start >= farRead.tUp && aroundOf(fetch.url) === releasedTurn.id,
  );
  expect(
    requestsAroundReleased.length,
    `the released position may be read at most once: ${JSON.stringify(farRead.fetches.filter((fetch) => fetch.start >= farRead.tUp).map((fetch) => fetch.url))}`,
  ).toBeLessThanOrEqual(1);
  // The window the release settled on is the one read for the released position:
  // a stale window from an earlier pointer position would leave the loaded
  // window's own first row far from it.
  const farFirstRow = await windowFirstRowFraction(page, turns, lastTurnIndex);
  expect(farFirstRow, 'the loaded window must expose its first row after the drag').not.toBeNull();
  expect(
    farFirstRow!,
    `the settled window must be the one around the released position: ${JSON.stringify({ farFirstRow, releasedTurn: releasedTurn.index / lastTurnIndex })}`,
  ).toBeGreaterThanOrEqual(0.5 - 2 * windowFraction - 0.02);
  expect(farFirstRow!).toBeLessThanOrEqual(0.5 + 0.02);
  expect(far.endY).toBeGreaterThan(0);

  // ── (c) + (d) release latency, far and in-window ───────────────────────────
  const settleReadings: number[] = [];
  const inWindowSettleReadings: number[] = [];
  const releaseAt = async (fraction: number, inWindow: boolean) => {
    await dragTo(page, fraction, { steps: inWindow ? 8 : 18, stepMs: 18, holdMs: inWindow ? 120 : 220 });
    const read = await settleAndRead(page);
    const settle = settleMsAfterRelease(read.samples, read.tUp);
    (inWindow ? inWindowSettleReadings : settleReadings).push(settle);
    const overlapHere = overlappingInterval(read.fetches);
    expect(overlapHere, `released at ${fraction}: requests must not overlap`).toBeNull();
    const turn = turnAt(turns, fraction, lastTurnIndex);
    // "After it settled" with a short grace: the release's last read can land a
    // frame or two after the pane's offset stopped moving, and the criterion asks
    // for the target to be in the viewport once it has.
    await expect
      .poll(async () => page.evaluate((id) => {
        const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
        const row = document.querySelector(`[data-message-anchor-id="${id}"]`) as HTMLElement | null;
        if (!row) return false;
        const p = pane.getBoundingClientRect();
        const r = row.getBoundingClientRect();
        return r.bottom > p.top && r.top < p.bottom;
      }, turn.id), { timeout: 5_000, message: `after releasing at ${fraction} the target turn must be in the viewport` })
      .toBe(true);
    return read;
  };

  await releaseAt(0.2, false);
  await releaseAt(0.8, false);
  await releaseAt(0.5, false);
  await releaseAt(0.35, false);
  await releaseAt(0.65, false);
  expect(settleReadings.length, 'the far releases must number at least the three the criterion names').toBeGreaterThanOrEqual(5);
  // An in-window drag: aim at a position strictly inside the loaded window's own
  // turn rows — the "position reachable within the window" the criterion names —
  // halfway between the content and the farther edge of what is loaded, so the
  // map can place it with no read at all.
  const coverage = await readScrubCoverage(page);
  const towardHigher = coverage.contentFraction <= (coverage.min + coverage.max) / 2;
  const edge = towardHigher ? coverage.max : coverage.min;
  const nudgeTarget = coverage.contentFraction + (edge - coverage.contentFraction) * 0.5;
  const beforeNudge = await page.evaluate(() => (window as unknown as Record<string, any>).__scrubFetches.length);
  await dragTo(page, nudgeTarget, { steps: 8, stepMs: 18, holdMs: 120 });
  const nudgeRead = await settleAndRead(page);
  const nudgeFetches = nudgeRead.fetches.length;
  console.log(`AC-218 (d) readings ${JSON.stringify({
    coverage,
    nudgeTarget,
    nudgeFetches,
    urls: nudgeRead.fetches.map((fetch) => fetch.url),
  })}`);
  expect(
    nudgeFetches,
    `an in-window drag must read nothing: ${JSON.stringify({ coverage, nudgeTarget, fetches: nudgeRead.fetches.map((fetch) => fetch.url) })}`,
  ).toBe(0);
  const nudgeTopChanges = nudgeRead.samples.filter(
    (sample, index) => index > 0 && sample.t < nudgeRead.tUp && sample.top !== nudgeRead.samples[index - 1].top,
  ).length;
  expect(nudgeTopChanges, 'an in-window drag must still move the content').toBeGreaterThan(0);
  inWindowSettleReadings.push(settleMsAfterRelease(nudgeRead.samples, nudgeRead.tUp));
  expect(beforeNudge).toBeGreaterThanOrEqual(0);

  console.log(`AC-218 (b)(c)(d) readings ${JSON.stringify({
    settleFar: settleReadings,
    settleFarP95: p95(settleReadings),
    settleInWindow: inWindowSettleReadings,
    settleInWindowP95: p95(inWindowSettleReadings),
    nudgeFetches,
    nudgeTopChanges,
    nudgeTarget,
    coverage,
    nudgeFrameP95: frameP95(nudgeRead.samples),
    nudgeOver33: nudgeRead.samples.filter((sample) => sample.dt > 33).length,
    nudgeFrames: nudgeRead.samples.length,
  })}`);
  expect(
    p95(settleReadings),
    `pointerup to the last scroll change must be <=${SETTLE_P95_MS}ms at p95: ${JSON.stringify(settleReadings)}`,
  ).toBeLessThanOrEqual(SETTLE_P95_MS);
  expect(
    p95(inWindowSettleReadings),
    `in-window releases must settle within ${IN_WINDOW_SETTLE_P95_MS}ms at p95: ${JSON.stringify(inWindowSettleReadings)}`,
  ).toBeLessThanOrEqual(IN_WINDOW_SETTLE_P95_MS);

  // ── (e) the thumb is continuous through a wheel gesture ────────────────────
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>;
    w.__startSampler();
  });
  const paneBox = await page.locator(PANE).boundingBox();
  if (!paneBox) throw new Error('the transcript pane has no box to wheel over');
  await page.mouse.move(paneBox.x + paneBox.width / 2, paneBox.y + paneBox.height / 2);
  for (let step = 0; step < 30; step += 1) {
    await page.mouse.wheel(0, -WHEEL_STEP_PX);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  const wheelSamples: Sample[] = await page.evaluate(() => (window as unknown as Record<string, any>).__stopSampler());
  const wheelDebug = await page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane');
    const thumb = document.querySelector('[data-scrollbar-thumb]');
    const track = document.querySelector('[data-scrollbar-track]');
    const w = window as unknown as Record<string, any>;
    return {
      anchorRows: pane ? pane.querySelectorAll('[data-message-anchor-id]').length : -1,
      progress: thumb ? thumb.getAttribute('data-scroll-progress') : null,
      dragging: track ? track.getAttribute('data-scrub-dragging') : null,
      ordinalCount: Object.keys(w.__ordinalById ?? {}).length,
      lastTurnIndex: w.__lastTurnIndex,
    };
  });
  console.log(`AC-218 (e) readings ${JSON.stringify({
    topChanging: wheelSamples.filter((sample, index) => index > 0 && sample.top !== wheelSamples[index - 1].top).length,
    contentChanging: wheelSamples.filter((sample, index) => index > 0 && sample.contentFraction !== wheelSamples[index - 1].contentFraction).length,
    // A `scrollTop` change is only the pane moving when it is not fully explained
    // by a content-height change: a lazily-mounted row above the viewport is
    // measured, the browser adjusts the offset to keep the reader in place, and
    // the content — and so the thumb — must not move at all.
    moved: wheelSamples.filter((sample, index) => index > 0 && sample.top !== wheelSamples[index - 1].top
      && (sample.height - wheelSamples[index - 1].height) !== (sample.top - wheelSamples[index - 1].top)).length,
    scrollEvents: await page.evaluate(() => (window as unknown as Record<string, any>).__scrollEvents),
    frames: wheelSamples.length,
    firstProgress: wheelSamples[0]?.progress,
    midProgress: wheelSamples[Math.floor(wheelSamples.length / 2)]?.progress,
    lastProgress: wheelSamples[wheelSamples.length - 1]?.progress,
    distinctProgress: new Set(wheelSamples.map((sample) => sample.progress)).size,
    topRange: [Math.min(...wheelSamples.map((s) => s.top)), Math.max(...wheelSamples.map((s) => s.top))],
    wheelDebug,
  })}`);
  const topChanging = wheelSamples.filter((sample, index) => index > 0 && sample.top !== wheelSamples[index - 1].top);
  // "The pane moved" means the offset changed and the content-height change does
  // not account for it. A lazily-mounted row above the viewport is measured and
  // the browser adjusts `scrollTop` to keep the reader in place — the offset
  // moves, the content does not, and a correct thumb must not move either. Those
  // frames are the criterion's premise, not its subject.
  const moved = wheelSamples.filter((sample, index) => index > 0
    && sample.top !== wheelSamples[index - 1].top
    && (sample.height - wheelSamples[index - 1].height) !== (sample.top - wheelSamples[index - 1].top));
  const thumbMoving = moved.filter((sample) => {
    const at = wheelSamples.indexOf(sample);
    return wheelSamples[at].progress !== wheelSamples[at - 1].progress;
  });
  expect(moved.length, 'the wheel gesture must have moved the pane').toBeGreaterThan(10);
  expect(
    thumbMoving.length / moved.length,
    `the thumb must move in >=90% of the frames the pane moved: ${JSON.stringify({ moved: moved.length, thumbMoving: thumbMoving.length, topChanging: topChanging.length })}`,
  ).toBeGreaterThanOrEqual(0.9);
  let maxJump = 0;
  let monotonicBreaks = 0;
  for (let index = 1; index < wheelSamples.length; index += 1) {
    const delta = wheelSamples[index].progress - wheelSamples[index - 1].progress;
    maxJump = Math.max(maxJump, Math.abs(delta));
    if (delta > 1e-4) monotonicBreaks += 1;
  }
  expect(maxJump, `the thumb may not jump more than ${MAX_THUMB_JUMP} of the track between frames: ${maxJump}`)
    .toBeLessThanOrEqual(MAX_THUMB_JUMP);
  expect(monotonicBreaks, `wheeling up must move the thumb monotonically towards the start: ${monotonicBreaks} breaks`)
    .toBe(0);
  expect(
    wheelSamples[wheelSamples.length - 1].progress,
    `wheeling up must leave the thumb nearer the start than it began: ${JSON.stringify({
      first: wheelSamples[0].progress,
      last: wheelSamples[wheelSamples.length - 1].progress,
    })}`,
  ).toBeLessThan(wheelSamples[0].progress);

  // ── (f) the wheel gesture is not a regression in frame cost ────────────────
  expect(frameP95(wheelSamples), `frame interval p95 must stay under ${FRAME_P95_MS}ms while wheeling`).toBeLessThanOrEqual(FRAME_P95_MS);

  // ── evidence ───────────────────────────────────────────────────────────────
  console.log(`AC-218 readings ${JSON.stringify({
    dragTopChanges: topChanges,
    followFrames: judged.length,
    followAgreeing: agreeing,
    dragFrameP95: frameP95(farSamples),
    settleFar: settleReadings,
    settleInWindow: inWindowSettleReadings,
    thumbChangeShare: thumbMoving.length / moved.length,
    maxThumbJump: maxJump,
    wheelFrameP95: frameP95(wheelSamples),
    fetchesDuringFarDrag: farRead.fetches.length,
  })}`);
});
