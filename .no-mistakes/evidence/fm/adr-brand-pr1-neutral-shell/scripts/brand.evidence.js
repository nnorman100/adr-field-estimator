const { test, expect } = require('/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M56FCN0WGK5FYX4CQP1MTN3E/node_modules/@playwright/test');
const OUT = '/home/nnorm/.no-mistakes/evidence/01M56FCN0WGK5FYX4CQP1MTN3E/';
const ADR = /Alert Disaster|950983|Matthew Myers|661|Patton Way|adr-logo/;
const fs = require('fs');
const log = (name, obj) => fs.appendFileSync(OUT + 'brand-evidence.log', name + ': ' + JSON.stringify(obj) + '\n');
// Visible text plus every attribute value (alt, aria-label, src, title...) plus document.title.
async function adrLeaks(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const hits = [];
    if (re.test(document.title)) hits.push('title:' + document.title);
    if (re.test(document.body.innerText)) hits.push('text:' + document.body.innerText.match(re)[0]);
    for (const el of document.querySelectorAll('*'))
      for (const a of el.attributes) if (re.test(a.value)) hits.push(el.tagName + '[' + a.name + ']=' + a.value.slice(0, 80));
    for (const m of document.querySelectorAll('meta')) if (re.test(m.content || '')) hits.push('meta');
    return hits;
  }, ADR.source);
}
async function audit(page, address) {
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('#address').fill(address);
  await page.locator('#yearBuilt').fill('2000');
  await page.locator('[data-room-key=finished_sf]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
test.afterEach(async ({ request }) => { await request.post('/__test/workspaces', { data: { enabled: false } }); });

test('signed-out shell online and offline', async ({ page, context }) => {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-signed-out', '1'));
  await page.goto('/');
  await expect(page.locator('#authPanel')).toBeVisible();
  const info = await page.evaluate(() => ({ title: document.title,
    description: document.querySelector('meta[name=description]')?.content,
    brand: document.querySelector('.masthead .brand strong').textContent,
    aria: document.querySelector('.masthead .brand').getAttribute('aria-label'),
    footer: document.querySelector('footer').textContent.trim(),
    help: document.getElementById('helpContact').textContent.trim(),
    accountDetails: document.getElementById('workspaceAccountDetails')?.innerHTML }));
  info.leaks = await adrLeaks(page);
  log('signed-out-1280', info);
  expect(info.title).toBe('DryScope · Water & mold loss estimates');
  expect(info.brand).toBe('DryScope'); expect(info.footer).toBe('DryScope · Private field inspections');
  expect(info.leaks).toEqual([]);
  await page.screenshot({ path: OUT + 'signed-out-1280.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: OUT + 'signed-out-390.png', fullPage: true });
  await page.locator('#helpButton').click();
  await expect(page.locator('#helpContact')).toHaveText('For company access, ask your company owner.');
  await page.screenshot({ path: OUT + 'signed-out-help-390.png' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true })); });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.masthead .brand strong')).toHaveText('DryScope');
  const off = { brand: await page.locator('.masthead .brand strong').textContent(), footer: (await page.locator('footer').textContent()).trim(),
    title: await page.title(), controlled: await page.evaluate(() => !!navigator.serviceWorker.controller), leaks: await adrLeaks(page) };
  log('signed-out-offline', off);
  expect(off.leaks).toEqual([]);
  await page.screenshot({ path: OUT + 'signed-out-offline-1280.png', fullPage: true });
  await context.setOffline(false);
});

test('ADR owner sees ADR profile branding and documents', async ({ page, request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-owner'));
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await expect(page.locator('.masthead .brand strong')).toHaveText('Alert Disaster Restoration');
  await page.locator('#accountMenu summary').click();
  const acct = (await page.locator('#workspaceAccountDetails').innerText());
  await page.screenshot({ path: OUT + 'adr-owner-account-menu.png' });
  await page.locator('#accountMenu summary').click();
  const shell = { masthead: await page.locator('.masthead .brand strong').textContent(), account: acct,
    footer: (await page.locator('footer').textContent()).trim(), logoHidden: await page.locator('.masthead .brand img').isHidden() };
  await page.locator('#helpButton').click();
  shell.help = await page.locator('#helpContact').innerText();
  await page.locator('#closeHelp').click();
  await audit(page, 'ADR synthetic property');
  shell.heading = await page.locator('#doc-proposal > h2').textContent();
  shell.letterhead = await page.locator('#doc-proposal .document-letterhead p').textContent();
  shell.tab = await page.locator('[data-tab=proposal]').textContent();
  shell.proposalEstimator = (await page.locator('#proposalBody').innerText()).match(/Estimator:.*/)?.[0];
  log('adr-owner', shell);
  expect(shell.heading).toBe('Alert Disaster Restoration · Official proposal');
  expect(shell.letterhead).toContain('CSLB #950983');
  expect(shell.account).toContain('Alert Disaster Restoration');
  await page.locator('#documents').screenshot({ path: OUT + 'adr-owner-proposal.png' });
  await page.screenshot({ path: OUT + 'adr-owner-shell.png' });
});

test('other company sees no ADR string anywhere in the DOM', async ({ page, request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-other'));
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await expect(page.locator('.masthead .brand strong')).toHaveText('Other Restoration');
  const r = { dashboardLeaks: await adrLeaks(page) };
  await page.locator('#accountMenu summary').click();
  r.account = await page.locator('#workspaceAccountDetails').innerText();
  await page.screenshot({ path: OUT + 'other-account-menu.png' });
  await page.locator('#accountMenu summary').click();
  await page.locator('#helpButton').click();
  r.help = await page.locator('#helpContact').innerText();
  r.helpLeaks = await adrLeaks(page);
  await page.screenshot({ path: OUT + 'other-help.png' });
  await page.locator('#closeHelp').click();
  await audit(page, 'Other synthetic property');
  r.heading = await page.locator('#doc-proposal > h2').textContent();
  r.tab = await page.locator('[data-tab=proposal]').textContent();
  for (const t of ['claim', 'defense', 'photos', 'proposal']) await page.locator('[data-tab=' + t + ']').click();
  r.documentLeaks = await adrLeaks(page);
  r.footer = (await page.locator('footer').textContent()).trim();
  log('other-company', r);
  expect(r.dashboardLeaks).toEqual([]); expect(r.helpLeaks).toEqual([]); expect(r.documentLeaks).toEqual([]);
  expect(r.heading).toBe('Other Restoration · Official proposal');
  await page.locator('#documents').screenshot({ path: OUT + 'other-proposal.png' });
  // Homeowner signing page
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkStatus')).toContainText('Waiting for the homeowner');
  const url = await page.locator('#homeownerLinkUrl').inputValue();
  const ctx = await page.context().browser().newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const home = await ctx.newPage();
  await home.goto(url);
  await expect(home.locator('#doc-proposal > h2')).toHaveText('Other Restoration · Official proposal');
  const s = { title: await home.title(), footer: await home.locator('#signFooter').textContent(), leaks: await adrLeaks(home) };
  log('other-signing-page', s);
  expect(s.leaks).toEqual([]);
  await home.screenshot({ path: OUT + 'other-signing-page-390.png', fullPage: true });
  await ctx.close();
});

test('legacy pre-workspace documents render the historical ADR identity', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#address').fill('Legacy synthetic property');
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  const r = { heading: await page.locator('#doc-proposal > h2').textContent(),
    letterhead: await page.locator('#doc-proposal .document-letterhead p').textContent(),
    logoVisible: await page.locator('#doc-proposal .document-letterhead img').isVisible(),
    logoIsData: (await page.locator('#doc-proposal .document-letterhead img').getAttribute('src'))?.startsWith('data:image/jpeg'),
    masthead: await page.locator('.masthead .brand strong').textContent(),
    tab: await page.locator('[data-tab=proposal]').textContent() };
  log('legacy-documents', r);
  expect(r.heading).toBe('Alert Disaster Restoration · Official proposal');
  expect(r.logoVisible).toBe(true);
  await page.locator('#documents').screenshot({ path: OUT + 'legacy-proposal.png' });
});
