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
  expect(await page.locator('#customerEmail').evaluate((input) => input.validity.valid)).toBe(
    false,
  );
  await expect(page.locator('#emailCopyField')).toHaveAttribute('hidden', '');
  await page.locator('#customerEmail').fill('home@example.invalid');
  await page.locator('#saveCustomer').click();
  await expect(page.locator('#customerStatus')).toHaveText('Customer saved.');
  await expect(page.locator('#emailCopyField')).not.toHaveAttribute('hidden', '');
  await expect(page.locator('#emailCopyText')).toHaveText(
    'Email me a copy of my signed documents at home@example.invalid.',
  );
  await expect(page.locator('#emailCopyNone')).toHaveAttribute('hidden', '');
  // Reopening the job reads the saved address back.
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#customerEmail')).toHaveValue('home@example.invalid');
});

test('a customer entered offline stays on the phone and sends on reconnect', async ({
  page,
  context,
  request,
}) => {
  await page.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    'test-owner-ws-estimator',
  );
  await page.goto('/app');
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // The customer panel opens only after its record has loaded; go offline after that.
  await expect(page.locator('#customerDetails')).toBeVisible();
  // The panel sits at the top of Check Scope, above the address.
  expect(
    await page.evaluate(
      () =>
        !!(
          $('customerDetails').compareDocumentPosition($('address')) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    ),
  ).toBe(true);
  await context.setOffline(true);
  await page.locator('#customerDetails summary').click();
  await page.locator('#customerName').fill('Offline Homeowner');
  // Leaving the field saves it; there is no need to tap Save.
  await page.locator('#customerPhone').focus();
  await expect(page.locator('#customerStatus')).toHaveText(
    'Saved on this phone. It is sent when you reconnect.',
  );
  await expect(page.locator('#customerSummary')).toHaveText('· Offline Homeowner');
  await context.setOffline(false);
  await expect(page.locator('#customerStatus')).toHaveText('Customer saved.');
  const job = await (
    await request.get('/api/jobs/ADR-INS-' + 'c'.repeat(32) + '/coordination', {
      headers: { Authorization: 'Bearer test-owner-ws-estimator', 'X-ADR-Workspace-Protocol': '1' },
    })
  ).json();
  expect(job.customer_name).toBe('Offline Homeowner');
});
