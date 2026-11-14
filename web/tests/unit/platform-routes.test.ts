import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { IdentityRefusal, type OperatorDirectory, type TokenVerifier } from '@/lib/auth/identity';
import { operatorRoute } from '@/lib/auth/route';
import { isMemberApiPath, isOperatorApiPath, operatorApiPaths } from '@/lib/public-api';
import { proxy } from '@/proxy';
import { createTenant, parseTenantArgs, tenantBody } from '../../scripts/create-tenant';

// The operator routes without a database: the proxy passes exactly the files under api/platform on
// to the operator sign-in check, the rule refuses what it must before any handler runs, and the
// owner-run tenant command sends what the plan says. tests/db/platform-*.test.ts drive the routes against Postgres.

const API_DIR = fileURLToPath(new URL('../../src/app/api', import.meta.url));
const ID = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (/^route\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

describe('operator route files', () => {
  it('passes exactly the operator routes on to their own sign-in check', async () => {
    const files = (await routeFiles(join(API_DIR, 'platform'))).map((path) =>
      `/api/${relative(API_DIR, join(path, '..'))}`.replace(/\[[A-Za-z]+\]/g, ':id'),
    );
    expect([...operatorApiPaths].sort()).toEqual(files.sort());
    for (const pattern of operatorApiPaths) {
      const real = pattern.replaceAll(':id', ID);
      expect(isOperatorApiPath(real)).toBe(true);
      expect(isMemberApiPath(real)).toBe(false);
      expect(proxy(new NextRequest(new URL(real, 'http://localhost'))).headers.get('x-middleware-next')).toBe('1');
    }
    for (const path of ['/api/platform', '/api/platform/operators', `/api/platform/companies/${ID}`, '/api/platform/companies/x/team']) {
      expect({ path, status: proxy(new NextRequest(new URL(path, 'http://localhost'))).status }).toEqual({ path, status: 401 });
    }
  });
});

describe('operatorRoute', () => {
  const now = Math.floor(Date.now() / 1000);
  const operators: OperatorDirectory = {
    async operatorFor(tenant, uid) {
      return tenant === 'operators' && uid === 'op' ? ID : null;
    },
  };
  const verifier = (tenant: string | null, session: { authTime?: number; secondFactor?: string | null } = {}): TokenVerifier => ({
    async verify() {
      return { tenant, uid: 'op', emailVerified: true };
    },
    async verifyNotRevoked(_token, signed) {
      if (signed !== tenant) throw new IdentityRefusal('invalid_token');
      return { tenant, uid: 'op', emailVerified: true, authTime: session.authTime ?? now - 60, secondFactor: session.secondFactor === undefined ? 'totp' : session.secondFactor };
    },
  });
  const signedIn = () => new Request('http://localhost/api/platform/companies', { headers: { Authorization: 'Bearer e30.e30.' } });
  const context = { params: Promise.resolve({}) };

  it('passes an active operator with a second step to the handler', async () => {
    const handler = vi.fn(async () => Response.json({}));
    const response = await operatorRoute(handler, {}, () => ({ verifier: verifier('operators'), operators }))(signedIn(), context);
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.any(Request), { operatorId: ID, uid: 'op', tenant: 'operators' }, context);
  });

  it.each([
    ['a company tenant', 'tenant-a', {}, {}, 403, 'not_an_operator'],
    ['no tenant', null, {}, {}, 403, 'not_an_operator'],
    ['no second step', 'operators', { secondFactor: null }, {}, 403, 'second_step_required'],
    ['a text-message second step', 'operators', { secondFactor: 'phone' }, {}, 403, 'second_step_required'],
    ['a sign-in older than 12 hours', 'operators', { authTime: now - 12 * 3600 - 60 }, {}, 401, 'sign_in_again'],
    ['a stale sign-in on a fresh route', 'operators', { authTime: now - 16 * 60 }, { freshSignIn: true }, 401, 'sign_in_again'],
  ] as const)('refuses %s before the handler runs', async (_name, tenant, session, rule, status, code) => {
    const handler = vi.fn(async () => Response.json({}));
    const response = await operatorRoute(handler, rule, () => ({ verifier: verifier(tenant, session), operators }))(signedIn(), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks revocation only after finding the operator, and fails closed when the lookup fails', async () => {
    const verifyNotRevoked = vi.fn();
    const handler = vi.fn(async () => Response.json({}));
    const company: TokenVerifier = { verify: async () => ({ tenant: 'tenant-a', uid: 'op', emailVerified: true }), verifyNotRevoked };
    await operatorRoute(handler, {}, () => ({ verifier: company, operators }))(signedIn(), context);
    expect(verifyNotRevoked).not.toHaveBeenCalled();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: OperatorDirectory = { operatorFor: async () => Promise.reject(new Error('database down')) };
    const response = await operatorRoute(handler, {}, () => ({ verifier: verifier('operators'), operators: broken }))(signedIn(), context);
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('the owner-run tenant command', () => {
  it('creates a tenant with password sign-in, no public sign-up, authenticator-app second steps, a 12-character password rule and email enumeration protection', async () => {
    const fetch = vi.fn(async () => Response.json({ name: 'projects/dryscope/tenants/test-company-a-x1y2z' }));
    const id = await createTenant(parseTenantArgs(['--project', 'dryscope', '--name', 'test-company-a']), {
      accessToken: async () => 'token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(id).toBe('test-company-a-x1y2z');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://identitytoolkit.googleapis.com/v2/projects/dryscope/tenants');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Goog-User-Project']).toBe('dryscope');
    expect(JSON.parse(String(init.body))).toEqual({
      displayName: 'test-company-a',
      allowPasswordSignup: true,
      enableEmailLinkSignin: false,
      client: { permissions: { disabledUserSignup: true, disabledUserDeletion: true } },
      mfaConfig: { state: 'ENABLED', providerConfigs: [{ state: 'ENABLED', totpProviderConfig: { adjacentIntervals: 1 } }] },
      // Owner decision 2026-11-14 (sign-in security review, F1 and F2).
      passwordPolicyConfig: {
        passwordPolicyEnforcementState: 'ENFORCE',
        forceUpgradeOnSignin: true,
        passwordPolicyVersions: [{ customStrengthOptions: { minPasswordLength: 12 } }],
      },
      emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
    });
    expect(tenantBody('x')).not.toHaveProperty('enableAnonymousUser');
  });

  it('names only the status when the call fails, and checks its arguments', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"message":"secret detail"}}', { status: 403 }));
    await expect(
      createTenant({ project: 'dryscope', name: 'test-ops' }, { accessToken: async () => 't', fetch: fetch as unknown as typeof globalThis.fetch }),
    ).rejects.toThrow(/^creating the tenant failed with status 403$/);
    expect(() => parseTenantArgs(['--project', 'dryscope'])).toThrow(/--name is required/);
    expect(() => parseTenantArgs(['--project', 'dryscope', '--name', '1abc'])).toThrow(/--name/);
    expect(() => parseTenantArgs(['--project', 'dryscope', '--name', 'abc'])).toThrow(/--name/);
    expect(() => parseTenantArgs(['--project', 'Dry Scope', '--name', 'test-ops'])).toThrow(/--project/);
    expect(() => parseTenantArgs(['--project', 'dryscope', '--name', 'test-ops', '--kind', 'x'])).toThrow(/unknown option/);
    expect(() => parseTenantArgs(['--project', 'dryscope', '--name', 'test-ops', '--dry-run'])).toThrow(/unknown option/);
    expect(parseTenantArgs(['--project', 'dryscope', '--name', 'test-ops'])).toEqual({ project: 'dryscope', name: 'test-ops' });
  });
});
