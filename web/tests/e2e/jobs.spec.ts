import { test as base, expect as baseExpect, type Browser, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './a11y';
import { JOBS_BASE_URL } from './jobs/backend';
import { seedCompany, storedJobs, storedPhotos, type Company, type Person } from './jobs/seed';
import { PASSWORD } from './sign-in/seed';

// The job screens (S5a-6) in Chromium and WebKit at phone width, against the second app server
// (tests/e2e/jobs/server.ts): a throwaway PostgreSQL behind the jobs and photo routes, the Auth and
// Firestore emulators, and the Storage emulator for photo bytes. The browser writes field data to
// the field database itself, under the real rules (web/firestore.rules). Each test seeds a company
// of its own, so the tests run side by side.

const test = base;
test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 } });
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

async function signIn(page: Page, company: Company, person: Person) {
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(person.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${company.name}` })).toBeVisible();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 } });
  return context.newPage();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const main = (page: Page) => page.getByRole('main');
const jobIdOf = (page: Page) => new URL(page.url()).searchParams.get('job')!;

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
}

async function takePhoto(page: Page, room: string, shot: string) {
  await main(page).getByRole('link', { name: 'Photos' }).click();
  await page.getByLabel('Room').selectOption({ label: room });
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
  await takePhoto(page, 'Kitchen', 'Source of loss');
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Photo 1, Kitchen, Source of loss' })).toBeVisible();
  await expectNoSideways(page);
  await expectNoAxeViolations(page);

  // Everything is still there after a reload, read back from the server and the field database.
  await page.reload();
  await expect(page.getByRole('img', { name: 'Photo 1, Kitchen, Source of loss' })).toBeVisible();
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
  await expect(office.getByRole('img', { name: 'Photo 1, Bath, Overview' })).toBeVisible();
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

test('a dropped response after the server committed leaves one job and one photo', async ({ page }) => {
  const company = await seedCompany('dropped', { estimator: 'estimator' });
  await signIn(page, company, company.people.estimator!);

  // The server makes the job, and its answer never reaches the phone.
  const committed: number[] = [];
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'POST' || committed.length > 0) return route.fallback();
    committed.push((await route.fetch()).status());
    await route.abort();
  });
  await main(page).getByRole('link', { name: 'New job' }).click();
  await page.getByLabel('Property address').fill('9 Lost Answer Way');
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(main(page).getByRole('alert')).toContainText('No answer from the server');
  expect(committed).toEqual([201]);
  expect(await storedJobs(company.id)).toHaveLength(1);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: '9 Lost Answer Way' })).toBeVisible();
  const jobId = jobIdOf(page);
  expect(await storedJobs(company.id)).toEqual([{ id: jobId, propertyAddress: '9 Lost Answer Way' }]);

  // The same for a photo: the bytes are stored, the receipt is lost, the phone sends it again.
  await addRoom(page, 'Laundry');
  const received: number[] = [];
  await page.route('**/api/jobs/*/photos/*', async (route) => {
    if (route.request().method() !== 'PUT' || received.length > 0) return route.fallback();
    received.push((await route.fetch()).status());
    await route.abort();
  });
  await takePhoto(page, 'Laundry', 'Moisture meter');
  await expect(page.getByRole('button', { name: 'Send again' })).toBeVisible();
  expect(received).toEqual([201]);
  expect(await storedPhotos(company.id, jobId)).toHaveLength(1);
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('heading', { name: 'Job photos (1)' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('img', { name: 'Photo 1, Laundry, Moisture meter' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Job photos' }).getByRole('listitem')).toHaveCount(1);
  expect(await storedPhotos(company.id, jobId)).toHaveLength(1);

  await main(page).getByRole('link', { name: 'Back to jobs' }).click();
  await expect(main(page).getByRole('list', { name: 'My jobs' }).getByRole('listitem')).toHaveCount(1);
});
