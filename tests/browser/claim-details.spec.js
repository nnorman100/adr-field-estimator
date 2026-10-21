const { test, expect } = require('@playwright/test');
const { checkScope } = require('./actions');

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, serviceWorkers: 'block' });

const uid = (role) => 'test-owner-ws-' + role;
// The fake provider in tests/browser_server.py fills carrier and claim number from this statement.
const claimWords = 'Synthetic Mutual claim number CLM 0042 77.';
const words = 'Room 1, category 2, 80 square feet of drywall. Use 3 fans. ' + claimWords;

test.beforeEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: true } });
});
test.afterEach(async ({ request }) => {
  await request.post('/__test/workspaces', { data: { enabled: false } });
});

async function newJob(page, role) {
  await page.addInitScript((value) => sessionStorage.setItem('synthetic-uid', value), uid(role));
  await page.goto('/');
  await expect(page.locator('#workspaceDashboard')).toBeVisible();
  await page.getByRole('button', { name: 'New job', exact: true }).click();
  await checkScope(page);
  await expect(page.locator('#claimDetails')).toBeVisible();
}
async function openClaim(page) {
  if (!(await page.locator('#claimDetails').evaluate((el) => el.open)))
    await page.locator('#claimDetails > summary').click();
}
const label = (page, id) => page.locator('#' + id).locator('..');

test('walkthrough claim details fill with Undo, save to the job and head every document', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await newJob(page, 'estimator');
  await expect(page.locator('#claimSummary')).toHaveText('· none recorded');
  await page.locator('#address').fill('Synthetic claim property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(words);
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#scopeSuggestionPanel')).toBeVisible();
  await expect(page.locator('#scopeSuggestionList')).toContainText('Claim number: CLM 0042 77');
  await expect(page.locator('#claimDetails')).toHaveJSProperty('open', true);
  await expect(page.locator('#claimNumber')).toHaveValue('CLM 0042 77');
  await expect(page.locator('#claimCarrier')).toHaveValue('Synthetic Mutual');
  await expect(page.locator('#claimSummary')).toHaveText('· Claim CLM 0042 77');
  await expect(label(page, 'claimCarrier')).toContainText('From walkthrough · Undo');
  // Undo restores the empty carrier on the job; the claim number keeps its marker.
  await label(page, 'claimCarrier').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#claimStatus')).toHaveText('Walkthrough value undone.');
  await expect(page.locator('#claimCarrier')).toHaveValue('');
  await expect(label(page, 'claimCarrier')).not.toContainText('From walkthrough');
  await expect(label(page, 'claimNumber')).toContainText('From walkthrough · Undo');
  // Typing over a filled value keeps the typed value and drops its marker.
  await page.locator('#claimNumber').fill('CLM-0042-77');
  await expect(label(page, 'claimNumber')).not.toContainText('From walkthrough');
  await page.locator('#claimAdjusterName').fill('Avery Adjuster');
  await page.locator('#claimDate').fill('2026-10-12');
  await page.locator('#claimCause').fill('Supply line under kitchen sink');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  const id = await page.evaluate(() => state.draft.inspection_id);
  const saved = await (
    await page.request.get('/api/jobs/' + id + '/claim', {
      headers: { Authorization: 'Bearer ' + uid('office'), 'X-ADR-Workspace-Protocol': '1' },
    })
  ).json();
  expect(saved.claim).toMatchObject({
    carrier: '',
    claim_number: 'CLM-0042-77',
    adjuster_name: 'Avery Adjuster',
    date_of_loss: '2026-10-12',
    loss_cause: 'Supply line under kitchen sink',
  });
  await page.locator('#confirmFilledScope').click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await expect(page.locator('#proposalBody')).toContainText('Claim number: CLM-0042-77');
  await expect(page.locator('#proposalBody')).toContainText('Date of loss: 10-12-2026');
  await expect(page.locator('#proposalBody')).not.toContainText('Insurance carrier');
  await expect(page.locator('#claimParty')).toContainText(
    'Cause and source of loss: Supply line under kitchen sink',
  );
  await expect(page.locator('#photoParty')).toContainText('Adjuster: Avery Adjuster');
  await expect(page.locator('#defenseBody')).toContainText(
    'TO: Avery Adjuster, Insurance Adjuster',
  );
  await expect(page.locator('#defenseBody')).toContainText('Claim number: CLM-0042-77');
  await page.locator('#doc-proposal');
  // A claim change clears the unsigned documents so they cannot be signed stale.
  await page.locator('.task-nav [data-task="property"]').click();
  await openClaim(page);
  await page.locator('#claimDeductible').fill('$1,000');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  expect(await page.evaluate(() => state.documents)).toBeNull();
  await expect(page.locator('#documents')).toBeHidden();
  expect(errors).toEqual([]);
});

test('office staff enter claim details; invalid values stay on the form', async ({ page }) => {
  await newJob(page, 'office');
  await openClaim(page);
  await expect(page.locator('#claimCarrier')).toBeEnabled();
  await page.locator('#claimCarrier').fill('Synthetic Mutual');
  await page.locator('#claimAdjusterEmail').fill('not an email');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('');
  expect(await page.locator('#claimAdjusterEmail').evaluate((el) => el.validity.valid)).toBe(false);
  await page.locator('#claimAdjusterEmail').fill('Avery@Example.invalid');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  await expect(page.locator('#claimAdjusterEmail')).toHaveValue('avery@example.invalid');
  await expect(page.locator('#claimSummary')).toHaveText('· 2 of 9 recorded');
  // The card fits a phone without horizontal scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
