import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { loginUrl, sharedRoles, startMigratedDatabase, type MigratedDatabase } from './postgres-harness';

// Migration 0017 (security audit F4): every SECURITY DEFINER function runs with
// search_path = pg_catalog, pg_temp. Without pg_temp written last, PostgreSQL searches the calling
// session's temporary schema first for type names, so the API user could create a temporary domain
// called uuid or text whose CHECK runs its own function, and a lookup that declares a variable of
// that type would run that function as the table owner. Each case below uses a new connection of
// the API user, because a session keeps a function it has already compiled.
const { api: apiLogin } = sharedRoles();
const API_USER = apiLogin.name;
const PROBE = 'definer-probe';

let server: MigratedDatabase;
let admin: postgres.Sql;
let companyA: string;
let operator: string;

// The five PL/pgSQL lookups the runtime may call, each with the type its body declares.
const LOOKUPS = [
  { name: 'sign_in_company', type: 'uuid', call: (sql: postgres.Sql) => sql`SELECT sign_in_company('tenant-a')::text AS id` },
  {
    name: 'platform_operator',
    type: 'uuid',
    call: (sql: postgres.Sql) => sql`SELECT platform_operator('operators', 'operator-1')::text AS id`,
  },
  {
    name: 'sign_in_company_page',
    type: 'text',
    call: (sql: postgres.Sql) => sql`SELECT company_name::pg_catalog.text AS name, tenant_id::pg_catalog.text AS tenant FROM sign_in_company_page('tenant-a')`,
  },
  {
    name: 'signing_link_company',
    type: 'uuid',
    call: (sql: postgres.Sql) => sql`SELECT signing_link_company(repeat('a', 64))::text AS id`,
  },
  {
    name: 'document_link_company',
    type: 'uuid',
    call: (sql: postgres.Sql) => sql`SELECT document_link_company(repeat('a', 64))::text AS id`,
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
    const functions = await admin<{ name: string; config: string[] }[]>`
      SELECT proname AS name, proconfig AS config FROM pg_proc
      WHERE prosecdef AND pronamespace = 'public'::regnamespace ORDER BY proname
    `;
    expect(functions).toEqual(
      [
        'access_projection_due_companies',
        'app_operator_active',
        'document_link_company',
        'job_submission_due_companies',
        'live_session_due_companies',
        'platform_operator',
        'sign_in_company',
        'sign_in_company_page',
        'signing_link_company',
      ].map((name) => ({ name, config: ['search_path=pg_catalog, pg_temp'] })),
    );
  });

  it('the API user holds the TEMPORARY right here, so the cases below can try the attack', async () => {
    const [row] = await admin<{ temp: boolean }[]>`
      SELECT has_database_privilege(${API_USER}, current_database(), 'TEMPORARY') AS temp
    `;
    expect(row).toEqual({ temp: true });
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

    it(`${lookup.name} does not call a temporary function named like one it uses`, async () => {
      const { sql, notices } = apiSession();
      try {
        await createProbe(sql);
        // Each lookup calls set_config around its read.
        await sql.unsafe(`
          CREATE FUNCTION pg_temp.set_config(pg_catalog.text, pg_catalog.text, pg_catalog.bool)
          RETURNS pg_catalog.text LANGUAGE plpgsql AS $$
          BEGIN
            PERFORM pg_temp.definer_probe();
            RETURN NULL;
          END
          $$
        `);
        expect(await lookup.call(sql)).toEqual(expected(lookup.name));
        expect(notices).toEqual([]);
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  }
});
