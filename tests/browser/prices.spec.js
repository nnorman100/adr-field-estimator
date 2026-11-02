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

test('a company with no prices is told to set them, sees no ADR rate, then prices from its own', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', {
    data: {
      enabled: true,
      price_books: true,
      other_prices: false,
      ai_features: ['priced_extras'],
    },
  });
  await start(page, 'other');
  const adrRates = /133\.95|47\.46|1,180\.20|159\.53|Workbook seed|workbook seed/;
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  await expect(page.locator('#pricesNotSet')).toBeVisible();
  await expect(page.locator('#pricesNotSetText')).toHaveText(
    'Set your company prices before your first estimate.',
  );
  await expect(page.locator('#jobChargesSummary')).toHaveText('· sheet quantities');
  await expect(page.locator('#afterHoursLabel')).toHaveText(
    'After-hours loss: company after-hours job charge and 20% labor/material adjustment.',
  );
  await page.locator('#address').fill('Other company synthetic property');
  await page.locator('#yearBuilt').fill('2000');
  await page.locator('[data-room-key=finished_sf]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('body')).toContainText(
    'Set your company prices before your first estimate. Open Company prices from the menu.',
  );
  await expect(page.locator('#documents')).toBeHidden();

  await page.getByRole('button', { name: 'Set company prices' }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices not set.');
  await expect(page.locator('#dashboardContent')).not.toContainText(adrRates);
  await expect(page.locator('input[name=emergency_call]')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  for (const input of await page.locator('input[data-price-key]').all()) await input.fill('12.34');
  await page.locator('textarea[name=change_reason]').fill('Our first prices');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('not set to 12.34');
  await expect(page.locator('#priceReview')).not.toContainText('Sample before');
  await expect(page.locator('#priceReview')).not.toContainText(adrRates);
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v1.');
  await expect(page.locator('input[name=emergency_call]')).toHaveValue('12.34');

  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Other company synthetic property/ }).click();
  await expect(page.locator('#pricesNotSet')).toBeHidden();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#proposalBody')).toContainText('Priced from Prices v1.');
  await expect(page.locator('body')).not.toContainText(adrRates);
});

test('ADR still sees its own prices on the estimate form, from the API', async ({ page }) => {
  await start(page, 'estimator');
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#jobChargesSummary')).toHaveText('· $1,180.20 at sheet quantities');
  await expect(page.locator('#afterHoursLabel')).toHaveText(
    "After-hours loss: $200 job charge and 20% labor/material adjustment. Added labor uses the sheet's $47.46/hr estimate formula.",
  );
  await expect(page.locator('#pricesNotSet')).toBeHidden();
});
