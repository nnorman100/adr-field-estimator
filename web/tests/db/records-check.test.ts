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
  objects: Map<string, ObjectStat>;
  fail: boolean;
  marks: DraftMarks;
  bucket: EvidenceObjects;
};

// The field drafts by "company/draft" and the bucket's live objects by name, ordered as Firestore and
// Cloud Storage order them (by id, by name).
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
    async stat(name) {
      if (stores.fail) throw new Error(`bucket unreachable at ${name}`);
      return stores.objects.get(name) ?? null;
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
    stores.objects.set(row.object_name, {
      generation: BigInt(row.generation),
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
  });
  stores.drafts.set(`${company}/${chain.job.draft}`, { state: 'editing', submissionId: null });
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
  });
  const archived = await seedCommitted(h.admin, newSubmission(company, chain.job.id, actor));
  stores.drafts.set(`${company}/${archived.draft}`, {
    state: 'archived',
    submissionId: archived.id,
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
  stores.drafts.set(`${company}/${markOnly}`, { state: 'submitted', submissionId: randomUUID() });
  const archivedMark = randomUUID();
  stores.drafts.set(`${company}/${archivedMark}`, {
    state: 'archived',
    submissionId: randomUUID(),
  });
  // An archived draft with no fence was never submitted: not a mark.
  stores.drafts.set(`${company}/${randomUUID()}`, { state: 'archived', submissionId: null });
  // A record with no mark: its draft is gone, or still fenced as `submitting`.
  const noDraft = await seedCommitted(h.admin, newSubmission(company, job, actor));
  const stillFenced = await seedCommitted(h.admin, newSubmission(company, job, actor));
  stores.drafts.set(`${company}/${stillFenced.draft}`, {
    state: 'submitting',
    submissionId: stillFenced.id,
  });
  // A record whose draft carries the mark of another submission: both a record with no mark and a
  // mark with no record behind it.
  const otherMark = await seedCommitted(h.admin, newSubmission(company, job, actor));
  stores.drafts.set(`${company}/${otherMark.draft}`, {
    state: 'submitted',
    submissionId: randomUUID(),
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
  // Registry rows whose object is missing, has another checksum, size or generation.
  const registry = async (change: (stat: ObjectStat) => ObjectStat | null): Promise<string> => {
    const photo = newEvidence(company, job, actor);
    await seedEvidence(h.admin, photo);
    const [row] = await h.admin<
      { id: string; object_name: string }[]
    >`SELECT id::text, object_name FROM evidence_objects WHERE object_id = ${photo.objectId}`;
    const stat = change({
      generation: 1731400000000000n,
      sizeBytes: 2048,
      sha256: digestOf(photo.objectId),
    });
    if (stat) stores.objects.set(row!.object_name, stat);
    return row!.id;
  };
  const missing = await registry(() => null);
  const checksum = await registry((stat) => ({ ...stat, sha256: digestOf('other bytes') }));
  const size = await registry((stat) => ({ ...stat, sizeBytes: 999 }));
  const generation = await registry((stat) => ({ ...stat, generation: stat.generation + 7n }));
  // An object with no row, and one whose name is not the app's shape.
  const orphan = randomUUID();
  stores.objects.set(photoName(company, job, orphan, 'originals'), {
    generation: 1n,
    sizeBytes: 10,
    sha256: null,
  });
  stores.objects.set(`companies/${company}/exports/${ADDRESS}.pdf`, {
    generation: 1n,
    sizeBytes: 10,
    sha256: null,
  });
  // A signed agreement whose signature object is gone (its registry row is then missing an object too).
  const signatureRow = (
    await h.admin<
      { object_name: string }[]
    >`SELECT object_name FROM evidence_objects WHERE id = ${clean.signature}`
  )[0]!;
  stores.objects.delete(signatureRow.object_name);
  return {
    committedWithoutMark: [noDraft.id, stillFenced.id, otherMark.id].sort(),
    markWithoutCommitted: [markOnly, archivedMark, otherMark.draft].sort(),
    pendingPastExpiry: [expired.id],
    rowWithoutObject: [missing, clean.signature].sort(),
    generationDiffers: [generation],
    sizeDiffers: [size],
    checksumDiffers: [checksum],
    objectWithoutRow: [`${job}/original/${orphan}`],
    unrecognisedObjects: [],
    agreementWithoutSignature: [clean.agreement],
  };
}

const expectFound = (pages: CheckPage[], planted: Planted, unrecognised: number) => {
  const expected = Object.fromEntries(
    FINDINGS.map((kind) => [
      kind,
      {
        count: kind === 'unrecognisedObjects' ? unrecognised : planted[kind].length,
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
