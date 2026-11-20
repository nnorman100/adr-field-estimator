import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import type { FieldManifest } from '@/lib/field/canonical';
import { newJob } from './job-harness';
import { standIn } from './readiness-fake';
import { agreementOf, insertAgreement, newSubmission, seedEstimate, seedPin, seedSignature, seedVersion } from './submission-harness';
import { flow, json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-10 slice 10B, the drying log: GET and POST /api/jobs/{jobId}/drying-readings and POST
// .../drying-readings/{readingId}/void through the real route files as the runtime role against
// Postgres, with the field drafts from the shared stand-in (tests/submissions/field-fake.ts, read
// through the readiness reader's stand-in; the real reader is checked against the emulator in
// tests/emu/readiness-reader.test.ts). It proves the server's air values, a reading resent after a lost
// answer stored once (spec.md 4.3), the 409s on a changed or moved id, voids and their receipts, the
// 400-reading limit, the rooms of a draft and of a signed record, who may read and add (office reads
// only, an estimator sees only their own or assigned jobs, another company nothing), 410 on an archived
// job, one audit row per change, and the drying log's setup reading for "Ready to review?".
const live = vi.hoisted(() => ({ harness: null as Harness | null, reader: null as null | ReturnType<typeof standIn> }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/drying/services', async () => {
  const { readingsService } = await import('@/lib/drying/readings');
  return { dryingServices: () => ({ readings: readingsService(live.harness!.handle.db, () => live.reader!) }) };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
const readingsRoute = await import('@/app/api/jobs/[jobId]/drying-readings/route');
const voidRoute = await import('@/app/api/jobs/[jobId]/drying-readings/[readingId]/void/route');
const { readinessService } = await import('@/lib/readiness/service');
const { dryingSetupReadings } = await import('@/lib/drying/setup');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let estimatorA2: string;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const DISABLED_A: FakeClaims = { tenant: 'tenant-a', uid: 'disabled-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

const f = flow(() => h, { createJob: jobsRoute.POST, putPhoto: photoRoute.PUT, submit: submissionsRoute.POST, nextDraft: draftsRoute.POST, request, params });

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.reader = standIn(h.field);
  const [actor] = await h.admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${h.seed.a}, 'tenant-a', 'estimator-a2', 'estimator-a2@example.test') RETURNING id
  `;
  await h.admin`INSERT INTO memberships (company_id, actor_id, role) VALUES (${h.seed.a}, ${actor!.id}, 'estimator')`;
  estimatorA2 = actor!.id;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = Record<string, any>;
type Reply = Answer & { body: Body };

const list = (claims: FakeClaims | null, jobId: string, query = ''): Promise<Reply> =>
  json(readingsRoute.GET(request(claims, `/api/jobs/${jobId}/drying-readings${query}`), params({ jobId })));
const add = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(readingsRoute.POST(request(claims, `/api/jobs/${jobId}/drying-readings`, { method: 'POST', body }), params({ jobId })));
const voidOf = (claims: FakeClaims | null, jobId: string, readingId: string, body: unknown): Promise<Reply> =>
  json(voidRoute.POST(request(claims, `/api/jobs/${jobId}/drying-readings/${readingId}/void`, { method: 'POST', body }), params({ jobId, readingId })));

const TAKEN = '2026-11-12T09:30:00-08:00';
const air = (extra: Body = {}): Body => ({ id: randomUUID(), kind: 'air', takenAt: TAKEN, temperatureF: 70, relativeHumidity: 50, ...extra });
const material = (extra: Body = {}): Body => ({ id: randomUUID(), kind: 'material', takenAt: TAKEN, roomId: 'kitchen', material: 'Drywall', moisture: 22, unit: '%MC', dryStandard: 12, ...extra });

const rows = (jobId: string) =>
  h.admin<{ id: string; voided: boolean; room_id: string | null; room_label: string | null }[]>`
    SELECT id::text, voided_at IS NOT NULL AS voided, room_id, room_label FROM drying_readings WHERE job_id = ${jobId} ORDER BY taken_at, id
  `;
const readingAudits = async (jobId: string) => (await f.auditActions(jobId)).filter((action) => action.startsWith('drying_'));

// A job of company A made by estimator A, being edited, its draft with two named rooms.
async function draftJob(): Promise<{ jobId: string; draftId: string }> {
  const { jobId, draftId } = await f.newJob(ESTIMATOR_A);
  h.field.put(h.seed.a, draftId, {
    draft: { roomOrder: ['kitchen', 'hall'], airMovers: 3 },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120 } },
      { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40 } },
    ],
  });
  return { jobId, draftId };
}

// A job submitted through the real routes (rooms Kitchen and Hall), then signed: the agreement and
// everything it names written as signing writes them.
async function signedJob(): Promise<{ jobId: string; draftId: string }> {
  const { jobId, draftId, manifest: ready } = await f.readyJob(ESTIMATOR_A, h.seed.a);
  const manifest: FieldManifest = { ...ready, draft: { ...(ready.draft as object), scopeConfirmed: true } };
  h.field.put(h.seed.a, draftId, manifest);
  expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
  const [submission] = await f.submissions(jobId);
  const actor = h.seed.ownerA.actor;
  const version = await seedVersion(h.admin, h.seed.a, actor);
  const pin = await seedPin(h.admin, { company: h.seed.a, job: jobId, version: version.id, actor });
  const estimate = await seedEstimate(h.admin, { company: h.seed.a, job: jobId, submission: submission!.id, pin, actor, hash: version.hash });
  const signature = await seedSignature(h.admin, h.seed.a, jobId, actor);
  const chain = { company: h.seed.a, actor, job: { ...newJob(h.seed.a, actor), id: jobId }, version, submission: { ...newSubmission(h.seed.a, jobId, actor), id: submission!.id }, pin, estimate, signature };
  await withCompany(h.handle.db, h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain)));
  await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
  return { jobId, draftId };
}

describe('adding a reading', () => {
  it('stores an air reading with the server’s air values, and lists it', async () => {
    const { jobId } = await draftJob();
    const reading = air({ note: 'Living room, by the window.' });
    const made = await add(OWNER_A, jobId, reading);
    expect(made.status).toBe(201);
    expect(made.body.reading).toMatchObject({
      id: reading.id,
      kind: 'air',
      roomId: null,
      roomLabel: null,
      takenAt: '2026-11-12T17:30:00.000000Z',
      reading: { zone: 'affected', temperatureF: 70, relativeHumidity: 50, note: 'Living room, by the window.' },
      air: { gpp: 54, dewPointF: 51, dewPointDepressionF: 19, vaporPressureInhg: 0.37, enthalpyBtuLb: 25.3 },
    });
    const [stored] = await h.admin<{ gpp: number; dew: number; vapor: string; enthalpy: string; by: string }[]>`
      SELECT gpp, dew_point_f AS dew, vapor_pressure_inhg::text AS vapor, enthalpy_btu_lb::text AS enthalpy, created_by_actor_id::text AS by FROM drying_readings WHERE id = ${reading.id}
    `;
    expect(stored).toEqual({ gpp: 54, dew: 51, vapor: '0.37', enthalpy: '25.3', by: h.seed.ownerA.actor });
    const page = await list(ESTIMATOR_A, jobId);
    expect(page).toEqual({ status: 200, body: { jobId, readings: [made.body.reading], next: null, canChange: true } });
    expect(await readingAudits(jobId)).toEqual(['drying_reading_added']);
  });

  it('stores a reading sent again after a lost answer once, and answers it with the stored reading', async () => {
    const { jobId } = await draftJob();
    const reading = air();
    const first = await add(ESTIMATOR_A, jobId, reading);
    expect(first.status).toBe(201);
    // The phone never saw the answer and sends the same request again.
    expect(await add(ESTIMATOR_A, jobId, reading)).toEqual({ status: 200, body: first.body });
    // Sent twice at once, a new reading is stored once too.
    const twin = air();
    const answers = await Promise.all([add(ESTIMATOR_A, jobId, twin), add(ESTIMATOR_A, jobId, twin)]);
    expect(answers.map((one) => one.status).sort()).toEqual([200, 201]);
    expect(answers[0]!.body).toEqual(answers[1]!.body);
    expect((await rows(jobId)).map((row) => row.id).sort()).toEqual([reading.id, twin.id].sort());
    expect(await readingAudits(jobId)).toEqual(['drying_reading_added', 'drying_reading_added']);
  });

  it('refuses the same id with another body, or on another job (409), and changes nothing', async () => {
    const { jobId } = await draftJob();
    const { jobId: other } = await draftJob();
    const reading = air();
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
    expect(await add(OWNER_A, jobId, { ...reading, relativeHumidity: 51 })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await add(OWNER_A, other, reading)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect((await rows(jobId)).length).toBe(1);
    expect(await rows(other)).toEqual([]);
    expect(await readingAudits(jobId)).toEqual(['drying_reading_added']);
  });

  it('refuses a supplied air value, a stray key, outside air in a room and a bad time (400)', async () => {
    const { jobId } = await draftJob();
    for (const body of [air({ gpp: 54 }), air({ dewPointF: 51 }), air({ companyId: h.seed.b }), air({ zone: 'outside', roomId: 'kitchen' }), air({ takenAt: '2026-02-30T09:30:00Z' }), air({ relativeHumidity: 0 }), { kind: 'air' }, 'not json']) {
      expect(await add(OWNER_A, jobId, body)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await rows(jobId)).toEqual([]);
  });

  it('stores material and thermal readings with no air values', async () => {
    const { jobId } = await draftJob();
    const made = await add(OWNER_A, jobId, material({ affected: false }));
    expect(made.status).toBe(201);
    expect(made.body.reading).toMatchObject({ kind: 'material', roomId: 'kitchen', roomLabel: 'Kitchen', air: null, reading: { material: 'Drywall', moisture: 22, unit: '%MC', dryStandard: 12, affected: false, note: '' } });
    const thermal = await add(OWNER_A, jobId, { id: randomUUID(), kind: 'thermal', takenAt: TAKEN, deltaTF: -7.5, pattern: 'evaporative_cooling', boundary: 'North wall, 2 ft up.' });
    expect(thermal.status).toBe(201);
    expect(thermal.body.reading).toMatchObject({ kind: 'thermal', roomId: null, air: null, reading: { deltaTF: -7.5, pattern: 'evaporative_cooling', boundary: 'North wall, 2 ft up.' } });
  });
});

describe('a reading’s room', () => {
  it('comes from the draft being edited, by its id, and keeps the name it had', async () => {
    const { jobId, draftId } = await draftJob();
    const first = await add(ESTIMATOR_A, jobId, material());
    expect(first.body.reading).toMatchObject({ roomId: 'kitchen', roomLabel: 'Kitchen' });
    expect(live.reader!.reads).toBe(1);
    // A whole-job reading reads no draft.
    expect((await add(ESTIMATOR_A, jobId, air())).status).toBe(201);
    expect(live.reader!.reads).toBe(1);
    // Renamed later: the new reading has the new name, the earlier one keeps its own.
    h.field.put(h.seed.a, draftId, { draft: { roomOrder: ['kitchen'] }, rooms: [{ id: 'kitchen', field: { name: 'Kitchen (north)', category: 2 } }] });
    expect((await add(ESTIMATOR_A, jobId, material())).body.reading.roomLabel).toBe('Kitchen (north)');
    expect((await rows(jobId)).filter((row) => row.room_id).map((row) => row.room_label).sort()).toEqual(['Kitchen', 'Kitchen (north)']);
    // A room the draft no longer has, or never had, is refused.
    for (const roomId of ['hall', 'attic']) expect(await add(ESTIMATOR_A, jobId, material({ roomId }))).toEqual({ status: 409, body: { error: 'unknown_room' } });
  });

  it('never takes a room of another job’s draft, and answers 503 while the field database is down', async () => {
    const { jobId } = await draftJob();
    const { jobId: otherJob, draftId: otherDraft } = await draftJob();
    h.field.put(h.seed.a, otherDraft, { draft: { roomOrder: ['attic'] }, rooms: [{ id: 'attic', field: { name: 'Attic' } }] });
    expect(await add(OWNER_A, jobId, material({ roomId: 'attic' }))).toEqual({ status: 409, body: { error: 'unknown_room' } });
    expect((await add(OWNER_A, otherJob, material({ roomId: 'attic' }))).status).toBe(201);
    live.reader!.fail = true;
    const reading = material();
    expect(await add(OWNER_A, jobId, reading)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
  });

  it('comes from the signed record on a signed job, whoever owns the field work, and changes nothing signed', async () => {
    const { jobId, draftId } = await signedJob();
    const before = await h.admin`SELECT j.revision, j.field_revision, a.documents_bytes, a.proposal_sha256, a.content_hash FROM jobs j JOIN agreements a ON a.job_id = j.id WHERE j.id = ${jobId}`;
    // The field draft no longer matters: the snapshot's rooms are the job's.
    h.field.put(h.seed.a, draftId, { draft: { roomOrder: ['attic'] }, rooms: [{ id: 'attic', field: { name: 'Attic' } }] });
    const made = await add(OWNER_A, jobId, material());
    expect(made.status).toBe(201);
    expect(made.body.reading).toMatchObject({ roomId: 'kitchen', roomLabel: 'Kitchen' });
    expect(await add(OWNER_A, jobId, material({ roomId: 'attic' }))).toEqual({ status: 409, body: { error: 'unknown_room' } });
    expect(live.reader!.reads).toBe(0);
    // An assigned estimator who does not own the field work adds readings after signing too.
    const assigned = await assignmentsRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id: randomUUID(), estimatorActorId: estimatorA2 } }), params({ jobId }));
    expect(assigned.status).toBe(201);
    expect((await add(ESTIMATOR_A2, jobId, air())).status).toBe(201);
    const voided = await voidOf(ESTIMATOR_A2, jobId, made.body.reading.id, { changeId: randomUUID() });
    expect(voided.status).toBe(200);
    expect(await h.admin`SELECT j.revision, j.field_revision, a.documents_bytes, a.proposal_sha256, a.content_hash FROM jobs j JOIN agreements a ON a.job_id = j.id WHERE j.id = ${jobId}`).toEqual(before);
  });
});

describe('voiding a reading', () => {
  it('voids once, answers the same void again with its receipt, and never lets another void replace it', async () => {
    const { jobId } = await draftJob();
    const reading = air();
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
    const change = { changeId: randomUUID() };
    const done = await voidOf(ESTIMATOR_A, jobId, reading.id, change);
    expect(done.status).toBe(200);
    expect(done.body.void).toMatchObject({ id: reading.id, voided: true, changeId: change.changeId });
    expect(await voidOf(ESTIMATOR_A, jobId, reading.id, change)).toEqual(done);
    expect(await voidOf(OWNER_A, jobId, reading.id, { changeId: randomUUID() })).toEqual({ status: 409, body: { error: 'already_voided' } });
    const [row] = await h.admin<{ by: string }[]>`SELECT voided_by_actor_id::text AS by FROM drying_readings WHERE id = ${reading.id}`;
    expect(row!.by).toBe(h.seed.estimatorA.actor);
    // The log lists active readings only.
    expect((await list(OWNER_A, jobId)).body.readings).toEqual([]);
    // Resending the reading itself still answers its stored reading.
    expect((await add(OWNER_A, jobId, reading)).status).toBe(200);
    expect(await readingAudits(jobId)).toEqual(['drying_reading_added', 'drying_reading_voided']);
  });

  it('refuses a void id used for another reading, and a reading of another job or none (404)', async () => {
    const { jobId } = await draftJob();
    const { jobId: other } = await draftJob();
    const one = air();
    const two = air();
    const elsewhere = air();
    for (const [job, reading] of [[jobId, one], [jobId, two], [other, elsewhere]] as const) expect((await add(OWNER_A, job, reading)).status).toBe(201);
    const change = { changeId: randomUUID() };
    expect((await voidOf(OWNER_A, jobId, one.id, change)).status).toBe(200);
    expect(await voidOf(OWNER_A, jobId, two.id, change)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await voidOf(OWNER_A, jobId, elsewhere.id, { changeId: randomUUID() })).toEqual({ status: 404, body: { error: 'reading_not_found' } });
    expect(await voidOf(OWNER_A, jobId, randomUUID(), { changeId: randomUUID() })).toEqual({ status: 404, body: { error: 'reading_not_found' } });
    expect(await voidOf(OWNER_A, jobId, 'not-a-uuid', { changeId: randomUUID() })).toEqual({ status: 404, body: { error: 'reading_not_found' } });
    expect(await voidOf(OWNER_A, jobId, two.id, { changeId: 'x' })).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect((await rows(jobId)).map((row) => row.voided).sort()).toEqual([false, true]);
    expect((await rows(other)).map((row) => row.voided)).toEqual([false]);
  });
});

describe('the 400-reading limit', () => {
  it('keeps at most 400 active readings on a job, and a void frees a place', async () => {
    const { jobId } = await draftJob();
    const kept = air();
    expect((await add(OWNER_A, jobId, kept)).status).toBe(201);
    await h.admin`
      INSERT INTO drying_readings (id, company_id, job_id, kind, taken_at, payload, request_digest, created_by_actor_id)
      SELECT gen_random_uuid(), ${h.seed.a}, ${jobId}, 'thermal', now(), '{"delta_t_f": 1, "pattern": "cold_anomaly", "boundary": "", "note": ""}'::jsonb, repeat('a', 64), ${h.seed.ownerA.actor}
      FROM generate_series(1, 399)
    `;
    const extra = air();
    expect(await add(OWNER_A, jobId, extra)).toEqual({ status: 409, body: { error: 'reading_limit' } });
    // A reading already stored is still answered: the replay comes before the limit.
    expect((await add(OWNER_A, jobId, kept)).status).toBe(200);
    expect((await voidOf(OWNER_A, jobId, kept.id, { changeId: randomUUID() })).status).toBe(200);
    expect((await add(OWNER_A, jobId, extra)).status).toBe(201);
    expect(await add(OWNER_A, jobId, air())).toEqual({ status: 409, body: { error: 'reading_limit' } });
  });
});

describe('reading the log', () => {
  it('pages the active readings in the order they were taken, with an opaque cursor', async () => {
    const { jobId } = await draftJob();
    const times = ['2026-11-10T08:00:00Z', '2026-11-09T08:00:00Z', '2026-11-11T08:00:00.123456Z', '2026-11-10T08:00:00Z'];
    const made: Body[] = [];
    for (const takenAt of times) made.push((await add(OWNER_A, jobId, air({ takenAt }))).body.reading);
    const order = [...made].sort((a, b) => (a.takenAt === b.takenAt ? (a.id < b.id ? -1 : 1) : a.takenAt < b.takenAt ? -1 : 1)).map((one) => one.id);
    const first = await list(OFFICE_A, jobId, '?limit=3');
    expect(first.body.readings.map((one: Body) => one.id)).toEqual(order.slice(0, 3));
    expect(first.body.canChange).toBe(false);
    const second = await list(OFFICE_A, jobId, `?limit=3&cursor=${first.body.next}`);
    expect(second.body).toMatchObject({ next: null });
    expect(second.body.readings.map((one: Body) => one.id)).toEqual(order.slice(3));
    expect(made.find((one) => one.takenAt.startsWith('2026-11-11'))!.takenAt).toBe('2026-11-11T08:00:00.123456Z');
    for (const query of ['?limit=0', '?limit=201', '?cursor=bm90IGEgY3Vyc29y', '?other=1']) expect(await list(OWNER_A, jobId, query)).toEqual({ status: 400, body: { error: 'invalid_request' } });
  });
});

describe('who may read and change the log', () => {
  it('lets office read only, and refuses office’s add and void (403) whatever the body', async () => {
    const { jobId } = await draftJob();
    const reading = air();
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
    expect((await list(OFFICE_A, jobId)).body.readings.length).toBe(1);
    for (const body of [air(), { nonsense: true }]) expect(await add(OFFICE_A, jobId, body)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await voidOf(OFFICE_A, jobId, reading.id, { changeId: randomUUID() })).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect((await rows(jobId)).map((row) => row.voided)).toEqual([false]);
  });

  it('shows an estimator only their own or assigned jobs, and another company nothing (404)', async () => {
    const { jobId } = await draftJob();
    const reading = air();
    expect((await add(ESTIMATOR_A, jobId, reading)).status).toBe(201);
    for (const other of [ESTIMATOR_A2, OWNER_B, ESTIMATOR_B]) {
      expect(await list(other, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await add(other, jobId, air())).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await voidOf(other, jobId, reading.id, { changeId: randomUUID() })).toEqual({ status: 404, body: { error: 'not_found' } });
    }
    expect((await list(DISABLED_A, jobId)).status).toBe(403);
    expect((await list(null, jobId)).status).toBe(401);
    expect(await list(OWNER_A, 'not-a-job')).toEqual({ status: 404, body: { error: 'not_found' } });
    // Company B's own job: its owner reads and adds there, and sees nothing of company A.
    const { jobId: ownB } = await f.newJob(ESTIMATOR_B);
    expect((await add(OWNER_B, ownB, air())).status).toBe(201);
    expect((await list(ESTIMATOR_B, ownB)).body.readings.length).toBe(1);
    expect((await rows(jobId)).length).toBe(1);
    // Assigned, the other estimator of company A reads and adds.
    const assigned = await assignmentsRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id: randomUUID(), estimatorActorId: estimatorA2 } }), params({ jobId }));
    expect(assigned.status).toBe(201);
    expect((await list(ESTIMATOR_A2, jobId)).body).toMatchObject({ canChange: true });
    expect((await add(ESTIMATOR_A2, jobId, air())).status).toBe(201);
  });

  it('answers 410 for an archived job, on every drying log route', async () => {
    const { jobId } = await draftJob();
    const reading = air();
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
    const archived = await archiveRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: 1, changeId: randomUUID() } }), params({ jobId }));
    expect(archived.status).toBe(200);
    for (const claims of [OWNER_A, ESTIMATOR_A, OFFICE_A]) {
      expect(await list(claims, jobId)).toEqual({ status: 410, body: { error: 'archived' } });
      expect(await add(claims, jobId, air())).toEqual({ status: 410, body: { error: 'archived' } });
      expect(await voidOf(claims, jobId, reading.id, { changeId: randomUUID() })).toEqual({ status: 410, body: { error: 'archived' } });
    }
  });
});

describe('the setup reading for Ready to review?', () => {
  const setup = (jobId: string) => withCompany(h.handle.db, h.seed.a, (tx) => dryingSetupReadings.setupReading(tx, h.seed.a, jobId), { snapshot: true });

  it('is an active affected air or affected material reading taken by now', async () => {
    const { jobId } = await draftJob();
    expect(await setup(jobId)).toBe('absent');
    // Neither outside air, unaffected material, thermal, nor a reading in the future is one.
    for (const body of [air({ zone: 'outside' }), material({ affected: false }), { id: randomUUID(), kind: 'thermal', takenAt: TAKEN, deltaTF: 3 }, air({ takenAt: '2099-01-01T00:00:00Z' })]) {
      expect((await add(OWNER_A, jobId, body)).status).toBe(201);
    }
    expect(await setup(jobId)).toBe('absent');
    const reading = material();
    expect((await add(OWNER_A, jobId, reading)).status).toBe(201);
    expect(await setup(jobId)).toBe('present');
    // A voided one is not.
    expect((await voidOf(OWNER_A, jobId, reading.id, { changeId: randomUUID() })).status).toBe(200);
    expect(await setup(jobId)).toBe('absent');
    expect((await add(OWNER_A, jobId, air())).status).toBe(201);
    expect(await setup(jobId)).toBe('present');
  });

  it('is what the readiness check reads, so a missing setup reading is a gap and a saved one is not', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'readiness', true)`;
    const { jobId } = await draftJob();
    const check = readinessService(h.handle.db, () => live.reader!, dryingSetupReadings);
    const caller = { companyId: h.seed.a, actorId: h.seed.ownerA.actor, uid: 'owner-a', role: 'owner' as const, capabilities: ['scope' as const] };
    const before = await check.read(caller, jobId);
    expect(before).toMatchObject({ status: 'checked' });
    if (before.status !== 'checked') return;
    expect(before.gaps.map((gap) => gap.code)).toContain('setupReadings');
    expect(before.unavailable).not.toContain('setupReadings');
    expect((await add(OWNER_A, jobId, air())).status).toBe(201);
    const after = await check.read(caller, jobId);
    if (after.status !== 'checked') throw new Error('expected a checked answer');
    expect(after.gaps.map((gap) => gap.code)).not.toContain('setupReadings');
    expect(after.unavailable).not.toContain('setupReadings');
  });
});
