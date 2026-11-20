import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalManifest, manifestDigest } from '@/lib/field/canonical';
import type { SubmissionsService, SubmitStore } from '@/lib/submissions/service';
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
const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
const { submissionsService } = await import('@/lib/submissions/service');
const { runSubmissionRepair } = await import('@/lib/submissions/repair');
const { syncJob } = await import('@/lib/jobs/sync-job');
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
// Runs `then` once the attempt reaches its read of the fenced draft: after its fence, before its
// decision, so only the marker's draft sync (after the decision) meets what `then` sets up.
const afterTheRead = (then: () => void) => {
  h.field.gate.read = async () => {
    then();
  };
};

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
      // The field owner's two phones (only the field owner submits, docs/spec.md 6.2).
      const answers = await Promise.all([f.submitShown(ESTIMATOR_A, jobId, draftId, manifest), f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)]);
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
      const second = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
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

    it('a same-id retry held before its fence while the other aborts and releases never leaves the draft fenced', async () => {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      // The phone's digest is not what the draft holds, so whichever attempt reads the draft aborts.
      const body = { id: randomUUID(), draftId, digest: await manifestDigest({ ...manifest, photos: [] }) };
      // The first attempt waits at its fence (the draft sync that writes it), then closes it and dies
      // before deciding.
      const hold = latch();
      let reached = false;
      const delayed: SubmitStore = {
        ...h.field,
        sync: async (...args) => {
          reached = true;
          await hold.wait;
          return h.field.sync(...args);
        },
        read: () => new Promise(() => {}),
      };
      live.service = submissionsService(h.handle.db, delayed);
      void f.submit(ESTIMATOR_A, jobId, body);
      await until(() => reached, 'the first attempt at its fence');
      live.service = null;
      const retry = f.submit(ESTIMATOR_A, jobId, body);
      await Promise.race([retry, new Promise((resolve) => setTimeout(resolve, 500))]);
      hold.open();
      expect(await retry).toMatchObject({ status: 409, body: { error: 'digest_mismatch' } });
      expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'aborted', marker_state: 'done' });
      expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
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
      // The draft is never opened again once recorded: no sync writes it back to editing after `submitted`.
      const states = h.field.stateWrites.filter((write) => write.at === `${h.seed.a}/${draftId}`).map((write) => write.state);
      expect(states.slice(states.indexOf('submitted'))).not.toContain('editing');
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
      expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'already_submitted' } });
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
      ['draft_invalid', (m) => (m.rooms = Array.from({ length: 31 }, (_, i) => ({ id: `room-${i}`, field: { name: 'Room' } })))],
      ['too_many_photos', (m) => (m.photos = Array.from({ length: 301 }, () => ({ id: randomUUID(), field: {} })))],
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

  it('only the estimator who owns the field work submits, not the owner who does not; another company never reaches the job', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const before = await everything(h.admin);
    const fieldBefore = JSON.stringify(h.field.data());
    expect((await f.submitShown(OFFICE_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    // The company owner submits only field work that is theirs (docs/spec.md 6.2; a move to themself, J5).
    expect((await f.submitShown(OWNER_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 403, body: { error: 'not_field_owner' } });
    expect((await f.submitShown(ESTIMATOR_A2, jobId, draftId, manifest)).answer).toMatchObject({ status: 404, body: { error: 'not_found' } });
    for (const claims of [OWNER_B, ESTIMATOR_B]) {
      expect((await f.submitShown(claims, jobId, draftId, manifest)).answer).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect((await f.submitShown({ tenant: 'tenant-a', uid: 'nobody' }, jobId, draftId, manifest)).answer.status).toBe(403);
    expect((await f.submit(null, jobId, {})).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
    expect(JSON.stringify(h.field.data())).toBe(fieldBefore);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
  });

  it('leaves the attempt pending when the field database cannot be reached, and the same request then records', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    // The fence's sync and its one more try both fail.
    h.field.failNext.sync = 2;
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
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.body.error).toBe('submission_in_progress');
    await expire();
    const next = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
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
    // No sync fenced the draft either.
    expect(h.field.stateWrites.filter((write) => write.at === `${h.seed.a}/${draftId}`).map((write) => write.state)).not.toContain('submitting');
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
    // The gate is one-shot: wait until the first attempt is stalled in it, so the second gate is the second attempt's.
    await until(() => h.field.gate.read === undefined, 'the first attempt stalled');
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

  // Security audit F5: the 10 s lock limit (db/client.ts) ends a wait for a row another transaction
  // holds; the pass leaves that row for the next one and repairs the rest.
  it('leaves an expired attempt whose row is locked past the lock limit for the next pass, and repairs the rest', async () => {
    const locked = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const free = await f.readyJob(ESTIMATOR_A, h.seed.a);
    live.service = shortWindow();
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, locked.jobId, locked.draftId, locked.manifest);
    await until(() => h.field.draft(h.seed.a, locked.draftId)?.state === 'submitting', 'the first fence');
    await until(() => h.field.gate.read === undefined, 'the first attempt stalled');
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, free.jobId, free.draftId, free.manifest);
    await until(() => h.field.draft(h.seed.a, free.draftId)?.state === 'submitting', 'the second fence');
    await expire();

    const release = latch();
    let held = false;
    const holder = h.admin.begin(async (sql) => {
      await sql`SELECT id FROM job_submissions WHERE job_id = ${locked.jobId} FOR UPDATE`;
      held = true;
      await release.wait;
    });
    try {
      await until(() => held, 'the row lock');
      expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 1, failed: 1 });
    } finally {
      release.open();
      await holder;
    }
    expect((await f.submissions(locked.jobId)).map((row) => row.status)).toEqual(['pending']);
    expect(h.field.draft(h.seed.a, locked.draftId)?.state).toBe('submitting');
    expect(await f.expectOneOutcome(h.seed.a, free.jobId, free.draftId)).toBe('aborted');
    expect(h.field.draft(h.seed.a, free.draftId)?.state).toBe('editing');
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, locked.jobId, locked.draftId)).toBe('aborted');
  });

  // The worker locks a job row before an expired attempt's submission row, in the order every request
  // takes them, so a request holding the job never waits on a submission row the worker holds while
  // the worker waits on the job (a deadlock once moving a submission's status also locks its job).
  it('waits for the job row before it aborts an expired attempt, in the order a request takes them', async () => {
    live.service = shortWindow();
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
    await expire();

    // The request holding the job, on a connection of its own (h.admin has one).
    const holder = postgres(h.server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    const release = latch();
    let pid: number | null = null;
    const request = holder.begin(async (sql) => {
      const [own] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await sql`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
      pid = own!.pid;
      await release.wait;
      // Still holding the job, the request takes the attempt's row as Submit would: the worker,
      // waiting for the job, holds none of it.
      return (await sql`SELECT id FROM job_submissions WHERE job_id = ${jobId} FOR UPDATE NOWAIT`).length;
    });
    let worker: ReturnType<typeof runSubmissionRepair> | undefined;
    // Both are settled below on every path; until then a rejection is held, not unhandled.
    request.catch(() => {});
    try {
      await until(() => pid !== null, 'the job lock');
      worker = runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 });
      worker.catch(() => {});
      // PostgreSQL shows the worker waiting on the request.
      await until(
        async () => (await h.admin<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0]!.n > 0,
        'the worker waiting for the job',
      );
      expect((await f.submissions(jobId)).map((row) => row.status)).toEqual(['pending']);
    } finally {
      release.open();
      await Promise.allSettled([request, worker]);
      await holder.end({ timeout: 5 });
    }
    expect(await request).toBe(1);
    expect(await worker).toEqual({ aborted: 1, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('editing');
  });

  it('writes a submitted marker the request could not, after the grace', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    afterTheRead(() => (h.field.failNext.sync = 2));
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'pending' });
    // Inside the grace the deciding request may still write it: the worker waits.
    expect(await runSubmissionRepair(h.handle.db, h.field)).toEqual({ aborted: 0, marked: 0, failed: 0 });
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'done' });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  // Security audit F5: a worker pass whose marker acknowledgement found no free database connection
  // ends there, so the scheduled caller sees 503, and the row waits for the next pass.
  it('ends the worker pass when the marker acknowledgement finds no free database connection', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    afterTheRead(() => (h.field.failNext.sync = 2));
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    const refused = Object.assign(new Error('QUEUE_TIMEOUT: Waited more than 10 seconds for a connection'), { code: 'QUEUE_TIMEOUT' });
    // Full for the acknowledgement only: after the marker's sync, its two short transactions (the
    // version read again, and the watermark) find a connection; the third, the acknowledgement, does not.
    let since = -1;
    const db = new Proxy(h.handle.db, {
      get: (target, key) => {
        if (key !== 'transaction' || since < 0) return Reflect.get(target, key);
        since += 1;
        if (since < 3) return Reflect.get(target, key);
        since = -1;
        return () => Promise.reject(refused);
      },
    });
    const store = new Proxy(h.field, {
      get: (target, key) =>
        key === 'sync'
          ? async (...args: Parameters<SubmitStore['sync']>) => {
              const synced = await target.sync(...args);
              since = 0;
              return synced;
            }
          : Reflect.get(target, key),
    });
    await expect(runSubmissionRepair(db, store, { markerGraceSeconds: 0 })).rejects.toMatchObject({ code: 'QUEUE_TIMEOUT' });
    // The drafts are synced and the version recorded; only the row's acknowledgement waits.
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitted');
    const [job] = await h.admin<{ behind: boolean }[]>`SELECT field_synced_revision < field_revision AS behind FROM jobs WHERE id = ${jobId}`;
    expect(job!.behind).toBe(false);
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'pending' });
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
  });

  // Security audit F5: a request whose marker found no free database connection answers 503, never
  // 201 with its marker unwritten; the record stands, and the same request again writes the marker.
  it('answers 503 when the marker finds no free database connection after the record, and the same request then answers it', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const refused = Object.assign(new Error('QUEUE_TIMEOUT: Waited more than 10 seconds for a connection'), { code: 'QUEUE_TIMEOUT' });
    // Full once, for the first transaction after the attempt's second sync (the marker's).
    let syncs = 0;
    let full = false;
    const db = new Proxy(h.handle.db, {
      get: (target, key) => {
        if (key !== 'transaction' || !full) return Reflect.get(target, key);
        full = false;
        return () => Promise.reject(refused);
      },
    });
    const store = new Proxy(h.field, {
      get: (target, key) =>
        key === 'sync'
          ? async (...args: Parameters<SubmitStore['sync']>) => {
              const synced = await target.sync(...args);
              syncs += 1;
              if (syncs === 2) full = true;
              return synced;
            }
          : Reflect.get(target, key),
    });
    live.service = submissionsService(db, store);
    const { body, answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(answer).toMatchObject({ status: 503, body: { error: 'submissions_unavailable' } });
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'committed', marker_state: 'pending' });
    live.service = null;
    expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('writes a release the request could not after an abort, and leaves a marker it cannot write for the next run', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    afterTheRead(() => (h.field.failNext.sync = 2));
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, { ...manifest, photos: [] })).answer.body.error).toBe('digest_mismatch');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    h.field.failNext.sync = 2;
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 0, failed: 1 });
    expect((await f.submissions(jobId))[0]).toMatchObject({ status: 'aborted', marker_state: 'pending' });
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 1, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('aborted');
    // Nothing left to do.
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 0, marked: 0, failed: 0 });
  });

  it('reopens a draft still fenced by an aborted attempt whose marker was written, in a company it visits', async () => {
    live.service = shortWindow();
    const stuck = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const body = { id: randomUUID(), draftId: stuck.draftId, digest: await manifestDigest({ ...stuck.manifest, photos: [] }) };
    expect((await f.submit(ESTIMATOR_A, stuck.jobId, body)).body.error).toBe('digest_mismatch');
    const [row] = await f.submissions(stuck.jobId);
    expect(row).toMatchObject({ status: 'aborted', marker_state: 'done' });
    // A fence for that epoch the release did not see (a state no route makes now).
    await h.field.fence(h.seed.a, stuck.draftId, { submissionId: row!.id, epoch: row!.epoch, expiresAt: new Date(Date.now() + 60_000) });
    // Other work in the same company, so the worker visits it.
    const stalled = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.gate.read = () => new Promise<void>(() => {});
    void f.submitShown(ESTIMATOR_A, stalled.jobId, stalled.draftId, stalled.manifest);
    await until(() => h.field.draft(h.seed.a, stalled.draftId)?.state === 'submitting', 'the stalled fence');
    await expire();
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 2, failed: 0 });
    expect(await f.expectOneOutcome(h.seed.a, stuck.jobId, stuck.draftId)).toBe('aborted');
    expect(await f.expectOneOutcome(h.seed.a, stalled.jobId, stalled.draftId)).toBe('aborted');
  });

  // r4 (b): an attempt's fence held at the field database (the draft sync, or the previous fence writer)
  // past its expiry; the worker aborts it and releases the draft, the owner archives the job, then the
  // held fence goes on. It is refused at the job's marker: the archived draft is never fenced.
  it('never fences a draft after its attempt was aborted and the job archived: the late fence is refused (r4 b)', async () => {
    live.service = shortWindow();
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const hold = latch();
    let reached = false;
    const held = async () => {
      delete h.field.gate.sync;
      delete h.field.gate.fence;
      reached = true;
      await hold.wait;
    };
    h.field.gate.sync = held;
    h.field.gate.fence = held;
    const attempt = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(() => reached, 'the held fence');
    await expire();
    expect(await runSubmissionRepair(h.handle.db, h.field, { markerGraceSeconds: 0 })).toEqual({ aborted: 1, marked: 1, failed: 0 });
    const { revision } = await f.job(jobId);
    const archived = await archiveRoute.POST(
      request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision, changeId: randomUUID() } }),
      params({ jobId }),
    );
    expect(archived.status).toBe(200);
    hold.open();
    // Its job is archived now: every job route answers 410.
    expect((await attempt).answer).toMatchObject({ status: 410, body: { error: 'archived' } });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'archived', fence: null });
    expect((await f.submissions(jobId)).map((row) => row.status)).toEqual(['aborted']);
  });

  // draft-sync-02: a sync that read the job while an attempt was pending, held at the field database
  // while a previous-version Submit (which moves no marker) decides that attempt, writes nothing when
  // it goes on, and the job is synced again as Postgres now says: never fenced again after the
  // release, never opened after the record.
  it('a sync that read a pending attempt writes nothing after a previous-version Submit decides it, in either order', async () => {
    for (const decision of ['aborted', 'committed'] as const) {
      const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
      // The attempt fenced the draft and stalls before its read.
      const stall = latch();
      h.field.gate.read = () => stall.wait;
      const attempt = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
      await until(() => h.field.draft(h.seed.a, draftId)?.state === 'submitting', 'the fence');
      const [row] = await f.submissions(jobId);
      // A later sync of the job reads it pending, and is held at the field database.
      const hold = latch();
      let reached = false;
      h.field.gate.sync = async () => {
        reached = true;
        await hold.wait;
      };
      // What the held sync's own transaction answers and leaves, before any catch-up runs.
      const sync = h.field.sync;
      let resumed: { outcome: string; draft: unknown; writes: number } | null = null;
      h.field.sync = async (...args) => {
        const result = await sync(...args);
        resumed ??= { outcome: result.outcome, draft: structuredClone(h.field.draft(h.seed.a, draftId)), writes: h.field.stateWrites.length };
        return result;
      };
      await h.admin`UPDATE jobs SET field_revision = field_revision + 1 WHERE id = ${jobId}`;
      const delayed = syncJob(h.handle.db, h.field, h.seed.a, jobId);
      await until(() => reached, 'the held sync');
      // The previous version decides the attempt and writes its own marker.
      if (decision === 'aborted') {
        await h.admin`UPDATE job_submissions SET status = 'aborted' WHERE id = ${row!.id}`;
        expect(await h.field.release(h.seed.a, draftId, row!.epoch)).toBe('released');
      } else {
        const bytes = Buffer.from('{}');
        await h.admin`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${bytes}, snapshot_sha256 = ${sha256(bytes)} WHERE id = ${row!.id}`;
        await h.admin`UPDATE jobs SET status = 'submitted', revision = revision + 1 WHERE id = ${jobId}`;
        expect(await h.field.markSubmitted(h.seed.a, draftId, row!.epoch, row!.id)).toBe('marked');
      }
      const decided = structuredClone(h.field.draft(h.seed.a, draftId));
      const writes = h.field.stateWrites.length;
      hold.open();
      await delayed;
      h.field.sync = sync;
      // The held sync wrote nothing: Postgres had moved on.
      expect(resumed).toEqual({ outcome: 'moved', draft: decided, writes });
      expect({ decision, draft: h.field.draft(h.seed.a, draftId) }).toMatchObject({
        decision,
        draft: decision === 'aborted' ? { state: 'editing', fence: null } : { state: 'submitted', fence: { epoch: row!.epoch } },
      });
      stall.open();
      await attempt;
    }
  });

  // The draft's parent lost with its rooms left under its id: the attempt is aborted (draft_missing), and
  // the decision's sync can write nothing there (rooms under a missing draft are a conflict). The row is
  // settled all the same, so Archive is not refused as if a Submit were still in flight.
  it('settles an attempt whose draft was lost with its rooms left, so the job can still be archived', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const { revision } = await f.job(jobId);
    h.field.remove(h.seed.a, draftId);
    expect(await h.field.restoreDraft(h.seed.a, jobId, draftId, 'editing', revision)).toBe('set');
    h.field.put(h.seed.a, draftId, manifest);
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ placeholder: true });
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'draft_missing' } });
    expect(await f.submissions(jobId)).toEqual([expect.objectContaining({ status: 'aborted', marker_state: 'done' })]);
    const archived = await archiveRoute.POST(
      request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: (await f.job(jobId)).revision, changeId: randomUUID() } }),
      params({ jobId }),
    );
    // Archived in Postgres; its own field step meets the same leftover rooms (409), never the Submit.
    expect({ status: archived.status, body: await archived.json() }).toEqual({ status: 409, body: { error: 'conflict' } });
    expect((await f.job(jobId)).status).toBe('archived');
  });

  // The draft gone between Submit's lookup and its fence: the fence's sync cannot make it (it never makes
  // a draft for a fence), so the answer is draft_missing, as when the lookup finds it gone, not 503.
  it('answers draft_missing when the draft goes between its lookup and its fence', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    h.field.gate.sync = async () => {
      h.field.remove(h.seed.a, draftId);
    };
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'draft_missing' } });
    expect((await f.submissions(jobId)).map((row) => row.status)).toEqual(['aborted']);
  });

  // The draft's parent gone between Submit's lookup and its fence, with its rooms left under the id (a
  // conflict for the sync): still draft_missing, as when the lookup finds it gone.
  it('answers draft_missing when the draft goes between its lookup and its fence and leaves its rooms', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const { revision } = await f.job(jobId);
    h.field.gate.sync = async () => {
      h.field.remove(h.seed.a, draftId);
      await h.field.restoreDraft(h.seed.a, jobId, draftId, 'editing', revision);
      h.field.put(h.seed.a, draftId, manifest);
    };
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'draft_missing' } });
    expect((await f.submissions(jobId)).map((row) => row.status)).toEqual(['aborted']);
  });

  // A copy whose draft is lost and whose source's signed record cannot be read: no draft can be made, so
  // the attempt is aborted (draft_missing) and settled, with nothing to release; Archive is not refused.
  it('settles an attempt whose lost draft cannot be made again, so the job can still be archived', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const source = await f.readyJob(ESTIMATOR_A, h.seed.a);
    await h.admin`UPDATE jobs SET copied_from_job_id = ${source.jobId} WHERE id = ${jobId}`;
    h.field.remove(h.seed.a, draftId);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer).toMatchObject({ status: 409, body: { error: 'draft_missing' } });
    expect(await f.submissions(jobId)).toEqual([expect.objectContaining({ status: 'aborted', marker_state: 'done' })]);
    const archived = await archiveRoute.POST(
      request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: (await f.job(jobId)).revision, changeId: randomUUID() } }),
      params({ jobId }),
    );
    // Archived in Postgres; its own field step still cannot make the draft (503), never the Submit.
    expect({ status: archived.status, body: await archived.json() }).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect((await f.job(jobId)).status).toBe('archived');
  });

  it('a retry of a decided submission writes its missing marker', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    afterTheRead(() => (h.field.failNext.sync = 2));
    const { body } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitting');
    expect((await f.submit(ESTIMATOR_A, jobId, body)).status).toBe(200);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
    expect((await f.submissions(jobId))[0]!.marker_state).toBe('done');
  });
});
