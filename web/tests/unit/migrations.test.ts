import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findDestructiveSql,
  findTransactionControl,
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

  it('refuses a statement that follows a comment marker inside a string', () => {
    expect(findDestructiveSql("COMMENT ON TABLE companies IS '--'; DROP TABLE companies;")).toBe('DROP');
    expect(findDestructiveSql("SELECT '/*'; DROP TABLE companies; SELECT '*/';")).toBe('DROP');
    expect(findDestructiveSql("SELECT E'\\' -- '; DROP TABLE companies;")).toBe('DROP');
    expect(findDestructiveSql('SELECT $q$ -- $q$; DROP TABLE companies;')).toBe('DROP');
    expect(findDestructiveSql('CREATE TABLE "a--b" (id integer); DROP TABLE companies;')).toBe('DROP');
    expect(findDestructiveSql("SELECT 1 AS x$y$; SELECT '$y$ -- '; DROP TABLE companies;")).toBe('DROP');
  });

  it('refuses a destructive statement inside a block that runs it', () => {
    expect(findDestructiveSql('DO $$ BEGIN DROP TABLE companies; END $$;')).toBe('DROP');
    expect(findDestructiveSql("DO 'BEGIN EXECUTE ''TRUNCATE companies''; END';")).toBe('TRUNCATE');
  });

  it('refuses a destructive statement split by a comment inside a block that runs it', () => {
    expect(findDestructiveSql('DO $$ BEGIN DELETE /* cleanup */ FROM companies; END $$;')).toBe('DELETE FROM');
    expect(findDestructiveSql("DO $$ BEGIN DELETE -- cleanup\nFROM companies; END $$;")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO 'BEGIN DELETE /* x */ FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO E'BEGIN DELETE /* x */ FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql('DO $a$ BEGIN EXECUTE $b$DELETE/**/FROM companies$b$; END $a$;')).toBe('DELETE FROM');
    expect(findDestructiveSql("SELECT 'unterminated DROP")).toBe('DROP');
  });

  it('decodes escaped line breaks before blanking comments inside a block that runs it', () => {
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\nDELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\012DELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\x0aDELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\u000aDELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO U&'BEGIN -- cleanup\\000ADELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO U&'BEGIN -- cleanup!+00000ADELETE FROM companies; END' UESCAPE '!';")).toBe(
      'DELETE FROM',
    );
    expect(findDestructiveSql("DO E'BEGIN /* x */ DELETE\\tFROM companies; END';")).toBe('DELETE FROM');
  });

  it('ends line comments and decodes escapes the way the Postgres lexer does', () => {
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\rDELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql("DO E'BEGIN -- cleanup\\412DELETE FROM companies; END';")).toBe('DELETE FROM');
    expect(findDestructiveSql('DO $$ BEGIN -- cleanup\rDELETE FROM companies; END $$;')).toBe('DELETE FROM');
    expect(findDestructiveSql("SELECT 1; -- note\rDROP TABLE companies;")).toBe('DROP');
    expect(
      findDestructiveSql("DO U&'BEGIN --x!000ADELETE FROM companies; END' /*a/*b*/c*/ UESCAPE '!';"),
    ).toBe('DELETE FROM');
  });

  it('refuses a file that ends or opens a transaction itself', async () => {
    expect(findTransactionControl('CREATE TABLE example (id integer); ROLLBACK;')).toBe('ROLLBACK');
    expect(findTransactionControl('CREATE TABLE example (id integer);\nCOMMIT;\nSELECT 1/0;')).toBe('COMMIT');
    expect(findTransactionControl('BEGIN;\nCREATE TABLE example (id integer);')).toBe('BEGIN');
    expect(findTransactionControl('/* x */ START  TRANSACTION;')).toBe('START TRANSACTION');
    expect(findTransactionControl('SELECT 1; -- note\rEND;')).toBe('END');
    expect(findTransactionControl('SELECT 1; ABORT;')).toBe('ABORT');
    expect(
      findTransactionControl("DO $$ BEGIN PERFORM 1; END $$; CREATE TABLE commit_log (id integer); SELECT 'COMMIT';"),
    ).toBeNull();
    const dir = await writeMigrations({ '0001_rollback.sql': `${ledger}ROLLBACK;\n` });
    await expect(readMigrations(dir)).rejects.toThrow(/0001_rollback\.sql contains ROLLBACK/);
  });

  it('reads nested block comments the way Postgres does', () => {
    expect(findDestructiveSql('/* outer /* inner */ DROP still a comment */ SELECT 1;')).toBeNull();
    expect(findDestructiveSql('/* outer /* inner */ */ DROP TABLE companies;')).toBe('DROP');
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
