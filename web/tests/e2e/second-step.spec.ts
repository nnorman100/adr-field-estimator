import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { APP_CODE, SETUP_KEY, fakeSecondStep } from './second-step/fake-totp';
import { PASSWORD, readSeed, type ProjectSeed } from './sign-in/seed';

// The second-step screens (S3-14) in Chromium and WebKit at phone width: setting up an authenticator
// app with a QR code and a typed key, entering its code at sign-in, adding a spare, and the notice
// after a reset. The Auth emulator cannot do authenticator-app (TOTP) enrolment, so the Firebase
// client is replaced at its network boundary (second-step/fake-totp.ts) for the second step only;
// the password check and the dev server's /api/me check of every token are real. These are mock
// results: the real flow is proved on a `test` tenant in S3-18.

const A = 'Company A Restoration';

test.use({ viewport: { width: 390, height: 844 } });

let mine: ProjectSeed;
test.beforeEach(({}, testInfo) => {
  mine = readSeed().projects[testInfo.project.name]!;
});

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

// Nothing may be wider than the phone.
async function expectFitsPhone(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

const signedIn = (page: Page) => page.getByRole('heading', { name: `Signed in to ${A}` });
const setupHeading = (page: Page) =>
  page.getByRole('heading', { name: 'Set up your second sign-in step' });
const codeHeading = (page: Page) => page.getByRole('heading', { name: 'Enter your sign-in code' });
const alertIn = (page: Page) => page.getByRole('main').getByRole('alert');

// Which /api/me answers the page gets, as status and refusal code.
function watchMe(page: Page) {
  const answers: string[] = [];
  page.on('response', async (response) => {
    if (new URL(response.url()).pathname !== '/api/me') return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    answers.push(`${response.status()} ${body.error ?? 'ok'}`);
  });
  return answers;
}

// Firebase's saved sign-ins on the phone.
function savedSignIns(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('firebaseLocalStorageDb');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('firebaseLocalStorage')) return resolve([]);
          const keys = db
            .transaction('firebaseLocalStorage')
            .objectStore('firebaseLocalStorage')
            .getAllKeys();
          keys.onsuccess = () =>
            resolve(keys.result.map(String).filter((key) => key.startsWith('firebase:authUser:')));
          keys.onerror = () => reject(keys.error);
        };
      }),
  );
}

test('an owner with no second step can reach only the setup screen', async ({ page }) => {
  const fake = await fakeSecondStep(page);
  const answers = watchMe(page);
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);

  await expect(setupHeading(page)).toBeVisible();
  expect(answers).toEqual(['403 second_step_required']);
  // The way in is setting it up or signing out: no skip, no signed-in screen, no plain notice.
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button')).toHaveText([
    'Turn on second step',
    'Sign out',
  ]);
  await expect(page.getByRole('link')).toHaveText(['Open in my authenticator app']);
  await expect(page.getByText('Your second sign-in step was reset.')).toHaveCount(0);
  await expect(signedIn(page)).toHaveCount(0);
  await expectFitsPhone(page);
  await expectAccessible(page);

  // A reload does not skip it: the server still wants the second step.
  await page.reload();
  await expect(setupHeading(page)).toBeVisible();
  await expect(signedIn(page)).toHaveCount(0);
  expect(fake.factors).toEqual([]);

  // Signing out is the one other way off the screen.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  expect(await savedSignIns(page)).toEqual([]);
});

test('the QR code and the typed key hold the same setup key', async ({ page }) => {
  await fakeSecondStep(page);
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(setupHeading(page)).toBeVisible();

  await expect(page.getByTestId('setup-key')).toHaveText('JBSW Y3DP EHPK 3PXP');
  const uri = new URL(
    (await page.getByRole('link', { name: 'Open in my authenticator app' }).getAttribute('href'))!,
  );
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.hostname).toBe('totp');
  expect(uri.searchParams.get('secret')).toBe(SETUP_KEY);
  expect(uri.searchParams.get('issuer')).toBe(`DryScope ${A}`);
  expect(uri.searchParams.get('digits')).toBe('6');
  // The QR code is drawn from that address: a real picture, wide as the column, not off the screen.
  const box = (await page
    .getByRole('img', { name: 'QR code for your authenticator app' })
    .boundingBox())!;
  expect(box.width).toBeGreaterThan(150);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test('a wrong code at setup shows an error, turns nothing on and keeps the setup screen', async ({
  page,
}) => {
  const fake = await fakeSecondStep(page);
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(setupHeading(page)).toBeVisible();

  // Not six digits: said at once, with no call made.
  await page.getByLabel('6-digit code').fill('12 34');
  await page.getByRole('button', { name: 'Turn on second step' }).click();
  await expect(alertIn(page)).toHaveText('Enter the 6-digit code from your authenticator app.');
  expect(fake.calls).not.toContain('mfaEnrollment:finalize');

  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Turn on second step' }).click();
  await expect(alertIn(page)).toHaveText(
    'That code did not match. Wait for a new code in your authenticator app, then try again.',
  );
  await expect(setupHeading(page)).toBeVisible();
  await expect(signedIn(page)).toHaveCount(0);
  await expect(page.getByLabel('6-digit code')).toHaveValue('');
  expect(fake.factors).toEqual([]);
});

for (const carriesSecondFactor of [false, true]) {
  test(`setting up the first authenticator app ${
    carriesSecondFactor ? 'signs the owner in' : 'asks the owner to sign in again with its code'
  }`, async ({ page }) => {
    const fake = await fakeSecondStep(page, {
      enrolmentTokenCarriesSecondFactor: carriesSecondFactor,
    });
    await page.goto('/sign-in/company-a');
    await signIn(page, mine.ownerA.email);
    await expect(setupHeading(page)).toBeVisible();

    // The code is typed as the app shows it, in two groups.
    await page.getByLabel('6-digit code').fill(`${APP_CODE.slice(0, 3)} ${APP_CODE.slice(3)}`);
    await page.getByRole('button', { name: 'Turn on second step' }).click();
    expect(fake.calls).toContain('mfaEnrollment:finalize');
    expect(fake.factors.map((factor) => factor.name)).toEqual(['Authenticator app']);

    if (carriesSecondFactor) {
      await expect(signedIn(page)).toBeVisible();
      await expect(page.getByText('You are signed in as the owner.')).toBeVisible();
      return;
    }
    // The sign-in that set it up used no second step, so the server still asks for one: sign in
    // again, this time with the app's code.
    await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      'Your authenticator app is set up. Sign in again and enter its code.',
    );
    await signIn(page, mine.ownerA.email);
    await expect(codeHeading(page)).toBeVisible();
    await page.getByLabel('6-digit code').fill(APP_CODE);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(signedIn(page)).toBeVisible();
    await expect(page.getByText('You are signed in as the owner.')).toBeVisible();
  });
}

test('after setup, a failed check and Try again still ask the owner to sign in again with its code', async ({
  page,
}) => {
  await fakeSecondStep(page, { enrolmentTokenCarriesSecondFactor: false });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(setupHeading(page)).toBeVisible();

  await page.route('**/api/me', (route) => route.fulfill({ status: 503, body: '' }), { times: 1 });
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Turn on second step' }).click();
  await expect(
    page.getByRole('heading', { name: 'We could not check your sign-in' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    'Your authenticator app is set up. Sign in again and enter its code.',
  );
  await expect(setupHeading(page)).toHaveCount(0);
  await expect(page.getByText('Your second sign-in step was reset.')).toHaveCount(0);
});

test('a wrong code at sign-in shows an error and does not sign in', async ({ page }) => {
  const fake = await fakeSecondStep(page, { factors: ['Authenticator app'] });
  const answers = watchMe(page);
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(codeHeading(page)).toBeVisible();
  await expectFitsPhone(page);
  await expectAccessible(page);

  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(alertIn(page)).toHaveText(
    'That code did not match. Wait for a new code in your authenticator app, then try again.',
  );
  await expect(codeHeading(page)).toBeVisible();
  await expect(signedIn(page)).toHaveCount(0);
  // Nothing was signed in: the server was never asked about a token, and the phone saved no sign-in.
  expect(answers).toEqual([]);
  expect(await savedSignIns(page)).toEqual([]);
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();

  // The right code, from the start, signs in.
  await signIn(page, mine.ownerA.email);
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(signedIn(page)).toBeVisible();
  expect(answers).toEqual(['200 ok']);
  expect(fake.calls.filter((call) => call === 'mfaSignIn:finalize')).toHaveLength(2);
});

test('a code that is not six digits is refused on the phone without asking Firebase', async ({
  page,
}) => {
  const fake = await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await page.getByLabel('6-digit code').fill('12345');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(alertIn(page)).toHaveText('Enter the 6-digit code from your authenticator app.');
  expect(fake.calls).toEqual([]);
});

test('going back from the code screen returns to the sign-in form with nobody signed in', async ({
  page,
}) => {
  await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(codeHeading(page)).toBeVisible();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveValue('');
  expect(await savedSignIns(page)).toEqual([]);
});

test('a sign-in that timed out before the code goes back to the start', async ({ page }) => {
  const fake = await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(codeHeading(page)).toBeVisible();
  fake.expireNextSignIn = true;
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    'That sign-in timed out. Sign in again.',
  );
  expect(await savedSignIns(page)).toEqual([]);
});

test('a person with two authenticator apps chooses which one to use', async ({ page }) => {
  const fake = await fakeSecondStep(page, {
    factors: ['Authenticator app', 'Authenticator app 2'],
  });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(codeHeading(page)).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('radio', { name: 'Authenticator app', exact: true })).toBeChecked();
  await expectFitsPhone(page);
  await expectAccessible(page);

  await page.getByRole('radio', { name: 'Authenticator app 2' }).check();
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(signedIn(page)).toBeVisible();
  expect(fake.checkedFactors).toEqual([fake.factors[1]!.id]);
});

test('a signed-in person adds a second authenticator app', async ({ page }) => {
  const fake = await fakeSecondStep(page, {
    factors: ['Authenticator app'],
    enrolmentTokenCarriesSecondFactor: true,
  });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(signedIn(page)).toBeVisible();
  await expect(page.getByText('Second sign-in step: on, with 1 authenticator app.')).toBeVisible();
  await expectFitsPhone(page);
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add another authenticator app' }).click();
  await expect(page.getByRole('heading', { name: 'Add an authenticator app' })).toBeVisible();
  await expect(page.getByText('Your second sign-in step was reset.')).toHaveCount(0);
  await expect(page.getByTestId('setup-key')).toBeVisible();
  await expectFitsPhone(page);

  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Turn on second step' }).click();
  await expect(signedIn(page)).toBeVisible();
  await expect(page.getByText('Second sign-in step: on, with 2 authenticator apps.')).toBeVisible();
  expect(fake.factors.map((factor) => factor.name)).toEqual([
    'Authenticator app',
    'Authenticator app 2',
  ]);

  // Back leaves without adding anything.
  await page.getByRole('button', { name: 'Add another authenticator app' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(signedIn(page)).toBeVisible();
  expect(fake.factors).toHaveLength(2);
});

test('an estimator, who may turn the second step on, is offered it', async ({ page }) => {
  await fakeSecondStep(page, { enrolmentTokenCarriesSecondFactor: true });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.memberA.email);
  await expect(signedIn(page)).toBeVisible();
  await expect(page.getByText('Second sign-in step: off.')).toBeVisible();
  await page.getByRole('button', { name: 'Add an authenticator app' }).click();
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Turn on second step' }).click();
  await expect(page.getByText('Second sign-in step: on, with 1 authenticator app.')).toBeVisible();
});

test('after a reset the setup screen says so, and only on the phone that had a second step', async ({
  browser,
  page,
}) => {
  const fake = await fakeSecondStep(page, { factors: ['Authenticator app'] });
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await page.getByLabel('6-digit code').fill(APP_CODE);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(signedIn(page)).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();

  // An operator resets the owner's second step (owner decision D9); their next sign-in needs only
  // the password, and the server then wants the second step again.
  fake.reset();
  await signIn(page, mine.ownerA.email);
  await expect(setupHeading(page)).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    'Your second sign-in step was reset. Set it up again to continue. If you did not ask for this, tell DryScope support.',
  );
  await expect(signedIn(page)).toHaveCount(0);
  await expectFitsPhone(page);
  await expectAccessible(page);

  // Another phone has no memory of the old second step, so it shows the plain setup screen.
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const otherPage = await other.newPage();
  await fakeSecondStep(otherPage);
  await otherPage.goto('/sign-in/company-a');
  await signIn(otherPage, mine.ownerA.email);
  await expect(setupHeading(otherPage)).toBeVisible();
  await expect(otherPage.getByText('Your second sign-in step was reset.')).toHaveCount(0);
  await other.close();
});

test('setting up needs a newer sign-in when Firebase says the sign-in is too old', async ({
  page,
}) => {
  const fake = await fakeSecondStep(page);
  fake.setupFailsAsTooOld = true;
  await page.goto('/sign-in/company-a');
  await signIn(page, mine.ownerA.email);
  await expect(page.getByRole('heading', { name: `Sign in to ${A}` })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText(
    'For your safety, sign in again before changing your second step.',
  );
  expect(await savedSignIns(page)).toEqual([]);
});
