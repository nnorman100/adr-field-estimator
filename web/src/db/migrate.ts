import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// Session lock so two starters cannot apply the same file. max: 1 keeps the lock, the
// migration and the unlock on the same connection.
const LOCK_KEY = 814257001;
const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export type MigrationFile = {
  id: string;
  number: number;
  filename: string;
  sql: string;
  checksum: string;
};

export const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export function redactDatabaseMessage(message: string, databaseUrl: string): string {
  let redacted = message.split(databaseUrl).join('[database]');
  try {
    const password = new URL(databaseUrl).password;
    if (password) {
      redacted = redacted.split(password).join('[redacted]');
      redacted = redacted.split(decodeURIComponent(password)).join('[redacted]');
    }
  } catch {
    // A URL that does not parse can still contain a postgres URL further down.
  }
  return redacted.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]');
}

function asMigrationError(error: unknown, databaseUrl: string): MigrationError {
  if (error instanceof MigrationError) return error;
  const message = error instanceof Error ? error.message : 'Unknown database error';
  return new MigrationError(redactDatabaseMessage(message, databaseUrl));
}

// Comments may discuss the removal rule. The statement scan sees the SQL that would run.
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function findDestructiveSql(sql: string): string | null {
  const code = stripSqlComments(sql);
  if (/\bDROP\b/i.test(code)) return 'DROP';
  if (/\bTRUNCATE\b/i.test(code)) return 'TRUNCATE';
  if (/\bDELETE\s+FROM\b/i.test(code)) return 'DELETE FROM';
  return null;
}

function assertSequence(files: MigrationFile[]): void {
  if (files.length === 0) throw new MigrationError('No migration files found');
  for (const [index, file] of files.entries()) {
    const expected = index + 1;
    if (file.number !== expected) {
      const label = String(expected).padStart(4, '0');
      throw new MigrationError(`Migration ${file.filename} is out of order; expected ${label}`);
    }
  }
}

export async function readMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);
  const files: MigrationFile[] = [];
  for (const filename of filenames) {
    const match = FILE_NAME.exec(filename);
    if (!match?.[1] || !match[2]) {
      throw new MigrationError(`Migration file ${filename} must be named NNNN_words.sql`);
    }
    const buf = await readFile(join(directory, filename));
    let sql: string;
    try {
      sql = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new MigrationError(`Migration ${filename} is not UTF-8`);
    }
    if (sql.trim().length === 0) throw new MigrationError(`Migration ${filename} is empty`);
    const destructive = findDestructiveSql(sql);
    if (destructive) {
      throw new MigrationError(`Migration ${filename} contains ${destructive}, which this ledger refuses`);
    }
    files.push({
      id: filename.slice(0, -'.sql'.length),
      number: Number(match[1]),
      filename,
      sql,
      checksum: createHash('sha256').update(buf).digest('hex'),
    });
  }
  files.sort((a, b) => a.number - b.number);
  assertSequence(files);
  return files;
}

async function appliedChecksums(sql: postgres.Sql): Promise<Map<string, string>> {
  const found = await sql<{ name: string | null }[]>`
    SELECT to_regclass('public.migration_ledger') AS name
  `;
  if (!found[0]?.name) return new Map();
  const rows = await sql<{ id: string; checksum: string }[]>`
    SELECT id, checksum FROM migration_ledger
  `;
  return new Map(rows.map((row) => [row.id, row.checksum]));
}

function assertHistory(files: MigrationFile[], applied: Map<string, string>): MigrationFile[] {
  const known = new Map(files.map((file) => [file.id, file]));
  const recorded = [...applied.keys()].sort();
  for (const [index, id] of recorded.entries()) {
    const file = files[index];
    const match = known.get(id);
    if (!file || file.id !== id || !match) {
      throw new MigrationError('The ledger does not match the migration files in order');
    }
    if (applied.get(id) !== file.checksum) {
      throw new MigrationError(`Migration ${file.filename} was already applied with different bytes`);
    }
  }
  return files.slice(recorded.length);
}

async function applyLocked(
  sql: postgres.Sql,
  files: MigrationFile[],
  databaseUrl: string,
): Promise<{ applied: string[] }> {
  const pending = assertHistory(files, await appliedChecksums(sql));
  const applied: string[] = [];
  for (const file of pending) {
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(file.sql);
        await tx`
          INSERT INTO migration_ledger (id, checksum)
          VALUES (${file.id}, ${file.checksum})
        `;
      });
    } catch (error) {
      const cause = asMigrationError(error, databaseUrl);
      throw new MigrationError(`Migration ${file.filename} failed: ${cause.message}`);
    }
    applied.push(file.id);
  }
  return { applied };
}

// Applies each missing file in order, in its own transaction, and records the SHA-256 of the
// file bytes. A second run applies nothing. A gap, a destructive statement or a changed file
// that was already applied stops the run before anything new is written.
export async function applyMigrations(
  databaseUrl: string,
  directory: string,
): Promise<{ applied: string[] }> {
  const files = await readMigrations(directory);
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    query_timeout: 30,
    onnotice: () => {},
    connection: { application_name: 'dryscope-migrate' },
  });
  try {
    await sql`SELECT pg_advisory_lock(${LOCK_KEY}::bigint)`;
    try {
      return await applyLocked(sql, files, databaseUrl);
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_KEY}::bigint)`.catch(() => {});
    }
  } catch (error) {
    throw asMigrationError(error, databaseUrl);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
