import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeClaims, Harness } from './team-harness';

// S5a-5, the photo routes: the receipt for a photo and for its full-size original (one object and
// one registry row however often it is sent, other bytes under the same id refused, no new photo
// once the draft is no longer being edited, an original allowed after signing) and the read (no
// other company, and no other estimator, reaches the bytes), through the real route file as the
// runtime role against a real Postgres. The bucket and the draft's state are in-memory stand-ins
// (evidence-fake.ts); the real precondition is checked against the real bucket in S5a-12, and the
// Firestore reader in tests/emu/. See jobs-api.test.ts for the setup.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/jobs/services', () => ({ jobsServices: () => live.harness!.jobs }));
vi.mock('@/lib/photos/services', () => ({ photosServices: () => live.harness!.photos }));

const jobsRoute = await import('@/app/api/jobs/route');
const photoRoute = await import('@/app/api/jobs/[jobId]/photos/[photoId]/route');
const { MAX_PHOTO_BYTES } = await import('@/lib/photos/image');
const { MAX_PHOTO_REFS } = await import('@/lib/field/schema');
const { servedHeaders } = await import('../support/next-headers');
const { everything, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const ESTIMATOR_A: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const ESTIMATOR_A2: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a2' };
const OFFICE_A: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const OWNER_B: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };
const ESTIMATOR_B: FakeClaims = { tenant: 'tenant-b', uid: 'estimator-b' };

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  // A second active estimator in company A, to prove one estimator never reaches another's job.
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

// Bytes the server accepts as an image: its own first bytes decide, so each kind needs a real
// signature, and `seed` makes the rest differ.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const image = (seed: string, signature = PNG): Uint8Array => Uint8Array.from([...signature, ...Buffer.from(`synthetic image ${seed}`)]);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Receipt = { photoId: string; kind: string; sha256: string; sizeBytes: number; contentType: string; createdAt: string };
type Answer = { status: number; body: Receipt & { error?: string } };

async function json(response: Response | Promise<Response>): Promise<Answer> {
  const done = await response;
  expect(done.headers.get('cache-control')).toBe('no-store');
  return { status: done.status, body: (await done.json()) as Answer['body'] };
}

const put = (claims: FakeClaims | null, jobId: string, photoId: string, kind: string | null, bytes: Uint8Array | string, headers: Record<string, string> = {}) => {
  const built = request(claims, `/api/jobs/${jobId}/photos/${photoId}${kind === null ? '' : `?kind=${kind}`}`, { method: 'PUT', body: bytes });
  for (const [name, value] of Object.entries(headers)) built.headers.set(name, value);
  return json(photoRoute.PUT(built, params({ jobId, photoId })));
};
const sendPhoto = (claims: FakeClaims | null, jobId: string, photoId: string, bytes: Uint8Array) => put(claims, jobId, photoId, 'photo', bytes);
const sendOriginal = (claims: FakeClaims | null, jobId: string, photoId: string, bytes: Uint8Array, photoSha256: string) =>
  put(claims, jobId, photoId, 'original', bytes, { 'X-Photo-Sha256': photoSha256 });

const get = (claims: FakeClaims | null, jobId: string, photoId: string, query = '') =>
  photoRoute.GET(request(claims, `/api/jobs/${jobId}/photos/${photoId}${query}`), params({ jobId, photoId }));

async function newJob(claims: FakeClaims): Promise<{ jobId: string; draftId: string }> {
  const ids = { jobId: randomUUID(), draftId: randomUUID() };
  const made = await jobsRoute.POST(request(claims, '/api/jobs', { method: 'POST', body: { id: ids.jobId, draftId: ids.draftId } }), params({}));
  expect(made.status).toBe(201);
  return ids;
}

const rows = () => h.admin`SELECT job_id, object_id, kind, object_name, sha256, size_bytes, content_type, created_by_actor_id FROM evidence_objects ORDER BY created_at, kind`;
const auditCount = async (action: string) => Number((await h.admin`SELECT count(*) AS n FROM audit_events WHERE action = ${action}`)[0]!.n);
const lockDraft = (companyId: string, draftId: string, state: string) => h.draftStates.set.set(`${companyId}/${draftId}`, state);

describe('storing a photo', () => {
  it('stores the bytes once under the job’s own path and answers the receipt', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const bytes = image('first');
    const sent = await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes);
    expect(sent.status).toBe(201);
    expect(sent.body).toEqual({
      photoId,
      kind: 'photo',
      sha256: sha256(bytes),
      sizeBytes: bytes.byteLength,
      contentType: 'image/png',
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    const name = `companies/${h.seed.a}/jobs/${jobId}/photos/${photoId}`;
    expect([...h.evidence.objects.keys()]).toEqual([name]);
    expect(h.evidence.objects.get(name)).toMatchObject({ sha256: sha256(bytes), contentType: 'image/png' });
    expect(await rows()).toEqual([
      { job_id: jobId, object_id: photoId, kind: 'photo', object_name: name, sha256: sha256(bytes), size_bytes: String(bytes.byteLength), content_type: 'image/png', created_by_actor_id: h.seed.estimatorA.actor },
    ]);
    // One audit row with ids and counts only.
    const audit = await h.admin`SELECT actor_id, target, details FROM audit_events WHERE action = 'photo_received'`;
    expect(audit).toEqual([{ actor_id: h.seed.estimatorA.actor, target: jobId, details: { kind: 'photo', sizeBytes: bytes.byteLength } }]);
  });

  it('answers the same receipt for the same photo sent twice, with one object and one row', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const bytes = image('twice');
    const first = await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes);
    const second = await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toEqual(first.body);
    expect(h.evidence.objects.size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await auditCount('photo_received')).toBe(1);
  });

  it('makes one object and one row when two requests for the same photo arrive at once', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const bytes = image('race');
    const both = await Promise.all([sendPhoto(ESTIMATOR_A, jobId, photoId, bytes), sendPhoto(ESTIMATOR_A, jobId, photoId, bytes)]);
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(both[0]!.body.sha256).toBe(both[1]!.body.sha256);
    expect(h.evidence.objects.size).toBe(1);
    expect(await rows()).toHaveLength(1);
    expect(await auditCount('photo_received')).toBe(1);
  });

  it('settles a lost answer by sending again: the stored bytes get their one row, with no second object', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const bytes = image('lost');
    // The bucket stored the bytes and the answer never came back: no registry row was made.
    h.evidence.failNext = { on: true, afterWrite: true };
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes)).status).toBe(503);
    expect(h.evidence.objects.size).toBe(1);
    expect(await rows()).toEqual([]);
    // Sent again: the object is there with these bytes (the 412 path), so it is registered.
    const again = await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes);
    expect(again.status).toBe(201);
    expect(h.evidence.objects.size).toBe(1);
    expect(h.evidence.creates).toHaveLength(2);
    expect(await rows()).toHaveLength(1);
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes)).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it('refuses other bytes under the same photo id with 409 and changes nothing', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const first = image('one');
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, first)).status).toBe(201);
    const before = await everything(h.admin);
    const other = await sendPhoto(ESTIMATOR_A, jobId, photoId, image('two'));
    expect(other).toEqual({ status: 409, body: { error: 'photo_conflict' } });
    expect(await everything(h.admin)).toBe(before);
    expect(h.evidence.objects.size).toBe(1);
    expect(h.evidence.objects.get(`companies/${h.seed.a}/jobs/${jobId}/photos/${photoId}`)!.sha256).toBe(sha256(first));
    // A different type of image is other bytes too.
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, image('one', JPEG))).status).toBe(409);
  });

  it('refuses other bytes under an id whose object is stored but not yet registered, and registers nothing', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    h.evidence.failNext = { on: true, afterWrite: true };
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, image('stored'))).status).toBe(503);
    const other = await sendPhoto(ESTIMATOR_A, jobId, photoId, image('different'));
    expect(other).toEqual({ status: 409, body: { error: 'photo_conflict' } });
    expect(await rows()).toEqual([]);
  });

  it('keeps a photo id per job: the same id on another job of the company is its own photo', async () => {
    const one = await newJob(ESTIMATOR_A);
    const two = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    expect((await sendPhoto(ESTIMATOR_A, one.jobId, photoId, image('a'))).status).toBe(201);
    expect((await sendPhoto(ESTIMATOR_A, two.jobId, photoId, image('b'))).status).toBe(201);
    expect(h.evidence.objects.size).toBe(2);
  });

  it('accepts a JPEG, a PNG and a WebP by what the bytes are, and answers with that type', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    for (const [signature, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']] as const) {
      const sent = await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image(type, signature));
      expect({ status: sent.status, type: sent.body.contentType }).toEqual({ status: 201, type });
    }
  });

  it('refuses bytes that are not an image, an empty body and a body over the limit, storing nothing', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const before = await everything(h.admin);
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), Buffer.from('<html>not a photo</html>'))).toEqual({ status: 415, body: { error: 'unsupported_image' } });
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), new Uint8Array(0))).toEqual({ status: 400, body: { error: 'invalid_request' } });
    // The declared length alone is enough to refuse, before a byte is read.
    const declared = await put(ESTIMATOR_A, jobId, randomUUID(), 'photo', image('x'), { 'Content-Length': String(MAX_PHOTO_BYTES + 1) });
    expect(declared).toEqual({ status: 413, body: { error: 'too_large' } });
    // And so is the running total of a body that says nothing true about its length.
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1);
    big.set(PNG);
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), big)).toEqual({ status: 413, body: { error: 'too_large' } });
    expect(await everything(h.admin)).toBe(before);
    expect(h.evidence.creates).toEqual([]);
  });

  it('takes a photo exactly at the limit', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const exact = new Uint8Array(MAX_PHOTO_BYTES);
    exact.set(PNG);
    const sent = await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), exact);
    expect({ status: sent.status, size: sent.body.sizeBytes }).toEqual({ status: 201, size: MAX_PHOTO_BYTES });
  });

  it('refuses a request with no kind, another kind or a repeated kind, and a photo id that is not a uuid', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    // `signature` is a kind since S5a-11 (tests/db/agreements-api.test.ts); its spelling is exact.
    for (const kind of [null, 'Signature', 'signatures', 'thumbnail', '']) {
      expect({ kind, ...(await put(ESTIMATOR_A, jobId, photoId, kind, image('k'))) }).toMatchObject({ kind, status: 400, body: { error: 'invalid_request' } });
    }
    // A signature on a job still being edited has no estimate to sign: refused, nothing stored.
    expect(await put(ESTIMATOR_A, jobId, photoId, 'signature', image('k'))).toMatchObject({ status: 409, body: { error: 'not_ready_to_sign' } });
    const twice = request(ESTIMATOR_A, `/api/jobs/${jobId}/photos/${photoId}?kind=photo&kind=original`, { method: 'PUT', body: image('k') });
    expect((await json(photoRoute.PUT(twice, params({ jobId, photoId })))).status).toBe(400);
    expect((await sendPhoto(ESTIMATOR_A, jobId, 'not-a-uuid', image('k'))).status).toBe(400);
    expect((await sendPhoto(ESTIMATOR_A, 'not-a-uuid', photoId, image('k'))).status).toBe(404);
    expect(h.evidence.creates).toEqual([]);
  });
});

describe('a photo and the draft', () => {
  it('refuses a new photo while the draft is being submitted or once it was, and stores nothing', async () => {
    const { jobId, draftId } = await newJob(ESTIMATOR_A);
    const before = await everything(h.admin);
    for (const state of ['submitting', 'submitted', 'unknown']) {
      lockDraft(h.seed.a, draftId, state);
      expect({ state, ...(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image(state))) }).toMatchObject({ state, status: 409, body: { error: 'draft_locked' } });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.evidence.creates).toEqual([]);
  });

  it('takes photos again once the draft is back to editing', async () => {
    const { jobId, draftId } = await newJob(ESTIMATOR_A);
    lockDraft(h.seed.a, draftId, 'submitting');
    expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('locked'))).status).toBe(409);
    lockDraft(h.seed.a, draftId, 'editing');
    expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('open'))).status).toBe(201);
  });

  it('takes the photo that brings the draft to its cap, then refuses a new one and still settles a sent one', async () => {
    const { jobId, draftId } = await newJob(ESTIMATOR_A);
    const refs = (count: number) => h.draftStates.refs.set(`${h.seed.a}/${draftId}`, count);
    const last = { id: randomUUID(), bytes: image('three hundredth') };
    refs(MAX_PHOTO_REFS - 1);
    const kept = await sendPhoto(ESTIMATOR_A, jobId, last.id, last.bytes);
    expect(kept.status).toBe(201);
    // The phone writes its reference: the draft now holds the most it may.
    refs(MAX_PHOTO_REFS);
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('one too many'))).toEqual({ status: 409, body: { error: 'photo_limit' } });
    expect(h.evidence.objects.size).toBe(1);
    expect(await rows()).toHaveLength(1);
    // A lost answer for the photo already taken is settled by sending it again, at the cap too.
    const again = await sendPhoto(ESTIMATOR_A, jobId, last.id, last.bytes);
    expect(again).toEqual({ status: 200, body: kept.body });
    expect(await auditCount('photo_received')).toBe(1);
  });

  it('counts the photos the server stored, so the 301st is refused although the phone wrote no reference', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    for (let n = 0; n < MAX_PHOTO_REFS; n += 1) expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image(`stored ${n}`))).status).toBe(201);
    const creates = h.evidence.creates.length;
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('one too many'))).toEqual({ status: 409, body: { error: 'photo_limit' } });
    expect(h.evidence.creates).toHaveLength(creates);
    expect(await rows()).toHaveLength(MAX_PHOTO_REFS);
  }, 120_000);

  it('takes one of two new photos racing for the last place and leaves at most one object unregistered', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    for (let n = 0; n < MAX_PHOTO_REFS - 1; n += 1) expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image(`stored ${n}`))).status).toBe(201);
    // Both pass the first count and both store their bytes before either is registered.
    const create = h.evidence.create;
    let release!: () => void;
    const bothStored = new Promise<void>((resolve) => (release = resolve));
    let stored = 0;
    h.evidence.create = async (...args: Parameters<typeof create>) => {
      const made = await create(...args);
      stored += 1;
      if (stored === 2) release();
      await bothStored;
      return made;
    };
    const answers = await Promise.all([sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('racer one')), sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('racer two'))]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
    expect(answers.find((answer) => answer.status === 409)!.body).toEqual({ error: 'photo_limit' });
    expect(await rows()).toHaveLength(MAX_PHOTO_REFS);
    expect(h.evidence.objects.size).toBeLessThanOrEqual(MAX_PHOTO_REFS + 1);
  }, 120_000);

  it('refuses a new photo for a job that is no longer a draft, whatever the draft says', async () => {
    for (const status of ['submitted', 'signed']) {
      const { jobId } = await newJob(ESTIMATOR_A);
      await h.admin`UPDATE jobs SET status = ${status}, revision = revision + 1 WHERE id = ${jobId}`;
      expect({ jobStatus: status, ...(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image(status))) }).toMatchObject({ jobStatus: status, status: 409, body: { error: 'draft_locked' } });
    }
    expect(h.evidence.creates).toEqual([]);
  });

  it('answers 503 when the draft cannot be read or is not there, and stores nothing', async () => {
    const { jobId, draftId } = await newJob(ESTIMATOR_A);
    h.draftStates.fail = true;
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('a'))).toEqual({ status: 503, body: { error: 'photos_unavailable' } });
    h.draftStates.fail = false;
    h.drafts.made.delete(`${h.seed.a}/${draftId}`);
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('b'))).toEqual({ status: 503, body: { error: 'photos_unavailable' } });
    expect(h.evidence.creates).toEqual([]);
  });

  it('still answers the receipt for a photo that was registered before the draft was locked', async () => {
    const { jobId, draftId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    const bytes = image('before');
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes)).status).toBe(201);
    lockDraft(h.seed.a, draftId, 'submitting');
    // A lost answer is settled by sending again, even after the fence: the phone learns the photo is
    // registered; its reference write is what the locked draft then refuses.
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, bytes)).status).toBe(200);
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, image('other'))).status).toBe(409);
    expect(h.evidence.objects.size).toBe(1);
  });

  it('answers 503 and registers nothing when the bucket cannot be reached, and works when sent again', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const photoId = randomUUID();
    h.evidence.failNext = { on: true, afterWrite: false };
    expect(await sendPhoto(ESTIMATOR_A, jobId, photoId, image('x'))).toEqual({ status: 503, body: { error: 'photos_unavailable' } });
    expect(await rows()).toEqual([]);
    expect((await sendPhoto(ESTIMATOR_A, jobId, photoId, image('x'))).status).toBe(201);
  });
});

describe('the full-size original', () => {
  async function registered(claims = ESTIMATOR_A) {
    const { jobId, draftId } = await newJob(claims);
    const photoId = randomUUID();
    const copy = image('copy');
    expect((await sendPhoto(claims, jobId, photoId, copy)).status).toBe(201);
    return { jobId, draftId, photoId, copyHash: sha256(copy) };
  }

  it('is stored beside its photo once, named by the photo’s hash, and the same bytes again are the same receipt', async () => {
    const { jobId, photoId, copyHash } = await registered();
    const original = image('original, larger', JPEG);
    const first = await sendOriginal(ESTIMATOR_A, jobId, photoId, original, copyHash);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ photoId, kind: 'original', sha256: sha256(original), sizeBytes: original.byteLength, contentType: 'image/jpeg' });
    expect((await sendOriginal(ESTIMATOR_A, jobId, photoId, original, copyHash)).status).toBe(200);
    expect(h.evidence.objects.size).toBe(2);
    expect([...h.evidence.objects.keys()].sort()).toEqual([
      `companies/${h.seed.a}/jobs/${jobId}/originals/${photoId}`,
      `companies/${h.seed.a}/jobs/${jobId}/photos/${photoId}`,
    ]);
    expect((await rows()).map((row) => row.kind)).toEqual(['photo', 'original']);
    expect(await auditCount('photo_original_received')).toBe(1);
    // Other bytes under the same id are a conflict.
    expect((await sendOriginal(ESTIMATOR_A, jobId, photoId, image('another original', JPEG), copyHash)).body).toEqual({ error: 'photo_conflict' });
    // The same bytes again, but naming another photo's hash, are a conflict too.
    expect(await sendOriginal(ESTIMATOR_A, jobId, photoId, original, sha256(image('some other photo')))).toEqual({ status: 409, body: { error: 'photo_conflict' } });
  });

  it('needs its photo in the registry with the hash it names', async () => {
    const { jobId, photoId, copyHash } = await registered();
    const original = image('original', JPEG);
    // No photo of that id.
    expect(await sendOriginal(ESTIMATOR_A, jobId, randomUUID(), original, copyHash)).toEqual({ status: 409, body: { error: 'photo_missing' } });
    // A photo that is registered, but not with that hash.
    expect(await sendOriginal(ESTIMATOR_A, jobId, photoId, original, sha256(image('some other photo')))).toEqual({ status: 409, body: { error: 'photo_conflict' } });
    // The photo's hash is required, and must look like one.
    expect((await put(ESTIMATOR_A, jobId, photoId, 'original', original)).status).toBe(400);
    expect((await put(ESTIMATOR_A, jobId, photoId, 'original', original, { 'X-Photo-Sha256': 'abc' })).status).toBe(400);
    expect([...h.evidence.objects.keys()].filter((name) => name.includes('/originals/'))).toEqual([]);
    expect((await rows()).map((row) => row.kind)).toEqual(['photo']);
  });

  it('ignores a proposal header, which only a signature carries', async () => {
    const { jobId, photoId, copyHash } = await registered();
    const sent = await put(ESTIMATOR_A, jobId, photoId, 'original', image('original', JPEG), { 'X-Photo-Sha256': copyHash, 'X-Proposal-Sha256': 'not a hash' });
    expect(sent.status).toBe(201);
  });

  it('may arrive after the job was signed and its draft locked, and changes nothing in the job', async () => {
    const { jobId, draftId, photoId, copyHash } = await registered();
    await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${jobId}`;
    lockDraft(h.seed.a, draftId, 'submitted');
    const jobBefore = await h.admin`SELECT * FROM jobs WHERE id = ${jobId}`;
    const late = await sendOriginal(ESTIMATOR_A, jobId, photoId, image('late original', JPEG), copyHash);
    expect(late.status).toBe(201);
    expect(await h.admin`SELECT * FROM jobs WHERE id = ${jobId}`).toEqual(jobBefore);
    // A new photo on the same job is still refused.
    expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('new'))).status).toBe(409);
  });
});

describe('who may send a photo', () => {
  it('lets the estimator who owns the job, and refuses the owner who does not own its field work and office with 403', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    expect((await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('e'))).status).toBe(201);
    const before = await everything(h.admin);
    expect(await sendPhoto(OWNER_A, jobId, randomUUID(), image('o'))).toEqual({ status: 403, body: { error: 'not_field_owner' } });
    expect(await sendPhoto(OFFICE_A, jobId, randomUUID(), image('office'))).toEqual({ status: 403, body: { error: 'not_allowed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('answers 404 to another estimator of the company and to the other company, with nothing stored', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    const before = await everything(h.admin);
    for (const claims of [ESTIMATOR_A2, OWNER_B, ESTIMATOR_B]) {
      expect(await sendPhoto(claims, jobId, randomUUID(), image('x'))).toEqual({ status: 404, body: { error: 'not_found' } });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.evidence.creates).toEqual([]);
  });

  it('answers 401 with no sign-in and 410 for an archived job', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    expect((await sendPhoto(null, jobId, randomUUID(), image('x'))).status).toBe(401);
    await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${jobId}`;
    expect(await sendPhoto(ESTIMATOR_A, jobId, randomUUID(), image('x'))).toEqual({ status: 410, body: { error: 'archived' } });
    expect(h.evidence.creates).toEqual([]);
  });

  it('does not read the body of a caller who has no right to the job', async () => {
    const { jobId } = await newJob(ESTIMATOR_A);
    let read = false;
    // No read-ahead: `pull` runs only when something reads the body.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          read = true;
          controller.enqueue(image('x'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const built = request(ESTIMATOR_B, `/api/jobs/${jobId}/photos/${randomUUID()}?kind=photo`, { method: 'PUT' });
    const streamed = new Request(built.url, { method: 'PUT', headers: built.headers, body: stream, duplex: 'half' } as RequestInit);
    expect((await photoRoute.PUT(streamed, params({ jobId, photoId: randomUUID() }))).status).toBe(404);
    expect(read).toBe(false);
  });
});

describe('reading a photo', () => {
  async function stored(claims = ESTIMATOR_A) {
    const { jobId } = await newJob(claims);
    const photoId = randomUUID();
    const copy = image('the photo itself');
    const original = image('the original itself', JPEG);
    expect((await sendPhoto(claims, jobId, photoId, copy)).status).toBe(201);
    expect((await sendOriginal(claims, jobId, photoId, original, sha256(copy))).status).toBe(201);
    return { jobId, photoId, copy, original };
  }
  const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  it('streams the photo and its original with the stored type, uncached and sniff-proof', async () => {
    const { jobId, photoId, copy, original } = await stored();
    for (const [query, bytes, type] of [['', copy, 'image/png'], ['?kind=photo', copy, 'image/png'], ['?kind=original', original, 'image/jpeg']] as const) {
      const response = await get(ESTIMATOR_A, jobId, photoId, query);
      expect({ query, status: response.status }).toEqual({ query, status: 200 });
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('content-security-policy')).toContain('sandbox');
      expect(Buffer.from(await bytesOf(response)).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it('reaches the browser with its own sandboxed policy, not the app-wide one, for the photo and the original', async () => {
    const { jobId, photoId } = await stored();
    for (const query of ['?kind=photo', '?kind=original']) {
      const sent = await servedHeaders(`/api/jobs/${jobId}/photos/${photoId}${query}`, await get(ESTIMATOR_A, jobId, photoId, query));
      expect({ query, csp: sent.get('content-security-policy') }).toEqual({ query, csp: "default-src 'none'; sandbox" });
      expect(sent.get('x-frame-options')).toBe('DENY');
      expect(sent.get('strict-transport-security')).toBe('max-age=31536000');
    }
  });

  it('lets the owner and office read a job’s photos, and no other estimator', async () => {
    const { jobId, photoId, copy } = await stored();
    for (const claims of [OWNER_A, OFFICE_A, ESTIMATOR_A]) {
      const response = await get(claims, jobId, photoId);
      expect(response.status).toBe(200);
      expect(Buffer.from(await bytesOf(response)).equals(Buffer.from(copy))).toBe(true);
    }
    const other = await get(ESTIMATOR_A2, jobId, photoId);
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'not_found' });
  });

  it('refuses company B the photo bytes and the original of company A, by A’s job and by its own', async () => {
    const a = await stored();
    const own = await newJob(OWNER_B);
    const bBefore = await everything(h.admin);
    for (const claims of [OWNER_B, ESTIMATOR_B]) {
      for (const query of ['', '?kind=photo', '?kind=original']) {
        // A's job and A's photo id.
        for (const target of [{ jobId: a.jobId, photoId: a.photoId }, { jobId: own.jobId, photoId: a.photoId }]) {
          const response = await get(claims, target.jobId, target.photoId, query);
          const text = await response.text();
          expect({ query, status: response.status, text }).toEqual({ query, status: 404, text: JSON.stringify({ error: 'not_found' }) });
          expect(response.headers.get('content-type')).not.toMatch(/^image\//);
        }
      }
    }
    expect(await everything(h.admin)).toBe(bBefore);
    // The same bytes are there for A: the refusal above was the access rule, not an empty store.
    expect((await get(OWNER_A, a.jobId, a.photoId, '?kind=original')).status).toBe(200);
  });

  it('answers 404 for a photo or an original that is not there, 400 for a bad kind, and 401 with no sign-in', async () => {
    const { jobId, photoId } = await newJob(ESTIMATOR_A).then((job) => ({ ...job, photoId: randomUUID() }));
    expect((await get(ESTIMATOR_A, jobId, photoId)).status).toBe(404);
    expect((await get(ESTIMATOR_A, jobId, photoId, '?kind=original')).status).toBe(404);
    expect((await get(ESTIMATOR_A, jobId, photoId, '?kind=signature')).status).toBe(404);
    expect((await get(ESTIMATOR_A, jobId, photoId, '?kind=thumbnail')).status).toBe(400);
    expect((await get(ESTIMATOR_A, jobId, 'not-a-uuid')).status).toBe(400);
    expect((await get(null, jobId, photoId)).status).toBe(401);
  });

  it('answers 410 for an archived job and 503, not 404, for a registered photo missing from the bucket', async () => {
    const { jobId, photoId } = await stored();
    h.evidence.objects.clear();
    expect(await (await get(ESTIMATOR_A, jobId, photoId)).json()).toEqual({ error: 'photos_unavailable' });
    h.evidence.failOpen = true;
    expect((await get(ESTIMATOR_A, jobId, photoId)).status).toBe(503);
    await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = revision + 1 WHERE id = ${jobId}`;
    expect((await get(ESTIMATOR_A, jobId, photoId)).status).toBe(410);
  });
});
