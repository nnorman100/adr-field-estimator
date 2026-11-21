import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import type { FieldManifest } from '@/lib/field/canonical';
import { newJob } from './job-harness';
import { standIn } from './readiness-fake';
import { agreementOf, insertAgreement, newSubmission, seedEstimate, seedPin, seedSignature, seedVersion } from './submission-harness';
import { flow, json, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-10 slice 10B, the drying watch: GET /api/jobs/{jobId}/drying-watch and POST
// .../drying-watch/actions through the real route files as the runtime role against Postgres, with
// readings added through the real drying log routes. It proves the switch, the signed-job rule, who
// reads and who acts (Mark dry: scope or coordination; Extend and Close: coordination), the status from
// the signed plan and the live log, a confirmation against stale facts refused, the receipt replayed
// first, one change and one audit row per action, a closed watch staying closed, the first action
// making the coordination row at revision 0 with the office notes left as they are, and that nothing
// signed changes.
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
  const { watchService } = await import('@/lib/drying/watch-service');
  const { outcomeService } = await import('@/lib/drying/outcome');
  return {
    dryingServices: () => ({
      readings: readingsService(live.harness!.handle.db, () => live.reader!),
      watch: watchService(live.harness!.handle.db),
      outcome: outcomeService(live.harness!.handle.db),
    }),
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
const coordinationRoute = await import('@/app/api/jobs/[jobId]/coordination/route');
const readingsRoute = await import('@/app/api/jobs/[jobId]/drying-readings/route');
const voidRoute = await import('@/app/api/jobs/[jobId]/drying-readings/[readingId]/void/route');
const watchRoute = await import('@/app/api/jobs/[jobId]/drying-watch/route');
const actionsRoute = await import('@/app/api/jobs/[jobId]/drying-watch/actions/route');
const outcomeRoute = await import('@/app/api/jobs/[jobId]/outcome/route');
const { params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let estimatorA2: string;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

const f = flow(() => h, { createJob: jobsRoute.POST, putPhoto: photoRoute.PUT, submit: submissionsRoute.POST, nextDraft: draftsRoute.POST, request, params });

const switchOn = (company: string) => h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company}, 'drying_watch', true)`;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.reader = standIn(h.field);
  await switchOn(h.seed.a);
  await switchOn(h.seed.b);
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

const watch = (claims: FakeClaims | null, jobId: string): Promise<Reply> => json(watchRoute.GET(request(claims, `/api/jobs/${jobId}/drying-watch`), params({ jobId })));
const act = (claims: FakeClaims | null, jobId: string, body: unknown): Promise<Reply> =>
  json(actionsRoute.POST(request(claims, `/api/jobs/${jobId}/drying-watch/actions`, { method: 'POST', body }), params({ jobId })));
const addReading = (claims: FakeClaims, jobId: string, body: Body): Promise<Reply> =>
  json(readingsRoute.POST(request(claims, `/api/jobs/${jobId}/drying-readings`, { method: 'POST', body }), params({ jobId })));
const voidReading = (claims: FakeClaims, jobId: string, readingId: string): Promise<Reply> =>
  json(voidRoute.POST(request(claims, `/api/jobs/${jobId}/drying-readings/${readingId}/void`, { method: 'POST', body: { changeId: randomUUID(), expectedState: 'active' } }), params({ jobId, readingId })));

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const dryMaterial = (roomId: string, moisture = 10): Body => ({ id: randomUUID(), kind: 'material', takenAt: minutesAgo(5), roomId, material: 'Drywall', moisture, unit: '%WME', dryStandard: 12 });
const action = (factsHash: string, extra: Body = {}): Body => ({ id: randomUUID(), action: 'extend', factsHash, confirmed: true, reason: 'Waiting on a second dehumidifier.', ...extra });
const watchAudits = async (jobId: string) => (await f.auditActions(jobId)).filter((one) => one === 'drying_watch_action');

// A job submitted through the real routes (rooms Kitchen and Hall, `dryingDays` signed unless left
// out), then signed: the agreement and everything it names written as signing writes them.
async function signedJob(options: { plan?: boolean } = {}): Promise<{ jobId: string; draftId: string }> {
  const { jobId, draftId, manifest: ready } = await f.readyJob(ESTIMATOR_A, h.seed.a);
  const draft = { ...(ready.draft as object), scopeConfirmed: true, ...(options.plan === false ? {} : { dryingDays: 3 }) };
  const manifest: FieldManifest = { ...ready, draft };
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

const signedRecord = (jobId: string) =>
  h.admin`SELECT j.revision, j.field_revision, a.documents_bytes, a.proposal_sha256, a.content_hash, a.priced_result FROM jobs j JOIN agreements a ON a.job_id = j.id WHERE j.id = ${jobId}`;

describe('reading the watch', () => {
  it('works out the status of a signed job from its signed plan, its log and the clock', async () => {
    const { jobId } = await signedJob();
    const [agreement] = await h.admin<{ id: string; signed_at: Date }[]>`SELECT id::text, signed_at FROM agreements WHERE job_id = ${jobId}`;
    const first = await watch(OWNER_A, jobId);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      jobId,
      agreementId: agreement!.id,
      status: 'active',
      plannedDays: 3,
      signedRooms: [
        { id: 'kitchen', name: 'Kitchen' },
        { id: 'hall', name: 'Hall' },
      ],
      dayNumber: 1,
      lastReadingAt: null,
      missingRooms: ['kitchen', 'hall'],
      revision: 0,
      decisions: [],
      suggestedDays: null,
      can: { markDry: true, extend: true, close: true },
    });
    expect(new Date(first.body.nextDueAt).getTime()).toBe(agreement!.signed_at.getTime() + 24 * 60 * 60 * 1000);
    expect(first.body.flags).toContain('missing_dry_standard');
    expect(first.body.factsHash).toMatch(/^[0-9a-f]{64}$/);
    // Both signed rooms at or under their standards: dry, and monitoring has finished.
    for (const room of ['kitchen', 'hall']) expect((await addReading(ESTIMATOR_A, jobId, dryMaterial(room))).status).toBe(201);
    const dry = await watch(ESTIMATOR_A, jobId);
    expect(dry.body).toMatchObject({ status: 'dry_standard_met', flags: [], nextDueAt: null, missingRooms: [], suggestedDays: 1 });
    expect(dry.body.factsHash).not.toBe(first.body.factsHash);
    expect(dry.body.summary).toContain('Every latest affected material reading meets its dry standard.');
  });

  it('works the status out again after a void, so a voided reading attests nothing', async () => {
    const { jobId } = await signedJob();
    const readings: Body[] = [];
    for (const room of ['kitchen', 'hall']) readings.push((await addReading(OWNER_A, jobId, dryMaterial(room))).body.reading);
    expect((await watch(OWNER_A, jobId)).body.status).toBe('dry_standard_met');
    expect((await voidReading(OWNER_A, jobId, readings[1]!.id)).status).toBe(200);
    expect((await watch(OWNER_A, jobId)).body).toMatchObject({ status: 'active', missingRooms: ['hall'] });
  });

  it('says a signed record without a saved drying plan has nothing to watch', async () => {
    const { jobId } = await signedJob({ plan: false });
    expect(await watch(OWNER_A, jobId)).toEqual({ status: 200, body: { jobId, status: 'unavailable', reason: 'no_plan' } });
    expect(await act(OWNER_A, jobId, action('0'.repeat(64)))).toEqual({ status: 409, body: { error: 'no_plan' } });
  });

  it('is for signed jobs only, behind the company’s switch', async () => {
    const { jobId: draft } = await f.newJob(ESTIMATOR_A);
    expect(await watch(OWNER_A, draft)).toEqual({ status: 409, body: { error: 'not_signed' } });
    const { jobId } = await signedJob();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'drying_watch'`;
    expect(await watch(OWNER_A, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await act(OWNER_A, jobId, action('0'.repeat(64)))).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('answers the job’s readers and refuses everyone else (404)', async () => {
    const { jobId } = await signedJob();
    for (const claims of [OWNER_A, ESTIMATOR_A, OFFICE_A]) expect((await watch(claims, jobId)).status).toBe(200);
    expect((await watch(ESTIMATOR_A, jobId)).body.can).toEqual({ markDry: true, extend: false, close: false });
    expect((await watch(OFFICE_A, jobId)).body.can).toEqual({ markDry: true, extend: true, close: true });
    for (const other of [ESTIMATOR_A2, OWNER_B, ESTIMATOR_B]) {
      expect(await watch(other, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
      expect(await act(other, jobId, action('0'.repeat(64)))).toEqual({ status: 404, body: { error: 'not_found' } });
    }
    const assigned = await assignmentsRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id: randomUUID(), estimatorActorId: estimatorA2 } }), params({ jobId }));
    expect(assigned.status).toBe(201);
    expect((await watch(ESTIMATOR_A2, jobId)).status).toBe(200);
    expect((await watch(null, jobId)).status).toBe(401);
  });
});

describe('acting on the watch', () => {
  it('saves one confirmed extension and one audit row, makes the coordination row at revision 0, and changes nothing signed', async () => {
    const { jobId } = await signedJob();
    const before = await signedRecord(jobId);
    const { factsHash } = (await watch(OFFICE_A, jobId)).body;
    const request = action(factsHash);
    const done = await act(OFFICE_A, jobId, request);
    expect(done.status).toBe(201);
    expect(done.body.receipt).toMatchObject({ id: request.id, action: 'extend', reason: request.reason, by: { actorId: h.seed.officeA.actor } });
    expect(done.body.watch).toMatchObject({ status: 'active', revision: 1, plannedDays: 3, decisions: [{ action: 'extend', reason: request.reason }] });
    const [row] = await h.admin<{ revision: number; office_notes: string; watch: Body }[]>`SELECT revision, office_notes, drying_watch AS watch FROM job_coordination WHERE job_id = ${jobId}`;
    expect(row).toMatchObject({ revision: 0, office_notes: '', watch: { revision: 1 } });
    expect(row!.watch.receipts[0]).toMatchObject({ action: 'extend', actor_id: h.seed.officeA.actor, request_id: request.id });
    expect(await signedRecord(jobId)).toEqual(before);
    expect(await watchAudits(jobId)).toEqual(['drying_watch_action']);
    // The office notes, opened before the action at revision 0, still save, and the watch stays.
    const notes = await coordinationRoute.PUT(request_(OFFICE_A, jobId, { revision: 0, changeId: randomUUID(), notes: 'Call before the visit.' }), params({ jobId }));
    expect(notes.status).toBe(200);
    const [after] = await h.admin<{ revision: number; watch: Body }[]>`SELECT revision, drying_watch AS watch FROM job_coordination WHERE job_id = ${jobId}`;
    expect(after).toMatchObject({ revision: 1, watch: { revision: 1 } });
  });

  it('answers a resent action with its accepted receipt, and refuses the same id with another body', async () => {
    const { jobId } = await signedJob();
    const { factsHash } = (await watch(OWNER_A, jobId)).body;
    const request = action(factsHash);
    const first = await act(OWNER_A, jobId, request);
    expect(first.status).toBe(201);
    // Sent again after a lost answer, even though the facts changed with it.
    const again = await act(OWNER_A, jobId, request);
    expect(again.status).toBe(200);
    expect(again.body.receipt).toEqual(first.body.receipt);
    expect(await act(OWNER_A, jobId, { ...request, reason: 'Another reason.' })).toEqual({ status: 409, body: { error: 'conflict' } });
    // Sent twice at once, a new action is saved once.
    const { factsHash: now } = (await watch(OWNER_A, jobId)).body;
    const twin = action(now);
    const answers = await Promise.all([act(OWNER_A, jobId, twin), act(OWNER_A, jobId, twin)]);
    expect(answers.map((one) => one.status).sort()).toEqual([200, 201]);
    expect(await watchAudits(jobId)).toEqual(['drying_watch_action', 'drying_watch_action']);
  });

  it('refuses a confirmation of facts that changed since they were read (409), and saves nothing', async () => {
    const { jobId } = await signedJob();
    const { factsHash } = (await watch(OFFICE_A, jobId)).body;
    expect((await addReading(ESTIMATOR_A, jobId, dryMaterial('kitchen', 30))).status).toBe(201);
    expect(await act(OFFICE_A, jobId, action(factsHash))).toEqual({ status: 409, body: { error: 'stale_facts' } });
    expect(await h.admin`SELECT 1 FROM job_coordination WHERE job_id = ${jobId}`).toHaveLength(0);
    expect(await watchAudits(jobId)).toEqual([]);
    // The facts read again are confirmed.
    const fresh = (await watch(OFFICE_A, jobId)).body.factsHash;
    expect((await act(OFFICE_A, jobId, action(fresh))).status).toBe(201);
  });

  it('lets the estimator mark dry but not extend or close, and keeps a closed watch closed', async () => {
    const { jobId } = await signedJob();
    const { factsHash } = (await watch(ESTIMATOR_A, jobId)).body;
    expect(await act(ESTIMATOR_A, jobId, action(factsHash))).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await act(ESTIMATOR_A, jobId, action(factsHash, { action: 'close' }))).toEqual({ status: 403, body: { error: 'not_allowed' } });
    const marked = await act(ESTIMATOR_A, jobId, action(factsHash, { action: 'mark_dry', reason: 'Readings at standard on the meter.' }));
    expect(marked.status).toBe(201);
    expect(marked.body.watch).toMatchObject({ status: 'marked_dry', flags: [], nextDueAt: null, suggestedDays: 1, can: { markDry: false, extend: false, close: false } });
    expect(marked.body.watch.summary).toContain('Marked dry by staff.');
    const now = (await watch(OWNER_A, jobId)).body;
    expect(now.status).toBe('marked_dry');
    expect(await act(OWNER_A, jobId, action(now.factsHash, { action: 'close' }))).toEqual({ status: 409, body: { error: 'watch_closed' } });
    // A wet reading later does not reopen it.
    expect((await addReading(OWNER_A, jobId, dryMaterial('kitchen', 40))).status).toBe(201);
    expect((await watch(OWNER_A, jobId)).body.status).toBe('marked_dry');
  });

  it('needs a confirmation and a reason, and decides the job and the role before the body', async () => {
    const { jobId } = await signedJob();
    const { factsHash } = (await watch(OFFICE_A, jobId)).body;
    for (const body of [action(factsHash, { confirmed: false }), action(factsHash, { reason: '   ' }), action(factsHash, { reason: 'x'.repeat(501) }), action(factsHash, { action: 'remind' }), '{not json']) {
      expect(await act(OFFICE_A, jobId, body)).toEqual({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await act(OWNER_B, jobId, '{not json')).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await watchAudits(jobId)).toEqual([]);
  });

  it('keeps at most 100 extensions', async () => {
    const { jobId } = await signedJob();
    const [agreement] = await h.admin<{ id: string }[]>`SELECT id::text FROM agreements WHERE job_id = ${jobId}`;
    const receipt = (n: number) => ({ action: 'extend', agreement_id: agreement!.id, reason: `Note ${n}`, actor_id: h.seed.officeA.actor, at: '2026-01-01T00:00:00.000000Z', request_id: randomUUID(), request_digest: 'a'.repeat(64) });
    let receipts: Body[] = [receipt(1)];
    await h.admin`INSERT INTO job_coordination (company_id, job_id, revision, drying_watch) VALUES (${h.seed.a}, ${jobId}, 0, ${h.admin.json({ revision: 1, receipts })})`;
    for (let n = 2; n <= 100; n += 1) {
      receipts = [...(await h.admin<{ watch: { receipts: Body[] } }[]>`SELECT drying_watch AS watch FROM job_coordination WHERE job_id = ${jobId}`)[0]!.watch.receipts, receipt(n)];
      await h.admin`UPDATE job_coordination SET drying_watch = ${h.admin.json({ revision: n, receipts })} WHERE job_id = ${jobId}`;
    }
    const now = (await watch(OFFICE_A, jobId)).body;
    expect(now.can.extend).toBe(false);
    expect(await act(OFFICE_A, jobId, action(now.factsHash))).toEqual({ status: 409, body: { error: 'extension_limit' } });
    expect((await act(OFFICE_A, jobId, action(now.factsHash, { action: 'close', reason: 'Equipment pulled.' }))).status).toBe(201);
  });
});

describe('the drying days a job close is preset with', () => {
  it('are the signed plan’s days, and the watch’s day count once monitoring has finished', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'estimate_assist', true)`;
    const { jobId } = await signedJob();
    const outcome = () => json(outcomeRoute.GET(request(OWNER_A, `/api/jobs/${jobId}/outcome`), params({ jobId })));
    expect((await outcome()).body.suggestedDays).toEqual({ days: 3, source: 'plan' });
    const { factsHash } = (await watch(OWNER_A, jobId)).body;
    expect((await act(OWNER_A, jobId, action(factsHash, { action: 'mark_dry' }))).status).toBe(201);
    expect((await outcome()).body.suggestedDays).toEqual({ days: 1, source: 'watch' });
    // With the drying watch switched off, the signed plan again.
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'drying_watch'`;
    expect((await outcome()).body.suggestedDays).toEqual({ days: 3, source: 'plan' });
  });
});

// The coordination save's request (the office notes route).
function request_(claims: FakeClaims, jobId: string, body: unknown): Request {
  return request(claims, `/api/jobs/${jobId}/coordination`, { method: 'PUT', body });
}

describe('the jobs list projection', () => {
  const due = (card: Body) => (card.flags.includes('overdue') ? 'overdue' : card.flags.includes('due_today') ? 'due_today' : null);

  it('gives each signed job on one page the status and due its own card works out, with drying_watch alone', async () => {
    const active = (await signedJob()).jobId;
    const dry = (await signedJob()).jobId;
    for (const room of ['kitchen', 'hall']) expect((await addReading(ESTIMATOR_A, dry, dryMaterial(room))).status).toBe(201);
    const noPlan = (await signedJob({ plan: false })).jobId;
    const rows = (await json(jobsRoute.GET(request(OWNER_A, '/api/jobs'), params({})))).body.jobs as Body[];
    const row = (jobId: string) => rows.find((one) => one.id === jobId)!;
    const cards = { active: (await watch(OWNER_A, active)).body, dry: (await watch(OWNER_A, dry)).body };
    expect([cards.active.status, cards.dry.status]).toEqual(['active', 'dry_standard_met']);
    for (const [jobId, card] of [
      [active, cards.active],
      [dry, cards.dry],
    ] as const) {
      expect(row(jobId).dryingWatch).toEqual({ status: card.status, due: due(card), nextDueAt: card.nextDueAt });
      // estimate_assist is off: no close status.
      expect(row(jobId).closed).toBeUndefined();
    }
    expect(row(active).dryingWatch.nextDueAt).not.toBeNull();
    expect(row(noPlan).dryingWatch).toEqual({ status: 'unavailable', due: null, nextDueAt: null });
  });
});
