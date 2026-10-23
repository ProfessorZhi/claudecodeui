import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// Real-browser landing check for the env-row kind explanations (gap-model-env-kind-explanations): jsdom
// asserts the nodes exist, but the DoD asks for the copy to be readable in a real browser and for the
// `aria-describedby` link to resolve there. Every write request is aborted at the network layer so nothing
// is persisted; the assertions only need the editor open with the gateway template expanded.

const ensureSignedIn = async (page: Page) => {
  await page.goto('/');
  const createAccount = page.getByRole('button', { name: 'Create Account' });
  const settings = page.getByRole('button', { name: 'Settings' }).first();
  await expect(createAccount.or(settings).or(page.locator('#username')).first()).toBeVisible();
  // Onboarding ends on the main UI, not on the "Choose Your Project" empty state: playwright.config.ts seeds a
  // transcript workspace, and indexing a session auto-registers its project, so a project already exists and
  // that empty state never renders. Wait for the control this spec actually uses next instead.
  const mainUi = page.getByRole('button', { name: 'Settings', exact: true }).first();
  if (await createAccount.count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').nth(0).fill('e2epassword');
    await page.locator('input[type=password]').nth(1).fill('e2epassword');
    await createAccount.click();
    await page.getByPlaceholder('John Doe').fill('E2E User');
    await page.getByPlaceholder('john@example.com').fill('e2e@example.com');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Complete Setup' }).click();
    await expect(mainUi).toBeVisible({ timeout: 30_000 });
  } else if (await page.locator('#username').count()) {
    await page.locator('#username').fill('e2euser');
    await page.locator('input[type=password]').first().fill('e2epassword');
    await page.locator('form button[type=submit]').click();
    await expect(mainUi).toBeVisible({ timeout: 30_000 });
  }
};

test.describe('model env kind explanations', () => {
  test('every kind explains itself in the browser and unset is linked via aria-describedby', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await ensureSignedIn(page);

    await page.route('**/api/**', (route) => (
      route.request().method() === 'GET' || route.request().method() === 'HEAD'
        ? route.continue()
        : route.abort()
    ));

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await page.getByRole('button', { name: 'Agents' }).click();
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page.getByText('Model library')).toBeVisible();
    await page.getByRole('button', { name: 'Gateway template' }).click();

    const rows = page.getByTestId('model-env-row');
    await expect(rows).toHaveCount(6);
    // Every row carries an explanation, not just the envref row that already had one.
    await expect(page.getByTestId('model-env-kind-help')).toHaveCount(6);

    // The gateway template's last row is the `unset` ANTHROPIC_API_KEY row.
    const unsetRow = rows.nth(5);
    const unsetHelp = unsetRow.getByTestId('model-env-kind-help');
    await expect(unsetHelp).toBeVisible();
    await expect(unsetHelp).toHaveText(/removes this variable/i);
    // Rendered copy, not a raw i18n key.
    expect(await unsetHelp.textContent()).not.toContain('modelLibrary.env.kindsHelp');

    // The explanation is the accessible description of both the name field and the kind select.
    const helpId = await unsetHelp.getAttribute('id');
    expect(helpId).toBeTruthy();
    await expect(unsetRow.getByLabel('Variable name')).toHaveAttribute('aria-describedby', helpId as string);
    await expect(unsetRow.getByLabel('Row type')).toHaveAttribute('aria-describedby', helpId as string);

    // Switching the kind swaps the explanation with it.
    const firstKind = rows.first().getByLabel('Row type');
    await firstKind.selectOption('unset');
    await expect(rows.first().getByTestId('model-env-kind-help')).toHaveText(/removes this variable/i);
    await firstKind.selectOption('secret');
    await expect(rows.first().getByTestId('model-env-kind-help')).toHaveText(/write-only/i);
  });
});
