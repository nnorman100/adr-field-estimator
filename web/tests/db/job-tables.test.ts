import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@/db/client';
import { evidenceObjects, jobClaims, jobCustomers, jobs } from '@/db/schema';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import {
  CHECK_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  INSUFFICIENT_PRIVILEGE,
  READ_ONLY_TRANSACTION,
  UNIQUE_VIOLATION,
  errorCode,
  insertEvidence,
  insertJob,
  newEvidence,
  newJob,
  ownerOf,
  pause,
  seedEvidence,
  seedJob,
} from './job-harness';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5a-2: the core job tables (migration 0010), as the app's runtime role on a server set up like a
// fresh Cloud SQL instance (see team-harness.ts). No route uses them yet, so these tests write and
// read through withCompany and withOperator exactly as S5a-3 to S5a-5 will.
const TABLES = ['evidence_objects', 'job_claims', 'job_customers', 'jobs'];

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
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false, companyId: string | null = h.seed.a) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: companyId ?? undefined, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];
const sqlOf = (text: string) => sql.raw(text);

// One job with a customer, a claim and a photo for the company, written as the table owner.
async function seedFullJob(company: string, extra: Parameters<typeof newJob>[2] = {}) {
  const job = await seedJob(h.admin, newJob(company, ownerOf(h, company), { address: '12 Main Street', ...extra }));
  await h.admin`INSERT INTO job_customers (company_id, job_id, name, phone, email) VALUES (${company}, ${job.id}, 'Pat Customer', '555-0100', 'pat@example.test')`;
  await h.admin`INSERT INTO job_claims (company_id, job_id, carrier, claim_number, date_of_loss) VALUES (${company}, ${job.id}, 'Carrier Co', 'CLM-1', '2026-11-01')`;
  const photo = newEvidence(company, job.id, ownerOf(h, company));
  await seedEvidence(h.admin, photo);
  return { job, photo };
}

describe('migration 0010: the four tables', () => {
  it('passes the row-level security guard: every table is forced, has policies, and nothing else changed', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<{ name: string; enabled: boolean; forced: boolean; policies: number }[]>`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
    `;
    expect(found).toEqual([
      { name: 'evidence_objects', enabled: true, forced: true, policies: 2 },
      { name: 'job_claims', enabled: true, forced: true, policies: 3 },
      { name: 'job_customers', enabled: true, forced: true, policies: 3 },
      { name: 'jobs', enabled: true, forced: true, policies: 3 },
    ]);
  });

  it('gives the runtime SELECT and INSERT, and UPDATE of named columns only (none on the evidence registry)', async () => {
    const tableLevel = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) ORDER BY 1, 2
    `;
    expect(tableLevel).toEqual(TABLES.flatMap((table) => ['INSERT', 'SELECT'].map((privilege) => ({ table, privilege }))));
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    const columns = {
      job_claims: ['adjuster_email', 'adjuster_name', 'adjuster_phone', 'carrier', 'claim_number', 'date_of_loss', 'deductible', 'loss_cause', 'policy_number', 'updated_at'],
      job_customers: ['email', 'name', 'phone', 'updated_at'],
      jobs: ['archived_at', 'archived_by_actor_id', 'current_draft_id', 'field_owner_actor_id', 'last_change_id', 'property_address', 'revision', 'status', 'updated_at'],
    };
    expect(updates).toEqual(Object.entries(columns).flatMap(([table, list]) => list.map((column) => ({ table, column }))));
  });

  it('works through the Drizzle view the routes will use', async () => {
    const job = newJob(h.seed.a, h.seed.ownerA.actor, { address: '12 Main Street' });
    const photo = newEvidence(h.seed.a, job.id, h.seed.ownerA.actor);
    await as(h.seed.a, async (tx) => {
      const [created] = await tx
        .insert(jobs)
        .values({ id: job.id, companyId: h.seed.a, createdByActorId: h.seed.ownerA.actor, currentDraftId: job.draft, propertyAddress: '12 Main Street', requestDigest: job.digest })
        .returning();
      expect(created).toMatchObject({ status: 'draft', revision: 1, lastChangeId: null, fieldOwnerActorId: null, archivedAt: null });
      expect(created?.createdAt).toBeInstanceOf(Date);
      await tx.insert(jobCustomers).values({ companyId: h.seed.a, jobId: job.id, name: 'Pat Customer' });
      await tx.insert(jobClaims).values({ companyId: h.seed.a, jobId: job.id, carrier: 'Carrier Co', dateOfLoss: '2026-11-01' });
      await tx.insert(evidenceObjects).values({
        companyId: h.seed.a,
        jobId: job.id,
        objectId: photo.objectId,
        kind: 'photo',
        objectName: `companies/${h.seed.a}/jobs/${job.id}/photos/${photo.objectId}`,
        generation: 1731400000000000n,
        sha256: 'a'.repeat(64),
        sizeBytes: 2048,
        contentType: 'image/jpeg',
        createdByActorId: h.seed.ownerA.actor,
      });
    });
    const read = await as(h.seed.a, async (tx) => ({
      job: (await tx.select().from(jobs))[0],
      customer: (await tx.select().from(jobCustomers))[0],
      claim: (await tx.select().from(jobClaims))[0],
      photo: (await tx.select().from(evidenceObjects))[0],
    }));
    expect(read.job).toMatchObject({ id: job.id, companyId: h.seed.a, revision: 1, propertyAddress: '12 Main Street' });
    expect(read.customer).toMatchObject({ name: 'Pat Customer', phone: '', email: '' });
    expect(read.claim).toMatchObject({ carrier: 'Carrier Co', dateOfLoss: '2026-11-01', claimNumber: '' });
    expect(read.photo).toMatchObject({ kind: 'photo', generation: 1731400000000000n, sizeBytes: 2048 });
    expect(await as(h.seed.b, (tx) => tx.select().from(jobs))).toEqual([]);
  });
});

describe('isolation between companies', () => {
  let a: Awaited<ReturnType<typeof seedFullJob>>;
  let b: Awaited<ReturnType<typeof seedFullJob>>;

  beforeEach(async () => {
    a = await seedFullJob(h.seed.a);
    b = await seedFullJob(h.seed.b);
  });

  it('shows company B none of company A’s rows in any of the four tables, and each only its own', async () => {
    for (const company of [h.seed.a, h.seed.b]) {
      const seen = await as(company, async (tx) => {
        const out: Record<string, string[]> = {};
        for (const table of TABLES) out[table] = rows<{ c: string }>(await tx.execute(sqlOf(`SELECT DISTINCT company_id::text AS c FROM ${table}`))).map((r) => r.c);
        return out;
      });
      expect(seen).toEqual({ evidence_objects: [company], job_claims: [company], job_customers: [company], jobs: [company] });
    }
    // Asking for company A's job by its id from company B finds nothing, in every table.
    const probe = await as(h.seed.b, async (tx) => [
      rows(await tx.execute(sql`SELECT 1 FROM jobs WHERE id = ${a.job.id}::uuid`)),
      rows(await tx.execute(sql`SELECT 1 FROM job_customers WHERE job_id = ${a.job.id}::uuid`)),
      rows(await tx.execute(sql`SELECT 1 FROM job_claims WHERE job_id = ${a.job.id}::uuid`)),
      rows(await tx.execute(sql`SELECT 1 FROM evidence_objects WHERE job_id = ${a.job.id}::uuid`)),
    ]);
    expect(probe).toEqual([[], [], [], []]);
    // Outside withCompany nothing is visible at all.
    for (const table of TABLES) expect(await pool.db.execute(sqlOf(`SELECT * FROM ${table}`))).toHaveLength(0);
  });

  it('refuses a write for another company, and an update that cannot see the row changes nothing', async () => {
    const before = await everything(h.admin);
    const attempts: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertJob(tx, newJob(h.seed.a, h.seed.ownerA.actor)),
      (tx) => tx.execute(sql`INSERT INTO job_customers (company_id, job_id) VALUES (${h.seed.a}::uuid, ${a.job.id}::uuid)`),
      (tx) => tx.execute(sql`INSERT INTO job_claims (company_id, job_id) VALUES (${h.seed.a}::uuid, ${a.job.id}::uuid)`),
      (tx) => insertEvidence(tx, newEvidence(h.seed.a, a.job.id, h.seed.ownerA.actor)),
    ];
    for (const attempt of attempts) expect(await errorCode(as(h.seed.b, attempt))).toBe(INSUFFICIENT_PRIVILEGE);
    const changed = await as(h.seed.b, async (tx) => [
      rows(await tx.execute(sql`UPDATE jobs SET property_address = 'Taken', revision = 2 WHERE id = ${a.job.id}::uuid RETURNING id`)),
      rows(await tx.execute(sql`UPDATE job_customers SET name = 'Taken' WHERE job_id = ${a.job.id}::uuid RETURNING job_id`)),
      rows(await tx.execute(sql`UPDATE job_claims SET carrier = 'Taken' WHERE job_id = ${a.job.id}::uuid RETURNING job_id`)),
    ]);
    expect(changed).toEqual([[], [], []]);
    expect(await everything(h.admin)).toBe(before);
  });

  it('lets two companies use the same job id without either seeing, or colliding with, the other', async () => {
    const same = newJob(h.seed.b, h.seed.ownerB.actor, { id: a.job.id });
    expect(await as(h.seed.b, (tx) => insertJob(tx, same))).toHaveLength(1);
    expect(await h.admin`SELECT company_id FROM jobs WHERE id = ${a.job.id} ORDER BY company_id`).toHaveLength(2);
    expect(await as(h.seed.a, async (tx) => rows(await tx.execute(sql`SELECT company_id::text AS c FROM jobs WHERE id = ${a.job.id}::uuid`)))).toEqual([{ c: h.seed.a }]);
  });

  it('refuses a row that points at another company’s job or person, even for the table owner (composite keys)', async () => {
    const before = await everything(h.admin);
    const refused = async (promise: Promise<unknown>) => expect(await errorCode(promise)).toBe(FOREIGN_KEY_VIOLATION);
    // Company B's rows naming company A's job.
    await refused(h.admin`INSERT INTO job_customers (company_id, job_id) VALUES (${h.seed.b}, ${a.job.id})`);
    await refused(h.admin`INSERT INTO job_claims (company_id, job_id) VALUES (${h.seed.b}, ${a.job.id})`);
    await refused(seedEvidence(h.admin, newEvidence(h.seed.b, a.job.id, h.seed.ownerB.actor)));
    // The same, written by company B's own runtime transaction: the policy passes, the key refuses.
    await refused(as(h.seed.b, (tx) => tx.execute(sql`INSERT INTO job_customers (company_id, job_id) VALUES (${h.seed.b}::uuid, ${a.job.id}::uuid)`)));
    await refused(as(h.seed.b, (tx) => insertEvidence(tx, newEvidence(h.seed.b, a.job.id, h.seed.ownerB.actor))));
    // A job made by, owned by or archived by another company's person.
    await refused(as(h.seed.b, (tx) => insertJob(tx, newJob(h.seed.b, h.seed.ownerA.actor))));
    await refused(as(h.seed.b, (tx) => insertJob(tx, newJob(h.seed.b, h.seed.ownerB.actor, { owner: h.seed.estimatorA.actor }))));
    await refused(h.admin`UPDATE jobs SET field_owner_actor_id = ${h.seed.estimatorA.actor}, revision = 2 WHERE id = ${b.job.id} AND company_id = ${h.seed.b}`);
    await refused(
      h.admin`UPDATE jobs SET status = 'archived', archived_at = now(), archived_by_actor_id = ${h.seed.ownerA.actor}, revision = 2 WHERE id = ${b.job.id} AND company_id = ${h.seed.b}`,
    );
    // A person of company B may be named by company B.
    expect(await as(h.seed.b, (tx) => insertJob(tx, newJob(h.seed.b, h.seed.estimatorB.actor, { owner: h.seed.estimatorB.actor })))).toHaveLength(1);
    expect(before).toContain(a.job.id);
  });
});

describe('nothing is removed, and the evidence registry is insert-only', () => {
  beforeEach(async () => {
    await seedFullJob(h.seed.a);
  });

  it('refuses every delete and truncate as the runtime, in all four tables', async () => {
    const before = await everything(h.admin);
    for (const table of TABLES) {
      for (const statement of [`DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
      }
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses every update of an evidence row as the runtime, whatever the column', async () => {
    const before = await everything(h.admin);
    for (const column of ['kind', 'object_name', 'generation', 'sha256', 'size_bytes', 'content_type', 'created_by_actor_id', 'company_id', 'job_id', 'object_id', 'created_at']) {
      const statement = `UPDATE evidence_objects SET ${column} = ${column}`;
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('never lets the runtime change what makes a job or its customer and claim who they are', async () => {
    const before = await everything(h.admin);
    const statements = [
      ...['company_id', 'id', 'created_by_actor_id', 'request_digest', 'created_at'].map((c) => `UPDATE jobs SET ${c} = ${c}, revision = revision + 1`),
      ...['company_id', 'job_id', 'created_at'].flatMap((c) => [`UPDATE job_customers SET ${c} = ${c}`, `UPDATE job_claims SET ${c} = ${c}`]),
    ];
    for (const statement of statements) {
      expect({ statement, code: await errorCode(as(h.seed.a, (tx) => tx.execute(sqlOf(statement)))) }).toEqual({ statement, code: INSUFFICIENT_PRIVILEGE });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('binds the migrator that owns the tables by forced row-level security: it reads and changes nothing', async () => {
    const before = await everything(h.admin);
    const owner = postgres(h.migratorUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      for (const table of TABLES) {
        expect(await owner.unsafe(`SELECT count(*)::int AS n FROM ${table}`)).toEqual([{ n: 0 }]);
        expect((await owner.unsafe(`DELETE FROM ${table}`)).count).toBe(0);
      }
      expect((await owner`UPDATE evidence_objects SET size_bytes = 1`).count).toBe(0);
    } finally {
      await owner.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('a job', () => {
  const create = (j = newJob(h.seed.a, h.seed.ownerA.actor)) => as(h.seed.a, (tx) => insertJob(tx, j)).then(() => j);
  const save = (id: string, set: string, revision: number) =>
    as(h.seed.a, (tx) => tx.execute(sqlOf(`UPDATE jobs SET ${set}, revision = ${revision} WHERE id = '${id}' RETURNING revision`)));

  it('starts as a draft at revision 1, with no field owner, archive or change id', async () => {
    const job = await create();
    const [row] = await h.admin`SELECT status, revision, field_owner_actor_id, archived_at, archived_by_actor_id, last_change_id, property_address FROM jobs WHERE id = ${job.id}`;
    expect(row).toEqual({ status: 'draft', revision: 1, field_owner_actor_id: null, archived_at: null, archived_by_actor_id: null, last_change_id: null, property_address: '' });
    expect(await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { revision: 2 })))).toBe(CHECK_VIOLATION);
    for (const status of ['submitted', 'signed', 'archived']) {
      expect({ status, code: await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { status }))) }).toEqual({ status, code: CHECK_VIOLATION });
    }
    expect(await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { status: 'finished' })))).toBe(CHECK_VIOLATION);
  });

  it('raises the revision by exactly one with each change and refuses a skip, a repeat or a rewind', async () => {
    const job = await create();
    expect(await save(job.id, `property_address = '1 First Street'`, 2)).toHaveLength(1);
    for (const revision of [2, 4, 1, 0]) {
      expect({ revision, code: await errorCode(save(job.id, `property_address = 'Elsewhere'`, revision)) }).toEqual({ revision, code: CHECK_VIOLATION });
    }
    // A blind save that carries no new revision is refused by the database.
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`UPDATE jobs SET property_address = 'Blind'`)))).toBe(CHECK_VIOLATION);
    expect(await save(job.id, `property_address = '2 Second Street'`, 3)).toHaveLength(1);
    expect(await h.admin`SELECT revision, property_address FROM jobs WHERE id = ${job.id}`).toEqual([{ revision: 3, property_address: '2 Second Street' }]);
  });

  it('gives two saves of the same revision at once one success and one stale refusal', async () => {
    const job = await create();
    let updated!: () => void;
    const first = new Promise<void>((resolve) => (updated = resolve));
    const write = (tx: CompanyTransaction, address: string) =>
      tx.execute(sql`UPDATE jobs SET property_address = ${address}, revision = 2 WHERE id = ${job.id}::uuid AND revision = 1 RETURNING revision`);
    const slow = as(h.seed.a, async (tx) => {
      const result = await write(tx, '1 First Street');
      updated();
      await pause(300);
      return result;
    });
    const stale = (async () => {
      await first;
      return as(h.seed.a, (tx) => write(tx, '9 Other Street'));
    })();
    expect(await slow).toHaveLength(1);
    // The expected-revision test no longer matches once the first commits, so nothing is written.
    expect(await stale).toHaveLength(0);
    expect(await h.admin`SELECT revision, property_address FROM jobs WHERE id = ${job.id}`).toEqual([{ revision: 2, property_address: '1 First Street' }]);
  });

  it('gives two creates with the same id at once one job and one refusal, never two rows', async () => {
    const job = newJob(h.seed.a, h.seed.ownerA.actor);
    const results = await Promise.all([1, 2].map(() => errorCode(create(job))));
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(results.filter((code) => code === UNIQUE_VIOLATION)).toHaveLength(1);
    expect(await h.admin`SELECT count(*)::int AS n FROM jobs`).toEqual([{ n: 1 }]);
  });

  it('keeps one job per field draft in a company, and lets another company use the same draft id', async () => {
    const draft = randomUUID();
    await create(newJob(h.seed.a, h.seed.ownerA.actor, { draft }));
    expect(await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { draft })))).toBe(UNIQUE_VIOLATION);
    expect(await as(h.seed.b, (tx) => insertJob(tx, newJob(h.seed.b, h.seed.ownerB.actor, { draft })))).toHaveLength(1);
    // Back to editing moves a job to a new draft id; an id another job holds is refused.
    const other = await create();
    expect(await errorCode(save(other.id, `current_draft_id = '${draft}'`, 2))).toBe(UNIQUE_VIOLATION);
    expect(await save(other.id, `current_draft_id = '${randomUUID()}'`, 2)).toHaveLength(1);
  });

  it('is archived exactly when it says when and by whom, and can be restored', async () => {
    const job = await create();
    const archive = `status = 'archived', archived_at = now(), archived_by_actor_id = '${h.seed.ownerA.actor}'`;
    for (const set of [
      `status = 'archived'`,
      `archived_at = now()`,
      `status = 'archived', archived_at = now()`,
      `status = 'archived', archived_by_actor_id = '${h.seed.ownerA.actor}'`,
      `archived_by_actor_id = '${h.seed.ownerA.actor}'`,
    ]) {
      expect({ set, code: await errorCode(save(job.id, set, 2)) }).toEqual({ set, code: CHECK_VIOLATION });
    }
    expect(await save(job.id, archive, 2)).toHaveLength(1);
    expect(await save(job.id, `status = 'draft', archived_at = NULL, archived_by_actor_id = NULL`, 3)).toHaveLength(1);
    expect(await h.admin`SELECT status, archived_at FROM jobs WHERE id = ${job.id}`).toEqual([{ status: 'draft', archived_at: null }]);
  });

  it('may move through the four named statuses, carries a change id, and refuses any other status', async () => {
    const job = await create();
    expect(await save(job.id, `field_owner_actor_id = '${h.seed.estimatorA.actor}', status = 'submitted'`, 2)).toHaveLength(1);
    expect(await save(job.id, `status = 'signed'`, 3)).toHaveLength(1);
    expect(await errorCode(save(job.id, `status = 'finished'`, 4))).toBe(CHECK_VIOLATION);
    expect(await save(job.id, `last_change_id = '${randomUUID()}'`, 4)).toHaveLength(1);
  });

  it('refuses a request digest that is not 64 lowercase hex characters', async () => {
    for (const digest of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}g`, ` ${'a'.repeat(63)}`]) {
      expect({ digest, code: await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { digest }))) }).toEqual({ digest, code: CHECK_VIOLATION });
    }
    await create(newJob(h.seed.a, h.seed.ownerA.actor, { digest: 'f'.repeat(64) }));
  });

  it('holds the property address to one line of at most 500 characters, with no padding', async () => {
    for (const address of [' 12 Main Street', '12 Main Street ', '12 Main\nStreet', '12 Main\tStreet', 'x'.repeat(501)]) {
      expect({ address, code: await errorCode(create(newJob(h.seed.a, h.seed.ownerA.actor, { address }))) }).toEqual({ address, code: CHECK_VIOLATION });
    }
    await create(newJob(h.seed.a, h.seed.ownerA.actor, { address: 'x'.repeat(500) }));
    await create(newJob(h.seed.a, h.seed.ownerA.actor, { address: '12 Main Street, Apt 4, Pasadena, CA 91101' }));
  });

  it('refuses a job with any required field missing', async () => {
    const values: Record<string, string> = {
      id: `'${randomUUID()}'::uuid`,
      company_id: `'${h.seed.a}'::uuid`,
      created_by_actor_id: `'${h.seed.ownerA.actor}'::uuid`,
      current_draft_id: `'${randomUUID()}'::uuid`,
      request_digest: `'${'a'.repeat(64)}'`,
    };
    for (const column of Object.keys(values)) {
      const columns = Object.keys(values).filter((name) => name !== column);
      const statement = `INSERT INTO jobs (${columns.join(', ')}) VALUES (${columns.map((name) => values[name]).join(', ')})`;
      expect({ column, code: await errorCode(h.admin.unsafe(statement)) }).toEqual({ column, code: '23502' });
    }
  });
});

describe('a customer and a claim', () => {
  let jobId: string;
  const insert = (table: string, set: Record<string, string | null>) => {
    const columns = ['company_id', 'job_id', ...Object.keys(set)];
    const values = [`'${h.seed.a}'::uuid`, `'${jobId}'::uuid`, ...Object.values(set).map((v) => (v === null ? 'NULL' : `'${v.replaceAll("'", "''")}'`))];
    return as(h.seed.a, (tx) => tx.execute(sqlOf(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')})`)));
  };

  beforeEach(async () => {
    jobId = (await seedJob(h.admin, newJob(h.seed.a, h.seed.ownerA.actor))).id;
  });

  it('holds at most one customer row and one claim row per job, and none without a job', async () => {
    await insert('job_customers', { name: 'Pat Customer' });
    await insert('job_claims', { carrier: 'Carrier Co' });
    expect(await errorCode(insert('job_customers', { name: 'Again' }))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(insert('job_claims', { carrier: 'Again' }))).toBe(UNIQUE_VIOLATION);
    expect(await errorCode(as(h.seed.a, (tx) => tx.execute(sql`INSERT INTO job_customers (company_id, job_id) VALUES (${h.seed.a}::uuid, ${randomUUID()}::uuid)`)))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('starts with every field empty and lets the runtime change the content columns', async () => {
    await insert('job_customers', {});
    await insert('job_claims', {});
    expect(await h.admin`SELECT name, phone, email FROM job_customers`).toEqual([{ name: '', phone: '', email: '' }]);
    expect(await h.admin`SELECT carrier, claim_number, policy_number, date_of_loss, loss_cause, adjuster_name, adjuster_email, adjuster_phone, deductible FROM job_claims`).toEqual([
      { carrier: '', claim_number: '', policy_number: '', date_of_loss: null, loss_cause: '', adjuster_name: '', adjuster_email: '', adjuster_phone: '', deductible: '' },
    ]);
    const changed = await as(h.seed.a, async (tx) => [
      rows(await tx.execute(sql`UPDATE job_customers SET name = 'Pat', phone = '555-0100', email = 'pat@example.test', updated_at = now() RETURNING job_id`)),
      rows(
        await tx.execute(sql`
          UPDATE job_claims SET carrier = 'Carrier Co', claim_number = 'CLM-1', policy_number = 'POL-9', date_of_loss = '2026-11-01', loss_cause = 'Burst pipe',
            adjuster_name = 'Alex Adjuster', adjuster_email = 'alex@example.test', adjuster_phone = '555-0111', deductible = '$1,000' RETURNING job_id`),
      ),
    ]);
    expect(changed.map((r) => r.length)).toEqual([1, 1]);
  });

  it('holds each customer field to one line within its limit, and an email to lowercase with an @', async () => {
    const limits: [string, number][] = [['name', 150], ['phone', 80]];
    for (const [column, max] of limits) {
      for (const value of [` ${'x'}`, 'x ', 'a\nb', 'x'.repeat(max + 1)]) {
        expect({ column, value, code: await errorCode(insert('job_customers', { [column]: value })) }).toEqual({ column, value, code: CHECK_VIOLATION });
      }
    }
    for (const email of ['Pat@Example.test', 'pat example.test', 'pat@', '@example.test', 'pat@example', ' pat@example.test', `${'x'.repeat(250)}@e.co`]) {
      expect({ email, code: await errorCode(insert('job_customers', { email })) }).toEqual({ email, code: CHECK_VIOLATION });
    }
    await insert('job_customers', { name: 'x'.repeat(150), phone: 'x'.repeat(80), email: 'pat.q+claims@example.test' });
  });

  it('holds each claim field to one line within its limit, and takes only a real date for the date of loss', async () => {
    const limits: [string, number][] = [['carrier', 150], ['claim_number', 80], ['policy_number', 80], ['loss_cause', 500], ['adjuster_name', 150], ['adjuster_phone', 80], ['deductible', 40]];
    for (const [column, max] of limits) {
      for (const value of ['x ', 'a\rb', 'x'.repeat(max + 1)]) {
        expect({ column, value, code: await errorCode(insert('job_claims', { [column]: value })) }).toEqual({ column, value, code: CHECK_VIOLATION });
      }
    }
    expect(await errorCode(insert('job_claims', { adjuster_email: 'Alex@Example.test' }))).toBe(CHECK_VIOLATION);
    // An impossible day or month is out of range (22008); text that is not a date at all is a bad format (22007).
    for (const [bad, code] of [['2026-02-30', '22008'], ['13/01/2026', '22008'], ['not a date', '22007'], ['', '22007']] as const) {
      expect({ bad, code: await errorCode(insert('job_claims', { date_of_loss: bad })) }).toEqual({ bad, code });
    }
    await insert('job_claims', { carrier: 'x'.repeat(150), loss_cause: 'x'.repeat(500), deductible: '$1,000 per occurrence', date_of_loss: '2026-11-01' });
  });
});

describe('the platform operator', () => {
  let a: Awaited<ReturnType<typeof seedFullJob>>;

  beforeEach(async () => {
    a = await seedFullJob(h.seed.a);
    await seedFullJob(h.seed.b);
  });

  const counts = (tx: CompanyTransaction) =>
    tx.execute(sql`
      SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM job_customers) AS customers,
             (SELECT count(*)::int FROM job_claims) AS claims, (SELECT count(*)::int FROM evidence_objects) AS evidence
    `);

  it('reads one company’s jobs in a read-only context that names it, and nothing without one', async () => {
    expect(await asOperator(counts, true)).toEqual([{ jobs: 1, customers: 1, claims: 1, evidence: 1 }]);
    expect(await asOperator(counts, true, null)).toEqual([{ jobs: 0, customers: 0, claims: 0, evidence: 0 }]);
  });

  it('cannot write a job, a customer, a claim or an evidence row, in a read-only context or not', async () => {
    const before = await everything(h.admin);
    const writes: ((tx: CompanyTransaction) => Promise<unknown>)[] = [
      (tx) => insertJob(tx, newJob(h.seed.a, h.seed.ownerA.actor)),
      (tx) => tx.execute(sql`INSERT INTO job_customers (company_id, job_id) VALUES (${h.seed.b}::uuid, ${randomUUID()}::uuid)`),
      (tx) => tx.execute(sql`INSERT INTO job_claims (company_id, job_id) VALUES (${h.seed.a}::uuid, ${a.job.id}::uuid)`),
      (tx) => insertEvidence(tx, newEvidence(h.seed.a, a.job.id, h.seed.ownerA.actor)),
    ];
    for (const write of writes) {
      expect(await errorCode(asOperator(write))).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await errorCode(asOperator(write, true))).toBe(READ_ONLY_TRANSACTION);
    }
    const updates = (tx: CompanyTransaction) =>
      tx.execute(sql`
        WITH j AS (UPDATE jobs SET property_address = 'Support edit', revision = 2 RETURNING 1),
             c AS (UPDATE job_customers SET name = 'Support edit' RETURNING 1),
             l AS (UPDATE job_claims SET carrier = 'Support edit' RETURNING 1)
        SELECT (SELECT count(*)::int FROM j) AS jobs, (SELECT count(*)::int FROM c) AS customers, (SELECT count(*)::int FROM l) AS claims
      `);
    // An update finds no row it may change, and in a read-only context it is refused outright.
    expect(await asOperator(updates)).toEqual([{ jobs: 0, customers: 0, claims: 0 }]);
    expect(await errorCode(asOperator(updates, true))).toBe(READ_ONLY_TRANSACTION);
    expect(await everything(h.admin)).toBe(before);
  });
});
