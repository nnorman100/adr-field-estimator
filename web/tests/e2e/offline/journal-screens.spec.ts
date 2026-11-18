// The sync chip and the "Can't save" sheet (S6-4b; docs/plans/S6/S6-4.md) on the real job screens
// behind the network lane, as job-edits.spec.ts drives them: field writes, refusals and the journal
// are the app's own against the emulators and rules; only the SQL routes are stand-ins.
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { firestoreJobProjectionStore } from '../../../src/lib/jobs/projection';
import { expect, expectNothingSent, SEND_MS, test } from './fixture';
import { FieldPhone, inDays } from './field-phone';
import type { NetworkLane } from './lane';
import { adminDb, fenceDraft, readDoc, readDraft, seedCompany, type World } from './world';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

const json = (body: unknown, status = 200) => ({ type: 'application/json', body: JSON.stringify(body), status });

function jobDetail(jobId: string, draftId: string) {
  const now = new Date().toISOString();
  return {
    job: { id: jobId, status: 'draft', currentDraftId: draftId, fieldOwnerActorId: 'actor', propertyAddress: '', revision: 1, createdAt: now, updatedAt: now },
    customer: { name: '', phone: '', email: '' },
    claim: { carrier: '', claimNumber: '', policyNumber: '', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' },
  };
}

async function serveJob(lane: NetworkLane, world: Pick<World, 'companyId'>, jobId: string, draftId: string) {
  lane.serve(`/api/jobs/${jobId}`, json(jobDetail(jobId, draftId)));
  lane.serve(`/api/jobs/${jobId}/scope-lists`, json({ version: null, roomTypes: [], items: [], prepTasks: [] }));
  await firestoreJobProjectionStore(adminDb()).projectJob(world.companyId, jobId, { currentDraftId: draftId, revision: 1 });
}

// Signed in as the draft's estimator, the job open on Check Scope, its draft bound to the job.
async function openJob(
  context: Parameters<typeof FieldPhone.open>[0],
  lane: NetworkLane,
  world: World,
  keep: 'Keep jobs on this phone' | 'Online only' = 'Keep jobs on this phone',
): Promise<{ page: Page; jobId: string }> {
  const phone = await FieldPhone.open(context, lane);
  const person = await phone.signIn(world, world.owner);
  const capabilities = ['scope', 'jobs_create', 'photos'];
  await phone.call('saveMe', person, { companyId: world.companyId, actorId: 'actor', role: 'estimator', capabilities, authTime: Date.now() });
  lane.serve('/api/me', json({ company: { id: world.companyId, name: 'Field Test' }, actor: { id: 'actor', displayName: null }, role: 'estimator', capabilities, fieldAccessExpiresAt: inDays(7).toISOString() }));
  const jobId = randomUUID();
  await adminDb().doc(world.draftPath).update({ jobId });
  await serveJob(lane, world, jobId, world.draftId);
  const page = phone.page;
  await page.goto(`${lane.appUrl}/field?job=${jobId}`);
  await page.getByRole('button', { name: keep }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
  return { page, jobId };
}

const chip = (page: Page): Locator => page.getByRole('status', { name: 'Sync' });

async function offline(page: Page, lane: NetworkLane) {
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
}

async function online(page: Page, lane: NetworkLane) {
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

async function saveYear(page: Page, year: string) {
  await page.getByLabel('Year built').fill(year);
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('status')).toContainText('Saved on this phone');
}

// The person's journal entries, read from the phone's own store.
function journal(page: Page): Promise<{ id: string; state: string; reason?: string; draftPath: string }[]> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('ds-journal');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const read = open.result.transaction('entries', 'readonly').objectStore('entries').getAll();
          read.onsuccess = () => {
            open.result.close();
            resolve(read.result);
          };
          read.onerror = () => reject(read.error);
        };
      }),
  );
}

test('an edit is Saved on this phone with a count while it waits, and Saved once the server has it', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page } = await openJob(context, lane, world);
  await expect(chip(page)).toHaveText('Saved');
  await offline(page, lane);
  await saveYear(page, '1962');
  await expect(chip(page)).toHaveText('Saved on this phone (1 waiting to send)');
  await expectNothingSent(lane);
  await online(page, lane);
  await expect.poll(async () => (await readDraft(world)).field.yearBuilt, { timeout: SEND_MS }).toBe(1962);
  await expect(chip(page)).toHaveText('Saved', { timeout: SEND_MS });
});

test('a write refused after a restart because the job was finished is Can’t save with that reason, and Discard asks first', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page, jobId } = await openJob(context, lane, world);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await offline(page, lane);
  await saveYear(page, '1962');
  // The job is finished on the server while the phone has no signal; then the app is opened again.
  await fenceDraft(world);
  const submitted = await readDraft(world);
  await page.reload();
  await expect(page.getByLabel('Year built')).toBeVisible();
  await online(page, lane);
  await expect(chip(page)).toHaveText('Can’t save: job finished', { timeout: SEND_MS });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await expect(sheet.getByRole('heading', { name: 'This job was finished' })).toBeVisible();
  // A person's own Finish leads to Back to editing, never to a new draft or a resend.
  await expect(sheet.getByRole('link', { name: 'Go to Finish and review' })).toHaveAttribute('href', new RegExp(`/jobs/${jobId}/finish$`));
  await expect(sheet.getByRole('button', { name: 'Save as new draft' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('dialog', { name: 'Discard these changes?' });
  await expect(confirm.getByRole('button', { name: 'Keep them' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep them' }).click();
  expect(await journal(page)).toEqual([expect.objectContaining({ state: 'rejected', reason: 'locked' })]);
  await sheet.getByRole('button', { name: 'Discard' }).click();
  await confirm.getByRole('button', { name: 'Discard changes' }).click();
  await expect.poll(() => journal(page)).toEqual([]);
  await expect(chip(page)).toHaveText('Saved');
  expect(await readDraft(world)).toEqual(submitted);
});

test('a write refused because the job was archived is sent by Try again once the job is restored', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page } = await openJob(context, lane, world);
  await offline(page, lane);
  await saveYear(page, '1962');
  await adminDb().doc(world.draftPath).update({ state: 'archived' });
  await online(page, lane);
  await expect(chip(page)).toHaveText('Can’t save: job archived', { timeout: SEND_MS });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await expect(sheet.getByRole('heading', { name: 'This job was archived' })).toBeVisible();
  await expect(sheet.getByText('Photos stay with the old job')).toBeVisible();
  // Still archived: Try again says so and keeps the change.
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Still can’t save: the reason above still holds.');
  expect((await readDraft(world)).field).not.toHaveProperty('yearBuilt');
  await adminDb().doc(world.draftPath).update({ state: 'editing' });
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(async () => (await readDraft(world)).field.yearBuilt, { timeout: SEND_MS }).toBe(1962);
  await expect(chip(page)).toHaveText('Saved', { timeout: SEND_MS });
  expect(await journal(page)).toEqual([]);
});

test('a job finished and then archived is still finished: Back to editing, never Save as new draft', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page, jobId } = await openJob(context, lane, world);
  await offline(page, lane);
  await saveYear(page, '1962');
  // Finished by the person, then archived (the archive keeps the fence), while the phone had no signal.
  await adminDb().doc(world.draftPath).update({ state: 'archived', fence: { submissionId: 's1', epoch: 'e1', expiresAt: new Date() } });
  await online(page, lane);
  await expect(chip(page)).toHaveText('Can’t save: job finished', { timeout: SEND_MS });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await expect(sheet.getByRole('heading', { name: 'This job was finished' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Go to Finish and review' })).toHaveAttribute('href', new RegExp(`/jobs/${jobId}/finish$`));
  await expect(sheet.getByRole('button', { name: 'Save as new draft' })).toHaveCount(0);
});

test('Try again never sends an edit over a value saved since it was refused: it is Changed on another device', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page } = await openJob(context, lane, world);
  await offline(page, lane);
  await saveYear(page, '1962');
  await adminDb().doc(world.draftPath).update({ state: 'archived' });
  await online(page, lane);
  await expect(chip(page)).toHaveText('Can’t save: job archived', { timeout: SEND_MS });
  // Restored, and another device saved its own year since.
  await adminDb().doc(world.draftPath).update({ state: 'editing', 'field.yearBuilt': 1970 });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await sheet.getByRole('button', { name: 'Try again' }).click();
  await expect(chip(page)).toHaveText('Changed on another device', { timeout: SEND_MS });
  await expect(sheet.getByRole('heading', { name: 'Changed on another device' })).toBeVisible();
  expect((await readDraft(world)).field.yearBuilt).toBe(1970);
  expect(await journal(page)).toEqual([expect.objectContaining({ state: 'changed' })]);
});

test('with Online only, the chip says Saved once the server has an edit, and Can’t save with the reason when it refuses one', async ({ context, lane }) => {
  const world = await seedCompany();
  const { page } = await openJob(context, lane, world, 'Online only');
  await expect(chip(page)).toHaveText('Saved');
  await page.getByLabel('Year built').fill('1962');
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect.poll(async () => (await readDraft(world)).field.yearBuilt, { timeout: SEND_MS }).toBe(1962);
  await expect(chip(page)).toHaveText('Saved', { timeout: SEND_MS });
  // Archived on the server while the screen still shows the job open.
  await adminDb().doc(world.draftPath).update({ state: 'archived' });
  await page.getByLabel('Year built').fill('1970');
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect(chip(page)).toHaveText('Can’t save: job archived', { timeout: SEND_MS });
  expect((await readDraft(world)).field.yearBuilt).toBe(1962);
});

test('Save as new draft of field work that moved makes one new job with the cached field work and the refused edit', async ({ context, lane }) => {
  const world = await seedCompany({ people: ['ana', 'ben'] });
  await adminDb().doc(world.draftPath).update({ 'field.notes': 'kept on the phone' });
  await adminDb().doc(`${world.draftPath}/rooms/r1`).set({ field: { name: 'Kitchen' } });
  await adminDb().doc(world.draftPath).update({ 'field.roomOrder': ['r1'] });
  const { page } = await openJob(context, lane, world);
  await offline(page, lane);
  await saveYear(page, '1962');
  // The owner moves the field work to Ben while Ana's phone has no signal.
  await adminDb().doc(world.draftPath).update({ fieldOwnerUid: world.people.ben!.uid });
  await online(page, lane);
  await expect(chip(page)).toHaveText('Can’t save: another person owns it', { timeout: SEND_MS });

  // The jobs API stand-in: the first answer is lost after the job is made, so the phone sends again.
  const made: { id: string; draftId: string }[] = [];
  lane.serve('/api/jobs', async (_headers, _url, request) => {
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const body = JSON.parse(request.body.toString()) as { id: string; draftId: string; propertyAddress: string };
    made.push({ id: body.id, draftId: body.draftId });
    const path = `companies/${world.companyId}/drafts/${body.draftId}`;
    if (!(await readDoc(path))) await adminDb().doc(path).set({ fieldOwnerUid: world.owner.uid, state: 'editing', jobId: body.id, field: {} });
    await serveJob(lane, world, body.id, body.draftId);
    return made.length === 1 ? json({ error: 'unavailable' }, 503) : json(jobDetail(body.id, body.draftId));
  });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await expect(sheet.getByRole('heading', { name: 'Another person owns this job’s field work now' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Save as new draft' }).click();
  await expect(sheet.getByRole('alert')).toContainText('it makes the same new draft');
  await sheet.getByRole('button', { name: 'Save as new draft' }).click();
  await expect.poll(() => made.length, { timeout: SEND_MS }).toBe(2);
  await expect(page).toHaveURL(new RegExp(`job=${made[1]!.id}`), { timeout: SEND_MS });

  // The same ids both times: one new job and draft.
  expect(made).toHaveLength(2);
  expect(made[1]).toEqual(made[0]);
  const copy = `companies/${world.companyId}/drafts/${made[0]!.draftId}`;
  await expect.poll(async () => (await readDoc(copy))?.field, { timeout: SEND_MS }).toEqual({ airMovers: 0, notes: 'kept on the phone', roomOrder: ['r1'], yearBuilt: 1962 });
  expect(await readDoc(`${copy}/rooms/r1`)).toEqual({ field: { name: 'Kitchen' } });
  expect((await readDraft(world)).field).not.toHaveProperty('yearBuilt');
  await expect(chip(page)).toHaveText('Saved', { timeout: SEND_MS });
  expect(await journal(page)).toEqual([]);
});

test('an edit the server holds another value for, with no refusal, is Changed on another device', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await FieldPhone.open(context, lane);
  const person = await phone.signIn(world, world.owner);
  // Left by an earlier page: an edit whose base the phone did not know, while another device saved
  // the same key since.
  await phone.call('journalOnly', person, world.draftPath, { 'field.notes': 'typed here' });
  await adminDb().doc(world.draftPath).update({ 'field.notes': 'typed on the other phone' });
  await phone.page.close();
  const { page } = await openJob(context, lane, world);
  await expect(chip(page)).toHaveText('Changed on another device', { timeout: SEND_MS });
  await chip(page).getByRole('button').click();
  const sheet = page.getByRole('dialog', { name: 'Changes not saved' });
  await expect(sheet.getByRole('heading', { name: 'Changed on another device' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Save as new draft' })).toHaveCount(0);
  await expect(page.getByText('Can’t save')).toHaveCount(0);
  expect((await readDraft(world)).field.notes).toBe('typed on the other phone');
});
