// Drives the real app (tests/browser_server.py, fake cloud adapters) and captures screenshots.
const path = require('path');
const WT = process.argv[2], OUT = process.argv[3], BASE = process.argv[4];
const { chromium } = require(path.join(WT, 'node_modules/playwright'));
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(OUT, n), fullPage: false });
  const waitSaved = () => page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent === 'Saved', null, { timeout: 15000 });
  const items = (sel) => page.locator(sel).allInnerTexts();
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector('#address').disabled, null, { timeout: 15000 });
  await waitSaved();
  await page.locator('#shotList').scrollIntoViewIfNeeded();
  log('1. Empty room checklist:', JSON.stringify(await items('#shotList .shot-items li')));
  log('   unset hint:', await page.locator('#shotList .shot-unset').innerText());
  await shot('01-walk-checklist-empty.png');
  const add = async () => {
    const data = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#467'; g.fillRect(0, 0, 200, 300); return c.toDataURL('image/png'); });
    await page.locator('#photoFileInput').setInputFiles({ name: 'room.png', mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64') });
  };
  await add();
  await page.locator('#shotPicker').waitFor({ state: 'visible' });
  log('2. Picker label:', await page.locator('#shotPickerLabel').innerText(), '| choices:', JSON.stringify(await items('#shotPickerChoices button')));
  await page.locator('#shotPicker').scrollIntoViewIfNeeded();
  await shot('02-quick-picker.png');
  await page.locator('#shotPickerChoices').getByRole('button', { name: 'Room overview' }).click();
  await page.locator('#shotList [data-shot-count="affected_surfaces"]').fill('3');
  await page.locator('#shotList [data-shot-count="wet_materials"]').fill('2');
  await page.locator('#shotList [data-shot-count="wet_materials"]').blur();
  for (const s of ['surface', 'meter']) { await add(); await page.locator('#shotPicker').waitFor({ state: 'visible' }); await page.locator(`#shotPickerChoices button`).filter({ hasText: s === 'surface' ? 'Affected wall or floor' : 'Meter reading' }).click(); }
  await waitSaved();
  await page.waitForTimeout(500);
  log('3. Counted checklist (3 surfaces, 2 wet):', JSON.stringify(await items('#shotList .shot-items li')));
  await page.locator('#shotList').scrollIntoViewIfNeeded();
  await shot('03-walk-checklist-counted.png');
  // Check Scope: confirm scope, then tag on a room card; confirmation must survive.
  await page.locator('.task-nav [data-task="property"]').click();
  const card = page.locator('#rooms .room').first();
  await page.locator('#scopeConfirmed').check();
  await waitSaved();
  log('4. Before card tag: scopeConfirmed =', await page.locator('#scopeConfirmed').isChecked(), '| drawer:', await card.locator('.shot-drawer > summary').innerText());
  await card.locator('.shot-drawer > summary').click();
  await card.locator('.photo .photo-shot').nth(2).selectOption('surface');
  await waitSaved(); await page.waitForTimeout(800);
  log('   After tagging 3rd photo as surface on room card: scopeConfirmed =', await page.locator('#scopeConfirmed').isChecked(),
    '| notice hidden =', await page.locator('#scopeConfirmNotice').isHidden(),
    '| record.scope_confirmed =', await page.evaluate(() => state.record.data.scope_confirmed),
    '| drawer:', await card.locator('.shot-drawer > summary').innerText());
  log('   Drawer checklist:', JSON.stringify(await card.locator('.shot-items li').allInnerTexts()));
  await card.locator('.shot-drawer').scrollIntoViewIfNeeded();
  await shot('04-check-scope-drawer-scope-still-confirmed.png');
  await page.locator('#scopeConfirmed').scrollIntoViewIfNeeded();
  await shot('05-scope-confirmed-checkbox.png');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
