const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');
// An owner archives a draft while an estimator's phone still holds work the server never got.
const JOB = 'ADR-INS-' + 'c'.repeat(32);
const owner = { Authorization: 'Bearer test-owner-ws-owner', 'X-ADR-Workspace-Protocol': '1' };
async function start(page) {
  await page.addInitScript(
    (value) => sessionStorage.setItem('synthetic-uid', value),
    'test-owner-ws-estimator',
  );
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
}
async function archive(request) {
  const job = await (
    await request.get('/api/jobs/' + JOB + '/coordination', { headers: owner })
  ).json();
  const response = await request.post('/api/jobs/' + JOB + '/archive', {
    headers: owner,
    data: { expected_version: job.version },
  });
  expect(response.status()).toBe(200);
}
const localRows = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('adr-private-drafts-v2');
        open.onsuccess = () => {
          const read = open.result.transaction('drafts').objectStore('drafts').getAll();
          read.onsuccess = () =>
            resolve(
              read.result.map((row) => ({
                id: row.draft.inspection_id,
                year: row.draft.data.year_built,
                archived: !!row.archived,
              })),
            );
        };
      }),
  );
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('an edit to the open draft after the owner archives it is kept and saves as a new draft', async ({
  page,
  request,
}) => {
  await start(page);
  await archive(request);
  await page.locator('#yearBuilt').fill('1999');
  await saveDraft(page);
  await expect(page.locator('#archivedActions')).toBeVisible();
  await expect(page.locator('#saveStatus')).toHaveText('Archived by the owner');
  await expect(page.locator('#conflictActions')).toBeHidden();
  expect(await localRows(page)).toContainEqual({ id: JOB, year: 1999, archived: true });
  await page.locator('#forkArchived').click();
  await expect(page.locator('#archivedActions')).toBeHidden();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
  await expect(page.locator('#yearBuilt')).toHaveValue('1999');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  // The archived copy is removed once the new draft is open, after the new draft's first save.
  await expect.poll(async () => (await localRows(page)).map((row) => row.id)).not.toContain(JOB);
  expect(await localRows(page)).toContainEqual(
    expect.objectContaining({ year: 1999, archived: false }),
  );
});

test('a queued offline edit survives the archive and can be discarded on purpose', async ({
  page,
  context,
  request,
}) => {
  await start(page);
  await context.setOffline(true);
  await page.locator('#yearBuilt').fill('1999');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Offline · saved on phone');
  // Starting another job moves the edited draft into the background queue.
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toHaveValue('');
  await archive(request);
  await context.setOffline(false);
  await expect
    .poll(async () => (await localRows(page)).find((row) => row.id === JOB))
    .toEqual({ id: JOB, year: 1999, archived: true });
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardJobs').click();
  const row = page.getByRole('button', { name: /Assigned bathroom/ });
  await expect(row).toContainText('Archived by the owner');
  await row.click();
  await expect(page.locator('#archivedActions')).toBeVisible();
  await expect(page.locator('#yearBuilt')).toHaveValue('1999');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#discardArchived').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('My jobs');
  await expect(page.locator('#archivedActions')).toBeHidden();
  await expect(page.locator('#message')).toContainText('Local work discarded.');
  expect((await localRows(page)).map((r) => r.id)).not.toContain(JOB);
});

test('a fully synced copy is dropped quietly once the owner archives the job', async ({
  page,
  request,
}) => {
  await start(page);
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toHaveValue('');
  await archive(request);
  // Reconnecting runs the background queue, which meets the archived job.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await localRows(page)).map((row) => row.id)).not.toContain(JOB);
});
