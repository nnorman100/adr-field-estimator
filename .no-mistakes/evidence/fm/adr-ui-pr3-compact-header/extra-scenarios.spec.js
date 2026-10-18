const { test, expect } = require('@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M58M38JTYWT26DBPJF0DTSCG/';
const shot = (page, name) => page.screenshot({ path: EV + test.info().project.name + '-' + name + '.png' });
const asUser = (page, role) => page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), 'test-owner-ws-' + role);
const swStub = () => {
  const sw = new EventTarget(), reg = new EventTarget();
  sw.controller = null; reg.waiting = null; reg.update = async () => {};
  sw.register = async () => reg;
  Object.defineProperty(navigator, 'serviceWorker', { value: sw });
  window.__installWorker = () => {
    const w = new EventTarget(); w.state = 'installing'; w.postMessage = () => {};
    sw.controller = new EventTarget(); reg.installing = w;
    reg.dispatchEvent(new Event('updatefound'));
    w.state = 'installed'; w.dispatchEvent(new Event('statechange'));
  };
};

test.describe('workspace', () => {
  test.beforeEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: true } }); });
  test.afterEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: false } }); });

  test('owner dashboard + compact job at 390 with long address; offline status', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asUser(page, 'owner');
    await page.goto('/');
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
    await shot(page, 'owner-dashboard-390');
    if (await page.locator('#workspaceMenuToggle').isVisible()) await page.locator('#workspaceMenuToggle').click();
    await page.locator('#dashboardJobs').click();
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
    await shot(page, 'owner-company-jobs-390');
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
    await page.locator('#address').fill('12345 Very Long Street Name Boulevard, Bakersfield, CA 93301');
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
    const h = await page.locator('#jobTitle').evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 30, ws: getComputedStyle(el).whiteSpace, scroll: el.scrollWidth > el.clientWidth }));
    console.log('title metrics', JSON.stringify(h));
    expect(h.h).toBeLessThanOrEqual(h.lh * 1.5);
    await shot(page, 'owner-job-long-title-390');
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.locator('#address').fill('12 Offline Ct');
    await expect(page.locator('#saveStatus')).toHaveText('Offline · saved on phone', { timeout: 15000 });
    await expect(page.locator('#offlineBanner')).toBeVisible();
    await shot(page, 'owner-job-offline-390');
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 20000 });
    // Rotate/resize to desktop: header tools return to the navy bar.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.product-bar #helpButton')).toBeVisible();
    await expect(page.locator('.product-bar #accountMenu')).toBeVisible();
    await expect(page.locator('#backToJobs')).toBeHidden();
    await expect(page.locator('#jobMenu > summary')).toHaveText(/Jobs/);
    await shot(page, 'owner-job-desktop-1280');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.product-bar')).toBeHidden();
    await expect(page.locator('#jobMenu .header-tools #helpButton')).toBeAttached();
  });

  test('office gets New job and Job coordination; technician-less permissions unchanged', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await asUser(page, 'office');
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
    await shot(page, 'office-dashboard-320');
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#jobTitle')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.jobbar')).toBeVisible();
    await page.locator('#jobMenu > summary').click();
    await expect(page.getByRole('button', { name: 'Job coordination', exact: true })).toBeVisible();
    await shot(page, 'office-more-320');
  });

  test('other-company owner (non-ADR) dashboard New job present', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asUser(page, 'other');
    await page.goto('/');
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
  });
});

test('signed-out header at 320 still fits', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await page.waitForTimeout(2500);
  const cls = await page.evaluate(() => document.body.className);
  console.log('body class', cls);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await shot(page, 'start-320');
});

test('update prompt reachable in compact job header at 320', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(swStub);
  await page.goto('/');
  await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
  await expect(page.locator('body')).toHaveClass(/compact-job/);
  await page.evaluate(() => window.__installWorker());
  const banner = page.locator('#updateBanner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#applyUpdate')).toBeInViewport();
  const b = await page.locator('#applyUpdate').boundingBox();
  const row = await page.locator('.jobbar').boundingBox();
  console.log('apply', JSON.stringify(b), 'row', JSON.stringify(row));
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await shot(page, 'update-prompt-320');
});
