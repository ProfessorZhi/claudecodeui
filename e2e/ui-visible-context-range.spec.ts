import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The DoD for gap-mcp-ui-visible-context-null-range-in-real-browser, run the way the DoD words it:
// a REAL browser showing a session, scrolled into the middle of a long answer, read by a REAL
// personal access token calling `ui_visible_context` over `/mcp` — on a desktop viewport and a
// phone viewport.
//
// What the defect was, and what this spec pins:
//
//   * the reported `visibleMessages` range was `{first: null, last: null}` whenever the pane's
//     band held only assistant content, because the transcript published the provider's raw
//     `transcriptAnchorId` — a field the Claude provider stamps on `role === 'user'` rows alone —
//     so every assistant, tool and thinking row had no `data-message-anchor-id` at all. The seed
//     below is one prompt plus one answer taller than either viewport, so scrolling to the middle
//     of that answer puts a pane band full of a message that used to report no range;
//   * `panel` was `null` on BOTH layouts: the desktop tab bar marks its active pill with
//     `aria-selected` and no `aria-current`, and the phone layout renders its `data-workspace-tab`
//     rows inside a picker dialog that is closed, so nothing on screen named the active view.
//
// Nothing here is stubbed: the token is minted by the app's own settings route, the session is
// opened through the sidebar's own link, and both `/mcp` calls are HTTP requests to the server
// Playwright started. The `session_read mode=around` leg is the resolvability half of the DoD: an
// id that no read can resolve is an id that was never worth reporting, and the server answers an
// unresolvable `aroundId` with MESSAGE_NOT_FOUND rather than a nearby page, so the call succeeding
// is itself the proof.

/** ChatMessagesPane's scroll container and the row class `MessageComponent` draws. */
const PANE = '.chat-messages-pane';
const ROW = '.chat-message';

/** The purpose-built seed: one prompt, one answer far taller than any viewport measured here. */
const SESSION_ID = 'e2e-ui-visible-context';
const SESSION_NAME = 'ui-visible-context';
const PROJECT_NAME = 'ui-visible-context-workspace';

/** The answer's own opening, asserted on the `around` read so the window is pinned to that row. */
const ANSWER_HEAD = 'assistant: Paragraph 1.';

/** The resource path the gateway is mounted at, and the wire shape a Streamable HTTP client must send. */
const MCP_PATH = '/mcp';
const MCP_ACCEPT = 'application/json, text/event-stream';
/** The read baseline scope `AccessTokensSection` gives every token, and these tools require. */
const READ_SCOPE = 'cloudcli:read';

/** The phone viewport, and the desktop one it is measured against. */
const DESKTOP = { width: 1280, height: 1000 };
const PHONE = { width: 390, height: 844 };

/** The server Playwright started; the spec process talks to it directly, the browser goes through Vite. */
const serverBase = () => `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;

/**
 * Signs in, creating the account on the first run of the fixture database.
 *
 * Always on a DESKTOP viewport: the phone layout has no Settings button and no `#username` field —
 * it opens with a drawer — so a phone-width first paint would never reach the form. The phone leg
 * resizes after signing in.
 */
const ensureSignedIn = async (page: Page) => {
  const shellReady = () =>
    page
      .locator('button:has-text("Create Account"), button:has-text("Settings"), #username')
      .first()
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true, () => false);
  page
    .waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 10_000 })
    .catch(() => undefined);

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

/**
 * Opens the seeded session through the sidebar's own link — never by writing the store or the URL.
 *
 * The project row is a toggle, so a click that lands while the sidebar is still re-rendering would
 * leave it collapsed; the loop clicks until the row is really on screen, then the link itself is
 * clicked once.
 */
const openSeededSession = async (page: Page) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  const link = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await link().isVisible().catch(() => false)) {
      break;
    }
    await projectRow().click();
    try {
      await expect(link()).toBeVisible({ timeout: 10_000 });
      break;
    } catch {
      // Collapsed again (or the click missed); the loop clicks once more.
    }
  }
  await expect(link()).toBeVisible({ timeout: 30_000 });
  await link().click({ timeout: 15_000 });
  await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
  await expect(page.locator(`${PANE} ${ROW}`).first()).toBeVisible({ timeout: 30_000 });
};

/**
 * Scrolls the pane so its whole band sits inside the tallest row — the long answer — and returns
 * what is on screen there.
 *
 * Reading the geometry from the DOM rather than scrolling a fixed number of pixels is what makes
 * the criterion viewport-independent: the answer is taller than both panes, so the band always ends
 * up entirely inside one message, which is exactly the arrangement that used to report no range.
 */
const scrollIntoTallestRow = async (page: Page) => {
  const reading = await page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.chat-message'));
    if (!pane || rows.length === 0) return null;
    const tallest = rows.reduce((a, b) =>
      b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a);
    const paneRect = pane.getBoundingClientRect();
    const rowRect = tallest.getBoundingClientRect();
    pane.scrollTop += (rowRect.top - paneRect.top) + (rowRect.height - paneRect.height) / 2;
    return { tallestHeight: Math.round(rowRect.height), paneHeight: Math.round(paneRect.height) };
  });
  expect(reading, 'the seeded session must draw a pane with rows').not.toBeNull();
  // The lazy-row observer and the placeholder estimate settle on the next frames; the reading is
  // taken from the committed layout, not from a mid-scroll intermediate.
  await page.waitForTimeout(1_500);

  const onScreen = await page.evaluate(() => {
    const pane = document.querySelector('.chat-messages-pane') as HTMLElement | null;
    if (!pane) return null;
    const paneRect = pane.getBoundingClientRect();
    // Document order is `querySelectorAll` order, which is transcript order — the same order the
    // responder walks, so the first and last of this list are the first and last it must report.
    const inBand = Array.from(document.querySelectorAll<HTMLElement>('[data-message-anchor-id]')).filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > paneRect.top && rect.top < paneRect.bottom;
    });
    return {
      ids: inBand.map((row) => row.getAttribute('data-message-anchor-id')),
      rowCountInBand: Array.from(document.querySelectorAll<HTMLElement>('.chat-message')).filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > paneRect.top && rect.top < paneRect.bottom;
      }).length,
    };
  });
  expect(onScreen, 'the pane must still be mounted').not.toBeNull();
  return { geometry: reading, ...onScreen! };
};

/**
 * Mints a personal access token through the app's own settings route.
 *
 * Issued from inside the page so it carries the session the UI created — the app keeps its token in
 * storage rather than in a cookie, so the same request from the test process would be anonymous. No
 * scope is sent, which is the point: the read baseline is the server's own default.
 */
const createReadToken = async (page: Page): Promise<string> => {
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/settings/access-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
      },
      body: JSON.stringify({ name: 'ui-visible-context-e2e', expiresInDays: 30 }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(created.status, `the app did not mint a token: ${created.body}`).toBe(201);
  const token = (JSON.parse(created.body) as { token?: { plaintext?: string; scopes?: string[] } }).token;
  expect(token?.plaintext, `the minted token carried no plaintext: ${created.body}`).toMatch(/^ccp_[0-9a-f]{64}$/);
  expect(token?.scopes ?? [], 'the minted token must carry the read baseline').toContain(READ_SCOPE);
  return token?.plaintext ?? '';
};

type McpCall = { status: number; rpc: Record<string, unknown> | null };

/** One real `/mcp` exchange, parsed whether the server answered plain JSON or one SSE `data:` frame. */
const mcpCall = async (token: string, message: Record<string, unknown>): Promise<McpCall> => {
  const response = await fetch(`${serverBase()}${MCP_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: MCP_ACCEPT,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('text/event-stream')
    ? (text.split('\n').find((line) => line.startsWith('data:'))?.slice('data:'.length).trim() ?? '')
    : text;

  let rpc: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed === 'object' && parsed !== null) {
      rpc = parsed as Record<string, unknown>;
    }
  } catch {
    // A body that is not JSON is reported through `rpc: null` by the caller, with the raw call attached.
  }
  return { status: response.status, rpc };
};

/** The payload a `tools/call` answered with: `structuredContent`, or the text block's JSON when the tool declares no output schema. */
const toolPayload = (call: McpCall, label: string): Record<string, unknown> => {
  expect(call.rpc, `${label}: no JSON-RPC envelope in ${JSON.stringify(call)}`).not.toBeNull();
  expect(call.rpc?.error, `${label}: JSON-RPC error ${JSON.stringify(call.rpc?.error)}`).toBeUndefined();
  const result = call.rpc?.result as
    | { structuredContent?: unknown; content?: { text?: string }[]; isError?: boolean }
    | undefined;
  expect(result, `${label}: the envelope carried no result`).toBeTruthy();
  expect(result?.isError, `${label}: the tool reported an error: ${JSON.stringify(result)}`).toBeFalsy();
  if (result?.structuredContent) {
    return result.structuredContent as Record<string, unknown>;
  }
  return JSON.parse((result?.content ?? []).map((block) => block.text ?? '').join('') || '{}') as Record<string, unknown>;
};

/** One tab of one device, as `ui_visible_context` reports it. */
type ReportedTab = {
  tabId: string;
  unresponsive: boolean;
  panel: string | null;
  selectedSession: string | null;
  visibleMessages: { first: string | null; last: string | null } | null;
};

/**
 * Asks `ui_visible_context` for every connected browser and returns the answering tabs that show
 * the seeded session.
 *
 * Filtering by `unresponsive === false` rather than by position matters: a tab that did not answer
 * reports every field as null, and reading one of those would make this spec pass over exactly the
 * defect it exists to catch — an answered tab that reports nothing.
 */
const readVisibleContext = async (token: string, label: string): Promise<ReportedTab[]> => {
  const call = await mcpCall(token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'ui_visible_context', arguments: {} },
  });
  expect(call.status, `${label}: /mcp answered ${call.status}`).toBe(200);
  const payload = toolPayload(call, label);
  const devices = (payload.devices ?? []) as { tabs?: ReportedTab[] }[];
  const tabs = devices.flatMap((device) => device.tabs ?? []);
  expect(
    tabs.length,
    `${label}: no browser tab was reported at all; payload was ${JSON.stringify(payload)}`,
  ).toBeGreaterThan(0);
  return tabs.filter((tab) => !tab.unresponsive && tab.selectedSession === SESSION_ID);
};

/** Reads one message window back through `session_read mode=around`, which 404s on an unknown id. */
const readAround = async (token: string, aroundId: string, label: string): Promise<string> => {
  const call = await mcpCall(token, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'session_read', arguments: { session: SESSION_ID, mode: 'around', aroundId, before: 0, after: 0 } },
  });
  expect(call.status, `${label}: /mcp answered ${call.status}`).toBe(200);
  const payload = toolPayload(call, label);
  expect(typeof payload.content, `${label}: the read carried no content: ${JSON.stringify(payload)}`).toBe('string');
  return payload.content as string;
};

/**
 * The whole criterion at one viewport: open the session, scroll into the long answer, then read the
 * range the browser reports and prove both ends are real, on-screen, and re-readable.
 */
const measureAt = async (page: Page, token: string, label: string) => {
  const onScreen = await scrollIntoTallestRow(page);
  expect(
    onScreen.ids.length,
    `${label}: the pane band must hold at least one addressed row to measure; band geometry ${JSON.stringify(onScreen.geometry)}`,
  ).toBeGreaterThan(0);

  const tabs = await readVisibleContext(token, label);
  expect(tabs.length, `${label}: no answering tab reported the open session`).toBeGreaterThan(0);

  for (const tab of tabs) {
    const range = tab.visibleMessages;
    expect(
      range?.first ?? null,
      `${label}: the reported range must name a first visible message; the tab was ${JSON.stringify(tab)}`,
    ).not.toBeNull();
    expect(
      range?.last ?? null,
      `${label}: the reported range must name a last visible message; the tab was ${JSON.stringify(tab)}`,
    ).not.toBeNull();

    // The reported ends are the ends of what the pane's band actually holds, in transcript order.
    expect(range?.first, `${label}: the reported first id is not the first addressed row on screen`).toBe(onScreen.ids[0]);
    expect(range?.last, `${label}: the reported last id is not the last addressed row on screen`).toBe(
      onScreen.ids[onScreen.ids.length - 1],
    );

    // The panel is readable on both layouts and names the view that is really open — never the
    // `unknown` sentinel, which means a mounted workspace that could not be read.
    expect(tab.panel, `${label}: the panel must be the open workspace view, not null or unknown`).toBe('chat');

    // The DoD's resolvability half, against the server: an id it cannot resolve is a 404, so the
    // call coming back with the answer's own opening is what proves the range is re-readable.
    const around = await readAround(token, range?.first ?? '', `${label} (around the reported first id)`);
    expect(around, `${label}: the around read did not land on the visible answer`).toContain(ANSWER_HEAD);
  }

  return onScreen;
};

test.describe.configure({ mode: 'serial', timeout: 55_000 });

test.describe('the visible-message range on the real service', () => {
  test('a browser showing a long answer reports a live range on desktop and on a phone viewport', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await ensureSignedIn(page);
    await openSeededSession(page);
    const token = await createReadToken(page);

    // (1) Desktop: the pane band sits inside the long answer, and the range names it.
    const desktop = await measureAt(page, token, 'desktop');
    expect(
      desktop.geometry.tallestHeight,
      'the seeded answer must be taller than the pane, or the band cannot sit inside it',
    ).toBeGreaterThan(desktop.geometry.paneHeight);

    // (2) Phone: a real reload at the phone viewport, then the same reading. The layout that has no
    //     tab bar at all is the one whose panel used to be unreadable, and whose range used to be
    //     empty for the same reason as the desktop's.
    await page.setViewportSize(PHONE);
    await page.reload();
    await expect(page.locator(`${PANE} ${ROW}`).first()).toBeVisible({ timeout: 30_000 });
    const phone = await measureAt(page, token, 'phone');
    expect(
      phone.geometry.tallestHeight,
      'the seeded answer must be taller than the phone pane too',
    ).toBeGreaterThan(phone.geometry.paneHeight);
  });
});
