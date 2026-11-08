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
function registerPriceHooks() {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', {
      data: { enabled: true, price_books: true, ai_features: ['priced_extras'] },
    });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });
}

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
  // The evaluate below does not wait: on a page still loading it would find no inputs to fill.
  await expect(page.locator('#priceEditor')).toBeVisible();
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

module.exports = {
  uid,
  start,
  navigate,
  startUnset,
  priceEverything,
  publishTable,
  registerPriceHooks,
};
