const { test, expect } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56MZGFDFA0BA7ANQ9HW120S/node_modules/@playwright/test');
const E = '/home/nnorm/.no-mistakes/evidence/01M56MZGFDFA0BA7ANQ9HW120S';
const OLD = ['rgb(212, 43, 50)', 'rgb(185, 35, 42)', 'rgb(23, 107, 70)'];
async function oldColours(page) {
  return page.evaluate((OLD) => {
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      if (!el.getClientRects().length) continue;
      const s = getComputedStyle(el);
      for (const p of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'borderBottomColor', 'outlineColor'])
        if (OLD.includes(s[p])) hits.push((el.id || el.className || el.tagName) + ' ' + p + '=' + s[p]);
    }
    return hits;
  }, OLD);
}
test.setTimeout(90000);
test.use({ viewport: { width: 390, height: 844 } });
test('install identity: manifest and theme-color', async ({ page, request }) => {
  const m = await (await request.get('/manifest.webmanifest')).json();
  await page.goto('/');
  const meta = await page.locator('meta[name=theme-color]').getAttribute('content');
  const swText = await (await request.get('/sw.js')).text();
  const signMeta = await (await request.get('/sign.html')).text();
  const out = { name: m.name, short_name: m.short_name, theme_color: m.theme_color, background_color: m.background_color,
    index_theme_color: meta, sign_theme_color: /name="theme-color" content="([^"]+)"/.exec(signMeta)[1],
    sw_cache_line: swText.split('\n').find((l) => l.includes('const CACHE')) , title: await page.title() };
  require('fs').writeFileSync(E + '/install-identity.json', JSON.stringify(out, null, 2));
  expect(out.name).toBe('DryScope'); expect(out.short_name).toBe('DryScope');
  expect(out.theme_color.toLowerCase()).toBe('#0b2545'); expect(out.index_theme_color.toLowerCase()).toBe('#0b2545');
  expect(out.sign_theme_color.toLowerCase()).toBe('#0b2545');
});
test('signed-out shell', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#emailSignIn')).toBeVisible();
  await expect(page.locator('#emailSignIn')).toHaveCSS('background-color', 'rgb(11, 37, 69)');
  await page.screenshot({ path: E + '/01-signed-out-390.png', fullPage: true });
  expect(await oldColours(page)).toEqual([]);
});
test('form, success message and documents', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await page.screenshot({ path: E + '/02-signed-in-form-390.png' });
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('Synthetic palette property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-index="0"][data-room-key="name"]').fill('Kitchen');
  await page.locator('[data-room-index="0"][data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56MZGFDFA0BA7ANQ9HW120S/tests/browser/actions.js').saveDraft(page);
  const msg = page.locator('#message');
  await expect(msg).toHaveText('Draft saved privately.');
  await expect(msg).toHaveCSS('color', 'rgb(11, 37, 69)');
  await msg.scrollIntoViewIfNeeded();
  await page.screenshot({ path: E + '/03-success-message-navy-check-390.png' });
  await msg.screenshot({ path: E + '/03b-success-message-closeup.png' });
  expect(await oldColours(page)).toEqual([]);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible({ timeout: 20000 });
  await page.locator('#documents').scrollIntoViewIfNeeded();
  await page.screenshot({ path: E + '/04-documents-tabs-390.png' });
  await page.screenshot({ path: E + '/05-documents-full-390.png', fullPage: true });
  expect(await oldColours(page)).toEqual([]);
});
