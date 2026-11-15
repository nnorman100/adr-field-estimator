import { test as base, expect as baseExpect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, seedCompany, type Company, type Person } from './jobs/seed';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD } from './sign-in/seed';

// Office jobs, assignment and the field owner (S5b-1) in Chromium and WebKit at phone width, against
// the jobs server (tests/e2e/jobs/server.ts: a throwaway PostgreSQL, the Auth and Firestore
// emulators under the real field rules). An office user starts an empty job, assigns estimators and
// keeps office notes; the first assigned estimator to start the field work owns it and a second sees
// it is someone else's; the owner moves the field work (owner decision J5). Each test seeds a company
// of its own, so the tests run side by side.

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

test('office starts an empty job and assigns it; the first estimator to start the field work owns it, and a second cannot', async ({ page, browser }) => {
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

  for (const who of ['first', 'second']) {
    await page.getByLabel('Estimator', { exact: true }).selectOption({ label: who });
    await page.getByRole('button', { name: 'Assign estimator' }).click();
    await expect(page.getByRole('list', { name: 'Assigned estimators' }).getByText(who, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('Every active estimator is assigned to this job.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Gate code 1234\nDog in the yard');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);
  // Office sees the field work read-only and cannot start it.
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(/^Read only\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start field work' })).toHaveCount(0);

  // The first estimator finds it in their own list and starts the field work.
  const first = await newPage(browser);
  await signIn(first, company, company.people.first!);
  await expect(first.getByRole('heading', { name: 'My jobs' })).toBeVisible();
  await openJob(first, '21 Office Row');
  await expect(first.getByRole('link', { name: 'Job coordination' })).toHaveCount(0);
  await expect(first.getByLabel('Year built')).toHaveCount(0);
  await first.getByRole('button', { name: 'Start field work' }).click();
  await expect(first.getByLabel('Year built')).toBeEditable();
  await first.getByLabel('Year built').fill('1988');
  await first.getByRole('button', { name: 'Save scope' }).click();
  await expect(main(first).getByRole('status').filter({ hasText: /saved/i })).toBeVisible();
  await expectNoAxeViolations(first);
  // An estimator never sees the office notes.
  await main(first).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(first.getByText('Gate code')).toHaveCount(0);

  // The second estimator is assigned too, but the field work is someone else's now.
  const second = await newPage(browser);
  await signIn(second, company, company.people.second!);
  await openJob(second, '21 Office Row');
  await expect(second.getByText('Another person owns this job’s field work')).toBeVisible();
  await expect(second.getByRole('button', { name: 'Start field work' })).toHaveCount(0);
  await expect(second.getByLabel('Year built')).toHaveCount(0);

  // Office sees who owns it.
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.reload();
  await expect(page.getByText('first owns the field work.')).toBeVisible();
});

test('the owner moves the field work to another assigned estimator, and the phone that held it can no longer change it', async ({ page, browser, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('move-field', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  // Set up through the API as office would: a job assigned to both estimators, the first owning it.
  const office = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.office!.email, PASSWORD))}` };
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: office, data: { id: jobId, draftId: randomUUID(), propertyAddress: '33 Moving Lane' } })).status()).toBe(201);
  const actors = await adminSql()<{ uid: string; id: string }[]>`SELECT uid, id::text FROM actors WHERE company_id = ${company.id}`;
  const actorOf = (person: Person) => actors.find((one) => one.uid === person.uid)!.id;
  for (const who of [company.people.first!, company.people.second!]) {
    const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: office, data: { id: randomUUID(), estimatorActorId: actorOf(who) } });
    expect(assigned.status()).toBe(201);
  }
  const first = { Authorization: `Bearer ${await idTokenFor(company.tenantId, company.people.first!.email, PASSWORD)}` };
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner`, { headers: first })).status()).toBe(201);

  const firstPage = await newPage(browser);
  await signIn(firstPage, company, company.people.first!);
  await openJob(firstPage, '33 Moving Lane');
  await expect(firstPage.getByLabel('Year built')).toBeEditable();

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

  // The old phone: read again, the field work is another person's.
  await firstPage.reload();
  await expect(firstPage.getByText('Another person owns this job’s field work')).toBeVisible();
  await expect(firstPage.getByLabel('Year built')).toHaveCount(0);

  // The new owner edits it.
  const secondPage = await newPage(browser);
  await signIn(secondPage, company, company.people.second!);
  await openJob(secondPage, '33 Moving Lane');
  await expect(secondPage.getByLabel('Year built')).toBeEditable();

  // What the choice shows is what is sent: the estimator just moved to is no longer offered, so the
  // next move goes to the first choice shown (the owner).
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByText('owner owns the field work.')).toBeVisible();
});

test('the phone that held the field work keeps what was typed when the owner moves it, read only', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-edits', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const office = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.office!.email, PASSWORD))}` };
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: office, data: { id: jobId, draftId: randomUUID(), propertyAddress: '52 Unsent Road' } })).status()).toBe(201);
  const actors = await adminSql()<{ uid: string; id: string }[]>`SELECT uid, id::text FROM actors WHERE company_id = ${company.id}`;
  const actorOf = (person: Person) => actors.find((one) => one.uid === person.uid)!.id;
  for (const who of [company.people.first!, company.people.second!]) {
    const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: office, data: { id: randomUUID(), estimatorActorId: actorOf(who) } });
    expect(assigned.status()).toBe(201);
  }
  const first = { Authorization: `Bearer ${await idTokenFor(company.tenantId, company.people.first!.email, PASSWORD)}` };
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner`, { headers: first })).status()).toBe(201);

  await signIn(page, company, company.people.first!);
  await openJob(page, '52 Unsent Road');
  await page.getByLabel('Year built').fill('1975');
  // The owner moves the field work while the change is still on this phone.
  const owner = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.owner!.email, PASSWORD))}` };
  const moved = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner/transfer`, {
    headers: owner,
    data: { revision: 1, changeId: randomUUID(), toActorId: actorOf(company.people.second!) },
  });
  expect(moved.status()).toBe(200);
  await page.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByText('Another person now owns this job’s field work', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Year built')).toHaveValue('1975');
  await expect(page.getByLabel('Year built')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save scope' })).toHaveCount(0);
});

test('a customer change typed on the phone that held the field work stays on it when its save is refused', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-customer', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const office = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.office!.email, PASSWORD))}` };
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: office, data: { id: jobId, draftId: randomUUID(), propertyAddress: '61 Refused Way' } })).status()).toBe(201);
  const actors = await adminSql()<{ uid: string; id: string }[]>`SELECT uid, id::text FROM actors WHERE company_id = ${company.id}`;
  const actorOf = (person: Person) => actors.find((one) => one.uid === person.uid)!.id;
  for (const who of [company.people.first!, company.people.second!]) {
    const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: office, data: { id: randomUUID(), estimatorActorId: actorOf(who) } });
    expect(assigned.status()).toBe(201);
  }
  const first = { Authorization: `Bearer ${await idTokenFor(company.tenantId, company.people.first!.email, PASSWORD)}` };
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner`, { headers: first })).status()).toBe(201);

  await signIn(page, company, company.people.first!);
  await openJob(page, '61 Refused Way');
  await page.getByLabel('Year built').fill('1968');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Casey Typed');
  const owner = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.owner!.email, PASSWORD))}` };
  const moved = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner/transfer`, {
    headers: owner,
    data: { revision: 1, changeId: randomUUID(), toActorId: actorOf(company.people.second!) },
  });
  expect(moved.status()).toBe(200);
  await page.getByRole('button', { name: 'Save customer' }).click();
  // The job stays on screen, read again: the typed customer change and the scope change are kept.
  await expect(page.getByText('Only the person who owns this job’s field work can add to it.')).toBeVisible();
  await expect(page.getByRole('heading', { name: '61 Refused Way' })).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Casey Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toHaveValue('1968');
  await expect(page.getByText('Another person now owns this job’s field work', { exact: false })).toBeVisible();
});

test('the phone that held the field work keeps what was typed when its estimator is also unassigned, read only', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('keep-unassigned', { owner: 'owner', office: 'office', first: 'estimator', second: 'estimator' });
  const office = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.office!.email, PASSWORD))}` };
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: office, data: { id: jobId, draftId: randomUUID(), propertyAddress: '73 Unassigned Lane' } })).status()).toBe(201);
  const actors = await adminSql()<{ uid: string; id: string }[]>`SELECT uid, id::text FROM actors WHERE company_id = ${company.id}`;
  const actorOf = (person: Person) => actors.find((one) => one.uid === person.uid)!.id;
  const firstAssignment = randomUUID();
  for (const [who, id] of [
    [company.people.first!, firstAssignment],
    [company.people.second!, randomUUID()],
  ] as const) {
    const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: office, data: { id, estimatorActorId: actorOf(who) } });
    expect(assigned.status()).toBe(201);
  }
  const first = { Authorization: `Bearer ${await idTokenFor(company.tenantId, company.people.first!.email, PASSWORD)}` };
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner`, { headers: first })).status()).toBe(201);

  await signIn(page, company, company.people.first!);
  await openJob(page, '73 Unassigned Lane');
  await page.getByLabel('Year built').fill('1959');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Robin Typed');
  // The field work moves to the second estimator, and office then unassigns the first.
  const owner = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.owner!.email, PASSWORD))}` };
  const moved = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/field-owner/transfer`, {
    headers: owner,
    data: { revision: 1, changeId: randomUUID(), toActorId: actorOf(company.people.second!) },
  });
  expect(moved.status()).toBe(200);
  expect((await request.delete(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments/${firstAssignment}`, { headers: office })).status()).toBe(200);

  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await page.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByText('This job is not in your list. What you changed and did not save stays on this phone', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Year built')).toHaveValue('1959');
  await expect(page.getByLabel('Year built')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save scope' })).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('Robin Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  // Nothing reached the job.
  const [row] = await adminSql()<{ name: string | null }[]>`SELECT name FROM job_customers WHERE job_id = ${jobId}`;
  expect(row?.name ?? '').not.toBe('Robin Typed');
});

test('an estimator whose field work the draft does not name yet starts it again and edits it', async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await seedCompany('owner-unset', { office: 'office', first: 'estimator' });
  const office = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, company.people.office!.email, PASSWORD))}` };
  const jobId = randomUUID();
  expect((await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: office, data: { id: jobId, draftId: randomUUID(), propertyAddress: '45 Retry Lane' } })).status()).toBe(201);
  const [first] = await adminSql()<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id} AND uid = ${company.people.first!.uid}`;
  const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: office, data: { id: randomUUID(), estimatorActorId: first!.id } });
  expect(assigned.status()).toBe(201);
  // The first capture was saved in the database, and its field draft step did not get through (a 503).
  await adminSql()`UPDATE jobs SET field_owner_actor_id = ${first!.id}::uuid, revision = revision + 1 WHERE id = ${jobId}::uuid`;

  await signIn(page, company, company.people.first!);
  await openJob(page, '45 Retry Lane');
  await expect(page.getByText('This job’s field work is yours, but this phone cannot open it yet.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Start field work' }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
  await expect(page.getByRole('button', { name: 'Start field work' })).toHaveCount(0);
});
