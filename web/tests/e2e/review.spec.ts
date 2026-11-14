import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priceEstimate } from '@/engine/estimate';
import { estimateInput } from '@/lib/estimates/inputs';
import { proposalBytes, proposalOf } from '@/lib/estimates/proposal';
import { estimateView, type EstimateView } from '@/lib/estimates/result';
import { capabilitiesFor } from '@/lib/access';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';
import { expectNoAxeViolations } from './a11y';
import { PASSWORD, readSeed, type TeamAccount, type TeamSeed } from './sign-in/seed';

// Review before signing (S5a-9) in Chromium and WebKit at phone width. It signs in to the Auth
// emulator's tenant of the browser project's own company, as a phone does. The estimate routes need
// Postgres, which this test server does not run, so the job and estimate answers are played here at
// the network boundary (tests/db/estimate-api.test.ts holds the real routes). The estimate played is
// a real one: the engine prices a submitted record and the server's own view of it is what the page
// gets, so every amount and sentence on screen is the engine's.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
const expect = baseExpect.configure({ timeout: 20_000 });

let team: TeamSeed;
test.beforeEach(({}, testInfo) => {
  team = readSeed().teams[testInfo.project.name]!;
});

const PHOTO = randomUUID();
const PHOTO_TWO = randomUUID();

// With `more`, a second photo (the hall, shot tag overview) is in the record after the first.
function record(jobId: string, draftId: string, more = false): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    submissionId: randomUUID(),
    jobId,
    draftId,
    fieldSha256: 'd'.repeat(64),
    field: {
      draft: { yearBuilt: 1968, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true },
      rooms: [
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      ],
      photos: [{ id: PHOTO, field: { roomId: 'kitchen', shotTag: 'source' } }, ...(more ? [{ id: PHOTO_TWO, field: { roomId: 'hall', shotTag: 'overview' } }] : [])],
    },
    photos: [{ id: PHOTO, sha256: 'ab'.repeat(32), sizeBytes: 1000, contentType: 'image/jpeg' }, ...(more ? [{ id: PHOTO_TWO, sha256: 'cd'.repeat(32), sizeBytes: 1000, contentType: 'image/jpeg' }] : [])],
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid' },
    claim: {},
  };
}

// The server's answer for this record priced at $2.00 a square foot of wet floor, as `role` sees it.
function estimateFor(team: TeamSeed, jobId: string, draftId: string, role: 'owner' | 'estimator' | 'office', photoLogGrouping: 'room' | 'shot_tag' | null = null): EstimateView {
  const company: CompanyDocuments = {
    identity: { companyId: team.companyId, name: team.companyName, address: '1 Synthetic Way, Testville', phone: '555-0100', email: 'office@example.invalid', license: '000001', signoff: 'Pat Example' },
    letterhead: NEUTRAL_LETTERHEAD,
    settings: photoLogGrouping ? { ...NEUTRAL_SETTINGS, photoLogGrouping } : NEUTRAL_SETTINGS,
  };
  const snapshot = record(jobId, draftId, photoLogGrouping !== null);
  const table = {
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  };
  const priced = priceEstimate(table, estimateInput(snapshot, company).job);
  if (!priced.ok) throw new Error(priced.error);
  const { bytes, sha256 } = proposalBytes(
    proposalOf({ estimate: priced, company, showLineBreakdown: false, submission: { id: snapshot.submissionId, snapshotSha256: 'e'.repeat(64) }, version: { sequence: 1 } }),
  );
  return estimateView(
    {
      id: randomUUID(),
      jobId,
      submissionId: snapshot.submissionId,
      pinSequence: 1,
      versionSequence: 1,
      tableHash: priced.table_sha256,
      engineVersion: priced.engine_version,
      pricedResult: JSON.parse(JSON.stringify({ ...priced, job_revision: 1 })),
      proposalBytes: bytes,
      proposalSha256: sha256,
      createdAt: new Date(),
    },
    capabilitiesFor(role, { priceBooks: true }),
  );
}

type Job = { id: string; status: string; currentDraftId: string; revision: number };

// The job and estimate routes at the network boundary. `estimate` is what GET answers; `make`
// decides POST's answer.
async function playApi(page: Page, job: Job, answers: { estimate: EstimateView | null; make?: () => [number, unknown]; read?: number }) {
  const sent: string[] = [];
  await page.route(`**/api/jobs/${job.id}**`, async (route: Route, request: Request) => {
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toMatch(/^Bearer /);
    sent.push(`${request.method()} ${path}`);
    if (request.method() === 'GET' && path === `/api/jobs/${job.id}`) {
      return route.fulfill({ json: { job: { ...job, propertyAddress: '', fieldOwnerActorId: null, createdAt: '', updatedAt: '' }, customer: {}, claim: {} } });
    }
    if (path === `/api/jobs/${job.id}/estimate`) {
      if (request.method() === 'GET') {
        if (answers.read) return route.fulfill({ status: answers.read, json: { error: 'not_found' } });
        return route.fulfill({ json: { job, estimate: answers.estimate } });
      }
      if (request.method() === 'POST' && answers.make) {
        const [status, json] = answers.make();
        return route.fulfill({ status, json });
      }
    }
    return route.fulfill({ status: 500, json: { error: 'unexpected' } });
  });
  return sent;
}

async function signInTo(page: Page, who: Pick<TeamAccount, 'email'>) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('the estimator opens the review from Finish, prices the job and reads the four documents', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const made = estimateFor(team, job.id, job.currentDraftId, 'estimator');
  const sent = await playApi(page, job, { estimate: null, make: () => [201, { job, estimate: made }] });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/finish`);
  const main = page.getByRole('main');
  await main.getByRole('link', { name: 'Review the estimate' }).click();

  await expect(main.getByRole('heading', { name: 'Price this job' })).toBeVisible();
  await expectNoAxeViolations(page);
  await main.getByRole('button', { name: 'Price this job' }).click();

  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  expect(sent.filter((call) => call.startsWith('POST'))).toEqual([`POST /api/jobs/${job.id}/estimate`]);
  // The engine's numbers, as the server answered them: 80 + 40 sq ft at $2.00.
  // The price section (the proposal and the itemized claim print the same lines further down).
  const price = main.getByRole('region', { name: 'Price' });
  await expect(price.getByText('Price: $240.00', { exact: true })).toBeVisible();
  await expect(price.getByText('Itemized total: $240.00')).toBeVisible();
  await expect(price.getByText('Kitchen: Extraction')).toBeVisible();
  await expect(price.getByText('Hall: Extraction')).toBeVisible();
  await expect(main.getByText('Category 2 water in two rooms.')).toBeVisible();
  await expect(main.getByText('Quantity overrides')).toHaveCount(0);

  for (const name of ['Proposal', 'Itemized claim', 'Scope defense letter', 'Photo audit log']) await main.getByText(name, { exact: true }).click();
  await expect(main.getByText(`${team.companyName} · Official proposal`)).toBeVisible();
  await expect(main.getByText('(this does not include the pretest for lead/asbestos)').first()).toBeVisible();
  await expect(main.getByText(`Photo 1 · Kitchen · shot: source · SHA-256 ${'ab'.repeat(6)}…`)).toBeVisible();
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  const box = main.getByRole('checkbox', { name: /I reviewed the proposal/ });
  await box.check();
  await expect(main.getByText('Documents confirmed.')).toBeVisible();
});

test('office reads the estimate but has no price button and no confirmation box', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const sent = await playApi(page, job, { estimate: estimateFor(team, job.id, job.currentDraftId, 'office') });
  await signInTo(page, team.office);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  await expect(main.getByRole('region', { name: 'Price' }).getByText('Price: $240.00', { exact: true })).toBeVisible();
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Price this job' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  expect(sent.filter((call) => call.startsWith('POST'))).toEqual([]);
});

test('a company with no published prices is told so, and nothing is shown as priced', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  await playApi(page, job, { estimate: null, make: () => [409, { error: 'prices_not_set' }] });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Price this job' }).click();
  await expect(main.getByRole('alert')).toContainText('Your company has no published prices yet.');
  await expect(main.getByText(/\$\d/)).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('with prices switched off for the company, the review says so', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  await playApi(page, job, { estimate: null, read: 404 });
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  await expect(page.getByRole('main').getByRole('heading', { name: 'Prices are not switched on' })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('the photo audit log shows the company’s grouping: by room as one list, by shot tag in albums', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  for (const grouping of ['room', 'shot_tag'] as const) {
    await playApi(page, job, { estimate: estimateFor(team, job.id, job.currentDraftId, 'office', grouping) });
    if (grouping === 'room') await signInTo(page, team.office);
    await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
    const main = page.getByRole('main');
    await main.getByText('Photo audit log', { exact: true }).click();
    const log = main.locator('details', { hasText: 'Photo audit log' });
    const lines = log.getByRole('listitem');
    if (grouping === 'room') {
      // Room order of the record is kitchen, hall: today's list, no headings.
      await expect(log.getByRole('heading')).toHaveCount(0);
      await expect(lines).toHaveText([`Photo 1 · Kitchen · shot: source · SHA-256 ${'ab'.repeat(6)}…`, `Photo 2 · Hall · shot: overview · SHA-256 ${'cd'.repeat(6)}…`]);
    } else {
      await expect(log.getByRole('heading')).toHaveText(['Overview', 'Source of loss']);
      await expect(lines).toHaveText([`Photo 1 · Hall · shot: overview · SHA-256 ${'cd'.repeat(6)}…`, `Photo 2 · Kitchen · shot: source · SHA-256 ${'ab'.repeat(6)}…`]);
    }
    await expectNoAxeViolations(page);
    await expectNoSideways(page);
  }
});
