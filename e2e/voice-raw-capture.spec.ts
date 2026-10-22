import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client started by playwright.config.ts. The recorder is
// the browser's own: Chromium is launched with a fake audio device whose samples come from a WAV the
// config wrote before the servers booted, so `getUserMedia` hands the capture chain a real stream and
// the app's own hook encodes what it hears.
//
// WHAT THIS FILE IS THE CRITERION FOR. The unit criteria own the endpoint, the file and the client's
// decision. This one owns the DEPLOYMENT's wiring: that a server started with `VOICE_CAPTURE=audio`
// and `VOICE_CAPTURE_RAW=1` — the two switches the config injects for this selection alone — writes,
// for one real listen, BOTH the trimmed upload the recogniser consumed AND the raw (pre-VAD) upload
// beside it, into one capture directory, under ONE `listenId` that the two capture ROWS share.
//
// THE UPSTREAM IS DELIBERATELY DEAD (the config sets `VOICE_API_BASE_URL` to an unused port for this
// selection): the capture row and file are written for a failed attempt too, so a recogniser that
// answered would add a socket nothing here reads. What is asserted is the wiring, not an answer.
//
// WHY THE ROWS COME FROM A LOG FILE. The pairing id lives on the two capture rows the server writes
// to its own output, and Playwright forwards a webServer's stdout to the RUNNER rather than to the
// spec — so this selection tees the server's output to a file inside the data directory (see the
// config's `VOICE_RAW_SERVER_LOG`) and the spec reads it there. The requests' bodies are NOT an
// alternative: Playwright does not retain a multipart body, so `postData()` is null for these uploads.

const DATA_DIR = process.env.QUAY_E2E_DATA_DIR!;
const CLIENT_URL = `http://127.0.0.1:${process.env.QUAY_E2E_CLIENT_PORT}`;
/** Where the deployment resolves its capture directory: beside the database, which is inside the data dir. */
const CAPTURE_DIR = path.join(DATA_DIR, 'voice-capture');
/** The file the server's stdout is teed to, set for this selection by the config. */
const SERVER_LOG = process.env.QUAY_E2E_VOICE_RAW_SERVER_LOG!;
const WORKSPACE = path.join(DATA_DIR, 'voice-trim-workspace');
const SESSION_ID = 'e2e-voice-trim';
const SESSION_NAME = 'voice-trim';
/** The fake microphone's samples; the config wrote the file before the browser launched. */
const AUDIO_FILE = process.env.QUAY_E2E_VOICE_TRIM_AUDIO!;
const FIXTURE_SEC = Number(process.env.QUAY_E2E_VOICE_TRIM_FIXTURE_SEC);
/** One pass of the fixture: long enough to hold speech, so a segment is cut and a raw upload is fired. */
const CAPTURE_MS = Math.round(FIXTURE_SEC * 1000);

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${AUDIO_FILE}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

/** One capture row, narrowed to the fields this criterion reads. */
type CaptureRow = { event: string; listenId?: string; path?: string };

/** Every capture row the server's tee has written so far. */
function captureRows(): CaptureRow[] {
  if (!fs.existsSync(SERVER_LOG)) return [];
  const rows: CaptureRow[] = [];
  for (const line of fs.readFileSync(SERVER_LOG, 'utf8').split('\n')) {
    try {
      const parsed = JSON.parse(line) as CaptureRow;
      if (typeof parsed.event === 'string' && parsed.event.startsWith('voice.capture')) rows.push(parsed);
    } catch {
      // A start-up or warning line: not a row.
    }
  }
  return rows;
}

test.describe.configure({ mode: 'serial' });

test.describe('the raw corpus end to end', () => {
  let context: BrowserContext;
  let page: Page;
  /** The page's console errors, collected so a failure can say which link broke. */
  const consoleErrors: string[] = [];

  const composer = () => page.locator('[data-slot="prompt-input-textarea"]');
  const projectRow = () =>
    page.getByRole('button', { name: new RegExp(`^${path.basename(WORKSPACE)}`) }).first();
  const sessionLink = () => page.locator('a[href^="/session/"]').filter({ hasText: SESSION_NAME });

  const expandProject = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (await sessionLink().isVisible().catch(() => false)) return;
      await projectRow().click();
      try {
        await expect(sessionLink()).toBeVisible({ timeout: 10_000 });
        return;
      } catch {
        // Collapsed again; the loop clicks once more.
      }
    }
    await expect(sessionLink()).toBeVisible({ timeout: 15_000 });
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);
    context = await browser.newContext({ baseURL: CLIENT_URL, permissions: ['microphone'] });
    // Voice is enabled in the mirror the first paint reads; no `voiceConfig` blob is seeded, so the
    // client has NO backend of its own and routes every transcription through the proxy — which is
    // what makes the server see the attempt and write its capture row.
    await context.addInitScript(() => {
      window.localStorage.setItem('uiPreferences', JSON.stringify({ voiceEnabled: true }));
      window.localStorage.setItem(
        'user-preferences',
        JSON.stringify({ uiPreferences: { voiceEnabled: true }, userLanguage: 'en' }),
      );
      window.localStorage.setItem('userLanguage', 'en');
    });

    page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
    });

    // First run on a fresh database: create the account, then finish onboarding. The account form is
    // the app's first rendered screen and the first thing a cold Vite dev server can fail to produce,
    // so it is retried the way the sibling voice specs retry it.
    await page.goto('/');
    let onboarded = await page.locator('#username').isVisible().catch(() => false);
    for (let attempt = 0; !onboarded && attempt < 3; attempt += 1) {
      await page.reload();
      onboarded = await page.locator('#username').isVisible({ timeout: 4_000 }).catch(() => false);
    }
    await expect(page.locator('#username')).toBeVisible({ timeout: 12_000 });
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();

    await expect(projectRow()).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('one listen leaves a raw row and a trimmed row sharing one listenId', async () => {
    test.setTimeout(45_000);

    // Open the seeded session's composer.
    await page.goto('/');
    await expandProject();
    await sessionLink().click();
    await expect(page).toHaveURL(new RegExp(`/session/${SESSION_ID}$`));
    await expect(composer()).toBeVisible({ timeout: 15_000 });

    // One press of the real voice button, held for one pass of the fixture.
    const record = page.getByRole('button', { name: 'Voice input' });
    await expect(record).toBeVisible({ timeout: 15_000 });
    await record.click();
    const stop = page.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(CAPTURE_MS);
    await stop.click();

    // The raw row is written after the listen ends; wait for it, then read the rows and the disk.
    await expect
      .poll(() => captureRows().filter((row) => row.event === 'voice.capture.raw').length, {
        timeout: 20_000,
        message: `the raw capture row never appeared in ${SERVER_LOG}; console errors=[${consoleErrors.slice(0, 3).join(' | ')}]`,
      })
      .toBeGreaterThan(0);

    const rows = captureRows();
    const rawRow = rows.find((row) => row.event === 'voice.capture.raw')!;
    const trimmedRow = rows.find((row) => row.event === 'voice.capture' && row.listenId === rawRow.listenId)!;

    // Printed before the assertions, so a green run says what it measured.
    console.log(
      `[voice-raw] raw.listenId=${rawRow.listenId} raw.path=${rawRow.path} ` +
        `trimmed.listenId=${trimmedRow?.listenId} trimmed.path=${trimmedRow?.path} ` +
        `rows=${rows.length}`,
    );

    // THE PAIRING, read off the two rows the deployment itself wrote: the raw row and the trimmed row
    // of ONE listen carry the same `listenId`, and each names the file it wrote.
    expect(rawRow.listenId).toBeTruthy();
    expect(trimmedRow, 'a trimmed capture row with the same listenId must exist').toBeTruthy();
    expect(trimmedRow.listenId).toBe(rawRow.listenId);

    // The bytes are really on disk, as two families in ONE directory.
    expect(rawRow.path && fs.existsSync(rawRow.path)).toBe(true);
    expect(trimmedRow.path && fs.existsSync(trimmedRow.path)).toBe(true);
    const files = fs.readdirSync(CAPTURE_DIR);
    console.log(`[voice-raw] dir=${CAPTURE_DIR} files=[${files.join(' ')}]`);
    expect(files.some((name) => /^raw-.*\.bin$/.test(name))).toBe(true);
    expect(files.some((name) => /^audio-.*\.bin$/.test(name))).toBe(true);
    // And the raw file is the one the raw row named — the `-2` give-way naming does not get in the way.
    expect(path.basename(rawRow.path!)).toMatch(/^raw-.*\.bin$/);
  });
});
