// Independent live driver of the running app (local harness server) at iPhone-sized 390x844.
const { chromium, webkit } = require('playwright');
const EV = process.env.EV, BASE = process.env.BASE, which = process.env.BROWSER || 'chromium';
const log = (...a) => { console.log(...a); };
(async () => {
  const browser = await (which === 'webkit' ? webkit : chromium).launch(
    which === 'webkit' && process.env.WK ? { executablePath: process.env.WK } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
    hasTouch: true, isMobile: which === 'chromium', serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    window.scrollCalls = [];
    const orig = window.scrollBy.bind(window);
    window.scrollBy = (...a) => { window.scrollCalls.push(JSON.stringify(a)); return orig(...a); };
  });
  const page = await ctx.newPage();
  const reqs = []; page.on('request', (r) => reqs.push(r.method() + ' ' + new URL(r.url()).pathname));
  const shot = (n) => page.screenshot({ path: `${EV}/${which}-${n}.png` });
  const label = () => page.locator('#finishAudit').textContent();
  const barVisible = () => page.locator('#draftActions').isVisible();
  await page.goto(BASE + '/');
  await page.locator('#address').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('Saved privately'), null, { timeout: 15000 });

  // G: tapping text/number inputs on 01 Property causes no programmatic scrollBy
  await page.evaluate(() => (window.scrollCalls = []));
  for (const id of ['address', 'yearBuilt']) {
    await page.locator('#' + id).tap();
    await page.evaluate(() => { visualViewport?.dispatchEvent(new Event('resize')); dispatchEvent(new Event('resize')); });
    await page.waitForTimeout(250);
  }
  await page.locator('[data-room-key="finished_sf"]').tap();
  await page.waitForTimeout(250);
  log('G focus scrollBy calls:', await page.evaluate(() => window.scrollCalls.length));
  await shot('01-property-focused-number');

  // G2: validation still reveals blocker
  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); window.scrollCalls = []; });
  await page.locator('#finishAudit').tap();
  await page.waitForTimeout(300);
  log('G2 validation: focused=', await page.evaluate(() => document.activeElement.id),
      'scrollBy=', await page.evaluate(() => window.scrollCalls.length),
      'feedback=', await page.locator('#validationFeedback').textContent());
  await shot('02-validation-reveals-address');

  // E: Save draft lives in Jobs menu, not bottom bar
  log('E bottom-bar saveDraft count:', await page.locator('.draft-actions #saveDraft').count());
  await page.locator('#jobMenu summary').tap();
  await shot('03-jobs-menu-save-draft');
  await page.locator('#saveDraft').tap();
  await page.waitForTimeout(800);
  log('E after save: message=', await page.locator('#message').textContent(), '| menuOpen=', await page.locator('#jobMenu').evaluate((e) => e.open));

  // C: walkthrough transcript routes bottom action to scope fill, no audit
  await page.locator('#address').fill('Synthetic driver property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('.task-nav [data-task="walkthrough"]').tap();
  log('C empty walkthrough label:', await label());
  await page.locator('#panel-walkthrough > details:last-child summary').tap();
  await page.locator('#technicianTranscript').fill('Room 1, category 2, 80 square feet of drywall. Use 3 fans.');
  log('C with transcript label:', await label());
  await shot('04-walkthrough-fill-scope-button');
  reqs.length = 0;
  await page.locator('#finishAudit').tap();
  await page.waitForTimeout(3000);
  log('C debug message:', await page.locator('#message').textContent(), '| reqs:', reqs.join(', '));
  await page.locator('#scopeSuggestionPanel').waitFor({ state: 'visible' });
  log('C requests:', reqs.filter((r) => r.includes('/api/')).join(', '));
  log('C scopeConfirmed checked:', await page.locator('#scopeConfirmed').isChecked(), '| label now:', await label());
  await shot('05-scope-suggestions-shown');

  // D: once scope confirmed, the same button audits
  await page.locator('.task-nav [data-task="property"]').tap();
  await page.locator('[data-room-key="finished_sf"]').fill('80');
  await page.locator('#scopeConfirmed').check();
  await page.locator('.task-nav [data-task="walkthrough"]').tap();
  log('D confirmed walkthrough label:', await label());
  reqs.length = 0;
  await page.locator('#finishAudit').tap();
  await page.locator('#documents').waitFor({ state: 'visible', timeout: 20000 });
  log('D requests:', reqs.filter((r) => r.includes('/api/')).join(', '));

  // B + A: bar hidden on Review; signing visible on all 4 tabs
  log('B review bar visible:', await barVisible());
  for (const t of ['proposal', 'claim', 'defense', 'photos']) {
    await page.locator(`[data-tab="${t}"]`).tap();
    const vis = await page.locator('#signingArea').isVisible();
    await page.locator('#documentsConfirmed').scrollIntoViewIfNeeded();
    log('A tab', t, 'signingArea visible:', vis, 'bar visible:', await barVisible());
    await shot('06-review-' + t + '-signing');
  }
  // sign from Photo audit log tab without returning to proposal
  await page.locator('#documentsConfirmed').check();
  const c = page.locator('#signCanvas'); await c.scrollIntoViewIfNeeded(); const r = await c.boundingBox();
  await page.mouse.move(r.x + 30, r.y + 40); await page.mouse.down();
  await page.mouse.move(r.x + 150, r.y + 90, { steps: 8 }); await page.mouse.move(r.x + 250, r.y + 30, { steps: 8 }); await page.mouse.up();
  await page.locator('#authorizeJob').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.includes('signed'), null, { timeout: 20000 });
  for (const t of ['photos', 'proposal']) {
    await page.locator(`[data-tab="${t}"]`).tap();
    log('F signed tab', t, 'savedSignature visible:', await page.locator('#savedSignature').isVisible(), '| evidence:', await page.locator('#signedEvidenceStatus').textContent());
  }
  await page.locator('#savedSignature').scrollIntoViewIfNeeded();
  await shot('07-signed-photos-tab-saved-signature');
  for (const t of ['property', 'walkthrough', 'evidence']) {
    await page.locator(`.task-nav [data-task="${t}"]`).tap();
    log('F signed task', t, 'bar visible:', await barVisible());
  }
  await shot('08-signed-property-no-bar');
  await browser.close();
})().catch((e) => { console.error('DRIVER ERROR', e); process.exit(1); });
