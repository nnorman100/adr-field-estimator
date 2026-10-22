// Uploads photos through the real app until the 61st, then records the server count and the refusal shown.
const path = require('path');
const WT = process.argv[2], OUT = process.argv[3], BASE = process.argv[4];
const { chromium } = require(path.join(WT, 'node_modules/playwright'));
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const responses = [];
  page.on('response', async (r) => { if (r.request().method() === 'POST' && /\/photos$/.test(r.url())) responses.push([r.status(), r.status() >= 400 ? await r.text() : '']); });
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector('#address').disabled, null, { timeout: 15000 });
  const data = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 120; c.height = 160; c.getContext('2d').fillRect(0, 0, 60, 80); return c.toDataURL('image/png'); });
  const buf = Buffer.from(data.split(',')[1], 'base64');
  for (let i = 1; i <= 61; i++) {
    await page.locator('#photoFileInput').setInputFiles({ name: `p${i}.png`, mimeType: 'image/png', buffer: buf });
    await page.waitForTimeout(1150);
    if (await page.locator('#skipShotTag').isVisible()) await page.locator('#skipShotTag').click();
    if (i % 10 === 0 || i >= 59) {
      await page.evaluate(async () => { await syncChain.catch(() => {}); });
      const n = await page.evaluate(() => [state.draft.photos.length, state.record.photos.length]);
      console.log(`after attempt #${i}: draft photos=${n[0]}, saved on server=${n[1]}`);
    }
  }
  await page.waitForTimeout(800);
  const msg = await page.evaluate(() => [...document.querySelectorAll('[role=alert],[role=status],.error,#saveStatus,#photoStatus')].map((e) => e.id + ': ' + e.textContent.trim()).filter((t) => /60|photo/i.test(t)).join(' | '));
  console.log('visible refusal/status:', msg);
  console.log('POST /photos statuses:', JSON.stringify(responses.map((r) => r[0]).reduce((a, s) => ((a[s] = (a[s] || 0) + 1), a), {})), responses.filter((r) => r[0] >= 400).map((r) => r[1]).join(' '));
  await page.screenshot({ path: path.join(OUT, '06-61st-photo-refused.png') });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
