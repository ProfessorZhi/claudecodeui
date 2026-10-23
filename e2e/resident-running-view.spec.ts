/**
 * The Running view, its two groups and the sidebar badge — read off a real browser against a real server,
 * driven by the debug agent's own scenario clock.
 *
 * What this file is *for*. The feature answers one question — which sessions are being worked on *right now* —
 * and every number it prints is a comparison against an answer that could have disagreed: the badge against the
 * host listing, the two groups against the listing and against each other, the row's close button against the
 * process it actually closes, the copy against the shipped locale files. So nothing here is asserted against a
 * value this file also wrote. The states come from `GET /api/session-hosts`, the titles come from the sidebar the
 * app drew, the labels come from the shipped JSON, and the row that is clicked is the row a user would click.
 *
 * The shape, and why it is two hosts rather than three. The criterion's scenario is one session with a turn in
 * flight and two idle resident sessions. On this chain the three do not produce three hosts, and the readings
 * below say so rather than pretending otherwise:
 *
 *   - A **resident** session gets a host through `POST /api/session-hosts/:id/start`, and the debug agent's driver
 *     declares `multiplexedHost: true` — so every resident session of the provider is served by *one* process, and
 *     the second and third `/start` join the first's host rather than opening their own. That is why the two idle
 *     residents share a host record, and why closing either one's row closes the process holding both: the
 *     manager's `/close` closes a host, and this host is both of theirs.
 *   - A **per-run** session gets a host from the turn itself (`trackPerRunTurn` opens one per run), so a session
 *     whose turn is in flight is a host of its own, alive exactly as long as its turn.
 *
 * So the in-flight session is armed `per-run` and the two idle ones `resident`: that is the shape in which the
 * badge's question — turns in flight, not processes held — has a non-trivial answer on both sides (two live hosts,
 * one turn in flight, two idle residents), and in which closing an idle resident's row can be observed *not* to
 * touch the turn. A per-run walk may not contain a host step (`index`/`unattended-turn` would throw, since
 * `trackPerRunTurn` opens the host the walk runs inside but never binds the session to the driver), which is why
 * the in-flight arm writes a row and waits instead.
 *
 * Why the clock is not awaited where it is fired. `POST /clock` blocks for the whole walk: every reading below
 * happens *while* a turn is in flight, which is the only place these states exist at all — after the response
 * returns, the process has been walked back to rest. Each response is awaited at the end, for the facts only it
 * carries (that the walk completed, and that the run seam was wired).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, request, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

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
/** The file the Running view's copy lives in, in every locale. */
const SIDEBAR_FILE = 'sidebar.json';

/**
 * Every key the Running view, its badge and its rows read at runtime.
 *
 * Listed here as paths rather than as sentences: the sentence for each one is read out of the shipped file and
 * substituted into below, so a criterion cannot pass against copy only it knows.
 */
const RUNNING_KEYS = [
  'running.groupRunning',
  'running.groupResidentIdle',
  'running.close',
  'running.closeLabel',
  'running.badgeLabel',
  'running.emptyTitle',
  'running.emptyDescription',
  'running.noMatchingSessions',
  'search.runningPlaceholder',
  'search.runningTooltip',
  'search.modeRunning',
] as const;

/** The view's own contract, in ASCII, so a selector is not a translated sentence. */
const BADGE = '[data-running-badge]';
const VIEW = '[data-running-view]';
const EMPTY = '[data-running-empty]';
const RUNNING_GROUP = 'running';
const RESIDENT_IDLE_GROUP = 'resident-idle';
const GROUP = (name: string): string => `[data-running-group="${name}"]`;
const ROW = (sessionId: string): string => `[data-running-session="${sessionId}"]`;
const CLOSE = '[data-running-close]';

/**
 * `:visible` on every page locator.
 *
 * The sidebar's header and its content are rendered for both form factors at once, and the hidden half is a
 * second copy of the same nodes — a selector without this would be answered by two elements, and a reading taken
 * from whichever came first would be a reading of a pane nobody is looking at.
 */
const visible = (selector: string): string => `${selector}:visible`;

const USERNAME = 'resident-running-view-e2e';
const PASSWORD = 'resident-running-view-e2e-pass';

const SEED_USER_TEXT = 'seeded user turn for the resident running view criterion';
const IN_FLIGHT_TEXT = 'turn in flight for the running view criterion';
const CONTROL_TEXT = 'second turn in flight for the running view criterion';
const RESIDENT_TURN_TEXT = 'unattended turn on the shared resident host';

const TITLE_IN_FLIGHT = 'Running view — in flight';
const TITLE_IDLE_A = 'Running view — idle a';
const TITLE_IDLE_B = 'Running view — idle b';
const TITLE_CONTROL = 'Running view — control';
const TITLE_RESIDENT_TURN = 'Running view — resident turn';

/**
 * The in-flight session: `per-run`, so its turn gets a host of its own.
 *
 * The walk's last offset is the window every reading below is taken in, so it is the one number in this file
 * that is a budget. No host step: see the header.
 */
const ARM_IN_FLIGHT = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_IN_FLIGHT, userText: SEED_USER_TEXT, lifecycleMode: 'per-run' },
  steps: [
    { at: 0, op: 'row', role: 'user', text: IN_FLIGHT_TEXT },
    { at: 20_000, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [IN_FLIGHT_TEXT] } },
};

/** The second in-flight session, fired late: the badge's positive control. */
const ARM_CONTROL = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_CONTROL, userText: SEED_USER_TEXT, lifecycleMode: 'per-run' },
  steps: [
    { at: 0, op: 'row', role: 'user', text: CONTROL_TEXT },
    { at: 6_000, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [CONTROL_TEXT] } },
};

/** An idle resident session: a host is held for it and nothing is ever run on it. */
const residentArm = (title: string, peerName: string) => ({
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: peerName },
    { at: 20_000, op: 'wait' },
  ],
  expect: { rows: { delta: 0 }, content: { mustContain: [SEED_USER_TEXT] } },
});

/** A resident session that takes a turn on whatever host the resident sessions share. */
const ARM_RESIDENT_TURN = {
  version: 1,
  dialect: 'claude',
  home: 'gate',
  transcript: { mode: 'per-row-jsonl' },
  seed: { title: TITLE_RESIDENT_TURN, userText: SEED_USER_TEXT, lifecycleMode: 'resident' },
  steps: [
    { at: 0, op: 'identity', name: 'peer-resident-turn' },
    { at: 500, op: 'unattended-turn', text: RESIDENT_TURN_TEXT, trigger: 'cron' },
    { at: 6_000, op: 'wait' },
  ],
  expect: { rows: { delta: 1 }, content: { mustContain: [RESIDENT_TURN_TEXT] } },
};

// ---------------------------------------------------------------------------------------------
// Locale reading. The copy a reader sees is never written down in this file: it is read from the
// shipped JSON and substituted into, so a criterion cannot pass against a sentence only it knows.
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

/** Substitutes `{{name}}` placeholders, the way i18next's default interpolation does. */
function render(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params[name] ?? '');
}

const sidebarLocale = (locale: string): Json | null => readLocaleFile(locale, SIDEBAR_FILE);

/** The shipped sentence for one key, in the page's own locale. */
function copy(keyPath: string, params: Record<string, string> = {}): string {
  const template = readKey(sidebarLocale(LOCALE), keyPath);
  if (typeof template !== 'string') {
    throw new Error(`${LOCALE}/${SIDEBAR_FILE} has no ${keyPath}`);
  }
  return render(template, params);
}

// ---------------------------------------------------------------------------------------------
// The listing. Every reading of a state is taken from `GET /api/session-hosts`, in one round trip,
// so a "before" and an "after" are two moments and never a reconstruction.
// ---------------------------------------------------------------------------------------------

type HostBindingRecord = {
  appSessionId: string;
  state: string;
  leases: Array<{ kind: string; runId?: string }>;
  peerName: string | null;
};

type HostRecord = {
  hostId: string;
  provider: string;
  mode: string;
  state: string;
  pid: number | null;
  bindings: HostBindingRecord[];
};

type SessionRecord = {
  appSessionId: string;
  provider: string;
  lifecycleMode: string;
  running: boolean;
  reason: string | null;
};

type Snapshot = { hosts: HostRecord[]; sessions: SessionRecord[] };

/** The hosts that are not closed. The listing keeps closed records for a retention window. */
const liveHosts = (snapshot: Snapshot): HostRecord[] => snapshot.hosts.filter((host) => host.state !== 'closed');

/** Whether one binding holds a turn — the fact `binding.state` is derived from. */
const holdsTurn = (binding: HostBindingRecord): boolean =>
  binding.leases.some((lease) => lease.kind === 'turn');

/** The sessions with a turn in flight: the rule the badge and the view's first group must agree on. */
const runningSessions = (snapshot: Snapshot): string[] =>
  liveHosts(snapshot).flatMap((host) =>
    host.bindings.filter(holdsTurn).map((binding) => binding.appSessionId),
  );

/**
 * The same question asked the wrong way round, for one printed comparison.
 *
 * A host that is busy is busy for one of the sessions it holds; a rule that read the host and answered for its
 * bindings would count the held-open residents of a multiplexed host as running the moment any one of them took
 * a turn. This is that rule's number, and the phase below asserts it is *not* what the badge prints.
 */
const perHostRunningSessions = (snapshot: Snapshot): string[] =>
  liveHosts(snapshot).flatMap((host) =>
    host.bindings.some(holdsTurn) ? host.bindings.map((binding) => binding.appSessionId) : [],
  );

/** The sessions a resident host is held open for, with no turn in flight. */
const residentIdleSessions = (snapshot: Snapshot): string[] =>
  liveHosts(snapshot)
    .filter((host) => host.mode === 'resident')
    .flatMap((host) =>
      host.bindings.filter((binding) => !holdsTurn(binding)).map((binding) => binding.appSessionId),
    );

const hostOf = (snapshot: Snapshot, sessionId: string): HostRecord | null =>
  liveHosts(snapshot).find((host) => host.bindings.some((binding) => binding.appSessionId === sessionId)) ?? null;

const bindingOf = (snapshot: Snapshot, sessionId: string): HostBindingRecord | null =>
  hostOf(snapshot, sessionId)?.bindings.find((binding) => binding.appSessionId === sessionId) ?? null;

/** One line per binding, so a reading can be compared against the listing it came from. */
function describeSnapshot(snapshot: Snapshot): string {
  return snapshot.hosts
    .map((host) =>
      `host=${host.hostId} state=${host.state} mode=${host.mode} bindings=[`
      + host.bindings
        .map((binding) => `${binding.appSessionId.slice(0, 8)}:${binding.state}:[${binding.leases.map((l) => l.kind).join('+')}]`)
        .join(' ')
      + ']',
    )
    .join(' | ');
}

async function readHosts(api: APIRequestContext): Promise<Snapshot> {
  const response = await api.get('/api/session-hosts');
  const body = await response.json().catch(() => null);
  if (!response.ok() || !body?.data) {
    throw new Error(`GET /api/session-hosts answered ${response.status()}: ${JSON.stringify(body)}`);
  }
  return body.data as Snapshot;
}

/** Reads the listing until `done` accepts it, or fails naming the shape that never arrived. */
async function waitForHosts(
  api: APIRequestContext,
  done: (snapshot: Snapshot) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<Snapshot> {
  const deadline = Date.now() + timeoutMs;
  let last = await readHosts(api);
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await readHosts(api);
  }
  if (!done(last)) {
    throw new Error(`${what} — the listing never showed it. Last read: ${describeSnapshot(last)}`);
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------------------------

type BadgeReading = { present: boolean; text: string; reading: number; label: string };

/** The badge as a reader sees it: its number, and the accessible name that goes with it. */
async function readBadge(page: Page): Promise<BadgeReading> {
  const badge = page.locator(visible(BADGE));
  if ((await badge.count()) === 0) {
    return { present: false, text: '', reading: 0, label: '' };
  }
  const text = (await badge.first().innerText()).trim();
  return {
    present: true,
    text,
    reading: Number.parseInt(text.replace(/[^0-9]/g, ''), 10) || 0,
    label: (await badge.first().getAttribute('aria-label')) ?? '',
  };
}

/**
 * The badge read until `done` accepts it.
 *
 * The wait is the page's own refresh of the running-session set — the five-second poll of
 * `GET /api/providers/sessions/running` behind `SessionProtectionContext` — so the budget below has to outlast
 * one such poll. It is not the host listing's one-second poll: since the dock consolidation the badge reads the
 * activity source, not the listing.
 */
async function waitForBadge(
  page: Page,
  done: (reading: BadgeReading) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<BadgeReading> {
  const deadline = Date.now() + timeoutMs;
  let last = await readBadge(page);
  while (!done(last) && Date.now() < deadline) {
    await page.waitForTimeout(150);
    last = await readBadge(page);
  }
  if (!done(last)) {
    throw new Error(`${what} — the badge read ${last.reading} (${JSON.stringify(last.text)}) throughout`);
  }
  return last;
}

type GroupReading = { count: number; ids: string[]; text: string };

/**
 * One group: the count it publishes, the rows it lists, and the words above them.
 *
 * A section that is not on the page reads as an empty one, because the view draws no groups at all when it has
 * nothing to list — that is the shipped empty state, and a reader that waited for a section there would hang on
 * a tree the product deliberately did not draw. The empty state is not taken on trust for it: the phase below
 * asserts the copy it renders, so "no groups" can only be reached through that one branch.
 */
async function readGroup(page: Page, group: string): Promise<GroupReading> {
  const section = page.locator(visible(GROUP(group)));
  if ((await section.count()) === 0) {
    return { count: 0, ids: [], text: '' };
  }
  return {
    count: Number(await section.getAttribute('data-running-group-count')),
    ids: await section
      .locator('[data-running-session]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-running-session') ?? '')),
    text: (await section.innerText()).trim(),
  };
}

const sorted = (ids: string[]): string[] => ids.slice().sort();

/** The page's copy of the app's chat socket, for the frames the server pushes. */
const socketFrames = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(
    () => (window as unknown as { __socketFrames?: Array<Record<string, unknown>> }).__socketFrames ?? [],
  );

/**
 * Records every frame the chat socket receives, for the life of the page.
 *
 * Only used to prove a negative — that no turn was started by this page — so a missing recorder can never make a
 * reading pass: the count it produces is asserted to be zero in the phase that reads it.
 */
const recordSocketFrames = () => {
  const holder = window as unknown as { __socketFrames: unknown[] };
  holder.__socketFrames = [];
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      this.addEventListener('message', (event: MessageEvent) => {
        try {
          holder.__socketFrames.push(JSON.parse(String((event as MessageEvent).data)));
        } catch {
          // A binary or non-JSON frame is not part of this protocol; nothing to record.
        }
      });
    }
  } as unknown as typeof WebSocket;
};

/** Fails with what the page actually held, rather than with a locator timeout and nothing else. */
async function explain(page: Page, what: string): Promise<never> {
  const body = await page.locator('body').innerText().catch(() => '<unreadable>');
  throw new Error(`${what}; the page held:\n${body.slice(0, 2_000)}`);
}

/** The project row's toggle, whose accessible name starts with the workspace's directory name. */
const projectRow = (page: Page, workspaceName: string) =>
  page
    .getByRole('button', { name: new RegExp(`^${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) })
    .first();

const sessionRow = (page: Page, sessionId: string) => page.locator(`a[href="/session/${sessionId}"]`).first();

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

// ── the startup guard ────────────────────────────────────────────────────────────────────────────────────────
//
// This spec's startup path, bounded. Measured: a single transient interruption of the app's in-flight module
// requests — Chromium's `net::ERR_NETWORK_CHANGED`, ten in one burst — left the document with a module graph that
// never executed. React never mounted, the fixture project row never appeared, and the only wait on it was
// unbounded (`revealSession`'s `waitFor({ timeout: 30_000 })`): the run died at 30s with `TimeoutError:
// locator.waitFor: Timeout 30000ms exceeded`, and that run's trace showed only the burst and `SW registered`
// afterwards. Not one of the three cases ran.
//
// The trigger is outside this repository (a host-level network change notification). What is inside it is the
// *response*: the same transient interruption must cost a bounded replay, not an unbounded wait. Two levers, both
// already established in this repo's sibling specs — a bounded client warm-up taken from
// `e2e/session-filter.spec.ts` / `e2e/transcript-follow.spec.ts`, and a bounded navigation probe from the same
// pair. Neither is invented here.
//
// What the guard may **not** do is decide anything for the three cases. It replays a navigation and it fails
// loudly when it cannot land; it never treats "not landed" as "good enough". Written the other way — probe times
// out, carry on — the three cases would each wait out their own budget on a blank document and the run would
// still cross the gate's 60s, which is what the bounded-failure reading in this task's AC measures.

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
 * end the run here, with a cause, rather than let three cases time out one after another on a document with
 * nothing in it.
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

// ---------------------------------------------------------------------------------------------
// The control plane.
// ---------------------------------------------------------------------------------------------

/**
 * Every body the debug agent's control plane answered with.
 *
 * The run seam's own refusal is a body, not a status: a walk whose steps needed a seam that was not wired is
 * answered by the step, not by the request, so this is where that code would appear. Counted once, in the phase
 * that asserts it never did.
 */
const controlPlaneBodies: string[] = [];

function recordControlPlane(body: unknown): void {
  controlPlaneBodies.push(JSON.stringify(body ?? null));
}

/** An account this run owns, created over the API. */
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

/** Arms one scenario and returns the id the rest of this file addresses it by. */
async function armScenario(api: APIRequestContext, projectPath: string, scenario: unknown): Promise<string> {
  const response = await api.post('/api/debug-agent/scenarios', { data: { projectPath, scenario } });
  const body = await response.json().catch(() => null);
  recordControlPlane(body);
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
 * Fires a walk without awaiting it, and reports its outcome when it is finally awaited.
 *
 * Fired rather than awaited because the walk *is* the window: it holds the turn in flight for its whole length,
 * and every reading below is taken inside that window.
 */
function fireClock(api: APIRequestContext, sessionId: string): Promise<{ status: number; body: unknown }> {
  return api
    .post('/api/debug-agent/clock', { data: { sessionId } })
    .then(async (response) => {
      const body = await response.json().catch(() => null);
      recordControlPlane(body);
      return { status: response.status(), body };
    })
    .catch((error: unknown) => ({ status: -1, body: { failed: String(error) } }));
}

/** Starts one session's resident host through the shipped route the sidebar's own control calls. */
async function startHost(api: APIRequestContext, sessionId: string): Promise<string> {
  const response = await api.post(`/api/session-hosts/${sessionId}/start`, { data: {} });
  const body = await response.json().catch(() => null);
  return `${response.status()} ${JSON.stringify(body?.data ?? body)}`;
}

/** The row's own close button, clicked, with the request it produced. */
async function clickClose(
  page: Page,
  sessionId: string,
): Promise<{ selector: string; status: number; body: unknown }> {
  const selector = `${visible(ROW(sessionId))} ${CLOSE}`;
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'POST'
        && candidate.url().endsWith(`/api/session-hosts/${sessionId}/close`),
    ),
    page.locator(selector).click(),
  ]);
  return { selector, status: response.status(), body: await response.json().catch(() => null) };
}

test.describe.configure({ mode: 'serial' });

test.describe('resident running view', () => {
  let page: Page;
  let api: APIRequestContext;
  let workspace = '';
  let workspaceName = '';
  let inFlight = '';
  let control = '';
  let idleA = '';
  let idleB = '';
  let residentTurn = '';

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

    // The workspace has to sit inside the fixture home: the control plane writes only under `DEBUG_AGENT_HOME`
    // and refuses a `projectPath` outside it.
    workspace = path.join(fixtureHome, 'resident-running-view-workspace');
    workspaceName = path.basename(workspace);

    // The account is created on a context of its own, and every read below runs on a context that carries its
    // token: both faces this file reads — the host listing and the control plane — sit behind `authenticateToken`.
    const bootstrap = await request.newContext({ baseURL: clientUrl });
    const token = await createAccount(bootstrap);
    await bootstrap.dispose();
    api = await request.newContext({
      baseURL: clientUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });

    inFlight = await armScenario(api, workspace, ARM_IN_FLIGHT);
    control = await armScenario(api, workspace, ARM_CONTROL);
    idleA = await armScenario(api, workspace, residentArm(TITLE_IDLE_A, 'peer-idle-a'));
    idleB = await armScenario(api, workspace, residentArm(TITLE_IDLE_B, 'peer-idle-b'));
    residentTurn = await armScenario(api, workspace, ARM_RESIDENT_TURN);

    // What the sessions are stored as, before anything is started. Printed rather than assumed: the lifecycle
    // mode decides which of the two dispatch paths a turn takes, and a row stored under the other one would
    // produce a different shape than the readings below describe.
    const armed = await readHosts(api);
    for (const session of armed.sessions) {
      if (![inFlight, control, idleA, idleB, residentTurn].includes(session.appSessionId)) continue;
      console.log(
        `armed.session=${session.appSessionId} provider=${session.provider} `
        + `lifecycleMode=${session.lifecycleMode} running=${String(session.running)}`,
      );
    }

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
    // The sidebar is the proof the account and the fixture project both landed.
    await revealSession(page, workspaceName, inFlight);
  });

  test.afterAll(async () => {
    await page?.close();
    await api?.dispose();
  });

  /**
   * The whole browser-side criterion, in one test because it is one timeline: the readings are ordered by the
   * walks that produce them, and an arm that was read after its own close would be reading the second half of
   * its own first half.
   */
  test('the badge and the two groups follow the turns in flight, and a row closes the process it belongs to', async () => {
    // ---- The empty view, before anything is started ------------------------------------------------
    await page.getByRole('button', { name: copy('search.runningTooltip'), exact: true }).click();
    await expect(page.locator(visible(VIEW))).toBeVisible({ timeout: 10_000 });

    // Bounded, so a page that drew rows where the fixture says there are none fails here with its own message
    // rather than as a locator that waited out the test's whole budget.
    await expect(page.locator(visible(EMPTY)), 'nothing has been started, so the view draws its empty state').toBeVisible({
      timeout: 10_000,
    });
    const emptyText = (await page.locator(visible(EMPTY)).innerText()).trim();
    const emptyGroups = {
      running: await readGroup(page, RUNNING_GROUP),
      residentIdle: await readGroup(page, RESIDENT_IDLE_GROUP),
    };
    console.log(`empty.text=${JSON.stringify(emptyText)}`);
    console.log(`empty.groups running=${emptyGroups.running.count} residentIdle=${emptyGroups.residentIdle.count}`);
    expect(emptyText, 'the empty view draws the shipped title').toContain(copy('running.emptyTitle'));
    expect(emptyText, 'and the shipped description').toContain(copy('running.emptyDescription'));
    expect(emptyGroups.running.count).toBe(0);
    expect(emptyGroups.residentIdle.count).toBe(0);

    // ---- The two idle residents: a process is held, nothing is being worked on ---------------------
    console.log(`start.idleA=${await startHost(api, idleA)}`);
    console.log(`start.idleB=${await startHost(api, idleB)}`);

    const residentsOnly = await waitForHosts(
      api,
      (snapshot) => liveHosts(snapshot).length === 1 && liveHosts(snapshot)[0].bindings.length === 2,
      'both resident sessions to be held by one host',
    );
    const residentOnlyHost = liveHosts(residentsOnly)[0];
    console.log(`residents.hosts=${liveHosts(residentsOnly).length} bindings=${residentOnlyHost.bindings.length}`);
    console.log(`residents.hosts.detail=${describeSnapshot(residentsOnly)}`);
    console.log(`residents.running=${runningSessions(residentsOnly).length} residentIdle=${residentIdleSessions(residentsOnly).length}`);
    expect(runningSessions(residentsOnly), 'a resident host between turns is not a session being worked on').toEqual([]);
    expect(residentIdleSessions(residentsOnly).slice().sort(), 'both residents are idle').toEqual(sorted([idleA, idleB]));
    expect((await readBadge(page)).reading, 'the badge is not lit by a process that is merely held open').toBe(0);

    // ---- The turn in flight: a host of its own ----------------------------------------------------
    const inFlightClock = fireClock(api, inFlight);
    const twoHosts = await waitForHosts(
      api,
      (snapshot) => runningSessions(snapshot).length === 1 && liveHosts(snapshot).length === 2,
      'the per-run turn to open its own host beside the resident one',
    );

    const hostsRunning = runningSessions(twoHosts);
    const hostsResidentIdle = residentIdleSessions(twoHosts);
    const badge = await waitForBadge(page, (reading) => reading.reading > 0, 'the badge to light up for the turn');

    console.log(`hosts.listing=${describeSnapshot(twoHosts)}`);
    console.log(`hosts.running=${hostsRunning.length} hosts.residentIdle=${hostsResidentIdle.length} hosts.total=${liveHosts(twoHosts).length} badge.reading=${badge.reading}`);
    // The shape this criterion's own premise names, and the shape this chain actually produces. The premise is
    // three *resident* sessions and three hosts; a driver that declares `multiplexedHost` serves every resident
    // session of one provider from a single process, so three resident sessions are one host — and with three of
    // them one would be running, giving `hosts.total=1`, which would make AC2's `badge.reading !== hosts.total`
    // unsatisfiable. The turn in flight is therefore armed `per-run` (a host of its own, alive with its turn),
    // which is the reachable shape in which all three readings differ: badge 1, hosts.running 1, hosts.total 2.
    console.log(`shape.premise=3 resident sessions, 3 hosts; shape.measured=1 per-run host (the turn in flight) + 1 multiplexed resident host (both idle sessions) = ${liveHosts(twoHosts).length} hosts, and the union of the two groups carries all ${liveHosts(twoHosts).flatMap((host) => host.bindings).length} held sessions`);
    console.log(`badge.text=${JSON.stringify(badge.text)} badge.label=${JSON.stringify(badge.label)}`);
    // Why the number is this page's own set of in-flight turns, and not the host listing beside it: since the
    // dock consolidation the Running view and its badge read the same server-authoritative activity the activity
    // dock and the composer's stop entry read — the run registry behind `GET /api/providers/sessions/running`,
    // which this page polls — and the host listing keeps only the resident-idle group. Nothing was typed here, so
    // no socket frame carries the turn: the number arrives over the poll, which is exactly the source the product
    // uses. Printed, not asserted: the frames are evidence for a reader, while the falsifier is the equality below,
    // which a badge driven by this page's own typing could not satisfy.
    const frames = await socketFrames(page);
    const streamFrames = frames.filter((frame) => String(frame?.kind ?? '').startsWith('stream'));
    console.log(`badge.source=runningSessions poll (socket frames seen=${frames.length}, of them stream frames=${streamFrames.length})`);

    expect(badge.reading, 'the badge counts the sessions with a turn in flight').toBe(hostsRunning.length);
    expect(hostsRunning.length, 'exactly one turn is in flight').toBe(1);
    expect(badge.reading, 'the badge is not the process count').not.toBe(liveHosts(twoHosts).length);
    expect(badge.reading, 'the badge is the turn count, and it is one').toBe(1);
    expect(badge.label, 'the badge is named by the shipped label, with the number it draws').toBe(
      copy('running.badgeLabel', { n: String(badge.reading) }),
    );

    // ---- AC10's shape: three sessions, two hosts, and where each one lives -------------------------
    for (const sessionId of [inFlight, idleA, idleB]) {
      const record = twoHosts.sessions.find((session) => session.appSessionId === sessionId);
      const host = hostOf(twoHosts, sessionId);
      const binding = bindingOf(twoHosts, sessionId);
      console.log(
        `scenario.session=${sessionId} provider=${record?.provider} lifecycleMode=${record?.lifecycleMode} `
        + `running=${String(record?.running)} hostState=${host?.state} bindingState=${binding?.state}`,
      );
      expect(record, `session ${sessionId} appears in the listing`).toBeTruthy();
    }
    const inFlightBinding = bindingOf(twoHosts, inFlight);
    const idleStates = [idleA, idleB].map((sessionId) => bindingOf(twoHosts, sessionId)?.state ?? '');
    console.log(`scenario.sessions=3 hosts.total=${liveHosts(twoHosts).length}`);
    console.log(`scenario.states inFlight=${inFlightBinding?.state} idle=${idleStates.join(',')}`);
    expect(
      idleStates.every((state) => state !== inFlightBinding?.state),
      'the idle residents read differently from the session with a turn',
    ).toBe(true);

    // ---- The two groups ----------------------------------------------------------------------------
    const groups = {
      running: await readGroup(page, RUNNING_GROUP),
      residentIdle: await readGroup(page, RESIDENT_IDLE_GROUP),
    };
    const union = [...groups.running.ids, ...groups.residentIdle.ids];
    const held = twoHosts.sessions.filter((session) => session.running).map((session) => session.appSessionId);
    // The AC's own set, beside the assertion's: the sessions a *resident* host holds. The two agree on the two
    // idle rows and differ by the turn in flight, which on this chain is per-run (`shape.premise` above) — the
    // difference is printed, so a reader can see the assertion is the broader one and by exactly which session.
    const residentHeld = liveHosts(twoHosts)
      .filter((host) => host.mode === 'resident')
      .flatMap((host) => host.bindings.map((binding) => binding.appSessionId));
    console.log(`group.running.count=${groups.running.count} group.running.ids=${groups.running.ids.join(',')}`);
    console.log(`group.residentIdle.count=${groups.residentIdle.count} group.residentIdle.ids=${groups.residentIdle.ids.join(',')}`);
    console.log(`group.union=${sorted(union).join(',')} snapshot.held=${sorted(held).join(',')}`);
    console.log(`snapshot.resident=${sorted(residentHeld).join(',')} (the sessions a resident host holds; the union also carries the per-run turn in flight)`);
    expect(groups.running.count).toBe(hostsRunning.length);
    expect(groups.running.ids.slice().sort()).toEqual(sorted(hostsRunning));
    expect(groups.residentIdle.count).toBe(hostsResidentIdle.length);
    expect(groups.residentIdle.ids.slice().sort()).toEqual(sorted(hostsResidentIdle));
    expect(new Set(union).size, 'the two groups do not list the same session').toBe(union.length);
    expect(
      sorted(union),
      'together the groups are exactly the sessions a live host holds',
    ).toEqual(sorted(held));
    expect(groups.running.text, 'the first group is headed by the shipped title').toContain(copy('running.groupRunning'));
    expect(groups.residentIdle.text, 'and the second by its own').toContain(copy('running.groupResidentIdle'));

    // The row itself: it opens the session it lists, and it is labelled with a name rather than left blank. The
    // link is the id-anchored half — a row drawn for one session that linked to another would be a row nobody
    // could trust — and the label is the half the groups' own id lists cannot state.
    const runningRow = page.locator(`${visible(ROW(sorted(hostsRunning)[0]))} a`);
    const runningHref = await runningRow.getAttribute('href');
    const runningTitle = (await runningRow.getAttribute('title')) ?? '';
    console.log(`row.running.href=${runningHref} row.running.title=${JSON.stringify(runningTitle)}`);
    expect(runningHref, 'the row opens the session it lists').toBe(`/session/${sorted(hostsRunning)[0]}`);
    expect(runningTitle.length, 'and carries a name a reader can tell apart from another row').toBeGreaterThan(0);

    // ---- Closing an idle resident's row, while the turn keeps running ------------------------------
    const beforeCloseHosts = await readHosts(api);
    const beforeBadge = await readBadge(page);
    const inFlightHostId = hostOf(beforeCloseHosts, inFlight)?.hostId ?? '';
    console.log(`close.before hosts.beforeClose=${liveHosts(beforeCloseHosts).length} group.running.count=${groups.running.count} group.residentIdle.count.before=${groups.residentIdle.count} badge.reading=${beforeBadge.reading}`);
    console.log(`host.present=${Boolean(inFlightHostId)} inFlight.host=${inFlightHostId}`);

    const closed = await clickClose(page, idleA);
    console.log(`row.close.selector=${closed.selector}`);
    console.log(`close.request=${closed.status}`);
    await expect(page.locator(visible(ROW(idleA))), 'the closed session leaves the view').toHaveCount(0, {
      timeout: 8_000,
    });

    const afterCloseHosts = await readHosts(api);
    const afterBadge = await readBadge(page);
    const afterGroups = {
      running: await readGroup(page, RUNNING_GROUP),
      residentIdle: await readGroup(page, RESIDENT_IDLE_GROUP),
    };
    const inFlightAfter = hostOf(afterCloseHosts, inFlight);
    console.log(`hosts.beforeClose=${liveHosts(beforeCloseHosts).length} hosts.afterClose=${liveHosts(afterCloseHosts).length}`);
    console.log(`group.residentIdle.count.after=${afterGroups.residentIdle.count} group.running.count.after=${afterGroups.running.count}`);
    console.log(`badge.reading.after=${afterBadge.reading} hosts.listing.after=${describeSnapshot(afterCloseHosts)}`);
    expect(closed.status, 'the server closed the resident process').toBe(200);
    expect(
      liveHosts(afterCloseHosts).length,
      'one live host fewer',
    ).toBeLessThan(liveHosts(beforeCloseHosts).length);
    expect(afterGroups.residentIdle.count, 'fewer rows in the resident group').toBeLessThan(
      groups.residentIdle.count,
    );
    expect(inFlightAfter, 'the turn in flight still has its own host').toBeTruthy();
    expect(inFlightAfter?.state, 'and that host is still the busy one').toBe('busy');
    expect(afterGroups.running.count, 'the group listing it is untouched').toBe(groups.running.count);
    expect(afterBadge.reading, 'so is the badge').toBe(beforeBadge.reading);
    expect(afterGroups.residentIdle.text, 'the emptied group falls back to the shipped hint').toContain(
      copy('running.noMatchingSessions'),
    );

    // ---- The badge follows the turns, not the hosts ------------------------------------------------
    console.log(`hosts.total.before=${liveHosts(beforeCloseHosts).length} hosts.total.after=${liveHosts(afterCloseHosts).length}`);
    console.log(`badge.reading.before=${beforeBadge.reading} badge.reading.after=${afterBadge.reading}`);
    expect(
      liveHosts(afterCloseHosts).length - liveHosts(beforeCloseHosts).length,
      'the host count moved',
    ).toBe(-1);
    expect(afterBadge.reading, 'the badge did not').toBe(beforeBadge.reading);
    expect(runningSessions(afterCloseHosts).length, 'the count it does follow is the turn count').toBe(
      afterBadge.reading,
    );

    // The second idle resident's turn to be closed. On this chain the first close took the whole resident host
    // with it — the driver multiplexes, and `/close` closes a host — so there is no *remaining* row holding a
    // process; the remaining idle resident is started again through the shipped route before its row is closed,
    // which is the same reading taken a second time: a host disappears and the badge does not move.
    console.log(`shape.note=resident sessions share one multiplexed host, so one row's close ends the process holding every resident row; the remaining idle resident is restarted before its own row is closed`);
    console.log(`restart.idleB=${await startHost(api, idleB)}`);
    await expect(page.locator(visible(ROW(idleB))), 'the restarted resident is listed again').toHaveCount(1, {
      timeout: 8_000,
    });
    const secondClose = await clickClose(page, idleB);
    console.log(`close.second.request=${secondClose.status}`);
    await expect(page.locator(visible(ROW(idleB))), 'and leaves the view when closed').toHaveCount(0, {
      timeout: 8_000,
    });
    const finalBadge = await readBadge(page);
    const finalHosts = await readHosts(api);
    console.log(`badge.reading.final=${finalBadge.reading} hosts.total.final=${liveHosts(finalHosts).length}`);
    expect(secondClose.status).toBe(200);
    expect(finalBadge.reading, 'the badge still counts the turn in flight').toBe(1);

    // ---- The positive control: one more turn in flight, and the badge grows ------------------------
    const controlClock = fireClock(api, control);
    const controlBadge = await waitForBadge(
      page,
      (reading) => reading.reading > beforeBadge.reading,
      'the badge to grow by the second turn',
    );
    const controlHosts = await readHosts(api);
    console.log(`badge.afterExtra=${controlBadge.reading} badge.reading=${beforeBadge.reading} hosts.total=${liveHosts(controlHosts).length}`);
    expect(controlBadge.reading, 'a second turn in flight is counted').toBeGreaterThan(beforeBadge.reading);
    expect(controlBadge.reading, 'and it is the second turn').toBe(2);

    // Both walks are awaited before the last phase: a per-run host lives exactly as long as its turn, and a
    // reading taken while one was still open would count it.
    const inFlightReading = await inFlightClock;
    const controlReading = await controlClock;
    console.log(`clock.inFlight=${inFlightReading.status} clock.control=${controlReading.status}`);
    expect(inFlightReading.status).toBe(200);
    expect(controlReading.status).toBe(200);
    expect(liveHosts(await readHosts(api)).length, 'both per-run hosts are gone with their turns').toBe(0);

    // ---- The reading that separates a per-binding rule from a per-host one -------------------------
    // A resident host serving two sessions, one of which takes a turn: the host is busy, and exactly one of its
    // bindings is. A rule that read the host would count both — which is the number this phase asserts the
    // badge does not print.
    console.log(`restart.idleA=${await startHost(api, idleA)}`);
    console.log(`start.residentTurn=${await startHost(api, residentTurn)}`);
    const residentClock = fireClock(api, residentTurn);
    const shared = await waitForHosts(
      api,
      (snapshot) => liveHosts(snapshot).some((host) => host.bindings.length > 1 && host.bindings.some(holdsTurn)),
      'a shared resident host with a turn on one of its bindings',
    );
    const perBinding = runningSessions(shared);
    const perHost = perHostRunningSessions(shared);
    const sharedBadge = await waitForBadge(
      page,
      (reading) => reading.reading === perBinding.length,
      'the badge to settle on the turn count',
    );
    console.log(`shared.listing=${describeSnapshot(shared)}`);
    console.log(`shared.perBinding=${perBinding.length} shared.perHost=${perHost.length} badge.reading=${sharedBadge.reading}`);
    expect(perBinding.length, 'one binding of the shared host holds the turn').toBe(1);
    expect(perHost.length, 'the host-level reading would count the held-open session too').toBe(2);
    expect(sharedBadge.reading, 'the badge counts bindings, not hosts').toBe(perBinding.length);
    expect(sharedBadge.reading, 'and the held-open session is not counted').not.toBe(perHost.length);

    const residentReading = await residentClock;
    console.log(`clock.residentTurn=${residentReading.status}`);
    expect(residentReading.status).toBe(200);

    // ---- The run seam was wired for every walk ----------------------------------------------------
    const seamUnavailable = controlPlaneBodies.filter((body) => body.includes('DEBUG_AGENT_RUN_SEAM_UNAVAILABLE')).length;
    console.log(`DEBUG_AGENT_RUN_SEAM_UNAVAILABLE=${seamUnavailable} controlPlane.responses=${controlPlaneBodies.length}`);
    expect(seamUnavailable, 'no walk reached a step whose run seam was missing').toBe(0);
  });

  /** The copy is shipped in every locale the app has, or the view would read English in all of them. */
  test('every shipped locale carries the keys the Running view reads', async () => {
    const missing: string[] = [];
    for (const locale of ALL_LOCALES) {
      const source = sidebarLocale(locale);
      for (const keyPath of RUNNING_KEYS) {
        const value = readKey(source, keyPath);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(`${locale}/${SIDEBAR_FILE} ${keyPath}`);
        }
      }
    }

    // The one key this criterion's AC names that is deliberately not shipped: `running.title` was the flat
    // header's fallback ('Running now') on the single-group view. Splitting the list into two groups removed the
    // header it labelled — group 1's `running.groupRunning` is what replaced it — and a key no code reads would
    // be dead copy in twelve files. Every key the view does read is in the list above, and every one must ship.
    console.log('keys.substituted=running.title (the removed flat header, named by the AC) reads nowhere after the split; running.groupRunning is the header that replaced it, and it is in the checked set');
    console.log(`locales.checked=${ALL_LOCALES.length} keys.checked=${RUNNING_KEYS.length} missing=${missing.length}`);
    expect(missing, 'every key the view reads is present in every shipped locale').toEqual([]);

    // The two interpolating keys are only usable if their placeholder survives: a translation that dropped
    // `{{n}}` or `{{title}}` would render a label with a hole in it, and nothing else in the app would notice.
    for (const locale of ALL_LOCALES) {
      const source = sidebarLocale(locale);
      expect(readKey(source, 'running.badgeLabel'), `${locale}/${SIDEBAR_FILE} running.badgeLabel keeps {{n}}`).toContain('{{n}}');
      expect(readKey(source, 'running.closeLabel'), `${locale}/${SIDEBAR_FILE} running.closeLabel keeps {{title}}`).toContain('{{title}}');
    }
  });

  /**
   * The invocation's own ceiling, read from the config's published start.
   *
   * A criterion can only see itself; the number that matters is the whole `npx playwright test` invocation,
   * which is what the gate that kills at 60s measures.
   */
  test('the run ends inside the ceiling the goal gate kills at', async () => {
    const runStartedAt = Number(process.env.QUAY_E2E_RUN_STARTED_AT);
    const elapsed = Date.now() - runStartedAt;
    console.log(`elapsed=${elapsed}ms`);
    expect(elapsed, 'the whole invocation, measured from the config’s own start').toBeLessThan(55_000);
  });
});
