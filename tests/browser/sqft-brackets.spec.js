const { test, expect } = require('@playwright/test');

async function start(page, role = 'owner') {
  await page.addInitScript(
    (uid) => sessionStorage.setItem('synthetic-uid', uid),
    'test-owner-ws-' + role,
  );
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  const menu = page.locator('#workspaceMenuToggle');
  if (await menu.isVisible()) await menu.click();
  await page.locator('#dashboardPrices').click();
  await expect(page.locator('#priceEditor')).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true, price_books: true } });
  await request.post('/__test/price-table', {
    data: { policy: { assist: { range_method: 'cushion' } } },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner edits item and cushion bands, sees drops, reloads and publishes the same bands', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await start(page);
  await expect(page.locator('[name=bracket_mode][value=tiered]')).toBeChecked();
  const item = page.locator('[data-price-item=demo_cat1_wall]');
  await item.getByRole('button', { name: 'Add price brackets', exact: true }).click();
  await item.locator('[name=price_brackets_value_0]').fill('10');
  await item.locator('[name=price_brackets_value_1]').fill('5');
  await item.getByRole('button', { name: 'Add band', exact: true }).click();
  await item.locator('[name=price_brackets_limit_1]').fill('1000');
  await item.locator('[name=price_brackets_value_2]').fill('2');
  const settings = page.locator('#priceSettings');
  await settings.getByRole('button', { name: 'Add cushion brackets', exact: true }).click();
  await settings.locator('[name=brackets_limit_0]').fill('500');
  await settings.locator('[name=brackets_value_0]').fill('50');
  await settings.locator('[name=brackets_value_1]').fill('10');
  await expect(page.locator('#priceSamples .price-boundaries')).toContainText(
    '501 sq ft: $5,005.00',
  );
  await expect(page.locator('#priceSamples .price-boundaries')).not.toContainText('Price drop');
  await page.locator('[name=bracket_mode][value="whole-job"]').check();
  await expect(page.locator('#priceSamples .price-boundaries')).toContainText(
    'Price drop at this boundary',
  );
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await page.reload();
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  const menu = page.locator('#workspaceMenuToggle');
  if (await menu.isVisible()) await menu.click();
  await page.locator('#dashboardPrices').click();
  await expect(page.locator('[name=bracket_mode][value="whole-job"]')).toBeChecked();
  await expect(item.locator('[name=price_brackets_value_2]')).toHaveValue('2.00');
  await expect(settings.locator('[name=brackets_value_1]')).toHaveValue('10');
  await page.locator('#priceReason').fill('Set square-foot prices and cushions');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(page.locator('#priceReview')).toContainText('square-foot price brackets');
  await expect(page.locator('#priceReview')).toContainText('Cushion brackets');
  await page.getByRole('button', { name: 'Publish prices', exact: true }).click();
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  await expect(item.locator('[name=price_brackets_value_2]')).toHaveValue('2.00');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.context().setOffline(true);
  await expect(item.locator('[name=price_brackets_value_0]')).toBeDisabled();
  await expect(item.getByRole('button', { name: 'Add band', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('office and estimator can read bracket schedules but cannot edit them', async ({
  page,
  request,
}) => {
  await request.post('/__test/price-table', {
    data: {
      items: {
        demo_cat1_wall: {
          price_brackets: [
            { up_to_sf: 500, unit_price: '10' },
            { up_to_sf: null, unit_price: '5' },
          ],
        },
      },
      policy: {
        bracket_mode: 'whole-job',
        range: {
          brackets: [
            { up_to_sf: 500, percent: '50' },
            { up_to_sf: null, percent: '10' },
          ],
        },
      },
    },
  });
  for (const role of ['office', 'estimator']) {
    await start(page, role);
    await expect(
      page.locator('[data-price-item=demo_cat1_wall] [name=price_brackets_value_0]'),
    ).toBeDisabled();
    await expect(page.locator('[name=brackets_value_0]')).toBeDisabled();
    await expect(page.locator('[name=bracket_mode][value="whole-job"]')).toBeChecked();
    await expect(page.locator('[name=bracket_mode][value="whole-job"]')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add band', exact: true })).toHaveCount(0);
  }
});

test('changing away from an area item clears brackets and returning shows an empty editor', async ({
  page,
}) => {
  await start(page);
  const item = page.locator('[data-price-item=demo_cat1_wall]');
  await item.getByRole('button', { name: 'Add price brackets', exact: true }).click();
  await expect(item.locator('[name=price_brackets_value_0]')).toBeVisible();
  await item.locator('.price-more > summary').click();
  await item
    .getByRole('combobox', { name: 'Quantity comes from', exact: true })
    .selectOption('typed');
  await expect(item.locator('[name=price_brackets_value_0]')).toHaveCount(0);
  await item
    .getByRole('combobox', { name: 'Quantity comes from', exact: true })
    .selectOption('room:demolition:finished');
  await expect(item.getByRole('button', { name: 'Add price brackets', exact: true })).toBeVisible();
  await expect(item.locator('[name=price_brackets_value_0]')).toHaveCount(0);
  await item.getByRole('button', { name: 'Add price brackets', exact: true }).click();
  await expect(item.locator('[name=price_brackets_value_0]')).toHaveValue('25.00');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
});

test('an owner can save and reload blank price brackets before entering prices', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // WebKit reports a sample request cut off by the reload as a page error, so the reload waits
  // for the sample the new brackets ask for and until none is in flight.
  let sampling = 0;
  const isSample = (sent) => sent.url().endsWith('/prices/calculate');
  page.on('request', (sent) => isSample(sent) && sampling++);
  page.on('requestfinished', (sent) => isSample(sent) && sampling--);
  page.on('requestfailed', (sent) => isSample(sent) && sampling--);
  await start(page);
  const item = page.locator('[data-price-item=demo_cat1_wall]');
  await item.locator('[name=price_demo_cat1_wall]').fill('');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  const bracketSample = page.waitForResponse(
    (answer) =>
      isSample(answer.request()) &&
      answer
        .request()
        .postDataJSON()
        .items.some((sent) => sent.item_id === 'demo_cat1_wall' && sent.price_brackets?.length),
  );
  await item.getByRole('button', { name: 'Add price brackets', exact: true }).click();
  await expect(item.locator('[name=price_brackets_value_0]')).toHaveValue('');
  await expect(item.locator('[name=price_brackets_value_1]')).toHaveValue('');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceProblems')).toContainText('1 item needs a price');
  await bracketSample;
  await expect.poll(() => sampling).toBe(0);
  await start(page);
  await expect(item.locator('[name=price_brackets_value_0]')).toHaveValue('');
  await expect(item.locator('[name=price_brackets_value_1]')).toHaveValue('');
  await item.locator('[name=price_brackets_value_0]').fill('10');
  await item.locator('[name=price_brackets_value_1]').fill('5');
  await expect(page.locator('#priceSaveStatus')).toContainText('Saved');
  await expect(page.locator('#priceProblems')).toBeHidden();
  await expect(page.locator('#priceSettings')).toContainText(
    'With the default two-step cushion, whole-job mode brings back the 1,001 sq ft step even if you have not added any brackets.',
  );
  expect(errors).toEqual([]);
});
