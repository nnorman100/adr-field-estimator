import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ESTIMATOR_A, ESTIMATOR_A2, OFFICE_A, OWNER_A, claimedJob, create, draftNeverMade, h, read, setUpOfficeJobsDatabase } from './office-jobs-harness';
import type { Harness } from './team-harness';

// The job read gets the field owner's field work ready (the draft life-cycle redesign, slice 6): when the
// job's drafts fell behind Postgres or its current draft is missing, the field owner's read syncs them, so
// the phone needs no draftMissing flag and no Start field work again. Through the real routes and the
// runtime role against a real Postgres, with the field database's stand-in (tests/submissions/field-fake.ts).
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));

setUpOfficeJobsDatabase(live);

describe('the field owner’s job read', () => {
  it('gets the current draft Back to editing never made ready at its field owner’s read, and at nobody else’s', async () => {
    const { id, later } = await draftNeverMade();
    // Nobody else's read makes it, or learns whether it exists: not another assigned estimator, not the owner.
    expect((await read(ESTIMATOR_A2, id)).body).not.toHaveProperty('draftMissing');
    expect((await read(OWNER_A, id)).body).not.toHaveProperty('draftMissing');
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    expect((await read(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing', fieldOwnerUid: 'estimator-a' });
    // Once it is ready, a read syncs nothing more.
    const calls = h.field.calls.length;
    expect((await read(ESTIMATOR_A, id)).body).not.toHaveProperty('draftMissing');
    expect(h.field.calls.slice(calls)).not.toContain('sync');
  });

  it('makes a missing first draft again, empty, at its field owner’s read', async () => {
    const { id, draftId } = await claimedJob();
    h.drafts.remove(`${h.seed.a}/${draftId}`);
    const lost = await read(ESTIMATOR_A, id);
    expect(lost.status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'editing', field: {}, fieldOwnerUid: 'estimator-a' });
  });

  it('keeps the job read when the draft lookup does not get through, and gets the draft ready at the next read', async () => {
    const { id, later } = await draftNeverMade();
    // Its Back to editing sync failed after the job's watermark: the lookup decides, and it fails once.
    await h.admin`UPDATE jobs SET field_synced_revision = field_revision WHERE id = ${id}`;
    const lookup = vi.spyOn(h.drafts, 'findDraft').mockRejectedValueOnce(new Error('field database unreachable'));
    const unsure = await read(ESTIMATOR_A, id);
    lookup.mockRestore();
    expect(unsure.status).toBe(200);
    expect(unsure.body.job.id).toBe(id);
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    expect((await read(ESTIMATOR_A, id)).status).toBe(200);
    expect(h.field.draft(h.seed.a, later)).toMatchObject({ jobId: id, state: 'editing' });
  });

  // R8 (slice 6 review): a healthy field owner's read makes one existence lookup (how a lost first draft is
  // found while the watermark has not moved) and no sync; anyone else's read makes neither.
  it('makes no lookup or sync at a read by anyone but the field owner, and one lookup and no sync at a field owner’s read of a job already as Postgres says', async () => {
    const { id } = await claimedJob();
    const lookup = vi.spyOn(h.drafts, 'findDraft');
    const calls = h.field.calls.length;
    const office = await read(OFFICE_A, id);
    const officeLookups = lookup.mock.calls.length;
    const officeSyncs = h.field.calls.slice(calls).filter((call) => call === 'sync').length;
    const owners = await read(ESTIMATOR_A, id);
    const ownerLookups = lookup.mock.calls.length - officeLookups;
    lookup.mockRestore();
    expect([office.status, owners.status]).toEqual([200, 200]);
    expect(office.body).not.toHaveProperty('draftMissing');
    expect({ officeLookups, officeSyncs, ownerLookups, syncs: h.field.calls.slice(calls).filter((call) => call === 'sync').length }).toEqual({
      officeLookups: 0,
      officeSyncs: 0,
      ownerLookups: 1,
      syncs: 0,
    });
  });

  // Moved here from jobs-api.test.ts (R10): the field owner's read gets a lost first draft ready again.
  it('makes a new job’s lost first draft again, empty, at its field owner’s read', async () => {
    const started = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(OWNER_A, { ...started, propertyAddress: '1 Lost First Lane' })).status).toBe(201);
    expect((await read(OWNER_A, started.id)).body).not.toHaveProperty('draftMissing');
    h.drafts.remove(`${h.seed.a}/${started.draftId}`);
    const lost = await read(OWNER_A, started.id);
    expect(lost.status).toBe(200);
    expect(h.field.draft(h.seed.a, started.draftId)).toMatchObject({ jobId: started.id, state: 'editing', field: {} });
    expect(lost.body.job.currentDraftId).toBe(started.draftId);
  });

  // R1 (slice 6 review): the read answers after its last field operation, from a snapshot that checks the
  // caller again: a member disabled while the draft was got ready, or while the locator was written, gets
  // no customer or claim.
  it('gives a member disabled while the read got the draft ready or wrote the locator no details of the job', async () => {
    const { id } = await draftNeverMade();
    h.field.gate.sync = async () => {
      await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.estimatorA.membership}`;
    };
    expect(await read(ESTIMATOR_A, id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    await h.admin`UPDATE memberships SET status = 'active' WHERE id = ${h.seed.estimatorA.membership}`;
    const project = h.drafts.projectJob;
    h.drafts.projectJob = async (...args) => {
      h.drafts.projectJob = project;
      await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.estimatorA.membership}`;
      return project(...args);
    };
    expect(await read(ESTIMATOR_A, id)).toEqual({ status: 403, body: { error: 'not_allowed' } });
  });

  // R2 (slice 6 review): the locator write is best effort: a field database outage never keeps the job's
  // customer and claim from its reader.
  it('answers the job when the locator cannot be written', async () => {
    const { id } = await claimedJob();
    const project = h.drafts.projectJob;
    h.drafts.projectJob = async () => {
      h.drafts.projectJob = project;
      throw new Error('field database unreachable');
    };
    const answer = await read(ESTIMATOR_A, id);
    expect(answer.status).toBe(200);
    expect(answer.body.job.id).toBe(id);
  });

  // R4 (slice 6 review round 2): a member disabled while the read got the draft ready learns nothing of the
  // job, not even that it was archived meanwhile: the final snapshot checks the caller first.
  it('answers a member disabled while the job was archived during the read 403, never 410', async () => {
    // The company owner owns the field work of a job they made; while the read looks for its draft, the
    // owner is disabled and the job archived. The locator's read then finds the job archived, but the
    // answer is the final snapshot's, which checks the caller first.
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(OWNER_A, { ...ids, propertyAddress: '2 Archived Meanwhile Road' })).status).toBe(201);
    const find = h.drafts.findDraft;
    h.drafts.findDraft = async (...args) => {
      h.drafts.findDraft = find;
      await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.ownerA.membership}`;
      await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${ids.id}`;
      return find(...args);
    };
    const answer = await read(OWNER_A, ids.id);
    await h.admin`UPDATE memberships SET status = 'active' WHERE id = ${h.seed.ownerA.membership}`;
    expect(answer).toEqual({ status: 403, body: { error: 'not_allowed' } });
  });

  // R6 (slice 6 review round 3): a sync that got through but left the job's current draft to a newer
  // previous-version writer has not got it ready: the read logs that, by name only.
  it('logs, by name only, a read whose sync leaves the current draft to a newer previous-version archive', async () => {
    const ids = { id: randomUUID(), draftId: randomUUID() };
    h.drafts.failNext = { on: true, afterWrite: false };
    h.field.failNext.sync = 2;
    expect((await create(OWNER_A, { ...ids, propertyAddress: '3 Held Placeholder Way' })).status).toBe(503);
    const { revision } = (await read(OFFICE_A, ids.id)).body.job as { revision: number };
    // A previous version's archive at a revision Postgres has not reached left its placeholder.
    expect(await h.field.archiveDraft(h.seed.a, ids.id, ids.draftId, revision + 5)).toBe('set');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const answer = await read(OWNER_A, ids.id);
    const calls = logged.mock.calls.map((call) => call.map(String));
    logged.mockRestore();
    expect(answer.status).toBe(200);
    expect(calls).toContainEqual(['job draft prepare unsettled', 'superseded']);
    expect(h.field.draft(h.seed.a, ids.draftId)).toMatchObject({ placeholder: true });
  });
});
