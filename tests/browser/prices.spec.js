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
  await expect(page.locator('#proposalBody')).toContainText('Priced from ADR starting prices.');
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
  await expect(page.locator('#proposalBody')).toContainText('Priced from ADR starting prices.');
  await expect(page.locator('#jobPricingStatus')).toContainText(
    'This job is priced from ADR starting prices.',
  );
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
  const adrRates =
    /133\.95|47\.46|1,180\.20|159\.53|Workbook seed|workbook seed|ADR starting prices/;
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  await expect(page.locator('#pricesNotSet')).toBeVisible();
  await expect(page.locator('#pricesNotSetText')).toHaveText(
    'Set your company prices before your first estimate. Open Company prices from the menu.',
  );
  await expect(page.locator('#jobPricing')).toBeHidden();
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
  await expect(page.locator('#jobPricing')).toBeHidden();

  await page.getByRole('button', { name: 'Set company prices' }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await expect(page.locator('#dashboardContent')).not.toContainText(adrRates);
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  // The Prices screen now offers the starter table; a rate book published through the API still
  // proves that a company's own prices, and nothing of ADR's, price a job end to end.
  const preview = await page.evaluate(async () => {
    const base = '/api/companies/' + state.session.company_id + '/prices';
    const view = await jsonApi(base);
    const rates = Object.fromEntries(view.rates.map((row) => [row.key, '12.34']));
    const reviewed = await jsonApi(base + '/preview', 'POST', {
      rates,
      change_reason: 'Our first prices',
    });
    await jsonApi(base + '/publish', 'POST', {
      preview_id: reviewed.preview_id,
      expected_generation: reviewed.generation,
    });
    return reviewed;
  });
  expect(preview.diff[0].before).toBeFalsy();
  expect(preview.diff[0].after).toBe('12.34');
  expect(preview.sample_before).toBeNull();
  expect(JSON.stringify(preview)).not.toMatch(adrRates);
  await page.reload();
  await navigate(page, 'dashboardPrices');
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

test('a company with no prices sets up and publishes its first table from the starter list', async ({
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
  const adrRates =
    /133\.95|47\.46|1,180\.20|159\.53|Workbook seed|workbook seed|ADR starting prices/;
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#priceEditor')).toBeVisible();
  await expect(page.locator('#dashboardContent')).toContainText('Prices: not set up yet');
  await expect(page.locator('#dashboardContent')).not.toContainText(adrRates);
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('');
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  await priceEverything(page, '12.34');
  await page.locator('#priceReason').fill('Our first prices');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('Added');
  await expect(page.locator('#priceReview')).not.toContainText(adrRates);
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v1');
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('12.34');
});

test('an open job form picks up prices published on another device', async ({ page, request }) => {
  await request.post('/__test/workspaces', {
    data: {
      enabled: true,
      price_books: true,
      other_prices: false,
      ai_features: ['priced_extras'],
    },
  });
  await start(page, 'other');
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  await expect(page.locator('#pricesNotSet')).toBeVisible();
  await expect(page.locator('#jobChargesSummary')).toHaveText('· sheet quantities');

  await page.evaluate(async () => {
    const view = await jsonApi('/api/companies/other/prices');
    const preview = await jsonApi('/api/companies/other/prices/preview', 'POST', {
      rates: Object.fromEntries(view.rates.map((row) => [row.key, '12.34'])),
      change_reason: 'Published on another device',
    });
    await jsonApi('/api/companies/other/prices/publish', 'POST', {
      preview_id: preview.preview_id,
      expected_generation: preview.generation,
    });
  });
  await expect(page.locator('#pricesNotSet')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(page.locator('#pricesNotSet')).toBeHidden();
  await expect(page.locator('#jobChargesSummary')).toHaveText(
    /^· \$[\d,]+\.\d\d at sheet quantities$/,
  );
  await expect(page.locator('#afterHoursLabel')).toContainText('$12.34 job charge');
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

// --- Owner price-table editor (calculation dryscope-v2) ---

async function startUnset(page, request, role = 'owner') {
  await request.post('/__test/workspaces', {
    data: {
      enabled: true,
      price_books: true,
      prices_unset: true,
      ai_features: ['priced_extras'],
    },
  });
  await start(page, role);
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await expect(page.locator('#priceEditor')).toBeVisible();
}
// Gives every blank price on the page a value, the way an owner would row by row.
async function priceEverything(page, value = '10.00') {
  await page.evaluate((price) => {
    document.querySelectorAll('details.price-group').forEach((d) => (d.open = true));
    for (const input of document.querySelectorAll('input[name^="price_"]')) {
      if (input.value) continue;
      input.value = price;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, value);
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
}
async function publishTable(page, reason = 'First price table') {
  await page.locator('#priceReason').fill(reason);
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v1');
}

test('owner builds a table from the starter, keeps a working copy across a reload and publishes it', async ({
  page,
  request,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startUnset(page, request);
  await expect(page.locator('#dashboardContent')).toContainText('Prices: not set up yet');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  // The starter carries no prices and nothing of any company's.
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('');
  await expect(page.locator('#dashboardContent')).not.toContainText('133.95');
  await page.locator('input[name=price_service_call]').fill('150');
  await page.locator('input[name=policy_after_hours\\.label]').fill('Night and weekend work');
  await page.locator('input[name=policy_minimum_job_charge]').fill('350');
  await page.locator('input[name=policy_range\\.first_sf]').fill('1200');
  await page.locator('input[name=policy_overhead_profit_percent]').fill('10');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await expect(page.locator('#priceUnpublished')).toContainText('not published');

  // Blank prices cannot be published: the owner is told what is missing and nothing is published.
  await page.locator('#priceReason').fill('First price table');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#message')).toContainText('unit price');
  await expect(page.locator('#priceReview')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('150.00');
  await expect(page.locator('input[name=policy_after_hours\\.label]')).toHaveValue(
    'Night and weekend work',
  );
  await expect(page.locator('input[name=policy_minimum_job_charge]')).toHaveValue('350');
  await expect(page.locator('input[name=policy_range\\.first_sf]')).toHaveValue('1200');
  await expect(page.locator('input[name=policy_overhead_profit_percent]')).toHaveValue('10');

  await priceEverything(page);
  await publishTable(page);
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('150.00');
  expect(errors).toEqual([]);
});

test('discarding unpublished changes restores the published table', async ({ page, request }) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  const price = page.locator('input[name=price_service_call]');
  await price.fill('999');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await expect(page.locator('#priceUnpublished')).toContainText('Unpublished changes');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(price).toHaveValue('999');
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await page.getByRole('button', { name: 'Yes, discard' }).click();
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('10.00');
});

test('estimator and support read the items and settings but cannot change them', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  await start(page, 'estimator');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('#dashboardContent')).toContainText('Read only');
  await expect(page.locator('input[name=price_service_call]')).toBeDisabled();
  await expect(page.locator('input[name=policy_minimum_job_charge]')).toBeDisabled();
  // A reader's list holds only items in use, so it shows none of them as switched off.
  await expect(page.locator('.price-off')).toHaveCount(0);
  await expect(page.getByLabel('Used on estimates')).toHaveCount(0);
  await expect(page.getByLabel('Allow a zero price')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish prices' })).toHaveCount(0);
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await start(page, 'owner');
  await navigate(page, 'dashboardAdmin');
  await page.getByRole('button', { name: 'Manage company' }).first().click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: 'Company prices (read only)' }).click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company prices');
  await expect(page.locator('input[name=price_service_call]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Publish prices' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review changes' })).toHaveCount(0);
});

test('a stale review is refused and the editor is disabled offline', async ({
  page,
  browser,
  request,
}) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  await page.locator('input[name=price_service_call]').fill('11');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.locator('#priceReason').fill('Raise the service call');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('Emergency service call');
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
  await other.locator('input[name=price_service_call]').fill('12');
  await other.locator('#priceReason').fill('Another phone');
  await other.getByRole('button', { name: 'Review changes' }).click();
  await other.getByRole('button', { name: 'Publish prices' }).click();
  await expect(other.locator('#dashboardContent')).toContainText('Prices v2');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#message')).toContainText('Prices changed');
  await page.context().setOffline(true);
  await expect(page.locator('#offlineBanner')).toBeVisible();
  await expect(page.locator('input[name=price_service_call]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  await page.context().setOffline(false);
  await other.close();
});

// WebKit does not show requests that go through the service worker to page.route.
test.describe('review and samples', () => {
  test.use({ serviceWorkers: 'block' });
  test('the review lists the change, large-change and zero-price warnings, and samples follow the price', async ({
    page,
    request,
  }) => {
    await startUnset(page, request);
    await priceEverything(page);
    await publishTable(page);
    // The sample engine ships separately: answer the calculate call the way it will.
    await page.route('**/prices/calculate', async (route) => {
      const body = route.request().postDataJSON();
      const call = body.items.find((item) => item.item_id === 'service_call');
      const low = '$' + Number(call.unit_price).toFixed(2);
      await route.fulfill({
        json: {
          problems: [],
          samples: ['small', 'medium', 'large'].map((key) => ({
            key,
            label: 'The ' + key + ' sample',
            description: 'A made-up job.',
            itemized: low,
            low,
            high: null,
            mode: 'single',
          })),
        },
      });
    });
    const call = page.locator('input[name=price_service_call]');
    await call.fill('40');
    await expect(page.locator('#priceSamples')).toContainText(
      'The medium sample prices at $40.00.',
    );
    await call.fill('55');
    await expect(page.locator('#priceSamples')).toContainText(
      'The medium sample prices at $55.00.',
    );
    await page.getByText('Show all three samples').click();
    await expect(page.locator('#priceSamples')).toContainText('The small sample prices at $55.00.');
    await expect(page.locator('#priceSamples')).toContainText('The large sample prices at $55.00.');

    await call.fill('0');
    await expect(page.locator('#priceSaveStatus')).toContainText('zero');
    await page.locator('[data-price-item="service_call"] summary', { hasText: 'More' }).click();
    await page.getByLabel('Allow a zero price').first().check();
    await page.getByLabel('I confirm this zero price is intentional.').first().check();
    await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
    await page.locator('#priceReason').fill('Free service call');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await expect(page.locator('#priceReview')).toContainText('zero price');
    await expect(page.locator('#priceReview')).toContainText('Emergency service call');
    await page.locator('input[name=policy_sales_tax\\.percent]').fill('8');
    await page.getByLabel('Charge sales tax on items marked taxable').check();
    await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await expect(page.locator('#priceReview')).toContainText('Sales tax');
    await expect(page.locator('#priceReview')).toContainText('Sales tax settings changed');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
  });
});

test('a new item is added to a group, saved and moved', async ({ page, request }) => {
  await startUnset(page, request);
  const group = page.locator('details.price-group[data-group=labor]');
  await group.locator('> summary').click();
  await group.getByLabel('New item name in Labor').fill('Content cleaning crew');
  await group.getByRole('button', { name: 'Add item' }).click();
  const added = page.locator('[data-price-item=content_cleaning_crew]');
  await expect(added).toBeVisible();
  await added.getByText('More', { exact: true }).click();
  await expect(added.getByLabel('Short code on the claim')).toHaveCount(0);
  await added.locator('input[name=price_content_cleaning_crew]').fill('44');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  for (let step = 0; step < 3; step += 1) {
    await added.getByRole('button', { name: 'Move up' }).click();
  }
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.reload();
  await navigate(page, 'dashboardPrices');
  await page.locator('details.price-group[data-group=labor] > summary').click();
  await expect(
    page.locator('details.price-group[data-group=labor] input[name=price_content_cleaning_crew]'),
  ).toHaveValue('44.00');
  await expect(
    page.locator('details.price-group[data-group=labor] [data-price-item]').first(),
  ).toHaveAttribute('data-price-item', 'content_cleaning_crew');
});

test('an estimator of a company with no prices is not told to enter them', async ({
  page,
  request,
}) => {
  await startUnset(page, request, 'estimator');
  await expect(page.locator('#dashboardContent')).toContainText('Read only');
  await expect(page.locator('#dashboardContent')).not.toContainText('Enter your prices');
  await expect(page.locator('.price-off')).toHaveCount(0);
});

test('a change after the review closes it, so publishing cannot drop the change', async ({
  page,
  request,
}) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  const price = page.locator('input[name=price_service_call]');
  await price.fill('11');
  await page.locator('#priceReason').fill('Raise the service call');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('$11.00');
  await price.fill('12');
  await expect(page.locator('#priceReview')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish prices' })).toHaveCount(0);
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText('$12.00');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Prices v2');
  await expect(price).toHaveValue('12.00');
});

test('reopening Prices keeps an edit still waiting to save', async ({ page, request }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  await page.locator('input[name=price_service_call]').fill('77');
  await navigate(page, 'dashboardPrices');
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('77.00');
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  // Nothing fires later from the page that was replaced.
  await page.waitForTimeout(900);
  await expect(page.locator('input[name=price_service_call]')).toHaveValue('77.00');
  expect(errors).toEqual([]);
});

test('confirming a zero price clears the problem it raised', async ({ page, request }) => {
  await startUnset(page, request);
  await priceEverything(page);
  await publishTable(page);
  const row = page.locator('[data-price-item=service_call]');
  await row.getByText('More', { exact: true }).click();
  await row.getByLabel('Allow a zero price').check();
  await row.locator('input[name=price_service_call]').fill('0');
  await expect(row.locator('.price-problem')).toContainText('confirm');
  await row.getByLabel('I confirm this zero price is intentional.').check();
  await expect(row.locator('.price-problem')).toHaveText('');
});

function csvRows(text) {
  const rows = [[]];
  let cell = '',
    quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quoted && char === '"' && text[at + 1] === '"') {
      cell += '"';
      at += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) {
      rows[rows.length - 1].push(cell);
      cell = '';
    } else if (char === '\n' && !quoted) {
      rows[rows.length - 1].push(cell);
      cell = '';
      rows.push([]);
    } else cell += char;
  }
  return rows.filter((row) => row.length > 1);
}
function csvText(rows) {
  return rows
    .map((row) => row.map((cell) => '"' + cell.replaceAll('"', '""') + '"').join(','))
    .join('\n');
}

test('a starter company imports its template, confirms a zero price and is warned about its working copy', async ({
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
  await navigate(page, 'dashboardPrices');
  await page.locator('input[name=price_service_call]').fill('33');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  const template = await page.evaluate(async () => {
    const base = '/api/companies/' + state.session.company_id + '/prices';
    return (await api(base + '/export?format=csv&version_id=starter')).text();
  });
  const rows = csvRows(template.replace(/^\ufeff/, '')),
    [header, ...body] = rows,
    price = header.indexOf('unit_price'),
    allow = header.indexOf('allow_zero');
  for (const row of body) row[price] = '10.00';
  body[0][price] = '0.00';
  body[0][allow] = 'yes';
  const file = {
    name: 'prices.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csvText([header, ...body]) + '\n'),
  };
  await page.locator('#priceImportFile').setInputFiles(file);
  await page.locator('#priceImportReason').fill('Prices from our spreadsheet');
  await page.getByRole('button', { name: 'Import prices' }).click();
  await expect(page.locator('#message')).toContainText('confirm that a zero unit price');
  await expect(page.locator('#priceReview')).toHaveCount(0);

  await page.getByLabel('Zero prices in this file are intentional').check();
  await page.getByRole('button', { name: 'Import prices' }).click();
  await expect(page.locator('#priceReview')).toContainText('zero price');
  await expect(page.locator('#priceReview')).toContainText('replaces your unpublished changes');
  await page.getByRole('button', { name: 'Publish prices' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Current: Prices v1');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await expect(page.locator('input[name=price_service_call]')).not.toHaveValue('33.00');
});
