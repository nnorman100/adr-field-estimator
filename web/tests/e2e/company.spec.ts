import {
  test as base,
  expect as baseExpect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { expectNoAxeViolations } from './a11y';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD, readSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';

// The Company settings screen (S5a-4) in Chromium and WebKit at phone width. It signs in to the
// Auth emulator's tenants; the dev server checks each sign-in and each profile call as it does in
// production, and only the profile record is a local file (src/lib/profile/local-profile.ts). Each
// browser project has a company of its own (sign-in/global-setup.ts); every test first puts the
// profile in a known state through the API, so the order of the tests does not matter.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
// The tests of one browser share its company's profile, so they run one after another (the two
// browsers have companies of their own and still run side by side).
test.describe.configure({ mode: 'serial' });

// The dev server compiles each page and route the first time it is asked.
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

const EMPTY = { address: '', phone: '', email: '', license: '', signoff: '' };
const FULL = {
  address: '12 Example Street, Testville, CA 90000',
  phone: '(555) 010-0100',
  email: 'office@example.test',
  license: '000001',
  signoff: 'Pat Example',
};

// Saves the profile as another of the owner's devices would: read the revision, then save from it.
async function setProfile(request: APIRequestContext, profile: typeof FULL) {
  const token = await idTokenFor(team.tenantId, team.owner.email, PASSWORD);
  const headers = { Authorization: `Bearer ${token}` };
  const read = await request.get(`/api/companies/${team.companyId}/profile`, { headers });
  expect(read.status()).toBe(200);
  const { revision } = await read.json();
  const response = await request.put(`/api/companies/${team.companyId}/profile`, {
    headers,
    data: { revision, changeId: randomUUID(), ...profile },
  });
  expect(response.status()).toBe(200);
}

async function signInTo(page: Page, who: Pick<TeamAccount, 'email'>) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `Signed in to ${team.companyName}` }),
  ).toBeVisible();
}

async function openSettings(page: Page) {
  await page.getByRole('link', { name: 'Company settings' }).click();
  await expect(page.getByRole('heading', { name: 'Company settings' })).toBeVisible();
  await expect(page.getByLabel('Company address')).toBeVisible();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the owner sees what is missing, fills it in and saves', async ({ page, request }) => {
  await setProfile(request, EMPTY);
  await signInTo(page, team.owner);
  await openSettings(page);
  await expect(page.getByText(team.companyName, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Still needed before documents' })).toBeVisible();
  const missing = page
    .getByRole('region', { name: 'Still needed before documents' })
    .getByRole('listitem');
  await expect(missing).toHaveText(['Company address', 'CSLB license', 'Document sign-off']);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  await page.getByLabel('Company address').fill(FULL.address);
  await page.getByLabel('Company phone').fill(FULL.phone);
  await page.getByLabel('Company email').fill(FULL.email);
  await page.getByLabel('CSLB license number').fill(FULL.license);
  await page.getByLabel('Document sign-off').fill(FULL.signoff);
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready to issue documents' })).toBeVisible();
  await expectNoAxeViolations(page);

  // What the server holds is what a reload shows.
  await page.reload();
  await expect(page.getByLabel('Company address')).toHaveValue(FULL.address);
  await expect(page.getByLabel('Company phone')).toHaveValue(FULL.phone);
  await expect(page.getByLabel('Company email')).toHaveValue(FULL.email);
  await expect(page.getByLabel('CSLB license number')).toHaveValue(FULL.license);
  await expect(page.getByLabel('Document sign-off')).toHaveValue(FULL.signoff);
  await expect(page.getByRole('heading', { name: 'Ready to issue documents' })).toBeVisible();
});

test('clearing the licence puts it back on the missing list', async ({ page, request }) => {
  await setProfile(request, FULL);
  await signInTo(page, team.owner);
  await openSettings(page);
  await expect(page.getByRole('heading', { name: 'Ready to issue documents' })).toBeVisible();
  await page.getByLabel('CSLB license number').fill('');
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('heading', { name: 'Still needed before documents' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Still needed before documents' }).getByRole('listitem'),
  ).toHaveText(['CSLB license']);
});

test('the lines cannot be changed while a save is on its way', async ({ page, request }) => {
  await setProfile(request, EMPTY);
  await signInTo(page, team.owner);
  await openSettings(page);

  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  await page.route(`**/api/companies/${team.companyId}/profile`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    reached();
    await held;
    await route.continue();
  });

  await page.getByLabel('Company address').fill(FULL.address);
  await page.getByLabel('Company phone').fill(FULL.phone);
  await page.getByLabel('Company email').fill(FULL.email);
  await page.getByLabel('CSLB license number').fill(FULL.license);
  await page.getByLabel('Document sign-off').fill(FULL.signoff);
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await arrived;

  for (const label of [
    'Company address',
    'Company phone',
    'Company email',
    'CSLB license number',
    'Document sign-off',
  ]) {
    await expect(page.getByLabel(label)).toBeDisabled();
  }

  release();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.getByLabel('Company phone')).toBeEnabled();
  await expect(page.getByLabel('Company phone')).toHaveValue(FULL.phone);
});

test('a save after the profile changed elsewhere is refused and shows what is saved now', async ({
  page,
  request,
}) => {
  await setProfile(request, FULL);
  await signInTo(page, team.owner);
  await openSettings(page);
  await expect(page.getByLabel('Company phone')).toHaveValue(FULL.phone);

  // Another device saves a new phone after this screen read the profile ...
  await setProfile(request, { ...FULL, phone: '(555) 010-0199' });

  // ... so this screen's sign-off change, made from the older profile, is not saved over it.
  await page.getByLabel('Document sign-off').fill('Robin Example');
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'changed somewhere else' }),
  ).toBeVisible();
  await expect(page.getByLabel('Company phone')).toHaveValue('(555) 010-0199');
  await expect(page.getByLabel('Document sign-off')).toHaveValue(FULL.signoff);
  await expectNoAxeViolations(page);

  // Made again from what is saved now, the change is saved and keeps the other device's phone.
  await page.getByLabel('Document sign-off').fill('Robin Example');
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Company phone')).toHaveValue('(555) 010-0199');
  await expect(page.getByLabel('Document sign-off')).toHaveValue('Robin Example');
});

test('a line the server refuses is explained and keeps what was typed', async ({
  page,
  request,
}) => {
  await setProfile(request, EMPTY);
  await signInTo(page, team.owner);
  await openSettings(page);
  await page.getByLabel('Company email').fill('name@localhost');
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Check each line' })).toBeVisible();
  await expect(page.getByLabel('Company email')).toHaveValue('name@localhost');
  await expectNoAxeViolations(page);
});

for (const [kind, who] of [
  ['an estimator', () => team.estimator],
  ['an office user', () => team.office],
] as const) {
  test(`${kind} cannot open the company settings`, async ({ page, request }) => {
    await setProfile(request, FULL);
    const person = who();
    await signInTo(page, person);
    // No way in from the signed-in screen ...
    await expect(page.getByRole('link', { name: 'Company settings' })).toHaveCount(0);

    // ... and the address itself shows only a refusal, without asking for the profile at all.
    const profileRequests: string[] = [];
    page.on('request', (seen) => {
      if (new URL(seen.url()).pathname.endsWith('/profile')) profileRequests.push(seen.url());
    });
    await page.goto(`/sign-in/${team.address}/company`);
    await expect(
      page.getByRole('heading', { name: 'This screen is for the company owner' }),
    ).toBeVisible();
    await expect(page.getByLabel('Company address')).toHaveCount(0);
    await expect(page.getByText(FULL.signoff)).toHaveCount(0);
    await expectNoAxeViolations(page);
    expect(profileRequests).toEqual([]);

    // The server refuses the same people on its own, for a read and for a change.
    const token = await idTokenFor(team.tenantId, person.email, PASSWORD);
    const headers = { Authorization: `Bearer ${token}` };
    const read = await request.get(`/api/companies/${team.companyId}/profile`, { headers });
    expect(read.status()).toBe(403);
    expect(await read.json()).toEqual({ error: 'not_allowed' });
    const owner = await idTokenFor(team.tenantId, team.owner.email, PASSWORD);
    const ownerRead = () =>
      request.get(`/api/companies/${team.companyId}/profile`, {
        headers: { Authorization: `Bearer ${owner}` },
      });
    const { revision } = await (await ownerRead()).json();
    const write = await request.put(`/api/companies/${team.companyId}/profile`, {
      headers,
      data: { revision, changeId: randomUUID(), ...FULL, signoff: 'Someone Else' },
    });
    expect(write.status()).toBe(403);
    expect((await (await ownerRead()).json()).signoff).toBe(FULL.signoff);
  });
}

test('a visitor who is not signed in is asked to sign in', async ({ page }) => {
  await page.goto(`/sign-in/${team.address}/company`);
  await expect(
    page.getByRole('heading', { name: 'Sign in to change the company settings' }),
  ).toBeVisible();
  await expect(page.getByLabel('Company address')).toHaveCount(0);
  await expectNoAxeViolations(page);
});
