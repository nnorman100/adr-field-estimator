// Fills scope from technician notes on a job with one tagged photo and counted surfaces; screenshots the still-missing panel.
const path = require('path');
const WT = process.argv[2], OUT = process.argv[3], BASE = process.argv[4];
const { chromium } = require(path.join(WT, 'node_modules/playwright'));
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector('#address').disabled, null, { timeout: 15000 });
  const data = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 160; c.getContext('2d').fillRect(0, 0, 60, 80); return c.toDataURL('image/png'); });
  await page.locator('#photoFileInput').setInputFiles({ name: 'k.png', mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64') });
  await page.locator('#shotPicker').waitFor({ state: 'visible' });
  await page.locator('#shotPickerChoices').getByRole('button', { name: 'Room overview' }).click();
  await page.locator('#shotList [data-shot-count="affected_surfaces"]').fill('2');
  await page.locator('#shotList [data-shot-count="affected_surfaces"]').blur();
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('Synthetic shot list property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill('Kitchen, category 2, 80 SF drywall. Use 3 fans.');
  await page.locator('#fillScopeProperty').click();
  await page.locator('#scopeSuggestionPanel').waitFor({ state: 'visible', timeout: 20000 }).catch(async (e) => { console.log('message:', await page.locator('#message').innerText().catch(() => '?')); throw e; });
  await page.waitForTimeout(500);
  console.log('Still missing or unclear:', JSON.stringify(await page.locator('#scopeMissing li').allInnerTexts()));
  await page.locator('#scopeGapsHeading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, '07-still-missing-panel.png') });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
