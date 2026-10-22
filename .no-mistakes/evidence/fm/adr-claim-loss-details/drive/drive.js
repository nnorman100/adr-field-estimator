// Drives the running app (wrapper around tests/browser_server.py on :8877) like a technician would.
const { chromium, request } = require('@playwright/test');
const fs = require('fs');
const E = process.argv[2], ADV = process.argv[3];
const base = 'https://localhost:8877';
const out = {};
const hdr = (u) => ({ Authorization: 'Bearer test-owner-ws-' + u, 'X-ADR-Workspace-Protocol': '1' });
async function job(browser, role) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => (out.pageErrors = [...(out.pageErrors || []), e.message]));
  await page.addInitScript((v) => sessionStorage.setItem('synthetic-uid', v), 'test-owner-ws-' + role);
  await page.goto(base + '/');
  await page.locator('#workspaceDashboard').waitFor();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  await page.locator('#claimDetails').waitFor();
  return page;
}
async function fill(page, notes) {
  await page.locator('#address').fill('100 Synthetic Claim Ave, Bakersfield CA');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(notes);
  await page.locator('#fillScopeProperty').click();
  await page.locator('#scopeSuggestionPanel').waitFor();
  await page.waitForTimeout(800);
}
(async () => {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const req = await request.newContext({ ignoreHTTPSErrors: true, baseURL: base });
  await req.post('/__test/workspaces', { data: { enabled: true } });
  // Scenario 1: walkthrough fill of stated claim details, then manual entry, then documents.
  let page = await job(browser, 'estimator');
  await fill(page, 'Room 1, category 2, 80 square feet of drywall. Use 3 fans. Synthetic Mutual claim number CLM 0042 77.');
  await page.locator('#scopeSuggestionPanel details > summary').click();
  await page.screenshot({ path: E + '/01-walkthrough-fill-claim.png', fullPage: true });
  out.fill = { carrier: await page.locator('#claimCarrier').inputValue(), claim_number: await page.locator('#claimNumber').inputValue() };
  await page.locator('#claimPolicy').fill('HO-778899');
  await page.locator('#claimDate').fill('2026-10-12');
  await page.locator('#claimCause').fill('Supply line failure under kitchen sink');
  await page.locator('#claimAdjusterName').fill('Avery Quinn');
  await page.locator('#claimAdjusterEmail').fill('Avery.Quinn@Example.invalid');
  await page.locator('#claimAdjusterPhone').fill('(661) 555-0100');
  await page.locator('#claimDeductible').fill('$1,000');
  await page.locator('#saveClaim').click();
  await page.locator('#claimStatus', { hasText: 'Claim details saved.' }).waitFor();
  await page.locator('#claimDetails').screenshot({ path: E + '/02-claim-card-saved.png' });
  const id = await page.evaluate(() => state.draft.inspection_id);
  out.savedClaim = await (await req.get('/api/jobs/' + id + '/claim', { headers: hdr('estimator') })).json();
  await page.locator('#confirmFilledScope').click();
  await page.locator('#finishAudit').click();
  await page.locator('#documents').waitFor();
  await page.waitForTimeout(500);
  out.docs = {};
  for (const [tab, sel] of [['proposal', '#doc-proposal'], ['claim', '#doc-claim'], ['defense', '#doc-defense'], ['photos', '#doc-photos']]) {
    await page.locator(`.doc-tabs [data-tab="${tab}"]`).click();
    await page.locator(sel).screenshot({ path: `${E}/03-doc-${tab}.png` });
    out.docs[tab] = (await page.locator(sel).innerText()).slice(0, 1400);
  }
  await page.context().close();
  // Scenario 2: hostile model output — only values grounded in their quote may be saved.
  page = await job(browser, 'estimator');
  await fill(page, ADV);
  await page.screenshot({ path: E + '/04-adversarial-fill.png', fullPage: true });
  out.advQuestions = await page.locator('#scopeQuestions').innerText();
  const id2 = await page.evaluate(() => state.draft.inspection_id);
  out.advSaved = await (await req.get('/api/jobs/' + id2 + '/claim', { headers: hdr('estimator') })).json();
  await page.context().close();
  // Scenario 3: historical signed record with no inspection record has no claim details.
  await req.post('/__test/seed-jobs', { data: { uid: 'test-owner-ws-estimator' } });
  const hist = await req.get('/api/jobs/ADR-AUTH-test-owner-ws-estimator-000/claim', { headers: hdr('estimator') });
  out.historical = { status: hist.status(), body: await hist.text() };
  const histPut = await req.put('/api/jobs/ADR-AUTH-test-owner-ws-estimator-000/claim', { headers: hdr('estimator'), data: { expected_version: 0, claim: { carrier: 'X' } } });
  out.historicalPut = { status: histPut.status(), body: await histPut.text() };
  await req.post('/__test/workspaces', { data: { enabled: false } });
  fs.writeFileSync(E + '/drive-results.json', JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
