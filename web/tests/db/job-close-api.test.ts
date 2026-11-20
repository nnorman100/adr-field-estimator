import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import { image, json } from './submission-flow';
import { ESTIMATOR_A, linkFlow, OFFICE_A, OWNER_A, OWNER_B, type Body, type Reply } from './link-flow';
import { newJob } from './job-harness';
import { agreementOf, insertAgreement, newSubmission, seedEstimate, seedPin, seedSignature, seedVersion } from './submission-harness';
import type { FakeClaims, Harness } from './team-harness';

// S5b-10 slice 10B, job close and the estimate history: the history sample written in the signing
// transaction (on the phone and through a signing link, with the estimate_assist switch off), a sample
// that cannot be written leaving the signature as it is, and GET /api/jobs/{jobId}/outcome and POST
// /api/jobs/{jobId}/close through the real route files as the runtime role against Postgres: the
// baseline is the job's first signed estimate, written from its signed record when missing; replays,
// corrections and stale requests; the estimator sees only that the job closed; nothing signed changes.
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
vi.mock('@/lib/links/services', async () => {
  const { signingLinksService } = await import('@/lib/links/signing');
  const { documentLinksService } = await import('@/lib/links/documents');
  return {
    signingLinksServices: () => signingLinksService(live.harness!.handle.db, live.harness!.photos),
    documentLinksServices: () => documentLinksService(live.harness!.handle.db, live.harness!.photos),
  };
});
vi.mock('@/lib/drying/services', async () => {
  const { outcomeService } = await import('@/lib/drying/outcome');
  return { dryingServices: () => ({ outcome: outcomeService(live.harness!.handle.db) }) };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const estimateRoute = await import('@/app/api/jobs/[jobId]/estimate/route');
const agreementsRoute = await import('@/app/api/jobs/[jobId]/agreements/route');
const signingLinkRoute = await import('@/app/api/jobs/[jobId]/signing-link/route');
const signRoute = await import('@/app/api/sign/route');
const signatureRoute = await import('@/app/api/sign/signature/[signatureId]/route');
const signedSignatureRoute = await import('@/app/api/sign/signature/route');
const outcomeRoute = await import('@/app/api/jobs/[jobId]/outcome/route');
const closeRoute = await import('@/app/api/jobs/[jobId]/close/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

async function publish(company: string, price: string) {
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
  const owner = company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor;
  await h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${company}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${owner}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${company}
  `;
}

const l = linkFlow(
  () => h,
  {
    createJob: jobsRoute.POST,
    putPhoto: photoRoute.PUT,
    submit: submissionsRoute.POST,
    nextDraft: draftsRoute.POST,
    request,
    params,
    customer: customerRoute.PUT,
    estimate: estimateRoute.POST,
    agreements: agreementsRoute.POST,
    signingLink: signingLinkRoute,
    sign: signRoute,
    signature: signatureRoute,
    signedSignature: signedSignatureRoute,
  },
  publish,
);

const switchOn = (company: string) => h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company}, 'estimate_assist', true)`;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  await l.setUp();
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const outcome = (claims: FakeClaims | null, jobId: string): Promise<Reply> => json(outcomeRoute.GET(request(claims, `/api/jobs/${jobId}/outcome`), params({ jobId })));
const close = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(closeRoute.POST(request(claims, `/api/jobs/${jobId}/close`, { method: 'POST', body }), params({ jobId })));

// Signs a priced job on the phone, as the estimator: the signature first, then the agreement.
async function signedOnPhone(): Promise<{ jobId: string; agreementId: string }> {
  const { jobId, estimate } = await l.pricedJob();
  const signatureId = randomUUID();
  const built = request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${signatureId}?kind=signature`, { method: 'PUT', body: image(`signature ${signatureId}`) });
  built.headers.set('X-Proposal-Sha256', estimate.proposalSha256);
  expect((await photoRoute.PUT(built, params({ jobId, photoId: signatureId }))).status).toBe(201);
  const body = { id: randomUUID(), estimateId: estimate.id, proposalSha256: estimate.proposalSha256, signatureId, signerName: 'Casey Customer', documentsConfirmed: true };
  const signed = await json(agreementsRoute.POST(request(ESTIMATOR_A, `/api/jobs/${jobId}/agreements`, { method: 'POST', body }), params({ jobId })));
  expect(signed.status).toBe(201);
  return { jobId, agreementId: body.id };
}

const samples = (jobId: string) =>
  h.admin<{ agreement_id: string; price_mode: string; low_cents: string; high_cents: string | null; labor_material_low_cents: string | null; room_categories: string[] | null; planned_days: number | null }[]>`
    SELECT agreement_id::text, price_mode, low_cents::text, high_cents::text, labor_material_low_cents::text, room_categories, planned_days FROM estimate_history WHERE job_id = ${jobId}
  `;
const signedTotals = async (agreementId: string) =>
  (await h.admin<{ low: string; labor: string }[]>`SELECT priced_result->'totals'->'low'->>'total' AS low, priced_result->'totals'->>'labor_material_low' AS labor FROM agreements WHERE id = ${agreementId}`)[0]!;
const cents = (money: string) => String(Math.round(Number(money) * 100));
const signedRecord = (jobId: string) =>
  h.admin`SELECT j.revision, j.field_revision, a.documents_bytes, a.proposal_sha256, a.content_hash, a.priced_result FROM jobs j JOIN agreements a ON a.job_id = j.id WHERE j.id = ${jobId}`;
const closeAudits = async (jobId: string) => (await l.f.auditActions(jobId)).filter((one) => one === 'job_closed');
const closeBody = (agreementId: string, extra: Body = {}): Body => ({ id: randomUUID(), expectedAgreementId: agreementId, expectedRevision: 0, finalAmount: '240.00', actualDays: 3, note: 'Invoice sent.', ...extra });

describe('the estimate history, written while signing', () => {
  it('writes one sample of the signed amounts on the phone, with the estimate_assist switch off', async () => {
    const { jobId, agreementId } = await signedOnPhone();
    const totals = await signedTotals(agreementId);
    expect(await samples(jobId)).toEqual([
      { agreement_id: agreementId, price_mode: 'single', low_cents: cents(totals.low), high_cents: null, labor_material_low_cents: cents(totals.labor), room_categories: ['2'], planned_days: null },
    ]);
  });

  it('writes the sample when the homeowner signs through a link', async () => {
    const { jobId, token } = await l.linkedJob();
    const { answer, body } = await l.homeownerSigns(token);
    expect(answer.status).toBe(201);
    expect((await samples(jobId)).map((row) => row.agreement_id)).toEqual([body.id]);
  });

  it('signs all the same when the sample cannot be written, and the close writes it later', async () => {
    await h.admin.unsafe(`
      CREATE FUNCTION test_refuse_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history write refused for a test'; END $$;
      CREATE TRIGGER test_refuse_history BEFORE INSERT ON estimate_history FOR EACH ROW EXECUTE FUNCTION test_refuse_history();
    `);
    let signed: { jobId: string; agreementId: string };
    try {
      signed = await signedOnPhone();
    } finally {
      await h.admin.unsafe('DROP TRIGGER test_refuse_history ON estimate_history; DROP FUNCTION test_refuse_history();');
    }
    expect(await samples(signed.jobId)).toEqual([]);
    expect((await l.f.job(signed.jobId)).status).toBe('signed');
    await switchOn(h.seed.a);
    const made = await close(OWNER_A, signed.jobId, closeBody(signed.agreementId));
    expect(made.status).toBe(201);
    expect((await samples(signed.jobId)).map((row) => row.agreement_id)).toEqual([signed.agreementId]);
  });
});

describe('closing a job', () => {
  it('compares the final invoice with the first signed estimate, keeps every version, and answers a replay with its original receipt', async () => {
    const { jobId, agreementId } = await signedOnPhone();
    await switchOn(h.seed.a);
    const before = await signedRecord(jobId);
    const read = await outcome(OFFICE_A, jobId);
    expect(read.body).toMatchObject({ jobId, access: 'full', closed: false, closedAt: null, agreementId, revision: 0, close: null, earlier: [], suggestedDays: null });
    const totals = await signedTotals(agreementId);
    const first = closeBody(agreementId, { finalAmount: totals.low });
    const made = await close(OFFICE_A, jobId, first);
    expect(made.status).toBe(201);
    expect(made.body.close).toMatchObject({ id: first.id, revision: 1, agreementId, finalAmount: totals.low, actualDays: 3, note: 'Invoice sent.', landed: 'inside', baseline: { agreementId, priceMode: 'single', low: totals.low, high: null } });
    // A correction names the revision it read.
    const correction = closeBody(agreementId, { expectedRevision: 1, finalAmount: '99999.99', actualDays: '' });
    const corrected = await close(OWNER_A, jobId, correction);
    expect(corrected.body.close).toMatchObject({ revision: 2, landed: 'above', actualDays: null });
    // The first request sent again still gets its own receipt.
    expect(await close(OFFICE_A, jobId, first)).toEqual({ status: 200, body: made.body });
    expect(await close(OFFICE_A, jobId, { ...first, note: 'Changed.' })).toEqual({ status: 409, body: { error: 'conflict' } });
    const now = await outcome(OWNER_A, jobId);
    expect(now.body).toMatchObject({ closed: true, revision: 2, close: { id: correction.id }, earlier: [{ id: first.id, revision: 1 }] });
    expect(await closeAudits(jobId)).toEqual(['job_closed', 'job_closed']);
    expect(await signedRecord(jobId)).toEqual(before);
  });

  it('refuses a stale revision or agreement, and an invalid amount, and writes nothing', async () => {
    const { jobId, agreementId } = await signedOnPhone();
    await switchOn(h.seed.a);
    expect((await close(OWNER_A, jobId, closeBody(agreementId))).status).toBe(201);
    expect(await close(OWNER_A, jobId, closeBody(agreementId))).toEqual({ status: 409, body: { error: 'stale_revision' } });
    expect(await close(OWNER_A, jobId, closeBody(randomUUID(), { expectedRevision: 1 }))).toEqual({ status: 409, body: { error: 'stale_agreement' } });
    for (const finalAmount of ['0.00', '2000000.01', '12.345', '-5', '1,000.00', 12]) {
      expect(await close(OWNER_A, jobId, closeBody(agreementId, { expectedRevision: 1, finalAmount }))).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    for (const extra of [{ actualDays: 366 }, { actualDays: -1 }, { note: 'x'.repeat(301) }]) {
      expect(await close(OWNER_A, jobId, closeBody(agreementId, { expectedRevision: 1, ...extra }))).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await closeAudits(jobId)).toEqual(['job_closed']);
    // Zero days and the top amount are taken.
    expect((await close(OWNER_A, jobId, closeBody(agreementId, { expectedRevision: 1, finalAmount: '2000000', actualDays: 0 }))).body.close).toMatchObject({ finalAmount: '2000000.00', actualDays: 0 });
  });

  it('refuses a job whose signed amount cannot be proven from its signed record', async () => {
    await switchOn(h.seed.a);
    // A signed job written as an older record would be: its priced result is not one the engine stores.
    const { jobId } = await l.f.newJob(ESTIMATOR_A);
    const actor = h.seed.ownerA.actor;
    const version = await seedVersion(h.admin, h.seed.a, actor);
    const submission = newSubmission(h.seed.a, jobId, actor);
    await h.admin`
      INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id, status, snapshot_bytes, snapshot_sha256)
      VALUES (${submission.id}, ${h.seed.a}, ${jobId}, ${submission.draft}, ${submission.epoch}, 'original', ${'b'.repeat(64)}, now() + interval '15 minutes', ${actor}, 'pending', NULL, NULL)
    `;
    await h.admin`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${Buffer.from('snapshot')}, snapshot_sha256 = encode(sha256('snapshot'::bytea), 'hex') WHERE id = ${submission.id}`;
    const pin = await seedPin(h.admin, { company: h.seed.a, job: jobId, version: version.id, actor });
    const estimate = await seedEstimate(h.admin, { company: h.seed.a, job: jobId, submission: submission.id, pin, actor, hash: version.hash });
    const signature = await seedSignature(h.admin, h.seed.a, jobId, actor);
    const chain = { company: h.seed.a, actor, job: { ...newJob(h.seed.a, actor), id: jobId }, version, submission, pin, estimate, signature };
    const agreement = agreementOf(chain);
    await withCompany(h.handle.db, h.seed.a, (tx) => insertAgreement(tx, agreement));
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
    expect(await close(OWNER_A, jobId, closeBody(agreement.id))).toEqual({ status: 409, body: { error: 'no_signed_amount' } });
    expect(await samples(jobId)).toEqual([]);
    expect(await closeAudits(jobId)).toEqual([]);
  });
});

describe('who reads and closes', () => {
  it('gives the estimator only whether and when the job closed, and lets only the owner and office close', async () => {
    const { jobId, agreementId } = await signedOnPhone();
    await switchOn(h.seed.a);
    expect(await outcome(ESTIMATOR_A, jobId)).toEqual({ status: 200, body: { jobId, access: 'status', closed: false, closedAt: null } });
    expect(await close(ESTIMATOR_A, jobId, closeBody(agreementId))).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect((await close(OFFICE_A, jobId, closeBody(agreementId, { finalAmount: '4321.09', note: 'Paid by check 5521.' }))).status).toBe(201);
    const seen = await outcome(ESTIMATOR_A, jobId);
    expect(Object.keys(seen.body).sort()).toEqual(['access', 'closed', 'closedAt', 'jobId']);
    expect(seen.body).toMatchObject({ access: 'status', closed: true });
    const text = JSON.stringify(seen.body);
    for (const secret of ['4321', 'Paid by check', 'baseline', 'landed']) expect(text).not.toContain(secret);
  });

  it('is behind the switch, for signed jobs only, and refuses another company (404)', async () => {
    const { jobId, agreementId } = await signedOnPhone();
    expect(await outcome(OWNER_A, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await close(OWNER_A, jobId, closeBody(agreementId))).toEqual({ status: 404, body: { error: 'not_found' } });
    await switchOn(h.seed.a);
    await switchOn(h.seed.b);
    const { jobId: unsigned } = await l.f.newJob(ESTIMATOR_A);
    expect(await outcome(OWNER_A, unsigned)).toEqual({ status: 409, body: { error: 'not_signed' } });
    expect(await close(OWNER_A, unsigned, closeBody(agreementId))).toEqual({ status: 409, body: { error: 'not_signed' } });
    expect(await outcome(OWNER_B, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await close(OWNER_B, jobId, closeBody(agreementId))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await closeAudits(jobId)).toEqual([]);
  });
});
