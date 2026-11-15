import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priceEstimate } from '@/engine/estimate';
import { SIGNED_FORMAT, type SignedRecord } from '@/lib/agreements/record';
import type { SignedAgreement } from '@/lib/agreements/screen';
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
    // The company's own wording for the signed page (S5a-11), synthetic text.
    signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
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

// The job, estimate and signing routes at the network boundary. `estimate` is what GET answers;
// `make` decides POST's answer; `signature` and `sign` decide the signature receipt's and the
// agreement's answers (S5a-11), and `agreement` is what GET .../agreements answers.
type Answers = {
  estimate: EstimateView | null;
  make?: () => [number, unknown];
  read?: number;
  signature?: () => [number, unknown];
  sign?: () => [number, unknown];
  agreement?: SignedAgreement | null;
};

// What the page sent to the signing routes: the signature's path and bytes, and the agreement bodies.
type Signing = { signatures: Array<{ path: string; bytes: Buffer }>; agreements: unknown[] };

async function playApi(page: Page, job: Job, answers: Answers, signing: Signing = { signatures: [], agreements: [] }) {
  const sent: string[] = [];
  await page.route(`**/api/jobs/${job.id}**`, async (route: Route, request: Request) => {
    const path = new URL(request.url()).pathname;
    expect(request.headers().authorization).toMatch(/^Bearer /);
    sent.push(`${request.method()} ${path}`);
    if (path.startsWith(`/api/jobs/${job.id}/photos/`) && new URL(request.url()).searchParams.get('kind') === 'signature') {
      if (request.method() === 'GET') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      if (request.method() === 'PUT' && answers.signature) {
        signing.signatures.push({ path, bytes: request.postDataBuffer() ?? Buffer.alloc(0) });
        const [status, json] = answers.signature();
        return route.fulfill({ status, json });
      }
    }
    if (path === `/api/jobs/${job.id}/agreements`) {
      if (request.method() === 'GET') return route.fulfill({ json: { job, agreement: answers.agreement ?? null } });
      if (request.method() === 'POST' && answers.sign) {
        signing.agreements.push(request.postDataJSON());
        const [status, json] = answers.sign();
        return route.fulfill({ status, json });
      }
    }
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

// A 1×1 white PNG: the stored signature image the signed page reads back.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

// The signed record the server stores for `estimate` (src/lib/agreements/service.ts), as GET and POST answer it.
function signedFor(estimate: EstimateView, signatureId: string): SignedAgreement {
  const record: SignedRecord = {
    format: SIGNED_FORMAT,
    agreement_id: randomUUID(),
    job_id: estimate.jobId,
    kind: 'original',
    signed_at: '2026-11-14T18:30:00.000Z',
    signer: { name: 'Casey Customer' },
    signed_with: { kind: 'device', presented_by: { actor_id: randomUUID(), name: 'Robin Tech' } },
    signature: { id: signatureId, sha256: 'f'.repeat(64), content_type: 'image/png' },
    proposal_sha256: estimate.proposalSha256!,
    proposal: estimate.proposal!,
    documents: { itemized_claim: estimate.documents!.itemizedClaim, letter: estimate.documents!.letter, photo_log: estimate.documents!.photoLog, claim: estimate.documents!.claim, compliance_notes: [] },
    basis: { estimate_id: estimate.id, submission_id: estimate.submissionId },
  };
  return { id: record.agreement_id, signedAt: record.signed_at, documentsSha256: 'e'.repeat(64), record };
}

// Draws a stroke across the signature pad with the pointer, as a finger would.
async function drawSignature(page: Page) {
  const pad = page.getByTestId('signature-pad');
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) await page.mouse.move(box.x + 20 + step * 25, box.y + box.height / 2 + (step % 2 ? -20 : 20));
  await page.mouse.up();
}

const exactText = (page: Page, testId: string) => page.getByTestId(testId).first().evaluate((element) => element.textContent);

// The signed page prints the authorization and payment terms above the signature (S5a-11).
async function expectTermsAboveSignature(page: Page, signer: string) {
  const main = page.getByRole('main');
  const signature = main.getByRole('img', { name: `Signature of ${signer}` });
  await expect(signature).toBeVisible();
  const signatureTop = (await signature.boundingBox())!.y;
  for (const testId of ['authorization-text', 'payment-terms-text']) {
    const terms = main.getByRole('region', { name: 'Signed proposal' }).getByTestId(testId);
    await expect(terms).toBeVisible();
    const box = (await terms.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(signatureTop);
  }
}

test('the customer signs on the phone: success only after the server’s answer, and the same request is retried', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  const made = estimateFor(team, job.id, job.currentDraftId, 'estimator');
  const signing: Signing = { signatures: [], agreements: [] };
  let attempts = 0;
  let signed: SignedAgreement | null = null;
  await playApi(
    page,
    job,
    {
      estimate: made,
      signature: () => [signing.signatures.length === 1 ? 201 : 200, { photoId: 'x', kind: 'signature', sha256: 'f'.repeat(64) }],
      sign: () => {
        attempts += 1;
        // The first answer is lost: nothing is shown as signed, and nothing claims it was not signed.
        if (attempts === 1) return [503, { error: 'agreements_unavailable' }];
        const id = (signing.agreements[0] as { signatureId: string }).signatureId;
        signed = signedFor(made, id);
        return [201, { job: { ...job, status: 'signed' }, agreement: signed }];
      },
    },
    signing,
  );
  await signInTo(page, team.estimator);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Review before signing' })).toBeVisible();
  // The proposal prints the company's start-work authorization and payment terms exactly as entered.
  await main.getByText('Proposal', { exact: true }).click();
  expect(await exactText(page, 'authorization-text')).toBe('Synthetic start-work authorization.');
  expect(await exactText(page, 'payment-terms-text')).toBe('Synthetic payment terms.');

  await expect(main.getByRole('heading', { name: 'Customer signature' })).toHaveCount(0);
  await main.getByRole('checkbox', { name: /I reviewed the proposal/ }).check();
  await expect(main.getByRole('heading', { name: 'Customer signature' })).toBeVisible();
  // "Email me a copy" is not offered until email exists (J7).
  await expect(main.getByText(/email me a copy/i)).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  // Nothing is sent without a name and a signature.
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByText("Write the customer's name.")).toBeVisible();
  await expect(main.getByText('Draw the signature in the box.')).toBeVisible();
  expect(signing.signatures).toEqual([]);

  await main.getByLabel("Customer's full name").fill('  Casey Customer ');
  await drawSignature(page);
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('We could not confirm signing with DryScope.');
  await expect(main.getByRole('alert')).not.toContainText('Nothing was signed');
  await expect(main.getByRole('heading', { name: 'Signed' })).toHaveCount(0);

  await main.getByRole('button', { name: 'Try signing again' }).click();
  await expect(main.getByRole('heading', { name: 'Signed', exact: true })).toBeVisible();
  // Both tries sent the same signature bytes under the same id, and the same agreement request.
  expect(signing.signatures).toHaveLength(2);
  expect(signing.signatures[1]).toEqual(signing.signatures[0]);
  expect([...signing.signatures[0]!.bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(signing.agreements).toHaveLength(2);
  expect(signing.agreements[1]).toEqual(signing.agreements[0]);
  const body = signing.agreements[0] as Record<string, unknown>;
  expect(body).toMatchObject({ estimateId: made.id, proposalSha256: made.proposalSha256, signerName: 'Casey Customer', documentsConfirmed: true });
  expect(signing.signatures[0]!.path).toBe(`/api/jobs/${job.id}/photos/${body.signatureId as string}`);

  // The signed page: who, when and how, from the stored record.
  await expect(main.getByTestId('signed-by')).toHaveText('Signed by Casey Customer');
  await expect(main.getByTestId('signed-how')).toHaveText("Signed on the technician's phone, presented by Robin Tech.");
  await expect(main.getByTestId('signed-when')).toContainText('2026');
  await expect(main.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);
  await expectTermsAboveSignature(page, 'Casey Customer');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
});

test('a signed job opens read-only from its stored record', async ({ page }) => {
  const job = { id: randomUUID(), status: 'signed', currentDraftId: randomUUID(), revision: 4 };
  const made = estimateFor(team, job.id, job.currentDraftId, 'office');
  const signatureId = randomUUID();
  const sent = await playApi(page, job, { estimate: made, agreement: signedFor(made, signatureId) });
  await signInTo(page, team.office);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Signed', exact: true })).toBeVisible();
  await expect(main.getByTestId('signed-by')).toHaveText('Signed by Casey Customer');
  await expect(main.getByRole('img', { name: 'Signature of Casey Customer' })).toBeVisible();
  expect(await exactText(page, 'authorization-text')).toBe('Synthetic start-work authorization.');
  expect(await exactText(page, 'payment-terms-text')).toBe('Synthetic payment terms.');
  await expectTermsAboveSignature(page, 'Casey Customer');
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await expect(main.getByRole('textbox')).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
  expect(sent).toContain(`GET /api/jobs/${job.id}/photos/${signatureId}`);
  expect(sent.filter((call) => !call.startsWith('GET'))).toEqual([]);
});

test('signing is refused with the setup check’s answer', async ({ page }) => {
  const job = { id: randomUUID(), status: 'submitted', currentDraftId: randomUUID(), revision: 3 };
  await playApi(page, job, {
    estimate: estimateFor(team, job.id, job.currentDraftId, 'owner'),
    signature: () => [201, { photoId: 'x', kind: 'signature', sha256: 'f'.repeat(64) }],
    sign: () => [409, { error: 'company_setup_missing', missing: ['Payment terms'] }],
  });
  await signInTo(page, team.owner);
  await page.goto(`/sign-in/${team.address}/jobs/${job.id}/review`);
  const main = page.getByRole('main');
  await main.getByRole('checkbox', { name: /I reviewed the proposal/ }).check();
  await main.getByLabel("Customer's full name").fill('Casey Customer');
  await drawSignature(page);
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('Company settings are not finished: Payment terms.');
  await expect(main.getByRole('heading', { name: 'Signed', exact: true })).toHaveCount(0);
});
