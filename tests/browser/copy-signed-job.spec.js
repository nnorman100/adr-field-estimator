const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const uid = (role) => 'test-owner-ws-' + role;
const SOURCE = 'ADR-INS-' + 'c'.repeat(32);
const AUTH = 'ADR-AUTH-copysigned1';
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
  });
  expect(signed.status()).toBe(200);
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('a signed job is copied to a new draft that holds only its scope', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await start(page, 'estimator');
  await openSigned(page);
  await page.locator('#jobMenu summary').click();
  const copy = page.getByRole('button', { name: 'Copy to new draft' });
  await expect(copy).toBeEnabled();
  await copy.click();
  // The new draft opens for editing; the signed job keeps its record.
  await expect(page.locator('#savedSignature')).toBeHidden();
  await expect(page.locator('#inspectionFields')).toBeEnabled();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
  await expect(page.getByRole('button', { name: 'Copy to new draft' })).toBeHidden();
  const drafts = await (await call(page, '/api/inspections')).json();
  const draft = drafts.inspections.find((r) => r.status === 'draft');
  expect(draft.inspection_id).not.toBe(SOURCE);
  const record = await (await call(page, '/api/inspections/' + draft.inspection_id)).json();
  expect(record.copied_from).toEqual({ auth_id: AUTH, inspection_id: SOURCE });
  expect(record.photos).toEqual([]);
  expect(record.audit).toBeNull();
  const source = await (await call(page, '/api/inspections/' + SOURCE)).json();
  expect(source.status).toBe('signed');
  expect(errors).toEqual([]);
});

test('copying needs a connection and says so', async ({ page, context }) => {
  await start(page, 'owner');
  await openSigned(page);
  await context.setOffline(true);
  await page.locator('#jobMenu summary').click();
  const copy = page.locator('#copyToDraft');
  await expect(copy).toBeDisabled();
  await expect(copy).toHaveText('Copy to new draft (needs a connection)');
  await context.setOffline(false);
  await expect(copy).toBeEnabled();
  await expect(copy).toHaveText('Copy to new draft');
});

test('office sees the action on a signed job and another company is refused', async ({ page }) => {
  await start(page, 'office');
  await openSigned(page);
  await page.locator('#jobMenu summary').click();
  await expect(page.locator('#copyToDraft')).toBeVisible();
  expect(
    (
      await call(
        page,
        '/api/authorizations/' + AUTH + '/copy',
        'POST',
        {
          inspection_id: 'ADR-INS-' + 'd'.repeat(32),
        },
        'other',
      )
    ).status(),
  ).toBe(404);
});
