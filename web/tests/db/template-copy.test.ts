import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, migrationsDirectory } from '@/db/migrate';
import {
  createDiscardDatabase,
  databaseUrlFor,
  emptyDiscardDatabase,
  sharedRoles,
  startMigratedDatabase,
  type MigratedDatabase,
} from './postgres-harness';

// The files of this suite take their databases from a migrated template instead of migrating for
// themselves (see "One server for the whole run" in postgres-harness.ts). This holds the copy to the
// database each of them used to build by hand: the owners, grants, row-level-security settings,
// policies, functions, constraints, indexes, triggers and ledger of both are the same.
const roles = sharedRoles();

let copy: MigratedDatabase;
let built: { databaseUrl: string; drop: () => Promise<void> };

const connect = (url: string) => postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });

function as(databaseUrl: string, role: { name: string; password: string }): string {
  const url = new URL(databaseUrl);
  url.username = role.name;
  url.password = role.password;
  return url.toString();
}

// What the old setup did before every test: an empty public schema as a new database has it, the
// migrator given CREATE by hand, then every migration as the migrator.
async function buildByHand(adminUrl: string) {
  const database = await createDiscardDatabase(adminUrl);
  const admin = connect(adminUrl);
  try {
    await admin.unsafe(`GRANT CREATE ON DATABASE "${database.databaseName}" TO ${roles.migrator.name}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  await emptyDiscardDatabase(database.databaseUrl);
  const sql = connect(database.databaseUrl);
  try {
    await sql.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
    await sql.unsafe(`GRANT CREATE ON SCHEMA public TO ${roles.migrator.name}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  await applyMigrations(as(database.databaseUrl, roles.migrator), migrationsDirectory);
  return { databaseUrl: database.databaseUrl, drop: database.drop };
}

// Everything the migrations decide about the database, as plain rows.
async function describeDatabase(databaseUrl: string): Promise<Record<string, unknown[]>> {
  const sql = connect(databaseUrl);
  try {
    const mine = "c.relnamespace = 'public'::regnamespace";
    return {
      relations: await sql.unsafe(`
        SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl,
               c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c WHERE ${mine} ORDER BY c.relname`),
      columns: await sql.unsafe(`
        SELECT c.relname, a.attname, a.atttypid::regtype::text AS type, a.attnotnull, a.attacl::text AS acl
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE ${mine} AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY 1, 2`),
      policies: await sql.unsafe(`
        SELECT polrelid::regclass::text AS relation, polname, polcmd, polpermissive,
               (SELECT array_agg(rolname ORDER BY rolname) FROM pg_roles WHERE oid = ANY(polroles))::text AS roles,
               pg_get_expr(polqual, polrelid) AS using_expr, pg_get_expr(polwithcheck, polrelid) AS check_expr
        FROM pg_policy ORDER BY 1, 2`),
      functions: await sql.unsafe(`
        SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
               p.prosecdef, p.proconfig::text AS config, pg_get_functiondef(p.oid) AS definition
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1`),
      constraints: await sql.unsafe(`
        SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
      indexes: await sql.unsafe(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
      triggers: await sql.unsafe(`
        SELECT tgrelid::regclass::text AS relation, tgname, pg_get_triggerdef(oid) AS definition
        FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
      schema: await sql.unsafe(`
        SELECT nspname, pg_get_userbyid(nspowner) AS owner, nspacl::text AS acl
        FROM pg_namespace WHERE nspname = 'public'`),
      database: await sql.unsafe(`
        SELECT pg_get_userbyid(datdba) AS owner, datacl::text AS acl
        FROM pg_database WHERE datname = current_database()`),
      ledger: await sql.unsafe('SELECT id, checksum FROM migration_ledger ORDER BY id'),
      rows: await sql.unsafe(`
        SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text AS rows
        FROM pg_class c WHERE ${mine} AND c.relkind = 'r' ORDER BY 1`),
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  copy = await startMigratedDatabase();
  built = await buildByHand(databaseUrlFor(copy.databaseUrl, 'postgres'));
});

afterAll(async () => {
  await copy?.stop();
  await built?.drop();
});

describe('a copy of the migrated template', () => {
  it('is the database the migrations make, section by section', async () => {
    const [fromCopy, fromMigrations] = await Promise.all([
      describeDatabase(copy.databaseUrl),
      describeDatabase(built.databaseUrl),
    ]);
    // Not an empty comparison: the migrations made tables, policies and functions to compare.
    expect(fromMigrations.relations!.length).toBeGreaterThan(15);
    expect(fromMigrations.policies!.length).toBeGreaterThan(15);
    expect(fromMigrations.functions!.length).toBeGreaterThan(5);
    expect(fromMigrations.ledger!.length).toBeGreaterThanOrEqual(10);
    for (const section of Object.keys(fromMigrations)) {
      expect({ section, rows: fromCopy[section] }).toEqual({ section, rows: fromMigrations[section] });
    }
  });

  it('holds no rows, and a reset gives the same database back', async () => {
    const before = await describeDatabase(copy.databaseUrl);
    // Only the ledger has rows: the migrations' own record of what they applied.
    expect(before.rows!.filter((row) => (row as { rows: string }).rows !== '0')).toEqual([
      { relname: 'migration_ledger', rows: String(before.ledger!.length) },
    ]);
    const sql = connect(copy.databaseUrl);
    try {
      await sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-x', 'company')`;
    } finally {
      await sql.end({ timeout: 5 });
    }
    await copy.reset();
    expect(await describeDatabase(copy.databaseUrl)).toEqual(before);
  });
});
