import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalManifest, manifestDigest } from '@/lib/field/canonical';
import type { SubmissionsService } from '@/lib/submissions/service';
import { flow, latch, sha256, until } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5a-8, Submit (docs/plans/S5.md, section 4): the intent row, the fence, the snapshot, one row
// deciding, and the marker; the worker's repair of expired attempts and lost markers. Through the
// real route files as the runtime role against a real Postgres; the field database is the stand-in
// in tests/submissions/field-fake.ts, held to the same contract as the real Firestore writer
// (tests/emu/submission-fence.test.ts), and the field rules' refusal of phone writes to a fenced or
// submitted draft is checked in tests/emu/. Process kills between the steps are in
// submission-crash.test.ts; Back to editing in next-draft-api.test.ts.
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
const { submissionsService } = await import('@/lib/submissions/service');
const { runSubmissionRepair } = await import('@/lib/submissions/repair');
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

// A service with a short window, so an attempt can expire within a test.
const shortWindow = (windowMs = 1500) => submissionsService(h.handle.db, h.field, { windowMs, fenceMarginMs: 200 });
const expire = (ms = 1600) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Submit', () => {
  it('records the draft once as an immutable snapshot and marks the draft submitted', async () => {
    const { jobId, draftId, photoId, photoBytes, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    await h.admin`INSERT INTO job_customers (company_id, job_id, name, phone, email) VALUES (${h.seed.a}, ${jobId}, 'Synthetic Customer', '555-0100', 'customer@example.test')`;
    const before = await f.job(jobId);
    const { body, answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(answer.status).toBe(201);
    const [row] = await f.submissions(jobId);
    expect(row).toMatchObject({ id: body.id, draft_id: draftId, status: 'committed', marker_state: 'done' });
    expect(answer.body).toEqual({
      submission: {
        id: body.id,
        jobId,
        draftId,
        status: 'committed',
        snapshotSha256: row!.snapshot_sha256,
        createdAt: expect.stringMatching(/^\d{4}-/),
        decidedAt: expect.stringMatching(/^\d{4}-/),
      },
      job: { id: jobId, status: 'submitted', currentDraftId: draftId, revision: before.revision + 1 },
    });

    // The snapshot: the draft in its canonical form, the registry's photo facts, the job header,
    // customer and claim; its hash is the hash of its bytes.
    const snapshot = JSON.parse(row!.snapshot!.toString('utf8'));
    expect(sha256(row!.snapshot!)).toBe(row!.snapshot_sha256);
    expect(snapshot).toMatchObject({
      format: 'dryscope-submission-v1',
      submissionId: body.id,
      jobId,
      draftId,
      fieldSha256: body.digest,
      field: JSON.parse(canonicalManifest(manifest)),
      photos: [{ id: photoId, sha256: sha256(photoBytes), sizeBytes: photoBytes.byteLength, contentType: 'image/png' }],
      job: { propertyAddress: '' },
      customer: { name: 'Synthetic Customer', phone: '555-0100', email: 'customer@example.test' },
    });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'submitted', fence: { submissionId: body.id, epoch: row!.epoch } });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    // Audit rows hold ids and counts only.
    expect(await f.auditActions(jobId)).toEqual(['job_created', 'photo_received', 'submission_started', 'submission_committed']);
    const [committed] = await h.admin`SELECT details FROM audit_events WHERE action = 'submission_committed'`;
    expect(committed!.details).toEqual({ revision: before.revision + 1, rooms: 2, photos: 1 });
    // The record never changes: the database refuses a change to a committed row.
    await expect(h.admin`UPDATE job_submissions SET status = 'aborted' WHERE id = ${body.id}`).rejects.toThrow(/cannot change/);
  });

  describe('double submit makes one record', () => {
    it('the same id twice answers the same record', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const { body, answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      expect(answer.status).toBe(201);
      const again = await f.submit(ESTIMATOR_A, jobId, body);
      expect(again.status).toBe(200);
      expect(again.body.submission).toEqual(answer.body.submission);
      expect(await f.submissions(jobId)).toHaveLength(1);
      expect(await f.auditActions(jobId)).toEqual(['job_created', 'photo_received', 'submission_started', 'submission_committed']);
    });

    it('the same id sent twice at once makes one record', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const body = { id: randomUUID(), draftId, digest: await manifestDigest(manifest) };
      const answers = await Promise.all([f.submit(ESTIMATOR_A, jobId, body), f.submit(ESTIMATOR_A, jobId, body)]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
      expect(answers[0]!.body.submission).toEqual(answers[1]!.body.submission);
      expect(await f.submissions(jobId)).toHaveLength(1);
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });

    it('two phones with different ids at once: one record and one 409', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const answers = await Promise.all([f.submitShown(ESTIMATOR_A, jobId, draftId, manifest), f.submitShown(OWNER_A, jobId, draftId, manifest)]);
      const statuses = answers.map((a) => a.answer.status).sort();
      expect(statuses).toEqual([201, 409]);
      const refused = answers.find((a) => a.answer.status === 409)!.answer.body.error;
      expect(['submission_in_progress', 'already_submitted']).toContain(refused);
      expect((await f.submissions(jobId)).filter((row) => row.status === 'committed')).toHaveLength(1);
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });

    it('a second phone while the first is between its fence and its record gets 409, and the first records', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const hold = latch();
      h.field.gate.read = () => hold.wait;
      const first = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the first fence');
      const second = await f.submitShown(OWNER_A, jobId, draftId, manifest);
      expect(second.answer).toMatchObject({ status: 409, body: { error: 'submission_in_progress' } });
      hold.open();
      expect((await first).answer.status).toBe(201);
      expect(await f.submissions(jobId)).toHaveLength(1);
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });

    it('a same-id retry racing a first attempt that fails reading the draft records once, and the draft is submitted', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const body = { id: randomUUID(), draftId, digest: await manifestDigest(manifest) };
      const retried = latch();
      // The first attempt's read waits for the retry to finish, then fails as if Firestore were gone.
      h.field.gate.read = async () => {
        await retried.wait;
        throw new Error('field database unreachable');
      };
      const first = f.submit(ESTIMATOR_A, jobId, body);
      await until(() => h.field.calls.filter((call) => call === 'read').length === 1, 'the first read');
      const retry = await f.submit(ESTIMATOR_A, jobId, body);
      expect(retry.status).toBe(201);
      retried.open();
      expect(await first).toMatchObject({ status: 503, body: { error: 'submissions_unavailable' } });
      expect(await f.submissions(jobId)).toHaveLength(1);
      // The failing attempt released nothing: the draft stays submitted with its record.
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });

    it('a same-id retry racing a first attempt that aborts never leaves a committed record on an editing draft', async () => {
      // The first attempt reads the draft before its photo is registered, so it must abort; the
      // retry reads it after. Whichever decides first wins, and the draft follows the row.
      const { jobId, draftId } = await f.newJob(ESTIMATOR_A);
      const photoId = randomUUID();
      const manifest = {
        draft: { roomOrder: ['kitchen'] },
        rooms: [{ id: 'kitchen', field: { name: 'Kitchen' } }],
        photos: [{ id: photoId, field: { roomId: 'kitchen' } }],
      };
      h.field.put(h.seed.a, draftId, manifest);
      const body = { id: randomUUID(), draftId, digest: await manifestDigest(manifest) };
      const first = await f.submit(ESTIMATOR_A, jobId, body);
      expect(first).toMatchObject({ status: 409, body: { error: 'photo_missing' } });
      // The photo arrives now; the retry of the same id is told to start again, and nothing commits.
      expect((await f.sendPhoto(ESTIMATOR_A, jobId, photoId, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))).status).toBe(201);
      expect(await f.submit(ESTIMATOR_A, jobId, body)).toMatchObject({ status: 409, body: { error: 'submission_aborted' } });
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
      // A new id records it.
      const again = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      expect(again.answer.status).toBe(201);
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });

    it('a same-id retry that commits while an aborting attempt waits leaves the record and the submitted draft', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const body = { id: randomUUID(), draftId, digest: await manifestDigest(manifest) };
      // The first attempt waits at its read; the retry records; the first then finds the row decided
      // and answers the record, writing no release.
      const hold = latch();
      h.field.gate.read = () => hold.wait;
      const first = f.submit(ESTIMATOR_A, jobId, body);
      await until(() => h.field.calls.includes('read'), 'the first read');
      expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(201);
      hold.open();
      expect((await first).status).toBe(200);
      expect(h.field.calls.filter((call) => call === 'release')).toEqual([]);
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    });
  });

  describe('a locked draft is rejected', () => {
    it('while submitting: a new photo and a second submission are refused', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const hold = latch();
      h.field.gate.read = () => hold.wait;
      const first = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
      expect(await f.sendPhoto(ESTIMATOR_A, jobId, randomUUID(), Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]))).toMatchObject({
        status: 409,
        body: { error: 'draft_locked' },
      });
      expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'submission_in_progress' } });
      hold.open();
      expect((await first).answer.status).toBe(201);
    });

    it('after submitted: a new photo and a second submission are refused, and the record is unchanged', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      const { body } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      const [record] = await f.submissions(jobId);
      expect(await f.sendPhoto(ESTIMATOR_A, jobId, randomUUID(), Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9]))).toMatchObject({
        status: 409,
        body: { error: 'draft_locked' },
      });
      expect((await f.submitShown(OWNER_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'already_submitted' } });
      expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(200);
      expect(await f.submissions(jobId)).toEqual([record]);
    });
  });

  it('a digest mismatch leaves no committed row and the draft editing', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    // The phone showed one note; another write landed before the fence.
    const shown = { ...manifest, draft: { ...(manifest.draft as object), notes: 'What the phone showed.' } };
    const { answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, shown);
    expect(answer).toMatchObject({ status: 409, body: { error: 'digest_mismatch' } });
    expect(await f.submissions(jobId)).toEqual([expect.objectContaining({ status: 'aborted', marker_state: 'done', snapshot: null })]);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    expect(await f.auditActions(jobId)).toContain('submission_aborted');
    // The phone reloads what is stored and submits again with a new id.
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
  });

  it('a draft that cannot be priced as it is, or a photo the job does not hold, is refused and released', async () => {
    const cases: [string, (manifest: { draft: unknown; rooms: { id: string; field: unknown }[]; photos: { id: string; field: unknown }[] }) => void][] = [
      ['draft_invalid', (m) => m.rooms.push({ id: 'attic', field: { category: 1 } })],
      ['draft_invalid', (m) => (m.draft = { roomOrder: ['kitchen'] })],
      ['photo_missing', (m) => m.photos.push({ id: randomUUID(), field: {} })],
      ['photo_missing', (m) => m.photos.push({ id: 'not-a-uuid', field: {} })],
    ];
    for (const [error, change] of cases) {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      change(manifest as never);
      h.field.put(h.seed.a, draftId, manifest);
      const { answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      expect({ error, answer }).toMatchObject({ error, answer: { status: 409, body: { error } } });
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    }
  });

  it('refuses another draft, a reused id with another body, and an aborted id', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const digest = await manifestDigest(manifest);
    expect(await f.submit(ESTIMATOR_A, jobId, { id: randomUUID(), draftId: randomUUID(), digest })).toMatchObject({
      status: 409,
      body: { error: 'not_current_draft' },
    });
    const failed = await f.submitShown(ESTIMATOR_A, jobId, draftId, { ...manifest, rooms: [] });
    expect(failed.answer.body.error).toBe('digest_mismatch');
    expect(await f.submit(ESTIMATOR_A, jobId, failed.body)).toMatchObject({ status: 409, body: { error: 'submission_aborted' } });
    expect(await f.submit(ESTIMATOR_A, jobId, { ...failed.body, digest })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    // The same id on another job of the company is another request.
    const other = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect(await f.submit(ESTIMATOR_A, other.jobId, { ...failed.body, draftId: other.draftId })).toMatchObject({ status: 409, body: { error: 'conflict' } });
    for (const bad of [{}, { id: 'x', draftId, digest }, { id: randomUUID(), draftId, digest: 'ABC' }, { id: randomUUID(), draftId, digest, extra: 1 }]) {
      expect(await f.submit(ESTIMATOR_A, jobId, bad)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
  });

  it('only the owner and the estimator whose job it is submit; another company never reaches the job', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const before = await everything(h.admin);
    const fieldBefore = JSON.stringify(h.field.data());
    expect((await f.submitShown(OFFICE_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect((await f.submitShown(ESTIMATOR_A2, jobId, draftId, manifest)).answer).toMatchObject({ status: 404, body: { error: 'not_found' } });
    for (const claims of [OWNER_B, ESTIMATOR_B]) {
      expect((await f.submitShown(claims, jobId, draftId, manifest)).answer).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect((await f.submitShown({ tenant: 'tenant-a', uid: 'nobody' }, jobId, draftId, manifest)).answer.status).toBe(403);
    expect((await f.submit(null, jobId, {})).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
    expect(JSON.stringify(h.field.data())).toBe(fieldBefore);
    // The owner may submit an estimator's job.
    expect((await f.submitShown(OWNER_A, jobId, draftId, manifest)).answer.status).toBe(201);
  });

  it('leaves the attempt pending when the field database cannot be reached, and the same request then records', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.failNext.fence = true;
    const { body, answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(answer).toMatchObject({ status: 503, body: { error: 'submissions_unavailable' } });
    expect(await f.submissions(jobId)).toEqual([expect.objectContaining({ status: 'pending' })]);
    expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(201);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('an attempt left pending past its expiry does not block the next one, whose fence replaces it', async () => {
    live.service = shortWindow();
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    // The first attempt closes its fence, then never returns (its process stalled).
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the first fence');
    const stale = h.field.draft(h.seed.a, draftId)!.fence!.epoch;
    expect((await f.submitShown(OWNER_A, jobId, draftId, manifest)).answer.body.error).toBe('submission_in_progress');
    await expire();
    const next = await f.submitShown(OWNER_A, jobId, draftId, manifest);
    expect(next.answer.status).toBe(201);
    const rows = await f.submissions(jobId);
    expect(rows.map((row) => row.status)).toEqual(['aborted', 'committed']);
    expect(rows[0]!.epoch).toBe(stale);
    // The stalled attempt's release, or the worker's, for the old epoch leaves the newer record alone.
    expect(await h.field.release(h.seed.a, draftId, stale)).toBe('not_fenced');
    // The worker finishes the replaced attempt's marker (its release finds no fence of its own).
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('never replaces a fence whose own attempt was recorded, only one whose attempt was aborted', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    // A recorded attempt still holds the draft's fence (its marker not yet written), while the job
    // row says draft: a state no route makes, so only the fence's own row can tell.
    const recorded = { id: randomUUID(), epoch: randomUUID() };
    await h.admin`
      INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
      VALUES (${recorded.id}, ${h.seed.a}, ${jobId}, ${draftId}, ${recorded.epoch}, 'original', ${'a'.repeat(64)}, now() + interval '1 minute', ${h.seed.estimatorA.actor})
    `;
    await h.admin`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${Buffer.from('{}')}, snapshot_sha256 = ${sha256(Buffer.from('{}'))} WHERE id = ${recorded.id}`;
    await h.field.fence(h.seed.a, draftId, { submissionId: recorded.id, epoch: recorded.epoch, expiresAt: new Date(Date.now() + 60_000) });
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'submission_in_progress' } });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'submitting', fence: { epoch: recorded.epoch } });
    expect((await f.submissions(jobId)).map((row) => row.status)).toEqual(['committed', 'aborted']);
  });

  it('a request too close to its expiry closes no fence and stops', async () => {
    live.service = submissionsService(h.handle.db, h.field, { windowMs: 60_000, now: () => new Date(Date.now() + 59_000) });
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'submission_aborted' } });
    expect(h.field.calls).not.toContain('fence');
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
  });
});

describe('the worker', () => {
  it('aborts an expired pending attempt and releases its fence, and a stale release leaves a newer fence closed', async () => {
    live.service = shortWindow();
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
    const stale = h.field.draft(h.seed.a, draftId)!.fence!.epoch;
    // Not yet expired: the worker leaves it alone.
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 0, failed: 0 });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    await expire();
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'aborted', marker_state: 'done' });
    const [audit] = await h.admin`SELECT actor_id, details FROM audit_events WHERE action = 'submission_aborted'`;
    expect(audit).toEqual({ actor_id: null, details: { reason: 'expired' } });

    // A newer attempt fences the draft; a late release for the old epoch leaves it closed.
    live.service = null;
    const hold = latch();
    h.field.gate.read = () => hold.wait;
    const newer = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the newer fence');
    expect(await h.field.release(h.seed.a, draftId, stale)).toBe('not_fenced');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    hold.open();
    expect((await newer).answer.status).toBe(201);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('aborts only the expired attempt when another of the same company is still within its window', async () => {
    const expiring = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const running = await f.readyJob(ESTIMATOR_A, h.seed.a);
    // Both attempts stall after their fence; the first has a short window, the second the usual one.
    live.service = shortWindow();
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, expiring.jobId, expiring.draftId, expiring.manifest);
    await until(() => h.field.draft(h.seed.a, expiring.draftId)?.state === 'submitting', 'the first fence');
    live.service = null;
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, running.jobId, running.draftId, running.manifest);
    await until(() => h.field.draft(h.seed.a, running.draftId)?.state === 'submitting', 'the second fence');
    await expire();
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, expiring.jobId, expiring.draftId)).toBe('aborted');
    expect((await f.submissions(running.jobId)).map((row) => row.status)).toEqual(['pending']);
    expect(h.field.draft(h.seed.a, running.draftId)?.state).toBe('submitting');
  });

  it('writes a submitted marker the request could not, after the grace', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.failNext.markSubmitted = true;
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'pending' });
    // Inside the grace the deciding request may still write it: the worker waits.
    expect(await runSubmissionRepair(h.handle.db, h.field)).toEqual({ aborted: 0, marked: 0, failed: 0 });
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'done' });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('writes a release the request could not after an abort, and leaves a marker it cannot write for the next run', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.failNext.release = true;
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, { ...manifest, photos: [] })).answer.body.error).toBe('digest_mismatch');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    h.field.failNext.release = true;
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 0, failed: 1 });
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'aborted', marker_state: 'pending' });
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    // Nothing left to do.
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 0, failed: 0 });
  });

  it('a retry of a decided submission writes its missing marker', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.failNext.markSubmitted = true;
    const { body } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    expect((await f.submissions(jobId))[0]!.marker_state).toBe('done');
  });
});
