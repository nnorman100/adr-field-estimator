const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
const job = 'ADR-INS-' + 'c'.repeat(32);
test.use({ serviceWorkers: 'block' });
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary', 'ai_usage', 'readiness'] },
  });
});
test.afterEach(async ({ request, page }) => {
  await page.close();
  await request.post('/__test/workspaces', { data: { enabled: false } });
});
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
async function jobs(page) {
  if (await page.locator('#workspaceMenuToggle').isVisible())
    await page.locator('#workspaceMenuToggle').click();
  await page.locator('#dashboardJobs').click();
  await expect(page.getByRole('button', { name: /Assigned bathroom/ })).toBeVisible();
}
async function openJob(page) {
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#jobInsight')).toBeVisible();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect(page.locator('#jobInsight .insight-narrative')).toContainText(
    /Draft scope\.|Facts changed/,
  );
  if (
    (await page.locator('#jobInsight .insight-narrative').textContent()).includes('Facts changed')
  )
    await page.locator('#jobInsight').getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#jobInsight .insight-narrative')).toContainText('Draft scope.');
}
for (const width of [390, 320]) {
  for (const role of ['owner', 'office', 'estimator']) {
    test(`${role} summaries and usage at ${width}px`, async ({ page, context }) => {
      await page.setViewportSize({ width, height: 844 });
      await start(page, role);
      if (role === 'owner') {
        await expect(page.locator('.ai-usage')).toContainText('3 active members');
        await context.setOffline(true);
        await expect(page.locator('.ai-usage')).toContainText('Offline · last loaded counts.');
        await expect(page.locator('.ai-usage button')).toBeDisabled();
        await context.setOffline(false);
        await expect(page.locator('.ai-usage button')).toBeEnabled();
      } else await expect(page.locator('.ai-usage')).toHaveCount(0);
      await page.locator('#accountMenu > summary').click();
      await expect(page.locator('#aiQuota')).toContainText('AI calls left today');
      await page.locator('#accountMenu > summary').click();
      await jobs(page);
      await page.locator('.insight-expander > summary').click();
      await expect(page.locator('.insight-expander .insight-narrative')).toContainText(
        'Draft scope.',
      );
      await openJob(page);
      const card = page.locator('#jobInsight');
      await expect(card).toContainText('AI summary');
      await card.getByText('Saved job facts', { exact: true }).click();
      await expect(card).toContainText('Assigned bathroom');
      await expect(card).toContainText('3 air movers');
      await expect(card.getByRole('button', { name: /Accept|Approve|Send/ })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await context.setOffline(true);
      await expect(card).toContainText('Offline · last loaded summary');
      await expect(card.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
      await expect(card.locator('.insight-narrative')).toContainText('Draft scope.');
      await context.setOffline(false);
      await expect(card.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
      await page.locator('#jobMenu > summary').click();
      await page.getByRole('button', { name: 'Help', exact: true }).click();
      await expect(page.locator('#helpYours [data-help-topic="insight"]')).toBeVisible();
    });
  }
  test(`support only reads cached summaries and counts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await start(page, 'admin');
    await page.getByRole('button', { name: 'Manage companies', exact: true }).click();
    await page.getByRole('button', { name: 'Manage company', exact: true }).first().click();
    await page.getByRole('button', { name: 'Open read-only support view', exact: true }).click();
    await expect(page.locator('.ai-usage')).toContainText('3 active members');
    await page.locator('.insight-expander > summary').click();
    await expect(page.locator('.insight-expander')).toContainText('Support is read only');
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#dashboardContent .insight-card')).toContainText(
      'No current saved summary',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });
}

test('loading, provider failure keeps facts and Retry succeeds', async ({ page, request }) => {
  await request.post('/__test/fault', {
    data: { uid: uid('owner'), faults: { job_summary: 1, ai_usage: 1 } },
  });
  await start(page, 'owner');
  await expect(page.locator('.ai-usage')).toContainText('Usage unavailable');
  await page.locator('.ai-usage').getByRole('button', { name: 'Refresh usage' }).click();
  await expect(page.locator('.ai-usage')).toContainText('3 active members');
  await jobs(page);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/jobs/${job}/insight`, async (route) => {
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  const card = page.locator('#jobInsight');
  await expect(card).toContainText('Writing summary');
  await card.getByText('Saved job facts', { exact: true }).click();
  await expect(card).toContainText('Assigned bathroom');
  release();
  await expect(card).toContainText('Could not write the summary. Retry.');
  await card.getByRole('button', { name: 'Retry summary' }).click();
  await expect(card.locator('.insight-narrative')).toContainText('Draft scope.');
});

test('429 cooldown, changed facts, and offline never-opened card', async ({ page, context }) => {
  await start(page, 'estimator');
  await jobs(page);
  let first = true;
  await page.route(`**/api/jobs/${job}/insight`, (route) => {
    if (!first) return route.continue();
    first = false;
    return route.fulfill({
      status: 429,
      headers: { 'Retry-After': '1' },
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Too many requests' }),
    });
  });
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  const card = page.locator('#jobInsight');
  await expect(card).toContainText('Retry after 1 seconds');
  await expect(card.getByRole('button', { name: 'Retry summary' })).toBeEnabled();
  await card.getByRole('button', { name: 'Retry summary' }).click();
  await expect(card.locator('.insight-narrative')).toContainText('Draft scope.');
  // Save a genuine source change through the same API, then absorb that revision as queue saves do.
  await page.evaluate(async (id) => {
    const record = await jsonApi('/api/inspections/' + id);
    record.data.air_movers = 8;
    const updated = await jsonApi('/api/inspections/' + id, 'PUT', {
      expected_revision: record.revision,
      data: record.data,
    });
    absorb(updated);
  }, job);
  await expect(card).toContainText('Facts changed. Refresh');
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(card.locator('.insight-narrative')).toContainText('8 air movers');
  await context.setOffline(true);
  await page.evaluate(() => {
    InsightUI.reset();
    InsightUI.job();
  });
  await expect(card).toContainText('Connect to load the summary');
  await expect(card.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
});

test('disabled features and other company do not expose job summaries', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', { data: { enabled: true, ai_features: [] } });
  await start(page, 'owner');
  await jobs(page);
  await expect(page.locator('.insight-expander')).toHaveCount(0);
  await expect(page.locator('.ai-usage')).toHaveCount(0);
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#jobInsight')).toBeHidden();
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary', 'ai_usage'] },
  });
  const response = await request.get(`/api/jobs/${job}/insight`, {
    headers: { Authorization: 'Bearer ' + uid('other') },
  });
  expect(response.status()).toBe(404);
});

test('signed job rows and scope show the immutable agreement summary', async ({
  page,
  request,
}) => {
  await request.post('/__test/drying-watch', { data: {} });
  await page.setViewportSize({ width: 320, height: 844 });
  await start(page, 'estimator');
  await jobs(page);
  await page.locator('.insight-expander > summary').click();
  await expect(page.locator('.insight-expander .insight-narrative')).toContainText(
    'Signed agreement.',
  );
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('.task-nav [data-task="property"]').click();
  const card = page.locator('#jobInsight');
  await expect(card).toBeVisible();
  await expect(card.locator('.insight-narrative')).toContainText('Signed agreement.');
  await expect(page.locator('#address')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('an auth-state change clears private counts and cached summary UI', async ({ page }) => {
  await start(page, 'owner');
  await page.locator('#accountMenu > summary').click();
  await expect(page.locator('#aiQuota')).toContainText('AI calls left today');
  await page.evaluate(() => window.__testAuthChanged(null));
  await expect(page.locator('#authPanel')).toBeVisible();
  await expect(page.locator('#aiQuota')).toBeHidden();
  await expect(page.locator('#aiQuota')).toHaveText('');
  await expect(page.locator('#jobInsight')).toHaveText('');
  await expect(page.locator('.ai-usage')).toHaveCount(0);
});
