const { test, expect } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M58M38JTYWT26DBPJF0DTSCG/node_modules/@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M58M38JTYWT26DBPJF0DTSCG/';
const shot = (page, name) => page.screenshot({ path: EV + test.info().project.name + '-' + name + '.png' });
const asUser = (page, uid) => page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), uid);
const rowOf = async (page) => page.evaluate(() => {
  const r = document.querySelector('.jobbar').getBoundingClientRect();
  return { y: r.y, h: r.height, compact: document.body.classList.contains('compact-job'),
    overflow: document.documentElement.scrollWidth > innerWidth };
});

test.describe('explore', () => {
  test.beforeEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: true } }); });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });

  test('owner dashboard + compact job header screenshots at 390', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asUser(page, 'test-owner-ws-owner');
    await page.goto('/');
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
    await shot(page, 'owner-dashboard-390');
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await shot(page, 'owner-job-compact-390');
    // Long address: title must stay on one line, no horizontal page overflow.
    await page.locator('.task-nav [data-task="property"]').click();
    await page.locator('#address').fill('12345 Extraordinarily Long Boulevard Name Apartment 4B, Bakersfield, CA 93301');
    await page.locator('#address').blur();
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
    const t = await page.locator('#jobTitle').evaluate((el) => {
      const cs = getComputedStyle(el); return { h: el.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3, text: el.textContent };
    });
    console.log('title', JSON.stringify(t));
    expect(t.text).toContain('Extraordinarily');
    expect(t.h).toBeLessThan(t.lh * 1.6);
    const r = await rowOf(page); console.log('row', JSON.stringify(r));
    expect(r.compact).toBe(true); expect(r.h).toBeLessThanOrEqual(56); expect(r.overflow).toBe(false);
    await shot(page, 'owner-long-title-390');
    // Resize to wide: header tools return to the navy bar and the compact class drops.
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.product-bar #helpButton')).toBeVisible();
    await expect(page.locator('.product-bar #accountMenu')).toBeVisible();
    expect((await rowOf(page)).compact).toBe(false);
    await expect(page.locator('#jobMenu > summary')).toHaveAccessibleName(/Jobs/);
    await shot(page, 'owner-job-wide-1280');
    // Back to phone: compact again.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await rowOf(page)).compact).toBe(true);
    await expect(page.locator('.product-bar')).toBeHidden();
  });

  test('office gets New job (jobs_create) but office jobs show coordination in More', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asUser(page, 'test-owner-ws-office');
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await expect(page.locator('#dashboardNewJob')).toBeVisible();
    await shot(page, 'office-dashboard-390');
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('.jobbar')).toBeVisible({ timeout: 15000 });
    await page.locator('#jobMenu > summary').click();
    await expect(page.locator('#moreCoordination')).toBeVisible();
    await shot(page, 'office-more-390');
  });

  test('offline edit shows concise offline status and the offline banner stays visible', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await asUser(page, 'test-owner-ws-estimator');
    await page.goto('/');
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
    await page.locator('.task-nav [data-task="property"]').click();
    await context.setOffline(true);
    await page.locator('#technicianNotes').fill('Offline edit');
    await page.locator('#technicianNotes').blur();
    await expect(page.locator('#saveStatus')).toHaveText(/Offline · saved on phone|Saved on phone · sync pending/, { timeout: 15000 });
    await expect(page.locator('#offlineBanner')).toBeVisible();
    await expect(page.locator('#saveStatus')).toBeInViewport();
    await shot(page, 'estimator-offline-status-390');
    await page.evaluate(() => scrollTo(0, 0));
    const b = await page.locator('#offlineBanner').boundingBox();
    console.log('offlineBanner', JSON.stringify(b), await page.locator('#saveStatus').textContent());
    expect(b.y).toBeGreaterThanOrEqual(0); expect(b.y + b.height).toBeLessThanOrEqual(844);
    await shot(page, 'estimator-offline-top-390');
    await context.setOffline(false);
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 20000 });
  });

  test('a real worker update prompt joins the compact job row and stays tappable', async ({ page, request }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await asUser(page, 'test-owner-ws-estimator');
    await page.goto('/');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
    await request.post('/__test/fault', { data: { uid: 'test-owner-ws-estimator', faults: { worker: true } } });
    await page.evaluate(async () => (await navigator.serviceWorker.ready).update());
    await expect(page.locator('#updateBanner')).toBeVisible({ timeout: 15000 });
    const usable = await page.locator('#applyUpdate').evaluate((el) => {
      const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { r: [r.left, r.top, r.right, r.bottom], hit: top === el || el.contains(top), inJobbar: !!el.closest('.jobbar') };
    });
    console.log('update', JSON.stringify(usable), JSON.stringify(await rowOf(page)));
    expect(usable.hit).toBe(true); expect(usable.r[2]).toBeLessThanOrEqual(320);
    expect((await rowOf(page)).overflow).toBe(false);
    await shot(page, 'estimator-update-banner-320');
  });

  test('signed-out sign-in page keeps the navy bar with Help and Account at 320', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await page.goto('/');
    await expect(page.locator('.product-bar')).toBeVisible();
    await expect(page.locator('.product-bar #helpButton')).toBeVisible();
    expect(await page.evaluate(() => document.body.classList.contains('compact-job'))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await shot(page, 'signed-out-320');
  });
});
