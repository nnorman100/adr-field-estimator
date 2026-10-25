const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
const job = 'ADR-INS-' + 'c'.repeat(32);

test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['drying_watch'] },
  });
  await request.post('/__test/drying-watch', { data: {} });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function open(page, role) {
  await start(page, role);
  const list = page.locator('.drying-watch-list');
  await expect(list).toContainText('Assigned bathroom');
  await list.getByRole('button', { name: 'Assigned bathroom', exact: true }).click();
  await expect(page.locator('#dryingWatch')).toBeVisible();
  await expect(page.locator('#dryingWatch .watch-summary')).toHaveText(
    /Day \d+ of 3\. Room 1 \(Bathroom\): no new reading\./,
  );
}

for (const width of [390, 320]) {
  for (const role of ['owner', 'office', 'estimator']) {
    test(`${role} sees facts, approvals and offline state at ${width}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, role);
      const card = page.locator('#dryingWatch');
      await expect(card).toContainText('AI summary');
      await expect(card).toContainText('Day 1 of 3 signed days');
      await expect(card.getByRole('button', { name: 'Mark dry', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Extend plan', exact: true })).toHaveCount(
        role === 'estimator' ? 0 : 1,
      );
      await expect(card.getByRole('button', { name: /^Remind / })).toHaveCount(
        role === 'estimator' ? 0 : 2,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await context.setOffline(true);
      await expect(card).toContainText('Offline · last loaded state');
      await expect(card.getByRole('button', { name: 'Mark dry', exact: true })).toBeDisabled();
      await expect(card).toContainText('Day 1 of 3');
      await context.setOffline(false);
      await expect(card.getByRole('button', { name: 'Mark dry', exact: true })).toBeEnabled();
      await card.getByRole('button', { name: 'Mark dry', exact: true }).click();
      await expect(card.locator('#watchApproval')).toContainText(
        'Mark this job dry with your reason?',
      );
      await expect(card).toContainText('Monitoring');
      await card.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(card.locator('#watchApproval')).toHaveCount(0);
      await card.getByRole('button', { name: 'Mark dry', exact: true }).click();
      await card.getByLabel('Reason', { exact: true }).fill('All materials checked on the visit.');
      await card.getByRole('button', { name: 'Confirm change', exact: true }).click();
      await expect(card).toContainText('Marked dry by staff');
      await expect(card).toContainText('All materials checked on the visit.');
      await page.locator('#jobMenu > summary').click();
      await page.getByRole('button', { name: 'Help', exact: true }).click();
      await expect(page.locator('#helpYours [data-help-topic="drying-watch"]')).toBeVisible();
    });
  }
  test(`superadmin sees read-only drying watch at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await start(page, 'admin');
    await page.getByRole('button', { name: 'Manage companies', exact: true }).click();
    await page.getByRole('button', { name: 'Manage company', exact: true }).first().click();
    await page.getByRole('button', { name: 'Open read-only support view', exact: true }).click();
    const list = page.locator('.drying-watch-list');
    await expect(list).toContainText('Drying watch · read only');
    await expect(list).toContainText('Day 1 of 3');
    await expect(
      list.getByRole('button', { name: /Remind|Mark dry|Extend plan|Close monitoring/ }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });
}

test('feature off and unassigned or other-company users never see this job', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
  await start(page, 'owner');
  await expect(page.locator('.drying-watch-list')).toHaveCount(0);
  await expect(page.locator('#dryingWatch')).toBeHidden();
});
for (const role of ['unassigned', 'other']) {
  test(`${role} has no drying job from another access scope`, async ({ page }) => {
    await start(page, role);
    await expect(page.locator('.drying-watch-list')).toContainText('No signed drying jobs yet.');
    await expect(page.locator('.drying-watch-list')).not.toContainText('Assigned bathroom');
  });
}

test('loading, failed summary, rate limit and retry keep deterministic facts visible', async ({
  page,
  request,
}) => {
  await request.post('/__test/fault', {
    data: { uid: uid('office'), faults: { drying_summary: 1 } },
  });
  await start(page, 'office');
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/jobs/' + job + '/drying-watch', async (route) => {
    await held;
    await route.continue();
  });
  await page
    .locator('.drying-watch-list')
    .getByRole('button', { name: 'Assigned bathroom', exact: true })
    .click();
  const card = page.locator('#dryingWatch');
  await expect(card).toContainText('Loading drying watch…');
  release();
  await expect(card).toContainText('Could not write the summary. Retry.');
  await expect(card).toContainText('Day 1 of 3');
  await page.route('**/drying-watch/summary', (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '1' },
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Limit reached.' }),
    }),
  );
  await card.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(card).toContainText('Retry after 1 seconds');
  await expect(card.getByRole('button', { name: 'Retry summary', exact: true })).toBeDisabled();
  await page.unroute('**/drying-watch/summary');
  await expect(card.getByRole('button', { name: 'Retry summary', exact: true })).toBeEnabled();
  await card.getByRole('button', { name: 'Retry summary', exact: true }).click();
  await expect(card.locator('.watch-summary')).toHaveText(
    /Day \d+ of 3\. Room 1 \(Bathroom\): no new reading\./,
  );
});

test('reminder needs confirmation, records failure and retries; extension never changes plan', async ({
  page,
  request,
}) => {
  // Reset so this signed fixture has one fake failure, followed by one successful fake email.
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['drying_watch'] },
  });
  await request.post('/__test/drying-watch', { data: { send_fail: true } });
  await open(page, 'office');
  const card = page.locator('#dryingWatch');
  await card
    .getByRole('button', { name: 'Remind ' + uid('estimator') + '@example.invalid', exact: true })
    .click();
  await expect(card.locator('#watchApproval')).toContainText('Send one reminder');
  await expect(card.locator('.watch-reminder')).toHaveCount(0);
  await card.getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await expect(card.locator('.watch-reminder')).toContainText('failed');
  await card.getByRole('button', { name: 'Retry reminder', exact: true }).click();
  await card.getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await expect(card.locator('.watch-reminder')).toContainText('sent');
  await expect(card.locator('.watch-reminder')).toHaveCount(1);
  await card.getByRole('button', { name: 'Extend plan', exact: true }).click();
  await card
    .getByLabel('Reason', { exact: true })
    .fill('Recheck tomorrow; separate agreement for extra days.');
  await card.getByRole('button', { name: 'Confirm change', exact: true }).click();
  await expect(card).toContainText('Plan extension note: Recheck tomorrow');
  await expect(card).toContainText('of 3 signed days');
});

test('owner switch starts off and hides reminder controls', async ({ page, request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['drying_watch'] },
  });
  await request.post('/__test/drying-watch', { data: { reminders: false } });
  await open(page, 'owner');
  await expect(page.locator('#dryingWatch')).toContainText(
    'The owner must enable drying reminders',
  );
  await expect(page.locator('#dryingWatch').getByRole('button', { name: /^Remind / })).toHaveCount(
    0,
  );
});
