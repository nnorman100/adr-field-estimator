import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manifestDigest } from '@/lib/field/canonical';
import { latch, until } from './submission-flow';
import { ESTIMATOR_A, ESTIMATOR_A2, MANIFEST, OFFICE_A, OWNER_A, OWNER_B, archive, assign, audits, claim, coordination, count, create, draftOf, estimatorA2, everything, h, nextDraft, officeJob, read, restore, sendPhoto, submitDraft, transfer, unassign, setUpOfficeJobsDatabase } from './office-jobs-harness';
import type { Harness } from './team-harness';

// S5b-1, moving the field work (owner decision J5), split out of office-jobs-api.test.ts for its length:
// the same real route files, runtime role and real Postgres, with the shared setup in office-jobs-harness.ts.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));

setUpOfficeJobsDatabase(live);

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
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
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

  // Security audit F1, across a release: drafts the previous version put the job on and submitted
  // were never claimed; they are still the job's, and the new owner is named on them too.
  it('names the new owner on an earlier draft the previous version left unclaimed', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE job_id = ${id}`;
    h.drafts.unstamp(`${h.seed.a}/${draftId}`);
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(h.drafts.jobOf(`${h.seed.a}/${draftId}`)).toBe(id);
    // Postgres first: the draft is claimed for the job, not only stamped in the field database.
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${draftId}`).toEqual([{ job: id }]);
  });

  // Security audit F1: a draft of the job's own submission that another job holds in Postgres is left
  // out of the move, unstamped and with its owner as it was; the rest of the job's drafts move.
  it('leaves out an earlier draft another job holds, and claims the rest for the job before naming the owner', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    const other = await officeJob();
    await h.admin`DELETE FROM job_drafts WHERE job_id = ${id}`;
    await h.admin`INSERT INTO job_drafts (company_id, draft_id, job_id) VALUES (${h.seed.a}, ${draftId}, ${other.id})`;
    h.field.unstamp(h.seed.a, draftId);
    const stored = structuredClone(draftOf(draftId));
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(draftOf(draftId)).toEqual(stored);
    expect(h.drafts.jobOf(`${h.seed.a}/${draftId}`)).toBeUndefined();
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${draftId}`).toEqual([{ job: other.id }]);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${later}`).toEqual([{ job: id }]);
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

  it('writes every draft in one step, so a move whose draft step failed is finished by the new owner’s Start field work', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    const { revision } = (await coordination(OWNER_A, id)).body;
    // The field database does not answer: no draft is set (they are written in one transaction).
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    expect(await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
  });

  // Back to editing commits in Postgres, but its field draft is never made (the field database
  // failed), and the phone that knew the submitted draft id is gone. The move, and the new owner's
  // Start field work, make the job's current draft from its latest record, with where it came from,
  // as Back to editing's retry does, instead of answering 503 every time.
  async function draftNeverMade() {
    const made = await claimedJob();
    h.field.put(h.seed.a, made.draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, made.id, { id: randomUUID(), draftId: made.draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    h.field.failNext.createFrom = true;
    expect(await nextDraft(ESTIMATOR_A, made.id, { draftId: later, fromDraftId: made.draftId })).toEqual({
      status: 503,
      body: { error: 'submissions_unavailable' },
    });
    expect((await read(OWNER_A, made.id)).body.job).toMatchObject({ status: 'draft', currentDraftId: later });
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    const [record] = await h.admin<{ id: string }[]>`SELECT id::text AS id FROM job_submissions WHERE job_id = ${made.id} AND status = 'committed'`;
    return { ...made, later, submissionId: record!.id };
  }

  it('makes the current draft Back to editing never made when the field work moves, from the job’s latest record', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({
      jobId: id,
      state: 'editing',
      field: MANIFEST.draft,
      rooms: { kitchen: { name: 'Kitchen' } },
      previous: { draftId, submissionId },
    });
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    // The first phone's own retry is refused now: the field work moved.
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).body.error).toBe('not_field_owner');
  });

  it('makes the current draft Back to editing never made when its field owner starts the field work again', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', previous: { draftId, submissionId } });
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a', fieldOwnerRevision: revision });
    // Back to editing sent again by the first phone finds the same draft: made once, from one record.
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(200);
  });

  it('tells only the field owner that the current draft is missing and Start field work can make it, and stops telling once it has', async () => {
    const { id, later } = await draftNeverMade();
    expect((await read(ESTIMATOR_A, id)).body.draftMissing).toBe(true);
    // Nobody else learns whether the draft exists: not another assigned estimator, not the company owner.
    expect((await read(ESTIMATOR_A2, id)).body.draftMissing).toBeUndefined();
    expect((await read(OWNER_A, id)).body.draftMissing).toBeUndefined();
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).not.toBeNull();
    expect((await read(ESTIMATOR_A, id)).body.draftMissing).toBeUndefined();
  });

  it('does not tell of a missing first draft, which Start field work has no record to make', async () => {
    const { id, draftId } = await claimedJob();
    h.drafts.remove(`${h.seed.a}/${draftId}`);
    const lost = await read(ESTIMATOR_A, id);
    expect(lost.status).toBe(200);
    expect(lost.body.draftMissing).toBeUndefined();
  });

  it('keeps the job read when the draft lookup does not get through, and says nothing of the draft', async () => {
    const { id } = await draftNeverMade();
    const lookup = vi.spyOn(h.drafts, 'findDraft').mockRejectedValueOnce(new Error('field database unreachable'));
    const unsure = await read(ESTIMATOR_A, id);
    lookup.mockRestore();
    expect(unsure.status).toBe(200);
    expect(unsure.body.job.id).toBe(id);
    expect(unsure.body.draftMissing).toBeUndefined();
    expect((await read(ESTIMATOR_A, id)).body.draftMissing).toBe(true);
  });

  it('does not look for the draft of a job that is not being edited', async () => {
    const { id } = await draftNeverMade();
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    const lookup = vi.spyOn(h.drafts, 'findDraft');
    const signed = await read(ESTIMATOR_A, id);
    const looked = lookup.mock.calls.length;
    lookup.mockRestore();
    expect(signed.status).toBe(200);
    expect(signed.body.draftMissing).toBeUndefined();
    expect(looked).toBe(0);
  });

  // No transaction or lock waits on the field database: a request's draft sync is paused after it read
  // Postgres, so a later change's sync, at a newer version, lands first and the paused one is refused.
  async function pausedRemake<T>(start: () => Promise<T>) {
    const step = holdStep(['createFrom', 'archiveDraft', 'restoreDraft']);
    const running = start();
    await until(() => step.reached(), 'the draft being made');
    return { running, resume: step.open };
  }

  // Holds the next field step of a request at the field database, whichever writer reaches it: the draft
  // sync, or the previous writers it replaces (the named field-database calls and the owner stamp), so a
  // sequence is held at the same step on either. The first to arrive is held; the other gates go.
  function holdStep(methods: (keyof Harness['field']['gate'])[]) {
    const hold = latch();
    let arrived = false;
    const named = h.drafts.setFieldOwner;
    const all = ['sync', ...methods] as (keyof Harness['field']['gate'])[];
    const gate = async () => {
      if (arrived) return;
      arrived = true;
      for (const method of all) delete h.field.gate[method];
      h.drafts.setFieldOwner = named;
      await hold.wait;
    };
    for (const method of all) h.field.gate[method] = gate;
    h.drafts.setFieldOwner = async (...args) => {
      await gate();
      return named(...args);
    };
    return { reached: () => arrived, open: hold.open };
  }

  // The archive's sync, at a newer version than a Start field work paused after it read Postgres, makes
  // the missing current draft from its record already archived; the slower sync is refused at the job's
  // marker and opens nothing.
  it('leaves the current draft closed when the job was archived while the draft was being made, and the slower request opens nothing', async () => {
    const { id, later } = await draftNeverMade();
    const paused = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    // Made from the job's latest record, archived: every phone write is refused (web/firestore.rules).
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', field: MANIFEST.draft });
    paused.resume();
    // Its answer is the job as Postgres holds it after its field step: archived.
    expect(await paused.running).toEqual({ status: 410, body: { error: 'archived' } });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', field: MANIFEST.draft });
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 410, body: { error: 'archived' } });
  });

  // A second Start field work, let in before the archive, reaches the field database only after the
  // archive's sync: both slower syncs are refused at the job's marker, and the draft stays archived.
  it('never opens a remade draft to a request let in before the job was archived', async () => {
    const { id, later } = await draftNeverMade();
    const first = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const second = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    first.resume();
    expect(await first.running).toEqual({ status: 410, body: { error: 'archived' } });
    second.resume();
    expect(await second.running).toEqual({ status: 410, body: { error: 'archived' } });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', jobId: id });
  });

  // The archive's sync makes the missing current draft, archived; the slower sync's answer is lost and a
  // second Start field work let in before the archive arrives later still. Neither opens it.
  it('never opens the current draft after an archive that found it missing', async () => {
    const { id, later } = await draftNeverMade();
    const first = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const second = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    h.field.loseNext.sync = true;
    first.resume();
    // Its lost answer is tried once more, and the job is archived: that is its answer.
    expect(await first.running).toEqual({ status: 410, body: { error: 'archived' } });
    second.resume();
    expect(await second.running).toEqual({ status: 410, body: { error: 'archived' } });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', field: MANIFEST.draft });
    // Archived drafts keep naming their field owner, who reads them and cannot change them.
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 410, body: { error: 'archived' } });
  });

  it('makes the missing current draft from its record when the job is archived, and opens it when the job is restored', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', jobId: id });
    expect((await restore(OWNER_A, id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'editing', archiveRevision: revision + 2 });
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    const made = h.field.draft(h.seed.a, later);
    expect(made).toMatchObject({ jobId: id, state: 'editing', field: MANIFEST.draft, previous: { draftId, submissionId }, archiveRevision: revision + 2 });
    expect(made?.placeholder).toBeUndefined();
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
  });

  // The archive's sync is held while the restore commits and its sync lands at a newer version: the
  // archive's slower sync is refused at the job's marker, and the restored job's draft stays open.
  it('never lets an archive that lands after a restore close the draft of the restored job', async () => {
    const { id, later } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    const held = await pausedRemake(() => archive(OWNER_A, id, { revision, changeId: randomUUID() }));
    expect((await restore(OWNER_A, id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    held.resume();
    expect((await held.running).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'editing', archiveRevision: revision + 2 });
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', archiveRevision: revision + 2 });
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
  });

  // The archive's sync made Back to editing's missing draft from its record, archived. While the restore's
  // field step has not got through, Back to editing's retry finds that draft and it stays closed; the
  // restore sent again opens it.
  it('keeps Back to editing’s draft closed until the restore reaches the field database', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    const once = { revision: revision + 1, changeId: randomUUID() };
    expect(await restore(OWNER_A, id, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', rooms: { kitchen: { name: 'Kitchen' } } });
    expect((await restore(OWNER_A, id, once)).status).toBe(200);
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({
      jobId: id,
      state: 'editing',
      rooms: { kitchen: { name: 'Kitchen' } },
      previous: { draftId, submissionId },
    });
  });

  // New job's draft was never made (the field database failed), then the job was archived and restored:
  // the archive's sync makes it, empty and archived, and the restore's opens it; the same create again finds it.
  it('makes the draft of a New job that was never made when the job is archived, and opens it on the restore', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    h.drafts.failNext = { on: true, afterWrite: false };
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(503);
    const { revision } = (await read(OWNER_A, ids.id)).body.job as { revision: number };
    expect((await archive(OWNER_A, ids.id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, ids.draftId)).toMatchObject({ state: 'archived', jobId: ids.id, field: {} });
    // While the job is archived, the same create again is answered archived and changes nothing.
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(410);
    expect(h.field.draft(h.seed.a, ids.draftId)).toMatchObject({ state: 'archived', jobId: ids.id });
    expect((await restore(OWNER_A, ids.id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(200);
    const made = h.field.draft(h.seed.a, ids.draftId);
    expect(made).toMatchObject({ jobId: ids.id, state: 'editing', archiveRevision: revision + 2 });
    expect(made?.placeholder).toBeUndefined();
    expect(draftOf(ids.draftId)).toBeDefined();
  });

  // An archived draft opens when any sync of the job reaches the field database after Postgres restored
  // it: Start field work, here, before the restore's own field step got through. Postgres decides.
  it('opens an archived draft to its field owner at the first sync after the restore', async () => {
    const { id, draftId } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'archived' });
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    const once = { revision: revision + 1, changeId: randomUUID() };
    expect(await restore(OWNER_A, id, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    // The first capture claims the field work (201), and its sync writes the restored job's state.
    expect((await claim(ESTIMATOR_A, id)).status).toBe(201);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-a' });
    expect((await restore(OWNER_A, id, once)).status).toBe(200);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a');
  });

  // A Start field work's sync, paused after it read Postgres, lands after a move whose own field step
  // failed: it writes the owner it read, sees Postgres moved on, and syncs again at once with the new owner.
  it('never leaves the current draft with a field owner who has since changed, even when the move’s own field step failed', async () => {
    const { id, later } = await draftNeverMade();
    const { revision } = (await coordination(OWNER_A, id)).body;
    const paused = await pausedRemake(() => claim(ESTIMATOR_A, id));
    // The move commits, then its own field step fails before it writes anything (for its one try again
    // too), under the sync or the previous owner stamp alike.
    h.field.failNext.sync = 2;
    h.drafts.failNext = { on: true, afterWrite: false };
    expect(await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    paused.resume();
    expect((await paused.running).status).toBe(200);
    // The held request's sync found Postgres moved on before it wrote: no draft ever named estimator-a.
    expect(h.field.ownerWrites.filter((write) => write.at === `${h.seed.a}/${later}` && write.fieldOwnerUid === 'estimator-a')).toEqual([]);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: 'estimator-a2' });
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a2');
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
  });

  // r6 of the draft life-cycle redesign: the previous version settled only the current draft, so a
  // restore left an earlier draft archived and a move left an archived earlier draft naming the old owner.
  async function earlierLeftArchived() {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).status).toBe(201);
    // As the previous version's archive left it: the earlier draft archived, still naming its estimator.
    h.field.lock(h.seed.a, draftId, 'archived');
    return { id, earlier: draftId, later };
  }

  // The earlier draft is left archived (as the previous version's archive left it) after the archive's own
  // field step and just before the restore, so only the restore's field step can settle it: every draft of
  // the job ends as Postgres says.
  it('brings every draft of the job to its state on a restore, not only the current one', async () => {
    const { id, earlier, later } = await earlierLeftArchived();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    h.field.lock(h.seed.a, earlier, 'archived');
    const before = h.field.calls.length;
    expect((await restore(OWNER_A, id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    // The restore's is the only field-database step since (the draft sync, or the previous restore writer).
    expect(h.field.calls.slice(before).filter((call) => call === 'sync' || call === 'restoreDraft')).toHaveLength(1);
    expect(h.field.draft(h.seed.a, earlier)).toMatchObject({ state: 'submitted', fieldOwnerUid: 'estimator-a' });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-a' });
  });

  // The earlier draft is left archived, naming its estimator, just before the move, and a competing Start
  // field work is held at the field database, so only the move's own field step can name the new owner on
  // it: the estimator who lost the field work is named on no draft of the job, archived ones included.
  it('names the new owner on every earlier draft when the field work moves, archived ones included', async () => {
    const { id, earlier, later } = await earlierLeftArchived();
    const { revision } = (await coordination(OWNER_A, id)).body;
    const competing = await pausedRemake(() => claim(ESTIMATOR_A, id));
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(h.field.draft(h.seed.a, earlier)).toMatchObject({ state: 'submitted', fieldOwnerUid: 'estimator-a2' });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'editing', fieldOwnerUid: 'estimator-a2' });
    competing.resume();
    // The held Start's answer is the job as Postgres holds it: its field work moved to estimator-a2.
    expect((await competing.running).status).toBe(200);
  });

  it('makes the current draft again when the field database lost it after a sync, on the same request again', async () => {
    const { id, draftId } = await claimedJob();
    h.field.remove(h.seed.a, draftId);
    // Nothing changed in Postgres: the job is synced at a new field revision, so its draft is made again.
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: 'estimator-a' });
  });

  it('makes a submitted current draft the field database lost from its own record, never empty', async () => {
    const { id, draftId } = await claimedJob();
    h.field.put(h.seed.a, draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, id, { id: randomUUID(), draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    h.field.remove(h.seed.a, draftId);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'submitted', field: MANIFEST.draft, rooms: { kitchen: { name: 'Kitchen' } } });
  });

  // unreadable-reconstruction: a draft is made only from a whole record (its format, the draft map, and
  // rooms and photos lists of ids the field rules accept, each with a field map), never from part of one.
  it('makes no draft from a record that is not whole: the same request again', async () => {
    const shapes = [
      { format: 'dryscope-submission-v1', field: true },
      { format: 'dryscope-submission-v1', field: { draft: {}, rooms: [{ id: 'a/b', field: {} }], photos: [] } },
      { format: 'dryscope-submission-v1', field: { draft: {}, rooms: [{ id: 'kitchen' }], photos: [] } },
      { format: 'dryscope-submission-v1', field: { draft: [], rooms: [], photos: [] } },
    ];
    for (const shape of shapes) {
      const { id, draftId } = await claimedJob();
      const bytes = Buffer.from(JSON.stringify(shape));
      const row = { id: randomUUID(), epoch: randomUUID() };
      await h.admin`
        INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
        VALUES (${row.id}, ${h.seed.a}, ${id}, ${draftId}, ${row.epoch}, 'original', ${'a'.repeat(64)}, now() + interval '1 minute', ${h.seed.estimatorA.actor})
      `;
      await h.admin`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${bytes}, snapshot_sha256 = ${createHash('sha256').update(bytes).digest('hex')} WHERE id = ${row.id}`;
      await h.admin`UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = ${id}`;
      h.field.remove(h.seed.a, draftId);
      expect({ shape, answer: await claim(ESTIMATOR_A, id) }).toEqual({ shape, answer: { status: 503, body: { error: 'draft_unavailable' } } });
      expect(h.field.draft(h.seed.a, draftId)).toBeNull();
    }
  });

  // A record that repeats a room id is not whole: a draft made from it would fail its create and roll back
  // the whole sync, the owner change on every other draft with it.
  it('moves the field work on the earlier draft when the lost current draft’s record repeats a room id, or holds a value Firestore cannot store, and makes no draft from it', async () => {
    const records = [
      { format: 'dryscope-submission-v1', field: { draft: {}, rooms: [{ id: 'kitchen', field: {} }, { id: 'kitchen', field: {} }], photos: [] } },
      { format: 'dryscope-submission-v1', field: { draft: { roomOrder: [['kitchen']] }, rooms: [], photos: [] } },
      { format: 'dryscope-submission-v1', field: { draft: {}, rooms: [{ id: 'kitchen', field: { readings: [[1, 2]] } }], photos: [] } },
    ];
    for (const repeated of records) {
      await movedPastRecord(repeated);
    }
  });

  async function movedPastRecord(repeated: unknown) {
    const { id, draftId: first } = await claimedJob();
    const bytes = Buffer.from(JSON.stringify(repeated));
    const row = { id: randomUUID(), epoch: randomUUID() };
    await h.admin`
      INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
      VALUES (${row.id}, ${h.seed.a}, ${id}, ${first}, ${row.epoch}, 'original', ${'a'.repeat(64)}, now() + interval '1 minute', ${h.seed.estimatorA.actor})
    `;
    await h.admin`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${bytes}, snapshot_sha256 = ${createHash('sha256').update(bytes).digest('hex')} WHERE id = ${row.id}`;
    await h.admin`UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = ${id}`;
    const second = randomUUID();
    expect((await nextDraft(ESTIMATOR_A, id, { draftId: second, fromDraftId: first })).status).toBe(201);
    h.field.remove(h.seed.a, second);
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect(await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect({ repeated, first: h.field.draft(h.seed.a, first) }).toMatchObject({ repeated, first: { jobId: id, fieldOwnerUid: 'estimator-a2' } });
    expect(h.field.draft(h.seed.a, second)).toBeNull();
  }

  it('answers an archive whose current draft is another job’s with 409, and leaves its version unsynced', async () => {
    const { id, draftId } = await claimedJob();
    // The field database holds another job's draft under the id (as security audit F1 guards against).
    h.drafts.stamp(`${h.seed.a}/${draftId}`, randomUUID());
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect(await archive(OWNER_A, id, { revision, changeId: randomUUID() })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect((await read(OWNER_A, id)).status).toBe(410);
    const [row] = await h.admin<{ behind: boolean }[]>`SELECT field_synced_revision < field_revision AS behind FROM jobs WHERE id = ${id}`;
    expect(row!.behind).toBe(true);
  });

  it('answers 503 when Postgres keeps moving through every try of the field step, never a success with nothing written', async () => {
    const { id } = await claimedJob();
    const { revision } = (await coordination(OWNER_A, id)).body;
    // Each try of the sync meets a newer field revision (as a run of office-note saves would make).
    const moving = async () => {
      h.field.gate.sync = moving;
      await h.admin`UPDATE jobs SET field_revision = field_revision + 1 WHERE id = ${id}`;
    };
    h.field.gate.sync = moving;
    const body = { revision, changeId: randomUUID(), toActorId: estimatorA2 };
    expect(await transfer(OWNER_A, id, body)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    delete h.field.gate.sync;
    expect((await transfer(OWNER_A, id, body)).status).toBe(200);
  });

  it('never makes a copy’s missing draft empty when its source’s signed record cannot be read: the same request again', async () => {
    const { id, draftId } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    // A copy whose source has no signed record (as a damaged or restored source would leave it).
    const source = await officeJob();
    await h.admin`UPDATE jobs SET copied_from_job_id = ${source.id} WHERE id = ${id}`;
    h.field.remove(h.seed.a, draftId);
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, draftId)).toBeNull();
  });

  // Holds the next draft sync at the field database until the test opens it.
  async function heldSync<T>(start: () => Promise<T>) {
    const hold = latch();
    let arrived = false;
    h.field.gate.sync = async () => {
      delete h.field.gate.sync;
      arrived = true;
      await hold.wait;
    };
    const running = start();
    await until(() => arrived, 'the draft sync');
    return { running, open: hold.open };
  }

  it('gives a caller disabled while its field step waited no job, customer or staff details after it', async () => {
    const { id } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    const started = await heldSync(() => claim(ESTIMATOR_A, id));
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.estimatorA.membership}`;
    started.open();
    expect(await started.running).toEqual({ status: 403, body: { error: 'not_allowed' } });

    // A Move by an owner whose role changed while its field step waited.
    await h.admin`UPDATE memberships SET status = 'active' WHERE id = ${h.seed.estimatorA.membership}`;
    const moved = await claimedJob();
    const { revision } = (await coordination(OWNER_A, moved.id)).body;
    const moving = await heldSync(() => transfer(OWNER_A, moved.id, { revision, changeId: randomUUID(), toActorId: estimatorA2 }));
    await h.admin`UPDATE memberships SET role = 'office' WHERE id = ${h.seed.ownerA.membership}`;
    moving.open();
    expect(await moving.running).toEqual({ status: 403, body: { error: 'not_allowed' } });
  });

  it('answers 503 and records nothing as synced when Postgres moves on after the last try’s commit', async () => {
    const { id } = await claimedJob();
    const { revision } = (await coordination(OWNER_A, id)).body;
    // Every sync commits, and Postgres moves on just after (a change committing between the version check
    // and the commit, each time).
    const sync = h.field.sync;
    h.field.sync = async (...args) => {
      const result = await sync(...args);
      await h.admin`UPDATE jobs SET field_revision = field_revision + 1 WHERE id = ${id}`;
      return result;
    };
    const body = { revision, changeId: randomUUID(), toActorId: estimatorA2 };
    expect(await transfer(OWNER_A, id, body)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    const [row] = await h.admin<{ behind: boolean }[]>`SELECT field_synced_revision < field_revision AS behind FROM jobs WHERE id = ${id}`;
    expect(row!.behind).toBe(true);
    h.field.sync = sync;
    expect((await transfer(OWNER_A, id, body)).status).toBe(200);
  });

  it('answers 409 on a retried archive when the current draft now names another job, whatever the earlier sync recorded', async () => {
    const { id, draftId } = await claimedJob();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    const body = { revision, changeId: randomUUID() };
    expect((await archive(OWNER_A, id, body)).status).toBe(200);
    // A damaged field database now holds another job's draft under the job's current draft id.
    h.drafts.plant(`${h.seed.a}/${draftId}`, { fieldOwnerUid: null, jobId: randomUUID() });
    expect(await archive(OWNER_A, id, body)).toEqual({ status: 409, body: { error: 'conflict' } });
  });

  // The sync wrote the job's version, the field database then lost the current draft, and a restore retry
  // on the previous version left a placeholder in its place without changing Postgres: Start field work
  // makes the draft again at a new version, never answering 'same' over the placeholder.
  it('makes the current draft again over a placeholder a previous-version restore left after the field database lost it', async () => {
    const { id, draftId } = await claimedJob();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    h.field.remove(h.seed.a, draftId);
    expect(await h.field.restoreDraft(h.seed.a, id, draftId, 'editing', revision)).toBeDefined();
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ placeholder: true, jobId: id });
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    const made = h.field.draft(h.seed.a, draftId);
    expect(made?.placeholder).toBeUndefined();
    expect(made).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: 'estimator-a' });
  });

  // reconstruction-blocks-revocation (PR 504 follow-up): the record a missing draft would be made from is
  // read only to make it; one that cannot be read never holds up a move of the field work on a draft that exists.
  it('moves the field work on a copy’s draft that exists even when its source’s signed record cannot be read', async () => {
    const { id, draftId } = await claimedJob();
    const source = await officeJob();
    await h.admin`UPDATE jobs SET copied_from_job_id = ${source.id} WHERE id = ${id}`;
    const { revision } = (await coordination(OWNER_A, id)).body;
    expect((await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: 'estimator-a2' });
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
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
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

  it('sends the field owner to the drafts again after they lost their estimator role, which no move to them would allow', async () => {
    const { id, draftId } = await claimedJob();
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    expect(await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${id}`;
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE company_id = ${h.seed.a} AND actor_id = ${estimatorA2}`;
    const again = await transfer(OWNER_A, id, { revision: 2, changeId: randomUUID(), toActorId: estimatorA2 });
    expect(again.status).toBe(200);
    expect(again.body.fieldOwner?.actorId).toBe(estimatorA2);
    expect(draftOf(draftId)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: 2 });
    expect(await audits('job_field_owner_moved')).toBe(1);
  });

  it('never lets an older owner overwrite a newer one on the draft', async () => {
    const { id, draftId } = await claimedJob();
    expect((await transfer(OWNER_A, id, { revision: 1, changeId: randomUUID(), toActorId: estimatorA2 })).status).toBe(200);
    // A slow first-capture request made at coordination revision 1 arrives after the move.
    expect(await h.drafts.setFieldOwner(h.seed.a, id, draftId, 'estimator-a', 1)).toBe('newer');
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a2');
    // And the estimator who lost the field work cannot take it back.
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 409, body: { error: 'field_owner_taken' } });
  });
});
