import { expect as baseExpect, test, type Page, type Request } from '@playwright/test';
import { expectNoAxeViolations } from './a11y';
import { APP_CHECK_BASE_URL, appCheckLines } from './app-check/server';
import { PASSWORD, readSeed, type TeamSeed } from './sign-in/seed';

// App Check in monitor mode (docs/plans/TC.md, TC-5), in Chromium and WebKit at phone width, on
// the App Check test server (app-check/server.ts): the same emulators and sign-in file as the main
// server, with App Check set up. Nothing reaches Google: the token exchange and the reCAPTCHA
// script are stood in for with page.route.
//
// What it proves: each /api call carries the X-Firebase-AppCheck header and the server records the
// outcome; with a reCAPTCHA that never answers, sign-in and every screen still work and their calls
// go out without a token; and the sign-in page with Google's reCAPTCHA notice passes axe.

test.use({ baseURL: APP_CHECK_BASE_URL, viewport: { width: 390, height: 844 } });

const expect = baseExpect.configure({ timeout: 20_000 });

// The token the stand-in exchange hands out. Not a real App Check token, so the server records it
// as invalid, which proves it arrived and was checked.
const STAND_IN_TOKEN = 'e2e-stand-in-app-check-token';

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

const RECAPTCHA_SCRIPT = /^https:\/\/www\.google\.com\/recaptcha\//;
const APP_CHECK_EXCHANGE = /^https:\/\/content-firebaseappcheck\.googleapis\.com\//;

// The App Check header of every /api call the page makes, by path ('' when none was sent).
function apiCalls(page: Page): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== APP_CHECK_BASE_URL || !url.pathname.startsWith('/api/')) return;
    const header = request.headers()['x-firebase-appcheck'] ?? '';
    calls.set(url.pathname, [...(calls.get(url.pathname) ?? []), header]);
  });
  return calls;
}

// The page may still be loading the stalled reCAPTCHA script, so navigation waits only for the
// document, not the load event.
async function signIn(page: Page) {
  await page.goto(`/sign-in/${team.address}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill(team.owner.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

const lineFor = (route: string, outcome: string) =>
  appCheckLines().find((line) => line.route === route && line.outcome === outcome && line.status === 200);

test('every /api call carries the App Check token, and the server records it', async ({ page }) => {
  // The debug provider (allowed on localhost only) with a stand-in exchange.
  await page.addInitScript(() => {
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: string }).FIREBASE_APPCHECK_DEBUG_TOKEN = 'e2e-debug-token';
  });
  await page.route(RECAPTCHA_SCRIPT, (route) => route.abort());
  await page.route(APP_CHECK_EXCHANGE, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: STAND_IN_TOKEN, ttl: '3600s' }) }),
  );
  const calls = apiCalls(page);

  await signIn(page);
  await page.getByRole('link', { name: 'Team and invitations' }).click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();

  const sent = [...calls.entries()];
  expect(sent.map(([path]) => path)).toContain('/api/me');
  expect(sent.length).toBeGreaterThan(1);
  for (const [path, headers] of sent) expect(headers, path).toEqual(headers.map(() => STAND_IN_TOKEN));
  await expect.poll(() => lineFor('/api/me', 'invalid')).toMatchObject({ method: 'GET', route: '/api/me', status: 200 });
  // The line never holds the token.
  expect(JSON.stringify(appCheckLines())).not.toContain(STAND_IN_TOKEN);
});

test('with a reCAPTCHA that never answers, sign-in and every screen still work', async ({ page }) => {
  // No debug token: the reCAPTCHA Enterprise provider waits for Google's script, which never comes.
  await page.route(RECAPTCHA_SCRIPT, () => new Promise<void>(() => {}));
  let exchanges = 0;
  await page.route(APP_CHECK_EXCHANGE, (route) => {
    exchanges += 1;
    return route.abort();
  });
  const calls = apiCalls(page);

  // Firebase Auth waits for App Check before each request; without the bound, sign-in would hang
  // for Auth's own 30-second timeout and fail, well past this test's 20-second wait.
  await signIn(page);
  await page.getByRole('link', { name: 'Team and invitations' }).click();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: team.owner.name })).toContainText('Owner');
  await page.goto(`/sign-in/${team.address}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
  await page.getByRole('link', { name: 'Company settings' }).click();
  await expect(page.getByRole('heading', { name: 'Company settings' })).toBeVisible();
  await expect(page.getByLabel('Company address')).toBeVisible();

  const sent = [...calls.entries()];
  expect(sent.map(([path]) => path)).toContain('/api/me');
  for (const [path, headers] of sent) expect(headers, path).toEqual(headers.map(() => ''));
  expect(exchanges).toBe(0);
  await expect.poll(() => lineFor('/api/me', 'missing')).toBeTruthy();
});

test('the sign-in page shows Google’s reCAPTCHA notice and passes axe', async ({ page }) => {
  await page.route(RECAPTCHA_SCRIPT, (route) => route.abort());
  await page.goto(`/sign-in/${team.address}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('This site is protected by reCAPTCHA.', { exact: true })).toBeVisible();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(sideways).toBeLessThanOrEqual(0);
  await expectNoAxeViolations(page);
});
