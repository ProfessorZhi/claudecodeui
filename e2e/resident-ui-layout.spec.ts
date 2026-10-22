import path from 'node:path';

import { expect, request, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test';

/**
 * The instant this criterion's `npx playwright test` invocation began.
 *
 * `playwright.config.ts` publishes it (`QUAY_E2E_RUN_STARTED_AT`) for exactly this reading: the 55 s
 * ceiling is on the whole invocation — config evaluation, seeding, server boot, browser launch — and a
 * spec that timed only its own body would report a number whose shortfall against the ceiling is the part
 * it could not see. The fallback is for a run started outside the config (there is none today); it can
 * only make the reading smaller.
 */
const RUN_STARTED_AT = Number(process.env.QUAY_E2E_RUN_STARTED_AT) || Date.now();

/**
 * The viewport the criterion is pinned to.
 *
 * Both numbers are the criterion's own, not the project's default: 780x493 is the window the origin
 * screenshot was taken in, where the composer takes most of the height and the transcript is left with
 * very little of it — the conditions under which a status bar that floats inside the scroll container
 * has nowhere to sit except on top of the conversation.
 */
const VIEWPORT = { width: 780, height: 493 };

/** The chat pane, the same anchor transcript-follow and the other resident specs know the session by. */
const PANE = '.chat-messages-pane';
/**
 * The resident status surface this file reads, and never writes.
 *
 * It used to be the status bar's own root (AC-172's DOM contract). `ad1bb63a` consolidated the resident
 * status bar into the activity dock, whose arrow opened the process's facts; that arrow lived in the
 * message flow and, opened, grew the transcript instead of floating over it (measured at 390x844: its
 * lower ~140px landed past the bottom of the scroll area). The facts are now the panel of the resident
 * pill in the workspace header, so the reading addresses the pill. The pill is drawn for exactly the
 * sessions the bar was drawn for (a session whose own host snapshot reads `resident`), so the two legs
 * below still separate by the one fact they always did. See `readGeometry` for what is asked of this box:
 * the pill is outside the transcript's scroll box altogether, so "does not cover a row" is now true by
 * construction, and the legs are what keeps it from being true by the pill not rendering.
 */
const BAR = '[data-resident-badge]';
/** One message row. The criterion reads the outermost ones only; see `readGeometry`. */
const ROW = '[data-message-timestamp]';

const USERNAME = 'resident-ui-layout-e2e';
const PASSWORD = 'resident-ui-layout-e2e-pass';

/** The workspace directory this run's fixtures live under, inside the gate's own fixture home. */
const WORKSPACE_DIR = 'resident-ui-layout-workspace';

const TITLE_RESIDENT = 'Resident layout — resident arm';
const TITLE_PER_RUN = 'Resident layout — per-run control';
const SEED_USER_TEXT = 'the seeded turn both arms of the layout criterion start from';
/**
 * The assistant row both arms are measured against, and the only row the reading may select.
 *
 * It is written by the scenario's own clock rather than by the fixture, so the row arrives the way any
 * other row does — through the transcript the engine appends to and the app reads back.
 */
const ASSISTANT_TEXT = 'the assistant answer the status bar must not be drawn over';

/** How long the control arm waits before its bar reading is taken; see the comment at that reading. */
const CONTROL_SETTLE_MS = 2_000;

/* ── the two fixtures ───────────────────────────────────────────────────────────────────────── */

/**
 * One arm, as a scenario: a seeded session, and one clock step that lands the assistant row.
 *
 * `lifecycleMode` is the only difference between the pairs below, and it is the whole point of the pair:
 * the same seeded conversation, the same assistant row and the same reading are taken twice, once on a
 * session stored `resident` and once on one stored `per-run`. The control is therefore the identical
 * reading function on an identical fixture, differing only in the one fact the bar renders on.
 */
const scenarioFor = (title: string, lifecycleMode: 'resident' | 'per-run') => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode },
  steps: [{ at: 0, op: 'row', role: 'assistant', text: ASSISTANT_TEXT }],
  expect: { rows: { delta: 1 }, content: { mustContain: [ASSISTANT_TEXT] } },
});

/* ── the server's own faces ─────────────────────────────────────────────────────────────────── */

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow this criterion never appears in; its last screen is what
 * sets the profile flag the app checks afterwards, so it is called directly. Register-then-login rather
 * than register: a re-run against a data directory that already holds this account must sign in, not
 * fail.
 */
async function createAccount(api: APIRequestContext): Promise<string> {
  const register = await api.post('/api/auth/register', { data: { username: USERNAME, password: PASSWORD } });
  const registered = await register.json().catch(() => null);
  if (typeof registered?.token === 'string') {
    await api.post('/api/user/complete-onboarding', {
      headers: { Authorization: `Bearer ${registered.token}` },
    });
    return registered.token;
  }

  const login = await api.post('/api/auth/login', { data: { username: USERNAME, password: PASSWORD } });
  const loggedIn = await login.json().catch(() => null);
  if (typeof loggedIn?.token !== 'string') {
    throw new Error(
      `could not create or sign in as ${USERNAME}: register ${register.status()} ${JSON.stringify(registered)}, `
        + `login ${login.status()} ${JSON.stringify(loggedIn)}`,
    );
  }
  return loggedIn.token;
}

/** Arms one scenario and returns the session id it was indexed under. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const sessionId = body?.data?.sessionId;
  if (typeof sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return sessionId;
}

/**
 * Walks one armed scenario's clock to its end and reports that it completed.
 *
 * The clock is awaited rather than fired and left: this criterion reads the transcript *after* the walk,
 * so a walk still in flight would make the message row it is about a race. The walk is what lands the
 * assistant row, so a walk that did not complete is a red on the fixture rather than on the geometry —
 * which is why it is asserted here, in its own words, and not left to the reading below.
 */
async function walkClock(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post('/api/debug-agent/clock', { data: { sessionId } });
  const body = await response.json().catch(() => null);
  expect(
    response.ok() && body?.success === true,
    `the clock walk for ${sessionId} must complete: ${response.status()} ${JSON.stringify(body)}`,
  ).toBe(true);
}

/**
 * One session's stored lifecycle mode, off the listing that publishes it.
 *
 * The same face the resident specs read their modes from, and the only one that answers the question: a
 * workspace's own session objects carry no mode at all. Read rather than assumed, because the bar's
 * presence is a function of this value — a fixture that failed to store `resident` would make the whole
 * reading below a statement about a per-run session.
 */
async function readLifecycleMode(api: APIRequestContext, sessionId: string): Promise<string> {
  const response = await api.get('/api/session-hosts');
  const body = (await response.json().catch(() => null)) as
    | { data?: { sessions?: { appSessionId: string; lifecycleMode: string }[] } }
    | null;
  expect(response.ok(), `GET /api/session-hosts answered ${response.status()}`).toBe(true);
  return body?.data?.sessions?.find((session) => session.appSessionId === sessionId)?.lifecycleMode
    ?? '<absent>';
}

/* ── the page's own reading ─────────────────────────────────────────────────────────────────── */

type Box = { x: number; y: number; w: number; h: number; x2: number; y2: number };
type RowReading = { style: string; box: Box };

/**
 * Everything the criterion reads, taken in ONE round trip.
 *
 * The boxes are one reading rather than several because the question is a relation between them: two
 * boxes measured a frame apart can be told apart from a relation that never held, and the status bar
 * polls, so "a frame apart" is a real distance here. `getBoundingClientRect` in a single `evaluate` is
 * what makes the relation the page actually drew.
 *
 * The message is the outermost `[data-message-timestamp]` row *whose `data-message-style` is `assistant`*
 * — the same outermost filter transcript-follow uses (`!row.parentElement?.closest(...)`, which drops the
 * rows nested inside a tool group), narrowed to the row kind the criterion is about. The two attributes
 * sit on two different elements: `data-message-timestamp` is on the row wrapper (LazyMessageRow, which
 * stays in the DOM even while its content is a placeholder) and `data-message-style` is published by the
 * message component inside it. So the *row* is selected by the outer attribute and the *kind* is read
 * from within it, which is what keeps this the outermost row rather than the inner element that happens
 * to be the styled one. `count` is how many rows that filter kept: it is the guard that keeps a blank
 * page from passing, because an empty transcript would otherwise report "no bar over the message" on the
 * strength of there being no message. Every outermost row is reported alongside, so a reading that
 * selected the wrong row says so.
 *
 * Two boxes from `getBoundingClientRect` are not by themselves a picture of what the user sees: the pane
 * is `overflow-y-auto` (and `contain: paint`), so a row scrolled past its top edge still reports a rect
 * that reaches up behind the bar. The reading would then say "the bar covers the message" about a part of
 * the message the pane never drew. That is why the pane's own box is taken here as well: the criterion
 * asserts the message's box lies *inside* the pane's box (`msgInPane`), which is the precondition under
 * which "the bar's box does not touch the message's box" is a statement about the drawn transcript rather
 * than about a rect the pane clips.
 *
 * `barOverRows` is the same relation asked of the rows themselves rather than of the scroll container:
 * every outermost row the bar's box overlaps, which has to be none. It replaced the pane-box reading
 * (`barOverPane`) this file used to assert, because that boundary stopped existing. `ad1bb63a` mounted
 * the dock the status bar was merged into `absolute bottom-full`, so it hangs over the pane's bottom
 * edge on purpose — the pane's box is no longer what separates "over the conversation" from "beside it",
 * and a leg requiring the bar to stay outside it has no satisfiable world left (measured: the dock's box
 * `305,314,459,32` against the pane's `289,57,491,289`). What the boundary was *for* survives one level
 * down: a bar drawn inside the scroll box comes to rest over rows the transcript drew — the top of it,
 * where the retired sticky bar sat — and still reds here, while a bar hanging below the last row reaches
 * none of them. The pane's box is still taken and still printed: `msgInPane` below needs it, and
 * `bar.over.pane` is reported so a red says which of the two relations moved.
 */
const readGeometry = (page: Page) =>
  page.evaluate((selectors: { pane: string; bar: string; row: string; styled: string }) => {
    const boxOf = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, x2: rect.right, y2: rect.bottom };
    };

    // Two boxes overlap when no one axis separates them.
    const overlaps = (a: Box | null, b: Box | null) =>
      Boolean(a && b && a.x < b.x2 && b.x < a.x2 && a.y < b.y2 && b.y < a.y2);

    const pane = document.querySelector(selectors.pane);
    const bar = document.querySelector(selectors.bar);
    const outermost = pane
      ? Array.from(pane.querySelectorAll(selectors.row))
        .filter((row) => !row.parentElement?.closest(selectors.row))
      : [];

    const rows = outermost.map((row) => {
      const styled = row.matches(selectors.styled) ? row : row.querySelector(selectors.styled);
      return {
        style: styled?.getAttribute('data-message-style') ?? '',
        box: boxOf(row),
      };
    });
    const assistantRows = rows.filter((row) => row.style === 'assistant');
    const msg = assistantRows.length ? assistantRows[assistantRows.length - 1].box : null;
    const barBox = bar ? boxOf(bar) : null;
    const paneBox = pane ? boxOf(pane) : null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };

    return {
      bar: barBox,
      msg,
      pane: paneBox,
      rows,
      count: assistantRows.length,
      barExists: Boolean(bar),
      intersect: overlaps(barBox, msg),
      // The criterion's own "fully in the viewport": the message's box lies between the viewport's edges.
      msgVisible: Boolean(
        msg && msg.w > 0 && msg.h > 0 && msg.y >= 0 && msg.y2 <= viewport.height,
      ),
      // The precondition that makes the reading above a statement about the drawn transcript: the row is
      // not one the pane has scrolled past.
      msgInPane: Boolean(
        msg && paneBox
          && msg.x >= paneBox.x && msg.y >= paneBox.y && msg.x2 <= paneBox.x2 && msg.y2 <= paneBox.y2,
      ),
      // Whether the bar is drawn inside the scroll container. Reported, not asserted on the resident arm:
      // the consolidated dock is mounted to hang over the pane's bottom edge on purpose, so this is true
      // by design there. The control arm still asserts it, where there is no bar to be inside anything.
      barOverPane: overlaps(barBox, paneBox),
      // The load-bearing boundary, asked of the rows rather than of the container: the outermost rows the
      // bar's box overlaps. Empty on both arms; non-empty if the bar is put back inside the scroll box.
      barOverRows: rows.filter((row) => overlaps(barBox, row.box)),
      viewport,
    };
  }, { pane: PANE, bar: BAR, row: ROW, styled: '[data-message-style]' });

/** A box as the criterion prints it: `x,y,w,h`, rounded, or a named absence. */
const formatBox = (box: Box | null): string =>
  box ? `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.w)},${Math.round(box.h)}` : '<none>';

/** A set of rows as the criterion prints it: `style@x,y,w,h` each, so a red names the rows it caught. */
const describeRows = (rows: RowReading[]): string[] =>
  rows.map((row) => `${row.style}@${formatBox(row.box)}`);

/** Prints one arm's whole reading, so the assertions below are readable against what was seen. */
const printReading = (label: string, reading: Awaited<ReturnType<typeof readGeometry>>): void => {
  console.log(`${label}.bar.exists=${reading.barExists}`);
  console.log(`${label}.bar.box=${formatBox(reading.bar)}`);
  console.log(`${label}.msg.box=${formatBox(reading.msg)}`);
  console.log(`${label}.intersect=${reading.intersect}`);
  console.log(`${label}.msg.visible=${reading.msgVisible}`);
  console.log(`${label}.msg.in.pane=${reading.msgInPane}`);
  console.log(`${label}.bar.over.pane=${reading.barOverPane}`);
  console.log(`${label}.bar.over.rows=${JSON.stringify(describeRows(reading.barOverRows))}`);
  console.log(`${label}.msg.count=${reading.count}`);
  console.log(`${label}.pane.box=${formatBox(reading.pane)}`);
  console.log(`${label}.viewport=${reading.viewport.width}x${reading.viewport.height}`);
  console.log(`${label}.rows=${JSON.stringify(describeRows(reading.rows))}`);
};

/* ── the startup guard ────────────────────────────────────────────────────────────────────────
 *
 * This spec's startup path, bounded. Measured (the goal-sweep and goal-cli AC-177 fails of
 * 2026-09-30T10:40:21Z / 10:43:12Z): a single transient interruption of the app's in-flight module
 * requests — Chromium's `net::ERR_NETWORK_CHANGED`, ten in one burst, no 504 — left the document with a
 * module graph that never executed. React never mounted, the fixture project row never appeared, and the
 * only wait on it was unbounded (`revealSession`'s `waitFor({ timeout: 30_000 })`): the run died at 30s
 * with `TimeoutError: locator.waitFor: Timeout 30000ms exceeded`, and that run's trace showed only the
 * burst afterwards. Not one of this file's three cases ran.
 *
 * The trigger is outside this repository (a host-level network change notification; on this host, docker/
 * veth churn). What is inside it is the *response*: the same transient interruption must cost a bounded
 * replay, not an unbounded wait. Two levers, both already established in this repo's sibling specs — a
 * bounded client warm-up and a bounded navigation probe, ported from `e2e/resident-running-view.spec.ts`
 * (which took them from `e2e/session-filter.spec.ts` / `e2e/transcript-follow.spec.ts`). Neither is
 * invented here.
 *
 * What the guard may **not** do is decide anything for the three cases. It replays a navigation and it
 * fails loudly when it cannot land; it never treats "not landed" as "good enough". Written the other way —
 * probe times out, carry on — each case would wait out its own budget on a blank document and the run
 * would still cross the gate's 60s, which is what the bounded-failure reading in this task's AC measures.
 */

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * How long this run's own client is given to answer its app entry before the startup path gives up on it.
 *
 * The run already has two ceilings above it (playwright.config.ts's watchdog, then the goal gate's 60s) and
 * both are *outside* this spec — an unbounded wait here would be reported by whichever fired first, naming
 * neither the url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before any
 * page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is held, and a url carrying a
 * hash from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite answers
 * a re-optimization committed after it began serving by pushing `full-reload` to every connected client,
 * which replaces the document whole — the other way this criterion has lost a page mid-flight. A 200 there
 * means the pages below will not race the optimizer.
 *
 * It runs before any page of this run exists — the same requests the page would have made, made first. It
 * is here rather than in playwright.config.ts's `globalSetup` because Playwright resolves every
 * `globalSetup` entry as a *script* (a path that must default-export the function), so an inline warm-up
 * there is neither type-legal nor loadable, and this task's write surface allows no new file.
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

  // The proof: a dependency url current for this run — re-read from the entry each attempt, because the hash a
  // url carries is the one its writer committed, and the entry is where the current one is written.
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

/**
 * The warm-up, taken exactly once per worker before any page exists.
 *
 * This file has three independent startup paths — the AC-179 case, the AC-177 describe's `beforeAll` and the
 * AC-178 case — and each creates its own page. A shared lazy promise makes every path observe the same
 * single warm-up without any of them having to know whether it ran first: the ordering the property needs
 * ("before any page") is a property of the file, not of which case Playwright schedules first.
 */
let warmClientStartupPromise: Promise<number> | null = null;
const warmClientStartupOnce = (clientUrl: string): Promise<number> => {
  warmClientStartupPromise ??= warmClientStartup(clientUrl);
  return warmClientStartupPromise;
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
 * own wall clock: the bounded-failure reading asks that a probe which cannot succeed ends the whole run in
 * under 30s, and that run pays the config evaluation, both servers' boot and the browser launch before the
 * probe's first attempt even starts. Counting replays leaves that head-room to chance; a deadline spends it.
 */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * What the startup pages said, kept for one purpose: a startup red has to *explain* a document that was
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
 * Registers a page's console and failed-request evidence.
 *
 * Called on every page this file creates, before that page's first navigation: a burst of module requests
 * that never landed is only in the evidence if the listener was already attached when it happened.
 */
const attachStartupEvidence = (page: Page): void => {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      startupEvidence.consoleErrors.push(message.text());
      console.log(`[e2e] page console error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
  });
};

/**
 * What a guarded navigation is expected to land on — and how the guard names it when it never lands.
 *
 * `present` and `label` are functions rather than values because both are read at attempt time: the label
 * carries the run's own workspace, and the locator has to be re-created against whatever document is
 * current *now*, after a replay has replaced the one the navigation started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/**
 * The one place this spec navigates — every navigation in this file is inside this function, which is what
 * makes "every navigation is guarded" a property of the file rather than a habit of its call sites. The
 * url is a parameter rather than the sibling's baked-in `/`, because this file has three different landing
 * pages across four navigation sites.
 *
 * One pass is: navigate to `url`, then probe the landing with a short budget. A landing that does not arrive
 * has the navigation replayed — a fresh document, which is exactly what recovers from in-flight module
 * requests that were interrupted once — and the probe repeated, until the deadline. When the deadline is
 * spent the guard throws with the page's own text and this run's failed-request list, never silently
 * continuing: a probe that cannot land must end the run here, with a cause, rather than let three cases time
 * out one after another on a document with nothing in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did not
 * arrive rather than as an error of its own — a document that never finishes loading and a document that
 * loads without ever mounting are the same failure from here, and both end at the same named error.
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

/** The page and the context it lives in, both signed in as the account this run created. */
const openPage = async (
  browser: Browser,
  baseURL: string,
  token: string,
  form: { viewport?: { width: number; height: number }; touch?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> => {
  // Before this run's first page: this run's optimize/re-optimize is over before the guard's navigation.
  await warmClientStartupOnce(baseURL);
  const context = await browser.newContext({
    baseURL,
    viewport: form.viewport ?? VIEWPORT,
    // `isMobile` as well as `hasTouch`: the pointer media query the app's device rules read only reports a
    // coarse, hover-less primary pointer for an emulated phone, not for a mouse context that merely taps.
    hasTouch: form.touch ?? false,
    isMobile: form.touch ?? false,
  });
  await context.addInitScript(
    ({ authKey, authToken, language }: { authKey: string; authToken: string; language: string }) => {
      window.localStorage.setItem(authKey, authToken);
      window.localStorage.setItem('userLanguage', language);
    },
    { authKey: 'auth-token', authToken: token, language: 'en' },
  );
  const page = await context.newPage();
  attachStartupEvidence(page);
  return { context, page };
};

/**
 * Opens one session and waits until the transcript has drawn a row.
 *
 * The pane is awaited first because it is the scroll container itself and the subject of every reading
 * below; a page that never reached the session would otherwise fail on a message-row timeout and report
 * the fixture rather than the layout.
 */
const openSession = async (
  page: Page,
  sessionId: string,
  viewport: { width: number; height: number } = VIEWPORT,
): Promise<void> => {
  await page.setViewportSize(viewport);
  await navigateBounded(
    page,
    `/session/${sessionId}`,
    { label: () => `the transcript pane for session ${sessionId}`, present: (budgetMs) => appears(page.locator(PANE), budgetMs) },
    'first-load',
  );
  await expect(page.locator(PANE), `the pane must open for session ${sessionId}`).toBeVisible({ timeout: 30_000 });
  await page.waitForSelector(`${PANE} ${ROW}`, { timeout: 30_000 });
};

/**
 * AC-179: the resident status bar must not be drawn over the conversation it describes.
 *
 * The surface read below is the resident pill (`[data-resident-badge]`) — the root `BAR` addresses and the
 * one `ad1bb63a` consolidated the bar into. It is drawn for exactly the sessions the bar was drawn for,
 * so the pair of legs still separates by the one fact it always did.
 *
 * Two legs, one run, one reading function. The resident leg is the load-bearing reading — at 780x493, with one
 * assistant message on screen, the bar's bounding box and that message's bounding box must not overlap,
 * the message's box must lie entirely inside the viewport *and* inside the transcript's own box, and the
 * bar's box must not overlap any row the pane drew. The per-run leg is the control that keeps
 * the first from being satisfied by a reading that can only ever say "no bar": the same function, on the
 * same fixture, must find no bar at all — and the same message visible.
 */
test('status bar does not cover the transcript', async ({ browser }) => {
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection');
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error('playwright.config.ts must give this project a baseURL');
  }

  // The workspace has to sit inside the fixture home: the control plane writes only under
  // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
  const workspace = path.join(fixtureHome, WORKSPACE_DIR);

  const bootstrap = await request.newContext({ baseURL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  const residentId = await armScenario(api, workspace, scenarioFor(TITLE_RESIDENT, 'resident'));
  const perRunId = await armScenario(api, workspace, scenarioFor(TITLE_PER_RUN, 'per-run'));
  await walkClock(api, residentId);
  await walkClock(api, perRunId);

  // The mode is read back off the listing rather than trusted to the arm: the bar's presence is a
  // function of this value, so a fixture that stored something else would silently turn the resident leg
  // into a second control leg.
  const residentMode = await readLifecycleMode(api, residentId);
  const perRunMode = await readLifecycleMode(api, perRunId);
  console.log(`resident.session=${residentId}`);
  console.log(`resident.session.lifecycle_mode=${residentMode}`);
  console.log(`per-run.session=${perRunId}`);
  console.log(`per-run.session.lifecycle_mode=${perRunMode}`);
  expect(residentMode, 'the load-bearing arm has to be a session the app stores as resident').toBe('resident');
  expect(perRunMode, 'the control arm has to be a session the app stores as per-run').toBe('per-run');

  const { context, page } = await openPage(browser, baseURL, token);

  try {
    // ── AC2: the resident arm — a bar that does not touch the message it describes ──────────────
    await openSession(page, residentId);
    await expect(page.locator(BAR), 'a resident session must draw the bar this reading is about')
      .toBeVisible({ timeout: 30_000 });
    const residentReading = await readGeometry(page);
    printReading('resident', residentReading);

    expect(
      residentReading.barExists,
      'a reading that found no bar would satisfy "no overlap" without saying anything',
    ).toBe(true);
    expect(
      residentReading.count,
      `exactly one assistant row must be the subject; the rows read were ${JSON.stringify(residentReading.rows)}`,
    ).toBe(1);
    expect(
      residentReading.msg,
      'the message row the bar is measured against must have been drawn',
    ).not.toBeNull();

    const barBox = residentReading.bar as Box;
    const msgBox = residentReading.msg as Box;
    // The precondition of the whole reading: the row the bar is measured against is one the pane drew,
    // not one scrolled past its top edge (where its raw box would reach up behind the bar).
    expect(
      residentReading.msgInPane,
      `the message row has to lie inside the transcript's own box, or "the bar does not overlap it" `
        + `would be said of a rect the pane clips; msg.box=${formatBox(msgBox)} `
        + `pane.box=${formatBox(residentReading.pane)}`,
    ).toBe(true);
    // Load-bearing: this is the reading the fake form has to falsify, and the one the origin screenshot fails.
    expect(
      residentReading.intersect,
      `the status bar must not overlap the message; intersect=${residentReading.intersect} `
        + `bar.box=${formatBox(barBox)} msg.box=${formatBox(msgBox)}`,
    ).toBe(false);
    expect(
      residentReading.msgVisible,
      `the message must be entirely inside the viewport; msg.box=${formatBox(msgBox)} `
        + `viewport=${residentReading.viewport.width}x${residentReading.viewport.height}`,
    ).toBe(true);
    // The same relation asked of the rows rather than of the scroll container: a bar drawn inside the
    // pane comes to rest over rows the message reading above does not happen to select (the top of the
    // transcript, where the retired sticky bar sat), so every outermost row is asked, not just the last
    // assistant one. This replaced the pane-box reading — the consolidated dock hangs over the pane's
    // bottom edge by design, so "the bar is outside the pane's box" is not a world this product has.
    expect(
      residentReading.barOverRows,
      `the status bar must not be drawn over any row of the transcript; `
        + `bar.box=${formatBox(barBox)} overlapped=${JSON.stringify(describeRows(residentReading.barOverRows))} `
        + `pane.box=${formatBox(residentReading.pane)} rows=${JSON.stringify(describeRows(residentReading.rows))}`,
    ).toEqual([]);

    // ── AC3: the per-run control — no bar at all, same reading ─────────────────────────────────
    //
    // The absence is read after a settle, and it is not a race: the resident leg above already proved the
    // snapshot arrived, and the listing that snapshot came from carries *both* sessions — so the very
    // answer that drew the bar on the resident arm also carried this arm's row, and read it `per-run`.
    // A bar that rendered on this session would therefore have rendered before the wait below began.
    await openSession(page, perRunId);
    await page.waitForTimeout(CONTROL_SETTLE_MS);
    const perRunBarCount = await page.locator(BAR).count();
    console.log(`per-run.bar.exists=${perRunBarCount > 0}`);
    expect(
      perRunBarCount,
      'an ordinary session must draw no status bar — without this leg the reading above could be '
        + 'satisfied by a bar that never renders anywhere',
    ).toBe(0);

    const perRunReading = await readGeometry(page);
    printReading('per-run', perRunReading);
    expect(
      perRunReading.count,
      `the control leg has to read the same message; the rows read were ${JSON.stringify(perRunReading.rows)}`,
    ).toBe(1);
    expect(
      perRunReading.msgInPane,
      `the control leg has to read a row the pane drew; msg.box=${formatBox(perRunReading.msg)} `
        + `pane.box=${formatBox(perRunReading.pane)}`,
    ).toBe(true);
    expect(
      perRunReading.msgVisible,
      `the message must be visible on the control leg too; msg.box=${formatBox(perRunReading.msg)}`,
    ).toBe(true);
    expect(
      perRunReading.barOverPane,
      'the control leg has no bar, so nothing can be drawn inside the pane',
    ).toBe(false);
  } finally {
    await context.close();
    await api.dispose();
  }

  const elapsed = Date.now() - RUN_STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000);
});

/**
 * The resident pill: where it sits, what it costs, and that opening it moves nothing.
 *
 * The arrow on the activity dock opened the process's facts inside the message flow. On a phone that grew
 * the transcript instead of floating over it (measured at 390x844: the panel's lower ~140px landed past the
 * bottom of the scroll area, only an edge showing) and it kept a dock on screen between turns for no reason
 * but to carry the arrow. The pill is in the header, outside the transcript, and its panel is a portal.
 *
 * Read at three form factors because the three are three different layouts of the same header — a phone held
 * upright, a phone held sideways (the 330px-tall viewport the whole height tier exists for, where a header
 * that grew by one line would cost the transcript a twentieth of the screen), and a desktop — and a pill that
 * fits one can break another. Each reading is a pair against the per-run session at the same viewport, so
 * "the header did not grow" is a comparison with the same header lacking only the pill, and "the pill is
 * absent" is read on a session that must not have one.
 */
const BADGE_FORM_FACTORS = [
  { name: 'phone portrait', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'phone landscape', viewport: { width: 844, height: 330 }, touch: true },
  { name: 'desktop', viewport: { width: 1440, height: 900 }, touch: false },
] as const;

const BADGE = '[data-resident-badge]';
const BADGE_PANEL = '[data-resident-badge-panel]';

/** What the pill case reads off a page in one evaluate, so the numbers describe one instant. */
const readBadgePage = (page: Page) =>
  page.evaluate(
    (selectors: { pane: string; row: string; badge: string; panel: string; header: string }) => {
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, x2: r.right, y2: r.bottom };
      };
      const pane = document.querySelector(selectors.pane) as HTMLElement | null;
      const rows = pane
        ? Array.from(pane.querySelectorAll(selectors.row)).filter((row) => !row.parentElement?.closest(selectors.row))
        : [];
      const lastRow = rows.length ? rows[rows.length - 1] : null;
      const badge = document.querySelector(selectors.badge) as HTMLElement | null;
      const panel = document.querySelector(selectors.panel) as HTMLElement | null;
      const header = document.querySelector(selectors.header);
      const close = panel?.querySelector('[data-resident-close]') ?? null;
      const closeBox = box(close);
      const hit = closeBox
        ? document.elementFromPoint(closeBox.x + closeBox.w / 2, closeBox.y + closeBox.h / 2)
        : null;
      const badgeBox = box(badge);
      // The invisible hit area extends up and to the left of the painted pill (see the component). A point
      // inside that extension, outside the painted box, must still land on the button.
      const extensionHit = badgeBox
        ? document.elementFromPoint(badgeBox.x + 4, badgeBox.y - 7.5)
        : null;
      const nameLine = badge?.previousElementSibling ?? null;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        header: box(header),
        badge: badgeBox,
        badgeFont: badge ? getComputedStyle(badge).fontSize : null,
        nameFont: nameLine ? getComputedStyle(nameLine).fontSize : null,
        extensionHitsBadge: Boolean(extensionHit && badge && badge.contains(extensionHit)),
        dockCount: document.querySelectorAll('[data-activity-dock]').length,
        paneScrollTop: pane ? pane.scrollTop : null,
        lastRowTop: lastRow ? lastRow.getBoundingClientRect().top : null,
        composerTop: box(document.querySelector('form[data-slot="prompt-input"]'))?.y ?? null,
        panel: box(panel),
        closeIsHit: Boolean(close && hit && close.contains(hit)),
        // A scrollable overflow of the title block would be the pill's pseudo-element leaking past it.
        titleScrollable: (() => {
          const block = badge?.closest('.overflow-x-auto') as HTMLElement | null;
          return block ? block.scrollHeight > block.clientHeight + 1 || block.scrollWidth > block.clientWidth + 1 : null;
        })(),
      };
    },
    { pane: PANE, row: ROW, badge: BADGE, panel: BADGE_PANEL, header: 'header' },
  );

test('the resident pill sits in the header, costs it no height, and its panel floats over the page', async ({ browser }) => {
  test.setTimeout(150_000);
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection');
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error('playwright.config.ts must give this project a baseURL');
  }

  const workspace = path.join(fixtureHome, WORKSPACE_DIR);
  const bootstrap = await request.newContext({ baseURL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  const residentId = await armScenario(api, workspace, scenarioFor(`${TITLE_RESIDENT} (pill)`, 'resident'));
  const perRunId = await armScenario(api, workspace, scenarioFor(`${TITLE_PER_RUN} (pill)`, 'per-run'));
  await walkClock(api, residentId);
  await walkClock(api, perRunId);
  expect(await readLifecycleMode(api, residentId), 'the pill arm has to be stored resident').toBe('resident');
  expect(await readLifecycleMode(api, perRunId), 'the control arm has to be stored per-run').toBe('per-run');

  try {
    for (const form of BADGE_FORM_FACTORS) {
      const { context, page } = await openPage(browser, baseURL, token, { viewport: form.viewport, touch: form.touch });
      try {
        const label = `${form.name} ${form.viewport.width}x${form.viewport.height}`;

        // The control first: the same header, the same viewport, a session that must have no pill.
        await openSession(page, perRunId, form.viewport);
        await page.waitForTimeout(CONTROL_SETTLE_MS);
        const control = await readBadgePage(page);
        console.log(`pill.${form.name}.control header.h=${control.header?.h} badges=${await page.locator(BADGE).count()}`);
        expect(await page.locator(BADGE).count(), `${label}: a per-run session must draw no pill`).toBe(0);

        // The resident session: the pill is drawn, and no dock is (no turn is running).
        await openSession(page, residentId, form.viewport);
        await expect(page.locator(BADGE), `${label}: a resident session must draw the pill`).toBeVisible({ timeout: 30_000 });
        const closed = await readBadgePage(page);
        console.log(
          `pill.${form.name}.closed header.h=${closed.header?.h} badge=${JSON.stringify(closed.badge)} `
          + `font=${closed.badgeFont}/${closed.nameFont} docks=${closed.dockCount}`,
        );

        expect(closed.dockCount, `${label}: with no turn there is no dock, resident or not`).toBe(0);
        expect(
          closed.header?.h,
          `${label}: the pill must cost the header no height — resident ${closed.header?.h}px vs control ${control.header?.h}px`,
        ).toBeCloseTo(control.header?.h ?? -1, 0);
        expect(closed.badgeFont, `${label}: the pill is the same font size as the project name beside it`).toBe(closed.nameFont);
        expect(
          Boolean(closed.badge && closed.header && closed.badge.y2 <= closed.header.y2 + 0.5),
          `${label}: the pill lies inside the header`,
        ).toBe(true);
        expect(closed.extensionHitsBadge, `${label}: the invisible hit area must extend above the painted pill (WCAG 2.5.8)`).toBe(true);
        expect(closed.titleScrollable, `${label}: the pill must not make the title block scrollable`).toBe(false);

        // Open it. Nothing the page showed may move: not the transcript's scroll offset, not its last row,
        // not the composer. This is the reading the dock's arrow failed.
        await page.locator(BADGE).click();
        await expect(page.locator(BADGE_PANEL), `${label}: the pill must open its panel`).toBeVisible({ timeout: 10_000 });
        const open = await readBadgePage(page);
        console.log(
          `pill.${form.name}.open panel=${JSON.stringify(open.panel)} scrollTop ${closed.paneScrollTop}->${open.paneScrollTop} `
          + `lastRow ${closed.lastRowTop}->${open.lastRowTop} composer ${closed.composerTop}->${open.composerTop}`,
        );

        expect(open.paneScrollTop, `${label}: opening the panel must not scroll the transcript`).toBe(closed.paneScrollTop);
        expect(open.lastRowTop, `${label}: opening the panel must not move the transcript's last row`).toBe(closed.lastRowTop);
        expect(open.composerTop, `${label}: opening the panel must not move the composer`).toBe(closed.composerTop);
        expect(open.header?.h, `${label}: opening the panel must not change the header`).toBe(closed.header?.h);

        const panelBox = open.panel;
        expect(panelBox, `${label}: the panel must have a box`).not.toBeNull();
        if (panelBox && open.badge) {
          expect(panelBox.y, `${label}: the panel is anchored under the pill`).toBeGreaterThanOrEqual(open.badge.y2);
          expect(panelBox.x, `${label}: the panel stays inside the left edge`).toBeGreaterThanOrEqual(0);
          expect(panelBox.x2, `${label}: the panel stays inside the right edge`).toBeLessThanOrEqual(form.viewport.width);
          expect(panelBox.y2, `${label}: the panel is entirely above the bottom of the viewport`).toBeLessThanOrEqual(form.viewport.height);
        }
        expect(open.closeIsHit, `${label}: the Close control must be what a pointer at its centre lands on`).toBe(true);

        // It dismisses the ways a popover must, and focus goes back to where it came from.
        await page.keyboard.press('Escape');
        await expect(page.locator(BADGE_PANEL), `${label}: Escape closes the panel`).toHaveCount(0);
        await expect(page.locator(BADGE), `${label}: focus returns to the pill`).toBeFocused();

        await page.locator(BADGE).click();
        await expect(page.locator(BADGE_PANEL)).toBeVisible({ timeout: 10_000 });
        // The point is the bottom edge of the viewport, not its centre: at 844x330 the panel is 288px wide
        // and reaches below the middle of the screen, so a click at the centre lands *inside* it and
        // correctly leaves it open — the first draft of this reading failed there for that reason.
        await page.mouse.click(form.viewport.width / 2, form.viewport.height - 3);
        await expect(page.locator(BADGE_PANEL), `${label}: a press elsewhere closes the panel`).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  } finally {
    await api.dispose();
  }
});


/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * AC-177 — the resident status bar's popover must be reachable on a narrow viewport.
 *
 * Two criteria share this file. The half above belongs to AC-179 (the bar must not cover the
 * transcript); everything below belongs to AC-177 (the popover's Close must be reachable at 780x493
 * and must really close the process). They read the same surface from opposite ends: AC-179 asks
 * that the bar stay out of the conversation's way, AC-177 asks that the bar's own popover still be
 * usable once the bar has moved. Each criterion selects its own test with `-g`.
 *
 * What this half is *for*. The bar and its popover live inside `.chat-messages-pane`, which is a
 * scroll container (`overflow-y-auto overflow-x-hidden`), and the composer sits under the pane as a
 * later flex sibling. When the composer grows tall — the resident disclosure alone is several
 * paragraphs — the pane shrinks, the popover (which opens downward from the bar) reaches past the
 * pane's bottom edge, and whatever is below it intercepts the pointer. The report this criterion
 * comes from was Playwright's own: the disclosure's `resident.notice.bypass` paragraph took the
 * click that was aimed at the popover's Close.
 *
 * After AC-178 the interceptor above cannot be on this page: a session that is already resident no
 * longer renders the switch or the consent notice, and this criterion's session is resident. The
 * criterion is unchanged in what it asks (the Close button's centre must hit the button, at both
 * viewports, and a real click must close the host); what changed is how its reading proves it can
 * say no. The consent notice used to be the falsifier by construction, so the test now injects an
 * element over the Close button and requires the same `elementFromPoint` reading to go red, naming
 * it, and to recover once it is removed. The clipping mechanism (`panelInPane`) is asserted as before.
 *
 * What this no longer proves, stated plainly: it cannot tell the popover as it was before the AC-177
 * fix from the fixed one. Measured — with the pre-fix component and a composer squeezed by hand until
 * the pane ended above the Close button, this reading still hit the button, because AC-179 had
 * already moved the bar out of the scroll box and the notice was the only thing that ever stacked
 * over the popover. What it does prove is that the button is reachable at both viewports, that a
 * real click closes the host, and that the hit reading itself would go red if anything covered it.
 *
 * Where the reading is anchored now, and why that is all that moved. `ad1bb63a` consolidated the
 * resident status bar into the activity dock and re-pointed two specs; this one was left addressing
 * markers that no longer exist, so its first positive wait timed out and nothing was ever measured.
 * The product guarantee is untouched — the same `ResidentPanel` still publishes Start / Address /
 * Copy / Close, and the close still goes through the same host-manager route — so the repair is on
 * the instrument: the dock root and its toggle for the surfaces, the panel's own root for the popover
 * anchor, an expanded-panel-first ordering (the controls are inside the panel now), and the Start
 * control's disappearance for the readiness signal the retired state attribute used to give.
 *
 * Why a reading and not an assertion about classes. "Clipped by the scroll container" and "painted
 * under the composer" are two different defects with two different fixes, and CSS `z-index` alone
 * cannot tell them apart. So the first thing this half does is *measure*: the close button's box,
 * the popover's box, the pane's box, the composer's box, and — the load-bearing one — what
 * `document.elementFromPoint` returns at the close button's own centre. `hit.isClose` is that
 * reading. Everything else is printed beside it so a red says which of the two mechanisms was real.
 *
 * Why the debug agent, and why no `claude` binary. The alternative is a real process, and a
 * criterion that needs one cannot run where the binary is absent. `POST /api/debug-agent/scenarios`
 * arms a session and `POST /api/debug-agent/clock` walks a scenario: the same product chain
 * (provider runtime → host manager → run registry → the normalizer) with the child replaced by a
 * scripted clock. The popover's own subject — a live host with an address — arrives through the
 * scenario's `identity` step, so the close below is closing a process the product really owns.
 *
 * Why the close is the last act, and why the clock is awaited before it. A walk cut off mid-flight
 * answers `DEBUG_AGENT_RUN_READING_MISSING` — a red about this file's ordering rather than about the
 * product. The walk here is one second long (`identity`, then a `wait`), so it is awaited before the
 * popover is read; a resident host is meant to sit idle between turns, so it is still live when the
 * Close is finally clicked.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The control that opens the resident panel, and the surface that panel is drawn in.
 *
 * `ad1bb63a` merged the resident status bar into the activity dock, and the dock's arrow then opened the
 * panel inside the message flow. The arrow is gone: the control is the resident pill in the workspace
 * header, `[data-resident-badge]` (rendered only for a session whose own host snapshot reads `resident`,
 * which is exactly the resident-only gate the old bar had), and the panel is a portal to `body` anchored
 * under it, whose own root is still `ResidentPanel`'s `[data-resident-panel="true"]`. This is a
 * re-anchoring of the reading, not a change to what it measures: the Start / Address / Close controls
 * the criterion clicks are the same ones, published by the same component.
 */
const TRIGGER = '[data-resident-badge]';
const PANEL = '[data-resident-panel="true"]';
const START = '[data-resident-start]';
const ADDRESS = '[data-resident-address]';
const CLOSE = '[data-resident-close]';

/** The two viewports the criterion names: the failing narrow one and its positive control. */
const NARROW = { width: 780, height: 493 };
const WIDE = { width: 1440, height: 900 };

/** The armed session, the sentence its seeded turn carries, and the address the walk reports. */
const TITLE = 'Resident ui layout — close reachability';
const CLOSE_SEED_USER_TEXT = 'seeded user turn for the resident ui layout criterion';
const PEER_NAME = 'peer-resident-ui-layout';

/**
 * The scenario: one identity step so the popover has an address to draw, then a short wait.
 *
 * 一 second rather than the sibling criteria's five: nothing here is read *during* the walk — the
 * popover is read after it settles — and the whole invocation has to fit under the 55 s ceiling.
 */
const SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE, userText: CLOSE_SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: PEER_NAME },
    { at: 1_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [CLOSE_SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// The wire, read by this file rather than through the page.
// ---------------------------------------------------------------------------------------------

type HostBinding = { appSessionId: string; peerName?: string | null };
type HostRecord = {
  hostId: string;
  state: string;
  closeReason: string | null;
  bindings: HostBinding[];
};
type SessionRecord = { appSessionId: string; lifecycleMode: string };
type HostsSnapshot = { hosts: HostRecord[]; sessions: SessionRecord[] };

/** The live host holding one session, or null. Closed hosts are skipped, as the frontend skips them. */
function liveHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  for (const host of snapshot.hosts) {
    if (host.state === 'closed') continue;
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) return host;
  }
  return null;
}

/** The host that most recently served one session, closed or not — the frontend's `findSessionHost`. */
function lastHost(snapshot: HostsSnapshot, sessionId: string): HostRecord | null {
  let found: HostRecord | null = null;
  for (const host of snapshot.hosts) {
    if (host.bindings.some((binding) => binding.appSessionId === sessionId)) found = host;
  }
  return found;
}

/** `GET /api/session-hosts`, as this file reads it. */
async function readHosts(api: APIRequestContext): Promise<HostsSnapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return { hosts: body?.data?.hosts ?? [], sessions: body?.data?.sessions ?? [] };
}

// ---------------------------------------------------------------------------------------------
// The page-side reading.
// ---------------------------------------------------------------------------------------------

/**
 * One geometry reading, taken in a single `page.evaluate` so every number describes one moment.
 *
 * `describe` is deliberately coarse: the question it answers is "which element took the pointer",
 * and a reader needs the tag, the nearest `data-*` attribute that names the surface, and — for the
 * composer's disclosure — the slot name. Not the whole `outerHTML`, which for the composer is
 * thousands of characters and pushes the real reading off the end of a log line.
 */
type Projection = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
type Reading = {
  viewport: string;
  closeBox: Projection | null;
  popoverBox: Projection | null;
  paneBox: Projection | null;
  composerBox: Projection | null;
  noticeBox: Projection | null;
  noticePresent: boolean;
  hit: string;
  isClose: boolean;
  hitInNotice: boolean;
  hitInComposer: boolean;
  /**
   * Whether the panel is still a DOM descendant of the scroll container.
   *
   * This is the *mechanism* reading: while it is true the pane's `overflow` clips the panel, so the
   * part of it below the pane's bottom edge is painted by whatever is under the pane — which is what
   * the report saw. False means the panel left the clipping box, which is the fix.
   */
  panelInPane: boolean;
  /**
   * Whether the panel's box still reaches below the pane's bottom edge.
   *
   * Kept beside {@link panelInPane} because the two readings disagree by design after the fix: the
   * panel is anchored under the bar, so on a short viewport it *does* overlap the composer — it just
   * paints above it now instead of being cut off. A reader seeing only this one would think the
   * defect was still there.
   */
  overlapsPaneEdge: boolean;
};

function measure(page: Page): Promise<Reading> {
  return page.evaluate(() => {
    const rect = (el: Element | null): Projection | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const describe = (el: Element | null): string => {
      if (!el) return 'null';
      const parts: string[] = [el.tagName.toLowerCase()];
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.startsWith('data-')) parts.push(`${attr.name}=${JSON.stringify(attr.value)}`);
      }
      const aria = el.getAttribute('aria-label');
      if (aria) parts.push(`aria-label=${JSON.stringify(aria)}`);
      return parts.join(' ');
    };

    const close = document.querySelector('[data-resident-close]');
    // The panel's root is `[data-resident-panel="true"]`. It is rendered inside the pill's portal
    // (`[data-resident-badge-panel]`, a `role="dialog"` wrapper on `body`), so it is found by its own root.
    const popover = close?.closest('[data-resident-panel="true"]') ?? null;
    const pane = document.querySelector('.chat-messages-pane');
    // The composer's own input form, not the whole `.chat-composer-shell`.
    //
    // This is the reading's discrimination, so it has to name the surface that can actually take the
    // pointer away from the Close button. After the consolidation the dock *is* drawn inside
    // `.chat-composer-shell` (the shell is the root at ChatComposer, and the dock is an
    // `absolute bottom-full` layer within it), so asking whether the hit landed anywhere in the shell
    // answers "yes" by construction — a red that could never be green. The form (`PromptInput`'s
    // `<form>`) is the input area proper: if it ever stacked over the Close button the hit would land
    // on a descendant of it, which is the defect this leg is here to catch.
    const composer = document.querySelector('.chat-composer-shell form');
    const notice = document.querySelector('[data-slot="resident-consent-notice"]');
    const closeBox = rect(close);
    const hitEl = closeBox
      ? document.elementFromPoint(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2)
      : null;
    const popoverBox = rect(popover);
    const paneBox = rect(pane);
    const contains = (outer: Element | null, inner: Element | null): boolean =>
      !!(outer && inner && (outer === inner || outer.contains(inner)));

    return {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      closeBox,
      popoverBox,
      paneBox,
      composerBox: rect(composer),
      noticeBox: rect(notice),
      noticePresent: notice !== null,
      hit: describe(hitEl),
      isClose: contains(close, hitEl),
      hitInNotice: contains(notice, hitEl),
      hitInComposer: contains(composer, hitEl),
      panelInPane: contains(pane, popover),
      overlapsPaneEdge: !!(popoverBox && paneBox && popoverBox.bottom > paneBox.bottom),
    } satisfies Reading;
  });
}

/**
 * The project row's toggle, whose accessible name starts with the workspace's directory name.
 *
 * The sidebar's own control, clicked rather than bypassed: a session row only exists once its
 * project is expanded.
 */
const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator => page.locator(`a[href="/session/${sessionId}"]`).first();

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`the sidebar never showed a row for session ${sessionId}; the page held:\n${body.slice(0, 2_000)}`);
}

test.describe('resident ui layout', () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let sessionId = '';

  test.beforeAll(async ({ browser }) => {
    const clientUrl = test.info().project.use.baseURL;
    if (!clientUrl) throw new Error('playwright.config.ts must give this project a baseURL');
    const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
    if (!fixtureHome) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for the debug agent selection');
    }
    if (!process.env.QUAY_E2E_RUN_STARTED_AT) {
      throw new Error('playwright.config.ts must publish QUAY_E2E_RUN_STARTED_AT for the elapsed reading');
    }

    // The workspace has to sit inside the fixture home: the control plane writes only under
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it.
    workspace = `${fixtureHome}/resident-ui-layout-workspace`;
    workspaceName = workspace.split('/').pop() as string;

    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    sessionId = await armScenario(api, workspace, SCENARIO);

    // Before any page of this run exists, so this run's optimize/re-optimize is over before the guard's first
    // navigation — see the helper for why the cost cannot be left inside the measurement window.
    await warmClientStartupOnce(clientUrl);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: 'auth-token', value: token },
    );
    page = await context.newPage();
    attachStartupEvidence(page);

    // The one navigation this describe makes is the guard's — it lands on the fixture project row or it ends
    // the run with the page's own text and this run's failed-request list. `revealSession` below then expands
    // the row.
    await navigateBounded(
      page,
      '/',
      { label: () => `the project row for ${workspaceName}`, present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs) },
      'first-load',
    );
    await revealSession(page, workspaceName, sessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  test('the popover close is reachable at a narrow viewport and closes the process', async () => {
    // The resident surface this criterion reads. The status bar that used to draw it was merged into
    // the activity dock (`ad1bb63a`) and its facts then moved to the resident pill in the header, so the
    // pill is what has to be on screen before anything below is measured.
    const BAR = '[data-resident-badge]';

    // The failing viewport, set before the session is opened so the transcript, the composer and
    // the dock are all laid out at it — the state the report was taken in.
    await page.setViewportSize(NARROW);
    await revealSession(page, workspaceName, sessionId);
    await sessionRow(page, sessionId).click();
    await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });

    // No composer switch and no disclosure here, on purpose. This session is already resident, and
    // AC-178 keeps the switch and the consent notice off a resident session's composer — the notice
    // that used to take this pointer can no longer be on this page. The reading below therefore asks
    // the question that outlives that fix: whatever is over the Close button's centre, is it the
    // button. The control after the narrow reading (an element injected over the popover) is what
    // proves the reading can still say no.

    // The panel first, the controls inside it second. The resident controls are the pill's panel, so
    // there is no Start to click until it is open. Its open state is component state, not a derived
    // value, so clicking Start and walking the clock below do not close it again.
    await page.locator(TRIGGER).click();
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 10_000 });

    // Start the process through the panel's own control, so the host this criterion closes is one the
    // product opened rather than one this file wrote.
    await page.locator(START).click();
    // The readiness signal, replacing the state attribute the retired status bar used to publish: the
    // Start control is drawn only while this session has no live host, so its disappearance is the
    // same "the process is up" fact that attribute carried. A bounded wait on the DOM, never a
    // `waitForTimeout` — a sleep here would turn the race it is meant to close back into a race.
    await expect(page.locator(START)).toHaveCount(0, { timeout: 15_000 });

    // The walk, awaited before the panel is read: `identity` runs at its own zero, and the one
    // second that follows is short enough to sit inside the budget.
    const clock = await api.post('/api/debug-agent/clock', { data: { sessionId } });
    expect(clock.ok(), `the scenario walk must complete: ${clock.status()}`).toBe(true);

    await expect(page.locator(ADDRESS)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(ADDRESS)).not.toBeEmpty({ timeout: 10_000 });
    const address = (await page.locator(ADDRESS).innerText()).trim();
    const snapshotAtAddress = await readHosts(api);
    const peerName = liveHost(snapshotAtAddress, sessionId)?.bindings
      .find((binding) => binding.appSessionId === sessionId)?.peerName ?? null;
    console.log(`popover.address=${JSON.stringify(address)} snapshot.peerName=${JSON.stringify(peerName)}`);
    expect(address, 'the popover must show the address the listing publishes').toBe(peerName);

    // --- the narrow reading (AC2) ---------------------------------------------------------------
    const narrow = await measure(page);
    console.log(
      `viewport=${narrow.viewport} hit.element=${narrow.hit} hit.isClose=${String(narrow.isClose)} `
      + `close.box=${JSON.stringify(narrow.closeBox)}`,
    );
    console.log(
      `popover.box=${JSON.stringify(narrow.popoverBox)} pane.box=${JSON.stringify(narrow.paneBox)} `
      + `composer.box=${JSON.stringify(narrow.composerBox)} notice.box=${JSON.stringify(narrow.noticeBox)} `
      + `notice.present=${String(narrow.noticePresent)} panel.inPane=${String(narrow.panelInPane)} `
      + `popover.overlapsPaneEdge=${String(narrow.overlapsPaneEdge)}`,
    );
    console.log(
      `hit.inNotice=${String(narrow.hitInNotice)} hit.inComposer=${String(narrow.hitInComposer)}`,
    );

    expect(narrow.closeBox, 'the popover must be open before it can be measured').not.toBeNull();
    expect(
      narrow.isClose,
      `elementFromPoint at the close button's centre returned ${narrow.hit} — `
      + `panel.inPane=${String(narrow.panelInPane)} `
      + `popover.bottom=${narrow.popoverBox?.bottom ?? 'null'} pane.bottom=${narrow.paneBox?.bottom ?? 'null'}`,
    ).toBe(true);
    // The panel must have left the scroll container: with it inside, the clip above is what makes
    // the button unreachable, and a run where this is true could only be green by luck of geometry.
    expect(narrow.panelInPane, 'the panel must not be clipped by the transcript scroll container').toBe(false);
    // Nothing inside the composer may take the pointer at the close button. (The consent notice is
    // absent on a resident session — AC-178 — so it is part of this composer check, not its own.)
    expect(narrow.noticePresent, 'AC-178: a resident session carries no consent notice').toBe(false);
    expect(narrow.hitInComposer, 'nothing in the composer may take the pointer at the close button').toBe(false);

    // --- the falsifying control ------------------------------------------------------------------
    // The reading above is only evidence if it can say no. The product state that used to make it say
    // no (the consent notice stacked over the popover) no longer exists, so the interceptor is put
    // there by hand: a fixed element above everything, centred on the Close button. The same
    // `measure` must now report that the pointer does NOT reach the button, and name the injected
    // element; once it is removed the reading must hit the button again. Without this leg a run where
    // `elementFromPoint` had been replaced by something that always answers "the button" would pass.
    await page.evaluate(() => {
      const close = document.querySelector('[data-resident-close]');
      if (!close) throw new Error('the falsifying control needs the close button on the page');
      const box = close.getBoundingClientRect();
      const cover = document.createElement('div');
      cover.setAttribute('data-e2e-falsifier', 'cover');
      cover.style.cssText =
        `position:fixed;z-index:2147483647;left:${box.left - 8}px;top:${box.top - 8}px;`
        + `width:${box.width + 16}px;height:${box.height + 16}px;background:transparent;`;
      document.body.appendChild(cover);
    });
    const covered = await measure(page);
    console.log(`falsifier.hit.element=${covered.hit} falsifier.hit.isClose=${String(covered.isClose)}`);
    expect(covered.isClose, 'an element stacked over the Close button must turn the reading red').toBe(false);
    expect(covered.hit, 'the red must land on the hit reading and name what took the pointer').toContain(
      'data-e2e-falsifier="cover"',
    );
    await page.evaluate(() => {
      document.querySelector('[data-e2e-falsifier="cover"]')?.remove();
    });
    const uncovered = await measure(page);
    console.log(`uncovered.isClose=${String(uncovered.isClose)}`);
    expect(uncovered.isClose, 'with the injected element removed the reading must hit the button again').toBe(true);

    // --- the positive control viewport (AC4) ----------------------------------------------------
    await page.setViewportSize(WIDE);
    await expect(page.locator(CLOSE)).toBeVisible({ timeout: 10_000 });
    const wide = await measure(page);
    console.log(
      `viewport=${wide.viewport} hit.element=${wide.hit} hit.isClose=${String(wide.isClose)} `
      + `close.box=${JSON.stringify(wide.closeBox)} panel.inPane=${String(wide.panelInPane)}`,
    );
    expect(
      wide.isClose,
      `the same reading on a wide viewport must also hit: elementFromPoint returned ${wide.hit}`,
    ).toBe(true);

    // --- the real click and the host read-back (AC3) --------------------------------------------
    // The positive control for the close below: the same host must exist *before* it is closed, or
    // "the host went away" would also be satisfied by one that was never there.
    const beforeClose = await readHosts(api);
    const hostBeforeClose = liveHost(beforeClose, sessionId);
    console.log(`host.present=${String(hostBeforeClose !== null)} host.id=${hostBeforeClose?.hostId ?? '(none)'}`);
    expect(hostBeforeClose, 'the popover was opened over a process, so a live host must exist').not.toBeNull();

    const [closeResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(`/api/session-hosts/${sessionId}/close`)),
      page.locator(CLOSE).click(),
    ]);
    const afterClose = await readHosts(api);
    const record = lastHost(afterClose, sessionId);
    console.log(
      `close.request=${closeResponse.status()} host.state.after=${record?.state ?? 'absent'} `
      + `closeReason.after=${record?.closeReason ?? '(none)'} `
      + `liveHost.after=${liveHost(afterClose, sessionId) ? 'present' : 'absent'}`,
    );
    expect(closeResponse.status(), 'closing a live host is accepted').toBeLessThan(300);
    expect(record?.state, 'the closed host must be recorded as closed').toBe('closed');
    expect(record?.closeReason, 'the record must say the user is why it closed').toBe('user');
    expect(liveHost(afterClose, sessionId), 'the host must stop being a live host for its session').toBeNull();

    // --- the ceiling (AC1) ----------------------------------------------------------------------
    // Read from the run's own start, published by `playwright.config.ts`: the ceiling binds the whole
    // `npx playwright test` invocation, and a spec can only see itself.
    const elapsed = Date.now() - Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config\'s own start').toBeLessThan(55_000);
  });
});
/* ── the composer no longer carries a resident affordance ─────────────────────────────────────── */

/**
 * The reading this criterion is named for: the composer draws no resident switch, for either mode.
 *
 * The affordance moved off the composer entirely — it lives only on the new-session empty state's
 * model card — so a session that already exists (stored `resident` or `per-run`) must draw no switch
 * inside `.chat-composer-shell`. The reading is an absence, and an absence is only evidence when the
 * same selector, in the same run, finds the switch where it does live: the empty state's model card.
 * So this leg arms both existing sessions and, in the same run, opens the new-session screen and reads
 * the same selector there.
 *
 * Why the marker rather than the accessible name. The switch's `aria-label` is the `resident.toggle`
 * i18n key, which a duplicate top-level `resident` key in the shipped locale files currently shadows
 * to `undefined` (the subject of a separate task). A locator keyed on the *name* would then match on
 * no name at all and collide with the page's dark-mode switch. So every reading here is structural —
 * `[data-resident-enable="true"]`, the marker `ResidentToggle` publishes.
 *
 * Why the resident pill is awaited before the resident count. `isResidentSession` is false until the
 * host snapshot has loaded, so a count taken on arrival could read "no switch" for the wrong reason —
 * a page that simply had not fetched yet. The pill renders only for a session whose snapshot reads
 * `lifecycleMode === 'resident'` through the very same `findSessionHostState`, so waiting for it is the
 * positive signal that the page knows what this session is. The control that the selector is not
 * merely always empty is the empty-state arm below, which is the only place the switch is drawn now.
 *
 * The scenario is stored and never clocked: this criterion reads the affordance the *stored mode*
 * decides, not a running process. The step exists because the loader refuses an empty `steps` array,
 * and `at: 0` is the earliest a document may place one.
 */

/** The composer's own root class, which scopes the existing-session counts to the input area. */
const COMPOSER_SHELL = '.chat-composer-shell';
/** The switch's structural marker, published by `ResidentToggle`. */
const COMPOSER_ENABLE = '[data-resident-enable="true"]';

const COMPOSER_TITLE_RESIDENT = 'Resident ui layout — the already-resident session';
const COMPOSER_TITLE_PER_RUN = 'Resident ui layout — the per-run control';

/** One arm of the composer pair: the same seeded session, stored under one lifecycle mode. */
const composerScenarioFor = (title: string, lifecycleMode: 'resident' | 'per-run') => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode },
  steps: [{ at: 0, op: 'wait' }],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
});

test('composer has no resident switch', async ({ browser }) => {
  const fixtureHome = process.env.QUAY_E2E_DEBUG_AGENT_HOME;
  if (!fixtureHome) {
    throw new Error('playwright.config.ts must publish QUAY_E2E_DEBUG_AGENT_HOME for this selection');
  }
  const baseURL = test.info().project.use.baseURL;
  if (!baseURL) {
    throw new Error('playwright.config.ts must give this project a baseURL');
  }

  // The workspace sits inside the fixture home: the control plane writes only under `DEBUG_AGENT_HOME`
  // and refuses a `projectPath` outside it, and the transcripts it arms land under that home's own
  // `.claude/projects`, which no other provider's scan reads.
  const workspace = path.join(fixtureHome, WORKSPACE_DIR);

  const bootstrap = await request.newContext({ baseURL });
  const token = await createAccount(bootstrap);
  await bootstrap.dispose();
  const api = await request.newContext({
    baseURL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });

  const residentId = await armScenario(api, workspace, composerScenarioFor(COMPOSER_TITLE_RESIDENT, 'resident'));
  const perRunId = await armScenario(api, workspace, composerScenarioFor(COMPOSER_TITLE_PER_RUN, 'per-run'));

  const { context, page } = await openPage(browser, baseURL, token);

  try {
    // ── the resident existing session — no switch in the composer ──────────────────────────────────
    const residentMode = await readLifecycleMode(api, residentId);
    console.log(`resident.session=${residentId}`);
    console.log(`session.lifecycle_mode=${residentMode}`);
    expect(
      residentMode,
      'the resident arm must be stored resident, or the counts below are about the wrong session',
    ).toBe('resident');

    await navigateBounded(
      page,
      `/session/${residentId}`,
      { label: () => `the transcript pane for the resident arm (${residentId})`, present: (budgetMs) => appears(page.locator(PANE), budgetMs) },
      'first-load',
    );
    await expect(page.locator(PANE), 'the pane must open for the resident arm').toBeVisible({ timeout: 30_000 });
    // The positive signal that the page has this session's mode: the resident pill renders only for a
    // session whose host snapshot reads `resident`.
    await expect(page.locator(BAR), 'a resident session must draw the pill that proves the mode arrived')
      .toBeVisible({ timeout: 30_000 });

    const residentScoped = await page.locator(`${COMPOSER_SHELL} ${COMPOSER_ENABLE}`).count();
    const residentPageWide = await page.locator(COMPOSER_ENABLE).count();
    console.log(`resident.composer.switch.count=${residentScoped}`);
    console.log(`resident.page.switch.count=${residentPageWide}`);
    expect(
      await page.locator(COMPOSER_SHELL).isVisible(),
      'the zero below must be a rendered composer, not a blank page',
    ).toBe(true);
    expect(
      residentScoped,
      'a session that already exists draws no resident switch in its composer — the affordance lives '
        + 'only on the new-session empty state now',
    ).toBe(0);

    // ── the per-run existing session — the same reading, the same run ──────────────────────────────
    const perRunMode = await readLifecycleMode(api, perRunId);
    console.log(`per-run.session=${perRunId}`);
    console.log(`session.lifecycle_mode=${perRunMode}`);
    expect(
      perRunMode,
      'the control arm must read per-run, or it would be the resident arm read twice',
    ).toBe('per-run');

    await navigateBounded(
      page,
      `/session/${perRunId}`,
      { label: () => `the transcript pane for the control arm (${perRunId})`, present: (budgetMs) => appears(page.locator(PANE), budgetMs) },
      'first-load',
    );
    await expect(page.locator(PANE), 'the pane must open for the control arm').toBeVisible({ timeout: 30_000 });

    const perRunScoped = await page.locator(`${COMPOSER_SHELL} ${COMPOSER_ENABLE}`).count();
    const perRunPageWide = await page.locator(COMPOSER_ENABLE).count();
    console.log(`per-run.composer.switch.count=${perRunScoped}`);
    console.log(`per-run.page.switch.count=${perRunPageWide}`);
    expect(
      perRunScoped,
      'a per-run session with a transcript draws no switch either — the composer is no longer a place a '
        + 'session is converted',
    ).toBe(0);

    // ── the positive control: the same selector, the same run, finds the switch where it lives ──────
    // The project is already selected (the sessions above belong to it), so the sidebar's New Session
    // clears the open session and lands on the empty state, under whose model card the switch now sits.
    // The switch itself is what is awaited: it appears once the capability matrix has answered, and the
    // `1` here is what proves every `0` above is a reading rather than a dead selector.
    await page.getByRole('button', { name: 'New Session' }).first().click();
    await expect(
      page.locator(COMPOSER_ENABLE),
      'the new-session empty state must carry the switch — the control that makes the zeroes above a reading',
    ).toHaveCount(1, { timeout: 30_000 });
    console.log(`empty.page.switch.count=${await page.locator(COMPOSER_ENABLE).count()}`);
  } finally {
    await context.close();
    await api.dispose();
  }

  const elapsed = Date.now() - RUN_STARTED_AT;
  console.log(`elapsed=${elapsed}ms`);
  expect(elapsed, 'the criterion has to end inside the single-file ceiling').toBeLessThan(55_000);
});
