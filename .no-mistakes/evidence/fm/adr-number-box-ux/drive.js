const { chromium } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56A20QSWY73NTGBJ0JX398P/node_modules/playwright');
const [port, label, outDir] = process.argv.slice(2);
const out = {};
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const puts = [], posts = [];
  page.on('request', (r) => {
    if (!r.url().includes('/api/inspections')) return;
    if (r.method() === 'PUT') puts.push(r.postDataJSON()?.data?.dehumidifiers);
    if (r.method() === 'POST' && !r.url().includes('/photos')) posts.push(r.url());
  });
  await page.goto(`https://localhost:${port}/`);
  await page.locator('#address').waitFor();
  await page.waitForFunction(() => !document.querySelector('#address').disabled, null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('Saved privately'), null, { timeout: 15000 });
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('1234 Acme St');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#saveDraft').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('Saved privately'));
  const box = page.locator('#dehumidifiers');
  out.inputmode = await box.getAttribute('inputmode');
  out.laborInputmode = await page.locator('#laborHours').getAttribute('inputmode');
  out.roomInputmode = await page.locator('[data-room-key="finished_sf"]').getAttribute('inputmode');
  out.before = await box.inputValue();
  // Touch-like tap at the right edge of the box (where iPhone parks the caret after "0").
  await box.scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('#dehumidifiers').scrollIntoView({ block: 'center' }));
  const bb = await box.boundingBox();
  await page.mouse.click(bb.x + bb.width - 30, bb.y + bb.height / 2);
  await page.keyboard.type('1');
  out.afterTyping1 = await box.inputValue();
  out.confirmedAfterEdit = await page.locator('#scopeConfirmed').isChecked();
  out.noticeVisible = await page.locator('#scopeConfirmNotice').isVisible().catch(() => false);
  out.noticeText = (await page.locator('#scopeConfirmNotice').count()) ? await page.locator('#scopeConfirmNotice').textContent() : null;
  await page.screenshot({ path: `${outDir}/${label}-after-typing-1-box.png` });
  await page.evaluate(() => document.querySelector('#scopeConfirmed').scrollIntoView({ block: 'center' }));
  await page.screenshot({ path: `${outDir}/${label}-after-typing-1-confirm.png` });
  // Tidy as a technician would: blur the field, then save.
  await page.locator('#technicianNotes').click();
  await page.locator('#saveDraft').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('Saved privately'));
  out.savedValue = await page.evaluate(() => state.draft.data.dehumidifiers);
  if (label === 'after') {
    // Adversarial: re-focus a box that holds a non-zero value and type 2: replaces, not "12".
    await box.click();
    await page.keyboard.type('2');
    out.retype2 = await box.inputValue();
    // Decimal box: type 2.5 into laborHours (prefilled 0).
    await page.locator('#laborHours').click();
    await page.keyboard.type('2.5');
    out.labor = await page.locator('#laborHours').inputValue();
    // Notice clears when the technician re-ticks.
    await page.locator('#scopeConfirmed').check();
    out.noticeAfterRetick = await page.locator('#scopeConfirmNotice').isVisible();
    // Untick manually, then edit: no stale notice for a box that was not ticked.
    await page.locator('#scopeConfirmed').uncheck();
    out.noticeAfterManualUntick = await page.locator('#scopeConfirmNotice').isVisible();
    await page.locator('#airMovers').click();
    await page.keyboard.type('3');
    out.airMovers = await page.locator('#airMovers').inputValue();
    out.noticeAfterEditWhileUnticked = await page.locator('#scopeConfirmNotice').isVisible();
    await page.locator('#saveDraft').click();
    await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('Saved privately'));
    out.finalData = await page.evaluate(() => ({ d: state.draft.data.dehumidifiers, l: state.draft.data.labor_hours, a: state.draft.data.air_movers }));
    await page.locator('#dehumidifiers').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${outDir}/${label}-final-form.png` });
  }
  out.putDehumidifierValues = puts;
  out.createPosts = posts.length;
  console.log(JSON.stringify({ label, ...out }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
