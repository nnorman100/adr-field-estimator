const { test, expect } = require('@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M56K4C3WEKCY9520KY7KWFXN/';
const fs = require('fs');
const log = [];
const uid = (r) => 'test-owner-ws-' + r;
async function start(page, role) {
  await page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), uid(role));
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function newJob(page, address) {
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('#address').fill(address);
  await page.locator('#yearBuilt').fill('2000');
  await page.locator('[data-room-key=finished_sf]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function imgs(page) {
  return page.evaluate(() =>
    ['.masthead .brand img', '#doc-proposal .document-letterhead img', '#doc-defense .document-letterhead img'].map((s) => {
      const el = document.querySelector(s);
      return { s, hidden: !el || el.hidden || !el.offsetParent, src: (el?.getAttribute('src') || '').slice(0, 40), loaded: el?.naturalWidth || 0 };
    }),
  );
}
async function sendLink(page) {
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkStatus')).toContainText('Waiting for the homeowner');
  return page.locator('#homeownerLinkUrl').inputValue();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
  fs.writeFileSync(EV + 'logo-fallback-transcript.json', JSON.stringify(log, null, 2));
});
test('capture ADR fallback and other-company negative', async ({ page, browser }) => {
  await start(page, 'owner');
  await page.screenshot({ path: EV + 'fallback-adr-masthead-1280.png', clip: { x: 0, y: 0, width: 1280, height: 160 } });
  await newJob(page, 'ADR fallback evidence property');
  log.push({ step: 'ADR owner, no profile logo, app', imgs: await imgs(page) });
  await page.locator('#doc-proposal').screenshot({ path: EV + 'fallback-adr-proposal.png' });
  await page.locator('[data-tab=defense]').click().catch(() => {});
  await page.locator('#doc-defense').screenshot({ path: EV + 'fallback-adr-defense.png' }).catch((e) => log.push({ defenseShotError: String(e) }));
  await page.emulateMedia({ media: 'print' });
  log.push({ step: 'ADR owner, print media', imgs: await imgs(page) });
  await page.screenshot({ path: EV + 'fallback-adr-print.png', fullPage: true });
  await page.emulateMedia({ media: 'screen' });
  const url = await sendLink(page);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const home = await ctx.newPage();
  await home.goto(url);
  await expect(home.locator('#doc-proposal .document-letterhead img')).toHaveAttribute('src', '/brand/adr-logo.jpg');
  log.push({ step: 'ADR signing page', imgs: await imgs(home) });
  await home.screenshot({ path: EV + 'fallback-adr-signing-390.png', fullPage: false });
  await ctx.close();
});
test('capture other company no fallback', async ({ page, browser }) => {
  await start(page, 'other');
  await page.screenshot({ path: EV + 'fallback-other-masthead-1280.png', clip: { x: 0, y: 0, width: 1280, height: 160 } });
  await newJob(page, 'Other fallback evidence property');
  log.push({ step: 'Other company app', imgs: await imgs(page), adrLogoAnywhere: await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('adr-logo')).length) });
  await page.locator('#doc-proposal').screenshot({ path: EV + 'fallback-other-proposal.png' });
  const url = await sendLink(page);
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const home = await ctx.newPage();
  await home.goto(url);
  await expect(home.locator('#proposalBody')).toContainText('Other');
  log.push({ step: 'Other signing page', imgs: await imgs(home), adrLogoAnywhere: await home.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('adr-logo')).length) });
  await home.screenshot({ path: EV + 'fallback-other-signing-390.png' });
  await ctx.close();
});
test('capture no-membership user has no ADR logo', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.masthead .brand strong')).toHaveText('Company administration');
  log.push({ step: 'no-membership signed-in', imgs: await imgs(page) });
  await page.screenshot({ path: EV + 'fallback-no-membership-1280.png', clip: { x: 0, y: 0, width: 1280, height: 200 } });
});
test('capture signed-out shell no ADR logo', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#authPanel')).toBeVisible();
  await page.waitForTimeout(800);
  log.push({ step: 'signed-out', adrLogoVisible: await page.evaluate(() => [...document.images].filter((i) => (i.getAttribute('src') || '').includes('adr-logo') && i.offsetParent).length), brand: await page.locator('.masthead .brand').innerText() });
  await page.screenshot({ path: EV + 'fallback-signed-out-1280.png', clip: { x: 0, y: 0, width: 1280, height: 200 } });
});
