const { test, expect } = require('@playwright/test');
const JOB = 'ADR-INS-' + 'c'.repeat(32);
const headers = { Authorization: 'Bearer test-owner-ws-owner' };
test.use({ serviceWorkers: 'block' });
test.afterEach(async ({ page, request }) => {
  await page.close();
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

async function owner(page) {
  await page.addInitScript(() => sessionStorage.setItem('synthetic-uid', 'test-owner-ws-owner'));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}

test('monthly spending uses real settlement with synthetic provider usage and no count feature', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary'] },
  });
  const summary = await request.get(`/api/jobs/${JOB}/insight`, { headers });
  expect(summary.status()).toBe(200);
  const session = await (await request.get('/api/session', { headers })).json();
  expect(session.ai_spending.monthly_cap_microusd).toBe(10000000);
  expect(session.ai_spending.spent_microusd).toBe(990);
  expect(session.ai_spending.reserved_microusd).toBe(0);
  await owner(page);
  const card = page.locator('.ai-spending');
  await expect(card).toContainText('AI spending this month');
  await expect(card).toContainText('$0.00 of $10.00');
  await expect(card).toContainText('next UTC month');
  await expect(card).toContainText('soft limit');
  await expect(card.locator('.notice')).toHaveCount(0);
  expect(await card.locator('progress').evaluate((bar) => bar.value)).toBe(990);
  await expect(page.locator('.ai-usage')).toHaveCount(0);
});

test('monthly cap refuses generation while saved work and the owner display stay available', async ({
  page,
  request,
}) => {
  await request.post('/__test/workspaces', {
    data: { enabled: true, ai_features: ['job_summary'], ai_monthly_cap_microusd: 0 },
  });
  const before = await (await request.get(`/api/inspections/${JOB}`, { headers })).json();
  const refused = await request.get(`/api/jobs/${JOB}/insight`, { headers });
  expect(refused.status()).toBe(429);
  expect((await refused.json()).detail).toContain('next month (UTC)');
  const after = await (await request.get(`/api/inspections/${JOB}`, { headers })).json();
  expect(after).toEqual(before);
  expect(
    (await request.get(`/api/jobs/${JOB}/insight?facts_only=true`, { headers })).status(),
  ).toBe(200);
  await owner(page);
  await expect(page.locator('.ai-spending')).toContainText('$0.00 of $0.00');
  await expect(page.locator('.ai-spending')).toContainText('Drafts and agreements stay available');
});
