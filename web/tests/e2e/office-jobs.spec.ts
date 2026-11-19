import { test as base, expect as baseExpect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, currentDraftOf, seedCompany, type Company, type Person } from './jobs/seed';
import { adminDb } from './offline/world';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD } from './sign-in/seed';

// Office jobs, assignment and the field owner screens (S5b-1) in Chromium and WebKit at phone width,
// against the jobs server (tests/e2e/jobs/server.ts): a throwaway PostgreSQL, the Auth and Firestore
// emulators under the real field rules. Office starts an empty job, assigns estimators and keeps
// notes; the first assigned estimator to start the field work owns it; the owner moves it (owner
// decision J5) and the phone that held it keeps what was typed, read only. State a test is not about
// is set up through the API, so each test signs in as few people as it can.

const test = base;
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const expect = baseExpect.configure({ timeout: 20_000 });

// An owner or office user needs the authenticator-app second step (D2), answered at the network
// boundary (second-step/fake-totp.ts) as in tests/e2e/jobs.spec.ts.
async function signIn(page: Page, company: Company, person: Person) {
  const secondStep = person.role !== 'estimator';
  if (secondStep) await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (secondStep) {
    await page.getByLabel('6-digit code').fill(APP_CODE);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: `Signed in to ${company.name}` })).toBeVisible();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
  const keep = page.getByRole('button', { name: 'Keep jobs on this phone', exact: true });
  if (await keep.isVisible()) await keep.click();
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  return context.newPage();
}

const main = (page: Page) => page.getByRole('main');

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openJob(page: Page, address: string) {
  await main(page).getByRole('link', { name: address }).click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
}

// What the phone that held the field work says once it moved (src/app/field/job-screens.tsx).
const MOVED = /field work is no longer yours/;

type Headers = { Authorization: string };
const bearer = async (company: Company, person: Person): Promise<Headers> => {
  const token = await idTokenFor(company.tenantId, person.email, PASSWORD);
  return { Authorization: `Bearer ${person.role === 'estimator' ? token : withSecondFactor(token)}` };
};

async function actorsOf(company: Company): Promise<(person: Person) => string> {
  const actors = await adminSql()<{ uid: string; id: string }[]>`SELECT uid, id::text FROM actors WHERE company_id = ${company.id}`;
  return (person) => actors.find((one) => one.uid === person.uid)!.id;
}

// A job made through the API as `maker` would, with `assigned` estimators assigned in order.
async function seedJob(request: APIRequestContext, company: Company, maker: Person, address: string, assigned: Person[]) {
  const actorOf = await actorsOf(company);
  const headers = await bearer(company, maker);
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers, data: { id: jobId, draftId: randomUUID(), propertyAddress: address } })).status()).toBe(201);
  const assignments: string[] = [];
  for (const who of assigned) {
    const id = randomUUID();
    const answer = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers, data: { id, estimatorActorId: actorOf(who) } });
    expect(answer.status()).toBe(201);
    assignments.push(id);
  }
  return { jobId, assignments, actorOf, headers };
}

async function claim(request: APIRequestContext, company: Company, who: Person, jobId: string) {
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner`, { headers: await bearer(company, who) })).status()).toBe(201);
}

// The owner moves the field work through the API, with the coordination revision as read now.
async function transfer(request: APIRequestContext, company: Company, jobId: string, to: string) {
  const headers = await bearer(company, company.people.owner!);
  const read = await request.get(`${JOBS_BASE_URL}/api/jobs/${jobId}/coordination`, { headers });
  const { revision } = (await read.json()) as { revision: number };
  const moved = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner/transfer`, { headers, data: { revision, changeId: randomUUID(), toActorId: to } });
  expect(moved.status()).toBe(200);
}

test('office starts an empty job, assigns and unassigns estimators and keeps notes; the first estimator to start the field work owns it', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('office-job', { office: 'office', first: 'estimator', second: 'estimator' });
  await signIn(page, company, company.people.office!);
  await main(page).getByRole('link', { name: 'New job' }).click();
  await expect(page.getByText(/The job starts empty/)).toBeVisible();
  await page.getByLabel('Property address').fill('21 Office Row');
  await page.getByRole('button', { name: 'Start job' }).click();
  // Office goes on to the job's coordination, not to a scope it cannot edit.
  await expect(page.getByRole('heading', { name: '21 Office Row' })).toBeVisible();
  await expect(page.getByText('Nobody has started the field work yet.', { exact: false })).toBeVisible();

  const assigned = page.getByRole('list', { name: 'Assigned estimators' });
  for (const who of ['first', 'second']) {
    await page.getByLabel('Estimator', { exact: true }).selectOption({ label: who });
    await page.getByRole('button', { name: 'Assign estimator' }).click();
    await expect(assigned.getByText(who, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Every active estimator is assigned to this job.')).toBeVisible();
  await page.getByRole('button', { name: 'Unassign second' }).click();
  await expect(assigned.getByText('second', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'second was unassigned.' })).toBeVisible();
  await page.getByLabel('Estimator', { exact: true }).selectOption({ label: 'second' });
  await page.getByRole('button', { name: 'Assign estimator' }).click();
  await expect(assigned.getByText('second', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Gate code 1234\nDog in the yard');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);
  // Office sees the field work read-only and cannot start it.
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(/^Read only\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start field work' })).toHaveCount(0);

  // The first estimator finds it in their own list and starts the field work. They see no
  // coordination, only that the office and the owner keep it.
  const first = await newPage(browser);
  await signIn(first, company, company.people.first!);
  await openJob(first, '21 Office Row');
  await expect(first.getByRole('link', { name: 'Job coordination' })).toHaveCount(0);
  await expect(first.getByLabel('Year built')).toHaveCount(0);
  await first.getByRole('button', { name: 'Start field work' }).click();
  await expect(first.getByLabel('Year built')).toBeEditable();
  await first.getByLabel('Year built').fill('1988');
  await first.getByRole('button', { name: 'Save scope' }).click();
  await expect(main(first).getByRole('status').filter({ hasText: /saved/i })).toBeVisible();
  await expectNoAxeViolations(first);
  await first.goto(`/field?job=${new URL(first.url()).searchParams.get('job')}&view=coordination`);
  await expect(first.getByText('Job coordination is kept by the office and the company owner.')).toBeVisible();
  await expect(first.getByText('Gate code')).toHaveCount(0);

  // The second estimator is assigned too, but the field work is someone else's now.
  const second = await newPage(browser);
  await signIn(second, company, company.people.second!);
  await openJob(second, '21 Office Row');
  await expect(second.getByText('Another person owns this job’s field work')).toBeVisible();
  await expect(second.getByRole('button', { name: 'Start field work' })).toHaveCount(0);
  await expect(second.getByLabel('Year built')).toHaveCount(0);

  // Office sees who owns it.
  await page.reload();
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByText('first owns the field work.')).toBeVisible();
});

test('the owner moves the field work, and the phone that held it keeps what was typed, read only', async ({ page, browser, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('move-field', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const { jobId } = await seedJob(request, company, company.people.office!, '33 Moving Lane', [company.people.first!, company.people.second!]);
  await claim(request, company, company.people.first!, jobId);

  const firstPage = await newPage(browser);
  await signIn(firstPage, company, company.people.first!);
  await openJob(firstPage, '33 Moving Lane');
  await firstPage.getByLabel('Year built').fill('1975');
  await main(firstPage).getByRole('link', { name: 'Customer and claim' }).click();
  await firstPage.getByLabel('Customer name').fill('Casey Typed');

  await signIn(page, company, company.people.owner!);
  await openJob(page, '33 Moving Lane');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByText('first owns the field work.')).toBeVisible();
  await page.getByLabel('Move it to').selectOption({ label: 'second' });
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByText('second owns the field work.')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'The field work was moved.' })).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // The old phone: its save is refused, and what was typed stays, read only, not saved to the job.
  await main(firstPage).getByRole('link', { name: 'Check Scope' }).click();
  await firstPage.getByRole('button', { name: 'Save scope' }).click();
  await expect(firstPage.getByText(MOVED)).toBeVisible();
  await expect(firstPage.getByLabel('Year built')).toHaveValue('1975');
  await expect(firstPage.getByLabel('Year built')).not.toBeEditable();
  await expect(firstPage.getByRole('button', { name: 'Save scope' })).toHaveCount(0);
  await main(firstPage).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(firstPage.getByLabel('Customer name')).toHaveValue('Casey Typed');
  await expect(firstPage.getByLabel('Customer name')).not.toBeEditable();
  const [row] = await adminSql()<{ name: string | null }[]>`SELECT name FROM job_customers WHERE job_id = ${jobId}`;
  expect(row?.name ?? '').not.toBe('Casey Typed');

  // What the choice shows is what is sent: the estimator just moved to is no longer offered, so the
  // next move goes to the first choice shown (the owner).
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByText('owner owns the field work.')).toBeVisible();
});

test('the phone that held the field work keeps what was typed when its estimator is also unassigned, read only', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-unassigned', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const { jobId, assignments, actorOf, headers } = await seedJob(request, company, company.people.office!, '73 Unassigned Lane', [company.people.first!, company.people.second!]);
  await claim(request, company, company.people.first!, jobId);

  await signIn(page, company, company.people.first!);
  await openJob(page, '73 Unassigned Lane');
  await page.getByLabel('Year built').fill('1959');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Robin Typed');
  // The field work moves to the second estimator, and office then unassigns the first.
  await transfer(request, company, jobId, actorOf(company.people.second!));
  expect((await request.delete(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments/${assignments[0]}`, { headers })).status()).toBe(200);

  // The job is refused to this phone now (404), and it stays on screen, read only.
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Robin Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toHaveValue('1959');
  await expect(page.getByLabel('Year built')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save scope' })).toHaveCount(0);
  // Nothing reached the job.
  const [row] = await adminSql()<{ name: string | null }[]>`SELECT name FROM job_customers WHERE job_id = ${jobId}`;
  expect(row?.name ?? '').not.toBe('Robin Typed');
});

test('an estimator whose field work the draft does not name yet starts it again, and customer changes typed before keep when the job is refused', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-no-draft', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const { jobId, assignments, actorOf, headers } = await seedJob(request, company, company.people.office!, '84 Unread Court', [company.people.first!, company.people.second!]);
  // The first estimator owns the field work in the database, but the draft does not name them yet
  // (the first capture's draft step did not get through), so this phone cannot read the draft.
  await adminSql()`UPDATE jobs SET field_owner_actor_id = ${actorOf(company.people.first!)}::uuid, revision = revision + 1 WHERE id = ${jobId}::uuid`;

  await signIn(page, company, company.people.first!);
  await openJob(page, '84 Unread Court');
  await expect(page.getByText('This job’s field work is yours, but this phone cannot open it yet.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Year built')).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Jordan Typed');
  await page.getByLabel('Insurance carrier').fill('Typed Mutual');
  await transfer(request, company, jobId, actorOf(company.people.second!));
  expect((await request.delete(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments/${assignments[0]}`, { headers })).status()).toBe(200);

  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Jordan Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await expect(page.getByLabel('Insurance carrier')).toHaveValue('Typed Mutual');
  await expect(page.getByLabel('Insurance carrier')).not.toBeEditable();
});

test('an estimator whose draft does not name them starts the field work again and edits it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-unset', { office: 'office', first: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.office!, '45 Retry Lane', [company.people.first!]);
  await adminSql()`UPDATE jobs SET field_owner_actor_id = ${actorOf(company.people.first!)}::uuid, revision = revision + 1 WHERE id = ${jobId}::uuid`;

  await signIn(page, company, company.people.first!);
  await openJob(page, '45 Retry Lane');
  await expect(page.getByText('This job’s field work is yours, but this phone cannot open it yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Start field work' }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
  await expect(page.getByRole('button', { name: 'Start field work' })).toHaveCount(0);
});

test('the company owner keeps an unsaved room change on screen after moving the field work, whatever happens to the room', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-keeps-room', { owner: 'owner', first: 'estimator' });
  // The owner starts the job, so they own its field work.
  const { jobId, actorOf } = await seedJob(request, company, company.people.owner!, '95 Owner Row', [company.people.first!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '95 Owner Row');
  await page.getByLabel('New room name').fill('Den');
  await page.getByRole('button', { name: 'Add room' }).click();
  const den = page.getByRole('form', { name: 'Den' });
  await expect(den).toBeVisible();
  await den.getByLabel('Floor area (sq ft)', { exact: true }).fill('120');
  // The owner moves the field work to the estimator, who then takes the room out.
  await transfer(request, company, jobId, actorOf(company.people.first!));
  await adminDb().doc(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`).update({ 'field.roomOrder': [] });

  // Saving office notes reads the job and its draft again: the room is gone from the draft, and the
  // owner's room and what they typed stay, read only.
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Den checked');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  // The draft read that follows the save brings the estimator's draft: the owner's screen is read only.
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(den.getByLabel('Floor area (sq ft)', { exact: true })).not.toBeEditable();
  await expect(den.getByLabel('Floor area (sq ft)', { exact: true })).toHaveValue('120');
});

test('a move with no answer is kept with its ids, blocks other coordination writes, survives leaving the job, and is sent again as it was', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-move', { owner: 'owner', first: 'estimator', second: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.owner!, '17 Held Move Way', [company.people.first!, company.people.second!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '17 Held Move Way');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByText('owner owns the field work.')).toBeVisible();

  // The server commits the move, and its answer is lost on the way to the phone.
  const sent: string[] = [];
  let lost = true;
  await page.route('**/api/jobs/*/field-owner/transfer', async (route) => {
    if (!lost) return route.fallback();
    sent.push(route.request().postData() ?? '');
    await route.fetch();
    await route.abort();
  });
  await page.getByLabel('Move it to').selectOption({ label: 'first' });
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  // Nothing else is sent while it is unanswered.
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Unassign second' })).toBeDisabled();

  // Leaving the job and opening it again keeps it.
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await openJob(page, '17 Held Move Way');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeDisabled();
  lost = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('first owns the field work.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeEnabled();
  expect(sent).toHaveLength(1);
  const [row] = await adminSql()<{ owner: string }[]>`SELECT field_owner_actor_id::text AS owner FROM jobs WHERE id = ${jobId}::uuid`;
  expect(row?.owner).toBe(actorOf(company.people.first!));
});

test('the company owner who moves the field work keeps customer changes typed before, read only, with the notice', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-keeps-customer', { owner: 'owner', first: 'estimator' });
  await seedJob(request, company, company.people.owner!, '29 Owner Customer Row', [company.people.first!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '29 Owner Customer Row');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Owner Typed');
  await page.getByLabel('Insurance carrier').fill('Typed Mutual');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByLabel('Move it to').selectOption({ label: 'first' });
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByText('first owns the field work.')).toBeVisible();

  // The draft read after the move names the new owner, and the owner's old edits stay read only.
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Owner Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await expect(page.getByLabel('Insurance carrier')).toHaveValue('Typed Mutual');
  await expect(page.getByLabel('Insurance carrier')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save customer' })).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).not.toBeEditable();
});

test('an unassign with no answer can be sent again after the assignment is gone from the list', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('held-unassign', { owner: 'owner', first: 'estimator', second: 'estimator' });
  await seedJob(request, company, company.people.owner!, '18 Held Unassign Way', [company.people.first!, company.people.second!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '18 Held Unassign Way');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByRole('list', { name: 'Assigned estimators' }).getByText('second', { exact: true })).toBeVisible();

  // The server unassigns, and its answer is lost on the way to the phone.
  let lost = true;
  await page.route('**/api/jobs/*/assignments/*', async (route) => {
    if (!lost || route.request().method() !== 'DELETE') return route.fallback();
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Unassign second' }).click();
  await expect(page.getByRole('button', { name: 'Send the unanswered change again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeDisabled();

  // Opened again, the list no longer has the assignment, but its recovery is still there.
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await openJob(page, '18 Held Unassign Way');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByRole('list', { name: 'Assigned estimators' }).getByText('second', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send the unanswered change again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeDisabled();
  lost = false;
  // Sent again as it was: the server answers that the assignment is gone, which settles it.
  await page.getByRole('button', { name: 'Send the unanswered change again' }).click();
  await expect(page.getByRole('button', { name: 'Send the unanswered change again' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeEnabled();
});

test('text typed in a room and not added stays on screen, read only, after the field work moves', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-keeps-typed', { owner: 'owner', first: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.owner!, '96 Typed Row', [company.people.first!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '96 Typed Row');
  await page.getByLabel('New room name').fill('Den');
  await page.getByRole('button', { name: 'Add room' }).click();
  const den = page.getByRole('form', { name: 'Den' });
  await expect(den).toBeVisible();
  await den.getByLabel('Your own prep task').fill('Tape the vent');
  await page.getByLabel('New room name').fill('Attic');
  await transfer(request, company, jobId, actorOf(company.people.first!));
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Checked');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(den.getByLabel('Your own prep task')).toHaveValue('Tape the vent');
  await expect(den.getByLabel('Your own prep task')).not.toBeEditable();
  await expect(page.getByLabel('New room name')).toHaveValue('Attic');
  await expect(page.getByLabel('New room name')).not.toBeEditable();
});

test('a prep task typed and not added stays on screen, read only, when the new owner removes its room', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-keeps-prep', { owner: 'owner', first: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.owner!, '97 Prep Row', [company.people.first!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '97 Prep Row');
  await page.getByLabel('New room name').fill('Den');
  await page.getByRole('button', { name: 'Add room' }).click();
  const den = page.getByRole('form', { name: 'Den' });
  await expect(den).toBeVisible();
  // Only the prep-task box is typed in: nothing else of the room is changed.
  await den.getByLabel('Your own prep task').fill('Tape the vent');
  await transfer(request, company, jobId, actorOf(company.people.first!));
  await adminDb().doc(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`).update({ 'field.roomOrder': [] });
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Checked');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await expect(page.getByText('No rooms yet.')).toBeVisible();
  await expect(den.getByLabel('Your own prep task')).toHaveValue('Tape the vent');
  await expect(den.getByLabel('Your own prep task')).not.toBeEditable();
});

test('a prep task and a room name typed and not added come back, read only, when the job is opened again after the field work moved', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-typed-reopen', { owner: 'owner', first: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.owner!, '98 Reopen Row', [company.people.first!]);

  await signIn(page, company, company.people.owner!);
  await openJob(page, '98 Reopen Row');
  await page.getByLabel('New room name').fill('Den');
  await page.getByRole('button', { name: 'Add room' }).click();
  const den = page.getByRole('form', { name: 'Den' });
  await expect(den).toBeVisible();
  await den.getByLabel('Your own prep task').fill('Tape the vent');
  await page.getByLabel('New room name').fill('Attic');
  await transfer(request, company, jobId, actorOf(company.people.first!));
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Checked');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();

  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await openJob(page, '98 Reopen Row');
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  const reopened = page.getByRole('form', { name: 'Den' });
  await expect(reopened.getByLabel('Your own prep task')).toHaveValue('Tape the vent');
  await expect(reopened.getByLabel('Your own prep task')).not.toBeEditable();
  await expect(page.getByLabel('New room name')).toHaveValue('Attic');
  await expect(page.getByLabel('New room name')).not.toBeEditable();
});

test('after the field work moves, the old phone shows its unsent photo read only and neither takes nor resends photos', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-photo', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const { jobId, actorOf } = await seedJob(request, company, company.people.office!, '58 Photo Lane', [company.people.first!, company.people.second!]);
  await claim(request, company, company.people.first!, jobId);

  await signIn(page, company, company.people.first!);
  await openJob(page, '58 Photo Lane');
  // The photo's upload fails, so it stays on the phone, unsent.
  await page.route('**/api/jobs/*/photos/*', (route) => route.abort());
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await page.getByLabel('Shot').selectOption({ label: 'Overview' });
  await page.getByLabel('Take photo').setInputFiles({
    name: 'photo.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeEnabled();

  // The owner moves the field work; the old phone's next change is refused and it goes read only.
  await transfer(request, company, jobId, actorOf(company.people.second!));
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await page.getByLabel('Year built').fill('1971');
  await page.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByText(MOVED)).toBeVisible();
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeDisabled();
  await expect(page.getByLabel('Take photo')).toHaveCount(0);
});
