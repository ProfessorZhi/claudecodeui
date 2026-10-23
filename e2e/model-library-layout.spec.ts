import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Layout regression guard for Settings → Agents → Models (AC-026). jsdom does no layout, so overflow and
// occlusion can only be asserted in a real browser. Every write request is aborted at the network layer so
// nothing is persisted; the assertions only need the editor open with the gateway template expanded.

const VIEWPORTS = [390, 900, 1440, 1920];
const WIDE_INPUT_MIN_PX = 250;
const WIDE_VIEWPORT_MIN_PX = 1024;
const MOBILE_MAX_PX = 768;

const ensureSignedIn = async (page: Page) => {
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
    // The app shell being up is what "signed in" means here — NOT the "Choose Your Project" empty state.
    // playwright.config.ts seeds the session-filter transcripts before boot and the boot scan auto-registers
    // their project, so that empty state does not render; waiting for it is a race (see that file's comment).
    await expect(settings).toBeVisible({ timeout: 15_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
    await expect(settings).toBeVisible({ timeout: 15_000 });
  }
};

test.describe('model library editor layout', () => {
  for (const width of VIEWPORTS) {
    test(`editor does not overflow and controls are reachable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await ensureSignedIn(page);

      const writes: string[] = [];
      await page.route('**/api/**', (route) => {
        const method = route.request().method();
        if (method === 'GET' || method === 'HEAD') {
          return route.continue();
        }
        // Unrelated app chatter (e.g. notification preferences) is aborted too, but only model-library writes count.
        if (/\/api\/providers\/[^/]+\/models/.test(route.request().url())) {
          writes.push(`${method} ${route.request().url()}`);
        }
        return route.abort();
      });

      // On phones the floating "Settings" handle opens Quick Settings; the full modal lives behind the sidebar menu.
      if (width < MOBILE_MAX_PX) {
        await page.getByRole('button', { name: 'Open menu' }).click();
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
      await page.getByRole('button', { name: 'Agents' }).click();
      await page.getByRole('tab', { name: 'Models' }).click();
      await expect(page.getByText('Model library')).toBeVisible();
      await page.getByRole('button', { name: 'Gateway template' }).click();

      const editor = page.getByTestId('model-env-editor');
      const rows = page.getByTestId('model-env-row');
      await expect(rows).toHaveCount(6);

      // (a) no horizontal overflow inside the editor
      const overflow = await editor.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      console.log(`[layout ${width}px] editor scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth}`);
      expect(overflow.scrollWidth, `scrollWidth ${overflow.scrollWidth} vs clientWidth ${overflow.clientWidth}`).toBe(overflow.clientWidth);

      // (c) the variable-name input is wide enough on desktop viewports
      const keyInput = rows.first().getByLabel('Variable name');
      const inputWidth = await keyInput.evaluate((node) => node.getBoundingClientRect().width);
      console.log(`[layout ${width}px] key input width=${Math.round(inputWidth)}`);
      if (width >= WIDE_VIEWPORT_MIN_PX) {
        expect(inputWidth).toBeGreaterThanOrEqual(WIDE_INPUT_MIN_PX);
      }

      // (b) the "+ Add" button is what actually sits at its own centre, and clicking it adds a row
      const addButton = editor.getByRole('button', { name: /Add/ }).first();
      await addButton.scrollIntoViewIfNeeded();
      const hit = await addButton.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { covered: !(top && (top === node || node.contains(top))), topElement: top ? top.outerHTML.slice(0, 120) : null };
      });
      expect(hit.covered, `elementFromPoint returned ${hit.topElement}`).toBe(false);
      await addButton.click();
      await expect(rows).toHaveCount(7);

      expect(writes).toEqual([]);
    });
  }
});
