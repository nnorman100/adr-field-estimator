import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany } from '@/db/tenant';
import { signedRecordBytes, SIGNED_FORMAT, type SignedRecord } from '@/lib/agreements/record';
import { PROPOSAL_FORMAT, type Proposal } from '@/lib/estimates/proposal';
import { canonicalJson } from '@/lib/field/canonical';
import { APP_DIR, handlersOf, routeModules } from './isolation-matrix';
import { newEvidence, newJob, photoName, seedEvidence, seedJob } from './job-harness';
import { agreementOf, bytesOf, insertAgreement, newSubmission, seedCommitted, seedEstimate, seedPin, seedVersion } from './submission-harness';
import { json } from './submission-flow';
import type { FakeClaims, Harness } from './team-harness';

// S5b-5, the platform operator's read-only support view of a company's jobs, through the real route
// files as the runtime role against a real Postgres: each view writes one audit row naming the
// operator, a refused request writes none, and no route under it can change a company's data. The
// evidence bucket is the in-memory stand-in (tests/db/evidence-fake.ts).
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/platform/support-services', async () => {
  const { supportJobsService } = await import('@/lib/platform/support-jobs');
  return { supportJobsServices: () => supportJobsService(live.harness!.handle.db, () => live.harness!.evidence) };
});

const listRoute = await import('@/app/api/platform/companies/[companyId]/jobs/route');
const jobRoute = await import('@/app/api/platform/companies/[companyId]/jobs/[jobId]/route');
const photoRoute = await import('@/app/api/platform/companies/[companyId]/jobs/[jobId]/photos/[photoId]/route');
const { everything, operatorClaims, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
const { supportJobsService } = await import('@/lib/platform/support-jobs');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

const OWNER_A: FakeClaims = { tenant: 'tenant-a', uid: 'owner-a' };
const OPERATOR = operatorClaims();
// A 1x1 JPEG and a 1x1 PNG: real images, so the registry's hash, size and type are those of the bytes.
const BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);
const SIGNATURE_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const PLATFORM = '/api/platform/companies';
const list = (claims: FakeClaims | null, companyId: string, query = '') =>
  json(listRoute.GET(request(claims, `${PLATFORM}/${companyId}/jobs${query}`), params({ companyId })));
const view = (claims: FakeClaims | null, companyId: string, jobId: string) =>
  json(jobRoute.GET(request(claims, `${PLATFORM}/${companyId}/jobs/${jobId}`), params({ companyId, jobId })));
const photo = (claims: FakeClaims | null, companyId: string, jobId: string, photoId: string, query = '') =>
  photoRoute.GET(request(claims, `${PLATFORM}/${companyId}/jobs/${jobId}/photos/${photoId}${query}`), params({ companyId, jobId, photoId }));

type AuditRow = { company_id: string; actor_id: string | null; operator_actor_id: string | null; action: string; target: string; details: Record<string, unknown> };
const supportRows = () =>
  h.admin<AuditRow[]>`
    SELECT company_id::text, actor_id::text, operator_actor_id::text, action, target, details
    FROM audit_events WHERE action LIKE 'support_%' ORDER BY id
  `;
// Every row of every table but the audit log, to show a view changed nothing else.
const allButAudit = async () => {
  const dump = JSON.parse(await everything(h.admin)) as Record<string, unknown>;
  delete dump.audit_events;
  return JSON.stringify(dump);
};

// A job of company A with a customer, a claim, a photo whose bytes are in the bucket, and a signed
// agreement whose stored record is a real signed record (the proposal hash it states is the estimate's).
// A job as the table owner writes it: every job starts as a draft (migration 0010), then moves on.
async function jobIn(company: string, actor: string, status: 'draft' | 'archived', address: string) {
  const job = await seedJob(h.admin, newJob(company, actor, { address }));
  if (status === 'archived') {
    await h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${actor}, revision = revision + 1 WHERE id = ${job.id}`;
  }
  return job;
}

// A signature object as the receipt route leaves it: a registry row and its bytes in the bucket.
async function storedSignature(jobId: string, actor: string) {
  const objectId = randomUUID();
  const name = photoName(h.seed.a, jobId, objectId, 'signatures');
  const digest = sha256(SIGNATURE_BYTES);
  const [row] = await h.admin<{ id: string }[]>`
    INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
    VALUES (${h.seed.a}, ${jobId}, ${objectId}, 'signature', ${name}, 1731400000000000, ${digest}, ${SIGNATURE_BYTES.length}, 'image/png', ${actor})
    RETURNING id::text
  `;
  h.evidence.objects.set(name, { bytes: SIGNATURE_BYTES, contentType: 'image/png', sha256: digest, generation: 1731400000000000n });
  return { id: row!.id, objectId, sha256: digest, bytes: SIGNATURE_BYTES };
}

async function signedJob(address = '12 Synthetic Way') {
  const actor = h.seed.ownerA.actor;
  const job = await jobIn(h.seed.a, actor, 'draft', address);
  await h.admin`INSERT INTO job_customers (company_id, job_id, name, phone, email) VALUES (${h.seed.a}, ${job.id}, 'Pat Customer', '555-0100', 'pat@example.test')`;
  await h.admin`INSERT INTO job_claims (company_id, job_id, carrier, claim_number, date_of_loss) VALUES (${h.seed.a}, ${job.id}, 'Carrier Co', 'CLM-1', '2026-11-01')`;
  const shot = newEvidence(h.seed.a, job.id, actor, { generation: 1_731_400_000_000_001, size: BYTES.length, sha: sha256(BYTES), type: 'image/jpeg' });
  await seedEvidence(h.admin, shot);
  h.evidence.objects.set(photoName(h.seed.a, job.id, shot.objectId), { bytes: BYTES, contentType: 'image/jpeg', sha256: sha256(BYTES), generation: 1_731_400_000_000_001n });

  const proposal = { format: PROPOSAL_FORMAT, heading: 'Synthetic proposal' } as unknown as Proposal;
  const proposalBytes = bytesOf(canonicalJson(proposal));
  const version = await seedVersion(h.admin, h.seed.a, actor);
  const submission = await seedCommitted(h.admin, newSubmission(h.seed.a, job.id, actor));
  const pin = await seedPin(h.admin, { company: h.seed.a, job: job.id, version: version.id, actor });
  const estimate = await seedEstimate(h.admin, { company: h.seed.a, job: job.id, submission: submission.id, pin, actor, hash: version.hash, proposal: proposalBytes });
  const signature = await storedSignature(job.id, actor);
  const orphan = await storedSignature(job.id, actor);
  const agreementId = randomUUID();
  const record: SignedRecord = {
    format: SIGNED_FORMAT,
    agreement_id: agreementId,
    job_id: job.id,
    kind: 'original',
    signed_at: new Date().toISOString(),
    signer: { name: 'Pat Customer' },
    signed_with: { kind: 'device', presented_by: { actor_id: actor, name: 'Owner A' } },
    signature: { id: signature.objectId, sha256: signature.sha256, content_type: 'image/png' },
    proposal_sha256: proposalBytes.sha,
    proposal,
    documents: { itemized_claim: [], letter: 'Synthetic letter.', photo_log: [], claim: {}, compliance_notes: [] },
    basis: { estimate_id: estimate.id, submission_id: submission.id },
  };
  const chain = { company: h.seed.a, actor, job, version, submission, pin, estimate, signature: signature.id };
  await withCompany(h.handle.db, h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain, { id: agreementId, documents: signedRecordBytes(record) })));
  await h.admin`UPDATE jobs SET status = 'signed', revision = revision + 1 WHERE id = ${job.id}`;
  return { jobId: job.id, photoId: shot.objectId, agreementId, address, signature, orphan };
}

describe('the operator’s support view of a company’s jobs', () => {
  it('lists every job of the company, archived ones too, in pages, with one audit row per view', async () => {
    const { jobId: signed } = await signedJob();
    const archived = await jobIn(h.seed.a, h.seed.ownerA.actor, 'archived', '3 Archived Lane');
    const other = await jobIn(h.seed.b, h.seed.ownerB.actor, 'draft', '99 Other Company Road');

    const first = await list(OPERATOR, h.seed.a, '?limit=1');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ company: { id: h.seed.a } });
    expect(first.body.jobs).toHaveLength(1);
    const second = await list(OPERATOR, h.seed.a, `?limit=1&cursor=${first.body.nextCursor as string}`);
    const ids = [...(first.body.jobs as { id: string }[]), ...(second.body.jobs as { id: string }[])].map((job) => job.id);
    expect(ids.sort()).toEqual([signed, archived.id].sort());
    expect(second.body.nextCursor).toBeNull();
    expect(JSON.stringify([first.body, second.body])).not.toContain(other.id);
    expect(JSON.stringify([first.body, second.body])).not.toContain('99 Other Company Road');

    expect(await supportRows()).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_jobs_viewed', target: h.seed.a, details: {} },
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_jobs_viewed', target: h.seed.a, details: {} },
    ]);
  });

  it('shows one job with its customer, claim, signed agreement and evidence, never an object path, with one audit row', async () => {
    const { jobId, photoId, agreementId, address, signature, orphan } = await signedJob();
    const answer = await view(OPERATOR, h.seed.a, jobId);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      company: { id: h.seed.a },
      job: { id: jobId, status: 'signed', propertyAddress: address },
      customer: { name: 'Pat Customer', phone: '555-0100', email: 'pat@example.test' },
      claim: { carrier: 'Carrier Co', claimNumber: 'CLM-1' },
      agreement: { id: agreementId, jobId, record: { agreement_id: agreementId, signer: { name: 'Pat Customer' }, signature: { id: signature.objectId, sha256: signature.sha256 } } },
    });
    // The signature of the committed agreement is listed; one received for no agreement is not.
    const evidence = answer.body.evidence as { photoId: string; kind: string; sha256: string }[];
    expect(evidence.map((found) => [found.kind, found.photoId])).toEqual([
      ['photo', photoId],
      ['signature', signature.objectId],
    ]);
    expect(evidence[1]!.sha256).toBe(signature.sha256);
    expect(JSON.stringify(answer.body)).not.toContain(orphan.objectId);
    expect(JSON.stringify(answer.body)).not.toContain('companies/');
    expect(await supportRows()).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_job_viewed', target: jobId, details: {} },
    ]);
  });

  it('answers a photo’s bytes as the image they are, with one audit row naming the photo', async () => {
    const { jobId, photoId } = await signedJob();
    const answer = await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('image/jpeg');
    expect(answer.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array(BYTES));
    expect(await supportRows()).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_photo_viewed', target: jobId, details: { photoId, kind: 'photo' } },
    ]);
  });

  it('answers the signature the signed agreement names, with one audit row, and hides one no agreement names', async () => {
    const { jobId, orphan } = await signedJob();
    const shown = await view(OPERATOR, h.seed.a, jobId);
    const named = (shown.body.agreement as { record: { signature: { id: string } } }).record.signature.id;
    const answer = await photo(OPERATOR, h.seed.a, jobId, named, '?kind=signature');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(new Uint8Array(SIGNATURE_BYTES));
    expect((await supportRows()).filter((row) => row.action === 'support_photo_viewed')).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_photo_viewed', target: jobId, details: { photoId: named, kind: 'signature' } },
    ]);

    const before = (await supportRows()).length;
    expect((await photo(OPERATOR, h.seed.a, jobId, orphan.objectId, '?kind=signature')).status).toBe(404);
    expect(await supportRows()).toHaveLength(before);
  });

  it('writes no audit row when the bucket fails while the bytes are read', async () => {
    const { jobId, photoId } = await signedJob();
    const open = h.evidence.open;
    h.evidence.open = async () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('media request failed'));
        },
      }) as never;
    try {
      expect((await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo')).status).toBe(503);
    } finally {
      h.evidence.open = open;
    }
    expect(await supportRows()).toEqual([]);
  });

  it('answers 503 and writes no audit row when the bytes disagree with the registered size or hash', async () => {
    const { jobId, photoId } = await signedJob();
    const [registered] = await h.admin<{ object_name: string }[]>`SELECT object_name FROM evidence_objects WHERE object_id = ${photoId}`;
    const held = h.evidence.objects.get(registered!.object_name)!;
    for (const bytes of [BYTES.subarray(0, BYTES.length - 1), Buffer.concat([BYTES, Buffer.from([0])]), Buffer.from(BYTES.map((byte, at) => (at === BYTES.length - 1 ? byte ^ 1 : byte)))].map((bytes) => new Uint8Array(bytes))) {
      h.evidence.objects.set(registered!.object_name, { ...held, bytes });
      expect((await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo')).status).toBe(503);
    }
    h.evidence.objects.set(registered!.object_name, { ...held, bytes: new Uint8Array(0) });
    expect((await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo')).status).toBe(503);
    expect(await supportRows()).toEqual([]);
  });

  it('answers 400 and writes no audit row for a cursor with an impossible date', async () => {
    const cursor = Buffer.from(`2026-02-30 12:00:00+00|${randomUUID()}`).toString('base64url');
    const answer = await list(OPERATOR, h.seed.a, `?cursor=${cursor}`);
    expect(answer.status).toBe(400);
    expect(await supportRows()).toEqual([]);
  });

  it('refuses HEAD on all three routes with 405 and writes no audit row', async () => {
    const { jobId, photoId } = await signedJob();
    const head = (path: string, ids: Record<string, string>, handler: typeof listRoute.GET) =>
      handler(request(OPERATOR, path, { method: 'HEAD' }), params(ids));
    const answers = [
      await head(`${PLATFORM}/${h.seed.a}/jobs`, { companyId: h.seed.a }, listRoute.GET),
      await head(`${PLATFORM}/${h.seed.a}/jobs/${jobId}`, { companyId: h.seed.a, jobId }, jobRoute.GET),
      await head(`${PLATFORM}/${h.seed.a}/jobs/${jobId}/photos/${photoId}?kind=photo`, { companyId: h.seed.a, jobId, photoId }, photoRoute.GET),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([405, 405, 405]);
    expect(await supportRows()).toEqual([]);
  });

  it('needs no evidence bucket for the list or the job view', async () => {
    const { jobId } = await signedJob();
    const noBucket = supportJobsService(h.handle.db, () => {
      throw new Error('no evidence bucket');
    });
    expect((await noBucket.jobs(h.seed.operator, h.seed.a, { limit: 10, cursor: null })).jobs).toHaveLength(1);
    expect((await noBucket.job(h.seed.operator, h.seed.a, jobId)).job.id).toBe(jobId);
  });

  it('writes no audit row and changes nothing for a refused request', async () => {
    const { jobId, photoId } = await signedJob();
    const otherJob = await seedJob(h.admin, newJob(h.seed.b, h.seed.ownerB.actor));
    const before = await everything(h.admin);
    const unknown = randomUUID();
    const refused: [string, number][] = [];
    const record = async (what: string, answer: Response | Promise<Response> | { status: number }) => refused.push([what, (await answer).status]);
    // Not an operator: no sign-in, then the company's own owner.
    await record('list, no sign-in', await list(null, h.seed.a));
    await record('job, owner', await view(OWNER_A, h.seed.a, jobId));
    await record('photo, owner', photo(OWNER_A, h.seed.a, jobId, photoId, '?kind=photo'));
    // Not this company's record, or no record at all.
    await record('list, unknown company', await list(OPERATOR, unknown));
    await record('job of company B under company A', await view(OPERATOR, h.seed.a, otherJob.id));
    await record('job of company A under company B', await view(OPERATOR, h.seed.b, jobId));
    await record('photo under company B', photo(OPERATOR, h.seed.b, jobId, photoId, '?kind=photo'));
    await record('unregistered photo', photo(OPERATOR, h.seed.a, jobId, unknown, '?kind=photo'));
    await record('photo as an original it is not', photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=original'));
    // A bad request.
    await record('list with a scope', await list(OPERATOR, h.seed.a, '?scope=archived'));
    await record('list with a forged cursor', await list(OPERATOR, h.seed.a, '?cursor=bm90LWEtY3Vyc29y'));
    await record('photo of an unknown kind', photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=thumbnail'));
    await record('photo with no kind', photo(OPERATOR, h.seed.a, jobId, photoId));
    await record('photo with two kinds', photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo&kind=original'));
    expect(refused).toEqual([
      ['list, no sign-in', 401],
      ['job, owner', 403],
      ['photo, owner', 403],
      ['list, unknown company', 404],
      ['job of company B under company A', 404],
      ['job of company A under company B', 404],
      ['photo under company B', 404],
      ['unregistered photo', 404],
      ['photo as an original it is not', 404],
      ['list with a scope', 400],
      ['list with a forged cursor', 400],
      ['photo of an unknown kind', 400],
      ['photo with no kind', 400],
      ['photo with two kinds', 400],
    ]);
    // A registered photo the bucket does not hold is a fault, and writes no audit row either.
    h.evidence.objects.clear();
    expect((await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo')).status).toBe(503);
    expect(await everything(h.admin)).toBe(before);
  });

  it('has no write path: every route under it is a read, and viewing changes nothing but the audit log', async () => {
    const modules = await routeModules(join(APP_DIR, 'api/platform/companies/[companyId]/jobs'));
    expect(handlersOf(modules).map((found) => `${found.method} ${found.route}`).sort()).toEqual(['GET ', 'GET [jobId]', 'GET [jobId]/photos/[photoId]']);
    const { jobId, photoId } = await signedJob();
    const before = await allButAudit();
    expect((await list(OPERATOR, h.seed.a)).status).toBe(200);
    expect((await view(OPERATOR, h.seed.a, jobId)).status).toBe(200);
    expect((await photo(OPERATOR, h.seed.a, jobId, photoId, '?kind=photo')).status).toBe(200);
    expect(await allButAudit()).toBe(before);
  });
});
