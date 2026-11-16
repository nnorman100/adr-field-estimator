import { expect, test } from '@playwright/test';
import { observeCsp, expectReportOnly } from './csp-observer';
import { JOBS_BASE_URL } from './jobs/backend';
import { seedCompany } from './jobs/seed';
import { PASSWORD } from './sign-in/seed';

test.use({ baseURL: JOBS_BASE_URL, viewport: { width: 390, height: 844 } });

test('job creation, Firestore scope editing, customer and photo screens produce no CSP reports', async ({
  context,
  page,
}) => {
  const observer = await observeCsp(context);
  const company = await seedCompany('csp', { estimator: 'estimator' });
  await page.goto(`/sign-in/${company.address}`);
  await page.getByLabel('Email').fill(company.people.estimator!.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await page.getByRole('button', { name: 'Online only', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible();
  await expectReportOnly(page);
  await page.getByRole('main').getByRole('link', { name: 'New job' }).click();
  await page.getByLabel('Property address').fill('12 Example Street');
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByRole('heading', { name: '12 Example Street' })).toBeVisible();
  await page.getByLabel('New room name').fill('Kitchen');
  await page.getByRole('button', { name: 'Add room' }).click();
  await expect(page.getByRole('form', { name: 'Kitchen', exact: true })).toBeVisible();
  await page.getByLabel('Year built').fill('2000');
  await page.getByLabel('I checked this scope on site').check();
  await page.getByRole('button', { name: 'Save scope' }).click();
  await expect(page.getByRole('form', { name: 'Job scope' }).getByRole('status')).toHaveText(
    'Scope saved.',
  );
  await page.getByRole('main').getByRole('link', { name: 'Customer and claim' }).click();
  await expect(page.getByRole('form', { name: 'Customer', exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Photos' }).click();
  await expect(page.getByLabel('Take photo')).toBeAttached();
  await observer.expectClean(page);
});
