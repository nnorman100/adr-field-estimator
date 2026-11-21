import { test as base, expect as baseExpect, type Browser, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { CLIENT_EPOCH, CLIENT_EPOCH_HEADER } from '../../src/lib/app-version';
import { hrefOf, type FieldView } from '../../src/lib/field/views';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { adminSql, currentDraftOf, seedCompany, storedJobs, storedPhotos, type Company, type Person } from './jobs/seed';
import { adminDb } from './offline/world';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD } from './sign-in/seed';

// The job screens (S5a-6) in Chromium and WebKit at phone width, against the second app server
// (tests/e2e/jobs/server.ts): a throwaway PostgreSQL behind the jobs and photo routes, the Auth and
// Firestore emulators, and the Storage emulator for photo bytes. The browser writes field data to
// the field database itself, under the real rules (web/firestore.rules). Each test seeds a company
// of its own, so the tests run side by side.

const test = base;
// No field worker: these tests drop answers with page.route, which WebKit does not apply to a
// request from a page the worker controls (Playwright's advice for interception). The worker's own
// behaviour is tested in tests/e2e/offline.
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const expect = baseExpect.configure({ timeout: 20_000 });

// A small PNG, as a phone's camera would hand the page a picture.
const PICTURE = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==',
    'base64',
  ),
};

// An office user (and an owner) needs the authenticator-app second step (D2; office since
// 2026-11-14), which the Auth emulator cannot do: it is answered at the network boundary
// (second-step/fake-totp.ts), with an authenticator app already set up.
const withAuthenticator = new WeakSet<Page>();

async function signIn(page: Page, company: Company, person: Person) {
  const secondStep = person.role !== 'estimator';
  if (secondStep && !withAuthenticator.has(page)) {
    await fakeSecondStep(page, { factors: ['Authenticator app'] });
    withAuthenticator.add(page);
  }
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

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const main = (page: Page) => page.getByRole('main');

// A photo really shown: an image with exactly this label whose bytes were fetched and decoded (the
// loading and not-available placeholders carry longer labels, and are not images).
async function expectPhoto(page: Page, label: string) {
  const image = page.getByRole('img', { name: label, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element) => (element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0)))
    .toBeGreaterThan(0);
}
const jobIdOf = (page: Page) => new URL(page.url()).searchParams.get('job')!;

// The server answers each matching request, and the answer is dropped on its way to the phone,
// until `lift`. `statuses` are what the server answered: proof it committed before the answer was lost.
async function dropAnswers(page: Page, url: string, method: string) {
  const dropped = { statuses: [] as number[], lifted: false, lift: () => {} };
  dropped.lift = () => {
    dropped.lifted = true;
  };
  await page.route(url, async (route) => {
    if (route.request().method() !== method || dropped.lifted) return route.fallback();
    dropped.statuses.push((await route.fetch()).status());
    await route.abort();
  });
  return dropped;
}

async function startJob(page: Page, address: string): Promise<string> {
  await main(page).getByRole('link', { name: 'New job' }).click();
  await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible();
  await page.getByLabel('Property address').fill(address);
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByRole('heading', { name: address })).toBeVisible();
  await expect(page.getByLabel('Year built')).toBeEditable();
  return jobIdOf(page);
}

async function addRoom(page: Page, name: string) {
  await page.getByLabel('New room name').fill(name);
  await page.getByRole('button', { name: 'Add room' }).click();
  await expect(page.getByRole('form', { name })).toBeVisible();
  // Shown on this phone first; the field database has it once the server acknowledges it.
  await expect(page.getByRole('form', { name: 'Add a room' }).getByRole('status')).toHaveText(`${name} added.`);
}

async function takePhoto(page: Page, room: string, shot: string) {
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await page.getByLabel('Room', { exact: true }).selectOption({ label: room });
  await page.getByLabel('Shot').selectOption({ label: shot });
  await page.getByLabel('Take photo').setInputFiles(PICTURE);
}

test('an estimator creates a job, adds two rooms and a photo, reloads and sees them', async ({ page }) => {
  const company = await seedCompany('create', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible();
  await expect(main(page).getByText('No jobs yet.')).toBeVisible();
  await expectNoAxeViolations(page);

  await main(page).getByRole('link', { name: 'New job' }).click();
  await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByLabel('Property address').fill('12 Example Street, Testville, CA 90000');
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByRole('heading', { name: '12 Example Street, Testville, CA 90000' })).toBeVisible();

  // Check Scope: year built, two rooms with areas and a category, equipment, notes, confirmed.
  await page.getByLabel('Year built').fill('1962');
  await addRoom(page, 'Kitchen');
  await addRoom(page, 'Hall');
  const kitchen = page.getByRole('form', { name: 'Kitchen' });
  await kitchen.getByLabel('Water category').selectOption('2');
  await kitchen.getByLabel('Floor area (sq ft)', { exact: true }).fill('120');
  await kitchen.getByRole('button', { name: 'Save room' }).click();
  await expect(kitchen.getByRole('status')).toHaveText('Room saved.');
  await page.getByLabel('Air movers').fill('4');
  await page.getByLabel('Labor hours').fill('2.5');
  await page.locator('#fact-notes').fill('Supply line under the sink.');
  await page.getByLabel('I checked this scope on site').check();
  await page.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('status')).toHaveText('Scope saved.');
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // Customer and claim, saved to the database through the jobs API.
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Pat Example');
  await page.getByLabel('Customer phone').fill('(555) 010-0100');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByRole('form', { name: 'Customer' }).getByRole('status')).toHaveText('Customer saved.');
  await page.getByLabel('Insurance carrier').fill('Example Mutual');
  await page.getByLabel('Claim number').fill('CLM-0001');
  await page.getByLabel('Date of loss').fill('2026-11-01');
  await page.getByRole('button', { name: 'Save claim' }).click();
  await expect(page.getByRole('form', { name: 'Claim' }).getByRole('status')).toHaveText('Claim saved.');
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // A photo of the kitchen's source of loss.
  const beforePhoto = Date.now();
  await takePhoto(page, 'Kitchen', 'Source of loss');
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();
  await expectPhoto(page, 'Photo 1, Kitchen, Source of loss');
  const draftId = await currentDraftOf(company.id, jobIdOf(page));
  const photos = await adminDb().collection(`companies/${company.id}/drafts/${draftId}/photos`).get();
  const capturedAt = photos.docs[0]!.data().field.capturedAt as string;
  expect(capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Date.parse(capturedAt)).toBeGreaterThanOrEqual(beforePhoto - 5000);
  expect(Date.parse(capturedAt)).toBeLessThanOrEqual(Date.now() + 5000);
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // Everything is still there after a reload, read back from the server and the field database.
  await page.reload();
  await expectPhoto(page, 'Photo 1, Kitchen, Source of loss');
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toHaveValue('1962');
  await expect(page.getByRole('list', { name: 'Rooms' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('form', { name: 'Kitchen' }).getByLabel('Floor area (sq ft)', { exact: true })).toHaveValue('120');
  await expect(page.getByRole('form', { name: 'Kitchen' }).getByLabel('Water category')).toHaveValue('2');
  await expect(page.getByRole('form', { name: 'Hall' })).toBeVisible();
  await expect(page.getByLabel('Air movers')).toHaveValue('4');
  await expect(page.getByLabel('Labor hours')).toHaveValue('2.5');
  await expect(page.getByLabel('I checked this scope on site')).toBeChecked();
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Customer name')).toHaveValue('Pat Example');
  await expect(page.getByLabel('Claim number')).toHaveValue('CLM-0001');
  await expect(page.getByLabel('Date of loss')).toHaveValue('2026-11-01');
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('link', { name: '12 Example Street, Testville, CA 90000' })).toBeVisible();
  await expect(main(page).getByText('Pat Example')).toBeVisible();
});

test('the field owner removes a room, and a reload keeps it removed', async ({ page }) => {
  const company = await seedCompany('remove', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '3 Removal Road');
  await addRoom(page, 'Den');
  await addRoom(page, 'Porch');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('form', { name: 'Den' }).getByRole('button', { name: 'Remove room' }).click();
  await expect(page.getByRole('form', { name: 'Den' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('form', { name: 'Porch' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Rooms' }).getByRole('listitem')).toHaveCount(1);
});

test('office sees the job read-only; another estimator and another company cannot open it', async ({ page, browser }) => {
  const company = await seedCompany('office', { estimator: 'estimator', office: 'office', other: 'estimator' });
  const otherCompany = await seedCompany('other', { stranger: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  const jobId = await startJob(page, '7 Office Lane');
  await addRoom(page, 'Bath');
  await takePhoto(page, 'Bath', 'Overview');
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();

  const office = await newPage(browser);
  await signIn(office, company, company.people.office!);
  await expect(office.getByRole('heading', { name: 'Company jobs' })).toBeVisible();
  await main(office).getByRole('link', { name: '7 Office Lane' }).click();
  await expect(office.getByText(/^Read only\./)).toBeVisible();
  await expect(office.getByLabel('Year built')).not.toBeEditable();
  await expect(office.getByRole('form', { name: 'Bath' }).getByLabel('Room name')).not.toBeEditable();
  await expect(office.getByRole('button', { name: 'Save scope' })).toHaveCount(0);
  await expect(office.getByRole('button', { name: 'Add room' })).toHaveCount(0);
  await expect(office.getByRole('button', { name: 'Remove room' })).toHaveCount(0);
  await expectNoAxeViolations(office);
  await main(office).getByRole('link', { name: 'Photos' }).click();
  await expectPhoto(office, 'Photo 1, Bath, Overview');
  await expect(office.getByLabel('Take photo')).toHaveCount(0);
  await expectNoAxeViolations(office);

  // Another estimator of the same company, and an estimator of another company, given the address.
  for (const [who, of] of [
    [company.people.other!, company],
    [otherCompany.people.stranger!, otherCompany],
  ] as const) {
    const stranger = await newPage(browser);
    await signIn(stranger, of, who);
    await expect(main(stranger).getByRole('link', { name: '7 Office Lane' })).toHaveCount(0);
    await stranger.goto(`/field?job=${jobId}&view=photos`);
    await expect(main(stranger).getByRole('alert')).toHaveText('This job is not in your list.');
    await expect(stranger.getByRole('img')).toHaveCount(0);
  }
});

test('an office user changed to estimator mid-visit loses the loaded job at the next refused photo', async ({ page, browser }) => {
  const company = await seedCompany('downgrade', { estimator: 'estimator', office: 'office' });
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '8 Downgrade Drive');
  await addRoom(page, 'Den');
  await takePhoto(page, 'Den', 'Overview');
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();

  const office = await newPage(browser);
  await signIn(office, company, company.people.office!);
  await main(office).getByRole('link', { name: '8 Downgrade Drive' }).click();
  await expect(office.getByRole('heading', { name: '8 Downgrade Drive' })).toBeVisible();
  await expect(office.getByLabel('Year built')).toBeVisible();

  // The office person becomes an estimator who does not own this job, in the database and in their
  // field database access record, while the job is open on Check Scope (Photos not opened yet).
  const officeUid = company.people.office!.uid;
  await adminSql()`
    UPDATE memberships SET role = 'estimator'
    WHERE company_id = ${company.id} AND actor_id = (SELECT id FROM actors WHERE company_id = ${company.id} AND uid = ${officeUid})
  `;
  await adminDb().doc(`companies/${company.id}/access/${officeUid}`).update({ role: 'estimator' });

  await main(office).getByRole('link', { name: 'Photos' }).click();
  await expect(main(office).getByRole('alert')).toHaveText('This job is not in your list.');
  await expect(office.getByRole('heading', { name: '8 Downgrade Drive' })).toHaveCount(0);
  await expect(office.getByLabel('Year built')).toHaveCount(0);
  await expect(office.getByRole('img')).toHaveCount(0);
});

test('a dropped response after the server committed leaves one job and one photo', async ({ page }) => {
  const company = await seedCompany('dropped', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);

  // The server makes the job, and its answer never reaches the phone. Every answer is dropped until
  // the test lifts the drop, as a browser may resend a request by itself after a network error.
  const committed = await dropAnswers(page, '**/api/jobs', 'POST');
  await main(page).getByRole('link', { name: 'New job' }).click();
  await page.getByLabel('Property address').fill('9 Lost Answer Way');
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(main(page).getByRole('alert')).toContainText('No answer from the server');
  expect(committed.statuses[0]).toBe(201);
  expect(await storedJobs(company.id)).toHaveLength(1);
  committed.lift();
  // A resend the browser made by itself met the request already made: the same answer, no second one.
  expect(committed.statuses.slice(1).every((status) => status === 200)).toBe(true);
  // Leaving the screen keeps the unanswered request: back on New job it is the same one.
  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await main(page).getByRole('link', { name: 'New job' }).click();
  await expect(page.getByLabel('Property address')).toHaveValue('9 Lost Answer Way');
  await expect(page.getByLabel('Property address')).not.toBeEditable();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: '9 Lost Answer Way' })).toBeVisible();
  const jobId = jobIdOf(page);
  expect(await storedJobs(company.id)).toEqual([{ id: jobId, propertyAddress: '9 Lost Answer Way' }]);

  // The same for a photo: the bytes are stored, the receipt is lost, the phone sends it again.
  await addRoom(page, 'Laundry');
  const received = await dropAnswers(page, '**/api/jobs/*/photos/*', 'PUT');
  const beforeFailedTake = Date.now();
  await takePhoto(page, 'Laundry', 'Moisture meter');
  const afterFailedTake = Date.now();
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
  expect(received.statuses[0]).toBe(201);
  expect(await storedPhotos(company.id, jobId)).toHaveLength(1);
  received.lift();
  // A resend the browser made by itself met the request already made: the same answer, no second one.
  expect(received.statuses.slice(1).every((status) => status === 200)).toBe(true);
  // Leaving the screen keeps the unsent photo and its "Send again".
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();
  const retriedPhotos = await adminDb().collection(`companies/${company.id}/drafts/${await currentDraftOf(company.id, jobId)}/photos`).get();
  const retriedCapturedAt = Date.parse(retriedPhotos.docs[0]!.data().field.capturedAt as string);
  expect(retriedCapturedAt).toBeGreaterThanOrEqual(beforeFailedTake - 5000);
  expect(retriedCapturedAt).toBeLessThanOrEqual(afterFailedTake + 5000);
  await page.reload();
  await expectPhoto(page, 'Photo 1, Laundry, Moisture meter');
  await expect(page.getByRole('list', { name: 'Job photos' }).getByRole('listitem')).toHaveCount(1);
  expect(await storedPhotos(company.id, jobId)).toHaveLength(1);

  // A customer save that the server made but whose answer was lost: the claim waits for it, and
  // sending it again is answered as made, not as a conflict.
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  const saved = await dropAnswers(page, '**/api/jobs/*/customer', 'PUT');
  await page.getByLabel('Customer name').fill('Lee Example');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByRole('form', { name: 'Customer' }).getByRole('alert')).toContainText('No answer from the server');
  expect(saved.statuses[0]).toBe(200);
  saved.lift();
  // A resend the browser made by itself met the request already made: the same answer, no second one.
  expect(saved.statuses.slice(1).every((status) => status === 200)).toBe(true);
  await expect(page.getByRole('button', { name: 'Save claim' })).toBeDisabled();
  await page.getByRole('form', { name: 'Customer' }).getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('form', { name: 'Customer' }).getByRole('status')).toHaveText('Customer saved.');
  await expect(page.getByRole('button', { name: 'Save claim' })).toBeEnabled();

  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('list', { name: 'My jobs' }).getByRole('listitem')).toHaveCount(1);
  await expect(main(page).getByText('Lee Example')).toBeVisible();
});

test('photos are downloaded only while Photos is open, and kept after', async ({ page }) => {
  const company = await seedCompany('lazy-photos', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '15 Quiet Lane');
  await addRoom(page, 'Utility');

  // The upload's answer is held until the person has moved on to Check Scope.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/jobs/*/photos/*', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const downloads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /^\/api\/jobs\/[^/]+\/photos\//.test(new URL(request.url()).pathname)) downloads.push(request.url());
  });

  await takePhoto(page, 'Utility', 'Overview');
  await expect(page.getByRole('status').filter({ hasText: 'Sending the photo…' })).toBeVisible();
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toBeVisible();
  release();
  // The photo is stored and in the job's photos, which are not on screen: nothing is downloaded.
  await expect(page.getByText('Job photos (1)')).toHaveCount(1);
  await expect(page.getByText('Saving its room and tag…')).toHaveCount(0);
  await page.waitForTimeout(1_000);
  expect(downloads).toEqual([]);

  // Opening Photos downloads and shows it; leaving and coming back keeps it without downloading again.
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await expectPhoto(page, 'Photo 1, Utility, Overview');
  const fetched = downloads.length;
  expect(fetched).toBeGreaterThan(0);
  await main(page).getByRole('link', { name: 'Check Scope' }).click();
  await expect(page.getByLabel('Year built')).toBeVisible();
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await expectPhoto(page, 'Photo 1, Utility, Overview');
  expect(downloads).toHaveLength(fetched);
});

// Holds each matching request before it reaches the server, until `release`: the server has not
// made the change while the test does something else.
async function holdRequests(page: Page, url: string, method: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.fallback();
    await held;
    await route.fulfill({ response: await route.fetch() });
  });
  return { release };
}

test('a save and a photo that settle after the job is left and reopened land on the reopened screen', async ({ page }) => {
  const company = await seedCompany('late', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  await startJob(page, '17 Late Answer Lane');
  await addRoom(page, 'Garage');
  const reopen = async () => {
    await main(page).getByRole('link', { name: 'Back to jobs' }).click();
    await main(page).getByRole('link', { name: '17 Late Answer Lane' }).click();
    await expect(page.getByLabel('Year built')).toBeVisible();
  };

  // A customer save the server makes only after the job was left and opened again.
  const customer = await holdRequests(page, '**/api/jobs/*/customer', 'PUT');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await page.getByLabel('Customer name').fill('Robin Late');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await reopen();
  customer.release();
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByRole('button', { name: 'Save customer' })).toBeEnabled();
  await expect(page.getByLabel('Customer name')).toHaveValue('Robin Late');

  // A photo the server stores only after the job was left and opened again.
  const photo = await holdRequests(page, '**/api/jobs/*/photos/*', 'PUT');
  await takePhoto(page, 'Garage', 'Overview');
  await expect(page.getByText('Sending the photo…')).toBeVisible();
  await reopen();
  photo.release();
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();
  await expectPhoto(page, 'Photo 1, Garage, Overview');
});

test('every field view passes axe', async ({ page }) => {
  const company = await seedCompany('axe', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  const jobId = await startJob(page, '5 Checked Court');
  // One entry per view of src/lib/field/views.ts: a view missing here does not compile.
  const views: Record<FieldView, (page: Page) => Locator> = {
    jobs: (p) => p.getByRole('heading', { name: 'My jobs' }),
    'new-job': (p) => p.getByRole('heading', { name: 'New job' }),
    scope: (p) => p.getByLabel('Year built'),
    customer: (p) => p.getByLabel('Customer name'),
    photos: (p) => p.getByRole('heading', { name: /^Job photos/ }),
    // An estimator is told the office and the owner keep it; office and owner see it in office-jobs.spec.ts.
    coordination: (p) => p.getByText('Job coordination is kept by the office and the company owner.'),
  };
  for (const [view, ready] of Object.entries(views) as [FieldView, (page: Page) => Locator][]) {
    const place = view === 'jobs' ? { view, list: null } : view === 'new-job' ? { view } : { view, jobId };
    await page.goto(hrefOf(place));
    await expect(ready(page), view).toBeVisible();
    await expectNoSideways(page);
    await expectNoAxeViolations(page);
  }
});

test("a save that meets someone else's change keeps their change", async ({ page, request }) => {
  const company = await seedCompany('stale', { estimator: 'estimator', office: 'office' });
  await signIn(page, company, company.people.estimator!);
  const jobId = await startJob(page, '11 Shared Street');
  await main(page).getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByLabel('Claim number')).toHaveValue('');

  // Meanwhile the office saves the claim from another device.
  const office = company.people.office!;
  const headers = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(company.tenantId, office.email, PASSWORD))}`, [CLIENT_EPOCH_HEADER]: String(CLIENT_EPOCH) };
  const read = await request.get(`${JOBS_BASE_URL}/api/jobs/${jobId}`, { headers });
  const { job, claim } = await read.json();
  const saved = await request.put(`${JOBS_BASE_URL}/api/jobs/${jobId}/claim`, {
    headers,
    data: { ...claim, claimNumber: 'OFFICE-1', revision: job.revision, changeId: randomUUID() },
  });
  expect(saved.status()).toBe(200);

  // The estimator's customer save meets the newer job, shows the office's claim, and saves again.
  await page.getByLabel('Customer name').fill('Sam Example');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByRole('form', { name: 'Customer' }).getByRole('alert')).toContainText('Someone else changed this job');
  await expect(page.getByLabel('Claim number')).toHaveValue('OFFICE-1');
  await expect(page.getByLabel('Customer name')).toHaveValue('Sam Example');
  await page.getByRole('button', { name: 'Save customer' }).click();
  await expect(page.getByRole('form', { name: 'Customer' }).getByRole('status')).toHaveText('Customer saved.');
  // Saving the untouched claim form writes the office's value back, not the old empty one.
  await page.getByRole('button', { name: 'Save claim' }).click();
  await expect(page.getByRole('form', { name: 'Claim' }).getByRole('status')).toHaveText('Claim saved.');
  const after = await (await request.get(`${JOBS_BASE_URL}/api/jobs/${jobId}`, { headers })).json();
  expect(after.claim.claimNumber).toBe('OFFICE-1');
  expect(after.customer.name).toBe('Sam Example');
});

test('a stored room the field map does not accept shows the load error, not empty work', async ({ page }) => {
  const company = await seedCompany('invalid', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  const jobId = await startJob(page, '13 Broken Room Row');
  await addRoom(page, 'Attic');
  const draftId = await currentDraftOf(company.id, jobIdOf(page));
  const rooms = await adminDb().collection(`companies/${company.id}/drafts/${draftId}/rooms`).get();
  expect(rooms.size).toBe(1);
  // Written past the rules, as only a server or a bug could: a room name that is not text.
  await rooms.docs[0]!.ref.update({ 'field.name': 42 });
  await page.reload();
  await expect(main(page).getByRole('alert')).toContainText('cannot read');
  await expect(page.getByRole('list', { name: 'Rooms' })).toHaveCount(0);
  await expect(page.getByLabel('Year built')).toHaveCount(0);
});

test('the phone takes the photo that fills a job to its cap, then stops offering Take photo and says why', async ({ page }) => {
  const company = await seedCompany('photo-cap', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);
  const jobId = await startJob(page, '17 Full Album Lane');
  const draftId = await currentDraftOf(company.id, jobId);
  // One short of the cap, written past the rules. The route holds none of their bytes, so their
  // downloads are dropped here: a missing thumbnail is not what this test is about.
  const batch = adminDb().batch();
  for (let i = 0; i < 299; i++) batch.set(adminDb().doc(`companies/${company.id}/drafts/${draftId}/photos/${randomUUID()}`), { field: {} });
  await batch.commit();
  await page.route('**/api/jobs/*/photos/*', (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()));
  await page.reload();
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await expect(page.getByRole('heading', { name: 'Job photos (299)' })).toBeVisible();
  const camera = page.getByLabel('Take photo');
  const reason = 'This job has the most photos it can hold (300).';
  await expect(camera).toBeEnabled();
  await expect(page.getByText(reason)).toHaveCount(0);

  // The three hundredth photo is taken, stored and listed.
  await camera.setInputFiles(PICTURE);
  await expect(page.getByRole('heading', { name: 'Job photos (300)' })).toBeVisible();
  expect(await storedPhotos(company.id, jobId)).toHaveLength(1);
  await expect(camera).toBeDisabled();
  await expect(camera).toHaveAccessibleDescription(reason);
  await expect(page.getByText(reason)).toBeVisible();
  await expectNoSideways(page);
});
