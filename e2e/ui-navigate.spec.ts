import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The task's Definition of Done, driven in a real browser: with this device's MCP
// navigation policy on "ask", one simulated `ui.navigate` frame raises the prompt bar;
// clicking "jump" opens the target session and lands on the target message; "always
// accept" writes the policy and jumps without asking; and Settings reads the policy
// back as "accept". Passing unit tests are explicitly not enough for this criterion.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts
// on an isolated data dir. Nothing about the app is stubbed: the account is created
// through the wizard, sessions are opened through the sidebar's own links, the target
// message is addressed by the anchor id the backend's own outline endpoint reports, and
// the policy is read back out of the real Settings page.
//
// The ONE seam is the transport. The backend half of this feature (`ui.navigate_ack` /
// `ui.navigate_result` routing, and whatever emits `ui.navigate` in the first place) is
// the sibling backend task's, so this server has no such frame: an MCP caller cannot
// reach a browser through it yet, and a reply sent to it answers `protocol_error`, which
// the client renders into the transcript as a chat row. So `window.WebSocket` is wrapped
// once, before the app exists: inbound frames are handed to the app's real sockets as
// real `MessageEvent`s, and outbound `ui.navigate*` frames are recorded instead of
// transmitted. The app still calls the real `sendMessage` on the real socket — what this
// spec reads back is the frame it produced, which is the thing the criterion is about.

/** ChatMessagesPane's scroll container — the same selector the transcript specs use. */
const PANE = '.chat-messages-pane';
/** The long seeded transcript the jump lands in — mirrors playwright.config.ts's own seed. */
const TARGET_SESSION_ID = 'e2e-transcript-jump';
const TARGET_SESSION_NAME = 'transcript-jump';
/** The session the run starts from: a different project's fixture, so the jump really moves. */
const ORIGIN_SESSION_ID = 'e2e-transcript-jump-tall';
const ORIGIN_SESSION_NAME = 'transcript-jump-tall';
const ORIGIN_PROJECT_NAME = 'transcript-jump-tall-workspace';
/**
 * The user turn the request targets, 1-indexed as the row text numbers it ("Turn 121.").
 *
 * Far enough into the 1200-turn fixture that the tail page the pane loads first cannot
 * contain it: if the row is on screen afterwards, the jump put it there.
 */
const TARGET_TURN = 121;
/** The prompt bar and the two answers this criterion clicks. */
const PROMPT = '[data-testid="ui-navigate-prompt"]';
const JUMP = '[data-testid="ui-navigate-jump"]';
const IGNORE = '[data-testid="ui-navigate-ignore"]';
const ALWAYS_ACCEPT = '[data-testid="ui-navigate-always-accept"]';
/** The bar's own placement wording for the two placements a request can name (`chat.json`'s `uiNavigate.*`). */
const MESSAGE_PLACEMENT = 'A specific message';
const LATEST_PLACEMENT = 'Latest messages';
/** The client names an unknown caller `MCP`; this requester is carried through to the bar. */
const REQUESTER = 'playwright-probe';
/** Fixed desktop viewport, so the pane is a known size and a row can be "fully in view". */
const VIEWPORT = { width: 1280, height: 1000 };
/** This device's policy key, as `useMcpNavigationSettings` stores it. */
const POLICY_KEY = 'mcpNavigationPolicy';

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
  const settings = page.getByRole('button', { name: 'Settings', exact: true }).first();
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
    return;
  }
  await page.locator('#username').fill('e2euser');
  await page.locator('input[type=password]').first().fill('e2epassword');
  await page.locator('form button[type=submit]').click();
  await expect(settings).toBeVisible({ timeout: 15_000 });
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
 * Wraps `window.WebSocket` once, before the app boots, so a frame can be handed to the
 * app's own socket and the frames the app answers with can be read back.
 *
 * `dispatchEvent(new MessageEvent('message', …))` rather than `socket.onmessage(…)`,
 * because a synthetic event runs the listeners a real frame would and does not depend on
 * how the provider happened to register (it assigns `onmessage`, but this is not the
 * place to encode that). The wrapper is a subclass, so `WebSocket.OPEN` and every other
 * static the app reads still resolve — `sendMessage` refuses to send unless `readyState`
 * compares equal to exactly that constant.
 */
const installUiNavigateBridge = () => {
  const page = window as unknown as {
    __quayNav: { sockets: WebSocket[]; sent: string[] };
    __quayInject: (frame: unknown) => number;
  };
  page.__quayNav = { sockets: [], sent: [] };
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      page.__quayNav.sockets.push(this as WebSocket);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      // The backend that routes these does not exist in this build, so transmitting one
      // buys a `protocol_error` chat row and nothing else. Recorded, not sent — the
      // app's own call is unchanged, and the frame it produced is what the assertions read.
      if (typeof data === 'string' && data.includes('"ui.navigate')) {
        page.__quayNav.sent.push(data);
        return;
      }
      super.send(data as never);
    }
  } as unknown as typeof WebSocket;

  page.__quayInject = (frame: unknown) => {
    const data = JSON.stringify(frame);
    let delivered = 0;
    for (const socket of page.__quayNav.sockets) {
      if (socket.readyState !== 1) continue;
      socket.dispatchEvent(new MessageEvent('message', { data }));
      delivered += 1;
    }
    return delivered;
  };
};

/** Hands the app one simulated `ui.navigate` frame on its own socket, the way a real request arrives. */
const injectNavigate = async (
  page: Page,
  frame: { navigationId: string; sessionId: string; at?: { messageId: string } | { latest: true } },
) => {
  const delivered = await page.evaluate(
    (payload) => (window as unknown as { __quayInject: (frame: unknown) => number }).__quayInject(payload),
    { type: 'ui.navigate', requester: REQUESTER, ...frame },
  );
  expect(delivered, 'the app must have an open chat socket for the frame to arrive on').toBeGreaterThan(0);
};

/** Every `ui.navigate*` frame the app has answered with so far, parsed. */
const readSentFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() =>
    (window as unknown as { __quayNav: { sent: string[] } }).__quayNav.sent.map(
      (raw) => JSON.parse(raw) as Record<string, unknown>,
    ),
  );

/** The frame of one type the app produced for one request, if it has produced it yet. */
const sentFrame = (
  frames: Array<Record<string, unknown>>,
  navigationId: string,
  type: string,
): Record<string, unknown> | undefined =>
  frames.find((frame) => frame.navigationId === navigationId && frame.type === type);

/** The sidebar row for a seeded session, addressed by the display name the seed gave it. */
const sessionLink = (page: Page, name: string) => page.locator('a[href^="/session/"]').filter({ hasText: name });

/** Opens one seeded session through the sidebar's own link, expanding its project first. */
const openSeededSession = async (page: Page, projectName: string, sessionName: string, sessionId: string) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${projectName}`) }).first();
  const link = sessionLink(page, sessionName);
  await expect(projectRow(), `indexing the seeded transcript must register ${projectName}`).toBeVisible({ timeout: 30_000 });
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

/** One turn of a session's outline, as the endpoint reports it. */
type OutlineTurn = { id: string; index: number; timestamp: string; preview: string };

/**
 * Reads a seeded session's outline over the app's own REST route, from inside the page
 * so it carries the token the UI stored. This is the endpoint the transcript rail reads,
 * so the anchor id it reports is the one `data-message-anchor-id` carries.
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
  const turn = turns.find((entry) => entry.preview.startsWith(`Turn ${displayTurn}.`));
  if (!turn) throw new Error(`the outline carries no turn ${displayTurn}`);
  return turn;
};

/** Whether the whole addressed row sits inside the pane's box, and which turn its own text names. */
type RowReading = { fully: boolean; turnNumber: number | null };

const readRow = (page: Page, anchorId: string): Promise<RowReading> =>
  page.evaluate((id) => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const row = document.querySelector(`[data-message-anchor-id="${id}"]`) as HTMLElement | null;
    if (!pane || !row) return { fully: false, turnNumber: null };
    const paneRect = pane.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    // The turn number comes from the row's own text: its anchor div mounts empty and already
    // pane-sized a frame before the content commits, so geometry alone cannot tell the placed
    // row from the placeholder it starts as.
    const match = /Turn (\d+)\./.exec(row.textContent ?? '');
    return {
      fully: rowRect.top >= paneRect.top - 1 && rowRect.bottom <= paneRect.bottom + 1,
      turnNumber: match ? Number(match[1]) : null,
    };
  }, anchorId);

/**
 * Waits for the addressed turn to be fully inside the pane *and* to carry its own text.
 *
 * "Fully inside the pane" is the reading that says the viewport was *placed*: a row that
 * merely exists somewhere in a 4800-row document is not a jump, and a jump that stopped
 * short leaves the row half off the top. Naming the turn from the row's own text is what
 * keeps the two ways of landing on nothing out of the pass: a neighbour's row, and the empty
 * wrapper the anchor div is before its content commits — which is already fully inside the
 * pane, so a geometry-only wait can be satisfied by a row that is not there yet.
 */
const expectLandedOn = async (page: Page, anchorId: string, turn: number) => {
  await expect
    .poll(async () => {
      const row = await readRow(page, anchorId);
      return row.fully && row.turnNumber === turn;
    }, {
      message: `turn ${turn}'s row must be fully inside the transcript pane and carry its own text`,
      timeout: 20_000,
    })
    .toBe(true);
};

/** This device's stored policy, read from the same localStorage key the settings hook uses. */
const storedPolicy = (page: Page) =>
  page.evaluate((key) => window.localStorage.getItem(key), POLICY_KEY);

test.describe.configure({ mode: 'serial', timeout: 300_000 });

test.describe('ui.navigate in a real browser', () => {
  test('ask prompts and jumps to the message, always-accept stops asking, Settings reads it back', async ({ browser }) => {
    test.setTimeout(300_000);
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up');
    await warmClientStartup(clientUrl);

    const page = await browser.newPage();
    await page.setViewportSize(VIEWPORT);
    await page.addInitScript(installUiNavigateBridge);

    await ensureSignedIn(page);
    await settleServiceWorker(page);

    // ── The run starts on a session that is not the target ───────────────────
    // The tall fixture, because it is a different project from the long one: the jump
    // has to move both the session and the project for the request to be about anything.
    await openSeededSession(page, ORIGIN_PROJECT_NAME, ORIGIN_SESSION_NAME, ORIGIN_SESSION_ID);
    await expect(page).not.toHaveURL(new RegExp(`/session/${TARGET_SESSION_ID}$`));

    // The target message, addressed by the id the backend's own outline reports — the same
    // key the row carries and the same key an `?around=` read resolves.
    const outlineResponse = await readOutline(page, TARGET_SESSION_ID);
    expect(outlineResponse.status, `GET /outline did not answer: ${outlineResponse.body.slice(0, 400)}`).toBe(200);
    const turns = (JSON.parse(outlineResponse.body) as { data?: { turns?: OutlineTurn[] } }).data?.turns ?? [];
    const target = turnFor(turns, TARGET_TURN);
    expect(target.preview.startsWith(`Turn ${TARGET_TURN}.`)).toBe(true);

    // This device starts on the unset default, which is "ask". Cleared rather than
    // written, so the run measures the fallback a fresh device really has.
    await page.evaluate((key) => window.localStorage.removeItem(key), POLICY_KEY);
    expect(await storedPolicy(page)).toBeNull();

    // ── (a) ask: the bar appears, and the jump opens the session on the message ──
    await injectNavigate(page, { navigationId: 'nav-1', sessionId: TARGET_SESSION_ID, at: { messageId: target.id } });

    const prompt = page.locator(PROMPT);
    await expect(prompt, 'an ask-policy request must raise the confirmation bar').toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText(REQUESTER);
    await expect(prompt).toContainText(MESSAGE_PLACEMENT);
    // The bar is up before anything moves: the request is a question, not a navigation.
    await expect(page).not.toHaveURL(new RegExp(`/session/${TARGET_SESSION_ID}$`));

    // The delivery ack is the frame the server correlates the request against, and `shown`
    // is what "this device is asking its user" means. The accepting path answers too — with
    // `applied` — so the status, not the frame's presence, is what tells the two apart.
    await expect
      .poll(async () => sentFrame(await readSentFrames(page), 'nav-1', 'ui.navigate_ack')?.status ?? null, {
        timeout: 20_000,
      })
      .toBe('shown');

    await page.locator(JUMP).click();
    await expect(prompt).toBeHidden();

    // The session opened…
    await expect(page).toHaveURL(new RegExp(`/session/${TARGET_SESSION_ID}$`), { timeout: 30_000 });
    // …and the viewport is on the addressed message, not on the tail page the pane
    // would otherwise have loaded.
    await expectLandedOn(page, target.id, TARGET_TURN);

    const settledResult = sentFrame(await readSentFrames(page), 'nav-1', 'ui.navigate_result');
    expect(settledResult?.status, 'the jump must settle the request as applied').toBe('applied');

    // ── (a2) the bar names the target session, and "ignore" navigates nowhere ──
    // The same session is now the open one and its project is the selected one, so this is
    // the case where the client holds a title for the target — the arm above is a jump into
    // another project, where the chat module's own session list does not reach.
    await injectNavigate(page, { navigationId: 'nav-1b', sessionId: TARGET_SESSION_ID, at: { latest: true } });
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt, 'the bar must name the session it is asking about').toContainText(TARGET_SESSION_NAME);
    await expect(prompt).toContainText(LATEST_PLACEMENT);
    await page.locator(IGNORE).click();
    await expect(prompt).toBeHidden();
    // An ignored request is a refusal, not a silent navigation.
    await expect(page).toHaveURL(new RegExp(`/session/${TARGET_SESSION_ID}$`));
    await expect
      .poll(async () => sentFrame(await readSentFrames(page), 'nav-1b', 'ui.navigate_result')?.status ?? null, {
        timeout: 20_000,
      })
      .toBe('ignored');

    // ── (b) always accept: the policy is written, this request jumps, no bar next time ──
    await injectNavigate(page, { navigationId: 'nav-2', sessionId: ORIGIN_SESSION_ID, at: { latest: true } });
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await page.locator(ALWAYS_ACCEPT).click();
    await expect(prompt).toBeHidden();

    await expect(page).toHaveURL(new RegExp(`/session/${ORIGIN_SESSION_ID}$`), { timeout: 30_000 });
    expect(await storedPolicy(page), 'the bar\'s "always accept" must write the device policy').toBe('accept');
    expect(sentFrame(await readSentFrames(page), 'nav-2', 'ui.navigate_result')?.status).toBe('applied');

    // ── (c) the next request jumps directly, with no bar and no `shown` ack ───
    await injectNavigate(page, { navigationId: 'nav-3', sessionId: TARGET_SESSION_ID, at: { messageId: target.id } });
    await expect(page).toHaveURL(new RegExp(`/session/${TARGET_SESSION_ID}$`), { timeout: 30_000 });
    await expectLandedOn(page, target.id, TARGET_TURN);

    // "No bar" is not the same as "the bar is gone": a bar that flashed up and closed would
    // also read as hidden. The reading that says the device never asked is the ack's own
    // status — the asking path answers `shown` and waits for its user, while this device
    // answered `applied` because it had already navigated.
    const directAck = sentFrame(await readSentFrames(page), 'nav-3', 'ui.navigate_ack');
    expect(directAck?.status, 'an accepted request must be acknowledged as applied, never as shown').toBe('applied');
    await expect(prompt).toBeHidden();

    // ── (d) Settings shows the policy the bar just chose ─────────────────────
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'API & Tokens', exact: true }).click();
    await expect(page.getByTestId('mcp-navigation-section')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('mcp-navigation-policy-accept')).toBeChecked();

    await page.close();
  });
});
