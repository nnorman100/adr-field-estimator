import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, json, sha256, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-9, the estimate and the four documents (docs/plans/S5.md; pricing plan S5a-2 and section 6
// "pins and signing") through the real route files as the runtime role against Postgres. A job is
// made, filled and submitted through the real jobs, photo and Submit routes (as in
// submissions-api.test.ts); the price versions are published tables of the engine's own schema.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/estimates/services', async () => {
  const { estimatesService } = await import('@/lib/estimates/service');
  return { estimatesServices: () => estimatesService(live.harness!.handle.db) };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

const f = flow(() => h, {
  createJob: jobsRoute.POST,
  putPhoto: photoRoute.PUT,
  submit: submissionsRoute.POST,
  nextDraft: draftsRoute.POST,
  request,
  params,
});

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  // Company A has price books on (company B too, so a refusal there is the job's, not the flag's).
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true), (${h.seed.b}, 'price_books', true)`;
  // Company A's profile, as its owner saved it on Company settings, with the signed page's two texts
  // (S5a-11: documents without them are not signable).
  await h.admin`
    UPDATE companies SET profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100', profile_email = 'office@example.invalid',
      profile_license = '000001', profile_signoff = 'Pat Example',
      profile_documents = ${JSON.stringify({ authorization_text: 'Synthetic start-work authorization.', payment_terms_text: 'Synthetic payment terms.' })}::text::jsonb
    WHERE id = ${h.seed.a}
  `;
  const [actor] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// A one-item table: `price` per square foot of wet floor, one price, nothing else.
function priceTable(price: string) {
  return {
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: price }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  };
}

// Publishes the company's next price version, as S4-6's publish stores it.
async function publish(company: string, price: string): Promise<{ id: string; sequence: number; hash: string }> {
  const table = parseTable(priceTable(price));
  const hash = contentHash(table);
  const owner = company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor;
  const [row] = await h.admin<{ id: string; sequence: number }[]>`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${company}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${hash}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${company}
    RETURNING id::text, sequence
  `;
  return { id: row!.id, sequence: row!.sequence, hash };
}

// What the technician leaves before Finish and review: two rooms (80 + 40 sq ft wet), one photo,
// the written summary (J1) and the scope confirmed.
function manifestOf(photoId: string, draft: Record<string, unknown> = {}): FieldManifest {
  return {
    draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true, ...draft },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
    ],
    photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'source' } }],
  };
}

// A submitted job of company A, made by `claims`.
async function submittedJob(claims: FakeClaims = ESTIMATOR_A, draft: Record<string, unknown> = {}) {
  const ready = await f.readyJob(claims, h.seed.a);
  // The customer and the property address, saved through the customer route as the phone saves them.
  const customer = { revision: (await f.job(ready.jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '12 Synthetic Lane, Testville' };
  const saved = await customerRoute.PUT(request(claims, `/api/jobs/${ready.jobId}/customer`, { method: 'PUT', body: customer }), params({ jobId: ready.jobId }));
  expect(saved.status).toBe(200);
  const manifest = manifestOf(ready.photoId, draft);
  h.field.put(h.seed.a, ready.draftId, manifest);
  const { body, answer } = await f.submitShown(claims, ready.jobId, ready.draftId, manifest);
  expect(answer.status).toBe(201);
  return { ...ready, manifest, submissionId: body.id };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
const make = (claims: FakeClaims | null, jobId: string): Promise<Answer & { body: Body }> =>
  json(estimateRoute.POST(request(claims, `/api/jobs/${jobId}/estimate`, { method: 'POST' }), params({ jobId })));
const read = (claims: FakeClaims | null, jobId: string): Promise<Answer & { body: Body }> =>
  json(estimateRoute.GET(request(claims, `/api/jobs/${jobId}/estimate`), params({ jobId })));

const pins = (jobId: string) =>
  h.admin<{ sequence: number; version_id: string; reason: string }[]>`SELECT sequence, version_id::text, reason FROM job_price_pins WHERE job_id = ${jobId} ORDER BY sequence`;
const estimates = (jobId: string) =>
  h.admin<{ id: string; submission_id: string; table_hash: string; proposal_bytes: Buffer; proposal_sha256: string }[]>`
    SELECT id::text, submission_id::text, table_hash, proposal_bytes, proposal_sha256 FROM job_estimates WHERE job_id = ${jobId} ORDER BY created_at, id
  `;

const PROTECTION = (company: string) =>
  `Per IICRC and EPA protocols, ${company} technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.`;
const EXCLUSIONS = (company: string) =>
  `NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of ${company}. This estimate does not include testing of any kind.`;

describe('making the estimate', () => {
  it('pins the job to the current prices at first price, prices the record and stores the documents once', async () => {
    const version = await publish(h.seed.a, '2.00');
    const { jobId, submissionId, photoId, photoBytes } = await submittedJob();
    const answer = await make(ESTIMATOR_A, jobId);
    expect(answer.status).toBe(201);
    const estimate = answer.body.estimate;
    expect(answer.body.job).toMatchObject({ id: jobId, status: 'submitted' });
    expect(estimate).toMatchObject({ jobId, submissionId, price: { pinSequence: 1, versionSequence: 1, tableHash: version.hash, engineVersion: ENGINE_VERSION } });
    // $2.00 a square foot of wet floor: 80 + 40 sq ft = $240.00; each line names its room and row.
    expect(estimate.lines.map((line: Body) => `${line.description} = ${line.total}`)).toEqual(['Kitchen: Extraction = 160.00', 'Hall: Extraction = 80.00']);
    expect(estimate.totals).toMatchObject({ mode: 'single', low: { total: '240.00' } });
    // The photo log lists the record's photo with the hash the evidence registry stored for its bytes.
    expect(estimate.documents.photoLog).toEqual([{ id: photoId, room: 'Kitchen', sha256: sha256(photoBytes), shot_tag: 'source' }]);
    expect(estimate.documents.signable).toBe(true);
    expect(estimate.staffNotes).toMatchObject({ summary: 'Category 2 water in two rooms.', companySetupMissing: [] });

    expect(await pins(jobId)).toEqual([{ sequence: 1, version_id: version.id, reason: 'first_price' }]);
    const [row] = await estimates(jobId);
    expect(row).toMatchObject({ id: estimate.id, submission_id: submissionId, table_hash: version.hash, proposal_sha256: estimate.proposalSha256 });
    // The proposal shown is the stored bytes, and their hash is the stored hash.
    expect(JSON.parse(row!.proposal_bytes.toString('utf8'))).toEqual(estimate.proposal);
    expect(createHash('sha256').update(row!.proposal_bytes).digest('hex')).toBe(row!.proposal_sha256);
    expect(await f.auditActions(jobId)).toEqual(expect.arrayContaining(['job_price_pinned', 'estimate_created']));
  });

  it('prints the mandated clauses exactly, with the company’s own name from its profile', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const { proposal } = (await make(OWNER_A, jobId)).body.estimate;
    const name = 'Company company-a';
    expect(proposal.heading).toBe(`${name} · Official proposal`);
    expect(proposal.letterhead).toEqual([name, '1 Synthetic Way, Testville', '555-0100', 'office@example.invalid', 'CSLB #000001']);
    expect(proposal.findings[0]).toBe(
      'Due to property age (1972), California State Law requires third-party lead and asbestos testing prior to destructive demolition.',
    );
    expect(proposal.recommendations[0]).toBe(
      "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly.",
    );
    expect(proposal.recommendations[1]).toBe(PROTECTION(name));
    expect(proposal.disclaimers.slice(2)).toEqual([
      '(this does not include the pretest for lead/asbestos)',
      EXCLUSIONS(name),
      'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.',
      'Estimate is valid for 30 days from date of inspection.',
    ]);
    // Company B's name is nowhere in company A's documents.
    expect(JSON.stringify((await read(OWNER_A, jobId)).body)).not.toContain('company-b');
  });

  it('the estimate retried returns the same row, and two at once make one estimate and one pin', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const first = await make(ESTIMATOR_A, jobId);
    const again = await make(ESTIMATOR_A, jobId);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.estimate).toEqual(first.body.estimate);

    const other = await submittedJob();
    const both = await Promise.all([make(ESTIMATOR_A, other.jobId), make(OWNER_A, other.jobId)]);
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(both[0]!.body.estimate.id).toBe(both[1]!.body.estimate.id);
    expect(await estimates(other.jobId)).toHaveLength(1);
    expect(await pins(other.jobId)).toHaveLength(1);
  });

  it('a draft pinned to version 1 still prices from version 1 after version 2 is published', async () => {
    const one = await publish(h.seed.a, '2.00');
    const { jobId, draftId, manifest } = await submittedJob();
    const first = (await make(ESTIMATOR_A, jobId)).body.estimate;
    const stored = await estimates(jobId);

    await publish(h.seed.a, '5.00');
    // The estimate made before the publish is unchanged, byte for byte.
    expect((await make(ESTIMATOR_A, jobId)).body.estimate).toEqual(first);
    expect(await estimates(jobId)).toEqual(stored);

    // Back to editing, then a new record of the same job: priced from version 1 again, not 2.
    const nextDraft = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: nextDraft, fromDraftId: draftId })).status).toBe(201);
    // The old review is void while the job is being edited.
    expect((await read(ESTIMATOR_A, jobId)).body.estimate).toBeNull();
    const changed: FieldManifest = { ...manifest, rooms: manifest.rooms.map((room) => (room.id === 'hall' ? { ...room, field: { ...(room.field as object), wetFloorSf: 20 } } : room)) };
    h.field.put(h.seed.a, nextDraft, changed);
    expect((await f.submitShown(ESTIMATOR_A, jobId, nextDraft, changed)).answer.status).toBe(201);
    const second = await make(ESTIMATOR_A, jobId);
    expect(second.status).toBe(201);
    expect(second.body.estimate).toMatchObject({ price: { pinSequence: 1, versionSequence: 1, tableHash: one.hash } });
    // $2.00 a square foot (version 1), not $5.00: 80 + 20 sq ft = $200.00.
    expect(second.body.estimate.totals.low.total).toBe('200.00');
    expect(await pins(jobId)).toEqual([{ sequence: 1, version_id: one.id, reason: 'first_price' }]);
    expect(await estimates(jobId)).toHaveLength(2);
  });

  it('a job whose first pin exists with no estimate is priced from that pin, and the estimate makes no second pin', async () => {
    const one = await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    await h.admin`
      INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id)
      VALUES (${h.seed.a}, ${jobId}, 1, ${one.id}, 'first_price', ${h.seed.ownerA.actor})
    `;
    await publish(h.seed.a, '5.00');
    const answer = await make(ESTIMATOR_A, jobId);
    expect(answer.status).toBe(201);
    expect(answer.body.estimate).toMatchObject({ price: { pinSequence: 1, versionSequence: 1, tableHash: one.hash }, totals: { low: { total: '240.00' } } });
    expect(await pins(jobId)).toEqual([{ sequence: 1, version_id: one.id, reason: 'first_price' }]);
    expect(await estimates(jobId)).toHaveLength(1);
  });

  it('a job first priced after version 2 is published is pinned to version 2', async () => {
    await publish(h.seed.a, '2.00');
    const two = await publish(h.seed.a, '5.00');
    const { jobId } = await submittedJob();
    const answer = await make(ESTIMATOR_A, jobId);
    expect(answer.body.estimate).toMatchObject({ price: { versionSequence: 2, tableHash: two.hash }, totals: { low: { total: '600.00' } } });
  });
});

// S5a-9b: each company's layout, clauses and letterhead come only from its own settings.
describe('the proposal layout and the company’s own clauses', () => {
  const CLAUSE = { title: 'Scheduling', text: '  We confirm the start date by phone.\nTwo days before.' };

  // A submitted job of `company` whose rooms carry a findings note and a prep task (S5a-10).
  async function jobWithRoomWords(claims: FakeClaims, company: string) {
    const ready = await f.readyJob(claims, company);
    const customer = { revision: (await f.job(ready.jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '12 Synthetic Lane, Testville' };
    expect((await customerRoute.PUT(request(claims, `/api/jobs/${ready.jobId}/customer`, { method: 'PUT', body: customer }), params({ jobId: ready.jobId }))).status).toBe(200);
    const manifest = manifestOf(ready.photoId);
    manifest.rooms = [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, prepTasks: ['Clear the cabinet under the sink.'] } },
      { id: 'hall', field: { name: 'Hall', category: 2, findings: 'Musty odour; the materials read dry.' } },
    ];
    h.field.put(company, ready.draftId, manifest);
    expect((await f.submitShown(claims, ready.jobId, ready.draftId, manifest)).answer.status).toBe(201);
    return ready.jobId;
  }

  it('company A’s letter, clause and letterhead print on A’s proposal and never reach company B’s', async () => {
    await h.admin`
      UPDATE companies SET profile_tagline = 'Synthetic tagline A', profile_emergency_phone = '555-0911',
        profile_documents = ${JSON.stringify({ proposal_layout: 'letter', company_clauses: [CLAUSE], authorization_text: 'Synthetic start-work authorization.', payment_terms_text: 'Synthetic payment terms.' })}::text::jsonb
      WHERE id = ${h.seed.a}
    `;
    await publish(h.seed.a, '2.00');
    await publish(h.seed.b, '2.00');
    const jobA = await jobWithRoomWords(ESTIMATOR_A, h.seed.a);
    const jobB = await jobWithRoomWords(OWNER_B, h.seed.b);

    const a = (await make(ESTIMATOR_A, jobA)).body.estimate;
    expect(a.proposal.letterhead).toEqual(['Company company-a', 'Synthetic tagline A', '1 Synthetic Way, Testville', '555-0100', 'Emergency: 555-0911', 'office@example.invalid', 'CSLB #000001']);
    expect(a.proposal.company_clauses).toEqual([CLAUSE]);
    expect(a.proposal.letter).toMatchObject({
      area_inspected: ['Kitchen', 'Hall'],
      room_findings: [{ room: 'Hall', text: 'Musty odour; the materials read dry.' }],
      room_work: [{ room: 'Kitchen', prep_tasks: ['* Clear the cabinet under the sink.'], lines: [{ text: 'Extraction: up to 80 sf' }] }],
    });
    expect(a.proposal).not.toHaveProperty('findings');
    expect(a.documents.signable).toBe(true);

    const b = (await make(OWNER_B, jobB)).body.estimate;
    expect(b.proposal.heading).toBe('Company company-b · Official proposal');
    expect(b.proposal.letterhead).toEqual(['Company company-b']);
    expect(b.proposal).not.toHaveProperty('letter');
    expect(b.proposal).not.toHaveProperty('company_clauses');
    expect(b.proposal.recommendations).toContain('Kitchen: Extraction');
    const text = JSON.stringify(b);
    for (const own of ['Synthetic tagline A', '555-0911', 'We confirm the start date', 'company-a']) expect(text).not.toContain(own);
    // The stored bytes are what the answer shows.
    const [row] = await estimates(jobB);
    expect(JSON.parse(row!.proposal_bytes.toString('utf8'))).toEqual(b.proposal);
  });
});

// A change to the customer or the claim while the job is submitted (J3), saved through the routes.
async function saveCustomer(claims: FakeClaims, jobId: string, propertyAddress: string) {
  const body = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress };
  const answer = await customerRoute.PUT(request(claims, `/api/jobs/${jobId}/customer`, { method: 'PUT', body }), params({ jobId }));
  expect(answer.status).toBe(200);
}
async function saveClaim(claims: FakeClaims, jobId: string, claimNumber: string) {
  const body = {
    revision: (await f.job(jobId)).revision,
    changeId: randomUUID(),
    carrier: 'Synthetic Mutual',
    claimNumber,
    policyNumber: 'POL-1',
    dateOfLoss: '2026-11-01',
    lossCause: 'Supply line',
    adjusterName: 'Alex Adjuster',
    adjusterEmail: 'alex@example.invalid',
    adjusterPhone: '555-0102',
    deductible: '1000',
  };
  const answer = await claimRoute.PUT(request(claims, `/api/jobs/${jobId}/claim`, { method: 'PUT', body }), params({ jobId }));
  expect(answer.status).toBe(200);
}

// Back to editing, then Finish and review again with the same field data: a new record of the job.
async function finishAgain(claims: FakeClaims, jobId: string, draftId: string, manifest: FieldManifest) {
  const next = randomUUID();
  expect((await f.nextDraft(claims, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
  h.field.put(h.seed.a, next, manifest);
  expect((await f.submitShown(claims, jobId, next, manifest)).answer.status).toBe(201);
}

describe('a customer or claim save after the estimate', () => {
  it('an address save after pricing: the same prices, documents rebuilt with the new address, needing review and not signable', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId, draftId, manifest } = await submittedJob();
    const first = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(first).toMatchObject({ needsReview: false, documents: { signable: true }, proposal: { property_address: '12 Synthetic Lane, Testville' } });

    await saveCustomer(ESTIMATOR_A, jobId, '14 Synthetic Lane, Testville');
    const shown = await read(OFFICE_A, jobId);
    expect(shown.status).toBe(200);
    expect(shown.body.estimate).toMatchObject({
      id: first.id,
      needsReview: true,
      documents: { signable: false },
      proposal: { property_address: '14 Synthetic Lane, Testville' },
      totals: first.totals,
      lines: first.lines,
      price: first.price,
    });
    expect(shown.body.estimate.documents.letter).toContain('RE: Remediation scope for 14 Synthetic Lane, Testville');
    expect(shown.body.estimate.proposalSha256).not.toBe(first.proposalSha256);

    // Pricing again is never refused: the same stored estimate, needing review, and nothing written.
    const before = await everything(h.admin);
    const again = await make(ESTIMATOR_A, jobId);
    expect(again.status).toBe(200);
    expect(again.body.estimate).toEqual((await read(ESTIMATOR_A, jobId)).body.estimate);
    expect((await make(ESTIMATOR_A, jobId)).body.estimate).toEqual(again.body.estimate);
    expect(await everything(h.admin)).toBe(before);
    expect(await estimates(jobId)).toHaveLength(1);

    // Back to editing and Finish make a new record, priced from the same pin, that can be signed.
    await finishAgain(ESTIMATOR_A, jobId, draftId, manifest);
    const second = await make(ESTIMATOR_A, jobId);
    expect(second.status).toBe(201);
    expect(second.body.estimate).toMatchObject({
      needsReview: false,
      documents: { signable: true },
      proposal: { property_address: '14 Synthetic Lane, Testville' },
      price: { pinSequence: 1, versionSequence: 1 },
      totals: { low: { total: '240.00' } },
    });
    expect(second.body.estimate.id).not.toBe(first.id);
  });

  it('a claim save after pricing: the letter shows the new claim, needing review and not signable', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const first = (await make(ESTIMATOR_A, jobId)).body.estimate;

    await saveClaim(ESTIMATOR_A, jobId, 'CLM-2');
    for (const answer of [await read(OWNER_A, jobId), await make(OWNER_A, jobId)]) {
      expect(answer.status).toBe(200);
      expect(answer.body.estimate).toMatchObject({ id: first.id, needsReview: true, documents: { signable: false }, totals: first.totals });
      expect(answer.body.estimate.documents.letter).toContain('Claim number: CLM-2');
    }
  });

  it('a save between Finish and the first price: the first estimate already needs review', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    await saveClaim(ESTIMATOR_A, jobId, 'CLM-3');
    const first = await make(ESTIMATOR_A, jobId);
    expect(first.status).toBe(201);
    expect(first.body.estimate).toMatchObject({ needsReview: true, documents: { signable: false }, totals: { low: { total: '240.00' } } });
    expect(first.body.estimate.documents.letter).toContain('Claim number: CLM-3');
    expect(await pins(jobId)).toHaveLength(1);
    const again = await make(ESTIMATOR_A, jobId);
    expect(again.status).toBe(200);
    expect(again.body.estimate).toEqual(first.body.estimate);
  });

  it('an address cleared after pricing: the stored prices and what is missing, no documents and no refusal', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const first = (await make(ESTIMATOR_A, jobId)).body.estimate;

    await saveCustomer(ESTIMATOR_A, jobId, '');
    const shown = await read(OFFICE_A, jobId);
    expect(shown.status).toBe(200);
    expect(shown.body.estimate).toMatchObject({
      id: first.id,
      needsReview: true,
      missingDetails: ['Property address is missing'],
      documents: null,
      proposal: null,
      proposalSha256: null,
      totals: first.totals,
      lines: first.lines,
      price: first.price,
    });
    const before = await everything(h.admin);
    const again = await make(ESTIMATOR_A, jobId);
    expect(again.status).toBe(200);
    expect(again.body.estimate).toEqual((await read(ESTIMATOR_A, jobId)).body.estimate);
    expect(await everything(h.admin)).toBe(before);

    // With the address back the documents are rebuilt, and they still need review.
    await saveCustomer(ESTIMATOR_A, jobId, '16 Synthetic Lane, Testville');
    expect((await read(ESTIMATOR_A, jobId)).body.estimate).toMatchObject({
      id: first.id,
      needsReview: true,
      missingDetails: [],
      documents: { signable: false },
      proposal: { property_address: '16 Synthetic Lane, Testville' },
      totals: first.totals,
    });
  });

  it('an address cleared between Finish and the first price: priced from the record, with what is missing', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    await saveCustomer(ESTIMATOR_A, jobId, '');
    const first = await make(ESTIMATOR_A, jobId);
    expect(first.status).toBe(201);
    expect(first.body.estimate).toMatchObject({ needsReview: true, missingDetails: ['Property address is missing'], documents: null, totals: { low: { total: '240.00' } } });
    expect(await pins(jobId)).toHaveLength(1);
    const again = await make(ESTIMATOR_A, jobId);
    expect(again.status).toBe(200);
    expect(again.body.estimate).toEqual(first.body.estimate);
  });

  it('a save that puts the details back still needs review', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const first = (await make(ESTIMATOR_A, jobId)).body.estimate;
    await saveCustomer(ESTIMATOR_A, jobId, '14 Synthetic Lane, Testville');
    await saveCustomer(ESTIMATOR_A, jobId, '12 Synthetic Lane, Testville');
    expect((await read(ESTIMATOR_A, jobId)).body.estimate).toMatchObject({
      id: first.id,
      needsReview: true,
      documents: { signable: false },
      proposal: { property_address: '12 Synthetic Lane, Testville' },
    });
  });
});

describe('what is refused, and writes nothing', () => {
  it('"prices not set": a company with no published version', async () => {
    const { jobId } = await submittedJob();
    const before = await everything(h.admin);
    const answer = await make(ESTIMATOR_A, jobId);
    expect(answer).toMatchObject({ status: 409, body: { error: 'prices_not_set' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a record whose scope was not confirmed, or that has no written summary', async () => {
    await publish(h.seed.a, '2.00');
    for (const [draft, code] of [
      [{ scopeConfirmed: false }, 'scope_not_confirmed'],
      [{ summary: '   ' }, 'summary_missing'],
    ] as const) {
      const { jobId } = await submittedJob(ESTIMATOR_A, draft);
      const before = await everything(h.admin);
      expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: code } });
      expect(await everything(h.admin)).toBe(before);
    }
  });

  it('a job still being edited has no estimate', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const before = await everything(h.admin);
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'not_submitted' } });
    expect(await read(ESTIMATOR_A, jobId)).toMatchObject({ status: 200, body: { estimate: null, job: { status: 'draft' } } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('office reads the estimate but cannot make it; an estimator never reaches another estimator’s job', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const before = await everything(h.admin);
    expect(await make(OFFICE_A, jobId)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await make(ESTIMATOR_A2, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await read(ESTIMATOR_A2, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await everything(h.admin)).toBe(before);
    const made = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(await read(OFFICE_A, jobId)).toMatchObject({ status: 200, body: { estimate: { id: made.id, totals: { low: { total: '240.00' } } } } });
  });

  it('company B gets 404 on company A’s job, and a company without price books gets 404', async () => {
    await publish(h.seed.a, '2.00');
    await publish(h.seed.b, '2.00');
    const { jobId } = await submittedJob();
    const before = await everything(h.admin);
    expect(await make(OWNER_B, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await read(OWNER_B, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a}`;
    const off = await everything(h.admin);
    expect((await make(ESTIMATOR_A, jobId)).status).toBe(404);
    expect((await read(OWNER_A, jobId)).status).toBe(404);
    expect(await everything(h.admin)).toBe(off);
    expect(before).not.toBe(off);
    expect(await estimates(jobId)).toEqual([]);
  });

  it('a signed-out caller is refused', async () => {
    const { jobId } = await f.newJob(ESTIMATOR_A);
    expect((await make(null, jobId)).status).toBe(401);
    expect((await read(null, jobId)).status).toBe(401);
  });
});

describe('the quantity-override note', () => {
  it('an estimator sees no quantity-override note; the owner gets the note’s key', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const estimator = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(estimator.staffNotes).not.toHaveProperty('quantityNotes');
    expect((await read(OFFICE_A, jobId)).body.estimate.staffNotes).not.toHaveProperty('quantityNotes');
    // Field map v1 records no override, so the owner's list is empty (tests/unit/estimate-proposal.test.ts
    // has the note itself).
    expect((await read(OWNER_A, jobId)).body.estimate.staffNotes.quantityNotes).toEqual([]);
  });
});

describe('the photo log grouping of the company', () => {
  const setGrouping = (company: string, settings: string) => h.admin`UPDATE companies SET profile_documents = ${settings}::text::jsonb WHERE id = ${company}`;

  it('follows the company’s own setting: by room until the owner chooses shot tags, the same photo and hash either way', async () => {
    await publish(h.seed.a, '2.00');
    const first = await submittedJob();
    const byRoom = await make(ESTIMATOR_A, first.jobId);
    expect(byRoom.body.estimate.documents.photoLog).toEqual([{ id: first.photoId, room: 'Kitchen', sha256: sha256(first.photoBytes), shot_tag: 'source' }]);

    await setGrouping(h.seed.a, '{"photo_log_grouping": "shot_tag"}');
    const second = await submittedJob();
    const byTag = await make(ESTIMATOR_A, second.jobId);
    expect(byTag.body.estimate.documents.photoLog).toEqual([{ id: second.photoId, room: 'Kitchen', sha256: sha256(second.photoBytes), shot_tag: 'source', album: 'Source of loss' }]);
    expect(byTag.body.estimate.totals).toEqual(byRoom.body.estimate.totals);
    // The first estimate is stored as it was made; the setting does not rewrite it.
    expect((await read(ESTIMATOR_A, first.jobId)).body.estimate.documents.photoLog).toEqual(byRoom.body.estimate.documents.photoLog);
  });

  it('company A’s setting does not reach company B’s documents', async () => {
    await setGrouping(h.seed.a, '{"photo_log_grouping": "shot_tag"}');
    const [row] = await h.admin<{ documents: Body }[]>`SELECT profile_documents AS documents FROM companies WHERE id = ${h.seed.b}`;
    expect(row?.documents).toEqual({});
  });

  it('settings the schema cannot read are refused, 503, and nothing is stored or pinned', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    await setGrouping(h.seed.a, '{"photo_log_grouping": "by_colour"}');
    const refused = await make(ESTIMATOR_A, jobId);
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ error: 'settings_unreadable' });
    expect(await estimates(jobId)).toEqual([]);
    expect(await pins(jobId)).toEqual([]);
  });

  it('orders each album and room group by capture time, leaving older untimed photos after timed ones', async () => {
    await publish(h.seed.a, '2.00');
    await setGrouping(h.seed.a, '{"photo_log_grouping": "shot_tag"}');

    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';
    const third = '33333333-3333-4333-8333-333333333333';
    const fourth = '44444444-4444-4444-8444-444444444444';
    const jobId = randomUUID();
    const draftId = randomUUID();
    expect((await jobsRoute.POST(request(ESTIMATOR_A, '/api/jobs', { method: 'POST', body: { id: jobId, draftId } }), params({}))).status).toBe(201);
    const customer = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '12 Synthetic Lane, Testville' };
    expect((await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body: customer }), params({ jobId }))).status).toBe(200);

    const bytesOf = new Map<string, Uint8Array>();
    for (const id of [first, second, third, fourth]) {
      const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(`photo-${id}`)]);
      bytesOf.set(id, bytes);
      expect((await photoRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${id}?kind=photo`, { method: 'PUT', body: bytes }), params({ jobId, photoId: id }))).status).toBe(201);
    }

    const manifest: FieldManifest = {
      draft: { yearBuilt: 1995, roomOrder: ['kitchen', 'hall'], summary: 'Supply line failure.', scopeConfirmed: true },
      rooms: [
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
      ],
      photos: [
        { id: fourth, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:00:00.000Z' } },
        { id: second, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:01:00.000Z' } },
        { id: third, field: { roomId: 'kitchen', shotTag: 'source', capturedAt: '2026-11-15T10:01:00.000Z' } },
        { id: first, field: { roomId: 'hall', shotTag: 'source' } },
      ],
    };
    h.field.put(h.seed.a, draftId, manifest);
    const { answer: submitted } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(submitted.status).toBe(201);

    const estimated = await make(ESTIMATOR_A, jobId);
    expect(estimated.status).toBe(201);
    expect(estimated.body.estimate.documents.photoLog).toEqual([
      { id: fourth, room: 'Kitchen', sha256: sha256(bytesOf.get(fourth)!), shot_tag: 'source', album: 'Source of loss', captured_at: '2026-11-15T10:00:00.000Z' },
      { id: second, room: 'Kitchen', sha256: sha256(bytesOf.get(second)!), shot_tag: 'source', album: 'Source of loss', captured_at: '2026-11-15T10:01:00.000Z' },
      { id: third, room: 'Kitchen', sha256: sha256(bytesOf.get(third)!), shot_tag: 'source', album: 'Source of loss', captured_at: '2026-11-15T10:01:00.000Z' },
      { id: first, room: 'Hall', sha256: sha256(bytesOf.get(first)!), shot_tag: 'source', album: 'Source of loss' },
    ]);
  });
});
