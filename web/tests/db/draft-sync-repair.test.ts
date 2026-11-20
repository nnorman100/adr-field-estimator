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
    // A job whose drafts already hold Postgres's state (New job writes its draft on its own writer until
    // the redesign's slice 5, so its first sync is the pass's).
    const synced = await officeJob();
    expect(await repair(0)).toEqual({ synced: 1, failed: 0 });
    expect(await behind(synced.id)).toBe(false);
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
});
