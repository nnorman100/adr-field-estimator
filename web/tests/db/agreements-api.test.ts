import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FieldManifest } from '@/lib/field/canonical';
import { flow, image, json, sha256, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-11, sign on the phone (docs/plans/S5.md, with the 2026-11-13 correction), through the real
// route files as the runtime role against Postgres. A job is made, filled, submitted and priced
// through the real routes (as in estimate-api.test.ts); the signature goes through the photo
// receipt route (?kind=signature) and the agreement through POST /api/jobs/{id}/agreements.
const live = vi.hoisted(() => ({ harness: null as Harness | null, engineChanged: false }));
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
// A later engine release, stood in for: once `engineChanged` is set, the engine writes other words.
vi.mock('@/engine/estimate', async (original) => {
  const real = await original<typeof import('@/engine/estimate')>();
  return {
    ...real,
    priceEstimate: (...args: Parameters<typeof real.priceEstimate>) => {
      const priced = real.priceEstimate(...args);
      if (!live.engineChanged || !priced.ok || !priced.documents) return priced;
      return { ...priced, documents: { ...priced.documents, letter: 'A later engine’s letter.' } };
    },
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { canonicalJson } = await import('@/lib/field/canonical');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
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
  live.engineChanged = false;
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
const readSigned = (claims: FakeClaims | null, jobId: string): Promise<Reply> =>
  json(agreementsRoute.GET(request(claims, `/api/jobs/${jobId}/agreements`), params({ jobId })));

const bodyFor = (estimate: Body, signatureId: string, extra: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  estimateId: estimate.id,
  proposalSha256: estimate.proposalSha256,
  signatureId,
  signerName: 'Casey Customer',
  documentsConfirmed: true,
  ...extra,
});

// A submitted, priced job with the signature already received: everything signing needs.
async function readyToSign(claims: FakeClaims = ESTIMATOR_A) {
  await publish(h.seed.a, '2.00');
  const job = await submittedJob(claims);
  const estimate = (await make(claims, job.jobId)).body.estimate as Body;
  const signatureId = randomUUID();
  const signature = image(`signature ${signatureId}`);
  expect((await putSignature(claims, job.jobId, signatureId, signature)).status).toBe(201);
  return { ...job, estimate, signatureId, signature };
}

const agreementRows = (jobId: string) =>
  h.admin<{ id: string; kind: string; signer_kind: string; signer_name: string; proposal_sha256: string; documents_bytes: Buffer; signed_at: Date; created_by_actor_id: string; estimate_id: string }[]>`
    SELECT id::text, kind, signer_kind, signer_name, proposal_sha256, documents_bytes, signed_at, created_by_actor_id::text, estimate_id::text
    FROM agreements WHERE job_id = ${jobId} ORDER BY signed_at, id
  `;
const signatureRows = (jobId: string) =>
  h.admin<{ object_id: string; sha256: string }[]>`SELECT object_id::text, sha256 FROM evidence_objects WHERE job_id = ${jobId} AND kind = 'signature'`;
const storedBytes = async (jobId: string) => ({
  agreements: (await agreementRows(jobId)).map((row) => row.documents_bytes.toString('base64')),
  estimates: (await h.admin<{ proposal_bytes: Buffer; priced_result: unknown }[]>`SELECT proposal_bytes, priced_result FROM job_estimates WHERE job_id = ${jobId} ORDER BY created_at, id`).map(
    (row) => [row.proposal_bytes.toString('base64'), JSON.stringify(row.priced_result)],
  ),
});
const hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('signing on the phone', () => {
  it('signs the current estimate: one agreement, the job signed, and the signed page says who, when and how', async () => {
    const { jobId, estimate, signatureId, signature } = await readyToSign();
    const answer = await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId));
    expect(answer.status).toBe(201);
    expect(answer.body.job).toMatchObject({ id: jobId, status: 'signed' });

    const [row] = await agreementRows(jobId);
    const [presenter] = await h.admin<{ email: string; display_name: string | null }[]>`SELECT email, display_name FROM actors WHERE id = ${row!.created_by_actor_id}`;
    expect(row).toMatchObject({ kind: 'original', signer_kind: 'device', signer_name: 'Casey Customer', proposal_sha256: estimate.proposalSha256, estimate_id: estimate.id });
    expect(row!.created_by_actor_id).toBe(h.seed.estimatorA.actor);
    // The record states who signed, when (the server's clock, the row's own instant) and how.
    const record = answer.body.agreement.record;
    expect(record.signer).toEqual({ name: 'Casey Customer' });
    expect(record.signed_at).toBe(row!.signed_at.toISOString());
    expect(answer.body.agreement.signedAt).toBe(row!.signed_at.toISOString());
    expect(record.signed_with).toEqual({ kind: 'device', presented_by: { actor_id: h.seed.estimatorA.actor, name: presenter!.display_name ?? presenter!.email } });
    expect(record.signature).toEqual({ id: signatureId, sha256: sha256(signature), content_type: 'image/png' });
    // The answer is the stored bytes read back, and their hash.
    expect(JSON.parse(row!.documents_bytes.toString('utf8'))).toEqual(record);
    expect(answer.body.agreement.documentsSha256).toBe(createHash('sha256').update(row!.documents_bytes).digest('hex'));

    expect((await f.job(jobId)).status).toBe('signed');
    expect(await f.auditActions(jobId)).toEqual(expect.arrayContaining(['signature_received', 'agreement_signed']));
    // Office reads the signed page too; the signature image reads back as stored.
    expect(await readSigned(OFFICE_A, jobId)).toMatchObject({ status: 200, body: { agreement: { id: row!.id, record: { signer: { name: 'Casey Customer' } } } } });
    const shown = await photoRoute.GET(request(OFFICE_A, `/api/jobs/${jobId}/photos/${signatureId}?kind=signature`), params({ jobId, photoId: signatureId }));
    expect(new Uint8Array(await shown.arrayBuffer())).toEqual(signature);
  });

  it('prints the authorization and payment terms exactly as entered, inside the hashed proposal bytes', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect(estimate.proposal).toMatchObject({ format: 'dryscope-proposal-v2', authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT_TERMS });
    const [stored] = await h.admin<{ proposal_bytes: Buffer; proposal_sha256: string }[]>`SELECT proposal_bytes, proposal_sha256 FROM job_estimates WHERE job_id = ${jobId}`;
    const text = stored!.proposal_bytes.toString('utf8');
    // Inside the bytes whose SHA-256 the signature binds, character for character.
    expect(text).toContain(JSON.stringify(AUTHORIZATION));
    expect(text).toContain(JSON.stringify(PAYMENT_TERMS));
    expect(hex(text)).toBe(stored!.proposal_sha256);

    const signed = (await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).body.agreement;
    const [row] = await agreementRows(jobId);
    expect(row!.proposal_sha256).toBe(stored!.proposal_sha256);
    // The signed record holds that same proposal: its canonical text is the stored bytes.
    expect(canonicalJson(signed.record.proposal)).toBe(text);
    expect(signed.record.proposal.authorization_text).toBe(AUTHORIZATION);
    expect(signed.record.proposal.payment_terms_text).toBe(PAYMENT_TERMS);
  });

  it('signs a letter-layout proposal with the company’s own clause: the signed record holds those same bytes (S5a-9b)', async () => {
    const clause = { title: 'Scheduling', text: 'We confirm the start date by phone.' };
    await h.admin`
      UPDATE companies SET profile_documents = ${JSON.stringify({ proposal_layout: 'letter', company_clauses: [clause], authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT_TERMS })}::text::jsonb
      WHERE id = ${h.seed.a}
    `;
    const { jobId, estimate, signatureId } = await readyToSign();
    expect(estimate.proposal).toMatchObject({ company_clauses: [clause], letter: { area_inspected: ['Kitchen', 'Hall'] } });
    const [stored] = await h.admin<{ proposal_bytes: Buffer; proposal_sha256: string }[]>`SELECT proposal_bytes, proposal_sha256 FROM job_estimates WHERE job_id = ${jobId}`;
    const answer = await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId));
    expect(answer.status).toBe(201);
    const [row] = await agreementRows(jobId);
    expect(row!.proposal_sha256).toBe(stored!.proposal_sha256);
    expect(canonicalJson(answer.body.agreement.record.proposal)).toBe(stored!.proposal_bytes.toString('utf8'));
    // The signed page reads the record back with the letter in it.
    expect((await readSigned(OFFICE_A, jobId)).body.agreement.record.proposal).toMatchObject({ company_clauses: [clause], letter: { area_inspected: ['Kitchen', 'Hall'] } });
  });

  it('the same signature twice returns one receipt and one agreement', async () => {
    const { jobId, estimate, signatureId, signature } = await readyToSign();
    const again = await putSignature(ESTIMATOR_A, jobId, signatureId, signature);
    expect(again).toMatchObject({ status: 200, body: { photoId: signatureId, kind: 'signature', sha256: sha256(signature) } });
    const body = bodyFor(estimate, signatureId);
    const first = await sign(ESTIMATOR_A, jobId, body);
    const second = await sign(ESTIMATOR_A, jobId, body);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.agreement).toEqual(first.body.agreement);
    // After signing, the same signature sent again (a lost answer) is still the same receipt.
    expect((await putSignature(ESTIMATOR_A, jobId, signatureId, signature)).status).toBe(200);
    expect(await agreementRows(jobId)).toHaveLength(1);
    expect(await signatureRows(jobId)).toEqual([{ object_id: signatureId, sha256: sha256(signature) }]);
    expect([...h.evidence.objects.keys()].filter((name) => name.includes('/signatures/'))).toEqual([`companies/${h.seed.a}/jobs/${jobId}/signatures/${signatureId}`]);
  });

  it('two phones signing at once with one request make one agreement', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    const body = bodyFor(estimate, signatureId);
    const both = await Promise.all([sign(ESTIMATOR_A, jobId, body), sign(ESTIMATOR_A, jobId, body)]);
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(await agreementRows(jobId)).toHaveLength(1);
  });

  it('a changed body with the same id is 409, and so is the same id on another job', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    const body = bodyFor(estimate, signatureId);
    expect((await sign(ESTIMATOR_A, jobId, body)).status).toBe(201);
    const other = await submittedJob();
    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, { ...body, signerName: 'Someone Else' })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await sign(ESTIMATOR_A, other.jobId, body)).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a second agreement is refused', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    const before = await everything(h.admin);
    expect(await sign(OWNER_A, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 409, body: { error: 'already_signed' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await agreementRows(jobId)).toHaveLength(1);
  });
});

describe('after signing', () => {
  it('every field write, upload, submission and estimate is refused, and the stored bytes are unchanged', async () => {
    const { jobId, draftId, manifest, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    const bytes = await storedBytes(jobId);
    const signed = (await readSigned(ESTIMATOR_A, jobId)).body.agreement;
    const before = await everything(h.admin);

    expect(await json(saveCustomer(ESTIMATOR_A, jobId, '99 Other Road, Testville'))).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    const claim = { revision: (await f.job(jobId)).revision, changeId: randomUUID(), carrier: 'Synthetic Mutual', claimNumber: 'C-2', policyNumber: '', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' };
    expect(await json(claimRoute.PUT(request(ESTIMATOR_A, `/api/jobs/${jobId}/claim`, { method: 'PUT', body: claim }), params({ jobId })))).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    const photoId = randomUUID();
    expect(await f.sendPhoto(ESTIMATOR_A, jobId, photoId, image(photoId))).toMatchObject({ status: 409, body: { error: 'draft_locked' } });
    const another = randomUUID();
    expect(await putSignature(ESTIMATOR_A, jobId, another, image(another))).toMatchObject({ status: 409, body: { error: 'not_ready_to_sign' } });
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: draftId })).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    expect(await make(ESTIMATOR_A, jobId)).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    // The field draft stays submitted, so the field rules refuse every field write (tests/emu).
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'submitted' });

    expect(await everything(h.admin)).toBe(before);
    expect(await storedBytes(jobId)).toEqual(bytes);
    expect((await readSigned(ESTIMATOR_A, jobId)).body.agreement).toEqual(signed);
  });

  it('a price publish or an engine change never alters a signed job’s documents', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
    const bytes = await storedBytes(jobId);
    const signed = (await readSigned(OWNER_A, jobId)).body.agreement;

    await publish(h.seed.a, '9.00');
    await setSigningTexts('Other authorization.', 'Other terms.');
    live.engineChanged = true;
    // The engine does change: a new job priced now gets the later engine's letter.
    const fresh = await submittedJob();
    expect((await make(ESTIMATOR_A, fresh.jobId)).body.estimate.documents.letter).toBe('A later engine’s letter.');

    expect((await readSigned(OWNER_A, jobId)).body.agreement).toEqual(signed);
    expect(await storedBytes(jobId)).toEqual(bytes);
    expect(signed.record.documents.letter).not.toBe('A later engine’s letter.');
  });
});

describe('what signing refuses, writing nothing', () => {
  it('without the authorization or the payment terms: the setup check’s answer', async () => {
    await setSigningTexts('', '   ');
    await publish(h.seed.a, '2.00');
    const { jobId } = await submittedJob();
    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    // The estimate's own setup check lists both, and its documents cannot be signed.
    expect(estimate.staffNotes.companySetupMissing).toEqual(['Start-work authorization', 'Payment terms']);
    expect(estimate.documents.signable).toBe(false);
    const signatureId = randomUUID();
    expect((await putSignature(ESTIMATOR_A, jobId, signatureId, image(signatureId))).status).toBe(201);
    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).toEqual({
      status: 409,
      body: { error: 'company_setup_missing', missing: ['Start-work authorization', 'Payment terms'] },
    });
    // Filled in after pricing: this estimate was made without them, so it still cannot be signed.
    await setSigningTexts(AUTHORIZATION, '');
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 409, body: { missing: ['Payment terms'] } });
    await setSigningTexts(AUTHORIZATION, PAYMENT_TERMS);
    const filled = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 409, body: { error: 'not_signable' } });
    expect(await everything(h.admin)).toBe(filled);
    expect(before).not.toBe(filled);
    expect(await agreementRows(jobId)).toEqual([]);
  });

  it('a new estimate before signing voids the old one for signing', async () => {
    const { jobId, draftId, manifest, estimate: old, signatureId } = await readyToSign();
    // Back to editing, a change, Finish again and a new price: a revised estimate.
    const next = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId })).status).toBe(201);
    // While the job is being edited there is nothing to sign.
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(old, signatureId))).toMatchObject({ status: 409, body: { error: 'not_submitted' } });
    // A reduced quantity: the hall's wet floor from 40 to 20 sq ft.
    const reduced: FieldManifest = { ...manifest, rooms: manifest.rooms.map((room) => (room.id === 'hall' ? { ...room, field: { ...(room.field as object), wetFloorSf: 20 } } : room)) };
    h.field.put(h.seed.a, next, reduced);
    expect((await f.submitShown(ESTIMATOR_A, jobId, next, reduced)).answer.status).toBe(201);
    const revised = (await make(ESTIMATOR_A, jobId)).body.estimate;
    expect(revised.id).not.toBe(old.id);

    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(old, signatureId))).toMatchObject({ status: 409, body: { error: 'estimate_superseded' } });
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(revised, signatureId, { proposalSha256: old.proposalSha256 }))).toMatchObject({ status: 409, body: { error: 'proposal_changed' } });
    expect(await everything(h.admin)).toBe(before);
    const signed = await sign(ESTIMATOR_A, jobId, bodyFor(revised, signatureId));
    expect(signed.status).toBe(201);
    expect(signed.body.agreement.record.basis.estimate_id).toBe(revised.id);
  });

  it('a proposal made before the signed page’s texts existed (format v1) cannot be signed', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    // The stored estimate as S5a-9 made it: the same proposal without the two texts, in format v1.
    const old: Body = { ...estimate.proposal, format: 'dryscope-proposal-v1' };
    delete old.authorization_text;
    delete old.payment_terms_text;
    const v1 = Buffer.from(canonicalJson(old), 'utf8');
    const v1Sha = createHash('sha256').update(v1).digest('hex');
    await h.admin`UPDATE job_estimates SET proposal_bytes = ${v1}, proposal_sha256 = ${v1Sha} WHERE id = ${estimate.id}`;
    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId, { proposalSha256: v1Sha }))).toMatchObject({ status: 409, body: { error: 'not_signable' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('an estimate that needs review after a customer save cannot be signed', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    expect((await saveCustomer(ESTIMATOR_A, jobId, '14 Synthetic Lane, Testville')).status).toBe(200);
    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 409, body: { error: 'needs_review' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a signature needs a current unsigned estimate, and the agreement needs the signature', async () => {
    await publish(h.seed.a, '2.00');
    const draft = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const early = randomUUID();
    expect(await putSignature(ESTIMATOR_A, draft.jobId, early, image(early))).toMatchObject({ status: 409, body: { error: 'not_ready_to_sign' } });
    const { jobId } = await submittedJob();
    expect(await putSignature(ESTIMATOR_A, jobId, early, image(early))).toMatchObject({ status: 409, body: { error: 'not_ready_to_sign' } });
    expect(h.evidence.creates.filter((name) => name.includes('/signatures/'))).toEqual([]);

    const estimate = (await make(ESTIMATOR_A, jobId)).body.estimate;
    const before = await everything(h.admin);
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, randomUUID()))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
    // A photo's id is not a signature.
    expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, draft.photoId))).toMatchObject({ status: 409, body: { error: 'signature_missing' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a body without the documents confirmed, or with a blank name, is a bad request', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    const before = await everything(h.admin);
    for (const extra of [{ documentsConfirmed: false }, { signerName: '   ' }, { signerName: 'Tab\tName' }, { signerName: 'x'.repeat(151) }, { extra: 1 }]) {
      expect(await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId, extra))).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await everything(h.admin)).toBe(before);
    // A name with spaces around it is signed trimmed.
    const signed = await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId, { signerName: '  Casey Customer ' }));
    expect(signed.body.agreement.record.signer.name).toBe('Casey Customer');
  });

  it('who may: office reads but cannot sign; another estimator, company B and no price books get 404; signed out 401', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    await publish(h.seed.b, '2.00');
    const before = await everything(h.admin);
    const other = randomUUID();
    expect(await putSignature(OFFICE_A, jobId, other, image(other))).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await sign(OFFICE_A, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await sign(ESTIMATOR_A2, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await readSigned(ESTIMATOR_A2, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await sign(OWNER_B, jobId, bodyFor(estimate, signatureId))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await readSigned(OWNER_B, jobId)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await putSignature(OWNER_B, jobId, other, image(other))).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((await sign(null, jobId, bodyFor(estimate, signatureId))).status).toBe(401);
    expect((await readSigned(null, jobId)).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
    expect(await readSigned(OFFICE_A, jobId)).toMatchObject({ status: 200, body: { agreement: null, job: { status: 'submitted' } } });

    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a}`;
    expect((await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId))).status).toBe(404);
    expect((await readSigned(OWNER_A, jobId)).status).toBe(404);
    expect(await agreementRows(jobId)).toEqual([]);
  });

  it('the owner signs without any approval step (J2)', async () => {
    const { jobId, estimate, signatureId } = await readyToSign(OWNER_A);
    expect((await sign(OWNER_A, jobId, bodyFor(estimate, signatureId))).status).toBe(201);
  });

  it('a signed agreement keeps its exact stored bytes and photo log unchanged', async () => {
    const { jobId, estimate, signatureId } = await readyToSign();
    const signed = await sign(ESTIMATOR_A, jobId, bodyFor(estimate, signatureId));
    expect(signed.status).toBe(201);
    const before = await storedBytes(jobId);

    // Turning on shot-tag grouping afterward never mutates the signed agreement or its photo log.
    await h.admin`UPDATE companies SET profile_documents = '{"photo_log_grouping": "shot_tag"}'::jsonb WHERE id = ${h.seed.a}`;
    expect(await storedBytes(jobId)).toEqual(before);
    const reloaded = await readSigned(ESTIMATOR_A, jobId);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.agreement.documentsSha256).toBe(signed.body.agreement.documentsSha256);
    expect(reloaded.body.agreement.record.documents.photo_log).toEqual(estimate.documents.photoLog);
  });
});
