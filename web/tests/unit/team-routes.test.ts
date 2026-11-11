import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IdentityRefusal, type IdentityDirectory, type TokenVerifier } from '@/lib/auth/identity';
import { accountRoute } from '@/lib/auth/route';
import {
  isMemberApiPath,
  isOperatorApiPath,
  isPublicApiPath,
  isServiceApiPath,
  memberApiPaths,
  operatorApiPaths,
  serviceApiPaths,
} from '@/lib/public-api';
import { INVITATION_DAYS, invitationLink } from '@/lib/team/service';

// The team routes without a database: every route file is reachable through the proxy and nothing
// else is, and the account rule refuses what it must before any handler runs.
// tests/db/team-*.test.ts drive the same routes against Postgres.

const API_DIR = fileURLToPath(new URL('../../src/app/api', import.meta.url));
const ID = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';

async function routePaths(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routePaths(path)));
    else if (/^route\.tsx?$/.test(entry.name)) found.push(`/api/${relative(API_DIR, dir)}`.replace(/\/$/, ''));
  }
  return found.sort();
}

describe('team routes and the proxy', () => {
  it('lists exactly the route files that check the sign-in (or a service token) themselves', async () => {
    const files = (await routePaths(API_DIR)).filter((path) => !isPublicApiPath(path));
    const patterns = files.map((path) => path.replace(/\[[A-Za-z]+\]/g, ':id'));
    expect([...patterns].sort()).toEqual([...memberApiPaths, ...operatorApiPaths, ...serviceApiPaths].sort());
    // A real path of each route file passes the proxy.
    for (const path of files) {
      const real = path.replace(/\[[A-Za-z]+\]/g, ID);
      expect({ path, passes: isMemberApiPath(real) || isOperatorApiPath(real) || isServiceApiPath(real) }).toEqual({ path, passes: true });
    }
  });

  it('makes the invitation link the company’s own sign-in address, open for 7 days', () => {
    expect(INVITATION_DAYS).toBe(7);
    expect(invitationLink('company-a', ID)).toBe(`/sign-in/company-a/invitations/${ID}`);
  });
});

describe('accountRoute', () => {
  const directory: IdentityDirectory = {
    async companyForTenant(tenant) {
      return tenant === 'tenant-a' ? ID : null;
    },
    async member(companyId) {
      return { company: { id: companyId, name: 'A', status: 'active' }, actor: null, membership: null, flags: [] };
    },
  };
  const verifier = (email: string | null, emailVerified = true): TokenVerifier => ({
    async verify() {
      return { tenant: 'tenant-a', uid: 'u', emailVerified };
    },
    async verifyNotRevoked() {
      return { tenant: 'tenant-a', uid: 'u', emailVerified, authTime: 1, secondFactor: null, email, name: null };
    },
  });
  const signedIn = () => new Request('http://localhost/api/invitations/x', { headers: { Authorization: 'Bearer e30.e30.' } });
  const context = { params: Promise.resolve({}) };

  it('passes an account that is not a member, with its email lowercased', async () => {
    const handler = vi.fn(async () => Response.json({}));
    const route = accountRoute(handler, () => ({ verifier: verifier(' Invitee@Example.TEST '), directory }));
    expect((await route(signedIn(), context)).status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ companyId: ID, email: 'invitee@example.test' }), context);
  });

  it.each([
    ['no token', null, ' x@example.test', true, 401, 'missing_token'],
    ['an unverified email', 'signed', 'x@example.test', false, 403, 'email_unverified'],
    ['no email', 'signed', null, true, 403, 'email_unverified'],
  ])('refuses %s before the handler runs', async (_name, token, email, verified, status, code) => {
    const handler = vi.fn(async () => Response.json({}));
    const route = accountRoute(handler, () => ({ verifier: verifier(email, verified), directory }));
    const response = await route(token ? signedIn() : new Request('http://localhost/api/invitations/x'), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the sign-in check cannot run', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = vi.fn(async () => Response.json({}));
    const broken: TokenVerifier = {
      verify: async () => {
        throw new Error('network');
      },
      verifyNotRevoked: async () => {
        throw new IdentityRefusal('invalid_token');
      },
    };
    const response = await accountRoute(handler, () => ({ verifier: broken, directory }))(signedIn(), context);
    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    logged.mockRestore();
  });
});
