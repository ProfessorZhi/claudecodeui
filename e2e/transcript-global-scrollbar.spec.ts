import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

// AC-214 v3: the transcript's drawn scrollbar, now a part of its own beside the
// turn-tick column rather than the rail that holds them both. Its thumb sits at
// the viewport centre's position on the conversation's ordinal scale — never at
// the loaded window's pixel ratio — so a window prepended above the viewport, or
// a row whose height is measured late, cannot move it. It is a real
// `role="scrollbar"` control: draggable, clickable and keyboard-operable. A drag
// may read as it moves (the content follows the pointer), but at most one read is
// ever in flight and the released position is the one that settles — an older
// read never overwrites a newer window. Its drawn length and position are AC-219's
// now — the browser formula against an estimated content height — so this file only
// reads that a thumb is drawn; and it is a neutral grey at rest, never the theme's
// own colour.
//
// v3 because AC-218 changed what a drag is allowed to do: v2 asserted a drag
// fetched nothing until it rested, and the criterion now allows reads while the
// pointer moves as long as they are serialised and the latest position wins.
//
// v2 because AC-217 split the two controls apart: the ticks became a window of
// fixed-size marks, and the thumb moved into a column of its own. The route to a
// distant turn is therefore the tick column's own scroll, as in AC-213 v2.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). The session is the shared long fixture
// seeded by `seedTranscriptJumpTranscript` — 1200 user turns, 4800 drawn rows — opened
// through the sidebar's own link. The outline the rail indexes comes from
// `GET /api/providers/sessions/:id/outline`; nothing is stubbed.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-jump';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-jump';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-jump-workspace';
/** User turns the fixture carries. */
const TOTAL_TURNS = 1200;
/** Normalized rows the fixture carries (four drawn rows per turn). */
const TOTAL_MESSAGES = 4800;
/** The turn "near the earliest" the criterion jumps to: ~10% of the conversation. */
const EARLY_TURN = 121;
/** Fixed desktop viewport, so the rail lays out and the pane is a known size. */
const VIEWPORT = { width: 1280, height: 1200 };
/**
 * How long the jump may take to place its target fully inside the viewport.
 *
 * The jump has its own internal retry budget (~3.2s) plus the window read it
 * waits on, so this is a generous ceiling, not a performance assertion: under
 * fleet load the placement can take longer than the jump's own budget.
 */
const TARGET_VISIBLE_MS = 15_000;
/** One wheel tick for the monotonic-scroll gesture, in CSS pixels. */
const WHEEL_STEP_PX = 700;
/** A reading must not move the thumb backwards by more than this share of the track, per frame. */
const BACKWARD_JUMP_TOLERANCE = 0.005;

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

/** One turn of the session's outline, as the endpoint reports it. */
type OutlineTurn = { id: string; index: number; timestamp: string; preview: string };

/**
 * Reads the seeded session's outline over the app's own REST route, from inside
 * the page so it carries the token the UI stored. `index` is the turn's absolute
 * message subscript in the full normalized history — the same scale the drawn
 * scrollbar is measured on, and the one the criterion reads positions from.
 */
const readOutline = (page: Page, sessionId: string): Promise<{ status: number; body: string }> =>
  page.evaluate(async (id) => {
    const response = await fetch(`/api/providers/sessions/${encodeURIComponent(id)}/outline`, {
      headers: { Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}` },
    });
    return { status: response.status, body: await response.text() };
  }, sessionId);

/** The outline turn for a 1-indexed displayed turn number, matched on its own preview text. */
const turnFor = (turns: OutlineTurn[], displayTurn: number): OutlineTurn => {
  const turn = turns.find((entry) => entry.preview.startsWith(`Turn ${displayTurn}.`))
    ?? turns[displayTurn - 1];
  if (!turn) throw new Error(`no outline turn for turn ${displayTurn}`);
  return turn;
};

/**
 * Opens a seeded session through the sidebar's own link.
 *
 * Parameterised because this file reads two fixtures: the long conversation the
 * position and length cases are about, and the short one the length ceiling is
 * read on.
 */
const openSeededSessionAs = async (
  page: Page,
  projectName: string,
  sessionName: string,
  sessionId: string,
) => {
  const link = page.locator('a[href^="/session/"]').filter({ hasText: sessionName });
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${projectName}`) }).first();
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
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
};

/** Opens the long fixture this file's position and length cases read. */
const openSeededSession = (page: Page) =>
  openSeededSessionAs(page, PROJECT_NAME, SESSION_NAME, SESSION_ID);

/** The rail tick for a turn, addressed by the id the outline reported. */
const tickFor = (page: Page, turnId: string) => page.locator(`[data-turn-id="${turnId}"]`);

/** Clicks the rail at a tick's own position with a real mouse. */
const clickTick = async (page: Page, turnId: string) => {
  const box = await tickFor(page, turnId).boundingBox();
  if (!box) throw new Error(`the rail has no tick for ${turnId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** The transcript row for a turn, addressed by the id the outline reported. */
const rowFor = (page: Page, turnId: string) => page.locator(`[data-message-anchor-id="${turnId}"]`);

type ThumbReading = {
  /** The thumb's own fraction of the track, derived from its laid-out geometry. */
  progress: number;
  /** The pane's distance from its bottom, in CSS pixels. */
  gap: number;
  role: string | null;
  orientation: string | null;
  valueNow: number | null;
  valueMin: number | null;
  valueMax: number | null;
};

const readThumb = (page: Page): Promise<ThumbReading> =>
  page.evaluate(() => {
    const track = document.querySelector('[data-scrollbar-track]') as HTMLElement | null;
    const thumbEl = document.querySelector('[data-scrollbar-thumb]') as HTMLElement | null;
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const empty = {
      progress: Number.NaN, gap: Number.NaN,
      role: null, orientation: null, valueNow: null, valueMin: null, valueMax: null,
    };
    if (!track || !thumbEl || !pane) return empty;
    const t = track.getBoundingClientRect();
    const b = thumbEl.getBoundingClientRect();
    const span = t.height - b.height;
    return {
      progress: span > 0 ? (b.top - t.top) / span : Number.NaN,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
      role: thumbEl.getAttribute('role'),
      orientation: thumbEl.getAttribute('aria-orientation'),
      valueNow: Number(thumbEl.getAttribute('aria-valuenow')),
      valueMin: Number(thumbEl.getAttribute('aria-valuemin')),
      valueMax: Number(thumbEl.getAttribute('aria-valuemax')),
    };
  });

/** The loaded window's pixel ratio — the reading the drawn thumb must not be. */
const readPanePixelFraction = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const travel = pane.scrollHeight - pane.clientHeight;
    return travel > 0 ? pane.scrollTop / travel : 0;
  });

/**
 * The first anchored row of the loaded window, as a fraction of the conversation.
 *
 * The wrapper keeps `data-message-anchor-id` whether or not the row's content is
 * mounted, so the first such element in document order is the window's own first
 * turn — the row the window was read around — not merely the first one on screen.
 */
const windowFirstRowFraction = async (
  page: Page,
  turns: OutlineTurn[],
  totalMessages: number,
): Promise<number | null> => {
  const id = await page.evaluate(() => {
    const el = document.querySelector('.chat-messages-pane [data-message-anchor-id]');
    return el ? el.getAttribute('data-message-anchor-id') : null;
  });
  if (!id) return null;
  const turn = turns.find((entry) => entry.id === id);
  return turn ? turn.index / totalMessages : null;
};

/** Records every `/messages` request the app makes, with the page times it started and ended at. */
const installFetchLog = () => {
  const w = window as unknown as { __messageFetches: { url: string; start: number; end: number }[] };
  w.__messageFetches = [];
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/messages')) return original(input, init);
    const record = { url, start: performance.now(), end: -1 };
    w.__messageFetches.push(record);
    const pending = original(input, init);
    const finish = () => {
      if (record.end < 0) record.end = performance.now();
    };
    pending.then(finish, finish);
    return pending;
  }) as typeof window.fetch;
};

const readFetches = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messageFetches: { url: string; start: number; end: number }[] }).__messageFetches);

/** The `around` id of a messages request, or null for a tail page. */
const aroundOf = (url: string): string | null => new URL(url, 'http://localhost').searchParams.get('around');

/**
 * The first request whose interval overlaps an earlier one's, or null when the
 * reads were serialised. An interval still open is treated as extending forever,
 * so a read that has not answered yet cannot hide an overlap behind it.
 */
const overlappingRequest = (
  fetches: { url: string; start: number; end: number }[],
): { url: string; start: number; end: number } | null => {
  const spanning = fetches
    .map((fetch) => ({ ...fetch, end: fetch.end < 0 ? Number.POSITIVE_INFINITY : fetch.end }))
    .sort((a, b) => a.start - b.start);
  for (let index = 1; index < spanning.length; index += 1) {
    if (spanning[index].start < spanning[index - 1].end) return spanning[index];
  }
  return null;
};

/** Samples the thumb's fraction once a frame until told to stop. */
const startProgressSampler = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pSamples: number[]; __pSampling: boolean };
    w.__pSamples = [];
    w.__pSampling = true;
    const tick = () => {
      if (!w.__pSampling) return;
      const track = document.querySelector('[data-scrollbar-track]');
      const thumb = document.querySelector('[data-scrollbar-thumb]');
      if (track && thumb) {
        const t = track.getBoundingClientRect();
        const b = thumb.getBoundingClientRect();
        const span = t.height - b.height;
        if (span > 0) w.__pSamples.push((b.top - t.top) / span);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

const stopProgressSampler = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __pSamples: number[]; __pSampling: boolean };
    w.__pSampling = false;
    return w.__pSamples;
  });

type PaneGeometry = { scrollTop: number; scrollHeight: number; clientHeight: number; gap: number };

/** Reads the pane's geometry once a frame's layout has settled. */
const readGeometry = (page: Page): Promise<PaneGeometry> =>
  page.evaluate(
    () =>
      new Promise<PaneGeometry>((resolve) => {
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
const waitForSettledPane = async (page: Page): Promise<PaneGeometry> => {
  let previous: PaneGeometry | null = null;
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

/** Puts the pointer over the middle of the pane, so a wheel gesture lands on the transcript. */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) throw new Error('the transcript pane has no box to aim a gesture at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

// ── AC-215: hiding the native scrollbar ──────────────────────────────────────
//
// The pane's native scrollbar is hidden by width (`scrollbar-width: none` plus the
// webkit pseudo-element) rather than by `overflow: hidden`, so the wheel, touch and
// keyboard still scroll it. These helpers read the two things the criterion is
// about: that hiding the bar left no layout behind (so exactly one scrollbar-like
// control — the drawn rail — remains), and that the drawn track still clears the
// last column of text now that the column has the width the native bar used to take.

/** The two viewports AC-215 must hold at: a wide desktop and a phone. */
const AC215_VIEWPORTS = [
  { name: 'desktop 1440×900', size: { width: 1440, height: 900 } },
  { name: 'mobile 390×844', size: { width: 390, height: 844 } },
] as const;

/** Everything one AC-215 reading compares: native bar, drawn track, text column, ARIA. */
type Clearance = {
  /** `offsetWidth − clientWidth` on the scroll container — the native bar's layout cost. */
  nativeLayoutPx: number;
  /** Computed `scrollbar-width` on the container. */
  scrollbarWidth: string;
  /** How many drawn tracks exist in the document. */
  trackCount: number;
  /** Left edge of the drawn track's box. */
  trackLeft: number;
  /** Left edge of the drawn thumb's box. */
  thumbLeft: number;
  /** Right edge of the content column's *content* box — the furthest right any text can reach. */
  textRight: number;
  role: string | null;
  valueNow: number | null;
  valueMin: number | null;
  valueMax: number | null;
  scrollTop: number;
  gap: number;
};

const readClearance = (page: Page): Promise<Clearance> =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const track = document.querySelector('[data-scrollbar-track]') as HTMLElement | null;
    const thumb = document.querySelector('[data-scrollbar-thumb]') as HTMLElement | null;
    // The content column is the pane's last child; text lives inside its content
    // box, so its right edge minus its own padding is the last place text can reach.
    const content = pane.lastElementChild as HTMLElement | null;
    const contentBox = content?.getBoundingClientRect();
    const contentPadRight = content ? Number.parseFloat(getComputedStyle(content).paddingRight) || 0 : 0;
    const trackBox = track?.getBoundingClientRect();
    const thumbBox = thumb?.getBoundingClientRect();
    const num = (el: HTMLElement | null, attr: string): number | null => {
      const raw = el?.getAttribute(attr);
      return raw == null ? null : Number(raw);
    };
    return {
      nativeLayoutPx: pane.offsetWidth - pane.clientWidth,
      scrollbarWidth: getComputedStyle(pane).scrollbarWidth,
      trackCount: document.querySelectorAll('[data-scrollbar-track]').length,
      trackLeft: trackBox ? trackBox.left : Number.NaN,
      thumbLeft: thumbBox ? thumbBox.left : Number.NaN,
      textRight: contentBox ? contentBox.right - contentPadRight : Number.NaN,
      role: thumb?.getAttribute('role') ?? null,
      valueNow: num(thumb, 'aria-valuenow'),
      valueMin: num(thumb, 'aria-valuemin'),
      valueMax: num(thumb, 'aria-valuemax'),
      scrollTop: pane.scrollTop,
      gap: pane.scrollHeight - pane.scrollTop - pane.clientHeight,
    };
  });

/**
 * Opens the seeded session in a fresh context at the viewport the case declares,
 * pinned at the tail and following, and returns the context and page.
 *
 * A fresh context rather than a resize of the shared page: the criterion needs
 * the transcript at the tail, and a fresh open lands there by construction,
 * whereas reflowing an already-open pane across a width change is a different
 * behaviour — a width reflow is not what the follow observes, and it can leave
 * the pane short of the bottom. The auth token is seeded into `localStorage`
 * before the first navigation, so `/session/<id>` opens the session directly.
 * `hasTouch` makes the narrow viewport the no-hover touch screen the criterion's
 * drag leg is about.
 */
const openSeededAtViewport = async (
  browser: Browser,
  origin: string,
  authToken: string,
  viewport: { readonly name: string; readonly size: { width: number; height: number } },
): Promise<{ context: BrowserContext; page: Page }> => {
  const isMobile = viewport.name.startsWith('mobile');
  const context = await browser.newContext({ viewport: viewport.size, hasTouch: isMobile, isMobile });
  await context.addInitScript((token) => {
    window.localStorage.setItem('auth-token', token);
  }, authToken);
  const scoped = await context.newPage();
  await scoped.goto(`${origin}/session/${SESSION_ID}`);
  await settleServiceWorker(scoped);
  await expect(scoped.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
  await waitForSettledPane(scoped);
  return { context, page: scoped };
};

/**
 * Scrolls back down until the pane is at the bottom again, and the app has read
 * that arrival as the user returning (so the follow is re-attached). A wheel
 * towards the bottom is the gesture the app re-attaches on, which is what makes
 * this the honest way to put the pane back at the tail between legs.
 */
const returnToBottom = async (page: Page) => {
  await pointAtPane(page);
  await page.mouse.wheel(0, 2_000);
  await expect
    .poll(async () => (await readClearance(page)).gap, {
      timeout: 5_000,
      message: 'a wheel back down must return the pane to the bottom',
    })
    .toBeLessThanOrEqual(1);
};

/** The pane's current offset, read on its own so a before/after comparison needs no geometry. */
const readScrollTop = (page: Page): Promise<number> =>
  page.evaluate(() => (document.querySelector('.chat-messages-pane') as HTMLElement).scrollTop);

/**
 * Grows the transcript's last in-flow row in place by `delta` px — the criterion's
 * "就地长高" injection — and reports the content column's height on both sides.
 * The tail of the column is where the newest row sits, so this is growth at the
 * bottom of the transcript, which is exactly what the follow must answer for.
 */
const growTranscriptTail = (page: Page, delta: number): Promise<{ before: number; after: number }> =>
  page.evaluate((d) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const content = pane.lastElementChild as HTMLElement;
    const row = (content.lastElementChild as HTMLElement | null) ?? content;
    const before = content.getBoundingClientRect().height;
    row.style.minHeight = `${row.getBoundingClientRect().height + d}px`;
    return { before, after: content.getBoundingClientRect().height };
  }, delta);

/** A CDP session for the page, for the real touch gestures below. */
const openCdp = (page: Page) => page.context().newCDPSession(page);

/**
 * A real touch scroll over the transcript: a finger press, a drag down the pane,
 * and a release, dispatched through Chromium's own input pipeline. Dragging the
 * finger down moves the content down, which is the gesture that reveals older
 * turns — i.e. it must lower `scrollTop`.
 */
const touchScrollPane = async (page: Page, yDelta: number) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) throw new Error('the transcript pane has no box for a touch gesture');
  const cdp = await openCdp(page);
  const x = Math.round(box.x + box.width / 2);
  const yStart = Math.round(box.y + box.height * 0.3);
  const steps = 10;
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yStart }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: yStart + Math.round((yDelta * step) / steps) }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
};

/**
 * A real touch drag on the drawn thumb: touchStart on it, move by `yDelta`, release.
 * The thumb carries `touch-action: none`, so this is a drag of the control, not a
 * scroll of the pane under it.
 */
const touchDragThumb = async (page: Page, yDelta: number) => {
  const box = await page.locator('[data-scrollbar-thumb]').boundingBox();
  if (!box) throw new Error('the drawn thumb has no box to touch-drag');
  const cdp = await openCdp(page);
  const x = Math.round(box.x + box.width / 2);
  const yStart = Math.round(box.y + box.height / 2);
  try {
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: yStart }] });
    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: yStart + Math.round((yDelta * step) / 8) }],
      });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
};

/** The drawn scrollbar's thumb, reached the way the criterion names it. */
type ThumbLength = {
  /** The thumb's own drawn height, in CSS pixels. */
  thumbHeight: number;
  /** The track's drawn height, in CSS pixels. */
  trackHeight: number;
  /** How many messages the rows intersecting the viewport stand for. */
  visibleMessages: number;
  /** The conversation's own message count — what the share is taken of. */
  totalMessages: number;
};

/**
 * Reads the thumb's drawn length together with the two numbers the criterion
 * defines it from.
 *
 * "Visible messages" is read the way the drawing code defines it: the rows of
 * the content column that intersect the pane's own box, each counting as one
 * message except a collapsed work segment, which publishes how many members it
 * stands for. Reading it here rather than assuming it keeps the assertion a
 * comparison of the drawn length against the criterion's formula, not against a
 * copy of the implementation's intermediate value.
 */
const readThumbLength = (
  page: Page,
  _turns: OutlineTurn[],
  totalMessages: number,
): Promise<ThumbLength> =>
  page.evaluate((total) => {
    const thumbEl = document.querySelector('[data-scrollbar-thumb]') as HTMLElement | null;
    const trackEl = document.querySelector('[data-scrollbar-track]') as HTMLElement | null;
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const content = document.querySelector('[data-transcript-content]') as HTMLElement | null;
    if (!thumbEl || !trackEl || !pane || !content) {
      return { thumbHeight: Number.NaN, trackHeight: Number.NaN, visibleMessages: 0, totalMessages: total };
    }
    const paneRect = pane.getBoundingClientRect();
    let visible = 0;
    for (const row of Array.from(content.children)) {
      // Only the lazy-row wrappers are messages; the column also holds the
      // loading overlays and the running turn's status line.
      if (!row.hasAttribute('data-message-timestamp')) continue;
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0) continue;
      if (rect.bottom <= paneRect.top || rect.top >= paneRect.bottom) continue;
      const declared = Number.parseInt(
        row.querySelector('[data-transcript-row-messages]')?.getAttribute('data-transcript-row-messages') ?? '1',
        10,
      );
      visible += Number.isFinite(declared) && declared > 0 ? declared : 1;
    }
    return {
      thumbHeight: Math.round(thumbEl.getBoundingClientRect().height),
      trackHeight: Math.round(trackEl.getBoundingClientRect().height),
      visibleMessages: visible,
      totalMessages: total,
    };
  }, totalMessages);

/** `hsl(<h> <s>% <l>%)` — the form this app's theme colours are authored in — as an rgb triple. */
const themeColorToRgb = (declared: string): { r: number; g: number; b: number } => {
  const match = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(declared);
  if (!match) throw new Error(`--primary is not an hsl triple: ${JSON.stringify(declared)}`);
  const h = Number(match[1]) / 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  if (s === 0) {
    const value = Math.round(l * 255);
    return { r: value, g: value, b: value };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let shifted = t;
    if (shifted < 0) shifted += 1;
    if (shifted > 1) shifted -= 1;
    if (shifted < 1 / 6) return p + (q - p) * 6 * shifted;
    if (shifted < 1 / 2) return q;
    if (shifted < 2 / 3) return p + (q - p) * (2 / 3 - shifted) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
};

/** Whether a computed `rgb(...)` colour is the theme's primary one, at full opacity. */
const isThemeColor = (computed: string | null, primary: { r: number; g: number; b: number }): boolean => {
  if (!computed) return false;
  const match = /^rgba?\(([^)]+)\)$/.exec(computed.trim());
  if (!match) return false;
  const parts = match[1].split(',').map((part) => Number.parseFloat(part));
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (alpha < 0.95) return false;
  return Math.abs(parts[0] - primary.r) <= 2
    && Math.abs(parts[1] - primary.g) <= 2
    && Math.abs(parts[2] - primary.b) <= 2;
};

/** The outline ordinal (1-indexed displayed turn number) a tick id names. */
const ordinalOf = (allTurns: OutlineTurn[], turnId: string): number =>
  allTurns.findIndex((turn) => turn.id === turnId) + 1;

/** Where the pointer must sit for a wheel to be the tick column's. */
const pointAtTickColumn = async (page: Page) => {
  const box = await page.locator('[data-turn-ticks]').boundingBox();
  if (!box) throw new Error('the tick column is not laid out to wheel');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

/** The ids the tick column is drawing right now, in column order. */
const drawnTickIds = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-turn-tick]'))
      .map((tick) => tick.getAttribute('data-turn-id') ?? '')
      .filter((id) => id.length > 0));

/**
 * Scrolls the tick column until it draws the wanted turn's tick.
 *
 * The column draws at most ten ticks around the turn the viewport is on, so a
 * turn far from it has no tick until the column is scrolled there — which is the
 * route AC-217 gave the rail in place of a tick per turn. A bounded number of
 * gestures keeps a window that never arrives a failure here rather than a
 * timeout later.
 */
const scrollTickColumnTo = async (
  page: Page,
  allTurns: OutlineTurn[],
  turnId: string,
  direction: -1 | 1,
  maxGestures = 90,
  pxPerGesture = 3_000,
) => {
  const wanted = ordinalOf(allTurns, turnId);
  for (let gesture = 0; gesture < maxGestures; gesture += 1) {
    const ids = await drawnTickIds(page);
    if (ids.includes(turnId)) return;
    // Overshot — the window has gone past the turn and has to come back.
    if (direction < 0 ? ordinalOf(allTurns, ids[0]) <= wanted : ordinalOf(allTurns, ids[0]) >= wanted) {
      await pointAtTickColumn(page);
      await page.mouse.wheel(0, (-direction * pxPerGesture) / 4);
      await page.waitForTimeout(60);
      continue;
    }
    await pointAtTickColumn(page);
    await page.mouse.wheel(0, direction * pxPerGesture);
    await page.waitForTimeout(60);
  }
  throw new Error(`the tick column never drew the tick for ${turnId}`);
};

test.describe.configure({ mode: 'serial', timeout: 240_000 });

test.describe('drawn global scrollbar in a real browser', () => {
  let page: Page;
  let turns: OutlineTurn[] = [];
  let totalMessages = TOTAL_MESSAGES;
  let browserRef: Browser;
  let origin = '';
  let authToken = '';

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    browserRef = browser;
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    await page.addInitScript(installFetchLog);
    await page.bringToFront();
    await page.setViewportSize(VIEWPORT);

    await ensureSignedIn(page);
    await settleServiceWorker(page);
    await openSeededSession(page);
    await waitForSettledPane(page);
    await pointAtPane(page);

    const outline = await readOutline(page, SESSION_ID);
    expect(outline.status, `GET /outline did not answer: ${outline.body.slice(0, 400)}`).toBe(200);
    const data = (JSON.parse(outline.body) as { data?: { total?: number; turns?: OutlineTurn[] } }).data;
    turns = data?.turns ?? [];
    totalMessages = data?.total ?? TOTAL_MESSAGES;
    expect(turns.length, 'the outline must carry every user turn of the seeded session').toBe(TOTAL_TURNS);
    expect(totalMessages, 'the outline must count every normalized row of the seeded session').toBe(TOTAL_MESSAGES);
    // The scale the rail measures on: a turn's `index` is its absolute message
    // subscript, so the fixture's turns sit four rows apart.
    expect(turns[1].index, 'outline indices must be absolute message subscripts').toBe(4);

    origin = new URL(page.url()).origin;
    authToken = await page.evaluate(() => window.localStorage.getItem('auth-token') ?? '');
    if (!authToken) throw new Error('no auth token to seed the short fixture context with');
  });

  test.afterAll(async () => {
    await page.close().catch(() => undefined);
  });

  test('AC-214 v3 the drawn scrollbar is a part of its own: ordinal position, neutral at rest', async () => {
    const track = page.locator('[data-scrollbar-track]');
    const thumb = page.locator('[data-scrollbar-thumb]');
    await expect(track, 'the transcript must draw its own scrollbar track').toBeVisible({ timeout: 20_000 });
    await expect(thumb, 'the track must carry a thumb').toBeVisible();

    // ── The two parts are separate: neither contains the other ───────────────
    const nesting = await page.evaluate(() => {
      const trackEl = document.querySelector('[data-scrollbar-track]');
      const column = document.querySelector('[data-turn-ticks]');
      if (!trackEl || !column) return 'one-absent';
      if (trackEl.contains(column)) return 'track-contains-ticks';
      if (column.contains(trackEl)) return 'ticks-contain-track';
      return 'siblings';
    });
    expect(nesting, 'the scrollbar and the tick column must be two separate parts').toBe('siblings');

    // ── (a) first screen pinned at the tail: the thumb sits at the far end, and
    // it is a real scrollbar to assistive tech ────────────────────────────────
    const atTail = await readThumb(page);
    expect(atTail.role, 'the thumb must be a scrollbar').toBe('scrollbar');
    expect(atTail.orientation, 'the thumb must be a vertical scrollbar').toBe('vertical');
    expect(atTail.valueMin).toBe(0);
    expect(atTail.valueMax).toBe(100);
    expect(atTail.valueNow, `aria-valuenow must read the position: ${JSON.stringify(atTail)}`).toBeGreaterThanOrEqual(97);
    expect(
      atTail.progress,
      `first screen at the tail must put the thumb at the far end: ${JSON.stringify(atTail)}`,
    ).toBeGreaterThanOrEqual(0.97);

    // ── (f) the drawn length is no longer this criterion's: it is AC-219's, and it
    // is the browser formula against an estimated content height rather than the
    // visible share. Only the fact that a thumb is drawn is read here. ─────────
    const length = await readThumbLength(page, turns, totalMessages);
    expect(
      length.thumbHeight,
      `a thumb must be drawn: ${JSON.stringify(length)}`,
    ).toBeGreaterThanOrEqual(28);

    // ── (g) at rest the thumb is neutral, never the theme's own colour ────────
    const primary = themeColorToRgb(await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()));
    const restColour = await page.evaluate(() =>
      getComputedStyle(document.querySelector('[data-scrollbar-thumb]') as HTMLElement).backgroundColor);
    expect(
      isThemeColor(restColour, primary),
      `the thumb must be a neutral grey at rest, not the theme colour: ${restColour}`,
    ).toBe(false);

    // ── (d) v3: a drag may read while it moves, but at most one read is in
    // flight, the newest position wins, and the released position is the one
    // that settles. The gesture drags the thumb towards ~10% and then to the
    // middle with the real mouse; the fetch log's start/end stamps make "one in
    // flight" an interval test, and the settled window is checked against the
    // released position so an older read cannot have overwritten it.
    const dragStartAt = await page.evaluate(() => performance.now());
    const trackBox = await track.boundingBox();
    const thumbBox = await thumb.boundingBox();
    if (!trackBox || !thumbBox) throw new Error('the scrollbar has no box to drag');
    const dragX = thumbBox.x + thumbBox.width / 2;
    const yAt = (fraction: number) => trackBox.y + fraction * trackBox.height;

    await page.mouse.move(dragX, thumbBox.y + thumbBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragX, yAt(0.1), { steps: 10 });
    await page.waitForTimeout(120);

    const midDrag = await readThumb(page);
    const midPreview = await page.locator('[data-scrollbar-preview]').textContent();
    // The thumb is the pointer's position throughout the gesture; the content
    // follows it rather than the other way round.
    expect(midDrag.progress, `dragging towards 10% must put the thumb near 0.10: ${JSON.stringify(midDrag)}`)
      .toBeGreaterThanOrEqual(0.07);
    expect(midDrag.progress, `dragging towards 10% must put the thumb near 0.10: ${JSON.stringify(midDrag)}`)
      .toBeLessThanOrEqual(0.13);
    expect(midPreview, 'the drag must float a preview of the turn under the thumb').toBeTruthy();
    expect(midPreview!, `the preview must name a turn and its time: ${JSON.stringify(midPreview)}`).toMatch(/Turn \d+\./);
    expect(midPreview!, `the preview must carry the turn's time: ${JSON.stringify(midPreview)}`).toMatch(/\d{1,2}:\d{2}/);
    const previewedTurn = turns.find((entry) => midPreview!.includes(entry.preview));
    expect(
      previewedTurn,
      `the drag preview must show the turn at that position, not an arbitrary one: ${JSON.stringify(midPreview)}`,
    ).toBeTruthy();
    expect(previewedTurn!.index / totalMessages).toBeGreaterThanOrEqual(0.04);
    expect(previewedTurn!.index / totalMessages).toBeLessThanOrEqual(0.18);

    // Release at the middle of the track: the position that must survive.
    await page.mouse.move(dragX, yAt(0.5), { steps: 10 });
    const releasedAt = await page.evaluate(() => performance.now());
    await page.mouse.up();

    await waitForSettledPane(page);
    const duringDrag = (await readFetches(page)).filter((entry) => entry.start >= dragStartAt);
    const overlap = overlappingRequest(duringDrag);
    expect(
      overlap,
      `a drag may read, but never two at once: ${JSON.stringify(duringDrag.map((entry) => ({ around: aroundOf(entry.url), start: Math.round(entry.start), end: Math.round(entry.end) })))}`,
    ).toBeNull();

    // The release's own read (if it needed one) is for the released position, and
    // it is the last word: a stale window read for an earlier pointer position
    // must not have landed after it.
    const afterRelease = duringDrag.filter((entry) => entry.start >= releasedAt);
    expect(
      afterRelease.length,
      `the release may issue at most one read for its final position: ${JSON.stringify(afterRelease.map((entry) => entry.url))}`,
    ).toBeLessThanOrEqual(1);
    const lastAround = aroundOf(duringDrag[duringDrag.length - 1].url);
    const lastTurnFraction = (() => {
      const turn = turns.find((entry) => entry.id === lastAround);
      return turn ? turn.index / totalMessages : -1;
    })();
    expect(lastTurnFraction, `the last read must be the position the drag settled on: ${lastAround}`)
      .toBeGreaterThanOrEqual(0.44);
    expect(lastTurnFraction, `the last read must be the position the drag settled on: ${lastAround}`)
      .toBeLessThanOrEqual(0.56);

    const afterDrag = await readThumb(page);
    expect(afterDrag.progress, `after resting at 50% the thumb must sit near 0.50: ${JSON.stringify(afterDrag)}`)
      .toBeGreaterThanOrEqual(0.47);
    expect(afterDrag.progress, `after resting at 50% the thumb must sit near 0.50: ${JSON.stringify(afterDrag)}`)
      .toBeLessThanOrEqual(0.53);
    // (d) no stale window applied: the settled window is the one the last read
    // asked for, so its first row sits within one window behind that position. A
    // stale window from an earlier pointer position would be far away.
    const draggedFirstRow = await windowFirstRowFraction(page, turns, totalMessages);
    expect(draggedFirstRow, 'the loaded window must expose its first row').not.toBeNull();
    expect(
      draggedFirstRow! - lastTurnFraction,
      `the settled window must belong to the last read, not an earlier one: ${JSON.stringify({ draggedFirstRow, lastTurnFraction, midDrag: midDrag.progress })}`,
    ).toBeGreaterThanOrEqual(-0.10);
    expect(
      draggedFirstRow! - lastTurnFraction,
      'the settled window must belong to the last read, not an earlier one',
    ).toBeLessThanOrEqual(0.02);

    // ── (b) jump to ~10% of the conversation through the tick column: the thumb
    // reports the ordinal position, which is not the loaded window's pixel ratio.
    // The column draws a window of ticks around the turn the viewport is on, so
    // the target's tick is reached by wheeling the column to it — the same route
    // AC-213 v2 takes.
    const earlyTurn = turnFor(turns, EARLY_TURN);
    await scrollTickColumnTo(page, turns, earlyTurn.id, -1);
    await clickTick(page, earlyTurn.id);
    // The independent witness that the window moved to ~10% of the conversation:
    // the loaded window's own first turn, read from the DOM and the outline — not
    // from the thumb the assertions below are about.
    await expect
      .poll(async () => {
        const fraction = await windowFirstRowFraction(page, turns, totalMessages);
        return fraction === null ? -1 : fraction;
      }, { timeout: TARGET_VISIBLE_MS, message: `turn ${EARLY_TURN}'s window never loaded` })
      .toBeGreaterThanOrEqual(0.07);
    await waitForSettledPane(page);

    const afterJump = await readThumb(page);
    const jumpedFirstRow = await windowFirstRowFraction(page, turns, totalMessages);
    const pixelFraction = await readPanePixelFraction(page);
    const jumpDiagnostic = JSON.stringify({ afterJump, jumpedFirstRow, pixelFraction });
    expect(
      afterJump.progress,
      `turn ${EARLY_TURN} sits at ~10% of the conversation: ${jumpDiagnostic}`,
    ).toBeGreaterThanOrEqual(0.07);
    expect(
      afterJump.progress,
      `turn ${EARLY_TURN} sits at ~10% of the conversation: ${jumpDiagnostic}`,
    ).toBeLessThanOrEqual(0.13);
    expect(jumpedFirstRow, `the loaded window must expose its first row: ${jumpDiagnostic}`).not.toBeNull();
    expect(jumpedFirstRow!, `the loaded window must start near 10%: ${jumpDiagnostic}`).toBeGreaterThanOrEqual(0.07);
    expect(jumpedFirstRow!, `the loaded window must start near 10%: ${jumpDiagnostic}`).toBeLessThanOrEqual(0.13);
    // The discriminator: a pixel-derived thumb would read the loaded window's own
    // scroll ratio, which is a position inside that window — far from the
    // conversation's 10%.
    expect(
      Math.abs(afterJump.progress - pixelFraction),
      `the thumb must be the conversation's ordinal, not the loaded window's pixels: ${jumpDiagnostic}`,
    ).toBeGreaterThan(0.2);

    // ── (c) wheeling up inside the window never moves the thumb backwards by
    // more than a fraction of the track, and never shrinks its drawn length ────
    // The pointer is put over the transcript, where a wheel is the transcript's.
    await pointAtPane(page);
    const windowStartBefore = await windowFirstRowFraction(page, turns, totalMessages);
    await startProgressSampler(page);
    for (let step = 0; step < 14; step += 1) {
      await page.mouse.wheel(0, -WHEEL_STEP_PX);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400);
    const samples = await stopProgressSampler(page);
    const windowStartAfter = await windowFirstRowFraction(page, turns, totalMessages);
    // The gesture has to have crossed a prepend for this section to mean what it
    // says: the loaded window's own first turn must have moved towards the start.
    expect(windowStartBefore, 'the loaded window must expose its first row before the wheel').not.toBeNull();
    expect(windowStartAfter, 'the loaded window must expose its first row after the wheel').not.toBeNull();
    expect(
      windowStartAfter!,
      `the wheel gesture must have forced a window prepend: before=${windowStartBefore} after=${windowStartAfter}`,
    ).toBeLessThan(windowStartBefore!);
    expect(samples.length, 'the monotonic sampler must have watched the wheel gesture').toBeGreaterThan(10);
    for (let index = 1; index < samples.length; index += 1) {
      expect(
        samples[index] - samples[index - 1],
        `wheeling up may not move the thumb backwards: ${JSON.stringify(samples.slice(Math.max(0, index - 3), index + 1))}`,
      ).toBeLessThanOrEqual(BACKWARD_JUMP_TOLERANCE);
    }
    expect(
      samples[samples.length - 1],
      `wheeling up must have moved the thumb towards the start: ${JSON.stringify(samples)}`,
    ).toBeLessThan(samples[0]);

    // ── (e) a click on the blank track and the keyboard both move the thumb, and
    // a click on the tick column is neither ───────────────────────────────────
    const clickTrack = await track.boundingBox();
    if (!clickTrack) throw new Error('the scrollbar track has no box to click');
    await page.mouse.click(clickTrack.x + clickTrack.width / 2, clickTrack.y + 0.75 * clickTrack.height);
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'clicking the track must move the thumb' })
      .toBeGreaterThan(0.6);

    /**
     * A gesture's thumb move is debounced, so the window it asks for lands a
     * moment later. Reading the thumb alone would let the case pass while the
     * pane never moved — and would leave a pending jump behind to fire in the
     * middle of the next leg. Each step therefore waits past the pause and for
     * the pane to stop, and the cases below read the window as well as the thumb.
     */
    const settleAfterGesture = async () => {
      await page.waitForTimeout(900);
      await waitForSettledPane(page);
    };

    await thumb.focus();
    await page.keyboard.press('End');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'End must move the thumb to the far end' })
      .toBeGreaterThanOrEqual(0.9);
    // The far end of the track is the newest turn's row, which the jump loaded.
    const lastTurn = turnFor(turns, TOTAL_TURNS);
    await settleAfterGesture();
    await expect(rowFor(page, lastTurn.id), 'the newest turn must be reachable through the drawn scrollbar')
      .toBeAttached({ timeout: 15_000 });

    await page.keyboard.press('PageUp');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'PageUp must move the thumb back' })
      .toBeLessThanOrEqual(0.92);
    const pageUp = await readThumb(page);
    expect(pageUp.progress, 'PageUp must land a page before the far end').toBeGreaterThanOrEqual(0.85);
    await settleAfterGesture();

    await page.keyboard.press('Home');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'Home must move the thumb to the start' })
      .toBeLessThanOrEqual(0.1);
    await settleAfterGesture();
    await expect
      .poll(async () => windowFirstRowFraction(page, turns, totalMessages), {
        timeout: TARGET_VISIBLE_MS,
        message: 'Home must take the loaded window to the head of the conversation',
      })
      .toBeLessThanOrEqual(0.05);

    await page.keyboard.press('PageDown');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'PageDown must move the thumb forward' })
      .toBeGreaterThanOrEqual(0.08);
    const pageDown = await readThumb(page);
    expect(pageDown.progress, 'PageDown must land a page after the start').toBeLessThanOrEqual(0.12);
    await settleAfterGesture();

    await page.keyboard.press('ArrowUp');
    await expect
      .poll(async () => (await readThumb(page)).progress, { timeout: 10_000, message: 'ArrowUp must move the thumb' })
      .toBeLessThan(pageDown.progress);
    await settleAfterGesture();

    // The tick column is not a scrollbar: clicking a tick is a jump, not a
    // position on the track. The discriminator is a tick whose turn is at the far
    // end of the conversation while its own row sits near the top of the pane —
    // read as a track position, that click would put the thumb in the middle.
    const lastTurnTickId = lastTurn.id;
    await scrollTickColumnTo(page, turns, lastTurnTickId, 1);
    const tickBox = await tickFor(page, lastTurnTickId).boundingBox();
    if (!tickBox) throw new Error('the column never drew the last turn\'s tick to click');
    const tickFractionIfTrackClick = (tickBox.y + tickBox.height / 2 - clickTrack.y) / clickTrack.height;
    expect(
      tickFractionIfTrackClick,
      `the tick must sit where a track click would read a different position: ${tickFractionIfTrackClick}`,
    ).toBeLessThan(0.9);
    await clickTick(page, lastTurnTickId);
    await expect
      .poll(async () => (await readThumb(page)).progress, {
        timeout: TARGET_VISIBLE_MS,
        message: 'clicking a tick must move the thumb to that turn\'s ordinal, not the click\'s place on the track',
      })
      .toBeGreaterThanOrEqual(0.97);
  });

  test('AC-215 the native scrollbar is hidden and the drawn rail is the only scrollbar, at two viewports', async () => {
    const browser = page.context().browser();
    if (!browser) throw new Error('the AC-215 case opens its own contexts and needs the browser');
    const origin = new URL(page.url()).origin;
    const authToken = await page.evaluate(() => window.localStorage.getItem('auth-token') ?? '');
    if (!authToken) throw new Error('no auth token to seed a fresh context with');

    for (const viewport of AC215_VIEWPORTS) {
      // A fresh context at this viewport: the transcript opens pinned at the tail
      // (the state the criterion's (c) leg names), and the narrow one is a real
      // no-hover touch screen for the drag leg. `page` shadows the shared page.
      const { context, page } = await openSeededAtViewport(browser, origin, authToken, viewport);
      try {
      // ── (a) the native bar leaves no layout, and the drawn rail is the one scrollbar ──
      const clearance = await readClearance(page);
      const reading = JSON.stringify(clearance);
      expect(
        clearance.nativeLayoutPx,
        `the native scrollbar must not take layout at ${viewport.name}: ${reading}`,
      ).toBe(0);
      expect(
        clearance.scrollbarWidth,
        `the container must carry scrollbar-width: none at ${viewport.name}: ${reading}`,
      ).toBe('none');
      expect(clearance.trackCount, `exactly one drawn track is the only scrollbar-like control: ${reading}`).toBe(1);

      // ── (d) the drawn track must not cover the last column of text ──
      expect(
        clearance.trackLeft,
        `the drawn track must clear the text column at ${viewport.name}: ${reading}`,
      ).toBeGreaterThanOrEqual(clearance.textRight);
      expect(
        clearance.thumbLeft,
        `the drawn thumb must clear the text column at ${viewport.name}: ${reading}`,
      ).toBeGreaterThanOrEqual(clearance.textRight);

      // ── (d) the thumb is a scrollbar to assistive tech, with a full ARIA range ──
      expect(clearance.role, `the thumb must be a scrollbar: ${reading}`).toBe('scrollbar');
      expect(clearance.valueMin, `aria-valuemin: ${reading}`).toBe(0);
      expect(clearance.valueMax, `aria-valuemax: ${reading}`).toBe(100);
      expect(clearance.valueNow, `aria-valuenow must read a position: ${reading}`).not.toBeNull();

      // ── (b) a wheel still scrolls the pane ──
      await pointAtPane(page);
      const beforeWheel = await readScrollTop(page);
      await page.mouse.wheel(0, -400);
      await expect
        .poll(() => readScrollTop(page), { timeout: 5_000, message: `a wheel must still scroll the pane at ${viewport.name}` })
        .toBeLessThan(beforeWheel);
      await returnToBottom(page);

      // ── (b) the keyboard still scrolls the pane ──
      await page.locator(PANE).focus();
      const beforeKey = await readScrollTop(page);
      await page.keyboard.press('PageUp');
      await expect
        .poll(() => readScrollTop(page), { timeout: 5_000, message: `PageUp must still scroll the pane at ${viewport.name}` })
        .toBeLessThan(beforeKey);
      await returnToBottom(page);

      // ── (c) at the tail, growing the last row ~400px keeps the bottom pinned ──
      const tailGrowth = await growTranscriptTail(page, 400);
      expect(
        tailGrowth.after - tailGrowth.before,
        `the injected growth must be at least 400px at ${viewport.name}: ${JSON.stringify(tailGrowth)}`,
      ).toBeGreaterThanOrEqual(400);
      await expect
        .poll(async () => (await readClearance(page)).gap, {
          timeout: 5_000,
          message: `the tail must stay pinned after the last row grows at ${viewport.name}`,
        })
        .toBeLessThanOrEqual(1);

      // ── (c) leaving the bottom: the same growth must not move scrollTop ──
      await pointAtPane(page);
      await page.mouse.wheel(0, -600);
      await waitForSettledPane(page);
      const leftReading = await readClearance(page);
      expect(
        leftReading.gap,
        `a wheel up must leave the bottom at ${viewport.name}: ${JSON.stringify(leftReading)}`,
      ).toBeGreaterThan(1);
      const leftAt = leftReading.scrollTop;
      const awayGrowth = await growTranscriptTail(page, 400);
      expect(
        awayGrowth.after - awayGrowth.before,
        `the second injected growth must be at least 400px at ${viewport.name}: ${JSON.stringify(awayGrowth)}`,
      ).toBeGreaterThanOrEqual(400);
      await waitForSettledPane(page);
      await page.waitForTimeout(300);
      const stayedReading = await readClearance(page);
      expect(
        Math.abs(stayedReading.scrollTop - leftAt),
        `growth below a viewport that left the bottom must not move scrollTop at ${viewport.name}: left=${JSON.stringify(leftReading)} stayed=${JSON.stringify(stayedReading)}`,
      ).toBeLessThanOrEqual(1);

      if (viewport.name.startsWith('mobile')) {
        // ── (b) a real touch swipe still scrolls the pane ──
        const beforeTouch = await readScrollTop(page);
        await touchScrollPane(page, 300);
        await expect
          .poll(() => readScrollTop(page), { timeout: 5_000, message: 'a touch swipe must still scroll the pane' })
          .toBeLessThan(beforeTouch);

        // ── (d) narrow, no hover: the drawn thumb is still touch-draggable ──
        const beforeDrag = await readClearance(page);
        await touchDragThumb(page, -160);
        await expect
          .poll(async () => (await readClearance(page)).valueNow, {
            timeout: 5_000,
            message: 'a touch drag must move the drawn thumb',
          })
          .toBeLessThan(beforeDrag.valueNow!);
      }
      } finally {
        await context.close();
      }
    }
  });
});
