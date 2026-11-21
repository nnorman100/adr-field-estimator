import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_DETAILS, flagsFromRows } from '@/lib/flags';
import { IdentityRefusal, type IdentityDirectory, type MemberRecord, type TokenVerifier } from '@/lib/auth';
import { actionDigest, watchActionBody } from '@/lib/drying/watch-service';

// S5b-10 slice 10B outside the database: the default-off `drying_watch` switch, its exposure in
// /api/me, and the watch action's request shape. The routes themselves are in
// tests/db/drying-watch-api.test.ts.

const A = '00000000-0000-4000-8000-00000000000a';

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

const verifier: TokenVerifier = {
  async verify(idToken) {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, string>;
    return { uid: claims.sub!, tenant: claims.tenant ?? null, emailVerified: true };
  },
  async verifyNotRevoked(idToken, tenant) {
    const found = await this.verify(idToken);
    if (found.tenant !== tenant) throw new IdentityRefusal('invalid_token');
    return { ...found, authTime: Math.floor(Date.now() / 1000) - 60, secondFactor: 'totp' };
  },
};

const directory = (flags: MemberRecord['flags']): IdentityDirectory => ({
  companyForTenant: async (tenant) => (tenant === 'tenant-a' ? A : null),
  member: async (companyId) => ({
    company: { id: companyId, name: 'Company', status: 'active' },
    actor: { id: 'actor-a', displayName: null },
    membership: { role: 'estimator', status: 'active' },
    flags,
  }),
});

const signedIn = () => new Request('http://localhost/api/me', { headers: { Authorization: `Bearer ${token({ sub: 'uid-a', tenant: 'tenant-a' })}` } });

describe('the drying_watch switch', () => {
  it('is off unless the company has it exactly on, and has an owner, a purpose and a review date', () => {
    expect(flagsFromRows([]).drying_watch).toBe(false);
    expect(flagsFromRows([{ flag: 'drying_watch', enabled: 'true' as unknown as boolean }]).drying_watch).toBe(false);
    expect(flagsFromRows([{ flag: 'drying_watch', enabled: true }]).drying_watch).toBe(true);
    const { owner, purpose, removeBy } = FEATURE_FLAG_DETAILS.drying_watch;
    expect(owner.trim().length).toBeGreaterThan(0);
    expect(purpose).toMatch(/Drying watch/);
    expect(new Date(`${removeBy}T00:00:00Z`).toISOString().slice(0, 10)).toBe(removeBy);
  });
});

describe('/api/me', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });

  it('tells the screens whether the drying watch is on for the company', async () => {
    for (const [rows, expected] of [
      [[{ flag: 'drying_watch', enabled: true }], true],
      [[{ flag: 'drying_watch', enabled: false }, { flag: 'readiness', enabled: true }], false],
      [[], false],
    ] as const) {
      vi.resetModules();
      vi.doMock('@/lib/auth/services', () => ({ identityServices: () => ({ verifier, directory: directory([...rows]) }) }));
      const { GET } = await import('@/app/api/me/route');
      const res = await GET(signedIn(), { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { features: { drying_watch: unknown } }).features.drying_watch).toBe(expected);
    }
  });
});

describe('a watch action request', () => {
  const ID = '6a2b8c4d-1e3f-4a5b-9c6d-7e8f9a0b1c2d';
  const body = (extra: Record<string, unknown> = {}) => ({ id: ID, action: 'extend', factsHash: 'a'.repeat(64), confirmed: true, reason: 'Waiting on a second dehumidifier.', ...extra });
  const ok = (value: unknown) => watchActionBody.safeParse(value).success;

  it('needs an explicit confirmation, a known action, the reviewed facts hash and a reason of at most 500 characters', () => {
    expect(ok(body())).toBe(true);
    expect(ok(body({ reason: 'Line one\nline two', action: 'mark_dry' }))).toBe(true);
    for (const extra of [{ confirmed: false }, { confirmed: 'true' }, { action: 'remind' }, { factsHash: 'A'.repeat(64) }, { factsHash: 'a'.repeat(63) }, { reason: '' }, { reason: '   ' }, { reason: ' 　' }, { reason: 'x'.repeat(501) }, { reason: 'bell\u0007' }, { other: 1 }]) {
      expect(ok(body(extra))).toBe(false);
    }
  });

  it('digests the same request the same way, whatever the id letter case, and another reason differently', () => {
    const one = actionDigest(watchActionBody.parse(body()));
    expect(actionDigest(watchActionBody.parse(body({ id: ID.toUpperCase() })))).toBe(one);
    expect(actionDigest(watchActionBody.parse(body({ reason: 'Another reason.' })))).not.toBe(one);
  });
});
