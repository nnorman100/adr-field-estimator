const { test, expect } = require('@playwright/test');
const EV = '/home/nnorm/.no-mistakes/evidence/01M58M38JTYWT26DBPJF0DTSCG/';
const log = [];
test.describe.configure({ mode: 'serial' });
test.beforeEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: true } }); });
test.afterEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: false } }); });
test.afterAll(() => { require('fs').writeFileSync(EV + 'evidence-' + test.info().project.name + '.log', log.join('\n') + '\n'); });
async function as(page, role, w, h) {
  await page.setViewportSize({ width: w, height: h });
  await page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), 'test-owner-ws-' + role);
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
const shot = (page, name) => page.screenshot({ path: EV + name + '-' + test.info().project.name + '.png' });

for (const role of ['owner', 'estimator', 'office'])
  test('dashboard New job CTA for ' + role, async ({ page }) => {
    await as(page, role, 390, 844);
    await page.waitForTimeout(500);
    const btn = page.locator('#dashboardNewJob');
    const vis = await btn.isVisible();
    const perm = await page.evaluate(() => window.WorkspaceUI && JSON.stringify(window.WorkspaceUI.state?.()?.membership?.permissions ?? null));
    const box = vis ? await btn.boundingBox() : null;
    log.push(`${role}: dashboardNewJob visible=${vis} y=${box && Math.round(box.y)} newJobButtons=${await page.getByRole('button', { name: 'New job', exact: true }).count()}`);
    await shot(page, 'dashboard-' + role + '-390');
    await page.locator('#dashboardJobs').evaluate((b) => b.click());
    await page.waitForTimeout(500);
    log.push(`${role}: on Company/My jobs, dashboardNewJob visible=${await btn.isVisible()}`);
    await shot(page, 'jobs-list-' + role + '-390');
  });

for (const w of [320, 390])
  test('compact job header at ' + w, async ({ page }) => {
    await as(page, 'owner', w, 844);
    await page.locator('#dashboardNewJob').click();
    await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
    await page.locator('.task-nav [data-task="property"]').click();
    await page.locator('#address').fill('1234 Very Long Street Name Avenue, Bakersfield, CA 93301');
    await page.locator('#address').blur();
    await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
    const jb = await page.locator('.jobbar').boundingBox();
    const t = await page.locator('#jobTitle').evaluate((e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight), text: e.textContent, overflow: getComputedStyle(e).textOverflow }));
    const panel = await page.locator('[data-panel="property"]').evaluate((e) => e.getBoundingClientRect().top);
    log.push(`${w}: jobbar y=${jb.y} h=${jb.height}; title "${t.text}" height=${t.h} lineHeight=${t.lh} overflow=${t.overflow}; status="${await page.locator('#saveStatus').textContent()}" title="${await page.locator('#saveStatus').getAttribute('title')}"; property panel top=${panel}`);
    await shot(page, 'job-header-' + w);
    await page.locator('#jobMenu > summary').click();
    await page.locator('#accountMenu > summary').click();
    await shot(page, 'more-account-' + w);
    await page.locator('#jobMenu > summary').click();
    await page.locator('#backToJobs').click();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    log.push(`${w}: Jobs back -> dashboard visible; product-bar help visible=${await page.locator('.product-bar #helpButton').isVisible()}`);
    await shot(page, 'back-to-dashboard-' + w);
  });

test('offline status in compact header', async ({ page, context }) => {
  await as(page, 'estimator', 390, 844);
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 15000 });
  await context.setOffline(true);
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('55 Offline Ct');
  await page.locator('#address').blur();
  await expect(page.locator('#saveStatus')).toHaveText('Offline · saved on phone', { timeout: 15000 });
  log.push(`offline: status="${await page.locator('#saveStatus').textContent()}" title="${await page.locator('#saveStatus').getAttribute('title')}" offlineBanner visible=${await page.locator('#offlineBanner').isVisible()}`);
  await shot(page, 'offline-390');
  await context.setOffline(false);
  await expect(page.locator('#saveStatus')).toHaveText('Saved', { timeout: 20000 });
  log.push(`back online: status="${await page.locator('#saveStatus').textContent()}" title="${await page.locator('#saveStatus').getAttribute('title')}"`);
});

test('update prompt joins compact header', async ({ page }) => {
  await as(page, 'owner', 320, 844);
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await page.evaluate(() => (document.getElementById('updateBanner').hidden = false));
  const b = await page.locator('#applyUpdate').boundingBox();
  const inJobbar = await page.locator('#updateBanner').evaluate((e) => !!e.closest('.jobbar'));
  log.push(`update: banner in jobbar=${inJobbar} applyUpdate visible=${await page.locator('#applyUpdate').isVisible()} box=${JSON.stringify(b)} scrollWidth>innerWidth=${await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)}`);
  await shot(page, 'update-banner-320');
});

test('wide layout keeps full header', async ({ page }) => {
  await as(page, 'owner', 1280, 900);
  await shot(page, 'dashboard-1280');
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  log.push(`1280: compact-job=${await page.evaluate(() => document.body.classList.contains('compact-job'))} product-bar visible=${await page.locator('.product-bar').isVisible()} jobMenu label="${(await page.locator('#jobMenu > summary').innerText()).trim()}" backToJobs visible=${await page.locator('#backToJobs').isVisible()} helpInProductBar=${await page.locator('.product-bar #helpButton').count()}`);
  await shot(page, 'job-1280');
});

test('signed-out header on phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.waitForTimeout(1500);
  log.push(`signed-out 320: compact-job=${await page.evaluate(() => document.body.classList.contains('compact-job'))} body=${await page.evaluate(() => document.body.className)} product-bar visible=${await page.locator('.product-bar').isVisible()} overflow=${await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)}`);
  await shot(page, 'signed-out-320');
});
