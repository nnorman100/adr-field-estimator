import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestDigest } from '@/lib/field/canonical';
import { latch, until } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-1, office jobs, assignment and the field owner, through the real route files as the runtime
// role against a real Postgres: an office user starts an empty job, assigns estimators and keeps the
// office notes; the first estimator to capture becomes the field owner, once; the owner moves the
// field work (owner decision J5); an estimator sees only the customer view. The four checks of
// docs/spec.md 6.2 are the "field and office ownership" block. The field drafts are an in-memory
// stand-in (draft-fake.ts); tests/emu/field-owner.test.ts checks the real writer and the field rules.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/prices/services', () => ({ pricesServices: () => live.harness!.prices }));

const jobsRoute = await import('@/app/api/jobs/route');
const jobRoute = await import('@/app/api/jobs/[jobId]/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const coordinationRoute = await import('@/app/api/jobs/[jobId]/coordination/route');
const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
const assignmentRoute = await import('@/app/api/jobs/[jobId]/assignments/[assignmentId]/route');
const fieldOwnerRoute = await import('@/app/api/jobs/[jobId]/field-owner/route');
const transferRoute = await import('@/app/api/jobs/[jobId]/field-owner/transfer/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const workingCopyRoute = await import('@/app/api/prices/working-copy/route');
const meRoute = await import('@/app/api/me/route');
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
  // A second active estimator in company A: the one who is refused once the first owns the field work.
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

type Person = { actorId: string; displayName: string | null; email: string };
type Body = {
  job: { id: string; status: string; currentDraftId: string; fieldOwnerActorId: string | null; revision: number };
  customer: { name: string };
  jobs: { id: string; mine: boolean }[];
  jobId: string;
  revision: number;
  notes: string;
  fieldOwner: Person | null;
  assignments: (Person & { id: string; assignedAt: string })[];
  estimators: Person[];
  capabilities: string[];
  error: string;
};
type Answer = { status: number; body: Body };

async function answer(response: Response | Promise<Response>): Promise<Answer> {
  const done = await response;
  expect(done.headers.get('cache-control')).toBe('no-store');
  return { status: done.status, body: (await done.json()) as Body };
}

const job = (jobId: string) => params({ jobId });
const create = (claims: FakeClaims, body: unknown) => answer(jobsRoute.POST(request(claims, '/api/jobs', { method: 'POST', body }), params({})));
const list = (claims: FakeClaims, query = '') => answer(jobsRoute.GET(request(claims, `/api/jobs${query}`), params({})));
const read = (claims: FakeClaims, jobId: string) => answer(jobRoute.GET(request(claims, `/api/jobs/${jobId}`), job(jobId)));
const saveCustomer = (claims: FakeClaims, jobId: string, revision: number) =>
  answer(
    customerRoute.PUT(
      request(claims, `/api/jobs/${jobId}/customer`, {
        method: 'PUT',
        body: { revision, changeId: randomUUID(), name: 'Pat Example', phone: '555-0100', email: 'pat@example.test', propertyAddress: '12 Sample Way' },
      }),
      job(jobId),
    ),
  );
const saveClaim = (claims: FakeClaims, jobId: string, revision: number) =>
  answer(
    claimRoute.PUT(
      request(claims, `/api/jobs/${jobId}/claim`, {
        method: 'PUT',
        body: {
          revision,
          changeId: randomUUID(),
          carrier: 'Sample Mutual',
          claimNumber: 'CL-1',
          policyNumber: 'PO-1',
          dateOfLoss: '2026-10-30',
          lossCause: 'Burst supply line',
          adjusterName: 'Alex Adjuster',
          adjusterEmail: 'alex@example.test',
          adjusterPhone: '555-0111',
          deductible: '$1,000',
        },
      }),
      job(jobId),
    ),
  );
const coordination = (claims: FakeClaims, jobId: string) => answer(coordinationRoute.GET(request(claims, `/api/jobs/${jobId}/coordination`), job(jobId)));
const saveNotes = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(coordinationRoute.PUT(request(claims, `/api/jobs/${jobId}/coordination`, { method: 'PUT', body }), job(jobId)));
const assign = (claims: FakeClaims, jobId: string, estimatorActorId: string, id = randomUUID()) =>
  answer(assignmentsRoute.POST(request(claims, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id, estimatorActorId } }), job(jobId)));
const unassign = (claims: FakeClaims, jobId: string, assignmentId: string) =>
  answer(
    assignmentRoute.DELETE(request(claims, `/api/jobs/${jobId}/assignments/${assignmentId}`, { method: 'DELETE' }), params({ jobId, assignmentId })),
  );
const claim = (claims: FakeClaims, jobId: string) => answer(fieldOwnerRoute.POST(request(claims, `/api/jobs/${jobId}/field-owner`, { method: 'POST' }), job(jobId)));
const transfer = (claims: FakeClaims, jobId: string, body: unknown) =>
  answer(transferRoute.POST(request(claims, `/api/jobs/${jobId}/field-owner/transfer`, { method: 'POST', body }), job(jobId)));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const sendPhoto = (claims: FakeClaims, jobId: string, photoId = randomUUID()) =>
  answer(
    photoRoute.PUT(
      request(claims, `/api/jobs/${jobId}/photos/${photoId}?kind=photo`, { method: 'PUT', body: Uint8Array.from([...PNG, ...Buffer.from(`synthetic ${photoId}`)]) }),
      params({ jobId, photoId }),
    ),
  );
const submit = (claims: FakeClaims, jobId: string, draftId: string) =>
  answer(
    submissionsRoute.POST(
      request(claims, `/api/jobs/${jobId}/submissions`, { method: 'POST', body: { id: randomUUID(), draftId, digest: '0'.repeat(64) } }),
      job(jobId),
    ),
  );

// Field work the server can record: one named room, no photos and no price ids.
const MANIFEST = { draft: { roomOrder: ['kitchen'] }, rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }], photos: [] };
const submitDraft = (claims: FakeClaims, jobId: string, body: { id: string; draftId: string; digest: string }) =>
  answer(submissionsRoute.POST(request(claims, `/api/jobs/${jobId}/submissions`, { method: 'POST', body }), job(jobId)));
const nextDraft = (claims: FakeClaims, jobId: string, body: { draftId: string; fromDraftId: string }) =>
  answer(draftsRoute.POST(request(claims, `/api/jobs/${jobId}/drafts`, { method: 'POST', body }), job(jobId)));

const count = async (table: string, where = 'true') => Number((await h.admin.unsafe(`SELECT count(*) AS n FROM ${table} WHERE ${where}`))[0]!.n);
const audits = (action: string) => count('audit_events', `action = '${action}'`);
// Company A's draft in the field-draft stand-in.
const draftOf = (draftId: string) => h.drafts.made.get(`${h.seed.a}/${draftId}`);

// An office user starts a job: the empty scope only, and nobody owns its field work yet.
async function officeJob(): Promise<{ id: string; draftId: string }> {
  const ids = { id: randomUUID(), draftId: randomUUID() };
  const made = await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' });
  expect(made.status).toBe(201);
  return ids;
}

describe('an office user starts a job', () => {
  it('makes one empty job with no field owner, however often the same create is sent', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    const first = await create(OFFICE_A, ids);
    const second = await create(OFFICE_A, ids);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toEqual(first.body);
    expect(first.body.job).toMatchObject({ id: ids.id, status: 'draft', fieldOwnerActorId: null, revision: 1 });
    expect(await count('jobs')).toBe(1);
    expect(await audits('job_created')).toBe(1);
    // The draft is made empty, with no field owner: an office user never captures field work.
    expect(h.drafts.made.get(`${h.seed.a}/${ids.draftId}`)).toEqual({ fieldOwnerUid: null });
    expect(h.drafts.calls.every((call) => call.fieldOwnerUid === null)).toBe(true);
  });
});

describe('field and office ownership (docs/spec.md 6.2)', () => {
  it('makes the first assigned estimator to capture the field owner, and refuses a second estimator’s field work', async () => {
    const { id, draftId } = await officeJob();
    expect((await assign(OFFICE_A, id, h.seed.estimatorA.actor)).status).toBe(201);
    expect((await assign(OFFICE_A, id, estimatorA2)).status).toBe(201);

    const first = await claim(ESTIMATOR_A, id);
    expect(first.status).toBe(201);
    expect(first.body.job.fieldOwnerActorId).toBe(h.seed.estimatorA.actor);
    // The field owner is coordination: the job revision stays, the coordination revision moves.
    expect(first.body.job.revision).toBe(1);
    expect((await coordination(OWNER_A, id)).body.revision).toBe(1);
    // The server named the field owner on the draft, in its transaction, at that revision.
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a', fieldOwnerRevision: 1 });
    expect(await audits('job_field_owner_claimed')).toBe(1);

    // The same person again changes nothing; anyone else is refused, and adds nothing.
    const again = await claim(ESTIMATOR_A, id);
    expect(again.status).toBe(200);
    expect(again.body.job.revision).toBe(1);
    const second = await claim(ESTIMATOR_A2, id);
    expect(second).toEqual({ status: 409, body: { error: 'field_owner_taken' } });
    expect((await sendPhoto(ESTIMATOR_A2, id)).body.error).toBe('not_field_owner');
    expect((await submit(ESTIMATOR_A2, id, draftId)).body.error).toBe('not_field_owner');
    expect(await count('evidence_objects')).toBe(0);
    expect(await count('job_submissions')).toBe(0);
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a');
    expect(await audits('job_field_owner_claimed')).toBe(1);
    // The field owner's own photo is taken.
    expect((await sendPhoto(ESTIMATOR_A, id)).status).toBe(201);
  });

  it('lets an office user change the customer and the assignment, and never write field work', async () => {
    const { id } = await officeJob();
    expect((await saveCustomer(OFFICE_A, id, 1)).status).toBe(200);
    const assigned = await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    expect(assigned.status).toBe(201);
    expect((await unassign(OFFICE_A, id, assigned.body.assignments[0]!.id)).status).toBe(200);
    expect(await claim(OFFICE_A, id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect((await sendPhoto(OFFICE_A, id)).status).toBe(403);
    expect((await read(OFFICE_A, id)).body.job.fieldOwnerActorId).toBeNull();
  });

  it('refuses the field owner a change of assignment or of the office notes', async () => {
    const { id } = await officeJob();
    const assigned = await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    const before = await everything(h.admin);
    expect(await assign(ESTIMATOR_A, id, estimatorA2)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await unassign(ESTIMATOR_A, id, assigned.body.assignments[0]!.id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await saveNotes(ESTIMATOR_A, id, { revision: 1, changeId: randomUUID(), notes: 'Gate code 1234' })).toEqual({
      status: 403,
      body: { error: 'not_allowed' },
    });
    expect(await coordination(ESTIMATOR_A, id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('lets only the estimator who owns the field work set the customer and the claim, not one who is only assigned', async () => {
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    await assign(OFFICE_A, id, estimatorA2);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    const before = await everything(h.admin);
    for (const refused of [await saveCustomer(ESTIMATOR_A2, id, 1), await saveClaim(ESTIMATOR_A2, id, 1)]) {
      expect(refused).toEqual({ status: 403, body: { error: 'not_field_owner' } });
    }
    expect(await everything(h.admin)).toBe(before);
    expect((await saveCustomer(ESTIMATOR_A, id, 1)).status).toBe(200);
    expect((await saveClaim(ESTIMATOR_A, id, 2)).status).toBe(200);
  });

  it('grants no price approval with the field work', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true)`;
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    const me = async () => answer(meRoute.GET(request(ESTIMATOR_A, '/api/me'), params({})));
    const keysBefore = (await me()).body.capabilities;
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    const keysAfter = (await me()).body.capabilities;
    expect(keysAfter).toEqual(keysBefore);
    expect(keysAfter).not.toContain('prices_manage');
    const working = await answer(
      workingCopyRoute.PUT(request(ESTIMATOR_A, '/api/prices/working-copy', { method: 'PUT', body: { expectedRevision: 1, table: {} } }), params({})),
    );
    expect(working.status).toBe(403);
  });
});

describe('who sees an office job', () => {
  it('answers 404 to an estimator who is not assigned, and lists the job for one who is', async () => {
    const { id } = await officeJob();
    expect(await read(ESTIMATOR_A, id)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect((await list(ESTIMATOR_A)).body.jobs).toEqual([]);

    const assigned = await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    expect((await read(ESTIMATOR_A, id)).status).toBe(200);
    expect((await list(ESTIMATOR_A)).body.jobs.map((one) => [one.id, one.mine])).toEqual([[id, true]]);
    // Still not the other estimator's.
    expect((await read(ESTIMATOR_A2, id)).status).toBe(404);
    expect((await list(ESTIMATOR_A2)).body.jobs).toEqual([]);

    // Unassigned, it is gone again.
    expect((await unassign(OFFICE_A, id, assigned.body.assignments[0]!.id)).status).toBe(200);
    expect((await read(ESTIMATOR_A, id)).status).toBe(404);
    expect((await list(ESTIMATOR_A)).body.jobs).toEqual([]);
  });

  it('shows an estimator the customer view only: no office notes, assignments or estimators', async () => {
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    expect((await saveNotes(OFFICE_A, id, { revision: 0, changeId: randomUUID(), notes: 'Gate code 1234\nDog in yard' })).status).toBe(200);
    const seen = await read(ESTIMATOR_A, id);
    expect(seen.status).toBe(200);
    expect(Object.keys(seen.body).sort()).toEqual(['claim', 'customer', 'job']);
    expect(JSON.stringify(seen.body)).not.toContain('Gate code');
    expect(await coordination(ESTIMATOR_A, id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    // The owner and office see the coordination view.
    for (const who of [OWNER_A, OFFICE_A]) {
      const view = await coordination(who, id);
      expect(view.status).toBe(200);
      expect(view.body.notes).toBe('Gate code 1234\nDog in yard');
      expect(view.body.assignments.map((one) => one.actorId)).toEqual([h.seed.estimatorA.actor]);
      expect(view.body.estimators.map((one) => one.actorId).sort()).toEqual([h.seed.estimatorA.actor, estimatorA2].sort());
    }
  });
});

describe('office notes', () => {
  it('saves the notes once per change, refuses a stale copy, and answers a lost response with the same view', async () => {
    const { id } = await officeJob();
    const changeId = randomUUID();
    // The coordination revision: 0 before the first note.
    const saved = await saveNotes(OFFICE_A, id, { revision: 0, changeId, notes: 'Call before arriving' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ jobId: id, revision: 1, notes: 'Call before arriving', fieldOwner: null });
    // Notes are coordination: the job revision a reviewed estimate is bound to stays.
    expect((await read(OFFICE_A, id)).body.job.revision).toBe(1);
    const again = await saveNotes(OFFICE_A, id, { revision: 0, changeId, notes: 'Call before arriving' });
    expect(again).toEqual(saved);
    expect(await audits('job_coordination_saved')).toBe(1);
    expect(await saveNotes(OFFICE_A, id, { revision: 0, changeId, notes: 'Something else' })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await saveNotes(OFFICE_A, id, { revision: 0, changeId: randomUUID(), notes: 'Late' })).toEqual({
      status: 409,
      body: { error: 'stale_revision', revision: 1 },
    });
    // A control character other than a tab or a line break is refused at the boundary.
    expect((await saveNotes(OFFICE_A, id, { revision: 1, changeId: randomUUID(), notes: 'bell\u0007' })).status).toBe(400);
    expect((await saveNotes(OFFICE_A, id, { revision: 1, changeId: randomUUID(), notes: 'x'.repeat(4001) })).status).toBe(400);
  });
});

describe('assignment', () => {
  it('assigns once per id, refuses a second active assignment of the same estimator and anyone who is not an active estimator', async () => {
    const { id } = await officeJob();
    const assignmentId = randomUUID();
    const first = await assign(OFFICE_A, id, h.seed.estimatorA.actor, assignmentId);
    const second = await assign(OFFICE_A, id, h.seed.estimatorA.actor, assignmentId);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toEqual(first.body);
    expect(await count('job_assignments')).toBe(1);
    expect(await audits('job_estimator_assigned')).toBe(1);
    // The same id with another estimator; another id for the same estimator.
    expect(await assign(OFFICE_A, id, estimatorA2, assignmentId)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await assign(OFFICE_A, id, h.seed.estimatorA.actor)).toEqual({ status: 409, body: { error: 'already_assigned' } });
    // An office user, the owner, a disabled estimator and another company's estimator cannot be assigned.
    for (const actor of [h.seed.officeA.actor, h.seed.ownerA.actor, h.seed.disabledA.actor, h.seed.estimatorB.actor]) {
      expect(await assign(OFFICE_A, id, actor)).toEqual({ status: 409, body: { error: 'not_assignable' } });
    }
    expect(await count('job_assignments')).toBe(1);
  });

  it('ends an assignment once, and keeps the job’s field owner assigned until the owner moves the field work', async () => {
    const { id } = await officeJob();
    const toA = await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    const toA2 = await assign(OFFICE_A, id, estimatorA2);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    const ownerAssignment = toA.body.assignments[0]!.id;
    expect(await unassign(OFFICE_A, id, ownerAssignment)).toEqual({ status: 409, body: { error: 'assigned_field_owner' } });
    const other = toA2.body.assignments.find((one) => one.actorId === estimatorA2)!.id;
    const ended = await unassign(OFFICE_A, id, other);
    expect(ended.status).toBe(200);
    expect(ended.body.assignments.map((one) => one.actorId)).toEqual([h.seed.estimatorA.actor]);
    expect(await unassign(OFFICE_A, id, other)).toEqual(ended);
    expect(await audits('job_estimator_unassigned')).toBe(1);
    // The row is kept, ended, and the estimator may be assigned again under a new id.
    expect(await count('job_assignments', 'ended_at IS NOT NULL')).toBe(1);
    expect((await assign(OFFICE_A, id, estimatorA2)).status).toBe(201);
    // An id that is not an assignment of this job.
    expect(await unassign(OFFICE_A, id, randomUUID())).toEqual({ status: 404, body: { error: 'assignment_not_found' } });
  });

  it('never ends another company’s assignment through a job of the caller’s own', async () => {
    const { id } = await officeJob();
    const theirs = await create(OWNER_B, { id: randomUUID(), draftId: randomUUID() });
    const bAssigned = await assign(OWNER_B, theirs.body.job.id, h.seed.estimatorB.actor);
    expect(bAssigned.status).toBe(201);
    const before = await everything(h.admin);
    expect(await unassign(OFFICE_A, id, bAssigned.body.assignments[0]!.id)).toEqual({ status: 404, body: { error: 'assignment_not_found' } });
    expect(await unassign(OFFICE_A, theirs.body.job.id, bAssigned.body.assignments[0]!.id)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect((await coordination(OWNER_A, theirs.body.job.id)).status).toBe(404);
    expect((await claim(ESTIMATOR_B, id)).status).toBe(404);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('the first capture', () => {
  it('keeps the field owner when the draft could not be updated, and sets the draft when the same person asks again', async () => {
    const { id, draftId } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    h.drafts.failNext = { on: true, afterWrite: false };
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect((await read(OWNER_A, id)).body.job.fieldOwnerActorId).toBe(h.seed.estimatorA.actor);
    expect(draftOf(draftId)?.fieldOwnerUid).toBeNull();
    const retry = await claim(ESTIMATOR_A, id);
    expect(retry.status).toBe(200);
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a', fieldOwnerRevision: 1 });
    expect(await audits('job_field_owner_claimed')).toBe(1);
  });

  it('answers 200 to the estimator who started the job, who owns its field work already', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(ESTIMATOR_A, ids)).status).toBe(201);
    const claimed = await claim(ESTIMATOR_A, ids.id);
    expect(claimed.status).toBe(200);
    expect(claimed.body.job.revision).toBe(1);
    expect(await audits('job_field_owner_claimed')).toBe(0);
  });

  it('refuses a signed job', async () => {
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 409, body: { error: 'job_signed' } });
  });
});

describe('moving the field work (owner decision J5)', () => {
  async function claimedJob() {
    const made = await officeJob();
    await assign(OFFICE_A, made.id, h.seed.estimatorA.actor);
    await assign(OFFICE_A, made.id, estimatorA2);
    expect((await claim(ESTIMATOR_A, made.id)).status).toBe(201);
    return made;
  }

  it('moves the field work to an assigned estimator, audited, and the phone that held it can add no more', async () => {
    const { id, draftId } = await claimedJob();
    const changeId = randomUUID();
    const moved = await transfer(OWNER_A, id, { revision: 1, changeId, toActorId: estimatorA2 });
    expect(moved.status).toBe(200);
    expect(moved.body.fieldOwner?.actorId).toBe(estimatorA2);
    expect(moved.body.revision).toBe(2);
    // A move is coordination: the job revision stays.
    expect((await read(OWNER_A, id)).body.job.revision).toBe(1);
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: 2 });
    const [row] = await h.admin`SELECT details FROM audit_events WHERE action = 'job_field_owner_moved'`;
    expect(row!.details).toEqual({ revision: 2, fromActorId: h.seed.estimatorA.actor, toActorId: estimatorA2 });
    expect((await sendPhoto(ESTIMATOR_A, id)).body.error).toBe('not_field_owner');
    expect((await sendPhoto(ESTIMATOR_A2, id)).status).toBe(201);
    // The same change again is the same answer, and sets the draft again; with another target it is a conflict.
    expect(await transfer(OWNER_A, id, { revision: 1, changeId, toActorId: estimatorA2 })).toEqual(moved);
    expect(await audits('job_field_owner_moved')).toBe(1);
    expect(await transfer(OWNER_A, id, { revision: 1, changeId, toActorId: h.seed.ownerA.actor })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: h.seed.ownerA.actor })).toEqual({
      status: 409,
      body: { error: 'stale_revision', revision: 2 },
    });
  });

  it('moves the field work to the owner themself, and to no one who is not assigned', async () => {
    const { id, draftId } = await claimedJob();
    const before = await everything(h.admin);
    for (const actor of [h.seed.officeA.actor, h.seed.disabledA.actor, h.seed.estimatorB.actor, randomUUID()]) {
      expect(await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: actor })).toEqual({ status: 409, body: { error: 'not_assignable' } });
    }
    expect(await everything(h.admin)).toBe(before);
    const toOwner = await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: h.seed.ownerA.actor });
    expect(toOwner.status).toBe(200);
    expect(toOwner.body.fieldOwner?.actorId).toBe(h.seed.ownerA.actor);
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('owner-a');
  });

  it('is the owner’s alone', async () => {
    const { id } = await claimedJob();
    const before = await everything(h.admin);
    for (const who of [OFFICE_A, ESTIMATOR_A, ESTIMATOR_A2]) {
      expect(await transfer(who, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 403, body: { error: 'not_allowed' } });
    }
    expect(await transfer(OWNER_B, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('keeps the move when the draft could not be updated, and sets the draft when the same change is sent again', async () => {
    const { id, draftId } = await claimedJob();
    const body = { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 };
    h.drafts.failNext = { on: true, afterWrite: false };
    expect(await transfer(OWNER_A, id, body)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect((await read(OWNER_A, id)).body.job.fieldOwnerActorId).toBe(estimatorA2);
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a');
    expect((await transfer(OWNER_A, id, body)).status).toBe(200);
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: 2 });
  });

  it('names the new owner on every draft of the job, so the estimator who lost the field work reads no earlier draft', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
  });

  it('stops a Submit whose field work moved to another person while it ran, and frees the draft for the new owner', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    const digest = await manifestDigest(MANIFEST);
    const hold = latch();
    h.field.gate.read = () => hold.wait;
    const first = submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest });
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
    expect((await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    hold.open();
    expect(await first).toEqual({ status: 403, body: { error: 'not_field_owner' } });
    expect(await count('job_submissions', "status = 'committed'")).toBe(0);
    expect(await count('job_submissions', "status = 'aborted'")).toBe(1);
    expect((await read(OWNER_A, id)).body.job.status).toBe('draft');
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'editing', fence: null });
    expect((await submitDraft(ESTIMATOR_A2, id, { id: randomUUID(), draftId, digest })).status).toBe(201);
  });

  it('stops and releases a Submit whose estimator lost the job while it ran, so the new owner can submit at once', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    const digest = await manifestDigest(MANIFEST);
    const hold = latch();
    h.field.gate.read = () => hold.wait;
    const first = submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest });
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
    const moved = await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 });
    expect(moved.status).toBe(200);
    const theirs = moved.body.assignments.find((one) => one.actorId === h.seed.estimatorA.actor)!.id;
    expect((await unassign(OFFICE_A, id, theirs)).status).toBe(200);
    hold.open();
    expect(await first).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await count('job_submissions', "status = 'aborted'")).toBe(1);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'editing', fence: null });
    expect((await submitDraft(ESTIMATOR_A2, id, { id: randomUUID(), draftId, digest })).status).toBe(201);
  });

  it('names the current draft last, so a move whose draft step stopped part way is finished by the new owner’s Start field work', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    const { revision } = (await coordination(OWNER_A, id)).body;
    // One draft is set, then the field database stops answering.
    h.drafts.failNext = { on: true, afterWrite: true };
    expect(await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
  });

  it('refuses the company owner field work they do not own, until they move it to themself', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    const digest = await manifestDigest(MANIFEST);
    const before = await everything(h.admin);
    expect(await sendPhoto(OWNER_A, id)).toEqual({ status: 403, body: { error: 'not_field_owner' } });
    expect(await submitDraft(OWNER_A, id, { id: randomUUID(), draftId, digest })).toMatchObject({ status: 403, body: { error: 'not_field_owner' } });
    expect(await everything(h.admin)).toBe(before);
    expect((await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: h.seed.ownerA.actor })).status).toBe(200);
    expect((await sendPhoto(OWNER_A, id)).status).toBe(201);
    expect((await submitDraft(OWNER_A, id, { id: randomUUID(), draftId, digest })).status).toBe(201);
    // Moved back to the estimator, the owner cannot make the next draft; moved to themself again, they can.
    expect((await transfer(OWNER_A, id, { revision: 2, changeId: randomUUID(), toActorId: h.seed.estimatorA.actor })).status).toBe(200);
    const next = { draftId: randomUUID(), fromDraftId: draftId };
    expect(await nextDraft(OWNER_A, id, next)).toMatchObject({ status: 403, body: { error: 'not_field_owner' } });
    expect((await transfer(OWNER_A, id, { revision: 3, changeId: randomUUID(), toActorId: h.seed.ownerA.actor })).status).toBe(200);
    expect((await nextDraft(OWNER_A, id, next)).status).toBe(201);
  });

  it('sends the field owner to every draft again on a signed job, without allowing a new move', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    // The move's draft step does not get through, then the job is signed before it is sent again.
    h.drafts.failNext = { on: true, afterWrite: false };
    expect(await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a');
    expect(await transfer(OWNER_A, id, { revision: 2, changeId: randomUUID(), toActorId: h.seed.ownerA.actor })).toEqual({ status: 409, body: { error: 'job_signed' } });
    const again = await transfer(OWNER_A, id, { revision: 2, changeId: randomUUID(), toActorId: estimatorA2 });
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(2);
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: 2 });
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    expect(await audits('job_field_owner_moved')).toBe(1);
  });

  it('never lets an older owner overwrite a newer one on the draft', async () => {
    const { id, draftId } = await claimedJob();
    expect((await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    // A slow first-capture request made at coordination revision 1 arrives after the move.
    expect(await h.drafts.setFieldOwner(h.seed.a, draftId, 'estimator-a', 1)).toBe('newer');
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a2');
    // And the estimator who lost the field work cannot take it back.
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 409, body: { error: 'field_owner_taken' } });
  });
});
