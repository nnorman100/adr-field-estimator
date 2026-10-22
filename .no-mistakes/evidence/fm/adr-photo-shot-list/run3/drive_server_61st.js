// Fills a job to 60 photos through the app, then posts a 61st directly to the server API (bypassing the client guard).
const path = require('path');
const WT = process.argv[2], BASE = process.argv[3];
const { chromium } = require(path.join(WT, 'node_modules/playwright'));
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector('#address').disabled, null, { timeout: 15000 });
  const out = await page.evaluate(async () => {
    await syncChain.catch(() => {});
    const c = document.createElement('canvas'); c.width = 80; c.height = 80; c.getContext('2d').fillRect(0, 0, 40, 40);
    const data_url = c.toDataURL('image/jpeg');
    const id = state.record.inspection_id; const results = [];
    for (let i = 1; i <= 61; i++) {
      const photo_id = crypto.randomUUID().replace(/-/g, '');
      try {
        const r = await jsonApi('/api/inspections/' + id + '/photos', 'POST', { photo_id, expected_revision: state.record.revision, room: 'Room 1', captured_at: new Date().toISOString(), data_url });
        state.record = r; results.push(`#${i}: ok, server has ${r.photos.length}`);
      } catch (e) { results.push(`#${i}: refused: ${e.message}`); if (/many requests/i.test(e.message)) { await new Promise((ok) => setTimeout(ok, 61000)); i--; } }
    }
    return results.filter((l, i, a) => i >= a.length - 3 || /refused/.test(l));
  });
  console.log(out.join('\n'));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
