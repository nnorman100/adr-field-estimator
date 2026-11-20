import { randomUUID } from 'node:crypto';
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

  // No transaction or lock waits on the field database, so a draft made here is made closed, naming
  // nobody, and is named only with the owner, revision and status Postgres holds just before.
  async function pausedRemake<T>(start: () => Promise<T>) {
    const hold = latch();
    const before = h.field.calls.filter((call) => call === 'createFrom').length;
    h.field.gate.createFrom = () => hold.wait;
    const running = start();
    await until(() => h.field.calls.filter((call) => call === 'createFrom').length > before, 'the draft being made');
    return { running, resume: hold.open };
  }

  it('leaves the current draft closed when the job was archived while the draft was being made, and names nobody on it', async () => {
    const { id, later } = await draftNeverMade();
    const paused = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    // The archive found no draft and left its placeholder there, which nothing is made over.
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', placeholder: true, field: {}, rooms: {} });
    paused.resume();
    // Nothing is made over the placeholder, so no draft exists to report: the same request again.
    expect(await paused.running).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', placeholder: true, fieldOwnerUid: null });
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 410, body: { error: 'archived' } });
  });

  // A second Start field work, let in before the archive, reaches the current draft only after the
  // first one made it: it reads the job again before naming anyone and finds it archived.
  it('never opens a remade draft to a request let in before the job was archived', async () => {
    const { id, draftId, later } = await draftNeverMade();
    const first = await pausedRemake(() => claim(ESTIMATOR_A, id));
    // The second request is past its checks and its commit, naming the owner on the earlier draft.
    const hold = latch();
    const named = h.drafts.setFieldOwner;
    let reached = false;
    h.drafts.setFieldOwner = async (companyId, jobId, at, uid, revision) => {
      if (at === draftId && !reached) {
        reached = true;
        await hold.wait;
      }
      return named(companyId, jobId, at, uid, revision);
    };
    try {
      const second = claim(ESTIMATOR_A, id);
      await until(() => reached, 'the second request at the earlier draft');
      const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
      expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
      first.resume();
      expect(await first.running).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
      hold.open();
      expect(await second).toEqual({ status: 410, body: { error: 'archived' } });
    } finally {
      h.drafts.setFieldOwner = named;
    }
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', placeholder: true, fieldOwnerUid: null });
  });

  // The archive finds no draft and answers 200; the draft is then made, but the answer that it was is
  // lost, and a second Start field work let in before the archive names its estimator on it. The
  // archive leaves a closed placeholder where the draft is missing, so nothing is made over it and
  // nobody is named on it: the archived job's field work stays closed.
  it('never makes or opens the current draft after an archive that found it missing', async () => {
    const { id, later } = await draftNeverMade();
    const first = await pausedRemake(() => claim(ESTIMATOR_A, id));
    const hold = latch();
    const named = h.drafts.setFieldOwner;
    let reached = false;
    h.drafts.setFieldOwner = async (companyId, jobId, at, uid, revision) => {
      if (at === later && !reached) {
        reached = true;
        await hold.wait;
      }
      return named(companyId, jobId, at, uid, revision);
    };
    try {
      const second = claim(ESTIMATOR_A, id);
      await until(() => reached, 'the second request at the current draft');
      const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
      expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
      h.field.loseNext.createFrom = true;
      first.resume();
      expect(await first.running).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
      hold.open();
      // Its stamp finds only the placeholder: no draft to name anyone on, so try again (then 410).
      expect(await second).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    } finally {
      h.drafts.setFieldOwner = named;
    }
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'archived', field: {}, rooms: {} });
    expect(draftOf(later)?.fieldOwnerUid ?? null).toBeNull();
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 410, body: { error: 'archived' } });
  });

  it('makes the current draft once the job is restored, over the placeholder that kept the revision', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', placeholder: true });
    expect((await restore(OWNER_A, id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'absent', placeholder: true, archiveRevision: revision + 2 });
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    const made = h.field.draft(h.seed.a, later);
    expect(made).toMatchObject({ jobId: id, state: 'editing', field: MANIFEST.draft, previous: { draftId, submissionId }, archiveRevision: revision + 2 });
    expect(made?.placeholder).toBeUndefined();
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
  });

  // The archive's field step is held while the restore commits and lands; the archive then reaches a
  // draft that is still missing. The restore's placeholder holds its revision, so the older archive
  // changes nothing and the restored job's draft is made and opened.
  it('never lets an archive that lands after a restore close the draft of the restored job', async () => {
    const { id, later } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    const hold = latch();
    h.field.gate.archiveDraft = () => hold.wait;
    const archiving = archive(OWNER_A, id, { revision, changeId: randomUUID() });
    await until(() => h.field.calls.includes('archiveDraft'), 'the archive at the field database');
    expect((await restore(OWNER_A, id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    hold.open();
    expect((await archiving).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'absent', placeholder: true, archiveRevision: revision + 2 });
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', archiveRevision: revision + 2 });
    expect(draftOf(later)?.fieldOwnerUid).toBe('estimator-a');
  });

  // Back to editing's retry over the placeholder of a job whose restore did not reach the field
  // database finds no draft there: it never answers 200 for one, and makes it once the restore has.
  it('never answers Back to editing’s retry for a draft that is only an archive’s placeholder', async () => {
    const { id, draftId, later, submissionId } = await draftNeverMade();
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    h.field.failNext.restoreDraft = true;
    const once = { revision: revision + 1, changeId: randomUUID() };
    expect(await restore(OWNER_A, id, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(await nextDraft(ESTIMATOR_A, id, { draftId: later, fromDraftId: draftId })).toEqual({
      status: 503,
      body: { error: 'draft_unavailable' },
    });
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ state: 'archived', placeholder: true, rooms: {} });
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
  // the same create again makes the draft over the placeholder, in the one record, keeping its revision.
  it('makes the draft of a New job retry over the placeholder an archive and restore left, keeping its revision', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    h.drafts.failNext = { on: true, afterWrite: false };
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(503);
    const { revision } = (await read(OWNER_A, ids.id)).body.job as { revision: number };
    expect((await archive(OWNER_A, ids.id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, ids.draftId)).toMatchObject({ state: 'archived', placeholder: true });
    // While the job is archived, the same create again is answered archived and makes nothing.
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(410);
    expect(h.field.draft(h.seed.a, ids.draftId)).toMatchObject({ state: 'archived', placeholder: true });
    expect((await restore(OWNER_A, ids.id, { revision: revision + 1, changeId: randomUUID() })).status).toBe(200);
    expect((await create(OFFICE_A, { ...ids, propertyAddress: '40 Office Road' })).status).toBe(200);
    const made = h.field.draft(h.seed.a, ids.draftId);
    expect(made).toMatchObject({ jobId: ids.id, state: 'editing', archiveRevision: revision + 2 });
    expect(made?.placeholder).toBeUndefined();
    expect(draftOf(ids.draftId)).toBeDefined();
  });

  // A stamp that reaches a draft the job's archive closed names nobody on it, though Postgres has
  // restored the job since (its restore's field step is still to come): the archived scope and rooms
  // never reach that estimator.
  it('names nobody on a draft that is archived, until the restore reaches the field database', async () => {
    const { id, draftId } = await officeJob();
    await assign(OFFICE_A, id, h.seed.estimatorA.actor);
    const { revision } = (await read(OWNER_A, id)).body.job as { revision: number };
    expect((await archive(OWNER_A, id, { revision, changeId: randomUUID() })).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'archived' });
    h.field.failNext.restoreDraft = true;
    const once = { revision: revision + 1, changeId: randomUUID() };
    expect(await restore(OWNER_A, id, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(await claim(ESTIMATOR_A, id)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(draftOf(draftId)?.fieldOwnerUid).toBeNull();
    expect((await restore(OWNER_A, id, once)).status).toBe(200);
    expect((await claim(ESTIMATOR_A, id)).status).toBe(200);
    expect(draftOf(draftId)?.fieldOwnerUid).toBe('estimator-a');
  });

  it('makes the draft naming nobody, and never names a field owner who has since changed on it', async () => {
    const { id, later } = await draftNeverMade();
    const { revision } = (await coordination(OWNER_A, id)).body;
    const paused = await pausedRemake(() => claim(ESTIMATOR_A, id));
    // The move commits, then its own field step fails before it makes the draft.
    h.field.failNext.createFrom = true;
    expect(await transfer(OWNER_A, id, { revision, changeId: randomUUID(), toActorId: estimatorA2 })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    paused.resume();
    expect(await paused.running).toEqual({ status: 409, body: { error: 'field_owner_taken' } });
    // Made, and closed: it names nobody until the new owner's request stamps it.
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: null });
    expect(draftOf(later)?.fieldOwnerUid).toBeNull();
    expect((await claim(ESTIMATOR_A2, id)).status).toBe(200);
    expect(draftOf(later)).toEqual({ fieldOwnerUid: 'estimator-a2', fieldOwnerRevision: revision + 1 });
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

  it('sends the field owner to the drafts again after they lost their estimator role, which no move to them would allow', async () => {
    const { id, draftId } = await claimedJob();
    h.drafts.failNext = { on: true, afterWrite: false };
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
