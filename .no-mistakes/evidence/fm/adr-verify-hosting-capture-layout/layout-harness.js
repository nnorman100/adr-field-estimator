// Mirrors the browser layout section of scripts/verify_hosting.js; compares old vs new measurement.
const { chromium } = require(process.env.WT + '/node_modules/playwright');
const path = require('node:path');
const [base, out, inject] = process.argv.slice(2);
const process_local = !!process.env.LOCAL;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  if (process_local) await page.addInitScript(() => (window.__local = true));
  await page.goto(base);
  await page.waitForFunction(() => typeof auth !== 'undefined' && (window.__local || auth !== null) &&
    document.getElementById('signInButton').hidden === false, null, { timeout: 30000 });
  // Local emulator: Auth cannot initialize with the demo key, so apply the signed-out stage the app renders.
  if (process_local) await page.evaluate(() => { document.getElementById('authPanel').hidden = false; document.getElementById('emailAuthForm').hidden = false; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.fonts.ready);
  if (inject) await page.evaluate((m) => (document.getElementById('startWalk').style.marginTop = m), inject);
  const results = [];
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.task-nav [data-task="walkthrough"]').click();
    const old = await page.locator('#startWalk').boundingBox();
    await page.screenshot({ path: path.join(out, `w${width}-signed-out-old-measure.png`) });
    await page.evaluate(() => (document.getElementById('authPanel').hidden = true));
    const fixed = await page.locator('#startWalk').boundingBox();
    await page.screenshot({ path: path.join(out, `w${width}-authpanel-hidden-new-measure.png`) });
    await page.evaluate(() => (document.getElementById('authPanel').hidden = false));
    const restored = await page.evaluate(() => document.getElementById('authPanel').hidden === false &&
      getComputedStyle(document.getElementById('authPanel')).display !== 'none');
    results.push({ width, oldBottom: Math.round(old.y + old.height), oldPasses: old.y + old.height < 844,
      newBottom: Math.round(fixed.y + fixed.height), newPasses: fixed.y + fixed.height < 844, authPanelRestored: restored,
      signInVisible: await page.locator('#signInButton').isVisible() });
  }
  console.log(JSON.stringify({ base, inject: inject || null, results }, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
