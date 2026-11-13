import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createUser, emailedLink, getUser } from './sign-in/emulator';
import { PASSWORD, readSeed, type ProjectSeed, type Seed } from './sign-in/seed';

// The company sign-in screens (S3-13) in Chromium and WebKit at phone width, signing in to the
// Firebase Auth emulator's tenants, with the dev server checking each sign-in through GET /api/me
// as it does in production. The seed (sign-in/global-setup.ts) makes two companies in two tenants.

const A = 'Company A Restoration';
const B = 'Company B Restoration';

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

async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// What GET /api/me answers to the next sign-in check.
function nextMeAnswer(page: Page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === '/api/me');
}

const uniqueEmail = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

test('a company sign-in page names its company and passes the accessibility check', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set your own password' })).toBeVisible();
  await expectAccessible(page);
});

test('an unknown sign-in link is not recognised', async ({ page, request }) => {
  const response = await page.goto('/sign-in/company-z');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This sign-in link is not recognised' })).toBeVisible();
  await expectAccessible(page);

  const unknown = await request.get('/api/sign-in/company-z');
  expect(unknown.status()).toBe(404);
  const known = await request.get('/api/sign-in/company-a');
  expect(await known.json()).toEqual({ company: { name: A }, tenantId: seed.tenantA });
});

test('a user of company A cannot sign in on company B’s page', async ({ page }) => {
  await page.goto('/sign-in/company-b');
  await signIn(page, mine.memberA.email, PASSWORD);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(`That email and password do not match a ${B} account.`);
  await expect(page.getByRole('heading', { name: `Sign in to ${B}` })).toBeVisible();

  // Company B's own member signs in there.
  await signIn(page, mine.memberB.email, PASSWORD);
  await expect(page.getByRole('heading', { name: `Signed in to ${B}` })).toBeVisible();

  // Signed in to A on the same phone, B's page still holds only B's sign-in, and A's only A's.
  await page.goto('/sign-in/company-a');
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await signIn(page, mine.memberA.email, PASSWORD);
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();
  await page.goto('/sign-in/company-b');
  await expect(page.getByRole('heading', { name: `Signed in to ${B}` })).toBeVisible();
});

test('signing out clears the session', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  const answer = nextMeAnswer(page);
  await signIn(page, mine.memberA.email, PASSWORD);
  expect((await answer).status()).toBe(200);
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();
  await expect(page.getByText('You are signed in as an estimator.')).toBeVisible();
  await expectAccessible(page);

  // The sign-in is kept on the phone across a reload.
  await page.reload();
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('You are signed out.');

  // Nothing of the sign-in is left: after a reload the page is signed out, and Firebase's store on
  // the phone holds no signed-in user.
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();
  const savedUsers = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('firebaseLocalStorageDb');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) return resolve([]);
          const keys = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAllKeys();
          keys.onsuccess = () => resolve(keys.result.map(String).filter((key) => key.startsWith('firebase:authUser:')));
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
  expect(savedUsers).toEqual([]);
});

test('a failed sign-out keeps the signed-in screen and the session', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.memberA.email, PASSWORD);
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();

  // The phone cannot remove the saved sign-in (its storage refuses the delete).
  await page.evaluate(() => {
    IDBObjectStore.prototype.delete = () => {
      throw new DOMException('Storage refused', 'UnknownError');
    };
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Sign-in did not work. Try again.');
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();
  await expect(page.getByText('You are signed out.')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();
});

// These tests stand in for the server's answer to GET /api/me with page.route. Since S6-3 the
// sign-in page installs the field service worker (scope /), which then controls later sign-in and
// team pages, and Playwright's WebKit cannot route a page a service worker controls. They cover
// server refusals, not the offline shell, so the worker is blocked for them only; the offline
// shell and its worker are tested in field-shell.spec.ts and tests/e2e/offline.
test.describe('with the field worker blocked', () => {
  test.use({ serviceWorkers: 'block' });

  test('a sign-in the phone cannot remove stays signed in when the server refuses it', async ({ page }) => {
    await page.goto('/sign-in/company-a');
    await signIn(page, mine.memberA.email, PASSWORD);
    await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();

    // The server now refuses the sign-in, and the phone's storage refuses to delete it.
    await page.route('**/api/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign_in_again' }) }),
    );
    await page.addInitScript(() => {
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (key) {
        if (String(key).startsWith('firebase:authUser:')) throw new DOMException('Storage refused', 'UnknownError');
        return remove.call(this, key);
      };
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'We could not check your sign-in' })).toBeVisible();

    // Trying again does not pretend the sign-in is gone.
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'We could not check your sign-in' })).toBeVisible();
    await expect(page.getByLabel('Password')).toHaveCount(0);
  });
});

// These tests stand in for the server's answer to GET /api/me with page.route. Since S6-3 the
// sign-in page installs the field service worker (scope /), which then controls later sign-in and
// team pages, and Playwright's WebKit cannot route a page a service worker controls. They cover
// server refusals, not the offline shell, so the worker is blocked for them only; the offline
// shell and its worker are tested in field-shell.spec.ts and tests/e2e/offline.
test.describe('with the field worker blocked', () => {
  test.use({ serviceWorkers: 'block' });

  test('a sign-in check that finishes after the sign-in ended is not shown', async ({ context, page }) => {
    await page.goto('/sign-in/company-a');
    await signIn(page, mine.memberA.email, PASSWORD);
    await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();

    // A second tab of company A whose sign-in check is held back.
    const other = await context.newPage();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen!: () => void;
    const requested = new Promise<void>((resolve) => (seen = resolve));
    await other.route('**/api/me', async (route) => {
      seen();
      await held;
      await route.continue();
    });
    await other.goto('/sign-in/company-a');
    await requested;
    await expect(other.getByText('Checking your sign-in…')).toBeVisible();

    // Signing out in the first tab ends the sign-in in the second, before its check answers.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
    await expect(other.getByLabel('Password')).toBeVisible();

    const answer = nextMeAnswer(other);
    release();
    expect((await answer).status()).toBe(200);
    await other.waitForTimeout(500);
    await expect(other.getByRole('heading', { name: `Signed in to ${A}` })).toHaveCount(0);
    await expect(other.getByLabel('Password')).toBeVisible();
  });
});

test('an unverified email cannot reach the app', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  const answer = nextMeAnswer(page);
  await signIn(page, mine.unverifiedA.email, PASSWORD);
  const refused = await answer;
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({ error: 'email_unverified' });
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Signed in/ })).toHaveCount(0);
  await expectAccessible(page);

  // Still refused after a reload, and "I have verified it" does not let an unverified account in.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  await page.getByRole('button', { name: 'I have verified it' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
});

test('verifying the email from the emailed link lets the member in', async ({ page, request }, testInfo) => {
  const account = mine.toVerifyA[testInfo.retry]!;
  await page.goto('/sign-in/company-a');
  await signIn(page, account.email, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();

  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('Link sent. Check your email.');
  const link = new URL(await emailedLink(seed.tenantA, account.email, 'VERIFY_EMAIL'));
  // The link comes back to this company's sign-in page.
  expect(link.searchParams.get('continueUrl')).toBe(page.url());
  expect(link.searchParams.get('tenantId')).toBe(seed.tenantA);
  const opened = await request.get(link.toString(), { maxRedirects: 0 });
  expect(opened.status()).toBe(303);
  expect((await getUser(seed.tenantA, account.uid)).emailVerified).toBe(true);

  await page.getByRole('button', { name: 'I have verified it' }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${A}` })).toBeVisible();
});

test('an account with no membership sees the invitation message', async ({ page }) => {
  const email = uniqueEmail('no-member');
  await createUser(seed.tenantA, { email, password: PASSWORD, emailVerified: true });
  await page.goto('/sign-in/company-a');
  const answer = nextMeAnswer(page);
  await signIn(page, email, PASSWORD);
  expect(await (await answer).json()).toEqual({ error: 'not_a_member' });
  await expect(page.getByRole('heading', { name: 'Accept a company invitation before using this app' })).toBeVisible();
  await expectAccessible(page);
});

test('an invited person sets their own password from the invitation link', async ({ page, request }) => {
  // As an invitation makes it (S3-10): no password, email not verified.
  const email = uniqueEmail('invitee');
  await createUser(seed.tenantA, { email });
  const invitation = `/sign-in/company-a/invitations/${randomUUID()}`;
  await page.goto(invitation);
  await expect(page.getByText(`You have been invited to ${A}.`)).toBeVisible();

  await page.getByRole('button', { name: 'Set your own password' }).click();
  await expect(page.getByRole('heading', { name: 'Set your own password' })).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  // The emailed link, opened with a new password, continues back to the invitation's sign-in page.
  const link = new URL(await emailedLink(seed.tenantA, email, 'PASSWORD_RESET'));
  expect(link.searchParams.get('tenantId')).toBe(seed.tenantA);
  link.searchParams.set('newPassword', 'a-password-only-they-know');
  const opened = await request.get(link.toString(), { maxRedirects: 0 });
  expect(opened.status()).toBe(303);
  const back = new URL(opened.headers()['location']!);
  expect(back.pathname).toBe(invitation);

  await page.goto(back.pathname);
  await signIn(page, email, 'a-password-only-they-know');
  await expect(page.getByRole('heading', { name: 'Accept a company invitation before using this app' })).toBeVisible();
});

test('asking to set a password for an unknown email says the same as for a known one', async ({ page }) => {
  await page.goto('/sign-in/company-a');
  await page.getByRole('button', { name: 'Set your own password' }).click();
  await page.getByLabel('Email').fill(uniqueEmail('nobody'));
  await page.getByRole('button', { name: 'Send the link' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expectAccessible(page);
});

// Firebase's pop-up sign-in loads Google's iframe script from apis.google.com, even against the
// emulator, so this one test needs the network; a lost script load loses the pop-up's result.
test.describe('Google', () => {
  test.describe.configure({ retries: 1 });

  test('Google sign-in signs in to the company’s own tenant', async ({ page }) => {
    await page.goto('/sign-in/company-a');
    const popupOpened = page.waitForEvent('popup');
    const answer = nextMeAnswer(page);
    await page.getByRole('button', { name: 'Sign in with Google' }).click();
    // The Auth emulator's stand-in for Google's account chooser.
    const popup = await popupOpened;
    // Its buttons work only once its own script has run.
    await popup.waitForLoadState('load');
    await expect(async () => {
      await popup.locator('#add-account-button').click({ timeout: 2_000 });
      await expect(popup.locator('#email-input')).toBeEditable({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await popup.locator('#email-input').fill(uniqueEmail('google'));
    await popup.locator('#display-name-input').fill('Google Person');
    await popup.locator('#sign-in').click();
    // A Google account new to company A's tenant is a verified account with no membership: the token
    // names company A's tenant (otherwise the server would answer unknown_tenant).
    expect(await (await answer).json()).toEqual({ error: 'not_a_member' });
    await expect(page.getByRole('heading', { name: 'Accept a company invitation before using this app' })).toBeVisible();
  });
});

test('the phone remembers the company sign-in link', async ({ page }) => {
  await page.goto('/sign-in/company-b');
  await expect(page.getByRole('heading', { name: `Sign in to ${B}` })).toBeVisible();
  await page.goto('/');
  await expect(page).toHaveURL(/\/sign-in\/company-b$/);
  await expect(page.getByRole('heading', { name: `Sign in to ${B}` })).toBeVisible();
});
