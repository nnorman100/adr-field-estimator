import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalManifest } from '@/lib/field/canonical';
import type { SubmissionsService } from '@/lib/submissions/service';
import { flow, json } from './submission-flow';
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
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
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
    expect(h.field.projected.get(`${h.seed.a}/${jobId}`)).toEqual({ currentDraftId: next, revision: before.revision + 1 });
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
    const calls = h.field.calls.length;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(201);
    const after = await f.job(jobId);
    expect(await f.nextDraft(ESTIMATOR_A, jobId, body)).toEqual({ status: 200, body: { job: { id: jobId, status: 'draft', currentDraftId: body.draftId, revision: after.revision } } });
    expect(await f.job(jobId)).toEqual(after);
    // One draft sync each; the second finds the draft as Postgres says.
    expect(h.field.calls.slice(calls).filter((call) => call === 'sync')).toHaveLength(2);
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

  // Security audit F1: a job's own earlier draft, or a draft the field database holds for another
  // job, is never its next draft version.
  it('refuses the job’s own earlier draft and a draft made for another job, and leaves both as they are', async () => {
    const { jobId, draftId, manifest } = await submittedJob();
    const second = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: second, fromDraftId: draftId })).status).toBe(201);
    h.field.put(h.seed.a, second, manifest);
    expect((await f.submitShown(ESTIMATOR_A, jobId, second, manifest)).answer.status).toBe(201);
    const before = await f.job(jobId);
    const earlier = structuredClone(h.field.draft(h.seed.a, draftId));
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId, fromDraftId: second })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await f.job(jobId)).toEqual(before);
    expect(h.field.draft(h.seed.a, draftId)).toEqual(earlier);

    const foreign = randomUUID();
    const key = `${h.seed.a}/${foreign}`;
    h.drafts.plant(key, { fieldOwnerUid: 'estimator-a2', jobId: randomUUID() });
    const stored = structuredClone(h.field.draft(h.seed.a, foreign));
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: foreign, fromDraftId: second })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(h.field.draft(h.seed.a, foreign)).toEqual(stored);
    expect(await f.job(jobId)).toEqual(before);
    expect(await h.admin`SELECT job_id FROM job_drafts WHERE draft_id = ${foreign}`).toEqual([]);
    // The job is still on its submitted draft, so a fresh id still goes back to editing.
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: randomUUID(), fromDraftId: second })).status).toBe(201);
  });

  // Security audit F1, the planned regression: after job A submits and moves off its first draft,
  // Back to editing on job B with that id answers 409, and the draft and its field owner stay as they
  // are; so does job B.
  it('refuses another job’s earlier draft as a job’s next draft, and leaves both jobs and that draft as they are', async () => {
    const a = await submittedJob();
    expect((await f.nextDraft(ESTIMATOR_A, a.jobId, { draftId: randomUUID(), fromDraftId: a.draftId })).status).toBe(201);
    const b = await submittedJob(ESTIMATOR_A2);
    const key = `${h.seed.a}/${a.draftId}`;
    const draft = structuredClone(h.field.draft(h.seed.a, a.draftId));
    const owner = structuredClone(h.drafts.owner(key));
    const before = await everything(h.admin);
    expect(await f.nextDraft(ESTIMATOR_A2, b.jobId, { draftId: a.draftId, fromDraftId: b.draftId })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(h.field.draft(h.seed.a, a.draftId)).toEqual(draft);
    expect(h.drafts.owner(key)).toEqual(owner);
    expect(owner?.fieldOwnerUid).toBe('estimator-a');
    expect(h.drafts.jobOf(key)).toBe(a.jobId);
  });

  // Security audit F1: a next draft is never the draft it comes from. Sent with one id as both, even
  // for a job whose current draft the previous version left unclaimed, it is refused before any claim,
  // so the refused id commits nothing.
  it('refuses the same id as next draft and source before any claim, so nothing is committed', async () => {
    const { jobId, draftId } = await submittedJob();
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${draftId}`;
    const before = await everything(h.admin);
    const stored = structuredClone(h.field.draft(h.seed.a, draftId));
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId, fromDraftId: draftId })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(await h.admin`SELECT job_id FROM job_drafts WHERE draft_id = ${draftId}`).toEqual([]);
    expect(h.field.draft(h.seed.a, draftId)).toEqual(stored);
  });

  // Security audit F1, across a release: the migration runs while the previous version still serves,
  // and that version puts jobs on drafts and submits them without claiming them or writing their job
  // id on the draft. Such a submitted draft is still no other job's, nor its own job's next draft.
  it('refuses a submitted draft the previous version left unclaimed, to another job and to its own job', async () => {
    const { jobId, draftId, manifest } = await submittedJob();
    const second = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: second, fromDraftId: draftId })).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE job_id = ${jobId}`;
    const key = `${h.seed.a}/${draftId}`;
    h.drafts.unstamp(key);
    const stored = structuredClone(h.drafts.owner(key));

    const other = randomUUID();
    const made = await json(jobsRoute.POST(request(ESTIMATOR_A2, '/api/jobs', { method: 'POST', body: { id: other, draftId } }), params({})));
    expect(made).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await h.admin`SELECT id FROM jobs WHERE id = ${other}`).toEqual([]);
    expect(await h.admin`SELECT job_id FROM job_drafts WHERE draft_id = ${draftId}`).toEqual([]);
    expect(h.drafts.owner(key)).toEqual(stored);
    expect(h.drafts.jobOf(key)).toBeUndefined();

    h.field.put(h.seed.a, second, manifest);
    expect((await f.submitShown(ESTIMATOR_A, jobId, second, manifest)).answer.status).toBe(201);
    const before = await f.job(jobId);
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId, fromDraftId: second })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(await f.job(jobId)).toEqual(before);
  });

  // Security audit F1, across a release: the previous version went back to editing without claiming
  // the new draft id or writing the job id on the draft it made. The same request sent again claims
  // the id for the job in Postgres first, then stamps the draft; an id Postgres holds for another job
  // is refused and its draft not stamped.
  it('claims and stamps a next draft the previous version made when the same request is sent again, and refuses one another job holds', async () => {
    const { jobId, draftId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${body.draftId}`;
    h.field.unstamp(h.seed.a, body.draftId);
    const other = await f.readyJob(ESTIMATOR_A, h.seed.a);
    await h.admin`INSERT INTO job_drafts (company_id, draft_id, job_id) VALUES (${h.seed.a}, ${body.draftId}, ${other.jobId})`;
    const stored = structuredClone(h.field.draft(h.seed.a, body.draftId));
    expect(await f.nextDraft(ESTIMATOR_A, jobId, body)).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(h.field.draft(h.seed.a, body.draftId)).toEqual(stored);
    expect(stored?.jobId).toBeUndefined();

    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${body.draftId}`;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${body.draftId}`).toEqual([{ job: jobId }]);
    expect(h.field.draft(h.seed.a, body.draftId)).toEqual({ ...stored, jobId });
  });

  // Security audit F1: the claim commits before the stamp, so a lost answer from the stamp never leaves
  // a draft the previous version made stamped without its claim.
  it('commits the claim before stamping a next draft the previous version made, so a lost answer leaves it claimed', async () => {
    const { jobId, draftId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${body.draftId}`;
    h.field.unstamp(h.seed.a, body.draftId);
    // The draft sync stamps it and loses its answer, on its try and its one more try.
    h.field.loseNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(503);
    expect(h.field.draft(h.seed.a, body.draftId)?.jobId).toBe(jobId);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${body.draftId}`).toEqual([{ job: jobId }]);
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
  });

  it('gives a new draft id to one of two jobs that claim it at once, and refuses the other (security audit F1)', async () => {
    const { jobId, draftId } = await submittedJob();
    const contested = randomUUID();
    const other = randomUUID();
    const [back, made] = await Promise.all([
      f.nextDraft(ESTIMATOR_A, jobId, { draftId: contested, fromDraftId: draftId }),
      json(jobsRoute.POST(request(ESTIMATOR_A2, '/api/jobs', { method: 'POST', body: { id: other, draftId: contested } }), params({}))),
    ]);
    expect([back.status, made.status].sort()).toEqual([201, 409]);
    const winner = back.status === 201 ? jobId : other;
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${contested}`).toEqual([{ job: winner }]);
    expect(await h.admin`SELECT id::text FROM jobs WHERE current_draft_id = ${contested}`).toEqual([{ id: winner }]);
  });

  it('only the estimator who owns the field work goes back to editing, not the owner who does not; another company never reaches the job', async () => {
    const { jobId, draftId } = await submittedJob();
    const before = await everything(h.admin);
    const fieldBefore = JSON.stringify(h.field.data());
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    expect(await f.nextDraft(OFFICE_A, jobId, body)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await f.nextDraft(OWNER_A, jobId, body)).toMatchObject({ status: 403, body: { error: 'not_field_owner' } });
    expect(await f.nextDraft(ESTIMATOR_A2, jobId, body)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    for (const claims of [OWNER_B, ESTIMATOR_B]) expect(await f.nextDraft(claims, jobId, body)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect((await f.nextDraft(null, jobId, body)).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
    expect(JSON.stringify(h.field.data())).toBe(fieldBefore);
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(201);
  });

  it('makes the missing draft when the same request is sent again after the field database failed', async () => {
    const { jobId, draftId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    // The draft sync fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect(await f.nextDraft(ESTIMATOR_A, jobId, body)).toMatchObject({ status: 503, body: { error: 'submissions_unavailable' } });
    expect((await f.job(jobId)).current_draft_id).toBe(body.draftId);
    expect(h.field.draft(h.seed.a, body.draftId)).toBeNull();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(h.field.draft(h.seed.a, body.draftId)).toMatchObject({ state: 'editing', previous: { draftId } });
  });

  it('makes the missing draft on a retry even after the office saved the claim in between', async () => {
    const { jobId, draftId, submissionId } = await submittedJob();
    const body = { draftId: randomUUID(), fromDraftId: draftId };
    // The draft sync fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(503);
    const claim = {
      revision: (await f.job(jobId)).revision,
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
    };
    const saved = await claimRoute.PUT(request(OFFICE_A, `/api/jobs/${jobId}/claim`, { method: 'PUT', body: claim }), params({ jobId }));
    expect(saved.status).toBe(200);
    expect((await f.job(jobId)).last_change_id).toBe(claim.changeId);
    expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(h.field.draft(h.seed.a, body.draftId)).toMatchObject({ state: 'editing', previous: { draftId, submissionId } });
  });

  it('never makes the missing draft from a record that is not the latest', async () => {
    const { jobId, draftId, manifest } = await submittedJob();
    const second = randomUUID();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: second, fromDraftId: draftId })).status).toBe(201);
    h.field.put(h.seed.a, second, manifest);
    expect((await f.submitShown(ESTIMATOR_A, jobId, second, manifest)).answer.status).toBe(201);
    const third = randomUUID();
    // The draft sync fails on its try and its one more try.
    h.field.failNext.sync = 2;
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: third, fromDraftId: second })).status).toBe(503);
    expect(await f.nextDraft(ESTIMATOR_A, jobId, { draftId: third, fromDraftId: draftId })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    expect(h.field.draft(h.seed.a, third)).toBeNull();
    expect((await f.nextDraft(ESTIMATOR_A, jobId, { draftId: third, fromDraftId: second })).status).toBe(200);
    expect(h.field.draft(h.seed.a, third)?.previous).toMatchObject({ draftId: second });
  });
});


it('retries a failed locator after the SQL draft change without making another draft', async () => {
  const { jobId, draftId } = await submittedJob();
  const body = { draftId: randomUUID(), fromDraftId: draftId };
  h.field.failNext.projectJob = true;
  expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(503);
  const after = await f.job(jobId);
  expect(after.current_draft_id).toBe(body.draftId);
  expect(h.field.draft(h.seed.a, body.draftId)).not.toBeNull();
  expect((await f.nextDraft(ESTIMATOR_A, jobId, body)).status).toBe(200);
  expect(await f.job(jobId)).toEqual(after);
  expect(h.field.projected.get(`${h.seed.a}/${jobId}`)).toEqual({ currentDraftId: body.draftId, revision: after.revision });
});
