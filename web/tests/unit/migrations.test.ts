import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDestructiveSql,
  migrationsDirectory,
  readMigrations,
  redactDatabaseMessage,
} from '@/db/migrate';

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
  it('loads the shipped foundation migration and nothing else', async () => {
    const files = await readMigrations(migrationsDirectory);
    expect(files.map((file) => file.id)).toEqual(['0001_foundation']);
    expect(files[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(findDestructiveSql(files[0]?.sql ?? '')).toBeNull();
  });

  it('allows a comment that names a refused statement', async () => {
    const dir = await writeMigrations({
      '0001_note.sql': `-- DROP is not a statement here\n${ledger}`,
    });
    const files = await readMigrations(dir);
    expect(files.map((file) => file.id)).toEqual(['0001_note']);
  });

  it('refuses a destructive statement', async () => {
    const dir = await writeMigrations({ '0001_bad.sql': 'DROP TABLE companies;\n' });
    await expect(readMigrations(dir)).rejects.toThrow(/DROP/);
  });

  it('refuses TRUNCATE and DELETE FROM', async () => {
    const truncateDir = await writeMigrations({ '0001_truncate.sql': 'TRUNCATE companies;\n' });
    await expect(readMigrations(truncateDir)).rejects.toThrow(/TRUNCATE/);
    const deleteDir = await writeMigrations({ '0001_delete.sql': 'DELETE FROM companies;\n' });
    await expect(readMigrations(deleteDir)).rejects.toThrow(/DELETE FROM/);
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
