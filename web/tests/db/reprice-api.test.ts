import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, image, json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-6, Reprice this draft (docs/plans/S5/S5b-6.md; pricing plan S5b-1), through the real route
// files as the runtime role against Postgres. A job is made, submitted, priced and made ready to
// sign through the real routes (as in agreements-api.test.ts); the owner then reprices it through
// POST /api/jobs/{id}/reprice.
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
vi.mock('@/lib/agreements/services', async () => {
  const { agreementsService } = await import('@/lib/agreements/service');
  return { agreementsServices: () => agreementsService(live.harness!.handle.db) };
});
const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const repriceRoute = await import('@/app/api/jobs/[jobId]/reprice/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

// The company's own wording for the signed page, with leading spaces, line breaks and a blank line,
// so "exactly as entered" is tested (synthetic text; DryScope ships no wording of its own here).
const AUTHORIZATION = '  Synthetic start-work authorization, line one.\n\nLine two, after a blank line.';
const PAYMENT_TERMS = 'Synthetic payment terms:\n  - half at start\n  - half at completion';

const f = flow(() => h, {
  createJob: jobsRoute.POST,
  putPhoto: photoRoute.PUT,
  submit: submissionsRoute.POST,
  nextDraft: draftsRoute.POST,
  request,
  params,
});

async function setSigningTexts(authorization: string, payment: string) {
  await h.admin`
    UPDATE companies SET profile_documents = ${JSON.stringify({ authorization_text: authorization, payment_terms_text: payment })}::text::jsonb
    WHERE id = ${h.seed.a}
  `;
}

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true), (${h.seed.b}, 'price_books', true)`;
  // Company A's profile, as its owner saved it on Company settings.
  await h.admin`
    UPDATE companies SET profile_address = '1 Synthetic Way, Testville', profile_phone = '555-0100', profile_email = 'office@example.invalid',
      profile_license = '000001', profile_signoff = 'Pat Example'
    WHERE id = ${h.seed.a}
  `;
  await setSigningTexts(AUTHORIZATION, PAYMENT_TERMS);
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// Publishes the company's next price version: `price` per square foot of wet floor.
async function publish(company: string, price: string): Promise<{ id: string; sequence: number; hash: string }> {
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: price }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  });
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

function manifestOf(photoId: string): FieldManifest {
  return {
    draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
    ],
    photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'source' } }],
  };
}

async function saveCustomer(claims: FakeClaims, jobId: string, propertyAddress: string) {
  const body = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress };
  return customerRoute.PUT(request(claims, `/api/jobs/${jobId}/customer`, { method: 'PUT', body }), params({ jobId }));
}

// A submitted job of company A, made by `claims`.
async function submittedJob(claims: FakeClaims = ESTIMATOR_A) {
  const ready = await f.readyJob(claims, h.seed.a);
  expect((await saveCustomer(claims, ready.jobId, '12 Synthetic Lane, Testville')).status).toBe(200);
  const manifest = manifestOf(ready.photoId);
  h.field.put(h.seed.a, ready.draftId, manifest);
  const { answer } = await f.submitShown(claims, ready.jobId, ready.draftId, manifest);
  expect(answer.status).toBe(201);
  return { ...ready, manifest };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
type Reply = Answer & { body: Body };
const make = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(estimateRoute.POST(request(claims, `/api/jobs/${jobId}/estimate`, { method: 'POST' }), params({ jobId })));
const putSignature = (claims: FakeClaims | null, jobId: string, signatureId: string, bytes: Uint8Array): Promise<Reply> =>
  json(photoRoute.PUT(request(claims, `/api/jobs/${jobId}/photos/${signatureId}?kind=signature`, { method: 'PUT', body: bytes }), params({ jobId, photoId: signatureId })));
const sign = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(agreementsRoute.POST(request(claims, `/api/jobs/${jobId}/agreements`, { method: 'POST', body }), params({ jobId })));

const bodyFor = (estimate: Body, signatureId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  estimateId: estimate.id,
  proposalSha256: estimate.proposalSha256,
  signatureId,
  signerName: 'Casey Customer',
  documentsConfirmed: true,
  ...extra,});

// A submitted, priced job with the signature already received: everything signing needs.
async function readyToSign(claims: FakeClaims = ESTIMATOR_A) {
  const version = await publish(h.seed.a, '2.00');
  const job = await submittedJob(claims);
  const estimate = (await make(claims, job.jobId)).body.estimate as Body;
  const signatureId = randomUUID();
  expect((await putSignature(claims, job.jobId, signatureId, image(`signature ${signatureId}`))).status).toBe(201);
  return { ...job, version, estimate, signatureId };
}

const send = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(repriceRoute.POST(request(claims, `/api/jobs/${jobId}/reprice`, { method: 'POST', body }), params({ jobId })));
// The owner's confirmation as the screen sends it: the job revision it saw, a change id of its own and
// the version it showed (the newest unless the test names another).
async function reprice(claims: FakeClaims | null, jobId: string, extra: Record<string, unknown> = {}): Promise<Reply> {
  const [newest] = await h.admin<{ id: string }[]>`SELECT id::text FROM price_table_versions WHERE company_id = ${h.seed.a} ORDER BY sequence DESC LIMIT 1`;
  return send(claims, jobId, { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: newest!.id, ...extra });
}
const read = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(estimateRoute.GET(request(claims, `/api/jobs/${jobId}/estimate`), params({ jobId })));
const pins = (jobId: string) =>
  h.admin<{ sequence: number; version_id: string; reason: string }[]>`SELECT sequence, version_id::text, reason FROM job_price_pins WHERE job_id = ${jobId} ORDER BY sequence`;
const repriceAudits = (jobId: string) =>
  h.admin<{ details: Record<string, number | string> }[]>`SELECT details FROM audit_events WHERE target = ${jobId} AND action = 'job_repriced' ORDER BY id`;

// Back to editing, then Finish and review again with the scope confirmed once more: a new record.
async function finishAgain(claims: FakeClaims, jobId: string, draftId: string, manifest: FieldManifest) {
  const next = randomUUID();
  expect((await f.nextDraft(claims, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
  h.field.put(h.seed.a, next, manifest);
  expect((await f.submitShown(claims, jobId, next, manifest)).answer.status).toBe(201);
}

describe('the owner reprices a draft', () => {
  it('moves the pin to the reviewed prices; the old estimate cannot be signed, scope is confirmed again, and the revised estimate needs a new signature', async () => {
    const { jobId, draftId, manifest, version: one, estimate: old, signatureId } = await readyToSign();
    expect(old.totals.low.total).toBe('240.00');
    const two = await publish(h.seed.a, '3.00');

    const changeId = randomUUID();
    const answer = await reprice(OWNER_A, jobId, { changeId });
    expect(answer).toMatchObject({ status: 200, body: { repriced: true, job: { id: jobId, status: 'submitted' }, pin: { sequence: 2, version: 2 } } });
    expect(await pins(jobId)).toEqual([
      { sequence: 1, version_id: one.id, reason: 'first_price' },
      { sequence: 2, version_id: two.id, reason: 'owner_reprice' },
    ]);
    expect((await repriceAudits(jobId)).map((row) => row.details)).toEqual([{ sequence: 2, from_version: 1, version: 2, change_id: changeId }]);

    // The old estimate is no longer the job's current one: nothing to read, and it cannot be signed.
    expect((await read(ESTIMATOR_A, jobId)).body.estimate).toBeNull();
    let before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(old, signatureId))).toMatchObject({ status: 409 });
    // The scope confirmation was cleared: the record made before the reprice is not priced on the new pin.
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'scope_not_confirmed' } });
    expect(await everything(h.admin)).toBe(before);

    // Scope confirmed again on a new record: priced from version 2, $3.00 x 120 sq ft.
    await finishAgain(ESTIMATOR_A, jobId, draftId, manifest);
    const revised = await make(ESTIMATOR_A, jobId);
    expect(revised.status).toBe(201);
    expect(revised.body.estimate).toMatchObject({ price: { pinSequence: 2, versionSequence: 2, tableHash: two.hash } });
    expect(revised.body.estimate.totals.low.total).toBe('360.00');

    // The signature received for the old estimate does not sign the revised one; a new one does.
    before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(revised.body.estimate, signatureId))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
    expect(await everything(h.admin)).toBe(before);
    const fresh = randomUUID();
    expect((await putSignature(ESTIMATOR_A, jobId, fresh, image(`signature ${fresh}`))).status).toBe(201);
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(revised.body.estimate, fresh))).status).toBe(201);
  });

  it('a job already on the reviewed prices is answered as it is, with nothing written', async () => {
    const { jobId } = await readyToSign();
    const before = await everything(h.admin);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 200, body: { repriced: false, pin: { sequence: 1, version: 1 } } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('the same change sent twice, even after newer prices are published, makes one pin and one audit row and is answered the same', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: (await h.admin<{ id: string }[]>`SELECT id::text FROM price_table_versions WHERE company_id = ${h.seed.a} AND sequence = 2`)[0]!.id };
    const first = await send(OWNER_A, jobId, change);
    expect(first).toMatchObject({ status: 200, body: { repriced: true, pin: { sequence: 2, version: 2 } } });
    await publish(h.seed.a, '4.00');
    expect(await send(OWNER_A, jobId, change)).toEqual(first);
    const [again, together] = await Promise.all([send(OWNER_A, jobId, change), send(OWNER_A, jobId, change)]);
    expect(again).toEqual(first);
    expect(together).toEqual(first);
    expect((await pins(jobId)).map((pin) => pin.sequence)).toEqual([1, 2]);
    expect(await repriceAudits(jobId)).toHaveLength(1);
  });
});

describe('what is refused, and writes nothing', () => {
  it('estimator and office are 403; another company’s owner is 404; signed out is 401', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    expect(await reprice(ESTIMATOR_A, jobId)).toMatchObject({ status: 403 });
    expect(await reprice(OFFICE_A, jobId)).toMatchObject({ status: 403 });
    expect(await reprice(OWNER_B, jobId)).toMatchObject({ status: 404 });
    expect((await reprice(null, jobId)).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
  });

  it('prices the owner did not review are not applied: a newer version is 409, a stale job revision is 409', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    await publish(h.seed.a, '4.00');
    const before = await everything(h.admin);
    expect(await reprice(OWNER_A, jobId, { versionId: two.id })).toMatchObject({ status: 409, body: { error: 'prices_superseded' } });
    expect(await reprice(OWNER_A, jobId, { versionId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'prices_superseded' } });
    expect(await reprice(OWNER_A, jobId, { revision: (await f.job(jobId)).revision + 1 })).toMatchObject({ status: 409, body: { error: 'stale_revision' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a body that is not the three fields is 400', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    const good = { revision: 1, changeId: randomUUID(), versionId: randomUUID() };
    for (const body of [{}, { ...good, revision: 0 }, { ...good, changeId: 'x' }, { ...good, versionId: 'x' }, { ...good, extra: true }, { changeId: good.changeId, versionId: good.versionId }]) {
      expect(await send(OWNER_A, jobId, body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('a job never priced has no pin to move', async () => {
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const before = await everything(h.admin);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 409, body: { error: 'not_priced' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a signed job is not repriced', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a company without price books gets 404', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    expect((await reprice(OWNER_A, jobId)).status).toBe(404);
    expect(await pins(jobId)).toHaveLength(1);
  });
});
