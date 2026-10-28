const { test, expect } = require('@playwright/test');
const uid = (role) => 'test-owner-ws-' + role;
async function start(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('estimator records and corrects the customer on their own job', async ({ page }) => {
  await start(page, 'estimator');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#jobCoordination')).toBeHidden();
  await expect(page.locator('#customerDetails')).toBeVisible();
  await page.locator('#customerDetails summary').click();
  await page.locator('#customerName').fill('Synthetic Homeower');
  await page.locator('#customerPhone').fill('555-0101');
  await page.locator('#saveCustomer').click();
  await expect(page.locator('#customerStatus')).toHaveText('Customer saved.');
  await page.locator('#customerName').fill('Synthetic Homeowner');
  await page.locator('#saveCustomer').click();
  await expect(page.locator('#customerStatus')).toHaveText('Customer saved.');
  await expect(page.locator('#customerSummary')).toHaveText('· Synthetic Homeowner');
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardJobs').click();
  await expect(page.getByRole('button', { name: /Assigned bathroom/ })).toContainText(
    'Synthetic Homeowner',
  );
});

test('owner archives a draft after confirming and it leaves the job list', async ({ page }) => {
  await start(page, 'owner');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#customerDetails')).toBeHidden();
  await expect(page.locator('#archiveJob')).toBeVisible();
  await page.locator('#archiveJob').click();
  await expect(page.locator('#archiveDialog')).toBeVisible();
  await expect(page.locator('#archiveTitle')).toHaveText('Archive Assigned bathroom?');
  // Cancel keeps the job.
  await page.locator('#cancelArchive').click();
  await expect(page.locator('#archiveDialog')).toBeHidden();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
  await page.locator('#archiveJob').click();
  await page.locator('#confirmArchive').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
  const drafts = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('adr-private-drafts-v2');
        open.onsuccess = () => {
          const read = open.result.transaction('drafts').objectStore('drafts').getAll();
          read.onsuccess = () => resolve(read.result.map((row) => row.draft.data.address));
        };
      }),
  );
  expect(drafts).not.toContain('Assigned bathroom');
});
