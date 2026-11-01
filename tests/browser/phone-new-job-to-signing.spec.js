const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');
// One continuous pass at a 390 px phone width: create a new job, scope it, review the proposal and
// sign it. Every step must fit the screen without sideways scrolling.
test.use({ viewport: { width: 390, height: 844 } });
const fits = async (page, step) =>
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    step + ' scrolls sideways',
  ).toBeLessThanOrEqual(0);
async function inView(page, selector, step) {
  const box = await page.locator(selector).boundingBox();
  expect(box, step + ' ' + selector).not.toBeNull();
  expect(box.x, step + ' ' + selector + ' left edge').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, step + ' ' + selector + ' right edge').toBeLessThanOrEqual(390);
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 20, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.45, rect.y + 90, { steps: 8 });
  await page.mouse.move(rect.x + rect.width * 0.8, rect.y + 30, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => !!state.signature)).toBe(true);
}

test('a new job goes from creation to a signed proposal at 390 px', async ({ page }) => {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // Start a new job from the phone's More menu.
  await page.locator('#jobMenu > summary').click();
  await page
    .locator('#jobMenu')
    .getByRole('button', { name: 'New inspection', exact: true })
    .click();
  await expect(page.locator('#address')).toHaveValue('');
  await fits(page, 'new job');
  await page.locator('.task-nav [data-task="property"]').click();
  await inView(page, '#address', 'scope');
  await page.locator('#address').fill('Synthetic phone property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await fits(page, 'check scope');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await page.locator('#finishAudit').scrollIntoViewIfNeeded();
  await inView(page, '#finishAudit', 'finish');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#estimateRange')).toHaveText('$1,208.00–$1,221.90');
  await expect(page.locator('#itemizedTotal')).toHaveText('$1,208.00');
  await fits(page, 'proposal');
  for (const name of ['proposal', 'claim', 'defense', 'photos'])
    await inView(page, '[data-tab="' + name + '"]', 'document tab');
  await expect(page.locator('#proposalBody')).toContainText('Itemized scope total: $1,208.00');
  await page.locator('#documentsConfirmed').check();
  await draw(page);
  await fits(page, 'signature');
  await inView(page, '#authorizeJob', 'sign');
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
  await fits(page, 'signed');
});
