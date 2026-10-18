const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');
// Two browser contexts: the signed-in technician, and a homeowner context with no sign-in at all.
test.setTimeout(90000);
async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
async function audit(page, address = 'Synthetic signing-link property') {
  await task(page, 'property');
  await page.locator('#address').fill(address);
  await page.locator('#yearBuilt').fill('1960');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
}
async function sendLink(page) {
  await page.locator('#sendHomeownerLink').click();
  await expect(page.locator('#homeownerLinkPanel')).toBeVisible();
  await expect(page.locator('#homeownerLinkStatus')).toContainText('Waiting for the homeowner');
  expect(await page.locator('#homeownerQr').evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  const url = await page.locator('#homeownerLinkUrl').inputValue();
  expect(url).toMatch(/^https:\/\/(localhost|127\.0\.0\.1):\d+\/sign#[A-Za-z0-9_-]{43}$/);
  return url;
}
async function homeowner(browser, url) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) =>
    requests.push({ url: request.url(), headers: request.headers() }),
  );
  await page.goto(url);
  return { context, page, requests };
}
async function draw(page) {
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 110, rect.y + 100, { steps: 8 });
  await page.mouse.move(rect.x + 220, rect.y + 30, { steps: 8 });
  await page.mouse.up();
}
async function signAsHomeowner(page) {
  await expect(page.locator('#submitSignature')).toBeDisabled();
  for (const name of ['proposal', 'claim', 'defense', 'photos'])
    await page.locator('[data-tab="' + name + '"]').click();
  await expect(page.locator('#documentProgress')).toContainText('4 of 4');
  await expect(page.locator('#submitSignature')).toBeEnabled();
  await page.locator('#signerName').fill('Synthetic Homeowner');
  await page.locator('input[name=signerRole][value=owner]').check();
  await page.locator('#consentReviewed').check();
  await page.locator('#consentElectronic').check();
  await draw(page);
  await page.locator('#submitSignature').click();
  await expect(page.locator('#signedReceipt')).toBeVisible();
}
async function technician(page) {
  await page.goto('/');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
}

test('technician sends a link, an unsigned-in homeowner signs it and the technician sees Signed', async ({
  page,
  browser,
  browserName,
}) => {
  await technician(page);
  await audit(page);
  const url = await sendLink(page);
  const home = await homeowner(browser, url);
  const view = home.page;
  await expect(view.locator('#documents')).toBeVisible();
  // The identical four documents the technician reviewed.
  const text = (target) =>
    target.evaluate(() =>
      [
        'estimateRange',
        'itemizedTotal',
        'proposalBody',
        'claimItems',
        'claimTotal',
        'defenseBody',
        'photoAuditLog',
      ].map((id) => document.getElementById(id).textContent),
    );
  expect(await text(view)).toEqual(await text(page));
  await expect(view.locator('#proposalBody')).toContainText('<img src=x');
  expect(await view.evaluate(() => window.reviewInjected)).toBeUndefined();
  await expect(view.locator('#consentReviewedText')).toContainText('I reviewed all four documents');
  await expect(view.locator('#linkExpiry')).toContainText('This link expires');
  expect(await view.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (browserName === 'chromium')
    await view.screenshot({ path: test.info().outputPath('homeowner-review.png'), fullPage: true });
  await view.locator('#submitSignature').evaluate((button) => button.form.requestSubmit());
  await expect(view.locator('#signError')).toHaveText('Open all four documents before signing.');
  await signAsHomeowner(view);
  await expect(view.locator('#receiptText')).toContainText(
    'Signed by Synthetic Homeowner, property owner',
  );
  await expect(view.locator('#receiptText')).toContainText('ADR-AUTH-link-');
  await expect(view.locator('#savedSignature')).toBeVisible();
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  if (browserName === 'chromium')
    await view.screenshot({ path: test.info().outputPath('homeowner-signed.png'), fullPage: true });
  // No sign-in anywhere on the homeowner side: only the link header reaches the API.
  const api = home.requests.filter((r) => new URL(r.url).pathname.startsWith('/api/'));
  expect(api.length).toBeGreaterThan(1);
  for (const request of api) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-adr-signing-link']).toBe(url.split('#')[1]);
  }
  expect(home.requests.some((r) => r.url.includes('/vendor/firebase/'))).toBe(false);
  // The technician's Review tab flips to the signed agreement by polling.
  await expect(page.locator('#saveStatus')).toContainText('Saved & signed', { timeout: 20000 });
  await expect(page.locator('#signedEvidenceStatus')).toContainText(
    'Signed through the homeowner link by Synthetic Homeowner (owner).',
  );
  await expect(page.locator('#savedSignature')).toBeVisible();
  await expect(page.locator('#homeownerLinkPanel')).toBeHidden();
  // A used link stays read-only: it reopens as signed and refuses a different signature.
  await view.reload();
  await expect(view.locator('#signedReceipt')).toBeVisible();
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  const refused = await view.evaluate(async (token) => {
    const response = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ADR-Signing-Link': token },
      body: JSON.stringify({
        signer_name: 'Someone Else',
        signer_role: 'owner',
        documents_reviewed: true,
        electronic_consent: true,
        consent_version: 'homeowner-link-v1',
        signature_png: document.getElementById('signCanvas').toDataURL('image/png'),
      }),
    });
    return [response.status, (await response.json()).detail];
  }, url.split('#')[1]);
  expect(refused).toEqual([409, 'This estimate is already signed.']);
  await home.context.close();
});

test.describe('page-routed link status', () => {
  // A worker-handled fetch bypasses page.route in WebKit, so the failed read must stay page-owned.
  test.use({ serviceWorkers: 'block' });
  test('after a reload the Review tab still offers Revoke, then flips to Signed', async ({
    page,
    browser,
  }) => {
    await technician(page);
    await audit(page, 'Synthetic reloaded signing-link property');
    const url = await sendLink(page);
    let failed = 0;
    await page.route(/\/api\/inspections\/[^/]+\/signing-links$/, (route) =>
      route.request().method() === 'GET' && !failed++ ? route.abort() : route.continue(),
    );
    await page.reload();
    await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
    await task(page, 'review');
    await expect(page.locator('#documents')).toBeVisible();
    // A failed status read is retried when the Review tab is reopened.
    await expect.poll(() => failed).toBe(1);
    await expect(page.locator('#homeownerLinkPanel')).toBeHidden();
    await task(page, 'property');
    await task(page, 'review');
    await expect(page.locator('#homeownerLinkStatus')).toContainText('Waiting for the homeowner');
    await expect(page.locator('#revokeHomeownerLink')).toBeVisible();
    // The token is never returned again, so only a new link shows a QR code.
    await expect(page.locator('#homeownerQr')).toBeHidden();
    await expect(page.locator('#copyHomeownerLink')).toBeHidden();
    const home = await homeowner(browser, url);
    await expect(home.page.locator('#documents')).toBeVisible();
    await signAsHomeowner(home.page);
    await expect(page.locator('#saveStatus')).toContainText('Saved & signed', { timeout: 20000 });
    await expect(page.locator('#homeownerLinkPanel')).toBeHidden();
    await home.context.close();
  });
});

test('an edit voids an unused link, and revoked or expired links are refused', async ({
  page,
  browser,
}) => {
  await technician(page);
  await audit(page);
  const edited = await homeowner(browser, await sendLink(page));
  await expect(edited.page.locator('#documents')).toBeVisible();
  await task(page, 'property');
  await page.locator('#address').fill('Changed after sending the link');
  await expect(page.locator('#documents')).toBeHidden();
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toContainText('Saved privately');
  await edited.page.reload();
  await expect(edited.page.locator('#signStatus')).toHaveText(
    'This estimate was updated. Ask your technician for a new link.',
  );
  await expect(edited.page.locator('#signMain')).toBeHidden();
  // A page left open is refused at submission too.
  await page.locator('#scopeConfirmed').check();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  const open = await homeowner(browser, await sendLink(page));
  await expect(open.page.locator('#documents')).toBeVisible();
  await page.locator('#revokeHomeownerLink').click();
  await expect(page.locator('#homeownerLinkStatus')).toContainText('Signing link revoked');
  await expect(page.locator('#homeownerLinkPanel')).toBeHidden();
  await signAsHomeownerExpectingRefusal(open.page);
  await open.page.reload();
  await expect(open.page.locator('#signStatus')).toHaveText(
    'This signing link is not available. Ask your technician for a new link.',
  );
  const expired = await homeowner(browser, await sendLink(page));
  await expect(expired.page.locator('#documents')).toBeVisible();
  await page.request.post('/__test/expire-signing-links');
  await expired.page.reload();
  await expect(expired.page.locator('#signStatus')).toHaveText(
    'This signing link is not available. Ask your technician for a new link.',
  );
  const broken = await homeowner(browser, new URL('/sign#not-a-link', page.url()).href);
  await expect(broken.page.locator('#signStatus')).toContainText('This signing link is incomplete');
  for (const home of [edited, open, expired, broken]) await home.context.close();
  await expect(page.locator('#saveStatus')).not.toContainText('signed');
});

async function signAsHomeownerExpectingRefusal(page) {
  for (const name of ['proposal', 'claim', 'defense', 'photos'])
    await page.locator('[data-tab="' + name + '"]').click();
  await page.locator('#signerName').fill('Synthetic Homeowner');
  await page.locator('input[name=signerRole][value=authorized_representative]').check();
  await page.locator('#consentReviewed').check();
  await page.locator('#consentElectronic').check();
  await draw(page);
  await page.locator('#submitSignature').click();
  await expect(page.locator('#signError')).toContainText(
    'Not signed yet: This signing link is not available.',
  );
  await expect(page.locator('#signedReceipt')).toBeHidden();
}

test.describe('company workspaces', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: true } });
  });
  test.afterEach(async ({ request }) => {
    await request.post('/__test/workspaces', { data: { enabled: false } });
  });

  test('a company job signs through the link with the company letterhead', async ({
    page,
    browser,
  }) => {
    await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-other'));
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await page.locator('#address').fill('Other company signing-link property');
    await page.locator('#yearBuilt').fill('2000');
    await page.locator('[data-room-key=finished_sf]').fill('10');
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    const home = await homeowner(browser, await sendLink(page));
    const view = home.page;
    await expect(view.locator('#doc-proposal > h2')).toHaveText(
      'Other Restoration · Official proposal',
    );
    await expect(view.locator('#proposalBody')).toContainText('Other Estimator · CSLB #123456');
    await expect(view.locator('[data-tab=proposal]')).toHaveText('Proposal');
    await expect(view.locator('#signFooter')).toContainText('Other Restoration');
    await expect(view.locator('#doc-proposal .document-letterhead img')).toBeHidden();
    // Without a company logo, the page chrome carries the DryScope wordmark instead.
    await expect(view.locator('#signBrand')).toBeVisible();
    await expect(view.locator('#signBrand')).toHaveAttribute('src', '/brand/dryscope-wordmark.svg');
    await signAsHomeowner(view);
    await expect(page.locator('#saveStatus')).toContainText('Saved & signed', { timeout: 20000 });
    await page.reload();
    await page.locator('#dashboardJobs').click();
    await expect(
      page.getByRole('button', { name: /Other company signing-link property.*Signed/s }),
    ).toBeVisible();
    await home.context.close();
  });

  // Temporary until PR 2 stores ADR's logo in its profile.
  test('an ADR job without a profile logo shows the bundled logo on the signing page', async ({
    page,
    browser,
  }) => {
    await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-owner'));
    await page.goto('/');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.getByRole('button', { name: 'New job', exact: true }).click();
    await page.locator('#address').fill('ADR signing-link property');
    await page.locator('#yearBuilt').fill('2000');
    await page.locator('[data-room-key=finished_sf]').fill('10');
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#documents')).toBeVisible();
    const home = await homeowner(browser, await sendLink(page));
    for (const doc of ['#doc-proposal', '#doc-defense'])
      await expect(home.page.locator(doc + ' .document-letterhead img')).toHaveAttribute(
        'src',
        '/brand/adr-logo.jpg',
      );
    await expect(home.page.locator('#signBrand')).toBeHidden();
    await home.context.close();
  });
});
