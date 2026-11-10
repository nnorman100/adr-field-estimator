import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

// Taken inside every migration transaction, so it is held for exactly the work it guards and
// never outlives or depends on one connection.
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

// A database URL, or the Cloud SQL socket login the migration job uses (the password is a function
// returning a short-lived access token, so it is never held in a setting).
export type MigrationTarget =
  | string
  | { path: string; database: string; username: string; password: () => Promise<string> };

export function redactDatabaseMessage(message: string, databaseUrl: string | null): string {
  if (databaseUrl === null) return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[database]');
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

function asMigrationError(error: unknown, databaseUrl: string | null): MigrationError {
  if (error instanceof MigrationError) return error;
  const message = error instanceof Error ? error.message : 'Unknown database error';
  return new MigrationError(redactDatabaseMessage(message, databaseUrl));
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

async function appliedChecksums(sql: postgres.TransactionSql): Promise<Map<string, string>> {
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

async function applyNext(
  sql: postgres.Sql,
  files: MigrationFile[],
  databaseUrl: string | null,
): Promise<string | null> {
  return sql.begin(async (tx) => {
    const [lock] = await tx<{ xid: string }[]>`
      SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint), pg_current_xact_id()::text AS xid
    `;
    const [file] = assertHistory(files, await appliedChecksums(tx));
    if (!file) return null;
    try {
      await tx.unsafe(file.sql);
      const [after] = await tx<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
      if (after?.xid !== lock?.xid) {
        throw new MigrationError('it ended the runner\'s transaction; leave BEGIN, COMMIT and ROLLBACK to the runner');
      }
      await tx`
        INSERT INTO migration_ledger (id, checksum)
        VALUES (${file.id}, ${file.checksum})
      `;
    } catch (error) {
      const cause = asMigrationError(error, databaseUrl);
      throw new MigrationError(`Migration ${file.filename} failed: ${cause.message}`);
    }
    return file.id;
  });
}

// Applies each missing file in order, in its own locked transaction that rereads the ledger first,
// and records the SHA-256 of the file bytes. A second run applies nothing. A gap or a changed file
// that was already applied stops the run before anything new is written. A file that ends the
// runner's transaction itself fails and is not recorded.
export async function applyMigrations(
  target: MigrationTarget,
  directory: string,
): Promise<{ applied: string[] }> {
  const files = await readMigrations(directory);
  const options = {
    max: 1,
    connect_timeout: 10,
    query_timeout: 30,
    onnotice: () => {},
    connection: { application_name: 'dryscope-migrate' },
  };
  const databaseUrl = typeof target === 'string' ? target : null;
  const sql = typeof target === 'string' ? postgres(target, options) : postgres({ ...options, ...target });
  try {
    const applied: string[] = [];
    for (;;) {
      const id = await applyNext(sql, files, databaseUrl);
      if (!id) return { applied };
      applied.push(id);
    }
  } catch (error) {
    throw asMigrationError(error, databaseUrl);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
