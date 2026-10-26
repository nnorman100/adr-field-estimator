const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;

async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function navigate(page, id) {
  await expect(page.locator('#workspaceNav')).toBeVisible();
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator('#' + id).click();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, price_books: true, ai_features: ['priced_extras'] },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner publishes a price, keeps the saved draft, then applies it to that draft', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await start(page, 'owner');
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#estimateRange')).toHaveText('$1,775.00–$1,788.90');
  await expect(page.locator('#proposalBody')).toContainText('Priced from workbook seed.');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  const trip = page.locator('input[name=emergency_call]');
  await trip.focus();
  await trip.fill('200');
  await page.locator('textarea[name=change_reason]').fill('Raise the trip charge');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('133.95 to 200.00');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v1');
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#estimateRange')).toHaveText('$1,775.00–$1,788.90');
  await expect(page.locator('#proposalBody')).toContainText('Priced from workbook seed.');
  await expect(page.locator('#jobPricingStatus')).toContainText('Newer company prices');
  await page.getByRole('button', { name: 'Review new prices for this job' }).click();
  await page.getByRole('button', { name: 'Apply these prices to this job only' }).click();
  await expect(page.locator('#documents')).toBeHidden();
  await expect(page.locator('#scopeConfirmed')).not.toBeChecked();
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#proposalBody')).toContainText('Priced from Prices v1.');
  await page.locator('#helpButton').click();
  await expect(page.locator('[data-help-topic="prices"]')).toBeVisible();
  await page.locator('#closeHelp').click();
  await navigate(page, 'dashboardPrices');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  }
  expect(errors).toEqual([]);
});

test('estimator and support can read prices and cannot publish them', async ({ page }) => {
  await start(page, 'estimator');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('input[name=emergency_call]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish prices' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0);
  await start(page, 'owner');
  await navigate(page, 'dashboardAdmin');
  await page.getByRole('button', { name: 'Manage company' }).first().click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: 'Company prices (read only)' }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await expect(page.getByRole('button', { name: 'Publish prices' })).toHaveCount(0);
  await expect(page.locator('input[name=emergency_call]')).toBeDisabled();
});

test('a second publish of a stale review is refused and offline does not queue it', async ({
  page,
  browser,
}) => {
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  await page.locator('input[name=emergency_call]').fill('180');
  await page.locator('textarea[name=change_reason]').fill('First published trip charge');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const other = await browser.newPage();
  await other.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    uid('owner'),
  );
  await other.goto('/app');
  await expect(other.locator('#workspaceDashboard')).toBeVisible();
  const toggle = other.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) await toggle.click();
  await other.locator('#dashboardPrices').click();
  await other.locator('input[name=emergency_call]').fill('190');
  await other.locator('textarea[name=change_reason]').fill('Second published trip charge');
  await other.getByRole('button', { name: 'Review changes' }).click();
  await other.getByRole('button', { name: 'Publish prices' }).click();
  await expect(other.locator('#dashboardContent')).toContainText('Prices v1');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#message')).toContainText('Prices changed');
  await page.context().setOffline(true);
  await expect(page.locator('#offlineBanner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish prices' })).toBeDisabled();
  await page.context().setOffline(false);
  await other.close();
});
