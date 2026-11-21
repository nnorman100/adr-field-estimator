import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestDigest, type FieldManifest } from '@/lib/field/canonical';
import type { SetupReadingSource } from '@/lib/readiness/readings';
import { standIn } from './readiness-fake';
import { flow, image, json, latch, until, type Answer } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-11 slice 11A, "Ready to review?": GET /api/jobs/{jobId}/readiness through the real route file as
// the runtime role against Postgres, with the field database's drafts from the shared stand-in
// (tests/submissions/field-fake.ts; the real reader is checked against the emulator in
// tests/emu/readiness-reader.test.ts). It proves the switch and the role and company refusals, the
// owner's and the assigned estimator's reads, 410 on an archived job, the gaps from the job's saved
// address, claim, prices and stored photos, that a read changes no record, the unavailable answers
// (draft not editing, changed meanwhile, unreadable, field database down), and that Submit neither
// waits on nor is stopped by any of it.
const live = vi.hoisted(() => ({ harness: null as Harness | null, reader: null as null | ReturnType<typeof standIn>, readings: null as SetupReadingSource | null, down: false }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));
vi.mock('@/lib/submissions/services', () => ({ submissionsServices: () => live.harness!.submissions }));
vi.mock('@/lib/readiness/services', async () => {
  const { readinessService } = await import('@/lib/readiness/service');
  const { noDryingLog } = await import('@/lib/readiness/readings');
  return {
    readinessServices: () => {
      return readinessService(
        live.harness!.handle.db,
        () => {
          // As a server whose field database setting is missing: the field reader cannot be built.
          if (live.down) throw new Error('readiness field reader unavailable');
          return live.reader!;
        },
        live.readings ?? noDryingLog,
      );
    },
  };
});

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const submissionsRoute = await import('@/app/api/jobs/[jobId]/submissions/route');
const draftsRoute = await import('@/app/api/jobs/[jobId]/drafts/route');
const customerRoute = await import('@/app/api/jobs/[jobId]/customer/route');
const claimRoute = await import('@/app/api/jobs/[jobId]/claim/route');
const assignmentsRoute = await import('@/app/api/jobs/[jobId]/assignments/route');
const assignmentRoute = await import('@/app/api/jobs/[jobId]/assignments/[assignmentId]/route');
const archiveRoute = await import('@/app/api/jobs/[jobId]/archive/route');
const readinessRoute = await import('@/app/api/jobs/[jobId]/readiness/route');
const { contentHash, ENGINE_VERSION, parseTable } = await import('@/engine/table');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

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

const switchOn = (company: string) => h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company}, 'readiness', true)`;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  live.reader = standIn(h.field);
  live.readings = null;
  live.down = false;
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
const readiness = (claims: FakeClaims | null, jobId: string): Promise<Answer & { body: Body }> =>
  json(readinessRoute.GET(request(claims, `/api/jobs/${jobId}/readiness`), params({ jobId })));

const revision = async (jobId: string) => (await f.job(jobId)).revision;

async function saveCustomer(jobId: string, propertyAddress: string) {
  const body = { revision: await revision(jobId), changeId: randomUUID(), name: 'Casey Customer', phone: '555-0101', email: 'casey@example.invalid', propertyAddress };
  expect((await customerRoute.PUT(request(OWNER_A, `/api/jobs/${jobId}/customer`, { method: 'PUT', body }), params({ jobId }))).status).toBe(200);
}

async function saveClaim(jobId: string, claim: Record<string, string | null>) {
  const empty = { carrier: '', claimNumber: '', policyNumber: '', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' };
  const body = { revision: await revision(jobId), changeId: randomUUID(), ...empty, ...claim };
  expect((await claimRoute.PUT(request(OWNER_A, `/api/jobs/${jobId}/claim`, { method: 'PUT', body }), params({ jobId }))).status).toBe(200);
}

// Publishes company A's next price version, as S4-6's publish stores it; `wetFloor` prices rooms by
// wet floor area, `badHash` stores it under another table's hash, as a version that cannot be read, and
// `engine` records it for another engine version, one this server cannot price.
async function publish(options: { wetFloor?: boolean; badHash?: boolean; engine?: string } = {}) {
  const policy = {
    estimate_mode: 'single',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    sales_tax: { enabled: false, percent: '0' },
    ...(options.wetFloor ? { area_basis: 'wet_floor' } : {}),
  };
  const table = parseTable({ items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }], policy });
  const other = parseTable({ items: [], policy });
  await h.admin`
    INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
    SELECT ${h.seed.a}, coalesce(max(sequence), 0) + 1, ${JSON.stringify(table)}::text::jsonb, ${contentHash(options.badHash ? other : table)}, ${options.engine ?? ENGINE_VERSION}, 'Prices for a test', 'blank', ${h.seed.ownerA.actor}, ${`key-${randomUUID()}`}
    FROM price_table_versions WHERE company_id = ${h.seed.a}
  `;
}

// A job of company A made by estimator A, one photo stored, its draft as the phone leaves it: two
// water rooms, the kitchen with a stored overview photo, no address, no claim.
async function job() {
  const { jobId, draftId } = await f.newJob(ESTIMATOR_A);
  const photoId = randomUUID();
  expect((await f.sendPhoto(ESTIMATOR_A, jobId, photoId, image(photoId))).status).toBe(201);
  const manifest: FieldManifest = {
    draft: { yearBuilt: 1972, roomOrder: ['kitchen', 'hall'], notes: 'Do not repeat these notes.', summary: 'Category 2 water in two rooms.', airMovers: 3 },
    rooms: [
      { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80, ceilingHeightFt: 8, waterClass: 2, finishedSf: 40 } },
      { id: 'hall', field: { name: 'Kitchen', category: 2, floorSf: 40 } },
    ],
    photos: [{ id: photoId, field: { roomId: 'kitchen', shotTag: 'overview' } }],
  };
  h.field.put(h.seed.a, draftId, manifest);
  return { jobId, draftId, photoId, manifest };
}

const codes = (body: Body) => (body.gaps as { code: string; roomId?: string }[]).map((gap) => (gap.roomId ? `${gap.roomId}:${gap.code}` : gap.code));

// What the stand-in job lacks: no address, the kitchen's surface and meter photos, the hall's sizing
// and photos (both rooms are named Kitchen: each is its own room), no prices, scope not confirmed.
// With no published prices the room area check is unavailable, not a demolition gap.
const JOB_GAPS = [
  'propertyAddress',
  'kitchen:shot:surface',
  'kitchen:shot:meter',
  'hall:ceilingHeightFt',
  'hall:waterClass',
  'hall:shot:overview',
  'hall:shot:surface',
  'hall:shot:meter',
  'prices',
  'scopeConfirmed',
];

describe('GET /api/jobs/{jobId}/readiness: who may read it', () => {
  it('answers 404 while the company’s readiness switch is off, before anything is read', async () => {
    const { jobId } = await job();
    await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'readiness'`;
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(live.reader!.reads).toBe(0);
  });

  it('answers the owner, the estimator who made the job and an assigned estimator alike', async () => {
    const { jobId, draftId, manifest } = await job();
    const owner = await readiness(OWNER_A, jobId);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ status: 'checked', jobId, draftId, jobRevision: 1, ready: false, fieldSha256: await manifestDigest(manifest), unavailable: ['roomArea', 'setupReadings', 'ocr'] });
    expect(codes(owner.body)).toEqual(JOB_GAPS);
    expect(await readiness(ESTIMATOR_A, jobId)).toEqual(owner);
    // Another estimator of the company does not see the job until they are assigned it.
    expect(await readiness(ESTIMATOR_A2, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    const assigned = await assignmentsRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id: randomUUID(), estimatorActorId: estimatorA2 } }), params({ jobId }));
    expect(assigned.status).toBe(201);
    expect(await readiness(ESTIMATOR_A2, jobId)).toEqual(owner);
  });

  it('refuses office (403), a disabled member, no sign-in, and every person of the other company (404)', async () => {
    const { jobId } = await job();
    expect(await readiness(OFFICE_A, jobId)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect((await readiness(DISABLED_A, jobId)).status).toBe(403);
    expect((await readiness(null, jobId)).status).toBe(401);
    for (const other of [OWNER_B, ESTIMATOR_B]) expect(await readiness(other, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
    // An id that is no job of the caller's company is the same 404.
    expect(await readiness(OWNER_A, randomUUID())).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(live.reader!.reads).toBe(0);
  });

  it('answers 410 on an archived job, and reads nothing of it', async () => {
    const { jobId } = await job();
    const archived = await archiveRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: await revision(jobId), changeId: randomUUID() } }), params({ jobId }));
    expect(archived.status).toBe(200);
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 410, body: { error: 'archived' } });
    expect(await readiness(ESTIMATOR_A, jobId)).toEqual({ status: 410, body: { error: 'archived' } });
    expect(live.reader!.reads).toBe(0);
  });
});

describe('GET /api/jobs/{jobId}/readiness: the gaps', () => {
  it('changes no record in Postgres or the field database, and repeats no value the job holds', async () => {
    const { jobId } = await job();
    await saveCustomer(jobId, '12 Synthetic Lane, Testville');
    await saveClaim(jobId, { carrier: 'Synthetic Mutual' });
    const rows = await everything(h.admin);
    const drafts = JSON.stringify(h.field.data());
    const answer = await readiness(OWNER_A, jobId);
    expect(answer.status).toBe(200);
    expect(await everything(h.admin)).toBe(rows);
    expect(JSON.stringify(h.field.data())).toBe(drafts);
    for (const value of ['Synthetic Lane', 'Synthetic Mutual', 'Casey', 'Kitchen', 'Do not repeat', 'Category 2 water']) expect(JSON.stringify(answer.body)).not.toContain(value);
  });

  it('reads the saved address and a part-filled claim, by key only, with an entered deductible of 0 counted', async () => {
    const { jobId } = await job();
    await saveCustomer(jobId, '12 Synthetic Lane, Testville');
    await saveClaim(jobId, { carrier: 'Synthetic Mutual', claimNumber: 'C-1', deductible: '0' });
    const answer = await readiness(ESTIMATOR_A, jobId);
    expect(answer.body.jobRevision).toBe(3);
    expect(codes(answer.body)).toEqual([
      ...JOB_GAPS.filter((code) => code !== 'propertyAddress' && code !== 'prices' && code !== 'scopeConfirmed'),
      'claim:policyNumber',
      'claim:dateOfLoss',
      'claim:lossCause',
      'claim:adjusterName',
      'claim:adjusterEmail',
      'claim:adjusterPhone',
      'prices',
      'scopeConfirmed',
    ]);
  });

  it('counts a tagged photo only once its photo is stored, and an untagged one never', async () => {
    const { jobId, draftId, photoId, manifest } = await job();
    const unsent = randomUUID();
    const untagged = randomUUID();
    h.field.put(h.seed.a, draftId, {
      ...manifest,
      photos: [...manifest.photos, { id: unsent, field: { roomId: 'kitchen', shotTag: 'surface' } }, { id: untagged, field: { roomId: 'kitchen' } }],
    });
    expect(codes((await readiness(OWNER_A, jobId)).body)).toContain('kitchen:shot:surface');
    expect((await f.sendPhoto(ESTIMATOR_A, jobId, unsent, image(unsent))).status).toBe(201);
    expect((await f.sendPhoto(ESTIMATOR_A, jobId, untagged, image(untagged))).status).toBe(201);
    const after = codes((await readiness(OWNER_A, jobId)).body);
    expect(after).not.toContain('kitchen:shot:surface');
    expect(after).toContain('kitchen:shot:meter');
    expect(photoId).toBeTruthy();
  });

  it('takes the area basis from the published prices, and tells a version it cannot read from none', async () => {
    const { jobId } = await job();
    await publish({ wetFloor: true });
    // Priced by wet floor area: the hall's floor area is its basis, so no demolition area is asked for.
    const wet = codes((await readiness(OWNER_A, jobId)).body);
    expect(wet).not.toContain('hall:demolitionArea');
    expect(wet).not.toContain('prices');
    await publish({ badHash: true });
    const unreadable = await readiness(OWNER_A, jobId);
    expect(unreadable.status).toBe(200);
    expect(unreadable.body.unavailable).toEqual(['roomArea', 'setupReadings', 'ocr', 'prices']);
    expect(codes(unreadable.body)).not.toContain('prices');
    expect(codes(unreadable.body)).not.toContain('hall:demolitionArea');
  });

  it('asks the drying log seam for the setup reading, and claims a missing one only when it says absent', async () => {
    const { jobId } = await job();
    const asked: string[] = [];
    live.readings = { setupReading: async (_tx, companyId, id) => (asked.push(`${companyId}/${id}`), 'absent') };
    expect(codes((await readiness(OWNER_A, jobId)).body)).toContain('setupReadings');
    expect(asked).toEqual([`${h.seed.a}/${jobId}`]);
    live.readings = { setupReading: async () => 'present' };
    const present = (await readiness(OWNER_A, jobId)).body;
    expect(codes(present)).not.toContain('setupReadings');
    expect(present.unavailable).toEqual(['roomArea', 'ocr']);
  });

  it('counts a scope confirmation made before an owner reprice as not confirmed, as the estimate does', async () => {
    const { jobId, draftId, manifest } = await job();
    h.field.put(h.seed.a, draftId, { ...manifest, draft: { ...(manifest.draft as object), scopeConfirmed: true } });
    await publish();
    await publish();
    const versions = await h.admin<{ id: string; sequence: number }[]>`SELECT id::text, sequence FROM price_table_versions WHERE company_id = ${h.seed.a} ORDER BY sequence`;
    const pin = (sequence: number, reason: string) =>
      h.admin`INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id) VALUES (${h.seed.a}, ${jobId}, ${sequence}, ${versions[sequence - 1]!.id}, ${reason}, ${h.seed.ownerA.actor})`;
    await pin(1, 'first_price');
    expect(codes((await readiness(OWNER_A, jobId)).body)).not.toContain('scopeConfirmed');
    // The owner's reprice of this very draft (as POST /api/jobs/{id}/reprice records it).
    await pin(2, 'owner_reprice');
    await h.admin`
      INSERT INTO audit_events (company_id, actor_id, action, target, details)
      VALUES (${h.seed.a}, ${h.seed.ownerA.actor}, 'job_repriced', ${jobId}, ${JSON.stringify({ sequence: '2', job_draft: draftId })}::text::jsonb)
    `;
    expect(codes((await readiness(OWNER_A, jobId)).body)).toContain('scopeConfirmed');
  });

  it('reads a draft made before drafts carried their job id once Postgres holds it for the job', async () => {
    const { jobId, draftId } = await job();
    h.field.unstamp(h.seed.a, draftId);
    expect((await readiness(OWNER_A, jobId)).body.status).toBe('checked');
  });
});

describe('GET /api/jobs/{jobId}/readiness: no gaps to give', () => {
  it('says the draft is not editing while it is fenced, and after Submit', async () => {
    const { jobId, draftId, manifest } = await job();
    h.field.lock(h.seed.a, draftId, 'submitting');
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'not_editing' } });
    h.field.lock(h.seed.a, draftId, 'editing');
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'not_editing' } });
  });

  it('gives no gaps for a job that changed while its draft was read, nor to a caller who lost the job meanwhile', async () => {
    const { jobId } = await job();
    live.reader!.during = () => saveCustomer(jobId, '12 Synthetic Lane, Testville');
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'draft_changed' } });
    const assignmentId = randomUUID();
    const assigned = await assignmentsRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/assignments`, { method: 'POST', body: { id: assignmentId, estimatorActorId: estimatorA2 } }), params({ jobId }));
    expect(assigned.status).toBe(201);
    live.reader!.during = async () => {
      const ended = await assignmentRoute.DELETE(request(OWNER_A, `/api/jobs/${jobId}/assignments/${assignmentId}`, { method: 'DELETE' }), params({ jobId, assignmentId }));
      expect(ended.status).toBe(200);
    };
    expect(await readiness(ESTIMATOR_A2, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  it('gives no gaps for a draft it cannot read as the field map, or one that names another job', async () => {
    const { jobId, draftId, manifest } = await job();
    h.field.put(h.seed.a, draftId, { ...manifest, draft: { ...(manifest.draft as object), roomOrder: ['kitchen'] } });
    expect((await readiness(OWNER_A, jobId)).body).toEqual({ status: 'unavailable', jobId, reason: 'draft_unreadable' });
    const other = await job();
    await h.admin`DELETE FROM job_drafts WHERE draft_id = ${other.draftId}`;
    await h.admin`INSERT INTO job_drafts (company_id, draft_id, job_id) VALUES (${h.seed.a}, ${other.draftId}, ${jobId})`;
    h.field.unstamp(h.seed.a, other.draftId);
    expect((await readiness(OWNER_A, other.jobId)).body).toEqual({ status: 'unavailable', jobId: other.jobId, reason: 'draft_unreadable' });
  });

  it('answers unavailable, with fixed log text, while the field database cannot be read', async () => {
    const { jobId } = await job();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    live.reader!.fail = true;
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'field_unavailable' } });
    expect(errors.mock.calls).toEqual([['readiness field read unavailable', 'Error']]);
    errors.mockRestore();
  });
});

describe('Submit never depends on readiness', () => {
  it('submits a draft with gaps exactly as before, and the check is never consulted', async () => {
    const { jobId, draftId, manifest } = await job();
    expect((await readiness(OWNER_A, jobId)).body.ready).toBe(false);
    const reads = live.reader!.reads;
    const { answer } = await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    expect(answer.status).toBe(201);
    expect(answer.body.submission).toMatchObject({ draftId, status: 'committed' });
    expect(live.reader!.reads).toBe(reads);
    expect(await f.expectOneOutcome(h.seed.a, jobId, draftId)).toBe('committed');
  });

  it('submits while readiness is down, and Submit’s own checks still refuse what they refused', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { jobId, draftId, manifest } = await job();
    live.reader!.fail = true;
    expect((await readiness(OWNER_A, jobId)).body.reason).toBe('field_unavailable');
    live.down = true;
    expect((await readiness(OWNER_A, jobId)).body.reason).toBe('field_unavailable');
    // Submit's digest and field-owner rules are unchanged by any of it.
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, { ...manifest, draft: { ...(manifest.draft as object), yearBuilt: 1999 } })).answer).toMatchObject({ status: 409 });
    expect((await f.submitShown(OWNER_A, jobId, draftId, manifest)).answer.status).toBe(403);
    expect((await f.submitShown(ESTIMATOR_A, jobId, draftId, manifest)).answer.status).toBe(201);
    errors.mockRestore();
  });
});

describe('GET /api/jobs/{jobId}/readiness: the second Postgres read decides', () => {
  it('refuses a company suspended while the draft was read, and a switch turned off meanwhile', async () => {
    const { jobId } = await job();
    live.reader!.during = async () => {
      await h.admin`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}`;
    };
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 403, body: { error: 'company_inactive' } });
    await h.admin`UPDATE companies SET status = 'active' WHERE id = ${h.seed.a}`;
    live.reader!.during = async () => {
      await h.admin`UPDATE company_feature_flags SET enabled = false WHERE company_id = ${h.seed.a} AND flag = 'readiness'`;
    };
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  // A draft the check cannot read as the field map gives no gaps, but only once Postgres agrees.
  const unreadable = async () => {
    const made = await job();
    h.field.put(h.seed.a, made.draftId, { ...made.manifest, draft: { ...(made.manifest.draft as object), roomOrder: ['kitchen'] } });
    return made;
  };

  it('answers 410 for a job archived while its draft was read, whatever the read gave', async () => {
    const { jobId } = await unreadable();
    live.reader!.during = async () => {
      const archived = await archiveRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: await revision(jobId), changeId: randomUUID() } }), params({ jobId }));
      expect(archived.status).toBe(200);
    };
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 410, body: { error: 'archived' } });
  });

  it('says changed when the first price version is published while the draft is read, whatever the read gave', async () => {
    const { jobId } = await unreadable();
    live.reader!.during = () => publish();
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'draft_changed' } });
  });
});

describe('GET /api/jobs/{jobId}/readiness: round 2 rules', () => {
  // Submit's intent row is committed before its fence closes (src/lib/submissions/service.ts), and the job's
  // draft sync closes it (since the draft life-cycle redesign's slice 4a): hold that sync, so Postgres has a
  // pending submission while the field draft still says editing.
  async function heldSubmit(jobId: string, draftId: string, manifest: FieldManifest) {
    const hold = latch();
    h.field.gate.sync = () => hold.wait;
    const submit = f.submitShown(ESTIMATOR_A, jobId, draftId, manifest);
    await until(async () => (await f.submissions(jobId)).some((row) => row.status === 'pending'), 'the pending submission');
    expect(h.field.draft(h.seed.a, draftId)?.state).toBe('editing');
    return { release: async () => (hold.open(), (await submit).answer.status) };
  }

  it('answers not editing while a Submit of the draft is pending, before and during the read', async () => {
    const { jobId, draftId, manifest } = await job();
    const held = await heldSubmit(jobId, draftId, manifest);
    expect(await readiness(OWNER_A, jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId, reason: 'not_editing' } });
    expect(await held.release()).toBe(201);

    const other = await job();
    let during: Awaited<ReturnType<typeof heldSubmit>> | null = null;
    live.reader!.during = async () => {
      during = await heldSubmit(other.jobId, other.draftId, other.manifest);
    };
    expect(await readiness(OWNER_A, other.jobId)).toEqual({ status: 200, body: { status: 'unavailable', jobId: other.jobId, reason: 'not_editing' } });
    expect(await during!.release()).toBe(201);
  });

  it('refuses office with 403 on an archived and a missing job, and a member made office during the read', async () => {
    const { jobId } = await job();
    const archived = await archiveRoute.POST(request(OWNER_A, `/api/jobs/${jobId}/archive`, { method: 'POST', body: { revision: await revision(jobId), changeId: randomUUID() } }), params({ jobId }));
    expect(archived.status).toBe(200);
    expect(await readiness(OFFICE_A, jobId)).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await readiness(OFFICE_A, randomUUID())).toEqual({ status: 403, body: { error: 'not_allowed' } });
    const live2 = await job();
    live.reader!.during = async () => {
      await h.admin`UPDATE memberships SET role = 'office' WHERE id = ${h.seed.estimatorA.membership}`;
    };
    expect(await readiness(ESTIMATOR_A, live2.jobId)).toEqual({ status: 403, body: { error: 'not_allowed' } });
  });

  it('reads prices published for another engine as unavailable, pinned or current', async () => {
    const { jobId } = await job();
    await publish({ engine: 'dryscope-v2' });
    const current = await readiness(OWNER_A, jobId);
    expect(current.body.unavailable).toEqual(['roomArea', 'setupReadings', 'ocr', 'prices']);
    expect(codes(current.body)).not.toContain('prices');
    await publish();
    expect((await readiness(OWNER_A, jobId)).body.unavailable).toEqual(['setupReadings', 'ocr']);
    const [old] = await h.admin<{ id: string }[]>`SELECT id::text FROM price_table_versions WHERE company_id = ${h.seed.a} AND sequence = 1`;
    await h.admin`INSERT INTO job_price_pins (company_id, job_id, sequence, version_id, reason, pinned_by_actor_id) VALUES (${h.seed.a}, ${jobId}, 1, ${old!.id}, 'first_price', ${h.seed.ownerA.actor})`;
    expect((await readiness(OWNER_A, jobId)).body.unavailable).toEqual(['roomArea', 'setupReadings', 'ocr', 'prices']);
  });
});
