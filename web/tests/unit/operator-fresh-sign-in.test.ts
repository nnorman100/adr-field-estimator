import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorDirectory, TokenVerifier } from '@/lib/auth/identity';

// Which operator routes need a sign-in under 15 minutes old (owner decision D7). D7 asked for it on
// team and second-step changes; on 2026-11-14 the owner extended it to company status, tenant
// binding, feature switches and AI limits (sign-in security review, finding F8). Every route file
// under api/platform is called with a sign-in 16 minutes old, so a new or changed route is caught
// here; the handlers are stand-ins, so this proves only the rule each route declares.
// tests/db/platform-routes.test.ts drives the same refusals through the real handlers.

const ran = vi.hoisted(() => ({ calls: [] as string[] }));

// A stand-in for a handler, or for a factory that returns one (supportInvitationAction).
const standIn = vi.hoisted(
  () =>
    (name: string) =>
    (...args: unknown[]): unknown => {
      if (args[0] instanceof Request) {
        ran.calls.push(name);
        return Response.json({ ran: name });
      }
      return async () => {
        ran.calls.push(`${name}:${String(args[0])}`);
        return Response.json({ ran: name });
      };
    },
);

vi.mock('@/lib/platform', () => ({
  bindCompanyTenant: standIn('bindCompanyTenant'),
  createCompany: standIn('createCompany'),
  listCompanies: standIn('listCompanies'),
  inviteOwner: standIn('inviteOwner'),
  resetSecondStep: standIn('resetSecondStep'),
  setCompanyFlag: standIn('setCompanyFlag'),
  setCompanyStatus: standIn('setCompanyStatus'),
  supportChangeRole: standIn('supportChangeRole'),
  supportEnableMember: standIn('supportEnableMember'),
  supportInvitationAction: standIn('supportInvitationAction'),
  supportHead: standIn('supportHead'),
  supportJob: standIn('supportJob'),
  supportJobs: standIn('supportJobs'),
  supportPhoto: standIn('supportPhoto'),
  supportPrices: standIn('supportPrices'),
  supportTeam: standIn('supportTeam'),
}));
vi.mock('@/lib/ai/http', () => ({ setAiSettings: standIn('setAiSettings') }));
vi.mock('@/lib/records-check/http', () => ({ recordsCheck: standIn('recordsCheck') }));

const session = vi.hoisted(() => ({ signedInAgo: 60 }));
const OPERATOR = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
vi.mock('@/lib/auth/services', () => {
  const verifier: TokenVerifier = {
    async verify() {
      return { tenant: 'operators', uid: 'op', emailVerified: true };
    },
    async verifyNotRevoked(_token, tenant) {
      return { tenant, uid: 'op', emailVerified: true, authTime: Math.floor(Date.now() / 1000) - session.signedInAgo, secondFactor: 'totp' };
    },
  };
  const operators: OperatorDirectory = {
    async operatorFor(tenant, uid) {
      return tenant === 'operators' && uid === 'op' ? OPERATOR : null;
    },
  };
  return {
    operatorServices: () => ({ verifier, operators }),
    identityServices: () => {
      throw new Error('not used by operator routes');
    },
  };
});

const API_DIR = fileURLToPath(new URL('../../src/app/api', import.meta.url));
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (/^route\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

// Every operator handler, named "METHOD platform/...".
async function operatorHandlers(): Promise<[string, Handler][]> {
  const all: [string, Handler][] = [];
  for (const file of await routeFiles(join(API_DIR, 'platform'))) {
    const mod = (await import(file)) as Record<string, unknown>;
    const dir = relative(API_DIR, join(file, '..'));
    for (const method of METHODS) {
      if (typeof mod[method] === 'function') all.push([`${method} ${dir}`, mod[method] as Handler]);
    }
  }
  return all;
}

const call = (handler: Handler) =>
  handler(new Request('http://localhost/api/platform/x', { method: 'POST', headers: { Authorization: 'Bearer e30.e30.' } }), {
    params: Promise.resolve({}),
  });

// The routes that change something a company's people rely on, and the records check, which reads
// across a company's stores (S8-3 asks for a fresh sign-in). The other reads and creating a new,
// empty company keep the operator's 12-hour sign-in.
const FRESH_SIGN_IN_ROUTES = [
  // Team and second-step changes (D7 as decided 2026-11-10).
  'POST platform/companies/[companyId]/invitations/[invitationId]/cancel',
  'POST platform/companies/[companyId]/invitations/[invitationId]/resend',
  'POST platform/companies/[companyId]/members/[membershipId]/enable',
  'POST platform/companies/[companyId]/members/[membershipId]/reset-second-step',
  'PATCH platform/companies/[companyId]/members/[membershipId]',
  'POST platform/companies/[companyId]/owner',
  // Added 2026-11-14 (finding F8): company status, tenant binding, feature switches, AI limits.
  'POST platform/companies/[companyId]/status',
  'POST platform/companies/[companyId]/tenant',
  'POST platform/companies/[companyId]/flags',
  'PUT platform/companies/[companyId]/ai-settings',
  // S8-3: the records check after a restore.
  'POST platform/companies/[companyId]/records-check',
].sort();

beforeEach(() => {
  ran.calls.length = 0;
  session.signedInAgo = 60;
});

describe('operator routes that need a fresh sign-in', () => {
  it('are exactly the team, second-step, company status, tenant, feature and AI limit changes and the records check', async () => {
    session.signedInAgo = 16 * 60;
    const refused: string[] = [];
    for (const [name, handler] of await operatorHandlers()) {
      const response = await call(handler);
      if (response.status === 401) {
        expect({ name, body: await response.json() }).toEqual({ name, body: { error: 'sign_in_again' } });
        refused.push(name);
      } else {
        expect({ name, status: response.status }).toEqual({ name, status: 200 });
      }
    }
    expect(refused.sort()).toEqual(FRESH_SIGN_IN_ROUTES);
  });

  it.each([
    ['company status', '@/app/api/platform/companies/[companyId]/status/route', 'POST', 'setCompanyStatus'],
    ['tenant binding', '@/app/api/platform/companies/[companyId]/tenant/route', 'POST', 'bindCompanyTenant'],
    ['a feature switch', '@/app/api/platform/companies/[companyId]/flags/route', 'POST', 'setCompanyFlag'],
    ['AI limits', '@/app/api/platform/companies/[companyId]/ai-settings/route', 'PUT', 'setAiSettings'],
  ] as const)('refuses a change of %s with a sign-in older than 15 minutes, before the handler runs', async (_what, path, method, handler) => {
    const route = (await import(path)) as Record<string, Handler>;
    session.signedInAgo = 15 * 60 + 1;
    const stale = await call(route[method]!);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'sign_in_again' });
    expect(ran.calls).toEqual([]);
    session.signedInAgo = 15 * 60;
    expect((await call(route[method]!)).status).toBe(200);
    expect(ran.calls).toEqual([handler]);
  });

  it('still lets an operator signed in hours ago read the companies list', async () => {
    const { GET } = (await import('@/app/api/platform/companies/route')) as unknown as Record<string, Handler>;
    session.signedInAgo = 11 * 60 * 60;
    expect((await call(GET!)).status).toBe(200);
    expect(ran.calls).toEqual(['listCompanies']);
  });
});
