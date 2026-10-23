import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Real Chromium against the real backend + Vite client (playwright.config.ts, isolated data dir).
// The whole path is the user's: the source model is created in the Settings UI, copied from the list,
// renamed, and only then sent on. The one stub is the LLM gateway the model points at, so "the copy
// really carries the secret" is observed on a real socket (a request arriving with the token) instead
// of being asserted from component state — which is also the only place the secret is ever visible.

const SOURCE = { name: 'E2E Duplicate Source', id: 'e2e-dup-source' };
const COPY = { name: 'E2E Duplicate Copy', id: 'e2e-dup-copy' };
const TOKEN = 'sk-e2e-duplicate-3c81f0a4e7';
const PROMPT = 'hello gateway from the duplicated model';

// Namespaced i18n keys leak into the UI as literals like "modelLibrary.duplicate.submit" when a translation is missing.
const UNTRANSLATED_KEY = /\b(?:modelLibrary|composer|settings|chat|common|sidebar|mainTabs)\.[a-z][A-Za-z]*(?:\.[a-z][A-Za-z]*)*\b/;

type GatewayHit = { url: string; headers: http.IncomingHttpHeaders; body: string };

test.describe.serial('duplicating a custom model in a real browser', () => {
  let page: Page;
  let gateway: http.Server;
  let gatewayUrl = '';
  const gatewayHits: GatewayHit[] = [];
  const responseBodies: string[] = [];

  const openModelsPage = async () => {
    // Idempotent: the dialog is a modal, so clicking Settings while it is already showing the model library
    // just lands on the backdrop. `beforeAll` leaves it open for the first test.
    if (await page.getByText('Model library').first().isVisible().catch(() => false)) {
      return;
    }
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Agents' }).click();
    // Claude is the Agents tab's default provider, so its Models category is one click away.
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.getByText('Model library')).toBeVisible();
  };

  /** Drops a model left behind by an earlier run, so the id suggestion and the list start from a known state. */
  const removeModelIfPresent = async (name: string) => {
    const remove = page.getByRole('button', { name: `Delete ${name}` });
    if (!(await remove.count())) {
      return;
    }
    await remove.click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('button', { name: `Delete ${name}` })).toHaveCount(0);
  };

  const removeAllSpecModels = async () => {
    // `SOURCE.name (copy)` is what the duplicate form pre-fills, so a run that died before renaming leaves that.
    for (const name of [SOURCE.name, COPY.name, `${SOURCE.name} (copy)`]) {
      await removeModelIfPresent(name);
    }
  };

  /** Runs the first-run account flow, or signs in when the database already holds the account. */
  const ensureSignedIn = async () => {
    await page.goto('/');
    const createAccount = page.getByRole('button', { name: 'Create Account' });
    const settings = page.getByRole('button', { name: 'Settings' }).first();
    await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
    if (await createAccount.count()) {
      await page.locator('#username').fill('e2euser');
      await page.locator('input[type=password]').nth(0).fill('e2epassword');
      await page.locator('input[type=password]').nth(1).fill('e2epassword');
      await createAccount.click();
      await page.getByPlaceholder('John Doe').fill('E2E User');
      await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Complete Setup' }).click();
      // "Signed in" means the real app shell is up, not that no project exists: playwright.config.ts seeds the
      // session-filter transcripts before the server boots, and the boot scan that indexes them auto-registers
      // their project, so the "Choose Your Project" empty state never renders — anchoring on it is a race.
      await expect(settings).toBeVisible({ timeout: 15_000 });
      return;
    }
    if (await page.locator('#username').count()) {
      await page.locator('#username').fill('e2euser');
      await page.locator('input[type=password]').first().fill('e2epassword');
      await page.locator('form button[type=submit]').click();
      await expect(settings).toBeVisible({ timeout: 15_000 });
    }
  };

  /** Creates a model through the Settings form, gateway template filled in far enough to be usable. */
  const createSourceModel = async () => {
    await openModelsPage();
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.getByLabel('Model name').fill(SOURCE.name);
    await page.getByLabel('Model ID').fill(SOURCE.id);
    await page.getByRole('button', { name: 'Gateway template' }).click();

    const rows = page.getByTestId('model-env-row');
    await expect(rows).toHaveCount(6);
    const rowFor = (key: string) => rows.filter({ has: page.locator(`input[value="${key}"]`) });
    await rowFor('ANTHROPIC_BASE_URL').getByLabel('Value').fill(gatewayUrl);
    await rowFor('ANTHROPIC_AUTH_TOKEN').getByLabel('Secret value').fill(TOKEN);

    const created = page.waitForResponse(
      (response) => /\/api\/providers\/claude\/models$/.test(response.url()) && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Add model' }).click();
    expect((await created).status()).toBeLessThan(300);
    await expect(page.getByRole('button', { name: `Edit ${SOURCE.name}` })).toBeVisible();
  };

  test.beforeAll(async ({ browser }) => {
    gateway = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        gatewayHits.push({ url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
        // Fail fast: the assertion is that the request arrived with the token, not that a reply is rendered.
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'e2e mock gateway' } }));
      });
    });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;

    page = await browser.newPage();
    page.on('response', (response) => {
      if (response.url().includes('/api/')) {
        response.text().then((text) => responseBodies.push(text)).catch(() => {});
      }
    });

    await ensureSignedIn();
    await openModelsPage();
    await removeAllSpecModels();
  });

  test.afterAll(async () => {
    // Leave no model behind, whatever the tests did.
    try {
      await page.goto('/');
      await openModelsPage();
      await removeAllSpecModels();
    } finally {
      await page.close();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    }
  });

  test('creates the source model from the gateway template through the Models page', async () => {
    await createSourceModel();
  });

  test('the duplicate button pre-fills a copy of the source, secret included', async () => {
    await openModelsPage();
    await page.getByRole('button', { name: `Duplicate ${SOURCE.name}` }).click();

    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);
    await expect(page.getByLabel('Model name')).toHaveValue(`${SOURCE.name} (copy)`);
    await expect(page.getByLabel('Model ID')).toHaveValue(`${SOURCE.id}-copy`);
    // The rows are the source's, and its secret reads back as set rather than as a value: the copy keeps
    // it server-side, which is the only way it can be kept at all.
    const rows = page.getByTestId('model-env-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ has: page.locator('input[value="ANTHROPIC_AUTH_TOKEN"]') }).getByTestId('secret-set-badge'))
      .toBeVisible();
    await expect(page.getByLabel('Secret value')).toHaveValue('');
  });

  test('renaming the copy and creating it adds it to the list', async () => {
    await page.getByLabel('Model name').fill(COPY.name);
    await page.getByLabel('Model ID').fill(COPY.id);

    const duplicated = page.waitForResponse(
      (response) => /\/api\/providers\/claude\/models\/\d+\/duplicate$/.test(response.url())
        && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create copy' }).click();
    expect((await duplicated).status()).toBeLessThan(300);

    await expect(page.getByRole('button', { name: `Edit ${COPY.name}` })).toBeVisible();
    // The source is still there: a copy adds a row, it does not move one.
    await expect(page.getByRole('button', { name: `Edit ${SOURCE.name}` })).toBeVisible();
  });

  test('after a reload the copy is only shown as set and the secret is nowhere to be found', async () => {
    await page.reload();
    await openModelsPage();
    await page.getByRole('button', { name: `Edit ${COPY.name}` }).click();

    const secretRow = page.getByTestId('model-env-row').filter({ has: page.locator('input[value="ANTHROPIC_AUTH_TOKEN"]') });
    await expect(secretRow.getByTestId('secret-set-badge')).toBeVisible();
    await expect(secretRow.getByLabel('Secret value')).toHaveValue('');
    // The base URL survived the copy as a literal value, so "only the secret is hidden" is not an accident of
    // an empty config.
    const baseUrlRow = page.getByTestId('model-env-row')
      .filter({ has: page.locator('input[value="ANTHROPIC_BASE_URL"]') });
    await expect(baseUrlRow.getByLabel('Value')).toHaveValue(gatewayUrl);

    expect(await page.locator('body').innerText()).not.toContain(TOKEN);
    expect(await page.content()).not.toContain(TOKEN);
    expect(await page.locator('body').innerText()).not.toMatch(UNTRANSLATED_KEY);
    // Both the create and the duplicate response, the reload's catalog fetches and every other API body seen.
    expect(responseBodies.length).toBeGreaterThan(0);
    for (const body of responseBodies) {
      expect(body).not.toContain(TOKEN);
    }
  });

  test('the copy is selectable in the composer and the gateway receives the request with its token', async () => {
    await page.keyboard.press('Escape');
    await page.reload();
    const workspace = path.join(process.env.QUAY_E2E_DATA_DIR!, 'duplicate-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    await page.getByTitle('Create new project').click();
    await page.getByPlaceholder('/path/to/project/workspace').fill(workspace);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Create Project' }).click();
    await page.getByText('duplicate-workspace', { exact: true }).first().click();

    await page.getByRole('button', { name: 'Select model and reasoning effort' }).click();
    await page.getByRole('menuitem').first().click();
    await page.getByRole('menuitemradio', { name: COPY.name }).click();
    await expect(page.getByRole('button', { name: 'Select model and reasoning effort' })).toContainText(COPY.name);

    const composer = page.locator('form').filter({ has: page.getByPlaceholder(/Type \/ for commands/) });
    expect(await composer.innerText()).not.toMatch(UNTRANSLATED_KEY);

    await page.getByPlaceholder(/Type \/ for commands/).fill(PROMPT);
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect
      .poll(() => gatewayHits.some((hit) => hit.headers['authorization'] === `Bearer ${TOKEN}` || hit.headers['x-api-key'] === TOKEN), {
        timeout: 45_000,
      })
      .toBe(true);
    // The Agent SDK names the session through this same gateway as well, with its own cheap model rather than
    // the selected one, so the first /v1/messages hit is not necessarily the message: pick the request that
    // carries THIS model's id, and still assert it landed on the messages endpoint.
    const hit = gatewayHits.find((entry) => entry.body.includes(COPY.id));
    expect(hit, `no gateway request carried ${COPY.id}; urls seen: ${JSON.stringify(gatewayHits.map((entry) => entry.url))}`).toBeTruthy();
    expect(hit!.url).toContain('/v1/messages');
  });
});
