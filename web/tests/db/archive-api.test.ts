import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import type { FieldManifest } from '@/lib/field/canonical';
import type { Snapshot } from '@/lib/submissions/snapshot';
import { APP_DIR, MATRIX, routeModules, type RouteModule } from './isolation-matrix';
import { newJob } from './job-harness';
import { agreementOf, insertAgreement, newSubmission, seedEstimate, seedPin, seedSignature, seedSubmission, seedVersion } from './submission-harness';
import { flow, json } from './submission-flow';
import type { FakeField } from '../submissions/field-fake';
import type { FakeClaims, Harness } from './team-harness';

// S5b-2, archive, restore and copy, through the real route files as the runtime role against a real
// Postgres: archive hides an unsigned draft and every job route answers it with 410; restore returns
// it as it was; a signed job has no archive; a copy of a signed job sent twice makes one draft. The
// field drafts are the in-memory stand-in (tests/submissions/field-fake.ts); tests/emu/archive.test.ts
// checks the real writer and the field rules on an archived draft.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/prices/services', () => ({ pricesServices: () => live.harness!.prices }));
vi.mock('@/lib/estimates/services', async () => {
  const { estimatesService } = await import('@/lib/estimates/service');
  return { estimatesServices: () => estimatesService(live.harness!.handle.db) };
});
vi.mock('@/lib/agreements/services', async () => {
  const { agreementsService } = await import('@/lib/agreements/service');
  return { agreementsServices: () => agreementsService(live.harness!.handle.db) };
});
vi.mock('@/lib/links/services', async () => {
  const { signingLinksService } = await import('@/lib/links/signing');
  const { documentLinksService } = await import('@/lib/links/documents');
  return {
    signingLinksServices: () => signingLinksService(live.harness!.handle.db, live.harness!.photos),
    documentLinksServices: () => documentLinksService(live.harness!.handle.db, live.harness!.photos),
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const jobRoute = await import('@/app/api/jobs/[jobId]/route');
const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
const restoreRoute = await import('@/app/api/jobs/[jobId]/restore/route');
const copyRoute = await import('@/app/api/jobs/[jobId]/copy/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  // The estimate, signing and link routes are behind price books and the readiness route behind its
  // own switch; every job route must answer. Priced extras too (S5b-8), so the proposal and approval
  // routes are reached and answer 410, not the switch's 404, and the drying watch (S5b-10).
  await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true), (${h.seed.a}, 'priced_extras', true), (${h.seed.a}, 'readiness', true), (${h.seed.a}, 'drying_watch', true)`;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const f = flow(() => h, {
  createJob: jobsRoute.POST,
  putPhoto: photoRoute.PUT,
  submit: submissionsRoute.POST,
  nextDraft: draftsRoute.POST,
  request,
  params,
});

const job = (jobId: string) => params({ jobId });
const send = (route: { POST: (r: Request, c: ReturnType<typeof job>) => Response | Promise<Response> }, name: string) => (claims: FakeClaims, jobId: string, body: unknown) =>
  json(route.POST(request(claims, `/api/jobs/${jobId}/${name}`, { method: 'POST', body }), job(jobId)));
const archive = send(archiveRoute, 'archive');
const restore = send(restoreRoute, 'restore');
const copy = send(copyRoute, 'copy');
const read = (claims: FakeClaims, jobId: string) => json(jobRoute.GET(request(claims, `/api/jobs/${jobId}`), job(jobId)));
const list = async (claims: FakeClaims, query = '') => json(jobsRoute.GET(request(claims, `/api/jobs${query}`), params({})));
const listed = async (claims: FakeClaims, query = '') => ((await list(claims, query)).body.jobs as { id: string; status: string }[]).map((row) => row.id);
const change = (revision: number) => ({ revision, changeId: randomUUID() });
const auditOf = (jobId: string) => f.auditActions(jobId);

// A job an estimator started and filled in, still a draft.
async function draftJob(): Promise<{ jobId: string; draftId: string }> {
  const { jobId, draftId } = await f.newJob(ESTIMATOR_A);
  h.field.put(h.seed.a, draftId, { draft: { notes: 'Wet carpet by the sink.' } });
  return { jobId, draftId };
}

// A job submitted through the real routes, with two rooms, a photo and the scope confirmed, then
// signed: the agreement and everything it names are written as signing writes them.
async function signedJob(): Promise<{ jobId: string; draftId: string; manifest: FieldManifest; address: string }> {
  const { jobId, draftId, manifest: ready } = await f.readyJob(ESTIMATOR_A, h.seed.a);
  const manifest: FieldManifest = { ...ready, draft: { ...(ready.draft as object), scopeConfirmed: true } };
  h.field.put(h.seed.a, draftId, manifest);
  const { answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
  expect(answer.status).toBe(201);
  const [submission] = await f.submissions(jobId);
  const actor = h.seed.ownerA.actor;
  const version = await seedVersion(h.admin, h.seed.a, actor);
  const pin = await seedPin(h.admin, { company: h.seed.a, job: jobId, version: version.id, actor });
  const estimate = await seedEstimate(h.admin, { company: h.seed.a, job: jobId, submission: submission!.id, pin, actor, hash: version.hash });
  const signature = await seedSignature(h.admin, h.seed.a, jobId, actor);
  const chain = { company: h.seed.a, actor, job: { ...newJob(h.seed.a, actor), id: jobId }, version, submission: { ...newSubmission(h.seed.a, jobId, actor), id: submission!.id }, pin, estimate, signature };
  await withCompany(h.handle.db, h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain)));
  await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
  const stored = JSON.parse(submission!.snapshot!.toString('utf8')) as Snapshot;
  return { jobId, draftId, manifest, address: stored.job.propertyAddress };
}

describe('archive', () => {
  it('hides the job, and every job route answers 410 for it', async () => {
    const { jobId, draftId } = await draftJob();
    const done = await archive(OWNER_A, jobId, change(1));
    expect(done).toMatchObject({ status: 200, body: { job: { id: jobId, status: 'archived', revision: 2 } } });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'archived', archiveRevision: 2, field: { notes: 'Wet carpet by the sink.' } });
    const [row] = await h.admin<{ archived_at: Date | null; archived_by: string | null }[]>`
      SELECT archived_at, archived_by_actor_id::text AS archived_by FROM jobs WHERE id = ${jobId}
    `;
    expect(row!.archived_at).not.toBeNull();
    expect(row!.archived_by).toBe(h.seed.ownerA.actor);
    expect(await auditOf(jobId)).toEqual(['job_created', 'job_archived']);

    // Left out of every list but the owner's archived drafts.
    expect(await listed(OWNER_A)).not.toContain(jobId);
    expect(await listed(ESTIMATOR_A)).not.toContain(jobId);
    expect(await listed(OFFICE_A)).not.toContain(jobId);
    expect(await listed(OWNER_A, '?scope=archived')).toEqual([jobId]);

    // Every handler of every route file under api/jobs/[jobId] (found on disk, not listed here),
    // with a body and query it accepts, as the owner, who holds every key, so no role refusal comes
    // first. Restore is the one way back. The estimator who made the job is answered the same.
    expect(await read(ESTIMATOR_A, jobId)).toEqual({ status: 410, body: { error: 'archived' } });
    const modules = await routeModules(join(APP_DIR, 'api/jobs/[jobId]'));
    const ids = { jobId, photoId: randomUUID(), assignmentId: randomUUID(), linkId: randomUUID(), approvalId: randomUUID() };
    const called: string[] = [];
    for (const [folder, module] of modules) {
      const route = folder === '' ? 'api/jobs/[jobId]' : `api/jobs/[jobId]/${folder}`;
      if (route === 'api/jobs/[jobId]/restore') continue;
      for (const entry of MATRIX.filter((one) => one.route === route)) {
        const handler = (module as RouteModule)[entry.method] as (r: Request, c: unknown) => Promise<Response>;
        const path = `/${route}`.replace(/\[([A-Za-z]+)\]/g, (_m, name: string) => ids[name as keyof typeof ids]);
        const answer = await handler(request(OWNER_A, `${path}${entry.query ?? ''}`, { method: entry.method, body: entry.body }), params(ids));
        expect({ call: `${entry.method} ${route}`, status: answer.status }).toEqual({ call: `${entry.method} ${route}`, status: 410 });
        called.push(`${entry.method} ${route}`);
      }
    }
    expect(called).toContain('POST api/jobs/[jobId]/archive');
    expect(called).toContain('POST api/jobs/[jobId]/copy');
    expect(called.length).toBeGreaterThanOrEqual(25);
  });

  it('refuses a signed job: it has no archive', async () => {
    const { jobId } = await signedJob();
    const before = await everything(h.admin);
    const revision = (await f.job(jobId)).revision;
    expect(await archive(OWNER_A, jobId, change(revision))).toEqual({ status: 409, body: { error: 'job_signed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('is the owner’s alone, with the revision the screen saw, and the same change again is one archive', async () => {
    const { jobId } = await draftJob();
    for (const who of [ESTIMATOR_A, OFFICE_A]) {
      expect(await archive(who, jobId, change(1))).toEqual({ status: 403, body: { error: 'not_allowed' } });
      expect(await list(who, '?scope=archived')).toEqual({ status: 403, body: { error: 'not_allowed' } });
    }
    expect(await archive(OWNER_A, jobId, change(5))).toEqual({ status: 409, body: { error: 'stale_revision', revision: 1 } });
    const once = change(1);
    const first = await archive(OWNER_A, jobId, once);
    expect(first.status).toBe(200);
    expect(await archive(OWNER_A, jobId, once)).toEqual(first);
    expect(await archive(OWNER_A, jobId, change(2))).toEqual({ status: 410, body: { error: 'archived' } });
    expect(await auditOf(jobId)).toEqual(['job_created', 'job_archived']);
  });

  it('waits for a Submit that is still deciding', async () => {
    const { jobId, draftId } = await draftJob();
    await seedSubmission(h.admin, newSubmission(h.seed.a, jobId, h.seed.estimatorA.actor, { draft: draftId }));
    expect(await archive(OWNER_A, jobId, change(1))).toEqual({ status: 409, body: { error: 'submission_in_progress' } });
    expect((await f.job(jobId)).status).toBe('draft');
  });

  it('answers 503 when the field draft is not reached, and the same request again archives it', async () => {
    const { jobId, draftId } = await draftJob();
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    const once = change(1);
    expect(await archive(OWNER_A, jobId, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('editing');
    expect((await archive(OWNER_A, jobId, once)).status).toBe(200);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('archived');
    expect(await auditOf(jobId)).toEqual(['job_created', 'job_archived']);
  });
});

describe('restore', () => {
  it('returns an archived draft as it was', async () => {
    const { jobId, draftId } = await draftJob();
    await archive(OWNER_A, jobId, change(1));
    expect(await restore(ESTIMATOR_A, jobId, change(2))).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await restore(OWNER_A, jobId, change(1))).toEqual({ status: 409, body: { error: 'stale_revision', revision: 2 } });
    const once = change(2);
    const done = await restore(OWNER_A, jobId, once);
    expect(done).toMatchObject({ status: 200, body: { job: { id: jobId, status: 'draft', revision: 3 } } });
    expect(await restore(OWNER_A, jobId, once)).toEqual(done);
    expect(await restore(OWNER_A, jobId, change(3))).toEqual({ status: 409, body: { error: 'not_archived' } });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'editing', archiveRevision: 3, field: { notes: 'Wet carpet by the sink.' } });
    expect((await read(ESTIMATOR_A, jobId)).status).toBe(200);
    expect(await listed(ESTIMATOR_A)).toContain(jobId);
    expect(await listed(OWNER_A, '?scope=archived')).toEqual([]);
    const [row] = await h.admin<{ archived_at: Date | null }[]>`SELECT archived_at FROM jobs WHERE id = ${jobId}`;
    expect(row!.archived_at).toBeNull();
    expect(await auditOf(jobId)).toEqual(['job_created', 'job_archived', 'job_restored']);
  });

  it('returns a submitted job submitted, its draft still closed to the phone', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    const revision = (await f.job(jobId)).revision;
    expect((await archive(OWNER_A, jobId, change(revision))).status).toBe(200);
    expect((await restore(OWNER_A, jobId, change(revision + 1))).body).toMatchObject({ job: { status: 'submitted', revision: revision + 2 } });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitted');
  });
});

describe('copy', () => {
  it('copied twice with the same ids makes one draft, from the signed record, with its approval cleared', async () => {
    const { jobId: source, manifest, address } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    const first = await copy(ESTIMATOR_A, source, ids);
    expect(first).toMatchObject({
      status: 201,
      body: { job: { id: ids.id, status: 'draft', currentDraftId: ids.draftId, revision: 1, fieldOwnerActorId: h.seed.estimatorA.actor, propertyAddress: address } },
    });
    const again = await copy(ESTIMATOR_A, source, ids);
    expect(again).toEqual({ ...first, status: 200 });
    expect(await h.admin`SELECT 1 FROM jobs WHERE id = ${ids.id}`).toHaveLength(1);
    // The copy names its source in Postgres (0018), so its first draft can be rebuilt from the signed record.
    expect(await h.admin`SELECT copied_from_job_id::text AS source FROM jobs WHERE id = ${ids.id}`).toEqual([{ source }]);
    expect(h.field.calls.filter((call) => call === 'createCopy')).toHaveLength(2);
    // The rooms and the scope, less the approval; no photo (it stays the signed job's evidence).
    const { scopeConfirmed, ...kept } = manifest.draft as Record<string, unknown>;
    expect(scopeConfirmed).toBe(true);
    expect(h.field.draft(h.seed.a, ids.draftId)).toEqual({
      fieldOwnerUid: 'estimator-a',
      state: 'editing',
      fence: null,
      field: kept,
      rooms: Object.fromEntries(manifest.rooms.map((room) => [room.id, room.field])),
      photos: {},
      previous: null,
      jobId: ids.id,
    });
    expect(await auditOf(ids.id)).toEqual(['job_copied']);
    const [audit] = await h.admin<{ details: Record<string, unknown> }[]>`SELECT details FROM audit_events WHERE target = ${ids.id}`;
    expect(audit!.details).toEqual({ revision: 1, copiedFrom: source });
    // The signed job is unchanged, and the copy is an ordinary draft: it submits from the copied scope.
    expect((await f.job(source)).status).toBe('signed');
    const copied: FieldManifest = { draft: kept, rooms: manifest.rooms, photos: [] };
    expect((await f.submitShown(ESTIMATOR_A, ids.id, ids.draftId, copied)).answer.status).toBe(201);
  });

  it('gives a copy made before 0018 its source when the same copy is sent again', async () => {
    const { jobId: source } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await copy(ESTIMATOR_A, source, ids)).status).toBe(201);
    // As the previous version left it: no source on the row (set aside without the triggers).
    await h.admin.begin(async (sql) => {
      await sql`SET LOCAL session_replication_role = replica`;
      await sql`UPDATE jobs SET copied_from_job_id = NULL WHERE id = ${ids.id}`;
    });
    const [before] = await h.admin<{ field: number }[]>`SELECT field_revision::int AS field FROM jobs WHERE id = ${ids.id}`;
    expect((await copy(ESTIMATOR_A, source, ids)).status).toBe(200);
    // Setting the source is a life-cycle input: the field revision rises, the job revision stays.
    expect(await h.admin`SELECT copied_from_job_id::text AS source, revision, field_revision::int AS field FROM jobs WHERE id = ${ids.id}`).toEqual([
      { source, revision: 1, field: before!.field + 1 },
    ]);
  });

  it('refuses another body under the same id, and copies only a signed job', async () => {
    const { jobId: source } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await copy(OFFICE_A, source, ids)).status).toBe(201);
    expect(await copy(OFFICE_A, source, { ...ids, draftId: randomUUID() })).toEqual({ status: 409, body: { error: 'conflict' } });
    // A job created with the copy's ids is not a retry of it.
    expect((await json(jobsRoute.POST(request(OFFICE_A, '/api/jobs', { method: 'POST', body: ids }), params({})))).status).toBe(409);
    const { jobId: unsigned } = await draftJob();
    expect(await copy(ESTIMATOR_A, unsigned, { id: randomUUID(), draftId: randomUUID() })).toEqual({ status: 409, body: { error: 'not_signed' } });
    // Office starts the copy with no field owner, as an office job.
    expect((await read(OFFICE_A, ids.id)).body).toMatchObject({ job: { fieldOwnerActorId: null } });
  });

  it('never takes another job’s earlier draft: a copy, a new job and Back to editing refuse its id', async () => {
    const { jobId: source } = await signedJob();
    const { jobId: other, draftId: earlier, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect((await f.submitShown(ESTIMATOR_A, other, earlier, manifest)).answer.status).toBe(201);
    expect((await f.nextDraft(ESTIMATOR_A, other, { draftId: randomUUID(), fromDraftId: earlier })).status).toBe(201);
    const { jobId: third, draftId: thirdDraft, manifest: thirdManifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect((await f.submitShown(ESTIMATOR_A, third, thirdDraft, thirdManifest)).answer.status).toBe(201);
    const before = await everything(h.admin);
    const stored = structuredClone(h.field.draft(h.seed.a, earlier));
    const refused = { status: 409, body: { error: 'conflict' } };
    expect(await copy(OWNER_A, source, { id: randomUUID(), draftId: earlier })).toEqual(refused);
    expect(await json(jobsRoute.POST(request(OWNER_A, '/api/jobs', { method: 'POST', body: { id: randomUUID(), draftId: earlier } }), params({})))).toEqual(refused);
    expect(await f.nextDraft(ESTIMATOR_A, third, { draftId: earlier, fromDraftId: thirdDraft })).toEqual(refused);
    expect(await everything(h.admin)).toBe(before);
    expect(h.field.draft(h.seed.a, earlier)).toEqual(stored);
  });

  // Security audit F1, across a release: the previous version made the copy and its draft with no
  // claim and no job id on the draft. The same copy sent again claims the draft id for the copy in
  // Postgres first, then stamps the draft; a draft id Postgres holds for another job is refused and
  // its draft not stamped.
  it('claims and stamps a copy draft the previous version made when the same copy is sent again, and refuses one another job holds', async () => {
    const { jobId: source } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await copy(OWNER_A, source, ids)).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${ids.draftId}`;
    h.field.unstamp(h.seed.a, ids.draftId);
    const { jobId: other } = await draftJob();
    await h.admin`INSERT INTO job_drafts (company_id, draft_id, job_id) VALUES (${h.seed.a}, ${ids.draftId}, ${other})`;
    const stored = structuredClone(h.field.draft(h.seed.a, ids.draftId));
    expect(await copy(OWNER_A, source, ids)).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(h.field.draft(h.seed.a, ids.draftId)).toEqual(stored);
    expect(stored?.jobId).toBeUndefined();

    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${ids.draftId}`;
    expect((await copy(OWNER_A, source, ids)).status).toBe(200);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${ids.draftId}`).toEqual([{ job: ids.id }]);
    expect(h.field.draft(h.seed.a, ids.draftId)).toEqual({ ...stored, jobId: ids.id });
  });

  // Security audit F1: the claim commits before the stamp, so a lost answer from the stamp never leaves
  // a copy draft the previous version made stamped without its claim.
  it('commits the claim before stamping a copy draft the previous version made, so a lost answer leaves it claimed', async () => {
    const { jobId: source } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    expect((await copy(OWNER_A, source, ids)).status).toBe(201);
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${ids.draftId}`;
    h.field.unstamp(h.seed.a, ids.draftId);
    h.field.loseNext.createCopy = true;
    expect((await copy(OWNER_A, source, ids)).status).toBe(503);
    expect(h.field.draft(h.seed.a, ids.draftId)?.jobId).toBe(ids.id);
    expect(await h.admin`SELECT job_id::text AS job FROM job_drafts WHERE draft_id = ${ids.draftId}`).toEqual([{ job: ids.id }]);
    expect((await copy(OWNER_A, source, ids)).status).toBe(200);
  });

  it('refuses a copy onto a draft the field database holds for another job, and commits nothing', async () => {
    const { jobId: source } = await signedJob();
    const foreign = randomUUID();
    const key = `${h.seed.a}/${foreign}`;
    h.drafts.plant(key, { fieldOwnerUid: 'estimator-a2', jobId: randomUUID() });
    const before = await everything(h.admin);
    const stored = structuredClone(h.field.draft(h.seed.a, foreign));
    const id = randomUUID();
    expect(await copy(OWNER_A, source, { id, draftId: foreign })).toEqual({ status: 409, body: { error: 'conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(h.field.draft(h.seed.a, foreign)).toEqual(stored);
    expect((await copy(OWNER_A, source, { id, draftId: randomUUID() })).status).toBe(201);
  });
});

// Holds the next call of a field method at its start until `open`, which may come before the call.
function hold(method: keyof FakeField['gate']): { arrived: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  h.field.gate[method] = async () => {
    arrive();
    await opened;
  };
  return { arrived, open };
}

// Holds the next call of whichever of these methods comes first (the draft sync, or the previous writer
// it replaces), so a sequence is held at the same step on either; the other gates go.
function holdEither(methods: (keyof FakeField['gate'])[]): { arrived: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  const gate = async () => {
    for (const method of methods) delete h.field.gate[method];
    arrive();
    await opened;
  };
  for (const method of methods) h.field.gate[method] = gate;
  return { arrived, open };
}

// Waits for a step that may instead be waiting on a lock another held request has.
const briefly = (step: Promise<unknown>) => Promise.race([step, new Promise((resolve) => setTimeout(resolve, 1000))]);

describe('overlapping requests', () => {
  it('leaves a copy archived when the owner archives it before its field draft is made', async () => {
    const { jobId: source } = await signedJob();
    const ids = { id: randomUUID(), draftId: randomUUID() };
    const made = hold('createCopy');
    const copying = copy(ESTIMATOR_A, source, ids);
    await made.arrived;
    const archiving = archive(OWNER_A, ids.id, change(1));
    await briefly(archiving);
    made.open();
    expect((await copying).status).toBe(201);
    expect((await archiving).status).toBe(200);
    expect(h.field.draft(h.seed.a, ids.draftId)?.state).toBe('archived');
  });

  it('leaves the next draft version archived when the owner archives it before Back to editing makes it', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    const next = randomUUID();
    const made = hold('createFrom');
    const editing = f.nextDraft(ESTIMATOR_A, jobId, { draftId: next, fromDraftId: draftId });
    await made.arrived;
    const archiving = archive(OWNER_A, jobId, change((await f.job(jobId)).revision));
    await briefly(archiving);
    made.open();
    expect((await editing).status).toBe(201);
    expect((await archiving).status).toBe(200);
    expect(h.field.draft(h.seed.a, next)?.state).toBe('archived');
  });

  // r4 (a) of the draft life-cycle redesign: an archive and a restore are held at the field database (the
  // draft sync, or the previous archive and restore writers alike); Submit then commits and marks the
  // draft submitted; the late archive and restore land after it and must not reopen it.
  it('never leaves a submitted job’s draft open when an archive and a restore land after a Submit', async () => {
    const { jobId, draftId, manifest } = await f.readyJob(ESTIMATOR_A, h.seed.a);
    const revision = (await f.job(jobId)).revision;
    const archived = holdEither(['sync', 'archiveDraft']);
    const archiving = archive(OWNER_A, jobId, change(revision));
    await archived.arrived;
    const restored = holdEither(['sync', 'restoreDraft']);
    const restoring = restore(OWNER_A, jobId, change(revision + 1));
    await restored.arrived;
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitted');
    archived.open();
    expect((await archiving).status).toBe(200);
    restored.open();
    expect((await restoring).status).toBe(200);
    expect((await f.job(jobId)).status).toBe('submitted');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('submitted');
    expect((await f.submissions(jobId)).filter((row) => row.marker_state === 'pending')).toEqual([]);
  });

  it('opens the field draft on the restore sent again after the job was saved meanwhile', async () => {
    const { jobId, draftId } = await draftJob();
    await archive(OWNER_A, jobId, change(1));
    // Unreachable for the request and its one try again.
    h.field.failNext.sync = 2;
    const once = change(2);
    expect(await restore(OWNER_A, jobId, once)).toEqual({ status: 503, body: { error: 'draft_unavailable' } });
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('archived');
    const customer = { ...change(3), name: 'Dana Field', phone: '555-0101', email: 'dana@example.test', propertyAddress: '2 Main St' };
    const saved = await json(customerRoute.PUT(request(OWNER_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body: customer }), job(jobId)));
    expect(saved.status).toBe(200);
    expect(await restore(OWNER_A, jobId, once)).toEqual({ status: 409, body: { error: 'not_archived' } });
    expect(h.field.draft(h.seed.a, draftId)).toMatchObject({ state: 'editing', archiveRevision: 4 });
  });
});

describe('company isolation', () => {
  it('refuses another company’s archive, restore, copy and archived list, and changes nothing', async () => {
    const { jobId: draft } = await draftJob();
    const { jobId: signed } = await signedJob();
    const { jobId: filed } = await draftJob();
    await archive(OWNER_A, filed, change(1));
    const before = await everything(h.admin);
    const fieldBefore = JSON.stringify(h.field.data());
    for (const who of [OWNER_B, ESTIMATOR_B]) {
      for (const jobId of [draft, signed, filed]) {
        for (const [name, call] of [['archive', archive], ['restore', restore]] as const) {
          const answer = await call(who, jobId, change(2));
          expect({ who: who.uid, name, status: answer.status }).toEqual({ who: who.uid, name, status: who === OWNER_B ? 404 : 403 });
        }
        expect(await copy(who, jobId, { id: randomUUID(), draftId: randomUUID() })).toEqual({ status: 404, body: { error: 'not_found' } });
      }
    }
    expect(await listed(OWNER_B, '?scope=archived')).toEqual([]);
    expect(await everything(h.admin)).toBe(before);
    expect(JSON.stringify(h.field.data())).toBe(fieldBefore);
  });
});
