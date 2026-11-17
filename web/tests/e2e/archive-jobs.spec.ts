import { test as base, expect as baseExpect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, currentDraftOf, seedCompany, type Company, type Person } from './jobs/seed';
import { adminDb } from './offline/world';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD } from './sign-in/seed';

// Archive, restore and copy screens (S5b-2) in Chromium and WebKit at phone width, against the jobs
// server (tests/e2e/jobs/server.ts): a throwaway PostgreSQL, the Auth and Firestore emulators under
// the real field rules. The owner archives an unsigned draft after a confirm dialog, finds it in
// Archived drafts and restores it; an old link of an archived job shows that it is archived (the
// server's 410); a signed job has no Archive and is copied to a new draft in one tap, with the same
// ids sent again after a lost answer. State a test is not about is set up through the API.

const test = base;
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const expect = baseExpect.configure({ timeout: 20_000 });

// An owner or office user needs the authenticator-app second step (D2), answered at the network
// boundary (second-step/fake-totp.ts) as in tests/e2e/office-jobs.spec.ts.
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

const main = (page: Page) => page.getByRole('main');

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function openJob(page: Page, address: string) {
  await main(page).getByRole('link', { name: address }).click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
}

const bearer = async (company: Company, person: Person) => {
  const token = await idTokenFor(company.tenantId, person.email, PASSWORD);
  return { Authorization: `Bearer ${person.role === 'estimator' ? token : withSecondFactor(token)}` };
};

// A draft job made through the API as `maker` would (who holds `scope` owns its field work).
async function seedJob(request: APIRequestContext, company: Company, maker: Person, address: string): Promise<string> {
  const jobId = randomUUID();
  const made = await request.post(`${JOBS_BASE_URL}/api/jobs`, { headers: await bearer(company, maker), data: { id: jobId, draftId: randomUUID(), propertyAddress: address } });
  expect(made.status()).toBe(201);
  return jobId;
}

// A signed job as the screens see it: the job row says signed. (Copy itself reads the signed record,
// which tests/db/archive-api.test.ts drives through the real signing chain.)
async function seedSigned(request: APIRequestContext, company: Company, maker: Person, address: string): Promise<string> {
  const jobId = await seedJob(request, company, maker, address);
  await adminSql()`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}::uuid`;
  return jobId;
}

async function statusOf(jobId: string): Promise<string> {
  const [row] = await adminSql()<{ status: string }[]>`SELECT status FROM jobs WHERE id = ${jobId}::uuid`;
  return row!.status;
}

async function draftStateOf(company: Company, jobId: string): Promise<unknown> {
  const draft = await adminDb().doc(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`).get();
  return draft.get('state');
}

const ARCHIVED_TEXT = /filed away, not deleted/;

test('the owner archives a draft after confirming, finds it in Archived drafts, its old link shows it archived, and Restore brings it back', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '8 Duplicate Lane');
  await seedSigned(request, company, owner, '3 Signed Court');

  await signIn(page, company, owner);
  // A signed job has no archive: it offers Copy instead.
  await openJob(page, '3 Signed Court');
  await expect(page.getByRole('button', { name: 'Copy to a new draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive job' })).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();

  await openJob(page, '8 Duplicate Lane');
  const archiveCalls: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().endsWith(`/api/jobs/${jobId}/archive`)) archiveCalls.push(sent.postData() ?? '');
  });
  // Keep the job closes the dialog and sends nothing.
  await page.getByRole('button', { name: 'Archive job' }).click();
  const dialog = page.getByRole('dialog', { name: 'Archive this job?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep the job' })).toBeFocused();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Keep the job' }).click();
  await expect(dialog).toBeHidden();
  expect(archiveCalls).toHaveLength(0);
  expect(await statusOf(jobId)).toBe('draft');

  // Confirmed, it is archived: the screen says so, the job row and its field draft are archived.
  await page.getByRole('button', { name: 'Archive job' }).click();
  await dialog.getByRole('button', { name: 'Archive job' }).click();
  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByText(ARCHIVED_TEXT)).toBeVisible();
  expect(archiveCalls).toHaveLength(1);
  expect(await statusOf(jobId)).toBe('archived');
  await expect.poll(() => draftStateOf(company, jobId)).toBe('archived');

  // It left the company list and is in Archived drafts.
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('link', { name: '3 Signed Court' })).toBeVisible();
  await expect(main(page).getByText('8 Duplicate Lane')).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();
  const archived = page.getByRole('list', { name: 'Archived drafts' });
  await expect(archived.getByText('8 Duplicate Lane')).toBeVisible();
  await expect(archived.getByText('3 Signed Court')).toHaveCount(0);
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // Its old link answers 410: the screen shows it archived, with the way to Archived drafts.
  await page.goto(`/field?job=${jobId}`);
  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check Scope' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();

  // Restore puts it back as it was: a draft, back in the company list, its field draft being edited.
  await archived.getByRole('listitem').filter({ hasText: '8 Duplicate Lane' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  await expect(page.getByText('No archived drafts.')).toBeVisible();
  expect(await statusOf(jobId)).toBe('draft');
  await expect.poll(() => draftStateOf(company, jobId)).toBe('editing');
  await main(page).getByRole('link', { name: 'Open 8 Duplicate Lane' }).click();
  await expect(page.getByRole('heading', { name: '8 Duplicate Lane' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive job' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('link', { name: '8 Duplicate Lane' })).toBeVisible();
});

test('an estimator has no Archive, sees an archived job’s old link as archived, and copies a signed job once, with the same ids after a lost answer', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('copy', { owner: 'owner', estimator: 'estimator' });
  const estimator = company.people.estimator!;
  const draft = await seedJob(request, company, estimator, '14 Draft Street');
  const filed = await seedJob(request, company, estimator, '22 Filed Away Road');
  const signed = await seedSigned(request, company, estimator, '5 Signed Avenue');
  // The owner archives one of the estimator's drafts.
  const archivedOne = await request.post(`${JOBS_BASE_URL}/api/jobs/${filed}/archive`, {
    headers: await bearer(company, company.people.owner!),
    data: { revision: 1, changeId: randomUUID() },
  });
  expect(archivedOne.status()).toBe(200);

  await signIn(page, company, estimator);
  await expect(main(page).getByRole('link', { name: '14 Draft Street' })).toBeVisible();
  await expect(main(page).getByText('22 Filed Away Road')).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: 'Archived drafts' })).toHaveCount(0);
  await openJob(page, '14 Draft Street');
  await expect(page.getByRole('link', { name: 'Check Scope' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive job' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy to a new draft' })).toHaveCount(0);

  // An old link of the archived job: archived, with no way to restore it from an estimator's phone.
  await page.goto(`/field?job=${filed}`);
  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByText(ARCHIVED_TEXT)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Archived drafts' })).toHaveCount(0);

  // Copy, played at the network boundary: the phone's ids go to the real create route (POST
  // /api/jobs makes one job per id and answers the same job again, as copy does). The first answer
  // is lost after the server made the job.
  const sent: { id: string; draftId: string }[] = [];
  let lost = true;
  await page.route(`**/api/jobs/${signed}/copy`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { id: string; draftId: string };
    sent.push(body);
    const made = await route.fetch({ url: `${JOBS_BASE_URL}/api/jobs`, postData: JSON.stringify({ ...body, propertyAddress: '5 Signed Avenue' }) });
    if (lost) return route.abort();
    return route.fulfill({ response: made });
  });
  await page.goto('/field');
  await openJob(page, '5 Signed Avenue');
  await page.getByRole('button', { name: 'Copy to a new draft' }).click();
  await expect(page.getByRole('button', { name: 'Try copying again' })).toBeVisible();
  // Leaving the job and opening it again keeps the ids. (The lost answer's draft, made by the server,
  // is in the list too, with the same address: the signed row is the one opened.)
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await main(page).getByRole('listitem').filter({ hasText: 'Signed ·' }).getByRole('link', { name: '5 Signed Avenue' }).click();
  await expect(page.getByRole('heading', { name: '5 Signed Avenue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try copying again' })).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);
  lost = false;
  await page.getByRole('button', { name: 'Try copying again' }).click();

  // The new draft opens on its scope, and there is exactly one.
  await expect(page).toHaveURL(new RegExp(`job=${sent[0]!.id}`));
  await expect(page.getByRole('heading', { name: '5 Signed Avenue' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check Scope' })).toBeVisible();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  const jobs = await adminSql()<{ id: string }[]>`SELECT id::text FROM jobs WHERE company_id = ${company.id}::uuid`;
  const copies = jobs.map((row) => row.id).filter((id) => ![draft, filed, signed].includes(id));
  expect(copies).toEqual([sent[0]!.id]);
  expect(await statusOf(signed)).toBe('signed');
});

test('archiving keeps what the owner typed and did not save on screen, read only', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-edits', { owner: 'owner' });
  const owner = company.people.owner!;
  await seedJob(request, company, owner, '9 Unsaved Way');

  await signIn(page, company, owner);
  await openJob(page, '9 Unsaved Way');
  await expect(page.getByLabel('Year built')).toBeEditable();
  await page.getByLabel('Year built').fill('1971');
  await page.getByRole('button', { name: 'Archive job' }).click();
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();

  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByLabel('Year built')).toHaveValue('1971');
  await expect(page.getByLabel('Year built')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Archive job' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('a job archived on another phone shows archived on the save that meets it, with what was typed kept, read only', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archived-elsewhere', { owner: 'owner', estimator: 'estimator' });
  const estimator = company.people.estimator!;
  const jobId = await seedJob(request, company, estimator, '31 Elsewhere Lane');

  await signIn(page, company, estimator);
  await openJob(page, '31 Elsewhere Lane');
  await page.getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Customer name')).toBeEditable();
  await page.getByLabel('Customer name').fill('Pat Typed');
  // The owner archives it from another phone just as the save goes out, so the save is the request
  // that meets the 410 (archived any earlier, another job call of this screen could meet it first).
  const ownerHeaders = await bearer(company, company.people.owner!);
  let archiveStatus = 0;
  await page.route(`**/api/jobs/${jobId}/customer`, async (route) => {
    const archivedOne = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/archive`, { headers: ownerHeaders, data: { revision: 1, changeId: randomUUID() } });
    archiveStatus = archivedOne.status();
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect.poll(() => archiveStatus).toBe(200);

  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveValue('Pat Typed');
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save customer' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('a restore whose field step did not get through is sent again from the jobs list once the job has left Archived drafts', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('restore-retry', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '17 Half Restored Road');
  const archivedOne = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/archive`, {
    headers: await bearer(company, owner),
    data: { revision: 1, changeId: randomUUID() },
  });
  expect(archivedOne.status()).toBe(200);

  // The first restore commits on the server, but its field step does not get through: the draft
  // stays archived and the answer is 503 draft_unavailable.
  const sent: { revision: number; changeId: string }[] = [];
  let failing = true;
  await page.route(`**/api/jobs/${jobId}/restore`, async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { revision: number; changeId: string });
    if (!failing) return route.continue();
    const draft = adminDb().doc(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`);
    const before = (await draft.get()).data()!;
    await route.fetch();
    await draft.update({ state: before.state, archiveRevision: before.archiveRevision });
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'draft_unavailable' }) });
  });

  await signIn(page, company, owner);
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();
  const archived = page.getByRole('list', { name: 'Archived drafts' });
  await archived.getByRole('listitem').filter({ hasText: '17 Half Restored Road' }).getByRole('button', { name: 'Restore' }).click();
  await expect(archived.getByRole('button', { name: 'Try restoring again' })).toBeVisible();
  expect(await statusOf(jobId)).toBe('draft');
  expect(await draftStateOf(company, jobId)).toBe('archived');

  // The job is back in the company list and no longer in Archived drafts: its restore is still there.
  await main(page).getByRole('link', { name: 'Company jobs' }).click();
  await expect(main(page).getByRole('link', { name: '17 Half Restored Road' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();
  await expect(page.getByText('No archived drafts.')).toBeVisible();
  const unfinished = page.getByRole('list', { name: 'Not finished' });
  await expect(unfinished.getByText('17 Half Restored Road')).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  failing = false;
  await unfinished.getByRole('button', { name: 'Try restoring again' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Restored' })).toBeVisible();
  await expect(unfinished).toHaveCount(0);
  await expect.poll(() => draftStateOf(company, jobId)).toBe('editing');
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
});

// R3 (firstmate ruling): Archive and Copy follow the person's keys and the job's state, not whether
// this phone's field work moved away; the moved, read-only state limits only field editing.
test('the owner who moves the field work to an estimator still sees Archive, and Copy once the job is signed', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-moved', { owner: 'owner', first: 'estimator' });
  const owner = company.people.owner!;
  // The owner starts the job, so they own its field work, and assigns the estimator.
  const jobId = await seedJob(request, company, owner, '41 Handed Over Lane');
  const [estimator] = await adminSql()<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id}::uuid AND uid = ${company.people.first!.uid}`;
  const assigned = await request.post(`${JOBS_BASE_URL}/api/jobs/${jobId}/assignments`, { headers: await bearer(company, owner), data: { id: randomUUID(), estimatorActorId: estimator!.id } });
  expect(assigned.status()).toBe(201);

  await signIn(page, company, owner);
  await openJob(page, '41 Handed Over Lane');
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByLabel('Move it to').selectOption({ label: 'first' });
  await page.getByRole('button', { name: 'Move field work' }).click();
  await expect(page.getByText('first owns the field work.')).toBeVisible();
  // The owner's screen now holds field work that moved away: field editing is read only.
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByText(/field work is no longer yours/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive job' })).toBeVisible();

  // Signed meanwhile: saving office notes reads the job again on this page, still moved.
  await adminSql()`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}::uuid`;
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await page.getByRole('textbox', { name: 'Office notes' }).fill('Signed on site');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Notes saved.' })).toBeVisible();
  await expect(page.getByText(/field work is no longer yours/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy to a new draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive job' })).toHaveCount(0);
});
