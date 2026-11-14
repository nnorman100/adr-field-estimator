import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperatorContextError, withCompany, withOperator } from '@/db/tenant';
import { addOperator, parseOperatorArgs } from '../../scripts/add-operator';
import { unprotectedRelations } from './row-security-guard';
import { everything, resetTeamDatabase, startTeamServer, type Harness } from './team-harness';

// Migration 0006 directly, as the runtime role and as the table owner: the operator lookup, the
// operator context and what it allows, the company trigger, and the owner-run command.
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const READ_ONLY = '25006';

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let api: postgres.Sql;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await api?.end({ timeout: 5 });
  h = await resetTeamDatabase(base, h ?? null);
  api = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
});

afterAll(async () => {
  await api?.end({ timeout: 5 });
  await h?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

const asOperator = <T>(run: (tx: Parameters<Parameters<typeof withOperator>[2]>[0]) => Promise<T>, companyId?: string): Promise<T> =>
  withOperator(h.handle.db, h.seed.operator, run, companyId ? { companyId } : {});

describe('the sign-in lookup', () => {
  it('finds an active operator by operator tenant and uid, and nobody else', async () => {
    const lookup = async (tenant: string, uid: string) =>
      (await api<{ id: string | null }[]>`SELECT platform_operator(${tenant}, ${uid})::text AS id`)[0]!.id;
    expect(await lookup('operators', 'operator-1')).toBe(h.seed.operator);
    expect(await lookup('operators', 'nobody')).toBeNull();
    expect(await lookup('tenant-a', 'owner-a')).toBeNull();
    expect(await lookup('tenant-a', 'operator-1')).toBeNull();
    await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
    expect(await lookup('operators', 'operator-1')).toBeNull();
    // Outside the function the runtime still sees no operator, even with the setting turned on.
    await api.begin(async (tx) => {
      await tx`SELECT set_config('app.operator_lookup', 'on', true)`;
      expect(await tx`SELECT * FROM platform_admins`).toHaveLength(0);
      expect(await tx`SELECT * FROM actors`).toHaveLength(0);
    });
  });

  it('cannot be run by the owner signed in as itself or by anyone but the runtime', async () => {
    const migrator = postgres(h.migratorUrl, { max: 1, onnotice: () => {} });
    try {
      expect(await migrator`SELECT platform_operator('operators', 'operator-1') AS id`).toEqual([{ id: null }]);
      expect(await migrator`SELECT app_operator_active() AS active`).toEqual([{ active: false }]);
      await migrator.begin(async (tx) => {
        await tx`SELECT set_config('app.operator_id', ${h.seed.operator}, true)`;
        expect(await tx`SELECT * FROM platform_admins`).toHaveLength(0);
      });
    } finally {
      await migrator.end({ timeout: 5 });
    }
    const grants = await h.admin<{ name: string; grantee: string }[]>`
      SELECT p.proname AS name, r.rolname AS grantee
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid = a.grantee
      WHERE p.proname IN ('app_operator_id', 'app_operator_active', 'platform_operator', 'add_platform_operator', 'companies_guard_change')
        AND r.rolname <> pg_get_userbyid(p.proowner)
      ORDER BY 1, 2
    `;
    expect(grants).toEqual([
      { name: 'app_operator_active', grantee: 'dryscope_runtime' },
      { name: 'app_operator_id', grantee: 'dryscope_runtime' },
      { name: 'platform_operator', grantee: 'dryscope_runtime' },
    ]);
  });
});

describe('the operator context', () => {
  it('refuses an id that is not an active operator before running anything', async () => {
    await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
    let ran = false;
    await expect(asOperator(async () => void (ran = true))).rejects.toBeInstanceOf(OperatorContextError);
    // A company member's actor id is not an operator either.
    await expect(withOperator(h.handle.db, h.seed.ownerA.actor, async () => void (ran = true))).rejects.toBeInstanceOf(OperatorContextError);
    await expect(withOperator(h.handle.db, 'not-a-uuid', async () => void (ran = true))).rejects.toThrow(/uuid/);
    expect(ran).toBe(false);
  });

  it('shows every company only to an active operator, never to a company transaction', async () => {
    const ids = await asOperator(async (tx) => (await tx.execute(sql`SELECT id::text FROM companies ORDER BY id`)) as unknown as { id: string }[]);
    expect(ids.map((row) => row.id).sort()).toEqual([h.seed.a, h.seed.b, h.seed.suspended].sort());
    const fromA = await withCompany(h.handle.db, h.seed.a, async (tx) => (await tx.execute(sql`SELECT id::text FROM companies`)) as unknown as unknown[]);
    expect(fromA).toHaveLength(1);
    // The setting alone, naming an operator, changes nothing unless that operator is active.
    await api.begin(async (tx) => {
      await tx`SELECT set_config('app.operator_id', ${h.seed.ownerA.actor}, true)`;
      expect(await tx`SELECT * FROM companies`).toHaveLength(0);
    });
  });

  it('lets an operator change only a company’s status and tenant, and create one with a name and address', async () => {
    expect(
      await errorCode(asOperator((tx) => tx.execute(sql`UPDATE companies SET name = 'Renamed' WHERE id = ${h.seed.a}::uuid`))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await errorCode(asOperator((tx) => tx.execute(sql`INSERT INTO companies (name, sign_in_slug, status) VALUES ('X', 'x', 'archived')`))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    // A company transaction cannot change its status or create companies (0010 lets it change its own profile columns, and its
    // guard refuses anything else on the row).
    expect(
      await errorCode(withCompany(h.handle.db, h.seed.a, (tx) => tx.execute(sql`UPDATE companies SET status = 'suspended' WHERE id = ${h.seed.a}::uuid RETURNING id`))),
    ).toBe(CHECK_VIOLATION);
    expect(await h.admin`SELECT status FROM companies WHERE id = ${h.seed.a}`).toEqual([{ status: 'active' }]);
    expect(await errorCode(withCompany(h.handle.db, h.seed.a, (tx) => tx.execute(sql`INSERT INTO companies (name, sign_in_slug) VALUES ('X', 'x')`)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    const columns = await h.admin<{ table: string; column: string; privilege: string }[]>`
      SELECT table_name AS table, column_name AS column, privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name IN ('companies', 'auth_tenants') AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY 1, 3, 2
    `;
    expect(columns).toEqual([
      { table: 'auth_tenants', column: 'id', privilege: 'INSERT' },
      { table: 'auth_tenants', column: 'kind', privilege: 'INSERT' },
      { table: 'companies', column: 'name', privilege: 'INSERT' },
      { table: 'companies', column: 'sign_in_slug', privilege: 'INSERT' },
      { table: 'companies', column: 'auth_tenant_id', privilege: 'UPDATE' },
      // 0010: a company's own profile columns, which the operator's context cannot change.
      // 0013 adds the letterhead lines and the document settings to them, under the same rule.
      { table: 'companies', column: 'profile_address', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_documents', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_email', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_emergency_phone', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_fax', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_license', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_mailing_address', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_phone', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_signoff', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_tagline', privilege: 'UPDATE' },
      { table: 'companies', column: 'profile_website', privilege: 'UPDATE' },
      { table: 'companies', column: 'status', privilege: 'UPDATE' },
      { table: 'companies', column: 'updated_at', privilege: 'UPDATE' },
    ]);
  });

  it('can never add an operator, an operator actor or an operator tenant', async () => {
    const before = await everything(h.admin);
    expect(await errorCode(asOperator((tx) => tx.execute(sql`INSERT INTO platform_admins (actor_id) VALUES (${h.seed.ownerA.actor}::uuid)`)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await errorCode(
        asOperator((tx) => tx.execute(sql`INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'new-op', 'n@example.test')`)),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(asOperator((tx) => tx.execute(sql`INSERT INTO auth_tenants (id, kind) VALUES ('ops-2', 'operator')`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(asOperator((tx) => tx.execute(sql`UPDATE platform_admins SET status = 'active'`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(api`SELECT add_platform_operator('operators', 'new-op', 'n@example.test')`)).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await everything(h.admin)).toBe(before);
  });

  it('lets an audit row name an operator only inside that operator’s context', async () => {
    const insert = (operatorId: string) => (tx: Parameters<Parameters<typeof withCompany>[2]>[0]) =>
      tx.execute(sql`INSERT INTO audit_events (company_id, operator_actor_id, action) VALUES (${h.seed.a}::uuid, ${operatorId}::uuid, 'test_event')`);
    // A company transaction alone cannot write an operator's name.
    expect(await errorCode(withCompany(h.handle.db, h.seed.a, insert(h.seed.operator)))).toBe(INSUFFICIENT_PRIVILEGE);
    const [other] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-2', 'o2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO platform_admins (actor_id) VALUES (${other!.id})`;
    // Nor can one operator write another's.
    expect(await errorCode(asOperator(insert(other!.id), h.seed.a))).toBe(INSUFFICIENT_PRIVILEGE);
    await asOperator(insert(h.seed.operator), h.seed.a);
    expect(await h.admin`SELECT operator_actor_id FROM audit_events`).toEqual([{ operator_actor_id: h.seed.operator }]);
  });

  it('runs a read-only context that cannot write', async () => {
    expect(
      await errorCode(
        withOperator(h.handle.db, h.seed.operator, (tx) => tx.execute(sql`INSERT INTO audit_events (action) VALUES ('x')`), { readOnly: true, companyId: h.seed.a }),
      ),
    ).toBe(READ_ONLY);
  });
});

describe('the company trigger', () => {
  it('refuses the runtime archiving a company that is not suspended', async () => {
    expect(await errorCode(asOperator((tx) => tx.execute(sql`UPDATE companies SET status = 'archived' WHERE id = ${h.seed.a}::uuid`)))).toBe(CHECK_VIOLATION);
    await asOperator((tx) => tx.execute(sql`UPDATE companies SET status = 'archived' WHERE id = ${h.seed.suspended}::uuid`));
    expect(await h.admin`SELECT status FROM companies WHERE id = ${h.seed.suspended}`).toEqual([{ status: 'archived' }]);
  });

  it('refuses the runtime changing or clearing a sign-in tenant once set, and leaves the owner its repair path', async () => {
    await h.admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-z', 'company')`;
    for (const value of ['tenant-z', null]) {
      expect(await errorCode(asOperator((tx) => tx.execute(sql`UPDATE companies SET auth_tenant_id = ${value} WHERE id = ${h.seed.b}::uuid`)))).toBe(
        CHECK_VIOLATION,
      );
    }
    // A company transaction cannot change it either (0010's guard refuses it outside an operator's context).
    expect(
      await errorCode(withCompany(h.handle.db, h.seed.b, (tx) => tx.execute(sql`UPDATE companies SET auth_tenant_id = 'tenant-z' WHERE id = ${h.seed.b}::uuid RETURNING id`))),
    ).toBe(CHECK_VIOLATION);
    expect(await h.admin`SELECT auth_tenant_id FROM companies WHERE id = ${h.seed.b}`).toEqual([{ auth_tenant_id: 'tenant-b' }]);
    // The owner, outside any policy, may repair a company nobody has signed in to yet.
    const fresh = await asOperator(async (tx) => {
      const [row] = (await tx.execute(sql`INSERT INTO companies (name, sign_in_slug) VALUES ('Fresh', 'fresh') RETURNING id::text`)) as unknown as { id: string }[];
      await tx.execute(sql`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-wrong', 'company')`);
      await tx.execute(sql`UPDATE companies SET auth_tenant_id = 'tenant-wrong' WHERE id = ${row!.id}::uuid`);
      await tx.execute(sql`INSERT INTO audit_events (company_id, operator_actor_id, action) VALUES (${row!.id}::uuid, ${h.seed.operator}::uuid, 'company_created')`);
      return row!.id;
    });
    await h.admin`UPDATE companies SET auth_tenant_id = 'tenant-z' WHERE id = ${fresh}`;
    expect(await h.admin`SELECT auth_tenant_id FROM companies WHERE id = ${fresh}`).toEqual([{ auth_tenant_id: 'tenant-z' }]);
  });
});

describe('the owner-run add-operator command', () => {
  it('adds an operator with one audit row, and running it again changes nothing', async () => {
    const migrator = postgres(h.migratorUrl, { max: 1, onnotice: () => {} });
    try {
      const input = parseOperatorArgs(['--tenant', 'ops-new', '--uid', 'person-1', '--email', ' Person@Example.TEST ']);
      const id = await addOperator(migrator, input);
      expect(await h.admin`SELECT kind FROM auth_tenants WHERE id = 'ops-new'`).toEqual([{ kind: 'operator' }]);
      expect(await h.admin`SELECT company_id, auth_tenant_id, uid, email FROM actors WHERE id = ${id}`).toEqual([
        { company_id: null, auth_tenant_id: 'ops-new', uid: 'person-1', email: 'person@example.test' },
      ]);
      expect(await h.admin`SELECT company_id, actor_id, operator_actor_id, action, target FROM audit_events`).toEqual([
        { company_id: null, actor_id: null, operator_actor_id: null, action: 'operator_added', target: id },
      ]);
      // The new operator signs in.
      expect(await api`SELECT platform_operator('ops-new', 'person-1')::text AS id`).toEqual([{ id }]);

      const before = await everything(h.admin);
      expect(await addOperator(migrator, input)).toBe(id);
      expect(await everything(h.admin)).toBe(before);
      // The setting is cleared afterwards: the owner reads nothing outside the command.
      expect(await migrator`SELECT * FROM platform_admins`).toHaveLength(0);
    } finally {
      await migrator.end({ timeout: 5 });
    }
  });

  it('refuses a company tenant and a disabled operator, writing nothing', async () => {
    await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
    const before = await everything(h.admin);
    const migrator = postgres(h.migratorUrl, { max: 1, onnotice: () => {} });
    try {
      await expect(addOperator(migrator, { tenant: 'tenant-a', uid: 'x', email: 'x@example.test' })).rejects.toThrow(/company tenant/);
      await expect(addOperator(migrator, { tenant: 'operators', uid: 'operator-1', email: 'x@example.test' })).rejects.toThrow(/disabled/);
    } finally {
      await migrator.end({ timeout: 5 });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('checks its arguments before connecting', () => {
    expect(() => parseOperatorArgs(['--tenant', 'ops', '--uid', 'u'])).toThrow(/--email is required/);
    expect(() => parseOperatorArgs(['--tenant', 'bad tenant', '--uid', 'u', '--email', 'a@b.co'])).toThrow(/--tenant/);
    expect(() => parseOperatorArgs(['--tenant', 'ops', '--uid', 'u', '--email', 'nope'])).toThrow(/--email/);
    expect(() => parseOperatorArgs(['--tenant', 'ops', '--uid', 'u', '--email', 'a@b.co', '--role', 'x'])).toThrow(/unknown option/);
  });
});

describe('migration 0006', () => {
  it('leaves every table protected', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
  });
});
