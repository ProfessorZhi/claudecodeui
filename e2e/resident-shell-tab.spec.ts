import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Locator, Page } from '@playwright/test';

/**
 * The instant this criterion's `npx playwright test` invocation began.
 *
 * `playwright.config.ts` publishes it (`QUAY_E2E_RUN_STARTED_AT`) for exactly this reading:
 * the 55 s ceiling is on the whole invocation — config evaluation, seeding, server boot,
 * browser launch — and a spec that timed only its own body would report a number whose
 * shortfall against the ceiling is the part it could not see. The fallback is for a run
 * started outside the config (there is none today); it can only make the reading smaller.
 */
const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/** The 12 locale directories the app ships. */
const LOCALES = ['de', 'en', 'es', 'fr', 'id', 'it', 'ja', 'ko', 'ru', 'tr', 'zh-CN', 'zh-TW'] as const;

/**
 * The keys this task adds, per namespace.
 *
 * Read off the disk rather than restated in this file, for the same reason the sentences
 * below are: a spec carrying its own copy of the copy would keep passing after the locale
 * file changed, and the point of these assertions is that what the user is shown is what
 * the app ships.
 */
const REQUIRED_KEYS: { namespace: 'common' | 'sidebar'; keys: string[] }[] = [
  { namespace: 'common', keys: ['tabs.shellResidentDisabled', 'tabs.shellResidentDisabledLabel'] },
  {
    namespace: 'sidebar',
    keys: ['sessionMenu.closeResidentMode', 'sessionMenu.closeResidentModeHint', 'sessionMenu.closeResidentModeFailed'],
  },
];

type MissingKey = { locale: string; namespace: string; key: string };

const readLocale = (locale: string, namespace: string): Record<string, unknown> =>
  JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales', locale, `${namespace}.json`), 'utf8'),
  ) as Record<string, unknown>;

const valueAt = (document: Record<string, unknown>, dotted: string): unknown =>
  dotted
    .split('.')
    .reduce<unknown>(
      (node, step) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[step] : undefined),
      document,
    );

/** Every declared key that is absent or blank, per locale. Empty means the copy is complete. */
const localeGaps = (): MissingKey[] => {
  const gaps: MissingKey[] = [];
  for (const locale of LOCALES) {
    for (const { namespace, keys } of REQUIRED_KEYS) {
      const document = readLocale(locale, namespace);
      for (const key of keys) {
        const value = valueAt(document, key);
        if (typeof value !== 'string' || value.trim() === '') {
          gaps.push({ locale, namespace, key });
        }
      }
    }
  }
  return gaps;
};

const enCommon = readLocale('en', 'common');
const SHELL_TAB_LABEL = String(valueAt(enCommon, 'tabs.shell'));
const CHAT_TAB_LABEL = String(valueAt(enCommon, 'tabs.chat'));
/** The sentence a resident session's notice has to be, verbatim, on both faces it appears on. */
const SHELL_NOTICE_SENTENCE = String(valueAt(enCommon, 'tabs.shellResidentDisabled'));
/** The way back out of the mode, as the menu ships it. */
const CLOSE_RESIDENT_LABEL = String(valueAt(readLocale('en', 'sidebar'), 'sessionMenu.closeResidentMode'));

const AUTH_TOKEN_KEY = 'auth-token';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The provider the seeded transcript's session belongs to; the matrix is what makes it resident-capable. */
const SESSION_PROVIDER = 'claude';
/**
 * The session the run seeds for this family of specs, in its own workspace.
 *
 * A session the app really discovered is what the sidebar lists and what carries a stored
 * `lifecycle_mode`; an API-created one would need a turn to exist. This one is indexed at
 * boot from the run's own fixture, and nothing below ever sends it a message — which is
 * exactly the state the criterion is about: a resident session whose process does not
 * exist.
 */
const SEEDED_SESSION_ID = 'e2e-mobile-send-key';
const SEEDED_SESSION_NAME = 'mobile-send-key';
const WORKSPACE_DIR_BASENAME = 'mobile-send-key-workspace';

/** The notice that explains the closed tab, and the marker the shell view mounts under. */
const NOTICE = '[data-resident-shell-notice]';
const SHELL_VIEW = '[data-workspace-view="shell"]';

/** Absolute path of the workspace the run seeded, used to name the project row in the sidebar. */
let workspace = '';
let authToken = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ── the server's own readings ───────────────────────────────────────────────── */

type SessionHostListing = {
  hosts?: { hostId?: string; bindings?: { appSessionId?: string }[] }[];
  sessions?: { appSessionId: string; provider: string; lifecycleMode: string; running: boolean }[];
};

const sessionHostListing = async (request: APIRequestContext): Promise<SessionHostListing> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  return ((await response.json()) as { data?: SessionHostListing }).data ?? {};
};

/**
 * One session's stored mode, read off the listing that publishes it.
 *
 * This is the same projection a restart uses to find a resident session whose process it
 * dropped, and it is the only face that answers "what does this session's `lifecycle_mode`
 * say" — the workspace's own session objects carry no mode at all.
 */
const modeOf = async (request: APIRequestContext, sessionId: string): Promise<string> =>
  (await sessionHostListing(request)).sessions?.find((row) => row.appSessionId === sessionId)?.lifecycleMode
  ?? 'undefined';

/** How many live hosts are bound to one session. Zero is the "resident but not running" reading. */
const hostsForSession = async (request: APIRequestContext, sessionId: string): Promise<number> =>
  ((await sessionHostListing(request)).hosts ?? []).filter((host) =>
    (host.bindings ?? []).some((binding) => binding.appSessionId === sessionId)).length;

/** Records a lifecycle mode through the app's own write entry, and reports what the server answered. */
const writeMode = async (request: APIRequestContext, mode: 'per-run' | 'resident') => {
  const response = await request.put(
    `/api/providers/${SESSION_PROVIDER}/sessions/${SEEDED_SESSION_ID}/lifecycle-mode`,
    { headers: auth(authToken), data: { mode } },
  );
  const body = (await response.json().catch(() => ({}))) as { data?: { changed?: boolean; mode?: string } };
  expect(
    response.ok(),
    `PUT /api/providers/${SESSION_PROVIDER}/sessions/${SEEDED_SESSION_ID}/lifecycle-mode {mode:${mode}} `
      + `answered ${response.status()} — ${JSON.stringify(body)}`,
  ).toBe(true);
  return body.data ?? {};
};

/** Reads one session's mode until it is `expected`, returning whatever it last read. */
const waitForMode = async (
  request: APIRequestContext,
  expected: string,
  budgetMs = 20_000,
): Promise<string> => {
  const deadline = Date.now() + budgetMs;
  let last = await modeOf(request, SEEDED_SESSION_ID);
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await modeOf(request, SEEDED_SESSION_ID);
  }
  return last;
};

/** The capability matrix as the backend answers it — so a refusal below is explainable, not mysterious. */
const residentCapableProviders = async (request: APIRequestContext): Promise<string[]> => {
  const response = await request.get('/api/providers/capabilities', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/providers/capabilities answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as { data?: { providers?: { provider: string; lifecycleModes?: string[] }[] } };
  return (body.data?.providers ?? [])
    .filter((row) => row.lifecycleModes?.includes('resident'))
    .map((row) => row.provider);
};

/* ── the page's own readings ─────────────────────────────────────────────────── */

const shellTab = (page: Page) => page.getByRole('tab', { name: SHELL_TAB_LABEL });
const chatTab = (page: Page) => page.getByRole('tab', { name: CHAT_TAB_LABEL });
const notice = (page: Page) => page.locator(NOTICE);

/** The shell view's mount marker. Present exactly while the workspace is showing the shell. */
const shellViewMounted = async (page: Page): Promise<boolean> => (await page.locator(SHELL_VIEW).count()) > 0;

const tabDisabled = (tab: ReturnType<typeof shellTab>): Promise<boolean> =>
  tab.evaluate((element) => (element as HTMLButtonElement).disabled);

/**
 * Which workspace view is active, by the stable hook both surfaces carry.
 *
 * Read as the tab id rather than as the tab's accessible name: the name is translated text,
 * and a criterion that compared translations would be reading the locale, not the view.
 * The accessible name is still how the tab is *found* (`shellTab`/`chatTab` above), which is
 * what a user does too; it is only the comparison that has to be locale-independent.
 */
const activeTabId = async (page: Page): Promise<string> =>
  (await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('data-workspace-tab'))
  ?? '<none>';

/**
 * Presses a tab and reports whether the press was accepted.
 *
 * A disabled button is not clickable, so Playwright's actionability check is the reading:
 * it waits for the tab to become enabled and gives up. The press is bounded because "it
 * never became enabled" is one of the two outcomes being measured, and an unbounded wait
 * would report it as a timeout instead of as the refusal it is.
 */
const attemptTabClick = async (page: Page, label: string): Promise<'accepted' | 'refused'> => {
  try {
    await page.getByRole('tab', { name: label }).click({ timeout: 2_000 });
    return 'accepted';
  } catch {
    return 'refused';
  }
};

/** Reads one tab's `disabled` until it is `expected`, returning whatever it last read. */
const waitForTabDisabled = async (page: Page, expected: boolean, budgetMs = 15_000): Promise<boolean | null> => {
  const deadline = Date.now() + budgetMs;
  let last = await tabDisabled(shellTab(page)).catch(() => null);
  while (last !== expected && Date.now() < deadline) {
    await page.waitForTimeout(200);
    last = await tabDisabled(shellTab(page)).catch(() => null);
  }
  return last;
};

/**
 * Waits for a resident session's workspace to settle, and reports the two readings that settle it.
 *
 * The mode was recorded from outside the page, so this is the workspace's own poll catching up.
 * Both readings come from the same property, so they arrive together — and the wait is bounded
 * rather than open-ended because "the tab never closed" is one of the two outcomes being
 * measured, and an unbounded wait would report it as a timeout instead of as the value it is.
 */
const waitForResidentShell = async (
  page: Page,
  budgetMs = 20_000,
): Promise<{ disabled: boolean | null; activeTab: string }> => {
  const deadline = Date.now() + budgetMs;
  let disabled = await tabDisabled(shellTab(page)).catch(() => null);
  let active = await activeTabId(page);
  while (!(disabled === true && active !== 'shell') && Date.now() < deadline) {
    await page.waitForTimeout(200);
    disabled = await tabDisabled(shellTab(page)).catch(() => null);
    active = await activeTabId(page);
  }
  return { disabled, activeTab: active };
};

/* ── the bounded startup guard ──────────────────────────────────────────────── */
//
// This is the member of the resident family that was left without a startup guard: its startup path is
// a single unbounded navigation to the seeded session (the `navigateBounded` call in the case below),
// whose only waits are the fixture's session row and the Shell tab. When this run's own Vite dependency
// optimizer commits a re-optimization inside the page's window, the in-flight module graph is
// interrupted, the document is replaced under the navigation, and the case times out on a page that
// never mounted — reported as a bare locator timeout that names neither the url nor the status.
//
// The trigger (this run's own dependency optimization) is decided by the cache, not by this file. What
// is inside it is the *response*: a bounded client warm-up and a bounded navigation probe, the two
// levers the sibling specs already carry (`e2e/resident-running-view.spec.ts`,
// `e2e/resident-status-bar.spec.ts`). Neither is invented here.
//
// The guard replays a navigation and fails loudly when it cannot land; it never treats "not landed" as
// "good enough". Written the other way — probe times out, carry on — the case would wait out its own
// budget on a blank document and the run would still cross the gate's 60s, which is what this task's
// bounded-failure reading measures.

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * How long this run's own client is given to answer its app entry before the startup path gives up on it.
 *
 * The run already has two ceilings above it (playwright.config.ts's watchdog, then the goal gate's 60s)
 * and both are *outside* this spec — an unbounded wait here would be reported by whichever fired first,
 * naming neither the url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before
 * any page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is held, and a url carrying a
 * hash from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite
 * answers a re-optimization committed after it began serving by pushing `full-reload` to every connected
 * client, which replaces the document whole — the way this criterion has lost a page mid-flight. A 200
 * there means the page below will not race the optimizer.
 *
 * `beforeAll`, before `browser.newContext()`/`newPage()`, is the earliest point inside the criterion's
 * own startup path, and it is strictly before any page exists — the same requests the page would have
 * made, made first. It is here rather than in playwright.config.ts's `globalSetup` because Playwright
 * resolves every `globalSetup` entry as a *script* (a path that must default-export the function), so an
 * inline warm-up there is neither type-legal nor loadable, and this task's write surface allows no new file.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never
 * answers fails here, by name, with the url and the status, rather than waiting out a timeout further up.
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

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the
  // hash a url carries is the one its writer committed, and the entry is where the current one is written.
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

/** How long the landing of the *first* navigation is given on its own, before the guard starts replaying. */
const STARTUP_PROBE_MS = 8_000;
/** How long each bounded replay's landing is given. Shorter than the first: a replay is a re-ask, not a cold boot. */
const STARTUP_RELOAD_PROBE_MS = 3_000;
/** How long one navigation's single rpc to its server is given, before the guard treats it as a failed landing. */
const NAVIGATION_PROBE_MS = 8_000;

/**
 * How long the startup probe may spend proving a navigation landed, replays included.
 *
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's
 * own wall clock: the bounded-failure reading asks that a probe which cannot succeed ends the whole run
 * in under 30s, and that run pays the config evaluation, both servers' boot, the browser launch and this
 * spec's own `beforeAll` (the bounded warm-up plus the onboarding wizard `bootstrapAuth` drives) before
 * the probe's first attempt even starts. Counting replays leaves that head-room to chance; a deadline
 * spends it.
 *
 * The value is derived from *this* spec's measured pre-probe overhead, not copied. The sibling specs that
 * carry this guard create their account over the API, so their pre-probe cost is the boot and the launch;
 * this one runs the three-screen onboarding, which measured 10.2s quiet and 16.0s loaded here (wall minus
 * the case's own duration, `e2e/resident-shell-tab`). 12s keeps the sum under the 30s the bounded-failure
 * reading asks for across that range, and still fits the first 8s landing probe plus one full 3s replay.
 */
const STARTUP_PROBE_DEADLINE_MS = 12_000;

/**
 * What the startup page said, kept for one purpose: a startup red has to *explain* a document that was
 * pulled out from under the navigation instead of reporting that a wait ran out.
 */
const startupEvidence = {
  consoleErrors: [] as string[],
  failedRequests: [] as string[],
};

/** The startup page's own text plus this run's console and network evidence — what a startup red is read from. */
const readStartupEvidence = async (page: Page): Promise<string> => {
  const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
  const errors = startupEvidence.consoleErrors.slice(0, 5);
  const failed = startupEvidence.failedRequests.slice(0, 5);
  return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
    + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
    + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
};

/**
 * What a guarded navigation is expected to land on — and how the guard names it when it never lands.
 *
 * `present` and `label` are functions rather than values because both are read at attempt time: the label
 * carries the run's own session, and the locator has to be re-created against whatever document is
 * current *now*, after a replay has replaced the one the navigation started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/**
 * The one place this spec's *startup* navigation is made. `ensureSignedIn` above has its own retried
 * navigation to the app root — the harness's first navigation, already bounded and explained at its own
 * definition — and it stays as it is; every other navigation in this file is the guarded call below.
 *
 * One pass is: navigate, then probe the landing with a short budget. A landing that does not arrive has
 * the navigation replayed — a fresh document, which is exactly what recovers from in-flight module
 * requests that were interrupted once — and the probe repeated, until the deadline. When the deadline is
 * spent the guard throws with the page's own text and this run's failed-request list, never silently
 * continuing: a probe that cannot land must end the run here, with a cause, rather than let the case time
 * out on a document with nothing in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did
 * not arrive rather than as an error of its own — a document that never finishes loading and a document
 * that loads without ever mounting are the same failure from here, and both end at the same named error.
 */
const navigateBounded = async (
  page: Page,
  url: string,
  landing: StartupLanding,
  kind: 'first-load' | 'replay',
): Promise<void> => {
  const startedAt = Date.now();
  const deadline = startedAt + STARTUP_PROBE_DEADLINE_MS;
  const budgetMs = () => Math.max(1, deadline - Date.now());
  let navigationFailure: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      if (attempt === 1 && kind === 'first-load') {
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
      console.log(
        `[e2e] client startup: ${landing.label()} landed after ${Date.now() - startedAt}ms (attempt ${attempt})`,
      );
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${landing.label()} never rendered, so this run's client never came up to a document that stays`
        + `${navigationFailure === null ? '' : ` (the navigation itself failed: ${navigationFailure})`}`
        + `: ${await readStartupEvidence(page)}`,
      );
    }
  }
};

/* ── the harness the resident family's specs share ───────────────────────────── */

/**
 * Signs in once for the whole file.
 *
 * Every case gets its own context, so the default `page` fixture starts unauthenticated;
 * re-running onboarding per case would cost more than the file's budget. Retried and
 * bounded for the same reason `e2e/resident-enable-consent.spec.ts` retries it: the first
 * navigation of a run is the one that pays for the client's module graph, and a loaded
 * host loses that race against a five-second template.
 */
const ensureSignedIn = async (page: Page) => {
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  const arrived = createAccount.or(settings).or(page.locator('#username')).first();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/').catch(() => undefined);
    try {
      await expect(arrived).toBeVisible({ timeout: 15_000 });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(1_000);
    }
  }
  if (lastError !== null) {
    const body = await page.locator('body').innerText().catch(() => '<unreadable>');
    throw new Error(
      `the app never reached a sign-in, onboarding or signed-in screen at ${page.url()}: `
        + `${body.replace(/\s+/g, ' ').trim().slice(0, 400) || '<empty body>'}`,
    );
  }

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

/** Puts the captured session into the context the test's own options already built. */
const restoreSession = async (page: Page) => {
  await page.addInitScript(([key, token]) => {
    try {
      window.localStorage.setItem(key, token);
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken] as const);
};

/** The seeded project's own row in the sidebar: a heading on mobile, a button on desktop. */
const projectRow = (page: Page) => {
  const name = escapeRegExp(path.basename(workspace));
  return page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${name}`) }))
    .first();
};

const sessionOptionsButton = (page: Page) =>
  page.getByRole('button', { name: `Session options for ${SEEDED_SESSION_NAME}` });

/**
 * Brings the seeded session's row into the sidebar, retrying the project toggle.
 *
 * The row lives under its project and the project row is a toggle, so a click landing
 * mid-render leaves it collapsed. Same retry loop as the sibling spec's `openWorkspace`.
 */
const openSessionRow = async (page: Page) => {
  const button = sessionOptionsButton(page);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await button.isVisible().catch(() => false)) return;

    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(300);
      }
    }

    await projectRow(page).click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
  await expect(button, 'the seeded session must have a row in the sidebar').toBeVisible({ timeout: 15_000 });
};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and happens once for the file.
  test.setTimeout(120_000);
  const clientUrl = test.info().project.use.baseURL;
  if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, WORKSPACE_DIR_BASENAME);
  // Before any page of this run exists, so this run's own optimize/re-optimize is over before the guarded
  // navigation below — see `warmClientStartup` for why that cost cannot be left inside the window.
  await warmClientStartup(clientUrl);
  await bootstrapAuth(browser);
});

test('a resident session closes the Shell tab, and closing the mode reopens it', async ({ page, request }) => {
  // ── AC7: the copy, before anything that needs a browser ───────────────────────────────
  const gaps = localeGaps();
  console.log(`locales.ok=${LOCALES.length - new Set(gaps.map((gap) => gap.locale)).size}`);
  console.log(`locales.missing=${JSON.stringify(gaps)}`);
  expect(
    gaps,
    'every locale must carry the Shell notice and the menu item — a key present only in en is a locale that '
      + 'silently falls back to English',
  ).toEqual([]);

  const residentProviders = await residentCapableProviders(request);
  console.log(`capability.residentProviders=${residentProviders.join(',')}`);
  expect(
    residentProviders,
    `${SESSION_PROVIDER} must list resident in its capability matrix, or the mode below cannot be recorded`,
  ).toContain(SESSION_PROVIDER);

  // ── AC3: the positive control — an ordinary session's Shell tab works ────────────────
  const perRunWrite = await writeMode(request, 'per-run');
  console.log(`mode.write.perRun=${JSON.stringify(perRunWrite)}`);
  const perRunMode = await waitForMode(request, 'per-run');
  console.log(`mode=${perRunMode}`);
  expect(perRunMode, 'the seeded session must read per-run before the control below is worth anything').toBe('per-run');

  await restoreSession(page);
  // The page's console and network evidence is registered before the guarded navigation, so the burst
  // that matters — this run's interrupted module requests — is inside the red the guard throws.
  page.on('console', (message) => {
    if (message.type() === 'error') {
      startupEvidence.consoleErrors.push(message.text());
      console.log(`[e2e] page console error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
  });
  // The one startup navigation is the guard's — it lands on the Shell tab or it ends the run with the
  // page's own text and this run's failed-request list. `ensureSignedIn`'s retried navigation to the app
  // root is the harness's own, already bounded and explained at its definition.
  await navigateBounded(page, `/session/${SEEDED_SESSION_ID}`, {
    label: () => `the Shell tab for ${SEEDED_SESSION_ID}`,
    present: (budgetMs) => appears(shellTab(page), budgetMs),
  }, 'first-load');
  await expect(shellTab(page), 'the workspace must offer its Shell tab for a selected session').toBeVisible({ timeout: 20_000 });

  const perRunDisabled = await tabDisabled(shellTab(page));
  console.log(`shellTab.disabled=${perRunDisabled}`);
  expect(perRunDisabled, 'a per-run session is exactly the session the Shell tab is for').toBe(false);

  const chatEnabled = await tabDisabled(chatTab(page));
  console.log(`chatTab.disabled=${chatEnabled}`);
  expect(chatEnabled, 'the tab strip is not disabled wholesale; the control has to show the difference').toBe(false);

  await attemptTabClick(page, SHELL_TAB_LABEL);
  const afterPerRunClick = await activeTabId(page);
  console.log(`tabClick.after=${afterPerRunClick}`);
  expect(afterPerRunClick, 'clicking Shell on a per-run session must land on Shell').toBe('shell');
  const perRunMounted = await shellViewMounted(page);
  console.log(`shellView.mounted=${perRunMounted}`);
  expect(perRunMounted).toBe(true);

  // ── AC5: the mode changes while the Shell view is the active one ─────────────────────
  //
  // This is the state the guard exists for: the tab is not merely disabled, the view that is
  // already open has to close. Nothing is sent to the session, so the process this mode is
  // about does not exist — which is the reading the next block takes.
  const guardBefore = await activeTabId(page);
  console.log(`guard.activeTab.before=${guardBefore}`);
  await writeMode(request, 'resident');
  const residentMode = await waitForMode(request, 'resident');
  console.log(`mode=${residentMode}`);
  expect(residentMode, 'the write must be readable back off the session row').toBe('resident');

  // The mode was recorded from outside the page, so this is the workspace's own poll catching up.
  // Both readings below come from the one property, so they settle together; the wait is bounded,
  // because "the tab never closed" is one of the two outcomes being measured and an open-ended
  // wait would report it as a timeout rather than as the value it is.
  const settled = await waitForResidentShell(page);
  console.log(`activeTab=${settled.activeTab}`);

  // ── AC2: the disabled tab, on a session whose process does not exist ────────────────
  //
  // Read first, before anything else in this state: this is the reading the whole task turns
  // on, so if a wrong judgement about the mode is in play, the red has to land here.
  console.log(`shellTab.disabled=${settled.disabled}`);
  expect(
    settled.disabled,
    'a resident session must close the Shell tab — and this session has no live process, so a reading that '
      + 'asked whether one exists would say the opposite',
  ).toBe(true);

  const hosts = await hostsForSession(request, SEEDED_SESSION_ID);
  console.log(`hosts.forSession=${hosts}`);
  expect(hosts, 'the session was never sent a message, so no host may be serving it').toBe(0);

  // ── AC5: the view that was open on Shell is gone, and the reason is on screen ────────
  expect(settled.activeTab, 'a session that turns resident under an open Shell view must not keep that view')
    .not.toBe('shell');

  const mountedAfterResident = await shellViewMounted(page);
  console.log(`shellView.mounted.afterResident=${mountedAfterResident}`);
  expect(mountedAfterResident, 'the shell view must be gone, not merely hidden behind another tab').toBe(false);

  await expect(
    notice(page),
    'a resident session must say why the Shell tab is closed, without a reload',
  ).toBeVisible({ timeout: 20_000 });

  const noticeInView = (await notice(page).textContent()) ?? '';
  console.log(`notice.inView=${noticeInView}`);
  expect(noticeInView, 'the notice on screen must be the shipped sentence, verbatim').toBe(SHELL_NOTICE_SENTENCE);

  const residentDisabledReason = await shellTab(page).getAttribute('data-disabled-reason');
  console.log(`shellTab.disabledReason=${residentDisabledReason}`);
  expect(residentDisabledReason, 'the closed tab has to say *why* it is closed, not only that it is').toBe('resident');

  const ariaDisabled = await shellTab(page).getAttribute('aria-disabled');
  console.log(`shellTab.ariaDisabled=${ariaDisabled}`);
  expect(ariaDisabled).toBe('true');

  const tabTitle = await shellTab(page).getAttribute('title');
  const describedBy = await shellTab(page).getAttribute('aria-describedby');
  const describedText = describedBy ? ((await page.locator(`#${describedBy}`).textContent()) ?? '') : '';
  const noticeSource = tabTitle === SHELL_NOTICE_SENTENCE
    ? 'title'
    : describedText === SHELL_NOTICE_SENTENCE
      ? 'aria-describedby'
      : 'none';
  console.log(`shellTab.notice=${tabTitle ?? '<none>'}`);
  console.log(`shellTab.notice.source=${noticeSource}`);
  expect(tabTitle, 'the disabled tab must carry the sentence itself, not only a pointer to it').toBe(SHELL_NOTICE_SENTENCE);
  expect(noticeSource, 'the sentence has to reach the tab through `title` or `aria-describedby`').not.toBe('none');

  const clickBefore = await activeTabId(page);
  console.log(`tabClick.before=${clickBefore}`);
  const refused = await attemptTabClick(page, SHELL_TAB_LABEL);
  console.log(`tabClick.refused=${refused === 'refused'}`);
  const clickAfter = await activeTabId(page);
  console.log(`tabClick.after=${clickAfter}`);
  expect(clickAfter, 'a press on the disabled Shell tab must leave the active view where it was').toBe(clickBefore);

  const chatStillEnabled = await tabDisabled(chatTab(page));
  console.log(`chatTab.disabled=${chatStillEnabled}`);
  expect(chatStillEnabled, 'the rest of the tab strip stays usable while Shell is closed').toBe(false);

  // ── AC4: the way back out, through the session's own menu ───────────────────────────
  const modeBeforeMenu = await modeOf(request, SEEDED_SESSION_ID);
  console.log(`mode.beforeMenu=${modeBeforeMenu}`);
  const disabledBeforeMenu = await tabDisabled(shellTab(page));
  console.log(`shellTab.disabled.beforeMenu=${disabledBeforeMenu}`);
  expect({ mode: modeBeforeMenu, disabled: disabledBeforeMenu }, 'the control the item below is measured against')
    .toEqual({ mode: 'resident', disabled: true });

  await openSessionRow(page);
  await sessionOptionsButton(page).click();
  const closeItem = page.getByRole('menuitem', { name: CLOSE_RESIDENT_LABEL });
  await expect(closeItem, 'a resident session must offer the way back out of the mode').toBeVisible({ timeout: 10_000 });
  console.log('menu.item=present');
  const menuEnabled = !(await closeItem.isDisabled());
  console.log(`menu.enabled=${menuEnabled}`);
  expect(menuEnabled, 'the item is the path the criterion takes, so it has to be usable').toBe(true);

  await closeItem.click();

  const afterClose = await waitForMode(request, 'per-run');
  console.log(`mode.afterClose=${afterClose}`);
  expect(afterClose, 'the menu item must record the preference through the server, not in local state').toBe('per-run');

  // The menu is closed by hand: it stays open on selection so that a refusal is readable where it
  // happened, and the readings below are about the workspace behind it.
  await page.keyboard.press('Escape');
  await expect(closeItem).toBeHidden({ timeout: 5_000 });

  const disabledAfter = await waitForTabDisabled(page, false);
  console.log(`shellTab.disabled.after=${disabledAfter}`);
  expect(disabledAfter, 'the same session must get its Shell tab back once the mode is gone').toBe(false);

  await attemptTabClick(page, SHELL_TAB_LABEL);
  const afterCloseTab = await activeTabId(page);
  console.log(`tabClick.afterClose=${afterCloseTab}`);
  expect(afterCloseTab, 'the reopened Shell tab must really open').toBe('shell');
  const mountedAfterClose = await shellViewMounted(page);
  console.log(`shellView.mounted=${mountedAfterClose}`);
  expect(mountedAfterClose).toBe(true);

  const elapsed = Date.now() - RUN_STARTED_AT;
  console.log(`elapsed=${elapsed}`);
  expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000);
});
