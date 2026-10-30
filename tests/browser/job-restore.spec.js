const { test, expect } = require('@playwright/test');
// Archived drafts can be restored, and superadmin support can archive a draft for a company whose
// owner cannot sign in.
async function start(page, role) {
  await page.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    'test-owner-ws-' + role,
  );
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('owner restores an archived draft from Archived drafts', async ({ page }) => {
  await start(page, 'owner');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.locator('#archiveJob').click();
  await page.locator('#confirmArchive').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
  const folder = page.locator('.archived-drafts');
  await folder.locator('summary').click();
  const card = folder.locator('.dashboard-card').filter({ hasText: 'Assigned bathroom' });
  await expect(card).toContainText('Archived ');
  await card.getByRole('button', { name: 'Restore draft' }).click();
  await expect(page.locator('#message')).toHaveText('Draft restored to the job list.');
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
});

test('support archives a draft in a suspended company and restores it', async ({ page }) => {
  await start(page, 'admin');
  await page.locator('#dashboardAdmin').click();
  await page
    .locator('.dashboard-card')
    .filter({ has: page.getByRole('heading', { name: 'Alert Disaster Restoration' }) })
    .getByRole('button', { name: 'Manage company' })
    .click();
  await page.getByRole('button', { name: 'Suspend company' }).click();
  await expect(page.locator('#dashboardContent')).toContainText('Company status: suspended');
  await page.getByRole('button', { name: 'Open read-only support view' }).click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await page.getByRole('button', { name: 'Archive draft (support action)' }).click();
  await expect(page.locator('#archiveDialog')).toBeVisible();
  await page.locator('#confirmArchive').click();
  await expect(page.locator('#message')).toHaveText('Draft archived.');
  await expect(page.getByRole('button', { name: /Assigned bathroom/ })).toHaveCount(0);
  await page.locator('.archived-drafts summary').click();
  await page
    .locator('.archived-drafts .dashboard-card')
    .filter({ hasText: 'Assigned bathroom' })
    .getByRole('button', { name: 'Restore draft' })
    .click();
  await expect(page.locator('#message')).toHaveText('Draft restored to the job list.');
  await expect(page.getByRole('button', { name: /Assigned bathroom/ })).toHaveCount(1);
});
