import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withCompany, withOperator, type CompanyTransaction } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, INSUFFICIENT_PRIVILEGE, UNIQUE_VIOLATION, digestOf, errorCode, newJob, seedJob } from './job-harness';
import { agreementOf, insertAgreement, seedChain } from './submission-harness';
import { resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// S5b-1: migration 0015's three tables (job_assignments, job_coordination, agreement_corrections) as
// the app's runtime role on a server set up like a fresh Cloud SQL instance (team-harness.ts). The
// routes over the first two are in office-jobs-api.test.ts and office-jobs-field-owner.test.ts; the corrections' routes come with S5b-4.
const TABLES = ['agreement_corrections', 'job_assignments', 'job_coordination'];

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, h ?? null);
});

afterAll(async () => {
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const as = <T>(company: string, run: (tx: CompanyTransaction) => Promise<T>) => withCompany(h.handle.db, company, run);
const asOperator = <T>(run: (tx: CompanyTransaction) => Promise<T>, readOnly = false) =>
  withOperator(h.handle.db, h.seed.operator, run, { companyId: h.seed.a, readOnly });
const rows = <T>(result: unknown) => result as unknown as T[];
const run = (company: string, text: string) => errorCode(as(company, (tx) => tx.execute(sql.raw(text))));

async function jobOf(company = h.seed.a) {
  return seedJob(h.admin, newJob(company, company === h.seed.a ? h.seed.ownerA.actor : h.seed.ownerB.actor));
}

// An active assignment of estimator A to the job, written by the runtime in company A.
async function assignment(jobId: string, id = randomUUID(), estimator = h.seed.estimatorA.actor) {
  await as(h.seed.a, (tx) =>
    tx.execute(sql`
      INSERT INTO job_assignments (id, company_id, job_id, estimator_actor_id, request_digest, assigned_by_actor_id)
      VALUES (${id}::uuid, ${h.seed.a}::uuid, ${jobId}::uuid, ${estimator}::uuid, ${digestOf(id)}, ${h.seed.officeA.actor}::uuid)
    `),
  );
  return id;
}

describe('migration 0015: the office tables', () => {
  it('forces row-level security with company policies, and gives the runtime no DELETE and only the columns it changes', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
    const found = await h.admin<{ name: string; forced: boolean; policies: string[] }[]>`
      SELECT c.relname AS name, c.relforcerowsecurity AS forced, array(SELECT p.polname::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS policies
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY(${TABLES}) ORDER BY 1
    `;
    expect(found).toEqual([
      { name: 'agreement_corrections', forced: true, policies: ['agreement_corrections_insert', 'agreement_corrections_select'] },
      { name: 'job_assignments', forced: true, policies: ['job_assignments_insert', 'job_assignments_select', 'job_assignments_update'] },
      { name: 'job_coordination', forced: true, policies: ['job_coordination_insert', 'job_coordination_select', 'job_coordination_update'] },
    ]);
    const rights = await h.admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) ORDER BY 1, 2
    `;
    expect(rights).toEqual(TABLES.flatMap((table) => [{ table, privilege: 'INSERT' }, { table, privilege: 'SELECT' }]));
    const updates = await h.admin<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = ANY(${TABLES}) AND privilege_type = 'UPDATE' ORDER BY 1, 2
    `;
    expect(updates).toEqual([
      { table: 'job_assignments', column: 'ended_at' },
      { table: 'job_assignments', column: 'ended_by_actor_id' },
      { table: 'job_coordination', column: 'drying_watch' },
      { table: 'job_coordination', column: 'last_change_id' },
      { table: 'job_coordination', column: 'office_notes' },
      { table: 'job_coordination', column: 'revision' },
      { table: 'job_coordination', column: 'updated_at' },
    ]);
    const job = await jobOf();
    const id = await assignment(job.id);
    await as(h.seed.a, (tx) => tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${h.seed.a}::uuid, ${job.id}::uuid, 'Gate code')`));
    for (const table of ['job_assignments', 'job_coordination']) {
      expect({ table, code: await run(h.seed.a, `DELETE FROM ${table} WHERE company_id = '${h.seed.a}'`) }).toEqual({ table, code: INSUFFICIENT_PRIVILEGE });
      expect({ table, code: await run(h.seed.a, `TRUNCATE ${table}`) }).toEqual({ table, code: INSUFFICIENT_PRIVILEGE });
    }
    // The other company sees and changes nothing.
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT id FROM job_assignments`)))).toEqual([]);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT job_id FROM job_coordination`)))).toEqual([]);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE job_coordination SET office_notes = 'x' RETURNING job_id`)))).toEqual([]);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`UPDATE job_assignments SET ended_by_actor_id = ${h.seed.ownerB.actor}::uuid RETURNING id`)))).toEqual([]);
    // Company B cannot write a row into company A, nor point its own row at A's job.
    expect(
      await errorCode(
        as(h.seed.b, (tx) =>
          tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${h.seed.a}::uuid, ${job.id}::uuid, 'planted')`),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(
        as(h.seed.b, (tx) => tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${h.seed.b}::uuid, ${job.id}::uuid, 'planted')`)),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);
    // An operator reads them, and never writes.
    const seen = await asOperator((tx) => tx.execute(sql`SELECT id::text FROM job_assignments`), true);
    expect(rows(seen)).toEqual([{ id }]);
    expect(rows(await asOperator((tx) => tx.execute(sql`UPDATE job_coordination SET office_notes = 'operator' RETURNING job_id`)))).toEqual([]);
    expect(
      await errorCode(
        asOperator((tx) =>
          tx.execute(sql`
            INSERT INTO job_assignments (id, company_id, job_id, estimator_actor_id, request_digest, assigned_by_actor_id)
            VALUES (${randomUUID()}::uuid, ${h.seed.a}::uuid, ${job.id}::uuid, ${h.seed.estimatorA.actor}::uuid, ${'0'.repeat(64)}, ${h.seed.ownerA.actor}::uuid)
          `),
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('keeps one active assignment per job and estimator, ends one once, and never changes who or what', async () => {
    const job = await jobOf();
    const id = await assignment(job.id);
    expect(await errorCode(assignment(job.id))).toBe(UNIQUE_VIOLATION);
    // Another company's estimator is not a person of this company.
    expect(await errorCode(assignment(job.id, randomUUID(), h.seed.estimatorB.actor))).toBe(FOREIGN_KEY_VIOLATION);
    for (const set of [
      `estimator_actor_id = '${h.seed.ownerA.actor}'`,
      `job_id = '${(await jobOf()).id}'`,
      `assigned_at = now() - interval '1 day'`,
      `request_digest = '${'1'.repeat(64)}'`,
    ]) {
      expect({ set, code: await run(h.seed.a, `UPDATE job_assignments SET ${set} WHERE id = '${id}'`) }).toEqual({ set, code: INSUFFICIENT_PRIVILEGE });
    }
    // Only an end with who ended it; the time is the clock's.
    expect(await run(h.seed.a, `UPDATE job_assignments SET ended_at = now() WHERE id = '${id}'`)).toBe(CHECK_VIOLATION);
    await as(h.seed.a, (tx) =>
      tx.execute(sql.raw(`UPDATE job_assignments SET ended_by_actor_id = '${h.seed.officeA.actor}', ended_at = '2000-01-01' WHERE id = '${id}'`)),
    );
    const [ended] = await h.admin<{ ended_at: Date }[]>`SELECT ended_at FROM job_assignments WHERE id = ${id}`;
    expect(ended!.ended_at.getFullYear()).toBeGreaterThan(2000);
    // An ended row never changes again, and the estimator may be assigned anew.
    expect(await run(h.seed.a, `UPDATE job_assignments SET ended_by_actor_id = '${h.seed.ownerA.actor}' WHERE id = '${id}'`)).toBe(CHECK_VIOLATION);
    await assignment(job.id);
    expect(await h.admin`SELECT count(*)::int AS n FROM job_assignments WHERE ended_at IS NULL`).toEqual([{ n: 1 }]);
  });

  it('lets a job change its field owner and nothing else without a new revision; every other change still moves it by one', async () => {
    const job = await jobOf();
    const [before] = await h.admin<{ revision: number }[]>`SELECT revision FROM jobs WHERE id = ${job.id}`;
    const owner = h.seed.estimatorA.actor;
    expect(await run(h.seed.a, `UPDATE jobs SET field_owner_actor_id = '${owner}' WHERE id = '${job.id}'`)).toBeUndefined();
    expect(await h.admin`SELECT field_owner_actor_id::text AS owner, revision FROM jobs WHERE id = ${job.id}`).toEqual([{ owner, revision: before!.revision }]);
    expect(await run(h.seed.a, `UPDATE jobs SET field_owner_actor_id = NULL, property_address = 'Elsewhere' WHERE id = '${job.id}'`)).toBe(CHECK_VIOLATION);
    expect(await run(h.seed.a, `UPDATE jobs SET property_address = 'Elsewhere' WHERE id = '${job.id}'`)).toBe(CHECK_VIOLATION);
    expect(await run(h.seed.a, `UPDATE jobs SET property_address = 'Elsewhere', revision = revision + 1 WHERE id = '${job.id}'`)).toBeUndefined();
  });

  it('holds office notes to 4,000 characters of text, with line breaks and tabs but no other control character', async () => {
    const job = await jobOf();
    const insert = (notes: string) =>
      errorCode(as(h.seed.a, (tx) => tx.execute(sql`INSERT INTO job_coordination (company_id, job_id, office_notes) VALUES (${h.seed.a}::uuid, ${job.id}::uuid, ${notes})`)));
    expect(await insert('x'.repeat(4001))).toBe(CHECK_VIOLATION);
    expect(await insert('bell\u0007')).toBe(CHECK_VIOLATION);
    expect(await insert('escape\u001b')).toBe(CHECK_VIOLATION);
    expect(await insert('delete\u007f')).toBe(CHECK_VIOLATION);
    expect(await insert('Gate code 1234\r\n\tDog in yard')).toBeUndefined();
    expect(await insert('again')).toBe(UNIQUE_VIOLATION);
  });

  it('keeps a correction insert-only, beside a signed agreement of the same job, within the corrected column’s limits', async () => {
    const chain = await seedChain(h.admin, h.seed.a, h.seed.ownerA.actor);
    const [agreement] = await as(h.seed.a, (tx) => insertAgreement(tx, agreementOf(chain)));
    const correct = (field: string, value: string, jobId = chain.job.id, id = randomUUID()) =>
      errorCode(
        as(h.seed.a, (tx) =>
          tx.execute(sql`
            INSERT INTO agreement_corrections (id, company_id, job_id, agreement_id, field, value, request_digest, created_by_actor_id)
            VALUES (${id}::uuid, ${h.seed.a}::uuid, ${jobId}::uuid, ${agreement!.id}::uuid, ${field}, ${value}, ${digestOf(id)}, ${h.seed.officeA.actor}::uuid)
          `),
        ),
      );
    const id = randomUUID();
    expect(await correct('customer_name', 'Pat Corrected', chain.job.id, id)).toBeUndefined();
    expect(await correct('property_address', '12 Corrected Way')).toBeUndefined();
    expect(await correct('customer_email', 'pat@example.test')).toBeUndefined();
    expect(await correct('customer_email', 'Pat@Example.test')).toBe(CHECK_VIOLATION);
    expect(await correct('customer_email', 'not an email')).toBe(CHECK_VIOLATION);
    expect(await correct('customer_name', 'x'.repeat(151))).toBe(CHECK_VIOLATION);
    expect(await correct('customer_phone', '5'.repeat(81))).toBe(CHECK_VIOLATION);
    expect(await correct('property_address', ' padded')).toBe(CHECK_VIOLATION);
    expect(await correct('claim_number', 'CL-2')).toBe(CHECK_VIOLATION);
    // The agreement must be of the same job.
    expect(await correct('customer_name', 'Pat', (await jobOf()).id)).toBe(FOREIGN_KEY_VIOLATION);
    expect(await run(h.seed.a, `UPDATE agreement_corrections SET value = 'changed' WHERE id = '${id}'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await run(h.seed.a, `DELETE FROM agreement_corrections WHERE id = '${id}'`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(rows(await as(h.seed.b, (tx) => tx.execute(sql`SELECT id FROM agreement_corrections`)))).toEqual([]);
    expect(await h.admin`SELECT count(*)::int AS n FROM agreement_corrections`).toEqual([{ n: 3 }]);
  });
});
