import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@/db/client';
import { teamService } from '@/lib/team/service';
import type { Harness } from './team-harness';

// S3-10 invitations: invite, resend, cancel, clear, read and accept, through the real route files
// with their access rules, as the runtime role. The services the routes build for themselves are
// replaced by the harness's database and fakes.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/team/services', () => ({ teamServices: () => live.harness!.team }));

const { GET: me } = await import('@/app/api/me/route');
const { POST: invite } = await import('@/app/api/companies/[companyId]/invitations/route');
const { POST: resend } = await import('@/app/api/companies/[companyId]/invitations/[invitationId]/resend/route');
const { POST: cancel } = await import('@/app/api/companies/[companyId]/invitations/[invitationId]/cancel/route');
const { POST: clear } = await import('@/app/api/companies/[companyId]/invitations/[invitationId]/clear/route');
const { GET: team } = await import('@/app/api/companies/[companyId]/team/route');
const { GET: readInvitation } = await import('@/app/api/invitations/[invitationId]/route');
const { POST: accept } = await import('@/app/api/invitations/[invitationId]/accept/route');
const { everything, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
type FakeClaims = import('./team-harness').FakeClaims;

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const invitee = (email = 'new.person@example.test', uid = 'new-person'): FakeClaims => ({ tenant: 'tenant-a', uid, email });

async function invited(email = 'new.person@example.test', role = 'estimator') {
  const response = await invite(
    request(owner(), `/api/companies/${h.seed.a}/invitations`, { method: 'POST', body: { email, role } }),
    params({ companyId: h.seed.a }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { invitation: { id: string; expiresAt: string; status: string }; link: string; delivery: string };
}

const acceptAs = (claims: FakeClaims, id: string) =>
  accept(request(claims, `/api/invitations/${id}/accept`, { method: 'POST' }), params({ invitationId: id }));
const readAs = (claims: FakeClaims, id: string) =>
  readInvitation(request(claims, `/api/invitations/${id}`), params({ invitationId: id }));
const invitationRoute = (route: typeof resend, claims: FakeClaims, id: string, companyId = h.seed.a) =>
  route(request(claims, `/api/companies/${companyId}/invitations/${id}/x`, { method: 'POST' }), params({ companyId, invitationId: id }));

describe('inviting', () => {
  it('gives the owner a link to copy, open for 7 days, with no email service set up', async () => {
    const before = Date.now();
    const body = await invited('  New.Person@Example.TEST ');
    expect(body.delivery).toBe('copy_link');
    expect(body.link).toBe(`/sign-in/company-a/invitations/${body.invitation.id}`);
    expect(body.invitation.status).toBe('pending');
    const expires = Date.parse(body.invitation.expiresAt);
    expect(expires).toBeGreaterThanOrEqual(before + 7 * DAY_MS);
    expect(expires).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS);

    const [row] = await h.admin`SELECT email, role, status, created_by_actor_id FROM invitations`;
    expect(row).toEqual({ email: 'new.person@example.test', role: 'estimator', status: 'pending', created_by_actor_id: h.seed.ownerA.actor });
    // The invitee gets a sign-in account in the company's own tenant, with no password (D11).
    expect(h.calls).toEqual([{ call: 'ensureAccount', tenant: 'tenant-a', value: 'new.person@example.test' }]);
    const audit = await h.admin`SELECT company_id, actor_id, action, target, details FROM audit_events`;
    expect(audit).toEqual([
      { company_id: h.seed.a, actor_id: h.seed.ownerA.actor, action: 'invitation_created', target: body.invitation.id, details: { role: 'estimator' } },
    ]);
    // The audit row never holds the email.
    expect(JSON.stringify(audit)).not.toContain('example.test');
  });

  it('refuses an owner role, a bad email, a second open invitation and an existing member', async () => {
    const post = (body: unknown) =>
      invite(request(owner(), `/api/companies/${h.seed.a}/invitations`, { method: 'POST', body }), params({ companyId: h.seed.a }));
    for (const body of [{ email: 'x@example.test', role: 'owner' }, { email: 'not-an-email', role: 'office' }, { email: 'x@example.test' }, 'nope']) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_request' });
    }
    await invited('x@example.test');
    expect(await (await post({ email: 'X@example.test', role: 'office' })).json()).toEqual({ error: 'invitation_pending' });
    expect(await (await post({ email: 'estimator-a@example.test', role: 'office' })).json()).toEqual({ error: 'already_member' });
  });

  it('writes nothing when the sign-in account cannot be made', async () => {
    const before = await everything(h.admin);
    h.failNext.ensureAccount = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await invite(
      request(owner(), `/api/companies/${h.seed.a}/invitations`, { method: 'POST', body: { email: 'y@example.test', role: 'office' } }),
      params({ companyId: h.seed.a }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'identity_unavailable' });
    expect(String(logged.mock.calls)).not.toContain('example.test');
    logged.mockRestore();
    expect(await everything(h.admin)).toBe(before);
  });

  // Security audit F5: a slow sign-in service never holds a database connection with a
  // transaction open, for the owner's invitation or for an operator's resend.
  it('makes the sign-in account with no transaction open, then writes the invitation', async () => {
    const seen: number[] = [];
    const team = teamService(
      h.handle.db,
      {
        async ensureAccount() {
          const [row] = await h.admin<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND application_name = 'dryscope-web' AND state LIKE 'idle in transaction%'
          `;
          seen.push(row!.n);
        },
        revokeSessions: async () => {},
      },
      async () => {},
    );
    const { invitation } = await team.invite(
      h.seed.a,
      { kind: 'member', actorId: h.seed.ownerA.actor },
      { email: 'held@example.test', role: 'office' },
      new Date(),
    );
    const resent = await team.resend(h.seed.a, { kind: 'operator', operatorId: h.seed.operator }, invitation.id, new Date());
    expect(resent.invitation.status).toBe('pending');
    expect(seen).toEqual([0, 0]);
    expect(await h.admin`SELECT action, actor_id, operator_actor_id FROM audit_events WHERE target = ${invitation.id} ORDER BY id`).toEqual([
      { action: 'invitation_created', actor_id: h.seed.ownerA.actor, operator_actor_id: null },
      { action: 'invitation_resent', actor_id: null, operator_actor_id: h.seed.operator },
    ]);
  });

  it('needs a sign-in under 15 minutes old', async () => {
    const response = await invite(
      request({ ...owner(), signedInAgo: 16 * 60 }, `/api/companies/${h.seed.a}/invitations`, {
        method: 'POST',
        body: { email: 'z@example.test', role: 'office' },
      }),
      params({ companyId: h.seed.a }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'sign_in_again' });
    // Reading the team is not a change, so an older sign-in still may.
    const list = await team(request({ ...owner(), signedInAgo: 16 * 60 }, `/api/companies/${h.seed.a}/team`), params({ companyId: h.seed.a }));
    expect(list.status).toBe(200);
  });
});

describe('reading and accepting', () => {
  it('shows nothing to an account whose verified email differs, and lets it accept nothing', async () => {
    const { invitation } = await invited();
    const before = await everything(h.admin);
    const stranger = invitee('someone.else@example.test', 'someone-else');
    for (const response of [await readAs(stranger, invitation.id), await acceptAs(stranger, invitation.id)]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    // The right email in another company's tenant reads nothing either.
    const otherTenant = { ...invitee(), tenant: 'tenant-b' };
    expect((await readAs(otherTenant, invitation.id)).status).toBe(404);
    expect((await acceptAs(otherTenant, invitation.id)).status).toBe(404);
    // An unverified email is refused before anything is read.
    expect(await (await readAs({ ...invitee(), verified: false }, invitation.id)).json()).toEqual({ error: 'email_unverified' });
    expect(await everything(h.admin)).toBe(before);

    const read = await readAs(invitee('NEW.PERSON@example.test'), invitation.id);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      invitation: { id: invitation.id, role: 'estimator', status: 'pending', expiresAt: invitation.expiresAt },
      company: { id: h.seed.a, name: 'Company company-a' },
    });
  });

  it('creates the actor and one membership, once, however often it is accepted', async () => {
    const { invitation } = await invited();
    const first = await acceptAs(invitee(), invitation.id);
    expect(first.status).toBe(201);
    const accepted = (await first.json()) as { membership: { membershipId: string; role: string } };
    expect(accepted.membership).toMatchObject({ role: 'estimator', status: 'active' });

    const again = await acceptAs(invitee(), invitation.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as typeof accepted).membership.membershipId).toBe(accepted.membership.membershipId);
    const both = await Promise.all([acceptAs(invitee(), invitation.id), acceptAs(invitee(), invitation.id)]);
    expect(both.map((response) => response.status)).toEqual([200, 200]);

    const actors = await h.admin`SELECT id, auth_tenant_id, uid, email FROM actors WHERE uid = 'new-person'`;
    expect(actors).toHaveLength(1);
    expect(actors[0]).toMatchObject({ auth_tenant_id: 'tenant-a', email: 'new.person@example.test' });
    const memberships = await h.admin`SELECT id, role, status, invitation_id FROM memberships WHERE actor_id = ${actors[0]!.id}`;
    expect(memberships).toEqual([{ id: accepted.membership.membershipId, role: 'estimator', status: 'active', invitation_id: invitation.id }]);
    expect(await h.admin`SELECT actor_id FROM access_projection_outbox`).toEqual([{ actor_id: actors[0]!.id }]);
    // Projected once, after the first acceptance committed; accepting again queued nothing.
    expect(h.projected).toEqual([{ companyId: h.seed.a, actorId: actors[0]!.id }]);
    expect((await h.admin`SELECT action FROM audit_events WHERE action = 'invitation_accepted'`).length).toBe(1);
    expect((await h.admin`SELECT status FROM invitations`)[0]).toEqual({ status: 'accepted' });

    // The new member is now signed in as one.
    const whoAmI = await me(request(invitee(), '/api/me'), params({}));
    expect(((await whoAmI.json()) as { role: string }).role).toBe('estimator');
  });

  it.each([
    ['a space where the 200-character cut falls', `N${' '.repeat(198)} X`, 'N'],
    ['an emoji across the 200-character cut', `${'N'.repeat(199)}😀X`, `${'N'.repeat(199)}😀`],
    ['nothing but spaces', '   ', null],
  ])('accepts an account whose name has %s, storing a name the actors table allows', async (_case, name, stored) => {
    const { invitation } = await invited();
    expect((await acceptAs({ ...invitee(), name }, invitation.id)).status).toBe(201);
    expect(await h.admin`SELECT display_name FROM actors WHERE uid = 'new-person'`).toEqual([{ display_name: stored }]);
  });

  it('makes one membership when two first acceptances race on two connections', async () => {
    const { invitation } = await invited();
    // The app holds one connection, so two requests never truly overlap there; two handles do.
    const second = openDatabase({ APP_ENV: 'test', DATABASE_URL: h.apiUrl });
    try {
      const other = teamService(
        second.db,
        { ensureAccount: async () => {}, revokeSessions: async () => {} },
        async () => {},
      );
      const account = {
        companyId: h.seed.a,
        companyName: 'Company company-a',
        tenant: 'tenant-a',
        uid: 'new-person',
        email: 'new.person@example.test',
        name: null,
        session: { authTime: Math.floor(Date.now() / 1000) - 60, secondFactor: null },
      };
      const results = await Promise.all([
        h.team.accept(account, invitation.id, new Date()),
        other.accept(account, invitation.id, new Date()),
      ]);
      expect(results.map((result) => result.accepted).sort()).toEqual([false, true]);
      expect(results[0]!.membershipId).toBe(results[1]!.membershipId);
    } finally {
      await second.close();
    }
    expect(await h.admin`SELECT count(*)::int AS n FROM memberships WHERE invitation_id = ${invitation.id}`).toEqual([{ n: 1 }]);
    expect(await h.admin`SELECT count(*)::int AS n FROM actors WHERE uid = 'new-person'`).toEqual([{ n: 1 }]);
    expect(await h.admin`SELECT count(*)::int AS n FROM audit_events WHERE action = 'invitation_accepted'`).toEqual([{ n: 1 }]);
  });

  it('expires after 7 days, and a resend opens it for 7 more', async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const { invitation } = await invited();
    vi.setSystemTime(start + 7 * DAY_MS - 60_000);
    expect(((await (await readAs(invitee(), invitation.id)).json()) as { invitation: { status: string } }).invitation.status).toBe('pending');
    vi.setSystemTime(start + 7 * DAY_MS + 1_000);
    expect(((await (await readAs(invitee(), invitation.id)).json()) as { invitation: { status: string } }).invitation.status).toBe('expired');
    const late = await acceptAs(invitee(), invitation.id);
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ error: 'invitation_expired' });
    expect(await h.admin`SELECT count(*)::int AS n FROM memberships WHERE invitation_id = ${invitation.id}`).toEqual([{ n: 0 }]);

    const renewed = await invitationRoute(resend, owner(), invitation.id);
    expect(renewed.status).toBe(200);
    const body = (await renewed.json()) as { invitation: { status: string; expiresAt: string }; link: string; delivery: string };
    expect(body).toMatchObject({ delivery: 'copy_link', link: `/sign-in/company-a/invitations/${invitation.id}`, invitation: { status: 'pending' } });
    expect(Date.parse(body.invitation.expiresAt)).toBe(start + 7 * DAY_MS + 1_000 + 7 * DAY_MS);
    expect((await acceptAs(invitee(), invitation.id)).status).toBe(201);
  });

  it('applies the second step an owner needs before an owner invitation is accepted', async () => {
    await h.admin`UPDATE memberships SET status = 'disabled' WHERE id = ${h.seed.ownerA.membership}`;
    const [row] = await h.admin<{ id: string }[]>`
      INSERT INTO invitations (company_id, email, role, expires_at, created_by_operator_id)
      VALUES (${h.seed.a}, 'next.owner@example.test', 'owner', now() + interval '7 days', ${h.seed.operator}) RETURNING id
    `;
    const next = invitee('next.owner@example.test', 'next-owner');
    const refused = await acceptAs({ ...next, secondFactor: null }, row!.id);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'second_step_required' });
    expect(await h.admin`SELECT count(*)::int AS n FROM actors WHERE uid = 'next-owner'`).toEqual([{ n: 0 }]);
    expect((await acceptAs(next, row!.id)).status).toBe(201);
  });

  it('refuses an account of a suspended company', async () => {
    const response = await readAs({ tenant: 'tenant-s', uid: 'someone' }, '00000000-0000-4000-8000-000000000000');
    expect(await response.json()).toEqual({ error: 'company_inactive' });
  });
});

describe('resend, cancel and clear', () => {
  it('cancels a pending invitation so it can no longer be accepted, then clears it from the list', async () => {
    const { invitation } = await invited();
    expect(await (await invitationRoute(clear, owner(), invitation.id)).json()).toEqual({ error: 'invitation_active' });
    expect((await invitationRoute(cancel, owner(), invitation.id)).status).toBe(200);
    expect(await (await acceptAs(invitee(), invitation.id)).json()).toEqual({ error: 'invitation_closed' });
    expect(await (await invitationRoute(resend, owner(), invitation.id)).json()).toEqual({ error: 'invitation_closed' });

    const listed = async () =>
      ((await (await team(request(owner(), `/api/companies/${h.seed.a}/team`), params({ companyId: h.seed.a }))).json()) as {
        invitations: { id: string; status: string }[];
      }).invitations;
    expect(await listed()).toEqual([expect.objectContaining({ id: invitation.id, status: 'cancelled' })]);
    expect(await (await invitationRoute(clear, owner(), invitation.id)).json()).toEqual({ cleared: true });
    expect(await listed()).toEqual([]);
    expect((await invitationRoute(clear, owner(), invitation.id)).status).toBe(404);
    const actions = await h.admin`SELECT action FROM audit_events ORDER BY id`;
    expect(actions.map((row) => row.action)).toEqual(['invitation_created', 'invitation_cancelled', 'invitation_cleared']);
  });

  it('clears an expired invitation so the email can be invited again', async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const { invitation } = await invited();
    vi.setSystemTime(start + 8 * DAY_MS);
    expect(await (await invitationRoute(clear, owner(), invitation.id)).json()).toEqual({ cleared: true });
    const again = await invited();
    expect(again.invitation.id).not.toBe(invitation.id);
  });

  it('is the owner’s alone, and only in the owner’s own company', async () => {
    const { invitation } = await invited();
    const before = await everything(h.admin);
    for (const route of [resend, cancel, clear]) {
      for (const uid of ['estimator-a', 'office-a']) {
        const response = await invitationRoute(route, { tenant: 'tenant-a', uid }, invitation.id);
        expect({ uid, status: response.status, body: await response.json() }).toEqual({ uid, status: 403, body: { error: 'not_allowed' } });
      }
      // Company B's owner naming company A, or naming its own company with A's invitation.
      const named = await invitationRoute(route, owner('owner-b', 'tenant-b'), invitation.id);
      expect(named.status).toBe(404);
      const own = await invitationRoute(route, owner('owner-b', 'tenant-b'), invitation.id, h.seed.b);
      expect(own.status).toBe(404);
    }
    const posted = await invite(
      request({ tenant: 'tenant-a', uid: 'office-a' }, `/api/companies/${h.seed.a}/invitations`, { method: 'POST', body: { email: 'q@example.test', role: 'office' } }),
      params({ companyId: h.seed.a }),
    );
    expect(posted.status).toBe(403);
    expect(await everything(h.admin)).toBe(before);
  });
});
