import { test as base, expect as baseExpect, type APIRequestContext, type Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, currentDraftOf, seedCompany, type Company, type Person } from './jobs/seed';
import { agreementOf, newSubmission, pricedResult, seedCommitted, seedEstimate, seedPin, seedSignature, seedVersion } from '../db/submission-harness';
import { FieldValue } from 'firebase-admin/firestore';
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

// A signed job as the real copy route reads it: a committed submission with its snapshot (the address
// and scope as signed), the price version, estimate and signature it names, and the original
// agreement, written as the table owner (tests/db/archive-api.test.ts drives the same chain).
const SIGNED_SCOPE = { yearBuilt: 1965, roomOrder: ['kitchen'], notes: 'Wet carpet by the sink.', scopeConfirmed: true };
const SIGNED_ROOM = { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120 } };

async function seedSigned(request: APIRequestContext, company: Company, maker: Person, address: string): Promise<string> {
  const jobId = await seedJob(request, company, maker, address);
  const sql = adminSql();
  const [actor] = await sql<{ id: string }[]>`SELECT id::text FROM actors WHERE company_id = ${company.id}::uuid AND uid = ${maker.uid}`;
  const draft = await currentDraftOf(company.id, jobId);
  const made = newSubmission(company.id, jobId, actor!.id, { draft });
  const bytes = Buffer.from(
    JSON.stringify({
      format: 'dryscope-submission-v1',
      submissionId: made.id,
      jobId,
      draftId: draft,
      fieldSha256: createHash('sha256').update(made.id).digest('hex'),
      field: { draft: SIGNED_SCOPE, rooms: [SIGNED_ROOM], photos: [] },
      photos: [],
      job: { propertyAddress: address },
      customer: { name: '', phone: '', email: '' },
      claim: {},
    }),
  );
  const submission = await seedCommitted(sql, made, { bytes, sha: createHash('sha256').update(bytes).digest('hex') });
  const version = await seedVersion(sql, company.id, actor!.id);
  const pin = await seedPin(sql, { company: company.id, job: jobId, version: version.id, actor: actor!.id });
  const estimate = await seedEstimate(sql, { company: company.id, job: jobId, submission: submission.id, pin, actor: actor!.id, hash: version.hash });
  const signature = await seedSignature(sql, company.id, jobId, actor!.id);
  const a = agreementOf({ company: company.id, actor: actor!.id, job: { id: jobId } as never, version, submission, pin, estimate, signature });
  await sql`
    INSERT INTO agreements (id, company_id, job_id, submission_id, estimate_id, kind, signer_kind, signer_name, signature_evidence_id, proposal_sha256, priced_result,
                            version_id, content_hash, engine_version, documents_bytes, request_digest, created_by_actor_id)
    VALUES (${a.id}, ${a.company}, ${a.job}, ${a.submission}, ${a.estimate}, 'original', 'device', 'Pat Customer', ${a.signature}, ${a.proposalSha},
            ${JSON.stringify(pricedResult)}::text::jsonb, ${a.version}, ${a.hash}, 'dryscope-v3',
            ${Buffer.from('{"documents":"as signed"}')}, ${createHash('sha256').update(a.id).digest('hex')}, ${a.actor})
  `;
  await sql`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}::uuid`;
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

  // Copy through the real route: the phone's ids go to POST /api/jobs/{id}/copy, which reads the signed
  // snapshot. Only the first answer is dropped, after the server made the copy.
  const sent: { id: string; draftId: string }[] = [];
  const statuses: number[] = [];
  const answered: { id: string; currentDraftId: string }[] = [];
  let lost = true;
  const draftsOf = async () => (await adminDb().collection(`companies/${company.id}/drafts`).get()).size;
  const draftsBefore = await draftsOf();
  await page.route(`**/api/jobs/${signed}/copy`, async (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { id: string; draftId: string });
    const real = await route.fetch();
    statuses.push(real.status());
    const body = (await real.json()) as { job: { id: string; currentDraftId: string } };
    answered.push({ id: body.job.id, currentDraftId: body.job.currentDraftId });
    if (lost) return route.abort();
    return route.fulfill({ response: real });
  });
  await page.goto('/field');
  await openJob(page, '5 Signed Avenue');
  await page.getByRole('button', { name: 'Copy to a new draft' }).click();
  await expect(page.getByRole('button', { name: 'Try copying again' })).toBeVisible();
  // The dropped first answer was the server's 201: it made the copy's draft before the answer was lost.
  expect(statuses).toEqual([201]);
  expect((await adminDb().doc(`companies/${company.id}/drafts/${sent[0]!.draftId}`).get()).exists).toBe(true);
  expect(await draftsOf()).toBe(draftsBefore + 1);
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
  // The retry was answered as a replay (200, not a second 201), and no second draft was made.
  expect(statuses).toEqual([201, 200]);
  // Both answers name the job and draft the phone asked for.
  expect(answered).toEqual([
    { id: sent[0]!.id, currentDraftId: sent[0]!.draftId },
    { id: sent[0]!.id, currentDraftId: sent[0]!.draftId },
  ]);
  expect(await draftsOf()).toBe(draftsBefore + 1);
  const jobs = await adminSql()<{ id: string }[]>`SELECT id::text FROM jobs WHERE company_id = ${company.id}::uuid`;
  const copies = jobs.map((row) => row.id).filter((id) => ![draft, filed, signed].includes(id));
  expect(copies).toEqual([sent[0]!.id]);
  expect(await statusOf(signed)).toBe('signed');
  // The one draft holds the signed scope, less its approval.
  const copied = (await adminDb().doc(`companies/${company.id}/drafts/${sent[0]!.draftId}`).get()).data()!;
  expect(copied.field).toEqual({ yearBuilt: 1965, roomOrder: ['kitchen'], notes: 'Wet carpet by the sink.' });
  expect((await adminDb().doc(`companies/${company.id}/drafts/${sent[0]!.draftId}/rooms/kitchen`).get()).data()).toEqual({ field: SIGNED_ROOM.field });
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

// Runs a request whose Postgres change commits, then leaves the field database's record of the job's draft
// sync as it was before it (the job's sync marker, web/src/lib/jobs/draft-sync.ts, and the version Postgres
// records as synced), as a field step that did not get through leaves them; the caller puts the draft back.
async function asIfFieldStepFailed(company: Company, jobId: string, send: () => Promise<unknown>): Promise<void> {
  const marker = adminDb().doc(`companies/${company.id}/draftLifecycle/${jobId}`);
  const before = (await marker.get()).data();
  const [row] = await adminSql()<{ synced: number }[]>`SELECT field_synced_revision AS synced FROM jobs WHERE id = ${jobId}::uuid`;
  const synced = row!.synced;
  await send();
  if (before) await marker.set(before);
  else await marker.delete();
  await adminSql()`UPDATE jobs SET field_synced_revision = ${synced} WHERE id = ${jobId}::uuid`;
}

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
    await asIfFieldStepFailed(company, jobId, () => route.fetch());
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

for (const code of ['draft_unavailable', 'jobs_unavailable']) {
  test(`an archive that committed but answered 503 ${code} leaves the screen read only, with the same archive kept to send again`, async ({ page, request }) => {
    test.setTimeout(150_000);
    const company = await seedCompany(`archive-partial-${code.slice(0, 4)}`, { owner: 'owner' });
    const owner = company.people.owner!;
    const jobId = await seedJob(request, company, owner, '12 Half Archived Court');

    // The first archive commits on the server, but the answer is 503 and the draft is still being edited.
    const sent: { revision: number; changeId: string }[] = [];
    let failing = true;
    await page.route(`**/api/jobs/${jobId}/archive`, async (route) => {
      sent.push(JSON.parse(route.request().postData() ?? '{}') as { revision: number; changeId: string });
      if (!failing) return route.continue();
      const draft = adminDb().doc(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}`);
      const before = (await draft.get()).data()!;
      await asIfFieldStepFailed(company, jobId, () => route.fetch());
      await draft.update({ state: before.state, archiveRevision: before.archiveRevision ?? FieldValue.delete() });
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: code }) });
    });

    await signIn(page, company, owner);
    await openJob(page, '12 Half Archived Court');
    await page.getByLabel('Year built').fill('1971');
    await page.getByRole('button', { name: 'Archive job' }).click();
    await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();

    // The job row is archived and the draft is not: nothing of it may be saved from this screen.
    await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
    expect(await statusOf(jobId)).toBe('archived');
    expect(await draftStateOf(company, jobId)).toBe('editing');
    await expect(page.getByLabel('Year built')).toHaveValue('1971');
    await expect(page.getByLabel('Year built')).not.toBeEditable();
    await expect(page.getByRole('button', { name: 'Save scope', exact: true })).toHaveCount(0);

    // The archive is still kept: Try archiving again sends the same change and finishes the draft.
    failing = false;
    await page.getByRole('button', { name: 'Try archiving again' }).click();
    await expect.poll(() => draftStateOf(company, jobId)).toBe('archived');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    await expect(page.getByRole('button', { name: 'Try archiving again' })).toHaveCount(0);
  });
}

test('while the read of the job after an archive answered 503 has no answer, every editable section is read only and the archive is kept', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-recheck-hold', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '14 Held Court');
  const sent: { revision: number; changeId: string }[] = [];
  await page.route(`**/api/jobs/${jobId}/archive`, (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { revision: number; changeId: string });
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'jobs_unavailable' }) });
  });
  let cutReads = false;
  await page.route(`**/api/jobs/${jobId}`, (route) => (cutReads && route.request().method() === 'GET' ? route.abort() : route.fallback()));

  await signIn(page, company, owner);
  await openJob(page, '14 Held Court');
  await page.getByRole('button', { name: 'Archive job' }).click();
  cutReads = true;
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();

  // The read that would say whether the archive committed gets no answer: nothing is saved from any section.
  await expect(page.getByRole('button', { name: 'Try archiving again' })).toBeVisible();
  await expect(page.getByLabel('Year built')).not.toBeEditable();
  await page.getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Customer name')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save customer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save claim' })).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByRole('textbox', { name: 'Office notes' })).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save notes' })).toBeDisabled();
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await expect(page.getByLabel('Take photo')).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test('a job read answered 410 with no body after an archive answered 503 shows the job archived', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-recheck-410', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '15 Bodyless Court');
  await page.route(`**/api/jobs/${jobId}/archive`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'jobs_unavailable' }) }));
  let gone = false;
  await page.route(`**/api/jobs/${jobId}`, (route) => (gone && route.request().method() === 'GET' ? route.fulfill({ status: 410, body: '' }) : route.fallback()));

  await signIn(page, company, owner);
  await openJob(page, '15 Bodyless Court');
  await page.getByRole('button', { name: 'Archive job' }).click();
  gone = true;
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();

  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByLabel('Year built')).not.toBeEditable();
});

test('an archive answered 503 that did not commit is held read only until the job is read, then editable again with the same archive kept', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-uncommitted', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '13 Not Archived Court');
  const sent: { revision: number; changeId: string }[] = [];
  await page.route(`**/api/jobs/${jobId}/archive`, (route) => {
    sent.push(JSON.parse(route.request().postData() ?? '{}') as { revision: number; changeId: string });
    return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'jobs_unavailable' }) });
  });

  await signIn(page, company, owner);
  await openJob(page, '13 Not Archived Court');
  await page.getByRole('button', { name: 'Archive job' }).click();
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();

  // The read of the job finds it not archived: the screen is not locked for good, and the kept archive
  // is offered again, as the same change.
  await expect(page.getByRole('button', { name: 'Try archiving again' })).toBeVisible();
  await expect(page.getByLabel('Year built')).toBeEditable();
  expect(await statusOf(jobId)).toBe('draft');
  expect(sent).toHaveLength(1);
});

test('a refused jobs list clears every property address, the Restore notice and the unfinished archives included, also on the list opened next', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('list-denied', { owner: 'owner' });
  const owner = company.people.owner!;
  const first = await seedJob(request, company, owner, '51 Restored First Street');
  await seedJob(request, company, owner, '52 Unfinished Second Street');
  const done = await request.post(`${JOBS_BASE_URL}/api/jobs/${first}/archive`, { headers: await bearer(company, owner), data: { revision: 1, changeId: randomUUID() } });
  expect(done.status()).toBe(200);

  await signIn(page, company, owner);
  // An archive of the second job is left unfinished: its answer never came.
  await openJob(page, '52 Unfinished Second Street');
  await page.route(/\/api\/jobs\/[^/?]+\/archive$/, (route) => route.abort());
  await page.getByRole('button', { name: 'Archive job' }).click();
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();
  await expect(page.getByRole('button', { name: 'Try archiving again' })).toBeVisible();

  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();
  const unfinished = main(page).getByRole('list', { name: 'Not finished' });
  await expect(unfinished.getByText('52 Unfinished Second Street')).toBeVisible();
  await main(page).getByRole('list', { name: 'Archived drafts' }).getByRole('listitem').filter({ hasText: '51 Restored First Street' }).getByRole('button', { name: 'Restore' }).click();
  await expect(main(page).getByRole('link', { name: 'Open 51 Restored First Street' })).toBeVisible();

  // The company is suspended: the next list read is refused (403). The one after that is held back, so
  // what a list shows before its own answer is seen.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let refused = 0;
  await page.route(/\/api\/jobs\?/, async (route) => {
    if (refused === 0) {
      refused += 1;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) });
    }
    await held;
    return route.continue();
  });
  await main(page).getByRole('link', { name: 'Company jobs' }).click();
  await expect(main(page).getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();
  await expect(main(page).getByText('51 Restored First Street')).toHaveCount(0);
  await expect(main(page).getByText('52 Unfinished Second Street')).toHaveCount(0);
  await expect(main(page).getByRole('status').filter({ hasText: 'Restored' })).toHaveCount(0);

  // A list opened next shows no address while its own answer is pending.
  await main(page).getByRole('link', { name: 'My jobs' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Loading jobs' })).toBeVisible();
  await expect(main(page).getByText('52 Unfinished Second Street')).toHaveCount(0);
  await expect(main(page).getByText('51 Restored First Street')).toHaveCount(0);

  // Once a list is answered again, the unfinished archive is shown.
  release();
  await expect(main(page).getByRole('list', { name: 'Not finished' })).toBeVisible();

  // A refusal that arrives after the list that asked was left is recorded all the same: Company jobs is
  // opened, My jobs follows before the refusal, and no address shows once it comes.
  let lateRefusal: () => void = () => undefined;
  const refusalHeld = new Promise<void>((resolve) => (lateRefusal = resolve));
  let mineHeld: () => void = () => undefined;
  const mineWaits = new Promise<void>((resolve) => (mineHeld = resolve));
  let asked = 0;
  await page.route(/\/api\/jobs\?/, async (route) => {
    asked += 1;
    if (asked === 1) {
      await refusalHeld;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) });
    }
    await mineWaits;
    return route.continue();
  });
  await main(page).getByRole('link', { name: 'Company jobs' }).click();
  await expect.poll(() => asked).toBe(1);
  await main(page).getByRole('link', { name: 'My jobs' }).click();
  await expect.poll(() => asked).toBe(2);
  lateRefusal();
  await expect(main(page).getByRole('status').filter({ hasText: 'Loading jobs' })).toBeVisible();
  await expect(main(page).getByText('52 Unfinished Second Street')).toHaveCount(0);
  await expect(main(page).getByText('51 Restored First Street')).toHaveCount(0);
  mineHeld();
  await expect(main(page).getByRole('list', { name: 'Not finished' })).toBeVisible();
});

// A small PNG, as a phone's camera would hand the page a picture.
const PICTURE = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==',
    'base64',
  ),
};

test('a refusal of one list read hides the rows already shown while a newer read is pending, until a list is answered again', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('list-denied-rows', { owner: 'owner' });
  const owner = company.people.owner!;
  const ids = [await seedJob(request, company, owner, '61 Restored A Road'), await seedJob(request, company, owner, '62 Restored B Road'), await seedJob(request, company, owner, '63 Still Archived Road')];
  for (const id of ids) {
    const done = await request.post(`${JOBS_BASE_URL}/api/jobs/${id}/archive`, { headers: await bearer(company, owner), data: { revision: 1, changeId: randomUUID() } });
    expect(done.status()).toBe(200);
  }

  await signIn(page, company, owner);
  await main(page).getByRole('link', { name: 'Archived drafts' }).click();
  const archived = main(page).getByRole('list', { name: 'Archived drafts' });
  await expect(archived.getByRole('listitem')).toHaveCount(3);

  // Two restores each read the list again: the first read is refused only after the second was asked.
  let refuse: () => void = () => undefined;
  const refusal = new Promise<void>((resolve) => (refuse = resolve));
  let answer: () => void = () => undefined;
  const answerHeld = new Promise<void>((resolve) => (answer = resolve));
  let asked = 0;
  await page.route(/\/api\/jobs\?/, async (route) => {
    asked += 1;
    if (asked === 1) {
      await refusal;
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) });
    }
    await answerHeld;
    return route.continue();
  });
  await archived.getByRole('listitem').filter({ hasText: '61 Restored A Road' }).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => asked).toBeGreaterThanOrEqual(1);
  await archived.getByRole('listitem').filter({ hasText: '62 Restored B Road' }).getByRole('button', { name: 'Restore' }).click();
  await expect.poll(() => asked).toBeGreaterThanOrEqual(2);
  await expect(archived.getByText('63 Still Archived Road')).toBeVisible();

  refuse();
  await expect(main(page).getByText('63 Still Archived Road')).toHaveCount(0);
  await expect(main(page).getByText(/Restored: it is back/)).toHaveCount(0);

  // A later answer that comes means access again: the list shows.
  answer();
  await expect(main(page).getByRole('list', { name: 'Archived drafts' }).getByText('63 Still Archived Road')).toBeVisible();
});

test('after a refused jobs list a job opened again by Back shows no address or customer from before, while its read is pending', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('list-denied-back', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '64 Cached Detail Lane');

  await signIn(page, company, owner);
  await openJob(page, '64 Cached Detail Lane');
  await page.route(/\/api\/jobs\?/, (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden' }) }));
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('alert').filter({ hasText: /./ }).first()).toBeVisible();

  let release: () => void = () => undefined;
  const readHeld = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/jobs/${jobId}`, async (route) => {
    await readHeld;
    return route.fallback();
  });
  await page.goBack();
  await expect(page.getByRole('status').filter({ hasText: 'Opening the job' })).toBeVisible();
  await expect(page.getByText('64 Cached Detail Lane')).toHaveCount(0);
  release();
});

test('a photo answered after an archive answered 503 is not saved to the draft and is kept to send again; the estimator picker is read only too', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('archive-photo-hold', { owner: 'owner', helper: 'estimator' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '65 Photo Hold Place');
  await page.route(`**/api/jobs/${jobId}/archive`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'jobs_unavailable' }) }));
  let cutReads = false;
  await page.route(`**/api/jobs/${jobId}`, (route) => (cutReads && route.request().method() === 'GET' ? route.abort() : route.fallback()));
  // The server holds the bytes, but the answer waits until after the archive.
  let release: () => void = () => undefined;
  const answerHeld = new Promise<void>((resolve) => (release = resolve));
  let registered = false;
  await page.route(new RegExp(`/api/jobs/${jobId}/photos/[^/?]+`), async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const real = await route.fetch();
    registered = true;
    await answerHeld;
    return route.fulfill({ response: real });
  });

  await signIn(page, company, owner);
  await openJob(page, '65 Photo Hold Place');
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await page.getByLabel('Take photo').setInputFiles(PICTURE);
  await expect.poll(() => registered).toBe(true);

  cutReads = true;
  await page.getByRole('button', { name: 'Archive job' }).click();
  await page.getByRole('dialog', { name: 'Archive this job?' }).getByRole('button', { name: 'Archive job' }).click();
  await expect(page.getByRole('button', { name: 'Try archiving again' })).toBeVisible();

  release();
  await expect(page.getByRole('alert').filter({ hasText: 'this job is being checked' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeDisabled();
  const draft = await currentDraftOf(company.id, jobId);
  expect((await adminDb().collection(`companies/${company.id}/drafts/${draft}/photos`).get()).size).toBe(0);

  await main(page).getByRole('link', { name: 'Job coordination' }).click();
  await expect(page.getByLabel('Estimator', { exact: true })).toBeDisabled();
});

test('a photo that is not available does not hold customer and claim read only while the job is read again', async ({ page, request }) => {
  test.setTimeout(150_000);
  const company = await seedCompany('missing-photo-open', { owner: 'owner' });
  const owner = company.people.owner!;
  const jobId = await seedJob(request, company, owner, '66 Missing Photo Way');
  let cutReads = false;
  await page.route(`**/api/jobs/${jobId}`, (route) => (cutReads && route.request().method() === 'GET' ? route.abort() : route.fallback()));
  await page.route(new RegExp(`/api/jobs/${jobId}/photos/[^/?]+`), (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not_found' }) }) : route.fallback(),
  );

  await signIn(page, company, owner);
  await openJob(page, '66 Missing Photo Way');
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  cutReads = true;
  await page.getByLabel('Take photo').setInputFiles(PICTURE);
  await expect(page.getByText(/not available/)).toBeVisible();

  await page.getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Customer name')).toBeEditable();
  await expect(page.getByRole('button', { name: 'Save customer' })).toBeVisible();
});
