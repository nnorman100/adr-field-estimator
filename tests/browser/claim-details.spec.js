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
  await page.locator('#claimAdjusterName').fill('Avery Quinn');
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
    adjuster_name: 'Avery Quinn',
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
  await expect(page.locator('#photoParty')).toContainText('Adjuster: Avery Quinn');
  await expect(page.locator('#defenseBody')).toContainText('TO: Avery Quinn, Adjuster');
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

test('a page left open overnight still saves a loss dated today', async ({ page }) => {
  const now = Date.now();
  await page.clock.setFixedTime(now - 86400000);
  await newJob(page, 'office');
  await openClaim(page);
  await page.clock.setFixedTime(now);
  const today = await page.evaluate(() => new Date().toLocaleDateString('en-CA'));
  await page.locator('#claimDate').fill(today);
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  await expect(page.locator('#claimDate')).toHaveValue(today);
});

test('a walkthrough fill keeps unsaved claim entries and its markers survive scope edits', async ({
  page,
}) => {
  await newJob(page, 'estimator');
  await openClaim(page);
  await page.locator('#claimPolicy').fill('POL-77');
  await page.locator('#address').fill('Synthetic claim property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(words);
  await page.locator('#fillScopeProperty').click();
  await expect(page.locator('#claimCarrier')).toHaveValue('Synthetic Mutual');
  await expect(page.locator('#claimPolicy')).toHaveValue('POL-77');
  await page.locator('#claimDeductible').fill('$500');
  await label(page, 'claimCarrier').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#claimStatus')).toHaveText('Walkthrough value undone.');
  await expect(page.locator('#claimCarrier')).toHaveValue('');
  await expect(page.locator('#claimPolicy')).toHaveValue('POL-77');
  await expect(page.locator('#claimDeductible')).toHaveValue('$500');
  await page.locator('#confirmFilledScope').click();
  await expect(label(page, 'claimNumber')).toContainText('From walkthrough · Undo');
});

test('a claim save that finishes after another job opens leaves that job untouched', async ({
  page,
}) => {
  await newJob(page, 'office');
  await openClaim(page);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/jobs/*/claim', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('#claimCarrier').fill('Job A Mutual');
  await page.locator('#saveClaim').click();
  const first = await page.evaluate(() => state.draft.inspection_id);
  await page.locator('#jobMenu > summary').click();
  await page.locator('#newInspection').click();
  await page.waitForFunction(
    (id) => state.draft?.inspection_id && state.draft.inspection_id !== id,
    first,
  );
  release();
  await openClaim(page);
  await page.waitForTimeout(500);
  await expect(page.locator('#claimCarrier')).toHaveValue('');
  await expect(page.locator('#claimStatus')).not.toHaveText('Claim details saved.');
});

test('edits typed while a claim save is pending stay unsaved and get no Undo', async ({ page }) => {
  await newJob(page, 'estimator');
  await openClaim(page);
  let release, reached;
  const arrived = new Promise((resolve) => (reached = resolve));
  await page.route('**/api/jobs/*/claim', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const response = await route.fetch();
    const held = new Promise((resolve) => (release = resolve));
    reached();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('#claimCarrier').fill('First Mutual');
  await page.locator('#saveClaim').click();
  await arrived;
  await page.locator('#claimCarrier').fill('Second Mutual');
  release();
  await expect(page.locator('#claimStatus')).toHaveText(
    'Edits typed while saving are not saved yet. Save claim details.',
  );
  await expect(page.locator('#claimCarrier')).toHaveValue('Second Mutual');
  // A walkthrough fill whose value is typed over during the save keeps the typed value without a marker.
  await page.locator('#address').fill('Synthetic claim property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(words);
  const filled = new Promise((resolve) => (reached = resolve));
  await page.locator('#fillScopeProperty').click();
  await filled;
  await page.locator('#claimNumber').fill('CLM-TYPED');
  release();
  await expect(page.locator('#claimStatus')).toHaveText(
    'Edits typed while saving are not saved yet. Save claim details.',
  );
  await expect(page.locator('#claimCarrier')).toHaveValue('Synthetic Mutual');
  await expect(label(page, 'claimCarrier')).toContainText('From walkthrough · Undo');
  await expect(page.locator('#claimNumber')).toHaveValue('CLM-TYPED');
  await expect(label(page, 'claimNumber')).not.toContainText('From walkthrough');
});

test('a fill whose document refresh finishes after a manual save marks only its own values', async ({
  page,
}) => {
  await newJob(page, 'estimator');
  await page.locator('#address').fill('Synthetic claim property');
  await page.locator('#yearBuilt').fill('1998');
  await page.locator('#technicianNotes').fill(words);
  await page.locator('#fillScopeProperty').click();
  // Clear the filled claim values so a later fill changes only claim details.
  for (const id of ['claimCarrier', 'claimNumber'])
    await label(page, id).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('#claimNumber')).toHaveValue('');
  await page.locator('#confirmFilledScope').click();
  await page.locator('#finishAudit').click();
  await expect(page.locator('#documents')).toBeVisible();
  await page.locator('.task-nav [data-task="property"]').click();
  await openClaim(page);
  // Hold the document refresh that follows the walkthrough's claim save.
  let armed = false,
    reached,
    release;
  const arrived = new Promise((resolve) => (reached = resolve));
  const held = new Promise((resolve) => (release = resolve));
  await page.route('**/api/jobs/*/claim', async (route) => {
    if (route.request().method() === 'PUT' && armed === false) armed = true;
    await route.continue();
  });
  await page.route('**/api/inspections/*', async (route) => {
    if (route.request().method() !== 'GET' || armed !== true) return route.continue();
    armed = 'held';
    const response = await route.fetch();
    reached();
    await held;
    await route.fulfill({ response });
  });
  await page.locator('#fillScopeProperty').click();
  await arrived;
  await page.locator('#claimCarrier').fill('Typed Mutual');
  await page.locator('#saveClaim').click();
  await expect(page.locator('#claimStatus')).toHaveText('Claim details saved.');
  release();
  await expect(label(page, 'claimNumber')).toContainText('From walkthrough · Undo');
  await expect(page.locator('#claimCarrier')).toHaveValue('Typed Mutual');
  await expect(label(page, 'claimCarrier')).not.toContainText('From walkthrough');
});
