import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { loginUrl, sharedRoles, startMigratedDatabase, type MigratedDatabase } from './postgres-harness';

// Migration 0017 (security audit F4): every SECURITY DEFINER function runs with
// search_path = pg_catalog, pg_temp. Without pg_temp written last, PostgreSQL searches the calling
// session's temporary schema first for type names, so the API user could create a temporary domain
// called uuid or text whose CHECK runs its own function, and a lookup that declares a variable of
// that type would run that function as the table owner. Each case below uses a new connection of
// the API user, because a session keeps a function it has already compiled. The API user may also
// call plpgsql_validator, which compiles a body under the caller's own search_path; the validator
// cases cover that path, which is why the five lookups name every type, function and operator by schema.
const { api: apiLogin } = sharedRoles();
const API_USER = apiLogin.name;
const PROBE = 'definer-probe';

let server: MigratedDatabase;
let admin: postgres.Sql;
let companyA: string;
let operator: string;

// The five PL/pgSQL lookups the runtime may call, each with the type its body declares. `indeterminate`
// calls the same lookup with arguments of indeterminate collation (a || b with a COLLATE "C" and
// b COLLATE "POSIX"), which a session that validated the function first matches in its compiled-function cache.
const PARTS = (first: string, second: string) =>
  `(SELECT '${first}'::pg_catalog.text COLLATE "C" AS a, '${second}'::pg_catalog.text COLLATE "POSIX" AS b) s`;
const JOINED = 's.a OPERATOR(pg_catalog.||) s.b';
const LOOKUPS = [
  {
    name: 'sign_in_company',
    type: 'uuid',
    signature: 'sign_in_company(pg_catalog.text)',
    call: (sql: postgres.Sql) => sql`SELECT sign_in_company('tenant-a')::text AS id`,
    indeterminate: (sql: postgres.Sql) =>
      sql.unsafe(`SELECT sign_in_company(${JOINED})::pg_catalog.text AS id FROM ${PARTS('tenant-', 'a')}`),
  },
  {
    name: 'platform_operator',
    type: 'uuid',
    signature: 'platform_operator(pg_catalog.text, pg_catalog.text)',
    call: (sql: postgres.Sql) => sql`SELECT platform_operator('operators', 'operator-1')::text AS id`,
    indeterminate: (sql: postgres.Sql) =>
      sql.unsafe(`SELECT platform_operator(${JOINED}, 'operator-1')::pg_catalog.text AS id FROM ${PARTS('operator', 's')}`),
  },
  {
    name: 'sign_in_company_page',
    type: 'text',
    signature: 'sign_in_company_page(pg_catalog.text)',
    call: (sql: postgres.Sql) => sql`SELECT company_name::pg_catalog.text AS name, tenant_id::pg_catalog.text AS tenant FROM sign_in_company_page('tenant-a')`,
    indeterminate: (sql: postgres.Sql) =>
      sql.unsafe(
        `SELECT p.company_name::pg_catalog.text AS name, p.tenant_id::pg_catalog.text AS tenant FROM ${PARTS('tenant-', 'a')} CROSS JOIN LATERAL sign_in_company_page(${JOINED}) p`,
      ),
  },
  {
    name: 'signing_link_company',
    type: 'uuid',
    signature: 'signing_link_company(pg_catalog.text)',
    call: (sql: postgres.Sql) => sql`SELECT signing_link_company(repeat('a', 64))::text AS id`,
    indeterminate: (sql: postgres.Sql) =>
      sql.unsafe(`SELECT signing_link_company(${JOINED})::pg_catalog.text AS id FROM ${PARTS('a'.repeat(32), 'a'.repeat(32))}`),
  },
  {
    name: 'document_link_company',
    type: 'uuid',
    signature: 'document_link_company(pg_catalog.text)',
    call: (sql: postgres.Sql) => sql`SELECT document_link_company(repeat('a', 64))::text AS id`,
    indeterminate: (sql: postgres.Sql) =>
      sql.unsafe(`SELECT document_link_company(${JOINED})::pg_catalog.text AS id FROM ${PARTS('a'.repeat(32), 'a'.repeat(32))}`),
  },
] as const;

function expected(name: string): unknown[] {
  if (name === 'sign_in_company') return [{ id: companyA }];
  if (name === 'platform_operator') return [{ id: operator }];
  if (name === 'sign_in_company_page') return [{ name: 'Company A', tenant: 'tenant-a' }];
  return [{ id: null }];
}

// A new API-user session that keeps the notices it receives.
function apiSession(): { sql: postgres.Sql; notices: string[] } {
  const notices: string[] = [];
  const sql = postgres(loginUrl(server.databaseUrl, apiLogin), {
    max: 1,
    connect_timeout: 10,
    onnotice: (notice) => notices.push(String(notice.message)),
  });
  return { sql, notices };
}

// The caller's own function: it reports who it runs as. Written with schema-qualified names so it
// behaves the same whatever the session's temporary types are called.
async function createProbe(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE FUNCTION pg_temp.definer_probe() RETURNS pg_catalog.bool LANGUAGE plpgsql AS $$
    BEGIN
      RAISE NOTICE '${PROBE} current_user=%', pg_catalog.current_user();
      RETURN true;
    END
    $$
  `);
}

beforeAll(async () => {
  server = await startMigratedDatabase();
  admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  await admin`INSERT INTO auth_tenants (id, kind) VALUES ('tenant-a', 'company'), ('operators', 'operator')`;
  const [company] = await admin<{ id: string }[]>`
    INSERT INTO companies (name, sign_in_slug, auth_tenant_id) VALUES ('Company A', 'tenant-a', 'tenant-a') RETURNING id
  `;
  companyA = company!.id;
  const [actor] = await admin<{ id: string }[]>`
    INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-1', 'operator-1@example.test') RETURNING id
  `;
  operator = actor!.id;
  await admin`INSERT INTO platform_admins (actor_id) VALUES (${operator})`;
});

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await server?.stop();
});

describe('SECURITY DEFINER functions and the caller\'s temporary schema (migration 0017)', () => {
  it('sets search_path to pg_catalog, then pg_temp, on every SECURITY DEFINER function', async () => {
    const functions = await admin<{ name: string; config: string[] | null }[]>`
      SELECT proname AS name, proconfig AS config FROM pg_proc
      WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname
    `;
    expect(functions.length).toBeGreaterThan(0);
    for (const fn of functions) {
      expect({ name: fn.name, config: fn.config }).toEqual({ name: fn.name, config: ['search_path=pg_catalog, pg_temp'] });
    }
  });

  for (const lookup of LOOKUPS) {
    it(`${lookup.name} does not run the caller's code through a temporary ${lookup.type} type`, async () => {
      const { sql, notices } = apiSession();
      try {
        await createProbe(sql);
        // Called directly, the probe runs as the API user: the notice proves it works.
        await sql`SELECT pg_temp.definer_probe()`;
        expect(notices).toEqual([`${PROBE} current_user=${API_USER}`]);
        notices.length = 0;

        await sql.unsafe(
          `CREATE DOMAIN pg_temp.${lookup.type} AS pg_catalog.${lookup.type} CHECK (pg_temp.definer_probe())`,
        );
        expect(await lookup.call(sql)).toEqual(expected(lookup.name));
        expect(notices).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });

    it(`${lookup.name} does not run the caller's code after the caller validated it under its own search path`, async () => {
      const { sql, notices } = apiSession();
      try {
        await createProbe(sql);
        await sql.unsafe(
          `CREATE DOMAIN pg_temp.${lookup.type} AS pg_catalog.${lookup.type} CHECK (pg_temp.definer_probe())`,
        );
        await sql.unsafe(
          `SELECT pg_catalog.plpgsql_validator('${lookup.signature}'::pg_catalog.regprocedure::pg_catalog.oid)`,
        );
        notices.length = 0;
        expect(await lookup.indeterminate(sql)).toEqual(expected(lookup.name));
        expect(notices).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  }
});
