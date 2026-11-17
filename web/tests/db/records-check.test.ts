import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany, withOperator } from '@/db/tenant';
import type { CheckPage, FindingKind, RecordsCheckService } from '@/lib/records-check/service';
import type {
  DraftMark,
  DraftMarks,
  EvidenceObjects,
  ObjectStat,
} from '@/lib/records-check/stores';
import { digestOf, newEvidence, newJob, photoName, seedEvidence, seedJob } from './job-harness';
import {
  agreementOf,
  insertAgreement,
  newSubmission,
  seedChain,
  seedCommitted,
  seedSubmission,
} from './submission-harness';
import type { Harness } from './team-harness';

// S8-3: the records check after a restore, through the real route file as the runtime role on a
// server set up like a fresh Cloud SQL instance (team-harness.ts). The field drafts and the evidence
// bucket are in-memory stand-ins at the two store seams (src/lib/records-check/stores.ts); the real
// readers are checked in tests/emu/records-check-marks.test.ts and tests/unit/records-check-bucket.test.ts.
const live = vi.hoisted(() => ({
  harness: null as Harness | null,
  service: null as RecordsCheckService | null,
}));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/records-check/services', () => ({ recordsCheckServices: () => live.service! }));

const { everything, operatorClaims, owner, params, request, resetTeamDatabase, startTeamServer } =
  await import('./team-harness');
const { POST } = await import('@/app/api/platform/companies/[companyId]/records-check/route');
const { FINDINGS, PAGE_SIZES, recordsCheckService } = await import('@/lib/records-check/service');
type FakeClaims = import('./team-harness').FakeClaims;

// `fail` makes every store call throw an error that quotes a path, as an SDK error may.
type Stores = {
  drafts: Map<string, DraftMark>;
  // Each object name's generations, live and kept; a name with any generation is listed.
  objects: Map<string, Map<bigint, ObjectStat>>;
  fail: boolean;
  marks: DraftMarks;
  bucket: EvidenceObjects;
};

// The field drafts by "company/draft" and the bucket's objects by name and generation, ordered as
// Firestore and Cloud Storage order them (by id, by name).
function fakeStores(): Stores {
  const stores = { drafts: new Map(), objects: new Map(), fail: false } as unknown as Stores;
  stores.marks = {
    async marksOf(companyId, draftIds) {
      if (stores.fail)
        throw new Error(
          `field database unreachable at companies/${companyId}/drafts/${draftIds[0]}`,
        );
      const found = new Map<string, DraftMark>();
      for (const id of draftIds) {
        const mark = stores.drafts.get(`${companyId}/${id}`);
        if (mark) found.set(id, mark);
      }
      return found;
    },
    async page(companyId, after, limit) {
      const ids = [...stores.drafts.keys()]
        .filter((key) => key.startsWith(`${companyId}/`))
        .map((key) => key.slice(companyId.length + 1))
        .sort()
        .filter((id) => after === null || id > after);
      return {
        drafts: ids
          .slice(0, limit)
          .map((id) => ({ id, ...stores.drafts.get(`${companyId}/${id}`)! })),
        more: ids.length > limit,
      };
    },
  };
  stores.bucket = {
    async stat(name, generation) {
      if (stores.fail) throw new Error(`bucket unreachable at ${name}`);
      return stores.objects.get(name)?.get(generation) ?? null;
    },
    async list(prefix, startOffset, count) {
      const names = [...stores.objects.keys()]
        .filter((name) => name.startsWith(prefix) && name >= startOffset)
        .sort();
      return { names: names.slice(0, count), more: names.length > count };
    },
  };
  return stores;
}

// Puts one generation of an object in the bucket.
function putObject(name: string, generation: bigint, stat: ObjectStat): void {
  const versions = stores.objects.get(name) ?? new Map<bigint, ObjectStat>();
  versions.set(generation, stat);
  stores.objects.set(name, versions);
}

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let stores: Stores;

const useSizes = (sizes: typeof PAGE_SIZES) => {
  live.service = recordsCheckService(h.handle.db, stores.marks, stores.bucket, sizes);
};

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  stores = fakeStores();
  useSizes(PAGE_SIZES);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

// The generation the job harness registers evidence at (seedEvidence, seedSignature).
const REGISTERED = 1731400000000000n;
const ADDRESS = '12 Wet Street, Sacramento';

const call = (company: string, body: unknown = {}, claims: FakeClaims | null = operatorClaims()) =>
  POST(
    request(claims, '/api/platform/x', { method: 'POST', body }),
    params({ companyId: company }),
  );

// Every page of one run, from its first page to the one with no next cursor.
async function run(company: string): Promise<CheckPage[]> {
  const pages: CheckPage[] = [];
  let body: unknown = {};
  for (let i = 0; i < 500; i += 1) {
    const response = await call(company, body);
    expect(response.status).toBe(200);
    const page = (await response.json()) as CheckPage;
    pages.push(page);
    if (page.next === null) return pages;
    body = { runId: page.runId, next: page.next };
  }
  throw new Error('the run did not end');
}

// What a run found, kind by kind, with the ids sorted so paging order does not matter.
function totals(pages: CheckPage[]): Record<FindingKind, { count: number; ids: string[] }> {
  const sum = Object.fromEntries(
    FINDINGS.map((kind) => [kind, { count: 0, ids: [] as string[] }]),
  ) as Record<FindingKind, { count: number; ids: string[] }>;
  for (const page of pages) {
    for (const kind of FINDINGS) {
      sum[kind].count += page.found[kind].count;
      sum[kind].ids.push(
        ...page.found[kind].ids.map((id) =>
          typeof id === 'string' ? id : `${id.jobId}/${id.kind}/${id.objectId}`,
        ),
      );
    }
  }
  for (const kind of FINDINGS) sum[kind].ids.sort();
  return sum;
}

const zeros = () => Object.fromEntries(FINDINGS.map((kind) => [kind, { count: 0, ids: [] }]));

// Puts every registry row of the company into the bucket as the photo routes would have made it.
async function mirrorBucket(company: string): Promise<void> {
  const rows = await h.admin<
    { object_name: string; generation: string; sha256: string; size_bytes: string }[]
  >`
    SELECT object_name, generation::text, sha256, size_bytes::text FROM evidence_objects WHERE company_id = ${company}
  `;
  for (const row of rows) {
    putObject(row.object_name, BigInt(row.generation), {
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
    });
  }
}

type Clean = {
  job: string;
  actor: string;
  submission: string;
  draft: string;
  agreement: string;
  signature: string;
  photo: string;
};

// A company whose stores agree: a signed job (its committed submission marked on its draft, its
// signature object in the bucket), a photo in the registry and the bucket, a draft still being
// edited, a submission still pending inside its fence, and a submitted draft whose job was archived
// since (`archived`, keeping the fence of its committed submission).
async function cleanCompany(company: string, actor: string): Promise<Clean> {
  const chain = await seedChain(
    h.admin,
    company,
    actor,
    newJob(company, actor, { address: ADDRESS }),
  );
  const agreement = agreementOf(chain);
  await withCompany(h.handle.db, company, (tx) => insertAgreement(tx, agreement));
  stores.drafts.set(`${company}/${chain.submission.draft}`, {
    state: 'submitted',
    submissionId: chain.submission.id,
    epoch: chain.submission.epoch,
  });
  stores.drafts.set(`${company}/${chain.job.draft}`, {
    state: 'editing',
    submissionId: null,
    epoch: null,
  });
  const photo = newEvidence(company, chain.job.id, actor);
  await seedEvidence(h.admin, photo);
  const second = await seedJob(h.admin, newJob(company, actor));
  const pending = await seedSubmission(
    h.admin,
    newSubmission(company, second.id, actor, { draft: second.draft }),
  );
  stores.drafts.set(`${company}/${second.draft}`, {
    state: 'submitting',
    submissionId: pending.id,
    epoch: pending.epoch,
  });
  const archived = await seedCommitted(h.admin, newSubmission(company, chain.job.id, actor));
  stores.drafts.set(`${company}/${archived.draft}`, {
    state: 'archived',
    submissionId: archived.id,
    epoch: archived.epoch,
  });
  await mirrorBucket(company);
  const [photoRow] = await h.admin<
    { id: string }[]
  >`SELECT id::text FROM evidence_objects WHERE object_id = ${photo.objectId}`;
  return {
    job: chain.job.id,
    actor,
    submission: chain.submission.id,
    draft: chain.submission.draft,
    agreement: agreement.id,
    signature: chain.signature,
    photo: photoRow!.id,
  };
}

type Planted = Record<FindingKind, string[]>;

// One difference of every kind the check looks for, on top of a clean company.
async function plantDifferences(company: string, clean: Clean): Promise<Planted> {
  const { actor, job } = clean;
  // A mark with no record, as after Postgres is restored to an earlier time; also an archived draft
  // that kept the fence of a submission Postgres no longer has.
  const markOnly = randomUUID();
  stores.drafts.set(`${company}/${markOnly}`, {
    state: 'submitted',
    submissionId: randomUUID(),
    epoch: randomUUID(),
  });
  const archivedMark = randomUUID();
  stores.drafts.set(`${company}/${archivedMark}`, {
    state: 'archived',
    submissionId: randomUUID(),
    epoch: randomUUID(),
  });
  // An archived draft with no fence was never submitted: not a mark.
  stores.drafts.set(`${company}/${randomUUID()}`, {
    state: 'archived',
    submissionId: null,
    epoch: null,
  });
  // A record with no mark: its draft is gone, or still fenced as `submitting`.
  const noDraft = await seedCommitted(h.admin, newSubmission(company, job, actor));
  const stillFenced = await seedCommitted(h.admin, newSubmission(company, job, actor));
  stores.drafts.set(`${company}/${stillFenced.draft}`, {
    state: 'submitting',
    submissionId: stillFenced.id,
    epoch: stillFenced.epoch,
  });
  // A record whose draft carries the mark of another submission: both a record with no mark and a
  // mark with no record behind it.
  const otherMark = await seedCommitted(h.admin, newSubmission(company, job, actor));
  stores.drafts.set(`${company}/${otherMark.draft}`, {
    state: 'submitted',
    submissionId: randomUUID(),
    epoch: otherMark.epoch,
  });
  // A record whose draft carries the mark of the same submission from another attempt (another
  // epoch), as after SQL and the draft are restored and Submit is replayed: both kinds again.
  const otherEpoch = await seedCommitted(h.admin, newSubmission(company, job, actor));
  stores.drafts.set(`${company}/${otherEpoch.draft}`, {
    state: 'submitted',
    submissionId: otherEpoch.id,
    epoch: randomUUID(),
  });
  // A pending submission past its expiry; one aborted after its expiry is not pending.
  const expired = await seedSubmission(
    h.admin,
    newSubmission(company, job, actor, { madeAgo: 3600, expiresIn: -60 }),
  );
  const abortedLate = await seedSubmission(
    h.admin,
    newSubmission(company, job, actor, { madeAgo: 3600, expiresIn: -60 }),
  );
  await h.admin`UPDATE job_submissions SET status = 'aborted' WHERE id = ${abortedLate.id}`;
  // Registry rows whose registered generation is missing, or has another checksum or size; and one
  // whose registered generation is gone while a later generation is live under its name (as after
  // a file restore that made a new generation and kept no copy of the old one).
  const registry = async (
    change: (stat: ObjectStat) => ObjectStat | null,
    generation = REGISTERED,
  ): Promise<string> => {
    const photo = newEvidence(company, job, actor);
    await seedEvidence(h.admin, photo);
    const [row] = await h.admin<
      { id: string; object_name: string }[]
    >`SELECT id::text, object_name FROM evidence_objects WHERE object_id = ${photo.objectId}`;
    const stat = change({ sizeBytes: 2048, sha256: digestOf(photo.objectId) });
    if (stat) putObject(row!.object_name, generation, stat);
    return row!.id;
  };
  const missing = await registry(() => null);
  const checksum = await registry((stat) => ({ ...stat, sha256: digestOf('other bytes') }));
  const size = await registry((stat) => ({ ...stat, sizeBytes: 999 }));
  const generationGone = await registry((stat) => stat, REGISTERED + 7n);
  // Two objects with no row: one named by the app's shape (reported by its ids) and one whose name
  // gives no safe id (counted only).
  const orphan = randomUUID();
  putObject(photoName(company, job, orphan, 'originals'), 1n, { sizeBytes: 10, sha256: null });
  putObject(`companies/${company}/exports/${ADDRESS}.pdf`, 1n, { sizeBytes: 10, sha256: null });
  // A signed agreement whose signature object is gone (its registry row is then missing an object too).
  const signatureRow = (
    await h.admin<
      { object_name: string }[]
    >`SELECT object_name FROM evidence_objects WHERE id = ${clean.signature}`
  )[0]!;
  stores.objects.delete(signatureRow.object_name);
  return {
    committedWithoutMark: [noDraft.id, stillFenced.id, otherMark.id, otherEpoch.id].sort(),
    markWithoutCommitted: [markOnly, archivedMark, otherMark.draft, otherEpoch.draft].sort(),
    pendingPastExpiry: [expired.id],
    rowWithoutObject: [missing, generationGone, clean.signature].sort(),
    sizeDiffers: [size],
    checksumDiffers: [checksum],
    objectWithoutRow: [`${job}/original/${orphan}`],
    agreementWithoutSignature: [clean.agreement],
  };
}

// `unnamed`: objects with no row whose names give no id, counted beside the ids.
const expectFound = (pages: CheckPage[], planted: Planted, unnamed: number) => {
  const expected = Object.fromEntries(
    FINDINGS.map((kind) => [
      kind,
      {
        count: planted[kind].length + (kind === 'objectWithoutRow' ? unnamed : 0),
        ids: planted[kind],
      },
    ]),
  );
  expect(totals(pages)).toEqual(expected);
};

const runRows = () =>
  h.admin<
    {
      company_id: string;
      operator_actor_id: string;
      actor_id: string | null;
      target: string;
      details: { runId: string };
    }[]
  >`
    SELECT company_id::text, operator_actor_id::text, actor_id::text, target, details FROM audit_events WHERE action = 'records_check_run' ORDER BY id
  `;

describe('the records check reads only what the operator policy lets it read', () => {
  it("shows the operator each table it reads in one company's read-only context, and none of another company's rows", async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    await cleanCompany(h.seed.b, h.seed.ownerB.actor);
    await h.admin`INSERT INTO audit_events (company_id, action, target) VALUES (${h.seed.a}, 'seeded', 'a'), (${h.seed.b}, 'seeded', 'b')`;
    for (const table of ['job_submissions', 'evidence_objects', 'agreements', 'audit_events']) {
      const seen = await withOperator(
        h.handle.db,
        h.seed.operator,
        async (tx) =>
          (await tx.execute(
            sql`SELECT company_id::text AS company FROM ${sql.identifier(table)}`,
          )) as unknown as { company: string }[],
        { companyId: h.seed.a, readOnly: true },
      );
      expect({
        table,
        some: seen.length > 0,
        companies: [...new Set(seen.map((row) => row.company))],
      }).toEqual({ table, some: true, companies: [h.seed.a] });
    }
    const companies = await withOperator(
      h.handle.db,
      h.seed.operator,
      async (tx) =>
        (await tx.execute(
          sql`SELECT id::text FROM companies WHERE id = ${h.seed.a}::uuid`,
        )) as unknown as unknown[],
      { companyId: h.seed.a, readOnly: true },
    );
    expect(companies).toHaveLength(1);
  });
});

describe('a run', () => {
  it('finds nothing in a clean company, page by page, and writes one audit row for the run', async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    useSizes({ rows: 1, stats: 1, objects: 1 });
    const before = await everything(h.admin);
    const pages = await run(h.seed.a);
    expect(totals(pages)).toEqual(zeros());
    // Every part is visited in order, a page at a time: 2 committed submissions, 4 drafts, no
    // expired pending submission, 2 registry rows, 2 objects, 1 agreement.
    expect(pages.map((page) => `${page.part}:${page.checked}`)).toEqual([
      'committed:1',
      'committed:1',
      'marks:1',
      'marks:1',
      'marks:1',
      'marks:1',
      'pending:0',
      'evidence:1',
      'evidence:1',
      'objects:1',
      'objects:1',
      'signatures:1',
    ]);
    expect(new Set(pages.map((page) => page.runId)).size).toBe(1);
    expect(await runRows()).toEqual([
      {
        company_id: h.seed.a,
        operator_actor_id: h.seed.operator,
        actor_id: null,
        target: h.seed.a,
        details: { runId: pages[0]!.runId },
      },
    ]);
    // Nothing else changed: the run repairs nothing.
    await h.admin`DELETE FROM audit_events WHERE action = 'records_check_run'`;
    expect(await everything(h.admin)).toBe(before);
  });

  it('finds each planted difference, the same with one-row pages as with full pages', async () => {
    const clean = await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    const planted = await plantDifferences(h.seed.a, clean);
    expectFound(await run(h.seed.a), planted, 1);
    useSizes({ rows: 1, stats: 1, objects: 1 });
    expectFound(await run(h.seed.a), planted, 1);
    expect(await runRows()).toHaveLength(2);
  });

  it('checks the generation each row registered: a copy restored as a new live generation is clean while the registered one is kept', async () => {
    const clean = await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    // The restore drill: the registered generation G1 of the photo and of the signature is copied
    // back under its name as a new live generation G2, and G1 stays readable.
    const rows = await h.admin<{ object_name: string; sha256: string; size_bytes: string }[]>`
      SELECT object_name, sha256, size_bytes::text FROM evidence_objects WHERE id IN (${clean.photo}, ${clean.signature})
    `;
    for (const row of rows) {
      putObject(row.object_name, REGISTERED + 1000n, { sizeBytes: Number(row.size_bytes), sha256: row.sha256 });
    }
    expect(totals(await run(h.seed.a))).toEqual(zeros());
    // Once G1 is no longer kept, the app cannot read what it registered: the rows are missing their
    // objects and the agreement its signature, though G2 is live under the same names.
    for (const row of rows) stores.objects.get(row.object_name)!.delete(REGISTERED);
    const found = totals(await run(h.seed.a));
    expect(found.rowWithoutObject).toEqual({ count: 2, ids: [clean.photo, clean.signature].sort() });
    expect(found.agreementWithoutSignature).toEqual({ count: 1, ids: [clean.agreement] });
    expect(found.objectWithoutRow).toEqual({ count: 0, ids: [] });
  });

  it("writes the run's audit row before comparing anything, so a run whose first page fails is still audited", async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    stores.fail = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await call(h.seed.a);
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 503,
      body: { error: 'records_check_unavailable' },
    });
    const audited = await runRows();
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ company_id: h.seed.a, operator_actor_id: h.seed.operator, actor_id: null });
  });

  it("never answers one company's run with another company's records", async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    const cleanB = await cleanCompany(h.seed.b, h.seed.ownerB.actor);
    const plantedB = await plantDifferences(h.seed.b, cleanB);
    useSizes({ rows: 1, stats: 1, objects: 1 });
    const pages = await run(h.seed.a);
    expect(totals(pages)).toEqual(zeros());
    const answer = JSON.stringify(pages);
    const idsOfB = await h.admin<{ id: string }[]>`
      SELECT id::text FROM jobs WHERE company_id = ${h.seed.b}
      UNION ALL SELECT id::text FROM job_submissions WHERE company_id = ${h.seed.b}
      UNION ALL SELECT draft_id::text FROM job_submissions WHERE company_id = ${h.seed.b}
      UNION ALL SELECT id::text FROM evidence_objects WHERE company_id = ${h.seed.b}
      UNION ALL SELECT id::text FROM agreements WHERE company_id = ${h.seed.b}
    `;
    for (const id of [h.seed.b, ...idsOfB.map((row) => row.id), ...Object.values(plantedB).flat()])
      expect(answer).not.toContain(id.split('/').pop()!);
    // B's own run still finds B's differences.
    useSizes(PAGE_SIZES);
    expectFound(await run(h.seed.b), plantedB, 1);
  });
});

describe('who may run it', () => {
  it('refuses every company user, no sign-in and an old sign-in, writing nothing', async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    const callers: [FakeClaims | null, number, string][] = [
      [owner(), 403, 'not_an_operator'],
      [{ tenant: 'tenant-a', uid: 'estimator-a' }, 403, 'not_an_operator'],
      [{ tenant: 'tenant-a', uid: 'office-a' }, 403, 'not_an_operator'],
      [owner('owner-b', 'tenant-b'), 403, 'not_an_operator'],
      [null, 401, 'missing_token'],
      [operatorClaims({ signedInAgo: 16 * 60 }), 401, 'sign_in_again'],
    ];
    for (const [claims, status, error] of callers) {
      const response = await call(h.seed.a, {}, claims);
      expect({ claims, status: response.status, body: await response.json() }).toEqual({
        claims,
        status,
        body: { error },
      });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a later page with no open run of this operator for this company, an unknown company and a bad cursor', async () => {
    await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    const first = (await (await call(h.seed.b)).json()) as CheckPage;
    const next = { part: 'marks', after: null, skip: 0 };
    const answers = async (company: string, body: unknown) => {
      const response = await call(company, body);
      return { status: response.status, body: await response.json() };
    };
    expect(await answers(h.seed.a, { runId: randomUUID(), next })).toEqual({
      status: 404,
      body: { error: 'run_not_found' },
    });
    // Company B's run does not open company A.
    expect(await answers(h.seed.a, { runId: first.runId, next })).toEqual({
      status: 404,
      body: { error: 'run_not_found' },
    });
    // Another operator's run of company A does not open it for this operator.
    const [second] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-2', 'operator-2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO platform_admins (actor_id) VALUES (${second!.id})`;
    const theirs = (await (
      await call(h.seed.a, {}, operatorClaims({ uid: 'operator-2' }))
    ).json()) as CheckPage;
    expect(await answers(h.seed.a, { runId: theirs.runId, next })).toEqual({
      status: 404,
      body: { error: 'run_not_found' },
    });
    expect((await answers(h.seed.b, { runId: first.runId, next })).status).toBe(200);
    // A run is open for an hour after its first page.
    await h.admin`UPDATE audit_events SET created_at = now() - interval '61 minutes' WHERE action = 'records_check_run'`;
    expect(await answers(h.seed.b, { runId: first.runId, next })).toEqual({
      status: 404,
      body: { error: 'run_not_found' },
    });
    expect(await answers(randomUUID(), {})).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await answers('not-a-company', {})).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    for (const body of [
      { runId: first.runId },
      { next },
      { runId: first.runId, next: { part: 'objects', after: randomUUID(), skip: 0 } },
      { runId: first.runId, next: { part: 'marks', after: null, skip: 3 } },
      { runId: first.runId, next: { part: 'marks', after: 'companies/x', skip: 0 } },
      { runId: first.runId, next: { part: 'nowhere', after: null, skip: 0 } },
      { extra: true },
    ]) {
      expect({ body, answer: await answers(h.seed.b, body) }).toEqual({
        body,
        answer: { status: 400, body: { error: 'invalid_request' } },
      });
    }
    // Only the two runs started above wrote audit rows.
    expect(await runRows()).toHaveLength(2);
  });
});

describe('what it says', () => {
  it('answers and logs no name, address or path, also when a store fails', async () => {
    const logged: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
    const clean = await cleanCompany(h.seed.a, h.seed.ownerA.actor);
    await plantDifferences(h.seed.a, clean);
    const answer = JSON.stringify(await run(h.seed.a));
    stores.fail = true;
    const failed = await call(h.seed.a);
    expect({ status: failed.status, body: await failed.json() }).toEqual({
      status: 503,
      body: { error: 'records_check_unavailable' },
    });
    const said = `${answer}\n${logged.join('\n')}`;
    for (const secret of [
      'companies/',
      'Company company-a',
      'owner-a@example.test',
      'Pat Customer',
      'Wet Street',
      'Sacramento',
    ]) {
      expect(said).not.toContain(secret);
    }
    expect(logged).toEqual(['records check unavailable Error']);
  });
});
