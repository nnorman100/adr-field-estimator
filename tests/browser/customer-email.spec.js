const { test, expect } = require('@playwright/test');
// The signed copy goes to the job's customer email, so it is offered only when one is saved.
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('estimator saves the customer email and the signing copy names it', async ({ page }) => {
  await page.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    'test-owner-ws-estimator',
  );
  await page.goto('/app');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#customerDetails')).toBeVisible();
  // No email yet: the copy is not offered, and the reason is.
  await expect(page.locator('#emailCopyField')).toHaveAttribute('hidden', '');
  await expect(page.locator('#emailCopyNone')).not.toHaveAttribute('hidden', '');
  await page.locator('#customerDetails summary').click();
  await page.locator('#customerName').fill('Synthetic Homeowner');
  await page.locator('#customerEmail').fill('not an email');
  await page.locator('#saveCustomer').click();
  await expect(page.locator('#customerStatus')).not.toHaveText('Customer saved.');
  await page.locator('#customerEmail').fill('home@example.invalid');
  await page.locator('#saveCustomer').click();
  await expect(page.locator('#customerStatus')).toHaveText('Customer saved.');
  await expect(page.locator('#emailCopyField')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#emailCopyText')).toHaveText(
    'Email me a copy of my signed documents at home@example.invalid.',
  );
  await expect(page.locator('#emailCopyNone')).toHaveAttribute('hidden', '');
  // Reopening the job reads the saved address back.
  await page.locator('#backToJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#customerEmail')).toHaveValue('home@example.invalid');
});
