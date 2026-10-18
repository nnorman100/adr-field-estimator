const { test, expect } = require('@playwright/test');
const E = process.env.EVIDENCE;
const task = (page, name) => page.locator('.task-nav [data-task="' + name + '"]').click();
// Real phone-test transcript shape from 1234 Acme St, 2026-10-17.
const TRANSCRIPT = [
  'Welcome to the',
  'Room 1, clean water, 10 square feet of drywall. The wall is wet to the right of the door.',
  'Can I add a picture?',
  'But you get it?',
  'To the right.',
  'One dehumidifier for three days.',
  '右侧墙面潮湿。',
  'All right, thanks.',
].join('\n');
async function photo(page, name) {
  const data = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300;
    const g = c.getContext('2d'); g.fillStyle = '#579'; g.fillRect(0, 0, 400, 300);
    return c.toDataURL('image/png');
  });
  await page.locator('#photoFileInput').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(data.split(',')[1], 'base64') });
}
async function run(page, year, tag) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await task(page, 'walkthrough');
  await page.locator('details:has(#technicianTranscript) summary').click();
  await page.locator('#technicianTranscript').fill(TRANSCRIPT);
  await photo(page, 'one.png');
  await expect(page.locator('#photoGallery')).toContainText('no meter', { timeout: 15000 });
  await photo(page, 'two.png');
  await expect(page.locator('#photoGallery .photo-card, #photoGallery > *')).toHaveCount(2, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await task(page, 'property');
  await page.locator('#address').fill('1234 Acme St ' + tag);
  await page.locator('#yearBuilt').fill(String(year));
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await page.locator('#saveDraft').click();
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  const audited = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
  await page.locator('#finishAudit').click();
  const docs = (await (await audited).json()).audit.documents;
  await expect(page.locator('#documents')).toBeVisible();
  require('fs').writeFileSync(E + '/acme-' + tag + '-documents.json', JSON.stringify(docs, null, 2));
  return docs;
}
test('1978 Acme job: clean statement, photos cited, letterhead first, no testing advice or JSON wording', async ({ page }) => {
  const docs = await run(page, 1978, '1978');
  const proposal = await page.locator('#proposalBody').innerText();
  await page.locator('#documents').screenshot({ path: E + '/acme-1978-proposal.png' });
  await page.locator('[data-tab="defense"]').click();
  await expect(page.locator('#doc-defense')).toBeVisible();
  const letter = await page.locator('#defenseBody').innerText();
  await page.locator('#doc-defense').screenshot({ path: E + '/acme-1978-defense-letter.png' });
  require('fs').writeFileSync(E + '/acme-1978-rendered.txt', '=== PROPOSAL ===\n' + proposal + '\n\n=== DEFENSE LETTER ===\n' + letter);
  for (const text of [proposal, letter]) {
    for (const chatter of ['Welcome to the', 'Can I add a picture', 'But you get it', 'All right, thanks']) expect(text).not.toContain(chatter);
    for (const kept of ['The wall is wet to the right of the door.', 'To the right.', 'One dehumidifier for three days.', '右侧墙面潮湿。']) expect(text).toContain(kept);
  }
  expect(letter).toMatch(/Photo 1 \([^)]+\) — supporting photo; no verified meter reading\./);
  expect(letter).toMatch(/Photo 2 \([^)]+\) — supporting photo; no verified meter reading\./);
  const first = letter.trim().split('\n')[0];
  // Legacy mode has no company record, so no phone is known.
  expect(first).toBe('Alert Disaster Restoration · Bakersfield, CA · CSLB #950983');
  expect(letter).not.toContain('•');
  expect(letter.indexOf('TO: Insurance')).toBeGreaterThan(letter.indexOf(first));
  expect(proposal).not.toContain('testing may be needed');
  expect(proposal).toContain('The home was built in 1978. Therefore, no lead or asbestos testing is required prior to the start of work.');
  expect(proposal).not.toContain('(this does not include the pretest for lead/asbestos)');
  expect(proposal).not.toMatch(/JSON|metadata|photo_log/);
  expect(proposal).toContain('saved inspection');
  // Homeowner signing page shows the same AI suggestions.
  await page.locator('[data-tab="proposal"]').click();
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkStatus')).toContainText('Waiting for the homeowner');
  const url = await page.locator('#homeownerLinkUrl').inputValue();
  const ctx = await page.context().browser().newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const home = await ctx.newPage();
  await home.goto(url);
  await expect(home.locator('#proposalBody')).toContainText('AI suggestions', { timeout: 15000 });
  const signText = await home.locator('#proposalBody').innerText();
  await home.screenshot({ path: E + '/acme-1978-homeowner-signing.png', fullPage: true });
  require('fs').appendFileSync(E + '/acme-1978-rendered.txt', '\n\n=== HOMEOWNER SIGNING PAGE PROPOSAL ===\n' + signText);
  expect(signText).not.toContain('testing may be needed');
  expect(signText).not.toMatch(/JSON|metadata/);
  await ctx.close();
});
test('1977 job: testing advice and pre-1978 notice appear', async ({ page }) => {
  await run(page, 1977, '1977');
  const proposal = await page.locator('#proposalBody').innerText();
  await page.locator('#documents').screenshot({ path: E + '/acme-1977-proposal.png' });
  require('fs').writeFileSync(E + '/acme-1977-rendered.txt', proposal);
  expect(proposal).toContain('Lead or asbestos testing may be needed');
  expect(proposal).toContain('(this does not include the pretest for lead/asbestos)');
  expect(proposal).toContain('Due to property age (1977), California State Law requires third-party lead and asbestos testing prior to destructive demolition.');
});

test('workspace job: letterhead opens the letter with company phone from company_identity', async ({ page, request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  try {
    await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-estimator'));
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#address')).toBeEnabled();
    const audited = page.waitForResponse((r) => r.url().endsWith('/api/audit'));
    await page.locator('#finishAudit').click();
    const docs = (await (await audited).json()).audit.documents;
    await page.locator('[data-tab="defense"]').click();
    const letter = await page.locator('#defenseBody').innerText();
    await page.locator('#doc-defense').screenshot({ path: E + '/workspace-defense-letter.png' });
    const id = docs.company_identity;
    require('fs').writeFileSync(E + '/workspace-defense-letter.txt', 'company_identity: ' + JSON.stringify(id) + '\n\n' + letter);
    const lines = letter.trim().split('\n').filter(Boolean);
    expect(lines[0]).toBe(id.name + ' · ' + id.address.replace(/•/g, '·') + ' · ' + id.phone + ' · CSLB #' + id.license);
    expect(id.phone).toBe('(661) 426-2151');
    expect(lines[1]).toBe('TO: Insurance Claims Examiner / Adjuster');
    expect(lines[2]).toMatch(/^RE: /);
    expect(letter).not.toContain('•');
  } finally {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  }
});
