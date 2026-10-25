const { test, expect } = require('@playwright/test');
// The read-only document link: a signed agreement's documents at /documents, with no sign-in and
// no signing. Links are minted on the server after signing; the test harness mints them directly.
test.setTimeout(90000);

const uid = (role) => 'test-owner-ws-' + role;
const SOURCE = 'ADR-INS-' + 'c'.repeat(32);
const AUTH = 'ADR-AUTH-doclink00001';
const PHOTO = 'd'.repeat(32);
const UNAVAILABLE =
  'This document link is not available. Ask your restoration company for a new link.';

async function call(page, path, method = 'GET', body, role = 'estimator') {
  return page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
}
function drawn(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    context.lineWidth = 3;
    context.moveTo(10, 35);
    context.lineTo(40, 12);
    context.lineTo(105, 15);
    context.stroke();
    return canvas.toDataURL('image/png');
  });
}
async function mint(page, documentSet, role = 'estimator') {
  const response = await page.request.post('/__test/document-links', {
    data: { uid: uid(role), auth_id: AUTH, document_set: documentSet },
  });
  expect(response.ok()).toBe(true);
  const { url } = await response.json();
  expect(url).toMatch(/^https:\/\/(localhost|127\.0\.0\.1):\d+\/documents#[A-Za-z0-9_-]{43}$/);
  return url;
}
async function recipient(browser, url) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) =>
    requests.push({ url: request.url(), headers: request.headers() }),
  );
  const response = await page.goto(url);
  return { context, page, requests, response };
}

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await page.goto('/app');
  const photo = await call(page, '/api/inspections/' + SOURCE + '/photos', 'POST', {
    expected_revision: 1,
    photo_id: PHOTO,
    room: 'Bathroom',
    captured_at: '2026-10-06T19:00:00Z',
    data_url: await drawn(page),
  });
  expect(photo.status()).toBe(200);
  // Recognition advances the revision; the audit binds to the record it returns.
  const recognized = await call(
    page,
    '/api/inspections/' + SOURCE + '/photos/' + PHOTO + '/ocr',
    'POST',
  );
  expect(recognized.status(), await recognized.text()).toBe(200);
  const revision = (await recognized.json()).revision;
  const audited = await call(page, '/api/audit', 'POST', {
    inspection_id: SOURCE,
    expected_revision: revision,
  });
  expect(audited.status(), await audited.text()).toBe(200);
  const audit = await audited.json();
  const signed = await call(page, '/api/authorize', 'POST', {
    inspection_id: SOURCE,
    expected_revision: audit.revision,
    auth_id: AUTH,
    proposal_hash: audit.audit.proposal_hash,
    signature_png: await drawn(page),
    documents_confirmed: true,
  });
  expect(signed.status()).toBe(200);
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('the homeowner link shows the signed proposal and photo log, read-only, with no sign-in', async ({
  page,
  browser,
  browserName,
}) => {
  const url = await mint(page, 'homeowner');
  const home = await recipient(browser, url);
  const view = home.page;
  expect(home.response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(home.response.headers()['permissions-policy']).toBe('tools=()');
  await expect(view).toHaveTitle('Your signed estimate documents');
  await expect(view.locator('.sign-header h1')).toHaveText('Your signed estimate documents');
  await expect(view.locator('#documents')).toBeVisible();
  await expect(view.locator('#documents .section-head h2')).toHaveText(
    'Signed proposal and Photo audit log',
  );
  // Only this set's documents have tabs; the signing area never appears.
  for (const name of ['proposal', 'photos'])
    await expect(view.locator('[data-tab="' + name + '"]')).toBeVisible();
  for (const name of ['claim', 'defense'])
    await expect(view.locator('[data-tab="' + name + '"]')).toBeHidden();
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  await expect(view.locator('#signCanvas')).toBeHidden();
  await expect(view.locator('#documentProgress')).toBeHidden();
  await expect(view.locator('#downloadScope')).toBeHidden();
  await expect(view.locator('#printDocuments')).toBeVisible();
  await expect(view.locator('.totals-summary')).toBeVisible();
  await expect(view.locator('#doc-proposal > h2')).toContainText('Official proposal');
  await expect(view.locator('#signedReceipt')).toBeVisible();
  await expect(view.locator('#receiptText')).toContainText('Signed on ');
  await expect(view.locator('#receiptText')).toContainText('Reference ' + AUTH);
  await expect(view.locator('#viewUntil')).toContainText(
    'This link opens the signed documents until',
  );
  await expect(view.locator('#signedNotice')).toContainText('Reference ' + AUTH);
  await expect(view.locator('#savedSignature')).toBeVisible();
  // The estimator's AI notes never reach the recipient.
  await expect(view.locator('#auditNotes')).toHaveCount(0);
  await expect(view.locator('#proposalBody')).not.toContainText('technician review required');
  await view.locator('[data-tab="photos"]').click();
  const image = view.locator('#photoAuditLog img').first();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
  expect(await view.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  if (browserName === 'chromium')
    await view.screenshot({
      path: test.info().outputPath('document-link-homeowner.png'),
      fullPage: true,
    });
  // No sign-in anywhere: only the document-link header reaches the API, and nothing is written.
  const api = home.requests.filter((r) => new URL(r.url).pathname.startsWith('/api/'));
  expect(api.length).toBeGreaterThan(2);
  for (const request of api) {
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['x-adr-signing-link']).toBeUndefined();
    expect(request.headers['x-adr-document-link']).toBe(url.split('#')[1]);
  }
  expect(home.requests.some((r) => r.url.includes('/vendor/firebase/'))).toBe(false);
  // The same link opens again: it is not single-use.
  await view.reload();
  await expect(view.locator('#signedReceipt')).toBeVisible();
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  await view.emulateMedia({ media: 'print' });
  for (const name of ['proposal', 'photos'])
    await expect(view.locator('#doc-' + name)).toBeVisible();
  for (const name of ['claim', 'defense']) await expect(view.locator('#doc-' + name)).toBeHidden();
  await view.screenshot({ path: test.info().outputPath('homeowner-print.png'), fullPage: true });
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  await home.context.close();
});

test('the adjuster link shows the claim and letter with the scope JSON, and nothing of the proposal', async ({
  page,
  browser,
}) => {
  const url = await mint(page, 'adjuster', 'owner');
  const token = url.split('#')[1];
  const office = await recipient(browser, url);
  const view = office.page;
  await expect(view.locator('#documents .section-head h2')).toHaveText(
    'Itemized claim and Scope defense letter',
  );
  for (const name of ['claim', 'defense'])
    await expect(view.locator('[data-tab="' + name + '"]')).toBeVisible();
  for (const name of ['proposal', 'photos'])
    await expect(view.locator('[data-tab="' + name + '"]')).toBeHidden();
  await expect(view.locator('#doc-claim')).toBeVisible();
  await expect(view.locator('#claimItems tr')).not.toHaveCount(0);
  await expect(view.locator('.totals-summary')).toBeHidden();
  await expect(view.locator('#savedSignature')).toBeHidden();
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  await expect(view.locator('#receiptText')).toContainText('Reference ' + AUTH);
  await view.locator('[data-tab="defense"]').click();
  await expect(view.locator('#defenseBody')).toContainText('IICRC');
  // The scope-code JSON the app exports, from the documents this link delivered.
  const downloading = view.waitForEvent('download');
  await view.locator('#downloadScope').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('scope.json');
  const scope = JSON.parse(await new Response(await download.createReadStream()).text());
  expect(Array.isArray(scope) && scope.length > 0).toBe(true);
  expect(scope[0]).toHaveProperty('code');
  // Photos and the signature are not in this set.
  const refused = await view.evaluate(
    async ([token, photo]) => {
      const results = [];
      for (const path of ['/api/documents/photos/' + photo, '/api/documents/signature']) {
        const response = await fetch(path, { headers: { 'X-ADR-Document-Link': token } });
        results.push([response.status, (await response.json()).detail]);
      }
      return results;
    },
    [token, PHOTO],
  );
  expect(refused).toEqual([
    [404, UNAVAILABLE],
    [404, UNAVAILABLE],
  ]);
  await view.emulateMedia({ media: 'print' });
  for (const name of ['claim', 'defense']) await expect(view.locator('#doc-' + name)).toBeVisible();
  for (const name of ['proposal', 'photos'])
    await expect(view.locator('#doc-' + name)).toBeHidden();
  await view.screenshot({ path: test.info().outputPath('adjuster-print.png'), fullPage: true });
  await expect(view.locator('#homeownerSigning')).toBeHidden();
  await office.context.close();
});

test('expired, replaced, broken and wrong-kind links are refused', async ({ page, browser }) => {
  const first = await mint(page, 'homeowner');
  const replaced = await recipient(browser, first);
  await expect(replaced.page.locator('#documents')).toBeVisible();
  // Minting the same set again replaces the earlier link.
  const second = await mint(page, 'homeowner');
  await replaced.page.reload();
  await expect(replaced.page.locator('#signStatus')).toHaveText(UNAVAILABLE);
  await expect(replaced.page.locator('#signMain')).toBeHidden();
  const expired = await recipient(browser, second);
  await expect(expired.page.locator('#documents')).toBeVisible();
  await page.request.post('/__test/expire-document-links');
  await expired.page.reload();
  await expect(expired.page.locator('#signStatus')).toHaveText(UNAVAILABLE);
  await expect(expired.page.locator('#signMain')).toBeHidden();
  const broken = await recipient(browser, new URL('/documents#not-a-link', page.url()).href);
  await expect(broken.page.locator('#signStatus')).toContainText(
    'This document link is incomplete',
  );
  await expect(broken.page.locator('.sign-header h1')).toHaveText('Your signed estimate documents');
  // A document token opened on the signing page is not a signing link.
  const wrongKind = await recipient(
    browser,
    new URL('/sign#' + second.split('#')[1], page.url()).href,
  );
  await expect(wrongKind.page.locator('#signStatus')).toHaveText(
    'This signing link is not available. Ask your technician for a new link.',
  );
  for (const home of [replaced, expired, broken, wrongKind]) await home.context.close();
});

test('revoking both active sets refuses both recipients', async ({ page, browser }) => {
  const urls = [await mint(page, 'homeowner'), await mint(page, 'adjuster')];
  const readers = [];
  for (const url of urls) {
    const reader = await recipient(browser, url);
    await expect(reader.page.locator('#documents')).toBeVisible();
    readers.push(reader);
  }
  const revoked = await page.request.post('/__test/revoke-document-links', {
    data: { uid: uid('estimator'), auth_id: AUTH },
  });
  expect(await revoked.json()).toEqual({ homeowner: 'revoked', adjuster: 'revoked' });
  for (const reader of readers) {
    await reader.page.reload();
    await expect(reader.page.locator('#signStatus')).toHaveText(UNAVAILABLE);
    await reader.context.close();
  }
});

test('role downgrade stops documents, photos and signatures; other roles cannot mint', async ({
  page,
  browser,
}) => {
  for (const role of ['office', 'admin', 'other']) {
    const denied = await page.request.post('/__test/document-links', {
      data: { uid: uid(role), auth_id: AUTH, document_set: 'homeowner' },
    });
    expect(denied.status()).toBe(404);
  }
  const url = await mint(page, 'homeowner');
  const reader = await recipient(browser, url);
  await expect(reader.page.locator('#documents')).toBeVisible();
  const changed = await call(
    page,
    '/api/companies/adr/team/' + uid('estimator'),
    'PUT',
    { expected_version: 1, role: 'office', status: 'active' },
    'owner',
  );
  expect(changed.status(), await changed.text()).toBe(200);
  for (const path of [
    '/api/documents',
    '/api/documents/signature',
    '/api/documents/photos/' + PHOTO,
  ]) {
    const denied = await page.request.get(path, {
      headers: { 'X-ADR-Document-Link': url.split('#')[1] },
    });
    expect(denied.status()).toBe(404);
  }
  await reader.page.reload();
  await expect(reader.page.locator('#signStatus')).toHaveText(UNAVAILABLE);
  await reader.context.close();
});

test('tampering with a token cannot open documents', async ({ page, browser }) => {
  const url = await mint(page, 'homeowner');
  const bad = url.slice(0, -1) + (url.endsWith('A') ? 'B' : 'A');
  const reader = await recipient(browser, bad);
  await expect(reader.page.locator('#signStatus')).toHaveText(UNAVAILABLE);
  await expect(reader.page.locator('#signMain')).toBeHidden();
  await reader.context.close();
});

test('offline revisit does not expose cached signed documents', async ({ page, browser }) => {
  const url = await mint(page, 'homeowner');
  const reader = await recipient(browser, url);
  await expect(reader.page.locator('#documents')).toBeVisible();
  // A failed WebKit reload can retain the already rendered document. Start a fresh
  // navigation while keeping this context's HTTP cache and storage intact.
  await reader.page.goto('about:blank');
  await reader.context.setOffline(true);
  try {
    await reader.page.goto(url);
  } catch (error) {
    expect(String(error)).toMatch(/ERR_INTERNET_DISCONNECTED|WebKit encountered an internal error/);
  }
  await expect(reader.page.locator('#documents')).toHaveCount(0);
  await reader.context.close();
});

test('older signed records open without invented claim details or locations', async ({
  page,
  browser,
}) => {
  expect(
    (await page.request.post('/__test/old-document-record', { data: { auth_id: AUTH } })).ok(),
  ).toBe(true);
  const reader = await recipient(browser, await mint(page, 'homeowner'));
  await expect(reader.page.locator('#signedReceipt')).toBeVisible();
  await reader.page.locator('[data-tab="photos"]').click();
  await expect(reader.page.locator('#photoAuditLog')).toContainText('No location recorded');
  await reader.context.close();
});
