import { test as base, expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priceEstimate } from '@/engine/estimate';
import { SIGNED_FORMAT, type SignedRecord } from '@/lib/agreements/record';
import type { SignedAgreement } from '@/lib/agreements/screen';
import { estimateInput } from '@/lib/estimates/inputs';
import { proposalBytes, proposalOf, type Proposal } from '@/lib/estimates/proposal';
import type { LinkEstimate } from '@/lib/links/screen';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';
import { expectNoAxeViolations } from './a11y';

// The homeowner's /sign page and the read-only /documents page (S5a-11b) in Chromium and WebKit at
// phone width, with no sign-in. The link routes need Postgres, which this test server does not run,
// so their answers are played at the network boundary (tests/db/signing-links.test.ts and
// document-links.test.ts hold the real routes). The estimate played is a real one: the engine prices
// a record and the page shows the documents it built, the company's terms inside the proposal.

const test = base;
test.use({ viewport: { width: 390, height: 844 } });
const expect = baseExpect.configure({ timeout: 20_000 });

const TOKEN = 'T0kenForTheLinkPageTestsOnly_abcdefghijklmn'.slice(0, 43);
const COMPANY = 'Synthetic Restoration Test Co';
const AUTHORIZATION = 'Synthetic start-work authorization.\nSecond line, as entered.';
const PAYMENT = 'Synthetic payment terms.';
const OTHER_TOKEN = 'D0cumentsLinkTokenForTheLinkPageTestsOnly_abcdef'.slice(0, 43);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');

function estimate(): LinkEstimate {
  const company: CompanyDocuments = {
    identity: { companyId: randomUUID(), name: COMPANY, address: '1 Synthetic Way, Testville', phone: '555-0100', email: 'office@example.invalid', license: '000001', signoff: 'Pat Example' },
    letterhead: NEUTRAL_LETTERHEAD,
    settings: NEUTRAL_SETTINGS,
    signing: { authorizationText: AUTHORIZATION, paymentTermsText: PAYMENT },
  };
  const photo = randomUUID();
  const snapshot: Snapshot = {
    format: SNAPSHOT_FORMAT,
    submissionId: randomUUID(),
    jobId: randomUUID(),
    draftId: randomUUID(),
    fieldSha256: 'd'.repeat(64),
    field: {
      draft: { yearBuilt: 1968, roomOrder: ['kitchen'], summary: 'Category 2 water in the kitchen.', scopeConfirmed: true },
      rooms: [{ id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } }],
      photos: [{ id: photo, field: { roomId: 'kitchen', shotTag: 'source' } }],
    },
    photos: [{ id: photo, sha256: 'ab'.repeat(32), sizeBytes: 1000, contentType: 'image/jpeg' }],
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid' },
    claim: {},
  };
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
  if (!priced.ok || !priced.documents) throw new Error('the engine did not price the test record');
  const proposal = proposalOf({ estimate: priced, company, showLineBreakdown: false, submission: { id: snapshot.submissionId, snapshotSha256: 'e'.repeat(64) }, version: { sequence: 1 } });
  const { sha256 } = proposalBytes(proposal);
  const documents = priced.documents;
  return {
    id: randomUUID(),
    proposalSha256: sha256,
    proposal: JSON.parse(JSON.stringify(proposal)) as Proposal,
    documents: JSON.parse(JSON.stringify({ itemized_claim: documents.itemized_claim, letter: documents.letter, photo_log: documents.photo_log, claim: documents.claim, compliance_notes: [] })),
  };
}

function signedFor(shown: LinkEstimate, signatureId: string, name: string, role?: 'homeowner' | 'adjuster' | 'other'): SignedAgreement {
  const record: SignedRecord = {
    format: SIGNED_FORMAT,
    agreement_id: randomUUID(),
    job_id: randomUUID(),
    kind: 'original',
    signed_at: '2026-11-15T18:30:00.000Z',
    signer: role ? { name, role } : { name },
    signed_with: { kind: 'link', link_id: randomUUID() },
    signature: { id: signatureId, sha256: 'f'.repeat(64), content_type: 'image/png' },
    proposal_sha256: shown.proposalSha256,
    proposal: shown.proposal,
    documents: shown.documents,
    basis: { estimate_id: shown.id, submission_id: randomUUID() },
  };
  return { id: record.agreement_id, signedAt: record.signed_at, documentsSha256: 'e'.repeat(64), record };
}

// Every call the page made to the link routes, with what it carried.
type Sent = { method: string; path: string; search: string; token: string | undefined; referer: string | undefined; authorization: string | undefined; body: unknown };

type Played = [number, unknown] | Buffer | 'lost';

// An answer of 'lost' drops the connection, as when the server acted but its answer never arrived.
async function playLinks(page: Page, answer: (sent: Sent) => Played | Promise<Played>) {
  const sent: Sent[] = [];
  const handle = async (route: Route, request: Request) => {
    const url = new URL(request.url());
    const headers = request.headers();
    let body: unknown = null;
    if (request.method() === 'POST') body = request.postDataJSON();
    const call = { method: request.method(), path: url.pathname, search: url.search, token: headers['x-link-token'], referer: headers.referer, authorization: headers.authorization, body };
    sent.push(call);
    const made = await answer(call);
    if (made === 'lost') return route.abort('connectionreset');
    if (Buffer.isBuffer(made)) return route.fulfill({ status: 200, contentType: 'image/png', body: made });
    return route.fulfill({ status: made[0], json: made[1], headers: { 'cache-control': 'no-store' } });
  };
  await page.route('**/api/sign**', handle);
  await page.route('**/api/documents**', handle);
  return sent;
}

async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function drawSignature(page: Page) {
  const pad = page.getByRole('img', { name: /signature/i }).or(page.locator('canvas')).first();
  await pad.scrollIntoViewIfNeeded();
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 8 });
  await page.mouse.move(box.x + 200, box.y + 40, { steps: 8 });
  await page.mouse.up();
}

test('the homeowner reads the documents with the company’s terms, signs once, and sees the signed page', async ({ page }) => {
  const shown = estimate();
  let signed: SignedAgreement | null = null;
  const sent = await playLinks(page, (call) => {
    if (call.method === 'GET' && call.path === '/api/sign') return [200, { status: 'pending', companyName: COMPANY, expiresAt: '2026-11-22T18:00:00.000Z', estimate: shown }];
    if (call.method === 'PUT' && call.path.startsWith('/api/sign/signature/')) return [201, { signatureId: call.path.split('/').pop(), sha256: 'f'.repeat(64) }];
    if (call.method === 'POST' && call.path === '/api/sign') {
      const body = call.body as { signatureId: string; signerName: string; signerRole: 'homeowner' };
      signed = signedFor(shown, body.signatureId, body.signerName, body.signerRole);
      const link = (set: string) => ({ id: randomUUID(), set, status: 'active', createdAt: '2026-11-15T18:30:00.000Z', expiresAt: '2026-12-15T18:30:00.000Z', endedAt: null });
      return [201, { agreement: signed, documentLinks: [{ link: link('homeowner'), token: OTHER_TOKEN }] }];
    }
    if (call.method === 'GET' && call.path === '/api/sign/signature') return PNG;
    if (call.method === 'GET' && call.path.startsWith('/api/sign/photos/')) return PNG;
    return [500, { error: 'unexpected' }];
  });
  await page.goto(`/sign#${TOKEN}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Review and sign your estimate' })).toBeVisible();
  // Each photo of the log opens on request, through the link's own photo route.
  const photoId = (shown.documents.photo_log[0] as { id: string }).id;
  await main.getByText('Photo audit log').click();
  await main.getByRole('button', { name: 'Show photo 1' }).click();
  await expect(main.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  await expect(main.getByText(`From ${COMPANY}.`, { exact: false })).toBeVisible();
  await expect(main.getByText('Synthetic start-work authorization.', { exact: false })).toBeVisible();
  await expect(main.getByText(PAYMENT, { exact: false })).toBeVisible();
  // No staff notes: the written summary is the company's own.
  await expect(main.getByText('Category 2 water in the kitchen.')).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  // Signing needs both boxes, the name and a signature.
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByText('Tick both boxes to sign.')).toBeVisible();
  await main.getByRole('checkbox', { name: /I reviewed the proposal/ }).check();
  await main.getByRole('checkbox', { name: /I agree to sign electronically/ }).check();
  await main.getByLabel('Your full name').fill('  Casey Customer ');
  await drawSignature(page);
  // Who signs is asked too.
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByText('Choose who is signing.')).toBeVisible();
  await main.getByRole('radio', { name: 'Homeowner' }).check();
  await expectNoAxeViolations(page);
  await main.getByRole('button', { name: 'Sign', exact: true }).click();

  await expect(main.getByRole('heading', { name: 'Your signed estimate' })).toBeVisible();
  await expect(main.getByTestId('signed-by')).toHaveText('Signed by Casey Customer, homeowner');
  // The link to the signed documents made at signing, shown this once.
  await expect(main.getByRole('heading', { name: 'Links to your signed documents' })).toBeVisible();
  await expect(main.getByRole('textbox', { name: "Homeowner's documents link" })).toHaveValue(new RegExp(`/documents#${OTHER_TOKEN}$`));
  await expect(main.getByTestId('signed-how')).toContainText('Signed through signing link');
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  // The token went in its header on every call, never in the address, and no referrer or sign-in was sent.
  expect(sent.length).toBeGreaterThanOrEqual(3);
  for (const call of sent) {
    expect(call).toMatchObject({ token: TOKEN, search: '', authorization: undefined, referer: undefined });
    expect(call.path).not.toContain(TOKEN);
  }
  const posted = sent.filter((call) => call.method === 'POST');
  expect(posted).toHaveLength(1);
  expect(posted[0]!.body).toMatchObject({ signerName: 'Casey Customer', signerRole: 'homeowner', documentsConfirmed: true, electronicConsent: true });
  expect(sent.filter((call) => call.path.startsWith('/api/sign/photos/')).map((call) => call.path)).toEqual([`/api/sign/photos/${photoId}`]);
  expect(posted[0]!.body).not.toHaveProperty('estimateId');
});

test('a link with no token, an unknown one or a voided one says what to do, and offers nothing to sign', async ({ page }) => {
  let next: Played = [404, { error: 'link_unavailable' }];
  await playLinks(page, () => next);
  await page.goto('/sign');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'This link cannot be used' })).toBeVisible();
  await expect(main.getByRole('alert')).toContainText('Ask your restoration company for a new link.');
  await expectNoAxeViolations(page);

  await page.goto(`/sign#${TOKEN}`);
  await expect(main.getByRole('alert')).toContainText('This link is not available.');
  next = [410, { error: 'link_voided' }];
  await page.reload();
  await expect(main.getByRole('alert')).toContainText('This estimate was updated after the link was sent.');
  await expect(main.getByRole('button', { name: 'Sign' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('a used link shows the signed page read-only', async ({ page }) => {
  const shown = estimate();
  const agreement = signedFor(shown, randomUUID(), 'Casey Customer');
  await playLinks(page, (call) =>
    call.path === '/api/sign/signature' ? PNG : [200, { status: 'signed', companyName: COMPANY, viewUntil: '2026-12-15T18:30:00.000Z', agreement }],
  );
  await page.goto(`/sign#${TOKEN}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Your signed estimate' })).toBeVisible();
  await expect(main.getByRole('img', { name: 'Signature of Casey Customer' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Sign' })).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test('the documents page shows the homeowner’s set and the adjuster’s set, read-only', async ({ page }) => {
  const shown = estimate();
  const signed = { name: 'Casey Customer', role: 'homeowner', signedAt: '2026-11-15T18:30:00.000Z', how: 'Signed through signing link.' };
  let set: 'homeowner' | 'adjuster' = 'homeowner';
  await playLinks(page, (call) => {
    if (call.path === '/api/documents/signature' || call.path.startsWith('/api/documents/photos/')) return PNG;
    if (set === 'homeowner') {
      return [200, { set, companyName: COMPANY, expiresAt: '2026-12-15T18:30:00.000Z', signed, signatureSha256: 'f'.repeat(64), proposalSha256: shown.proposalSha256, proposal: shown.proposal, photoLog: shown.documents.photo_log }];
    }
    return [200, { set, companyName: COMPANY, expiresAt: '2026-12-15T18:30:00.000Z', signed, price: shown.proposal.price, itemizedClaim: shown.documents.itemized_claim, letter: shown.documents.letter, claim: shown.documents.claim }];
  });
  await page.goto(`/documents#${TOKEN}`);
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Signed proposal' })).toBeVisible();
  await expect(main.getByText('Synthetic start-work authorization.', { exact: false })).toBeVisible();
  await expect(main.getByRole('img', { name: 'Signature of Casey Customer' })).toBeVisible();
  await expect(main.getByText('Signed by Casey Customer, homeowner').first()).toBeVisible();
  await main.getByRole('button', { name: 'Show photo 1' }).click();
  await expect(main.getByRole('img', { name: 'Photo 1' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Itemized claim' })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);

  set = 'adjuster';
  await page.reload();
  await expect(main.getByRole('heading', { name: 'Itemized claim' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Scope defense letter' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Signed proposal' })).toHaveCount(0);
  await expect(main.getByText('Synthetic start-work authorization.', { exact: false })).toHaveCount(0);
  await expectNoAxeViolations(page);
  await expectNoSideways(page);
});

test('a new link in the same tab starts a new page: nothing shown, ticked or drawn for the first link stays', async ({ page }) => {
  const first = estimate();
  const second = estimate();
  const OTHER = 'An0therLinkForTheSameTabTestOnly_abcdefghij'.slice(0, 43);
  const OTHER_COMPANY = 'Second Synthetic Restoration Co';
  let release: () => void = () => {};
  const secondHeld = new Promise<void>((resolve) => (release = resolve));
  const sent = await playLinks(page, async (call) => {
    if (call.method === 'GET' && call.path === '/api/sign' && call.token === TOKEN) return [200, { status: 'pending', companyName: COMPANY, expiresAt: '2026-11-22T18:00:00.000Z', estimate: first }];
    if (call.method === 'GET' && call.path === '/api/sign' && call.token === OTHER) {
      await secondHeld;
      return [200, { status: 'pending', companyName: OTHER_COMPANY, expiresAt: '2026-11-22T18:00:00.000Z', estimate: second }];
    }
    return [500, { error: 'unexpected' }];
  });
  await page.goto(`/sign#${TOKEN}`);
  const main = page.getByRole('main');
  await expect(main.getByText(`From ${COMPANY}.`, { exact: false })).toBeVisible();
  await main.getByRole('checkbox', { name: /I reviewed the proposal/ }).check();
  await main.getByRole('checkbox', { name: /I agree to sign electronically/ }).check();
  await main.getByLabel('Your full name').fill('Casey Customer');
  await drawSignature(page);

  await page.evaluate((token) => {
    window.location.hash = token;
  }, OTHER);
  // While the second link's estimate is on its way, nothing of the first is shown and nothing can be signed.
  await expect(main.getByRole('status')).toHaveText('Opening the estimate…');
  await expect(main.getByText(`From ${COMPANY}.`, { exact: false })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'Sign', exact: true })).toHaveCount(0);

  release();
  await expect(main.getByText(`From ${OTHER_COMPANY}.`, { exact: false })).toBeVisible();
  await expect(main.getByRole('checkbox', { name: /I reviewed the proposal/ })).not.toBeChecked();
  await expect(main.getByRole('checkbox', { name: /I agree to sign electronically/ })).not.toBeChecked();
  await expect(main.getByLabel('Your full name')).toHaveValue('');
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByText('Draw your signature in the box.')).toBeVisible();
  expect(sent.filter((call) => call.method !== 'GET')).toEqual([]);
});

test('signing again after the answer was lost returns the agreement already made, not "already signed"', async ({ page }) => {
  const shown = estimate();
  let signed: SignedAgreement | null = null;
  let signedId: string | null = null;
  const sent = await playLinks(page, (call) => {
    if (call.method === 'GET' && call.path === '/api/sign') return [200, { status: 'pending', companyName: COMPANY, expiresAt: '2026-11-22T18:00:00.000Z', estimate: shown }];
    if (call.method === 'PUT' && call.path.startsWith('/api/sign/signature/')) {
      // A used link takes no more signatures (src/lib/links/signing.ts, receiveSignature).
      return signed ? [409, { error: 'already_signed' }] : [201, { signatureId: call.path.split('/').pop(), sha256: 'f'.repeat(64) }];
    }
    if (call.method === 'POST' && call.path === '/api/sign') {
      const body = call.body as { id: string; signatureId: string; signerName: string };
      if (!signed) {
        signed = signedFor(shown, body.signatureId, body.signerName);
        signedId = body.id;
        return 'lost';
      }
      // The same request again answers the link's own agreement; any other is refused.
      return body.id === signedId ? [200, { agreement: signed }] : [409, { error: 'already_signed' }];
    }
    if (call.method === 'GET' && call.path === '/api/sign/signature') return PNG;
    return [500, { error: 'unexpected' }];
  });
  await page.goto(`/sign#${TOKEN}`);
  const main = page.getByRole('main');
  await main.getByRole('checkbox', { name: /I reviewed the proposal/ }).check();
  await main.getByRole('checkbox', { name: /I agree to sign electronically/ }).check();
  await main.getByLabel('Your full name').fill('Casey Customer');
  await main.getByRole('radio', { name: 'Homeowner' }).check();
  await drawSignature(page);
  await main.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(main.getByRole('alert')).toContainText('We could not reach DryScope.');

  await main.getByRole('button', { name: 'Try signing again' }).click();
  await expect(main.getByRole('heading', { name: 'Your signed estimate' })).toBeVisible();
  await expect(main.getByTestId('signed-by')).toHaveText('Signed by Casey Customer');
  expect(sent.filter((call) => call.method === 'PUT')).toHaveLength(1);
  const posted = sent.filter((call) => call.method === 'POST').map((call) => (call.body as { id: string }).id);
  expect(posted).toEqual([signedId, signedId]);
});
