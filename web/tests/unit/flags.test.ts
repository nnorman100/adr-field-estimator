import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdentityRefusal,
  requireFlag,
  resolveIdentity,
  type IdentityDirectory,
  type MemberRecord,
  type TokenVerifier,
} from '@/lib/auth';
import { AI_FEATURES, AI_REGISTRY } from '@/lib/ai/registry';
import {
  AI_FLAG_DETAILS,
  AI_FLAG_NAMES,
  ALL_OFF,
  FLAG_CHANGED_ACTION,
  FLAG_NAMES,
  FlagRefusal,
  accessFlags,
  changeCompanyFlag,
  flagsFromRows,
  isFlagName,
  parseFlagName,
  type FlagAuditEvent,
  type FlagChangeStore,
  type FlagName,
  type FlagRow,
} from '@/lib/flags';

// Per-company feature flags (S3-11a): the known list, reading a company's switches at sign-in,
// requireFlag on routes, and the change rule. The operator route that calls the change rule comes
// with S3-11b; tests/db/sign-in-lookup.test.ts reads stored flags through Postgres.

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const OPERATOR = '00000000-0000-4000-8000-0000000000f1';

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

// A verifier that trusts the test's claims; tests/unit/identity.test.ts covers the refusals.
const verifier: TokenVerifier = {
  async verify(idToken) {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, string>;
    return { uid: claims.sub!, tenant: claims.tenant ?? null, emailVerified: true };
  },
  async verifyNotRevoked(idToken, tenant) {
    const found = await this.verify(idToken);
    if (found.tenant !== tenant) throw new IdentityRefusal('invalid_token');
    // An authenticator-app sign-in a minute ago, so the owner and session rules (S3-8) pass.
    return { ...found, authTime: Math.floor(Date.now() / 1000) - 60, secondFactor: 'totp' };
  },
};

// Two companies, each with its own stored flag rows, standing in for company_feature_flags.
function directory(rows: Record<string, FlagRow[]>, role: 'owner' | 'estimator' = 'owner'): IdentityDirectory {
  const byTenant: Record<string, string> = { 'tenant-a': A, 'tenant-b': B };
  return {
    async companyForTenant(tenant) {
      return byTenant[tenant] ?? null;
    },
    async member(companyId): Promise<MemberRecord> {
      return {
        company: { id: companyId, name: 'Company', status: 'active' },
        actor: { id: `actor-${companyId.slice(-1)}`, displayName: null },
        membership: { role, status: 'active' },
        flags: rows[companyId] ?? [],
      };
    },
  };
}

function signedIn(tenant: string, init: RequestInit = {}, url = 'http://localhost/api/feature'): Request {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token({ sub: `uid-${tenant}`, tenant })}`);
  return new Request(url, { ...init, headers });
}

const context = { params: Promise.resolve({}) };
const priceBooksOnForA = { [A]: [{ flag: 'price_books', enabled: true }] };

describe('the known flags', () => {
  it('is a fixed list, every flag off by default', () => {
    expect(FLAG_NAMES).toEqual([
      'price_books',
      'live_voice',
      'ai_summary',
      'ai_scope_fill',
      'ai_meter_reading',
      'ai_voice_notes',
      'ai_job_summary',
      'readiness',
      'priced_extras',
    ]);
    expect(Object.isFrozen(FLAG_NAMES)).toBe(true);
    expect(ALL_OFF).toEqual({
      price_books: false,
      live_voice: false,
      ai_summary: false,
      ai_scope_fill: false,
      ai_meter_reading: false,
      ai_voice_notes: false,
      ai_job_summary: false,
      readiness: false,
      priced_extras: false,
    });
    expect(flagsFromRows([])).toEqual(ALL_OFF);
    expect(flagsFromRows(null)).toEqual(ALL_OFF);
  });

  it('refuses an unknown flag name, including object property names, without repeating it', () => {
    for (const name of ['prices', 'PRICE_BOOKS', 'price_books ', '', 'constructor', '__proto__', 'toString', null, 1]) {
      expect(isFlagName(name)).toBe(false);
      expect(() => parseFlagName(name)).toThrow(FlagRefusal);
    }
    try {
      parseFlagName('secret_name');
    } catch (error) {
      expect((error as FlagRefusal).code).toBe('unknown_flag');
      expect((error as Error).message).not.toContain('secret_name');
    }
    expect(parseFlagName('price_books')).toBe('price_books');
  });

  it('turns a flag on only for a known name stored with enabled exactly true', () => {
    expect(flagsFromRows([{ flag: 'price_books', enabled: true }])).toEqual({ ...ALL_OFF, price_books: true });
    expect(flagsFromRows([{ flag: 'price_books', enabled: false }])).toEqual(ALL_OFF);
    expect(flagsFromRows([{ flag: 'ai_scope_fill', enabled: true }])).toEqual({ ...ALL_OFF, ai_scope_fill: true });
    const odd = [
      { flag: 'price_books', enabled: 'true' },
      { flag: 'price_books', enabled: 1 },
      { flag: 'unknown_feature', enabled: true },
      { flag: '__proto__', enabled: true },
      { flag: 'live_voice', enabled: 'true' },
      { flag: 'AI_SUMMARY', enabled: true },
    ] as unknown as FlagRow[];
    const flags = flagsFromRows(odd);
    expect(flags).toEqual(ALL_OFF);
    expect(Object.keys(flags)).toEqual([...FLAG_NAMES]);
    expect(Object.isFrozen(flags)).toBe(true);
  });

  it('maps price_books onto the capability table switch', () => {
    expect(accessFlags({ ...ALL_OFF, price_books: true })).toEqual({ priceBooks: true });
    expect(accessFlags(ALL_OFF)).toEqual({ priceBooks: false });
    // An AI switch grants no capability key: the AI boundary reads it per feature.
    expect(accessFlags(Object.fromEntries(FLAG_NAMES.map((n) => [n, n !== 'price_books'])) as typeof ALL_OFF)).toEqual({ priceBooks: false });
  });

  it('gives each of the six AI switches an owner, a purpose and a removal date (S7-4)', () => {
    expect([...AI_FLAG_NAMES].sort()).toEqual(
      ['ai_job_summary', 'ai_meter_reading', 'ai_scope_fill', 'ai_summary', 'ai_voice_notes', 'live_voice'].sort(),
    );
    expect(FLAG_NAMES.filter((n) => n !== 'price_books' && n !== 'priced_extras' && n !== 'readiness')).toEqual([
      ...AI_FLAG_NAMES,
    ]);
    expect(Object.keys(AI_FLAG_DETAILS).sort()).toEqual([...AI_FLAG_NAMES].sort());
    for (const name of AI_FLAG_NAMES) {
      const { owner, purpose, removeBy } = AI_FLAG_DETAILS[name];
      expect(owner.trim().length, name).toBeGreaterThan(0);
      expect(purpose.trim().length, name).toBeGreaterThan(20);
      expect(removeBy, name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${removeBy}T00:00:00Z`).toISOString().slice(0, 10), name).toBe(removeBy);
    }
    // Every AI feature's flag is one of them, so the operator can turn each feature on.
    for (const feature of AI_FEATURES) expect(AI_FLAG_NAMES, feature).toContain(AI_REGISTRY[feature].flag);
  });
});

describe('flags at sign-in', () => {
  it('turning a flag on for company A leaves company B off', async () => {
    const dir = directory(priceBooksOnForA);
    const a = await resolveIdentity(signedIn('tenant-a'), verifier, dir);
    const b = await resolveIdentity(signedIn('tenant-b'), verifier, dir);
    expect(a.flags).toEqual({ ...ALL_OFF, price_books: true });
    expect(b.flags).toEqual(ALL_OFF);
    expect(a.capabilities).toEqual(expect.arrayContaining(['prices_read', 'prices_manage']));
    expect(b.capabilities).not.toContain('prices_read');
    expect(b.capabilities).not.toContain('prices_manage');
  });

  it('takes the flags from the signed-in company, never from the request', async () => {
    const sneaky = signedIn(
      'tenant-b',
      { method: 'POST', headers: { 'X-Flags': 'price_books', 'X-Company-Id': A }, body: JSON.stringify({ price_books: true }) },
      `http://localhost/api/feature?price_books=true&companyId=${A}`,
    );
    const identity = await resolveIdentity(sneaky, verifier, directory(priceBooksOnForA));
    expect(identity.flags).toEqual(ALL_OFF);
  });

  it('/api/me capabilities follow the stored switch', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/services', () => ({
      identityServices: () => ({ verifier, directory: directory(priceBooksOnForA, 'estimator') }),
    }));
    const { GET } = await import('@/app/api/me/route');
    const on = await (await GET(signedIn('tenant-a'), context)).json();
    const off = await (await GET(signedIn('tenant-b'), context)).json();
    expect(on.capabilities).toContain('prices_read');
    expect(on.capabilities).not.toContain('prices_manage');
    expect(off.capabilities).not.toContain('prices_read');
  });

  afterEach(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });
});

describe('requireFlag', () => {
  const services = () => ({ verifier, directory: directory(priceBooksOnForA) });

  it('answers 404 without running the handler when the flag is off for the caller company', async () => {
    const handler = vi.fn(() => Response.json({ ok: true }));
    const GET = requireFlag('price_books', handler, {}, services);
    const off = await GET(signedIn('tenant-b'), context);
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: 'not_found' });
    expect(off.headers.get('cache-control')).toBe('no-store');
    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the handler with the identity when the flag is on', async () => {
    const GET = requireFlag('price_books', (_request, identity) => Response.json({ company: identity.companyId }), {}, services);
    const on = await GET(signedIn('tenant-a'), context);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ company: A });
  });

  it('checks the sign-in first, so an unsigned caller gets 401, not 404', async () => {
    const GET = requireFlag('price_books', () => Response.json({}), {}, services);
    const res = await GET(new Request('http://localhost/api/feature'), context);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_token' });
  });

  it('refuses an unknown flag when the route is defined', () => {
    expect(() => requireFlag('not_a_flag' as FlagName, () => Response.json({}), {}, services)).toThrow(FlagRefusal);
  });
});

// A store that keeps rows in memory and applies a transaction's writes only if it finishes,
// like withCompany.
function memoryStore(failAudit = false) {
  const flags = new Map<string, { enabled: boolean; updatedByOperatorId: string }>();
  const audit: (FlagAuditEvent & { companyId: string })[] = [];
  const store: FlagChangeStore = {
    async inCompany(companyId, run) {
      const pendingFlags: [string, { enabled: boolean; updatedByOperatorId: string }][] = [];
      const pendingAudit: (FlagAuditEvent & { companyId: string })[] = [];
      const result = await run({
        async stored(flag) {
          return flags.get(`${companyId}/${flag}`)?.enabled === true;
        },
        async write(row) {
          pendingFlags.push([`${companyId}/${row.flag}`, { enabled: row.enabled, updatedByOperatorId: row.updatedByOperatorId }]);
        },
        async audit(event) {
          if (failAudit) throw new Error('audit insert failed');
          pendingAudit.push({ ...event, companyId });
        },
      });
      for (const [key, value] of pendingFlags) flags.set(key, value);
      audit.push(...pendingAudit);
      return result;
    },
  };
  const rowsOf = (companyId: string): FlagRow[] =>
    [...flags.entries()]
      .filter(([key]) => key.startsWith(`${companyId}/`))
      .map(([key, value]) => ({ flag: key.slice(companyId.length + 1), enabled: value.enabled }));
  return { store, flags, audit, rowsOf };
}

describe('changeCompanyFlag', () => {
  it('turns a flag on for A, leaves B off, and writes exactly one audit row', async () => {
    const { store, audit, rowsOf, flags } = memoryStore();
    const result = await changeCompanyFlag(store, { operatorActorId: OPERATOR, companyId: A, flag: 'price_books', enabled: true });
    expect(result).toEqual({ companyId: A, flag: 'price_books', enabled: true, previous: false });
    expect(flagsFromRows(rowsOf(A))).toEqual({ ...ALL_OFF, price_books: true });
    expect(flagsFromRows(rowsOf(B))).toEqual(ALL_OFF);
    expect(flags.get(`${A}/price_books`)?.updatedByOperatorId).toBe(OPERATOR);
    expect(audit).toEqual([
      {
        companyId: A,
        operatorActorId: OPERATOR,
        action: FLAG_CHANGED_ACTION,
        target: 'price_books',
        details: { enabled: true, previous: false },
      },
    ]);
    expect(FLAG_CHANGED_ACTION).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });

  it('records the previous value when turning a flag back off', async () => {
    const { store, audit, rowsOf } = memoryStore();
    await changeCompanyFlag(store, { operatorActorId: OPERATOR, companyId: A, flag: 'price_books', enabled: true });
    const result = await changeCompanyFlag(store, { operatorActorId: OPERATOR, companyId: A, flag: 'price_books', enabled: false });
    expect(result.previous).toBe(true);
    expect(flagsFromRows(rowsOf(A))).toEqual(ALL_OFF);
    expect(audit.map((event) => event.details)).toEqual([
      { enabled: true, previous: false },
      { enabled: false, previous: true },
    ]);
  });

  it.each([
    ['an unknown flag name', { flag: 'prices' }, 'unknown_flag'],
    ['an object property name', { flag: '__proto__' }, 'unknown_flag'],
    ['a flag that is not a string', { flag: 1 }, 'invalid_request'],
    ['an enabled value that is not a boolean', { enabled: 'true' }, 'invalid_request'],
    ['a company id that is not a uuid', { companyId: 'company-a' }, 'invalid_request'],
    ['an operator id that is not a uuid', { operatorActorId: '' }, 'invalid_request'],
    ['an extra field', { role: 'owner' }, 'invalid_request'],
  ])('refuses %s and writes nothing', async (_name, change, code) => {
    const { store, flags, audit } = memoryStore();
    const inCompany = vi.spyOn(store, 'inCompany');
    const input = { operatorActorId: OPERATOR, companyId: A, flag: 'price_books', enabled: true, ...change };
    const refused = await changeCompanyFlag(store, input).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FlagRefusal);
    expect((refused as FlagRefusal).code).toBe(code);
    expect(inCompany).not.toHaveBeenCalled();
    expect(flags.size).toBe(0);
    expect(audit).toEqual([]);
  });

  it('refuses input that is not an object', async () => {
    const { store } = memoryStore();
    for (const input of [null, undefined, 'price_books', []]) {
      await expect(changeCompanyFlag(store, input)).rejects.toMatchObject({ code: 'invalid_request' });
    }
  });

  it('leaves the flag unchanged when the audit row cannot be written', async () => {
    const { store, flags, audit } = memoryStore(true);
    await expect(
      changeCompanyFlag(store, { operatorActorId: OPERATOR, companyId: A, flag: 'price_books', enabled: true }),
    ).rejects.toThrow('audit insert failed');
    expect(flags.size).toBe(0);
    expect(audit).toEqual([]);
  });
});

describe('who can change a flag', () => {
  it('gives no company role a capability to change flags, with the flag on or off', async () => {
    const { capabilitiesFor } = await import('@/lib/access');
    for (const role of ['owner', 'estimator', 'office']) {
      for (const priceBooks of [true, false]) {
        expect(capabilitiesFor(role, { priceBooks }).filter((key) => /flag|feature/.test(key))).toEqual([]);
      }
    }
  });
});
