import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClaims, Harness } from './team-harness';

// S5a-3, the jobs routes: create (one job and one draft however often it is sent), list, read, and
// the customer and claim saves (a retry after a lost response is no conflict), through the real
// route files as the runtime role against a real Postgres. The field drafts are an in-memory
// stand-in (draft-fake.ts); the real writer is checked in tests/emu/. See team-members.test.ts for
// the setup.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));

const jobsRoute = await import('@/app/api/jobs/route');
const jobRoute = await import('@/app/api/jobs/[jobId]/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

let estimatorA2: string;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  // A second active estimator in company A, to prove one estimator never sees another's job.
  const [actor] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
  estimatorA2 = actor!.id;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// What an answer may hold; each route's answer holds the part it names (the rest is absent).
type Body = {
  job: { id: string; status: string; currentDraftId: string; fieldOwnerActorId: string | null; propertyAddress: string; revision: number };
  customer: { name: string; phone: string; email: string };
  claim: { dateOfLoss: string | null };
  jobs: { id: string; mine: boolean; customerName: string; propertyAddress: string; revision: number }[];
  nextCursor: string | null;
  error: string;
  revision: number;
};
type Answer = { status: number; body: Body };

async function answer(response: Response | Promise<Response>): Promise<Answer> {
  const done = await response;
  expect(done.headers.get('cache-control')).toBe('no-store');
  return { status: done.status, body: (await done.json()) as Body };
}

const newIds = () => ({ id: randomUUID(), draftId: randomUUID() });

const create = (claims: FakeClaims, body: unknown) =>
  answer(jobsRoute.POST(request(claims, '/api/jobs', { method: 'POST', body }), params({})));
const list = (claims: FakeClaims, query = '') =>
  answer(jobsRoute.GET(request(claims, `/api/jobs${query}`), params({})));
const read = (claims: FakeClaims, jobId: string) =>
  answer(jobRoute.GET(request(claims, `/api/jobs/${jobId}`), params({ jobId })));
const saveCustomer = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(customerRoute.PUT(request(claims, `/api/jobs/${jobId}/customer`, { method: 'PUT', body }), params({ jobId })));
const saveClaim = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(claimRoute.PUT(request(claims, `/api/jobs/${jobId}/claim`, { method: 'PUT', body }), params({ jobId })));

const customerOf = (revision: number, changeId = randomUUID(), extra: Record<string, unknown> = {}) => ({
  revision,
  changeId,
  name: 'Pat Example',
  phone: '555-0100',
  email: 'pat@example.test',
  propertyAddress: '12 Sample Way',
  ...extra,
});

const claimOf = (revision: number, changeId = randomUUID(), extra: Record<string, unknown> = {}) => ({
  revision,
  changeId,
  carrier: 'Sample Mutual',
  claimNumber: 'CL-1',
  policyNumber: 'PO-1',
  dateOfLoss: '2026-10-30',
  lossCause: 'Burst supply line',
  adjusterName: 'Alex Adjuster',
  adjusterEmail: 'alex@example.test',
  adjusterPhone: '555-0111',
  deductible: '$1,000',
  ...extra,
});

const jobCount = async () => Number((await h.admin`SELECT count(*) AS n FROM jobs`)[0]!.n);
const auditCount = async (action: string) =>
  Number((await h.admin`SELECT count(*) AS n FROM audit_events WHERE action = ${action}`)[0]!.n);

async function seedJob(claims = ESTIMATOR_A): Promise<{ id: string; draftId: string }> {
  const ids = newIds();
  const made = await create(claims, ids);
  expect(made.status).toBe(201);
  return ids;
}

describe('creating a job', () => {
  it('makes one job and one draft when the same create is sent twice', async () => {
    const ids = newIds();
    const first = await create(ESTIMATOR_A, { ...ids, propertyAddress: '12 Sample Way' });
    const second = await create(ESTIMATOR_A, { ...ids, propertyAddress: '12 Sample Way' });
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toEqual(first.body);
    expect(first.body.job).toMatchObject({
      id: ids.id,
      status: 'draft',
      currentDraftId: ids.draftId,
      fieldOwnerActorId: h.seed.estimatorA.actor,
      propertyAddress: '12 Sample Way',
      revision: 1,
    });
    expect(first.body.customer).toEqual({ name: '', phone: '', email: '' });
    expect(first.body.claim.dateOfLoss).toBeNull();
    expect(await jobCount()).toBe(1);
    expect(await auditCount('job_created')).toBe(1);
    expect(h.drafts.owners()).toEqual([[`${h.seed.a}/${ids.draftId}`, { fieldOwnerUid: 'estimator-a', fieldOwnerRevision: 0 }]]);
    expect(h.drafts.projected.get(`${h.seed.a}/${ids.id}`)).toEqual({ currentDraftId: ids.draftId, revision: 1 });
  });

  it('reads an omitted address as the empty one', async () => {
    const ids = newIds();
    expect((await create(ESTIMATOR_A, ids)).status).toBe(201);
    expect((await create(ESTIMATOR_A, { ...ids, propertyAddress: '' })).status).toBe(200);
    expect(await jobCount()).toBe(1);
  });

  it('answers 409 when the same id comes with a different body, and changes nothing', async () => {
    const ids = newIds();
    await create(ESTIMATOR_A, { ...ids, propertyAddress: '12 Sample Way' });
    const before = await everything(h.admin);
    // No refused request reaches the field database: no draft writer (the sync, or the previous one).
    const drafts = h.drafts.calls.length;
    const field = h.field.calls.length;
    for (const body of [
      { ...ids, propertyAddress: '99 Other Road' },
      { ...ids, draftId: randomUUID(), propertyAddress: '12 Sample Way' },
      ids,
    ]) {
      expect(await create(ESTIMATOR_A, body)).toEqual({ status: 409, body: { error: 'conflict' } });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.drafts.calls).toHaveLength(drafts);
    expect(h.field.calls.slice(field)).toEqual([]);
  });

  it('answers 409 when the draft id is another job’s', async () => {
    const first = newIds();
    await create(ESTIMATOR_A, first);
    expect(await create(ESTIMATOR_A, { id: randomUUID(), draftId: first.draftId })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await jobCount()).toBe(1);
  });

  it('answers 409 when the field database holds the draft id for another job, and leaves that draft as it is', async () => {
    // Security audit F1: a draft made for another job is never taken as this job's, even where
    // Postgres does not know the id (a draft made before the job id was written on drafts).
    const draftId = randomUUID();
    const key = `${h.seed.a}/${draftId}`;
    h.drafts.plant(key, { fieldOwnerUid: 'estimator-a2', jobId: randomUUID() });
    const before = await everything(h.admin);
    const id = randomUUID();
    expect(await create(ESTIMATOR_A, { id, draftId })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(h.drafts.owner(key)).toEqual({ fieldOwnerUid: 'estimator-a2' });
    // Nothing is committed in Postgres, so the same job id with a fresh draft id is a new job.
    expect(await everything(h.admin)).toBe(before);
    expect((await create(ESTIMATOR_A, { id, draftId: randomUUID() })).status).toBe(201);
  });

  // Security audit F1, across a release: the previous version (still serving while the migration
  // runs) made the job and its draft with no claim and no job id on the draft, which proves nothing on
  // its own. The same create sent again claims the draft id for the job in Postgres first, then
  // stamps the draft; a draft id Postgres holds for another job is refused and its draft not stamped.
  it('claims and stamps a draft the previous version made when the same create is sent again, and refuses one another job holds', async () => {
    const ids = newIds();
    expect((await create(ESTIMATOR_A, ids)).status).toBe(201);
    const key = `${h.seed.a}/${ids.draftId}`;
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${ids.draftId}`;
    h.drafts.unstamp(key);
    expect((await create(ESTIMATOR_A, ids)).status).toBe(200);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${ids.draftId}`).toEqual([{ job: ids.id }]);
    expect(h.drafts.jobOf(key)).toBe(ids.id);

    const held = newIds();
    expect((await create(ESTIMATOR_A, held)).status).toBe(201);
    const other = newIds();
    expect((await create(ESTIMATOR_A, other)).status).toBe(201);
    const heldKey = `${h.seed.a}/${held.draftId}`;
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${held.draftId}`;
    await h.admin`INSERT INTO job_drafts (company_id, draft_id, job_id) VALUES (${h.seed.a}, ${held.draftId}, ${other.id})`;
    h.drafts.unstamp(heldKey);
    const stored = structuredClone(h.drafts.owner(heldKey));
    expect(await create(ESTIMATOR_A, held)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(h.drafts.jobOf(heldKey)).toBeUndefined();
    expect(h.drafts.owner(heldKey)).toEqual(stored);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${held.draftId}`).toEqual([{ job: other.id }]);
  });

  // Security audit F1: the claim commits before the stamp. When the field database stamps a draft the
  // previous version made and its answer is lost, the draft is never left stamped without its claim.
  it('commits the claim before stamping a draft the previous version made, so a lost answer leaves it claimed', async () => {
    const ids = newIds();
    expect((await create(ESTIMATOR_A, ids)).status).toBe(201);
    const key = `${h.seed.a}/${ids.draftId}`;
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${ids.draftId}`;
    h.drafts.unstamp(key);
    // The draft sync stamps it and loses its answer, on its try and its one more try.
    h.field.loseNext.sync = 2;
    expect(await create(ESTIMATOR_A, ids)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.drafts.jobOf(key)).toBe(ids.id);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${ids.draftId}`).toEqual([{ job: ids.id }]);
    expect((await create(ESTIMATOR_A, ids)).status).toBe(200);
  });

  it('makes the draft on a retry when the first attempt saved the job and lost the draft', async () => {
    const ids = newIds();
    // The draft sync fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect(await create(ESTIMATOR_A, ids)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(await jobCount()).toBe(1);
    expect(h.drafts.owners().length).toBe(0);
    const retry = await create(ESTIMATOR_A, ids);
    expect(retry.status).toBe(200);
    expect(retry.body.job.id).toBe(ids.id);
    expect(await jobCount()).toBe(1);
    expect(await auditCount('job_created')).toBe(1);
    expect(h.drafts.owners().map(([at]) => at)).toEqual([`${h.seed.a}/${ids.draftId}`]);
  });

  it('makes no second draft when the draft was written but its answer was lost', async () => {
    const ids = newIds();
    // The draft sync writes the draft and loses its answer, on its try and its one more try.
    h.field.loseNext.sync = 2;
    expect((await create(ESTIMATOR_A, ids)).status).toBe(503);
    expect(h.drafts.owners().length).toBe(1);
    expect((await create(ESTIMATOR_A, ids)).status).toBe(200);
    expect(h.drafts.owners().length).toBe(1);
    expect(await jobCount()).toBe(1);
  });

  it('lets the owner send an estimator’s create again, and refuses another estimator the same id', async () => {
    const ids = newIds();
    await create(ESTIMATOR_A, ids);
    expect((await create(OWNER_A, ids)).status).toBe(200);
    expect((await create(OFFICE_A, ids)).status).toBe(200);
    expect(await create(ESTIMATOR_A2, ids)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await jobCount()).toBe(1);
  });

  it('gives the field work to the creator who does field work, and to nobody when office starts the job', async () => {
    const byOwner = newIds();
    const byOffice = newIds();
    expect((await create(OWNER_A, byOwner)).body.job.fieldOwnerActorId).toBe(h.seed.ownerA.actor);
    const office = await create(OFFICE_A, byOffice);
    expect(office.status).toBe(201);
    expect(office.body.job.fieldOwnerActorId).toBeNull();
    expect(h.drafts.owner(`${h.seed.a}/${byOffice.draftId}`)).toEqual({ fieldOwnerUid: null, fieldOwnerRevision: 0 });
    expect(h.drafts.owner(`${h.seed.a}/${byOwner.draftId}`)).toEqual({ fieldOwnerUid: 'owner-a', fieldOwnerRevision: 0 });
  });

  it('makes the other company’s own job from the other company’s ids, and touches nothing of the first', async () => {
    const ids = await seedJob(ESTIMATOR_A);
    const before = await h.admin`SELECT * FROM jobs WHERE company_id = ${h.seed.a}`;
    const made = await create(OWNER_B, { ...ids, propertyAddress: 'B Street' });
    expect(made.status).toBe(201);
    expect(made.body.job.id).toBe(ids.id);
    expect(await jobCount()).toBe(2);
    expect(await h.admin`SELECT * FROM jobs WHERE company_id = ${h.seed.a}`).toEqual(before);
    expect(h.drafts.owners().map(([at]) => at).sort()).toEqual([`${h.seed.a}/${ids.draftId}`, `${h.seed.b}/${ids.draftId}`].sort());
  });

  it.each([
    ['an id that is not a uuid', { id: 'job-1', draftId: randomUUID() }],
    ['a missing draft id', { id: randomUUID() }],
    ['a key the route does not know', { ...newIds(), companyId: randomUUID() }],
    ['an address with a line break', { ...newIds(), propertyAddress: 'one\ntwo' }],
    ['an address that is too long', { ...newIds(), propertyAddress: 'x'.repeat(501) }],
    ['a body that is not an object', 'nope'],
  ])('refuses %s with 400 and writes nothing', async (_name, body) => {
    expect(await create(ESTIMATOR_A, body)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(await jobCount()).toBe(0);
    expect(h.drafts.calls).toEqual([]);
    expect(h.field.calls).toEqual([]);
  });

  it('refuses a call with no sign-in', async () => {
    const response = await jobsRoute.POST(request(null, '/api/jobs', { method: 'POST', body: newIds() }), params({}));
    expect(response.status).toBe(401);
    expect(await jobCount()).toBe(0);
  });
});

describe('saving the customer', () => {
  it('saves the customer and the address, raising the revision by one with one audit row', async () => {
    const { id } = await seedJob();
    const saved = await saveCustomer(ESTIMATOR_A, id, customerOf(1));
    expect(saved.status).toBe(200);
    expect(saved.body.job).toMatchObject({ revision: 2, propertyAddress: '12 Sample Way' });
    expect(saved.body.customer).toEqual({ name: 'Pat Example', phone: '555-0100', email: 'pat@example.test' });
    expect(await auditCount('job_customer_saved')).toBe(1);
    const audit = await h.admin`SELECT actor_id, target, details FROM audit_events WHERE action = 'job_customer_saved'`;
    expect(audit).toEqual([{ actor_id: h.seed.estimatorA.actor, target: id, details: { revision: 2 } }]);
    expect(JSON.stringify(audit)).not.toContain('Pat');
    expect((await read(ESTIMATOR_A, id)).body).toEqual(saved.body);
  });

  it('gives no false conflict when the answer was lost and the same change is sent again', async () => {
    const { id } = await seedJob();
    const body = customerOf(1);
    const first = await saveCustomer(ESTIMATOR_A, id, body);
    // The phone never saw `first`; it sends the same change, with the revision it still holds.
    const again = await saveCustomer(ESTIMATOR_A, id, body);
    expect(again).toEqual(first);
    expect(again.body.job.revision).toBe(2);
    expect(await auditCount('job_customer_saved')).toBe(1);
    // Once another change has landed, an old copy is a real stale write.
    expect((await saveCustomer(ESTIMATOR_A, id, customerOf(2, undefined, { name: 'Pat Two' }))).status).toBe(200);
    expect((await saveCustomer(ESTIMATOR_A, id, body)).status).toBe(409);
  });

  it('refuses a change id used again for other values', async () => {
    const { id } = await seedJob();
    const changeId = randomUUID();
    await saveCustomer(ESTIMATOR_A, id, customerOf(1, changeId));
    for (const other of [{ name: 'Someone Else' }, { phone: '555-0199' }, { email: 'else@example.test' }, { propertyAddress: '1 Other St' }]) {
      expect(await saveCustomer(ESTIMATOR_A, id, customerOf(1, changeId, other))).toEqual({ status: 409, body: { error: 'conflict' } });
    }
    expect((await read(ESTIMATOR_A, id)).body.job.revision).toBe(2);
  });

  it('refuses a stale revision and says what the revision is now', async () => {
    const { id } = await seedJob();
    await saveCustomer(OWNER_A, id, customerOf(1));
    expect(await saveCustomer(ESTIMATOR_A, id, customerOf(1, undefined, { name: 'Late' }))).toEqual({
      status: 409,
      body: { error: 'stale_revision', revision: 2 },
    });
    expect((await read(ESTIMATOR_A, id)).body.customer.name).toBe('Pat Example');
  });

  it('lets exactly one of two saves from the same revision win', async () => {
    const { id } = await seedJob();
    const [a, b] = await Promise.all([
      saveCustomer(ESTIMATOR_A, id, customerOf(1, undefined, { name: 'First' })),
      saveCustomer(OWNER_A, id, customerOf(1, undefined, { name: 'Second' })),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const detail = (await read(OWNER_A, id)).body;
    expect(detail.job.revision).toBe(2);
    expect(await auditCount('job_customer_saved')).toBe(1);
  });

  it('lets the estimator who owns the work, the owner and office set it, while the job is not signed', async () => {
    const { id } = await seedJob();
    let revision = 1;
    for (const [claims, name] of [
      [ESTIMATOR_A, 'By estimator'],
      [OWNER_A, 'By owner'],
      [OFFICE_A, 'By office'],
    ] as const) {
      const saved = await saveCustomer(claims, id, customerOf(revision, undefined, { name }));
      expect({ name, status: saved.status }).toEqual({ name, status: 200 });
      revision = saved.body.job.revision;
    }
    expect((await read(ESTIMATOR_A, id)).body.customer.name).toBe('By office');
    await h.admin`UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = ${id}`;
    expect((await saveCustomer(OFFICE_A, id, customerOf(revision + 1))).status).toBe(200);
  });

  it('refuses a signed job’s customer, and answers 410 for an archived job', async () => {
    const { id } = await seedJob();
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    expect(await saveCustomer(OWNER_A, id, customerOf(2))).toEqual({ status: 409, body: { error: 'job_signed' } });
    expect(await saveClaim(OWNER_A, id, claimOf(2))).toEqual({ status: 409, body: { error: 'job_signed' } });
    await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${id}`;
    for (const result of [
      await read(OWNER_A, id),
      await saveCustomer(OWNER_A, id, customerOf(3)),
      await saveClaim(OWNER_A, id, claimOf(3)),
    ]) {
      expect(result).toEqual({ status: 410, body: { error: 'archived' } });
    }
  });

  it.each([
    ['a name with a control character', { name: 'Pat\u0007' }],
    ['a name that is too long', { name: 'n'.repeat(151) }],
    ['a bad email', { email: 'not an email' }],
    ['a revision of zero', { revision: 0 }],
    ['a change id that is not a uuid', { changeId: 'change-1' }],
    ['a missing field', { phone: undefined }],
    ['an unknown field', { nickname: 'Pat' }],
  ])('refuses %s with 400 and changes nothing', async (_name, extra) => {
    const { id } = await seedJob();
    const before = await everything(h.admin);
    expect(await saveCustomer(ESTIMATOR_A, id, customerOf(1, undefined, extra))).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('trims the values and lowers an email before it keeps them', async () => {
    const { id } = await seedJob();
    const saved = await saveCustomer(ESTIMATOR_A, id, customerOf(1, undefined, { name: '  Pat Example ', email: ' Pat@Example.TEST ' }));
    expect(saved.body.customer).toMatchObject({ name: 'Pat Example', email: 'pat@example.test' });
  });

  it('clears a value that is sent empty', async () => {
    const { id } = await seedJob();
    await saveCustomer(ESTIMATOR_A, id, customerOf(1));
    const cleared = await saveCustomer(ESTIMATOR_A, id, customerOf(2, undefined, { phone: '', email: '', propertyAddress: '' }));
    expect(cleared.body.customer).toEqual({ name: 'Pat Example', phone: '', email: '' });
    expect(cleared.body.job.propertyAddress).toBe('');
  });
});

describe('saving the claim', () => {
  it('saves the claim, leaves the customer alone and raises the revision', async () => {
    const { id } = await seedJob();
    await saveCustomer(ESTIMATOR_A, id, customerOf(1));
    const saved = await saveClaim(OFFICE_A, id, claimOf(2));
    expect(saved.status).toBe(200);
    expect(saved.body.job.revision).toBe(3);
    expect(saved.body.claim).toEqual({
      carrier: 'Sample Mutual',
      claimNumber: 'CL-1',
      policyNumber: 'PO-1',
      dateOfLoss: '2026-10-30',
      lossCause: 'Burst supply line',
      adjusterName: 'Alex Adjuster',
      adjusterEmail: 'alex@example.test',
      adjusterPhone: '555-0111',
      deductible: '$1,000',
    });
    expect(saved.body.customer.name).toBe('Pat Example');
    expect(await auditCount('job_claim_saved')).toBe(1);
  });

  it('gives no false conflict when the answer was lost and the same change is sent again', async () => {
    const { id } = await seedJob();
    const body = claimOf(1);
    const first = await saveClaim(ESTIMATOR_A, id, body);
    expect(await saveClaim(ESTIMATOR_A, id, body)).toEqual(first);
    expect(await auditCount('job_claim_saved')).toBe(1);
    expect(await saveClaim(ESTIMATOR_A, id, { ...body, carrier: 'Another' })).toEqual({ status: 409, body: { error: 'conflict' } });
  });

  it('refuses a stale revision', async () => {
    const { id } = await seedJob();
    await saveClaim(ESTIMATOR_A, id, claimOf(1));
    expect(await saveClaim(ESTIMATOR_A, id, claimOf(1))).toEqual({ status: 409, body: { error: 'stale_revision', revision: 2 } });
  });

  it('keeps a date of loss only when it is a real date from 1900 to today, and null for not known', async () => {
    const { id } = await seedJob();
    const today = new Date().toISOString().slice(0, 10);
    for (const dateOfLoss of ['2026-02-30', '2999-01-01', '1899-12-31', '10/30/2026', '', 20261030, undefined]) {
      expect({ dateOfLoss, status: (await saveClaim(ESTIMATOR_A, id, claimOf(1, undefined, { dateOfLoss }))).status }).toEqual({ dateOfLoss, status: 400 });
    }
    expect((await saveClaim(ESTIMATOR_A, id, claimOf(1, undefined, { dateOfLoss: today }))).body.claim.dateOfLoss).toBe(today);
    expect((await saveClaim(ESTIMATOR_A, id, claimOf(2, undefined, { dateOfLoss: null }))).body.claim.dateOfLoss).toBeNull();
  });
});

describe('listing and reading', () => {
  it('lists an estimator’s own jobs only, and never reads or changes another estimator’s', async () => {
    const mine = await seedJob(ESTIMATOR_A);
    const theirs = await seedJob(ESTIMATOR_A2);
    await saveCustomer(ESTIMATOR_A2, theirs.id, customerOf(1, undefined, { name: 'Other Customer' }));

    const listed = await list(ESTIMATOR_A);
    expect(listed.status).toBe(200);
    expect(listed.body.jobs.map((job) => job.id)).toEqual([mine.id]);
    expect(JSON.stringify(listed.body)).not.toContain(theirs.id);
    expect(JSON.stringify(listed.body)).not.toContain('Other Customer');
    expect(await list(ESTIMATOR_A, '?scope=mine')).toEqual(listed);
    expect(await list(ESTIMATOR_A, '?scope=company')).toEqual({ status: 403, body: { error: 'not_allowed' } });

    const before = await everything(h.admin);
    expect(await read(ESTIMATOR_A, theirs.id)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await saveCustomer(ESTIMATOR_A, theirs.id, customerOf(2))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await saveClaim(ESTIMATOR_A, theirs.id, claimOf(2))).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await everything(h.admin)).toBe(before);
    // The other estimator sees theirs, and the owner and office see both.
    expect((await read(ESTIMATOR_A2, theirs.id)).status).toBe(200);
    expect((await read(OWNER_A, theirs.id)).status).toBe(200);
    expect((await read(OFFICE_A, mine.id)).status).toBe(200);
  });

  // The draft life-cycle redesign, slice 6: the field owner's read gets a lost first draft ready again.
  it('makes a new job’s lost first draft again, empty, at its field owner’s read', async () => {
    const started = await seedJob(OWNER_A);
    expect((await read(OWNER_A, started.id)).body).not.toHaveProperty('draftMissing');
    h.drafts.remove(`${h.seed.a}/${started.draftId}`);
    const lost = await read(OWNER_A, started.id);
    expect(lost.status).toBe(200);
    expect(h.field.draft(h.seed.a, started.draftId)).toMatchObject({ jobId: started.id, state: 'editing', field: {} });
    expect(lost.body.job.currentDraftId).toBe(started.draftId);
  });

  it('shows an estimator a job they own in the field even when someone else started it', async () => {
    const started = await seedJob(OWNER_A);
    expect((await list(ESTIMATOR_A)).body.jobs).toEqual([]);
    await h.admin`UPDATE jobs SET field_owner_actor_id = ${h.seed.estimatorA.actor}, revision = revision + 1 WHERE id = ${started.id}`;
    expect((await list(ESTIMATOR_A)).body.jobs.map((job) => [job.id, job.mine])).toEqual([[started.id, true]]);
    expect((await read(ESTIMATOR_A, started.id)).status).toBe(200);
    // And not the other way round: a job whose owner moved on is no longer the creator-estimator's.
    await h.admin`UPDATE jobs SET field_owner_actor_id = ${estimatorA2}, created_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${started.id}`;
    expect((await read(ESTIMATOR_A, started.id)).status).toBe(404);
  });

  it('lists the company’s jobs for the owner and office, and their own with scope=mine', async () => {
    const one = await seedJob(ESTIMATOR_A);
    const two = await seedJob(ESTIMATOR_A2);
    const three = await seedJob(OWNER_A);
    await seedJob(OWNER_B);
    for (const claims of [OWNER_A, OFFICE_A]) {
      const all = await list(claims);
      expect(all.body.jobs.map((job) => job.id).sort()).toEqual([one.id, two.id, three.id].sort());
      expect(all.body.nextCursor).toBeNull();
      expect((await list(claims, '?scope=company')).body).toEqual(all.body);
    }
    expect((await list(OWNER_A, '?scope=mine')).body.jobs.map((job) => job.id)).toEqual([three.id]);
    // Office started none and owns none of the field work.
    expect((await list(OFFICE_A, '?scope=mine')).body.jobs).toEqual([]);
  });

  it('shows each job’s customer name and leaves an archived job off the list', async () => {
    const one = await seedJob(ESTIMATOR_A);
    const two = await seedJob(ESTIMATOR_A);
    await saveCustomer(ESTIMATOR_A, one.id, customerOf(1));
    await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${two.id}`;
    const listed = await list(OWNER_A);
    expect(listed.body.jobs).toHaveLength(1);
    expect(listed.body.jobs[0]).toMatchObject({ id: one.id, customerName: 'Pat Example', propertyAddress: '12 Sample Way', revision: 2, mine: false });
  });

  it('pages newest first, with no repeat or gap, including jobs made in the same instant', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = randomUUID();
      ids.push(id);
      // Two pairs share a timestamp to exercise the tie-break; created_at is the database's to the microsecond.
      const stamp = i < 2 ? '2026-11-01 10:00:00.123456+00' : i < 4 ? '2026-11-02 10:00:00.654321+00' : '2026-11-03 10:00:00+00';
      await h.admin`
        INSERT INTO jobs (id, company_id, created_by_actor_id, field_owner_actor_id, current_draft_id, request_digest, created_at)
        VALUES (${id}, ${h.seed.a}, ${h.seed.estimatorA.actor}, ${h.seed.estimatorA.actor}, ${randomUUID()}, ${'a'.repeat(64)}, ${stamp})
      `;
    }
    const expected = (
      await h.admin<{ id: string }[]>`SELECT id::text FROM jobs WHERE company_id = ${h.seed.a} ORDER BY created_at DESC, id ASC`
    ).map((row) => row.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Answer = await list(OWNER_A, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.jobs.map((job) => job.id));
      cursor = page.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(5);
    expect(expected.slice(0, 1)).toEqual([ids[4]]);
  });

  it.each([['?limit=0'], ['?limit=51'], ['?limit=abc'], ['?scope=everyone'], ['?cursor=not-a-cursor'], [`?cursor=${Buffer.from('x|y').toString('base64url')}`]])(
    'refuses the query %s with 400',
    async (query) => {
      expect(await list(OWNER_A, query)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    },
  );

  it('answers 404 to a job id that is not a uuid or does not exist', async () => {
    for (const jobId of ['nope', randomUUID()]) {
      expect(await read(OWNER_A, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    }
  });
});

describe('another company’s owner', () => {
  it('gets 404 on each route of a job of company A, and lists nothing of it', async () => {
    const { id, draftId } = await seedJob(ESTIMATOR_A);
    await saveCustomer(ESTIMATOR_A, id, customerOf(1));
    const before = await everything(h.admin);
    for (const claims of [OWNER_B, ESTIMATOR_B]) {
      const results = [
        await read(claims, id),
        await saveCustomer(claims, id, customerOf(2)),
        await saveClaim(claims, id, claimOf(2)),
      ];
      expect(results).toEqual(Array(3).fill({ status: 404, body: { error: 'not_found' } }));
      const listed = await list(claims);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.body)).not.toMatch(new RegExp(`${id}|${draftId}|Pat Example`));
      expect(listed.body.jobs).toEqual([]);
    }
    expect(await everything(h.admin)).toBe(before);
  });
});


describe('job locator repair', () => {
  it('populates an existing job on an authorized read and never projects a refused read', async () => {
    const ids = await seedJob();
    h.drafts.projected.clear();
    expect((await read(ESTIMATOR_A2, ids.id)).status).toBe(404);
    expect((await read(OWNER_B, ids.id)).status).toBe(404);
    expect(h.drafts.projected.size).toBe(0);
    const answer = await read(ESTIMATOR_A, ids.id);
    expect(answer.status).toBe(200);
    expect(h.drafts.projected.get(`${h.seed.a}/${ids.id}`)).toEqual({ currentDraftId: ids.draftId, revision: answer.body.job.revision });
  });
});
