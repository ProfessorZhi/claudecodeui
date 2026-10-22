import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data
// dir), for the SPA consent screen `gap-oauth-consent-spa-ui` adds at `/oauth/consent`.
//
// Nothing is stubbed. The client is registered through the server's REAL DCR endpoint, the consent
// request is one the server's own `/oauth/authorize` validated, the decision goes through the real
// `/api/oauth/authorize/decision`, the minted code is exchanged at the real `/oauth/token` with a
// PKCE verifier whose challenge rode the original request, and the resulting access token is
// presented to the real `/mcp` gateway. What the case reads back is the server's own answer at every
// hop and the browser's own rendering of the page.
//
// WHY THE BROWSER IS SENT TO `/oauth/consent` DIRECTLY. In production one origin serves both, so the
// browser opening `/oauth/authorize` follows the 302 to `/oauth/consent` in the same document. In
// this dev harness Vite serves the client and proxies only `/api` (see `vite.config.js`), so
// `/oauth/authorize` on the Vite origin is the SPA shell, not the server. The hop is therefore
// asserted out-of-band — the server's `/oauth/authorize` really answers 302 to the SPA path with the
// query preserved — and the browser then really renders the document that redirect names. Both
// halves are the server's decision; neither is stubbed.
//
// The startup path is bounded in the same two levers its sibling specs use
// (`e2e/connected-apps-settings.spec.ts`, `e2e/access-tokens-settings.spec.ts`): a client warm-up
// before any page exists, and a bounded navigation guard. Neither guard decides anything for the
// case — a navigation that cannot land ends the run with the page's own evidence.

/** Namespaced i18n keys leak into the UI as literals like "consent.title" when a translation is missing. */
const UNTRANSLATED_KEY = /\b(?:consent|mainTabs|settings|chat|common|sidebar)\.[a-z][A-Za-z]+\b/;
/** The one scope every consent grants; the pinned, disabled checkbox. */
const READ_SCOPE = 'cloudcli:read';
/** The write scope this run ticks; a real write scope from the server's vocabulary. */
const WRITE_SCOPE = 'cloudcli:navigate';
/** The MCP protocol revision the probe's `initialize` announces; the SDK's gateway answers it. */
const PROTOCOL_VERSION = '2025-06-18';
/** The phone the consent screen is really used on; the mobile leg's viewport. */
const MOBILE_VIEWPORT = { width: 375, height: 812 } as const;
/** The single account this run creates; the consent confirmation re-enters this password (AC-261). */
const ACCOUNT_USERNAME = 'e2euser';
const ACCOUNT_PASSWORD = 'e2epassword';

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;
/** How long this run's client is given to answer its app entry before the startup path gives up on it. */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** How long the landing of the first navigation is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 8_000;
/** How long each bounded replay's landing is given; shorter than the first, because a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long one navigation's own request is given before the guard treats it as a failed landing. */
const NAVIGATION_PROBE_MS = 8_000;
/** The sum the startup path may spend proving a navigation landed, replays included. */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the shell, the app
 * entry and one optimized dependency, all requested before any page of this run exists. A 200 on the
 * dependency url only comes once the optimizer has committed the bundle, so the page below does not
 * race a re-optimization that would serve it a superseded url. Every step is bounded; a client that
 * accepts the connection and never answers fails here.
 */
const warmClientStartup = async (clientUrl: string): Promise<number> => {
  const startedAt = Date.now();
  const deadline = startedAt + CLIENT_WARM_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  const fetchWithin = async (url: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs());
    try {
      return await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new Error(
        `the client did not answer ${url} inside the ${CLIENT_WARM_DEADLINE_MS}ms startup budget `
        + `(${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      clearTimeout(timer);
    }
  };

  const shellUrl = new URL('/', clientUrl).href;
  const shell = await fetchWithin(shellUrl);
  if (!shell.ok) throw new Error(`the client's shell did not load: ${shellUrl} answered HTTP ${shell.status}`);
  await shell.text();

  const entryUrl = new URL('/src/main.tsx', clientUrl).href;
  const entry = await fetchWithin(entryUrl);
  if (!entry.ok) throw new Error(`the app entry did not transform: ${entryUrl} answered HTTP ${entry.status}`);
  await entry.text();

  let lastAnswer = 'no dependency url was ever served';
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt += 1) {
    const specifier = OPTIMIZED_DEP_IN_TEXT.exec(await (await fetchWithin(entryUrl)).text())?.[1];
    if (!specifier) break;
    const depUrl = new URL(specifier, clientUrl).href;
    const dep = await fetchWithin(depUrl);
    if (dep.ok) {
      console.log(`[e2e] client warm-up: pre-bundle committed in ${Date.now() - startedAt}ms`);
      return Date.now() - startedAt;
    }
    lastAnswer = `${depUrl} answered HTTP ${dep.status}`;
    await dep.text().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `this run's dependency pre-bundle never committed, so the criterion cannot drive a document that stays: `
    + lastAnswer,
  );
};

/** Whether `locator` showed up within `timeoutMs`. */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/** What a guarded navigation is expected to land on — and how the guard names it when it never lands. */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/** The flattened `a.b.c` key paths of a nested translation object, so two locales' key sets can be compared. */
const flattenKeys = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object') {
    return prefix === '' ? [] : [prefix];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenKeys(nested, prefix === '' ? key : `${prefix}.${key}`),
  );
};

/** base64url of a buffer/string, the only encoding PKCE and the query string speak. */
const base64url = (value: crypto.BinaryLike): string =>
  Buffer.from(value as string).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** What one callback listener captured: the query the browser really arrived with. */
type CallbackArrival = { url: string; params: Record<string, string> };

test.describe.configure({ mode: 'serial', timeout: 50_000 });

test.describe('the OAuth consent SPA', () => {
  let page: Page;
  /** The registered callback the browser is sent to; a real listener on an ephemeral loopback port. */
  let callbackPort = 0;
  let callbackServer: http.Server;
  /** Resolved by the listener on each arrival; re-armed before every leg that expects one. */
  let arrival: { promise: Promise<CallbackArrival>; settle: (value: CallbackArrival) => void };
  /** The client this run registered through the real DCR endpoint. */
  let clientId = '';
  const clientName = 'E2E Consent App';
  const state = 'state-e2e-consent';
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(crypto.createHash('sha256').update(codeVerifier).digest());

  const startupEvidence = {
    consoleErrors: [] as string[],
    failedRequests: [] as string[],
  };

  const serverBase = () => `http://127.0.0.1:${process.env.QUAY_E2E_SERVER_PORT}`;
  const clientBase = () => test.info().project.use.baseURL ?? '';

  /** The authorization request this run drives: the same query at every hop, so a mismatch is visible. */
  const authorizeQuery = (redirectUri: string): string =>
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    }).toString();

  /** The SPA route the server's 302 names, addressed on the dev client origin. */
  const consentUrl = (query: string): string => `${clientBase()}/oauth/consent?${query}`;

  /** Unreadable evidence is still evidence: what the page said when a startup landing never arrived. */
  const readStartupEvidence = async (): Promise<string> => {
    const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
    const errors = startupEvidence.consoleErrors.slice(0, 5);
    const failed = startupEvidence.failedRequests.slice(0, 5);
    return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
      + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
      + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
  };

  /**
   * The one place this spec navigates: navigate, probe the landing with a short budget, and on a
   * missed landing replay the navigation (a fresh document, which recovers from module requests
   * interrupted once) until the deadline. A probe that cannot land ends the run here with a cause
   * rather than letting the case wait out its own budget on a blank page.
   */
  const navigateBounded = async (url: string, landing: StartupLanding): Promise<void> => {
    const startedAt = Date.now();
    const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
    const budgetMs = () => Math.max(1, deadline - Date.now());
    let navigationFailure: string | null = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (attempt === 1) {
          await page.goto(url, { timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
        } else {
          await page.reload({ timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
        }
        navigationFailure = null;
      } catch (error) {
        navigationFailure = error instanceof Error ? error.message : String(error);
      }
      const landingBudget = Math.min(attempt === 1 ? STARTUP_PROBE_MS : STARTUP_RELOAD_PROBE_MS, budgetMs());
      if (await landing.present(landingBudget)) {
        console.log(`[e2e] startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt})`);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${landing.label()} never rendered, so this run's client never came up to a document that stays`
          + `${navigationFailure === null ? '' : ` (the navigation itself failed: ${navigationFailure})`}`
          + `: ${await readStartupEvidence()}`,
        );
      }
    }
  };

  /** What the first navigation must land on: the fresh database's account form or the app shell, whichever this run has. */
  const FIRST_LANDING: StartupLanding = {
    label: () => 'the account form or the app shell',
    present: async (budgetMs) =>
      (await appears(page.locator('#username'), budgetMs))
      || (await appears(page.getByRole('button', { name: 'Settings', exact: true }).first(), budgetMs)),
  };

  /** What every later navigation must land on: the app shell's Settings button, painted before any of this spec's own data. */
  const APP_SHELL_LANDING: StartupLanding = {
    label: () => 'the app shell (Settings button)',
    present: (budgetMs) => appears(page.getByRole('button', { name: 'Settings', exact: true }).first(), budgetMs),
  };

  /** What the consent route must land on: the rendered request, i.e. the client name the server answered with. */
  const CONSENT_LANDING: StartupLanding = {
    label: () => 'the consent screen (client name)',
    present: (budgetMs) => appears(page.getByTestId('consent-client-name'), budgetMs),
  };

  const allowButton = () => page.getByTestId('consent-allow');
  const writeWarning = () => page.getByTestId('consent-write-warning');
  const scopeRow = (scope: string) => page.locator(`[data-testid="consent-scope"][data-scope="${scope}"]`);
  const scopeCheckbox = (scope: string) => scopeRow(scope).locator('input[type=checkbox]');

  /** Re-arms the callback listener so the next arrival resolves this promise. */
  const armCallback = (): void => {
    let settle: (value: CallbackArrival) => void = () => undefined;
    const promise = new Promise<CallbackArrival>((resolve) => { settle = resolve; });
    arrival = { promise, settle };
  };

  /** Waits for the browser to reach the registered callback, bounded; resolves with what it carried. */
  const waitForCallback = async (label: string): Promise<CallbackArrival> => {
    const timeout = 15_000;
    const timer = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${label}: the browser never reached the registered callback within ${timeout}ms`)), timeout);
    });
    return Promise.race([arrival.promise, timer]);
  };

  /** One real `/mcp` exchange carrying `token`; the auth middleware decides before the transport sees the body. */
  const callMcp = (token: string): Promise<Response> =>
    fetch(`${serverBase()}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'oauth-consent-e2e', version: '1.0.0' },
        },
      }),
    });

  /**
   * The scopes the server actually stored on the newest live grant for this run's client, read back
   * through the settings API with the browser's own session. The grant row is the server's decision
   * about what the decision granted — not the page's idea of what it sent.
   *
   * Must be called with the page on the dev CLIENT origin (the app), because it reads the session
   * token out of that origin's localStorage and fetches the relative `/api` path the dev server
   * proxies. The Allow leg ends on the registered callback's origin, so the caller comes back here
   * first.
   */
  const readGrantedScopes = async (): Promise<string[]> => {
    const grants = await page.evaluate(async () => {
      const token = window.localStorage.getItem('auth-token');
      const response = await fetch('/api/settings/oauth-grants', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return response.json() as Promise<{ grants?: { clientId: string; scopes: string[] }[] }>;
    });
    const mine = (grants.grants ?? []).filter((grant) => grant.clientId === clientId);
    if (mine.length === 0) throw new Error('the server stored no live grant for this run’s client');
    return mine[mine.length - 1].scopes;
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(50_000);
    const clientUrl = clientBase();
    if (!clientUrl) {
      throw new Error('playwright.config.ts must give this project a baseURL for the startup warm-up to address');
    }
    await warmClientStartup(clientUrl);

    // The registered callback: a real listener the browser is really sent to, on an ephemeral
    // loopback port, so the redirect's host and the arrival are both facts this run observed.
    callbackServer = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${callbackPort}`);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>callback</title>received');
      arrival.settle({
        url: url.toString(),
        params: Object.fromEntries(url.searchParams.entries()),
      });
    });
    await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve));
    const address = callbackServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the callback listener did not bind a TCP port');
    }
    callbackPort = address.port;
    armCallback();

    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('console', (message) => {
      if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding. Tolerant of
    // an existing account so the spec also runs against a database another spec signed into. Every
    // click is followed by a state-driven assertion, so no bare click rides a mid-run Vite reload.
    await navigateBounded('/', FIRST_LANDING);
    if (await page.locator('#username').count()) {
      await page.locator('#username').fill(ACCOUNT_USERNAME);
      await page.locator('input[type=password]').nth(0).fill(ACCOUNT_PASSWORD);
      await page.locator('input[type=password]').nth(1).fill(ACCOUNT_PASSWORD);
      await page.getByRole('button', { name: 'Create Account' }).click();
      await page.getByPlaceholder('John Doe').fill('E2E User');
      await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Complete Setup' }).click();
    }
    await expect(page.getByRole('button', { name: 'Settings', exact: true }).first()).toBeVisible({ timeout: 30_000 });

    // The client is a genuine registration: the real DCR endpoint, the real policy, the real row.
    const registration = await fetch(`${serverBase()}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [`http://127.0.0.1:${callbackPort}/callback`],
        token_endpoint_auth_method: 'none',
      }),
    });
    const registrationBody = await registration.json() as { client_id?: string };
    if (registration.status !== 201 || !registrationBody.client_id) {
      throw new Error(
        `DCR registration answered ${registration.status}: ${JSON.stringify(registrationBody)}; `
        + 'playwright.config.ts must inject the MCP/OAuth environment for this selection',
      );
    }
    clientId = registrationBody.client_id;
    console.log(`(setup) DCR registered "${clientName}" -> ${clientId}; callback http://127.0.0.1:${callbackPort}/callback`);
  });

  test.afterAll(async () => {
    await page.close();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  });

  test('renders the consent screen, records a decision through the real authorization server, and refuses a bad request', async () => {
    const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
    const query = authorizeQuery(redirectUri);

    // (AC3, first half) The server's own authorization endpoint validates the request and answers a
    // 302 to the SPA path with the query preserved. This is the hop the browser would follow when one
    // origin serves both; it is asserted here because the dev client origin does not proxy `/oauth`.
    const authorizeHop = await fetch(`${serverBase()}/oauth/authorize?${query}`, { redirect: 'manual' });
    const location = authorizeHop.headers.get('location') ?? '';
    console.log(
      `(a) GET /oauth/authorize -> ${authorizeHop.status}, Location: ${JSON.stringify(location)}`,
    );
    expect(authorizeHop.status).toBe(302);
    expect(location.startsWith('/oauth/consent?')).toBe(true);
    expect(new URLSearchParams(location.slice('/oauth/consent?'.length)).get('client_id')).toBe(clientId);

    // (AC3) The browser opens the authorization URL and lands on the consent route.
    await navigateBounded(consentUrl(query), CONSENT_LANDING);
    expect(new URL(page.url()).pathname).toBe('/oauth/consent');

    const clientNameShown = await page.getByTestId('consent-client-name').innerText();
    const callbackHostShown = await page.getByTestId('consent-callback-host').innerText();
    const identityShown = await page.getByTestId('consent-identity').innerText();
    const scopeRows = page.getByTestId('consent-scope');
    const scopeCount = await scopeRows.count();
    const checkedScopes: string[] = [];
    const disabledScopes: string[] = [];
    for (let index = 0; index < scopeCount; index += 1) {
      const row = scopeRows.nth(index);
      const scope = (await row.getAttribute('data-scope')) ?? '';
      if (await row.locator('input[type=checkbox]').isChecked()) checkedScopes.push(scope);
      if (await row.locator('input[type=checkbox]').isDisabled()) disabledScopes.push(scope);
    }
    console.log(
      `(a) page at ${new URL(page.url()).pathname}; client=${JSON.stringify(clientNameShown)}; `
      + `callback host=${JSON.stringify(callbackHostShown)}; identity=${JSON.stringify(identityShown)}; `
      + `scopes=${scopeCount}; checked=${JSON.stringify(checkedScopes)}; disabled=${JSON.stringify(disabledScopes)}`,
    );
    expect(clientNameShown).toBe(clientName);
    expect(callbackHostShown).toBe(`127.0.0.1:${callbackPort}`);
    expect(identityShown).toContain(ACCOUNT_USERNAME);
    expect(scopeCount).toBe(6);
    expect(checkedScopes).toEqual([READ_SCOPE]);
    expect(disabledScopes).toEqual([READ_SCOPE]);
    await page.screenshot({ path: 'artifacts/oauth-consent-desktop.png' });

    // (AC4) Tick one write scope: the risk warning appears, and Allow sends the browser to the
    // registered callback with a code and the echoed state. The code is then redeemed at the real
    // token endpoint with the PKCE verifier, and the token really authenticates against `/mcp`.
    expect(await writeWarning().count()).toBe(0);
    await scopeCheckbox(WRITE_SCOPE).check();
    await expect(writeWarning()).toBeVisible({ timeout: 5_000 });
    const warningText = await writeWarning().innerText();
    console.log(`(b) ticking ${WRITE_SCOPE} showed the risk warning: ${JSON.stringify(warningText)}`);

    // (AC-261) An Allow is a confirmation, not just a click: the button stays disabled until the
    // signed-in user re-enters their password, and the real `/decision` verifies it against the
    // account's real hash — a correct password is what lets the code be minted at all.
    const consentPassword = page.getByTestId('consent-password');
    await expect(consentPassword).toBeVisible({ timeout: 5_000 });
    await expect(allowButton()).toBeDisabled();
    const disabledWithoutPassword = await allowButton().isDisabled();
    await consentPassword.fill(ACCOUNT_PASSWORD);
    await expect(allowButton()).toBeEnabled();
    console.log(
      `(b) the confirmation field gated Allow: disabled before the password was re-entered=${disabledWithoutPassword}, `
      + `enabled after=${!(await allowButton().isDisabled())}`,
    );

    armCallback();
    await allowButton().click();
    const arrivalResult = await waitForCallback('(b) Allow');
    console.log(`(b) browser reached the callback: ${arrivalResult.url}`);
    expect(arrivalResult.params.code).toBeTruthy();
    expect(arrivalResult.params.state).toBe(state);

    const exchange = await fetch(`${serverBase()}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(arrivalResult.params.code),
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    });
    const tokens = await exchange.json() as { access_token?: string; token_type?: string };
    console.log(`(b) POST /oauth/token -> ${exchange.status}, token_type=${JSON.stringify(tokens.token_type)}`);
    expect(exchange.status).toBe(200);
    expect(tokens.access_token).toBeTruthy();

    const mcp = await callMcp(String(tokens.access_token));
    const mcpBody = await mcp.text();
    console.log(`(b) POST /mcp with the minted token -> ${mcp.status} ${JSON.stringify(mcpBody.slice(0, 120))}`);
    expect(mcp.status).toBe(200);

    // Back to the app origin — the Allow leg left the browser on the callback — so the grant can be
    // read back through the session the consent was granted under.
    await navigateBounded(consentUrl(query), CONSENT_LANDING);
    const granted = await readGrantedScopes();
    console.log(`(b) the server stored grant scopes: ${JSON.stringify(granted)}`);
    expect([...granted].sort()).toEqual([READ_SCOPE, WRITE_SCOPE].sort());

    // (AC5) Deny: the callback carries `error=access_denied` and no code at all.
    armCallback();
    await page.getByTestId('consent-deny').click();
    const denied = await waitForCallback('(c) Deny');
    console.log(`(c) browser reached the callback: ${denied.url}`);
    expect(denied.params.error).toBe('access_denied');
    expect(denied.params.code).toBeUndefined();

    // (AC7) An unregistered callback is refused on BOTH sides: the server's authorization endpoint
    // answers no redirect, and the SPA renders the error face with no Allow button — and the browser
    // never navigates to the bad uri.
    const badRedirectUri = 'http://127.0.0.1:9/evil-callback';
    const badHop = await fetch(`${serverBase()}/oauth/authorize?${authorizeQuery(badRedirectUri)}`, { redirect: 'manual' });
    console.log(
      `(e) GET /oauth/authorize (unregistered redirect_uri) -> ${badHop.status}, `
      + `Location: ${JSON.stringify(badHop.headers.get('location'))}`,
    );
    expect(badHop.status).toBeGreaterThanOrEqual(400);
    expect(badHop.headers.get('location')).toBeNull();

    await navigateBounded(consentUrl(authorizeQuery(badRedirectUri)), { label: () => 'the consent error face', present: (budget) => appears(page.getByTestId('consent-error'), budget) });
    const badUriUrl = page.url();
    const errorText = await page.getByTestId('consent-error-message').innerText();
    console.log(`(e) unregistered redirect_uri -> ${JSON.stringify(errorText)}; browser still at ${new URL(badUriUrl).pathname}`);
    expect(await allowButton().count()).toBe(0);
    expect(await page.getByTestId('consent-deny').count()).toBe(0);
    expect(new URL(badUriUrl).pathname).toBe('/oauth/consent');
    expect(new URL(badUriUrl).host).not.toBe('127.0.0.1:9');

    // The unknown-client half of the same rule.
    const unknownHop = await fetch(`${serverBase()}/oauth/authorize?client_id=nope&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`, { redirect: 'manual' });
    console.log(`(e) GET /oauth/authorize (unknown client) -> ${unknownHop.status}, Location: ${JSON.stringify(unknownHop.headers.get('location'))}`);
    expect(unknownHop.status).toBeGreaterThanOrEqual(400);
    expect(unknownHop.headers.get('location')).toBeNull();

    // (AC6) A signed-out visitor opens the same authorization URL, signs in, and comes back to the
    // SAME request: the login gate renders in place and never rewrites the URL, so every parameter
    // the client sent is still there afterwards.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(consentUrl(query), { timeout: NAVIGATION_PROBE_MS });
    await expect(page.locator('#username')).toBeVisible({ timeout: 20_000 });
    const signedOutUrl = page.url();
    console.log(`(d) signed out, the URL is ${new URL(signedOutUrl).pathname}${new URL(signedOutUrl).search}`);
    await page.locator('#username').fill(ACCOUNT_USERNAME);
    await page.locator('input[type=password]').first().fill(ACCOUNT_PASSWORD);
    await page.locator('button[type=submit]').click();
    await expect(page.getByTestId('consent-client-name')).toBeVisible({ timeout: 20_000 });

    const afterLogin = new URL(page.url());
    const original = new URL(consentUrl(query));
    console.log(`(d) after login the browser is at ${afterLogin.pathname}${afterLogin.search}`);
    expect(afterLogin.pathname).toBe('/oauth/consent');
    for (const key of ['client_id', 'redirect_uri', 'state', 'code_challenge']) {
      expect(afterLogin.searchParams.get(key)).toBe(original.searchParams.get(key));
    }

    // (AC8) The phone viewport: no horizontal overflow, and the Allow button really in the viewport
    // with its own text — the predicate polls text and geometry together, so a mounting placeholder
    // cannot satisfy it.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await navigateBounded(consentUrl(query), CONSENT_LANDING);
    await allowButton().scrollIntoViewIfNeeded();
    const readAllowGeometry = async () => page.evaluate(() => {
      const element = document.querySelector('[data-testid="consent-allow"]');
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return {
        text: (element.textContent ?? '').trim(),
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    });
    let allowGeometry = await readAllowGeometry();
    const geometryDeadline = Date.now() + 8_000;
    while (
      (allowGeometry === null || allowGeometry.text === '' || allowGeometry.width === 0 || allowGeometry.height === 0)
      && Date.now() < geometryDeadline
    ) {
      await page.waitForTimeout(100);
      allowGeometry = await readAllowGeometry();
    }
    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    console.log(
      `(f) 375x812: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}; `
      + `Allow=${JSON.stringify(allowGeometry)}`,
    );
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(allowGeometry).not.toBeNull();
    expect(allowGeometry?.text).toBeTruthy();
    expect(allowGeometry?.left ?? -1).toBeGreaterThanOrEqual(0);
    expect(allowGeometry?.top ?? -1).toBeGreaterThanOrEqual(0);
    expect(allowGeometry?.right ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    expect(allowGeometry?.bottom ?? Number.MAX_SAFE_INTEGER).toBeLessThanOrEqual(MOBILE_VIEWPORT.height);
    await page.screenshot({ path: 'artifacts/oauth-consent-mobile-375.png' });

    // (AC9) The page renders no untranslated namespace literal, and every locale's consent namespace
    // carries the same key set as `en`.
    const bodyText = await page.locator('body').innerText();
    const strayKey = UNTRANSLATED_KEY.exec(bodyText);
    console.log(`(g) page text carries an untranslated key: ${strayKey === null ? 'no' : JSON.stringify(strayKey[0])}`);
    expect(strayKey).toBeNull();

    const localeRoot = path.join(process.cwd(), 'src/modules/i18n/locales');
    const englishKeys = flattenKeys(JSON.parse(fs.readFileSync(path.join(localeRoot, 'en/consent.json'), 'utf8'))).sort();
    const localeNames = fs.readdirSync(localeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const localeReport: string[] = [];
    for (const locale of localeNames) {
      const keys = flattenKeys(JSON.parse(fs.readFileSync(path.join(localeRoot, locale, 'consent.json'), 'utf8'))).sort();
      localeReport.push(`${locale}=${keys.length}`);
      expect(keys, `locale ${locale} key set must equal en`).toEqual(englishKeys);
    }
    console.log(`(g) consent namespace key count ${englishKeys.length} in every locale: ${localeReport.join(', ')}`);

    // (AC10) The consent DOCUMENT itself carries the anti-framing header, so the page cannot be
    // framed by the site that is asking for authorization.
    // In this dev harness there is no built `dist/index.html`, so the server's static layer hands
    // this path to the composition root's dev redirect and the answer is a 302 — the header is
    // re-asserted at `writeHead`, which is exactly the path the middleware exists for. A built
    // deployment serves the SPA document here with the same three headers; the backend criterion
    // (`server/modules/oauth/tests/oauth-consent-page.test.ts`, case (h)) proves that 200 document
    // against a real static layer. Either way the header is the server's own, not the client's.
    const document = await fetch(`${serverBase()}/oauth/consent?${query}`, { redirect: 'manual' });
    const frameOptions = document.headers.get('x-frame-options');
    const documentCsp = document.headers.get('content-security-policy') ?? '';
    console.log(
      `(h) GET /oauth/consent -> ${document.status}, X-Frame-Options: ${JSON.stringify(frameOptions)}, `
      + `CSP: ${JSON.stringify(documentCsp)}`,
    );
    expect(frameOptions).toBe('DENY');
    expect(documentCsp).toContain("frame-ancestors 'none'");

    // (DoD) The visual-review grid for this single-page surface: the consent page in DARK mode at
    // both viewports, plus the settings page in the same theme — the surface the revoke hint points
    // at, and the reference the visual review compares this page's theme against.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await navigateBounded(consentUrl(query), CONSENT_LANDING);
    await page.screenshot({ path: 'artifacts/oauth-consent-desktop-dark.png' });
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.screenshot({ path: 'artifacts/oauth-consent-mobile-dark.png' });

    await page.setViewportSize({ width: 1280, height: 800 });
    await navigateBounded('/', APP_SHELL_LANDING);
    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByRole('button', { name: 'API & Tokens', exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'API & Tokens', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Connected Apps' })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'artifacts/oauth-consent-settings-theme-reference.png' });

    // (DoD) The mechanical half of the visual review, read off the rendered consent document: an
    // accessible name on every interactive control, no skipped heading level, and every rendered
    // text run at or above its WCAG AA contrast ratio. This replaces Lighthouse (this host has no
    // lighthouse binary and the task forbids new dependencies) with a dependency-free reading of
    // exactly the properties Lighthouse's accessibility audit scores.
    await navigateBounded(consentUrl(query), CONSENT_LANDING);
    await page.emulateMedia({ colorScheme: 'dark' });
    const reading = await page.evaluate(() => {
      const accessibleName = (element: Element): string => {
        const ariaLabel = (element.getAttribute('aria-label') ?? '').trim();
        if (ariaLabel !== '') return ariaLabel;
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          const text = (target?.textContent ?? '').trim();
          if (text !== '') return text;
        }
        if (element instanceof HTMLInputElement) {
          const labelText = Array.from(element.labels ?? [])
            .map((label) => (label.textContent ?? '').trim())
            .join(' ')
            .trim();
          if (labelText !== '') return labelText;
          const placeholder = (element.getAttribute('placeholder') ?? '').trim();
          if (placeholder !== '') return placeholder;
        }
        return (element.textContent ?? '').trim();
      };

      const channel = (value: number): number => {
        const scaled = value / 255;
        return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
      };
      const luminance = ([r, g, b]: [number, number, number]): number =>
        0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      const parseColor = (value: string): [number, number, number, number] | null => {
        const match = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\)/.exec(value);
        if (match === null) return null;
        return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])];
      };
      // The background under a text run is every translucent ancestor layer composited over the
      // first opaque one (the white browser canvas when the chain has none). Reading a `bg-*/10`
      // overlay as though it were opaque measures the text against the overlay itself and invents
      // a contrast failure the eye never sees.
      const backgroundOf = (element: Element): [number, number, number] => {
        const layers: [number, number, number, number][] = [];
        let node: Element | null = element;
        while (node !== null) {
          const parsed = parseColor(getComputedStyle(node).backgroundColor);
          if (parsed !== null && parsed[3] > 0) {
            layers.push(parsed);
            if (parsed[3] >= 1) break;
          }
          node = node.parentElement;
        }
        let composited: [number, number, number] = [255, 255, 255];
        for (let index = layers.length - 1; index >= 0; index -= 1) {
          const [r, g, b, alpha] = layers[index];
          composited = [
            r * alpha + composited[0] * (1 - alpha),
            g * alpha + composited[1] * (1 - alpha),
            b * alpha + composited[2] * (1 - alpha),
          ];
        }
        return composited;
      };

      const unnamed = Array.from(document.querySelectorAll('button, a[href], input, select, textarea'))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && accessibleName(element) === '';
        })
        .map((element) => element.outerHTML.slice(0, 80));
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map((heading) => Number(heading.tagName.slice(1)));
      const lowContrast: { text: string; size: number; weight: string; ratio: number }[] = [];
      for (const element of Array.from(document.querySelectorAll('body *'))) {
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => (node.textContent ?? '').trim())
          .join(' ')
          .trim();
        if (ownText === '') continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const style = getComputedStyle(element);
        const foreground = parseColor(style.color);
        if (foreground === null || foreground[3] === 0) continue;
        const background = backgroundOf(element);
        const foregroundRgb: [number, number, number] = [foreground[0], foreground[1], foreground[2]];
        const lighter = Math.max(luminance(foregroundRgb), luminance(background));
        const darker = Math.min(luminance(foregroundRgb), luminance(background));
        const ratio = (lighter + 0.05) / (darker + 0.05);
        const size = Number.parseFloat(style.fontSize);
        const bold = Number.parseInt(style.fontWeight, 10) >= 700;
        const required = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        if (ratio + 0.005 < required) {
          lowContrast.push({ text: ownText.slice(0, 40), size, weight: style.fontWeight, ratio: Number(ratio.toFixed(2)) });
        }
      }
      return { unnamed, headings, lowContrast };
    });
    console.log(
      `(visual) unnamed controls=${JSON.stringify(reading.unnamed)}; headings=${JSON.stringify(reading.headings)}; `
      + `below-AA text runs=${JSON.stringify(reading.lowContrast)}`,
    );
    expect(reading.unnamed).toEqual([]);
    expect(reading.headings[0]).toBe(1);
    for (let index = 1; index < reading.headings.length; index += 1) {
      expect(reading.headings[index] - reading.headings[index - 1]).toBeLessThanOrEqual(1);
    }
    expect(reading.lowContrast).toEqual([]);
  });
});
