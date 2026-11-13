import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { agreements, jobEstimates, jobPricePins, jobSubmissions } from '@/db/schema';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { sharedRoles } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  READ_ONLY_TRANSACTION,
  UNIQUE_VIOLATION,
  digestOf,
  errorCode,
  newJob,
  ownerOf,
  pause,
  seedJob,
} from './job-harness';
import {
  abortSubmission,
  agreementOf,
  bytesOf,
  commitSubmission,
  insertAgreement,
  insertSubmission,
  newSubmission,
  refusal,
  seedChain,
  seedSubmission,
} from './submission-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-7: the submission table and the worker's lookup (migration 0011), as the app's runtime role on a
// server set up like a fresh Cloud SQL instance (see team-harness.ts). No route uses them yet, so
// these tests write and read through withCompany and withOperator exactly as S5a-8 will. The pin,
// estimate and agreement tables are in agreement-tables.test.ts.
const TABLES = ['agreements', 'job_estimates', 'job_price_pins', 'job_submissions'];
const INVALID_PARAMETER = '22023';

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
// The runtime with several connections, so two transactions can overlap.
let pool: ReturnType<typeof openDatabase>;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await pool?.close();
  h = await resetTeamDatabase(base, h ?? null);
  pool = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl }, { max: 6 });
});

afterAll(async () => {
  await pool?.close();
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) => withCompany(pool.db, company, run);
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: h.seed.a, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];
const sqlOf = (text: string) => sql.raw(text);
// A login that is neither the runtime nor the owner (the run's shared `other` role).
const loginAsOther = () => {
  const url = new URL(base.server.databaseUrl);
  url.username = sharedRoles().other.name;
  url.password = sharedRoles().other.password;
  return postgres(url.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
};

const jobOf = (company: string) => seedJob(h.admin, newJob(company, ownerOf(h, company)));
const submissionOf = async (company: string, extra: Parameters<typeof newSubmission>[3] = {}) => {
  const job = await jobOf(company);
  return seedSubmission(h.admin, newSubmission(company, job.id, ownerOf(h, company), extra));
};

describe('migration 0011: the four tables', () => {
  it('passes the row-level security guard: every table is forced, has policies, and nothing else changed', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<{ name: string; enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
    `;
    // job_submissions has a third and fourth policy: its update, and the worker lookup's owner scan.
    expect(found).toEqual([
      { name: 'agreements', enabled: true, forced: true, policies: 2 },
      { name: 'job_estimates', enabled: true, forced: true, policies: 2 },
      { name: 'job_price_pins', enabled: true, forced: true, policies: 2 },
      { name: 'job_submissions', enabled: true, forced: true, policies: 4 },
    ]);
  });

  it('gives the runtime SELECT and INSERT, and UPDATE of four named submission columns only', async () => {
    const tableLevel = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) ORDER BY 1, 2
    `;
    expect(tableLevel).toEqual(TABLES.flatMap((table) => ['INSERT', 'SELECT'].map((privilege) => ({ table, privilege }))));
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual(['marker_state', 'snapshot_bytes', 'snapshot_sha256', 'status'].map((column) => ({ table: 'job_submissions', column })));
  });

  it('works through the Drizzle view the routes will use, with bytes and jsonb coming back whole', async () => {
    const chain = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const [agreement] = rows<{ id: string }>(await as(h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain, { documents: Buffer.from([0, 1, 2, 255]) }))));
    const read = await as(h.seed.a, async (tx) => ({
      submission: (await tx.select().from(jobSubmissions))[0],
      pin: (await tx.select().from(jobPricePins))[0],
      estimate: (await tx.select().from(jobEstimates))[0],
      agreement: (await tx.select().from(agreements))[0],
    }));
    expect(read.submission).toMatchObject({ id: chain.submission.id, status: 'committed', kind: 'original', markerState: 'pending', parentAgreementId: null });
    expect(read.submission?.snapshotBytes).toEqual(Buffer.from(`snapshot ${chain.submission.id}`));
    expect(read.submission?.decidedAt).toBeInstanceOf(Date);
    expect(read.pin).toMatchObject({ sequence: 1, reason: 'first_price', versionId: chain.version.id });
    expect(read.estimate).toMatchObject({ tableHash: chain.version.hash, engineVersion: 'dryscope-v3', proposalSha256: chain.estimate.proposal.sha });
    expect(read.estimate?.pricedResult).toMatchObject({ total: '1250.00' });
    expect(read.agreement).toMatchObject({ id: agreement!.id, signerKind: 'device', signerName: 'Pat Customer', versionId: chain.version.id });
    expect(read.agreement?.documentsBytes).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await as(h.seed.b, (tx) => tx.select().from(jobSubmissions))).toEqual([]);
  });
});

describe('isolation between companies (submissions)', () => {
  it('shows company B none of company A’s submissions, and an update from B finds nothing', async () => {
    const a = await submissionOf(h.seed.a);
    const b = await submissionOf(h.seed.b);
    expect(await as(h.seed.b, async (tx) => rows(await tx.execute(sql`SELECT id::text FROM job_submissions`)))).toEqual([{ id: b.id }]);
    expect(await as(h.seed.b, async (tx) => rows(await tx.execute(sql`SELECT 1 FROM job_submissions WHERE id = ${a.id}::uuid`)))).toEqual([]);
    expect(await pool.db.execute(sql`SELECT * FROM job_submissions`)).toHaveLength(0);
    const changed = await as(h.seed.b, async (tx) => [
      rows(await tx.execute(sql`UPDATE job_submissions SET status = 'aborted' WHERE id = ${a.id}::uuid RETURNING id`)),
      rows(await tx.execute(sql`UPDATE job_submissions SET status = 'aborted' RETURNING id::text`)),
    ]);
    expect(changed[0]).toHaveLength(0);
    // Company B's own row is the only one its blanket update can reach; company A's is still pending.
    expect(changed[1]).toEqual([{ id: b.id }]);
    expect(await h.admin`SELECT id::text, status FROM job_submissions ORDER BY status`).toEqual([
      { id: b.id, status: 'aborted' },
      { id: a.id, status: 'pending' },
    ]);
  });

  it('refuses a submission written for another company, or naming another company’s job or person', async () => {
    const jobA = await jobOf(h.seed.a);
    expect(await errorCode(as(h.seed.b, (tx) => insertSubmission(tx, newSubmission(h.seed.a, jobA.id, h.seed.ownerA.actor))))).toBe(INSUFFICIENT_PRIVILEGE);
    // Company B naming company A's job, or A's person, passes the policy and is refused by the keys.
    expect(await errorCode(as(h.seed.b, (tx) => insertSubmission(tx, newSubmission(h.seed.b, jobA.id, h.seed.ownerB.actor))))).toBe(FOREIGN_KEY_VIOLATION);
    const jobB = await jobOf(h.seed.b);
    expect(await errorCode(as(h.seed.b, (tx) => insertSubmission(tx, newSubmission(h.seed.b, jobB.id, h.seed.ownerA.actor))))).toBe(FOREIGN_KEY_VIOLATION);
    expect(await as(h.seed.b, (tx) => insertSubmission(tx, newSubmission(h.seed.b, jobB.id, h.seed.ownerB.actor)))).toHaveLength(1);
  });

  it('lets two companies use the same submission id and the same draft and epoch', async () => {
    const jobA = await jobOf(h.seed.a);
    const jobB = await jobOf(h.seed.b);
    const first = newSubmission(h.seed.a, jobA.id, h.seed.ownerA.actor);
    await as(h.seed.a, (tx) => insertSubmission(tx, first));
    const second = newSubmission(h.seed.b, jobB.id, h.seed.ownerB.actor, { id: first.id, draft: first.draft, epoch: first.epoch });
    expect(await as(h.seed.b, (tx) => insertSubmission(tx, second))).toHaveLength(1);
  });
});

describe('nothing is removed from the submission table', () => {
  it('refuses every delete and truncate as the runtime', async () => {
    await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    for (const statement of ['DELETE FROM job_submissions', 'TRUNCATE job_submissions']) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('never lets the runtime change what makes a submission who it is', async () => {
    await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    for (const column of ['company_id', 'id', 'job_id', 'draft_id', 'epoch', 'kind', 'parent_agreement_id', 'request_digest', 'expires_at', 'created_by_actor_id', 'created_at', 'decided_at']) {
      const statement = `UPDATE job_submissions SET ${column} = ${column}`;
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('binds the migrator that owns the table by forced row-level security: it reads and changes nothing', async () => {
    await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const before = await everything(h.admin);
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await owner`SELECT count(*)::int AS n FROM job_submissions`).toEqual([{ n: 0 }]);
      expect((await owner`UPDATE job_submissions SET marker_state = 'done'`).count).toBe(0);
      expect((await owner`DELETE FROM job_submissions`).count).toBe(0);
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('a submission', () => {
  it('starts pending with no snapshot, no decision time and a marker still to write', async () => {
    const s = await submissionOf(h.seed.a);
    expect(await h.admin`SELECT status, marker_state, snapshot_bytes, snapshot_sha256, decided_at, kind, parent_agreement_id FROM job_submissions WHERE id = ${s.id}`).toEqual([
      { status: 'pending', marker_state: 'pending', snapshot_bytes: null, snapshot_sha256: null, decided_at: null, kind: 'original', parent_agreement_id: null },
    ]);
  });

  it('can be made only as pending, never committed, aborted or with its marker written', async () => {
    const job = await jobOf(h.seed.a);
    for (const set of [`'committed'`, `'aborted'`]) {
      const statement = `INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id, status)
        VALUES ('${randomUUID()}', '${h.seed.a}', '${job.id}', '${randomUUID()}', '${randomUUID()}', 'original', '${'a'.repeat(64)}', now() + interval '1 hour', '${h.seed.ownerA.actor}', ${set})`;
      expect({ set, found: await refusal(h.admin.unsafe(statement)) }).toMatchObject({ found: { code: CHECK_VIOLATION, message: 'a submission starts pending' } });
    }
    const markerDone = `INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id, marker_state)
      VALUES ('${randomUUID()}', '${h.seed.a}', '${job.id}', '${randomUUID()}', '${randomUUID()}', 'original', '${'a'.repeat(64)}', now() + interval '1 hour', '${h.seed.ownerA.actor}', 'done')`;
    expect(await refusal(h.admin.unsafe(markerDone))).toMatchObject({ code: CHECK_VIOLATION, message: 'a submission starts pending' });
  });

  it('holds one row per draft and epoch and one per id, and gives two inserts at once one success', async () => {
    const job = await jobOf(h.seed.a);
    const first = newSubmission(h.seed.a, job.id, h.seed.ownerA.actor);
    await as(h.seed.a, (tx) => insertSubmission(tx, first));
    // The same draft and epoch under a new id, and the same id under a new epoch.
    expect(await refusal(as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft: first.draft, epoch: first.epoch }))))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'job_submissions_company_draft_epoch_key',
    });
    expect(await refusal(as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { id: first.id }))))).toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'job_submissions_pkey',
    });
    // A second attempt on the same draft has its own epoch.
    expect(await as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft: first.draft })))).toHaveLength(1);
    const race = newSubmission(h.seed.a, job.id, h.seed.ownerA.actor);
    const results = await Promise.all([1, 2].map(() => errorCode(as(h.seed.a, (tx) => insertSubmission(tx, race)))));
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(results.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(1);
  });

  it('holds its digest to 64 lowercase hex characters, and its expiry after its creation', async () => {
    const job = await jobOf(h.seed.a);
    for (const digest of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}g`]) {
      expect({ digest, code: await errorCode(as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { digest })))) }).toEqual({ digest, code: CHECK_VIOLATION });
    }
    for (const expiresIn of [0, -5]) {
      expect({ expiresIn, found: await refusal(as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { expiresIn })))) }).toMatchObject({
        found: { code: CHECK_VIOLATION, constraint: 'job_submissions_expires_check' },
      });
    }
    expect(await as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { digest: 'f'.repeat(64), expiresIn: 1 })))).toHaveLength(1);
  });

  it('is an original without a parent, or a change order with one, and a change order builds on an agreement of its own job', async () => {
    const chain = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    await as(h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain, { id: randomUUID() })));
    const [agreement] = await h.admin<{ id: string }[]>`SELECT id::text FROM agreements`;
    const make = (extra: Parameters<typeof newSubmission>[3], job = chain.job.id) => as(h.seed.a, (tx) => insertSubmission(tx, newSubmission(h.seed.a, job, chain.actor, extra)));
    expect(await refusal(make({ kind: 'original', parent: agreement!.id }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_submissions_parent_check' });
    expect(await refusal(make({ kind: 'change_order', parent: null }))).toMatchObject({ code: CHECK_VIOLATION, constraint: 'job_submissions_parent_check' });
    expect(await refusal(make({ kind: 'change_order', parent: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_submissions_parent_fkey' });
    // An agreement of another job of the same company cannot be a change order's parent.
    const other = await jobOf(h.seed.a);
    expect(await refusal(make({ kind: 'change_order', parent: agreement!.id }, other.id))).toMatchObject({ code: FOREIGN_KEY_VIOLATION, constraint: 'job_submissions_parent_fkey' });
    expect(await refusal(make({ kind: 'bogus' as 'original' }))).toMatchObject({ code: CHECK_VIOLATION });
    expect(await make({ kind: 'change_order', parent: agreement!.id })).toHaveLength(1);
  });
});

describe('a submission’s decision', () => {
  let s: Awaited<ReturnType<typeof submissionOf>>;

  beforeEach(async () => {
    s = await submissionOf(h.seed.a);
  });

  const state = async () =>
    (await h.admin<{ status: string; marker_state: string; sha: string | null; decided: boolean }[]>`
      SELECT status, marker_state, snapshot_sha256 AS sha, decided_at IS NOT NULL AS decided FROM job_submissions WHERE id = ${s.id}
    `)[0];

  it('commits a pending row with its snapshot and takes the decision time from the clock', async () => {
    const snapshot = bytesOf('{"draft":"d","rooms":[]}');
    const [done] = await as(h.seed.a, async (tx) => {
      const result = await commitSubmission(tx, h.seed.a, s.id, snapshot);
      const [clock] = rows<{ now: string }>(await tx.execute(sql`SELECT now()`));
      return [{ ...result[0]!, clock: clock!.now }];
    });
    expect(done).toMatchObject({ id: s.id, status: 'committed' });
    expect(new Date(done!.decided_at).getTime()).toBe(new Date(done!.clock).getTime());
    expect(await state()).toEqual({ status: 'committed', marker_state: 'pending', sha: snapshot.sha, decided: true });
    expect(await h.admin`SELECT snapshot_bytes FROM job_submissions WHERE id = ${s.id}`).toEqual([{ snapshot_bytes: snapshot.bytes }]);
  });

  it('aborts a pending row with no snapshot, and refuses an abort that carries one', async () => {
    expect(await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET status = 'aborted', snapshot_bytes = ${Buffer.from('xx')}, snapshot_sha256 = ${digestOf('xx')} WHERE id = ${s.id}::uuid`)))).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'job_submissions_snapshot_check',
    });
    expect(await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, s.id))).toHaveLength(1);
    expect(await state()).toEqual({ status: 'aborted', marker_state: 'pending', sha: null, decided: true });
  });

  it('refuses a commit without its snapshot, and a snapshot that is not the one its hash names', async () => {
    const attempts: [string, () => Promise<unknown>][] = [
      ['no snapshot', () => as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET status = 'committed' WHERE id = ${s.id}::uuid`))],
      [
        'bytes without a hash',
        () => as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${Buffer.from('some bytes')} WHERE id = ${s.id}::uuid`)),
      ],
      [
        'a hash of other bytes',
        () => as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${Buffer.from('some bytes')}, snapshot_sha256 = ${digestOf('other bytes')} WHERE id = ${s.id}::uuid`)),
      ],
      [
        'a hash that is not hex',
        () => as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET status = 'committed', snapshot_bytes = ${Buffer.from('some bytes')}, snapshot_sha256 = ${'Z'.repeat(64)} WHERE id = ${s.id}::uuid`)),
      ],
      [
        'a snapshot while still pending',
        () => as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET snapshot_bytes = ${Buffer.from('some bytes')}, snapshot_sha256 = ${digestOf('some bytes')} WHERE id = ${s.id}::uuid`)),
      ],
      ['an empty snapshot', () => as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id, bytesOf('')))],
      ['a snapshot over 8 MiB', () => as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id, bytesOf('a'.repeat(8388609))))],
    ];
    for (const [name, attempt] of attempts) expect({ name, code: await errorCode(attempt()) }).toEqual({ name, code: CHECK_VIOLATION });
    expect(await state()).toEqual({ status: 'pending', marker_state: 'pending', sha: null, decided: false });
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id, bytesOf('a'.repeat(1000))))).toHaveLength(1);
  });

  it('lets a conditional update move only a pending row, so a second decision finds no row', async () => {
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id))).toHaveLength(1);
    expect(await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, s.id))).toHaveLength(0);
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id, bytesOf('another snapshot')))).toHaveLength(0);
    expect(await state()).toMatchObject({ status: 'committed', sha: digestOf(`snapshot ${s.id}`) });
    // The other way round: an aborted row is never committed.
    const t = await submissionOf(h.seed.a);
    expect(await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, t.id))).toHaveLength(1);
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, t.id))).toHaveLength(0);
  });

  it('refuses, in the database, every change to a committed or aborted row except the marker going to done', async () => {
    const decided = async (kind: 'committed' | 'aborted') => {
      const row = await submissionOf(h.seed.a);
      await as(h.seed.a, (tx) => (kind === 'committed' ? commitSubmission(tx, h.seed.a, row.id) : abortSubmission(tx, h.seed.a, row.id)));
      return row;
    };
    const committed = await decided('committed');
    const aborted = await decided('aborted');
    const before = await everything(h.admin);
    for (const row of [committed, aborted]) {
      const target = (await h.admin<{ status: string }[]>`SELECT status FROM job_submissions WHERE id = ${row.id}`)[0]!.status;
      const attempts = [
        `status = '${target === 'committed' ? 'aborted' : 'committed'}'`,
        `status = 'pending'`,
        `snapshot_bytes = '\\x6162'::bytea`,
        `snapshot_sha256 = '${'0'.repeat(64)}'`,
        ...(target === 'committed' ? [`snapshot_bytes = NULL, snapshot_sha256 = NULL`] : []),
        `decided_at = now() + interval '1 day'`,
        `decided_at = NULL`,
      ];
      for (const set of attempts) {
        // As the superuser, which no policy or column right binds: only the trigger and the checks do.
        const found = await refusal(h.admin.unsafe(`UPDATE job_submissions SET ${set} WHERE id = '${row.id}'`));
        expect({ target, set, code: found?.code }).toEqual({ target, set, code: CHECK_VIOLATION });
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('freezes every column of a decided row but the marker, and the list of columns is this table’s', async () => {
    const columns = (await h.admin<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'job_submissions' AND table_schema = 'public' ORDER BY column_name
    `).map((row) => row.column_name);
    const changes: Record<string, string> = {
      id: `'${randomUUID()}'`,
      company_id: `'${h.seed.b}'`,
      job_id: `'${randomUUID()}'`,
      draft_id: `'${randomUUID()}'`,
      epoch: `'${randomUUID()}'`,
      kind: `'change_order'`,
      parent_agreement_id: `'${randomUUID()}'`,
      status: `'aborted'`,
      request_digest: `'${'e'.repeat(64)}'`,
      expires_at: `expires_at + interval '1 hour'`,
      snapshot_bytes: `'\\x6162'::bytea`,
      snapshot_sha256: `'${'0'.repeat(64)}'`,
      marker_state: `'done'`,
      created_by_actor_id: `'${h.seed.estimatorA.actor}'`,
      created_at: `created_at - interval '1 hour'`,
      decided_at: `now() + interval '1 day'`,
    };
    // A column added to the table later must be named here, and in the trigger, before this passes.
    expect(Object.keys(changes).sort()).toEqual(columns);
    await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id));
    for (const [column, value] of Object.entries(changes)) {
      if (column === 'marker_state') continue;
      const found = await refusal(h.admin.unsafe(`UPDATE job_submissions SET ${column} = ${value} WHERE id = '${s.id}'`));
      expect({ column, code: found?.code }).toEqual({ column, code: CHECK_VIOLATION });
    }
    expect(await state()).toMatchObject({ status: 'committed', marker_state: 'pending' });
  });

  it('freezes the identity of a pending row too, and lets only status, snapshot and marker move', async () => {
    for (const set of [
      `job_id = '${randomUUID()}'`,
      `draft_id = '${randomUUID()}'`,
      `epoch = '${randomUUID()}'`,
      `request_digest = '${'e'.repeat(64)}'`,
      `expires_at = expires_at + interval '1 hour'`,
      `created_by_actor_id = '${h.seed.estimatorA.actor}'`,
      `kind = 'change_order'`,
      `id = '${randomUUID()}'`,
    ]) {
      const found = await refusal(h.admin.unsafe(`UPDATE job_submissions SET ${set} WHERE id = '${s.id}'`));
      expect({ set, found }).toMatchObject({ found: { code: CHECK_VIOLATION, message: "a submission's identity cannot change" } });
    }
    expect(await state()).toEqual({ status: 'pending', marker_state: 'pending', sha: null, decided: false });
  });

  it('moves the marker from pending to done once, on a committed or aborted row, and never back', async () => {
    const t = await submissionOf(h.seed.a);
    await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, s.id));
    await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, t.id));
    // A row still pending has no marker to write.
    const u = await submissionOf(h.seed.a);
    expect(await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' WHERE id = ${u.id}::uuid`)))).toMatchObject({
      code: CHECK_VIOLATION,
      constraint: 'job_submissions_marker_check',
    });
    for (const id of [s.id, t.id]) {
      expect(await as(h.seed.a, async (tx) => rows(await tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' WHERE id = ${id}::uuid RETURNING marker_state`)))).toEqual([{ marker_state: 'done' }]);
      // Done again is not a change; back to pending is refused.
      expect(await as(h.seed.a, async (tx) => rows(await tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' WHERE id = ${id}::uuid RETURNING marker_state`)))).toHaveLength(1);
      expect(await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'pending' WHERE id = ${id}::uuid`)))).toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringContaining('marker'),
      });
    }
    expect(await refusal(as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'finished' WHERE id = ${u.id}::uuid`)))).toMatchObject({ code: CHECK_VIOLATION });
  });

  it('gives one commit per draft: a second commit for the same draft is refused, and that row can still abort', async () => {
    const job = await jobOf(h.seed.a);
    const draft = randomUUID();
    const first = await seedSubmission(h.admin, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft }));
    const second = await seedSubmission(h.admin, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft }));
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, first.id))).toHaveLength(1);
    expect(await refusal(as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, second.id)))).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_submissions_one_committed_per_draft' });
    expect(await as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, second.id))).toHaveLength(1);
    // Another draft of the same job, and the same draft id in another company, each have their own.
    const other = await seedSubmission(h.admin, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor));
    expect(await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, other.id))).toHaveLength(1);
    const jobB = await jobOf(h.seed.b);
    const sameDraft = await seedSubmission(h.admin, newSubmission(h.seed.b, jobB.id, h.seed.ownerB.actor, { draft }));
    expect(await as(h.seed.b, (tx) => commitSubmission(tx, h.seed.b, sameDraft.id))).toHaveLength(1);
  });

  it('gives two commits for the same draft at once one success, whichever lands first', async () => {
    const job = await jobOf(h.seed.a);
    const draft = randomUUID();
    const one = await seedSubmission(h.admin, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft }));
    const two = await seedSubmission(h.admin, newSubmission(h.seed.a, job.id, h.seed.ownerA.actor, { draft }));
    let updated!: () => void;
    const first = new Promise<void>((resolve) => (updated = resolve));
    const slow = as(h.seed.a, async (tx) => {
      const result = await commitSubmission(tx, h.seed.a, one.id);
      updated();
      await pause(300);
      return result;
    });
    const late = (async () => {
      await first;
      return refusal(as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, two.id)));
    })();
    expect(await slow).toHaveLength(1);
    expect(await late).toMatchObject({ code: UNIQUE_VIOLATION, constraint: 'job_submissions_one_committed_per_draft' });
    expect(await h.admin`SELECT id::text, status FROM job_submissions WHERE draft_id = ${draft} ORDER BY status`).toEqual([
      { id: one.id, status: 'committed' },
      { id: two.id, status: 'pending' },
    ]);
  });

  it('gives a commit and an abort of the same row at once one outcome, and the loser changes nothing', async () => {
    let updated!: () => void;
    const first = new Promise<void>((resolve) => (updated = resolve));
    const slow = as(h.seed.a, async (tx) => {
      const result = await commitSubmission(tx, h.seed.a, s.id);
      updated();
      await pause(300);
      return result;
    });
    const late = (async () => {
      await first;
      // Waits for the first transaction, then finds the row no longer pending.
      return as(h.seed.a, (tx) => abortSubmission(tx, h.seed.a, s.id));
    })();
    expect(await slow).toHaveLength(1);
    expect(await late).toHaveLength(0);
    expect(await state()).toMatchObject({ status: 'committed', decided: true });
  });
});

describe('the platform operator', () => {
  it('reads one company’s submissions in a read-only context that names it, and cannot write', async () => {
    const chain = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    await seedChain(h.admin, h.seed.b, h.seed.ownerB.actor);
    const counts = (tx: CompanyTransaction) =>
      tx.execute(sql`
        SELECT (SELECT count(*)::int FROM job_submissions) AS submissions, (SELECT count(*)::int FROM job_price_pins) AS pins,
               (SELECT count(*)::int FROM job_estimates) AS estimates, (SELECT count(*)::int FROM agreements) AS agreements
      `);
    expect(await asOperator(counts, true)).toEqual([{ submissions: 1, pins: 1, estimates: 1, agreements: 0 }]);
    const before = await everything(h.admin);
    const writes: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertSubmission(tx, newSubmission(h.seed.a, chain.job.id, h.seed.ownerA.actor)),
      (tx) => insertAgreement(tx, agreementOf(chain)),
    ];
    for (const write of writes) {
      expect(await errorCode(asOperator(write))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(asOperator(write, true))).toBe(READ_ONLY_TRANSACTION);
    }
    const update = (tx: CompanyTransaction) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' RETURNING 1`);
    expect(await asOperator(update)).toEqual([]);
    expect(await errorCode(asOperator(update, true))).toBe(READ_ONLY_TRANSACTION);
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('migration 0011: the worker’s lookup across companies', () => {
  const due = (max = 10, grace = 0) => pool.db.execute(sql`SELECT job_submission_due_companies(${max}::int, ${grace}::int)::text AS id`);
  const ids = async (max?: number, grace?: number) => rows<{ id: string }>(await due(max, grace)).map((row) => row.id).sort();

  it('finds a company with a pending row past its expiry, and not one that has not expired yet', async () => {
    await submissionOf(h.seed.a, { madeAgo: 7200, expiresIn: -3600 });
    await submissionOf(h.seed.b, { expiresIn: 900 });
    expect(await ids()).toEqual([h.seed.a]);
  });

  it('finds a decided row whose marker is still pending once the grace has passed, and not one whose marker is done', async () => {
    const a = await submissionOf(h.seed.a);
    await as(h.seed.a, (tx) => commitSubmission(tx, h.seed.a, a.id));
    const b = await submissionOf(h.seed.b);
    await as(h.seed.b, (tx) => abortSubmission(tx, h.seed.b, b.id));
    expect(await ids(10, 0)).toEqual([h.seed.a, h.seed.b].sort());
    // Inside the grace period the request that just decided is not raced by the worker.
    expect(await ids(10, 3600)).toEqual([]);
    await as(h.seed.a, (tx) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' WHERE id = ${a.id}::uuid`));
    expect(await ids(10, 0)).toEqual([h.seed.b]);
    await pause(1200);
    expect(await ids(10, 1)).toEqual([h.seed.b]);
    await as(h.seed.b, (tx) => tx.execute(sql`UPDATE job_submissions SET marker_state = 'done' WHERE id = ${b.id}::uuid`));
    expect(await ids(10, 0)).toEqual([]);
  });

  it('leaves out a pending row not yet expired even when its company has done work, and returns each company once, oldest first, up to the limit', async () => {
    await submissionOf(h.seed.a, { madeAgo: 7200, expiresIn: -3600 });
    await submissionOf(h.seed.a, { madeAgo: 7200, expiresIn: -3000 });
    await submissionOf(h.seed.b, { madeAgo: 7200, expiresIn: -7000 });
    await submissionOf(h.seed.b, { expiresIn: 900 });
    expect(rows<{ id: string }>(await due()).map((row) => row.id)).toEqual([h.seed.b, h.seed.a]);
    expect(rows(await due(1))).toHaveLength(1);
  });

  it('lets the runtime find which companies have work, and nothing else, even with the setting turned on', async () => {
    await submissionOf(h.seed.a, { madeAgo: 7200, expiresIn: -3600 });
    expect(await pool.db.execute(sql`SELECT * FROM job_submissions`)).toHaveLength(0);
    const api = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      await api.begin(async (tx) => {
        await tx`SELECT set_config('app.submission_scan', 'on', true)`;
        expect(await tx`SELECT * FROM job_submissions`).toHaveLength(0);
      });
      expect(await api`SELECT current_setting('app.submission_scan', true) AS v`).toEqual([{ v: '' }]);
      expect(await api`SELECT job_submission_due_companies(10, 0)::text AS id`).toEqual([{ id: h.seed.a }]);
      expect(await api`SELECT * FROM job_submissions`).toHaveLength(0);
    } finally {
      await api.end({ timeout: 5 });
    }
  });

  it('refuses everyone but the runtime, and the owner reads nothing through it', async () => {
    await submissionOf(h.seed.a, { madeAgo: 7200, expiresIn: -3600 });
    const other = loginAsOther();
    const migrator = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(await errorCode(other`SELECT job_submission_due_companies(10, 0)`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(other`SELECT * FROM job_submissions`)).toBe(INSUFFICIENT_PRIVILEGE);
      // The owner signed in as itself: the policy's session check matches nothing.
      expect(await migrator`SELECT job_submission_due_companies(10, 0)`).toEqual([]);
      await migrator.begin(async (tx) => {
        await tx`SELECT set_config('app.submission_scan', 'on', true)`;
        expect(await tx`SELECT * FROM job_submissions`).toHaveLength(0);
      });
      // The policy is for reading only; the owner still cannot change a row.
      expect(await migrator`UPDATE job_submissions SET marker_state = 'done' RETURNING id`).toHaveLength(0);
    } finally {
      await other.end({ timeout: 5 });
      await migrator.end({ timeout: 5 });
    }
  });

  it('refuses a size outside 1 to 100 and a grace outside 0 to 86,400 seconds, and answers nothing for a null', async () => {
    for (const [max, grace] of [[0, 0], [101, 0], [1, -1], [1, 86401]] as const) {
      expect({ max, grace, code: await errorCode(due(max, grace)) }).toEqual({ max, grace, code: INVALID_PARAMETER });
    }
    expect(await errorCode(due(100, 86400))).toBeUndefined();
    expect(rows(await pool.db.execute(sql`SELECT job_submission_due_companies(NULL, 0)`))).toEqual([]);
    expect(rows(await pool.db.execute(sql`SELECT job_submission_due_companies(10, NULL)`))).toEqual([]);
  });

  it('leaves every table protected', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
  });
});
