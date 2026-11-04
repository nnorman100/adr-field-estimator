const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
const JOB = 'ADR-INS-' + 'c'.repeat(32);

test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function setup(request, features = ['estimate_assist'], priceBooks = true) {
  await request.post('/__test/workspaces', {
    data: { enabled: true, price_books: priceBooks, ai_features: features },
  });
  await request.post('/__test/drying-watch', { data: {} });
}
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function openSigned(page) {
  await navigate(page, 'dashboardJobs');
  await page.getByRole('button', { name: /Assigned bathroom.*Signed/s }).click();
  await expect(page.locator('#savedSignature')).toBeVisible();
}
async function navigate(page, id) {
  await expect(page.locator('#workspaceNav')).toBeVisible();
  const toggle = page.locator('#workspaceMenuToggle');
  if (await toggle.isVisible()) {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  }
  await page.locator('#' + id).click();
}
const closedRow = (category, final, extra = {}) => ({
  auth_id: 'ADR-AUTH-history',
  signed_at: '2026-10-01T00:00:00+00:00',
  calculation_version: 'dryscope-v2',
  estimate_mode: 'range',
  sf: '500.00',
  category,
  single_category: true,
  low: '2000.00',
  high: '2500.00',
  labor_material_low: '1000.00',
  planned_days: 3,
  closed_at: '2026-10-20T00:00:00+00:00',
  closed_by_uid: 'test-owner-ws-owner',
  final,
  actual_days: 4,
  note: '',
  landed: Number(final) > 2500 ? 'above' : Number(final) < 2000 ? 'below' : 'inside',
  ...extra,
});
// Overruns of 5, 10, 15, 20 and 40 percent on category 2: 4 of 5 are covered by 20.
const SIX_CLOSED = Object.fromEntries(
  ['2050.00', '2100.00', '2150.00', '2200.00', '2400.00', '2700.00'].map((final, index) => [
    'ADR-INS-' + String(index).padStart(32, '0'),
    closedRow(2, final, index === 5 ? { single_category: false } : {}),
  ]),
);

for (const role of ['owner', 'office']) {
  test(`${role} closes a signed job with prefilled days, sees where it landed and can change it`, async ({
    page,
    request,
  }) => {
    await setup(request);
    await page.setViewportSize({ width: 390, height: 844 });
    await start(page, role);
    await openSigned(page);
    const card = page.locator('#jobClose');
    await expect(card).toBeVisible();
    await expect(card).toContainText('the signed plan');
    await expect(card.locator('#jobCloseDays')).toHaveValue('3');
    await card.locator('#jobCloseAmount').fill('12.345');
    await card.getByRole('button', { name: 'Record close' }).click();
    await expect(card).toContainText('Enter the final invoiced amount as dollars and cents.');
    await card.locator('#jobCloseAmount').fill('1.00');
    await card.locator('#jobCloseDays').fill('4');
    await card.locator('#jobCloseNote').fill('Synthetic close note');
    await card.getByRole('button', { name: 'Record close' }).click();
    await expect(card.locator('.job-close-result')).toContainText('invoiced $1.00');
    await expect(card.locator('.job-close-result')).toContainText('landed below the low end');
    await expect(card).toContainText('Actual drying days: 4');
    await expect(card).toContainText('Synthetic close note');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await card.getByRole('button', { name: 'Change' }).click();
    await expect(card.locator('#jobCloseAmount')).toHaveValue('1.00');
    await card.locator('#jobCloseAmount').fill('999999.00');
    await card.getByRole('button', { name: 'Record close' }).click();
    await expect(card.locator('.job-close-result')).toContainText('landed above the high end');
    // The record survives opening the job again.
    await page.reload();
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await openSigned(page);
    await expect(page.locator('#jobClose .job-close-result')).toContainText('$999,999.00');
    await page.locator('#jobMenu > summary').click();
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.locator('#helpYours [data-help-topic="job-close"]')).toBeVisible();
    await expect(page.locator('#helpYours [data-help-topic="estimate-accuracy"]')).toHaveCount(
      role === 'owner' ? 1 : 0,
    );
  });
}

test('an estimator sees no card and asks for no close record', async ({ page, request }) => {
  await setup(request);
  const asked = [];
  page.on('request', (r) => {
    if (/\/api\/.*(\/outcome|\/estimate-accuracy)/.test(r.url())) asked.push(r.url());
  });
  await start(page, 'estimator');
  await openSigned(page);
  await expect(page.locator('#jobClose')).toBeHidden();
  await expect(page.locator('.estimate-accuracy')).toHaveCount(0);
  expect(asked).toEqual([]);
});

test('offline the card says to connect and nothing can be recorded', async ({
  page,
  request,
  context,
}) => {
  await setup(request);
  await start(page, 'office');
  await openSigned(page);
  const card = page.locator('#jobClose');
  await expect(card.locator('#jobCloseAmount')).toBeVisible();
  await card.locator('#jobCloseAmount').fill('250.00');
  await context.setOffline(true);
  await expect(card).toContainText('Connect to record the close.');
  await expect(card.getByRole('button', { name: 'Record close' })).toBeDisabled();
  // What was typed stays, and nothing was queued to send later.
  await expect(card.locator('#jobCloseAmount')).toHaveValue('250.00');
  await context.setOffline(false);
  await expect(card.getByRole('button', { name: 'Record close' })).toBeEnabled();
  await expect(card.locator('.job-close-result')).toHaveCount(0);
});

test('a finished drying watch prefills the actual days', async ({ page, request }) => {
  await setup(request, ['estimate_assist', 'drying_watch']);
  const headers = { Authorization: 'Bearer ' + uid('office'), 'X-ADR-Workspace-Protocol': '1' };
  const watch = await (await page.request.get(`/api/jobs/${JOB}/drying-watch`, { headers })).json();
  const marked = await page.request.post(`/api/jobs/${JOB}/drying-watch/state`, {
    headers,
    data: {
      action: 'mark_dry',
      reason: 'All materials checked on the visit.',
      facts_hash: watch.facts_hash,
      request_id: 'a'.repeat(32),
      approved: true,
    },
  });
  expect(marked.ok()).toBe(true);
  await start(page, 'office');
  await openSigned(page);
  const card = page.locator('#jobClose');
  await expect(card).toContainText('from drying watch');
  await expect(card.locator('#jobCloseDays')).toHaveValue(String(watch.day_number));
});

test('the owner sees the numbers and a suggestion only reaches the working copy', async ({
  page,
  request,
}) => {
  await setup(request);
  await request.post('/__test/price-table', { data: {} });
  await request.post('/__test/estimate-history', { data: { rows: SIX_CLOSED } });
  await page.setViewportSize({ width: 390, height: 844 });
  await start(page, 'owner');
  const dashboard = page.locator('#dashboardContent .estimate-accuracy');
  await expect(dashboard).toContainText(
    '5 of 6 closed jobs landed inside the range · 1 above · 0 below',
  );
  await dashboard.getByRole('button', { name: 'Open' }).click();
  const section = page.locator('#estimateAccuracy');
  await expect(section).toContainText('In 5 of 6 closed jobs the final invoice landed inside');
  await expect(section).toContainText(
    'Category 2 rooms: a 20% allowance would have covered 4 of 5 of your 5 single-category jobs.',
  );
  await expect(section).toContainText('hidden damage, more equipment, approved extras');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const line = section.locator('[data-path="assist.hidden_damage_percent.2"]');
  await expect(line).toContainText('Suggested: 20% (now 15%)');
  await expect(page.locator('#priceUnpublished')).toBeHidden();
  const saved = page.waitForResponse(
    (r) => r.url().includes('/prices/working-copy') && r.request().method() === 'PUT' && r.ok(),
  );
  await line.getByRole('button', { name: 'Use suggestion' }).click();
  await expect(line).toContainText('Suggested: 20% (now 20%)');
  await expect(line.getByRole('button', { name: 'Use suggestion' })).toHaveCount(0);
  await expect(page.locator('#priceUnpublished')).toBeVisible();
  await saved;
  await page.locator('#priceReason').fill('Use the suggested allowance');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText(
    'Hidden damage in category 2 rooms (%): 15 to 20',
  );
  // Published prices did not change: the current table still reads 15 on a fresh read.
  const headers = { Authorization: 'Bearer ' + uid('owner'), 'X-ADR-Workspace-Protocol': '1' };
  const view = await (await page.request.get('/api/companies/adr/prices', { headers })).json();
  expect(view.policy.assist.hidden_damage_percent['2']).toBe('15');
  expect(view.working_copy.policy.assist.hidden_damage_percent['2']).toBe('20');
});

test('a cushion suggestion below the cushion beyond is held there, saves and reaches review', async ({
  page,
  request,
}) => {
  await setup(request);
  await request.post('/__test/price-table', {
    data: { policy: { assist: { range_method: 'cushion' } } },
  });
  // Overruns of 0, 3, 6, 9, 11 and 12 percent: 15 would cover 4 of 5, under the published 20.
  const rows = Object.fromEntries(
    ['2000.00', '2030.00', '2060.00', '2090.00', '2110.00', '2120.00'].map((final, index) => [
      'ADR-INS-' + String(index).padStart(32, '0'),
      closedRow(1, final),
    ]),
  );
  await request.post('/__test/estimate-history', { data: { rows } });
  await start(page, 'owner');
  await navigate(page, 'dashboardPrices');
  const section = page.locator('#estimateAccuracy');
  await expect(section).toContainText('Range cushion: 15% on labor and materials');
  await expect(section).toContainText('The suggestion is 20%');
  const line = section.locator('[data-path="range.first_percent"]');
  await expect(line).toContainText('Suggested: 20% (now 50%)');
  const saved = page.waitForResponse(
    (r) => r.url().includes('/prices/working-copy') && r.request().method() === 'PUT',
  );
  await line.getByRole('button', { name: 'Use suggestion' }).click();
  expect((await saved).ok()).toBe(true);
  await expect(line).toContainText('Suggested: 20% (now 20%)');
  await expect(page.locator('[name="policy_range.first_percent"]')).toHaveValue('20');
  await page.locator('#priceReason').fill('Use the suggested cushion');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('#priceReview')).toContainText(
    'Cushion on the first square feet (%): 50 to 20',
  );
});

test('a rate-book company sees its numbers and the note about its own price table', async ({
  page,
  request,
}) => {
  await setup(request);
  await request.post('/__test/estimate-history', { data: { rows: SIX_CLOSED } });
  await start(page, 'owner');
  await expect(page.locator('#dashboardContent .estimate-accuracy')).toContainText(
    '5 of 6 closed jobs landed inside the range',
  );
  await navigate(page, 'dashboardPrices');
  const section = page.locator('#estimateAccuracy');
  await expect(section).toContainText('In 5 of 6 closed jobs');
  await expect(section).toContainText('Suggestions apply to your own price table.');
  await expect(section.getByRole('button', { name: 'Use suggestion' })).toHaveCount(0);
});

test('with no closed jobs the dashboard says how to start', async ({ page, request }) => {
  await setup(request);
  await start(page, 'owner');
  await expect(page.locator('#dashboardContent .estimate-accuracy')).toContainText(
    'Close a signed job to start tracking.',
  );
});

test('office staff see no accuracy numbers', async ({ page, request }) => {
  await setup(request);
  await start(page, 'office');
  await expect(page.locator('#dashboardContent .estimate-accuracy')).toHaveCount(0);
});

test('with the flag off nothing shows', async ({ page, request }) => {
  await setup(request, []);
  await start(page, 'owner');
  await expect(page.locator('#dashboardContent .estimate-accuracy')).toHaveCount(0);
  await openSigned(page);
  await expect(page.locator('#jobClose')).toBeHidden();
  await page.locator('#jobMenu > summary').click();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.locator('[data-help-topic="job-close"]')).toHaveCount(0);
  await expect(page.locator('[data-help-topic="estimate-accuracy"]')).toHaveCount(0);
});
