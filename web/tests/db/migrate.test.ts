import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory, readMigrations } from '@/db/migrate';
import { companies, migrationLedger } from '@/db/schema';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';

const exec = promisify(execFile);
const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHIPPED = ['0001_foundation', '0002_identity', '0003_runtime_role', '0004_sign_in_lookup', '0005_access_projection', '0006_platform_operator', '0007_sign_in_address', '0008_feature_flag_writes', '0009_price_tables', '0010_core_job_tables', '0011_submissions_agreements', '0012_ai_live_tables', '0013_company_documents', '0014_signing_links'];
const SHIPPED_TABLES = [
  'access_projection_outbox',
  'actors',
  'agreements',
  'ai_ledger',
  'ai_results',
  'audit_events',
  'auth_tenants',
  'companies',
  'company_ai_settings',
  'company_feature_flags',
  'document_links',
  'evidence_objects',
  'invitations',
  'job_claims',
  'job_customers',
  'job_estimates',
  'job_price_pins',
  'job_submissions',
  'jobs',
  'live_sessions',
  'live_turns',
  'live_usage',
  'member_voice_settings',
  'memberships',
  'migration_ledger',
  'platform_admins',
  'price_table_versions',
  'price_table_working_copies',
  'signing_links',
  'voice_notes',
];
// The tables as of 0013, for the test of that file, which a later file (0014) adds tables after.
const TABLES_TO_0013 = SHIPPED_TABLES.filter((table) => table !== 'document_links' && table !== 'signing_links');

// Every column of companies from 0001 to 0012, so a test of an earlier file compares the rows it
// planted while a later file (0013) adds columns of its own.
const COMPANY_COLUMNS_TO_0012 =
  'id, created_at, name, sign_in_slug, status, auth_tenant_id, auth_tenant_kind, updated_at, profile_address, profile_phone, profile_email, profile_license, profile_signoff';

let disposable: DisposablePostgres;

beforeAll(async () => {
  disposable = await startDisposablePostgres();
});

afterAll(async () => {
  await disposable?.stop();
});

beforeEach(async () => {
  await emptyDiscardDatabase(disposable.databaseUrl);
});

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(disposable.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function tableNames(): Promise<string[]> {
  const rows = await withSql(
    (sql) => sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
    `,
  );
  return rows.map((row) => row.tablename);
}

async function tempMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)));
  return dir;
}

describe('numbered migration ledger', () => {
  it('applies the foundation from an empty database and records the checksum', async () => {
    expect(await tableNames()).toEqual([]);
    const files = await readMigrations(migrationsDirectory);
    const first = await applyMigrations(disposable.databaseUrl, migrationsDirectory);
    expect(first.applied).toEqual(SHIPPED);
    expect(await tableNames()).toEqual(SHIPPED_TABLES);

    const columns = await withSql(
      (sql) => sql<{ column_name: string; data_type: string }[]>`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'companies'
        ORDER BY ordinal_position
      `,
    );
    expect(columns).toEqual([
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'name', data_type: 'text' },
      { column_name: 'sign_in_slug', data_type: 'text' },
      { column_name: 'status', data_type: 'text' },
      { column_name: 'auth_tenant_id', data_type: 'text' },
      { column_name: 'auth_tenant_kind', data_type: 'text' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
      // 0010: the company profile the documents print.
      { column_name: 'profile_address', data_type: 'text' },
      { column_name: 'profile_phone', data_type: 'text' },
      { column_name: 'profile_email', data_type: 'text' },
      { column_name: 'profile_license', data_type: 'text' },
      { column_name: 'profile_signoff', data_type: 'text' },
      // 0013: the letterhead lines and the document settings.
      { column_name: 'profile_emergency_phone', data_type: 'text' },
      { column_name: 'profile_fax', data_type: 'text' },
      { column_name: 'profile_website', data_type: 'text' },
      { column_name: 'profile_tagline', data_type: 'text' },
      { column_name: 'profile_mailing_address', data_type: 'text' },
      { column_name: 'profile_documents', data_type: 'jsonb' },
    ]);

    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: disposable.databaseUrl });
    try {
      const inserted = await handle.db.insert(companies).values({ name: 'Example' }).returning();
      expect(inserted[0]?.id).toMatch(UUID);
      expect(inserted[0]?.createdAt).toBeInstanceOf(Date);
      const ledger = await handle.db.select().from(migrationLedger);
      expect(ledger.map((row) => row.id).sort()).toEqual(SHIPPED);
      for (const file of files) {
        expect(ledger.find((row) => row.id === file.id)?.checksum).toBe(file.checksum);
      }
    } finally {
      await handle.close();
    }

    const appliedAt = await withSql(async (sql) => {
      const rows = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM migration_ledger ORDER BY id`;
      return rows.map((row) => row.applied_at);
    });
    const second = await applyMigrations(disposable.databaseUrl, migrationsDirectory);
    expect(second.applied).toEqual([]);
    const again = await withSql(async (sql) => {
      const rows = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM migration_ledger ORDER BY id`;
      return rows.map((row) => row.applied_at);
    });
    expect(again).toEqual(appliedAt);
  });

  it('refuses a gap without writing', async () => {
    const foundation = (await readMigrations(migrationsDirectory))[0]?.sql ?? '';
    const gap = await tempMigrations({
      '0001_foundation.sql': foundation,
      '0003_gap.sql': 'CREATE TABLE skipped (id integer);\n',
    });
    try {
      await expect(applyMigrations(disposable.databaseUrl, gap)).rejects.toThrow(/out of order/);
      expect(await tableNames()).toEqual([]);
    } finally {
      await rm(gap, { recursive: true, force: true });
    }
  });

  it('does not record a file that ends the runner transaction', async () => {
    const foundation = (await readMigrations(migrationsDirectory))[0]?.sql ?? '';
    for (const ending of ['ROLLBACK', 'COMMIT']) {
      await emptyDiscardDatabase(disposable.databaseUrl);
      const dir = await tempMigrations({
        '0001_foundation.sql': foundation,
        '0002_ends.sql': `CREATE TABLE example (id integer);\n${ending};\n`,
      });
      try {
        await expect(applyMigrations(disposable.databaseUrl, dir)).rejects.toThrow(
          /0002_ends\.sql failed: it ended the runner's transaction/,
        );
        const ids = await withSql(async (sql) => {
          const rows = await sql<{ id: string }[]>`SELECT id FROM migration_ledger ORDER BY id`;
          return rows.map((row) => row.id);
        });
        expect(ids).toEqual(['0001_foundation']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('rolls back a failing file and applies it on the next run', async () => {
    const foundation = (await readMigrations(migrationsDirectory))[0]?.sql ?? '';
    const dir = await tempMigrations({
      '0001_foundation.sql': foundation,
      '0002_bad.sql': 'SELECT 1/0;\n',
    });
    try {
      await expect(applyMigrations(disposable.databaseUrl, dir)).rejects.toThrow(/0002_bad\.sql/);
      const ids = await withSql(async (sql) => {
        const rows = await sql<{ id: string }[]>`SELECT id FROM migration_ledger ORDER BY id`;
        return rows.map((row) => row.id);
      });
      expect(ids).toEqual(['0001_foundation']);
      await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE applied_second (id integer);\n');
      const second = await applyMigrations(disposable.databaseUrl, dir);
      expect(second.applied).toEqual(['0002_bad']);
      expect(await tableNames()).toEqual(['applied_second', 'companies', 'migration_ledger']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a changed file that was already applied', async () => {
    const foundation = (await readMigrations(migrationsDirectory))[0]?.sql ?? '';
    const dir = await tempMigrations({ '0001_foundation.sql': foundation });
    try {
      await applyMigrations(disposable.databaseUrl, dir);
      const checksum = await withSql(async (sql) => {
        const rows = await sql<{ checksum: string }[]>`SELECT checksum FROM migration_ledger`;
        return rows[0]?.checksum;
      });
      await writeFile(join(dir, '0001_foundation.sql'), `${foundation}\n-- edited\n`);
      await expect(applyMigrations(disposable.databaseUrl, dir)).rejects.toThrow(/different bytes/);
      const still = await withSql(async (sql) => {
        const rows = await sql<{ checksum: string }[]>`SELECT checksum FROM migration_ledger`;
        return rows[0]?.checksum;
      });
      expect(still).toBe(checksum);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets one applier wait while the other records the same file once', async () => {
    const [first, second] = await Promise.all([
      applyMigrations(disposable.databaseUrl, migrationsDirectory),
      applyMigrations(disposable.databaseUrl, migrationsDirectory),
    ]);
    expect([...first.applied, ...second.applied].sort()).toEqual(SHIPPED);
    const count = await withSql(async (sql) => {
      const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM migration_ledger`;
      return rows[0]?.count;
    });
    expect(count).toBe(String(SHIPPED.length));
  });

  it('keeps a second applier waiting when a migration drops its session locks', async () => {
    const foundation = (await readMigrations(migrationsDirectory))[0]?.sql ?? '';
    const dir = await tempMigrations({
      '0001_foundation.sql': foundation,
      '0002_slow.sql':
        'SELECT pg_advisory_unlock_all();\nSELECT pg_sleep(1);\nCREATE TABLE second_step (id integer);\n',
    });
    try {
      const [first, second] = await Promise.all([
        applyMigrations(disposable.databaseUrl, dir),
        applyMigrations(disposable.databaseUrl, dir),
      ]);
      expect([...first.applied, ...second.applied].sort()).toEqual(['0001_foundation', '0002_slow']);
      expect(await tableNames()).toEqual(['companies', 'migration_ledger', 'second_step']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the price tables to a database already holding 0001 to 0008 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0009');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 8));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 8));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT id, created_at, name, sign_in_slug, status, auth_tenant_id, auth_tenant_kind, updated_at FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          flags: await sql`SELECT * FROM company_feature_flags ORDER BY company_id, flag`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-x') RETURNING id
        `;
        await sql`INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test')`;
        await sql`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company!.id}, 'price_books', true)`;
      });
      const before = await holding();
      expect(before.tables).not.toContain('price_table_versions');
      expect((await applyMigrations(disposable.databaseUrl, migrationsDirectory)).applied).toEqual(SHIPPED.slice(8));
      const after = await holding();
      expect({ ...after, tables: [] }).toEqual({ ...before, tables: [] });
      expect(after.tables).toEqual(SHIPPED_TABLES);
      const counts = await withSql(
        (sql) => sql<{ versions: number; copies: number }[]>`
          SELECT (SELECT count(*)::int FROM price_table_versions) AS versions,
                 (SELECT count(*)::int FROM price_table_working_copies) AS copies
        `,
      );
      expect(counts).toEqual([{ versions: 0, copies: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the job tables and company profile to a database already holding 0001 to 0009 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0010');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 9));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 9));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT id, name, sign_in_slug, status, auth_tenant_id, created_at, updated_at FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          flags: await sql`SELECT * FROM company_feature_flags ORDER BY company_id, flag`,
          versions: await sql`SELECT id, company_id, sequence, content_hash FROM price_table_versions ORDER BY id`,
          copies: await sql`SELECT * FROM price_table_working_copies ORDER BY company_id`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-x') RETURNING id
        `;
        const [actor] = await sql<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test') RETURNING id
        `;
        await sql`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${company!.id}, 'price_books', true)`;
        await sql`
          INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
          VALUES (${company!.id}, 1, '{}'::jsonb, ${'a'.repeat(64)}, 'dryscope-v3', 'First prices', 'blank', ${actor!.id}, 'publish-key-000001')
        `;
        await sql`INSERT INTO price_table_working_copies (company_id, base_sequence, content) VALUES (${company!.id}, 1, '{}'::jsonb)`;
      });
      const before = await holding();
      expect(before.tables).not.toContain('jobs');
      expect((await applyMigrations(disposable.databaseUrl, migrationsDirectory)).applied).toEqual(SHIPPED.slice(9));
      const after = await holding();
      expect({ ...after, tables: [] }).toEqual({ ...before, tables: [] });
      expect(after.tables).toEqual(SHIPPED_TABLES);
      // The existing company keeps its row and starts with an empty profile; no job rows exist.
      const [profile] = await withSql(
        (sql) => sql`
          SELECT profile_address, profile_phone, profile_email, profile_license, profile_signoff FROM companies WHERE sign_in_slug = 'existing'
        `,
      );
      expect(profile).toEqual({ profile_address: '', profile_phone: '', profile_email: '', profile_license: '', profile_signoff: '' });
      const counts = await withSql(
        (sql) => sql<{ jobs: number; customers: number; claims: number; evidence: number }[]>`
          SELECT (SELECT count(*)::int FROM jobs) AS jobs, (SELECT count(*)::int FROM job_customers) AS customers,
                 (SELECT count(*)::int FROM job_claims) AS claims, (SELECT count(*)::int FROM evidence_objects) AS evidence
        `,
      );
      expect(counts).toEqual([{ jobs: 0, customers: 0, claims: 0, evidence: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the submission, pin, estimate and agreement tables to a database already holding 0001 to 0010 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0011');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 10));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 10));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT ${sql.unsafe(COMPANY_COLUMNS_TO_0012)} FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          versions: await sql`SELECT id, company_id, sequence, content_hash FROM price_table_versions ORDER BY id`,
          jobs: await sql`SELECT * FROM jobs ORDER BY id`,
          evidence: await sql`SELECT id, company_id, job_id, kind, object_name FROM evidence_objects ORDER BY id`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-x') RETURNING id
        `;
        const [actor] = await sql<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test') RETURNING id
        `;
        await sql`
          INSERT INTO price_table_versions (company_id, sequence, content, content_hash, engine_version, reason, source, published_by_actor_id, publish_key)
          VALUES (${company!.id}, 1, '{}'::jsonb, ${'a'.repeat(64)}, 'dryscope-v3', 'First prices', 'blank', ${actor!.id}, 'publish-key-000001')
        `;
        const [job] = await sql<{ id: string }[]>`
          INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
          VALUES (gen_random_uuid(), ${company!.id}, ${actor!.id}, gen_random_uuid(), ${'b'.repeat(64)}) RETURNING id
        `;
        const object = '11111111-1111-4111-8111-111111111111';
        await sql`
          INSERT INTO evidence_objects (company_id, job_id, object_id, kind, object_name, generation, sha256, size_bytes, content_type, created_by_actor_id)
          VALUES (${company!.id}, ${job!.id}, ${object}, 'photo', ${`companies/${company!.id}/jobs/${job!.id}/photos/${object}`}, 1, ${'c'.repeat(64)}, 10, 'image/jpeg', ${actor!.id})
        `;
      });
      const before = await holding();
      expect(before.tables).not.toContain('job_submissions');
      expect((await applyMigrations(disposable.databaseUrl, migrationsDirectory)).applied).toEqual(SHIPPED.slice(10));
      const after = await holding();
      expect({ ...after, tables: [] }).toEqual({ ...before, tables: [] });
      expect(after.tables).toEqual(SHIPPED_TABLES);
      const counts = await withSql(
        (sql) => sql<{ submissions: number; pins: number; estimates: number; agreements: number }[]>`
          SELECT (SELECT count(*)::int FROM job_submissions) AS submissions, (SELECT count(*)::int FROM job_price_pins) AS pins,
                 (SELECT count(*)::int FROM job_estimates) AS estimates, (SELECT count(*)::int FROM agreements) AS agreements
        `,
      );
      expect(counts).toEqual([{ submissions: 0, pins: 0, estimates: 0, agreements: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the AI and Live tables to a database already holding 0001 to 0011 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0012');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 11));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 11));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT ${sql.unsafe(COMPANY_COLUMNS_TO_0012)} FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          jobs: await sql`SELECT * FROM jobs ORDER BY id`,
          submissions: await sql`SELECT id, company_id, job_id, status FROM job_submissions ORDER BY id`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-x') RETURNING id
        `;
        const [actor] = await sql<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test') RETURNING id
        `;
        const [job] = await sql<{ id: string }[]>`
          INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
          VALUES (gen_random_uuid(), ${company!.id}, ${actor!.id}, gen_random_uuid(), ${'b'.repeat(64)}) RETURNING id
        `;
        await sql`
          INSERT INTO job_submissions (id, company_id, job_id, draft_id, epoch, kind, request_digest, expires_at, created_by_actor_id)
          VALUES (gen_random_uuid(), ${company!.id}, ${job!.id}, gen_random_uuid(), gen_random_uuid(), 'original', ${'c'.repeat(64)}, now() + interval '15 minutes', ${actor!.id})
        `;
      });
      const before = await holding();
      expect(before.tables).not.toContain('live_sessions');
      expect((await applyMigrations(disposable.databaseUrl, migrationsDirectory)).applied).toEqual(SHIPPED.slice(11));
      const after = await holding();
      expect({ ...after, tables: [] }).toEqual({ ...before, tables: [] });
      expect(after.tables).toEqual(SHIPPED_TABLES);
      const counts = await withSql(
        (sql) => sql<Record<string, number>[]>`
          SELECT (SELECT count(*)::int FROM company_ai_settings) AS settings, (SELECT count(*)::int FROM ai_ledger) AS ledger,
                 (SELECT count(*)::int FROM ai_results) AS results, (SELECT count(*)::int FROM live_sessions) AS sessions,
                 (SELECT count(*)::int FROM live_usage) AS usage, (SELECT count(*)::int FROM live_turns) AS turns,
                 (SELECT count(*)::int FROM voice_notes) AS notes, (SELECT count(*)::int FROM member_voice_settings) AS voices
        `,
      );
      expect(counts).toEqual([{ settings: 0, ledger: 0, results: 0, sessions: 0, usage: 0, turns: 0, notes: 0, voices: 0 }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the letterhead fields and document settings to a database already holding 0001 to 0012 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0013');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 12));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 12));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT ${sql.unsafe(COMPANY_COLUMNS_TO_0012)} FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          jobs: await sql`SELECT * FROM jobs ORDER BY id`,
          settings: await sql`SELECT * FROM company_ai_settings ORDER BY company_id`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company'), ('tenant-y', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id, profile_address, profile_license, profile_signoff)
          VALUES ('Existing', 'existing', 'tenant-x', '1 Existing Way', '000001', 'Pat Existing') RETURNING id
        `;
        await sql`INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Other', 'other', 'tenant-y')`;
        const [actor] = await sql<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test') RETURNING id
        `;
        await sql`
          INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
          VALUES (gen_random_uuid(), ${company!.id}, ${actor!.id}, gen_random_uuid(), ${'b'.repeat(64)})
        `;
        await sql`INSERT INTO company_ai_settings (company_id) VALUES (${company!.id})`;
      });
      const before = await holding();
      // Up to and including 0013 only: 0014 adds tables of its own (its own test is below).
      const through = await tempMigrations(
        Object.fromEntries((await readMigrations(migrationsDirectory)).filter((file) => file.id < '0014').map((file) => [`${file.id}.sql`, file.sql])),
      );
      const migrated = await applyMigrations(disposable.databaseUrl, through).finally(() => rm(through, { recursive: true, force: true }));
      expect(migrated.applied).toEqual(SHIPPED.slice(12, 13));
      expect(migrated.applied).toEqual(['0013_company_documents']);
      const after = await holding();
      // Every row and every earlier column is as it was, and no table is added.
      expect(after).toEqual(before);
      expect(after.tables).toEqual(TABLES_TO_0013);
      // Both companies start with the letterhead empty and the settings at their neutral defaults
      // ('{}'): no company's own values are seeded.
      const added = await withSql(
        (sql) => sql`
          SELECT sign_in_slug, profile_emergency_phone, profile_fax, profile_website, profile_tagline, profile_mailing_address, profile_documents
          FROM companies ORDER BY sign_in_slug
        `,
      );
      const empty = { profile_emergency_phone: '', profile_fax: '', profile_website: '', profile_tagline: '', profile_mailing_address: '', profile_documents: {} };
      expect(added).toEqual([
        { sign_in_slug: 'existing', ...empty },
        { sign_in_slug: 'other', ...empty },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the signing and document link tables to a database already holding 0001 to 0013 and its rows', async () => {
    const earlier = (await readMigrations(migrationsDirectory)).filter((file) => file.id < '0014');
    expect(earlier.map((file) => file.id)).toEqual(SHIPPED.slice(0, 13));
    const dir = await tempMigrations(Object.fromEntries(earlier.map((file) => [`${file.id}.sql`, file.sql])));
    try {
      expect((await applyMigrations(disposable.databaseUrl, dir)).applied).toEqual(SHIPPED.slice(0, 13));
      const holding = async () =>
        withSql(async (sql) => ({
          companies: await sql`SELECT * FROM companies ORDER BY id`,
          actors: await sql`SELECT * FROM actors ORDER BY id`,
          jobs: await sql`SELECT * FROM jobs ORDER BY id`,
          tables: await tableNames(),
        }));
      await withSql(async (sql) => {
        await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
        const [company] = await sql<{ id: string }[]>`
          INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Existing', 'existing', 'tenant-x') RETURNING id
        `;
        const [actor] = await sql<{ id: string }[]>`
          INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (${company!.id}, 'tenant-x', 'u1', 'u1@example.test') RETURNING id
        `;
        await sql`
          INSERT INTO jobs (id, company_id, created_by_actor_id, current_draft_id, request_digest)
          VALUES (gen_random_uuid(), ${company!.id}, ${actor!.id}, gen_random_uuid(), ${'b'.repeat(64)})
        `;
      });
      const before = await holding();
      expect(before.tables).toEqual(TABLES_TO_0013);
      const migrated = await applyMigrations(disposable.databaseUrl, migrationsDirectory);
      expect(migrated.applied).toEqual(['0014_signing_links']);
      const after = await holding();
      // Every row is as it was; the two link tables are added, empty.
      expect({ ...after, tables: [] }).toEqual({ ...before, tables: [] });
      expect(after.tables).toEqual(SHIPPED_TABLES);
      const counts = await withSql(
        (sql) => sql`SELECT (SELECT count(*)::int FROM signing_links) AS signing, (SELECT count(*)::int FROM document_links) AS documents`,
      );
      expect(counts).toEqual([{ signing: 0, documents: 0 }]);
      // agreements gains two nullable columns, last, so every row signed so far (on a device) keeps
      // them empty.
      const columns = await withSql(
        (sql) => sql`
          SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'agreements' ORDER BY ordinal_position DESC LIMIT 2
        `,
      );
      expect(columns).toEqual([
        { column_name: 'signer_role', is_nullable: 'YES' },
        { column_name: 'signing_link_id', is_nullable: 'YES' },
      ]);
      const signedSoFar = await withSql((sql) => sql`SELECT count(*)::int AS rows, count(signer_role)::int AS roles, count(signing_link_id)::int AS links FROM agreements`);
      expect(signedSoFar[0]!.roles).toBe(0);
      expect(signedSoFar[0]!.links).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates a separate throwaway database from an external URL', async () => {
    const second = await startDisposablePostgres({
      APP_ENV: 'test',
      DATABASE_URL: disposable.databaseUrl,
      DRYSCOPE_DISPOSABLE_DATABASE: '1',
    });
    const sql = postgres(second.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      expect(second.databaseName).toMatch(/^dryscope_discard_[a-f0-9]{16}$/);
      expect(second.databaseName).not.toBe(disposable.databaseName);
      const rows = await sql<{ name: string }[]>`SELECT current_database() AS name`;
      expect(rows[0]?.name).toBe(second.databaseName);
    } finally {
      await sql.end({ timeout: 5 });
      await second.stop();
    }
  });

  it('reads APP_ENV and DATABASE_URL from .env.local in the working directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dryscope-cli-'));
    try {
      await writeFile(join(dir, '.env.local'), `APP_ENV=local\nDATABASE_URL=${disposable.databaseUrl}\n`);
      const env = { ...process.env };
      delete env.APP_ENV;
      delete env.DATABASE_URL;
      const { stdout } = await exec(join(webRoot, 'node_modules/.bin/tsx'), [join(webRoot, 'src/db/cli.ts')], {
        cwd: dir,
        timeout: 30_000,
        env,
      });
      expect(stdout).toMatch(/applied 0001_foundation/);
      expect(await tableNames()).toEqual(SHIPPED_TABLES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('logs applied ids from the config URL and not the password', async () => {
    const role = `dryscope_cli_${randomBytes(8).toString('hex')}`;
    const password = `secret-${randomBytes(16).toString('hex')}`;
    await withSql(async (sql) => {
      // Like the real migrator: CREATEROLE so 0003 can create the runtime role, nothing more.
      await sql.unsafe(`CREATE ROLE "${role}" LOGIN CREATEROLE PASSWORD '${password}'`);
      await sql.unsafe(`GRANT ALL ON DATABASE "${disposable.databaseName}" TO "${role}"`);
      await sql.unsafe(`GRANT ALL ON SCHEMA public TO "${role}"`);
    });
    try {
      const url = new URL(disposable.databaseUrl);
      url.username = role;
      url.password = password;
      const { stdout, stderr } = await exec('npx', ['tsx', 'src/db/cli.ts'], {
        cwd: webRoot,
        timeout: 30_000,
        env: { ...process.env, APP_ENV: 'test', DATABASE_URL: url.toString() },
      });
      expect(stdout).toMatch(/applied 0001_foundation/);
      expect(`${stdout}\n${stderr}`).not.toContain(password);
      expect(await tableNames()).toEqual(SHIPPED_TABLES);
    } finally {
      await withSql(async (sql) => {
        await sql.unsafe(`DROP OWNED BY "${role}"`);
        await sql.unsafe(`DROP ROLE "${role}"`);
      });
    }
  });
});
