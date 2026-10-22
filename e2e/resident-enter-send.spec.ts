import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, Page } from '@playwright/test';

/**
 * The shipped English wording, read off the disk rather than restated here.
 *
 * The switch this spec names is the app's own copy, so a spec that carried its own would keep passing after
 * the locale file changed while the words a user meets did not.
 */
type ChatLocale = {
  resident: { toggle: string };
};

const enChat = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'src/modules/i18n/locales/en/chat.json'), 'utf8'),
) as ChatLocale;

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The subject is the ENTER key path through the composer, read the way a user meets it: a real project from
// the run's own seeded HOME, a real session row allocated by the send the key produced, and the lifecycle
// mode read back from the server the session was addressed to. Nothing here rebuilds the mode client-side —
// `GET /api/session-hosts` is the same projection a restart uses to find a resident session whose process it
// dropped, so the `resident` this spec prints is the server's own stored preference and not the switch's
// local state. The host half is read from the same endpoint's `hosts` array, so "a resident host really
// exists for this session" is the process table's answer, not an inference from the switch.
//
// The switch POSITION is the whole of the intent. The consent gate that used to stand between the switch and
// the send — and the disclosure tick that armed it — was retired by the 2026-09-29 product change
// (`gap-resident-toggle-relocate-drop-consent-gate`), and its locale key is gone from every `chat.json`. So
// this file drives the switch and nothing else; there is no separate tick state left for it to set.
//
// The two cases are the pair the reading needs. (a) is the load-bearing one: with the switch on, Enter must
// record the resident intent through the composer's submit entry, so the server stores the session resident
// and a resident host process holds it. (b) is the positive control: with the switch off, the same key must
// send and land `per-run` — without it the `resident` reading above would have no resolution, since it would
// score the same for every session. `e2e/resident-enable-consent.spec.ts` (AC-171) presses the SEND BUTTON;
// that spec cannot see this defect, because the Enter path used to reach the send directly and skip the
// intent the switch was showing. Reading the key is this file's whole job.

const COMPOSER = '[data-slot="prompt-input-textarea"]';
/** The disclosure component's own slot — the marker its module declares. */
const NOTICE = '[data-slot="resident-consent-notice"]';
const AUTH_TOKEN_KEY = 'auth-token';
/**
 * The first-paint mirror of the account's preferences, the same key the app writes.
 *
 * `src/shared/userSettings.ts` reads it synchronously so the first render already knows the stored provider;
 * the server's copy is authoritative and is what the legs below write. Priming the mirror removes the one
 * frame in which the composer would be drawing the default provider's capability while the hydrate was in
 * flight.
 */
const PREFERENCES_MIRROR_KEY = 'user-preferences';
const USERNAME = 'e2euser';
const PASSWORD = 'e2epassword';
/** The one provider this spec works under: the capability matrix lists `resident` for it. */
const RESIDENT_PROVIDER = 'claude';

/** Absolute path of the workspace playwright.config.ts seeded for its composer specs. */
let workspace = '';

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Signs in once for the whole file.
 *
 * Every case gets its own browser context, so the default `page` fixture starts unauthenticated. Re-running
 * onboarding per case would cost more than the whole budget, so the session is captured here and replayed
 * into each context by `restoreSession`. Same helper as `e2e/resident-enable-consent.spec.ts`, including the
 * bounded retry: the first navigation pays for the client's whole module graph, and a loaded host can lose
 * that race and report "element not found" — a red that names nothing the reader can act on.
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

/** The signed-in token, captured once by `bootstrapAuth`. */
let authToken = '';

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

/** Puts the captured session into the context the test's own options already built, mirroring the provider. */
const restoreSession = async (page: Page, provider?: string) => {
  await page.addInitScript(([key, token, mirrorKey, mirrorValue]) => {
    try {
      window.localStorage.setItem(key, token);
      if (mirrorValue) {
        window.localStorage.setItem(mirrorKey!, JSON.stringify({ selectedProvider: mirrorValue }));
      }
    } catch {
      // about:blank has an opaque origin; the real navigation below is what matters.
    }
  }, [AUTH_TOKEN_KEY, authToken, provider ? PREFERENCES_MIRROR_KEY : null, provider ?? null] as const);
};

/** Writes the account's selected provider through the app's own preference API, and reads it back. */
const setSelectedProvider = async (request: APIRequestContext, provider: string) => {
  const written = await request.patch('/api/user/preferences', {
    headers: auth(authToken),
    data: { selectedProvider: provider },
  });
  expect(written.ok(), `PATCH /api/user/preferences answered ${written.status()}`).toBe(true);

  const readBack = await request.get('/api/user/preferences', { headers: auth(authToken) });
  const body = (await readBack.json()) as { preferences?: { selectedProvider?: string } };
  expect(
    body.preferences?.selectedProvider,
    'the stored provider must be the one just written — otherwise the leg below would read the default',
  ).toBe(provider);
};

/** One host as `GET /api/session-hosts` projects it: enough to say which session a resident process holds. */
type HostRow = { mode: string; state: string; bindings: { appSessionId: string }[] };
/** One session's stored mode, as the same endpoint projects it off the session rows. */
type SessionRow = { appSessionId: string; lifecycleMode: string };

/** The whole listing: both halves of the one endpoint, read together so they cannot disagree. */
const sessionHosts = async (request: APIRequestContext): Promise<{ hosts: HostRow[]; sessions: SessionRow[] }> => {
  const response = await request.get('/api/session-hosts', { headers: auth(authToken) });
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  const body = (await response.json()) as { data?: { hosts?: HostRow[]; sessions?: SessionRow[] } };
  return { hosts: body.data?.hosts ?? [], sessions: body.data?.sessions ?? [] };
};

/** Every stored lifecycle mode, keyed by session id. */
const sessionModes = async (request: APIRequestContext): Promise<Map<string, string>> => {
  const { sessions } = await sessionHosts(request);
  return new Map(sessions.map((row) => [row.appSessionId, row.lifecycleMode]));
};

const modeOf = async (request: APIRequestContext, sessionId: string) =>
  (await sessionModes(request)).get(sessionId);

/** True while some live host holds `sessionId` under the given mode. */
const hostHolds = async (request: APIRequestContext, sessionId: string, mode: string): Promise<boolean> => {
  const { hosts } = await sessionHosts(request);
  return hosts.some(
    (host) => host.mode === mode
      && host.state !== 'closed'
      && host.bindings.some((binding) => binding.appSessionId === sessionId),
  );
};

/**
 * Reads one session's mode until it is `expected`, and returns whatever it last read.
 *
 * The write this waits for travels the app's own path — the composer's send allocates the session, then asks
 * the server to keep it running — so the two are not adjacent in time. Returning the last reading rather
 * than asserting inside the loop lets the caller print what it actually saw, which is the difference between
 * a red that names the value and one that names an expectation.
 */
const waitForMode = async (
  request: APIRequestContext,
  sessionId: string,
  expected: string,
  budgetMs = 20_000,
): Promise<string> => {
  const deadline = Date.now() + budgetMs;
  let last = await modeOf(request, sessionId);
  while (last !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await modeOf(request, sessionId);
  }
  return last ?? 'undefined';
};

/** Reads the host table until a `mode` host holds `sessionId`, and reports what it last saw. */
const waitForHost = async (
  request: APIRequestContext,
  sessionId: string,
  mode: string,
  budgetMs = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  let last = await hostHolds(request, sessionId, mode);
  while (!last && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await hostHolds(request, sessionId, mode);
  }
  return last;
};

const composer = (page: Page) => page.locator(COMPOSER);

/**
 * The seeded project's own row, whichever of the sidebar's two designs is on screen.
 *
 * The sidebar renders a dense button on desktop and a tappable card on a phone; the card's accessible name
 * sits on a heading rather than on the clickable element. Both are targeted so the spec says "open this
 * project" rather than naming markup. Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const projectRow = (page: Page) =>
  page.getByRole('heading', { name: path.basename(workspace) })
    .or(page.getByRole('button', { name: new RegExp(`^${escapeRegExp(path.basename(workspace))}`) }))
    .first();

/**
 * How long the sidebar is given to draw the seeded project before the composer is opened.
 *
 * The row appears only once the client has booted and answered its own project listing, and a loaded host
 * pushes that past the fixed five seconds the click here used to carry: the click then timed out, the
 * failure was swallowed, and the retry loop behind it spent what was left of the case on a row that was
 * never on screen. This budget is chosen under the criterion's own ceilings — the gate kills the run at
 * 60s and the config's watchdog at 55s — so a slow sidebar is waited out rather than given up on.
 */
const PROJECT_ROW_READY_MS = 20_000;

/**
 * Opens a composer bound to the seeded project, through the app's own "New Session" entry point.
 *
 * The composer only renders once a project is selected, and this run seeds more than one project, so the
 * selection is made the way a user makes it. The project row is a toggle, so a click landing mid-render can
 * leave it collapsed; the loop retries. Same helper as `e2e/resident-enable-consent.spec.ts`.
 */
const openComposer = async (page: Page) => {
  const textarea = composer(page);
  const row = projectRow(page);
  const newSession = page.getByRole('button', { name: 'New Session' }).first();

  // Wait for the row to be on screen, then click it with no fixed sub-deadline of its own: the case's own
  // budget is the bound, so a row that is merely late is waited for instead of being abandoned after 5s.
  await expect(row).toBeVisible({ timeout: PROJECT_ROW_READY_MS }).catch(() => undefined);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await textarea.isVisible().catch(() => false)) return;

    if (!(await page.getByRole('button', { name: 'Close sidebar' }).isVisible().catch(() => false))) {
      const menu = page.getByRole('button', { name: 'Open menu' });
      if (await menu.isVisible().catch(() => false)) {
        await menu.click().catch(() => undefined);
        await page.waitForTimeout(400);
      }
    }

    if (!(await newSession.isVisible().catch(() => false))) {
      await row.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    if (await newSession.isVisible().catch(() => false)) {
      await newSession.click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
  await expect(textarea).toBeVisible({ timeout: 15_000 });
};

/** The switch, on the new-session empty state — its only home — once the capability matrix has answered. */
const residentToggle = (page: Page) => page.getByRole('switch', { name: enChat.resident.toggle });

/**
 * Opens a new-session composer and, when asked, flips the resident switch on.
 *
 * The two legs differ only in this prefix, so it lives in one place: the switch OFF is the positive
 * control's state, the switch ON is the one whose Enter send must land resident. The switch lives on
 * the new-session empty state's model card (the composer no longer draws one), and `openComposer`
 * lands on that screen, so the page-wide locator finds it there. Nothing is ticked afterwards — the
 * switch position is the whole of the intent, so there is no separate tick to set.
 */
const openResidentComposer = async (page: Page, { switchOn }: { switchOn: boolean }) => {
  await page.goto('/');
  await openComposer(page);

  if (!switchOn) return;

  const toggle = residentToggle(page);
  await expect(
    toggle,
    `${RESIDENT_PROVIDER} lists resident in its capability matrix, so the new-session screen must offer the switch`,
  ).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  await expect(page.locator(NOTICE), 'opening the switch must disclose the mode in place').toBeVisible();
};

test.describe.configure({ mode: 'serial' });
// Each of the two cases gets an explicit budget of its own. It sits above the two `waitFor*` budgets (20s each)
// so it never pre-empts a legitimate wait, and below both the criterion's 60s gate and the config's 55s run
// watchdog so a case that outruns either fails while naming itself rather than being killed from outside — the
// default per-case budget is the 60s the gate also uses, which no case can ever reach before being killed.
test.describe.configure({ timeout: 45_000 });

test.beforeAll(async ({ browser }) => {
  // Onboarding is the expensive part of a fresh database and only happens once for the file.
  test.setTimeout(120_000);
  workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'mobile-send-key-workspace');
  await bootstrapAuth(browser);
});

test('AC-180 (a): Enter with the resident switch on allocates a resident session, and a resident host holds it', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  await openResidentComposer(page, { switchOn: true });

  const textarea = composer(page);
  await textarea.fill('enter key resident probe');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`created.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'resident');
  console.log(`session.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'the session an Enter send addressed with the switch on must read back as resident from the server — the '
      + 'key reached the send without recording the resident intent the switch was showing',
  ).toBe('resident');

  const heldByResidentHost = await waitForHost(request, createdSessionId, 'resident');
  const { hosts } = await sessionHosts(request);
  console.log(`host.resident.bindsSession=${heldByResidentHost}`);
  console.log(`hosts=${JSON.stringify(hosts.map((host) => ({ mode: host.mode, state: host.state, sessions: host.bindings.map((b) => b.appSessionId) })))}`);
  expect(
    heldByResidentHost,
    'a session stored resident must have a resident host holding it — the mode is the stored wish, the host is '
      + 'the process that is really there',
  ).toBe(true);
});

test('AC-180 (b) control: Enter with the resident switch off still sends, and lands per-run', async ({ page, request }) => {
  await setSelectedProvider(request, RESIDENT_PROVIDER);
  await restoreSession(page, RESIDENT_PROVIDER);
  // No switch interaction at all: this is the shape every non-resident send has always had.
  await openResidentComposer(page, { switchOn: false });

  const textarea = composer(page);
  await textarea.fill('enter key per-run control');
  await textarea.press('Enter');

  await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/session\/[^/]+$/);
  const createdSessionId = new URL(page.url()).pathname.split('/').pop() as string;
  console.log(`control.sessionId=${createdSessionId}`);

  const createdMode = await waitForMode(request, createdSessionId, 'per-run');
  console.log(`control.lifecycle_mode=${createdMode}`);
  expect(
    createdMode,
    'a session created with the switch off must read per-run — otherwise the resident reading above has no '
      + 'resolution and would score the same for every session',
  ).toBe('per-run');
});
