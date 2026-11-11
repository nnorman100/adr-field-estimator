import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S3-10 members: the team list, moving a member between estimator and office, disabling and
// re-enabling, and the platform operator's support actions on the same records, through the real
// route files as the runtime role (see team-invitations.test.ts for the setup).
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/team/services', () => ({ teamServices: () => live.harness!.team }));

const { GET: me } = await import('@/app/api/me/route');
const { GET: team } = await import('@/app/api/companies/[companyId]/team/route');
const { PATCH: changeRole } = await import('@/app/api/companies/[companyId]/members/[membershipId]/route');
const { POST: disable } = await import('@/app/api/companies/[companyId]/members/[membershipId]/disable/route');
const { POST: enable } = await import('@/app/api/companies/[companyId]/members/[membershipId]/enable/route');
const { TeamError } = await import('@/lib/team/service');
const { everything, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
type FakeClaims = import('./team-harness').FakeClaims;

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

const listAs = (claims: FakeClaims, companyId = h.seed.a) =>
  team(request(claims, `/api/companies/${companyId}/team`), params({ companyId }));
const memberRoute = (route: typeof disable, claims: FakeClaims, membershipId: string, body?: unknown, companyId = h.seed.a) =>
  route(
    request(claims, `/api/companies/${companyId}/members/${membershipId}/x`, { method: body === undefined ? 'POST' : 'PATCH', body }),
    params({ companyId, membershipId }),
  );
const roleOf = async (membershipId: string) =>
  (await h.admin<{ role: string; status: string }[]>`SELECT role, status FROM memberships WHERE id = ${membershipId}`)[0];

describe('the team list', () => {
  it('shows the owner every member and invitation of the company only', async () => {
    const response = await listAs(owner());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { view: string; members: { actorId: string; role: string; status: string }[]; invitations: unknown[] };
    expect(body.view).toBe('full');
    expect(body.members.map(({ actorId, role, status }) => ({ actorId, role, status }))).toEqual([
      { actorId: h.seed.ownerA.actor, role: 'owner', status: 'active' },
      { actorId: h.seed.estimatorA.actor, role: 'estimator', status: 'active' },
      { actorId: h.seed.officeA.actor, role: 'office', status: 'active' },
      { actorId: h.seed.disabledA.actor, role: 'estimator', status: 'disabled' },
    ]);
    expect(body.invitations).toEqual([]);
  });

  it('shows an office user only the active estimators', async () => {
    const body = await (await listAs({ tenant: 'tenant-a', uid: 'office-a' })).json();
    expect(body).toEqual({
      view: 'estimators',
      estimators: [
        { membershipId: h.seed.estimatorA.membership, actorId: h.seed.estimatorA.actor, displayName: null, email: 'estimator-a@example.test' },
      ],
    });
  });

  it('refuses an estimator, a disabled member, and anyone naming another company', async () => {
    const estimator = await listAs({ tenant: 'tenant-a', uid: 'estimator-a' });
    expect(estimator.status).toBe(403);
    expect(await estimator.json()).toEqual({ error: 'not_allowed' });
    expect(await (await listAs({ tenant: 'tenant-a', uid: 'disabled-a' })).json()).toEqual({ error: 'member_disabled' });
    // Company B's owner naming company A sees nothing of A; the company comes from the sign-in.
    const named = await listAs(owner('owner-b', 'tenant-b'), h.seed.a);
    expect(named.status).toBe(404);
    expect(await named.json()).toEqual({ error: 'not_found' });
    for (const id of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      expect((await listAs(owner(), id)).status).toBe(404);
    }
    expect((await listAs({ tenant: null, uid: 'nobody' })).status).toBe(403);
  });
});

describe('changing a member', () => {
  it('moves a member between estimator and office, and queues their access record', async () => {
    const moved = await memberRoute(changeRole, owner(), h.seed.estimatorA.membership, { role: 'office' });
    expect(moved.status).toBe(200);
    expect(((await moved.json()) as { member: { role: string } }).member.role).toBe('office');
    expect(await roleOf(h.seed.estimatorA.membership)).toEqual({ role: 'office', status: 'active' });
    expect(await h.admin`SELECT actor_id FROM access_projection_outbox`).toEqual([{ actor_id: h.seed.estimatorA.actor }]);
    // The change was projected after it committed, before the route answered.
    expect(h.projected).toEqual([{ companyId: h.seed.a, actorId: h.seed.estimatorA.actor }]);
    const audit = await h.admin`SELECT actor_id, action, target, details FROM audit_events`;
    expect(audit).toEqual([
      { actor_id: h.seed.ownerA.actor, action: 'member_role_changed', target: h.seed.estimatorA.membership, details: { from: 'estimator', to: 'office' } },
    ]);
    // The new role holds on the member's next request.
    expect(((await (await me(request({ tenant: 'tenant-a', uid: 'estimator-a' }, '/api/me'), params({}))).json()) as { role: string }).role).toBe('office');
    expect((await memberRoute(changeRole, owner(), h.seed.estimatorA.membership, { role: 'estimator' })).status).toBe(200);
    expect(await roleOf(h.seed.estimatorA.membership)).toEqual({ role: 'estimator', status: 'active' });
  });

  it('cannot disable, demote, promote or re-enable the owner', async () => {
    const before = await everything(h.admin);
    for (const [route, body] of [
      [changeRole, { role: 'office' }],
      [changeRole, { role: 'estimator' }],
      [disable, undefined],
      [enable, undefined],
    ] as const) {
      const response = await memberRoute(route, owner(), h.seed.ownerA.membership, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'owner_protected' });
    }
    const promote = await memberRoute(changeRole, owner(), h.seed.estimatorA.membership, { role: 'owner' });
    expect(promote.status).toBe(400);
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
    expect(h.projected).toEqual([]);
  });

  it('disabling revokes the member’s sessions before the call returns, and blocks them at once', async () => {
    // The revocation runs while the change is still uncommitted: the member is active until it is done.
    let seenDuringRevoke: unknown;
    h.onRevoke = async () => {
      seenDuringRevoke = await roleOf(h.seed.estimatorA.membership);
    };
    const response = await memberRoute(disable, owner(), h.seed.estimatorA.membership);
    expect(response.status).toBe(200);
    expect(h.calls).toEqual([{ call: 'revokeSessions', tenant: 'tenant-a', value: 'estimator-a' }]);
    expect(seenDuringRevoke).toEqual({ role: 'estimator', status: 'active' });
    expect(await roleOf(h.seed.estimatorA.membership)).toEqual({ role: 'estimator', status: 'disabled' });
    expect(await (await me(request({ tenant: 'tenant-a', uid: 'estimator-a' }, '/api/me'), params({}))).json()).toEqual({ error: 'member_disabled' });
    expect(await h.admin`SELECT actor_id FROM access_projection_outbox`).toEqual([{ actor_id: h.seed.estimatorA.actor }]);
    expect(h.projected).toEqual([{ companyId: h.seed.a, actorId: h.seed.estimatorA.actor }]);

    // Disabling again changes nothing more.
    expect((await memberRoute(disable, owner(), h.seed.estimatorA.membership)).status).toBe(200);
    expect(await h.admin`SELECT count(*)::int AS n FROM audit_events WHERE action = 'member_disabled'`).toEqual([{ n: 1 }]);

    const back = await memberRoute(enable, owner(), h.seed.estimatorA.membership);
    expect(back.status).toBe(200);
    expect(await roleOf(h.seed.estimatorA.membership)).toEqual({ role: 'estimator', status: 'active' });
    expect((await me(request({ tenant: 'tenant-a', uid: 'estimator-a' }, '/api/me'), params({}))).status).toBe(200);
  });

  it('changes nothing when the sessions cannot be revoked', async () => {
    const before = await everything(h.admin);
    h.failNext.revokeSessions = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await memberRoute(disable, owner(), h.seed.officeA.membership);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'identity_unavailable' });
    expect(await everything(h.admin)).toBe(before);
    vi.restoreAllMocks();
  });

  it('is the owner’s alone, needs a fresh sign-in, and stays inside the owner’s company', async () => {
    const before = await everything(h.admin);
    for (const [route, body] of [[changeRole, { role: 'office' }], [disable, undefined], [enable, undefined]] as const) {
      for (const uid of ['estimator-a', 'office-a']) {
        const response = await memberRoute(route, { tenant: 'tenant-a', uid }, h.seed.disabledA.membership, body);
        expect(await response.json()).toEqual({ error: 'not_allowed' });
      }
      const stale = await memberRoute(route, { ...owner(), signedInAgo: 16 * 60 }, h.seed.disabledA.membership, body);
      expect(await stale.json()).toEqual({ error: 'sign_in_again' });
      // Company B's owner, with A's member, naming either company.
      expect((await memberRoute(route, owner('owner-b', 'tenant-b'), h.seed.disabledA.membership, body)).status).toBe(404);
      expect((await memberRoute(route, owner('owner-b', 'tenant-b'), h.seed.disabledA.membership, body, h.seed.b)).status).toBe(404);
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
  });
});

describe('platform operator support actions', () => {
  const operator = () => ({ kind: 'operator' as const, operatorId: h.seed.operator });

  it('may move a member between roles and re-enable one, each with its own audit row', async () => {
    const now = new Date();
    await h.team.changeRole(h.seed.a, operator(), h.seed.officeA.membership, 'estimator', now);
    await h.team.enable(h.seed.a, operator(), h.seed.disabledA.membership, now);
    const audit = await h.admin`SELECT company_id, actor_id, operator_actor_id, action FROM audit_events ORDER BY id`;
    expect(audit).toEqual([
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'member_role_changed' },
      { company_id: h.seed.a, actor_id: null, operator_actor_id: h.seed.operator, action: 'member_enabled' },
    ]);
  });

  it('may resend or cancel a staff invitation it did not create', async () => {
    const { invitation } = await h.team.invite(h.seed.a, { kind: 'member', actorId: h.seed.ownerA.actor }, { email: 'p@example.test', role: 'office' }, new Date());
    await h.team.resend(h.seed.a, operator(), invitation.id, new Date());
    await h.team.cancel(h.seed.a, operator(), invitation.id, new Date());
    const audit = await h.admin`SELECT operator_actor_id, action FROM audit_events WHERE operator_actor_id IS NOT NULL ORDER BY id`;
    expect(audit.map((row) => row.action)).toEqual(['invitation_resent', 'invitation_cancelled']);
  });

  it('may not invite, clear or disable, and a refusal writes nothing', async () => {
    const before = await everything(h.admin);
    const refusals = [
      h.team.invite(h.seed.a, operator(), { email: 'p@example.test', role: 'office' }, new Date()),
      h.team.clear(h.seed.a, operator(), '00000000-0000-4000-8000-000000000000', new Date()),
      h.team.disable(h.seed.a, operator(), h.seed.estimatorA.membership, new Date()),
    ];
    for (const refusal of refusals) {
      await expect(refusal).rejects.toEqual(new TeamError('support_action_refused'));
    }
    expect(await everything(h.admin)).toBe(before);
    expect(h.calls).toEqual([]);
  });
});
