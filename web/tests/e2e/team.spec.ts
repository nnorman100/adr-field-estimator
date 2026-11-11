import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { activateAccount, idTokenFor } from './sign-in/emulator';
import { PASSWORD, readSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';

// The team and invitation screens (S3-16) in Chromium and WebKit at phone width. They sign in to
// the Auth emulator's tenants, and the dev server checks each sign-in and each team call as it does
// in production; only the team records are a local file (src/lib/team/local-team.ts) and the
// owner's authenticator-app second step is stood in for by the fixture, because the emulator
// cannot do either. Each browser project has a company of its own (sign-in/global-setup.ts).

test.use({ viewport: { width: 390, height: 844 } });

// The dev server compiles each API route the first time it is called, which under four browsers at
// once takes longer than the default five seconds.
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

async function signInAt(page: Page, path: string, who: Pick<TeamAccount, 'email'>) {
  await page.goto(path);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signInTo(page: Page, who: Pick<TeamAccount, 'email'>) {
  await signInAt(page, `/sign-in/${team.address}`, who);
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

async function openTeam(page: Page) {
  await page.getByRole('link', { name: 'Team and invitations' }).click();
  await expect(page.getByRole('heading', { name: 'Team and invitations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
}

const row = (page: Page, text: string) => page.getByRole('listitem').filter({ hasText: text });
const uniqueEmail = (name: string) => `${name}-${randomUUID().slice(0, 8)}@example.com`;

// An invitation made straight through the API as the owner, for tests that are about what happens
// after it exists. The owner's token comes from the emulator.
async function inviteThroughApi(request: APIRequestContext, email: string, role: 'estimator' | 'office') {
  const token = await idTokenFor(team.tenantId, team.owner.email, PASSWORD);
  const response = await request.post(`/api/companies/${team.companyId}/invitations`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { email, role },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { invitation: { id: string }; link: string };
  return { id: body.invitation.id, link: body.link };
}

test('the owner sees the team and the invitations', async ({ page }) => {
  await signInTo(page, team.owner);
  await expectAccessible(page);
  await openTeam(page);
  await expect(page.getByRole('heading', { name: 'Invite someone' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invitations', exact: true })).toBeVisible();
  await expect(row(page, team.owner.name)).toContainText('Owner');
  await expect(row(page, team.estimator.name)).toContainText('Estimator');
  await expect(row(page, team.office.name)).toContainText('Office');
  // The owner cannot be changed from here.
  await expect(row(page, team.owner.name).getByRole('button')).toHaveCount(0);
  await expectAccessible(page);
});

test('a visitor who is not signed in is asked to sign in', async ({ page }) => {
  await page.goto(`/sign-in/${team.address}/team`);
  await expect(page.getByRole('heading', { name: 'Sign in to see your team' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toHaveCount(0);
  await expectAccessible(page);
});

for (const [kind, who] of [
  ['an estimator', () => team.estimator],
  ['an office user', () => team.office],
] as const) {
  test(`${kind} cannot open the team screen`, async ({ page, request }) => {
    const person = who();
    await signInTo(page, person);
    // No way in from the signed-in screen ...
    await expect(page.getByRole('link', { name: 'Team and invitations' })).toHaveCount(0);

    // ... and the address itself shows only a refusal, without asking for the team at all.
    const teamRequests: string[] = [];
    page.on('request', (seen) => {
      if (new URL(seen.url()).pathname.startsWith('/api/companies/')) teamRequests.push(seen.url());
    });
    await page.goto(`/sign-in/${team.address}/team`);
    await expect(page.getByRole('heading', { name: 'This screen is for the company owner' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Team and invitations' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Members', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Email address to invite')).toHaveCount(0);
    await expectAccessible(page);
    expect(teamRequests).toEqual([]);

    // The server refuses the same people on its own.
    const token = await idTokenFor(team.tenantId, person.email, PASSWORD);
    const headers = { Authorization: `Bearer ${token}` };
    const invite = await request.post(`/api/companies/${team.companyId}/invitations`, {
      headers,
      data: { email: uniqueEmail('refused'), role: 'office' },
    });
    expect(invite.status()).toBe(403);
    expect(await invite.json()).toEqual({ error: 'not_allowed' });
    const list = await request.get(`/api/companies/${team.companyId}/team`, { headers });
    if (person === team.estimator) {
      expect(list.status()).toBe(403);
    } else {
      // An office user gets only the active estimators, to assign work: no members, no invitations.
      const body = (await list.json()) as Record<string, unknown>;
      expect(list.status()).toBe(200);
      expect(body.view).toBe('estimators');
      expect(body).not.toHaveProperty('members');
      expect(body).not.toHaveProperty('invitations');
      expect(JSON.stringify(body)).not.toContain(team.owner.email);
      expect(JSON.stringify(body)).not.toContain(team.office.email);
    }
  });
}

test('role changes show after reload', async ({ page }, testInfo) => {
  const person = team.forRoleChange[testInfo.retry]!;
  await signInTo(page, team.owner);
  await openTeam(page);
  await expect(row(page, person.name)).toContainText('Estimator');

  await page.getByRole('button', { name: `Change to office for ${person.name}` }).click();
  await expect(row(page, person.name)).toContainText('Office');
  await expect(page.getByRole('button', { name: `Change to estimator for ${person.name}` })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await expect(row(page, person.name)).toContainText('Office');
  await expect(row(page, person.name)).not.toContainText('Estimator');
});

test('turning a member off and on shows after reload, and a member turned off cannot get in', async ({ page, browser }, testInfo) => {
  const person = team.forTurnOff[testInfo.retry]!;
  await signInTo(page, team.owner);
  await openTeam(page);

  await page.getByRole('button', { name: `Turn off for ${person.name}` }).click();
  await expect(row(page, person.name)).toContainText('Turned off');
  await page.reload();
  await expect(row(page, person.name)).toContainText('Turned off');

  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL!, viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();
  await signInAt(phone, `/sign-in/${team.address}`, person);
  await expect(phone.getByRole('heading', { name: 'Your access is turned off' })).toBeVisible();
  await other.close();

  await page.getByRole('button', { name: `Turn on for ${person.name}` }).click();
  await expect(row(page, person.name)).not.toContainText('Turned off');
  await page.reload();
  await expect(row(page, person.name)).not.toContainText('Turned off');
});

test('the owner invites someone, who accepts the invitation', async ({ page, browser }, testInfo) => {
  const email = uniqueEmail('new-office');
  await signInTo(page, team.owner);
  await openTeam(page);

  await page.getByLabel('Email address to invite').fill(email);
  await page.getByLabel('Office').check();
  await page.getByRole('button', { name: 'Create invitation' }).click();
  // No email service yet: the owner gets the link to send.
  await expect(page.getByText(`Invitation for ${email}`)).toBeVisible();
  const link = await page.getByLabel(`Invitation link for ${email}`).inputValue();
  expect(new URL(link).pathname).toMatch(new RegExp(`^/sign-in/${team.address}/invitations/[0-9a-f-]{36}$`));
  await expect(row(page, email)).toContainText('Office · Open until');
  await expectAccessible(page);

  // Inviting made the person a sign-in account with no password; they set one (the emailed link,
  // tests/e2e/sign-in.spec.ts) and open the link.
  await activateAccount(team.tenantId, email, PASSWORD);
  const other = await browser.newContext({ baseURL: testInfo.project.use.baseURL!, viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();
  await signInAt(phone, new URL(link).pathname, { email });
  await expect(phone.getByRole('heading', { name: 'Accept invitation' })).toBeVisible();
  await expect(phone.getByText(`${team.companyName} has invited you to join as office.`)).toBeVisible();
  await expectAccessible(phone);
  await phone.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(phone.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
  await expect(phone.getByText('You are signed in as office staff.')).toBeVisible();
  // An office user has no way into the team screen.
  await expect(phone.getByRole('link', { name: 'Team and invitations' })).toHaveCount(0);
  await other.close();

  await page.reload();
  await expect(row(page, email)).toHaveCount(2);
  await expect(row(page, email).first()).toContainText('Office');
  await expect(row(page, email).nth(1)).toContainText('Accepted');
});

test('an invitation for another email cannot be read', async ({ page, request }) => {
  const invited = uniqueEmail('invited-office');
  const { id, link } = await inviteThroughApi(request, invited, 'office');

  // A verified account of this company, but not the invited email, opens the link.
  const answer = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/invitations/${id}`);
  await signInAt(page, link, team.stranger);
  expect((await answer).status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Accept a company invitation before using this app' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accept invitation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);
  await expect(page.getByText(invited)).toHaveCount(0);
  await expectAccessible(page);

  // The server says the same to the API: nothing to read, and nothing to accept.
  const token = await idTokenFor(team.tenantId, team.stranger.email, PASSWORD);
  const headers = { Authorization: `Bearer ${token}` };
  const read = await request.get(`/api/invitations/${id}`, { headers });
  expect(read.status()).toBe(404);
  expect(await read.json()).toEqual({ error: 'not_found' });
  const accept = await request.post(`/api/invitations/${id}/accept`, { headers });
  expect(accept.status()).toBe(404);
  // A made-up invitation reads the same way, so the answer says nothing about which ones exist.
  const unknown = await request.get(`/api/invitations/${randomUUID()}`, { headers });
  expect(unknown.status()).toBe(404);
  expect(await unknown.json()).toEqual({ error: 'not_found' });
  const signedOut = await request.get(`/api/invitations/${id}`);
  expect(signedOut.status()).toBe(401);
});

test('an invitation can be resent, cancelled and cleared', async ({ page, request }) => {
  const email = uniqueEmail('resend-cancel');
  await inviteThroughApi(request, email, 'estimator');
  await signInTo(page, team.owner);
  await openTeam(page);
  await expect(row(page, email)).toContainText('Estimator · Open until');

  await page.getByRole('button', { name: `Resend to ${email}` }).click();
  await expect(page.getByText(`Invitation for ${email}`)).toBeVisible();
  await expect(page.getByLabel(`Invitation link for ${email}`)).toHaveValue(/\/sign-in\/team-[a-z]+\/invitations\/[0-9a-f-]{36}$/);

  // An open invitation cannot be cleared, only cancelled.
  await expect(page.getByRole('button', { name: `Clear for ${email}` })).toHaveCount(0);
  await page.getByRole('button', { name: `Cancel for ${email}` }).click();
  await expect(row(page, email)).toContainText('Cancelled');

  await page.getByRole('button', { name: `Clear for ${email}` }).click();
  await expect(row(page, email)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Invitations', exact: true })).toBeVisible();
  await expect(row(page, email)).toHaveCount(0);
});

test('an email already invited or on the team is refused with a reason', async ({ page }) => {
  await signInTo(page, team.owner);
  await openTeam(page);
  await page.getByLabel('Email address to invite').fill(team.estimator.email);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('That email address is already on the team.');
});

test('a team change after the sign-in has grown old asks the owner to sign in again', async ({ page }) => {
  await signInTo(page, team.owner);
  await openTeam(page);
  await page.route(`**/api/companies/${team.companyId}/invitations`, (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'sign_in_again' }) }),
  );
  await page.getByLabel('Email address to invite').fill(uniqueEmail('too-late'));
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('team changes need a sign-in from the last 15 minutes');
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page).toHaveURL(new RegExp(`/sign-in/${team.address}$`));
  await expect(page.getByLabel('Password')).toBeVisible();
});
