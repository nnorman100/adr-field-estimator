import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-8 proposals and approvals on a job, server slice (docs/plans/S5/S5b-8.md; spec 6.1; owner
// decisions D1 to D5), through the real route files as the runtime role against Postgres. A job is
// made and submitted through the real routes (as in reprice-api.test.ts); the estimator proposes and
// the owner approves through /api/jobs/{id}/approvals, and the estimate prices what was approved.
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
vi.mock('@/lib/approvals/services', async () => {
  const { approvalsService } = await import('@/lib/approvals/service');
  return { approvalsServices: () => approvalsService(live.harness!.handle.db) };
});
const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const approvalsRoute = await import('@/app/api/jobs/[jobId]/approvals/route');
const approvalRoute = await import('@/app/api/jobs/[jobId]/approvals/[approvalId]/route');
const approveRoute = await import('@/app/api/jobs/[jobId]/approvals/[approvalId]/approve/route');
const repriceRoute = await import('@/app/api/jobs/[jobId]/reprice/route');
const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
const { approvalsService } = await import('@/lib/approvals/service');
const { estimatesService } = await import('@/lib/estimates/service');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
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
  await h.admin`
    INSERT INTO company_feature_flags (company_id, flag, enabled)
    VALUES (${h.seed.a}, 'price_books', true), (${h.seed.a}, 'priced_extras', true), (${h.seed.b}, 'price_books', true), (${h.seed.b}, 'priced_extras', true)
  `;
  await h.admin`
    UPDATE companies SET profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100', profile_email = 'office@example.invalid',
      profile_license = '000001', profile_signoff = 'Pat Example',
      profile_documents = ${JSON.stringify({ authorization_text: 'Synthetic start-work authorization.', payment_terms_text: 'Synthetic payment terms.' })}::text::jsonb
    WHERE id = ${h.seed.a}
  `;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// Publishes company A's next price version: $2.00 per square foot of wet floor, an additional work
// rate of $50.00 an hour (none when `rate` is null) and two named adjustments.
async function publish(rate: string | null = '50.00', extractionSource = 'room:wet_floor'): Promise<{ id: string; hash: string }> {
  const table = parseTable({
    items: [
      { item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: extractionSource, unit_price: '2.00' },
      ...(rate === null ? [] : [{ item_id: 'additional_work', group: 'extras', name: 'Additional work', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: rate }]),
    ],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
    adjustments: [
      { adjustment_id: 'rush_charge', name: 'Rush', kind: 'amount', direction: 'charge', value: '10.00' },
      { adjustment_id: 'loyal_discount', name: 'Loyal customer', kind: 'amount', direction: 'discount', value: '20.00' },
    ],
  });
  const hash = contentHash(table);
  const [row] = await h.admin<{ id: string }[]>`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${h.seed.a}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${hash}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${h.seed.ownerA.actor}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${h.seed.a}
    RETURNING id::text
  `;
  return { id: row!.id, hash };
}

function manifestOf(photoId: string): FieldManifest {
  return {
    draft: { yearBuilt: 1990, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
    ],
    photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'source' } }],
  };
}

// A submitted job of company A, made by the estimator; not priced yet, so it has no pin.
async function submittedJob() {
  const ready = await f.readyJob(ESTIMATOR_A, h.seed.a);
  const body = { revision: (await f.job(ready.jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '12 Synthetic Lane, Testville' };
  expect((await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${ready.jobId}/customer`, { method: 'PUT', body }), params({ jobId: ready.jobId }))).status).toBe(200);
  const manifest = manifestOf(ready.photoId);
  h.field.put(h.seed.a, ready.draftId, manifest);
  expect((await f.submitShown(ESTIMATOR_A, ready.jobId, ready.draftId, manifest)).answer.status).toBe(201);
  return { jobId: ready.jobId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Answer & { body: Record<string, any> };
const revisionOf = async (jobId: string) => (await f.job(jobId)).revision;
const list = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(approvalsRoute.GET(request(claims, `/api/jobs/${jobId}/approvals`), params({ jobId })));
async function propose(claims: FakeClaims | null, jobId: string, extra: Record<string, unknown>, id = randomUUID()): Promise<Reply> {
  const body = { id, revision: await revisionOf(jobId), ...extra };
  return json(approvalsRoute.POST(request(claims, `/api/jobs/${jobId}/approvals`, { method: 'POST', body }), params({ jobId })));
}
async function edit(claims: FakeClaims | null, jobId: string, approvalId: string, extra: Record<string, unknown>, id = randomUUID()): Promise<Reply> {
  const body = { id, revision: await revisionOf(jobId), ...extra };
  return json(approvalRoute.PUT(request(claims, `/api/jobs/${jobId}/approvals/${approvalId}`, { method: 'PUT', body }), params({ jobId, approvalId })));
}
async function approve(claims: FakeClaims | null, jobId: string, approvalId: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  const body = { revision: await revisionOf(jobId), ...extra };
  return json(approveRoute.POST(request(claims, `/api/jobs/${jobId}/approvals/${approvalId}/approve`, { method: 'POST', body }), params({ jobId, approvalId })));
}
const make = (claims: FakeClaims, jobId: string): Promise<Reply> =>
  json(estimateRoute.POST(request(claims, `/api/jobs/${jobId}/estimate`, { method: 'POST' }), params({ jobId })));

const ESTIMATOR_CALLER = () => ({ companyId: h.seed.a, actorId: h.seed.estimatorA.actor, uid: 'estimator-a', role: 'estimator' as const, capabilities: ['scope' as const, 'jobs_read' as const] });
const OWNER_CALLER = () => ({ companyId: h.seed.a, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: ['scope' as const, 'jobs_read' as const, 'additions_approve' as const] });

// Holds locks in a transaction of the test's own, starts `start`, waits until Postgres shows it
// blocked on a lock, runs `between` in the holding transaction, and commits: so a change lands
// between two of the call's queries, in the same order every run.
async function interleaved<T>(
  hold: (tx: postgres.TransactionSql) => Promise<void>,
  start: () => Promise<T>,
  between: (tx: postgres.TransactionSql) => Promise<void> = async () => undefined,
): Promise<{ blocked: boolean; result: T }> {
  const side = postgres(base.server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    let running: Promise<T> | undefined;
    let blocked = false;
    await h.admin.begin(async (tx) => {
      await hold(tx);
      running = start();
      running.catch(() => undefined);
      for (let tries = 0; tries < 200 && !blocked; tries++) {
        const [waiting] = await side<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        blocked = waiting!.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await between(tx);
    });
    return { blocked, result: await running! };
  } finally {
    await side.end({ timeout: 5 });
  }
}

// The pinned (before) price the owner's Reprice preview shows now, as the banner sends it back.
async function pinnedShown(jobId: string): Promise<string | null> {
  const answer = await json(repriceRoute.GET(request(OWNER_A, `/api/jobs/${jobId}/reprice`), params({ jobId })));
  return (answer.body as Reply['body']).reprice?.pinned?.price ?? null;
}

const HOURLY = { kind: 'hourly', description: '  Move contents to the garage ', hours: '2.5' };
const OWNER_NAME = ' Pat  Example ';

describe('proposals and approvals (S5b-8)', () => {
  it('answers 404 on every route while the company has priced extras off', async () => {
    await publish();
    const { jobId } = await submittedJob();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'priced_extras'`;
    const id = randomUUID();
    for (const answer of [await list(ESTIMATOR_A, jobId), await propose(ESTIMATOR_A, jobId, HOURLY), await edit(ESTIMATOR_A, jobId, id, HOURLY), await approve(OWNER_A, jobId, id)]) {
      expect(answer.status).toBe(404);
    }
  });

  it('takes an hourly proposal at the pinned rate, pins a job with no pin to the newest prices, and replays the same id', async () => {
    const one = await publish();
    const { jobId } = await submittedJob();
    const id = randomUUID();
    const made = await propose(ESTIMATOR_A, jobId, HOURLY, id);
    expect(made).toMatchObject({ status: 201, body: { approval: { id, kind: 'hourly', description: HOURLY.description, hours: '2.5', rate: '50.00', total: '125.00', approved: false } } });
    expect(await h.admin`SELECT sequence, version_id::text, reason FROM job_price_pins WHERE job_id = ${jobId}`).toEqual([{ sequence: 1, version_id: one.id, reason: 'first_price' }]);
    expect((await propose(ESTIMATOR_A, jobId, HOURLY, id)).status).toBe(200);
    expect(await propose(ESTIMATOR_A, jobId, { ...HOURLY, hours: '3' }, id)).toMatchObject({ status: 409, body: { error: 'conflict' } });
    // A newer publish does not move the pin the first proposal made.
    await publish('80.00');
    expect((await propose(ESTIMATOR_A, jobId, { ...HOURLY, hours: '1' })).body.approval.rate).toBe('50.00');
    expect((await list(ESTIMATOR_A, jobId)).body.approvals).toHaveLength(2);
  });

  it('takes a custom multiplier, a unit and a flat addition, and refuses a body it cannot read', async () => {
    await publish();
    const { jobId } = await submittedJob();
    for (const extra of [
      { kind: 'line_multiplier', itemId: 'extraction', roomId: 'kitchen', multiplier: '1.25' },
      { kind: 'unit', description: 'Bags', quantity: '3', unit: 'bag', price: '4.00', taxable: true },
      { kind: 'flat', description: 'Permit', price: '150.00', taxable: false },
    ]) {
      expect(await propose(ESTIMATOR_A, jobId, extra)).toMatchObject({ status: 201, body: { approval: { kind: extra.kind, approved: false } } });
    }
    for (const extra of [
      { ...HOURLY, hours: '0.2' },
      { ...HOURLY, hours: '2.555' },
      { ...HOURLY, description: '\u00a0\u2003' },
      { ...HOURLY, description: 'a\u2028b' },
      { kind: 'bogus' },
      { kind: 'line_multiplier', itemId: 'extraction', roomId: 'hall', multiplier: '1' },
      { kind: 'line_multiplier', itemId: 'extraction', roomId: 'hall', multiplier: '3.01' },
      { kind: 'line_multiplier', itemId: 'extraction', roomId: 'hall', multiplier: '1.255' },
      { kind: 'unit', description: 'Bags', quantity: '3', price: '4.00', taxable: true },
      { kind: 'flat', description: 'Permit', price: '0', taxable: false },
      { kind: 'flat', description: 'Permit', price: '150.00' },
    ]) {
      expect({ extra, error: (await propose(ESTIMATOR_A, jobId, extra)).body.error }).toEqual({ extra, error: 'invalid_request' });
    }
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals`).toEqual([{ n: 3 }]);
  });

  it('takes one custom multiplier per line, on an item the pinned prices have and a room the record has, and prices it', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const line = { kind: 'line_multiplier', itemId: 'extraction', roomId: 'kitchen', multiplier: '1.25' };
    const id = (await propose(ESTIMATOR_A, jobId, line)).body.approval.id as string;
    expect(await propose(ESTIMATOR_A, jobId, { ...line, multiplier: '1.5' })).toMatchObject({ status: 409, body: { error: 'line_already_proposed' } });
    expect(await propose(ESTIMATOR_A, jobId, { ...line, itemId: 'no_such_item' })).toMatchObject({ status: 409, body: { error: 'unknown_item' } });
    expect(await propose(ESTIMATOR_A, jobId, { ...line, roomId: 'attic' })).toMatchObject({ status: 409, body: { error: 'unknown_room' } });
    // The record prices extraction in the rooms, not job-wide, and the hourly rate item prices no line of its own.
    expect(await propose(ESTIMATOR_A, jobId, { ...line, roomId: null })).toMatchObject({ status: 409, body: { error: 'no_such_line' } });
    expect(await propose(ESTIMATOR_A, jobId, { ...line, itemId: 'additional_work' })).toMatchObject({ status: 409, body: { error: 'no_such_line' } });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals`).toEqual([{ n: 1 }]);
    expect((await approve(OWNER_A, jobId, id)).body.approval).toMatchObject({ id, itemId: 'extraction', roomId: 'kitchen', multiplier: '1.25', approved: true });
    // Kitchen 80 sq ft x $2.00 = $160.00, x1.25 = $200.00; Hall 40 sq ft x $2.00 = $80.00. Total $280.00.
    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(estimate.totals.low.total).toBe('280.00');
    expect(JSON.stringify(estimate)).toContain('x1.25');
  });

  it('answers a record that prices no line 409 no_such_line, not that the estimate is refused', async () => {
    await publish('50.00', 'room:demolition:unfinished');
    const { jobId } = await submittedJob();
    const line = { kind: 'line_multiplier', itemId: 'extraction', roomId: 'kitchen', multiplier: '1.25' };
    expect(await propose(ESTIMATOR_A, jobId, line)).toMatchObject({ status: 409, body: { error: 'no_such_line' } });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals`).toEqual([{ n: 0 }]);
  });

  it('refuses a custom multiplier beyond the 3,000 the estimate takes, and lets an edit replace one at the limit', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const line = { kind: 'line_multiplier', itemId: 'extraction', roomId: 'kitchen', multiplier: '1.25' };
    const first = (await propose(ESTIMATOR_A, jobId, line)).body.approval.id as string;
    await h.admin`
      INSERT INTO job_price_approvals (id, company_id, job_id, submission_id, pin_id, table_hash, job_revision, kind, item_id, room_id, multiplier, request_digest, proposed_by_actor_id)
      SELECT gen_random_uuid(), company_id, job_id, submission_id, pin_id, table_hash, job_revision, kind, 'seed_' || n, room_id, multiplier, request_digest, proposed_by_actor_id
      FROM job_price_approvals, generate_series(1, 2999) AS n WHERE id = ${first}
    `;
    expect(await propose(ESTIMATOR_A, jobId, { ...line, roomId: 'hall' })).toMatchObject({ status: 409, body: { error: 'too_many_additions' } });
    expect((await edit(ESTIMATOR_A, jobId, first, { ...line, multiplier: '1.5' })).status).toBe(201);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals WHERE ended_at IS NULL`).toEqual([{ n: 3000 }]);
  });

  it('prices approved unit and flat additions with their approved wording, never in the price table, and waits on unapproved ones', async () => {
    await publish();
    const catalog = async () => ({
      versions: await h.admin`SELECT * FROM price_table_versions WHERE company_id = ${h.seed.a} ORDER BY sequence`,
      workingCopies: await h.admin`SELECT * FROM price_table_working_copies WHERE company_id = ${h.seed.a}`,
    });
    const before = await catalog();
    const { jobId } = await submittedJob();
    const bags = (await propose(ESTIMATOR_A, jobId, { kind: 'unit', description: 'Haul-away bags', quantity: '12', unit: 'bag', price: '4.50', taxable: true })).body.approval;
    expect(bags).toMatchObject({ quantity: '12', unit: 'bag', price: '4.50', taxable: true, total: '54.00' });
    const permit = (await propose(ESTIMATOR_A, jobId, { kind: 'flat', description: 'Permit filing', price: '150.00', taxable: false })).body.approval;
    expect(permit).toMatchObject({ quantity: null, price: '150.00', taxable: false, total: '150.00' });
    await approve(OWNER_A, jobId, bags.id as string);
    // The flat addition is still waiting for the owner: it prices nothing and the estimate cannot be signed.
    const other = await submittedJob();
    const pending = (await propose(ESTIMATOR_A, other.jobId, { kind: 'flat', description: 'Permit filing', price: '150.00', taxable: false })).body.approval;
    expect(pending.approved).toBe(false);
    const unsettled = (await make(ESTIMATOR_A, other.jobId)).body.estimate;
    expect(unsettled.totals.low.total).toBe('240.00');
    expect(unsettled.documents.signable).toBe(false);
    expect(unsettled.documents.pendingExtras).toBe(1);
    await approve(OWNER_A, jobId, permit.id as string);
    // $240.00 + 12 bags x $4.50 = $54.00 + $150.00 = $444.00 (no sales tax in this table).
    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(estimate.totals.low.total).toBe('444.00');
    const text = JSON.stringify(estimate);
    expect(text).toContain('Haul-away bags: 12 bag at $4.50/bag, approved on ');
    expect(text).toContain('Permit filing: $150.00, approved on ');
    // The company's published prices are as they were.
    expect(await catalog()).toEqual(before);
  });

  it('lets only the owner approve; an hourly approval keeps the name as entered and reaches the estimate', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    expect((await approve(ESTIMATOR_A, jobId, id, { approverName: 'Me' })).status).toBe(403);
    expect((await approve(OFFICE_A, jobId, id, { approverName: 'Me' })).status).toBe(403);
    expect((await propose(OFFICE_A, jobId, HOURLY)).status).toBe(403);
    expect(await approve(OWNER_A, jobId, id)).toMatchObject({ status: 400, body: { error: 'approver_name_required' } });
    const approved = await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    expect(approved).toMatchObject({ status: 200, body: { approval: { id, approved: true, approverName: OWNER_NAME } } });
    // The same approval again is answered as the first time.
    expect((await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME })).status).toBe(200);

    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    // $2.00 x 120 sq ft = $240.00, plus 2.5 h x $50.00 = $125.00.
    expect(estimate.totals.low.total).toBe('365.00');
    expect(JSON.stringify(estimate)).toContain(`approved by ${OWNER_NAME} on`);
  });

  it('applies one approved named adjustment, which a newly approved one replaces, and refuses one the prices do not have', async () => {
    await publish();
    const { jobId } = await submittedJob();
    expect(await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'no_such_one' })).toMatchObject({ status: 409, body: { error: 'unknown_adjustment' } });
    const rush = (await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'rush_charge' })).body.approval.id as string;
    const loyal = (await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'loyal_discount' })).body.approval.id as string;
    expect((await approve(OWNER_A, jobId, rush, { approverName: 'Pat' })).body.error).toBe('invalid_request');
    expect((await approve(OWNER_A, jobId, rush)).status).toBe(200);
    expect((await approve(OWNER_A, jobId, loyal)).status).toBe(200);
    expect(await h.admin`SELECT adjustment_id, ended_reason FROM job_price_approvals ORDER BY adjustment_id`).toEqual([
      { adjustment_id: 'loyal_discount', ended_reason: null },
      { adjustment_id: 'rush_charge', ended_reason: 'replaced' },
    ]);
    // $240.00 less the $20.00 loyal customer discount.
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('220.00');
  });

  it('clears an approval when the proposal is edited, and leaves the edited row out of the estimate', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const edited = await edit(ESTIMATOR_A, jobId, id, { ...HOURLY, hours: '4' });
    expect(edited).toMatchObject({ status: 201, body: { approval: { hours: '4', rate: '50.00', approved: false } } });
    expect(await edit(ESTIMATOR_A, jobId, id, HOURLY)).toMatchObject({ status: 409, body: { error: 'approval_closed' } });
    expect((await list(ESTIMATOR_A, jobId)).body.approvals.map((row: { id: string }) => row.id)).toEqual([edited.body.approval.id]);
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('240.00');
  });

  it('refuses a proposal once the estimate is made, on a stale revision, without an hourly rate, and from another company', async () => {
    await publish(null);
    const { jobId } = await submittedJob();
    expect(await propose(ESTIMATOR_A, jobId, HOURLY)).toMatchObject({ status: 409, body: { error: 'no_hourly_rate' } });
    expect(await propose(ESTIMATOR_A, jobId, { ...HOURLY, revision: 1 })).toMatchObject({ status: 409, body: { error: 'stale_revision' } });
    expect((await propose(OWNER_B, jobId, HOURLY)).status).toBe(404);
    expect((await list(OWNER_B, jobId)).status).toBe(404);
    // A real proposal of company A, named by company B's owner: refused, and unchanged.
    await publish();
    const theirs = (await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'rush_charge' })).body.approval.id as string;
    expect((await approve(OWNER_B, jobId, theirs)).status).toBe(404);
    expect((await edit(OWNER_B, jobId, theirs, { kind: 'named_adjustment', adjustmentId: 'loyal_discount' })).status).toBe(404);
    expect(await h.admin`SELECT approved_at, ended_at FROM job_price_approvals WHERE id = ${theirs}`).toEqual([{ approved_at: null, ended_at: null }]);
    expect((await make(ESTIMATOR_A, jobId)).status).toBe(201);
    expect(await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'rush_charge' })).toMatchObject({ status: 409, body: { error: 'estimate_made' } });
  });

  it('ignores approvals in the estimate while priced extras is off', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'priced_extras'`;
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('240.00');
  });

  it('takes the priced extras switch from the database inside the transaction, not from the sign-in', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const flag = (enabled: boolean) => async (tx: postgres.TransactionSql) => {
      await tx`UPDATE company_feature_flags SET enabled = ${enabled} WHERE company_id = ${h.seed.a} AND flag = 'priced_extras'`;
    };
    const lockJob = async (tx: postgres.TransactionSql) => {
      await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    };
    // Off when the request signed in, on once it holds the job's lock: the approved work is priced.
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'priced_extras'`;
    const maker = { ...ESTIMATOR_CALLER(), capabilities: ['audit' as const, 'jobs_read' as const], flags: { priced_extras: false } };
    const on = await interleaved(lockJob, () => estimatesService(h.handle.db).make(maker, jobId), flag(true));
    expect(on.blocked).toBe(true);
    expect(on.result.estimate.totals.low.total).toBe('365.00');

    // On when the request signed in, off by the time it holds the lock: a proposal answers 404, nothing is written.
    const second = (await submittedJob()).jobId;
    const revision = await revisionOf(second);
    const answered = await interleaved(
      async (tx) => {
        await tx`SELECT id FROM jobs WHERE id = ${second} FOR UPDATE`;
      },
      () =>
        approvalsService(h.handle.db)
          .propose(ESTIMATOR_CALLER(), second, { id: randomUUID(), revision, kind: 'hourly', description: 'Move contents', hours: '1' })
          .then(
            () => 'made',
            (error: { code?: string }) => error.code,
          ),
      flag(false),
    );
    expect(answered).toMatchObject({ blocked: true, result: 'not_found' });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals WHERE job_id = ${second}`).toEqual([{ n: 0 }]);
  });

  it('takes the price books switch from the database too: switched off after the sign-in, a proposal answers 404 and writes nothing', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const revision = await revisionOf(jobId);
    // The request signed in with price books on; it is turned off while the request waits for the company lock.
    const answered = await interleaved(
      async (tx) => {
        await tx`SELECT id FROM companies WHERE id = ${h.seed.a} FOR UPDATE`;
      },
      () =>
        approvalsService(h.handle.db)
          .propose(ESTIMATOR_CALLER(), jobId, { id: randomUUID(), revision, kind: 'hourly', description: 'Move contents', hours: '1' })
          .then(
            () => 'made',
            (error: { code?: string }) => error.code,
          ),
      async (tx) => {
        await tx`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
      },
    );
    expect(answered).toMatchObject({ blocked: true, result: 'not_found' });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals WHERE job_id = ${jobId}`).toEqual([{ n: 0 }]);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_pins WHERE job_id = ${jobId}`).toEqual([{ n: 0 }]);
  });

  it('shows an hourly line’s total with every view of it, and none for a named adjustment', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const hourly = (await propose(ESTIMATOR_A, jobId, { ...HOURLY, hours: '2.75' })).body.approval;
    expect(hourly).toMatchObject({ rate: '50.00', total: '137.50' });
    const approved = await approve(OWNER_A, jobId, hourly.id, { approverName: OWNER_NAME });
    expect(approved.body.approval.total).toBe('137.50');
    const named = (await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'rush_charge' })).body.approval;
    expect(named.total).toBeNull();
    expect((await list(OWNER_A, jobId)).body.approvals.map((row: { total: string | null }) => row.total)).toEqual(['137.50', null]);
  });

  it('ends the record’s proposals when the owner reprices, and refuses new ones until Back to editing and Finish', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const two = await publish('60.00');
    const body = { revision: await revisionOf(jobId), changeId: randomUUID(), versionId: two.id, pinnedPrice: await pinnedShown(jobId) };
    expect((await repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body }), params({ jobId }))).status).toBe(200);
    expect(await h.admin`SELECT ended_reason FROM job_price_approvals WHERE id = ${id}`).toEqual([{ ended_reason: 'repriced' }]);
    expect((await list(ESTIMATOR_A, jobId)).body.approvals).toEqual([]);
    expect(await propose(ESTIMATOR_A, jobId, HOURLY)).toMatchObject({ status: 409, body: { error: 'repriced' } });
  });

  it('answers 404 on every route while price books are off, and writes nothing', async () => {
    await publish();
    const { jobId } = await submittedJob();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    const id = randomUUID();
    for (const answer of [await list(ESTIMATOR_A, jobId), await propose(ESTIMATOR_A, jobId, HOURLY), await edit(ESTIMATOR_A, jobId, id, HOURLY), await approve(OWNER_A, jobId, id)]) {
      expect(answer).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_approvals`).toEqual([{ n: 0 }]);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_pins`).toEqual([{ n: 0 }]);
  });

  it('answers an archived job 410 before the role refusal, to the estimator, office and owner alike', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    const revision = await revisionOf(jobId);
    expect((await json(archiveRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision, changeId: randomUUID() } }), params({ jobId })))).status).toBe(200);
    for (const claims of [ESTIMATOR_A, OFFICE_A, OWNER_A]) {
      const proposed = await json(approvalsRoute.POST(request(claims, `/api/jobs/${jobId}/approvals`, { method: 'POST', body: { id: randomUUID(), revision: 2, ...HOURLY } }), params({ jobId })));
      const edited = await json(approvalRoute.PUT(request(claims, `/api/jobs/${jobId}/approvals/${id}`, { method: 'PUT', body: { id: randomUUID(), revision: 2, ...HOURLY } }), params({ jobId, approvalId: id })));
      const approved = await json(approveRoute.POST(request(claims, `/api/jobs/${jobId}/approvals/${id}/approve`, { method: 'POST', body: { revision: 2, approverName: 'Pat' } }), params({ jobId, approvalId: id })));
      const listed = await list(claims, jobId);
      expect([proposed.status, edited.status, approved.status, listed.status]).toEqual([410, 410, 410, 410]);
    }
  });

  it('answers a proposal id that is not a uuid as not found', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const approvalId = 'not-a-uuid';
    const body = { id: randomUUID(), revision: await revisionOf(jobId), ...HOURLY };
    expect(await json(approvalRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/approvals/${approvalId}`, { method: 'PUT', body }), params({ jobId, approvalId })))).toMatchObject({ status: 404, body: { error: 'approval_not_found' } });
  });

  it('keeps a pending hourly row in the estimate as unsettled work: it prices nothing and the estimate cannot be signed', async () => {
    await publish();
    const clean = await submittedJob();
    expect((await make(ESTIMATOR_A, clean.jobId)).body.estimate.documents.signable).toBe(true);
    const { jobId } = await submittedJob();
    await propose(ESTIMATOR_A, jobId, HOURLY);
    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(estimate.totals.low.total).toBe('240.00');
    expect(estimate.documents.signable).toBe(false);
  });

  it('rebuilds a saved-after estimate with the approved work it was priced with, and previews its pinned price the same way', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('365.00');
    const saved = { revision: await revisionOf(jobId), changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '14 Synthetic Lane, Testville' };
    expect((await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body: saved }), params({ jobId }))).status).toBe(200);
    for (const estimate of [(await make(ESTIMATOR_A, jobId)).body.estimate, (await json(estimateRoute.GET(request(ESTIMATOR_A, `/api/jobs/${jobId}/estimate`), params({ jobId })))).body.estimate]) {
      expect(estimate).toMatchObject({ needsReview: true, totals: { low: { total: '365.00' } } });
      expect(JSON.stringify(estimate.proposal)).toContain(`approved by ${OWNER_NAME} on`);
      expect(JSON.stringify(estimate.documents.itemizedClaim)).toContain('Additional work');
    }
    await publish('60.00');
    const preview = await json(repriceRoute.GET(request(OWNER_A, `/api/jobs/${jobId}/reprice`), params({ jobId })));
    expect(preview.body.reprice).toMatchObject({ pinned: { price: '$365.00' }, newest: { price: '$240.00' } });
  });

  it('refuses a thirty-first hourly row, and lets an edit replace one at the limit', async () => {
    await publish();
    const { jobId } = await submittedJob();
    let first = '';
    for (let n = 0; n < 30; n++) {
      const made = await propose(ESTIMATOR_A, jobId, { ...HOURLY, description: `Task ${n}` });
      expect(made.status).toBe(201);
      first ||= made.body.approval.id;
    }
    expect(await propose(ESTIMATOR_A, jobId, HOURLY)).toMatchObject({ status: 409, body: { error: 'too_many_additions' } });
    expect((await edit(ESTIMATOR_A, jobId, first, { ...HOURLY, description: 'Replaced' })).status).toBe(201);
    expect((await list(ESTIMATOR_A, jobId)).body.approvals).toHaveLength(30);
    expect(await propose(ESTIMATOR_A, jobId, HOURLY)).toMatchObject({ status: 409, body: { error: 'too_many_additions' } });
  });

  it('refuses a description the estimate cannot print, on propose and on edit, and keeps an accepted one as entered', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const joiner = { ...HOURLY, description: 'Crew \u{1F477}\u200D\u2642\uFE0F on site' };
    expect(await propose(ESTIMATOR_A, jobId, joiner)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    expect(await edit(ESTIMATOR_A, jobId, id, joiner)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect((await list(ESTIMATOR_A, jobId)).body.approvals[0].description).toBe(HOURLY.description);
  });

  it('answers a replay with the row as it stands: an ended proposal says so, and an approval left at an older revision is stale', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const first = randomUUID();
    const proposal = { ...HOURLY, hours: '2' };
    expect((await propose(ESTIMATOR_A, jobId, proposal, first)).body.approval.ended).toBe(false);
    const second = (await edit(ESTIMATOR_A, jobId, first, { ...HOURLY, hours: '3' })).body.approval;
    expect(second.ended).toBe(false);
    expect(await propose(ESTIMATOR_A, jobId, proposal, first)).toMatchObject({ status: 200, body: { approval: { id: first, ended: true } } });

    expect((await approve(OWNER_A, jobId, second.id, { approverName: OWNER_NAME })).status).toBe(200);
    const saved = { revision: await revisionOf(jobId), changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '14 Synthetic Lane, Testville' };
    expect((await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body: saved }), params({ jobId }))).status).toBe(200);
    expect(await approve(OWNER_A, jobId, second.id, { approverName: OWNER_NAME })).toMatchObject({ status: 409, body: { error: 'stale_revision' } });
    expect(await approve(OWNER_A, jobId, first, { approverName: OWNER_NAME })).toMatchObject({ status: 409, body: { error: 'approval_closed' } });
  });

  it('rebuilds the estimate from one snapshot: a reprice that commits between its reads cannot change what it prices', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('365.00');
    const saved = { revision: await revisionOf(jobId), changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress: '14 Synthetic Lane, Testville' };
    expect((await customerRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body: saved }), params({ jobId }))).status).toBe(200);
    const newer = await publish('80.00');
    const { blocked, result } = await interleaved(
      async (tx) => {
        await tx`LOCK TABLE job_price_approvals IN ACCESS EXCLUSIVE MODE`;
      },
      () => estimatesService(h.handle.db).read(ESTIMATOR_CALLER(), jobId),
      // What the reprice route commits, with the production triggers on: the owner's pin (which ends the
      // record's open rows as repriced), the job's next revision and the audit row.
      async (tx) => {
        const [pin] = await tx<{ sequence: number }[]>`
          INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id)
          SELECT ${h.seed.a}, ${jobId}, max(sequence) + 1, ${newer.id}, 'owner_reprice', ${h.seed.ownerA.actor} FROM job_price_pins WHERE job_id = ${jobId}
          RETURNING sequence`;
        const [job] = await tx<{ revision: number; current_draft_id: string }[]>`UPDATE jobs SET revision = revision + 1 WHERE id = ${jobId} RETURNING revision, current_draft_id::text`;
        await tx`
          INSERT INTO audit_events (company_id, actor_id, action, target, details)
          VALUES (${h.seed.a}, ${h.seed.ownerA.actor}, 'job_repriced', ${jobId}, ${JSON.stringify({ sequence: pin!.sequence, job_draft: job!.current_draft_id, job_revision: job!.revision })}::text::jsonb)`;
      },
    );
    expect(blocked).toBe(true);
    expect(result.estimate).toMatchObject({ needsReview: true, totals: { low: { total: '365.00' } }, proposal: { price: { itemized_total: '365.00' } } });
  });

  it('takes the job lock to list, as the writes do', async () => {
    await publish();
    const { jobId } = await submittedJob();
    await propose(ESTIMATOR_A, jobId, HOURLY);
    const { blocked, result } = await interleaved(
      async (tx) => {
        await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
      },
      () => approvalsService(h.handle.db).list(ESTIMATOR_CALLER(), jobId),
    );
    expect(blocked).toBe(true);
    expect(result.approvals).toHaveLength(1);
  });

  it('refuses every approval route once the company is suspended, and writes nothing', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await h.admin`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}`;
    const service = approvalsService(h.handle.db);
    const input = { id: randomUUID(), revision: await revisionOf(jobId), kind: 'hourly' as const, description: 'Other work', hours: '1' };
    await expect(service.list(ESTIMATOR_CALLER(), jobId)).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(service.propose(ESTIMATOR_CALLER(), jobId, input)).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(service.edit(ESTIMATOR_CALLER(), jobId, id, input)).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(service.approve(OWNER_CALLER(), jobId, id, { revision: input.revision, approverName: 'Pat' })).rejects.toMatchObject({ code: 'not_allowed' });
    expect(await h.admin`SELECT approved_at, ended_at FROM job_price_approvals`).toEqual([{ approved_at: null, ended_at: null }]);
  });

  it('keeps only ids in the audit rows of a proposal, an edit and an approval', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const first = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    const second = (await edit(ESTIMATOR_A, jobId, first, { ...HOURLY, hours: '3' })).body.approval.id as string;
    await approve(OWNER_A, jobId, second, { approverName: OWNER_NAME });
    const rows = await h.admin<{ action: string; details: Record<string, string> }[]>`
      SELECT action, details FROM audit_events WHERE action IN ('price_proposed', 'price_edited', 'price_approved') ORDER BY action, details::text`;
    expect(rows.map((row) => [row.action, Object.keys(row.details).sort()])).toEqual([
      ['price_approved', ['approval']],
      ['price_edited', ['approval', 'replaced_by']],
      ['price_proposed', ['approval']],
      ['price_proposed', ['approval']],
    ]);
  });

  it('previews the pinned price with the current approvals when no estimate is made yet', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const hourly = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, hourly, { approverName: OWNER_NAME });
    const rush = (await propose(ESTIMATOR_A, jobId, { kind: 'named_adjustment', adjustmentId: 'rush_charge' })).body.approval.id as string;
    await approve(OWNER_A, jobId, rush);
    await publish('60.00');
    const preview = await json(repriceRoute.GET(request(OWNER_A, `/api/jobs/${jobId}/reprice`), params({ jobId })));
    // $240.00 and 2.5 h x $50.00 = $125.00, plus the $10.00 rush charge.
    expect(preview.body.reprice).toMatchObject({ pinned: { price: '$375.00' }, newest: { price: '$240.00' } });
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.totals.low.total).toBe('375.00');
  });

  it('refuses a member whose role changed or who was disabled after the sign-in, and writes nothing', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const caller = { companyId: h.seed.a, actorId: h.seed.estimatorA.actor, uid: 'estimator-a', role: 'estimator' as const, capabilities: ['scope' as const, 'jobs_read' as const] };
    const input = { id: randomUUID(), revision: await revisionOf(jobId), kind: 'hourly' as const, description: 'Other work', hours: '1' };
    const service = approvalsService(h.handle.db);
    for (const change of [`role = 'office'`, `status = 'disabled'`]) {
      await h.admin.unsafe(`UPDATE memberships SET ${change} WHERE id = '${h.seed.estimatorA.membership}'`);
      await expect(service.edit(caller, jobId, id, input)).rejects.toMatchObject({ code: 'not_allowed' });
      await expect(service.propose(caller, jobId, input)).rejects.toMatchObject({ code: 'not_allowed' });
      await expect(service.list(caller, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
      await h.admin.unsafe(`UPDATE memberships SET role = 'estimator', status = 'active' WHERE id = '${h.seed.estimatorA.membership}'`);
    }
    expect(await h.admin`SELECT approved_at IS NOT NULL AS approved, ended_at FROM job_price_approvals`).toEqual([{ approved: true, ended_at: null }]);
  });
});

describe('hardening (S5b-8 follow-ups)', () => {
  it('refuses a reprice confirmed against a before-price that an approval changed since the preview', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    const two = await publish('60.00');
    // The owner's preview: $2.00 x 120 sq ft = $240.00 before; the hourly row is not approved yet.
    const seen = await pinnedShown(jobId);
    expect(seen).toBe('$240.00');
    // Meanwhile the owner approves the hourly row on another phone: the before-price is now $365.00, and
    // the job revision has not moved.
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const body = { revision: await revisionOf(jobId), changeId: randomUUID(), versionId: two.id };
    const stale = await json(repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body: { ...body, pinnedPrice: seen } }), params({ jobId })));
    expect(stale).toMatchObject({ status: 409, body: { error: 'preview_stale' } });
    expect(await h.admin`SELECT count(*)::int AS n FROM job_price_pins WHERE job_id = ${jobId}`).toEqual([{ n: 1 }]);
    expect(await h.admin`SELECT ended_at FROM job_price_approvals WHERE id = ${id}`).toEqual([{ ended_at: null }]);
    // Confirmed against the price the preview shows now, it goes through.
    expect(await pinnedShown(jobId)).toBe('$365.00');
    const fresh = await json(repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body: { ...body, pinnedPrice: '$365.00' } }), params({ jobId })));
    expect(fresh.status).toBe(200);
    // A body without the price is refused as unreadable.
    const missing = await json(repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body: { ...body, changeId: randomUUID() } }), params({ jobId })));
    expect(missing).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
  });

  it('refuses an estimate for a caller disabled or moved to another role after the sign-in, and for a suspended company', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const service = estimatesService(h.handle.db);
    const maker = { ...ESTIMATOR_CALLER(), capabilities: ['audit' as const, 'jobs_read' as const] };
    await h.admin`UPDATE memberships SET role = 'office' WHERE company_id = ${h.seed.a} AND actor_id = ${h.seed.estimatorA.actor}`;
    await expect(service.make(maker, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(service.read(maker, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
    await h.admin`UPDATE memberships SET role = 'estimator' WHERE company_id = ${h.seed.a} AND actor_id = ${h.seed.estimatorA.actor}`;
    await h.admin`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}`;
    await expect(service.make(maker, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(service.read(maker, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
    await h.admin`UPDATE companies SET status = 'active' WHERE id = ${h.seed.a}`;
    expect(await h.admin`SELECT count(*)::int AS n FROM job_estimates`).toEqual([{ n: 0 }]);
    expect((await service.make(maker, jobId)).created).toBe(true);
  });

  it('reads priced_extras under the company lock: a switch-off committed while the estimate waits leaves the approvals out', async () => {
    await publish();
    const { jobId } = await submittedJob();
    const id = (await propose(ESTIMATOR_A, jobId, HOURLY)).body.approval.id as string;
    await approve(OWNER_A, jobId, id, { approverName: OWNER_NAME });
    const maker = { ...ESTIMATOR_CALLER(), capabilities: ['audit' as const, 'jobs_read' as const] };
    // The operator holds the company row while switching priced_extras off; the estimate waits for it.
    const made = await interleaved(
      async (tx) => {
        await tx`SELECT id FROM companies WHERE id = ${h.seed.a} FOR UPDATE`;
      },
      () => estimatesService(h.handle.db).make(maker, jobId),
      async (tx) => {
        await tx`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'priced_extras'`;
      },
    );
    expect(made.blocked).toBe(true);
    // $2.00 x 120 sq ft = $240.00, without the approved $125.00 of hours.
    expect(made.result.estimate.totals.low.total).toBe('240.00');
  });
});
