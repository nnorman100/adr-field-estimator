import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsDirectory, readMigrations, redactDatabaseMessage } from '@/db/migrate';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dryscope-mig-'));
  dirs.push(dir);
  await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)));
  return dir;
}

const ledger = `CREATE TABLE migration_ledger (
  id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`;

describe('migration files', () => {
  it('loads the shipped migrations in order and nothing else', async () => {
    const files = await readMigrations(migrationsDirectory);
    expect(files.map((file) => file.id)).toEqual(['0001_foundation', '0002_identity', '0003_runtime_role', '0004_sign_in_lookup', '0005_access_projection', '0006_platform_operator', '0007_sign_in_address', '0008_feature_flag_writes', '0009_price_tables', '0010_core_job_tables', '0011_submissions_agreements', '0012_ai_live_tables', '0013_company_documents', '0014_signing_links', '0015_office_jobs', '0016_job_drafts', '0017_definer_search_path', '0018_field_revision', '0019_price_approvals', '0020_drying_outcomes']);
    for (const file of files) expect(file.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a gap before the numbers are contiguous from 0001', async () => {
    const dir = await writeMigrations({
      '0001_foundation.sql': ledger,
      '0003_gap.sql': 'CREATE TABLE skipped (id integer);\n',
    });
    await expect(readMigrations(dir)).rejects.toThrow(/0003_gap.sql is out of order; expected 0002/);
  });

  it('strips a database URL and its password from a failure message', () => {
    const databaseUrl = 'postgres://user:super-secret-db-password@127.0.0.1:5432/dryscope';
    const message = redactDatabaseMessage(
      `connect failed for ${databaseUrl} using super-secret-db-password`,
      databaseUrl,
    );
    expect(message).not.toMatch(/super-secret-db-password/);
    expect(message).not.toMatch(/postgres:\/\//);
    expect(message).toMatch(/\[database\]/);
  });
});
