/**
 * The AskUserQuestion panel's "Other" answer box, read as geometry in a real Chromium.
 *
 * Reported shape: when an AskUserQuestion prompt appears and the reader picks "Other...", the answer box does not
 * wrap — a long answer stays on one line and scrolls sideways — and the decorative `Enter` hint sits on top of the
 * control's right edge, permanently covering the tail of whatever was typed.
 *
 * Both halves of that report are statements about layout, so neither can be read in jsdom: there is no line
 * breaking and no box model there, and a `scrollWidth > clientWidth` reading is 0/0. They need a browser.
 *
 * Nothing here is a stand-in for the app. What is doubled is the *transport*, never the consumer: an init script
 * wraps `window.WebSocket` and hands the app one frame on its own chat socket — the same `permission_request`
 * shape `requestClientToolDecision` sends (`server/modules/providers/list/claude/claude-runtime.provider.js`) —
 * and everything after that is the app's own realtime → store → React path. The session is allocated by the app
 * through its own `POST /api/providers/sessions`, because a transcript id seeded on disk is not registered and no
 * socket would subscribe to it.
 *
 * The two readings are kept apart on purpose, because they fail for different reasons and a single "is it broken"
 * assertion could not say which:
 *
 *   (a) *the answer wraps* — the control must not clip its own text horizontally. Measured as
 *       `scrollWidth <= clientWidth`, with the premise that the typed text is genuinely wider than the content box
 *       (measured with a canvas at the control's own computed font, so the premise is a reading rather than a
 *       guess about character counts).
 *   (b) *the hint covers nothing* — the `Enter` hint must not overlap the region the control lays text out in.
 *       The comparison is against the control's *content box* (padding excluded), not its border box: a hint that
 *       sits inside reserved padding covers no text, and asserting against the border box would red that correct
 *       layout. See `clipped-scroll-pane-makes-raw-rect-intersection-unsound` for why raw box intersection needs
 *       its subject to be genuinely inside the visible region first.
 *
 * The panel's own premise is asserted before either reading: the prompt really rendered, "Other..." really opened
 * the box, and the text really landed. A cell that skipped that would pass against a panel that never appeared.
 */

import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The workspace the session is created under. Seeded (with a transcript) by playwright.config.ts before boot. */
const WORKSPACE_DIR = 'transcript-follow-workspace';

/** The `Other...` control's placeholder — the English bundle's `chat:misc.typeAnswer`, and unique to this panel. */
const OTHER_PLACEHOLDER = 'Type your answer...';

/**
 * Long enough that it cannot fit on one line of the panel at the width this file reads.
 *
 * It is not the premise — the premise is measured against the control's real content box and font — but it has to
 * be long enough that the measurement has something to find. The premise assertion below fails loudly if this
 * constant is ever shortened past the point where the reading means anything.
 */
const LONG_ANSWER =
  'This answer is deliberately long so that it cannot fit on a single line of the control, and it has to wrap '
  + 'onto a second and a third line instead of scrolling sideways underneath the hint.';

// Long enough for a cold boot, the app's sign-in, a session allocation and a real Chromium layout pass.
test.describe.configure({ timeout: 120_000 });

/**
 * Installs the transport double: one socket wrapper, and a way to hand the app one frame on its own chat socket.
 * Only the chat socket is addressed — the shell keeps one of its own, and a chat frame delivered there would be
 * recorded as received without the pane ever seeing it.
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

/**
 * Hands the app one `permission_request` for an AskUserQuestion prompt, shaped the way the server shapes one.
 *
 * No `seq`: no provider run is in flight, so there is no sequence the client could have missed, and claiming one
 * would make the reconnect bookkeeping try to resume a run that does not exist. No `complete` either — it would
 * send the app to the server to refresh a turn this fixture never created, which would retract the prompt.
 */
const injectAskUserQuestion = (page: Page, sessionId: string, requestId: string) =>
  page.evaluate(
    ({ sid, rid }: { sid: string; rid: string }) =>
      (window as unknown as { __injectFrame: (frame: unknown) => number }).__injectFrame({
        id: `e2e-ask-${rid}`,
        kind: 'permission_request',
        requestId: rid,
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which approach should this change take?',
              header: 'Approach',
              multiSelect: false,
              options: [
                { label: 'Narrow the change', description: 'Touch only the panel that misbehaves.' },
                { label: 'Widen the change', description: 'Also rework the surrounding composer rows.' },
              ],
            },
          ],
        },
        sessionId: sid,
        timestamp: new Date().toISOString(),
        provider: 'claude',
        role: 'assistant',
      }),
    { sid: sessionId, rid: requestId },
  );

/** Signs in, tolerating both a fresh database and one that already holds the account. */
const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible({ timeout: 30_000 });
  if (await createAccount.count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
  }
  await expect(settings).toBeVisible({ timeout: 30_000 });
};

/**
 * A conversation the app creates and then opens, over the app's own REST route.
 *
 * Issued from inside the page so it carries the session the UI just created — the app keeps its token in storage
 * rather than in a cookie, so the same request from the test process would be anonymous.
 */
const openAppSession = async (page: Page, projectPath: string) => {
  const created = await page.evaluate(async (workspacePath) => {
    const response = await fetch('/api/providers/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
      },
      body: JSON.stringify({ provider: 'claude', projectPath: workspacePath, initialMessage: '' }),
    });
    return { status: response.status, body: await response.text() };
  }, projectPath);
  expect(created.status, `the app did not create a session: ${created.body}`).toBe(201);
  const sessionId = (JSON.parse(created.body) as { data?: { sessionId?: string } }).data?.sessionId ?? '';
  expect(sessionId, `the app created a session without an id: ${created.body}`).not.toBe('');

  await page.goto(`/session/${sessionId}`);
  await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`));
  return sessionId;
};

/**
 * Waits until the app's own chat socket is open, so a frame injected now has somewhere to land.
 *
 * The socket is opened by the app after the document loads, so `openAppSession` returning — which only proves the
 * URL changed — is too early: the first run of this spec injected into zero open sockets and the delivery counter
 * caught it. Bounded, because a socket that never opens is a reading about this run, not a reason to hang.
 */
const waitForChatSocket = async (page: Page) => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sockets = (window as unknown as { __wireSockets?: { url: string; socket: WebSocket }[] }).__wireSockets ?? [];
          return sockets.filter((entry) => entry.url.includes('/ws') && entry.socket.readyState === 1).length;
        }),
      { timeout: 30_000, message: 'the app never opened its chat socket, so no frame could be delivered' },
    )
    .toBeGreaterThan(0);
};

/** Everything the two readings need, gathered in one pass so both describe the same frame. */
type OtherControlReading = {
  /** The control's tag, printed so a reading taken from something other than the answer box is visible. */
  tagName: string;
  /** What the control currently holds — the premise that the typed text actually landed. */
  text: string;
  /** Layout box of the control, border box, in CSS pixels. */
  rect: { top: number; right: number; bottom: number; left: number; width: number; height: number };
  /** The region the control can lay text out in: the border box minus its own padding. */
  contentBox: { top: number; right: number; bottom: number; left: number; width: number; height: number };
  clientWidth: number;
  scrollWidth: number;
  /** One line of this control's own font, so "did it use more than one line" is a reading and not a constant. */
  lineHeightPx: number;
  /** The typed text's width at that same font, measured off-document. */
  textWidthPx: number;
  /** The `Enter` hint, or null when the panel renders none. */
  hint: { top: number; right: number; bottom: number; left: number; width: number; height: number } | null;
};

/**
 * Reads the answer box and the hint beside it.
 *
 * The hint is looked up as the control's sibling inside its own relative wrapper rather than by its text, so the
 * reading survives the hint being reworded — it is the *position* that is being measured, not the label.
 */
const readOtherControl = (page: Page): Promise<OtherControlReading> =>
  page.locator(`[placeholder="${OTHER_PLACEHOLDER}"]`).evaluate((el) => {
    const control = el as HTMLElement;
    const style = window.getComputedStyle(control);
    const px = (value: string) => Number.parseFloat(value) || 0;

    const rect = control.getBoundingClientRect();
    const padLeft = px(style.paddingLeft);
    const padRight = px(style.paddingRight);
    const padTop = px(style.paddingTop);
    const padBottom = px(style.paddingBottom);

    // `line-height: normal` resolves to the keyword, which parses to NaN — fall back to the font's own size, the
    // same way a browser does, so the "more than one line" reading is never a comparison against NaN.
    const fontSize = px(style.fontSize);
    const lineHeightPx = style.lineHeight === 'normal' ? fontSize * 1.2 : px(style.lineHeight);

    // Measured with the control's own computed font: a character count would be a guess about glyph widths, and
    // the panel's font is not the test's to assume.
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const textWidthPx = context
      ? (() => {
          context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          return context.measureText((control as HTMLInputElement | HTMLTextAreaElement).value).width;
        })()
      : Number.NaN;

    const hintEl = control.parentElement?.querySelector('kbd') as HTMLElement | null;
    const hintStyle = hintEl ? window.getComputedStyle(hintEl) : null;
    const hintBox = hintEl && hintStyle && hintStyle.visibility !== 'hidden' && hintStyle.display !== 'none'
      ? hintEl.getBoundingClientRect()
      : null;

    return {
      tagName: control.tagName,
      text: (control as HTMLInputElement | HTMLTextAreaElement).value,
      rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height },
      contentBox: {
        top: rect.top + padTop,
        right: rect.right - padRight,
        bottom: rect.bottom - padBottom,
        left: rect.left + padLeft,
        width: rect.width - padLeft - padRight,
        height: rect.height - padTop - padBottom,
      },
      clientWidth: control.clientWidth,
      scrollWidth: control.scrollWidth,
      lineHeightPx,
      textWidthPx,
      hint: hintBox
        ? { top: hintBox.top, right: hintBox.right, bottom: hintBox.bottom, left: hintBox.left, width: hintBox.width, height: hintBox.height }
        : null,
    };
  });

test.describe('AskUserQuestion "Other" answer box', () => {
  test('a long answer wraps, and the Enter hint covers none of it', async ({ browser }) => {
    const dataDir = process.env.QUAY_E2E_DATA_DIR;
    if (!dataDir) throw new Error('playwright.config.ts must publish QUAY_E2E_DATA_DIR for this spec');

    const page = await browser.newPage();
    // Before the first script runs, so the socket this spec injects into is the app's own.
    await page.addInitScript(installWireDouble);
    await page.bringToFront();
    // A narrow-but-not-phone width, so the panel's own width is what makes the answer overflow rather than the
    // text being short enough to fit anywhere.
    await page.setViewportSize({ width: 900, height: 900 });

    await ensureSignedIn(page);
    const sessionId = await openAppSession(page, path.join(dataDir, WORKSPACE_DIR));
    await waitForChatSocket(page);

    const requestId = 'e2e-ask-other-1';

    // --- Premise: the panel really rendered ---
    // The app subscribes to the session as soon as its socket opens, and the server's `chat_subscribed` ack
    // carries `pendingPermissions: []` — the handler *replaces* the pending set with it, so a prompt delivered
    // before that ack lands is wiped by it (measured: the first two runs of this file delivered the frame into an
    // open socket and the panel never appeared). How long that round trip takes is the server's business, not this
    // file's, so the prompt is re-delivered on a bounded retry until the panel actually takes it. Re-delivery is
    // safe: the client dedupes on `requestId`, so a second copy of the same prompt is not a second prompt.
    await expect(async () => {
      const delivered = await injectAskUserQuestion(page, sessionId, requestId);
      expect(delivered, 'the prompt frame reached no open chat socket').toBeGreaterThan(0);
      await expect(page.getByText('Claude needs your input')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByRole('button', { name: /Other/ }).click();
    const control = page.locator(`[placeholder="${OTHER_PLACEHOLDER}"]`);
    await expect(control).toBeVisible({ timeout: 10_000 });
    await control.fill(LONG_ANSWER);
    await expect(control).toHaveValue(LONG_ANSWER);

    const reading = await readOtherControl(page);
    // Printed whole: a reading whose numbers are not in the log cannot be argued with after the fact.
    console.log(`[e2e] other-control reading: ${JSON.stringify(reading)}`);

    // The premise both readings rest on: the typed answer genuinely needs more than one line at this width. If
    // this ever fails the case below is vacuous, so it is asserted rather than assumed.
    expect(
      reading.textWidthPx,
      `the premise failed: ${reading.textWidthPx}px of text does not overflow a ${reading.contentBox.width}px box, `
      + `so "it wrapped" would be true of any control. Lengthen LONG_ANSWER or narrow the viewport.`,
    ).toBeGreaterThan(reading.contentBox.width);

    // --- Reading (a): the answer wraps instead of clipping itself horizontally ---
    expect(
      reading.scrollWidth,
      `the answer box clips its own text: scrollWidth ${reading.scrollWidth} > clientWidth ${reading.clientWidth}, `
      + `so ${reading.textWidthPx}px of answer stays on one line and scrolls sideways instead of wrapping.`,
    ).toBeLessThanOrEqual(reading.clientWidth + 1);

    // ...and it laid the overflow out on real lines rather than simply hiding it. Because `contentBox.height` is
    // the *visible* content height, a control that wrapped would have to be at least two lines tall to show them.
    expect(
      reading.contentBox.height,
      `the answer box is only ${reading.contentBox.height}px of content tall (one line is ${reading.lineHeightPx}px), `
      + `so the wrapped text has nowhere to go.`,
    ).toBeGreaterThanOrEqual(reading.lineHeightPx * 2 - 1);

    // --- Reading (b): the hint covers none of the text ---
    // vs the *content* box, not the border box: a hint inside reserved padding covers no text and is a correct
    // layout. A hint is not required to exist; when none is rendered there is nothing to cover anything.
    if (reading.hint) {
      const overlaps = reading.hint.left < reading.contentBox.right
        && reading.hint.right > reading.contentBox.left
        && reading.hint.top < reading.contentBox.bottom
        && reading.hint.bottom > reading.contentBox.top;
      expect(
        overlaps,
        `the Enter hint (${JSON.stringify(reading.hint)}) overlaps the answer box's text region `
        + `(${JSON.stringify(reading.contentBox)}), so it covers the tail of the answer.`,
      ).toBe(false);
    } else {
      console.log('[e2e] no Enter hint is rendered beside the answer box, so there is nothing that could cover it');
    }

    await page.close();
  });
});
