import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// AC-213 v2: the turn navigation rail — clicking a turn's tick places that
// turn's message fully inside the scroll container's viewport and highlights it,
// without a blank viewport in between; a wheel stopped on the tick column moves
// the ticks and nothing else; the window then continues front and back without
// gaps or duplicates; and "back to latest" returns to the tail, where a newly
// arrived realtime row re-pins. The rail and the sidebar search share one
// id-addressed jump, so the jump resolves a same-millisecond tie by id, not by
// timestamp.
//
// v2 because the ticks are no longer one-per-turn: AC-217 replaced the
// proportional whole-rail tick list with a fixed-size window of at most ten
// ticks around the turn the reader is on, so a tick for a turn far from the
// current one does not exist in the DOM until the window is brought to it. The
// window is moved by the scrollbar it now shares the rail with (a track click or
// the thumb's own keys), or by wheeling the column itself. Everything else this
// criterion measured is unchanged, and is measured the same way.
//
// Real Chromium against the real backend + Vite client started by
// playwright.config.ts (isolated data dir). The session is the shared long
// fixture seeded by `seedTranscriptJumpTranscript` in playwright.config.ts —
// 1200 user turns, 4800 drawn rows, the 600th and 601st sharing one millisecond
// — opened through the sidebar's own link. Nothing is stubbed: the outline the
// rail indexes comes from `GET /api/providers/sessions/:id/outline`.
//
// AC-223 (the second case below) closes GOAL-017's fourth clause: the sidebar
// search jump reuses and replaces the old "pull the whole transcript, then widen
// a window" path. It drives the search through the sidebar's real conversation
// search (the SSE-backed one — the only source of `__searchTargetSnippet`),
// reads the page's own fetch log to say the jump read one `?around=<id>` window
// and never a bare `/messages`, and pins that the resolved row is the addressed
// turn of the same-millisecond pair rather than its twin.

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
/** The first of the two turns that share one millisecond (the 601st reuses it). */
const TIE_TURN = 600;
/**
 * The turn the criterion's jump targets: about a tenth of the way into the
 * conversation, outside both the tail page the pane loads first and the tick
 * column's own window.
 */
const EARLY_TURN = 121;
/** Fixed desktop viewport, so the rail lays out and the pane is a known size. */
const VIEWPORT = { width: 1280, height: 1200 };
/** The criterion's own ceiling: the target is on screen within this long of the click. */
const TARGET_VISIBLE_MS = 3_000;
/** A gap at or below this is "at the bottom", in CSS pixels. */
const AT_BOTTOM_PX = 2;
/**
 * The query AC-223 types into the real sidebar conversation search.
 *
 * It opens turn 601's prompt ("Turn 601. The transcript keeps…") and nothing
 * else: the reply says "Reply 601.", the thinking row "turn 601 before", and the
 * tool rows "turn-601" — none carries the phrase "Turn 601." with its period.
 * The hit therefore names exactly the addressed turn of the same-millisecond
 * pair the rail case also uses.
 */
const SEARCH_PHRASE = 'Turn 601. The transcript';
/**
 * The most ticks the column's window may draw (AC-217's ceiling, restated here
 * so this criterion fails if the rail ever goes back to one tick per turn).
 */
const MAX_TICKS_IN_WINDOW = 11;
/** One wheel tick for the continuation gestures, in CSS pixels. */
const WHEEL_STEP_PX = 700;
/** The scroll-to-bottom control, located the way the app labels it. */
const SCROLL_BUTTON = '[aria-label="Scroll to bottom"], [title="Scroll to bottom"]';

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
 * the page so it carries the token the UI stored. This is the same index the
 * rail reads, so the ticks the case clicks are the turns the endpoint named.
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

/** The sidebar row for the seeded session. */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/** Opens the seeded session through the sidebar's own link. */
const openSeededSession = async (page: Page) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink(page).isVisible().catch(() => false)) break;
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
  await expect(page.locator(`${PANE} .chat-message`).first()).toBeVisible({ timeout: 30_000 });
};

/** The rail tick for a turn, addressed by the id the outline reported. */
const tickFor = (page: Page, turnId: string) => page.locator(`[data-turn-id="${turnId}"]`);

/**
 * Clicks the rail at a tick's own position with a real mouse.
 *
 * The rail resolves a click by proportional position (its ticks are a fraction
 * of a pixel apart), so the click is aimed at the tick's box centre — the same
 * point the reader aims at — and the rail picks the nearest turn from it.
 */
const clickTick = async (page: Page, turnId: string) => {
  const box = await tickFor(page, turnId).boundingBox();
  if (!box) throw new Error(`the rail has no tick for ${turnId}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};

/** The transcript row for a turn, addressed by the id the outline reported. */
const rowFor = (page: Page, turnId: string) => page.locator(`[data-message-anchor-id="${turnId}"]`);

/**
 * Records every `/messages` request the app makes.
 *
 * The wheel case reads it to say the tick column's gesture fetched nothing, and
 * the jump cases read it to say a jump read the window it needed.
 */
const installFetchLog = () => {
  const w = window as unknown as { __messageFetches: { url: string; t: number }[] };
  w.__messageFetches = [];
  const original = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/messages')) w.__messageFetches.push({ url, t: performance.now() });
    return original(input, init);
  }) as typeof window.fetch;
};

const readFetches = (page: Page) =>
  page.evaluate(() => (window as unknown as { __messageFetches: { url: string; t: number }[] }).__messageFetches);

/** What the tick column is drawing right now. */
type TickColumnReading = {
  /** Every drawn tick's `data-turn-id`, in column order. */
  ids: string[];
  /** The transcript's own scroll offset. */
  scrollTop: number;
  /** How many `/messages` reads the page has made. */
  fetches: number;
};

const readTickColumn = (page: Page): Promise<TickColumnReading> =>
  page.evaluate(() => ({
    ids: Array.from(document.querySelectorAll('[data-turn-tick]'))
      .map((tick) => tick.getAttribute('data-turn-id') ?? '')
      .filter((id) => id.length > 0),
    scrollTop: Math.round((document.querySelector('.chat-messages-pane') as HTMLElement).scrollTop),
    fetches: (window as unknown as { __messageFetches: { url: string }[] }).__messageFetches.length,
  }));

/** Where the pointer must sit for a wheel to be the tick column's. */
const pointAtTickColumn = async (page: Page) => {
  const box = await page.locator('[data-turn-ticks]').boundingBox();
  if (!box) throw new Error('the tick column is not laid out to wheel');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

/** One wheel gesture of `px` CSS pixels over the tick column. */
const wheelTickColumn = async (page: Page, px: number) => {
  await pointAtTickColumn(page);
  await page.mouse.wheel(0, px);
  await page.waitForTimeout(60);
};

/** The outline ordinal (1-indexed displayed turn number) a tick id names. */
const ordinalOf = (turns: OutlineTurn[], turnId: string): number => turns.findIndex((turn) => turn.id === turnId) + 1;

/**
 * Scrolls the tick column until it draws the wanted turn's tick.
 *
 * The column draws at most ten ticks around the turn the viewport is on, so a
 * turn far from it has no tick until the column is scrolled there. This walks
 * the window in `px`-pixel gestures, and refuses to loop forever: a window that
 * never arrives is a failure here rather than a timeout later.
 */
const scrollTickColumnTo = async (
  page: Page,
  turns: OutlineTurn[],
  turnId: string,
  direction: -1 | 1,
  maxGestures = 90,
  pxPerGesture = 3_000,
) => {
  const wanted = ordinalOf(turns, turnId);
  for (let gesture = 0; gesture < maxGestures; gesture += 1) {
    const reading = await readTickColumn(page);
    if (reading.ids.includes(turnId)) return reading;
    const first = ordinalOf(turns, reading.ids[0]);
    // Overshot — the window has gone past the turn and has to come back.
    if (direction < 0 ? first <= wanted : first >= wanted) {
      await wheelTickColumn(page, -direction * pxPerGesture / 4);
      continue;
    }
    await wheelTickColumn(page, direction * pxPerGesture);
  }
  throw new Error(`the tick column never drew the tick for ${turnId}`);
};

/** The turn the rail currently draws as the viewport's own. */
const currentTickTurnId = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const tick = document.querySelector('[data-turn-tick][aria-current="true"]');
    return tick ? tick.getAttribute('data-turn-id') : null;
  });

/** Frames the reader's window between the blank sampler's samples. */
type TargetReading = {
  present: boolean;
  fully: boolean;
  highlighted: boolean;
  /** The turn number drawn in the target row, for the tie discriminator. */
  turnNumber: number | null;
  offsetFromPaneTop: number | null;
};

/**
 * Reads the target row against the scroll container's box: whether its whole
 * height is inside the pane, whether it carries the highlight, and what turn
 * number it draws. The turn number is how a same-millisecond tie is told apart
 * from its twin — two rows can share an instant, not a number.
 */
const readTarget = (page: Page, turnId: string): Promise<TargetReading> =>
  page.evaluate((id) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const row = document.querySelector(`[data-message-anchor-id="${id}"]`) as HTMLElement | null;
    if (!pane || !row) {
      return { present: Boolean(row), fully: false, highlighted: false, turnNumber: null, offsetFromPaneTop: null };
    }
    const paneRect = pane.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const match = /Turn (\d+)\./.exec(row.textContent ?? '');
    return {
      present: true,
      fully: rowRect.top >= paneRect.top - 1 && rowRect.bottom <= paneRect.bottom + 1,
      highlighted: row.classList.contains('search-highlight-flash'),
      turnNumber: match ? Number(match[1]) : null,
      offsetFromPaneTop: Math.round(rowRect.top - paneRect.top),
    };
  }, turnId);

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

/**
 * Records, once a frame's rendering steps have run, how many transcript rows
 * intersect the pane's box. Sampling stops when told; the minimum over the run
 * is the "blank viewport" reading — a single frame with no row on screen is the
 * failure, so the witness has to be per-frame rather than per-assertion.
 */
const startBlankSampler = (page: Page) =>
  page.evaluate(() => {
    interface BlankState { samples: number[]; running: boolean }
    const state: BlankState = { samples: [], running: true };
    (window as unknown as { __ac213blank: BlankState }).__ac213blank = state;
    const tick = () => {
      if (!state.running) return;
      requestAnimationFrame(() => {
        setTimeout(() => {
          const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
          if (pane) {
            const paneRect = pane.getBoundingClientRect();
            let visible = 0;
            for (const node of Array.from(pane.querySelectorAll('[data-message-timestamp]'))) {
              const rect = (node as HTMLElement).getBoundingClientRect();
              if (rect.bottom > paneRect.top && rect.top < paneRect.bottom) visible += 1;
            }
            state.samples.push(visible);
          }
          tick();
        }, 0);
      });
    };
    tick();
  });

/** Stops the blank sampler and returns every frame's reading. */
const stopBlankSampler = (page: Page) =>
  page.evaluate(() => {
    const state = (window as unknown as { __ac213blank?: { running: boolean; samples: number[] } }).__ac213blank;
    if (!state) return [] as number[];
    state.running = false;
    return state.samples;
  });

/**
 * The user-turn numbers drawn in the pane right now, in document order.
 *
 * Only a user turn draws the text "Turn N." — the assistant rows carry
 * "Reply N." — so this is the rail's own sequence as the DOM currently holds it.
 */
const drawnTurnNumbers = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.chat-messages-pane .chat-message.user'))
      .map((row) => /Turn (\d+)\./.exec(row.textContent ?? '')?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number),
  );

/** Records every frame a chat socket receives and lets a frame be handed to the app through it. */
const installWireDouble = () => {
  const page = window as unknown as {
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectStreamFrame: (frame: unknown) => number;
  };
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      const socket = this as WebSocket;
      page.__wireSockets.push({ url: String(args[0]), socket });
    }
  } as unknown as typeof WebSocket;

  page.__injectStreamFrame = (frame: unknown) => {
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const entry of page.__wireSockets) {
      if (!entry.url.includes('/ws')) continue;
      if (entry.socket.readyState !== 1) continue;
      entry.socket.dispatchEvent(new MessageEvent('message', { data }));
      delivered += 1;
    }
    return delivered;
  };
};

/**
 * Hands the app one realtime delta on its own chat socket, the way a reply arrives.
 *
 * The frame's timestamp is deliberately far in the future: the seed stamps its
 * turns forward from the run's boot (one a minute, 4800 rows), so a row stamped
 * with `Date.now()` would sort *into* the middle of the transcript rather than
 * after it, and the case could not then read whether the pane re-pinned under a
 * row that arrived at the end. A block key is carried so the store uses this
 * timestamp for the row it creates.
 */
const injectRealtimeDelta = (page: Page, sessionId: string, content: string) =>
  page.evaluate(
    (payload) =>
      (window as unknown as { __injectStreamFrame: (frame: unknown) => number }).__injectStreamFrame({
        kind: 'stream_delta',
        sessionId: payload.sessionId,
        content: payload.content,
        blockKey: 'e2e-ac213-realtime',
        id: 'e2e-ac213-wire',
        timestamp: '2099-01-01T00:00:00.000Z',
        provider: 'claude',
        role: 'assistant',
      }),
    { sessionId, content },
  );

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('turn rail jump in a real browser', () => {
  let page: Page;
  let turns: OutlineTurn[] = [];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    page = await browser.newPage();
    await page.addInitScript(installWireDouble);
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
    turns = (JSON.parse(outline.body) as { data?: { turns?: OutlineTurn[] } }).data?.turns ?? [];
    expect(turns.length, 'the outline must carry every user turn of the seeded session').toBe(TOTAL_TURNS);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('AC-213 v2 a windowed tick, reached by wheeling the column, jumps its turn into the viewport', async () => {
    // ── (a) the column is a window, and the target's tick is not in it ───────
    const initial = await readTickColumn(page);
    expect(initial.ids.length, 'the column must draw a window of ticks').toBeGreaterThan(0);
    expect(
      initial.ids.length,
      `the column must draw at most ${MAX_TICKS_IN_WINDOW} ticks, and must not grow with the conversation: ${JSON.stringify(initial.ids)}`,
    ).toBeLessThanOrEqual(MAX_TICKS_IN_WINDOW);

    const earlyTurn = turnFor(turns, EARLY_TURN);
    expect(earlyTurn, `the fixture must carry a turn near ${EARLY_TURN}`).toBeTruthy();
    expect(
      initial.ids.includes(earlyTurn.id),
      `turn ${EARLY_TURN}'s tick must not be drawn while the viewport sits at the tail`,
    ).toBe(false);
    expect(
      await rowFor(page, earlyTurn.id).count(),
      `turn ${EARLY_TURN} must not be in the DOM before its tick is clicked`,
    ).toBe(0);

    // ── (b) wheeling the column walks the window back, and nothing else ──────
    const fetchesBefore = (await readFetches(page)).length;
    const scrollTopBefore = (await readGeometry(page)).scrollTop;
    const seenFirstOrdinals: number[] = [];
    let reached: TickColumnReading | null = null;
    for (let gesture = 0; gesture < 80 && reached === null; gesture += 1) {
      const reading = await readTickColumn(page);
      seenFirstOrdinals.push(ordinalOf(turns, reading.ids[0]));
      if (reading.ids.includes(earlyTurn.id)) {
        reached = reading;
        break;
      }
      expect(
        ordinalOf(turns, reading.ids[0]),
        `each wheel must walk the window towards earlier turns: ${JSON.stringify(seenFirstOrdinals)}`,
      ).toBeLessThanOrEqual(seenFirstOrdinals[Math.max(0, seenFirstOrdinals.length - 2)]);
      await wheelTickColumn(page, -3_000);
    }
    expect(
      reached,
      `wheeling the column up never drew turn ${EARLY_TURN}'s tick: earliest ordinals seen ${JSON.stringify(seenFirstOrdinals)}`,
    ).not.toBeNull();
    expect(
      seenFirstOrdinals.length,
      'the wheel must have taken several gestures to cross the conversation',
    ).toBeGreaterThan(1);
    expect(
      seenFirstOrdinals[seenFirstOrdinals.length - 1],
      `the window must have got monotonically earlier: ${JSON.stringify(seenFirstOrdinals)}`,
    ).toBeLessThan(seenFirstOrdinals[0]);
    expect(
      Math.abs((await readGeometry(page)).scrollTop - scrollTopBefore),
      'wheeling on the tick column must not scroll the transcript',
    ).toBeLessThanOrEqual(1);
    expect(
      (await readFetches(page)).length - fetchesBefore,
      'wheeling on the tick column must not read a message page',
    ).toBe(0);

    // ── (c) the click places the turn, highlights it, and shows no blank frame ──
    await startBlankSampler(page);
    const clickedAt = await page.evaluate(() => performance.now());
    await clickTick(page, earlyTurn.id);

    let reading: TargetReading | null = null;
    const deadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < deadline) {
      const current = await readTarget(page, earlyTurn.id);
      // The row has to have drawn its content too: a lazy wrapper that is in the
      // viewport but not mounted yet reads no turn number at all, and the number
      // is what tells a clicked turn from its same-millisecond twin.
      if (current.fully && current.turnNumber !== null) {
        reading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const blankSamples = await stopBlankSampler(page);
    const elapsed = await page.evaluate((startedAt) => Math.round(performance.now() - startedAt), clickedAt);
    const diagnostic = await page.evaluate((targetId) => {
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const targetRow = document.querySelector(`[data-message-anchor-id="${targetId}"]`) as HTMLElement | null;
      const flash = document.querySelector('.search-highlight-flash') as HTMLElement | null;
      const turnNumbers = Array.from(pane?.querySelectorAll('.chat-message.user') ?? [])
        .map((row) => /Turn (\d+)\./.exec((row as HTMLElement).textContent ?? '')?.[1])
        .filter((value): value is string => Boolean(value));
      return {
        targetPresent: Boolean(targetRow),
        targetRect: targetRow ? { top: Math.round(targetRow.getBoundingClientRect().top), bottom: Math.round(targetRow.getBoundingClientRect().bottom) } : null,
        paneRect: pane ? { top: Math.round(pane.getBoundingClientRect().top), bottom: Math.round(pane.getBoundingClientRect().bottom), scrollTop: Math.round(pane.scrollTop), scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight } : null,
        flashTurn: /Turn (\d+)\./.exec(flash?.textContent ?? '')?.[1] ?? null,
        anchors: Array.from(document.querySelectorAll('[data-message-anchor-id]')).length,
        turnNumbers: [turnNumbers[0], turnNumbers[turnNumbers.length - 1], turnNumbers.length],
      };
    }, earlyTurn.id);

    expect(
      reading,
      `turn ${EARLY_TURN} was not fully in the viewport within ${TARGET_VISIBLE_MS}ms of its tick being clicked (${JSON.stringify(diagnostic)})`,
    ).not.toBeNull();
    expect(reading!.turnNumber, 'the row landed in must be the turn that was clicked').toBe(EARLY_TURN);
    expect(reading!.highlighted, 'the jumped-to row must be highlighted').toBe(true);
    expect(elapsed, `the target had to be on screen within ${TARGET_VISIBLE_MS}ms`).toBeLessThanOrEqual(TARGET_VISIBLE_MS);
    expect(blankSamples.length, 'the blank sampler must have watched the jump').toBeGreaterThan(0);
    expect(
      Math.min(...blankSamples),
      `no frame during the jump may show a blank viewport; fewest rows seen was ${Math.min(...blankSamples)} of ${blankSamples.length} frames`,
    ).toBeGreaterThanOrEqual(1);

    // The jump detached from the follow: the pane now knows it sits away from
    // the tail, which is what stops the next arriving row from dragging the
    // reader back down. The visible consequence is the way back being offered.
    await expect(
      page.locator(SCROLL_BUTTON).first(),
      'after jumping away from the tail the pane must offer the way back to it (the jump must detach the follow)',
    ).toBeVisible({ timeout: 5_000 });

    // ── (d) the window continues front and back without gaps or duplicates ──
    await pointAtPane(page);
    for (let screen = 0; screen < 3; screen += 1) {
      await page.mouse.wheel(0, -WHEEL_STEP_PX);
      await waitForSettledPane(page);
    }
    for (let screen = 0; screen < 3; screen += 1) {
      await page.mouse.wheel(0, WHEEL_STEP_PX);
      await waitForSettledPane(page);
    }
    const drawn = await drawnTurnNumbers(page);
    expect(drawn.length, 'the wheel gestures must have left user turns on screen').toBeGreaterThan(1);
    const unique = new Set(drawn);
    expect(unique.size, `no user turn may be drawn twice after the wheel gestures: ${JSON.stringify(drawn)}`).toBe(drawn.length);
    for (let index = 1; index < drawn.length; index += 1) {
      expect(
        drawn[index] - drawn[index - 1],
        `consecutive drawn user turns must be adjacent, so the window has no missing rows: ${JSON.stringify(drawn)}`,
      ).toBe(1);
    }

    // ...and "back to latest" returns to the tail, where a realtime row re-pins.
    await page.locator(SCROLL_BUTTON).first().click({ timeout: 15_000 });
    const lastTurn = turnFor(turns, TOTAL_TURNS);
    await expect(rowFor(page, lastTurn.id), 'the tail must be back after "back to latest"').toBeAttached({ timeout: 15_000 });
    await expect
      .poll(async () => Math.abs((await readGeometry(page)).gap), {
        timeout: 10_000,
        message: '"back to latest" never settled the pane on the bottom',
      })
      .toBeLessThanOrEqual(AT_BOTTOM_PX);
    const delivered = await injectRealtimeDelta(page, SESSION_ID, 'AC213 realtime row after returning to the tail.');
    expect(delivered, 'the realtime frame was never delivered to a chat socket').toBeGreaterThan(0);
    await expect
      .poll(async () => (await page.locator(PANE).textContent())?.includes('AC213 realtime row') ?? false, {
        timeout: 10_000,
        message: 'the injected realtime row never appeared in the transcript',
      })
      .toBe(true);
    expect(
      Math.abs((await readGeometry(page)).gap),
      'a realtime row arriving after "back to latest" must keep the pane pinned to the bottom',
    ).toBeLessThanOrEqual(AT_BOTTOM_PX);

    // ── (e) control: the last turn, the first turn, and the same-millisecond tie ──
    // The last turn, through the column.
    await scrollTickColumnTo(page, turns, lastTurn.id, 1);
    await clickTick(page, lastTurn.id);
    await expect
      .poll(async () => (await readTarget(page, lastTurn.id)).fully, {
        timeout: TARGET_VISIBLE_MS,
        message: 'the last turn never landed in the viewport',
      })
      .toBe(true);
    expect((await readTarget(page, lastTurn.id)).turnNumber).toBe(TOTAL_TURNS);

    // The first turn, through the column — wheeled all the way back.
    const firstTurn = turnFor(turns, 1);
    await scrollTickColumnTo(page, turns, firstTurn.id, -1);
    expect(await rowFor(page, firstTurn.id).count(), 'turn 1 must not be in the DOM before its tick is clicked').toBe(0);
    await clickTick(page, firstTurn.id);
    await expect
      .poll(async () => (await readTarget(page, firstTurn.id)).fully, {
        timeout: TARGET_VISIBLE_MS,
        message: 'the first turn never landed in the viewport',
      })
      .toBe(true);
    expect((await readTarget(page, firstTurn.id)).turnNumber).toBe(1);

    // The tie: the 601st turn shares the 600th's millisecond, and its tick must
    // land on the 601st — the discriminator a timestamp lookup fails.
    const tiedFirst = turnFor(turns, TIE_TURN);
    const tiedSecond = turnFor(turns, TIE_TURN + 1);
    expect(tiedFirst.timestamp, 'the fixture must give the tie pair one millisecond').toBe(tiedSecond.timestamp);
    expect(tiedFirst.id, 'the tied turns must still be two ids').not.toBe(tiedSecond.id);

    await scrollTickColumnTo(page, turns, tiedSecond.id, 1);
    await clickTick(page, tiedSecond.id);
    let tieReading: TargetReading | null = null;
    const tieDeadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < tieDeadline) {
      const current = await readTarget(page, tiedSecond.id);
      if (current.fully && current.turnNumber !== null) {
        tieReading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const tieDiagnostic = await page.evaluate((targetId) => {
      const flash = document.querySelector('.search-highlight-flash') as HTMLElement | null;
      const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
      const turnNumbers = Array.from(pane?.querySelectorAll('.chat-message.user') ?? [])
        .map((row) => /Turn (\d+)\./.exec((row as HTMLElement).textContent ?? '')?.[1])
        .filter((value): value is string => Boolean(value));
      return {
        targetPresent: Boolean(document.querySelector(`[data-message-anchor-id="${targetId}"]`)),
        flashTurn: /Turn (\d+)\./.exec(flash?.textContent ?? '')?.[1] ?? null,
        turnNumbers: [turnNumbers[0], turnNumbers[turnNumbers.length - 1], turnNumbers.length],
      };
    }, tiedSecond.id);
    expect(
      tieReading,
      `the tick for turn ${TIE_TURN + 1} never placed its row in the viewport (${JSON.stringify(tieDiagnostic)})`,
    ).not.toBeNull();
    expect(
      tieReading!.turnNumber,
      `clicking turn ${TIE_TURN + 1}'s tick must land on turn ${TIE_TURN + 1}, not the tied ${TIE_TURN}`,
    ).toBe(TIE_TURN + 1);
    // "Turn 601's row is visible" is not by itself a discriminator: a timestamp
    // lookup finds the *first* row that shares the instant (turn 600) and
    // centres/highlights that one, and the clicked turn 601 is drawn right
    // beside it, still inside the viewport. What tells the two apart is *which
    // row the jump acted on* — the clicked turn's row must carry the highlight,
    // and its same-millisecond twin must not.
    expect(
      tieReading!.highlighted,
      `the jump must highlight turn ${TIE_TURN + 1}'s own row, not the same-millisecond turn ${TIE_TURN}'s (${JSON.stringify(tieDiagnostic)})`,
    ).toBe(true);
    expect(
      (await readTarget(page, tiedFirst.id)).highlighted,
      `the tied turn ${TIE_TURN} must not be the row the jump actually addressed`,
    ).toBe(false);
  });

  // AC-223: the sidebar search jump is the rail's own id-addressed read, not a
  // second implementation. It is driven here through the real search UI, with
  // the tie pair deliberately OUT of the loaded window so the hit's turn has to
  // be named from the outline — the path a timestamp lookup gets wrong.
  test('AC-223 a sidebar search jump reads one around window and lands on the addressed turn', async () => {
    test.setTimeout(300_000);

    // ── Park the loaded window back at the tail ─────────────────────────────
    // When this case runs after the rail case, that case left the window around
    // the tie and the pane detached; "back to latest" drops it and re-reads the
    // newest page. Run alone (the criterion's `-g "AC-223"` invocation) the pane
    // is already on the tail, so there is nothing to take back. Either way the
    // tie pair ends up unloaded and the search has to name turn 601 from the
    // outline, not from a loaded row.
    const scrollButton = page.locator(SCROLL_BUTTON).first();
    if (await scrollButton.isVisible().catch(() => false)) {
      await scrollButton.click({ timeout: 15_000 });
    }
    const lastTurn = turnFor(turns, TOTAL_TURNS);
    await expect(rowFor(page, lastTurn.id), 'the tail must be attached before the search').toBeAttached({ timeout: 15_000 });
    await expect
      .poll(async () => Math.abs((await readGeometry(page)).gap), {
        timeout: 10_000,
        message: 'the pane never settled on the bottom before the search',
      })
      .toBeLessThanOrEqual(AT_BOTTOM_PX);

    const tiedFirst = turnFor(turns, TIE_TURN);
    const tiedSecond = turnFor(turns, TIE_TURN + 1);
    expect(tiedFirst.timestamp, 'the fixture must give the tie pair one millisecond').toBe(tiedSecond.timestamp);
    expect(tiedFirst.id, 'the tied turns must still be two ids').not.toBe(tiedSecond.id);
    await expect
      .poll(async () => rowFor(page, tiedSecond.id).count(), {
        timeout: 10_000,
        message: 'the tie turn must leave the loaded window before the search resolves',
      })
      .toBe(0);

    // ── A real sidebar search whose only hit is turn 601's own prompt ───────
    await page.locator('button:visible', { hasText: 'Conversations' }).first().click();
    const searchInput = page.locator('input.nav-search-input:visible').first();
    await searchInput.fill(SEARCH_PHRASE);
    const result = page.getByRole('button').filter({ hasText: SESSION_NAME }).first();
    await result.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(result, "the search result must carry the hit's snippet").toContainText(SEARCH_PHRASE);

    const fetchesBefore = (await readFetches(page)).length;
    await result.click();

    let searchReading: TargetReading | null = null;
    const deadline = Date.now() + TARGET_VISIBLE_MS;
    while (Date.now() < deadline) {
      const current = await readTarget(page, tiedSecond.id);
      if (current.fully && current.turnNumber !== null) {
        searchReading = current;
        break;
      }
      await page.waitForTimeout(50);
    }
    const searchFetches = (await readFetches(page)).slice(fetchesBefore);
    const searchUrls = searchFetches.map((entry) => entry.url);
    console.log('[AC-223] the search jump made these /messages reads:', JSON.stringify(searchUrls));

    // (a) The jump is a window read, never a full pull. A bare `/messages`
    // request (no limit, no around) is exactly the old "read the whole
    // transcript" shape; every read the jump made has to carry `around=`.
    const bareReads = searchFetches.filter((entry) => /\/messages(\?|$)/.test(entry.url) && !entry.url.includes('around='));
    expect(
      bareReads,
      `the search jump must not read /messages without an around id; it made ${JSON.stringify(bareReads.map((entry) => entry.url))}`,
    ).toEqual([]);
    const aroundReads = searchFetches.filter((entry) => entry.url.includes('around='));
    expect(aroundReads.length, `the search jump must read an around window: ${JSON.stringify(searchUrls)}`).toBeGreaterThan(0);

    // (b) It lands on the addressed turn, not the same-millisecond twin.
    const searchDiagnostic = await page.evaluate((target) => {
      const flash = document.querySelector('.search-highlight-flash') as HTMLElement | null;
      return {
        targetPresent: Boolean(document.querySelector(`[data-message-anchor-id="${target}"]`)),
        flashTurn: /Turn (\d+)\./.exec(flash?.textContent ?? '')?.[1] ?? null,
      };
    }, tiedSecond.id);
    expect(
      searchReading,
      `the search hit for turn ${TIE_TURN + 1} never placed its row in the viewport (${JSON.stringify(searchDiagnostic)})`,
    ).not.toBeNull();
    expect(
      searchReading!.turnNumber,
      `the search jump must land on the addressed turn ${TIE_TURN + 1}, not the tied ${TIE_TURN}`,
    ).toBe(TIE_TURN + 1);
    expect(
      searchReading!.highlighted,
      `the search jump must highlight turn ${TIE_TURN + 1}'s own row (${JSON.stringify(searchDiagnostic)})`,
    ).toBe(true);
    expect(
      (await readTarget(page, tiedFirst.id)).highlighted,
      `the same-millisecond turn ${TIE_TURN} must not be the row the search actually addressed`,
    ).toBe(false);

    // (c) The same read the rail makes. A rail tick jump is taken and the two
    // window reads are compared: same endpoint, same around/before/after shape.
    const railBefore = (await readFetches(page)).length;
    await scrollTickColumnTo(page, turns, tiedSecond.id, 1);
    await clickTick(page, tiedSecond.id);
    await expect
      .poll(async () => (await readTarget(page, tiedSecond.id)).fully, {
        timeout: TARGET_VISIBLE_MS,
        message: 'the rail jump after the search never re-placed its turn',
      })
      .toBe(true);
    const railUrls = (await readFetches(page)).slice(railBefore).map((entry) => entry.url);
    const railAround = railUrls.find((url) => url.includes('around='));
    console.log('[AC-223] the rail jump made these /messages reads:', JSON.stringify(railUrls));
    expect(railAround, `the rail jump must be an around-window read: ${JSON.stringify(railUrls)}`).toBeTruthy();
    const shapeOf = (url: string) => {
      const parsed = new URL(url, 'http://localhost');
      return {
        path: parsed.pathname,
        hasAround: parsed.searchParams.has('around'),
        before: parsed.searchParams.get('before'),
        after: parsed.searchParams.get('after'),
      };
    };
    expect(
      shapeOf(aroundReads[0].url),
      `the sidebar search and the rail must enter the same ?around window read; search ${aroundReads[0].url} vs rail ${railAround}`,
    ).toEqual(shapeOf(railAround!));

    // (c, structural) ...and there is no second copy of the jump in the source:
    // the search effect routes through `jumpToMessage`, the rail routes through
    // it too, the one jump reads an id-addressed window, and it never scrolls a
    // fully pulled transcript with `scrollIntoView`.
    const repoRoot = process.cwd();
    const chatHook = fs.readFileSync(path.join(repoRoot, 'src/modules/chat/hooks/useChatSessionState.ts'), 'utf8');
    const railHook = fs.readFileSync(path.join(repoRoot, 'src/modules/chat/hooks/useTurnNavigation.ts'), 'utf8');
    expect(chatHook, 'the search effect must route through the shared jumpToMessage entry').toContain('jumpToMessage(anchorId)');
    expect(railHook, 'the rail must route through the same jumpToMessage entry').toContain('jumpToMessage(');
    expect(chatHook, 'the shared jump must read an id-addressed window').toContain('loadWindowAround(sessionId, anchorId');
    expect(
      /\bscrollIntoView\s*\(/.test(chatHook),
      'the jump must not fall back to scrolling a fully pulled transcript with scrollIntoView',
    ).toBe(false);
  });
});
