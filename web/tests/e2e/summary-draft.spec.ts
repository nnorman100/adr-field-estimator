import { test as base, expect as baseExpect, type Page, type Route } from '@playwright/test';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, currentDraftOf, seedCompany, storedJobs, type Company, type Person } from './jobs/seed';
import { adminDb } from './offline/world';
import { PASSWORD } from './sign-in/seed';

// The summary of findings and "Draft with AI" on Check Scope (S7-6) in Chromium and WebKit at phone
// width, against the jobs server (tests/e2e/jobs/server.ts) as in room-inputs.spec.ts. The browser
// writes the summary to the field database itself, under the real rules (web/firestore.rules), and
// each check reads the stored draft back with the admin SDK.
//
// The jobs server has no AI model, so the summary draft route's answer is stood in for with the
// exact shape it answers (src/lib/summary-draft/service.ts `view`, http.ts): `{ result: { id,
// callId, jobId, draftId, proposal } }` with 201, and its fixed refusal body with 429 and
// Retry-After. The route itself (the switch, the field owner, the call id, the price and testing
// rules) is covered against Postgres in tests/db/summary-draft-api.test.ts.

const test = base;
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const expect = baseExpect.configure({ timeout: 20_000 });

const ROUTE = '**/api/jobs/*/ai/summary-draft';
const PROPOSAL = {
  summary: 'Category 2 water from the supply line reached the kitchen.',
  suggestions: ['Check the subfloor under the dishwasher.', 'Photograph the toe kick.'],
  unpriced_work: ['Replace the toe kick, 8 linear feet.'],
  testing_advice: [],
};

const flagOn = (company: Company) => adminSql()`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'ai_summary', true)`;

async function signIn(page: Page, company: Company, person: Person) {
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${company.name}` })).toBeVisible();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
  const keep = page.getByRole('button', { name: 'Keep jobs on this phone', exact: true });
  if (await keep.isVisible()) await keep.click();
}

async function startJob(page: Page, company: Company, address: string): Promise<{ jobId: string; draftId: string }> {
  await page.getByRole('main').getByRole('link', { name: 'New job' }).click();
  await page.getByLabel('Property address').fill(address);
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
  await expect(page.getByLabel('Summary of findings', { exact: true })).toBeEditable();
  const job = (await storedJobs(company.id)).find((row) => row.propertyAddress === address)!;
  return { jobId: job.id, draftId: await currentDraftOf(company.id, job.id) };
}

// The draft's `field` map as the field database stores it.
async function storedField(company: Company, draftId: string): Promise<Record<string, unknown>> {
  const snapshot = await adminDb().doc(`companies/${company.id}/drafts/${draftId}`).get();
  return (snapshot.get('field') ?? {}) as Record<string, unknown>;
}

// Answers the summary draft request as the route does for a new proposal, and records each call id.
function proposeOnce(page: Page, ids: { jobId: string; draftId: string }, callIds: string[]) {
  return page.route(ROUTE, async (route: Route) => {
    const { callId } = route.request().postDataJSON() as { callId: string };
    callIds.push(callId);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ result: { id: '00000000-0000-4000-8000-0000000000c1', callId, ...ids, proposal: PROPOSAL } }),
    });
  });
}

test('the estimator types a summary, then accepts an edited AI draft with the notes they ticked', async ({ page }) => {
  const company = await seedCompany('summary-ai', { owner: 'owner', estimator: 'estimator' });
  await flagOn(company);
  await signIn(page, company, company.people.estimator!);
  const ids = await startJob(page, company, '21 Example Street, Testville, CA 90000');
  const summary = page.getByRole('form', { name: 'Summary' });

  // A summary in the technician's own words, saved as theirs.
  await summary.getByLabel('Summary of findings', { exact: true }).fill('Wet drywall in the kitchen.');
  await summary.getByRole('button', { name: 'Save summary' }).click();
  await expect(page.getByText('Summary saved.')).toBeVisible();
  await expect.poll(() => storedField(company, ids.draftId)).toMatchObject({ summary: 'Wet drywall in the kitchen.', summarySource: 'manual' });

  const callIds: string[] = [];
  await proposeOnce(page, ids, callIds);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  const review = page.getByRole('region', { name: 'AI draft, check it' });
  await expect(review.getByLabel('Drafted summary')).toHaveValue(PROPOSAL.summary);
  await expect(review.getByRole('group', { name: 'Suggestions' }).getByRole('checkbox')).toHaveCount(2);
  await expect(review.getByRole('group', { name: 'Work with no price' }).getByRole('checkbox')).toHaveCount(1);
  await expect(review.getByRole('group', { name: 'Testing advice' })).toHaveCount(0);
  await expect(review.getByText('Accepting replaces the summary saved now.')).toBeVisible();
  await expect(review).not.toContainText('$');
  await expectNoAxeViolations(page);
  expect(callIds).toHaveLength(1);
  expect(callIds[0]).toMatch(/^[0-9a-f-]{36}$/);

  // Shown is not saved: the stored draft is still the technician's own summary.
  expect(await storedField(company, ids.draftId)).toEqual({ summary: 'Wet drywall in the kitchen.', summarySource: 'manual' });

  await review.getByLabel('Drafted summary').fill(`${PROPOSAL.summary} Checked on site.`);
  await review.getByLabel('Photograph the toe kick.').check();
  await review.getByLabel('Replace the toe kick, 8 linear feet.').check();
  await review.getByRole('button', { name: 'Accept' }).click();
  await expect(review).toHaveCount(0);
  await expect.poll(() => storedField(company, ids.draftId)).toEqual({
    summary: `${PROPOSAL.summary} Checked on site.`,
    summarySource: 'ai',
    aiNotes: { suggestions: ['Photograph the toe kick.'], unpricedWork: ['Replace the toe kick, 8 linear feet.'] },
  });
  await expect(summary.getByLabel('Summary of findings', { exact: true })).toHaveValue(`${PROPOSAL.summary} Checked on site.`);
  await expect(page.getByText('Drafted with AI and accepted.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted AI notes' })).toBeVisible();

  // Read again, the screen shows what is stored.
  await page.reload();
  await expect(page.getByLabel('Summary of findings', { exact: true })).toHaveValue(`${PROPOSAL.summary} Checked on site.`);
  await expect(page.getByText('Photograph the toe kick.')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('a discarded AI draft writes nothing, and a refusal says when to ask again', async ({ page }) => {
  const company = await seedCompany('summary-ai-discard', { owner: 'owner', estimator: 'estimator' });
  await flagOn(company);
  await signIn(page, company, company.people.estimator!);
  const ids = await startJob(page, company, '22 Example Street, Testville, CA 90000');

  const callIds: string[] = [];
  await proposeOnce(page, ids, callIds);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  const review = page.getByRole('region', { name: 'AI draft, check it' });
  await review.getByLabel('Check the subfloor under the dishwasher.').check();
  await review.getByRole('button', { name: 'Discard' }).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByText('AI draft discarded. Nothing was saved from it.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Summary of findings', { exact: true })).toHaveValue('');
  expect(await storedField(company, ids.draftId)).toEqual({});

  // The allowance is used up: the server's own words show and the button waits for Retry-After.
  await page.unroute(ROUTE);
  await page.route(ROUTE, (route) =>
    route.fulfill({
      status: 429,
      headers: { 'Retry-After': '3600' },
      contentType: 'application/json',
      body: JSON.stringify({ error: 'ai_quota', message: 'You have used this AI feature as often as allowed today. Your field work is saved; you can keep working without AI.', retryAfterSeconds: 3600, fieldWorkContinues: true }),
    }),
  );
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'You have used this AI feature as often as allowed today.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Draft with AI' })).toBeDisabled();
  await expect(page.getByText(/Draft with AI can be asked again after/)).toBeVisible();
  expect(await storedField(company, ids.draftId)).toEqual({});
});

test('a lost answer is asked again with the same call id, and the switch off shows no Draft with AI', async ({ page }) => {
  const company = await seedCompany('summary-ai-retry', { owner: 'owner', estimator: 'estimator' });
  await flagOn(company);
  await signIn(page, company, company.people.estimator!);
  const ids = await startJob(page, company, '23 Example Street, Testville, CA 90000');

  const sent: string[] = [];
  await page.route(ROUTE, async (route) => {
    sent.push((route.request().postDataJSON() as { callId: string }).callId);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'No answer from the server.' })).toBeVisible();
  await page.unroute(ROUTE);
  await proposeOnce(page, ids, sent);
  await page.getByRole('button', { name: 'Draft with AI' }).click();
  await expect(page.getByRole('region', { name: 'AI draft, check it' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toBe(sent[0]);

  // The company's switch off: the next read of the person shows no AI button at all.
  await adminSql()`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${company.id} AND flag = 'ai_summary'`;
  await page.reload();
  await expect(page.getByLabel('Summary of findings', { exact: true })).toBeEditable();
  await expect(page.getByRole('button', { name: 'Draft with AI' })).toHaveCount(0);
});
