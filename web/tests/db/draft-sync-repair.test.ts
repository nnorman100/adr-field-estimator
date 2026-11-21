import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OFFICE_A, OWNER_A, OWNER_B, archive, assign, create, h, officeJob, read, setUpOfficeJobsDatabase } from './office-jobs-harness';
import type { Harness } from './team-harness';

// The draft sync's repair pass (src/lib/jobs/sync-repair.ts, the draft life-cycle redesign): a job whose
// field step did not get through is synced by the scheduled worker once its grace has passed, with no
// request from a phone. Through the real routes and the runtime role against a real Postgres, with the
// field database's stand-in (tests/submissions/field-fake.ts).
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));

const { runDraftSyncRepair } = await import('@/lib/jobs/sync-repair');

setUpOfficeJobsDatabase(live);

const repair = (graceSeconds?: number) => runDraftSyncRepair(h.handle.db, h.field, graceSeconds === undefined ? {} : { graceSeconds });
const behind = async (jobId: string) =>
  (await h.admin<{ behind: boolean }[]>`SELECT field_synced_revision < field_revision AS behind FROM jobs WHERE id = ${jobId}`)[0]!.behind;

// An archive whose field step failed (its sync and the one more try): committed in Postgres, the draft
// still open, the version not recorded as synced.
async function archivedWithoutItsFieldStep(claims = OWNER_A) {
  const { id, draftId } = await officeJob();
  await assign(OFFICE_A, id, h.seed.estimatorA.actor);
  const { revision } = (await read(claims, id)).body.job as { revision: number };
  h.field.failNext.sync = 2;
  expect(await archive(claims, id, { revision, changeId: randomUUID() })).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
  expect(h.field.draft(h.seed.a, draftId)?.state).toBe('editing');
  expect(await behind(id)).toBe(true);
  return { id, draftId };
}

describe('the draft sync repair pass', () => {
  it('syncs a job whose field step did not get through once its grace has passed, with no request, and then leaves it', async () => {
    const { id, draftId } = await archivedWithoutItsFieldStep();
    // Inside the grace the request that changed the job may still be syncing it: the pass waits.
    expect(await repair()).toEqual({ synced: 0, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('editing');
    expect(await repair(0)).toEqual({ synced: 1, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'archived' });
    expect(await behind(id)).toBe(false);
    // Nothing left to do.
    expect(await repair(0)).toEqual({ synced: 0, failed: 0 });
  });

  it('counts a job it could not sync, keeps it due, and syncs it on the next pass', async () => {
    const { id, draftId } = await archivedWithoutItsFieldStep();
    h.field.failNext.sync = 2;
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await behind(id)).toBe(true);
    expect(await repair(0)).toEqual({ synced: 1, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('archived');
  });

  it('syncs each company’s jobs in that company only, and leaves a job already synced alone', async () => {
    // A job whose drafts already hold Postgres's state: New job syncs its first draft itself (slice 5).
    const synced = await officeJob();
    expect(await behind(synced.id)).toBe(false);
    expect(await repair(0)).toEqual({ synced: 0, failed: 0 });
    const first = await archivedWithoutItsFieldStep();
    // A job of the other company whose field step did not get through either.
    const other = { id: randomUUID(), draftId: randomUUID() };
    expect((await create(OWNER_B, { ...other, propertyAddress: '2 Other Road' })).status).toBe(201);
    const { revision } = (await read(OWNER_B, other.id)).body.job as { revision: number };
    h.field.failNext.sync = 2;
    expect((await archive(OWNER_B, other.id, { revision, changeId: randomUUID() })).status).toBe(503);
    const calls = h.field.calls.length;
    expect(await repair(0)).toEqual({ synced: 2, failed: 0 });
    // One sync per job due, none for the job already synced.
    expect(h.field.calls.slice(calls).filter((call) => call === 'sync')).toHaveLength(2);
    expect(h.field.draft(h.seed.a, first.draftId)?.state).toBe('archived');
    expect(h.field.draft(h.seed.b, other.draftId)).toMatchObject({ jobId: other.id, state: 'archived' });
    expect(h.field.draft(h.seed.a, synced.draftId)?.state).toBe('editing');
  });

  // R6 (slice 4b review round 2): a generation document not in its shape stops every sync the same way;
  // no try raises the job's field revision for it, so nothing churns while the operator fixes it.
  it('stops on a generation document not in its shape without raising any field revision, and goes on once it is fixed', async () => {
    const { id, draftId } = await archivedWithoutItsFieldStep();
    const fieldRevision = async () => (await h.admin<{ v: number }[]>`SELECT field_revision AS v FROM jobs WHERE id = ${id}`)[0]!.v;
    const before = await fieldRevision();
    h.field.setGeneration({ gen: -1 });
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await fieldRevision()).toBe(before);
    h.field.setGeneration(null);
    expect(await repair(0)).toEqual({ synced: 1, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('archived');
  });

  // R4 (slice 4b review round 3): with the current draft missing, the field step's own Postgres writes (the
  // claim and the raised field revision for a draft to make) wait for the control documents to be in shape.
  it('changes nothing in Postgres for a missing draft while the generation document is not in its shape', async () => {
    const { id, draftId } = await archivedWithoutItsFieldStep();
    h.field.remove(h.seed.a, draftId);
    const state = async () =>
      (await h.admin<{ v: number; claims: number }[]>`SELECT field_revision AS v, (SELECT count(*)::int FROM job_drafts WHERE job_id = ${id}) AS claims FROM jobs WHERE id = ${id}`)[0];
    const before = await state();
    h.field.setGeneration({ gen: -1 });
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await state()).toEqual(before);
    h.field.setGeneration(null);
    expect(await repair(0)).toEqual({ synced: 1, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ jobId: id, state: 'archived' });
  });

  it('waits out the 60-second grace with no override: a job changed 59 seconds ago is left, one 61 seconds ago is synced', async () => {
    const recent = await archivedWithoutItsFieldStep();
    const older = await archivedWithoutItsFieldStep();
    // The trigger's own column, set back as an older change would have left it (as the admin, with the
    // jobs triggers off for that one transaction: no route can set it).
    const changedAgo = (jobId: string, seconds: number) =>
      h.admin.begin(async (sql) => {
        await sql`SET LOCAL session_replication_role = replica`;
        await sql`UPDATE jobs SET field_changed_at = now() - make_interval(secs => ${seconds}) WHERE id = ${jobId}`;
      });
    await changedAgo(recent.id, 59);
    await changedAgo(older.id, 61);
    expect(await repair()).toEqual({ synced: 1, failed: 0 });
    expect(h.field.draft(h.seed.a, older.draftId)?.state).toBe('archived');
    expect(h.field.draft(h.seed.a, recent.draftId)?.state).toBe('editing');
    expect(await behind(recent.id)).toBe(true);
  });

  it('counts a job a newer write held back as failed, and keeps it due', async () => {
    const { id, draftId } = await archivedWithoutItsFieldStep();
    // A previous-version writer archived the draft at a revision Postgres does not have yet.
    expect(await h.field.archiveDraft(h.seed.a, id, draftId, 999)).toBe('set');
    expect(await repair(0)).toEqual({ synced: 0, failed: 1 });
    expect(await behind(id)).toBe(true);
  });

  // Jobs that keep failing stay the oldest; the pass's starting place moves on each scheduler period, so
  // they cannot hide a later job beyond one pass's bound.
  it('tries every due job of a company within a few periods, however many of the oldest keep failing', async () => {
    const jobs = [];
    for (let i = 0; i < 3; i += 1) jobs.push(await archivedWithoutItsFieldStep());
    // The two oldest hold another job's draft under their current draft id: they fail every pass.
    for (const job of jobs.slice(0, 2)) h.drafts.stamp(`${h.seed.a}/${job.draftId}`, randomUUID());
    const pass = (period: number) => runDraftSyncRepair(h.handle.db, h.field, { graceSeconds: 0, maxJobsPerCompany: 2, now: () => new Date(period * 300_000) });
    expect(await pass(0)).toEqual({ synced: 0, failed: 2 });
    expect(await behind(jobs[2]!.id)).toBe(true);
    expect(await pass(1)).toEqual({ synced: 1, failed: 1 });
    expect(h.field.draft(h.seed.a, jobs[2]!.draftId)?.state).toBe('archived');
  });
});
