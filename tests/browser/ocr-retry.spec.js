const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');

test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

async function task(page, name) {
  await page.locator('.task-nav [data-task="' + name + '"]').click();
}
async function png(page) {
  const photo = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 600;
    canvas.getContext('2d').fillRect(0, 0, 100, 100);
    return canvas.toDataURL('image/png');
  });
  return {
    name: 'meter.png',
    mimeType: 'image/png',
    buffer: Buffer.from(photo.split(',')[1], 'base64'),
  };
}
async function upload(page) {
  await task(page, 'walkthrough');
  await page.locator('#photoFileInput').setInputFiles(await png(page));
  await expect(page.locator('#photoGallery')).toContainText('no meter');
}

test('Retry recognition is disabled offline and hidden after the job is signed', async ({
  page,
  context,
}) => {
  await page.goto('/app');
  await expect(page.locator('#address')).toBeEnabled({ timeout: 15000 });
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await task(page, 'property');
  await page.locator('#address').fill('Synthetic meter photo');
  await page.locator('#yearBuilt').fill('2001');
  await page.locator('[data-room-key="finished_sf"]').fill('10');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await upload(page);
  const retry = page.getByRole('button', { name: 'Retry recognition' });
  await expect(retry).toBeEnabled();
  await context.setOffline(true);
  await expect(retry).toBeDisabled();
  await expect(retry).toHaveAttribute('title', 'Photo recognition needs a connection.');
  await context.setOffline(false);
  await expect(retry).toBeEnabled();
  await expect(retry).not.toHaveAttribute('title', 'Photo recognition needs a connection.');
  // Coming back online can clear a confirmation that moved while the phone was offline.
  await task(page, 'property');
  await page.locator('#scopeConfirmed').check();
  await saveDraft(page);
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await page.locator('#documentsConfirmed').check();
  const canvas = page.locator('#signCanvas');
  await canvas.scrollIntoViewIfNeeded();
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + 30, rect.y + 40);
  await page.mouse.down();
  await page.mouse.move(rect.x + 140, rect.y + 90, { steps: 6 });
  await page.mouse.up();
  await page.locator('#authorizeJob').click();
  await expect(page.locator('#saveStatus')).toHaveText('Signed');
  await task(page, 'walkthrough');
  await expect(page.locator('#photoGallery')).toContainText('no meter');
  await expect(page.getByRole('button', { name: 'Retry recognition' })).toHaveCount(0);
});

test('office staff do not see Retry recognition on a job an estimator photographed', async ({
  page,
}) => {
  await page.request.post('/__test/workspaces', { data: { enabled: true } });
  try {
    await page.addInitScript(
      (value) => sessionStorage.setItem('synthetic-uid', value),
      'test-owner-ws-estimator',
    );
    await page.goto('/app');
    await expect(page.locator('#workspaceDashboard')).toBeVisible();
    await page.locator('#dashboardJobs').click();
    await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    await expect(page.locator('#address')).toBeEnabled();
    await upload(page);
    await expect(page.getByRole('button', { name: 'Retry recognition' })).toBeEnabled();
    const changed = await page.request.fetch('/api/companies/adr/team/test-owner-ws-estimator', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-owner-ws-owner',
        'X-ADR-Workspace-Protocol': '1',
      },
      data: { expected_version: 1, role: 'office', status: 'active' },
    });
    expect(changed.ok()).toBe(true);
    await page.evaluate(() => WorkspaceUI.refresh());
    await expect(page.locator('#message')).toContainText('company access changed');
    if ((await page.locator('#address').inputValue()) === '') {
      await page.locator('#dashboardJobs').click();
      await page.getByRole('button', { name: /Assigned bathroom/ }).click();
    }
    await expect(page.locator('#address')).toBeDisabled();
    await expect(page.locator('#rooms')).toContainText('no meter');
    await expect(page.getByRole('button', { name: 'Retry recognition' })).toHaveCount(0);
  } finally {
    await page.request.post('/__test/workspaces', { data: { enabled: false } });
  }
});
