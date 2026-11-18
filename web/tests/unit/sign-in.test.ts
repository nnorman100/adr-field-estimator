import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseBrowserSignInConfig, parseConfig, parseLocalSignInFixture } from '@/lib/config';
import { isSignInAddress, noSignInDirectory, signInPageFor, type SignInDirectory } from '@/lib/sign-in';
import type { Database } from '@/db/tenant';
import { databaseSignInDirectory } from '@/lib/sign-in/database-directory';
import { localIdentityDirectory, localSignInDirectory, type LocalSignInFixture } from '@/lib/sign-in/local-directory';
import { endsSession, errorCode, meOutcome, signInErrorMessage } from '@/lib/sign-in/outcome';

// The sign-in screens' server half and their pure decisions (S3-13a). tests/e2e/sign-in.spec.ts
// drives the screens themselves against the Auth emulator.

const COMPANY_A = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
const COMPANY_B = '1c6b2d2f-8e3a-4d9f-8b7c-4a5f6e7d8c9b';
const ACTOR = '2d7c3e3a-9f4b-4ea0-9c8d-5b6a7f8e9dac';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('sign-in address', () => {
  it.each(['a', 'company-a', 'adr', `a${'b'.repeat(38)}c`])('accepts %s', (value) => {
    expect(isSignInAddress(value)).toBe(true);
  });

  it.each(['', 'A', 'Company', '-a', 'a-', 'a_b', 'a.b', 'a/b', `a${'b'.repeat(39)}c`, null, 7])(
    'refuses %s',
    (value) => {
      expect(isSignInAddress(value)).toBe(false);
    },
  );

  it('never asks a directory about a malformed address', async () => {
    const pageFor = vi.fn(async () => ({ companyName: 'A', tenantId: 't' }));
    const directory: SignInDirectory = { pageFor };
    expect(await signInPageFor(directory, '../me')).toBeNull();
    expect(await signInPageFor(directory, 'Company-A')).toBeNull();
    expect(pageFor).not.toHaveBeenCalled();
    expect(await signInPageFor(directory, 'company-a')).toEqual({ companyName: 'A', tenantId: 't' });
  });

  it('recognises no address with the empty directory', async () => {
    expect(await signInPageFor(noSignInDirectory, 'company-a')).toBeNull();
  });
});

describe('GET /api/sign-in/{address}', () => {
  const get = async (address: string) => {
    const { GET } = await import('@/app/api/sign-in/[address]/route');
    return GET(new Request(`http://localhost/api/sign-in/${address}`), { params: Promise.resolve({ address }) });
  };

  it('fails closed, never claiming "not recognised", when no database is configured', async () => {
    vi.stubEnv('APP_ENV', 'test');
    await expect(get('company-a')).rejects.toThrow(/DATABASE_URL/);
  });

  // Security audit F5: a lookup the full pool could not serve within its queue limit.
  it('answers 503, quoting nothing, when no database connection came free in time', async () => {
    const refused = Object.assign(new Error('QUEUE_TIMEOUT: Waited more than 10 seconds for a connection'), { code: 'QUEUE_TIMEOUT' });
    vi.doMock('@/lib/sign-in/services', () => ({
      signInDirectory: () => ({
        pageFor: async () => {
          throw refused;
        },
      }),
    }));
    try {
      const res = await get('company-a');
      expect(res.status).toBe(503);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'sign_in_unavailable' });
    } finally {
      vi.doUnmock('@/lib/sign-in/services');
    }
  });

  it('answers 404 for a malformed address without opening a database', async () => {
    vi.stubEnv('APP_ENV', 'test');
    const res = await get('Company_A');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});

describe('database sign-in directory', () => {
  // A stand-in for the drizzle handle: one read-only transaction that returns the given rows.
  const handle = (rows: unknown[]) => {
    const calls: { config: unknown; sql: string }[] = [];
    const db = {
      transaction: async (run: (tx: unknown) => Promise<unknown>, config: unknown) =>
        run({
          execute: async (query: { queryChunks: unknown[] }) => {
            calls.push({ config, sql: JSON.stringify(query.queryChunks) });
            return rows;
          },
        }),
    };
    return { db: db as unknown as Database, calls };
  };

  it('maps the function row to the page, in a read-only transaction', async () => {
    const { db, calls } = handle([{ company_name: 'Company A', tenant_id: 'tenant-a' }]);
    expect(await databaseSignInDirectory(db).pageFor('company-a')).toEqual({ companyName: 'Company A', tenantId: 'tenant-a' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.config).toEqual({ accessMode: 'read only' });
    expect(calls[0]!.sql).toContain('sign_in_company_page');
    expect(calls[0]!.sql).toContain('company-a');
  });

  it('answers null when the function returns no row', async () => {
    expect(await databaseSignInDirectory(handle([]).db).pageFor('company-z')).toBeNull();
  });
});

describe('local sign-in stand-in', () => {
  let dir: string;
  let path: string;
  const fixture: LocalSignInFixture = {
    companies: [
      { id: COMPANY_A, name: 'Company A', signInAddress: 'company-a', tenantId: 'tenant-a', status: 'active' },
      { id: COMPANY_B, name: 'Company B', signInAddress: 'company-b', tenantId: 'tenant-b', status: 'suspended' },
    ],
    members: [
      { companyId: COMPANY_A, uid: 'u1', actorId: ACTOR, displayName: 'Pat', role: 'estimator', status: 'active' },
    ],
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dryscope-sign-in-'));
    path = join(dir, 'fixture.json');
    await writeFile(path, JSON.stringify(fixture));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('gives an active company’s name and tenant, and nothing for an inactive or unknown one', async () => {
    const directory = localSignInDirectory(path);
    expect(await directory.pageFor('company-a')).toEqual({ companyName: 'Company A', tenantId: 'tenant-a' });
    expect(await directory.pageFor('company-b')).toBeNull();
    expect(await directory.pageFor('company-c')).toBeNull();
  });

  it('answers the identity questions the database answers', async () => {
    const directory = localIdentityDirectory(path);
    expect(await directory.companyForTenant('tenant-a')).toBe(COMPANY_A);
    expect(await directory.companyForTenant('tenant-z')).toBeNull();
    expect(await directory.member(COMPANY_A, 'tenant-a', 'u1')).toEqual({
      company: { id: COMPANY_A, name: 'Company A', status: 'active' },
      actor: { id: ACTOR, displayName: 'Pat' },
      membership: { role: 'estimator', status: 'active' },
      flags: [],
    });
    expect(await directory.member(COMPANY_A, 'tenant-a', 'nobody')).toEqual({
      company: { id: COMPANY_A, name: 'Company A', status: 'active' },
      actor: null,
      membership: null,
      flags: [],
    });
    // Another company's tenant never reads company A.
    expect(await directory.member(COMPANY_A, 'tenant-b', 'u1')).toBeNull();
  });

  it('refuses a malformed file', async () => {
    const bad = join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ companies: [{ id: 'x' }], members: [] }));
    await expect(localSignInDirectory(bad).pageFor('company-a')).rejects.toThrow();
  });

  it('serves the route from the stand-in when the local configuration allows it', async () => {
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'demo-dryscope');
    vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST', '127.0.0.1:9399');
    vi.stubEnv('LOCAL_SIGN_IN_FIXTURE', path);
    const { GET } = await import('@/app/api/sign-in/[address]/route');
    const res = await GET(new Request('http://localhost/api/sign-in/company-a'), {
      params: Promise.resolve({ address: 'company-a' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ company: { name: 'Company A' }, tenantId: 'tenant-a' });
  });
});

describe('sign-in configuration', () => {
  const local = { APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399' };
  const key = 'AIzaSyA-test-key-0123456789abcdefghij';

  it('allows the local stand-in only beside the Auth emulator with no database', () => {
    const fixture = '/tmp/dryscope/fixture.json';
    expect(parseLocalSignInFixture({ ...local, LOCAL_SIGN_IN_FIXTURE: fixture })).toBe(fixture);
    expect(parseLocalSignInFixture(local)).toBeNull();
    const refused = [
      { APP_ENV: 'test', LOCAL_SIGN_IN_FIXTURE: fixture },
      { APP_ENV: 'live', GOOGLE_CLOUD_PROJECT: 'dryscope', LOCAL_SIGN_IN_FIXTURE: fixture },
      { APP_ENV: 'local', GOOGLE_CLOUD_PROJECT: 'demo-dryscope', LOCAL_SIGN_IN_FIXTURE: fixture },
      { ...local, LOCAL_SIGN_IN_FIXTURE: fixture, DATABASE_URL: 'postgres://u@127.0.0.1:5432/d' },
      { ...local, LOCAL_SIGN_IN_FIXTURE: fixture, SQL_CONNECTION_NAME: 'dryscope:us-central1:dryscope-test-pg' },
      { ...local, LOCAL_SIGN_IN_FIXTURE: 'relative/fixture.json' },
      { ...local, LOCAL_SIGN_IN_FIXTURE: '/tmp/fixture.js' },
    ];
    for (const env of refused) {
      expect(() => parseConfig(env)).toThrow(ConfigError);
      expect(() => parseConfig(env)).toThrow(/LOCAL_SIGN_IN_FIXTURE/);
    }
  });

  it('gives the browser the emulator and a placeholder key on a developer machine', () => {
    expect(parseBrowserSignInConfig(local)).toEqual({
      apiKey: 'demo-emulator-api-key',
      authDomain: 'demo-dryscope.firebaseapp.com',
      projectId: 'demo-dryscope',
      authEmulatorUrl: 'http://127.0.0.1:9399',
    });
  });

  it('needs the web API key and auth domain outside the emulator, and never points at an emulator', () => {
    const test = { APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope' };
    expect(parseBrowserSignInConfig(test)).toBeNull();
    expect(parseBrowserSignInConfig({ ...test, FIREBASE_WEB_API_KEY: key })).toBeNull();
    expect(parseBrowserSignInConfig({ APP_ENV: 'test', FIREBASE_WEB_API_KEY: key, FIREBASE_AUTH_DOMAIN: 'dryscope.firebaseapp.com' })).toBeNull();
    expect(parseBrowserSignInConfig({ ...test, FIREBASE_WEB_API_KEY: key, FIREBASE_AUTH_DOMAIN: 'dryscope.firebaseapp.com' })).toEqual({
      apiKey: key,
      authDomain: 'dryscope.firebaseapp.com',
      projectId: 'dryscope',
      authEmulatorUrl: null,
    });
  });

  it.each([
    ['FIREBASE_WEB_API_KEY', 'short'],
    ['FIREBASE_WEB_API_KEY', 'has spaces in it and is long enough'],
    ['FIREBASE_AUTH_DOMAIN', 'https://dryscope.firebaseapp.com'],
    ['FIREBASE_AUTH_DOMAIN', 'no_underscores.example.com'],
  ])('refuses a malformed %s without echoing it', (name, value) => {
    expect(() => parseConfig({ APP_ENV: 'test', [name]: value })).toThrow(new RegExp(name));
    expect(() => parseConfig({ APP_ENV: 'test', [name]: value })).not.toThrow(value);
  });
});

describe('what the screens show after GET /api/me', () => {
  it('shows signed in only for a well-formed member answer', () => {
    expect(meOutcome(200, { company: { id: COMPANY_A, name: 'Company A' }, role: 'estimator' })).toEqual({
      kind: 'signed-in',
      companyName: 'Company A',
      role: 'estimator',
    });
    expect(meOutcome(200, {})).toEqual({ kind: 'unavailable' });
    expect(meOutcome(200, null)).toEqual({ kind: 'unavailable' });
  });

  it.each([
    [403, 'email_unverified', 'verify-email'],
    [403, 'not_a_member', 'needs-invitation'],
    [403, 'member_disabled', 'member-disabled'],
    [403, 'company_inactive', 'company-inactive'],
    [403, 'second_step_required', 'second-step'],
    [401, 'sign_in_again', 'sign-in-again'],
    [401, 'sign_in_revoked', 'sign-in-again'],
    [401, 'invalid_token', 'sign-in-again'],
    [401, 'missing_token', 'sign-in-again'],
    [403, 'no_tenant', 'not-this-company'],
    [403, 'unknown_tenant', 'not-this-company'],
    [403, 'account_disabled', 'account-disabled'],
    [401, 'something_new', 'sign-in-again'],
    [403, 'something_new', 'unavailable'],
    [403, 'toString', 'unavailable'],
    [503, 'identity_unavailable', 'unavailable'],
    [500, undefined, 'unavailable'],
  ])('%i %s shows %s', (status, error, kind) => {
    expect(meOutcome(status, { error }).kind).toBe(kind);
  });

  it('ends the phone’s sign-in only when it cannot be used for this company', () => {
    const ending = ['sign-in-again', 'not-this-company', 'account-disabled'];
    for (const kind of ['verify-email', 'needs-invitation', 'member-disabled', 'company-inactive', 'second-step', 'unavailable', ...ending]) {
      expect({ kind, ends: endsSession({ kind } as never) }).toEqual({ kind, ends: ending.includes(kind) });
    }
  });
});

describe('sign-in error messages', () => {
  it('says the same thing for a wrong password and an unknown account', () => {
    const wrong = signInErrorMessage('auth/wrong-password', 'Company A');
    for (const code of ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/user-not-found']) {
      expect(signInErrorMessage(code, 'Company A')).toBe(wrong);
    }
  });

  it('says nothing when the person closed the Google window', () => {
    expect(signInErrorMessage('auth/popup-closed-by-user', 'A')).toBeNull();
    expect(signInErrorMessage('auth/cancelled-popup-request', 'A')).toBeNull();
  });

  // Tenants enforce a 12-character password rule and make a shorter old password be changed at the
  // next sign-in (owner decision 2026-11-14); Firebase then refuses the sign-in with this code.
  it('tells a person whose password is too short to set a new one', () => {
    const message = signInErrorMessage('auth/password-does-not-meet-requirements', 'Company A');
    expect(message).toContain('at least 12 characters');
    expect(message).toContain('Set your own password');
  });

  it('falls back to a fixed message and reads only the error code', () => {
    expect(signInErrorMessage('auth/internal-error', 'A')).toBe('Sign-in did not work. Try again.');
    expect(signInErrorMessage(undefined, 'A')).toBe('Sign-in did not work. Try again.');
    const error = Object.assign(new Error('pat@example.com: INVALID_PASSWORD'), { code: 'auth/wrong-password' });
    expect(errorCode(error)).toBe('auth/wrong-password');
    expect(signInErrorMessage(errorCode(error), 'A')).not.toContain('pat@example.com');
    expect(errorCode('nope')).toBeNull();
  });
});
