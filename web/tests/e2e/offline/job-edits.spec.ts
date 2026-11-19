// The actual job screens behind the network lane, including WebKit's worker-controlled page.
// Only the SQL reads are stand-ins; field writes and their receipts use the real emulator/rules.
import { randomUUID } from 'node:crypto';
import { HIDDEN_TEXT } from '../../../src/app/field/field-store-text';
import { firestoreJobProjectionStore } from '../../../src/lib/jobs/projection';
import { keepKey } from '../../../src/lib/field/keep-consent';
import { unsentKey } from '../../../src/lib/field/unsent';
import { expect, expectNothingSent, SEND_MS, test } from './fixture';
import { FieldPhone, inDays } from './field-phone';
import { adminDb, readDraft, seedCompany, type World } from './world';
import type { Page } from '@playwright/test';
import type { NetworkLane } from './lane';

test.use({ serviceWorkers: 'allow', viewport: { width: 390, height: 844 } });

// A small PNG, as a phone's camera would hand the page a picture.
const PICTURE = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==',
    'base64',
  ),
};

function serveMe(lane: NetworkLane, world: World) {
  lane.serve('/api/me', { type: 'application/json', body: JSON.stringify({
    company: { id: world.companyId, name: 'Field Test' }, actor: { id: 'actor', displayName: null }, role: 'estimator',
    capabilities: ['scope', 'jobs_create', 'photos'], fieldAccessExpiresAt: inDays(7).toISOString(),
  }) });
}

async function openJob(page: Page, lane: NetworkLane, world: World, jobId: string) {
  serveMe(lane, world);
  lane.serve(`/api/jobs/${jobId}`, { type: 'application/json', body: JSON.stringify({
    job: { id: jobId, status: 'draft', currentDraftId: world.draftId, fieldOwnerActorId: 'actor',
      propertyAddress: 'Offline test job', revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    customer: { name: '', phone: '', email: '' },
    claim: { carrier: '', claimNumber: '', policyNumber: '', dateOfLoss: null, lossCause: '',
      adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' },
  }) });
  lane.serve(`/api/jobs/${jobId}/scope-lists`, { type: 'application/json', body: JSON.stringify({
    version: null, roomTypes: [], items: [], prepTasks: ['Protect contents'],
  }) });
  await firestoreJobProjectionStore(adminDb()).projectJob(world.companyId, jobId, { currentDraftId: world.draftId, revision: 1 });
  await page.goto(`${lane.appUrl}/field?job=${jobId}`);
  await page.getByRole('button', { name: 'Keep jobs on this phone' }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
}

async function mark(page: Page, world: World) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), unsentKey(world.tenantId, world.owner.uid));
}

async function signedIn(context: Parameters<typeof FieldPhone.open>[0], lane: NetworkLane, world: World) {
  const phone = await FieldPhone.open(context, lane);
  const person = await phone.signIn(world, world.owner);
  await phone.call('saveMe', person, { companyId: world.companyId, actorId: 'actor', role: 'estimator', capabilities: ['scope', 'jobs_create', 'photos'], authTime: Date.now() });
  return phone;
}

test('an open job saves scope and rooms offline, marks unsent work, and reconnects once', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await page.getByLabel('Year built').fill('1962');
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save scope', exact: true })).toBeEnabled();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('status')).toContainText('Saved on this phone');
  await expect.poll(() => mark(page, world)).toMatchObject({ unsentSince: expect.any(Number) });
  await page.getByLabel('New room name').fill('Kitchen');
  await page.getByRole('button', { name: 'Add room', exact: true }).click();
  const room = page.getByRole('form', { name: 'Kitchen', exact: true });
  await expect(room).toBeVisible();
  await room.getByLabel('Floor area (sq ft)', { exact: true }).fill('120');
  await room.getByLabel('Water category or mold').selectOption('2');
  await room.getByLabel('Findings in this room').fill('Wet baseboard');
  await room.getByLabel('Your own prep task').fill('Protect contents');
  await room.getByRole('button', { name: 'Add own task', exact: true }).click();
  await room.getByRole('button', { name: 'Save room', exact: true }).click();
  await expect(room.getByRole('button', { name: 'Save room', exact: true })).toBeEnabled();
  await expectNothingSent(lane);
  expect((await readDraft(world)).field).not.toHaveProperty('yearBuilt');
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await readDraft(world)).field, { timeout: SEND_MS }).toMatchObject({ yearBuilt: 1962, roomOrder: [expect.any(String)] });
  await expect.poll(() => mark(page, world), { timeout: SEND_MS }).toMatchObject({ unsentSince: null });
  const stored = await adminDb().collection(`${world.draftPath}/rooms`).get();
  expect(stored.docs.map((item) => item.data().field)).toEqual([{ name: 'Kitchen', category: 2, floorSf: 120, findings: 'Wet baseboard', prepTasks: ['Protect contents'] }]);
  const revision = (await adminDb().doc(world.draftPath).get()).updateTime!.toMillis();
  await page.waitForTimeout(3000);
  expect((await adminDb().doc(world.draftPath).get()).updateTime!.toMillis()).toBe(revision);
});

test('a job opened earlier on the same page reopens its field work offline', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to jobs' }).click();
  await expect(page.getByLabel('Year built')).toHaveCount(0);
  await page.goBack();
  await expect(page.getByLabel('Year built')).toBeEditable();
  await expectNothingSent(lane);
});

test('a failed SQL job read keeps the cached field work open', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  const jobId = randomUUID();
  await openJob(phone.page, lane, world, jobId);
  const page = phone.page;
  await page.evaluate(() => navigator.serviceWorker.ready);
  lane.cut();
  await page.reload();
  await expect(page.getByLabel('Year built')).toBeEditable();
  lane.serve(`/api/jobs/${jobId}`, { type: 'application/json', body: JSON.stringify({ error: 'unavailable' }), status: 503 });
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toBeEditable();
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await expect(page.getByLabel('Year built')).toBeEditable();
});

test('a job found archived after an offline edit keeps the open forms and the unsaved input, read only', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  const jobId = randomUUID();
  await openJob(phone.page, lane, world, jobId);
  const page = phone.page;
  await page.evaluate(() => navigator.serviceWorker.ready);
  lane.cut();
  await page.reload();
  await expect(page.getByLabel('Year built')).toBeEditable();
  await page.getByLabel('Year built').fill('1962');
  // The owner archived the job meanwhile: the first job read after the signal returns answers 410.
  lane.serve(`/api/jobs/${jobId}`, { type: 'application/json', body: JSON.stringify({ error: 'archived' }), status: 410 });
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByRole('heading', { name: 'This job is archived' })).toBeVisible();
  await expect(page.getByLabel('Year built')).toHaveValue('1962');
  await expect(page.getByLabel('Year built')).not.toBeEditable();
});

test('a photo taken while the camera hid the page is kept to send again', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Take photo', { exact: true }).click();
  const camera = await chooser;
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await camera.setFiles(PICTURE);
  const sending = page.getByRole('list', { name: 'Photos being sent' });
  await expect(sending.getByText('Not sent yet.')).toBeVisible();
  await expect(sending.getByRole('button', { name: 'Send again' })).toBeDisabled();
  await expect(page.getByLabel('Take photo')).toHaveCount(0);
  expect(await mark(page, world)).toMatchObject({ photosInMemory: [expect.any(String)] });
  await expectNothingSent(lane);
});

test('a photo the phone cannot record after the camera hid the page says so', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByText('Take photo', { exact: true }).click();
  const camera = await chooser;
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await page.evaluate((key) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Full', 'QuotaExceededError');
      return real.call(this, name, value);
    };
  }, unsentKey(world.tenantId, world.owner.uid));
  await camera.setFiles(PICTURE);
  await expect(page.getByRole('alert').filter({ hasText: 'could not record the photo' })).toBeVisible();
  await expect(page.getByLabel('Take photo')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Photos being sent' })).toHaveCount(0);
  await expectNothingSent(lane);
});

test('a page of jobs asked for before the list is read again on resume is not added to it', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  const page = phone.page;
  serveMe(lane, world);
  const now = new Date().toISOString();
  const pageOf = (n: number, nextCursor: string | null) => ({ type: 'application/json', body: JSON.stringify({
    jobs: [{ id: randomUUID(), status: 'draft', propertyAddress: `Job ${n}`, revision: 1, createdAt: now, updatedAt: now, customerName: '', mine: true }],
    nextCursor,
  }) });
  let releaseThird!: () => void;
  const third = new Promise<void>((done) => (releaseThird = done));
  lane.serve('/api/jobs', async (_headers, url) => {
    const cursor = new URL(url, 'http://lane').searchParams.get('cursor');
    if (cursor === 'two') return pageOf(2, 'three');
    if (cursor === 'three') {
      await third;
      return pageOf(3, null);
    }
    return pageOf(1, 'two');
  });
  await page.goto(`${lane.appUrl}/field`);
  await page.getByRole('button', { name: 'Keep jobs on this phone' }).click();
  const jobs = page.getByRole('list', { name: 'My jobs' });
  await expect(jobs.getByText('Job 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show more jobs' }).click();
  await expect(jobs.getByText('Job 2', { exact: true })).toBeVisible();
  const asked = page.waitForRequest((request) => request.url().includes('cursor=three'));
  await page.getByRole('button', { name: 'Show more jobs' }).click();
  await asked;
  await page.evaluate(() => {
    const shown = { value: false };
    Object.defineProperty(document, 'visibilityState', { get: () => (shown.value ? 'visible' : 'hidden'), configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    (window as unknown as { shown: typeof shown }).shown = shown;
  });
  await expect(page.getByText('Needs a connection', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { shown: { value: boolean } }).shown.value = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(jobs.getByText('Job 2', { exact: true })).toHaveCount(0);
  await expect(jobs.getByText('Job 1', { exact: true })).toBeVisible();
  releaseThird();
  await page.getByRole('button', { name: 'Show more jobs' }).click();
  await expect(jobs.getByText('Job 2', { exact: true })).toBeVisible();
  await expect(jobs.getByText('Job 3', { exact: true })).toHaveCount(0);
});

test('a failed first-page refresh on resume is tried again from the first page, not the next', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  const page = phone.page;
  serveMe(lane, world);
  const now = new Date().toISOString();
  const pageOf = (name: string, nextCursor: string | null) => ({ type: 'application/json', body: JSON.stringify({
    jobs: [{ id: randomUUID(), status: 'draft', propertyAddress: name, revision: 1, createdAt: now, updatedAt: now, customerName: '', mine: true }],
    nextCursor,
  }) });
  let firstPages = 0;
  lane.serve('/api/jobs', async (_headers, url) => {
    if (new URL(url, 'http://lane').searchParams.get('cursor') === 'two') return pageOf('Older job', null);
    firstPages += 1;
    if (firstPages === 1) return pageOf('First job', 'two');
    if (firstPages === 2) return { type: 'application/json', status: 500, body: JSON.stringify({ error: 'unavailable' }) };
    return pageOf('Newer job', 'two');
  });
  await page.goto(`${lane.appUrl}/field`);
  await page.getByRole('button', { name: 'Keep jobs on this phone' }).click();
  const jobs = page.getByRole('list', { name: 'My jobs' });
  await expect(jobs.getByText('First job', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const shown = { value: false };
    Object.defineProperty(document, 'visibilityState', { get: () => (shown.value ? 'visible' : 'hidden'), configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    (window as unknown as { shown: typeof shown }).shown = shown;
  });
  await expect(page.getByText('Needs a connection', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { shown: { value: boolean } }).shown.value = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(jobs.getByText('Newer job', { exact: true })).toBeVisible();
  await expect(jobs.getByText('First job', { exact: true })).toHaveCount(0);
  await expect(jobs.getByText('Older job', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more jobs' })).toBeVisible();
});

test('SQL customer and claim edits need a connection and are never queued offline', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  await page.getByRole('link', { name: 'Customer and claim' }).click();
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByRole('button', { name: 'Save customer', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save claim', exact: true })).toBeDisabled();
  await expect(page.getByText('Needs a connection', { exact: true }).first()).toBeVisible();
});

test('a person locked out past 30 days sees no job inputs offline, and no local work is deleted', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await phone.call('setMark', phone.person(world, world.owner), {
    writes: 1, unsentSince: Date.now(), lockedSince: Date.now() - 31 * 86_400_000, lockedReason: 'member-disabled',
  });
  await phone.page.evaluate((key) => localStorage.setItem(key, 'keep'), keepKey(world.tenantId));
  lane.drop('/api/me');
  await phone.page.goto(`${lane.appUrl}/field?job=${randomUUID()}`);
  await phone.page.evaluate(() => navigator.serviceWorker.ready);
  lane.cut();
  await phone.page.reload();
  await expect(phone.page.getByText(HIDDEN_TEXT)).toBeVisible();
  await expect(phone.page.getByLabel('Year built')).toHaveCount(0);
  await expect(phone.page.getByLabel('Customer name')).toHaveCount(0);
  expect(await mark(phone.page, world)).toMatchObject({ unsentSince: expect.any(Number), lockedReason: 'member-disabled' });
});

// The same job-only URL reopens the current field draft with no SQL/API copy on the phone.
test('a scope edit made by the screen survives an offline reload and syncs after reconnect', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.getByLabel('Year built')).toBeEditable();
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  await page.getByLabel('Year built').fill('1962');
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('status')).toContainText('Saved on this phone');
  const unsentBefore = await mark(page, world);
  await page.reload();
  await expect(page.getByLabel('Year built')).toHaveValue('1962');
  await page.getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByText('Needs a connection', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Customer name')).toHaveCount(0);
  await page.getByRole('link', { name: 'Check Scope' }).click();
  await expect.poll(() => mark(page, world)).toMatchObject({ unsentSince: unsentBefore.unsentSince });
  expect((await readDraft(world)).field).not.toHaveProperty('yearBuilt');
  await expectNothingSent(lane);
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await readDraft(world)).field.yearBuilt, { timeout: SEND_MS }).toBe(1962);
  await expect(page.getByLabel('Year built')).toHaveValue('1962');
  await expect.poll(() => mark(page, world)).toMatchObject({ unsentSince: null });
});

test('a phone that cannot save its unsent mark makes no field edit and keeps the typed value', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  await openJob(phone.page, lane, world, randomUUID());
  const page = phone.page;
  await page.evaluate((key) => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('Full', 'QuotaExceededError');
      return real.call(this, name, value);
    };
  }, unsentKey(world.tenantId, world.owner.uid));
  await page.getByLabel('Year built').fill('1962');
  await page.getByRole('button', { name: 'Save scope', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('alert')).toContainText('phone could not record');
  await expect(page.getByLabel('Year built')).toHaveValue('1962');
  expect((await readDraft(world)).field).not.toHaveProperty('yearBuilt');
});

test('an online-refreshed current-draft locator reopens the newer field draft offline', async ({ context, lane }) => {
  const world = await seedCompany();
  const phone = await signedIn(context, lane, world);
  const page = phone.page;
  const jobId = randomUUID();
  await openJob(page, lane, world, jobId);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // Unsaved inputs from the retired draft cannot become inputs on the new draft.
  await page.getByLabel('Year built').fill('1962');
  lane.cut();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByText(/No signal/)).toBeVisible();
  const nextDraftId = randomUUID();
  await adminDb().doc(`companies/${world.companyId}/drafts/${nextDraftId}`).set({
    fieldOwnerUid: world.owner.uid, state: 'editing', field: { yearBuilt: 2001 },
  });
  await firestoreJobProjectionStore(adminDb()).projectJob(world.companyId, jobId, { currentDraftId: nextDraftId, revision: 2 });
  // The slower SQL response still names the old draft; the newer server-owned locator wins.
  lane.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByLabel('Year built')).toHaveValue('2001');
  await page.reload();
  await expect(page.getByLabel('Year built')).toHaveValue('2001');
  lane.cut();
  await page.reload();
  await expect(page.getByLabel('Year built')).toHaveValue('2001');
  await expect(page.getByLabel('Year built')).toBeEditable();
});
