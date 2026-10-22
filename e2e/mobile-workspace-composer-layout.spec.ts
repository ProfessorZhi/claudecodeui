/**
 * The mobile workspace header and composer layout, read as a matrix in a real Chromium.
 *
 * Four implementation tasks each promised a shape for one part of the mobile chrome: the workspace header collapses
 * to a single row with one selector instead of a tablist, the composer footer stays on one line with everything
 * else behind a "more" menu, a recording's replay pair gets its own row *below* the textarea rather than pushing
 * the footer apart, and the running state shows exactly one interrupt control instead of two. Each of those was
 * read once, by hand, while it was being built. This file is the permanent reading: six viewports on both sides of
 * the 768 breakpoint, four states each, in one run against the real backend and the real Vite client.
 *
 * Why a matrix rather than one case per shape: the shapes are conditions, not constants. A bound like "the footer
 * may be 57px" is only meaningful at the width where the layout is supposed to be single-row, and a rule like
 * "the replay pair sits below the footer" is only meaningful once a clip exists. So each cell declares its width
 * and its state, asserts the *premise* that would make its reading meaningless (the viewport really is that wide,
 * the running state really appeared, both clips really exist), and only then asserts the geometry — a cell that
 * skipped the premise would pass against a clamped viewport or a recording that never produced a clip.
 *
 * Nothing here is a stand-in for the app. The recordings are real: Chromium is launched with a fake audio device
 * whose samples come from the WAV `playwright.config.ts` writes before the servers boot, the app's own recorder
 * and trim run, and the recogniser is a local HTTP server answering `/audio/transcriptions` the way the shipped
 * voice-trim spec does. The running state is the one exception, and it is a stand-in for the *transport*, never
 * for the consumer: an init script wraps `window.WebSocket` and hands the app one frame on its own chat socket,
 * exactly the frame shape the server sends (`kind: 'status'` with `canInterrupt`), so what the cells read is the
 * app's own reaction to a real frame arriving on a real socket.
 *
 * The readings are Chromium's viewport and touch emulation, not a real device, and the PWA safe-area inset is not
 * in effect in headless: `MOBILE_HEADER_MAX` is the bound *without* a safe area.
 *
 * Two measurement traps this file has to avoid, both found by reading the app rather than assuming it:
 *
 * The recogniser stand-in has to answer. With a base URL that refuses the connection, the app renders its voice
 * error notice inside the footer's right-hand control cluster, which grows the footer's scroll extent by 32px at
 * 320 — a *failing backend* moving the very number `noOverflow` asserts. A dead recogniser would red this matrix
 * for a reason that has nothing to do with layout, so the stand-in answers every transcription.
 *
 * The workspace dialog animates in. Radix mounts it with an entrance scale, so a reading taken on the first visible
 * frame measures the animation instead of the layout: the probe caught a 44px entry at 42.24px (44 x 0.96) and an
 * earlier one at 43px, either of which reads as a touch target below the declared minimum. The dialog's entries are
 * therefore polled until they settle before their height is used as a touch-target reading.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
/** The fake microphone's samples, written by the config before the browser was launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_TRIM_AUDIO!;
/** The fixture's own duration, derived by the config from the samples it wrote. */
const FIXTURE_SEC = Number(process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC);
/** One pass of the fixture, so the trim has a pause inside the window to remove. */
const CAPTURE_MS = Math.round(FIXTURE_SEC * 1000);

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';

/** The seeded long-title session the mobile cells read; its workspace is seeded by the config before boot. */
const MOBILE_SESSION = 'e2e-mobile-layout';
/**
 * The language the mobile cells read, chosen for its long tab labels rather than its own sake.
 *
 * The desktop cells read it too: the language a document ends up with is decided by whichever preference reaches the
 * server first, so a run that mixes languages across cells is reading a moving target. One language for the whole
 * matrix also means the baseline commit's narrowed desktop-only run reads the same bundle, which is what makes the
 * two sets of boxes comparable at all.
 */
const MOBILE_LANGUAGE = 'de';

/**
 * The three controls the mobile layout moved out of the footer and behind the `more` menu, under the names the
 * German bundle renders for them — read off the running app, not translated here. The German bundle has no `misc`
 * entries, so the token-usage label stays English at `de`; both cells assert the same three strings, the mobile ones
 * that the footer does not have them and the desktop ones that it does.
 */
const FOOTER_ONLY_CONTROLS = ['Alle Befehle anzeigen', 'Show token usage', 'Nachricht planen'];
/**
 * The pre-existing session the desktop cells read.
 *
 * Pre-existing on purpose: the desktop half of this matrix has to be readable on a baseline commit that predates
 * this task's fixtures as well, which is what makes the two readings comparable at all.
 */
const DESKTOP_SESSION = 'e2e-voice-trim';

/**
 * A model whose *label* is long — the default entry is `Default (recommended)`, which is short enough to hide an
 * overflow that a real model name would cause.
 *
 * Created through the provider API for the duration of the run and deleted again at the end: the model library
 * spec asserts the number of rows it finds, so a row left behind by this file is a red in another file.
 */
const LONG_MODEL_ID = 'e2e-layout-long-model';
const LONG_MODEL_LABEL = 'claude-sonnet-4-5-20250929';

/**
 * The header bound at mobile widths, with no PWA safe-area inset (headless has none) — 56px is the implementation
 * task's own bound, restated here so a drift shows up as a reading rather than as a number nobody wrote down.
 */
const MOBILE_HEADER_MAX = 56;
/**
 * The header's own computed top padding on each side of the breakpoint: the mobile branch's `py-1.5` and the desktop
 * branch's `py-2`.
 *
 * Read as a pair on purpose. `MOBILE_HEADER_MAX` is a *bound*, and a bound cannot see which CSS branch produced the
 * number it bounds: applying the desktop branch one pixel below the breakpoint moves the 767 header from 45px to 49px
 * and every bound-based assertion in the matrix still passes. The padding is the branch itself, so the pair
 * (`6px` at 767, `8px` at 768) is what makes the *position* of the CSS breakpoint a reading.
 */
const MOBILE_HEADER_PADDING_TOP = '6px';
const DESKTOP_HEADER_PADDING_TOP = '8px';
/** The footer bound once a replay row exists: the row is meant to be *outside* the footer, so the footer cannot grow. */
const MOBILE_FOOTER_MAX = 57;
/** How far the two footer control groups' tops may differ and still be one row (button heights differ by 4px). */
const SAME_ROW_TOP_TOLERANCE = 4;
/** The touch target the workspace dialog's entries have to offer. */
const MIN_TOUCH_TARGET = 44;

/** The interrupt control's accessible name, in the language the cell is reading and in the one a missing translation falls back to. */
const STOP_NAMES = ['Stop', 'Stoppen'];
/** The replay pair's accessible names. The German bundle has no `voice.*` entries, so these are the English fallback at every width. */
const REPLAY_ORIGINAL = /Replay original/;
const REPLAY_TRIMMED = /Replay trimmed/;

const MOBILE_VIEWPORTS = [
  { width: 320, height: 700 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 767, height: 900 },
];
/**
 * The desktop viewports, each declaring which footer arrangement its own box ends up in.
 *
 * Declared rather than derived from the width, because the width is not what decides it: 768×900 opens with the
 * sidebar out, so the composer is handed ~445px and takes the compact arrangement, while 1280×720 hands it ~866px
 * and keeps the desktop's. Each cell asserts the declared side as a premise (printing the box it measured) and then
 * reads that arrangement, so the two desktop cells together cover both tiers at widths where neither window rule
 * would put them.
 */
const DESKTOP_VIEWPORTS = [
  { width: 768, height: 900, compactFooter: true },
  { width: 1280, height: 720, compactFooter: false },
];
/**
 * The width of the composer's own input box below which the footer takes the compact arrangement, mirrored from
 * `COMPACT_TIER_WIDTH_PX` in `src/modules/chat/hooks/useComposerCompactTier.ts`.
 *
 * The desktop cells need it because the arrangement a desktop *window* gets is decided by the box inside it, not by
 * the window: 768×900 with the sidebar open hands the composer a 445px box, which is below this threshold, so its
 * footer takes the same one-row compact arrangement the mobile cells read, while 1280's 866px box keeps the
 * desktop's. Each desktop cell therefore asserts *which side of this threshold its own box is on* before it reads
 * any arrangement, so a cell whose box turned out to be on the other side fails as a premise rather than quietly
 * measuring an arrangement it was not written for.
 */
const COMPACT_TIER_WIDTH_PX = 800;

/**
 * The viewport *height* below which the layout takes the short tier, mirrored from `SHORT_VIEWPORT_MAX_HEIGHT_PX` in
 * `src/shared/hooks/useDeviceSettings.ts`.
 *
 * Restated rather than imported for the same reason as the width above: a drift in the constant becomes a reading in
 * this file instead of moving every cell with it.
 */
const SHORT_TIER_MAX_HEIGHT_PX = 480;
/**
 * The header's computed top padding on the short tier.
 *
 * A third value rather than either side of the 768 pair above, and it is asserted for the same reason that pair is:
 * `MOBILE_HEADER_MAX` is a bound, and a bound cannot see which CSS branch produced the number. This is the branch.
 */
const SHORT_HEADER_PADDING_TOP = '4px';
/**
 * The share of the viewport the transcript has to keep on the short tier.
 *
 * Measured before the tier existed: 126px of 330, which is 38%. The bar sits above that and below what the
 * arrangement delivers, so it is a reading about the shape rather than about a rounding.
 *
 * The two readings it has to clear are not the same number, and the difference is a child of the form rather than
 * a viewport: a session that is not already resident draws the switch's row above the input, and that row is worth
 * roughly a tenth of the viewport. The fixture session is one of those, so this cell reads 52%; the same
 * arrangement on a session that is already resident reads 63%. The bar is set under the first because the reading
 * has to hold for the sessions that exist, and the cell's log line carries the number so a drift shows up there.
 */
const MIN_TRANSCRIPT_SHARE = 0.5;
/**
 * The narrowest the input may be squeezed to on the short tier before "beside the controls" has stopped being
 * true. Set below anything the measured viewports produce (the narrowest is ~186px at 844 with the sidebar open)
 * and far above the 0px a collapsed column reports, which is the failure it exists to name.
 */
const MIN_INPUT_WIDTH = 120;
/**
 * The landscape phone viewports.
 *
 * Kept out of `MOBILE_VIEWPORTS` on purpose: every cell in that loop asserts the *mobile* header padding and the
 * mobile workspace selector, and these viewports are neither — 667 and 844 both clear the composer's `sm` boundary,
 * and 844 clears `md` as well, so the markup is the desktop's and only the height is a phone's. That combination is
 * the whole reason the short tier exists, and no existing loop in this file contains it.
 */
const SHORT_VIEWPORTS = [
  { width: 667, height: 375 },
  { width: 844, height: 330 },
];

/** The box the composer is handed, or null when no footer was found. */
const footerBoxWidth = (cell: CellReading): number | null => cell.footer?.clientWidth ?? null;

/** Whether the cell's own box is narrow enough for the compact arrangement. */
const boxIsNarrow = (cell: CellReading): boolean => {
  const box = footerBoxWidth(cell);
  return box !== null && box < COMPACT_TIER_WIDTH_PX;
};

/* ------------------------------------------------------------------------------------------------------------
 * The recogniser stand-in
 * --------------------------------------------------------------------------------------------------------- */

/**
 * The stand-in the shipped voice-trim spec uses, answering the one endpoint the direct voice path posts to.
 *
 * A cross-origin multipart POST carrying `Authorization` is not a simple request, so the browser sends a preflight
 * first and would block the call without an answer to it.
 */
const startRecognizer = async (): Promise<http.Server> => {
  const server = http.createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ text: 'a sentence the layout matrix records and never reads' }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

/* ------------------------------------------------------------------------------------------------------------
 * Session, language and the wire double
 * --------------------------------------------------------------------------------------------------------- */

/**
 * The premise that a sign-in worked: the token every later context replays is in `localStorage`.
 *
 * Read from storage rather than from the Settings button the older specs in this directory wait on. That button's
 * accessible name is `t('actions.settings')` — a *translated* label, "Einstellungen" once this same file's cells have
 * moved the account's language to de, and that preference is sticky on the server. So a second sign-in in one run (a
 * worker Playwright had to restart, say) would look for an English label the app no longer renders and sit there for
 * its whole timeout, failing a cell whose actual work never started. The token is what this helper needs, and it is
 * language-free.
 */
const authTokenStored = (page: Page) =>
  page.waitForFunction((key) => Boolean(window.localStorage.getItem(key)), AUTH_TOKEN_KEY, { timeout: 30_000 });

/** Creates the account (or signs in to it) and returns the token every later context replays. */
const bootstrapAuth = async (browser: Browser): Promise<string> => {
  const context = await browser.newContext({ baseURL: CLIENT_URL });
  const page = await context.newPage();
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  await expect(createAccount.or(page.locator('#username')).first()).toBeVisible({ timeout: 30_000 });
  if (await createAccount.count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').nth(0).fill(PASSWORD);
    await page.locator('input[type=password]').nth(1).fill(PASSWORD);
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await authTokenStored(page);
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill(USERNAME);
    await page.locator('input[type=password]').first().fill(PASSWORD);
    await page.locator('form button[type=submit]').click();
    await authTokenStored(page);
  }
  const token = (await page.evaluate((key) => window.localStorage.getItem(key), AUTH_TOKEN_KEY)) ?? '';
  await context.close();
  if (!token) throw new Error('the account was created but no auth token was captured');
  return token;
};

/**
 * Installs the transport-layer double: one socket wrapper, and a way to hand the app one frame on its own chat
 * socket. Only the chat socket is addressed — the shell keeps one of its own, and a chat frame delivered there
 * would be recorded as received without the composer ever seeing it.
 */
const installWireDouble = () => {
  const page = window as unknown as {
    __wireSockets: { url: string; socket: WebSocket }[];
    __injectFrame: (frame: unknown) => number;
  };
  page.__wireSockets = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      page.__wireSockets.push({ url: String(args[0]), socket: this as WebSocket });
    }
  } as unknown as typeof WebSocket;
  page.__injectFrame = (frame: unknown) => {
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

/** Everything a context needs before its first navigation: the session, the language, the voice backend, the double. */
const seedContext = async (
  context: BrowserContext,
  options: { token: string; language: string; recognizerUrl: string },
): Promise<void> => {
  await context.addInitScript(
    ({ token, language, recognizerUrl: url, authKey }: { token: string; language: string; recognizerUrl: string; authKey: string }) => {
      window.localStorage.setItem(authKey, token);
      // The two keys the first paint reads and the one hydration migrates from, exactly as the shipped voice spec
      // seeds them: a language that only existed in one of them would be dropped when the other one arrived.
      window.localStorage.setItem('userLanguage', language);
      window.localStorage.setItem(
        'user-preferences',
        JSON.stringify({ userLanguage: language, uiPreferences: { voiceEnabled: true } }),
      );
      window.localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: true }));
      window.localStorage.setItem(
        'voiceConfig',
        JSON.stringify({ baseUrl: url, apiKey: 'sk-e2e-mobile-layout', sttModel: 'whisper-large-v3-turbo', ttsModel: '', ttsVoice: '', ttsFormat: '' }),
      );
    },
    { token: options.token, language: options.language, recognizerUrl: options.recognizerUrl, authKey: AUTH_TOKEN_KEY },
  );
  await context.addInitScript(installWireDouble);
};

/** Delivers one running-state frame on the chat socket and reports how many open sockets took it. */
const injectStatusFrame = (page: Page, sessionId: string) =>
  page.evaluate(
    ({ id }: { id: string }) =>
      (window as unknown as { __injectFrame: (frame: unknown) => number }).__injectFrame({
        // The shape the server sends and the client's own `status` case reads: without `text` the frame is dropped
        // and without `canInterrupt` the interrupt control is not considered available.
        kind: 'status',
        id: `e2e-layout-status-${id}`,
        sessionId: id,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        role: 'assistant',
        text: 'working on the layout matrix',
        canInterrupt: true,
      }),
    { id: sessionId },
  );

/* ------------------------------------------------------------------------------------------------------------
 * The reading
 * --------------------------------------------------------------------------------------------------------- */

type BoxRect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
type Box = BoxRect | null;
type FooterBox = BoxRect & { clientWidth: number; scrollWidth: number };

type CellReading = {
  innerWidth: number;
  /** The viewport's other axis. Read for the short tier, and printed so a cell that meant to be short can prove it was. */
  innerHeight: number;
  header: Box;
  headerPaddingTop: string | null;
  footer: FooterBox | null;
  tools: Box;
  right: Box;
  clipRow: Box;
  /** The transcript's scroll container: the box every other reading on this page is paid for out of. */
  pane: Box;
  /** The input's own column. Read because "beside" is a claim about this box giving up width to the controls. */
  body: Box;
  /** The input, with the cap that bounds a draft's growth — the only thing bounding it, since JS writes its height. */
  textarea: (BoxRect & { maxHeight: string | null; scrollHeight: number }) | null;
  /** The composer's own submit control: the one stop entry at every width, and the control a long draft pushed off-screen. */
  submit: Box;
  /** Whether the composer's own form is laid out as a row, with the controls beside the input rather than under it. */
  composerIsRow: boolean;
  /**
   * The one activity dock, read at both candidate mount sites.
   *
   * `dockInTranscript` is the pane's copy — the only one drawn, at every viewport.
   * `dockInComposer` is read too, and must stay empty: the composer used to hang a
   * tab-shaped strip off the input from `md` up, and these two boxes are how this
   * file reads that the second mount site is gone rather than merely unused.
   */
  dockInTranscript: Box;
  dockInComposer: Box;
  clipButtons: { label: string | null; inClipRow: boolean; inTools: boolean; box: Box }[];
  stopNames: string[];
  tablists: number;
  collapsedTrigger: Box;
  collapsedText: string;
  modelTriggerText: string | null;
  modelTriggerBox: Box;
  footerText: string;
};

/** One reading of everything the cells assert on, taken in a single evaluate so the numbers describe one instant. */
const readCell = (page: Page): Promise<CellReading> =>
  page.evaluate((stopNames: string[]) => {
    const round = (n: number) => Math.round(n * 100) / 100;
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: round(r.top), bottom: round(r.bottom), left: round(r.left), right: round(r.right), width: round(r.width), height: round(r.height) };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const header = document.querySelector('header.pwa-header-safe');
    const footer = document.querySelector('[data-slot="prompt-input-footer"]') as HTMLElement | null;
    const tools = document.querySelector('[data-slot="prompt-input-tools"]');
    const right = footer?.querySelector('div.ml-auto') ?? null;
    const clipRow = document.querySelector('[data-slot="prompt-input-clip-row"]');
    const form = document.querySelector('form[data-slot="prompt-input"]') as HTMLFormElement | null;
    const pane = document.querySelector('.chat-messages-pane');
    const body = document.querySelector('[data-slot="prompt-input-body"]');
    const textarea = document.querySelector('[data-slot="prompt-input-textarea"]') as HTMLTextAreaElement | null;
    const submit = form?.querySelector('button[type="submit"]') ?? null;
    const collapsed = header?.querySelector('[aria-haspopup="dialog"]') ?? null;
    const modelButton = document.querySelector('button[aria-label="Select model and reasoning effort"]');
    const modelSpan = modelButton?.querySelector('span.truncate');
    const clipButtonList = [...document.querySelectorAll('button[data-clip-url]')];

    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      pane: box(pane),
      body: box(body),
      textarea: textarea
        ? { maxHeight: getComputedStyle(textarea).maxHeight, scrollHeight: textarea.scrollHeight, ...box(textarea)! }
        : null,
      submit: box(submit),
      // The arrangement is named for what it looks like — the controls beside the input — and the
      // mechanism is a grid, not a flex row: the form has a child that is a line of its own (the
      // resident switch, on any session that is not already resident), and a flex row seats that
      // child as its first *column*, taking the width the input was meant to have.
      composerIsRow: form ? getComputedStyle(form).display === 'grid' : false,
      header: box(header),
      headerPaddingTop: header ? getComputedStyle(header).paddingTop : null,
      footer: footer
        ? { clientWidth: footer.clientWidth, scrollWidth: footer.scrollWidth, ...box(footer)! }
        : null,
      tools: box(tools),
      right: box(right),
      clipRow: box(clipRow),
      dockInTranscript: box(document.querySelector('.chat-messages-pane [data-activity-dock]')),
      dockInComposer: box(document.querySelector('.chat-composer-shell [data-activity-dock]')),
      clipButtons: clipButtonList.map((b) => ({
        label: b.getAttribute('aria-label'),
        inClipRow: clipRow ? clipRow.contains(b) : false,
        inTools: tools ? tools.contains(b) : false,
        box: box(b),
      })),
      // Visible *and* named: a Stop inside a hidden branch is not an interrupt control, and one with no accessible
      // name is not one either — the whole point of the count is what a user can reach and read.
      stopNames: [...document.querySelectorAll('button[aria-label]')]
        .filter(visible)
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((label) => stopNames.includes(label)),
      tablists: document.querySelectorAll('[role="tablist"]').length,
      collapsedTrigger: box(collapsed),
      collapsedText: (collapsed?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      modelTriggerText: modelSpan ? (modelSpan.textContent ?? '').trim() : null,
      modelTriggerBox: box(modelButton),
      footerText: (footer?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  }, STOP_NAMES);

/**
 * The reading, formatted for a failure message.
 *
 * Every geometry assertion below goes through this: a criterion that failed with `expect(false).toBe(true)` would
 * say a cell is wrong and nothing about *how* wrong, and the numbers are the only thing that says whether a bound
 * is off by a rounding error or by a row.
 */
const describeReading = (label: string, cell: CellReading): string =>
  `${label}\n  header=${JSON.stringify(cell.header)} (max ${MOBILE_HEADER_MAX}) padTop=${cell.headerPaddingTop} (mobile ${MOBILE_HEADER_PADDING_TOP} / desktop ${DESKTOP_HEADER_PADDING_TOP})` +
  `\n  footer=${JSON.stringify(cell.footer)} (max height ${MOBILE_FOOTER_MAX})` +
  `\n  tools=${JSON.stringify(cell.tools)} right=${JSON.stringify(cell.right)}` +
  `\n  clipRow=${JSON.stringify(cell.clipRow)} dockInTranscript=${JSON.stringify(cell.dockInTranscript)} dockInComposer=${JSON.stringify(cell.dockInComposer)}` +
  `\n  clipButtons=${JSON.stringify(cell.clipButtons)}` +
  `\n  visible stop names=${JSON.stringify(cell.stopNames)} tablists=${cell.tablists}` +
  `\n  collapsed=${JSON.stringify(cell.collapsedTrigger)} ${JSON.stringify(cell.collapsedText)}` +
  `\n  modelTrigger=${JSON.stringify(cell.modelTriggerText)} ${JSON.stringify(cell.modelTriggerBox)}` +
  `\n  innerWidth=${cell.innerWidth} footerText=${JSON.stringify(cell.footerText)}`;

/** One geometry assertion: passes silently, and on failure prints the whole reading rather than a bare `false`. */
const expectReading = (ok: boolean, label: string, cell: CellReading) =>
  expect(ok, describeReading(label, cell)).toBe(true);

/**
 * The breakpoint criterion: every mobile width's header has to carry the mobile CSS branch's padding, every desktop
 * width's the desktop branch's.
 *
 * The JS tier boundary is 768 — that is what decides which markup is rendered and is asserted all over this file. This
 * is the other half of the same requirement: the *CSS* boundary has to sit there too, or a width just below it gets
 * desktop padding on mobile markup. Nothing else in the matrix can see that, because every other header assertion is a
 * bound (see `MOBILE_HEADER_PADDING_TOP`).
 */
const expectHeaderBranch = (width: number, cell: CellReading) => {
  const mobile = MOBILE_VIEWPORTS.some((viewport) => viewport.width === width);
  const expected = mobile ? MOBILE_HEADER_PADDING_TOP : DESKTOP_HEADER_PADDING_TOP;
  expectReading(
    cell.headerPaddingTop === expected,
    `@${width}: the header must carry the ${mobile ? 'mobile' : 'desktop'} CSS branch's top padding (${expected}), ` +
      `so that the CSS breakpoint sits at 768 where the JS tier boundary is — read ${cell.headerPaddingTop}`,
    cell,
  );
};

/**
 * The premise a desktop cell asserts before it reads any arrangement: its own box is on the side of the tier
 * threshold the case declares.
 *
 * Without it a cell could read the *other* arrangement and still pass — `oneRow` is true on the compact tier and
 * true on the wide tier at a wide enough box, so a 768 cell whose box had somehow stayed 866px wide would read a
 * correct-looking row while measuring the arrangement 1280 is there to measure. The box width is printed either
 * way, which is what the criterion asks for: record `footer.clientWidth` so the reading can be checked against the
 * band the case claimed.
 */
const expectFooterBoxTier = (width: number, narrow: boolean, cell: CellReading): void =>
  expectReading(
    boxIsNarrow(cell) === narrow,
    `@${width}: this case reads the ${narrow ? 'compact' : 'wide'} arrangement, so the composer's box has to be ` +
      `${narrow ? 'below' : 'at or above'} ${COMPACT_TIER_WIDTH_PX}px; it read ${footerBoxWidth(cell)}px ` +
      '— a cell whose box is on the other side is not measuring what it was written for',
    cell,
  );

/**
 * The desktop footer's arrangement: one row, at both desktop widths and for both tiers.
 *
 * The window no longer decides this. A 768px window with the sidebar open hands the composer a 445px box, and the
 * arrangement that fits the row into that box is the same compact one the mobile cells read — which is what makes
 * the assertion identical at both desktop widths rather than relaxed at the narrower one. Asserting the wrap at 768
 * (what this file did before `gap-composer-footer-tier-follows-own-width` landed) was the criterion being written
 * around the defect instead of the requirement: the two groups sitting on separate lines *is* the failure.
 */
const expectDesktopFooterRow = (width: number, cell: CellReading) =>
  expectReading(
    oneRow(cell),
    `@${width}: the desktop footer's two control groups must be one row — tools ${JSON.stringify(cell.tools)} ` +
      `vs right ${JSON.stringify(cell.right)}, tolerance ${SAME_ROW_TOP_TOLERANCE}px`,
    cell,
  );

/**
 * The desktop footer's sideways reading, asserted at every desktop width.
 *
 * It was a mobile-only bound while the desktop footer was the wrapping one: at 768 a replay pair in the tool group
 * pushed the content 25px past a 445px box. The box is what decides the arrangement now, so that box takes the
 * compact tier, the wrap never arises, and the desktop footer is a non-scrolling row at both widths — the same
 * reading the mobile cells are given, for the same reason.
 */
const expectDesktopFooterOverflow = (width: number, cell: CellReading): void => {
  if (cell.footer && cell.footer.scrollWidth > cell.footer.clientWidth) {
    console.log(
      `[layout] NOTE @${width}: the composer footer scrolls sideways by ${cell.footer.scrollWidth - cell.footer.clientWidth}px`,
    );
  }
  expectReading(noOverflow(cell), `@${width}: the desktop footer must not scroll sideways`, cell);
};

/** The premise every cell asserts before it reads: the viewport really is the width the case declares. */
const expectDeclaredWidth = (cell: CellReading, width: number) =>
  expect(cell.innerWidth, `the case declares ${width}px; the page reports ${cell.innerWidth}px`).toBe(width);

/** The single-row reading: both footer groups are present, their vertical ranges overlap, and their tops are close. */
const oneRow = (cell: CellReading): boolean => {
  const { tools, right } = cell;
  if (!tools || !right) return false;
  const overlaps = tools.top < right.bottom && right.top < tools.bottom;
  return overlaps && Math.abs(tools.top - right.top) <= SAME_ROW_TOP_TOLERANCE;
};

/**
 * The wrapped reading: the two groups are on separate lines.
 *
 * Printed for every cell and asserted by none. It is the *complement* of `oneRow`, so asserting both would be one
 * criterion counted twice; keeping it in the log line is what makes a failure legible — `sameRow=false stacked=true`
 * says "two rows" where `sameRow=false stacked=false` would say the groups were missing entirely.
 */
const stacked = (cell: CellReading): boolean => {
  const { tools, right } = cell;
  if (!tools || !right) return false;
  return tools.bottom <= right.top || right.bottom <= tools.top;
};

/** The footer's own overflow reading: it scrolls sideways exactly as far as it is wide. */
const noOverflow = (cell: CellReading): boolean =>
  cell.footer !== null && cell.footer.scrollWidth === cell.footer.clientWidth;

/**
 * The per-cell reading line, printed for every cell whether it passes or fails.
 *
 * This is the matrix's own output: the criteria ask for a reading table — header height, footer overflow, the
 * same-row reading, footer height, the visible interrupt count — for every viewport and state, and cells that only
 * print when they fail cannot produce one.
 */
const logCell = (label: string, cell: CellReading): void => {
  const gap = cell.tools && cell.right ? Math.round(Math.abs(cell.tools.top - cell.right.top) * 100) / 100 : null;
  console.log(
    `[layout] READING ${label}: header=${cell.header?.height ?? 'none'}px padTop=${cell.headerPaddingTop ?? 'none'}` +
      ` footer=${cell.footer ? `${cell.footer.scrollWidth}/${cell.footer.clientWidth}` : 'none'}` +
      ` (h-overflow=${cell.footer ? cell.footer.scrollWidth - cell.footer.clientWidth : 'n/a'}, h=${cell.footer?.height ?? 'none'}px)` +
      ` groups tools.top=${cell.tools?.top ?? 'none'} right.top=${cell.right?.top ?? 'none'} diff=${gap}` +
      ` sameRow=${oneRow(cell)} stacked=${stacked(cell)}` +
      ` stops=${cell.stopNames.length}${JSON.stringify(cell.stopNames)}` +
      ` clipRow=${cell.clipRow ? `${cell.clipRow.top}..${cell.clipRow.bottom}` : 'none'}` +
      ` tablists=${cell.tablists} innerWidth=${cell.innerWidth} innerHeight=${cell.innerHeight}` +
      ` pane=${cell.pane?.height ?? 'none'}px row=${cell.composerIsRow} body=${JSON.stringify(cell.body)}` +
      ` ta=${JSON.stringify(cell.textarea)} submit=${JSON.stringify(cell.submit)}`,
  );
};

/** The replay pair's own reading, counted in the accessibility tree so "two sets of controls" cannot pass as one pair. */
const replayCounts = async (page: Page) => {
  const snapshot = await page.locator('body').ariaSnapshot();
  const lines = snapshot.split('\n');
  return {
    original: lines.filter((line) => REPLAY_ORIGINAL.test(line)).length,
    trimmed: lines.filter((line) => REPLAY_TRIMMED.test(line)).length,
    excerpt: lines.filter((line) => /Replay/.test(line)),
  };
};

/**
 * The workspace dialog's entries, measured on each entry's own box.
 *
 * The poll below and the assertion after it both read through this, so the numbers being waited for are the numbers
 * being asserted on — and both are rounded the same way, which matters at a boundary of exactly 44.
 */
const dialogEntries = (page: Page) =>
  page.getByRole('dialog').locator('button').evaluateAll((buttons) =>
    buttons.map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent ?? '').replace(/\s+/g, ' ').trim(), width: Math.round(r.width), height: Math.round(r.height) };
    }),
  );

/* ------------------------------------------------------------------------------------------------------------
 * Recording, and the long model
 * --------------------------------------------------------------------------------------------------------- */

/** The microphone, whose accessible name is English at both languages (the German bundle has no `voice.*` entries). */
const mic = (page: Page) => page.getByRole('button', { name: 'Voice input' });
const stopRecording = (page: Page) => page.getByRole('button', { name: 'Stop recording' });

/**
 * Records one pass of the fixture through the app's own button and waits for the clip to exist.
 *
 * Waits on the clip *control*, not on the clip row: the row exists only below the breakpoint, so waiting for it would
 * make every desktop cell time out here. The pair itself — one button per track, each carrying its own clip URL — is
 * what a recording produces at either width. Timed rather than merely awaited: the recording is the expensive part
 * of a cell, and the criteria have to report what the run cost.
 */
const recordOnce = async (page: Page, label: string): Promise<number> => {
  const started = Date.now();
  await mic(page).click();
  await expect(stopRecording(page)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(CAPTURE_MS);
  await stopRecording(page).click();
  await expect(page.locator('button[data-clip-url]').first()).toBeVisible({ timeout: 30_000 });
  const cost = Date.now() - started;
  console.log(`[layout] ${label}: one recording in ${cost}ms`);
  return cost;
};

/**
 * Selects the long model through the composer's own menu, the way a user does.
 *
 * Seeding `localStorage['claude-model']` would not do: the catalog is fetched on mount, and a stored value that is
 * not in it is discarded — so the value has to be picked after the load, from the menu the app renders.
 */
const selectLongModel = async (page: Page, width: number): Promise<void> => {
  const trigger = page.getByRole('button', { name: 'Select model and reasoning effort' });
  await expect(trigger, `@${width}: the model trigger has to exist before the long name can be picked`).toBeVisible({ timeout: 15_000 });
  await trigger.click();
  // The model row is a collapsible menuitem; the options are the radios inside it once it is open.
  await page.getByRole('menuitem').first().click();
  await page.getByRole('menuitemradio', { name: LONG_MODEL_LABEL }).click();
  await expect(trigger).toContainText(LONG_MODEL_LABEL);
};

/* ------------------------------------------------------------------------------------------------------------
 * The matrix
 * --------------------------------------------------------------------------------------------------------- */

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

let authToken = '';
let recognizer: http.Server;
let recognizerUrl = '';
let longModelRecordId = '';

test.beforeAll(async ({ browser, request }) => {
  test.setTimeout(120_000);
  recognizer = await startRecognizer();
  recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;
  authToken = await bootstrapAuth(browser);

  const created = await request.post('/api/providers/claude/models', {
    headers: { authorization: `Bearer ${authToken}` },
    data: { id: LONG_MODEL_ID, model: LONG_MODEL_LABEL },
  });
  expect(
    created.status(),
    `creating the long model has to answer 201; it answered ${created.status()} ${await created.text()}`,
  ).toBe(201);
  longModelRecordId = ((await created.json()) as { data: { model: { recordId: string } } }).data.model.recordId;
  console.log(`[layout] long model ${LONG_MODEL_LABEL} created as ${longModelRecordId}; recogniser at ${recognizerUrl}`);
});

test.afterAll(async ({ request }) => {
  // The model library spec asserts how many rows it finds, so the row this file added has to be gone before any
  // other file runs. The recogniser is this run's own process and would die with it, but a run that closed it
  // explicitly is a run whose port is released for the next one.
  if (longModelRecordId) {
    const removed = await request.delete(`/api/providers/claude/models/${longModelRecordId}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(removed.status(), `deleting the long model has to answer 2xx; it answered ${removed.status()}`).toBeLessThan(300);
  }
  await new Promise<void>((resolve) => recognizer.close(() => resolve()));
});

/** Opens a document with everything the cell needs, at the width the case declares. */
const openCell = async (
  browser: Browser,
  options: { width: number; height: number; touch: boolean; language: string; session: string; query?: string },
) => {
  const context = await browser.newContext({
    baseURL: CLIENT_URL,
    viewport: { width: options.width, height: options.height },
    hasTouch: options.touch,
    isMobile: options.touch,
    permissions: ['microphone'],
  });
  await seedContext(context, { token: authToken, language: options.language, recognizerUrl });
  const page = await context.newPage();
  await page.goto(`/session/${options.session}${options.query ?? ''}`);
  return { context, page };
};

/**
 * The composer's presence, waited for in a way that survives the document restarting underneath the wait.
 *
 * A first paint can be pulled out from under this locator: the app's own Vite client reloads the document after
 * `504 Outdated Optimize Dep`, which the shipped transcript-follow fixture documents at its own onboarding step,
 * and a locator left waiting across that restart waits on a document that no longer exists — the cell then dies
 * on the ceiling above it with nothing to read. One matrix run did exactly that: `@360 double playback` sat its
 * whole 30s on a footer that a reloaded document would have rendered in a second, while every other cell in the
 * same run read the same footer fine. So the wait is bounded into probes with a bounded number of reloads, and a
 * composer that is still absent afterwards is a reading the cell can print, not a silent timeout.
 */
const settleComposer = async (page: Page, width: number): Promise<void> => {
  const footer = page.locator('[data-slot="prompt-input-footer"]');
  const appears = (timeoutMs: number) =>
    footer.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true, () => false);
  let up = await appears(10_000);
  for (let attempt = 0; !up && attempt < 2; attempt += 1) {
    await page.reload().catch(() => undefined);
    up = await appears(8_000);
  }
  expect(up, `@${width}: the composer footer never rendered, so this run's client never came up to a document that stays`).toBe(true);
};

/* ------------------------------------------------------------------------------------------------------------
 * Mobile cells: four widths, four states
 * --------------------------------------------------------------------------------------------------------- */

for (const viewport of MOBILE_VIEWPORTS) {
  const { width, height } = viewport;

  test.describe(`mobile workspace and composer @${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test(`@${width} idle — one header row, one footer row, everything else behind the more menu`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);

        await selectLongModel(page, width);
        await page.waitForTimeout(250);
        const cell = await readCell(page);
        logCell(`@${width} idle`, cell);

        expectReading(cell.header !== null && cell.header.height <= MOBILE_HEADER_MAX, `@${width} idle: the header must be a single row of at most ${MOBILE_HEADER_MAX}px`, cell);
        expectHeaderBranch(width, cell);
        expectReading(noOverflow(cell), `@${width} idle: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} idle: the footer's two control groups must be one row`, cell);
        expectReading(cell.tablists === 0, `@${width} idle: no tablist may survive below the breakpoint`, cell);
        expectReading(cell.collapsedTrigger !== null && cell.collapsedTrigger.height > 0, `@${width} idle: the workspace selector must be there instead`, cell);
        // The long model label is the whole reason this cell picks one: the footer that has to hold it is the one
        // whose overflow is asserted above, and a short default label would have hidden that requirement.
        expectReading(cell.modelTriggerText === LONG_MODEL_LABEL, `@${width} idle: the composer must be showing the long model name`, cell);

        // Token usage, commands and scheduling are not in the footer any more, and the "more" menu is where they
        // went: one click, which is the "within two clicks" the criterion asks for.
        const footer = page.locator('[data-slot="prompt-input-footer"]');
        for (const name of FOOTER_ONLY_CONTROLS) {
          expectReading(
            (await footer.getByRole('button', { name }).count()) === 0,
            `@${width} idle: ${name} must not be in the footer`,
            cell,
          );
        }
        const more = footer.getByRole('button', { name: /More tools|Weitere Tools/ });
        expectReading((await more.count()) === 1, `@${width} idle: the more menu's trigger must be in the footer`, cell);
        await more.click();
        const menu = page.locator('[role="menu"]');
        await expect(menu).toBeVisible({ timeout: 5_000 });
        const items = (await menu.locator('[role="menuitem"]').allTextContents()).map((text) => text.replace(/\s+/g, ' ').trim());
        console.log(`[layout] @${width} idle more menu: ${JSON.stringify(items)}`);
        for (const fragment of ['Alle Befehle', 'Token', 'Nachricht planen']) {
          expectReading(
            items.some((item) => item.toLowerCase().includes(fragment.toLowerCase())),
            `@${width} idle: the more menu must offer ${fragment}; it offered ${JSON.stringify(items)}`,
            cell,
          );
        }
        await page.keyboard.press('Escape');

        // The workspace selector's own dialog: every entry has to be a touch target, and picking one has to close
        // the dialog and land on that workspace.
        await page.locator('header [aria-haspopup="dialog"]').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 5_000 });
        // The dialog scales in, so its first visible frame is smaller than its layout: poll until every entry has
        // settled at its declared minimum rather than measuring the animation (see the header comment).
        await expect
          .poll(
            async () =>
              (await dialogEntries(page)).filter((entry) => entry.width < MIN_TOUCH_TARGET || entry.height < MIN_TOUCH_TARGET).length,
            { message: `@${width} idle: the dialog entries must settle at ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET}` },
          )
          .toBe(0);
        const entries = await dialogEntries(page);
        console.log(`[layout] @${width} idle dialog entries: ${JSON.stringify(entries)}`);
        const small = entries.filter((entry) => entry.width < MIN_TOUCH_TARGET || entry.height < MIN_TOUCH_TARGET);
        expectReading(
          entries.length > 1 && small.length === 0,
          `@${width} idle: every dialog entry must be at least ${MIN_TOUCH_TARGET}x${MIN_TOUCH_TARGET}; the small ones read ${JSON.stringify(small)}`,
          cell,
        );
        await dialog.locator('button', { hasText: /Files|Dateien/ }).first().click();
        await expect(dialog).toBeHidden({ timeout: 5_000 });
        const switched = await readCell(page);
        expectReading(
          /Files|Dateien/.test(switched.collapsedText),
          `@${width} idle: the selector must name the workspace that was picked`,
          switched,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} single playback — one clip, its own row above the footer, footer height unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, {
        ...viewport,
        touch: true,
        language: MOBILE_LANGUAGE,
        session: MOBILE_SESSION,
        // Trim off is what makes this the *single* clip case: the original is uploaded as it was recorded, so the
        // pair the trimmed recording produces never exists.
        query: '?voiceTrim=off',
      });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);
        const before = await readCell(page);
        // The premise the footer-height comparison rests on: without it, "unchanged" could be two different
        // failures cancelling out.
        expectReading(before.footer !== null, `@${width} single: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} single`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} single aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} single playback`, cell);

        expectReading(counts.original === 1 && counts.trimmed === 0, `@${width} single: exactly one replay control, and it is the original's`, cell);
        expectReading(cell.clipButtons.length === 1 && cell.clipButtons.every((b) => b.inClipRow), `@${width} single: the one clip control must live in the clip row`, cell);
        expectReading(cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top, `@${width} single: the replay row must sit above the footer`, cell);
        expectReading(cell.footer !== null && cell.footer.height <= MOBILE_FOOTER_MAX, `@${width} single: the footer must not grow around the replay row`, cell);
        expectReading(noOverflow(cell), `@${width} single: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} single: the footer's two control groups must still be one row`, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} single: the footer height must be identical before and after the clip appears (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} double playback — the pair is one row above the footer, footer height unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);
        const before = await readCell(page);
        expectReading(before.footer !== null, `@${width} double: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} double`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} double aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} double playback`, cell);

        // The premise: the trimmed pair is what this cell is about, and a recording that produced only the
        // original would satisfy every geometry assertion below while testing the single case again.
        expectReading(counts.original === 1 && counts.trimmed === 1, `@${width} double: exactly one original and one trimmed replay control`, cell);
        expectReading(cell.clipButtons.length === 2, `@${width} double: both clip controls must be in the composer`, cell);
        expectReading(cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top, `@${width} double: the clip row must sit above the footer`, cell);
        expectReading(cell.footer !== null && cell.footer.height <= MOBILE_FOOTER_MAX, `@${width} double: the footer must not grow around the clip row`, cell);
        expectReading(noOverflow(cell), `@${width} double: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} double: the footer's two control groups must still be one row`, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} double: the footer height must be identical before and after the clips appear (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} running — exactly one accessible interrupt control`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        await selectLongModel(page, width);

        const delivered = await injectStatusFrame(page, MOBILE_SESSION);
        console.log(`[layout] @${width} running: status frame delivered to ${delivered} chat socket(s)`);
        // The premise: the frame was delivered *and* the app acted on it. A frame that never arrived looks exactly
        // like a state that was never entered, and every assertion below would then be read off an idle page.
        expect(delivered, `@${width} running: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
        await expect(page.locator('.chat-messages-pane [data-activity-dock]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);

        const cell = await readCell(page);
        logCell(`@${width} running`, cell);
        expectReading(cell.stopNames.length === 1, `@${width} running: exactly one visible and named interrupt control`, cell);
        expectReading(
          cell.dockInComposer === null || cell.dockInComposer.width === 0,
          `@${width} running: the composer's mount site for the dock must not be used at this width`,
          cell,
        );
        expectReading(cell.dockInTranscript !== null && cell.dockInTranscript.height > 0, `@${width} running: the transcript's mount site must be the one that draws the dock`, cell);
        expectReading(noOverflow(cell), `@${width} running: the footer must not scroll sideways`, cell);
        expectReading(oneRow(cell), `@${width} running: the footer's two control groups must still be one row`, cell);
      } finally {
        await context.close();
      }
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------
 * Short cells: a phone held sideways, where the chrome that fits a desktop does not fit the screen
 * --------------------------------------------------------------------------------------------------------- */

for (const viewport of SHORT_VIEWPORTS) {
  const { width, height } = viewport;

  test.describe(`short viewport (landscape phone) @${width}x${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test(`@${width}x${height} — controls beside the input, and the transcript keeps the screen`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: true, language: MOBILE_LANGUAGE, session: MOBILE_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);

        const cell = await readCell(page);
        logCell(`@${width}x${height} short`, cell);

        // Premises, without which every reading below could be of some other layout. The height one matters most:
        // if the viewport were taller than the tier, the composer would still be the stacked one and this cell
        // would be measuring the arrangement it was written to distinguish itself from.
        expectReading(cell.innerHeight === height, `@${width}x${height}: premise — the viewport must really be ${height} tall`, cell);
        expectReading(
          cell.innerHeight < SHORT_TIER_MAX_HEIGHT_PX,
          `@${width}x${height}: premise — ${height} has to be under the ${SHORT_TIER_MAX_HEIGHT_PX}px tier, or this cell reads the tall layout`,
          cell,
        );
        expectReading(
          width >= 640,
          `@${width}x${height}: premise — the composer must be past \`sm\`, or the textarea's cap is the narrow one and the cap reading below is about a different rule`,
          cell,
        );

        // The branch rather than a bound: 4px is the short tier's own padding and neither value of the 768 pair, so
        // a header that took the desktop branch at a short viewport fails here and nowhere else in the file.
        expectReading(
          cell.headerPaddingTop === SHORT_HEADER_PADDING_TOP,
          `@${width}x${height}: the header must carry the short tier's own top padding (${SHORT_HEADER_PADDING_TOP}), not either side of the 768 pair`,
          cell,
        );

        // The arrangement: one row, the input leading it, and both control groups still sharing a line inside it.
        expectReading(cell.composerIsRow, `@${width}x${height}: the composer must lay its controls beside the input, not under it`, cell);
        expectReading(oneRow(cell), `@${width}x${height}: the row's two control groups must still be one row`, cell);
        expectReading(noOverflow(cell), `@${width}x${height}: the footer must not scroll sideways`, cell);
        // "Beside" is two claims, and the width one is the load-bearing half. Position alone passes against a
        // column that collapsed to nothing: the first draft of this cell asserted only `left`, and it went green
        // in a browser where the input was 0px wide because a form child that is a row of its own — the resident
        // switch, which only a session that is not already resident draws — had taken the slack as a flex item.
        // A floor on the input's width is what makes a stray column fail as itself rather than as a control that
        // happens to sit to its right.
        expectReading(
          cell.textarea !== null && cell.footer !== null && cell.textarea.left < cell.footer.left,
          `@${width}x${height}: the input must be to the left of the controls — the reading that distinguishes "beside" from "under"`,
          cell,
        );
        expectReading(
          cell.textarea !== null && cell.textarea.width >= MIN_INPUT_WIDTH,
          `@${width}x${height}: the input must still be a usable column (>=${MIN_INPUT_WIDTH}px) after the controls take theirs — it is ${cell.textarea ? Math.round(cell.textarea.width) : 'none'}px, and a form child that became a column of the row instead of a line of its own is what collapses it`,
          cell,
        );

        // The point of the whole tier: the transcript's share of a viewport this short.
        const share = cell.pane ? cell.pane.height / cell.innerHeight : 0;
        expectReading(
          share >= MIN_TRANSCRIPT_SHARE,
          `@${width}x${height}: the transcript must keep at least ${Math.round(MIN_TRANSCRIPT_SHARE * 100)}% of the viewport; it kept ${Math.round(share * 100)}% (${cell.pane?.height ?? 'none'}px of ${cell.innerHeight})`,
          cell,
        );

        // The regression this tier was measured for. Before it, a 20-line draft grew the input to its 300px
        // `sm:` cap, the composer reached 116% of the viewport, and the submit button sat past the bottom edge
        // with `html,body{overflow:hidden}` making it unreachable. Nothing above would catch that: it takes a draft.
        await page.locator('[data-slot="prompt-input-textarea"]').fill(
          Array.from({ length: 20 }, (_, index) => `draft line ${index + 1}`).join('\n'),
        );
        await page.waitForTimeout(400);
        const drafted = await readCell(page);
        logCell(`@${width}x${height} short + 20-line draft`, drafted);

        expectReading(
          drafted.submit !== null && drafted.submit.bottom <= drafted.innerHeight,
          `@${width}x${height}: with a 20-line draft the submit button must stay inside the viewport — it ends at ${drafted.submit?.bottom ?? 'none'} of ${drafted.innerHeight}`,
          drafted,
        );
        expectReading(
          drafted.textarea !== null && drafted.textarea.height <= 0.45 * drafted.innerHeight + 1,
          `@${width}x${height}: the draft must be capped to a share of the viewport (<=45%), not to the desktop's 300px — it is ${drafted.textarea?.height ?? 'none'}px of ${drafted.innerHeight}`,
          drafted,
        );
        expectReading(
          drafted.textarea !== null && drafted.textarea.scrollHeight > drafted.textarea.height,
          `@${width}x${height}: premise — the draft has to overflow the capped box, or the cap was never reached and the two readings above are about a short draft`,
          drafted,
        );
        expectReading(
          drafted.pane !== null && drafted.pane.height / drafted.innerHeight >= 0.4,
          `@${width}x${height}: even a full draft must leave the transcript 40% of the viewport; it left ${Math.round(((drafted.pane?.height ?? 0) / drafted.innerHeight) * 100)}%`,
          drafted,
        );

        // Where the status goes on this tier. It takes a running turn to read at all — an idle session that is
        // not resident draws no status, so asserting the mount site on the idle reading above would be asserting
        // the absence of a thing that was never going to be there (which is exactly how the first draft of this
        // cell failed). The frame is injected last so it cannot move the draft readings above: it turns the
        // submit into a Stop and the composer into a different control.
        await page.locator('[data-slot="prompt-input-textarea"]').fill('');
        const delivered = await injectStatusFrame(page, MOBILE_SESSION);
        expect(delivered, `@${width}x${height}: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
        await expect(page.locator('.chat-messages-pane [data-activity-dock]')).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);

        const running = await readCell(page);
        logCell(`@${width}x${height} short + running`, running);
        expectReading(
          running.dockInTranscript !== null && running.dockInTranscript.height > 0,
          `@${width}x${height}: the transcript's line must be drawing the status — the composer has no status surface of its own at any viewport`,
          running,
        );
        expectReading(
          running.dockInComposer === null || running.dockInComposer.width === 0,
          `@${width}x${height}: the composer must draw no status surface`,
          running,
        );
      } finally {
        await context.close();
      }
    });
  });
}

/**
 * The control the short tier shipped without, and the reason it had to be added.
 *
 * The tier was first written as "the viewport is short", full stop. That is true of a phone in landscape and
 * equally true of a desktop window with DevTools docked to the bottom, and the second one was handed the phone's
 * layout: the composer's keyboard hint — a row a touch device never draws, because it is hidden at every width —
 * stayed visible and went into the footer's single row, where `basis-full` means nothing, taking 467px of an
 * 866px composer and leaving the input **138px**. Every landscape cell in this file passed throughout, because
 * every one of them emulates a touch device.
 *
 * So this cell is the same height as the landscape cells and the opposite device. Its premises are the point: the
 * viewport really is short, so the height half of the tier IS satisfied, and the pointer really is fine, so the
 * device half is the only thing holding the tier off. Without them the cell would pass against a build that
 * dropped the height rule entirely.
 */
const SHORT_DESKTOP_VIEWPORT = { width: 1440, height: 450 };
/** The input width the phone layout left behind: asserted against, so a return to it fails here by number. */
const CRUSHED_INPUT_WIDTH = 138;
/** What a 1440-wide composer's input column measures when the arrangement is the desktop's. */
const MIN_DESKTOP_INPUT_WIDTH = 400;

test.describe('short viewport on a mouse-and-keyboard device', () => {
  test.use({ viewport: SHORT_DESKTOP_VIEWPORT, hasTouch: false, isMobile: false });

  test(`@${SHORT_DESKTOP_VIEWPORT.width}x${SHORT_DESKTOP_VIEWPORT.height} — a short desktop window keeps the desktop arrangement`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, page } = await openCell(browser, {
      ...SHORT_DESKTOP_VIEWPORT,
      touch: false,
      language: MOBILE_LANGUAGE,
      session: MOBILE_SESSION,
    });
    try {
      await settleComposer(page, SHORT_DESKTOP_VIEWPORT.width);
      await expectDeclaredWidth(await readCell(page), SHORT_DESKTOP_VIEWPORT.width);

      const cell = await readCell(page);
      logCell(`@${SHORT_DESKTOP_VIEWPORT.width}x${SHORT_DESKTOP_VIEWPORT.height} short desktop`, cell);

      const touchOnly = await page.evaluate(
        () => window.matchMedia('(pointer: coarse) and (hover: none)').matches,
      );
      expectReading(
        cell.innerHeight === SHORT_DESKTOP_VIEWPORT.height && cell.innerHeight < SHORT_TIER_MAX_HEIGHT_PX,
        `@short desktop: premise — the viewport must really be ${SHORT_DESKTOP_VIEWPORT.height}px tall and under the ${SHORT_TIER_MAX_HEIGHT_PX}px tier, or the height half of the rule is not being tested`,
        cell,
      );
      expectReading(
        touchOnly === false,
        `@short desktop: premise — the pointer must really be fine, or the device half is not the thing holding the tier off`,
        cell,
      );

      // The arrangement itself: the desktop's, not the phone's.
      expectReading(
        cell.composerIsRow === false,
        `@short desktop: the composer must keep the desktop's stacked arrangement — the controls under the input, not beside it`,
        cell,
      );
      expectReading(
        cell.textarea !== null && cell.textarea.width >= MIN_DESKTOP_INPUT_WIDTH,
        `@short desktop: the input must keep its desktop width (>=${MIN_DESKTOP_INPUT_WIDTH}px) — the phone layout left it ${CRUSHED_INPUT_WIDTH}px, which is what this cell exists to catch; it is ${cell.textarea ? Math.round(cell.textarea.width) : 'none'}px`,
        cell,
      );
      // The branch, not a bound: 8px is the desktop branch's padding and 4px is the short tier's.
      expectReading(
        cell.headerPaddingTop === DESKTOP_HEADER_PADDING_TOP,
        `@short desktop: the header must keep the desktop branch's padding (${DESKTOP_HEADER_PADDING_TOP}), not the short tier's`,
        cell,
      );
      expectReading(noOverflow(cell), `@short desktop: the footer must not scroll sideways`, cell);

      // Where the status goes, read on a running turn. An idle session that is not resident draws no
      // status at all, so asserting the mount site on the reading above would assert the placement of
      // a thing that was never going to be there — the same mistake this file's landscape cells each
      // had to be corrected for. The frame goes in last so it cannot move the readings above: it
      // turns the submit button into a Stop and the composer into a different control.
      const delivered = await injectStatusFrame(page, MOBILE_SESSION);
      expect(delivered, `@short desktop: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
      await expect(page.locator('.chat-messages-pane [data-activity-dock]')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);

      const running = await readCell(page);
      logCell(`@${SHORT_DESKTOP_VIEWPORT.width}x${SHORT_DESKTOP_VIEWPORT.height} short desktop + running`, running);
      expectReading(
        running.dockInTranscript !== null && running.dockInTranscript.width > 0,
        `@short desktop: the status must be the pane's in-flow line — the composer's floating tab is gone at every viewport, this one included`,
        running,
      );
      expectReading(
        running.dockInComposer === null || running.dockInComposer.width === 0,
        `@short desktop: the composer must draw no floating tab`,
        running,
      );
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------------------------------------------------
 * Desktop cells: the breakpoint's other side, where the header is never collapsed and the footer is read on both tiers
 * --------------------------------------------------------------------------------------------------------- */

for (const viewport of DESKTOP_VIEWPORTS) {
  const { width, height, compactFooter } = viewport;

  test.describe(`desktop workspace and composer @${width}`, () => {
    test.use({ viewport: { width, height }, hasTouch: false, isMobile: false });

    test(`@${width} idle — the full tablist, no collapsed selector, one footer row and no sideways scroll`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        await page.waitForTimeout(250);
        const cell = await readCell(page);
        logCell(`@${width} idle`, cell);

        expectReading(cell.tablists >= 1, `@${width} idle: the full tablist has to be there at and above the breakpoint`, cell);
        expectHeaderBranch(width, cell);
        expectReading(cell.collapsedTrigger === null, `@${width} idle: no collapsed workspace selector may be rendered here`, cell);
        // The premise: which arrangement this cell is about to read, decided by the box it measured.
        expectFooterBoxTier(width, compactFooter, cell);
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
        // Where the three controls live follows the arrangement, and the arrangement follows the box — the two
        // readings together cover both tiers, so neither "always in the footer" nor "always behind a menu" passes.
        const footer = page.locator('[data-slot="prompt-input-footer"]');
        const more = footer.getByRole('button', { name: /More tools|Weitere Tools/ });
        for (const name of FOOTER_ONLY_CONTROLS) {
          const inFooter = (await footer.getByRole('button', { name }).count()) === 1;
          expectReading(
            inFooter === !compactFooter,
            `@${width} idle: ${name} must ${compactFooter ? 'not ' : ''}be in the footer on the ` +
              `${compactFooter ? 'compact' : 'wide'} tier (box ${footerBoxWidth(cell)}px)`,
            cell,
          );
        }
        expectReading(
          (await more.count()) === (compactFooter ? 1 : 0),
          `@${width} idle: the more menu's trigger must ${compactFooter ? '' : 'not '}be rendered on the ` +
            `${compactFooter ? 'compact' : 'wide'} tier`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} single playback — one clip, placed by the tier, footer height unchanged`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, {
        ...viewport,
        touch: false,
        language: MOBILE_LANGUAGE,
        session: DESKTOP_SESSION,
        // Trim off, as in the mobile single cell: the original is uploaded as it was recorded, so the second clip
        // the trimmed path produces never exists and this really is the single-clip reading.
        query: '?voiceTrim=off',
      });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        const before = await readCell(page);
        expectReading(before.footer !== null, `@${width} single: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} single`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} single aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} single playback`, cell);

        expectReading(counts.original === 1 && counts.trimmed === 0, `@${width} single: exactly one replay control, and it is the original's`, cell);
        expectReading(cell.clipButtons.length === 1, `@${width} single: the one clip control must be in the composer`, cell);
        expectFooterBoxTier(width, compactFooter, cell);
        if (compactFooter) {
          expectReading(
            cell.clipButtons[0]?.inClipRow === true,
            `@${width} single: on the compact tier the clip must live in the row between the box and the footer`,
            cell,
          );
          expectReading(
            cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top,
            `@${width} single: the clip row must sit above the footer, not inside it`,
            cell,
          );
        } else {
          expectReading(
            cell.clipButtons[0]?.inTools === true,
            `@${width} single: on the wide tier the clip must stay in the footer's tool group`,
            cell,
          );
          expectReading(cell.clipRow === null, `@${width} single: no separate clip row may be rendered on the wide tier`, cell);
        }
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} single: the footer height must be identical before and after the clip appears (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} double playback — the pair is placed by the tier and the footer does not grow`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);
        const before = await readCell(page);
        expectReading(before.footer !== null, `@${width} double: the footer has to exist before a recording is made`, before);

        await recordOnce(page, `@${width} double`);
        const cell = await readCell(page);
        const counts = await replayCounts(page);
        console.log(`[layout] @${width} double aria replay lines: ${JSON.stringify(counts.excerpt)}`);
        logCell(`@${width} double playback`, cell);

        expectReading(counts.original === 1 && counts.trimmed === 1, `@${width} double: exactly one original and one trimmed replay control`, cell);
        expectFooterBoxTier(width, compactFooter, cell);
        if (compactFooter) {
          // The compact arrangement puts the pair in the row *between* the box and the footer — the row the mobile
          // cells read — which is what keeps the footer one row and 57px tall while the pair is on screen.
          expectReading(
            cell.clipButtons.length === 2 && cell.clipButtons.every((b) => b.inClipRow),
            `@${width} double: on the compact tier the pair must live in the clip row between the box and the footer`,
            cell,
          );
          expectReading(
            cell.clipRow !== null && cell.footer !== null && cell.clipRow.top < cell.footer.top,
            `@${width} double: the clip row must sit above the footer, not inside it`,
            cell,
          );
        } else {
          expectReading(
            cell.clipButtons.length === 2 && cell.clipButtons.every((b) => b.inTools),
            `@${width} double: on the wide tier the pair must live in the footer's tool group, where it has always been`,
            cell,
          );
          expectReading(cell.clipRow === null, `@${width} double: no separate clip row may be rendered on the wide tier`, cell);
        }
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
        // The height invariant holds on both tiers — it is not a mobile promise. On the compact tier the pair is
        // outside the footer entirely; on the wide tier it stays in the tool group, which had 25px of content past
        // the box at a 445px box until the tier hook took that box to the compact side, so a footer that is one
        // non-scrolling row without a recording stays one non-scrolling row with one.
        expectReading(
          cell.footer !== null && before.footer !== null && cell.footer.height === before.footer.height,
          `@${width} double: the footer height must be identical before and after the clips appear (${before.footer?.height} → ${cell.footer?.height})`,
          cell,
        );
      } finally {
        await context.close();
      }
    });

    test(`@${width} running — the one status line and the composer's one Stop`, async ({ browser }) => {
      test.setTimeout(90_000);
      const { context, page } = await openCell(browser, { ...viewport, touch: false, language: MOBILE_LANGUAGE, session: DESKTOP_SESSION });
      try {
        await settleComposer(page, width);
        await expectDeclaredWidth(await readCell(page), width);

        const delivered = await injectStatusFrame(page, DESKTOP_SESSION);
        console.log(`[layout] @${width} running: status frame delivered to ${delivered} chat socket(s)`);
        expect(delivered, `@${width} running: the status frame has to reach an open chat socket`).toBeGreaterThan(0);
        await expect(page.locator('.chat-messages-pane [data-activity-dock]').first()).toBeVisible({ timeout: 10_000 });
        await page.waitForTimeout(300);

        const cell = await readCell(page);
        logCell(`@${width} running`, cell);
        // The status is the pane's in-flow line here too, and the composer draws no dock:
        // the desktop used to be the one viewport where a second, floating surface carried
        // the status, and this is the reading that keeps it from coming back.
        expectReading(
          cell.dockInTranscript !== null && cell.dockInTranscript.width > 0,
          `@${width} running: the status must be the pane's in-flow line on the desktop too`,
          cell,
        );
        expectReading(cell.dockInComposer === null, `@${width} running: the composer must draw no floating tab`, cell);
        expectReading(cell.stopNames.length === 1, `@${width} running: the composer's submit is the one stop entry`, cell);
        expectFooterBoxTier(width, compactFooter, cell);
        expectDesktopFooterOverflow(width, cell);
        expectDesktopFooterRow(width, cell);
      } finally {
        await context.close();
      }
    });
  });
}
