import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCompany, withOperator } from '@/db/tenant';
import { unprotectedRelations } from './row-security-guard';
import type { Harness } from './team-harness';

// S3-11b: the operator route that changes one company's feature flag, through the real route file as
// the runtime role on a server set up like a fresh Cloud SQL instance (see team-harness.ts), and
// migration 0008's policies and column rights directly.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  operatorServices: () => live.harness!.operators,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/team/services', () => ({ teamServices: () => live.harness!.team }));
vi.mock('@/lib/platform/services', () => ({ platformServices: () => live.harness!.platform }));

const { everything, operatorClaims, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
type FakeClaims = import('./team-harness').FakeClaims;
const { POST: flags } = await import('@/app/api/platform/companies/[companyId]/flags/route');
const { GET: me } = await import('@/app/api/me/route');

const INSUFFICIENT_PRIVILEGE = '42501';
const NOT_FOUND_COMPANY = '00000000-0000-4000-8000-0000000000c0';

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
let api: postgres.Sql;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  await api?.end({ timeout: 5 });
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
  api = postgres(h.apiUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
});

afterAll(async () => {
  await api?.end({ timeout: 5 });
  await live.harness?.handle.close();
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

const setFlag = (claims: FakeClaims | null, companyId: string, body: unknown) =>
  flags(request(claims, '/api/platform/x', { method: 'POST', body }), params({ companyId }));

const storedFlags = (companyId: string) =>
  h.admin<{ flag: string; enabled: boolean; updated_by_operator_id: string | null }[]>`
    SELECT flag, enabled, updated_by_operator_id FROM company_feature_flags WHERE company_id = ${companyId} ORDER BY flag
  `;
const auditRows = () =>
  h.admin<{ company_id: string | null; actor_id: string | null; operator_actor_id: string | null; action: string; target: string; details: unknown }[]>`
    SELECT company_id, actor_id, operator_actor_id, action, target, details FROM audit_events ORDER BY id
  `;
const capabilitiesOf = async (claims: FakeClaims) =>
  ((await (await me(request(claims, '/api/me'), params({}))).json()) as { capabilities: string[] }).capabilities;

describe('POST /api/platform/companies/{companyId}/flags', () => {
  it('turns a flag on for company A, leaves B off, and writes exactly one audit row naming the operator', async () => {
    const response = await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ companyId: h.seed.a, flag: 'price_books', enabled: true, previous: false });
    expect(await storedFlags(h.seed.a)).toEqual([{ flag: 'price_books', enabled: true, updated_by_operator_id: h.seed.operator }]);
    expect(await storedFlags(h.seed.b)).toEqual([]);
    expect(await auditRows()).toEqual([
      {
        company_id: h.seed.a,
        actor_id: null,
        operator_actor_id: h.seed.operator,
        action: 'feature_flag_changed',
        target: 'price_books',
        details: { enabled: true, previous: false },
      },
    ]);
    // The company's own sign-in sees it at once; the other company does not.
    expect(await capabilitiesOf(owner())).toContain('prices_read');
    expect(await capabilitiesOf(owner('owner-b', 'tenant-b'))).not.toContain('prices_read');
  });

  it('turns it back off, recording the previous value, and keeps one row per flag', async () => {
    await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: true });
    const off = await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: false });
    expect(await off.json()).toEqual({ companyId: h.seed.a, flag: 'price_books', enabled: false, previous: true });
    expect(await storedFlags(h.seed.a)).toEqual([{ flag: 'price_books', enabled: false, updated_by_operator_id: h.seed.operator }]);
    expect((await auditRows()).map((row) => row.details)).toEqual([
      { enabled: true, previous: false },
      { enabled: false, previous: true },
    ]);
    expect(await capabilitiesOf(owner())).not.toContain('prices_read');
  });

  it('audits setting the value a flag already has, as a change the operator made', async () => {
    await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: false });
    expect(await storedFlags(h.seed.a)).toEqual([{ flag: 'price_books', enabled: false, updated_by_operator_id: h.seed.operator }]);
    expect((await auditRows()).map((row) => row.details)).toEqual([{ enabled: false, previous: false }]);
  });

  it('changes a suspended company’s flag too, so it is ready when the company returns', async () => {
    expect((await setFlag(operatorClaims(), h.seed.suspended, { flag: 'price_books', enabled: true })).status).toBe(200);
    expect(await storedFlags(h.seed.suspended)).toHaveLength(1);
  });

  it('refuses an unknown flag name with 400 unknown_flag, writing nothing and never repeating it', async () => {
    const before = await everything(h.admin);
    for (const flag of ['prices', 'PRICE_BOOKS', 'price_books ', '', 'constructor', '__proto__', 'x'.repeat(65)]) {
      const response = await setFlag(operatorClaims(), h.seed.a, { flag, enabled: true });
      const text = await response.text();
      expect({ flag, status: response.status }).toEqual({ flag, status: 400 });
      expect(JSON.parse(text)).toEqual({ error: flag.length > 64 ? 'invalid_request' : 'unknown_flag' });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses a body that is not exactly a flag name and a boolean, writing nothing', async () => {
    const before = await everything(h.admin);
    for (const body of [
      {},
      { flag: 'price_books' },
      { enabled: true },
      { flag: 'price_books', enabled: 'true' },
      { flag: 'price_books', enabled: 1 },
      { flag: 1, enabled: true },
      { flag: 'price_books', enabled: true, companyId: h.seed.b },
      { flag: 'price_books', enabled: true, updatedByOperatorId: h.seed.operator },
      [],
      null,
      'not json',
    ]) {
      const response = await setFlag(operatorClaims(), h.seed.a, body);
      expect({ body, status: response.status, answer: await response.json() }).toEqual({ body, status: 400, answer: { error: 'invalid_request' } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('answers 404 for a company that does not exist or a path that is not a uuid, writing nothing', async () => {
    const before = await everything(h.admin);
    for (const companyId of [NOT_FOUND_COMPANY, 'not-a-uuid']) {
      const response = await setFlag(operatorClaims(), companyId, { flag: 'price_books', enabled: true });
      expect({ companyId, status: response.status, answer: await response.json() }).toEqual({ companyId, status: 404, answer: { error: 'not_found' } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('takes the company from the path only, never from the body or the query', async () => {
    const response = await flags(
      request(operatorClaims(), `/api/platform/x?companyId=${h.seed.b}`, { method: 'POST', body: { flag: 'price_books', enabled: true } }),
      params({ companyId: h.seed.a }),
    );
    expect(response.status).toBe(200);
    expect(await storedFlags(h.seed.a)).toHaveLength(1);
    expect(await storedFlags(h.seed.b)).toEqual([]);
  });

  it('refuses an owner, an estimator and an office user, with the flag on or off, writing nothing', async () => {
    for (const enabledBefore of [false, true]) {
      if (enabledBefore) await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', true)`;
      const before = await everything(h.admin);
      for (const caller of [owner(), { tenant: 'tenant-a', uid: 'estimator-a' }, { tenant: 'tenant-a', uid: 'office-a' }, owner('owner-b', 'tenant-b')]) {
        for (const companyId of [h.seed.a, h.seed.b]) {
          const response = await setFlag(caller, companyId, { flag: 'price_books', enabled: !enabledBefore });
          expect({ caller: caller.uid, companyId, status: response.status, answer: await response.json() }).toEqual({
            caller: caller.uid,
            companyId,
            status: 403,
            answer: { error: 'not_an_operator' },
          });
        }
      }
      expect(await everything(h.admin)).toBe(before);
    }
  });

  it('refuses no sign-in, a disabled operator, no second step and an old sign-in, writing nothing', async () => {
    await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
    const disabledState = await everything(h.admin);
    for (const [claims, status, error] of [
      [null, 401, 'missing_token'],
      [operatorClaims(), 403, 'not_an_operator'],
    ] as const) {
      const response = await setFlag(claims, h.seed.a, { flag: 'price_books', enabled: true });
      expect({ status: response.status, answer: await response.json() }).toEqual({ status, answer: { error } });
    }
    expect(await everything(h.admin)).toBe(disabledState);
    await h.admin`UPDATE platform_admins SET status = 'active' WHERE actor_id = ${h.seed.operator}`;
    const before = await everything(h.admin);
    for (const [claims, status, error] of [
      [operatorClaims({ secondFactor: null }), 403, 'second_step_required'],
      [operatorClaims({ signedInAgo: 12 * 60 * 60 + 60 }), 401, 'sign_in_again'],
    ] as const) {
      const response = await setFlag(claims, h.seed.a, { flag: 'price_books', enabled: true });
      expect({ status: response.status, answer: await response.json() }).toEqual({ status, answer: { error } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('answers 403 and writes nothing when the operator is disabled after the sign-in check', async () => {
    const before = await everything(h.admin);
    // The route's sign-in check passes; then the operator is disabled before the transaction runs.
    const original = h.platform.setFlag;
    h.platform.setFlag = async (...args) => {
      await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
      return original(...args);
    };
    try {
      const response = await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: true });
      expect({ status: response.status, answer: await response.json() }).toEqual({ status: 403, answer: { error: 'not_an_operator' } });
    } finally {
      h.platform.setFlag = original;
    }
    await h.admin`UPDATE platform_admins SET status = 'active' WHERE actor_id = ${h.seed.operator}`;
    expect(await everything(h.admin)).toBe(before);
  });

  it('writes neither the flag nor an audit row when the audit row is refused', async () => {
    // A trigger that refuses the audit row stands in for any failure after the flag was written.
    await h.admin`
      CREATE FUNCTION refuse_flag_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$
    `;
    await h.admin`
      CREATE TRIGGER refuse_flag_audit BEFORE INSERT ON audit_events
      FOR EACH ROW WHEN (NEW.action = 'feature_flag_changed') EXECUTE FUNCTION refuse_flag_audit()
    `;
    const before = await everything(h.admin);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled: true });
      expect({ status: response.status, answer: await response.json() }).toEqual({ status: 503, answer: { error: 'platform_unavailable' } });
    } finally {
      logged.mockRestore();
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('runs two changes to one company one after the other, so each audit row’s previous value is true', async () => {
    const results = await Promise.all(
      [true, false, true, false].map((enabled) => setFlag(operatorClaims(), h.seed.a, { flag: 'price_books', enabled })),
    );
    expect(results.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    const rows = await auditRows();
    expect(rows).toHaveLength(4);
    // Whatever order they ran in, each change starts from where the one before it ended.
    let value = false;
    for (const row of rows) {
      const details = row.details as { enabled: boolean; previous: boolean };
      expect(details.previous).toBe(value);
      value = details.enabled;
    }
    expect(await storedFlags(h.seed.a)).toEqual([{ flag: 'price_books', enabled: value, updated_by_operator_id: h.seed.operator }]);
  });
});

describe('migration 0008', () => {
  const asOperator = <T>(run: (tx: Parameters<Parameters<typeof withOperator>[2]>[0]) => Promise<T>, companyId?: string) =>
    withOperator(h.handle.db, h.seed.operator, run, companyId ? { companyId } : {});
  const insert = (companyId: string, operatorId: string | null) => (tx: Parameters<Parameters<typeof withOperator>[2]>[0]) =>
    tx.execute(
      sql`INSERT INTO company_feature_flags (company_id, flag, enabled, updated_by_operator_id) VALUES (${companyId}::uuid, 'price_books', true, ${operatorId}::uuid)`,
    );

  it('gives the runtime these column rights on company_feature_flags and no more', async () => {
    const columns = await h.admin<{ column: string; privilege: string }[]>`
      SELECT column_name AS column, privilege_type AS privilege
      FROM information_schema.column_privileges
      WHERE grantee = 'dryscope_runtime' AND table_name = 'company_feature_flags' AND privilege_type IN ('INSERT', 'UPDATE')
      ORDER BY 2, 1
    `;
    expect(columns).toEqual([
      { column: 'company_id', privilege: 'INSERT' },
      { column: 'enabled', privilege: 'INSERT' },
      { column: 'flag', privilege: 'INSERT' },
      { column: 'updated_at', privilege: 'INSERT' },
      { column: 'updated_by_operator_id', privilege: 'INSERT' },
      { column: 'enabled', privilege: 'UPDATE' },
      { column: 'updated_at', privilege: 'UPDATE' },
      { column: 'updated_by_operator_id', privilege: 'UPDATE' },
    ]);
    const tableLevel = await h.admin<{ privilege: string }[]>`
      SELECT privilege_type AS privilege FROM information_schema.role_table_grants
      WHERE grantee = 'dryscope_runtime' AND table_name = 'company_feature_flags' ORDER BY 1
    `;
    expect(tableLevel).toEqual([{ privilege: 'SELECT' }]);
  });

  it('lets an active operator write only the company its context names, stamped with its own id', async () => {
    await asOperator(insert(h.seed.a, h.seed.operator), h.seed.a);
    expect(await storedFlags(h.seed.a)).toHaveLength(1);
    // Another company than the context's, or no company in the context at all.
    expect(await errorCode(asOperator(insert(h.seed.b, h.seed.operator), h.seed.a))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(asOperator(insert(h.seed.b, h.seed.operator)))).toBe(INSUFFICIENT_PRIVILEGE);
    // A row that names no operator, or another one.
    expect(await errorCode(asOperator(insert(h.seed.b, null), h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    const [other] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-2', 'o2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO platform_admins (actor_id) VALUES (${other!.id})`;
    expect(await errorCode(asOperator(insert(h.seed.b, other!.id), h.seed.b))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedFlags(h.seed.b)).toEqual([]);
  });

  it('refuses an update to another company’s row, to a row’s company or name, and any delete', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', false), (${h.seed.b}, 'price_books', false)`;
    const before = await everything(h.admin);
    // Company B's row is not visible or changeable from company A's context.
    expect(
      await asOperator((tx) => tx.execute(sql`UPDATE company_feature_flags SET enabled = true WHERE company_id = ${h.seed.b}::uuid RETURNING flag`), h.seed.a),
    ).toHaveLength(0);
    for (const statement of [
      sql`UPDATE company_feature_flags SET company_id = ${h.seed.b}::uuid WHERE company_id = ${h.seed.a}::uuid`,
      sql`UPDATE company_feature_flags SET flag = 'other' WHERE company_id = ${h.seed.a}::uuid`,
      sql`DELETE FROM company_feature_flags WHERE company_id = ${h.seed.a}::uuid`,
      sql`TRUNCATE company_feature_flags`,
    ]) {
      expect(await errorCode(asOperator((tx) => tx.execute(statement), h.seed.a))).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses an update that stamps another operator’s id', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', false)`;
    const [other] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-2', 'o2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO platform_admins (actor_id) VALUES (${other!.id})`;
    expect(
      await errorCode(
        asOperator(
          (tx) => tx.execute(sql`UPDATE company_feature_flags SET enabled = true, updated_by_operator_id = ${other!.id}::uuid WHERE company_id = ${h.seed.a}::uuid`),
          h.seed.a,
        ),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await storedFlags(h.seed.a)).toEqual([{ flag: 'price_books', enabled: false, updated_by_operator_id: null }]);
  });

  // The runtime's own connection with the settings a request would have set, as raw statements.
  const rawInsert = (setting: { company?: string; operator?: string }) =>
    api
      .begin(async (tx) => {
        if (setting.company) await tx`SELECT set_config('app.company_id', ${setting.company}, true)`;
        if (setting.operator) await tx`SELECT set_config('app.operator_id', ${setting.operator}, true)`;
        await tx`
          INSERT INTO company_feature_flags (company_id, flag, enabled, updated_by_operator_id)
          VALUES (${h.seed.a}, 'price_books', true, ${setting.operator ?? null})
        `;
      })
      .then(
        () => 'written',
        (error: { code?: string }) => error.code,
      );

  it('gives a company transaction no write', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'price_books', false)`;
    const before = await everything(h.admin);
    expect(await errorCode(withCompany(h.handle.db, h.seed.a, insert(h.seed.a, h.seed.operator)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await errorCode(withCompany(h.handle.db, h.seed.a, insert(h.seed.a, null)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await withCompany(h.handle.db, h.seed.a, (tx) => tx.execute(sql`UPDATE company_feature_flags SET enabled = true RETURNING flag`)),
    ).toHaveLength(0);
    expect(await everything(h.admin)).toBe(before);
  });

  it('gives the runtime no write outside a context, for a member’s id, or for a disabled operator', async () => {
    await h.admin`INSERT INTO company_feature_flags (company_id, flag, enabled) VALUES (${h.seed.a}, 'other', false)`;
    const before = await everything(h.admin);
    // No setting at all, a company alone, and an owner's actor id where an operator's should be.
    expect(await rawInsert({})).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rawInsert({ company: h.seed.a })).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await rawInsert({ company: h.seed.a, operator: h.seed.ownerA.actor })).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await everything(h.admin)).toBe(before);
    await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
    const disabledState = await everything(h.admin);
    expect(await rawInsert({ company: h.seed.a, operator: h.seed.operator })).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await everything(h.admin)).toBe(disabledState);
    // The same statements are accepted for the active operator, so the refusals above are the policy's.
    await h.admin`UPDATE platform_admins SET status = 'active' WHERE actor_id = ${h.seed.operator}`;
    expect(await rawInsert({ company: h.seed.a, operator: h.seed.operator })).toBe('written');
  });

  it('leaves every table protected', async () => {
    expect(await unprotectedRelations(h.admin)).toEqual([]);
  });
});
