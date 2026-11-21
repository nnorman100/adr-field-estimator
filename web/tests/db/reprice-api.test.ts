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
const fieldOwnerRoute = await import('@/app/api/jobs/[jobId]/field-owner/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { revisedLine } = await import('@/lib/estimates/proposal');
const { estimatesService } = await import('@/lib/estimates/service');
const { readStoredEstimate } = await import('@/lib/estimates/result');
const { priceText } = await import('@/lib/estimates/screen');
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
// The signature as the phone sends it: bound to the proposal it was drawn for.
const putSignature = (claims: FakeClaims | null, jobId: string, signatureId: string, bytes: Uint8Array, proposalSha256: string): Promise<Reply> => {
  const built = request(claims, `/api/jobs/${jobId}/photos/${signatureId}?kind=signature`, { method: 'PUT', body: bytes });
  built.headers.set('X-Proposal-Sha256', proposalSha256);
  return json(photoRoute.PUT(built, params({ jobId, photoId: signatureId })));
};
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
  expect((await putSignature(claims, job.jobId, signatureId, image(`signature ${signatureId}`), estimate.proposalSha256)).status).toBe(201);
  return { ...job, version, estimate, signatureId };
}

const OWNER_CALLER = () => ({ companyId: h.seed.a, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: ['job_reprice' as const] });
// The pinned (before) price the owner's preview shows now, as the Reprice banner sends it back (S5b-8).
const shownPinnedPrice = async (jobId: string): Promise<string | null> =>
  ((await json(repriceRoute.GET(request(OWNER_A, `/api/jobs/${jobId}/reprice`), params({ jobId })))).body as Body).reprice?.pinned?.price ?? null;
// A body without `pinnedPrice` gets the one the preview shows, as the screen sends it.
const send = async (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> => {
  const sent = body && typeof body === 'object' && !Array.isArray(body) && !('pinnedPrice' in body) ? { ...body, pinnedPrice: await shownPinnedPrice(jobId) } : body;
  return json(repriceRoute.POST(request(claims, `/api/jobs/${jobId}/reprice`, { method: 'POST', body: sent }), params({ jobId })));
};
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

const withoutScope = (manifest: FieldManifest): FieldManifest => ({
  ...manifest,
  draft: Object.fromEntries(Object.entries(manifest.draft as Record<string, unknown>).filter(([key]) => key !== 'scopeConfirmed')),
});

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
    const seen = (await f.job(jobId)).revision;
    const answer = await reprice(OWNER_A, jobId, { changeId });
    expect(answer).toMatchObject({ status: 200, body: { job: { id: jobId, status: 'submitted', currentDraftId: draftId, revision: seen + 1 }, pin: { sequence: 2, version: 2 } } });
    expect(answer.body).not.toHaveProperty('repriced');
    expect((await f.job(jobId)).revision).toBe(seen + 1);
    expect(await pins(jobId)).toEqual([
      { sequence: 1, version_id: one.id, reason: 'first_price' },
      { sequence: 2, version_id: two.id, reason: 'owner_reprice' },
    ]);
    expect((await repriceAudits(jobId)).map((row) => row.details)).toEqual([
      {
        sequence: 2,
        from_version: 1,
        version: 2,
        change_id: changeId,
        request_revision: seen,
        request_version_id: two.id,
        request_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
        job_status: 'submitted',
        job_draft: draftId,
        job_revision: seen + 1,
      },
    ]);

    // The old estimate is no longer the job's current one: nothing to read, and it cannot be signed.
    expect((await read(ESTIMATOR_A, jobId)).body.estimate).toBeNull();
    let before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(old, signatureId))).toMatchObject({ status: 409 });
    // The scope confirmation was cleared: the record made before the reprice is not priced on the new pin.
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'scope_not_confirmed' } });
    expect(await everything(h.admin)).toBe(before);

    // Back to editing does not carry the old confirmation into the new draft, so Finish without
    // confirming it again is not priced on the new prices.
    const next = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
    expect(h.field.draft(h.seed.a, next)?.field).not.toHaveProperty('scopeConfirmed');
    const unconfirmed = withoutScope(manifest);
    expect((await f.submitShown(ESTIMATOR_A, jobId, next, unconfirmed)).answer.status).toBe(201);
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'scope_not_confirmed' } });

    // Scope confirmed again on a new record: priced from version 2, $3.00 x 120 sq ft.
    await finishAgain(ESTIMATOR_A, jobId, next, manifest);
    const revised = await make(ESTIMATOR_A, jobId);
    expect(revised.status).toBe(201);
    expect(revised.body.estimate).toMatchObject({ price: { pinSequence: 2, versionSequence: 2, tableHash: two.hash } });
    expect(revised.body.estimate.totals.low.total).toBe('360.00');

    // The signature received for the old estimate does not sign the revised one; a new one does.
    before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(revised.body.estimate, signatureId))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
    expect(await everything(h.admin)).toBe(before);
    const fresh = randomUUID();
    expect((await putSignature(ESTIMATOR_A, jobId, fresh, image(`signature ${fresh}`), revised.body.estimate.proposalSha256)).status).toBe(201);
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(revised.body.estimate, fresh))).status).toBe(201);
  });

  it('a signature is bound to the proposal it was captured for, however late it arrives', async () => {
    const { jobId, draftId, manifest, estimate: old } = await readyToSign();
    await publish(h.seed.a, '3.00');
    expect((await reprice(OWNER_A, jobId)).status).toBe(200);
    await finishAgain(ESTIMATOR_A, jobId, draftId, manifest);
    const revised = (await make(ESTIMATOR_A, jobId)).body.estimate as Body;
    expect(revised.proposalSha256).not.toBe(old.proposalSha256);

    // Drawn for the old estimate and sent after the revised one exists: refused at capture.
    const late = randomUUID();
    expect(await putSignature(ESTIMATOR_A, jobId, late, image(`signature ${late}`), old.proposalSha256)).toMatchObject({ status: 409, body: { error: 'not_ready_to_sign' } });
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(revised, late))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
  });

  it('a signature keeps the proposal it was captured for: the same id with the same bytes for another proposal, or for none, is refused', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    const bytes = image(`signature ${signatureId}`);
    const before = await everything(h.admin);
    expect(await putSignature(ESTIMATOR_A, jobId, signatureId, bytes, 'a'.repeat(64))).toMatchObject({ status: 409, body: { error: 'photo_conflict' } });
    expect(await putSignature(ESTIMATOR_A, jobId, signatureId, bytes, 'not a hash')).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    const bare = request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${signatureId}?kind=signature`, { method: 'PUT', body: bytes });
    expect(await json(photoRoute.PUT(bare, params({ jobId, photoId: signatureId })))).toMatchObject({ status: 409, body: { error: 'photo_conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await putSignature(ESTIMATOR_A, jobId, signatureId, bytes, estimate.proposalSha256)).toMatchObject({ status: 200 });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a job already priced from the reviewed prices is refused, with nothing written', async () => {
    const { jobId } = await readyToSign();
    const before = await everything(h.admin);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 409, body: { error: 'prices_unchanged' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('the same change sent twice, even after newer prices are published, makes one pin and one audit row and is answered the same', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    // The same change is the same body, the price the preview showed at the first send included.
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: (await h.admin<{ id: string }[]>`SELECT id::text FROM price_table_versions WHERE company_id = ${h.seed.a} AND sequence = 2`)[0]!.id, pinnedPrice: await shownPinnedPrice(jobId) };
    const first = await send(OWNER_A, jobId, change);
    expect(first).toMatchObject({ status: 200, body: { pin: { sequence: 2, version: 2 } } });
    await publish(h.seed.a, '4.00');
    expect(await send(OWNER_A, jobId, change)).toEqual(first);
    const [again, together] = await Promise.all([send(OWNER_A, jobId, change), send(OWNER_A, jobId, change)]);
    expect(again).toEqual(first);
    expect(together).toEqual(first);
    expect((await pins(jobId)).map((pin) => pin.sequence)).toEqual([1, 2]);
    expect(await repriceAudits(jobId)).toHaveLength(1);
  });

  it('a retry after the job moved on is answered with the original answer; the same change with another body is refused', async () => {
    const { jobId, draftId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: two.id, pinnedPrice: await shownPinnedPrice(jobId) };
    const first = await send(OWNER_A, jobId, change);
    expect(first.status).toBe(200);
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: draftId })).status).toBe(201);
    expect(await send(OWNER_A, jobId, change)).toEqual(first);
    const before = await everything(h.admin);
    expect(await send(OWNER_A, jobId, { ...change, revision: change.revision + 1 })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await send(OWNER_A, jobId, { ...change, versionId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('binds the change id to the whole confirmation: the same body again is answered as the first time, another price is refused', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: two.id, pinnedPrice: await shownPinnedPrice(jobId) };
    expect(change.pinnedPrice).toBe('$240.00');
    const first = await send(OWNER_A, jobId, change);
    expect(first.status).toBe(200);
    expect(await send(OWNER_A, jobId, change)).toEqual(first);
    const before = await everything(h.admin);
    expect(await send(OWNER_A, jobId, { ...change, pinnedPrice: '$365.00' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await send(OWNER_A, jobId, { ...change, pinnedPrice: null })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await repriceAudits(jobId)).toHaveLength(1);
  });

  it('an older audit row without the digest is still compared on its revision and version', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: two.id, pinnedPrice: await shownPinnedPrice(jobId) };
    const first = await send(OWNER_A, jobId, change);
    expect(first.status).toBe(200);
    await h.admin`UPDATE audit_events SET details = details - 'request_digest' WHERE target = ${jobId} AND action = 'job_repriced'`;
    expect(await send(OWNER_A, jobId, change)).toEqual(first);
    expect(await send(OWNER_A, jobId, { ...change, revision: change.revision + 1 })).toMatchObject({ status: 409, body: { error: 'conflict' } });
  });

  it('a retry of a reprice the previous release made, sent without the price, is answered with the original answer', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const change = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: two.id, pinnedPrice: await shownPinnedPrice(jobId) };
    const first = await send(OWNER_A, jobId, change);
    expect(first.status).toBe(200);
    const raw = { revision: change.revision, changeId: change.changeId, versionId: change.versionId };
    const post = (body: unknown) => json(repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body }), params({ jobId })));
    const before = await everything(h.admin);
    expect(await post(raw)).toMatchObject({ status: 409, body: { error: 'conflict' } });
    await h.admin`UPDATE audit_events SET details = details - 'request_digest' WHERE target = ${jobId} AND action = 'job_repriced'`;
    const legacy = await everything(h.admin);
    expect(await post(raw)).toEqual(first);
    expect(await post({ ...raw, revision: raw.revision + 1 })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(legacy);
    expect(before).not.toBe(legacy);
  });

  it('a new confirmation without the price is 400 and writes nothing', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    const raw = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: two.id };
    expect(await json(repriceRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/reprice`, { method: 'POST', body: raw }), params({ jobId })))).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await pins(jobId)).toHaveLength(1);
  });

  it('a suspended company, or price books switched off, is refused for the preview and the confirmation before the job is read', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    const call = {
      preview: () => estimatesService(h.handle.db).repricePreview(OWNER_CALLER(), jobId),
      confirm: async () => {
        const [newest] = await h.admin<{ id: string }[]>`SELECT id::text FROM price_table_versions WHERE company_id = ${h.seed.a} ORDER BY sequence DESC LIMIT 1`;
        return estimatesService(h.handle.db).reprice(OWNER_CALLER(), jobId, { revision: (await f.job(jobId)).revision, changeId: randomUUID(), versionId: newest!.id, pinnedPrice: '$240.00' });
      },
    };
    await h.admin`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}`;
    for (const run of [call.preview, call.confirm]) await expect(run()).rejects.toMatchObject({ code: 'not_allowed' });
    await h.admin`UPDATE companies SET status = 'active' WHERE id = ${h.seed.a}`;
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    for (const run of [call.preview, call.confirm]) await expect(run()).rejects.toMatchObject({ code: 'not_found' });
    await h.admin`UPDATE company_feature_flags SET enabled = true WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    expect(await everything(h.admin)).toBe(before);
    expect((await call.confirm()).pin.version).toBe(2);
  });

  it('a second confirmation carrying the revision from before the first pin move is stale, even for the newest prices', async () => {
    const { jobId } = await readyToSign();
    const seen = (await f.job(jobId)).revision;
    await publish(h.seed.a, '3.00');
    expect((await reprice(OWNER_A, jobId)).status).toBe(200);
    const three = await publish(h.seed.a, '4.00');
    const before = await everything(h.admin);
    expect(await send(OWNER_A, jobId, { revision: seen, changeId: randomUUID(), versionId: three.id })).toMatchObject({ status: 409, body: { error: 'stale_revision' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 200, body: { pin: { sequence: 3, version: 3 } } });
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

  it('a job back in editing is repriced, and Finish on that open draft still needs a fresh scope confirmation', async () => {
    const { jobId, draftId, manifest } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const open = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(201);
    // The open draft carries the confirmation given at the old prices.
    expect(h.field.draft(h.seed.a, open)?.field).toHaveProperty('scopeConfirmed', true);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 200, body: { job: { id: jobId, status: 'draft', currentDraftId: open }, pin: { sequence: 2, version: 2 } } });
    expect((await pins(jobId)).map((pin) => pin.version_id)).toEqual([expect.any(String), two.id]);

    // Finish on the same open draft is not priced: its confirmation predates the new prices.
    expect((await f.submitShown(ESTIMATOR_A, jobId, open, manifest)).answer.status).toBe(201);
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'scope_not_confirmed' } });

    // Back to editing starts unconfirmed, and a fresh confirmation is priced from the new prices.
    const fresh = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: fresh, fromDraftId: open })).status).toBe(201);
    expect(h.field.draft(h.seed.a, fresh)?.field).not.toHaveProperty('scopeConfirmed');
    h.field.put(h.seed.a, fresh, manifest);
    expect((await f.submitShown(ESTIMATOR_A, jobId, fresh, manifest)).answer.status).toBe(201);
    const revised = await make(ESTIMATOR_A, jobId);
    expect(revised.status).toBe(201);
    expect(revised.body.estimate).toMatchObject({ price: { pinSequence: 2, versionSequence: 2 } });
  });

  // Back to editing commits, its field draft is never made, and the owner reprices while that draft is
  // current (the reprice names it). The draft the sync then makes from the record starts unconfirmed.
  it('a draft the sync makes from the record after a reprice of the draft Back to editing left current starts unconfirmed', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const open = randomUUID();
    // Back to editing's field step (the draft sync) fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(503);
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 200, body: { job: { status: 'draft', currentDraftId: open } } });
    // Start field work syncs the job: the missing current draft is made from the latest record.
    const started = await json(fieldOwnerRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), params({ jobId })));
    expect(started.status).toBe(200);
    expect(h.field.draft(h.seed.a, open)).toMatchObject({ jobId, state: 'editing', previous: { draftId } });
    expect(h.field.draft(h.seed.a, open)?.field).not.toHaveProperty('scopeConfirmed');
  });

  // The same, with the reprice committing while the sync that makes the draft is held after it read Postgres:
  // the sync's version check sees the reprice and syncs again, so the made draft starts unconfirmed.
  it('a draft the sync is making when the owner reprices starts unconfirmed', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const open = randomUUID();
    // Back to editing's field step (the draft sync) fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(503);
    let arrived = false;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.field.gate.sync = async () => {
      delete h.field.gate.sync;
      arrived = true;
      await held;
    };
    const started = json(fieldOwnerRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), params({ jobId })));
    for (const deadline = Date.now() + 10_000; !arrived; ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for the draft sync');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await reprice(OWNER_A, jobId)).toMatchObject({ status: 200, body: { job: { status: 'draft', currentDraftId: open } } });
    release();
    expect((await started).status).toBe(200);
    expect(h.field.draft(h.seed.a, open)).toMatchObject({ jobId, state: 'editing', previous: { draftId } });
    expect(h.field.draft(h.seed.a, open)?.field).not.toHaveProperty('scopeConfirmed');
  });

  // reprice-after-version-check: the reprice commits after the sync's version check passed and before its
  // Firestore commit, so the draft is written at the older job revision. The catch-up is then a new field
  // revision, not a retry at the same one, and writes the draft's legacy archive revision to the job's.
  it('a reprice between the sync’s version check and its commit is caught up at a new version', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const open = randomUUID();
    // Back to editing's field step (the draft sync) fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(503);
    const sync = h.field.sync;
    let repriced = false;
    // The field revision the check passed at, before the reprice landed.
    let checkedAt = -1;
    h.field.sync = (company, job, gen, options = {}) =>
      sync(company, job, gen, {
        ...options,
        stillCurrent: async () => {
          const current = await options.stillCurrent!();
          if (current && !repriced) {
            repriced = true;
            checkedAt = job.v;
            expect((await reprice(OWNER_A, jobId)).status).toBe(200);
          }
          return current;
        },
      });
    try {
      const started = await json(fieldOwnerRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), params({ jobId })));
      expect(started.status).toBe(200);
    } finally {
      h.field.sync = sync;
    }
    expect(repriced).toBe(true);
    expect(h.field.draft(h.seed.a, open)).toMatchObject({ jobId, state: 'editing', archiveRevision: (await f.job(jobId)).revision });
    // The catch-up was exactly one field revision higher, not a replan at the same one.
    const [fieldRevision] = await h.admin<{ v: number }[]>`SELECT field_revision::int AS v FROM jobs WHERE id = ${jobId}`;
    expect(fieldRevision!.v).toBe(checkedAt + 1);
    expect(h.field.marker(h.seed.a, jobId)).toMatchObject({ v: checkedAt + 1 });
    // The first commit made the draft with the confirmation it read; a sync never rewrites field work, so
    // the catch-up keeps it (the estimate refuses a confirmation older than the reprice).
    expect(h.field.draft(h.seed.a, open)?.field).toHaveProperty('scopeConfirmed', true);
    const [row] = await h.admin<{ behind: boolean }[]>`SELECT field_synced_revision < field_revision AS behind FROM jobs WHERE id = ${jobId}`;
    expect(row!.behind).toBe(false);
  });

  // R3 (slice 4b review): the sync commits the older job revision's keys and its answer is lost; the one
  // more try meets a marker written at the older job revision, so it is planned again and writes the job's
  // revision rather than answering `same`.
  it('a sync whose answer was lost while a reprice landed is tried again at a new version', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const open = randomUUID();
    // Back to editing's field step (the draft sync) fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(503);
    const sync = h.field.sync;
    let repriced = false;
    h.field.sync = (company, job, gen, options = {}) =>
      sync(company, job, gen, {
        ...options,
        stillCurrent: async () => {
          const current = await options.stillCurrent!();
          if (current && !repriced) {
            repriced = true;
            expect((await reprice(OWNER_A, jobId)).status).toBe(200);
            // This try commits, and its answer is lost.
            h.field.loseNext.sync = true;
          }
          return current;
        },
      });
    try {
      const started = await json(fieldOwnerRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), params({ jobId })));
      expect(started.status).toBe(200);
    } finally {
      h.field.sync = sync;
    }
    expect(h.field.draft(h.seed.a, open)).toMatchObject({ jobId, state: 'editing', archiveRevision: (await f.job(jobId)).revision });
  });

  // R2 (slice 4b review round 2): the first try fails, and the last one commits while a reprice lands after
  // its version check, then loses its answer. The next request starts again at the same field revision: its
  // marker was written at the older job revision, so it is planned again and writes the job's revision.
  it('a last try whose answer was lost while a reprice landed is caught up by the next request', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    const open = randomUUID();
    // Back to editing's field step (the draft sync) fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: open, fromDraftId: draftId })).status).toBe(503);
    h.field.failNext.sync = 1;
    const sync = h.field.sync;
    let repriced = false;
    h.field.sync = (company, job, gen, options = {}) =>
      sync(company, job, gen, {
        ...options,
        stillCurrent: async () => {
          const current = await options.stillCurrent!();
          if (current && !repriced) {
            repriced = true;
            expect((await reprice(OWNER_A, jobId)).status).toBe(200);
            h.field.loseNext.sync = true;
          }
          return current;
        },
      });
    const start = () => json(fieldOwnerRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), params({ jobId })));
    try {
      expect(await start()).toMatchObject({ status: 503, body: { error: 'draft_unavailable' } });
    } finally {
      h.field.sync = sync;
    }
    expect(repriced).toBe(true);
    expect((await start()).status).toBe(200);
    expect(h.field.draft(h.seed.a, open)).toMatchObject({ jobId, state: 'editing', archiveRevision: (await f.job(jobId)).revision });
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

const preview = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(repriceRoute.GET(request(claims, `/api/jobs/${jobId}/reprice`), params({ jobId })));
const agreementsOf = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(agreementsRoute.GET(request(claims, `/api/jobs/${jobId}/agreements`), params({ jobId })));
// The day a revised estimate made now is headed with (UTC, written out).
const today = () => new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date());
const showPreviousPrice = () =>
  h.admin`UPDATE companies SET profile_documents = profile_documents || '{"show_previous_price": true}'::jsonb WHERE id = ${h.seed.a}`;

// Reprices the ready job to $3.00 and prices it again on a new record with the scope confirmed.
async function repricedEstimate() {
  const job = await readyToSign();
  await publish(h.seed.a, '3.00');
  expect((await reprice(OWNER_A, job.jobId)).status).toBe(200);
  await finishAgain(ESTIMATOR_A, job.jobId, job.draftId, job.manifest);
  const revised = await make(ESTIMATOR_A, job.jobId);
  expect(revised.status).toBe(201);
  return { ...job, revised: revised.body.estimate as Body };
}

describe('the revised estimate heading (D6)', () => {
  it('a first estimate has no revised line; the estimate after a reprice is headed "Revised {date}" without the previous price', async () => {
    const { estimate: first, revised } = await repricedEstimate();
    expect(first.proposal).not.toHaveProperty('revised');
    expect(revised.proposal.revised).toBe(`Revised ${today()}`);
    expect(revised.proposal.heading).toBe(first.proposal.heading);
    // The line is in the stored bytes the signature binds, and reads back the same.
    const [row] = await h.admin<{ proposal_bytes: Buffer }[]>`SELECT proposal_bytes FROM job_estimates WHERE id = ${revised.id}`;
    expect(JSON.parse(row!.proposal_bytes.toString('utf8')).revised).toBe(`Revised ${today()}`);
    expect((await read(OWNER_A, revised.jobId)).body.estimate.proposal.revised).toBe(`Revised ${today()}`);
  });

  it('with the company’s show_previous_price on, before signing it reads "Revised {date}: was {previous price}"', async () => {
    await showPreviousPrice();
    const { revised } = await repricedEstimate();
    expect(revised.proposal.revised).toBe(`Revised ${today()}: was $240.00`);
  });

  it('Back to editing without a reprice is a revised estimate too, with the previous price only when the setting is on', async () => {
    await showPreviousPrice();
    const { jobId, draftId, manifest } = await readyToSign();
    await finishAgain(ESTIMATOR_A, jobId, draftId, manifest);
    expect((await make(ESTIMATOR_A, jobId)).body.estimate.proposal.revised).toBe(`Revised ${today()}: was $240.00`);
  });

  it('a job with a signed agreement is headed with the agreement’s stored price, whatever the setting', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    const [agreement] = await h.admin<{ priced_result: unknown }[]>`SELECT priced_result FROM agreements WHERE job_id = ${jobId}`;
    const signed = priceText(readStoredEstimate(agreement!.priced_result).totals);
    const made = new Date('2026-11-19T12:00:00Z');
    const lineWith = (showPrevious: boolean) => revisedLine(made, { previous: '$999.00', signed, showPrevious });
    expect(lineWith(false)).toBe('Revised November 19, 2026: was $240.00');
    expect(lineWith(true)).toBe('Revised November 19, 2026: was $240.00');
  });

  it('a signed proposal is unchanged: the agreement keeps the bytes it was signed with, with no revised line', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    await showPreviousPrice();
    await publish(h.seed.a, '3.00');
    const signed = await agreementsOf(OWNER_A, jobId);
    expect(signed.status).toBe(200);
    expect(JSON.stringify(signed.body)).not.toContain('Revised');
    const [row] = await h.admin<{ proposal_sha256: string }[]>`SELECT proposal_sha256 FROM agreements WHERE job_id = ${jobId}`;
    expect(row!.proposal_sha256).toBe(estimate.proposalSha256);
  });
});

describe('the before/after preview', () => {
  it('shows the owner the job’s record priced from its pinned prices and from the newest, and writes nothing', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    const before = await everything(h.admin);
    const answer = await preview(OWNER_A, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      job: { revision: (await f.job(jobId)).revision },
      reprice: { pinned: { version: 1, price: '$240.00', refused: null }, newest: { versionId: two.id, version: 2, price: '$360.00', refused: null } },
    });
    expect(await everything(h.admin)).toBe(before);
  });

  it('prices only the two totals: company settings the documents cannot be built from do not stop it', async () => {
    const { jobId } = await readyToSign();
    const two = await publish(h.seed.a, '3.00');
    await h.admin`UPDATE companies SET profile_documents = profile_documents || '{"photo_log_grouping": "by_colour"}'::jsonb WHERE id = ${h.seed.a}`;
    const answer = await preview(OWNER_A, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body.reprice).toMatchObject({ pinned: { price: '$240.00' }, newest: { versionId: two.id, price: '$360.00' } });
  });

  it('while the job is back in editing, previews its last record', async () => {
    const { jobId, draftId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: draftId })).status).toBe(201);
    expect((await preview(OWNER_A, jobId)).body.reprice).toMatchObject({ pinned: { price: '$240.00' }, newest: { price: '$360.00' } });
  });

  it('has nothing to show on the newest prices, a never-priced job or a signed job', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await preview(OWNER_A, jobId)).body.reprice).toBeNull();
    const unpriced = await submittedJob();
    await publish(h.seed.a, '3.00');
    expect((await preview(OWNER_A, unpriced.jobId)).body.reprice).toBeNull();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    expect((await preview(OWNER_A, jobId)).body.reprice).toBeNull();
  });

  it('is refused to an owner who was disabled after the sign-in was verified, and reads nothing', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.ownerA.membership}`;
    const caller = { companyId: h.seed.a, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: ['job_reprice' as const] };
    await expect(estimatesService(h.handle.db).repricePreview(caller, jobId)).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('is the owner’s only: estimator and office are 403, another company’s owner 404, signed out 401', async () => {
    const { jobId } = await readyToSign();
    await publish(h.seed.a, '3.00');
    expect((await preview(ESTIMATOR_A, jobId)).status).toBe(403);
    expect((await preview(OFFICE_A, jobId)).status).toBe(403);
    expect((await preview(OWNER_B, jobId)).status).toBe(404);
    expect((await preview(null, jobId)).status).toBe(401);
  });
});
