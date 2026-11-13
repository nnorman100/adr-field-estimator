import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalManifest } from '@/lib/field/canonical';
import type { SubmissionsService } from '@/lib/submissions/service';
import { flow } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-8, Back to editing (owner decision J4; docs/plans/S5.md, section 4, step 7): the next draft
// version of a submitted job, made from the submitted record with its provenance, under the job
// lock, only from the job's current draft. Set up as submissions-api.test.ts.
const live = vi.hoisted(() => ({ harness: null as Harness | null, service: null as SubmissionsService | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.service ?? live.harness!.submissions }));

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

const f = flow(() => h, {
  createJob: jobsRoute.POST,
  putPhoto: photoRoute.PUT,
  submit: submissionsRoute.POST,
  nextDraft: draftsRoute.POST,
  request,
  params,
});

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.service = null;
  const [actor] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// A submitted job, ready for Back to editing.
async function submittedJob(claims: FakeClaims = ESTIMATOR_A) {
  const ready = await f.readyJob(claims, h.seed.a);
  const { body, answer } = await f.submitShown(claims, ready.jobId, ready.draftId, ready.manifest);
  expect(answer.status).toBe(201);
  return { ...ready, submissionId: body.id };
}

describe('Back to editing', () => {
  it('makes the next draft version from the submitted record, with its provenance', async () => {
    const { jobId, draftId, manifest, submissionId } = await submittedJob();
    const before = await f.job(jobId);
    // The phone's copy of the old draft no longer matters: the new version comes from the record.
    h.field.put(h.seed.a, draftId, { draft: { notes: 'never submitted' } });
    const next = randomUUID();
    const answer = await f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId });
    expect(answer).toEqual({ status: 201, body: { job: { id: jobId, status: 'draft', currentDraftId: next, revision: before.revision + 1 } } });
    expect(await f.job(jobId)).toMatchObject({ status: 'draft', current_draft_id: next, last_change_id: next });
    const made = h.field.draft(h.seed.a, next)!;
    expect(made).toMatchObject({ state: 'editing', fence: null, fieldOwnerUid: 'estimator-a', previous: { draftId, submissionId } });
    const stored = JSON.parse(canonicalManifest(manifest));
    expect(made.field).toEqual(stored.draft);
    expect(made.rooms).toEqual(Object.fromEntries(stored.rooms.map((room: { id: string; field: unknown }) => [room.id, room.field])));
    expect(made.photos).toEqual(Object.fromEntries(stored.photos.map((photo: { id: string; field: unknown }) => [photo.id, photo.field])));
    // The old draft and its record stay as they were.
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitted');
    expect(await f.submissions(jobId)).toEqual([expect.objectContaining({ id: submissionId, status: 'committed' })]);
    expect(await f.auditActions(jobId)).toContain('job_back_to_editing');

    // The new version takes photos and is submitted as a second record of the job.
    const photoId = randomUUID();
    expect((await f.sendPhoto(ESTIMATOR_A, jobId, photoId, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 7]))).status).toBe(201);
    const changed = { ...stored, photos: [...stored.photos, { id: photoId, field: {} }] };
    h.field.put(h.seed.a, next, changed);
    expect((await f.submitShown(ESTIMATOR_A, jobId, next, changed)).answer.status).toBe(201);
    expect((await f.submissions(jobId)).map((row) => [row.draft_id, row.status])).toEqual([
      [draftId, 'committed'],
      [next, 'committed'],
    ]);
    expect(await f.expectOneOutcome(h.seed.a, jobId, next)).toBe('committed');
  });

  it('two calls with the same new id make one draft', async () => {
    const { jobId, draftId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(201);
    const after = await f.job(jobId);
    expect(await f.nextDraft(ESTIMATOR_A, jobId, body)).toEqual({ status: 200, body: { job: { id: jobId, status: 'draft', currentDraftId: body.draftId, revision: after.revision } } });
    expect(await f.job(jobId)).toEqual(after);
    expect(h.field.calls.filter((call) => call === 'createFrom')).toHaveLength(2);
    expect(Object.keys(h.field.data()).filter((key) => key.endsWith(body.draftId))).toHaveLength(1);
    expect((await f.auditActions(jobId)).filter((action) => action === 'job_back_to_editing')).toHaveLength(1);
  });

  it('two calls with different new ids at once make one new draft and one 409', async () => {
    const { jobId, draftId } = await submittedJob();
    const ids = [randomUUID(), randomUUID()];
    const answers = await Promise.all(ids.map((id) => f.nextDraft(ESTIMATOR_A, jobId, { draftId: id, fromDraftId: draftId })));
    expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
    expect(answers.find((a) => a.status === 409)!.body.error).toBe('conflict');
    const winner = ids[answers.findIndex((a) => a.status === 201)]!;
    expect((await f.job(jobId)).current_draft_id).toBe(winner);
    expect(ids.filter((id) => h.field.draft(h.seed.a, id) !== null)).toEqual([winner]);
  });

  it('refuses a job that is not submitted, a draft that is not current, and a draft id another job holds', async () => {
    const editing = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect(await f.nextDraft(ESTIMATOR_A, editing.jobId, { draftId: randomUUID(), fromDraftId: editing.draftId })).toMatchObject({
      status: 409,
      body: { error: 'not_submitted' },
    });
    const { jobId, draftId } = await submittedJob();
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: randomUUID() })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    // Another job's draft id is never taken over.
    const before = await f.job(jobId);
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: editing.draftId, fromDraftId: draftId })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await f.job(jobId)).toEqual(before);
    // A signed job changes only through a change order.
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: draftId })).toMatchObject({ status: 409, body: { error: 'job_signed' } });
    for (const bad of [{}, { draftId: 'x', fromDraftId: draftId }, { draftId: randomUUID(), fromDraftId: draftId, more: true }]) {
      expect(await f.nextDraft(ESTIMATOR_A, jobId, bad)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
  });

  it('only the owner and the estimator whose job it is go back to editing; another company never reaches the job', async () => {
    const { jobId, draftId } = await submittedJob();
    const before = await everything(h.admin);
    const fieldBefore = JSON.stringify(h.field.data());
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    expect(await f.nextDraft(OFFICE_A, jobId, body)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await f.nextDraft(ESTIMATOR_A2, jobId, body)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    for (const claims of [OWNER_B, ESTIMATOR_B]) expect(await f.nextDraft(claims, jobId, body)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((await f.nextDraft(null, jobId, body)).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
    expect(JSON.stringify(h.field.data())).toBe(fieldBefore);
    expect((await f.nextDraft(OWNER_A, jobId, body)).status).toBe(201);
  });

  it('makes the missing draft when the same request is sent again after the field database failed', async () => {
    const { jobId, draftId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    h.field.failNext.createFrom = true;
    expect(await f.nextDraft(ESTIMATOR_A, jobId, body)).toMatchObject({ status: 503, body: { error: 'submissions_unavailable' } });
    expect((await f.job(jobId)).current_draft_id).toBe(body.draftId);
    expect(h.field.draft(h.seed.a, body.draftId)).toBeNull();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(h.field.draft(h.seed.a, body.draftId)).toMatchObject({ state: 'editing', previous: { draftId } });
  });
});
