const { test, expect } = require('@playwright/test');
const { checkScope } = require('./actions');
const uid = (role) => 'test-owner-ws-' + role;
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['priced_extras'] },
  });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function open(page, role = 'owner') {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await checkScope(page);
}
async function scope(page) {
  await page.locator('#address').fill('Synthetic extras property');
  await page.locator('#yearBuilt').fill('2000');
  await page.locator('[data-room-key="finished_sf"]').first().fill('10');
  await page.locator('#technicianNotes').fill('Move and reset toilet');
  await page.locator('#scopeConfirmed').check();
}
async function add(page) {
  await page.locator('#extraHours').fill('2.5');
  await page.locator('#retryExtraQuote').click();
  await expect(page.locator('#extraQuote')).toContainText('$118.65');
  await page.locator('#saveExtra').click();
  await expect(page.locator('#extraDialog')).toBeHidden();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
for (const width of [320, 390]) {
  test(`owner prices, approves and renders exact wording at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await scope(page);
    await page.locator('#finishAudit').click();
    await expect(page.locator('#priceUnpriced')).toBeVisible();
    await expect(page.locator('#authorizeJob')).toBeDisabled();
    await page.locator('#unpricedItems').getByRole('button', { name: 'Add as extra' }).click();
    await expect(page.locator('#extraDescription')).toHaveValue('Move and reset toilet');
    expect(
      await page.locator('#extraDialog').evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    const hours = await page.locator('.extra-quantity label').boundingBox();
    const price = await page.locator('#extraQuote').boundingBox();
    if (width === 320) expect(price.y).toBeGreaterThanOrEqual(hours.y + hours.height);
    else expect(price.x).toBeGreaterThan(hours.x);
    await add(page);
    await expect(page.locator('#reviewExtrasList')).toContainText('Pending owner approval');
    await page
      .locator('#reviewExtrasList')
      .getByRole('button', { name: 'Review & approve' })
      .click();
    await expect(page.locator('#extraQuote')).toContainText('$118.65');
    await page.locator('#extraOwnerName').fill('Test Owner');
    await page.locator('#saveExtra').click();
    await expect(page.locator('#extraDialog')).toBeHidden();
    await expect(page.locator('#reviewExtrasList')).toContainText('Approved by Test Owner');
    await checkScope(page);
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#authorizeJob')).toBeEnabled();
    const date = await page
      .locator('#extrasList')
      .innerText()
      .then((text) => text.match(/on (\d{4}-\d{2}-\d{2})/)[1]);
    const wording = `Additional work, not in Alert Disaster Restoration price sheet: Move and reset toilet, 2.5 h at $47.46/h, approved by Test Owner on ${date}.`;
    await expect(page.locator('#proposalBody')).toContainText(wording);
    await page.locator('[data-tab="claim"]').click();
    await expect(page.locator('#claimCards')).toContainText(wording);
    await page.locator('#jobMenu > summary').click();
    await page.locator('#helpButton').click();
    await expect(page.locator('[data-help-topic="extras"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
  test(`estimator offline edits and retry at ${width}`, async ({ page, context, request }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, 'estimator');
    await scope(page);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await context.setOffline(true);
    await page.locator('#newExtra').click();
    await page.locator('#extraDescription').fill('Move and reset toilet');
    await page.locator('#extraHours').fill('2.5');
    await page.locator('#saveExtra').click();
    await expect(page.locator('#extrasList')).toContainText('Pending owner approval');
    await expect(
      page.locator('#extrasList').getByRole('button', { name: 'Review & approve' }),
    ).toHaveCount(0);
    await context.setOffline(false);
    await expect(page.locator('#saveStatus')).toHaveText('Saved');
    await request.post('/__test/fault', {
      data: { uid: uid('estimator'), faults: { extra_quote: 1 } },
    });
    await page.locator('#extrasList').getByRole('button', { name: 'Edit extra' }).click();
    await expect(page.locator('#extraQuote')).toContainText('Retry with Refresh price');
    await page.locator('#retryExtraQuote').click();
    await expect(page.locator('#extraQuote')).toContainText('$118.65');
    await page.locator('#cancelExtra').click();
    await page.locator('#scopeConfirmed').check();
    await page.locator('#finishAudit').click();
    await expect(page.locator('#auditWarnings')).toContainText('owner approval');
    await expect(page.locator('#authorizeJob')).toBeDisabled();
  });
}
test('owner approval failure retains pending work; offline approval disabled', async ({
  page,
  context,
  request,
}) => {
  await open(page);
  await scope(page);
  await page.locator('#newExtra').click();
  await page.locator('#extraDescription').fill('Move and reset toilet');
  await add(page);
  await context.setOffline(true);
  await expect(
    page.locator('#extrasList').getByRole('button', { name: 'Review & approve' }),
  ).toBeDisabled();
  await context.setOffline(false);
  await page.locator('#extrasList').getByRole('button', { name: 'Review & approve' }).click();
  await expect(page.locator('#extraQuote')).toContainText('$118.65');
  await page.locator('#extraOwnerName').fill('Test Owner');
  await request.post('/__test/fault', {
    data: { uid: uid('owner'), faults: { extra_approve: 1 } },
  });
  await page.locator('#saveExtra').click();
  await expect(page.locator('#extraStatus')).toContainText('Your draft is preserved');
  await expect(page.locator('#saveExtra')).toBeDisabled();
  await page.locator('#retryExtraQuote').click();
  await expect(page.locator('#extraQuote')).toContainText('$118.65');
  await page.locator('#saveExtra').click();
  await expect(page.locator('#extraDialog')).toBeHidden();
  await expect(page.locator('#extrasList')).toContainText('Approved by Test Owner');
});
for (const role of ['office', 'admin']) {
  test(`${role} has no pricing or approval controls`, async ({ page }) => {
    await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    if (role === 'office') {
      await page.getByRole('button', { name: 'New job', exact: true }).click();
      await checkScope(page);
    }
    await expect(page.locator('#additionalWork')).toBeHidden();
    await page.locator('#helpButton').click();
    await expect(page.locator('[data-help-topic="extras"]')).toHaveCount(0);
  });
}
test('flag off hides extras and rate settings; owner edits rate when enabled', async ({
  page,
  request,
}) => {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid('owner'));
  await page.goto('/app');
  await page.locator('#dashboardProfile').click();
  const rate = page.getByLabel('Additional work hourly rate ($/h)', { exact: true });
  await expect(rate).toHaveValue('47.46');
  await rate.fill('62.50');
  await page.getByRole('button', { name: 'Save company details' }).click();
  await expect(rate).toHaveValue('62.50');
  await request.post('/__test/workspaces', { data: { enabled: true, ai_features: [] } });
  await page.reload();
  await page.locator('#dashboardProfile').click();
  await expect(rate).toHaveCount(0);
});

for (const width of [320, 390]) {
  for (const role of ['office', 'admin']) {
    test(`${role} reads pending extras without approval controls at ${width}`, async ({
      page,
      request,
    }) => {
      const id = 'ADR-INS-' + 'c'.repeat(32);
      const headers = {
        Authorization: 'Bearer ' + uid('estimator'),
        'X-ADR-Workspace-Protocol': '1',
      };
      const record = await (await request.get('/api/inspections/' + id, { headers })).json();
      const saved = await request.put('/api/inspections/' + id, {
        headers,
        data: {
          expected_revision: record.revision,
          data: {
            ...record.data,
            extras: [
              {
                id: 'e'.repeat(32),
                description: 'Move and reset toilet',
                hours: '2.5',
                origin: 'manual',
                unpriced_item: '',
                approval: null,
              },
            ],
          },
        },
      });
      expect(saved.status()).toBe(200);
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript(
        (value) => sessionStorage.setItem('synthetic-uid', value),
        uid(role),
      );
      await page.goto('/app');
      await expect(page.locator('#workspaceDashboard')).toBeVisible();
      if (role === 'admin') {
        await page.locator('#workspaceMenuToggle').click();
        await page.locator('#dashboardAdmin').click();
        await page
          .locator('.dashboard-card')
          .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
          .getByRole('button', { name: 'Manage company' })
          .click();
        await page.getByRole('button', { name: 'Open read-only support view' }).click();
      }
      await page.locator('.job-link').filter({ hasText: 'Assigned bathroom' }).click();
      if (role === 'office') {
        await checkScope(page);
        await expect(page.locator('#additionalWork')).toContainText('Pending owner approval');
        await expect(page.locator('#extrasList button')).toHaveCount(0);
        await expect(page.locator('#newExtra')).toBeHidden();
      } else {
        await expect(page.locator('#dashboardContent')).toContainText(
          'Additional work · read-only',
        );
        await expect(page.locator('#dashboardContent')).toContainText(
          'Move and reset toilet · 2.5 h · Pending owner approval',
        );
        await expect(page.getByRole('button', { name: 'Review & approve' })).toHaveCount(0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
}

test('conflict recovery copies quantities into a new draft without carrying owner approval', async ({
  page,
}) => {
  await open(page);
  await scope(page);
  await page.locator('#newExtra').click();
  await page.locator('#extraDescription').fill('Move and reset toilet');
  await add(page);
  await page.locator('#extrasList').getByRole('button', { name: 'Review & approve' }).click();
  await expect(page.locator('#extraQuote')).toContainText('$118.65');
  await page.locator('#extraOwnerName').fill('Test Owner');
  await page.locator('#saveExtra').click();
  await expect(page.locator('#extraDialog')).toBeHidden();
  const original = await page.evaluate(() => state.draft.inspection_id);
  const headers = { Authorization: 'Bearer ' + uid('owner'), 'X-ADR-Workspace-Protocol': '1' };
  const record = await (await page.request.get('/api/inspections/' + original, { headers })).json();
  const changed = await page.request.put('/api/inspections/' + original, {
    headers,
    data: {
      expected_revision: record.revision,
      data: { ...record.data, technician_notes: 'Another device changed this scope' },
    },
  });
  expect(changed.status()).toBe(200);
  await page.locator('#technicianNotes').fill('Keep local work in a new draft');
  await expect(page.locator('#conflictActions')).toBeVisible();
  await page.locator('#forkLocal').click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#extrasList')).toContainText('Pending owner approval');
  expect(await page.evaluate(() => state.draft.inspection_id)).not.toBe(original);
  const source = await (await page.request.get('/api/inspections/' + original, { headers })).json();
  expect(source.data.extras[0].approval.accepted_by_name).toBe('Test Owner');
});
