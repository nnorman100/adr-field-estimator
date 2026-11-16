import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { observeCsp, expectReportOnly } from './csp-observer';
import { PASSWORD, readSeed } from './sign-in/seed';

test.use({ viewport: { width: 390, height: 844 } });

test('sign-in and the field screen produce no CSP reports', async ({ context, page }, testInfo) => {
  const observer = await observeCsp(context);
  await page.goto('/sign-in/company-a');
  await expectReportOnly(page);
  await page.getByLabel('Email').fill(readSeed().projects[testInfo.project.name]!.memberA.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Signed in to Company A Restoration' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Open the field app' }).click();
  await expect(
    page.getByRole('heading', { name: 'Company A Restoration', exact: true }),
  ).toBeVisible();
  await expectReportOnly(page);
  await observer.expectClean(page);
});

test('Google popup sign-in produces no CSP reports in the app', async ({ context, page }) => {
  const observer = await observeCsp(context);
  await page.goto('/sign-in/company-a');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  const popup = await opened;
  await popup.waitForLoadState('load');
  await expect(async () => {
    await popup.locator('#add-account-button').click({ timeout: 2_000 });
    await expect(popup.locator('#email-input')).toBeEditable({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await popup.locator('#email-input').fill(`csp-${randomUUID()}@example.com`);
  await popup.locator('#display-name-input').fill('CSP Test');
  await popup.locator('#sign-in').click();
  await expect(
    page.getByRole('heading', { name: 'Accept a company invitation before using this app' }),
  ).toBeVisible();
  await observer.expectClean(page);
});

test('the browser observer catches a real report-only violation without blocking the request', async ({
  context,
  page,
}) => {
  const observer = await observeCsp(context);
  await page.goto('/sign-in/company-a');
  await observer.expectClean(page);
  // An intentional forbidden connection, answered locally; no external data or service involved.
  await page.route('https://csp-probe.invalid/probe', (route) =>
    route.fulfill({ body: 'ok', headers: { 'access-control-allow-origin': '*' } }),
  );
  expect(
    await page.evaluate(async () => (await fetch('https://csp-probe.invalid/probe')).text()),
  ).toBe('ok');
  await expect
    .poll(() =>
      observer.violations.some(
        (v) =>
          v.directive === 'connect-src' &&
          v.blocked.startsWith('https://csp-probe.invalid') &&
          v.disposition === 'report',
      ),
    )
    .toBe(true);
});
