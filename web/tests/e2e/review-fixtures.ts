import { expect as baseExpect, type Page, type Request, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { priceEstimate } from '@/engine/estimate';
import type { SignedAgreement } from '@/lib/agreements/screen';
import { estimateInput } from '@/lib/estimates/inputs';
import { proposalBytes, proposalOf } from '@/lib/estimates/proposal';
import { estimateView, type EstimateView } from '@/lib/estimates/result';
import { capabilitiesFor } from '@/lib/access';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';
import { PASSWORD, type TeamAccount, type TeamSeed } from './sign-in/seed';

// Shared by the Review before signing specs (review.spec.ts, review-reprice.spec.ts): the record, the
// estimate the engine prices from it, and the job and estimate answers played at the network boundary.
const expect = baseExpect.configure({ timeout: 20_000 });


export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
export const PHOTO = randomUUID();
export const PHOTO_TWO = randomUUID();

// With `more`, a second photo (the hall, shot tag overview) is in the record after the first.
export function record(jobId: string, draftId: string, more = false): Snapshot {
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
      photos: [
        { id: PHOTO, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-14T18:01:00.000Z' } },
        ...(more ? [{ id: PHOTO_TWO, field: { roomId: 'hall', shotTag: 'overview', capturedAt: '2026-11-14T18:00:00.000Z' } }] : []),
      ],
    },
    photos: [{ id: PHOTO, sha256: 'ab'.repeat(32), sizeBytes: 1000, contentType: 'image/jpeg' }, ...(more ? [{ id: PHOTO_TWO, sha256: 'cd'.repeat(32), sizeBytes: 1000, contentType: 'image/jpeg' }] : [])],
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid' },
    claim: {},
  };
}

// S5a-9b: a company that chose the letter layout, with a clause of its own and line prices shown.
export const CLAUSE = { title: 'Scheduling', text: 'We confirm the start date by phone.\nTwo days before.' };
export type Layout = { letter: boolean };

export function estimateOfSnapshot(
  team: TeamSeed,
  snapshot: Snapshot,
  role: 'owner' | 'estimator' | 'office',
  photoLogGrouping: 'room' | 'shot_tag' | null = null,
  layout: Layout = { letter: false },
  revised: string | null = null,
  made: { versionSequence: number; pinSequence: number; unitPrice: string; jobRevision: number } = { versionSequence: 1, pinSequence: 1, unitPrice: '2.00', jobRevision: 1 },
): EstimateView {
  const company: CompanyDocuments = {
    identity: { companyId: team.companyId, name: team.companyName, address: '1 Synthetic Way, Testville', phone: '555-0100', email: 'office@example.invalid', license: '000001', signoff: 'Pat Example' },
    letterhead: NEUTRAL_LETTERHEAD,
    settings: {
      ...NEUTRAL_SETTINGS,
      ...(photoLogGrouping ? { photoLogGrouping } : {}),
      ...(layout.letter ? { proposalLayout: 'letter' as const, companyClauses: [CLAUSE] } : {}),
    },
    // The company's own wording for the signed page (S5a-11), synthetic text.
    signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
  };
  const table = {
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: made.unitPrice }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      show_line_breakdown: layout.letter,
    },
  };
  const priced = priceEstimate(table, estimateInput(snapshot, company).job);
  if (!priced.ok) throw new Error(priced.error);
  const { bytes, sha256 } = proposalBytes(
    proposalOf({ estimate: priced, company, showLineBreakdown: layout.letter, submission: { id: snapshot.submissionId, snapshotSha256: 'e'.repeat(64) }, version: { sequence: made.versionSequence }, revised }),
  );
  return estimateView(
    {
      id: randomUUID(),
      jobId: snapshot.jobId,
      submissionId: snapshot.submissionId,
      pinSequence: made.pinSequence,
      versionSequence: made.versionSequence,
      tableHash: priced.table_sha256,
      engineVersion: priced.engine_version,
      pricedResult: JSON.parse(JSON.stringify({ ...priced, job_revision: made.jobRevision })),
      proposalBytes: bytes,
      proposalSha256: sha256,
      createdAt: new Date(),
    },
    capabilitiesFor(role, { priceBooks: true }),
  );
}

// The server's answer for this record priced at $2.00 a square foot of wet floor, as `role` sees it.
export function estimateFor(
  team: TeamSeed,
  jobId: string,
  draftId: string,
  role: 'owner' | 'estimator' | 'office',
  photoLogGrouping: 'room' | 'shot_tag' | null = null,
  layout: Layout = { letter: false },
): EstimateView {
  const snapshot = record(jobId, draftId, photoLogGrouping !== null);
  if (layout.letter) {
    // The rooms' words the letter prints (S5a-10): a prep task in the kitchen, a findings note in the hall.
    snapshot.field.rooms = [
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40, findings: 'Baseboards swollen along the east wall.' } },
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, prepTasks: ['The homeowner clears the cabinet under the sink.'] } },
    ];
  }
  return estimateOfSnapshot(team, snapshot, role, photoLogGrouping, layout);
}

export type Job = { id: string; status: string; currentDraftId: string; revision: number };

// The job, estimate and signing routes at the network boundary. `estimate` is what GET answers;
// `make` decides POST's answer; `signature` and `sign` decide the signature receipt's and the
// agreement's answers (S5a-11), and `agreement` is what GET .../agreements answers.
export type Answers = {
  estimate: EstimateView | null;
  make?: () => [number, unknown];
  read?: number;
  signature?: () => [number, unknown];
  sign?: () => [number, unknown];
  agreement?: SignedAgreement | null;
};

// What the page sent to the signing routes: the signature's path and bytes, and the agreement bodies.
export type Signing = { signatures: Array<{ path: string; bytes: Buffer }>; agreements: unknown[] };

export async function playApi(page: Page, job: Job, answers: Answers, signing: Signing = { signatures: [], agreements: [] }) {
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

export async function signInTo(page: Page, team: TeamSeed, who: Pick<TeamAccount, 'email'>) {
  await page.goto(`/sign-in/${team.address}`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Signed in to ${team.companyName}` })).toBeVisible();
}

export async function expectNoSideways(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
