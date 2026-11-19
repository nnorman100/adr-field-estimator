import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakePlatform } from './operator/fake-platform';
import { PASSWORD, readSeed, type ProjectSeed, type Seed } from './sign-in/seed';

// The operator's read-only support view of a company's jobs (S5b-5) in Chromium and WebKit at phone
// width: reached from Manage company, it lists the company's jobs and opens one with its customer,
// claim, signed agreement and evidence. Nothing on it changes anything, each page is read once per
// opening, and an image is fetched only when asked for, because the server audits every read. As
// in operator.spec.ts, the operator signs in to the Auth emulator and the operator routes are played
// by FakePlatform at the network boundary with their real shapes and rules.

test.use({ viewport: { width: 390, height: 844 } });

let seed: Seed;
let mine: ProjectSeed;
test.beforeEach(({}, testInfo) => {
  seed = readSeed();
  mine = seed.projects[testInfo.project.name]!;
});

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function openAsOperator(page: Page, fake: FakePlatform) {
  await fake.install(page);
  await page.goto(`/operator/${seed.tenantOperators}`);
  await page.getByLabel('Email').fill(mine.operator.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// Only reads, and no field, switch or button that could change something.
async function expectReadOnly(page: Page, fake: FakePlatform, buttons: (string | RegExp)[]) {
  const main = page.getByRole('main');
  await expect(main.getByRole('textbox')).toHaveCount(0);
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await expect(main.getByRole('radio')).toHaveCount(0);
  await expect(main.getByRole('combobox')).toHaveCount(0);
  await expect(main.getByRole('button')).toHaveText(buttons);
  expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  // The screens fit a phone: no sideways scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('the operator opens a company’s jobs from Manage company, a page at a time, read-only', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await page.getByRole('link', { name: 'Open the jobs view' }).click();
  await expect(page.getByRole('heading', { name: 'Company A Restoration: jobs', level: 1 })).toBeVisible();
  await expect(page.getByText('Read-only support view.')).toBeVisible();
  await expect(page.getByText('ask the company’s owner')).toBeVisible();
  await expect(page.getByRole('link', { name: '12 Synthetic Way' })).toBeVisible();
  await expect(page.getByText('Pat Customer')).toBeVisible();
  await expect(page.getByText(/^Signed · started /)).toBeVisible();
  await expectAccessible(page);
  await expectReadOnly(page, fake, ['Sign out', 'Show more jobs']);
  // One read for opening the list.
  expect(fake.made('GET', /\/jobs$/)).toHaveLength(1);

  // The next page only when asked for; the archived job is listed too.
  await page.getByRole('button', { name: 'Show more jobs' }).click();
  await expect(page.getByRole('link', { name: '3 Archived Lane' })).toBeVisible();
  await expect(page.getByText(/^Archived · started /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more jobs' })).toHaveCount(0);
  expect(fake.made('GET', /\/jobs$/)).toHaveLength(2);
  expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('the operator opens a signed job with its customer, claim, agreement and evidence, an image only on request', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await page.getByRole('link', { name: 'Open the jobs view' }).click();
  await page.getByRole('link', { name: '12 Synthetic Way' }).click();

  await expect(page.getByRole('heading', { name: '12 Synthetic Way', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByRole('region', { name: 'Customer' })).toContainText('pat@example.com');
  await expect(main.getByRole('region', { name: 'Claim' })).toContainText('CLM-1');
  const agreement = main.getByRole('region', { name: 'Signed agreement' });
  await expect(agreement.getByText('Signed by Pat Customer')).toBeVisible();
  await expect(agreement.getByText('Signed on the technician\'s phone, presented by Eddie Estimator.')).toBeVisible();
  await expect(agreement.getByText('Price: $240.00', { exact: true })).toBeVisible();
  const evidence = main.getByRole('region', { name: 'Evidence' });
  await expect(evidence.getByText('Photo 1', { exact: true })).toBeVisible();
  await expect(evidence.getByText('Signature 2', { exact: true })).toBeVisible();
  await expectAccessible(page);
  await expectReadOnly(page, fake, ['Sign out', 'Show photo 1', 'Show signature 2']);
  // One read for opening the job, and no image fetched until one is asked for.
  expect(fake.made('GET', /\/jobs\/[^/]+$/)).toHaveLength(1);
  expect(fake.made('GET', /\/photos\//)).toEqual([]);

  await evidence.getByRole('button', { name: 'Show photo 1' }).click();
  await expect(evidence.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  const photos = fake.made('GET', /\/photos\//);
  expect(photos).toHaveLength(1);
  expect(photos[0]!.bearer).toBe(true);
  expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('a job of another company, or no job at all, is not shown', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  const companyC = fake.find('Company C Restoration');
  // Company A's job named under Company C's address: the server answers not found.
  await page.goto(`/operator/${seed.tenantOperators}/companies/${companyC.id}/jobs/${fake.detail!.job.id}`);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('That job was not found in this company.');
  await expect(page.getByText('Pat Customer')).toHaveCount(0);
  // An address that is not a job id never reaches the server.
  await page.goto(`/operator/${seed.tenantOperators}/companies/${companyC.id}/jobs/not-a-job`);
  await expect(page.getByRole('heading', { name: 'Job not found', level: 1 })).toBeVisible();
});
