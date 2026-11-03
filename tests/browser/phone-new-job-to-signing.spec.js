const { saveDraft } = require('./actions');
const { routeDocuments } = require('./v2-documents');
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
  const firstJob = await page.evaluate(() => state.draft.inspection_id);
  await page.locator('#jobMenu > summary').click();
  await page
    .locator('#jobMenu')
    .getByRole('button', { name: 'New inspection', exact: true })
    .click();
  // The blank address was already true; the new draft and its reset form arrive together.
  await expect.poll(() => page.evaluate(() => state.draft.inspection_id)).not.toBe(firstJob);
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

test.describe('price-table documents', () => {
  // A worker-handled fetch bypasses page.route in WebKit, so the audit read stays page-owned.
  test.use({ serviceWorkers: 'block' });
  for (const mode of ['range', 'single']) {
    test(
      'a price-table proposal prints its summary lines in ' + mode + ' mode at 390 px',
      async ({ page }) => {
        await routeDocuments(page, /\/api\/audit$/, mode, { breakdown: mode === 'single' });
        await page.goto('/app');
        await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
        await expect(page.locator('#saveStatus')).toHaveText('Saved');
        await page.locator('.task-nav [data-task="property"]').click();
        await page.locator('#address').fill('Synthetic price table property');
        await page.locator('#yearBuilt').fill('1960');
        await page.locator('[data-room-key="finished_sf"]').fill('10');
        await page.locator('#scopeConfirmed').check();
        await saveDraft(page);
        await expect(page.locator('#saveStatus')).toHaveText('Saved');
        await page.locator('#finishAudit').click();
        await expect(page.locator('#documents')).toBeVisible();
        const summary = page.locator('#proposalBody .estimate-summary');
        await expect(summary).toBeVisible();
        if (mode === 'range') {
          await expect(page.locator('#estimateHeading')).toHaveText('Customer estimate range');
          await expect(page.locator('#estimateRange')).toHaveText('$8,489.80–$11,896.00');
          await expect(summary.locator('thead th')).toHaveText(['', 'Low', 'High']);
          await expect(summary.locator('tbody tr').nth(1)).toContainText(
            'After-hours adjustment (20%)$1,030.00$1,545.00',
          );
          await expect(summary.locator('tbody tr').last()).toContainText(
            'Total$8,489.80$11,896.00',
          );
          await expect(page.locator('#proposalBody')).not.toContainText('FAN');
        } else {
          await expect(page.locator('#estimateHeading')).toHaveText('Price');
          await expect(page.locator('#estimateRange')).toHaveText('$8,489.80');
          await expect(summary.locator('thead th')).toHaveText(['', 'Price']);
          await expect(summary.locator('tbody tr').last()).toContainText('Total$8,489.80');
          await expect(page.locator('#proposalBody')).toContainText(
            'The price covers the itemized',
          );
          await expect(page.locator('#proposalBody .line-breakdown li')).toHaveCount(3);
        }
        await expect(page.locator('#proposalBody')).toContainText('Priced from Prices v');
        await expect(page.locator('#proposalBody')).toContainText('Sales tax (8%)');
        await expect(page.locator('#proposalBody')).toContainText('Overhead and profit (10%)');
        await fits(page, 'price-table proposal');
        // The override note the server sends the owner stays off the in-person signing screen.
        await expect(page.locator('#panel-review #quantityNotes')).toHaveCount(0);
        await expect(page.locator('#quantityNotes')).toBeHidden();
        await expect(page.locator('#proposalBody')).not.toContainText('Closet not wet');
        await page.locator('.task-nav [data-task="property"]').click();
        await expect(page.locator('#quantityNotes')).toBeVisible();
        await page.locator('#quantityNotes > summary').click();
        await expect(page.locator('#quantityNotesBody')).toContainText(
          'measured 320, entered 300 · Reason: Closet not wet',
        );
        await page.locator('.task-nav [data-task="review"]').click();
        // The itemized claim adds the Xactimate column and the adjustments before its total.
        await page.locator('[data-tab="claim"]').click();
        // Phones show the claim as cards; the Xactimate code rides on the line's card.
        await expect(page.locator('#claimCards')).toContainText('Xactimate: WTR DMO');
        await expect(page.locator('#claimItems tr').nth(1)).toContainText('WTR DMO');
        await expect(page.locator('#claimAdjustments')).toContainText(
          'After-hours adjustment (20%): $1,030.00',
        );
        await expect(page.locator('#claimAdjustments')).toContainText('Sales tax (8%): $52.80');
        await expect(page.locator('#claimTotal')).toHaveText('Itemized claim total: $8,489.80');
        await fits(page, 'price-table claim');
      },
    );
  }
});
