import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manifestDigest } from '@/lib/field/canonical';
import { ESTIMATOR_A, ESTIMATOR_A2, ESTIMATOR_B, MANIFEST, OFFICE_A, OWNER_A, OWNER_B, answer, assign, audits, claim, coordination, count, create, draftOf, estimatorA2, everything, h, list, meRoute, nextDraft, officeJob, params, read, request, saveClaim, saveCustomer, saveNotes, sendPhoto, submit, submitDraft, unassign, workingCopyRoute, setUpOfficeJobsDatabase } from './office-jobs-harness';
import type { Harness } from './team-harness';

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

setUpOfficeJobsDatabase(live);

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
    expect(h.drafts.owner(`${h.seed.a}/${ids.draftId}`)).toEqual({ fieldOwnerUid: null, fieldOwnerRevision: 0 });
    // The draft sync wrote the draft once, naming nobody.
    expect(h.field.ownerWrites.filter((write) => write.at === `${h.seed.a}/${ids.draftId}`)).toEqual([{ at: `${h.seed.a}/${ids.draftId}`, fieldOwnerUid: null }]);
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

  it('lets the field owner set the customer only while the job is unsigned (owner decision J3)', async () => {
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    expect((await saveCustomer(ESTIMATOR_A, id, 1)).status).toBe(200);
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    const before = await everything(h.admin);
    // After signing only office and the owner correct it, through a correction (S5b-4).
    for (const who of [ESTIMATOR_A, OFFICE_A, OWNER_A]) {
      expect(await saveCustomer(who, id, 3)).toEqual({ status: 409, body: { error: 'job_signed' } });
      expect(await saveClaim(who, id, 3)).toEqual({ status: 409, body: { error: 'job_signed' } });
    }
    expect(await everything(h.admin)).toBe(before);
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
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
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

  // Security audit F1: a job whose current draft another job claimed (job_drafts, 0016), as data made
  // before the claims could hold it, never hands that draft on, even one made before drafts carried
  // their job id.
  it('refuses a first capture on a job whose current draft another job also holds, and leaves that draft as it is', async () => {
    const victim = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(ESTIMATOR_A2, victim)).status).toBe(201);
    h.field.put(h.seed.a, victim.draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A2, victim.id, { id: randomUUID(), draftId: victim.draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    expect((await nextDraft(ESTIMATOR_A2, victim.id, { draftId: randomUUID(), fromDraftId: victim.draftId })).status).toBe(201);
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    await h.admin`UPDATE jobs SET current_draft_id = ${victim.draftId}, revision = revision + 1 WHERE id = ${id}`;
    h.drafts.unstamp(`${h.seed.a}/${victim.draftId}`);
    const before = structuredClone(draftOf(victim.draftId));
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(draftOf(victim.draftId)).toEqual(before);
    expect((await read(OWNER_A, id)).body.job.fieldOwnerActorId).toBeNull();
  });

  it('refuses a first capture on a job whose current draft the field database holds for another job, and changes nothing', async () => {
    const { id, draftId } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    h.drafts.stamp(`${h.seed.a}/${draftId}`, randomUUID());
    const before = await everything(h.admin);
    const stored = structuredClone(draftOf(draftId));
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(draftOf(draftId)).toEqual(stored);
    expect(await everything(h.admin)).toBe(before);
  });

  it('never reaches the draft of another company that has the same id', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(ESTIMATOR_A, ids)).status).toBe(201);
    const before = structuredClone(draftOf(ids.draftId));
    const other = { id: randomUUID(), draftId: ids.draftId };
    expect((await create(ESTIMATOR_B, other)).status).toBe(201);
    expect((await claim(ESTIMATOR_B, other.id)).status).toBe(200);
    expect(await claim(ESTIMATOR_B, ids.id)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(draftOf(ids.draftId)).toEqual(before);
    expect(h.drafts.jobOf(`${h.seed.a}/${ids.draftId}`)).toBe(ids.id);
    expect(h.drafts.jobOf(`${h.seed.b}/${ids.draftId}`)).toBe(other.id);
    expect(h.drafts.owner(`${h.seed.b}/${ids.draftId}`)?.fieldOwnerUid).toBe('estimator-b');
  });
});
