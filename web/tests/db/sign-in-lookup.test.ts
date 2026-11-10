import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { openDatabase } from '@/db/client';
import { applyMigrations, migrationsDirectory } from '@/db/migrate';
import { withCompany } from '@/db/tenant';
import { databaseDirectory } from '@/lib/auth/directory';
import { IdentityRefusal, resolveIdentity, type TokenVerifier } from '@/lib/auth/identity';
import { emptyDiscardDatabase, startDisposablePostgres, type DisposablePostgres } from './postgres-harness';
import { unprotectedRelations } from './row-security-guard';

// Migration 0004 and the sign-in records read through it, as the app's runtime role on a server
// set up like a fresh Cloud SQL instance (see row-level-security.test.ts): a CREATEROLE migrator
// owns the tables and the API user inherits dryscope_runtime. Tokens are replaced by a fake
// verifier here; tests/emu/identity.test.ts checks real tokens against the Auth emulator.
const MIGRATOR = 'dryscope_migrator_ci';
const API_USER = 'dryscope-api-ci@dryscope.iam';
const OTHER_USER = 'dryscope_other_ci';
const INSUFFICIENT_PRIVILEGE = '42501';

const migratorPassword = randomBytes(16).toString('hex');
const apiPassword = randomBytes(16).toString('hex');
const otherPassword = randomBytes(16).toString('hex');

let server: DisposablePostgres;
let admin: postgres.Sql;
let api: postgres.Sql;
let handle: ReturnType<typeof openDatabase>;

type Seed = { a: string; b: string; suspended: string; ownerA: string; estimatorB: string };
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

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    const found = error as { code?: string; cause?: { code?: string } };
    return found.code ?? found.cause?.code;
  }
  return undefined;
}

async function seedCompanies(): Promise<Seed> {
  await admin`
    INSERT INTO auth_tenants (id, kind) VALUES
      ('tenant-a', 'company'), ('tenant-b', 'company'), ('tenant-s', 'company'), ('operators', 'operator')
  `;
  const company = async (tenant: string, status = 'active') => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO companies (name, sign_in_slug, auth_tenant_id, status)
      VALUES (${`Company ${tenant}`}, ${tenant}, ${tenant}, ${status}) RETURNING id
    `;
    return row!.id;
  };
  const member = async (companyId: string | null, tenant: string, uid: string, role?: string, status = 'active') => {
    const [row] = await admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email)
      VALUES (${companyId}, ${tenant}, ${uid}, ${`${uid}@example.test`}) RETURNING id
    `;
    if (companyId && role) {
      await admin`INSERT INTO memberships (company_id, actor_id, role, status) VALUES (${companyId}, ${row!.id}, ${role}, ${status})`;
    }
    return row!.id;
  };
  const a = await company('tenant-a');
  const b = await company('tenant-b');
  const suspended = await company('tenant-s', 'suspended');
  const ownerA = await member(a, 'tenant-a', 'owner-a', 'owner');
  // The same uid in two tenants is two different people.
  const estimatorB = await member(b, 'tenant-b', 'owner-a', 'estimator');
  await member(b, 'tenant-b', 'disabled-b', 'office', 'disabled');
  await member(b, 'tenant-b', 'no-membership-b');
  await member(suspended, 'tenant-s', 'owner-s', 'owner');
  const operator = await member(null, 'operators', 'operator-1');
  await admin`INSERT INTO platform_admins (actor_id) VALUES (${operator})`;
  await admin`INSERT INTO audit_events (company_id, actor_id, action) VALUES (${a}, ${ownerA}, 'member_invited')`;
  return { a, b, suspended, ownerA, estimatorB };
}

beforeAll(async () => {
  server = await startDisposablePostgres({ APP_ENV: 'test' });
  admin = postgres(server.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  await admin.unsafe(`CREATE ROLE ${MIGRATOR} LOGIN CREATEROLE PASSWORD '${migratorPassword}'`);
  await admin.unsafe(`GRANT CREATE ON DATABASE "${server.databaseName}" TO ${MIGRATOR}`);
  await admin.unsafe(`CREATE ROLE "${API_USER}" LOGIN PASSWORD '${apiPassword}'`);
  await admin.unsafe(`CREATE ROLE ${OTHER_USER} LOGIN PASSWORD '${otherPassword}'`);
});

afterAll(async () => {
  await handle?.close();
  await api?.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
  await server?.stop();
});

beforeEach(async () => {
  await handle?.close();
  await api?.end({ timeout: 5 });
  await emptyDiscardDatabase(server.databaseUrl);
  await admin.unsafe('GRANT USAGE ON SCHEMA public TO PUBLIC');
  await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${MIGRATOR}`);
  await applyMigrations(urlAs(MIGRATOR, migratorPassword), migrationsDirectory);
  seed = await seedCompanies();
  api = connect(API_USER, apiPassword);
  handle = openDatabase({ APP_ENV: 'test', DATABASE_URL: urlAs(API_USER, apiPassword) });
});

// A verifier that trusts the test: the token is "<tenant>|<uid>|<verified>|<revoked>".
function fakeVerifier(): TokenVerifier {
  const read = (idToken: string) => {
    const [tenant, uid, verified, revoked] = Buffer.from(idToken.split('.')[1]!, 'base64url').toString().split('|');
    return { tenant: tenant || null, uid: uid!, emailVerified: verified === 'yes', revoked: revoked === 'yes' };
  };
  return {
    async verify(idToken) {
      const { tenant, uid, emailVerified } = read(idToken);
      return { tenant, uid, emailVerified };
    },
    async verifyNotRevoked(idToken, tenant) {
      const token = read(idToken);
      if (token.tenant !== tenant) throw new IdentityRefusal('invalid_token');
      if (token.revoked) throw new IdentityRefusal('sign_in_revoked');
      return { tenant: token.tenant, uid: token.uid, emailVerified: token.emailVerified };
    },
  };
}

function signedIn(tenant: string, uid: string, verified = 'yes', revoked = 'no', init: RequestInit = {}, url = 'http://localhost/api/me') {
  const payload = Buffer.from([tenant, uid, verified, revoked].join('|')).toString('base64url');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer e30.${payload}.`);
  return new Request(url, { ...init, headers });
}

const resolve = (request: Request) => resolveIdentity(request, fakeVerifier(), databaseDirectory(handle.db));

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IdentityRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

// Every row of every table, to prove a refused request changed nothing.
async function everything(): Promise<string> {
  const tables = await admin<{ name: string }[]>`
    SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY relname
  `;
  const dump: Record<string, unknown> = {};
  for (const { name } of tables) dump[name] = await admin.unsafe(`SELECT * FROM "${name}" ORDER BY 1`);
  return JSON.stringify(dump);
}

describe('sign-in lookup (migration 0004)', () => {
  it('finds the company of a tenant as the runtime, which still sees no company row', async () => {
    const [found] = await api<{ id: string | null }[]>`SELECT sign_in_company('tenant-b')::text AS id`;
    expect(found?.id).toBe(seed.b);
    expect(await api`SELECT * FROM companies`).toHaveLength(0);
    // The lookup clears its setting when it returns, in the caller's transaction too.
    const [after] = await api<{ found: boolean; setting: string | null }[]>`
      SELECT sign_in_company('tenant-a') IS NOT NULL AS found, current_setting('app.sign_in_lookup', true) AS setting
    `;
    expect(after).toEqual({ found: true, setting: '' });

    // Inside company A the runtime still sees only A, even after looking up B.
    const seen = await withCompany(handle.db, seed.a, async (tx) => {
      await tx.execute(`SELECT sign_in_company('tenant-b')`);
      return (await tx.execute(`SELECT id::text AS id FROM companies`)) as unknown as { id: string }[];
    });
    expect(seen.map((row) => row.id)).toEqual([seed.a]);
  });

  it('returns NULL for an unknown, empty, missing or operator tenant', async () => {
    for (const tenant of ['tenant-z', '', null, 'operators', ' tenant-a', 'TENANT-A']) {
      const [row] = await api<{ id: string | null }[]>`SELECT sign_in_company(${tenant}::text)::text AS id`;
      expect({ tenant, id: row?.id }).toEqual({ tenant, id: null });
    }
  });

  it('may be called by the runtime only', async () => {
    const [grants] = await admin<{ everyone: boolean; runtime: boolean }[]>`
      SELECT has_function_privilege('public', 'sign_in_company(text)', 'EXECUTE') AS everyone,
             has_function_privilege('dryscope_runtime', 'sign_in_company(text)', 'EXECUTE') AS runtime
    `;
    expect(grants).toEqual({ everyone: false, runtime: true });
    const other = connect(OTHER_USER, otherPassword);
    try {
      expect(await errorCode(other`SELECT sign_in_company('tenant-a')`)).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  it('runs as its owner with a fixed search path, and the owner may only read companies', async () => {
    const [fn] = await admin<{ definer: boolean; config: string[]; owner: string; volatile: string; strict: boolean }[]>`
      SELECT prosecdef AS definer, proconfig AS config, pg_get_userbyid(proowner) AS owner,
             provolatile AS volatile, proisstrict AS strict
      FROM pg_proc WHERE oid = 'sign_in_company(text)'::regprocedure
    `;
    expect(fn).toEqual({
      definer: true,
      config: ['search_path=pg_catalog'],
      owner: MIGRATOR,
      volatile: 'v',
      strict: true,
    });

    const policies = await admin<{ name: string; command: string; roles: string[] }[]>`
      SELECT polname AS name, polcmd AS command, polroles::regrole[]::text[] AS roles
      FROM pg_policy WHERE polrelid = 'companies'::regclass ORDER BY polname
    `;
    expect(policies).toEqual([
      { name: 'companies_current', command: 'r', roles: ['dryscope_runtime'] },
      { name: 'companies_owner_read', command: 'r', roles: ['-'] },
    ]);

    const migrator = connect(MIGRATOR, migratorPassword);
    try {
      // Outside the function the owner reads nothing, as in 0003; the setting alone is not enough
      // for the runtime either.
      expect(await migrator`SELECT id FROM companies`).toHaveLength(0);
      const [inside] = await migrator<{ n: number }[]>`
        SELECT count(*)::int AS n FROM companies WHERE id = sign_in_company('tenant-a')
      `;
      expect(inside?.n).toBe(0);
      await api`SELECT set_config('app.sign_in_lookup', 'on', false)`;
      expect(await api`SELECT * FROM companies`).toHaveLength(0);
      await migrator`SELECT set_config('app.sign_in_lookup', 'on', false)`;
      expect(await errorCode(migrator`INSERT INTO companies (name) VALUES ('Planted')`)).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await migrator`UPDATE companies SET status = 'active' RETURNING id`).toHaveLength(0);
      expect(await migrator`DELETE FROM companies RETURNING id`).toHaveLength(0);
    } finally {
      await migrator.end({ timeout: 5 });
    }
    const [count] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM companies WHERE status = 'suspended'`;
    expect(count?.n).toBe(1);
  });

  it('leaves every table forced and covered by a policy', async () => {
    expect(await unprotectedRelations(admin)).toEqual([]);
  });
});

describe('request identity against the database', () => {
  it('resolves the member of the token tenant, with role and capabilities', async () => {
    const owner = await resolve(signedIn('tenant-a', 'owner-a'));
    expect(owner).toMatchObject({ companyId: seed.a, actorId: seed.ownerA, role: 'owner', companyName: 'Company tenant-a' });
    expect(owner.capabilities).toContain('team_manage');
  });

  it('never resolves company A from a tenant B token, even for the same uid', async () => {
    const member = await resolve(signedIn('tenant-b', 'owner-a'));
    expect(member).toMatchObject({ companyId: seed.b, actorId: seed.estimatorB, role: 'estimator' });
    expect(member.capabilities).not.toContain('team_manage');
  });

  it('ignores a company id sent by the browser', async () => {
    const request = signedIn(
      'tenant-b',
      'owner-a',
      'yes',
      'no',
      { method: 'POST', headers: { 'X-Company-Id': seed.a }, body: JSON.stringify({ companyId: seed.a }) },
      `http://localhost/api/me?companyId=${seed.a}`,
    );
    expect((await resolve(request)).companyId).toBe(seed.b);
  });

  it.each([
    ['an unknown tenant', 'tenant-z', 'owner-a', 'yes', 'no', 'unknown_tenant'],
    ['an operator tenant', 'operators', 'operator-1', 'yes', 'no', 'unknown_tenant'],
    ['a token with no tenant', '', 'owner-a', 'yes', 'no', 'no_tenant'],
    ['a revoked token', 'tenant-a', 'owner-a', 'yes', 'yes', 'sign_in_revoked'],
    ['an unverified email', 'tenant-a', 'owner-a', 'no', 'no', 'email_unverified'],
    ['a disabled member', 'tenant-b', 'disabled-b', 'yes', 'no', 'member_disabled'],
    ['an actor with no membership', 'tenant-b', 'no-membership-b', 'yes', 'no', 'not_a_member'],
    ['an account with no actor', 'tenant-a', 'stranger', 'yes', 'no', 'not_a_member'],
    ['a member of a suspended company', 'tenant-s', 'owner-s', 'yes', 'no', 'company_inactive'],
  ])('refuses %s and writes nothing', async (_name, tenant, uid, verified, revoked, code) => {
    const before = await everything();
    expect(await refusalOf(resolve(signedIn(tenant, uid, verified, revoked)))).toBe(code);
    expect(await everything()).toBe(before);
  });

  it('refuses an archived company, whose tenant still resolves', async () => {
    const directory = databaseDirectory(handle.db);
    await admin`UPDATE companies SET status = 'archived' WHERE id = ${seed.a}`;
    const record = await directory.member(seed.a, 'tenant-a', 'owner-a');
    expect(record?.company.status).toBe('archived');
    expect(await refusalOf(resolve(signedIn('tenant-a', 'owner-a')))).toBe('company_inactive');
  });
});
