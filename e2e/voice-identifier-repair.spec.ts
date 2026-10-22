import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts (isolated data dir).
//
// The recorder is the browser's own: Chromium is launched with a fake audio device whose samples come from a
// WAV fixture, so `getUserMedia` hands `MediaRecorder` a real stream, the app's own hook encodes it, and the
// browser uploads the blob to the endpoint the *voice settings* name — the settings having been seeded into
// the two places an existing install really keeps them, and imported from there by the app's own hydration.
//
// The one stand-in is the recogniser. No offline speech-to-text exists in this checkout, so the endpoint the
// voice settings point at is a local server that answers `/audio/transcriptions`; the same shape the
// model-library specs already use for the LLM gateway they point a model at. Nothing here stubs the app: the
// request that arrives on that socket was made by the running client through the real
// `transcribeVoice()` path, carrying the seeded credential and model, and every assertion below is about what
// the app itself did with the answer.
//
// The identifier is not a literal on this side either. playwright.config.ts writes `voice.routes.ts` into the
// seeded project's workspace, and the identifier asserted on is read back off that directory — so the claim
// "the composer holds the project's real file name" is decided by the project's own content. The recogniser
// hears it as `voice.rouse.ts`, so the composer holding the real name is a repair that happened, not a
// transcription that was already right.

/** The sentence the fake microphone is saying; the recogniser stand-in answers with it, and the composer must end up holding it repaired. */
const UTTERANCE = process.env.QUAY_E2E_VOICE_UTTERANCE!;
/** The identifier as the recogniser heard it — the fixture's pre-repair state, which the composer must not still hold. */
const SPOKEN = process.env.QUAY_E2E_VOICE_SPOKEN_IDENTIFIER!;
const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
const WORKSPACE = path.join(DATA_DIR, 'voice-identifier-workspace');
const SESSION_ID = 'e2e-voice-identifier';
const SESSION_NAME = 'voice-identifier';
/** What the seeded voice settings name as the recogniser endpoint's credential, so the arriving request can be traced back to them. */
const API_KEY = 'sk-e2e-voice-4b1d9e77';
const STT_MODEL = 'whisper-large-v3-turbo';
/** `useVoiceInput` refuses to upload a blob under 800 bytes ("Recording too short"), so the capture must outlast that floor. */
const MIN_UPLOAD_BYTES = 800;

/** The account form's own selector, probed rather than filled blindly so the preamble can name what it waited for. */
const ACCOUNT_FORM_PROBE = '#username';
/** How long the account form is given to render before the preamble falls back to a reload. */
const STARTUP_PROBE_MS = 8_000;
/** How long each reload is given, once one is needed. */
const STARTUP_RELOAD_PROBE_MS = 4_000;
/**
 * The whole bounded preamble, reloads included.
 *
 * Bounded because this preamble is not what the criterion tests. Sibling runs of the two ceilings above it —
 * the run watchdog ends a `browser-launch-or-cases` run at 55s, the goal gate kills at 60s — used to report a
 * preamble that never finished as `Channel closed` and a bare `waiting for locator('#username')`, which is the
 * same shape a broken criterion has. Adding up to well under those ceilings means a preamble that really is
 * stuck ends here, in this spec's own words, while the command is still this run's to explain.
 */
const STARTUP_PROBE_DEADLINE_MS = 18_000;
/**
 * How long this run's client is given to answer its own app entry before the criterion's startup path gives up.
 * The same bound the sibling specs use, for the same reason: the ceilings above are *outside* the spec, and an
 * unbounded wait inside `beforeAll` would be reported by whichever of them fired first, naming neither the url
 * nor the status.
 */
const CLIENT_WARM_DEADLINE_MS = 30_000;
/** A dependency the optimizer serves out of this run's private cache, already rewritten to its url. */
const OPTIMIZED_DEP_IN_TEXT = /["'](\/@fs\/[^"']*\/deps\/[^"']+\.js\?v=[0-9a-f]+)["']/;

/**
 * Chromium's fake audio device, fed from the WAV playwright.config.ts wrote before the servers booted.
 *
 * `--use-fake-device-for-media-stream` is what makes `--use-file-for-fake-audio-capture` take effect at all:
 * without it the file is ignored and the device synthesises a beep, which would still record and still
 * transcribe — the run would go green while testing no fixture.
 */
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${process.env.QUAY_E2E_VOICE_AUDIO}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** One request the recogniser stand-in saw, kept so the assertions can be about the real socket. */
type RecognizerRequest = {
  url: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
};

/**
 * The uploaded file's bytes, taken out of the multipart body that carried them.
 *
 * The client posts a `FormData`, so the audio is one part among a few and the part boundaries are the only
 * thing that says where it starts and ends. Reading it here rather than trusting a length in a header keeps
 * the assertion about the bytes the app really put on the socket.
 */
const uploadedFile = (body: Buffer, contentType: string | undefined): Buffer => {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) throw new Error(`no boundary in upload content type: ${contentType}`);

  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break; // the closing delimiter
    const next = body.indexOf(delimiter, start);
    const part = body.subarray(start, next >= 0 ? next : body.length);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) throw new Error('malformed multipart part: no header terminator');
    if (/name="file"/.test(part.subarray(0, headerEnd).toString('ascii'))) {
      return part.subarray(headerEnd + 4, part.length - 2); // the trailing CRLF before the next boundary
    }
    at = next;
  }
  throw new Error('the upload carried no file part');
};

/** The duration of a 16-bit PCM WAV, in seconds, from its own `fmt `/`data` chunks. */
const wavDurationSec = (bytes: Buffer): number => {
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let dataBytes = 0;

  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      channels = bytes.readUInt16LE(at + 10);
      sampleRate = bytes.readUInt32LE(at + 12);
      bits = bytes.readUInt16LE(at + 22);
    } else if (id === 'data') {
      dataBytes = size;
    }
    at += 8 + size + (size % 2);
  }

  const bytesPerSecond = sampleRate * channels * (bits / 8);
  if (!bytesPerSecond || !dataBytes) throw new Error('not a PCM WAV with a readable data chunk');
  return dataBytes / bytesPerSecond;
};

/**
 * Whether `locator` showed up within `timeoutMs`.
 *
 * The boolean rather than a thrown timeout, because the caller's decision is what to do about its absence and a
 * caught assertion error reads as a failure that has already been reported.
 */
const appears = async (locator: Locator, timeoutMs: number): Promise<boolean> =>
  locator.waitFor({ state: 'visible', timeout: timeoutMs }).then(
    () => true,
    () => false,
  );

/**
 * Takes this run's first dependency optimization out of the measurement window: the html shell, the app's
 * entry module, and then one optimized dependency — all requested against this run's own client before any
 * page of this run exists.
 *
 * The dependency request is the one that carries the proof, and it is why the step is not just "warm the
 * cache". The imports of a transformed module are already rewritten to this run's own
 * `/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` urls, and that url only answers 200 once the optimizer has
 * committed the bundle: while the bundle is still being built the request is *held*, and a url carrying a hash
 * from a superseded run is exactly what a page receives `504 Outdated Optimize Dep` for. This spec's own red
 * showed what that costs when it lands inside the preamble — the page's module graph stalled behind the
 * optimizer, the account form never rendered, and the run ended at the watchdog with `Channel closed` and a
 * bare `waiting for locator('#username')`, with none of the criterion's own assertions ever reached. A 200
 * here means the page below will not race the optimizer, and this run's startup cost is paid before the
 * document it is measured against is navigated to.
 *
 * The seed in `playwright.config.ts` is not enough on its own here: it is only usable when the shared cache
 * was written by *this* root, and a worktree's root is by construction a different path — so the private
 * directory is built while the server is already answering, inside the window. This step is where that is paid.
 *
 * Why the warm-up lives here rather than in `playwright.config.ts`'s `globalSetup`, which is where this
 * defect's proposal put it: Playwright resolves every `globalSetup` entry as a *script* — `resolveScript()`
 * turns it into a path and the file must default-export the function — so an inline warm-up is neither
 * type-legal nor loadable, and this task's write surface allows no new file. `beforeAll`, before
 * `browser.newContext()`, is the earliest point inside the criterion's own startup path, and it is strictly
 * before any page exists — the same requests the page would have made, made first.
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

/**
 * What the startup document said, kept for one purpose: a preamble red has to be able to *explain* a document
 * that was replaced instead of reporting that a wait ran out.
 */
const startupEvidence = {
  consoleErrors: [] as string[],
  failedRequests: [] as string[],
};

/** The startup page's own text plus this run's console and network evidence — what a preamble red is read from. */
const readStartupEvidence = async (page: Page): Promise<string> => {
  const shown = await page.locator('body').innerText().catch(() => '<unreadable>');
  const errors = startupEvidence.consoleErrors.slice(0, 5);
  const failed = startupEvidence.failedRequests.slice(0, 5);
  return `the page shows ${JSON.stringify(shown.slice(0, 300))}`
    + `; console errors: ${errors.length > 0 ? errors.join(' | ') : '<none>'}`
    + `; failed requests: ${failed.length > 0 ? failed.join(' | ') : '<none>'}`;
};

test.describe.configure({ mode: 'serial' });

test.describe('AC-115 the repair holds end to end through the voice button', () => {
  let context: BrowserContext;
  let page: Page;
  let recognizer: http.Server;
  let recognizerUrl = '';
  const requests: RecognizerRequest[] = [];

  /**
   * The OpenAI-compatible speech endpoint the voice settings point at.
   *
   * A cross-origin multipart POST carrying `Authorization` is not a simple request, so the browser sends a
   * preflight first and would block the call without an answer to it — the preflight is handled here for the
   * same reason a real provider handles it, not as a convenience.
   */
  const startRecognizer = async (): Promise<http.Server> => {
    const server = http.createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
      response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          url: request.url ?? '',
          method: request.method ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks),
        });

        if (!(request.url ?? '').endsWith('/audio/transcriptions')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected path' }));
          return;
        }

        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ text: UTTERANCE }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return server;
  };

  /** The project row is a toggle whose accessible name starts with the workspace's display name. */
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();

  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  /**
   * Expands the project's session list. The row is a toggle, so a click that lands while the sidebar is still
   * re-rendering (right after a reload) would leave it collapsed — retry until the row is really on screen.
   */
  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) {
        return;
      }
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        // Collapsed again (or the click missed); the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  test.beforeAll(async ({ browser }) => {
    // Onboarding plus the first project load outlasts the default per-test budget, and the whole criterion has
    // to fit inside the goal gate's 60s — so the budget is raised only as far as the flow needs.
    test.setTimeout(120_000);

    recognizer = await startRecognizer();
    recognizerUrl = `http://127.0.0.1:${(recognizer.address() as AddressInfo).port}`;

    // Before `browser.newContext()` and therefore before any page of this run exists, so this run's own
    // optimize/re-optimize is committed before the criterion's first navigation — see the helper for why that
    // cost cannot be left inside the measurement window.
    console.log(`[e2e] client warm-up: ${await warmClientStartup(CLIENT_URL)}ms`);

    context = await browser.newContext({
      baseURL: CLIENT_URL,
      permissions: ['microphone'],
    });

    // The two places an install that predates the server-side move really keeps these values, written before
    // the app runs so the app's own readers are what consume them:
    //   - `user-preferences`, the mirror the first paint reads synchronously;
    //   - `uiPreferences`, the legacy key that mirror's `uiPreferences` entry is migrated from on hydrate;
    //   - `voiceConfig`, the legacy voice settings, imported to the server on the first voice hydration.
    // Seeding both the mirror and the legacy keys is the point: the built-in this exercises is the migration,
    // and a value that only ever existed in the mirror would be dropped the moment hydration replaced it.
    await context.addInitScript(
      ({ voiceConfig, preferences }: { voiceConfig: unknown; preferences: unknown }) => {
        window.localStorage.setItem('voiceConfig', JSON.stringify(voiceConfig));
        window.localStorage.setItem('uiPreferences', JSON.stringify(preferences));
        window.localStorage.setItem('user-preferences', JSON.stringify({ uiPreferences: preferences, userLanguage: 'en' }));
        window.localStorage.setItem('userLanguage', 'en');
      },
      {
        voiceConfig: {
          baseUrl: recognizerUrl,
          apiKey: API_KEY,
          sttModel: STT_MODEL,
          ttsModel: '',
          ttsVoice: '',
          ttsFormat: '',
        },
        preferences: { voiceEnabled: true },
      },
    );

    page = await context.newPage();

    // What the startup document said, kept from before its first navigation: a document that was replaced
    // mid-flow and a client that never rendered are the same blank page from the outside, and the console and
    // the failed requests are what tell them apart in this spec's own failure message.
    page.on('console', (message) => {
      if (message.type() === 'error') startupEvidence.consoleErrors.push(message.text());
    });
    page.on('requestfailed', (request) => {
      startupEvidence.failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'no error text'}`);
    });

    // First run on a fresh database: create the single account, then finish onboarding.
    await page.goto('/');
    // The account form is the app's first rendered screen, which also makes it the first thing a cold Vite dev
    // server can fail to produce. The warm-up above has committed this run's pre-bundle, but a page can still
    // be replaced by a later `full-reload`, and a probe that only ever asks about the form's *first* appearance
    // cannot see the difference. Neither blank throws on its own — the navigation succeeded, so nothing
    // surfaces until the wait for the form runs out. A reload clears both, so it is retried, bounded, because
    // this preamble is not what the criterion tests; if it is still absent the preamble ends here, with what
    // the page and this run's console and network said, rather than at a ceiling that names neither.
    const probeDeadline = Date.now() + STARTUP_PROBE_DEADLINE_MS;
    let onboarded = await appears(page.locator(ACCOUNT_FORM_PROBE), STARTUP_PROBE_MS);
    while (!onboarded && Date.now() < probeDeadline) {
      await page.reload();
      onboarded = await appears(
        page.locator(ACCOUNT_FORM_PROBE),
        Math.min(STARTUP_RELOAD_PROBE_MS, Math.max(1, probeDeadline - Date.now())),
      );
    }
    if (!onboarded) {
      throw new Error(`the account form never rendered; ${await readStartupEvidence(page)}`);
    }
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    // Indexing a session auto-registers its project, so the seeded workspace is already a project here; the
    // sidebar is the proof that the fixture really reached the backend.
    await expect(projectRow()).toBeVisible({ timeout: 30_000 });

    // Loading the app re-reads /api/projects, which synchronizes sessions before it answers.
    await page.reload();
    await expandProject();
    await expect(sessionLink()).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise<void>((resolve) => recognizer?.close(() => resolve()));
  });

  test('AC-115 a recording made through the voice button lands the project\'s real file name in the composer', async () => {
    // The project's own file name, read off the project rather than restated here.
    const fileNames = fs.readdirSync(WORKSPACE).filter((name) => name.endsWith('.ts'));
    expect(fileNames, 'the seeded workspace must hold the file the utterance names').toHaveLength(1);
    const [identifier] = fileNames;
    // The fixture must arrive BEFORE the repair. An utterance that already carried the real name would satisfy
    // every assertion below whether or not anything repairs it — green in exactly the world this criterion
    // exists to catch. Asserting the spoken form is present and the real name is absent is what keeps it able
    // to fail, so this premise failing is a criterion defect, not a product one.
    expect(UTTERANCE).toContain(SPOKEN);
    expect(UTTERANCE).not.toContain(identifier);
    /** What the composer has to hold: the recogniser's sentence with the name it got wrong put back. */
    const expected = UTTERANCE.split(SPOKEN).join(identifier);

    // The audio the fake device was pointed at, checked as audio. A path that does not resolve to a WAV is not
    // an error Chromium reports: it quietly plays its own fallback tone instead, which records and transcribes
    // exactly like the fixture — so a criterion that only looked at the composer could go green on a run where
    // nothing was injected at all.
    const audio = fs.readFileSync(process.env.QUAY_E2E_VOICE_AUDIO!);
    expect(audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audio.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // 48kHz mono 16-bit, so a second of it is 96kB: the fixture is seconds long, not a click.
    expect(audio.length).toBeGreaterThan(96_000);

    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));

    const composer = page.locator('[data-slot="prompt-input-textarea"]');
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await expect(composer).toHaveValue('');

    // The mic button is on screen only once both halves of the gate are satisfied: `voiceEnabled` from the
    // seeded preferences, and a configured backend from the seeded `voiceConfig` after its hydration ran.
    const record = page.getByRole('button', { name: 'Voice input' });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await record.click();

    // Recording really started: the button renames itself for as long as the recorder is running.
    const stop = page.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible({ timeout: 10_000 });

    // The recorder has to run long enough to clear the hook's own 800-byte floor. There is no event to wait on
    // for "enough audio" — the upload does not exist until the stop — so the wait is the capture duration.
    await page.waitForTimeout(2500);
    await stop.click();

    // The transcript travelled the whole path back into the composer, and it is the recogniser's text with the
    // one name it got wrong put back — the app is free to trim, but the only thing allowed to re-spell it is the
    // repair, and only against a name the project really has.
    // The ceiling is deliberately short: a regression here has to surface as this assertion rather than as an
    // unattributable timeout, because the gate that runs this file caps the whole command at 60s.
    await expect(composer).toHaveValue(expected, { timeout: 15_000 });
    const value = await composer.inputValue();

    // The identifier survives with its own case and its own dots, character for character...
    expect(value).toContain(identifier);
    // ...and what landed is not the shape a recogniser produces when it drops the dot — which is the failure
    // this criterion exists to catch, and which any dots-blind comparison would accept.
    expect(value).not.toContain(identifier.replace(/\./g, ' '));
    // ...and it is not the name the recogniser actually said either. This is the reading that separates a
    // repair from a fixture that was already spelled right: the composer must hold the project's name and no
    // longer the wrong one, so the criterion fails if the repair stops running.
    expect(value).not.toContain(SPOKEN);

    // The transcription was the app's own call, made from the seeded settings, and it carried real audio.
    expect(requests).toHaveLength(1);
    const [upload] = requests;
    expect(upload.method).toBe('POST');
    expect(upload.url.endsWith('/audio/transcriptions')).toBe(true);
    // The credential proves the request was built from the settings that were seeded, not from a default.
    expect(upload.authorization).toBe(`Bearer ${API_KEY}`);
    expect(upload.contentType).toContain('multipart/form-data');
    // A real recording: the browser encoded audio, and it cleared the hook's own floor before uploading.
    expect(upload.body.length).toBeGreaterThan(MIN_UPLOAD_BYTES);
    // ...and the bytes on the socket are real audio, produced by the app from what the fake microphone was
    // playing, rather than a payload this test assembled. Two readings say that, both taken off the uploaded
    // audio itself: the container it is really in, and the length that container's own header describes.
    //
    // The container is this repo's, not the browser's. The trim is the shipped default, so `prepareUpload`
    // decodes the capture and re-encodes it as PCM WAV before uploading; a capture that never went through
    // that path arrives in the recorder's own webm. Reading the container is therefore reading whether the
    // shipped chain ran at all — and it is the reading that stopped being written down here: this guard used
    // to assert the *browser's* webm, which was true before the trim was wired into the upload path and false
    // from the moment it was. The mechanism changed under the guard; the invariant below did not.
    const audioPart = uploadedFile(upload.body, upload.contentType);
    expect(audioPart.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(audioPart.subarray(8, 12).toString('ascii')).toBe('WAVE');
    // The other half of "this is that audio": how long it is, out of the WAV's own `fmt `/`data` chunks —
    // never out of the part's byte count, which says nothing about duration. The reference is the fixture,
    // the same bytes the fake device was pointed at, read here rather than restated as a literal, so a
    // fixture that stopped being written would red this criterion instead of quietly agreeing with it.
    const fixtureSec = wavDurationSec(audio);
    const uploadSec = wavDurationSec(audioPart);
    // Printed before the assertions so a green run says what the guard measured, not only what it refused:
    // the next change to this chain should be readable against these numbers rather than re-derived.
    console.log(
      `[voice-identifier] upload: container=${audioPart.subarray(0, 4).toString('ascii')}`
        + ` fixture=${fixtureSec.toFixed(3)}s uploaded=${uploadSec.toFixed(3)}s`,
    );
    // The upload is one pass of the fixture and nothing else, so its length is bounded by the fixture's on
    // both sides — and the two bounds fail in opposite directions, which is why both are written.
    //
    // Over it: the capture window is shorter than the fixture, and the trim only ever takes silence out of
    // the capture it is handed, so an upload at or past the fixture's full length is one the trim never
    // met. Watch the headroom — the trim adds its own lead-in/lead-out padding, and at the shipped capture
    // window the upload lands close under the fixture (see the reading printed above), so this is the
    // tighter of the two.
    //
    // Well under half of it: the audio is still there. A trim whose detector called the whole capture
    // silence returns a near-empty WAV, which passes the container reading above and every other assertion
    // in this test — the recogniser stand-in answers the same sentence either way — so this is the only
    // reading that refuses it.
    expect(uploadSec, `the upload was ${uploadSec}s of a ${fixtureSec}s fixture`).toBeLessThan(fixtureSec);
    expect(uploadSec, `the upload was ${uploadSec}s of a ${fixtureSec}s fixture`).toBeGreaterThan(fixtureSec / 2);
    expect(upload.body.includes(Buffer.from(`name="model"`))).toBe(true);
    expect(upload.body.includes(Buffer.from(STT_MODEL))).toBe(true);
  });
});
