// Drives the running DryScope harness (real backend + real frontend, fake cloud adapters).
const { chromium } = require('@playwright/test');
const fs = require('fs');
const E = '/home/nnorm/.no-mistakes/evidence/01M5JQ242XJKTN7S0BNZF6PH5Z/';
const BASE = 'https://localhost:8799';
const log = [];
const note = (k, v) => { log.push(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v))); console.log(log.at(-1)); };
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requested = [];
  page.on('request', (r) => requested.push(r.url()));
  const api = (path, method = 'GET', body) => page.request.fetch(BASE + path, { method,
    headers: { Authorization: 'Bearer test-owner-ws-owner', 'X-ADR-Workspace-Protocol': '1' }, ...(body ? { data: body } : {}) });

  // 1. Retired bundled logo is no longer served.
  for (const p of ['/brand/adr-logo.jpg', '/brand/dryscope-mark.svg']) note('GET ' + p, (await page.request.get(BASE + p)).status());

  // 2. Workspace mode: ADR is an ordinary company with no saved logo.
  await page.request.post(BASE + '/__test/workspaces', { data: { enabled: true } });
  const session = await (await api('/api/session')).json();
  note('session has legacy_identity key', 'legacy_identity' in session);
  await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-owner'));
  await page.goto(BASE + '/app');
  await page.locator('#workspaceDashboard').waitFor();
  await page.waitForTimeout(500);
  const img = page.locator('.masthead .brand img');
  note('masthead title', await page.locator('.masthead .brand strong').textContent());
  note('masthead logo visible (no saved logo)', await img.isVisible());
  note('masthead logo src (no saved logo)', String(await img.getAttribute('src')));
  await page.screenshot({ path: E + '01-adr-company-strip-no-saved-logo.png' });

  // 3. A brand-new company created by the superadmin inherits no ADR details.
  const created = await api('/api/admin/companies', 'POST', { name: 'Synthetic New Co', owner_email: 'newco@example.invalid' });
  note('create company status', created.status());
  const createdBody = await created.json().catch(() => ({}));
  note('new company profile', createdBody.company?.profile || createdBody.profile || createdBody);

  // 4. Owner saves their own logo + details in Company settings.
  await page.locator('#dashboardProfile').click();
  const form = page.locator('form.dashboard-form');
  await form.locator('input[name=address]').fill('12 Synthetic Way · Fresno, CA 93700');
  await form.locator('input[name=phone]').fill('(555) 010-2000');
  await form.locator('input[name=license]').fill('555000');
  await form.locator('input[name=signoff]').fill('Sam Synthetic');
  await form.locator('input[name=logo]').setInputFiles('public/icon-512.png');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await page.locator('#message').filter({ hasText: 'Company details saved' }).waitFor();
  note('masthead logo src after save', ((await img.getAttribute('src')) || '').slice(0, 30));
  await page.screenshot({ path: E + '02-adr-company-settings-own-logo-saved.png' });
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#finishAudit').click();
  await page.locator('#documents').waitFor();
  note('proposal h2', await page.locator('#doc-proposal > h2').textContent());
  note('defense letterhead', await page.locator('#doc-defense .document-letterhead p').textContent());
  await page.locator('#doc-proposal').screenshot({ path: E + '03-adr-proposal-with-own-profile.png' });
  note('any adr-logo request in workspace session', requested.some((u) => u.includes('adr-logo')));

  // 5. Owner-only (pre-workspace) mode: documents with no company identity print no ADR details.
  await page.request.post(BASE + '/__test/workspaces', { data: { enabled: false } });
  const p2 = await ctx.newPage();
  const req2 = []; p2.on('request', (r) => req2.push(r.url()));
  await p2.goto(BASE + '/app');
  await p2.locator('#address').waitFor({ state: 'visible' });
  await p2.locator('.task-nav [data-task="property"]').click();
  await p2.locator('#address').fill('Synthetic legacy property');
  await p2.locator('#yearBuilt').fill('1960');
  await p2.locator('[data-room-key="finished_sf"]').fill('10');
  await p2.locator('#scopeConfirmed').check();
  await p2.locator('#finishAudit').click();
  await p2.locator('#documents').waitFor();
  const body = await p2.locator('body').innerText();
  note('legacy proposal h2', await p2.locator('#doc-proposal > h2').textContent());
  note('legacy body mentions ADR/Myers/950983/Bakersfield', /Alert Disaster|Matthew Myers|950983|Bakersfield|426-2151/.test(body));
  note('legacy PROTECTION clause', (body.match(/Per IICRC and EPA protocols[^.]*/) || [''])[0]);
  note('any adr-logo request in legacy session', req2.some((u) => u.includes('adr-logo')));
  await p2.locator('#doc-proposal').screenshot({ path: E + '04-no-identity-proposal.png' });
  await p2.emulateMedia({ media: 'print' });
  await p2.locator('#doc-defense').screenshot({ path: E + '05-no-identity-defense-letter.png' });
  // 6. Homeowner sign page shell with incomplete link.
  const p3 = await ctx.newPage();
  await p3.goto(BASE + '/sign#not-a-link');
  await p3.waitForTimeout(800);
  note('sign page broken-link text', (await p3.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await p3.screenshot({ path: E + '06-sign-page-no-adr-identity.png' });
  fs.writeFileSync(E + 'drive-transcript.txt', log.join('\n') + '\n');
  await browser.close();
})().catch((e) => { console.error(e); fs.writeFileSync(E + 'drive-transcript.txt', log.join('\n') + '\nERROR ' + e + '\n'); process.exit(1); });
