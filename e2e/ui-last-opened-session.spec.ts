import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The DoD for gap-mcp-ui-last-opened-session, run the way the DoD words it: on a REAL service,
// with a REAL browser opening a session and a REAL personal access token calling the tool over
// `/mcp`.
//
// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated
// data dir, `MCP_ENABLED`). Nothing here is stubbed or hand-wired:
//
//   * the session is opened through the sidebar's own link, so the pointer is written by the
//     provider's own session-read route (`GET /api/providers/sessions/:id/messages`) — the same
//     request `session_get`/`session_read` never make, which is why the reading below is a real
//     browser-open and not a fixture;
//   * the token is minted by the app's own settings route and carries the read baseline scope, not
//     a value planted in the store;
//   * both `/mcp` calls are HTTP requests to the server Playwright started, and the refusal leg
//     re-reads the pointer AFTER a token has read a different session's transcript.
//
// This is the reading the in-process criterion (`server/modules/mcp-gateway/tests/mcp-ui-last-opened.test.ts`)
// cannot give: it proves the wiring `server/index.ts` assembles — the live database the server opened,
// the PAT the settings route issued, the `/mcp` mount the deployment's environment enabled.

/** ChatMessagesPane's scroll container and the row class `MessageComponent` draws. */
const PANE = '.chat-messages-pane';
const ROW = '.chat-message';

/**
 * The session the browser opens. The SHORT seed on purpose: the pointer is written by whichever
 * session the pane loads, so the follow fixture (24 turns) measures the criterion instead of the
 * 1200-turn seed's own load time.
 */
const SESSION_ID = 'e2e-transcript-follow';
/** Display name the sidebar renders for it. */
const SESSION_NAME = 'transcript-follow';
/** The project row's accessible name starts with the workspace's basename. */
const PROJECT_NAME = 'transcript-follow-workspace';
/** A DIFFERENT seeded session, read through `/mcp` to prove a token cannot move the pointer. */
const OTHER_SESSION_ID = 'e2e-transcript-jump';

/** The resource path the gateway is mounted at, and the wire shape a Streamable HTTP client must send. */
const MCP_PATH = '/mcp';
const MCP_ACCEPT = 'application/json, text/event-stream';
/** The read baseline scope `AccessTokensSection` gives every token, and this tool requires. */
const READ_SCOPE = 'cloudcli:read';

/** The server Playwright started; the spec process talks to it directly, the browser goes through Vite. */
const serverBase = () => `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;

/** Signs in, creating the account on the first run of the fixture database. */
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

/** The sidebar row for the seeded session the browser is about to open. */
const sessionLink = (page: Page) => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

/**
 * Opens the seeded session through the sidebar's own link — never by writing the store or the URL.
 *
 * The project row is a toggle, so a click that lands while the sidebar is still re-rendering would
 * leave it collapsed; the loop clicks until the row is really on screen, then the link itself is
 * clicked once. The transcript row becoming visible is what proves the app made its own history
 * request — the request that records the pointer.
 */
const openSeededSession = async (page: Page) => {
  const projectRow = () => page.getByRole('button', { name: new RegExp(`^${PROJECT_NAME}`) }).first();
  await expect(projectRow(), 'indexing the seeded transcript must register its project').toBeVisible({ timeout: 30_000 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await sessionLink(page).isVisible().catch(() => false)) {
      break;
    }
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
  await expect(page.locator(`${PANE} ${ROW}`).first()).toBeVisible({ timeout: 30_000 });
};

/**
 * Mints a personal access token through the app's own settings route.
 *
 * Issued from inside the page so it carries the session the UI just created — the app keeps its
 * token in storage rather than in a cookie, so the same request from the test process would be
 * anonymous. No scope is sent, which is the point: the read baseline is the server's own default.
 */
const createReadToken = async (page: Page): Promise<{ plaintext: string; scopes: string[] }> => {
  const created = await page.evaluate(async () => {
    const response = await fetch('/api/settings/access-tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${window.localStorage.getItem('auth-token') ?? ''}`,
      },
      body: JSON.stringify({ name: 'ui-last-opened-e2e', expiresInDays: 30 }),
    });
    return { status: response.status, body: await response.text() };
  });
  expect(created.status, `the app did not mint a token: ${created.body}`).toBe(201);
  const token = (JSON.parse(created.body) as { token?: { plaintext?: string; scopes?: string[] } }).token;
  expect(token?.plaintext, `the minted token carried no plaintext: ${created.body}`).toMatch(/^ccp_[0-9a-f]{64}$/);
  return { plaintext: token?.plaintext ?? '', scopes: token?.scopes ?? [] };
};

type McpCall = { status: number; rpc: Record<string, unknown> | null };

/**
 * One real `/mcp` exchange, parsed whether the server answered plain JSON or one SSE `data:` frame.
 *
 * No `initialize` is sent: the gateway mounts a stateless transport whose every POST stands alone,
 * which is what lets a token call a tool on its first request.
 */
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

/** Reads `ui_last_opened_session` over `/mcp`, returning the session id and the ISO reading it reports. */
const readPointer = async (token: string, label: string): Promise<{ sessionId: string; iso: string }> => {
  const call = await mcpCall(token, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'ui_last_opened_session', arguments: {} },
  });
  expect(call.status, `${label}: /mcp answered ${call.status}`).toBe(200);
  const payload = toolPayload(call, label);
  const session = payload.session as { id?: string } | undefined;
  const openedAt = payload.openedAt as { iso?: string } | undefined;
  expect(typeof session?.id, `${label}: the payload carried no session id: ${JSON.stringify(payload)}`).toBe('string');
  expect(typeof openedAt?.iso, `${label}: the payload carried no openedAt.iso: ${JSON.stringify(payload)}`).toBe('string');
  return { sessionId: session?.id ?? '', iso: openedAt?.iso ?? '' };
};

test.describe.configure({ mode: 'serial', timeout: 50_000 });

test.describe('last-opened session on the real service', () => {
  test('a browser open is what /mcp reports, and a token read of another session does not move it', async ({ page }) => {
    await ensureSignedIn(page);

    // (1) The browser opens a session: the sidebar link, the real history request it triggers, and
    //     the transcript it draws.
    await openSeededSession(page);

    // (2) A real PAT with the read baseline scope.
    const token = await createReadToken(page);
    expect(token.scopes, 'the minted token must carry the read baseline').toContain(READ_SCOPE);

    // (3) `/mcp` reports the session the browser opened, with when it was opened.
    const opened = await readPointer(token.plaintext, 'after the browser open');
    expect(opened.sessionId, 'the tool must report the session the browser opened').toBe(SESSION_ID);
    expect(Number.isNaN(Date.parse(opened.iso)), `openedAt.iso is not a timestamp: ${opened.iso}`).toBe(false);

    // (4) A PAT reads a DIFFERENT session's transcript through `/mcp`. If the gateway or the
    //     sessions service behind it wrote the pointer, this would move it to `OTHER_SESSION_ID`.
    const read = await mcpCall(token.plaintext, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'session_read', arguments: { session: OTHER_SESSION_ID } },
    });
    expect(read.status, `session_read of another session answered ${read.status}`).toBe(200);
    toolPayload(read, 'session_read of the other session');

    // (5) The answer is unchanged — same session, same instant.
    const after = await readPointer(token.plaintext, 'after a token read another session');
    expect(after.sessionId, 'an MCP read must not move the browser’s last-opened pointer').toBe(SESSION_ID);
    expect(after.iso, 're-reading must report the same open instant').toBe(opened.iso);
  });
});
