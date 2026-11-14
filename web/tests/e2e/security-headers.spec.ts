import { expect, test, type Page } from '@playwright/test';
import { PASSWORD, readSeed } from './sign-in/seed';

// F7 of the S3 security review (src/lib/security-headers.ts) in Chromium and WebKit: the headers
// arrive on pages and API answers, and the full content policy, which is sent report-only, is not
// violated by the places the app really goes: the sign-in page, signing in (the Auth emulator
// stands in for Identity Platform), the field shell and Firestore. A violation here means the
// policy is missing something the app loads, so flipping it to enforced would break that screen.
test.use({ viewport: { width: 390, height: 844 } });

const COMMON = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
};

function expectHeaders(headers: Record<string, string>) {
  expect(headers).toMatchObject(COMMON);
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy-report-only']).toContain("default-src 'self'");
}

test('pages and API answers carry the security headers', async ({ page, request }) => {
  for (const path of ['/', '/field', '/sign-in/company-a', '/sign-in/company-z']) {
    const response = await page.goto(path);
    expectHeaders(response!.headers());
  }
  for (const [method, path] of [
    ['get', '/api/health'],
    ['get', '/api/me'], // refused with 401: an error answer carries them too
    ['post', '/api/client-errors'],
  ] as const) {
    const response = await request[method](path);
    expectHeaders(response.headers());
  }
  expectHeaders((await request.get('/sw.js')).headers());
});

test('the field worker keeps its own cache rule beside the security headers', async ({ request }) => {
  const response = await request.get('/sw.js');
  expect(response.headers()['cache-control']).toBe('no-cache, no-store, must-revalidate');
});

// Records every report-only violation in the page and its frames.
async function watchViolations(page: Page) {
  await page.addInitScript(() => {
    const seen: string[] = ((window as unknown as { __csp?: string[] }).__csp = []);
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber} ${event.sample}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

test('signing in and opening the field shell breaks no part of the full policy', async ({ page }, testInfo) => {
  const mine = readSeed().projects[testInfo.project.name]!;
  const violations = await watchViolations(page);

  await page.goto('/sign-in/company-a');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  expect(await violations()).toEqual([]);

  await page.getByLabel('Email').fill(mine.memberA.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Signed in to / })).toBeVisible();
  expect(await violations()).toEqual([]);

  await page.goto('/field');
  await expect(page.locator('main, [role="main"]').first()).toBeVisible();
  expect(await violations()).toEqual([]);
});
