import { randomBytes } from 'node:crypto';
import { eq, sql as dsql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory } from '@/db/migrate';
import {
  accessProjectionOutbox,
  actors,
  auditEvents,
  authTenants,
  companies,
  companyFeatureFlags,
  invitations,
  memberships,
} from '@/db/schema';
import { CompanyContextError, withCompany, type CompanyTransaction } from '@/db/tenant';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';

// This file starts its own throwaway server, as a fresh Cloud SQL instance would be: a migrator
// with CREATEROLE and nothing more applies every migration and owns the tables, and the API
// database user, named like dryscope-api-<env>@dryscope.iam, exists before 0003 runs. The server
// superuser only seeds rows and inspects them.
const MIGRATOR = 'dryscope_migrator_ci';
const API_USER = 'dryscope-api-ci@dryscope.iam';
const RUNTIME = 'dryscope_runtime';
const INSUFFICIENT_PRIVILEGE = '42501';
const INVALID_TEXT = '22P02';

const migratorPassword = randomBytes(16).toString('hex');
const apiPassword = randomBytes(16).toString('hex');

let server: DisposablePostgres;
let admin: postgres.Sql;
let api: postgres.Sql;

type Seed = {
  a: string;
  b: string;
  ownerA: string;
  ownerB: string;
  inviteB: string;
  membershipB: string;
  operator: string;
};
let seed: Seed;

function urlAs(user: string, password: string): string {
  const url = new URL(server.databaseUrl);
  url.username = user;
  url.password = password;
  return url.toString();
}

function connect(user: string, password: string): postgres.Sql {
  return postgres(urlAs(user, password), { max: 1, connect_timeout: 10, onnotice: () => {} });
}

// The error code of a refused statement, whether the driver or Drizzle raised it.
async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

async function seedTwoCompanies(): Promise<Seed> {
  await admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-a', 'company'), ('tenant-b', 'company'), ('operators', 'operator')`;
  const company = async (tenant: string) => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO companies (name, sign_in_slug, auth_tenant_id)
      VALUES (${`Company ${tenant}`}, ${tenant}, ${tenant}) RETURNING id
    `;
    return row!.id;
  };
  const actor = async (companyId: string | null, tenant: string, uid: string) => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email)
      VALUES (${companyId}, ${tenant}, ${uid}, ${`${uid}@example.test`}) RETURNING id
    `;
    return row!.id;
  };
  const a = await company('tenant-a');
  const b = await company('tenant-b');
  const ownerA = await actor(a, 'tenant-a', 'owner-a');
  const ownerB = await actor(b, 'tenant-b', 'owner-b');
  const operator = await actor(null, 'operators', 'operator-1');
  await admin`INSERT INTO platform_admins (actor_id) VALUES (${operator})`;
  const ids: Record<string, { invite: string; membership: string }> = {};
  for (const [companyId, ownerId] of [
    [a, ownerA],
    [b, ownerB],
  ] as const) {
    const [membership] = await admin<{ id: string }[]>`
      INSERT INTO memberships (company_id, actor_id, role) VALUES (${companyId}, ${ownerId}, 'owner') RETURNING id
    `;
    const [invite] = await admin<{ id: string }[]>`
      INSERT INTO invitations (company_id, email, role, expires_at, created_by_actor_id)
      VALUES (${companyId}, ${`new-${companyId}@example.test`}, 'estimator', now() + interval '7 days', ${ownerId})
      RETURNING id
    `;
    await admin`INSERT INTO audit_events (company_id, actor_id, action) VALUES (${companyId}, ${ownerId}, 'member_invited')`;
    await admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${companyId}, 'price_books', true)`;
    await admin`INSERT INTO access_projection_outbox (company_id, actor_id) VALUES (${companyId}, ${ownerId})`;
    ids[companyId] = { invite: invite!.id, membership: membership!.id };
  }
  await admin`INSERT INTO audit_events (operator_actor_id, action) VALUES (${operator}, 'operator_added')`;
  return { a, b, ownerA, ownerB, operator, inviteB: ids[b]!.invite, membershipB: ids[b]!.membership };
}

// Each company-scoped table the runtime may read, with the column that names the company.
const COMPANY_TABLES = [
  ['companies', 'id'],
  ['actors', 'company_id'],
  ['memberships', 'company_id'],
  ['invitations', 'company_id'],
  ['audit_events', 'company_id'],
  ['company_feature_flags', 'company_id'],
  ['access_projection_outbox', 'company_id'],
] as const;
const READABLE_TABLES = [...COMPANY_TABLES.map(([table]) => table), 'auth_tenants', 'platform_admins'];

async function companyIdsSeen(tx: { execute: (query: ReturnType<typeof dsql.raw>) => Promise<unknown> }) {
  const seen: Record<string, string[]> = {};
  for (const [table, column] of COMPANY_TABLES) {
    const rows = (await tx.execute(dsql.raw(`SELECT DISTINCT ${column}::text AS c FROM ${table}`))) as unknown as {
      c: string;
    }[];
    seen[table] = rows.map((row) => row.c).sort();
  }
  return seen;
}

// An empty public schema as a new PostgreSQL 16 database has it: everyone may use it, and only its
// owner may create in it. The migrator is given CREATE by hand, as in the runbook's bootstrap.
async function stockPublicSchema(): Promise<void> {
  await emptyDiscardDatabase(server.databaseUrl);
  await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
  await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${MIGRATOR}`);
}

beforeAll(async () => {
  // No DATABASE_URL: the harness starts a server this file owns, even in CI.
  server = await startDisposablePostgres({ APP_ENV: 'test' });
  admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE ${MIGRATOR} LOGIN CREATEROLE PASSWORD '${migratorPassword}'`);
  await admin.unsafe(`GRANT CREATE ON DATABASE "${server.databaseName}" TO ${MIGRATOR}`);
  await admin.unsafe(`CREATE ROLE "${API_USER}" LOGIN PASSWORD '${apiPassword}'`);
});

afterAll(async () => {
  await api?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
  await server?.stop();
});

beforeEach(async () => {
  await api?.end({ timeout: 5 });
  await stockPublicSchema();
  await applyMigrations(urlAs(MIGRATOR, migratorPassword), migrationsDirectory);
  seed = await seedTwoCompanies();
  api = connect(API_USER, apiPassword);
});

describe('runtime role and row-level security (migration 0003)', () => {
  it('fails the guard for any table without forced row-level security or a policy', async () => {
    expect(await unprotectedRelations(admin)).toEqual([]);

    // A later migration that forgets any one of the three is caught.
    const migrator = connect(MIGRATOR, migratorPassword);
    try {
      await migrator`CREATE TABLE later_plain (id integer)`;
      await migrator`CREATE TABLE later_unforced (id integer)`;
      await migrator`ALTER TABLE later_unforced ENABLE ROW LEVEL SECURITY`;
      await migrator`CREATE POLICY later_unforced_any ON later_unforced USING (true)`;
      await migrator`CREATE TABLE later_no_policy (id integer)`;
      await migrator`ALTER TABLE later_no_policy ENABLE ROW LEVEL SECURITY`;
      await migrator`ALTER TABLE later_no_policy FORCE ROW LEVEL SECURITY`;
      await migrator`CREATE VIEW later_view AS SELECT id FROM companies`;
    } finally {
      await migrator.end({ timeout: 5 });
    }
    expect(await unprotectedRelations(admin)).toEqual([
      { name: 'later_no_policy', reason: 'no policy' },
      { name: 'later_plain', reason: 'row-level security is not enabled' },
      { name: 'later_unforced', reason: 'row-level security is not forced' },
      { name: 'later_view', reason: 'not a table, so row-level security does not apply' },
    ]);
  });

  it('makes the runtime a non-owner role that cannot bypass the policies', async () => {
    const [runtime] = await admin<
      { super: boolean; bypass: boolean; login: boolean; createrole: boolean; createdb: boolean }[]
    >`
      SELECT rolsuper AS super, rolbypassrls AS bypass, rolcanlogin AS login,
             rolcreaterole AS createrole, rolcreatedb AS createdb
      FROM pg_roles WHERE rolname = ${RUNTIME}
    `;
    expect(runtime).toEqual({ super: false, bypass: false, login: false, createrole: false, createdb: false });

    // The API user holds the runtime's rights by inheritance only, and no other role.
    const grants = await admin<{ role: string; inherit: boolean; set: boolean; admin: boolean }[]>`
      SELECT r.rolname AS role, m.inherit_option AS inherit, m.set_option AS set, m.admin_option AS admin
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles u ON u.oid = m.member
      WHERE u.rolname = ${API_USER}
    `;
    expect(grants).toEqual([{ role: RUNTIME, inherit: true, set: false, admin: false }]);

    const owners = await admin<{ owner: string }[]>`
      SELECT DISTINCT pg_get_userbyid(relowner) AS owner
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
    `;
    expect(owners).toEqual([{ owner: MIGRATOR }]);

    // No TRUNCATE or DELETE anywhere, nothing on the ledger or on operators beyond the empty read.
    const rights = await admin<{ table: string; privilege: string }[]>`
      SELECT table_name AS table, privilege_type AS privilege
      FROM information_schema.role_table_grants
      WHERE grantee = ${RUNTIME} AND table_schema = 'public'
      ORDER BY table_name, privilege_type
    `;
    const byTable: Record<string, string[]> = {};
    for (const row of rights) (byTable[row.table] ??= []).push(row.privilege);
    expect(byTable).toEqual({
      access_projection_outbox: ['INSERT', 'SELECT', 'UPDATE'],
      actors: ['INSERT', 'SELECT', 'UPDATE'],
      audit_events: ['INSERT', 'SELECT'],
      auth_tenants: ['SELECT'],
      companies: ['SELECT'],
      company_feature_flags: ['SELECT'],
      invitations: ['INSERT', 'SELECT', 'UPDATE'],
      memberships: ['INSERT', 'SELECT', 'UPDATE'],
      platform_admins: ['SELECT'],
    });
  });

  it('returns no rows to a query outside withCompany', async () => {
    for (const table of READABLE_TABLES) {
      const rows = await api.unsafe(`SELECT * FROM ${table}`);
      expect({ table, rows: rows.length }).toEqual({ table, rows: 0 });
    }
    // The rows are there; only the runtime cannot see them.
    const [all] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM actors`;
    expect(all?.n).toBe(3);
    expect(await refusal(api`SELECT * FROM migration_ledger`)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("never shows company A company B's rows, nor an operator's", async () => {
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
    try {
      const seen = await withCompany(handle.db, seed.a, (tx) => companyIdsSeen(tx));
      for (const [table] of COMPANY_TABLES) expect({ table, ids: seen[table] }).toEqual({ table, ids: [seed.a] });

      await withCompany(handle.db, seed.a, async (tx) => {
        expect((await tx.select().from(authTenants)).map((row) => row.id)).toEqual(['tenant-a']);
        expect(await tx.execute(dsql`SELECT * FROM platform_admins`)).toHaveLength(0);
        expect(await tx.select().from(actors).where(eq(actors.id, seed.operator))).toEqual([]);
        expect(await tx.select().from(invitations).where(eq(invitations.id, seed.inviteB))).toEqual([]);
        // Platform-wide audit events (no company) are not a company's.
        expect((await tx.select().from(auditEvents)).every((row) => row.companyId === seed.a)).toBe(true);
      });
    } finally {
      await handle.close();
    }
  });

  it("refuses to insert company B's rows from company A", async () => {
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
    try {
      const attempts = [
        (tx: CompanyTransaction) =>
          tx.insert(actors).values({ companyId: seed.b, authTenantId: 'tenant-b', uid: 'x', email: 'x@example.test' }),
        (tx: CompanyTransaction) =>
          tx.insert(invitations).values({
            companyId: seed.b,
            email: 'y@example.test',
            role: 'office',
            expiresAt: new Date(Date.now() + 86_400_000),
          }),
        (tx: CompanyTransaction) =>
          tx.insert(auditEvents).values({ companyId: seed.b, action: 'member_invited' }),
        (tx: CompanyTransaction) =>
          tx.insert(accessProjectionOutbox).values({ companyId: seed.b, actorId: seed.ownerB }),
        (tx: CompanyTransaction) =>
          tx.insert(companyFeatureFlags).values({ companyId: seed.b, flag: 'other', enabled: true }),
        (tx: CompanyTransaction) =>
          tx.insert(companies).values({ name: 'Third' }),
      ];
      for (const attempt of attempts) {
        expect(await refusal(withCompany(handle.db, seed.a, (tx) => attempt(tx)))).toBe(INSUFFICIENT_PRIVILEGE);
      }
      // A platform-wide audit row cannot be written from a company either.
      expect(
        await refusal(withCompany(handle.db, seed.a, (tx) => tx.insert(auditEvents).values({ action: 'operator_added' }))),
      ).toBe(INSUFFICIENT_PRIVILEGE);

      // Its own rows go in.
      await withCompany(handle.db, seed.a, async (tx) => {
        await tx.insert(auditEvents).values({ companyId: seed.a, actorId: seed.ownerA, action: 'member_invited' });
        await tx.insert(accessProjectionOutbox).values({ companyId: seed.a, actorId: seed.ownerA });
      });
      const [counts] = await admin<{ a: number; b: number }[]>`
        SELECT count(*) FILTER (WHERE company_id = ${seed.a})::int AS a,
               count(*) FILTER (WHERE company_id = ${seed.b})::int AS b
        FROM audit_events
      `;
      expect(counts).toEqual({ a: 2, b: 1 });
    } finally {
      await handle.close();
    }
  });

  it("never updates company B's rows from company A, nor moves a row to B", async () => {
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
    try {
      const changed = await withCompany(handle.db, seed.a, async (tx) => ({
        everyMembership: (await tx.update(memberships).set({ status: 'disabled' }).returning()).map((r) => r.companyId),
        inviteOfB: await tx
          .update(invitations)
          .set({ status: 'cancelled', cancelledAt: new Date() })
          .where(eq(invitations.id, seed.inviteB))
          .returning(),
        everyActor: (await tx.update(actors).set({ displayName: 'Renamed' }).returning()).map((r) => r.companyId),
      }));
      expect(changed).toEqual({ everyMembership: [seed.a], inviteOfB: [], everyActor: [seed.a] });

      const b = await admin`
        SELECT (SELECT status FROM memberships WHERE id = ${seed.membershipB}) AS membership,
               (SELECT status FROM invitations WHERE id = ${seed.inviteB}) AS invite,
               (SELECT display_name FROM actors WHERE id = ${seed.ownerB}) AS name
      `;
      expect(b[0]).toEqual({ membership: 'active', invite: 'pending', name: null });

      expect(
        await refusal(
          withCompany(handle.db, seed.a, (tx) =>
            tx.update(accessProjectionOutbox).set({ companyId: seed.b, actorId: seed.ownerB }),
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await refusal(withCompany(handle.db, seed.a, (tx) => tx.update(companies).set({ name: 'Taken' }))),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await handle.close();
    }
  });

  it("never deletes company B's rows from company A", async () => {
    for (const [table] of COMPANY_TABLES) {
      const code = await refusal(
        api.begin(async (tx) => {
          await tx`SELECT set_config('app.company_id', ${seed.a}, true)`;
          await tx.unsafe(`DELETE FROM ${table}`);
        }),
      );
      expect({ table, code }).toEqual({ table, code: INSUFFICIENT_PRIVILEGE });
    }
    const [left] = await admin<{ n: number }[]>`
      SELECT (SELECT count(*) FROM memberships WHERE company_id = ${seed.b})::int
           + (SELECT count(*) FROM invitations WHERE company_id = ${seed.b})::int AS n
    `;
    expect(left?.n).toBe(2);
  });

  it('carries nothing over on one pooled connection used for A, then B, then nothing', async () => {
    // openDatabase keeps exactly one connection, so all three uses share it.
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
    try {
      const pid = async (tx: { execute: typeof handle.db.execute }) =>
        ((await tx.execute(dsql`SELECT pg_backend_pid() AS pid`)) as unknown as { pid: number }[])[0]?.pid;

      const first = await withCompany(handle.db, seed.a, async (tx) => ({
        pid: await pid(tx),
        seen: await companyIdsSeen(tx),
      }));
      const second = await withCompany(handle.db, seed.b, async (tx) => ({
        pid: await pid(tx),
        seen: await companyIdsSeen(tx),
      }));
      const leftover = (await handle.db.execute(
        dsql`SELECT current_setting('app.company_id', true) AS value, pg_backend_pid() AS pid`,
      )) as unknown as { value: string | null; pid: number }[];
      const after = await companyIdsSeen(handle.db);

      expect(new Set([first.pid, second.pid, leftover[0]?.pid]).size).toBe(1);
      for (const [table] of COMPANY_TABLES) {
        expect({ table, a: first.seen[table], b: second.seen[table], none: after[table] }).toEqual({
          table,
          a: [seed.a],
          b: [seed.b],
          none: [],
        });
      }
      // The connection keeps '' after a transaction-local setting, and that matches nothing.
      expect(leftover[0]?.value).toBe('');
      expect(await handle.db.select().from(memberships)).toEqual([]);
    } finally {
      await handle.close();
    }
  });

  it('keeps audit rows append-only for the runtime', async () => {
    const inCompanyA = (statement: string) =>
      api.begin(async (tx) => {
        await tx`SELECT set_config('app.company_id', ${seed.a}, true)`;
        await tx.unsafe(statement);
      });
    await inCompanyA(`INSERT INTO audit_events (company_id, action) VALUES ('${seed.a}', 'member_invited')`);
    expect(await refusal(inCompanyA(`UPDATE audit_events SET action = 'changed'`))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusal(inCompanyA('DELETE FROM audit_events'))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refusal(inCompanyA('TRUNCATE audit_events'))).toBe(INSUFFICIENT_PRIVILEGE);
    const [rows] = await admin<{ n: number; changed: number }[]>`
      SELECT count(*)::int AS n, count(*) FILTER (WHERE action = 'changed')::int AS changed FROM audit_events
    `;
    expect(rows).toEqual({ n: 4, changed: 0 });
  });

  it('cannot switch role', async () => {
    for (const statement of [
      `SET ROLE ${RUNTIME}`,
      `SET ROLE ${MIGRATOR}`,
      'SET ROLE dryscope',
      `SET SESSION AUTHORIZATION ${MIGRATOR}`,
      'SET SESSION AUTHORIZATION dryscope',
    ]) {
      expect({ statement, code: await refusal(api.unsafe(statement)) }).toEqual({
        statement,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    const [who] = await api<{ user: string }[]>`SELECT current_user AS user`;
    expect(who?.user).toBe(API_USER);
  });

  it('cannot turn row-level security off', async () => {
    for (const statement of [
      'ALTER TABLE memberships DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY',
      'DROP POLICY memberships_current ON memberships',
      'CREATE POLICY open_all ON memberships USING (true)',
      'ALTER FUNCTION app_company_id() RENAME TO other',
      `ALTER ROLE "${API_USER}" BYPASSRLS`,
    ]) {
      expect({ statement, code: await refusal(api.unsafe(statement)) }).toEqual({
        statement,
        code: INSUFFICIENT_PRIVILEGE,
      });
    }
    // Turning the setting off is allowed, but then a query the policies would filter fails
    // instead of returning rows, inside withCompany or not.
    await api`SET row_security = off`;
    expect(await refusal(api`SELECT * FROM memberships`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await refusal(
        api.begin(async (tx) => {
          await tx`SELECT set_config('app.company_id', ${seed.a}, true)`;
          await tx`SELECT * FROM memberships`;
        }),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a company context that is not a uuid', async () => {
    const handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
    try {
      for (const bad of ['', 'not-a-uuid', `${seed.a}' OR true --`]) {
        await expect(withCompany(handle.db, bad, async () => 'ran')).rejects.toBeInstanceOf(CompanyContextError);
      }
    } finally {
      await handle.close();
    }
    // Set by hand, a value that is not a uuid is an error, never a match.
    expect(
      await refusal(
        api.begin(async (tx) => {
          await tx`SELECT set_config('app.company_id', 'not-a-uuid', true)`;
          await tx`SELECT * FROM memberships`;
        }),
      ),
    ).toBe(INVALID_TEXT);
  });

  it('binds the migrator to the policies too, except for its ledger', async () => {
    const migrator = connect(MIGRATOR, migratorPassword);
    try {
      expect(await migrator`SELECT * FROM companies`).toHaveLength(0);
      expect(await migrator`SELECT * FROM migration_ledger`).toHaveLength(3);
    } finally {
      await migrator.end({ timeout: 5 });
    }
    const again = await applyMigrations(urlAs(MIGRATOR, migratorPassword), migrationsDirectory);
    expect(again.applied).toEqual([]);
  });

  it('refuses to grant the runtime to an API user that could bypass the policies', async () => {
    const risky = 'dryscope-api-risky@dryscope.iam';
    await admin.unsafe(`CREATE ROLE "${risky}" LOGIN BYPASSRLS`);
    try {
      await stockPublicSchema();
      await expect(applyMigrations(urlAs(MIGRATOR, migratorPassword), migrationsDirectory)).rejects.toThrow(
        /0003_runtime_role\.sql failed: API database user dryscope-api-risky@dryscope\.iam must not be a superuser or bypass row-level security/,
      );
      const ledger = await admin<{ id: string }[]>`SELECT id FROM migration_ledger ORDER BY id`;
      expect(ledger.map((row) => row.id)).toEqual(['0001_foundation', '0002_identity']);
    } finally {
      await admin.unsafe(`DROP ROLE "${risky}"`);
    }
  });
});
