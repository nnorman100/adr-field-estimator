import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdentityRefusal,
  memberRoute,
  resolveIdentity,
  type IdentityDirectory,
  type MemberRecord,
  type TokenVerifier,
  type VerifiedToken,
} from '@/lib/auth';
import { getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { claimedTenant, firebaseTokenVerifier, IdentityUnavailable } from '@/lib/auth/firebase';
import { ConfigError, parseConfig, parseIdentityConfig } from '@/lib/config';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

// A fake token: the tests only need its shape. The fake verifier reads the claims from it.
function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

type Account = VerifiedToken & { revoked?: boolean; disabled?: boolean };

function fakeVerifier(): TokenVerifier & { calls: string[] } {
  const calls: string[] = [];
  const read = (idToken: string): Account => {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    if (claims.bad) throw new IdentityRefusal('invalid_token');
    return {
      uid: claims.sub as string,
      tenant: (claims.tenant as string | undefined) ?? null,
      emailVerified: claims.email_verified === true,
      revoked: claims.revoked === true,
      disabled: claims.disabled === true,
    };
  };
  return {
    calls,
    async verify(idToken) {
      calls.push('verify');
      const { uid, tenant, emailVerified } = read(idToken);
      return { uid, tenant, emailVerified };
    },
    async verifyNotRevoked(idToken, tenant) {
      calls.push(`verifyNotRevoked:${tenant}`);
      const account = read(idToken);
      if (account.tenant !== tenant) throw new IdentityRefusal('invalid_token');
      if (account.disabled) throw new IdentityRefusal('account_disabled');
      if (account.revoked) throw new IdentityRefusal('sign_in_revoked');
      return { uid: account.uid, tenant: account.tenant, emailVerified: account.emailVerified };
    },
  };
}

const companiesByTenant: Record<string, string> = { 'tenant-a': A, 'tenant-b': B };

function record(companyId: string, overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    company: { id: companyId, name: `Company ${companyId.slice(-1)}`, status: 'active' },
    actor: { id: `actor-${companyId.slice(-1)}`, displayName: 'Synthetic member' },
    membership: { role: 'estimator', status: 'active' },
    ...overrides,
  };
}

function fakeDirectory(records: Record<string, MemberRecord | null> = {}): IdentityDirectory & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async companyForTenant(tenant) {
      calls.push(`company:${tenant}`);
      return companiesByTenant[tenant] ?? null;
    },
    async member(companyId, tenant, uid) {
      calls.push(`member:${companyId}:${tenant}:${uid}`);
      return companyId in records ? records[companyId]! : record(companyId);
    },
  };
}

function request(idToken?: string, init: RequestInit = {}, url = 'http://localhost/api/me'): Request {
  const headers = new Headers(init.headers);
  if (idToken) headers.set('Authorization', `Bearer ${idToken}`);
  return new Request(url, { ...init, headers });
}

const memberA = { sub: 'uid-a', tenant: 'tenant-a', email_verified: true };
const memberB = { sub: 'uid-b', tenant: 'tenant-b', email_verified: true };

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IdentityRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('resolveIdentity', () => {
  it('resolves a member from the token tenant and returns role and capabilities', async () => {
    const verifier = fakeVerifier();
    const directory = fakeDirectory();
    const identity = await resolveIdentity(request(token(memberA)), verifier, directory);
    expect(identity).toMatchObject({ companyId: A, actorId: 'actor-a', uid: 'uid-a', tenant: 'tenant-a', role: 'estimator' });
    expect(identity.capabilities).toContain('sign');
    expect(identity.capabilities).not.toContain('team_manage');
    // Verify, find the company, then the revocation check on that tenant.
    expect(verifier.calls).toEqual(['verify', 'verifyNotRevoked:tenant-a']);
    expect(directory.calls).toEqual(['company:tenant-a', 'member:' + A + ':tenant-a:uid-a']);
  });

  it('never resolves company A from a tenant B token', async () => {
    const identity = await resolveIdentity(request(token(memberB)), fakeVerifier(), fakeDirectory());
    expect(identity.companyId).toBe(B);
  });

  it('ignores a company id sent by the browser in the URL, a header or the body', async () => {
    const directory = fakeDirectory();
    const sneaky = request(
      token(memberB),
      {
        method: 'POST',
        headers: { 'X-Company-Id': A, Cookie: `companyId=${A}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: A, tenant: 'tenant-a' }),
      },
      `http://localhost/api/me?companyId=${A}&tenant=tenant-a`,
    );
    const identity = await resolveIdentity(sneaky, fakeVerifier(), directory);
    expect(identity.companyId).toBe(B);
    expect(directory.calls.join(' ')).not.toContain(A);
  });

  it.each([
    ['no Authorization header', undefined, 'missing_token'],
    ['a token that is not a JWT', 'not-a-token', 'invalid_token'],
    ['a token the verifier refuses', token({ ...memberA, bad: true }), 'invalid_token'],
    ['a token with no tenant', token({ sub: 'uid-x', email_verified: true }), 'no_tenant'],
    ['a token from an unknown tenant', token({ ...memberA, tenant: 'tenant-z' }), 'unknown_tenant'],
    ['a revoked token', token({ ...memberA, revoked: true }), 'sign_in_revoked'],
    ['a disabled account', token({ ...memberA, disabled: true }), 'account_disabled'],
    ['an unverified email', token({ ...memberA, email_verified: false }), 'email_unverified'],
  ])('refuses %s', async (_name, idToken, code) => {
    expect(await refusalOf(resolveIdentity(request(idToken), fakeVerifier(), fakeDirectory()))).toBe(code);
  });

  it('refuses a Basic header and a second word after the token', async () => {
    const r1 = new Request('http://localhost/', { headers: { Authorization: 'Basic abc' } });
    const r2 = new Request('http://localhost/', { headers: { Authorization: `Bearer ${token(memberA)} extra` } });
    expect(await refusalOf(resolveIdentity(r1, fakeVerifier(), fakeDirectory()))).toBe('invalid_token');
    expect(await refusalOf(resolveIdentity(r2, fakeVerifier(), fakeDirectory()))).toBe('invalid_token');
  });

  it('does not reach the revocation check or the member lookup for an unknown tenant', async () => {
    const verifier = fakeVerifier();
    const directory = fakeDirectory();
    await refusalOf(resolveIdentity(request(token({ ...memberA, tenant: 'tenant-z' })), verifier, directory));
    expect(verifier.calls).toEqual(['verify']);
    expect(directory.calls).toEqual(['company:tenant-z']);
  });

  it.each([
    ['a disabled member', record(A, { membership: { role: 'owner', status: 'disabled' } }), 'member_disabled'],
    ['a member of a suspended company', record(A, { company: { id: A, name: 'A', status: 'suspended' } }), 'company_inactive'],
    ['a member of an archived company', record(A, { company: { id: A, name: 'A', status: 'archived' } }), 'company_inactive'],
    ['an actor with no membership', record(A, { membership: null }), 'not_a_member'],
    ['an account with no actor', record(A, { actor: null, membership: null }), 'not_a_member'],
    ['a company row that is not visible', null, 'unknown_tenant'],
  ])('refuses %s', async (_name, member, code) => {
    const directory = fakeDirectory({ [A]: member });
    expect(await refusalOf(resolveIdentity(request(token(memberA)), fakeVerifier(), directory))).toBe(code);
  });
});

describe('memberRoute', () => {
  const services = () => ({ verifier: fakeVerifier(), directory: fakeDirectory() });

  it('hands the handler the identity and answers with it', async () => {
    const GET = memberRoute((_request, identity) => Response.json({ company: identity.companyId }), services);
    const res = await GET(request(token(memberB)), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ company: B });
  });

  it('refuses without calling the handler, with only a code in the body', async () => {
    const handler = vi.fn(() => Response.json({}));
    const GET = memberRoute(handler, services);
    const res = await GET(request(token({ ...memberA, revoked: true })), { params: Promise.resolve({}) });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_revoked' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(handler).not.toHaveBeenCalled();
    const forbidden = await GET(request(token({ ...memberA, email_verified: false })), { params: Promise.resolve({}) });
    expect(forbidden.status).toBe(403);
  });

  it('fails closed with 503 and logs no token when the check cannot run', async () => {
    const secretToken = token(memberA);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = () => ({
      verifier: {
        verify: async () => {
          throw new Error(`network failure for ${secretToken}`);
        },
        verifyNotRevoked: async () => {
          throw new IdentityUnavailable();
        },
      },
      directory: fakeDirectory(),
    });
    const handler = vi.fn(() => Response.json({}));
    const res = await memberRoute(handler, broken)(request(secretToken), { params: Promise.resolve({}) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'identity_unavailable' });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(secretToken);
    errors.mockRestore();
  });

  it('fails closed when the server has no sign-in configuration', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const missing = () => parseIdentityConfig({ APP_ENV: 'test' }) as never;
    const res = await memberRoute(() => Response.json({}), missing)(request(token(memberA)), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(503);
    errors.mockRestore();
  });
});

describe('/api/me', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });

  it('is a member route returning company, role and capabilities, with no email, uid or token', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/services', () => ({
      identityServices: () => ({ verifier: fakeVerifier(), directory: fakeDirectory() }),
    }));
    const { GET } = await import('@/app/api/me/route');
    const idToken = token(memberA);
    const res = await GET(request(idToken), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ company: { id: A, name: 'Company a' }, actor: { id: 'actor-a' }, role: 'estimator' });
    expect(body.capabilities).toContain('jobs_read');
    const text = JSON.stringify(body);
    expect(text).not.toContain('uid-a');
    expect(text).not.toContain(idToken);
    expect((await GET(request(), { params: Promise.resolve({}) })).status).toBe(401);
  });
});

describe('claimedTenant', () => {
  it('reads the tenant a token names, and refuses a malformed one', () => {
    expect(claimedTenant(token({ firebase: { tenant: 'company-a-x1y2z' } }))).toBe('company-a-x1y2z');
    expect(claimedTenant(token({ firebase: {} }))).toBeNull();
    expect(claimedTenant(token({}))).toBeNull();
    expect(() => claimedTenant(token({ firebase: { tenant: 7 } }))).toThrow(IdentityRefusal);
    expect(() => claimedTenant(token({ firebase: { tenant: '../other' } }))).toThrow(IdentityRefusal);
    expect(() => claimedTenant('a.%%%.c')).toThrow(IdentityRefusal);
  });
});

describe('firebaseTokenVerifier', () => {
  it('checks the first token on the project, never on a tenant the unverified token claims', async () => {
    expect(process.env.FIREBASE_AUTH_EMULATOR_HOST).toBeUndefined();
    const verifier = firebaseTokenVerifier({ appEnv: 'test', projectId: 'dryscope-unit', authEmulatorHost: null });
    const app = getApps().find((candidate) => candidate.name === 'dryscope-identity-dryscope-unit')!;
    const auth = getAuth(app);
    const forTenant = vi.spyOn(auth.tenantManager(), 'authForTenant');
    const check = vi
      .spyOn(auth, 'verifyIdToken')
      .mockResolvedValueOnce({ uid: 'uid-a', email_verified: true, firebase: { tenant: 'tenant-a' } } as never);

    const idToken = token({ firebase: { tenant: 'tenant-forged-1' } });
    await expect(verifier.verify(idToken)).resolves.toEqual({ uid: 'uid-a', tenant: 'tenant-a', emailVerified: true });
    expect(check).toHaveBeenCalledWith(idToken, false);

    check.mockRestore();
    const refused = verifier.verify(token({ firebase: { tenant: 'tenant-forged-2' } }));
    await expect(refused).rejects.toMatchObject({ code: 'invalid_token' });
    expect(forTenant).not.toHaveBeenCalled();
    forTenant.mockRestore();
  });
});

describe('sign-in configuration', () => {
  it('needs GOOGLE_CLOUD_PROJECT to check a sign-in, but not to boot', () => {
    expect(parseConfig({ APP_ENV: 'test' }).appEnv).toBe('test');
    expect(() => parseIdentityConfig({ APP_ENV: 'test' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(parseIdentityConfig({ APP_ENV: 'live', GOOGLE_CLOUD_PROJECT: 'dryscope' })).toEqual({
      appEnv: 'live',
      projectId: 'dryscope',
      authEmulatorHost: null,
    });
    expect(() => parseConfig({ APP_ENV: 'live', GOOGLE_CLOUD_PROJECT: 'Not A Project' })).toThrow(ConfigError);
  });

  it('reads the names the Cloud Run Terraform sets (infra/dryscope/app/cloud_run.tf common_env)', () => {
    // The environment a test or live service starts with: no APP_ENV, no Firebase-specific name.
    const cloudRun = {
      APP_ENVIRONMENT: 'test',
      GOOGLE_CLOUD_PROJECT: 'dryscope',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
      FIRESTORE_DATABASE_ID: 'dryscope-field-test',
      ALLOWED_ORIGINS: 'https://test.example.test',
    };
    expect(parseConfig(cloudRun)).toEqual({ appEnv: 'test', databaseUrl: null });
    expect(parseIdentityConfig(cloudRun)).toEqual({ appEnv: 'test', projectId: 'dryscope', authEmulatorHost: null });
    expect(parseConfig({ ...cloudRun, APP_ENVIRONMENT: 'live' }).appEnv).toBe('live');
    // An invalid or contradictory environment name still stops the app, without echoing it.
    expect(() => parseConfig({ ...cloudRun, APP_ENVIRONMENT: 'staging-secret' })).toThrow(/APP_ENVIRONMENT/);
    expect(() => parseConfig({ ...cloudRun, APP_ENVIRONMENT: 'staging-secret' })).not.toThrow(/staging-secret/);
    expect(() => parseConfig({ ...cloudRun, APP_ENV: 'live' })).toThrow(/must match/);
    expect(parseConfig({ ...cloudRun, APP_ENV: 'test' }).appEnv).toBe('test');
  });

  it('allows the Auth emulator only locally, for a demo- project, on a loopback address', () => {
    const local = { APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399' };
    expect(parseIdentityConfig(local).authEmulatorHost).toBe('127.0.0.1:9399');
    for (const appEnv of ['test', 'live']) {
      expect(() => parseConfig({ ...local, APP_ENV: appEnv })).toThrow(/allowed only when APP_ENV is local/);
    }
    expect(() => parseConfig({ ...local, GOOGLE_CLOUD_PROJECT: 'dryscope' })).toThrow(/demo-/);
    expect(() => parseConfig({ ...local, FIREBASE_AUTH_EMULATOR_HOST: 'auth.example.com:9399' })).toThrow(/loopback/);
    // The live app refuses to start rather than trust unsigned tokens.
    expect(() =>
      parseConfig({ APP_ENV: 'live', GOOGLE_CLOUD_PROJECT: 'dryscope', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399' }),
    ).toThrow(ConfigError);
  });
});
