/**
 * Sending to a resident session that is already answering — where the message goes, and who decides
 * that a withdrawal happened.
 *
 * What this file is *for*. A client that is looking at a busy session has two ways to hold the next
 * message: its own queue (the one `QueuedMessageCard` draws, which the browser sends when the turn
 * ends) and the process's queue (the CLI's own, which the process drains while the answer is still
 * being written). The criterion is that a *resident* session takes the second road and a per-run one
 * keeps the first — and that the second road's states are the host's account of a command rather than
 * this client's guess about a request. So every reading below is a comparison between two things that
 * could have disagreed: the row the page draws against the uuid the host minted, the sentence on
 * screen against the shipped locale file, the withdrawal the reader sees against the `cancelled` row
 * the substitute actually wrote, and the absent card against the same client's card on a per-run
 * session in the same run.
 *
 * Why the debug agent. The alternative is a real `claude` process held mid-answer, and a criterion
 * that needs one cannot run where the binary is absent. `POST /api/debug-agent/clock` walks a
 * scenario instead: the same product chain (provider runtime → host manager → the run registry → the
 * shared normalizer → the client) with the child process replaced by a scripted clock, whose
 * `cancel-ack` and `dequeue` steps are the moments a real CLI would withdraw and start a queued
 * command. The gate that mounts that face is opened by `playwright.config.ts` for exactly this file's
 * selection, so no other run's server grows a fixture-writing endpoint.
 *
 * Three sessions, and why each one is busy. A pushed command is a push only while the process is
 * holding a turn, and the composer's own branch is chosen by "this session has a turn in flight" —
 * two different readings, both of which have to be true for a message to reach a *process's* queue.
 * Each resident arm therefore gets a session of its own, walked into 忙 by a turn the scenario opens
 * (`unattended-turn`) and then asked for exactly one command: the first one is withdrawn, the second
 * one is started. They cannot share a session, and the reason is the product's rather than this
 * file's: a command the process is handed is dispatched as a run of its own, and when that dispatch
 * settles the session stops reading as processing — while the process itself is still mid-turn. The
 * second command of a shared session would therefore be sent by a client that no longer believes the
 * session is busy, which is a different reading from the one this file is about. The per-run arm
 * needs no scenario step at all: it is made busy by an ordinary send of its own, which is the whole
 * difference between the two roads.
 *
 * Why the clock is not awaited where it is fired. `POST /clock` blocks for the whole walk — it awaits
 * each step's absolute offset from the run's start. Every reading below therefore happens *while* the
 * walk is in flight, which is the only place a busy session exists at all: after the response
 * returns, the process has been walked back to rest. The responses are awaited at the end, reduced to
 * settled values rather than left as bare promises — if an assertion fails while a walk is still in
 * flight, `afterAll` disposes the request context under it, and a promise left dangling here would
 * report *that* as this test's error instead of the real one.
 *
 * One client, because the guest and the control have to be read from the same one: `resident.queuedCard=0`
 * means nothing unless the same client draws that card for a busy session it does not own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const LOCALES_ROOT = path.join(REPO_ROOT, 'src/modules/i18n/locales');

/** The locale the page is seeded with, and the one the rendered copy is checked against. */
const LOCALE = 'en';
/** Every locale the shipped keys must be present in — the app's own set, read from disk. */
const ALL_LOCALES = fs.readdirSync(LOCALES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** The chat pane, the same anchor transcript-follow uses to know the session actually opened. */
const PANE = '.chat-messages-pane';
/** The composer's form. The submit button is inside it; the status line lives in the transcript. */
const FORM = 'form[data-slot="prompt-input"]';
const TEXTAREA = '[data-slot="prompt-input-textarea"]';
/** The activity dock, whose state attribute says the process is mid-turn. */
const BAR = '[data-activity-dock]';

/** The browser's own queue, drawn above the composer. */
const QUEUED_CARD = '[data-queued-message-card]';
/** A row the host's `command_lifecycle` events own. Empty until the host names the command. */
const COMMAND_ROW = '[data-command-uuid]';
const PENDING_BUBBLE = '[data-resident-pending-message]';
const ANNOTATION = '[data-resident-annotation]';
const WITHDRAW = '[data-resident-withdraw]';
const WITHDRAWN = '[data-resident-withdrawn]';
/** A settled turn. The row a pushed command must never become one of. */
const USER_TURN = '[data-message-style="user"]';

/** The account this run creates. Any name works; all three sessions are read under it. */
const USERNAME = 'resident-busy-send-e2e';
const PASSWORD = 'resident-busy-send-e2e-pass';

/** The three sessions' titles. */
const TITLE_WITHDRAWN = 'Resident busy send — the withdrawn command';
const TITLE_STARTED = 'Resident busy send — the started command';
const TITLE_PER_RUN = 'Resident busy send — the per-run control';
const SEED_USER_TEXT = 'seeded user turn for the resident busy-send criterion';

/** The drafts. Neither is ever run: the first is withdrawn, the second is only started. */
const DRAFT_WITHDRAWN = 'draft one — the process has not taken this yet';
const DRAFT_STARTED = 'draft two — the process takes this one';
/** The per-run arm's own two messages: the turn that makes it busy, and the one it queues. */
const PER_RUN_TURN_TEXT = 'the per-run turn that is still being written';
const DRAFT_LOCAL_QUEUE = 'draft three — this one waits for the browser';

/**
 * The turn each resident process is already writing when a command is pushed at it.
 *
 * It is what makes the session *busy*: the status bar and the composer both read "a turn is in
 * flight" off the host's lease, and a push is only a push when one is. Its text is deliberately
 * unrelated to either draft, so the "no turn was produced by the withdrawn command" reading below is
 * a count of the drafts and not of everything the process happened to run.
 */
const WALK_TURN_TEXT = 'the turn the process was already writing';

/** The annotation key a queued row draws, and the one a started row draws. */
const PENDING_ANNOTATION_KEY = 'resident.pending.annotation';
const STARTED_ANNOTATION_KEY = 'resident.pending.started';

/**
 * The withdrawn command's walk: one busy process, and the moment a real CLI would act on a
 * withdrawal.
 *
 * The offsets are absolute from the run's start, so the shape of the walk — and therefore where each
 * reading can be taken — does not depend on how long this file took to get there. `cancel-ack` is the
 * process acting on the withdrawal the browser sent, and it is a no-op when nothing is waiting: the
 * second one is a fallback for a click that landed late, and a click that landed on time leaves it
 * with nothing to do. `turn-end` is placed after both, so the process is still mid-turn for every
 * reading above it.
 *
 * `expect` is inert here — only `GET /self-check` evaluates it, and this file deliberately never
 * calls it (its subject is the browser's rows, not the transcript's arithmetic). The delta is the
 * truthful count under both timings: the unattended turn's own row and one `cancel-ack` that found
 * something to act on.
 */
const ARM_WITHDRAWN_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_WITHDRAWN, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: WALK_TURN_TEXT, trigger: 'cron' },
    { at: 12_000, op: 'cancel-ack' },
    { at: 13_500, op: 'cancel-ack' },
    { at: 15_000, op: 'turn-end' },
    { at: 15_500, op: 'wait' },
  ],
  expect: { rows: { delta: 2 }, content: { mustContain: [SEED_USER_TEXT, WALK_TURN_TEXT] } },
};

/**
 * The started command's walk: the same busy process, and the moment a real CLI takes the oldest
 * command it was holding.
 *
 * Its offsets are later than the other arm's because this session's turn is opened at the same moment
 * and is only sent to once the first arm is finished with its own. `dequeue` reads *and removes* the
 * oldest queued command, so the same fallback shape applies: the second pair has nothing to do when
 * the first found the command.
 */
const ARM_STARTED_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_STARTED, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'unattended-turn', text: WALK_TURN_TEXT, trigger: 'cron' },
    { at: 20_000, op: 'dequeue' },
    { at: 24_000, op: 'dequeue' },
    { at: 26_000, op: 'turn-end' },
    { at: 26_500, op: 'wait' },
  ],
  expect: { rows: { delta: 2 }, content: { mustContain: [SEED_USER_TEXT, WALK_TURN_TEXT] } },
};

/**
 * The per-run control: a session that is busy but not resident.
 *
 * It is armed only so the send has something to run — the walk is two waits, and the clock is never
 * fired for it. This session is made busy the way any session is: the client sends it a message, the
 * run that message opens walks this scenario, and the walk holds the run open long enough for the
 * composer to be typed into twice. Nothing about this arm is resident, which is the whole of what
 * separates it from the two arms above.
 */
const ARM_PER_RUN_SCENARIO = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_PER_RUN, userText: SEED_USER_TEXT },
  steps: [
    { at: 0, op: 'wait' },
    { at: 12_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// Locale reading. The copy a reader sees is never written down in this file: it is read from the
// shipped JSON, and the key the DOM publishes is what says *which* sentence to compare against.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Reads one shipped locale file. `null` when it, or the key path, is absent. */
function readLocaleFile(locale: string, file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCALES_ROOT, locale, file), 'utf8')) as Json;
  } catch {
    return null;
  }
}

/** One dot-path inside a parsed locale file, or `undefined`. */
function readKey(source: Json | null, keyPath: string): unknown {
  let node: unknown = source;
  for (const segment of keyPath.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Json)[segment];
  }
  return node;
}

/** The shipped sentence for one key, or a loud failure naming the key that is missing. */
function chatKey(keyPath: string): string {
  const value = readKey(readLocaleFile(LOCALE, 'chat.json'), keyPath);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`en/chat.json has no ${keyPath}`);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

/**
 * The composer's submit button, addressed by the label it actually carries.
 *
 * Scoped to the form on purpose: the composer's shell also holds controls that can carry a
 * similar word, so a search that started at the shell could match more than the submit and prove
 * nothing about which one was pressed. The activity tab that used to be the second "Stop" beside
 * it is gone — the submit is the one stop entry — but the form scoping keeps this locator
 * unambiguous by construction rather than by a count that could drift.
 */
function composerButton(page: Page, label: string): Locator {
  const escaped = label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return page.locator(`${FORM} button[aria-label="${escaped}"]`);
}

type PendingReading = {
  uuid: string;
  /** Whether the message itself is on screen. `started` and `cancelled` both drop it. */
  present: boolean;
  annotationKey: string;
  annotation: string;
  withdrawButtons: number;
  withdrawn: string;
  text: string;
};

/** Everything one command's row publishes, in one moment. */
async function readPendingRow(page: Page, uuid: string): Promise<PendingReading> {
  const row = page.locator(`${COMMAND_ROW}[data-command-uuid="${uuid}"]`).first();
  const annotation = row.locator(ANNOTATION).first();
  const hasAnnotation = (await annotation.count()) > 0;
  return {
    uuid,
    present: (await row.locator(PENDING_BUBBLE).count()) > 0,
    annotationKey: hasAnnotation
      ? ((await annotation.getAttribute('data-resident-annotation')) ?? '')
      : '',
    annotation: hasAnnotation ? (await annotation.innerText()).trim() : '',
    withdrawButtons: await row.locator(WITHDRAW).count(),
    withdrawn: (await row.getAttribute('data-resident-withdrawn')) ?? '',
    text: (await row.innerText()).trim().replace(/\s+/g, ' '),
  };
}

/** How many settled user turns in the pane carry a given text. */
async function countUserTurnsWith(page: Page, text: string): Promise<number> {
  return page.locator(PANE).locator(USER_TURN).evaluateAll(
    (nodes, needle) => nodes.filter((node) => (node.textContent ?? '').includes(needle)).length,
    text,
  );
}

/**
 * Waits for the one row that holds a message and has been given the host's name for it.
 *
 * The row exists the moment it is sent — that is the point of the feature — but its uuid is the
 * process's, delivered on the `queued` row, and until it arrives the row could not be withdrawn nor
 * told apart from another command's. Only rows that still draw a bubble are candidates, which is what
 * keeps this reading to the command that has not been started or withdrawn yet.
 */
async function waitForPendingUuid(page: Page, timeoutMs: number): Promise<string> {
  const rows = page.locator(`${COMMAND_ROW}:has(${PENDING_BUBBLE})`);
  await expect(rows).toHaveCount(1, { timeout: timeoutMs });
  await expect
    .poll(async () => ((await rows.first().getAttribute('data-command-uuid')) ?? '').length, {
      timeout: timeoutMs,
    })
    .toBeGreaterThan(0);
  return (await rows.first().getAttribute('data-command-uuid')) ?? '';
}

/** Fails with what the page actually held, rather than with a locator timeout and nothing else. */
async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/**
 * The project row's toggle, whose accessible name starts with the workspace's directory name.
 *
 * The sidebar's own control, clicked rather than bypassed: a session row only exists once its
 * project is expanded, and expanding it any other way would leave the row this file reads not
 * necessarily the row a user would see.
 */
const projectRow = (page: Page, workspaceName: string): Locator =>
  page.getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).first();

const sessionRow = (page: Page, sessionId: string): Locator =>
  page.locator(`a[href="/session/${sessionId}"]`).first();

/** Expands the fixture project until the session's row is on screen. Bounded, and never silent. */
async function revealSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  const row = sessionRow(page, sessionId);
  await projectRow(page, workspaceName).waitFor({ state: 'visible', timeout: 30_000 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    await projectRow(page, workspaceName).click().catch(() => undefined);
    if (await row.waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false)) return;
  }
  await explain(page, `the sidebar never showed a row for session ${sessionId}`);
}

/**
 * Opens a session and waits for its pane — the proof the transcript, not just the route, loaded.
 *
 * Opening is also this file's way of asking the server whether the session is processing: the client
 * subscribes on mount, and `chat_subscribed` carries the run registry's answer for the moment of the
 * subscribe. That is why each arm opens its own session *after* the walk that makes it busy has been
 * fired, rather than reloading a page it already had open.
 */
async function openSession(page: Page, workspaceName: string, sessionId: string): Promise<void> {
  await revealSession(page, workspaceName, sessionId);
  await sessionRow(page, sessionId).click();
  await expect(page.locator(PANE)).toBeVisible({ timeout: 30_000 });
}

// ── the startup guard ──────────────────────────────────────────────────────────────────────────
//
// This spec's startup path, bounded — the two levers the rest of this family already carries
// (`e2e/resident-running-view.spec.ts`, `e2e/session-filter.spec.ts`, `e2e/transcript-follow.spec.ts`),
// ported here rather than re-invented.
//
// Measured: a single transient interruption of the app's in-flight module requests — Chromium's
// `net::ERR_NETWORK_CHANGED`, ten in one burst — left the document with a module graph that never
// executed. React never mounted, the fixture project row never appeared, and the only wait on it was
// unbounded this file's own `revealSession` `waitFor({ timeout: 30_000 })`: the run died at 30s with
// `TimeoutError: locator.waitFor: Timeout 30000ms exceeded`, and not one of the three cases ran.
//
// The trigger is outside this repository (a host-level network change notification). What is inside
// it is the *response*: the same transient interruption must cost a bounded replay, not an unbounded
// wait. Two levers, both already established in this repo's sibling specs — a bounded client warm-up
// taken from `e2e/session-filter.spec.ts` / `e2e/transcript-follow.spec.ts`, and a bounded navigation
// probe from the same pair. Neither is invented here.
//
// What the guard may **not** do is decide anything for the three cases. It replays a navigation and
// it fails loudly when it cannot land; it never treats "not landed" as "good enough". Written the
// other way — probe times out, carry on — the three cases would each wait out their own budget on a
// blank document and the run would still cross the gate's 60s, which is what the bounded-failure
// reading in this task's AC measures.

/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * How long this run's own client is given to answer its app entry before the startup path gives up on it.
 *
 * The run already has two ceilings above it (playwright.config.ts's watchdog, then the goal gate's 60s) and both
 * are *outside* this spec — an unbounded wait here would be reported by whichever fired first, naming neither the
 * url nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's entry
 * module, and then one optimized dependency — all requested against this run's own client before any page of this
 * run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the cache".
 * The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has committed
 * the bundle: while the bundle is still being built the request is held, and a url carrying a hash from a
 * superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. Vite answers a re-optimization
 * committed after it began serving by pushing `full-reload` to every connected client, which replaces the document
 * whole — the other way this criterion has lost a page mid-flight. A 200 there means the page below will not race
 * the optimizer.
 *
 * `beforeAll`, before `browser.newPage()`, is the earliest point inside the criterion's own startup path, and it
 * is strictly before any page exists — the same requests the page would have made, made first. It is here rather
 * than in playwright.config.ts's `globalSetup` because Playwright resolves every `globalSetup` entry as a
 * *script* (a path that must default-export the function), so an inline warm-up there is neither type-legal nor
 * loadable, and this task's write surface allows no new file.
 *
 * Every step is bounded, including each request: a client that accepts the connection and then never answers
 * fails here, by name, with the url and the status, rather than waiting out a timeout further up.
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
 * A deadline rather than a replay count, because it is the *sum* that has to stay inside the criterion's own wall
 * clock: the bounded-failure reading asks that a probe which cannot succeed ends the whole run in under 30s, and
 * that run pays the config evaluation, both servers' boot and the browser launch before the probe's first attempt
 * even starts. Counting replays leaves that head-room to chance; a deadline spends it.
 */
const STARTUP_PROBE_DEADLINE_MS = 14_000;

/**
 * What the startup page said, kept for one purpose: a startup red has to *explain* a document that was pulled out
 * from under the navigation instead of reporting that a wait ran out.
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
 * `present` and `label` are functions rather than values because both are read at attempt time: the label carries
 * the run's own workspace, and the locator has to be re-created against whatever document is current *now*, after
 * a replay has replaced the one the navigation started on.
 */
type StartupLanding = {
  /** Names this landing in the guard's own error, so a red says which document never came up. */
  readonly label: () => string;
  /** Whether the landing is on screen right now, within `budgetMs`. */
  readonly present: (budgetMs: number) => Promise<boolean>;
};

/**
 * The one place this spec navigates — every navigation in this file is inside this function, which is what makes
 * "every navigation is guarded" a property of the file rather than a habit of its call sites.
 *
 * One pass is: navigate, then probe the landing with a short budget. A landing that does not arrive has the
 * navigation replayed — a fresh document, which is exactly what recovers from in-flight module requests that were
 * interrupted once — and the probe repeated, until the deadline. When the deadline is spent the guard throws with
 * the page's own text and this run's failed-request list, never silently continuing: a probe that cannot land must
 * end the run here, with a cause, rather than let the cases time out one after another on a document with nothing
 * in it.
 *
 * The navigation itself is bounded too, and a navigation that times out is treated as a landing that did not
 * arrive rather than as an error of its own — a document that never finishes loading and a document that loads
 * without ever mounting are the same failure from here, and both end at the same named error.
 */
const navigateBounded = async (
  page: Page,
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
        await page.goto('/', { timeout: Math.min(NAVIGATION_PROBE_MS, budgetMs()) });
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

/**
 * Records every frame the chat socket receives, and every frame it sends.
 *
 * Both directions are needed and neither is visible anywhere else: the host's account of a command
 * reaches this client as a `command_lifecycle` frame and the REST listing has no field for it, while
 * the withdrawal the click produced leaves as `chat.cancel-queued` and its only witness on this side
 * is the frame itself. Installing a subclass rather than re-assigning `onmessage` keeps the app's own
 * handlers working — the recorded frames are copies of what the app already got and sent.
 */
const recordSocketFrames = () => {
  const page = window as unknown as { __socketFrames: unknown[]; __socketSent: unknown[] };
  page.__socketFrames = [];
  page.__socketSent = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          page.__socketFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A binary or non-JSON frame is not part of this protocol; nothing to record.
        }
      });
    }

    send(data: Parameters<WebSocket['send']>[0]) {
      try {
        page.__socketSent.push(JSON.parse(String(data)));
      } catch {
        // Same: only the JSON frames this protocol uses are of interest.
      }
      super.send(data);
    }
  } as unknown as typeof WebSocket;
};

const socketFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(
    () => (window as unknown as { __socketFrames: Array<Record<string, unknown>> }).__socketFrames ?? [],
  );

const sentSocketFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(
    () => (window as unknown as { __socketSent: Array<Record<string, unknown>> }).__socketSent ?? [],
  );

/** Waits until one `command_lifecycle` frame carrying a given state has reached this client. */
async function waitForLifecycle(
  page: Page,
  sessionId: string,
  commandUuid: string,
  state: string,
  timeoutMs: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await socketFrames(page)).some(
          (frame) =>
            frame.kind === 'command_lifecycle'
            && frame.sessionId === sessionId
            && frame.commandUuid === commandUuid
            && frame.commandState === state,
        ),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

// ---------------------------------------------------------------------------------------------
// Setup.
// ---------------------------------------------------------------------------------------------

/**
 * An account this run owns, created over the API.
 *
 * The onboarding wizard is a three-screen flow that exists to collect a display name and an email,
 * neither of which this criterion reads; driving it would spend a third of the run's budget on
 * screens the subject never appears in. The profile flag it sets is the only thing the app checks
 * afterwards, so it is set here through the same endpoint the wizard's last screen calls.
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

/** Arms one scenario and returns the ids the rest of this file addresses it by. */
async function armScenario(
  api: APIRequestContext,
  projectPath: string,
  scenario: unknown,
): Promise<{ sessionId: string; transcriptPath: string }> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`arming failed (${response.status()}): ${JSON.stringify(body)}`);
  }
  const data = body?.data;
  if (typeof data?.sessionId !== 'string') {
    throw new Error(`arming returned no sessionId: ${JSON.stringify(body)}`);
  }
  return { sessionId: data.sessionId, transcriptPath: data.transcriptPath };
}

/**
 * Brings a session's resident process up, through the endpoint the status bar's own control calls.
 *
 * A scenario's `unattended-turn` needs a host to open its turn on, so both resident arms need their
 * process running before their walk is fired. This is that start verb and nothing else — the same
 * one `POST /api/session-hosts/:id/start` gives the bar's [Start] button, reached over the API so the
 * three sessions can be prepared before the page is opened.
 */
async function startResidentProcess(api: APIRequestContext, sessionId: string): Promise<void> {
  const response = await api.post(`/api/session-hosts/${encodeURIComponent(sessionId)}/start`);
  if (!response.ok()) {
    throw new Error(
      `could not start the resident process for ${sessionId}: ${response.status()} ${await response.text()}`,
    );
  }
}

type QueueReading = {
  queued: string[];
  withdrawRequested: string[];
  withdrawn: string[];
  controlResponses: string[];
};

/**
 * What the substitute process is holding, as the debug provider reports it.
 *
 * Read through the provider the registry resolved rather than from anything this file kept: the
 * queue belongs to the running process, and the criterion's claim is about what the *host* was
 * handed, not about what this client believes it sent.
 */
async function readQueue(api: APIRequestContext, sessionId: string): Promise<QueueReading> {
  const response = await api.get(`/api/debug-agent/queue?sessionId=${encodeURIComponent(sessionId)}`);
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`GET /api/debug-agent/queue answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  const data = body?.data ?? {};
  return {
    queued: data.queued ?? [],
    withdrawRequested: data.withdrawRequested ?? [],
    withdrawn: data.withdrawn ?? [],
    controlResponses: data.controlResponses ?? [],
  };
}

/** Fires a walk and reduces its outcome to a settled value, so a failure elsewhere is not shadowed. */
function fireClock(api: APIRequestContext, sessionId: string) {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => ({
      ok: response.ok(),
      status: response.status(),
      body: (await response.json().catch(() => null)) as { success?: boolean } | null,
    }))
    .catch((error: unknown) => ({ ok: false, status: -1, body: { failed: String(error) } }));
}

test.describe.configure({ mode: 'serial' });

test.describe('resident busy send', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let withdrawnSessionId = '';
  let startedSessionId = '';
  let perRunSessionId = '';

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
    // `DEBUG_AGENT_HOME` and refuses a `projectPath` outside it. The transcripts it arms land under
    // that home's `.claude/projects`, which is a tree of the debug provider's own — no other
    // provider's scan reads it, so the rows stay the ones the debug synchronizer wrote.
    workspace = path.join(fixtureHome, 'resident-busy-send-workspace');
    workspaceName = path.basename(workspace);

    // The account is created on a context of its own, and every read below runs on a context that
    // carries its token: both faces this file reads — the debug agent's control plane and its queue
    // — are mounted behind the same `authenticateToken` as the rest of `/api`, so an anonymous
    // request is answered with a refusal rather than with the state.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    withdrawnSessionId = (await armScenario(api, workspace, ARM_WITHDRAWN_SCENARIO)).sessionId;
    startedSessionId = (await armScenario(api, workspace, ARM_STARTED_SCENARIO)).sessionId;
    perRunSessionId = (await armScenario(api, workspace, ARM_PER_RUN_SCENARIO)).sessionId;

    await startResidentProcess(api, withdrawnSessionId);
    await startResidentProcess(api, startedSessionId);

    // Before any page of this run exists, so this run's optimize/re-optimize is over before the guard's first
    // navigation — see the helper for why the cost cannot be left inside the measurement window.
    await warmClientStartup(clientUrl);

    const context = await browser.newContext({ baseURL: clientUrl });
    await context.addInitScript(
      ({ key, value, language }: { key: string; value: string; language: string }) => {
        window.localStorage.setItem(key, value);
        window.localStorage.setItem('userLanguage', language);
      },
      { key: 'auth-token', value: token, language: LOCALE },
    );
    await context.addInitScript(recordSocketFrames);

    page = await context.newPage();
    // What the page said, kept for one purpose: the startup guard has to be able to *explain* a document that was
    // pulled out from under a navigation instead of reporting that a wait ran out. Registered before the first
    // navigation, or the burst that matters would not be in the evidence.
    page.on('console', (message) => {
      if (message.type() === 'error') {
        startupEvidence.consoleErrors.push(message.text());
        console.log(`[e2e] page console error: ${message.text()}`);
      }
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // The one navigation this spec makes is the guard's — it lands on the fixture project row or it ends the run
    // with the page's own text and this run's failed-request list. `revealSession` below then expands the row.
    const projectRowLanding: StartupLanding = {
      label: () => `the project row for ${workspaceName}`,
      present: (budgetMs) => appears(projectRow(page, workspaceName), budgetMs),
    };
    await navigateBounded(page, projectRowLanding, 'first-load');
    // The sidebar is the proof the account and the fixture project both landed. The first session
    // revealed is the withdrawn arm's, whose row the first test then clicks.
    await revealSession(page, workspaceName, withdrawnSessionId);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  /**
   * The three arms, in one client and one run.
   *
   * One test rather than three, because the readings are comparisons: the absence of the browser's
   * card on a resident session means nothing unless the same client shows that card for a busy
   * session it does not own, and the composer's own branch is exactly what differs between them.
   */
  test('a busy resident session takes the message, and the withdrawal is the process\'s own act', async () => {
    // ---- the withdrawn command ----------------------------------------------------------------
    // Both resident walks are fired here, before either arm is opened. Each one's opening step makes
    // its own session busy; the second arm's acts on the queue are placed far enough out that they
    // land after this file has got to it.
    const clockWithdrawn = fireClock(api, withdrawnSessionId);
    const clockStarted = fireClock(api, startedSessionId);

    await openSession(page, workspaceName, withdrawnSessionId);
    await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(BAR)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 20_000 });

    // The composer's own account of the two facts its branch is chosen by — busy, and resident —
    // read off the label it publishes rather than from a variable this file cannot see.
    await expect(composerButton(page, chatKey('resident.stopResident'))).toHaveCount(1, { timeout: 20_000 });

    await page.locator(TEXTAREA).fill(DRAFT_WITHDRAWN);
    await composerButton(page, chatKey('input.send')).click();

    // What this client did with the message, read before anything else about it is.
    //
    // The wait is on "whichever of the two roads was taken is on screen", not on the row: a build
    // that still queues a resident session locally draws the card instead, and waiting for the row
    // would red at that wait — reporting a missing row rather than the card that is sitting there.
    // Waiting for *either* makes the reading below the first thing that can be wrong, which is what
    // puts a regression of that shape on `resident.queuedCard === 0` and on nothing else.
    await expect(page.locator(`${QUEUED_CARD}, ${COMMAND_ROW}`).first()).toBeVisible({ timeout: 20_000 });

    const residentQueuedCard = await page.locator(QUEUED_CARD).count();
    console.log(`resident.queuedCard=${residentQueuedCard}`);
    expect(residentQueuedCard, 'a resident session must not fall back to the browser\'s own queue').toBe(0);

    const withdrawnUuid = await waitForPendingUuid(page, 20_000);
    const queuedRow = await readPendingRow(page, withdrawnUuid);
    const queuedAnnotation = chatKey(queuedRow.annotationKey);
    console.log(`resident.row.present=${queuedRow.present}`);
    console.log(`resident.row.annotationKey=${queuedRow.annotationKey}`);
    console.log(`resident.row.annotation=${queuedRow.annotation}`);
    console.log(`resident.row.text=${JSON.stringify(queuedRow.text)}`);
    expect(queuedRow.present, 'the message is in the record as soon as it is sent').toBe(true);
    expect(queuedRow.annotationKey, 'the queued row names the key it draws').toBe(PENDING_ANNOTATION_KEY);
    expect(queuedRow.annotation, 'and the sentence is that key\'s shipped one').toBe(queuedAnnotation);

    const withdrawnRowSelector = `${COMMAND_ROW}[data-command-uuid="${withdrawnUuid}"]`;
    const withdrawVisibleBefore = queuedRow.withdrawButtons;

    await page.locator(`${withdrawnRowSelector} ${WITHDRAW}`).click();
    // The withdrawal's evidence, polled on its own reading rather than waited for somewhere else.
    //
    // A click is not a withdrawal: it is proof only once the process that holds the command has
    // been handed it, and the count of what that process has been handed is `cancelPayloads`. Polling
    // *that* — through the provider the registry resolved, not through anything this file kept — is
    // what makes a build whose click never leaves the browser red here, naming this count, instead of
    // at a locator timeout that would report the same defect as a missing element.
    await expect
      .poll(
        async () => {
          const reading = await readQueue(api, withdrawnSessionId);
          return reading.withdrawRequested.length + reading.withdrawn.length;
        },
        { timeout: 10_000, message: 'the click must reach the process that holds the command (cancelPayloads >= 1)' },
      )
      .toBeGreaterThanOrEqual(1);

    const dispatched = (await sentSocketFrames(page)).some(
      (frame) =>
        frame.type === 'chat.cancel-queued'
        && frame.sessionId === withdrawnSessionId
        && frame.messageUuid === withdrawnUuid,
    );
    const withdrawnBeforeEvent = await page.locator(PANE).locator(WITHDRAWN).count();
    console.log(`withdraw.visibleBefore=${withdrawVisibleBefore > 0}`);
    console.log(`click.dispatched=${dispatched}`);
    console.log(`ui.withdrawnBeforeEvent=${withdrawnBeforeEvent > 0}`);
    expect(withdrawVisibleBefore, 'a command the process has not taken must offer [withdraw]').toBeGreaterThan(0);
    expect(dispatched, 'and it left this browser as a frame naming this message').toBe(true);
    expect(withdrawnBeforeEvent, 'a request is not a withdrawal: the row must not claim one yet').toBe(0);

    await waitForLifecycle(page, withdrawnSessionId, withdrawnUuid, 'cancelled', 30_000);
    await expect
      .poll(async () => page.locator(`${withdrawnRowSelector}${WITHDRAWN}`).count(), { timeout: 10_000 })
      .toBe(1);

    const withdrawnAfter = await readPendingRow(page, withdrawnUuid);
    const withdrawnAfterEvent = await page.locator(PANE).locator(WITHDRAWN).count();
    const turnsAfterWithdraw = await countUserTurnsWith(page, DRAFT_WITHDRAWN);
    const turnsControl = await countUserTurnsWith(page, SEED_USER_TEXT);
    const queue = await readQueue(api, withdrawnSessionId);
    const cancelPayloads = queue.withdrawRequested.length + queue.withdrawn.length;
    const cancelAsyncMessage = queue.withdrawn[0] ?? queue.withdrawRequested[0] ?? '';
    const framesAfterCancel = await socketFrames(page);
    const cancelledFrameSeen = framesAfterCancel.some(
      (frame) =>
        frame.kind === 'command_lifecycle'
        && frame.sessionId === withdrawnSessionId
        && frame.commandUuid === withdrawnUuid
        && frame.commandState === 'cancelled',
    );
    const cancelAckFrames = framesAfterCancel.filter(
      (frame) => frame.kind === 'queued_input_cancel_result' && frame.sessionId === withdrawnSessionId,
    ).length;
    console.log(`ui.withdrawnAfterEvent=${withdrawnAfterEvent > 0}`);
    console.log(`row.presentAfter=${withdrawnAfter.present}`);
    console.log(`row.textAfter=${JSON.stringify(withdrawnAfter.text)}`);
    console.log(`turnsAfterWithdraw=${turnsAfterWithdraw}`);
    console.log(`turns.control=${turnsControl}`);
    console.log(`cancelPayloads=${cancelPayloads}`);
    console.log(`scenario.cancel_async_message=${cancelAsyncMessage}`);
    console.log(`controlResponsesForCancel=${queue.controlResponses.length}`);
    console.log(`cancelAckFrames=${cancelAckFrames}`);
    console.log(`cancelVerdictSource=${cancelledFrameSeen ? 'command_lifecycle' : 'none'}`);
    expect(withdrawnAfterEvent, 'the notice arrives with the host\'s own cancelled state').toBeGreaterThan(0);
    expect(withdrawnAfter.present, 'a withdrawn command leaves the record with the queue').toBe(false);
    expect(turnsAfterWithdraw, 'and produces no turn of its own').toBe(0);
    expect(turnsControl, 'the counting method does find the turns that did run').toBeGreaterThan(0);
    expect(cancelPayloads, 'the click reached the process that holds the command').toBeGreaterThanOrEqual(1);
    expect(cancelAsyncMessage, 'and it is this message\'s own uuid the process was handed').toBe(withdrawnUuid);
    expect(queue.controlResponses, 'the withdrawal is never answered by a control response').toHaveLength(0);
    expect(cancelledFrameSeen, 'the verdict is the cancelled lifecycle event, and nothing else').toBe(true);

    // ---- the command the process takes --------------------------------------------------------
    await openSession(page, workspaceName, startedSessionId);
    await expect(page.locator(BAR)).toHaveAttribute('data-activity-state', 'in-turn', { timeout: 20_000 });
    await expect(composerButton(page, chatKey('resident.stopResident'))).toHaveCount(1, { timeout: 20_000 });

    await page.locator(TEXTAREA).fill(DRAFT_STARTED);
    await composerButton(page, chatKey('input.send')).click();

    const startedUuid = await waitForPendingUuid(page, 30_000);
    const beforeStarted = await readPendingRow(page, startedUuid);
    console.log(`beforeStarted.withdrawButton=${beforeStarted.withdrawButtons}`);
    expect(beforeStarted.withdrawButtons, 'a command still in the queue offers [withdraw]').toBeGreaterThanOrEqual(1);

    await waitForLifecycle(page, startedSessionId, startedUuid, 'started', 30_000);
    await expect
      .poll(async () => (await readPendingRow(page, startedUuid)).withdrawButtons, { timeout: 15_000 })
      .toBe(0);

    const afterStarted = await readPendingRow(page, startedUuid);
    const startedAnnotation = chatKey(afterStarted.annotationKey);
    console.log(`afterStarted.withdrawButton=${afterStarted.withdrawButtons}`);
    console.log(`afterStarted.annotationKey=${afterStarted.annotationKey}`);
    console.log(`afterStarted.label=${afterStarted.annotation}`);
    expect(afterStarted.withdrawButtons, 'a command the process has taken cannot be withdrawn').toBe(0);
    expect(afterStarted.annotationKey, 'the started row names the key it draws').toBe(STARTED_ANNOTATION_KEY);
    expect(afterStarted.annotation, 'and the sentence is that key\'s shipped one').toBe(startedAnnotation);

    // ---- the per-run session, in the same client and the same run ------------------------------
    // Its turn is this client's own send: the run that message opens is what holds the session busy,
    // and the scenario it walks is two waits long enough to type into while it is still running.
    await openSession(page, workspaceName, perRunSessionId);
    await page.locator(TEXTAREA).fill(PER_RUN_TURN_TEXT);
    await composerButton(page, chatKey('input.send')).click();

    // Busy, and *not* resident: the same button the two arms above read, carrying the other label.
    await expect(composerButton(page, chatKey('input.stop'))).toHaveCount(1, { timeout: 30_000 });

    await page.locator(TEXTAREA).fill(DRAFT_LOCAL_QUEUE);
    await composerButton(page, chatKey('input.queue.sendNext')).click();

    await expect(page.locator(QUEUED_CARD)).toHaveCount(1, { timeout: 15_000 });
    const perRunQueuedCard = await page.locator(QUEUED_CARD).count();
    const perRunCardText = (await page.locator(QUEUED_CARD).innerText()).trim().replace(/\s+/g, ' ');
    console.log(`perRun.queuedCard=${perRunQueuedCard}`);
    console.log(`perRun.card.text=${JSON.stringify(perRunCardText)}`);
    console.log(`perRun.card.label=${chatKey('input.queue.label')}`);
    expect(perRunQueuedCard, 'a per-run session keeps the browser\'s queue').toBeGreaterThanOrEqual(1);
    // The label is compared case-insensitively, and only it: the card renders it through a class that
    // uppercases it, so the sentence on screen is the shipped one after a `text-transform` this file
    // cannot see in `innerText`. The two sentences below it are compared as shipped — a fold that
    // applied to all three would accept a card that had stopped carrying the other two.
    expect(perRunCardText.toLowerCase(), 'the card draws the keys the locale file ships')
      .toContain(chatKey('input.queue.label').toLowerCase());
    expect(perRunCardText).toContain(chatKey('input.queue.willSend'));
    expect(perRunCardText).toContain(DRAFT_LOCAL_QUEUE);

    // The walks are awaited only now, for the one fact each response carries: that the runs these
    // arms read really were driven by the control plane rather than by something else.
    const withdrawnOutcome = await clockWithdrawn;
    const startedOutcome = await clockStarted;
    console.log(`withdrawn.run.ok=${withdrawnOutcome.ok} status=${withdrawnOutcome.status}`);
    console.log(`started.run.ok=${startedOutcome.ok} status=${startedOutcome.status}`);
    expect(withdrawnOutcome.ok, `the withdrawn arm's walk must complete: ${JSON.stringify(withdrawnOutcome.body)}`).toBe(true);
    expect(startedOutcome.ok, `the started arm's walk must complete: ${JSON.stringify(startedOutcome.body)}`).toBe(true);
  });

  test('every shipped locale carries the keys a held command draws', async () => {
    const required = [
      'resident.pending.annotation',
      'resident.pending.started',
      'resident.pending.withdraw',
      'resident.pending.withdrawn',
    ];

    const missing: string[] = [];
    for (const locale of ALL_LOCALES) {
      for (const keyPath of required) {
        const value = readKey(readLocaleFile(locale, 'chat.json'), keyPath);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/chat.json:${keyPath}`);
        }
      }
    }

    console.log(`locales.checked=${ALL_LOCALES.length} keys.perLocale=${required.length} missing=${missing.length}`);
    console.log(`locales=${ALL_LOCALES.join(',')}`);
    expect(missing, `every locale must carry these keys; missing: ${missing.join(', ')}`).toEqual([]);
  });

  /**
   * The wall clock, against the ceiling the goal gate kills at.
   *
   * Read from the run's own start — published by `playwright.config.ts` because a spec can only see
   * itself, and the ceiling binds the whole `npx playwright test` invocation: config evaluation,
   * seeding, server boot and browser launch all happen inside it. A spec that timed its own body
   * would report a number whose shortfall against the ceiling is exactly the part it could not see.
   */
  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, `the whole invocation, measured from the config's own start`).toBeLessThan(55_000);
  });
});
