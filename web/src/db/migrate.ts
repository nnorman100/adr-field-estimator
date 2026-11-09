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

const IDENTIFIER_START = /[A-Za-z_\u0080-\uffff]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

function endOfQuoted(sql: string, start: number, quote: string, backslash: boolean): number {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslash && ch === '\\') {
      i += 2;
    } else if (ch === quote) {
      if (sql[i + 1] !== quote) return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return sql.length + 1;
}

function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

function unescapeEString(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (_, c) =>
    c === "'" ? "'" : ' ',
  );
}

// Comments may discuss the removal rule, so they are blanked the way Postgres reads them. String
// and dollar-quoted bodies stay in the scan with their own comments blanked, because DO blocks and
// EXECUTE run that text. Identifier text stays as written.
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    let end: number;
    if (sql.startsWith('--', i)) {
      const newline = sql.indexOf('\n', i);
      i = newline === -1 ? sql.length : newline;
      out += ' ';
      continue;
    }
    if (sql.startsWith('/*', i)) {
      i = endOfBlockComment(sql, i);
      out += ' ';
      continue;
    }
    if (ch === "'") {
      end = endOfQuoted(sql, i, ch, false);
      out += ` ${stripSqlComments(sql.slice(i + 1, end - 1).replaceAll("''", "'"))} `;
      i = end;
      continue;
    } else if (ch === '"') {
      end = endOfQuoted(sql, i, ch, false);
    } else if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        end = close === -1 ? sql.length : close + tag.length;
        const body = sql.slice(i + tag.length, close === -1 ? sql.length : close);
        out += ` ${stripSqlComments(body)} `;
        i = end;
        continue;
      } else {
        end = i + 1;
        while (end < sql.length && /[0-9]/.test(sql[end] ?? '')) end += 1;
      }
    } else if (IDENTIFIER_START.test(ch)) {
      end = i + 1;
      while (end < sql.length && IDENTIFIER_PART.test(sql[end] ?? '')) end += 1;
      if (end === i + 1 && (ch === 'e' || ch === 'E') && sql[end] === "'") {
        const close = endOfQuoted(sql, end, "'", true);
        const body = unescapeEString(sql.slice(end + 1, close - 1)).replaceAll("''", "'");
        out += ` ${stripSqlComments(body)} `;
        i = close;
        continue;
      }
    } else {
      end = i + 1;
    }
    out += sql.slice(i, end);
    i = end;
  }
  return out;
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
  databaseUrl: string,
): Promise<string | null> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
    const [file] = assertHistory(files, await appliedChecksums(tx));
    if (!file) return null;
    try {
      await tx.unsafe(file.sql);
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
// and records the SHA-256 of the file bytes. A second run applies nothing. A gap, a destructive
// statement or a changed file that was already applied stops the run before anything new is written.
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
