import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manifestDigest } from '@/lib/field/canonical';
import { ESTIMATOR_A, ESTIMATOR_A2, MANIFEST, OFFICE_A, OWNER_A, assign, claim, estimatorA2, h, nextDraft, officeJob, read, submitDraft, setUpOfficeJobsDatabase } from './office-jobs-harness';
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
  async function claimedJob() {
    const made = await officeJob();
    await assign(OFFICE_A, made.id, h.seed.estimatorA.actor);
    await assign(OFFICE_A, made.id, estimatorA2);
    expect((await claim(ESTIMATOR_A, made.id)).status).toBe(201);
    return made;
  }

  // Back to editing committed a new draft id and its field step failed, on its one more try too.
  async function draftNeverMade() {
    const made = await claimedJob();
    h.field.put(h.seed.a, made.draftId, MANIFEST);
    expect((await submitDraft(ESTIMATOR_A, made.id, { id: randomUUID(), draftId: made.draftId, digest: await manifestDigest(MANIFEST) })).status).toBe(201);
    const later = randomUUID();
    h.field.failNext.sync = 2;
    expect(await nextDraft(ESTIMATOR_A, made.id, { draftId: later, fromDraftId: made.draftId })).toEqual({ status: 503, body: { error: 'submissions_unavailable' } });
    expect(h.field.draft(h.seed.a, later)).toBeNull();
    return { ...made, later };
  }

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

  it('does not look for or sync the drafts at a read by anyone but the field owner, or of a job already as Postgres says', async () => {
    const { id } = await claimedJob();
    const lookup = vi.spyOn(h.drafts, 'findDraft');
    const calls = h.field.calls.length;
    const office = await read(OFFICE_A, id);
    const looked = lookup.mock.calls.length;
    const owners = await read(ESTIMATOR_A, id);
    lookup.mockRestore();
    expect([office.status, owners.status]).toEqual([200, 200]);
    expect(office.body).not.toHaveProperty('draftMissing');
    expect(looked).toBe(0);
    expect(h.field.calls.slice(calls)).not.toContain('sync');
  });
});
