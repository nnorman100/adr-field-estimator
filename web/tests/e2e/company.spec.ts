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

// The texts the signed page needs (S5a-4b); until both are set the setup check lists them.
const TERMS = {
  authorization_text: 'I authorize the work described in this estimate to begin.',
  payment_terms_text: 'Payment is due within 30 days of completion.',
};
const NOT_READY = 'Still needed before documents can be issued and signed';
const READY = 'Ready to issue and sign documents';

// Saves the profile as another of the owner's devices would: read the revision, then save from it.
// The letterhead lines are cleared and the document settings set to `documents` (neutral by
// default), so every test starts from a known state.
async function setProfile(request: APIRequestContext, profile: typeof FULL, documents: object = {}) {
  const token = await idTokenFor(team.tenantId, team.owner.email, PASSWORD);
  const headers = { Authorization: `Bearer ${token}` };
  const read = await request.get(`/api/companies/${team.companyId}/profile`, { headers });
  expect(read.status()).toBe(200);
  const { revision } = await read.json();
  const response = await request.put(`/api/companies/${team.companyId}/profile`, {
    headers,
    data: {
      revision,
      changeId: randomUUID(),
      ...profile,
      ...{ emergencyPhone: '', fax: '', website: '', tagline: '', mailingAddress: '' },
      documents,
    },
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
  await expect(page.getByRole('heading', { name: NOT_READY })).toBeVisible();
  const missing = page.getByRole('region', { name: NOT_READY }).getByRole('listitem');
  await expect(missing).toHaveText([
    'Company address',
    'CSLB license',
    'Document sign-off',
    'Start-work authorization',
    'Payment terms',
  ]);
  // S7-4: the AI used today and this month against the V5 B default ceilings (the stand-in has no
  // AI calls), read through the real route's owner check.
  const aiUse = page.getByRole('region', { name: 'AI use' });
  await expect(aiUse.getByRole('term')).toHaveText(['AI used today', 'AI used this month']);
  await expect(aiUse.getByRole('definition')).toHaveText(['$0.00 of $10.00', '$0.00 of $200.00']);
  await expect(aiUse).toContainText('not the prices of your work');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  await page.getByLabel('Company address').fill(FULL.address);
  await page.getByLabel('Company phone').fill(FULL.phone);
  await page.getByLabel('Company email').fill(FULL.email);
  await page.getByLabel('CSLB license number').fill(FULL.license);
  await page.getByLabel('Document sign-off').fill(FULL.signoff);
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  // The five lines are in; the signed page's two texts are still missing.
  await expect(page.getByRole('region', { name: NOT_READY }).getByRole('listitem')).toHaveText([
    'Start-work authorization',
    'Payment terms',
  ]);
  await page.getByLabel('Start-work authorization').fill(TERMS.authorization_text);
  await page.getByLabel('Payment terms').fill(TERMS.payment_terms_text);
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('heading', { name: READY })).toBeVisible();
  await expectNoAxeViolations(page);

  // What the server holds is what a reload shows.
  await page.reload();
  await expect(page.getByLabel('Company address')).toHaveValue(FULL.address);
  await expect(page.getByLabel('Company phone')).toHaveValue(FULL.phone);
  await expect(page.getByLabel('Company email')).toHaveValue(FULL.email);
  await expect(page.getByLabel('CSLB license number')).toHaveValue(FULL.license);
  await expect(page.getByLabel('Document sign-off')).toHaveValue(FULL.signoff);
  await expect(page.getByLabel('Payment terms')).toHaveValue(TERMS.payment_terms_text);
  await expect(page.getByRole('heading', { name: READY })).toBeVisible();
});

test('clearing the licence puts it back on the missing list', async ({ page, request }) => {
  await setProfile(request, FULL, TERMS);
  await signInTo(page, team.owner);
  await openSettings(page);
  await expect(page.getByRole('heading', { name: READY })).toBeVisible();
  await page.getByLabel('CSLB license number').fill('');
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('heading', { name: NOT_READY })).toBeVisible();
  await expect(
    page.getByRole('region', { name: NOT_READY }).getByRole('listitem'),
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
    'Emergency phone',
    'Tagline',
    'Start-work authorization',
    'Payment terms',
  ]) {
    await expect(page.getByLabel(label)).toBeDisabled();
  }
  await expect(page.getByRole('button', { name: 'Add a clause' })).toBeDisabled();

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

test('the owner sets the letterhead lines and the document settings, and a reload shows them', async ({
  page,
  request,
}) => {
  await setProfile(request, FULL);
  await signInTo(page, team.owner);
  await openSettings(page);
  // A new company's settings: the itemized proposal, photos by room, nothing else set.
  await expect(page.getByRole('radio', { name: /^Itemized/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^By room/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Show the previous price on a revised estimate' })).not.toBeChecked();
  await expect(page.getByLabel('Clause 1 title')).toHaveCount(0);

  await page.getByLabel('Emergency phone').fill('(555) 010-0199');
  await page.getByLabel('Fax').fill('(555) 010-0102');
  await page.getByLabel('Website').fill('www.example.com');
  await page.getByLabel('Tagline').fill('Water damage and mold remediation');
  await page.getByLabel('Mailing address').fill('PO Box 100, Testville, CA 90000');
  await page.getByRole('radio', { name: /^Letter/ }).check();
  await page.getByRole('button', { name: 'Add a clause' }).click();
  await page.getByLabel('Clause 1 title').fill('Scheduling');
  await page.getByLabel('Clause 1 text').fill('We confirm the start date by phone.\nTwo days before work begins.');
  await page.getByRole('button', { name: 'Add a clause' }).click();
  await page.getByLabel('Clause 2 title').fill('Removed again');
  await page.getByRole('button', { name: 'Remove clause 2' }).click();
  await page.getByRole('button', { name: 'Add a prep task' }).click();
  await page.getByLabel('Prep task 1').fill('The homeowner removes the contents of the closet before the start date.');
  // A row added and left empty is not sent.
  await page.getByRole('button', { name: 'Add a prep task' }).click();
  await page.getByRole('radio', { name: /^By kind of shot/ }).check();
  await page.getByLabel('Start-work authorization').fill(TERMS.authorization_text);
  await page.getByLabel('Payment terms').fill(TERMS.payment_terms_text);
  await page.getByRole('checkbox', { name: 'Show the previous price on a revised estimate' }).check();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
  await page.getByRole('button', { name: 'Save company settings' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: READY })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Emergency phone')).toHaveValue('(555) 010-0199');
  await expect(page.getByLabel('Fax')).toHaveValue('(555) 010-0102');
  await expect(page.getByLabel('Website')).toHaveValue('www.example.com');
  await expect(page.getByLabel('Tagline')).toHaveValue('Water damage and mold remediation');
  await expect(page.getByLabel('Mailing address')).toHaveValue('PO Box 100, Testville, CA 90000');
  await expect(page.getByRole('radio', { name: /^Letter/ })).toBeChecked();
  await expect(page.getByLabel('Clause 1 title')).toHaveValue('Scheduling');
  await expect(page.getByLabel('Clause 1 text')).toHaveValue('We confirm the start date by phone.\nTwo days before work begins.');
  await expect(page.getByLabel('Clause 2 title')).toHaveCount(0);
  await expect(page.getByLabel('Prep task 1')).toHaveValue('The homeowner removes the contents of the closet before the start date.');
  await expect(page.getByLabel('Prep task 2')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /^By kind of shot/ })).toBeChecked();
  await expect(page.getByLabel('Start-work authorization')).toHaveValue(TERMS.authorization_text);
  await expect(page.getByRole('checkbox', { name: 'Show the previous price on a revised estimate' })).toBeChecked();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
});

test('a list cannot grow past its limit', async ({ page, request }) => {
  const clauses = Array.from({ length: 9 }, (_, i) => ({ title: `Clause ${i + 1}`, text: 'Text.' }));
  await setProfile(request, FULL, { company_clauses: clauses });
  await signInTo(page, team.owner);
  await openSettings(page);
  await expect(page.getByLabel('Clause 9 title')).toHaveValue('Clause 9');
  await page.getByRole('button', { name: 'Add a clause' }).click();
  await expect(page.getByLabel('Clause 10 title')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a clause' })).toBeDisabled();
});

test('the settings still open when the AI use cannot be read, and say so', async ({ page, request }) => {
  await setProfile(request, FULL);
  await page.route(`**/api/companies/${team.companyId}/ai-usage`, (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"ai_usage_unavailable"}' }),
  );
  await signInTo(page, team.owner);
  await openSettings(page);
  const aiUse = page.getByRole('region', { name: 'AI use' });
  await expect(aiUse).toContainText('We could not load the AI use');
  await expect(aiUse.getByRole('term')).toHaveCount(0);
  await expect(page.getByLabel('Company phone')).toHaveValue(FULL.phone);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
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
    // The AI use as well (S7-4: ai_usage_read is the owner's).
    const usage = await request.get(`/api/companies/${team.companyId}/ai-usage`, { headers });
    expect(usage.status()).toBe(403);
    expect(await usage.json()).toEqual({ error: 'not_allowed' });
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
