import { expect as baseExpect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { hrefOf, type FieldView } from '../../src/lib/field/views';
import { APP_CHECK_BASE_URL, APP_CHECK_JOBS_BASE_URL } from './app-check/server';
import { adminSql, seedCompany, storedJobs, storedPhotos, type Company } from './jobs/seed';
import { FakePlatform } from './operator/fake-platform';
import { FIELD_VIEW_SCREENS, SCREENS } from './screens';
import { APP_CODE, fakeSecondStep, withSecondFactor } from './second-step/fake-totp';
import { idTokenFor } from './sign-in/emulator';
import { PASSWORD, readSeed, type Seed } from './sign-in/seed';

// Every screen with App Check on and a reCAPTCHA that never answers (docs/plans/TC.md, TC-5):
// each screen of screens.ts still opens and works, and so does each changed /api call path (team
// invitations, company settings, the price-list export, the check and a publish, the field app's
// job and photo calls, Finish and review, and the operator screens). Their calls go out without an App
// Check token, and none waits for one. Chromium and WebKit at phone width.
//
// Two App Check servers (app-check/server.ts): the sign-in file one for the screens the other
// specs run on the main server, and one on the jobs database for prices (a company of its own, so
// publishing changes nobody else's), the field app, Finish and review.
// The other specs' stand-ins are reused (fake-totp.ts for the authenticator step, FakePlatform for
// the operator routes); nothing reaches Google.

test.use({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });

const expect = baseExpect.configure({ timeout: 20_000 });

// Every /api call a page makes, with whether it carried an App Check header.
type Sent = { path: string; header: boolean };

async function stallRecaptcha(page: Page): Promise<Sent[]> {
  await page.route(/^https:\/\/www\.google\.com\/recaptcha\//, () => new Promise<void>(() => {}));
  const sent: Sent[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/') || url.hostname !== 'localhost') return;
    sent.push({ path: url.pathname, header: request.headers()['x-firebase-appcheck'] !== undefined });
  });
  return sent;
}

// The page may still be loading the stalled reCAPTCHA script, so navigation waits for the
// document only.
const open = (page: Page, path: string) => page.goto(path, { waitUntil: 'domcontentloaded' });

async function signIn(page: Page, address: string, email: string, companyName: string, secondStep = false) {
  await open(page, `/sign-in/${address}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (secondStep) {
    await page.getByLabel('6-digit code').fill(APP_CODE);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: `Signed in to ${companyName}` })).toBeVisible();
}

// Switches the company's prices on (the price_books flag), as the operator would.
async function withPrices(company: Company): Promise<Company> {
  await adminSql()`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company.id}, 'price_books', true)`;
  return company;
}

// Saves a working copy with two items on and priced, every other item off, as the owner would on
// another device (the same table prices.spec.ts saves), through the App Check server's own API.
async function savePricedWorkingCopy(tenantId: string, email: string) {
  const headers = { Authorization: `Bearer ${withSecondFactor(await idTokenFor(tenantId, email, PASSWORD))}`, 'Content-Type': 'application/json' };
  const read = await fetch(`${APP_CHECK_JOBS_BASE_URL}/api/prices`, { headers });
  expect(read.status).toBe(200);
  type Item = { item_id: string } & Record<string, unknown>;
  const { workingCopy } = (await read.json()) as { workingCopy: { revision: number; table: { items: Item[] } } };
  const items = workingCopy.table.items.map((item) =>
    item.item_id === 'demo_drywall'
      ? { ...item, unit_price: '4.00' }
      : item.item_id === 'water_extraction'
        ? { ...item, unit_price: '1.25' }
        : { ...item, enabled: false },
  );
  const saved = await fetch(`${APP_CHECK_JOBS_BASE_URL}/api/prices/working-copy`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ expectedRevision: workingCopy.revision, table: { ...workingCopy.table, items } }),
  });
  expect(saved.status).toBe(200);
}

type Visit = {
  name: string;
  baseURL: string;
  // The screens.ts patterns and field views this visit opens.
  screens: string[];
  run: (page: Page, seed: Seed, project: string) => Promise<void>;
};

const VISITS: Visit[] = [
  {
    name: 'start page',
    baseURL: APP_CHECK_BASE_URL,
    screens: ['/'],
    run: async (page) => {
      await open(page, '/');
      await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();
    },
  },
  {
    // The homeowner's pages need Postgres, which this server does not run, so the link routes'
    // answers are played at the network boundary, as links.spec.ts does: an unavailable link.
    name: 'the signing and documents link pages',
    baseURL: APP_CHECK_BASE_URL,
    screens: ['/sign', '/documents'],
    run: async (page) => {
      await page.route(/\/api\/(sign|documents)(\/|\?|$)/, (route) => route.fulfill({ status: 404, json: { error: 'link_unavailable' } }));
      for (const path of ['/sign', '/documents']) {
        await open(page, `${path}#${'a'.repeat(43)}`);
        await expect(page.getByRole('main').getByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
      }
    },
  },
  {
    name: 'sign-in, team with a new invitation, the invitation, and company settings',
    baseURL: APP_CHECK_BASE_URL,
    screens: ['/sign-in/[address]', '/sign-in/[address]/team', '/sign-in/[address]/invitations/[invitationId]', '/sign-in/[address]/company'],
    run: async (page, seed, project) => {
      const team = seed.teams[project]!;
      await signIn(page, team.address, team.owner.email, team.companyName);
      await page.getByRole('link', { name: 'Team and invitations' }).click();
      await expect(page.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
      const email = `app-check-${randomUUID().slice(0, 8)}@example.com`;
      await page.getByLabel('Email address to invite').fill(email);
      await page.getByLabel('Office').check();
      await page.getByRole('button', { name: 'Create invitation' }).click();
      await expect(page.getByText(`Invitation for ${email}`)).toBeVisible();
      const link = await page.getByLabel(`Invitation link for ${email}`).inputValue();
      await open(page, `/sign-in/${team.address}`);
      await page.getByRole('link', { name: 'Company settings' }).click();
      await expect(page.getByRole('heading', { name: 'Company settings' })).toBeVisible();
      await expect(page.getByLabel('Company address')).toBeVisible();
      // The invitation screen, as the invited person opens the link on a phone of their own.
      const context = await page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      try {
        const invited = await context.newPage();
        const sent = await stallRecaptcha(invited);
        await open(invited, `${APP_CHECK_BASE_URL}${new URL(link).pathname}`);
        await expect(invited.getByText(`You have been invited to ${team.companyName}.`, { exact: false })).toBeVisible();
        expect(sent.filter((call) => call.header)).toEqual([]);
      } finally {
        await context.close();
      }
    },
  },
  {
    name: 'prices: the price-list export, the check and a publish',
    baseURL: APP_CHECK_JOBS_BASE_URL,
    screens: ['/sign-in/[address]/prices'],
    run: async (page) => {
      // A company of its own with prices switched on and a saved, priced working copy, so the
      // publish here changes nobody else's prices.
      const company = await withPrices(await seedCompany('app-check-prices', { owner: 'owner' }));
      const owner = company.people.owner!;
      await savePricedWorkingCopy(company.tenantId, owner.email);
      await fakeSecondStep(page, { factors: ['Authenticator app'] });
      await signIn(page, company.address, owner.email, company.name, true);
      await page.getByRole('link', { name: 'Company settings' }).click();
      await page.getByRole('link', { name: 'Prices', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Prices', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Items' })).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('region', { name: 'Price-list file' }).getByRole('button', { name: 'Download the price list' }).click();
      expect((await download).suggestedFilename()).toBe('price-list.csv');
      const publish = page.getByRole('region', { name: 'Publish', exact: true });
      await publish.getByRole('button', { name: 'Check the prices before publishing' }).click();
      await publish.getByLabel('A price range (low to high)').check();
      await publish.getByLabel('What changed (kept with the version)').fill('First prices');
      await publish.getByRole('button', { name: 'Publish these prices' }).click();
      await expect(publish.getByText('Published as version 1.', { exact: false })).toBeVisible();
    },
  },
  {
    name: 'operator: companies, a company and its team',
    baseURL: APP_CHECK_BASE_URL,
    screens: ['/operator/[tenantId]', '/operator/[tenantId]/companies/[companyId]', '/operator/[tenantId]/companies/[companyId]/team'],
    run: async (page, seed, project) => {
      await fakeSecondStep(page, { factors: ['Authenticator app'] });
      const fake = new FakePlatform();
      await fake.install(page);
      await open(page, `/operator/${seed.tenantOperators}`);
      await page.getByLabel('Email').fill(seed.projects[project]!.operator.email);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByLabel('6-digit code').fill(APP_CODE);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Companies', level: 1 })).toBeVisible();
      const company = fake.find('Company A Restoration');
      await open(page, `/operator/${seed.tenantOperators}/companies/${company.id}`);
      await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
      await open(page, `/operator/${seed.tenantOperators}/companies/${company.id}/team`);
      await expect(page.getByRole('heading', { name: `${company.name}: team` })).toBeVisible();
      expect(fake.calls.length).toBeGreaterThan(0);
    },
  },
  {
    name: 'field app: every view, a new job and a photo, then Finish and review',
    baseURL: APP_CHECK_JOBS_BASE_URL,
    screens: ['/field', ...Object.keys(FIELD_VIEW_SCREENS).map((view) => `field:${view}`), '/sign-in/[address]/jobs/[jobId]/finish', '/sign-in/[address]/jobs/[jobId]/review'],
    run: async (page) => {
      const company = await withPrices(await seedCompany('app-check', { estimator: 'estimator' }));
      const estimator = company.people.estimator!;
      await signIn(page, company.address, estimator.email, company.name);
      await page.getByRole('link', { name: 'Open the field app' }).click();
      await expect(page.getByRole('heading', { name: company.name, level: 1 })).toBeVisible();
      await page.getByRole('button', { name: 'Online only', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible();

      const main = page.getByRole('main');
      await main.getByRole('link', { name: 'New job' }).click();
      await expect(page.getByRole('heading', { name: 'New job' })).toBeVisible();
      const address = `${randomUUID().slice(0, 6)} App Check Way`;
      await page.getByLabel('Property address').fill(address);
      await page.getByRole('button', { name: 'Start job' }).click();
      await expect(page.getByRole('heading', { name: address })).toBeVisible();
      await expect.poll(async () => (await storedJobs(company.id)).length).toBe(1);
      const jobId = (await storedJobs(company.id))[0]!.id;

      await page.getByLabel('New room name').fill('Kitchen');
      await page.getByRole('button', { name: 'Add room' }).click();
      await expect(page.getByRole('form', { name: 'Kitchen' })).toBeVisible();
      await main.getByRole('link', { name: 'Photos' }).click();
      await page.getByLabel('Room', { exact: true }).selectOption({ label: 'Kitchen' });
      await page.getByLabel('Shot').selectOption({ label: 'Overview' });
      await page.getByLabel('Take photo').setInputFiles({
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAZ0lEQVR4nBWMQQ0AQAyDqmRKqgQlU1IlU1JFl+NJCBIaZARaFHSoSGKGMQOzTJhjykh4sDF4cfDhYokfm89C4KAgscP6y1027LFlJTLEP82SkCMlEjec/+CWC3dcOYkO9d92aejR0gf/sEsBLaIzfQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await expect.poll(async () => (await storedPhotos(company.id, jobId)).length).toBeGreaterThan(0);

      // Every field view by its address, as a reload or a link opens it.
      const views: Record<FieldView, () => Promise<void>> = {
        jobs: () => expect(page.getByRole('heading', { name: 'My jobs' })).toBeVisible(),
        'new-job': () => expect(page.getByRole('heading', { name: 'New job' })).toBeVisible(),
        scope: () => expect(page.getByLabel('Year built')).toBeVisible(),
        customer: () => expect(page.getByLabel('Customer name')).toBeVisible(),
        photos: () => expect(page.getByRole('heading', { name: /^Job photos/ })).toBeVisible(),
        coordination: () => expect(page.getByText('Job coordination is kept by the office and the company owner.')).toBeVisible(),
      };
      for (const [view, ready] of Object.entries(views) as [FieldView, () => Promise<void>][]) {
        const place = view === 'jobs' ? { view, list: null } : view === 'new-job' ? { view } : { view, jobId };
        await open(page, hrefOf(place));
        await ready();
      }

      // Finish (the submission call), then the review of the finished job.
      await open(page, `/sign-in/${company.address}/jobs/${jobId}/finish`);
      const finish = page.getByRole('main');
      await expect(finish.getByRole('heading', { name: 'Finish and review' })).toBeVisible();
      await finish.getByRole('button', { name: 'Finish and review' }).click();
      await expect(finish.getByRole('heading', { name: 'Finished' })).toBeVisible();
      await finish.getByRole('link', { name: 'Review the estimate' }).click();
      await expect(page.getByRole('main').getByRole('heading', { name: 'Price this job' })).toBeVisible();
    },
  },
];

test('the visits below open every screen of screens.ts and every field view', () => {
  const opened = new Set(VISITS.flatMap((visit) => visit.screens));
  for (const screen of Object.keys(SCREENS)) expect(opened.has(screen), screen).toBe(true);
  for (const view of Object.keys(FIELD_VIEW_SCREENS)) expect(opened.has(`field:${view}`), view).toBe(true);
});

for (const visit of VISITS) {
  test.describe(() => {
    test.use({ baseURL: visit.baseURL });

    test(`${visit.name} works with App Check on and a reCAPTCHA that never answers`, async ({ page }, testInfo) => {
      const sent = await stallRecaptcha(page);
      await visit.run(page, readSeed(), testInfo.project.name);
      expect(sent.filter((call) => call.header).map((call) => call.path)).toEqual([]);
    });
  });
}
