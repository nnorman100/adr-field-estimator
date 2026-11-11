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
const SHIPPED = ['0001_foundation', '0002_identity', '0003_runtime_role', '0004_sign_in_lookup', '0005_access_projection', '0006_platform_operator'];
const SHIPPED_TABLES = [
  'access_projection_outbox',
  'actors',
  'audit_events',
  'auth_tenants',
  'companies',
  'company_feature_flags',
  'invitations',
  'memberships',
  'migration_ledger',
  'platform_admins',
];

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
