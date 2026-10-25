const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const uid = (role) => 'test-owner-ws-' + role;
const SOURCE = 'ADR-INS-' + 'c'.repeat(32);
const AUTH = 'ADR-AUTH-deliverystatus1';

async function call(page, path, method = 'GET', body, role = 'estimator') {
  return page.request.fetch(path, {
    method,
    headers: { Authorization: 'Bearer ' + uid(role), 'X-ADR-Workspace-Protocol': '1' },
    ...(body ? { data: body } : {}),
  });
}
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function openSigned(page) {
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom.*Signed/s }).click();
  await expect(page.locator('#savedSignature')).toBeVisible();
}

test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  const company = await call(page, '/api/companies/adr', 'GET', undefined, 'owner');
  const profile = (await company.json()).profile;
  expect(
    (
      await call(
        page,
        '/api/companies/adr',
        'PUT',
        { expected_version: 1, profile: { ...profile, document_delivery: true } },
        'owner',
      )
    ).status(),
  ).toBe(200);
  const job = await (
    await call(page, '/api/jobs/' + SOURCE + '/coordination', 'GET', undefined, 'office')
  ).json();
  expect(
    (
      await call(
        page,
        '/api/jobs/' + SOURCE + '/coordination',
        'PUT',
        { expected_version: job.version, customer_email: 'home@example.invalid' },
        'office',
      )
    ).status(),
  ).toBe(200);
  const audit = await (
    await call(page, '/api/audit', 'POST', { inspection_id: SOURCE, expected_revision: 1 })
  ).json();
  await page.goto('/app');
  const signature = await page.evaluate(() => {
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
  const signed = await call(page, '/api/authorize', 'POST', {
    inspection_id: SOURCE,
    expected_revision: audit.revision,
    auth_id: AUTH,
    proposal_hash: audit.audit.proposal_hash,
    signature_png: signature,
    documents_confirmed: true,
    email_copy: true,
  });
  expect(signed.status()).toBe(200);
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner sees a failed delivery and resend needs a connection', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, 'owner');
  await openSigned(page);
  const panel = page.locator('#deliveryStatus');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Homeowner: Failed');
  await expect(panel).toContainText('Delivery failed: Resend');
  const resend = page.locator('#resendDelivery');
  await expect(resend).toBeEnabled();
  await expect(resend).toHaveText('Resend');
  await context.setOffline(true);
  await expect(resend).toBeDisabled();
  await expect(resend).toHaveText('Resend (needs a connection)');
  await context.setOffline(false);
  await expect(resend).toBeEnabled();
  await resend.click();
  await expect(panel).toContainText('Homeowner: Failed');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  expect(errors).toEqual([]);
});

test('office can resend, an estimator cannot see status, and support is read-only', async ({
  page,
}) => {
  await start(page, 'office');
  await openSigned(page);
  await expect(page.locator('#resendDelivery')).toBeVisible();
  await start(page, 'estimator');
  await openSigned(page);
  await expect(page.locator('#deliveryStatus')).toBeHidden();
  expect(
    (
      await call(page, '/api/jobs/' + SOURCE + '/delivery/resend', 'POST', {}, 'estimator')
    ).status(),
  ).toBe(403);
  expect(
    (await call(page, '/api/jobs/' + SOURCE + '/delivery/resend', 'POST', {}, 'admin')).status(),
  ).toBe(403);
  expect(
    (await call(page, '/api/jobs/' + SOURCE + '/delivery/resend', 'POST', {}, 'other')).status(),
  ).toBe(404);
  await start(page, 'admin');
  await page.locator('#dashboardAdmin').click();
  await page
    .locator('.dashboard-card')
    .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
    .getByRole('button', { name: 'Manage company' })
    .click();
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: /Signed agreement/ }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Homeowner: Failed');
  await expect(page.locator('#dashboardContent')).toContainText(
    'Resend is not available in the support view.',
  );
  await expect(page.locator('#resendDelivery')).toBeHidden();
});
