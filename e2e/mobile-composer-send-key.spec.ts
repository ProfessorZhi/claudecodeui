import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

/**
 * The shipped English strings, read off the disk rather than restated here.
 *
 * A spec that hard-coded "Enter to send" would keep passing after the locale file changed, and the whole
 * point of these assertions is that the hint the user reads is the one the app ships.
 */
const enChat = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'),
    'utf8',
  ),
) as { input: { hintText: { enter: string } } };

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data
// dir). Nothing here stubs a media query, a keyboard event or an API response: the device the browser
// reports is the device the app reads, the key press is a real one, and the message the button sends
// really opens a session.
//
// This spec is the only place the media query STRING is proven. A jsdom test cannot implement media
// queries, so `src/modules/chat/tests/sendOnEnter.test.tsx` proves the policy against a double; whether
// `(pointer: coarse) and (hover: none)` is what a touch device really answers can only be read here.
//
// Whether the hint row is SHOWN is a question no jsdom test can answer either, and one cell cannot
// answer it alone. Three cells are read in this one run, each with its own `test.use` so that the
// viewport and the touch emulation are always handed over together:
//
//   (a) touch @390   — must be `display: none` (the change itself)
//   (b) touch @1280  — must be `display: none` too (the ≥lg tablet, where `hidden lg:block` would have
//                      lifted the hiding and shown a soft keyboard the wording naming Shift)
//   (c) keyboard @1280 — must be `display: block` (the positive control: without it, deleting the
//                      hiding class everywhere scores the same "none" on (a) and (b))
//
// The three together are falsifiable in three different directions, which is the point: an
// always-visible row reds (a), an always-hidden one reds (c), and reverting to a bare
// `hidden lg:block` reds (b) while (a) stays green.

/**
 * The touch-only signal the composer must gate on, both halves required.
 *
 * `'ontouchstart' in window` is NOT the same question — it is false under this emulation, so a spec (or
 * a hook) sniffing for it would read a touch device as a keyboard one.
 */
const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';
const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The composer's outermost element — the box whose height the hint row does or does not add to. */
const COMPOSER_SHELL = 'div.chat-composer-shell';
/**
 * The hint row. It is the only `basis-full` element in the composer, and `basis-full` is exactly what
 * puts it on a line of its own: the cost this task is about is the row's own line plus the footer's
 * `gap-y-1` that only exists while the row does.
 */
const HINT_ROW = 'div.basis-full';
const SEND_BUTTON = 'button[aria-label="Send"]';
const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The stored preference must outlive a debounced push before the "after" reading is taken. */
const PREFERENCE_WRITE_SETTLE_MS = 900;
/** Tailwind's `lg`, where `hidden lg:block` stops hiding: 64rem at the default 16px root. */
const LG_BREAKPOINT_PX = 1024;
/** The phone cell — the width at which the hint row was costing a touch device a line. */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;
/** The tablet cell — at or above `lg`, the width where the keyboard wording used to become visible. */
const TABLET_VIEWPORT = { width: 1280, height: 900 } as const;
/**
 * The composer's height at 390×844 on a touch-only device BEFORE this change, in CSS pixels.
 *
 * It cannot be derived from the changed tree — the wording that used to fill the row is deleted — so it
 * is a RECORDED READING, taken by putting the pre-change sources back in this worktree and reading the
 * live layout the same way this spec reads it:
 *
 *     git checkout develop -- src/modules/chat/composer/ChatComposer.tsx \
 *                              src/modules/i18n/locales/en/chat.json
 *     npx playwright test e2e/__baseline-probe.spec.ts      # scratch probe, prints BASELINE touch@390
 *     git checkout HEAD -- <same paths>
 *
 * That reading was `{touchOnly: true, innerWidth: 390, hintDisplay: 'block', hintHeight: 16,
 * hintText: 'Tap ➤ to send • Return adds a line', composerHeight: 151}`. The row was one 16px line and
 * the footer's `gap-y-1` added 4px more, which is where the 20px comes from; the assertion below
 * compares the two heights and prints both, so a stale constant says so rather than passing quietly.
 */
const COMPOSER_HEIGHT_BEFORE_PX = 151;

/**
 * Both legs share one `DATABASE_PATH` (playwright.config.ts sets one for the whole run), so the account
 * is created at most once and every later navigation logs in instead. Same helper as
 * e2e/model-library-layout.spec.ts, for the same reason.
 */
const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
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

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';
/** Absolute path of the workspace playwright.config.ts seeded for this spec. */
let workspace = '';

/**
 * Signs in once for the whole file.
 *
 * `test.use({ hasTouch, isMobile, viewport })` is per-describe, so each leg gets its own browser context
 * and the default `page` fixture starts unauthenticated. Re-running onboarding per leg would cost more
 * than the whole budget, so the session is captured here and replayed into each leg by `restoreSession`.
 */
const bootstrapAuth = async (browser: Browser) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await ensureSignedIn(page);
  authToken = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!authToken) {
    throw new Error('onboarding completed but no auth token was stored — the legs cannot authenticate');
  }
};

/** Puts the captured session into a context that the `test.use` options already built. */
const restoreSession = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/**
 * Records every keydown the composer really saw, as the LAST listener in the chain.
 *
 * React 18 attaches its handler to the root container, which is inside the document, so a bubble-phase
 * listener on `window` runs after it and reads the `defaultPrevented` the app left behind — the same
 * reading the task's matrix is written in.
 */
const installKeyProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const readings: { key: string; shiftKey: boolean; ctrlKey: boolean; defaultPrevented: boolean }[] = [];
    (window as unknown as { __keyReadings: typeof readings }).__keyReadings = readings;
    window.addEventListener('keydown', (event) => {
      readings.push({
        key: event.key,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
};

const keyReadings = (page: Page) =>
  page.evaluate(() => (window as unknown as {
    __keyReadings: { key: string; shiftKey: boolean; ctrlKey: boolean; defaultPrevented: boolean }[];
  }).__keyReadings);

const composer = (page: Page) => page.locator(COMPOSER);

/**
 * The project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; only the card exists at
 * 390px, and its accessible name sits on a heading rather than on the clickable div. Both are targeted so
 * the spec says "open this project" rather than "click this markup".
 */
const projectToggle = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', {
      name: new RegExp(`^${path.basename(workspace).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    }))
    .first();

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and the app auto-selects only when the run seeded
 * exactly one project — this one seeds five, so the selection has to be made the way a user makes it. On a
 * phone the sidebar is a drawer behind the menu button; on desktop both of those controls are absent and
 * the sidebar is already docked.
 */
const openComposer = async (page: Page) => {
  const textarea = composer(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    // `Open menu` is still "visible" to Playwright while the drawer covers it, so the drawer's own
    // backdrop — labelled "Close sidebar" — is what says whether it is already open.
    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    const newSession = page.getByRole('button', { name: 'New Session' }).first();
    if (!(await newSession.isVisible().catch(() => false))) {
      // The row is a toggle, so a click landing mid-render can leave it collapsed; the loop retries.
      await projectToggle(page).click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/** The hint row, its text and the computed styles that decide whether a user can read it at all. */
const readHintRow = (page: Page) =>
  page.locator(HINT_ROW).evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      text: element.textContent,
      display: style.display,
      opacity: style.opacity,
      // A laid-out row has a width; a `display: none` one has 0. Reported alongside `display` because
      // it is the second, independent witness that the row really occupies no space.
      width: Math.round(element.getBoundingClientRect().width),
    };
  });

/** The composer's rendered height, in CSS pixels — the space the hint row does or does not cost it. */
const readComposerHeight = (page: Page) =>
  page.locator(COMPOSER_SHELL).evaluate((element) => (element as HTMLElement).offsetHeight);

/**
 * Empties the composer and waits for it to read back empty.
 *
 * The readings below compare the composer against a baseline height, and the composer's height is not
 * a constant: the textarea grows with the draft. An empty input is the one state both readings share.
 */
const clearComposer = async (page: Page) => {
  const textarea = composer(page);
  await textarea.fill('');
  await expect(textarea).toHaveValue('');
};

/**
 * What the composer costs and shows on one device, which is the whole of this task's question.
 *
 * The four fields travel together on purpose. `viewportWidth` and `touchOnly` are the premise (a cell
 * that quietly measured the wrong device must fail rather than agree); `hintDisplay` is the answer;
 * `composerHeight` is the price. Read from live computed style and layout — not from a class name —
 * because a class only says what was asked for, and this task is about what the browser did with it.
 */
type ComposerCell = {
  viewportWidth: number;
  touchOnly: boolean;
  hintDisplay: string;
  hintText: string;
  hintWidth: number;
  composerHeight: number;
};

/** Every cell this run read, so the file prints all three together as well as asserting each one. */
const cells: Record<string, ComposerCell> = {};

/** Reads one cell and files it under `name`. */
const readCell = async (page: Page, name: string): Promise<ComposerCell> => {
  const features = await readMediaFeatures(page, TOUCH_ONLY_QUERY);
  const hint = await readHintRow(page);
  const cell: ComposerCell = {
    viewportWidth: features.innerWidth,
    touchOnly: features.touchOnly,
    hintDisplay: hint.display,
    hintText: hint.text ?? '',
    hintWidth: hint.width,
    composerHeight: await readComposerHeight(page),
  };
  cells[name] = cell;
  console.log(`CELL ${name}`, JSON.stringify(cell));
  return cell;
};

/** One cell's failure message, with its own readings and every other cell read so far. */
const cellMessage = (name: string, cell: ComposerCell, claim: string) =>
  `${claim}; the ${name} cell read {viewportWidth:${cell.viewportWidth}, touchOnly:${cell.touchOnly}, `
    + `hintDisplay:${JSON.stringify(cell.hintDisplay)}, hintWidth:${cell.hintWidth}, `
    + `composerHeight:${cell.composerHeight}} — all cells: ${JSON.stringify(cells)}`;

/** The media features the browser really reports, so a failed premise says which half was wrong. */
const readMediaFeatures = (page: Page, query: string) =>
  page.evaluate((touchQuery) => ({
    touchOnly: window.matchMedia(touchQuery).matches,
    pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
    hoverNone: window.matchMedia('(hover: none)').matches,
    // The sniff the task warns about: false here, so it cannot stand in for the query above.
    ontouchstart: 'ontouchstart' in window,
    innerWidth: window.innerWidth,
  }), query);

/** What the account has stored, both raw and as the client reads it. */
type StoredSendKey = { raw: unknown; enabled: boolean };

/**
 * The preference lives at `preferences.uiPreferences.sendByCtrlEnter`, and an absent key means the user
 * never changed it — which the client reads as its default, off. Both are reported so the evidence shows
 * the raw value rather than only the normalised one.
 */
const readStoredSendKey = async (page: Page): Promise<StoredSendKey> => {
  const raw = await page.evaluate(async ([key]) => {
    const response = await window.fetch('/api/user/preferences', {
      headers: { Authorization: `Bearer ${window.localStorage.getItem(key) ?? ''}` },
    });
    const body = (await response.json()) as {
      preferences?: { uiPreferences?: { sendByCtrlEnter?: unknown } };
    };
    return body.preferences?.uiPreferences?.sendByCtrlEnter;
  }, [AUTH_TOKEN_KEY] as const);
  return { raw, enabled: raw === true };
};

/** Every `GET /api/user/preferences` the app itself made on this page, oldest first. */
const recordPreferenceReads = (page: Page): StoredSendKey[] => {
  const reads: StoredSendKey[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname !== '/api/user/preferences') return;
    if (response.request().method() !== 'GET') return;
    void response
      .json()
      .then((body: { preferences?: { uiPreferences?: { sendByCtrlEnter?: unknown } } }) => {
        const raw = body.preferences?.uiPreferences?.sendByCtrlEnter;
        reads.push({ raw, enabled: raw === true });
      })
      .catch(() => undefined);
  });
  return reads;
};

test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.beforeAll(async ({ browser }) => {
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  await bootstrapAuth(browser);
});

// The three cells this task is decided by, printed together once the run is over. Each cell asserts
// its own reading (so a red names the cell that was wrong); this is the artefact the Evidence quotes.
test.afterAll(() => {
  console.log('THREE CELLS', JSON.stringify(cells));
});

test.describe('the composer send key on a touch-only device', () => {
  // Viewport and touch come from ONE place on purpose. `page.setViewportSize` flips the width but not
  // the pointer media features, and a CDP metrics override outlives its session while touch emulation
  // does not — splitting them across two calls is how a 1280px-wide viewport ends up being measured as
  // a phone. The premise assertion below is what makes that mistake fail instead of pass. It is also
  // why the tablet cell below is a separate `test.use` rather than a mid-test resize.
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE_VIEWPORT });

  test('Enter breaks the line, the button sends, and the preference is untouched', async ({ page }) => {
    const preferenceReads = recordPreferenceReads(page);
    await restoreSession(page);
    await installKeyProbe(page);
    await page.goto('/');
    await openComposer(page);

    // PREMISE, asserted before any behaviour: without this the whole leg passes on a desktop config.
    const features = await readMediaFeatures(page, TOUCH_ONLY_QUERY);
    expect(
      features.touchOnly,
      `this leg needs a touch-only device; ${TOUCH_ONLY_QUERY} read ${JSON.stringify(features)}`,
    ).toBe(true);
    expect(
      features.pointerCoarse && features.hoverNone,
      `both halves of the query must hold; the features read ${JSON.stringify(features)}`,
    ).toBe(true);

    // PREMISE for the reading itself: with the preference already on, Enter breaks the line on any
    // device and the three assertions below would pass without the touch gate existing at all.
    await expect.poll(() => preferenceReads.length).toBeGreaterThan(0);
    const storedBefore = await readStoredSendKey(page);
    console.log('PREFERENCE before', JSON.stringify(storedBefore));
    expect(
      storedBefore.enabled,
      'this leg measures what a touch device does with the preference OFF; the account has '
        + `sendByCtrlEnter=${JSON.stringify(storedBefore.raw)}`,
    ).toBe(false);

    const textarea = composer(page);

    // 1. The defect itself: Enter with text typed used to send the message. It now adds exactly one line
    //    break and stays put. This is the assertion the anti-fake variant is required to redden.
    await textarea.fill('hello');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('hello\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'Enter must break the line on a touch device, not submit',
    ).toEqual({ pathname: '/' });

    // 2. The dead key. Return used to send, and with nothing typed it did nothing at all; it is now the
    //    newline key, so an empty input gains exactly one line break.
    await textarea.fill('');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'an empty Enter must not send: no session may be opened by it',
    ).toEqual({ pathname: '/' });

    const afterEnter = await keyReadings(page);
    console.log('TOUCH Enter readings', JSON.stringify(afterEnter));
    expect(
      afterEnter.filter((reading) => reading.key === 'Enter' && !reading.shiftKey && !reading.ctrlKey),
      'neither Enter press may reach the app un-prevented — that is what "Enter sends" looked like',
    ).toEqual([
      expect.objectContaining({ defaultPrevented: false }),
      expect.objectContaining({ defaultPrevented: false }),
    ]);

    // THE CELL THIS TASK IS ABOUT (a): a phone is shown no hint at all, so the row costs it nothing.
    //
    // Read from computed style rather than from the class name. `hidden` is what the composer asks
    // for; `display: none` is what the browser did with it, and only the second is the user's
    // experience. The width is the second witness: a row that is laid out has one, a hidden row
    // does not.
    await clearComposer(page);
    await page.locator(SEND_BUTTON).waitFor({ state: 'attached' });

    const phone = await readCell(page, 'touch@390');
    expect(
      phone.viewportWidth,
      cellMessage('touch@390', phone, `this cell must be the ${PHONE_VIEWPORT.width}px phone it claims`),
    ).toBe(PHONE_VIEWPORT.width);
    expect(
      phone.touchOnly,
      cellMessage('touch@390', phone, `this cell must be a touch-only device, so ${TOUCH_ONLY_QUERY} must hold`),
    ).toBe(true);
    expect(
      phone.hintDisplay,
      cellMessage('touch@390', phone, 'a touch-only phone must be shown no hint row at all'),
    ).toBe('none');

    // THE PRICE (AC-6): the 20px this task buys back, against the height the same composer had on
    // `develop` — see COMPOSER_HEIGHT_BEFORE_PX for where that reading comes from and how to re-take
    // it. Both readings are printed, so a drift says which side moved.
    const savedPx = COMPOSER_HEIGHT_BEFORE_PX - phone.composerHeight;
    expect(
      Math.abs(savedPx - 20),
      `a touch phone must be 20px shorter than before this change: the composer stood at `
        + `${COMPOSER_HEIGHT_BEFORE_PX}px before (pre-change reading) and reads ${phone.composerHeight}px `
        + `now — ${savedPx}px saved, not 20`,
    ).toBeLessThanOrEqual(1);

    // 3. The button is the only way out, and it really opens a session.
    await textarea.fill('hello again');
    await page.locator(SEND_BUTTON).click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);

    // POSITIVE CONTROL for "the device judgement wrote nothing back": an independent GET of the same
    // account preference, after the write debounce has had time to fire.
    await page.waitForTimeout(PREFERENCE_WRITE_SETTLE_MS);
    const storedAfter = await readStoredSendKey(page);
    console.log('PREFERENCE readings', JSON.stringify({ before: storedBefore, after: storedAfter }));
    expect(
      storedAfter,
      'the touch leg must leave the account preference exactly as it found it — the device decides its own '
        + `Enter behaviour and writes nothing back. Before: ${JSON.stringify(storedBefore)}`,
    ).toEqual(storedBefore);
    expect(
      preferenceReads.map((read) => read.enabled),
      `no GET /api/user/preferences this page made may report the preference on: ${JSON.stringify(preferenceReads)}`,
    ).toEqual(preferenceReads.map(() => false));
  });
});

test.describe('the composer send key on a large touch-only device', () => {
  // The cell that makes this task more than a revert, and the one no earlier run could see: at or above
  // `lg`, `hidden lg:block` stops hiding. Left alone, this device would be shown the keyboard wording —
  // "Enter to send • Shift+Enter for new line" — on a soft keyboard that has no Shift. Same `test.use`
  // channel as the phone cell, so width and touch emulation still travel together.
  test.use({ hasTouch: true, isMobile: true, viewport: TABLET_VIEWPORT });

  test('a landscape tablet is shown no hint either, so the wording naming Shift never reaches it', async ({ page }) => {
    await restoreSession(page);
    await page.goto('/');
    await openComposer(page);
    await clearComposer(page);

    // THE CELL (b): the positive control for the phone cell, at the width where the hiding would lift.
    const tablet = await readCell(page, 'touch@1280');
    // PREMISE for the reading: a viewport that quietly stayed a phone would measure the wrong question,
    // and it is exactly the mistake a mid-test resize makes (the CDP metrics override outlives the
    // session that set it; `test.use` cannot).
    expect(
      tablet.viewportWidth,
      cellMessage('touch@1280', tablet, `this cell must sit at or above the ${LG_BREAKPOINT_PX}px lg breakpoint`),
    ).toBeGreaterThanOrEqual(LG_BREAKPOINT_PX);
    expect(
      tablet.touchOnly,
      cellMessage('touch@1280', tablet, `this cell must be a touch-only device, so ${TOUCH_ONLY_QUERY} must hold`),
    ).toBe(true);
    expect(
      tablet.hintDisplay,
      cellMessage('touch@1280', tablet, 'a touch-only tablet must be shown no hint row at any width'),
    ).toBe('none');
  });
});

test.describe('the composer send key on a device with a keyboard', () => {
  test.use({ viewport: TABLET_VIEWPORT });

  test('Enter submits, Shift+Enter breaks the line, and an empty Enter stays a dead key', async ({ page }) => {
    const preferenceReads = recordPreferenceReads(page);
    await restoreSession(page);
    await installKeyProbe(page);
    await page.goto('/');
    await openComposer(page);

    // PREMISE: this leg is the desktop reading, so the same query must be false here — it is what makes
    // the touch leg above evidence of anything.
    const features = await readMediaFeatures(page, TOUCH_ONLY_QUERY);
    expect(
      features.touchOnly,
      `this leg needs a keyboard device; ${TOUCH_ONLY_QUERY} read ${JSON.stringify(features)}`,
    ).toBe(false);

    await expect.poll(() => preferenceReads.length).toBeGreaterThan(0);
    const stored = await readStoredSendKey(page);
    console.log('KEYBOARD preference', JSON.stringify(stored));
    expect(
      stored.enabled,
      'this leg measures the default send key; the account has '
        + `sendByCtrlEnter=${JSON.stringify(stored.raw)}. A touch leg that wrote its device setting back into `
        + 'the account would show up right here.',
    ).toBe(false);

    // THE CELL (c): the positive control for both hidden cells above. Without it, `display: none` on a
    // touch device would be equally satisfied by deleting the hiding class everywhere — an inert
    // implementation that scores zero on the phone cell too, and would leave this task's own price
    // (AC-6) unmeasurable. The input is empty here, which is the state the heights were read in.
    const keyboard = await readCell(page, 'keyboard@1280');
    expect(
      keyboard.viewportWidth,
      cellMessage('keyboard@1280', keyboard, `this cell must sit at or above the ${LG_BREAKPOINT_PX}px lg breakpoint`),
    ).toBeGreaterThanOrEqual(LG_BREAKPOINT_PX);
    expect(
      keyboard.touchOnly,
      cellMessage('keyboard@1280', keyboard, `this cell must have a keyboard, so ${TOUCH_ONLY_QUERY} must not hold`),
    ).toBe(false);
    expect(
      keyboard.hintDisplay,
      cellMessage('keyboard@1280', keyboard, 'a keyboard device at or above lg must still be shown the hint'),
    ).toBe('block');
    // Visible is not the same as correct: the row that is shown here is the one the app ships, read off
    // the locale file rather than restated in this spec.
    expect(
      keyboard.hintText,
      cellMessage('keyboard@1280', keyboard, 'the keyboard cell must be shown the shipped Enter wording'),
    ).toBe(enChat.input.hintText.enter);

    const textarea = composer(page);

    // The empty-input dead key, unchanged by this task: Enter is swallowed and nothing happens.
    await textarea.click();
    await page.keyboard.press('Enter');
    await expect(textarea).toHaveValue('');
    expect(
      { pathname: new URL(page.url()).pathname },
      'an empty Enter on desktop is a dead key — it must neither send nor insert',
    ).toEqual({ pathname: '/' });

    // Shift+Enter is the newline key, and it is the browser's own default action, not the app's.
    await textarea.fill('line one');
    await textarea.press('Shift+Enter');
    await expect(textarea).toHaveValue('line one\n');
    expect(
      { pathname: new URL(page.url()).pathname },
      'Shift+Enter must not submit',
    ).toEqual({ pathname: '/' });

    // Plain Enter does submit.
    await textarea.press('Enter');
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);

    const readings = await keyReadings(page);
    console.log('KEYBOARD Enter readings', JSON.stringify(readings));
    expect(
      readings.filter((reading) => reading.key === 'Enter'),
      'exactly the two bare Enters are the app\'s to decide; Shift+Enter is the browser\'s default',
    ).toEqual([
      expect.objectContaining({ shiftKey: false, ctrlKey: false, defaultPrevented: true }),
      expect.objectContaining({ shiftKey: true, ctrlKey: false, defaultPrevented: false }),
      expect.objectContaining({ shiftKey: false, ctrlKey: false, defaultPrevented: true }),
    ]);
  });
});
