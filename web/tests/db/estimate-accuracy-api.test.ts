import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import { signedRecordBytes, SIGNED_FORMAT, type SignedRecord } from '@/lib/agreements/record';
import { PROPOSAL_FORMAT, type Proposal } from '@/lib/estimates/proposal';
import { canonicalJson } from '@/lib/field/canonical';
import { newJob, seedJob } from './job-harness';
import { agreementOf, bytesOf, insertAgreement, newSubmission, seedCommitted, seedEstimate, seedPin, seedSignature, seedVersion } from './submission-harness';
import { json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-10 slice 10B, the rest of the outcomes server: GET /api/estimate-accuracy through the real route
// file as the runtime role against Postgres (the owner with price books and estimate_assist; refused
// before anything is read for anyone else), and the signed-row projection on the jobs list and on the
// operator's audited support views (close status and date, drying watch status and due indicator,
// under their switches, nothing else). The numbers' arithmetic is tests/unit/drying-accuracy.test.ts.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/platform/support-services', async () => {
  const { supportJobsService } = await import('@/lib/platform/support-jobs');
  return { supportJobsServices: () => supportJobsService(live.harness!.handle.db, () => live.harness!.evidence) };
});
vi.mock('@/lib/drying/services', async () => {
  const { accuracyService } = await import('@/lib/drying/accuracy-service');
  return { dryingServices: () => ({ accuracy: accuracyService(live.harness!.handle.db) }) };
});

const accuracyRoute = await import('@/app/api/estimate-accuracy/route');
const jobsRoute = await import('@/app/api/jobs/route');
const supportListRoute = await import('@/app/api/platform/companies/[companyId]/jobs/route');
const supportJobRoute = await import('@/app/api/platform/companies/[companyId]/jobs/[jobId]/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { operatorClaims, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const OPERATOR = operatorClaims();

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
type Reply = Answer & { body: Body };

const switchOn = (company: string, ...flags: string[]) =>
  Promise.all(flags.map((flag) => h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company}, ${flag}, true) ON CONFLICT (company_id, flag) DO UPDATE SET enabled = true`));
const accuracy = (claims: FakeClaims | null, query = ''): Promise<Reply> => json(accuracyRoute.GET(request(claims, `/api/estimate-accuracy${query}`), params({})));
const jobsList = (claims: FakeClaims): Promise<Reply> => json(jobsRoute.GET(request(claims, '/api/jobs'), params({})));

// A cushion-method range table published for company A, as S4-6's publish stores it.
async function publish(policy: Record<string, unknown> = {}) {
  const table = parseTable({
    items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
    policy: {
      estimate_mode: 'range',
      range: { first_sf: 1000, first_percent: '20', beyond_percent: '10' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      ...policy,
    },
  });
  await h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${h.seed.a}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(table)}, ${ENGINE_VERSION}, 'Prices for a test', 'blank', ${h.seed.ownerA.actor}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${h.seed.a}
  `;
}

// A signed job of `company` with its original agreement, its history sample (a range of 1,000.00 to
// 1,400.00, with 1,000.00 of labor and materials; none with `history` false, as a signing whose sample
// write failed) and, when `final` is given, closes at those amounts.
async function closedJob(company: string, closes: number[] = [], history = true): Promise<string> {
  const actor = company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor;
  const proposal = { format: PROPOSAL_FORMAT, heading: 'Synthetic proposal' } as unknown as Proposal;
  const proposalBytes = bytesOf(canonicalJson(proposal));
  const proposalSha = proposalBytes.sha;
  const job = await seedJob(h.admin, newJob(company, actor, { status: 'draft' }));
  const version = await seedVersion(h.admin, company, actor);
  const submission = await seedCommitted(h.admin, newSubmission(company, job.id, actor));
  const pin = await seedPin(h.admin, { company, job: job.id, version: version.id, actor });
  const estimate = await seedEstimate(h.admin, { company, job: job.id, submission: submission.id, pin, actor, hash: version.hash, proposal: proposalBytes });
  const signature = await seedSignature(h.admin, company, job.id, actor);
  const chain = { company, actor, job, version, submission, pin, estimate, signature };
  const id = randomUUID();
  // A signed record the support view reads (src/lib/agreements/record.ts).
  const record: SignedRecord = {
    format: SIGNED_FORMAT,
    agreement_id: id,
    job_id: chain.job.id,
    kind: 'original',
    signed_at: new Date().toISOString(),
    signer: { name: 'Pat Customer' },
    signed_with: { kind: 'device', presented_by: { actor_id: actor, name: 'Owner' } },
    signature: { id: chain.signature, sha256: 'd'.repeat(64), content_type: 'image/png' },
    proposal_sha256: proposalSha,
    proposal,
    documents: { itemized_claim: [], letter: 'Synthetic letter.', photo_log: [], claim: {}, compliance_notes: [] },
    basis: { estimate_id: chain.estimate.id, submission_id: chain.submission.id },
  };
  const agreement = agreementOf(chain, { id, documents: signedRecordBytes(record) });
  await withCompany(h.handle.db, company, (tx) => insertAgreement(tx, agreement));
  await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${chain.job.id}`;
  if (history) {
    await h.admin`
      INSERT INTO estimate_history (company_id, job_id, agreement_id, signed_at, price_mode, low_cents, high_cents, labor_material_low_cents, room_categories, planned_days)
      VALUES (${company}, ${chain.job.id}, ${agreement.id}, now(), 'range', 100000, 140000, 100000, '{2}', 3)
    `;
  }
  for (const [n, final] of closes.entries()) {
    const closeId = randomUUID();
    const landed = final < 100_000 ? 'below' : final > 140_000 ? 'above' : 'inside';
    await h.admin`
      INSERT INTO job_closes (id, company_id, job_id, agreement_id, revision, request_digest, final_cents, actual_days, note, baseline_agreement_id, price_mode,
                              baseline_low_cents, baseline_high_cents, landed, closed_by_actor_id)
      VALUES (${closeId}, ${company}, ${chain.job.id}, ${agreement.id}, ${n + 1}, ${'c'.repeat(64)}, ${final}, 4, 'Paid in full.', ${agreement.id}, 'range', 100000, 140000, ${landed}, ${actor})
    `;
  }
  return chain.job.id;
}

describe('GET /api/estimate-accuracy', () => {
  it('gives the owner the company’s numbers, each job counted once by its latest close', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    // Five closed jobs, the first corrected from inside to above; one signed job not closed yet.
    await closedJob(h.seed.a, [120_000, 150_000]);
    for (const final of [100_000, 110_000, 130_000, 160_000]) await closedJob(h.seed.a, [final]);
    await closedJob(h.seed.a);
    // Published after the seeded jobs, whose own seeded versions are placeholders.
    await publish();
    const answer = await accuracy(OWNER_A);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ signed: 6, closed: 5, inside: 3, above: 2, below: 0, insidePercent: 60, method: 'cushion', estimateMode: 'range', reason: null });
    // Overruns of 0%, 10%, 30%, 50% and 60% of labor and materials: 4 of 5 are covered by 50%.
    expect(answer.body.suggestions).toEqual({ firstPercent: { value: '50', jobs: 5, heldAtBeyond: false } });
    expect(answer.body.extraDryingDays).toEqual({ value: 1, jobs: 5 });
    // Counts and settings only: nothing names a job, an amount or a note.
    expect(JSON.stringify(answer.body)).not.toContain('Paid in full');
  });

  it('answers the empty and small-sample states, and says when the table gives no suggestion', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    expect((await accuracy(OWNER_A)).body).toMatchObject({ signed: 0, closed: 0, insidePercent: null, suggestions: null, reason: 'no_prices' });
    await closedJob(h.seed.a, [120_000]);
    // The seeded job's own placeholder version is current: no table this server can price.
    expect((await accuracy(OWNER_A)).body).toMatchObject({ closed: 1, suggestions: null, reason: 'no_prices' });
    await publish();
    expect((await accuracy(OWNER_A)).body).toMatchObject({ closed: 1, suggestions: { firstPercent: { value: null, jobs: 1 } } });
    await publish({ estimate_mode: 'single' });
    expect((await accuracy(OWNER_A)).body).toMatchObject({ closed: 1, suggestions: null, reason: 'single_price' });
  });

  it('is the owner’s alone, refused before anything is read, and never counts another company', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    await switchOn(h.seed.b, 'price_books', 'estimate_assist');
    await closedJob(h.seed.b, [120_000]);
    for (const claims of [ESTIMATOR_A, OFFICE_A]) expect(await accuracy(claims)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await accuracy(OWNER_A, '?company=other')).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect((await accuracy(OWNER_A)).body).toMatchObject({ signed: 0, closed: 0 });
    expect((await accuracy(OWNER_B)).body).toMatchObject({ signed: 1, closed: 1 });
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    expect(await accuracy(OWNER_A)).toEqual({ status: 404, body: { error: 'not_found' } });
    await h.admin`UPDATE company_feature_flags SET enabled = true WHERE company_id = ${h.seed.a} AND flag = 'price_books'`;
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'estimate_assist'`;
    expect(await accuracy(OWNER_A)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect((await accuracy(null)).status).toBe(401);
  });

  it('counts every signed job, one whose signing kept no history sample included', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    await closedJob(h.seed.a, [], false);
    await closedJob(h.seed.a, [120_000]);
    expect((await accuracy(OWNER_A)).body).toMatchObject({ signed: 2, closed: 1 });
  });

  it('refuses any query, one with no parameter names included', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    for (const query of ['?&&', '?&', '?=']) expect(await accuracy(OWNER_A, query)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect((await accuracy(OWNER_A)).status).toBe(200);
  });

  it('refuses once either switch is off, even for a request that passed the route’s checks, before reading history', async () => {
    await switchOn(h.seed.a, 'price_books', 'estimate_assist');
    await closedJob(h.seed.a, [120_000]);
    const { accuracyService } = await import('@/lib/drying/accuracy-service');
    const service = accuracyService(h.handle.db);
    const owner = { companyId: h.seed.a, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: ['jobs_read' as const, 'prices_read' as const, 'prices_manage' as const] };
    expect(await service.read(owner)).toMatchObject({ signed: 1, closed: 1 });
    const refusal = async (run: Promise<unknown>) => run.then(() => 'answered', (error: { code?: string }) => error.code);
    for (const flag of ['estimate_assist', 'price_books']) {
      await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = ${flag}`;
      expect(await refusal(service.read(owner))).toBe('not_found');
      await h.admin`UPDATE company_feature_flags SET enabled = true WHERE company_id = ${h.seed.a} AND flag = ${flag}`;
    }
    expect(await service.read(owner)).toMatchObject({ signed: 1, closed: 1 });
  });
});

describe('the signed-row projection', () => {
  it('adds nothing with both switches off', async () => {
    const jobId = await closedJob(h.seed.a, [120_000]);
    const row = (await jobsList(OWNER_A)).body.jobs.find((one: Body) => one.id === jobId);
    expect(row).toBeDefined();
    expect(row.closed).toBeUndefined();
    expect(row.dryingWatch).toBeUndefined();
  });

  it('shows each signed row’s close date and watch status under their switches, to members and the operator, and nothing more', async () => {
    await switchOn(h.seed.a, 'estimate_assist', 'drying_watch');
    const closed = await closedJob(h.seed.a, [120_000]);
    const open = await closedJob(h.seed.a);
    const rows = (await jobsList(OFFICE_A)).body.jobs as Body[];
    const closedRow = rows.find((one) => one.id === closed)!;
    expect(closedRow.closed.closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rows.find((one) => one.id === open)!.closed).toEqual({ closedAt: null });
    // The seeded signed records keep no drying plan: the watch has nothing to watch.
    expect(closedRow.dryingWatch).toEqual({ status: 'unavailable', due: null, nextDueAt: null });
    const text = JSON.stringify(rows);
    for (const secret of ['Paid in full', '120000', '1200.00', 'landed']) expect(text).not.toContain(secret);
    // The operator's audited support views carry the same projection.
    const list = await json(supportListRoute.GET(request(OPERATOR, `/api/platform/companies/${h.seed.a}/jobs`), params({ companyId: h.seed.a })));
    expect(list.status).toBe(200);
    expect((list.body.jobs as Body[]).find((one) => one.id === closed)).toMatchObject({ closed: { closedAt: closedRow.closed.closedAt }, dryingWatch: { status: 'unavailable' } });
    const view = await json(supportJobRoute.GET(request(OPERATOR, `/api/platform/companies/${h.seed.a}/jobs/${closed}`), params({ companyId: h.seed.a, jobId: closed })));
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ closed: { closedAt: closedRow.closed.closedAt }, dryingWatch: { status: 'unavailable' } });
    expect(JSON.stringify(view.body)).not.toContain('Paid in full');
  });

  it('adds exactly the close status with estimate_assist alone, to the member list and both support views', async () => {
    const closed = await closedJob(h.seed.a, [120_000]);
    const memberRow = async () => ((await jobsList(OFFICE_A)).body.jobs as Body[]).find((one) => one.id === closed)!;
    const supportRow = async () =>
      ((await json(supportListRoute.GET(request(OPERATOR, `/api/platform/companies/${h.seed.a}/jobs`), params({ companyId: h.seed.a })))).body.jobs as Body[]).find((one) => one.id === closed)!;
    const supportView = async () => (await json(supportJobRoute.GET(request(OPERATOR, `/api/platform/companies/${h.seed.a}/jobs/${closed}`), params({ companyId: h.seed.a, jobId: closed })))).body;
    const before = { member: await memberRow(), list: await supportRow(), view: await supportView() };
    await switchOn(h.seed.a, 'estimate_assist');
    const after = { member: await memberRow(), list: await supportRow(), view: await supportView() };
    const closedAt = after.member.closed?.closedAt;
    expect(closedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    // The member row is the same row with one field more: the close date, nothing of the close itself.
    expect(after.member).toEqual({ ...before.member, closed: { closedAt } });
    for (const where of ['list', 'view'] as const) {
      expect(Object.keys(after[where]).sort()).toEqual([...Object.keys(before[where]), 'closed'].sort());
      expect(after[where].closed).toEqual({ closedAt });
      expect(after[where].dryingWatch).toBeUndefined();
    }
  });
});
