import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// AC-216: a steady scroll up has the next page of older messages already in hand. The prefetch
// arms a couple of screens above the top edge — not at it, which is where the absolute
// `scrollTop < 100` it replaced waited — each older page is at least 50 rows, and the prepend
// leaves the row the user was reading where it was.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated
// data dir). The transcript is the shared long-session seed (`e2e-transcript-jump`), opened
// through the sidebar; the viewport is moved by real wheel gestures, and the network reading this
// criterion is taken from the app's own requests as they are issued — no request is stubbed.

/** ChatMessagesPane's scroll container. */
const PANE = '.chat-messages-pane';
/** Session the seeded transcript belongs to; mirrors playwright.config.ts's own seed. */
const SESSION_ID = 'e2e-transcript-jump';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-jump';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-jump-workspace';
/**
 * A short, wide pane: desktop layout (the sidebar sits beside the pane), and little enough height
 * that the seeded first page stands well over two of its screens — which is what lets the pane
 * open *outside* the prefetch band and makes the request below the wheel's doing.
 */
const VIEWPORT = { width: 1200, height: 460 };
/** The criterion's own page floor, in rows. */
const PAGE_FLOOR = 50;
/** The edge the old trigger waited for; the prefetch must ask before the pane reaches it. */
const OLD_EDGE_PX = 100;
/** The anchored row's offset may move by at most this, in CSS pixels. */
const DRIFT_PX = 1;

/**
 * One request the app issued for a session's persisted history, as it was issued.
 *
 * The pane's geometry and the row the app's own restore would anchor on are read in the same
 * synchronous step the fetch is made in — the same step `captureScrollRestoreState` runs in — so
 * this is the position the app prefetch-armed at, not a later one.
 */
type HistoryRequest = {
  t: number;
  limit: number;
  offset: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** Rows in the pane when the request was issued. */
  rows: number;
  /** The timestamp of the row the restore would anchor on, if one is on screen. */
  anchorStamp: string | null;
  /** That row's offset from the pane's top, in CSS pixels. */
  anchorOffset: number | null;
};

/**
 * Records every history request the app makes, with the pane as it stood when the request went out.
 *
 * Installed before the app's first script runs, so no request escapes it: the pane opens at the
 * bottom and the first scroll it reports is already a candidate for a prefetch. Wrapping `fetch`
 * changes nothing the app does — the native function is still called with the same arguments — it
 * only appends the reading.
 */
const installHistoryRequestRecorder = () => {
  const state: { requests: HistoryRequest[] } = { requests: [] };
  (window as unknown as { __historyRequests?: typeof state }).__historyRequests = state;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const url = new URL(raw, window.location.origin);
      const limitParam = url.searchParams.get('limit');
      if (limitParam !== null && /\/api\/providers\/sessions\/[^/]+\/messages$/.test(url.pathname)) {
        const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
        const limit = Number(limitParam);
        if (pane && Number.isFinite(limit)) {
          const paneTop = pane.getBoundingClientRect().top;
          const rows = Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[];
          // The same anchor `captureScrollRestoreState` picks — the first row whose bottom is at or
          // below the pane's top — narrowed to rows carrying their timestamp so the row can be found
          // again after the prepend. `.chat-message` is MessageComponent's own element.
          const anchor = (Array.from(pane.querySelectorAll('.chat-message[data-message-timestamp]')) as HTMLElement[]).find(
            (element) => element.getBoundingClientRect().bottom >= paneTop,
          );
          state.requests.push({
            t: Math.round(performance.now()),
            limit,
            offset: Number(url.searchParams.get('offset') ?? '0'),
            scrollTop: pane.scrollTop,
            clientHeight: pane.clientHeight,
            scrollHeight: pane.scrollHeight,
            rows: rows.filter((row) => !row.parentElement?.closest('[data-message-timestamp]')).length,
            anchorStamp: anchor?.getAttribute('data-message-timestamp') ?? null,
            anchorOffset: anchor ? anchor.getBoundingClientRect().top - paneTop : null,
          });
        }
      }
    } catch {
      // A non-URL fetch argument is not one of ours; the real fetch below still runs.
    }
    return nativeFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
};

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

/** The sidebar row for the seeded session. */
const sessionLink = (page: Page) =>
  page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/** Opens the seeded session through the sidebar's own link — never by writing the store or the URL. */
const openSeededSession = async (page: Page) => {
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
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

type Geometry = { scrollTop: number; scrollHeight: number; clientHeight: number; gap: number };

/**
 * Reads the pane's geometry once a frame's rendering steps have run, so a write deferred to a
 * frame of its own has landed before the read.
 */
const readGeometry = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Geometry>((resolve) => {
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

/** The number of rows the pane currently holds. */
const readRows = (page: Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    return (Array.from(pane.querySelectorAll('[data-message-timestamp]')) as HTMLElement[]).filter(
      (row) => !row.parentElement?.closest('[data-message-timestamp]'),
    ).length;
  });

/** Every history request the app has issued, newest last. */
const readHistoryRequests = (page: Page): Promise<HistoryRequest[]> =>
  page.evaluate(() =>
    JSON.parse(JSON.stringify(
      (window as unknown as { __historyRequests?: { requests: HistoryRequest[] } }).__historyRequests?.requests ?? [],
    )) as HistoryRequest[],
  );

/** The offset of a row's top from the pane's top, in CSS pixels — the row's place in the viewport. */
const readRowOffset = (page: Page, stamp: string) =>
  page.evaluate((target) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement;
    const row = (Array.from(pane.querySelectorAll('.chat-message[data-message-timestamp]')) as HTMLElement[]).find(
      (node) => node.getAttribute('data-message-timestamp') === target,
    );
    return row ? row.getBoundingClientRect().top - pane.getBoundingClientRect().top : null;
  }, stamp);

/**
 * Waits for the pane to stop moving, and returns the geometry it stopped at. The follow and the
 * prepend's restore are allowed to land a frame or more after the change that caused them, so the
 * steady state — not the first read — is what a measurement is taken from.
 */
const waitForSettledPane = async (page: Page): Promise<Geometry> => {
  let previous: Geometry | null = null;
  let stable = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const current = await readGeometry(page);
    if (
      previous
      && Math.abs(current.scrollTop - previous.scrollTop) < 0.5
      && Math.abs(current.gap - previous.gap) < 0.5
    ) {
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
 * Puts the pointer over the middle of the pane, so the wheel gestures land on the transcript. A
 * wheel is aimed at whatever is under the pointer, and the sidebar is beside the pane at this
 * width but over it at a phone's, so every gesture aims rather than inheriting a position.
 */
const pointAtPane = async (page: Page) => {
  const box = await page.locator(PANE).boundingBox();
  if (!box) throw new Error('the transcript pane has no box to aim a gesture at');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
};

/** One assignment to an element's `scrollTop`, as it was made. */
type PaneWrite = { value: number; t: number; isPane: boolean };

/**
 * Records every assignment to `scrollTop` on any element, tagged with whether it was the transcript
 * pane. Installed before the wheel, so the write the prepend's anchor restore makes is caught.
 *
 * The setter keeps its own descriptor and calls through to it, so the write is counted without
 * being altered. A wheel, a key and the browser's own scroll anchoring never go through a JS setter,
 * so a recorded pane write is one the *app* made — which is what separates the app's restore from
 * the browser silently holding the row on its own.
 */
const installPaneWriteRecorder = () => {
  const state: { writes: PaneWrite[] } = { writes: [] };
  (window as unknown as { __paneWrites?: typeof state }).__paneWrites = state;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(this: Element) {
        return descriptor.get!.call(this);
      },
      set(this: Element, value: number) {
        state.writes.push({
          value,
          t: Math.round(performance.now()),
          isPane: this.classList?.contains('chat-messages-pane') ?? false,
        });
        descriptor.set!.call(this, value);
      },
    });
  }
};

/** The `scrollTop` writes the app has made, oldest first. */
const readPaneWrites = (page: Page): Promise<PaneWrite[]> =>
  page.evaluate(() =>
    JSON.parse(JSON.stringify(
      (window as unknown as { __paneWrites?: { writes: PaneWrite[] } }).__paneWrites?.writes ?? [],
    )) as PaneWrite[],
  );

test.describe.configure({ timeout: 120_000 });

test.describe('transcript prefetch before the edge', () => {
  test('AC-216 an upward scroll prefetches two screens early, 50 rows at a time, without moving the anchored row', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await ensureSignedIn(page);
    await openSeededSession(page);

    const opened = await waitForSettledPane(page);
    const openedRows = await readRows(page);
    // Installed here rather than at navigation: the first screen opens *outside* the band (asserted
    // below), so no history request can be in flight before this point, and every request the wheel
    // causes is recorded.
    await page.evaluate(installHistoryRequestRecorder);
    await page.evaluate(installPaneWriteRecorder);
    await pointAtPane(page);

    // The premise the wheel's reading rests on, asserted rather than assumed: the first screen
    // sits *outside* the prefetch band, so a page can only arrive by the gesture below — an app
    // that opened inside the band could prefetch before the user touched anything.
    const band = 2 * opened.clientHeight;
    expect(
      opened.scrollTop,
      `the first screen must open below the prefetch band (${opened.scrollTop} <= ${band}), or the request below is not the wheel's`,
    ).toBeGreaterThan(band);

    // A steady, human-sized scroll: small ticks so the band is entered from above while the pane
    // is still far from the edge — a single large wheel could overshoot straight to the top and
    // make "asked before the edge" true or false by luck.
    const step = Math.max(80, Math.round(opened.clientHeight / 3));
    let olderRequests: HistoryRequest[] = [];
    let rowsAfter = openedRows;
    for (let attempt = 0; attempt < 100 && olderRequests.length === 0; attempt += 1) {
      await page.mouse.wheel(0, -step);
      await page.waitForTimeout(140);
      olderRequests = (await readHistoryRequests(page)).filter((request) => request.limit >= PAGE_FLOOR);
    }
    expect(
      olderRequests.length,
      'the wheel up over the pane must have made the app ask for an older page',
    ).toBeGreaterThan(0);
    // The request is recorded as it is *issued*; the prepend it answers lands after it. Wait for
    // the rows to actually grow, and for the restore that follows them to settle, before reading
    // the pane back.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      rowsAfter = await readRows(page);
      if (rowsAfter > openedRows) break;
      await page.waitForTimeout(100);
    }
    const settled = await waitForSettledPane(page);

    const first = olderRequests[0];
    const readings = await readHistoryRequests(page);
    console.log(`AC-216 readings ${JSON.stringify({
      viewport: VIEWPORT,
      opened: { scrollTop: Math.round(opened.scrollTop), clientHeight: Math.round(opened.clientHeight), rows: openedRows, band },
      firstPrefetch: {
        scrollTop: Math.round(first.scrollTop),
        clientHeight: Math.round(first.clientHeight),
        limit: first.limit,
        offset: first.offset,
        rowsAtRequest: first.rows,
        anchorStamp: first.anchorStamp,
        anchorOffset: first.anchorOffset === null ? null : Math.round(first.anchorOffset * 100) / 100,
      },
      rowsAfter,
      settled: { scrollTop: Math.round(settled.scrollTop), clientHeight: Math.round(settled.clientHeight) },
      olderRequests: readings
        .filter((request) => request.limit >= PAGE_FLOOR)
        .map((request) => ({ offset: request.offset, scrollTop: Math.round(request.scrollTop), limit: request.limit })),
    })}`);

    // 1. The prefetch armed before the edge the old trigger waited for. This is the reading the
    //    "page size raised but the trigger left at scrollTop < 100" variant turns red: the page
    //    would only be asked for once the pane had arrived at the top.
    expect(
      first.scrollTop,
      `the older page must be asked for before the viewport reaches the top edge, not at it (asked at scrollTop ${first.scrollTop})`,
    ).toBeGreaterThan(OLD_EDGE_PX);
    // ...and it was the prefetch band that armed it: the request went out from inside a couple of
    // screens of the top, which is where the trigger lives, not from somewhere arbitrary.
    expect(
      first.scrollTop,
      `the prefetch must arm inside the band (asked at scrollTop ${first.scrollTop}, band ${band})`,
    ).toBeLessThanOrEqual(2 * first.clientHeight + 2);

    // 2. Each older page is at least the floor: asked for, and delivered. The request's `limit` is
    //    the page size itself; the rows it draws are fewer, because consecutive work rows fold into
    //    one rendered row — this seed draws ~3 rows for every 4 messages — so the delivered floor is
    //    stated against what one page of 50 messages draws (~37 here), comfortably clear of the ~15
    //    the old 20-message page drew.
    expect(first.limit, `the older page must ask for at least ${PAGE_FLOOR} rows`).toBeGreaterThanOrEqual(PAGE_FLOOR);
    expect(
      rowsAfter - openedRows,
      `the prepend must draw at least half a page of new rows (${openedRows} → ${rowsAfter})`,
    ).toBeGreaterThanOrEqual(PAGE_FLOOR / 2);

    // 3. The anchored row did not move, and the app's own restore is what kept it. Chromium anchors
    //    the offset itself when content above the viewport changes, so the drift alone does not say
    //    which mechanism acted — the write does. The app writes the pane's offset through
    //    `scrollTop` (never the browser's silent anchoring), so a pane write after the fetch was
    //    issued is the restore running. The "prefetch without the anchor restore" variant makes no
    //    such write and turns the second assertion red.
    expect(first.anchorStamp, 'the request must have been made with a row on screen to anchor on').not.toBeNull();
    expect(first.anchorOffset, 'the anchored row must have a measured offset').not.toBeNull();
    const anchorAfter = await readRowOffset(page, first.anchorStamp!);
    expect(anchorAfter, 'the anchored row must still be in the pane after the prepend').not.toBeNull();
    const drift = Math.abs(anchorAfter! - first.anchorOffset!);
    expect(
      drift,
      `the prepend must leave the anchored row where it was (offset ${first.anchorOffset} → ${anchorAfter}, drift ${drift}px)`,
    ).toBeLessThanOrEqual(DRIFT_PX);

    const paneWrites = (await readPaneWrites(page)).filter((write) => write.isPane && write.t >= first.t);
    console.log(`AC-216 restore drift=${drift.toFixed(2)}px paneWrites=${JSON.stringify(paneWrites.map((write) => ({ value: Math.round(write.value), t: write.t })))}`);
    expect(
      paneWrites.length,
      `the prepend must re-place the viewport with the anchor restore — no pane write was made after the fetch at t${first.t} `
      + `(writes ${JSON.stringify(paneWrites)})`,
    ).toBeGreaterThan(0);

    // 4. One request per arrival: a page is never asked for twice, which is the shape a trigger
    //    that re-fired while its own request was in flight would take.
    const offsets = readings.filter((request) => request.limit >= PAGE_FLOOR).map((request) => request.offset);
    expect(
      new Set(offsets).size,
      `no older page may be requested twice (offsets ${JSON.stringify(offsets)})`,
    ).toBe(offsets.length);
  });
});
