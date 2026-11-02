const { saveDraft } = require('./actions');
const { test, expect } = require('@playwright/test');
// Client side of an owner archiving a draft that an estimator's phone still holds (R1, R2).
// job-archive-unsynced.spec.js covers the open-draft fork and the queue discard; this adds the
// queue's Save as new draft, and the owner archiving from a real second phone.
const JOB = 'ADR-INS-' + 'c'.repeat(32);
const uid = (role) => 'test-owner-ws-' + role;
const owner = { Authorization: 'Bearer test-owner-ws-owner', 'X-ADR-Workspace-Protocol': '1' };

async function openAssigned(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/app');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  // On a phone-width screen the company links sit behind a Menu button.
  const menu = page.locator('#workspaceMenuToggle:visible');
  if (await menu.count()) await menu.click();
  await page.locator('#dashboardJobs').click();
  await page.getByRole('button', { name: /Assigned bathroom/ }).click();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
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
// Owner's phone: archive the open job through the confirmation dialog.
async function archiveOnOwnerPhone(browser) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await openAssigned(page, 'owner');
  // With a job open, a phone reaches Job coordination from More.
  await page.locator('#jobMenu > summary').click();
  await page
    .locator('#jobMenu')
    .getByRole('button', { name: 'Job coordination', exact: true })
    .click();
  await expect(page.locator('#coordinationToggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#archiveJob').click();
  await page.locator('#confirmArchive').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('Company jobs');
  await expect(page.locator('#dashboardContent')).not.toContainText('Assigned bathroom');
  await context.close();
}
test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

test('an archived job in the background queue can be saved as a new draft with its unsynced edit', async ({
  page,
  context,
  request,
}) => {
  await openAssigned(page, 'estimator');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await context.setOffline(true);
  await page.locator('#yearBuilt').fill('1999');
  await saveDraft(page);
  await expect(page.locator('#saveStatus')).toHaveText('Offline · saved on phone');
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardNewJob').click();
  await expect(page.locator('#address')).toHaveValue('');
  const job = await (
    await request.get('/api/jobs/' + JOB + '/coordination', { headers: owner })
  ).json();
  expect(
    (
      await request.post('/api/jobs/' + JOB + '/archive', {
        headers: owner,
        data: { expected_version: job.version },
      })
    ).status(),
  ).toBe(200);
  await context.setOffline(false);
  // Reconnecting runs the queue, which gets the 410 and keeps the unsynced copy.
  await expect
    .poll(async () => (await localRows(page)).find((row) => row.id === JOB))
    .toEqual({ id: JOB, year: 1999, archived: true });
  await page.locator('#dashboardHome').click();
  await page.locator('#dashboardJobs').click();
  const row = page.getByRole('button', { name: /Assigned bathroom/ });
  await expect(row).toContainText('Archived by the owner');
  await row.click();
  await expect(page.locator('#archivedActions')).toBeVisible();
  await expect(page.locator('#saveStatus')).toHaveText('Archived by the owner');
  await page.locator('#forkArchived').click();
  await expect(page.locator('#archivedActions')).toBeHidden();
  await expect(page.locator('#address')).toHaveValue('Assigned bathroom');
  await expect(page.locator('#yearBuilt')).toHaveValue('1999');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect.poll(async () => (await localRows(page)).map((r) => r.id)).not.toContain(JOB);
  expect(await localRows(page)).toContainEqual(
    expect.objectContaining({ year: 1999, archived: false }),
  );
});

test('a second phone archives the job the estimator has open: the edit is kept and can be discarded', async ({
  page,
  browser,
}) => {
  await openAssigned(page, 'estimator');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await archiveOnOwnerPhone(browser);
  // The estimator's phone has not heard about the archive; their next edit meets the 410.
  await page.locator('#yearBuilt').fill('1999');
  await saveDraft(page);
  await expect(page.locator('#archivedActions')).toBeVisible();
  await expect(page.locator('#saveStatus')).toHaveText('Archived by the owner');
  await expect(page.locator('#conflictActions')).toBeHidden();
  await expect
    .poll(async () => (await localRows(page)).find((row) => row.id === JOB))
    .toEqual({ id: JOB, year: 1999, archived: true });
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#discardArchived').click();
  await expect(page.locator('#dashboardHeading')).toHaveText('My jobs');
  await expect.poll(async () => (await localRows(page)).map((r) => r.id)).not.toContain(JOB);
});

test('a second phone archives the job the estimator has open: Save as new draft keeps the edit', async ({
  page,
  browser,
}) => {
  await openAssigned(page, 'estimator');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await archiveOnOwnerPhone(browser);
  await page.locator('#yearBuilt').fill('1999');
  await saveDraft(page);
  await expect(page.locator('#archivedActions')).toBeVisible();
  await page.locator('#forkArchived').click();
  await expect(page.locator('#archivedActions')).toBeHidden();
  await expect(page.locator('#yearBuilt')).toHaveValue('1999');
  await expect(page.locator('#saveStatus')).toHaveText('Saved');
  await expect.poll(async () => (await localRows(page)).map((r) => r.id)).not.toContain(JOB);
  expect(await localRows(page)).toContainEqual(
    expect.objectContaining({ year: 1999, archived: false }),
  );
});
