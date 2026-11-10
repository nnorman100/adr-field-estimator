import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, parseConfig, parseProjectionConfig } from '@/lib/config';
import { renewSignedInAccess } from '@/lib/projection/services';

const A = '00000000-0000-4000-8000-00000000000a';

describe('access record configuration', () => {
  const cloudRun = {
    APP_ENVIRONMENT: 'test',
    GOOGLE_CLOUD_PROJECT: 'dryscope',
    FIRESTORE_DATABASE_ID: 'dryscope-field-test',
  };

  it('reads the names the Cloud Run Terraform sets (infra/dryscope/app/cloud_run.tf common_env)', () => {
    expect(parseProjectionConfig(cloudRun)).toEqual({
      projectId: 'dryscope',
      databaseId: 'dryscope-field-test',
      firestoreEmulatorHost: null,
    });
  });

  it('needs the project and database to write a record, but not to boot', () => {
    expect(parseConfig({ APP_ENV: 'test' }).appEnv).toBe('test');
    expect(() => parseProjectionConfig({ APP_ENV: 'test', GOOGLE_CLOUD_PROJECT: 'dryscope' })).toThrow(/FIRESTORE_DATABASE_ID/);
    expect(() => parseProjectionConfig({ APP_ENV: 'test', FIRESTORE_DATABASE_ID: '(default)' })).toThrow(/GOOGLE_CLOUD_PROJECT/);
    expect(() => parseConfig({ ...cloudRun, FIRESTORE_DATABASE_ID: 'Bad/Database' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...cloudRun, FIRESTORE_DATABASE_ID: 'Bad/Database' })).not.toThrow(/Bad\/Database/);
    expect(parseProjectionConfig({ ...cloudRun, FIRESTORE_DATABASE_ID: '(default)' }).databaseId).toBe('(default)');
  });

  it('allows the Firestore emulator only locally, for a demo- project, on a loopback address', () => {
    const local = {
      APP_ENV: 'local',
      GOOGLE_CLOUD_PROJECT: 'demo-dryscope',
      FIRESTORE_DATABASE_ID: '(default)',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8399',
    };
    expect(parseProjectionConfig(local).firestoreEmulatorHost).toBe('127.0.0.1:8399');
    for (const appEnv of ['test', 'live']) {
      expect(() => parseConfig({ ...local, APP_ENV: appEnv })).toThrow(/FIRESTORE_EMULATOR_HOST is allowed only when APP_ENV is local/);
    }
    expect(() => parseConfig({ ...local, GOOGLE_CLOUD_PROJECT: 'dryscope' })).toThrow(/demo-/);
    expect(() => parseConfig({ ...local, FIRESTORE_EMULATOR_HOST: 'firestore.example.com:8399' })).toThrow(/loopback/);
  });
});

describe('renewal on the request path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/auth/services');
    vi.doUnmock('@/lib/projection/services');
    vi.resetModules();
  });

  it('never fails the request, and logs fixed text only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      renewSignedInAccess({ companyId: A, actorId: A }, () => {
        throw new Error('connect failed for postgres://user:secret@db/app');
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledWith('access renewal unavailable', 'Error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('secret');
  });

  it('runs for the signed-in member when /api/me answers', async () => {
    vi.resetModules();
    const renew = vi.fn(async () => {});
    vi.doMock('@/lib/projection/services', () => ({ renewSignedInAccess: renew }));
    vi.doMock('@/lib/auth/services', () => ({
      identityServices: () => ({
        verifier: {
          async verify() {
            return { uid: 'uid-a', tenant: 'tenant-a', emailVerified: true };
          },
          async verifyNotRevoked() {
            return {
              uid: 'uid-a',
              tenant: 'tenant-a',
              emailVerified: true,
              authTime: Math.floor(Date.now() / 1000) - 60,
              secondFactor: null,
            };
          },
        },
        directory: {
          async companyForTenant() {
            return A;
          },
          async member() {
            return {
              company: { id: A, name: 'Company a', status: 'active' as const },
              actor: { id: 'actor-a', displayName: null },
              membership: { role: 'estimator' as const, status: 'active' as const },
            };
          },
        },
      }),
    }));
    const { GET } = await import('@/app/api/me/route');
    const res = await GET(new Request('http://localhost/api/me', { headers: { Authorization: 'Bearer a.b.c' } }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith(expect.objectContaining({ companyId: A, actorId: 'actor-a' }));
    // A refused request renews nothing.
    expect((await GET(new Request('http://localhost/api/me'), { params: Promise.resolve({}) })).status).toBe(401);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
