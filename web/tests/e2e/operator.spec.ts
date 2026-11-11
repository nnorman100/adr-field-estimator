import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { FakePlatform } from './operator/fake-platform';
import { PASSWORD, readSeed, type ProjectSeed, type Seed } from './sign-in/seed';

// The platform operator's screens (S3-15) in Chromium and WebKit at phone width. An operator signs
// in to the operator tenant of the Auth emulator and the dev server checks that sign-in through the
// real operator route (the emulator has no authenticator-app second step, so that check refuses an
// operator, which is tested as it is). The data the screens show comes from FakePlatform, which
// plays the operator routes at the network boundary with their real shapes and rules.

test.use({ viewport: { width: 390, height: 844 } });

let seed: Seed;
let mine: ProjectSeed;
test.beforeEach(({}, testInfo) => {
  seed = readSeed();
  mine = seed.projects[testInfo.project.name]!;
});

const operatorUrl = (path = '') => `/operator/${seed.tenantOperators}${path}`;

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function signIn(page: Page, email: string) {
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

// Opens an operator page signed in as the operator, with the operator routes played by `fake`.
async function openAsOperator(page: Page, fake: FakePlatform, path = '') {
  await fake.install(page);
  await page.goto(operatorUrl(path));
  await signIn(page, mine.operator.email);
}

test('the operator sign-in page names itself and passes the accessibility check', async ({ page }) => {
  await page.goto(operatorUrl());
  await expect(page.getByRole('heading', { name: 'Platform operator sign-in' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible();
  await expectAccessible(page);
});

test('an address that is not a tenant id is not found', async ({ page }) => {
  const response = await page.goto('/operator/not%20a%20tenant');
  expect(response?.status()).toBe(404);
});

test('a company owner cannot open the operator screens', async ({ page }) => {
  // The owner's own company tenant in the address: Firebase signs them in, the real operator route
  // refuses them, and the phone drops the sign-in.
  await page.goto(`/operator/${seed.tenantA}`);
  const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/platform/companies');
  await signIn(page, mine.ownerA.email);
  const response = await refused;
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'not_an_operator' });
  await expect(page.getByRole('main').getByRole('status')).toHaveText('This account is not a platform operator.');
  await expect(page.getByRole('heading', { name: 'Platform operator sign-in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Companies' })).toHaveCount(0);

  // Nothing of the sign-in is kept: after a reload the page is signed out.
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();

  // On the operator tenant itself, the owner has no account at all.
  await page.goto(operatorUrl());
  await signIn(page, mine.ownerA.email);
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('That email and password do not match a platform operator account.');
});

test('an operator with no second step sees only the second-step message', async ({ page }) => {
  await page.goto(operatorUrl());
  const answered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/platform/companies');
  await signIn(page, mine.operator.email);
  const response = await answered;
  expect(response.status()).toBe(403);
  expect(await response.json()).toEqual({ error: 'second_step_required' });
  await expect(page.getByRole('heading', { name: 'Set up your second sign-in step' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Companies' })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Platform operator sign-in' })).toBeVisible();
});

test('lists the companies and creates one', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await expect(page.getByText('Company A Restoration')).toBeVisible();
  await expect(page.getByText('Active · Sign-in address: company-a · Sign-in tenant: set')).toBeVisible();
  await expect(page.getByText('Active · Sign-in address: company-c · Sign-in tenant: not set yet')).toBeVisible();
  expect(fake.calls.every((call) => call.bearer)).toBe(true);
  await expectAccessible(page);

  // A bad address never reaches the server.
  await page.getByLabel('Company name').fill('Company D Restoration');
  await page.getByLabel('Sign-in address').fill('Company D');
  await page.getByRole('button', { name: 'Add company' }).click();
  await expect(page.getByRole('main').getByRole('alert').filter({ hasText: 'lowercase letters' })).toBeVisible();
  expect(fake.made('POST', /companies$/)).toHaveLength(0);

  // An address another company uses is refused by the server.
  await page.getByLabel('Sign-in address').fill('company-a');
  await page.getByRole('button', { name: 'Add company' }).click();
  await expect(page.getByRole('main').getByRole('alert').filter({ hasText: 'Another company already uses' })).toBeVisible();

  await page.getByLabel('Sign-in address').fill('company-d');
  await page.getByRole('button', { name: 'Add company' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Company D Restoration was created.' })).toBeVisible();
  await expect(page.getByText('Active · Sign-in address: company-d · Sign-in tenant: not set yet')).toBeVisible();
  expect(fake.made('POST', /companies$/).at(-1)?.body).toEqual({ name: 'Company D Restoration', signInSlug: 'company-d' });
  await expect(page.getByLabel('Company name')).toHaveValue('');
});

test('offers archive only for a suspended company', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await expect(page.getByRole('heading', { name: 'Company A Restoration', level: 1 })).toBeVisible();
  await expectAccessible(page);

  // Active: suspend is offered, archive and reactivate are not.
  await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Reactivate' })).toHaveCount(0);

  // Suspending asks first, and changes nothing until confirmed.
  await page.getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByText('Suspending turns off sign-in and field access')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(fake.made('POST', /status$/)).toHaveLength(0);
  await page.getByRole('button', { name: 'Suspend' }).click();
  await page.getByRole('button', { name: 'Confirm suspend' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Company A Restoration is now suspended.' })).toBeVisible();
  expect(fake.made('POST', /status$/).at(-1)?.body).toEqual({ status: 'suspended' });

  // Suspended: now archive is offered, beside reactivate.
  await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reactivate' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Confirm archive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Company A Restoration is now archived.' })).toBeVisible();
  expect(fake.made('POST', /status$/).at(-1)?.body).toEqual({ status: 'archived' });

  // Archived: only reactivate.
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reactivate' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Company A Restoration is now active.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend' })).toBeVisible();
});

test('opening a company page directly reads the list first and shows only that company', async ({ page }) => {
  const fake = new FakePlatform();
  await fake.install(page);
  const company = fake.find('Company C Restoration');
  await page.goto(operatorUrl(`/companies/${company.id}`));
  await signIn(page, mine.operator.email);
  await expect(page.getByRole('heading', { name: 'Company C Restoration', level: 1 })).toBeVisible();
  await expect(page.getByText('Company A Restoration')).toHaveCount(0);

  await page.goto(operatorUrl('/companies/00000000-0000-4000-8000-000000000000'));
  await expect(page.getByRole('heading', { name: 'Company not found' })).toBeVisible();
});

test('invites the first owner, replaces the owner, and gives the link to copy', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);

  // A company with no sign-in tenant yet has no owner form.
  await page.getByRole('link', { name: 'Manage Company C Restoration' }).click();
  await expect(page.getByText('This company has no sign-in tenant yet, so an owner cannot be invited.')).toBeVisible();
  await expect(page.getByLabel('New owner’s email')).toHaveCount(0);

  await page.getByRole('link', { name: 'Companies', exact: true }).click();
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await page.getByLabel('New owner’s email').fill('first@example.com');
  await page.getByRole('button', { name: 'Invite owner' }).click();
  await expect(page.getByLabel('Invitation link')).toHaveValue(/\/sign-in\/company-a\/invitations\/[0-9a-f-]{36}$/);
  await expect(page.getByLabel('Invitation link')).toHaveValue(/^http:\/\/localhost:3100\//);
  await expect(page.getByText('No email is sent yet. Send this link to first@example.com yourself')).toBeVisible();
  expect(fake.made('POST', /owner$/).at(-1)?.body).toEqual({ email: 'first@example.com', replace: false });

  // Replacing needs the operator to say they understand the old owner is signed out.
  await page.getByLabel('Replace the owner').check();
  await page.getByLabel('New owner’s email').fill('second@example.com');
  await page.getByRole('button', { name: 'Replace owner' }).click();
  expect(fake.made('POST', /owner$/)).toHaveLength(1);
  await page.getByLabel('I understand the current owner is turned off').check();
  await page.getByRole('button', { name: 'Replace owner' }).click();
  await expect(page.getByText('The previous owner is turned off and signed out.')).toBeVisible();
  expect(fake.made('POST', /owner$/).at(-1)?.body).toEqual({ email: 'second@example.com', replace: true });
  await expectAccessible(page);
});

test('resets a second step only after the operator confirms by phone', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();

  // Opening the company page reads no team; choosing a person does, once.
  expect(fake.made('GET', /team$/)).toHaveLength(0);
  await page.getByRole('button', { name: 'Choose a person' }).click();
  await expect(page.getByText('Olivia Owner (olivia@example.com)')).toBeVisible();
  expect(fake.made('GET', /team$/)).toHaveLength(1);

  await page.getByRole('button', { name: 'Reset second step for Olivia Owner (olivia@example.com)' }).click();
  await page.getByRole('button', { name: 'Reset second step', exact: true }).click();
  expect(fake.made('POST', /reset-second-step$/)).toHaveLength(0);
  await page.getByLabel('I confirmed by phone that this is Olivia Owner.').check();
  await page.getByRole('button', { name: 'Reset second step', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'tell them by phone' })).toBeVisible();
  const reset = fake.made('POST', /reset-second-step$/);
  expect(reset).toHaveLength(1);
  expect(reset[0]!.body).toEqual({ confirmedBy: 'phone' });
  expect(reset[0]!.path).toBe(`/api/platform/companies/${fake.find('Company A Restoration').id}/members/${fake.members[0]!.membershipId}/reset-second-step`);
  await expectAccessible(page);
});

test('asks for a new sign-in when a team change needs a fresh one', async ({ page }) => {
  const fake = new FakePlatform();
  fake.stale = true;
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await page.getByLabel('New owner’s email').fill('first@example.com');
  await page.getByRole('button', { name: 'Invite owner' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('For that change, sign in again.');
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page.getByRole('heading', { name: 'Platform operator sign-in' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('For that change, sign in again.');
});

test('the support view of a team is read-only', async ({ page }) => {
  const fake = new FakePlatform();
  fake.invitations = [
    { id: '7a3c5e1f-2b4d-4f6a-8c9e-0d1f2a3b4c5d', email: 'pending@example.com', role: 'estimator', status: 'pending', expiresAt: new Date().toISOString(), createdAt: new Date().toISOString() },
  ];
  await openAsOperator(page, fake);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await page.getByRole('link', { name: 'Open the team view' }).click();
  await expect(page.getByRole('heading', { name: 'Company A Restoration: team' })).toBeVisible();
  await expect(page.getByText('Olivia Owner')).toBeVisible();
  await expect(page.getByText('eddie@example.com')).toBeVisible();
  await expect(page.getByText('pending@example.com')).toBeVisible();
  await expect(page.getByText('Read-only support view.')).toBeVisible();
  await expectAccessible(page);

  // Nothing on it can change anything: no field, no switch, and no button but Sign out.
  const main = page.getByRole('main');
  await expect(main.getByRole('textbox')).toHaveCount(0);
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await expect(main.getByRole('radio')).toHaveCount(0);
  await expect(main.getByRole('button')).toHaveText(['Sign out']);
  // One read for opening it, and no write of any kind.
  expect(fake.made('GET', /team$/)).toHaveLength(1);
  expect(fake.calls.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('no screen shows or edits customer data', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  const customerWords = /\b(jobs?|estimates?|prices?|price books?|photos?|customers?|proposals?|readings?)\b/i;
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(customerWords);
  await page.getByRole('link', { name: 'Manage Company A Restoration' }).click();
  await expect(page.getByRole('heading', { name: 'Company A Restoration', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(customerWords);
  await page.getByRole('link', { name: 'Open the team view' }).click();
  await expect(page.getByRole('heading', { name: 'Company A Restoration: team' })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(customerWords);
  // The screens fit a phone: no sideways scrolling.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('signing out clears the operator session', async ({ page }) => {
  const fake = new FakePlatform();
  await openAsOperator(page, fake);
  await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Platform operator sign-in' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('status')).toHaveText('You are signed out.');
  await page.reload();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Companies' })).toHaveCount(0);
});
