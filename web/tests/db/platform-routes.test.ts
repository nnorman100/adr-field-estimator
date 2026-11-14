import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S3-9: the platform operator routes, through the real route files as the runtime role on a server
// set up like a fresh Cloud SQL instance (see team-harness.ts). Tokens and the tenant's accounts are
// fakes; the operator is found by the real platform_operator lookup of migration 0006.
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

const API_DIR = fileURLToPath(new URL('../../src/app/api', import.meta.url));
const PLATFORM_DIR = join(API_DIR, 'platform');
const METHODS = ['GET', 'POST', 'PATCH', 'PUT'] as const;
type RouteHandler = (request: Request, context: ReturnType<typeof params>) => Response | Promise<Response>;

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (entry.name === 'route.ts') found.push(path);
  }
  return found.sort();
}

// Every handler of every route file under api/platform, found by searching, with a real path.
async function platformHandlers(): Promise<{ name: string; method: string; handler: RouteHandler; path: string; ids: Record<string, string> }[]> {
  const all = [];
  for (const file of await routeFiles(PLATFORM_DIR)) {
    const dir = relative(API_DIR, join(file, '..'));
    const mod = (await import(file)) as Record<string, unknown>;
    const ids: Record<string, string> = {};
    const path = `/api/${dir}`.replace(/\[([A-Za-z]+)\]/g, (_m, name: string) => {
      ids[name] = name === 'companyId' ? h.seed.a : name === 'membershipId' ? h.seed.estimatorA.membership : '00000000-0000-4000-8000-000000000000';
      return ids[name]!;
    });
    for (const method of METHODS) {
      if (typeof mod[method] === 'function') all.push({ name: `${method} ${dir}`, method, handler: mod[method] as RouteHandler, path, ids });
    }
  }
  return all;
}

const { GET: companiesGet, POST: companiesPost } = await import('@/app/api/platform/companies/route');
const { POST: status } = await import('@/app/api/platform/companies/[companyId]/status/route');
const { POST: tenant } = await import('@/app/api/platform/companies/[companyId]/tenant/route');
const { POST: ownerRoute } = await import('@/app/api/platform/companies/[companyId]/owner/route');
const { GET: supportTeam } = await import('@/app/api/platform/companies/[companyId]/team/route');
const { POST: reset } = await import('@/app/api/platform/companies/[companyId]/members/[membershipId]/reset-second-step/route');
const { PATCH: changeRole } = await import('@/app/api/platform/companies/[companyId]/members/[membershipId]/route');
const { POST: enable } = await import('@/app/api/platform/companies/[companyId]/members/[membershipId]/enable/route');
const { POST: resend } = await import('@/app/api/platform/companies/[companyId]/invitations/[invitationId]/resend/route');
const { POST: cancel } = await import('@/app/api/platform/companies/[companyId]/invitations/[invitationId]/cancel/route');
const { GET: me } = await import('@/app/api/me/route');
const { POST: accept } = await import('@/app/api/invitations/[invitationId]/accept/route');

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const call = (
  route: RouteHandler,
  claims: FakeClaims | null,
  ids: Record<string, string> = {},
  init: { method?: string; body?: unknown } = {},
) => route(request(claims, '/api/platform/x', { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'), body: init.body }), params(ids));

const auditRows = () =>
  h.admin<{ company_id: string | null; actor_id: string | null; operator_actor_id: string | null; action: string; target: string; details: unknown }[]>`
    SELECT company_id, actor_id, operator_actor_id, action, target, details FROM audit_events ORDER BY id
  `;
const companyRow = async (id: string) =>
  (await h.admin<{ status: string; auth_tenant_id: string | null }[]>`SELECT status, auth_tenant_id FROM companies WHERE id = ${id}`)[0];

// A new company with no tenant yet, made as the operator.
async function newCompany(slug = 'company-new'): Promise<string> {
  const response = await call(companiesPost, operatorClaims(), {}, { body: { name: 'New Co', signInSlug: slug } });
  expect(response.status).toBe(201);
  return ((await response.json()) as { company: { id: string } }).company.id;
}

describe('who may use the operator routes', () => {
  it('finds every operator route file and each is an operator route', async () => {
    const handlers = await platformHandlers();
    expect(handlers.map((found) => found.name).sort()).toEqual([
      'GET platform/companies',
      'GET platform/companies/[companyId]/prices',
      'GET platform/companies/[companyId]/team',
      'PATCH platform/companies/[companyId]/members/[membershipId]',
      'POST platform/companies',
      'POST platform/companies/[companyId]/flags',
      'POST platform/companies/[companyId]/invitations/[invitationId]/cancel',
      'POST platform/companies/[companyId]/invitations/[invitationId]/resend',
      'POST platform/companies/[companyId]/members/[membershipId]/enable',
      'POST platform/companies/[companyId]/members/[membershipId]/reset-second-step',
      'POST platform/companies/[companyId]/owner',
      'POST platform/companies/[companyId]/status',
      'POST platform/companies/[companyId]/tenant',
      'PUT platform/companies/[companyId]/ai-settings',
    ]);
  });

  it('refuses an owner, an estimator and an office user on every operator route, writing nothing', async () => {
    const before = await everything(h.admin);
    const handlers = await platformHandlers();
    const bodies: Record<string, unknown> = {
      POST: { status: 'suspended', tenantId: 'x', email: 'x@example.test', name: 'X', signInSlug: 'x', confirmedBy: 'phone' },
      PATCH: { role: 'office' },
      PUT: { dailyCeilingMicroUsd: 1, monthlyCeilingMicroUsd: 1 },
    };
    for (const caller of [owner(), { tenant: 'tenant-a', uid: 'estimator-a' }, { tenant: 'tenant-a', uid: 'office-a' }, owner('owner-b', 'tenant-b')]) {
      for (const { name, method, handler, ids } of handlers) {
        const response = await call(handler, caller, ids, { method, body: method === 'GET' ? undefined : bodies[method] });
        expect({ name, caller: caller.uid, status: response.status, body: await response.json() }).toEqual({
          name,
          caller: caller.uid,
          status: 403,
          body: { error: 'not_an_operator' },
        });
      }
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
    expect(h.projected).toEqual([]);
  });

  it('refuses no sign-in, an unknown operator, a disabled one, no second step and an old sign-in', async () => {
    const [disabled] = await h.admin<{ id: string }[]>`
      INSERT INTO actors (company_id, auth_tenant_id, uid, email) VALUES (NULL, 'operators', 'operator-2', 'operator-2@example.test') RETURNING id
    `;
    await h.admin`INSERT INTO platform_admins (actor_id, status) VALUES (${disabled!.id}, 'disabled')`;
    const before = await everything(h.admin);
    const cases: [FakeClaims | null, number, string][] = [
      [null, 401, 'missing_token'],
      [{ tenant: null, uid: 'operator-1' }, 403, 'not_an_operator'],
      [operatorClaims({ uid: 'someone-else' }), 403, 'not_an_operator'],
      [operatorClaims({ uid: 'operator-2' }), 403, 'not_an_operator'],
      // The operator's uid in a company tenant is another person.
      [{ tenant: 'tenant-a', uid: 'operator-1' }, 403, 'not_an_operator'],
      [operatorClaims({ secondFactor: null }), 403, 'second_step_required'],
      [operatorClaims({ secondFactor: 'phone' }), 403, 'second_step_required'],
      [operatorClaims({ signedInAgo: 12 * 60 * 60 + 60 }), 401, 'sign_in_again'],
      [operatorClaims({ revoked: true }), 401, 'sign_in_revoked'],
      [operatorClaims({ verified: false }), 403, 'email_unverified'],
    ];
    for (const [claims, code, error] of cases) {
      const response = await call(companiesGet, claims);
      expect({ claims, status: response.status, body: await response.json() }).toEqual({ claims, status: code, body: { error } });
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('needs a sign-in under 15 minutes old for team and second-step changes', async () => {
    const stale = operatorClaims({ signedInAgo: 16 * 60 });
    const before = await everything(h.admin);
    const ids = { companyId: h.seed.a, membershipId: h.seed.estimatorA.membership, invitationId: '00000000-0000-4000-8000-000000000000' };
    for (const [route, body] of [
      [ownerRoute, { email: 'new@example.test', replace: true }],
      [reset, { confirmedBy: 'phone' }],
      [enable, {}],
      [resend, {}],
      [cancel, {}],
    ] as const) {
      expect(await (await call(route, stale, ids, { body })).json()).toEqual({ error: 'sign_in_again' });
    }
    expect(await (await call(changeRole, stale, ids, { method: 'PATCH', body: { role: 'office' } })).json()).toEqual({ error: 'sign_in_again' });
    expect(await everything(h.admin)).toBe(before);
    // A company list or status change needs only the operator's 12-hour sign-in.
    expect((await call(companiesGet, stale)).status).toBe(200);
  });
});

describe('companies', () => {
  it('lists every company, read-only, with no audit row', async () => {
    const response = await call(companiesGet, operatorClaims());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { companies: { id: string; status: string; tenantBound: boolean }[] };
    expect(body.companies.map(({ id, status, tenantBound }) => ({ id, status, tenantBound }))).toEqual([
      { id: h.seed.a, status: 'active', tenantBound: true },
      { id: h.seed.b, status: 'active', tenantBound: true },
      { id: h.seed.suspended, status: 'suspended', tenantBound: true },
    ]);
    expect(await auditRows()).toEqual([]);
  });

  it('creates a company with exactly one audit row, and refuses a taken sign-in address writing nothing', async () => {
    const id = await newCompany();
    expect(await auditRows()).toEqual([
      { company_id: id, actor_id: null, operator_actor_id: h.seed.operator, action: 'company_created', target: id, details: {} },
    ]);
    expect(await h.admin`SELECT name, sign_in_slug, status, auth_tenant_id FROM companies WHERE id = ${id}`).toEqual([
      { name: 'New Co', sign_in_slug: 'company-new', status: 'active', auth_tenant_id: null },
    ]);
    const before = await everything(h.admin);
    const taken = await call(companiesPost, operatorClaims(), {}, { body: { name: 'Other', signInSlug: 'company-a' } });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: 'sign_in_address_taken' });
    for (const body of [{ name: ' ', signInSlug: 'ok' }, { name: 'X', signInSlug: 'Bad_Slug' }, { name: 'X', signInSlug: 'ok', status: 'archived' }, 'not json']) {
      expect((await call(companiesPost, operatorClaims(), {}, { body })).status).toBe(400);
    }
    expect(await everything(h.admin)).toBe(before);
  });

  it('suspends, archives and reactivates, with one audit row each, and every member’s access follows', async () => {
    const steps: [string, string][] = [['suspended', 'company_suspended'], ['archived', 'company_archived'], ['active', 'company_reactivated']];
    for (const [to, action] of steps) {
      h.projected = [];
      const response = await call(status, operatorClaims(), { companyId: h.seed.a }, { body: { status: to } });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { company: { status: string } }).company.status).toBe(to);
      expect((await companyRow(h.seed.a))!.status).toBe(to);
      expect((await auditRows()).at(-1)).toMatchObject({ company_id: h.seed.a, operator_actor_id: h.seed.operator, action, target: h.seed.a });
      // Every actor of the company is projected after the change commits.
      expect(h.projected.map((row) => row.actorId).sort()).toEqual(
        [h.seed.ownerA.actor, h.seed.estimatorA.actor, h.seed.officeA.actor, h.seed.disabledA.actor].sort(),
      );
      if (to !== 'active') {
        expect(await (await me(request(owner(), '/api/me'), params({}))).json()).toEqual({ error: 'company_inactive' });
      }
    }
    expect(await auditRows()).toHaveLength(3);
    expect((await me(request(owner(), '/api/me'), params({}))).status).toBe(200);
    // Setting the status it already has changes nothing.
    const before = await everything(h.admin);
    expect((await call(status, operatorClaims(), { companyId: h.seed.a }, { body: { status: 'active' } })).status).toBe(200);
    expect(await everything(h.admin)).toBe(before);
  });

  it('still lists and shows a company after it is archived, with its status', async () => {
    const archived = await call(status, operatorClaims(), { companyId: h.seed.suspended }, { body: { status: 'archived' } });
    expect(archived.status).toBe(200);
    const listed = (await (await call(companiesGet, operatorClaims())).json()) as { companies: { id: string; status: string }[] };
    expect(listed.companies.find((company) => company.id === h.seed.suspended)).toMatchObject({ status: 'archived' });
    const viewed = await call(supportTeam, operatorClaims(), { companyId: h.seed.suspended });
    expect(viewed.status).toBe(200);
    const body = (await viewed.json()) as { company: { id: string; status: string }; team: { view: string } };
    expect(body.company).toMatchObject({ id: h.seed.suspended, status: 'archived' });
    expect(body.team.view).toBe('full');
  });

  it('refuses to archive an active company, and an unknown one, writing nothing', async () => {
    const before = await everything(h.admin);
    const refused = await call(status, operatorClaims(), { companyId: h.seed.a }, { body: { status: 'archived' } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'suspend_first' });
    for (const companyId of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect((await call(status, operatorClaims(), { companyId }, { body: { status: 'suspended' } })).status).toBe(404);
    }
    expect((await call(status, operatorClaims(), { companyId: h.seed.a }, { body: { status: 'closed' } })).status).toBe(400);
    expect(await everything(h.admin)).toBe(before);
    expect(h.projected).toEqual([]);
  });

  it('binds a new company to its tenant once, and refuses a tenant in use', async () => {
    const id = await newCompany();
    const bound = await call(tenant, operatorClaims(), { companyId: id }, { body: { tenantId: 'tenant-new' } });
    expect(bound.status).toBe(200);
    expect(((await bound.json()) as { company: { tenantBound: boolean } }).company.tenantBound).toBe(true);
    expect(await companyRow(id)).toEqual({ status: 'active', auth_tenant_id: 'tenant-new' });
    expect(await h.admin`SELECT kind FROM auth_tenants WHERE id = 'tenant-new'`).toEqual([{ kind: 'company' }]);
    expect((await auditRows()).map((row) => row.action)).toEqual(['company_created', 'company_tenant_bound']);

    const before = await everything(h.admin);
    // The same tenant again changes nothing; another tenant, another company's, or the operator
    // tenant is refused.
    expect((await call(tenant, operatorClaims(), { companyId: id }, { body: { tenantId: 'tenant-new' } })).status).toBe(200);
    expect(await (await call(tenant, operatorClaims(), { companyId: id }, { body: { tenantId: 'tenant-other' } })).json()).toEqual({ error: 'tenant_already_bound' });
    const other = await newCompany('company-other');
    const afterOther = await everything(h.admin);
    for (const tenantId of ['tenant-a', 'operators']) {
      expect(await (await call(tenant, operatorClaims(), { companyId: other }, { body: { tenantId } })).json()).toEqual({ error: 'tenant_in_use' });
    }
    expect((await call(tenant, operatorClaims(), { companyId: other }, { body: { tenantId: 'has spaces' } })).status).toBe(400);
    expect(await everything(h.admin)).toBe(afterOther);
    expect(before).not.toBe(afterOther);
  });
});

describe('the owner', () => {
  it('invites the first owner by link, who accepts and becomes the owner', async () => {
    const id = await newCompany();
    await call(tenant, operatorClaims(), { companyId: id }, { body: { tenantId: 'tenant-new' } });
    const response = await call(ownerRoute, operatorClaims(), { companyId: id }, { body: { email: ' Boss@Example.TEST ' } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { invitation: { id: string; role: string }; delivery: string; link: string; replacedMembershipId: null };
    expect(body).toMatchObject({ delivery: 'copy_link', link: `/sign-in/company-new/invitations/${body.invitation.id}`, replacedMembershipId: null });
    expect(body.invitation.role).toBe('owner');
    expect(h.calls).toEqual([{ call: 'ensureAccount', tenant: 'tenant-new', value: 'boss@example.test' }]);
    expect((await auditRows()).at(-1)).toMatchObject({ company_id: id, operator_actor_id: h.seed.operator, action: 'owner_invited', target: body.invitation.id });
    expect(await auditRows()).toHaveLength(3);

    const accepted = await accept(
      request({ tenant: 'tenant-new', uid: 'boss', email: 'boss@example.test' }, `/api/invitations/${body.invitation.id}/accept`, { method: 'POST' }),
      params({ invitationId: body.invitation.id }),
    );
    expect(accepted.status).toBe(201);
    expect(((await (await me(request({ tenant: 'tenant-new', uid: 'boss' }, '/api/me'), params({}))).json()) as { role: string }).role).toBe('owner');
  });

  it('refuses to invite a second owner without replace, an unready company, and a member’s email, writing nothing', async () => {
    const unready = await newCompany();
    const before = await everything(h.admin);
    const cases: [string, unknown, number, string][] = [
      [h.seed.a, { email: 'new@example.test' }, 409, 'owner_exists'],
      [unready, { email: 'new@example.test' }, 409, 'company_not_ready'],
      [h.seed.a, { email: 'estimator-a@example.test', replace: true }, 409, 'already_member'],
      ['00000000-0000-4000-8000-000000000000', { email: 'new@example.test' }, 404, 'not_found'],
      [h.seed.a, { email: 'not an email' }, 400, 'invalid_request'],
    ];
    for (const [companyId, body, code, error] of cases) {
      const response = await call(ownerRoute, operatorClaims(), { companyId }, { body });
      expect({ companyId, status: response.status, body: await response.json() }).toEqual({ companyId, status: code, body: { error } });
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
  });

  it('replacing the owner disables the old owner and revokes their sessions before answering', async () => {
    let seenDuringRevoke: unknown;
    h.onRevoke = async () => {
      seenDuringRevoke = (await h.admin`SELECT status FROM memberships WHERE id = ${h.seed.ownerA.membership}`)[0];
    };
    const response = await call(ownerRoute, operatorClaims(), { companyId: h.seed.a }, { body: { email: 'new-owner@example.test', replace: true } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { invitation: { id: string }; replacedMembershipId: string };
    expect(body.replacedMembershipId).toBe(h.seed.ownerA.membership);
    // The revocation ran before the change committed, and before the answer.
    expect(seenDuringRevoke).toEqual({ status: 'active' });
    expect(h.calls).toEqual([
      { call: 'ensureAccount', tenant: 'tenant-a', value: 'new-owner@example.test' },
      { call: 'revokeSessions', tenant: 'tenant-a', value: 'owner-a' },
    ]);
    expect(await h.admin`SELECT status FROM memberships WHERE id = ${h.seed.ownerA.membership}`).toEqual([{ status: 'disabled' }]);
    expect(await (await me(request(owner(), '/api/me'), params({}))).json()).toEqual({ error: 'member_disabled' });
    expect(h.projected).toEqual([{ companyId: h.seed.a, actorId: h.seed.ownerA.actor }]);
    expect(await auditRows()).toEqual([
      {
        company_id: h.seed.a,
        actor_id: null,
        operator_actor_id: h.seed.operator,
        action: 'owner_replaced',
        target: body.invitation.id,
        details: { cancelledInvitations: 0, replacedMembershipId: h.seed.ownerA.membership },
      },
    ]);
    // The new owner can accept: the old owner no longer holds the one active owner place.
    const accepted = await accept(
      request({ tenant: 'tenant-a', uid: 'new-owner', email: 'new-owner@example.test' }, '/x', { method: 'POST' }),
      params({ invitationId: body.invitation.id }),
    );
    expect(accepted.status).toBe(201);
    // Replacing again cancels nothing it should not: there is an owner, so plain invite is refused.
    expect(await (await call(ownerRoute, operatorClaims(), { companyId: h.seed.a }, { body: { email: 'x@example.test' } })).json()).toEqual({ error: 'owner_exists' });
  });

  it('refuses cancelling the owner invitation of a company with no active owner, writing nothing', async () => {
    const replaced = await call(ownerRoute, operatorClaims(), { companyId: h.seed.a }, { body: { email: 'new-owner@example.test', replace: true } });
    expect(replaced.status).toBe(201);
    const { invitation } = (await replaced.json()) as { invitation: { id: string } };
    const before = await everything(h.admin);
    const refused = await call(cancel, operatorClaims(), { companyId: h.seed.a, invitationId: invitation.id }, { body: {} });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'owner_invitation_required' });
    expect(await everything(h.admin)).toBe(before);
    expect(await h.admin`SELECT status FROM invitations WHERE id = ${invitation.id}`).toEqual([{ status: 'pending' }]);
  });

  it('cancels an older pending owner invitation, and changes nothing when the old owner cannot be signed out', async () => {
    const company = h.seed.b;
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.ownerB.membership}`;
    const first = (await (await call(ownerRoute, operatorClaims(), { companyId: company }, { body: { email: 'one@example.test' } })).json()) as { invitation: { id: string } };
    const second = await call(ownerRoute, operatorClaims(), { companyId: company }, { body: { email: 'two@example.test' } });
    expect(second.status).toBe(201);
    expect(await h.admin`SELECT status FROM invitations WHERE id = ${first.invitation.id}`).toEqual([{ status: 'cancelled' }]);
    expect((await auditRows()).at(-1)!.details).toEqual({ cancelledInvitations: 1 });

    const before = await everything(h.admin);
    h.failNext.revokeSessions = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await call(ownerRoute, operatorClaims(), { companyId: h.seed.a }, { body: { email: 'new@example.test', replace: true } });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'identity_unavailable' });
    expect(await everything(h.admin)).toBe(before);
    vi.restoreAllMocks();
  });
});

describe('second step reset (D9)', () => {
  it('resets the member’s second step and signs them out, with one audit row', async () => {
    const response = await call(reset, operatorClaims(), { companyId: h.seed.a, membershipId: h.seed.ownerA.membership }, { body: { confirmedBy: 'phone' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reset: true, email: 'not_sent', tellByPhone: true });
    expect(h.calls).toEqual([{ call: 'resetSecondStep', tenant: 'tenant-a', value: 'owner-a' }]);
    expect(await auditRows()).toEqual([
      {
        company_id: h.seed.a,
        actor_id: null,
        operator_actor_id: h.seed.operator,
        action: 'second_step_reset',
        target: h.seed.ownerA.membership,
        details: { role: 'owner', confirmedBy: 'phone' },
      },
    ]);
  });

  it('needs the phone check stated, a member of that company, and writes nothing when the reset fails', async () => {
    const before = await everything(h.admin);
    const ids = { companyId: h.seed.a, membershipId: h.seed.ownerA.membership };
    for (const body of [{}, { confirmedBy: 'email' }]) {
      expect((await call(reset, operatorClaims(), ids, { body })).status).toBe(400);
    }
    // Company B's owner named under company A is not found.
    const other = await call(reset, operatorClaims(), { companyId: h.seed.a, membershipId: h.seed.ownerB.membership }, { body: { confirmedBy: 'phone' } });
    expect(other.status).toBe(404);
    h.failNext.resetSecondStep = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await call(reset, operatorClaims(), ids, { body: { confirmedBy: 'phone' } })).status).toBe(503);
    vi.restoreAllMocks();
    expect(await everything(h.admin)).toBe(before);
  });
});

describe('support view and support actions', () => {
  it('shows a company’s team read-only and writes one audit row per view', async () => {
    const response = await call(supportTeam, operatorClaims(), { companyId: h.seed.b });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { company: { id: string }; team: { view: string; members: { actorId: string }[] } };
    expect(body.company.id).toBe(h.seed.b);
    expect(body.team.view).toBe('full');
    expect(body.team.members.map((m) => m.actorId)).toEqual([h.seed.ownerB.actor, h.seed.estimatorB.actor]);
    expect(await auditRows()).toEqual([
      { company_id: h.seed.b, actor_id: null, operator_actor_id: h.seed.operator, action: 'support_team_viewed', target: h.seed.b, details: {} },
    ]);
    // A suspended company can be viewed too; an unknown one is not found and writes nothing.
    expect((await call(supportTeam, operatorClaims(), { companyId: h.seed.suspended })).status).toBe(200);
    const before = await everything(h.admin);
    expect((await call(supportTeam, operatorClaims(), { companyId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect(await everything(h.admin)).toBe(before);
  });

  it('switches a member’s role, re-enables one, and resends and cancels an invitation, one audit row each', async () => {
    const { invitation } = await h.team.invite(h.seed.a, { kind: 'member', actorId: h.seed.ownerA.actor }, { email: 'p@example.test', role: 'office' }, new Date());
    const start = (await auditRows()).length;
    const ids = { companyId: h.seed.a, membershipId: h.seed.officeA.membership, invitationId: invitation.id };
    expect((await call(changeRole, operatorClaims(), ids, { method: 'PATCH', body: { role: 'estimator' } })).status).toBe(200);
    expect((await call(enable, operatorClaims(), { ...ids, membershipId: h.seed.disabledA.membership }, { body: {} })).status).toBe(200);
    expect((await call(resend, operatorClaims(), ids, { body: {} })).status).toBe(200);
    expect((await call(cancel, operatorClaims(), ids, { body: {} })).status).toBe(200);
    const rows = (await auditRows()).slice(start);
    expect(rows.map(({ operator_actor_id, action }) => ({ operator_actor_id, action }))).toEqual([
      { operator_actor_id: h.seed.operator, action: 'member_role_changed' },
      { operator_actor_id: h.seed.operator, action: 'member_enabled' },
      { operator_actor_id: h.seed.operator, action: 'invitation_resent' },
      { operator_actor_id: h.seed.operator, action: 'invitation_cancelled' },
    ]);
    // The owner stays protected from support actions too.
    const before = await everything(h.admin);
    const protectedOwner = await call(changeRole, operatorClaims(), { ...ids, membershipId: h.seed.ownerA.membership }, { method: 'PATCH', body: { role: 'office' } });
    expect(await protectedOwner.json()).toEqual({ error: 'owner_protected' });
    expect(await everything(h.admin)).toBe(before);
  });

  it('refuses an operator disabled after signing in, writing nothing', async () => {
    // The sign-in check finds an active operator, who is then disabled before the action's
    // transaction opens; that transaction refuses (app_operator_active is false).
    h.operators = {
      verifier: h.operators.verifier,
      operators: {
        async operatorFor() {
          await h.admin`UPDATE platform_admins SET status = 'disabled' WHERE actor_id = ${h.seed.operator}`;
          return h.seed.operator;
        },
      },
    };
    const response = await call(companiesPost, operatorClaims(), {}, { body: { name: 'X', signInSlug: 'x' } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'not_an_operator' });
    expect(await auditRows()).toEqual([]);
    expect(await h.admin`SELECT count(*)::int AS n FROM companies`).toEqual([{ n: 3 }]);
  });
});
