import { randomUUID } from 'node:crypto';
import { IdentityRefusal, sessionRefusal } from '@/lib/auth';
import { readFixtureSync, updateFixture, type LocalFixtureData } from '@/lib/sign-in/local-directory';
import {
  INVITATION_DAYS,
  TeamError,
  invitationLink,
  type InvitationView,
  type MemberView,
  type TeamActor,
  type TeamService,
} from './service';
import type { TenantUsers } from './users';

// A stand-in for the team and invitation records in Postgres, kept in the same JSON file as the
// sign-in stand-in (LOCAL_SIGN_IN_FIXTURE), so the team screens can be driven end to end against
// the Auth emulator with no database (tests/e2e/team.spec.ts). It follows teamService
// (service.ts) rule for rule and answers with the same errors; only the storage differs. Sign-in
// accounts are still made and revoked through `users`, which the dev server points at the
// emulator. The configuration allows it only on a developer machine (src/lib/config.ts).

const DAY_MS = 24 * 60 * 60 * 1000;

type Fixture = LocalFixtureData;
type Member = Fixture['members'][number];
type Invitation = Fixture['invitations'][number];

const isExpired = (row: Invitation, now: Date) => row.status === 'pending' && Date.parse(row.expiresAt) <= now.getTime();

function invitationView(row: Invitation, now: Date): InvitationView {
  const { id, email, role, expiresAt, createdAt } = row;
  return { id, email, role, status: isExpired(row, now) ? 'expired' : row.status, expiresAt, createdAt };
}

function memberView(row: Member): MemberView {
  return {
    membershipId: row.membershipId ?? row.actorId,
    actorId: row.actorId,
    displayName: row.displayName,
    email: row.email ?? '',
    role: row.role,
    status: row.status,
  };
}

export function localTeamService(path: string, users: TenantUsers): TeamService {
  const tenantOf = (data: Fixture, companyId: string) => data.companies.find((c) => c.id === companyId)?.tenantId;

  function readyCompany(data: Fixture, companyId: string) {
    const company = data.companies.find((c) => c.id === companyId);
    if (!company) throw new TeamError('not_found');
    return company;
  }

  function invitationOf(data: Fixture, companyId: string, id: string): Invitation {
    const row = data.invitations.find((i) => i.companyId === companyId && i.id === id);
    if (!row || row.clearedAt) throw new TeamError('not_found');
    return row;
  }

  // Never the owner, as in service.ts.
  function memberOf(data: Fixture, companyId: string, membershipId: string): Member {
    const row = data.members.find((m) => m.companyId === companyId && (m.membershipId ?? m.actorId) === membershipId);
    if (!row) throw new TeamError('not_found');
    if (row.role === 'owner') throw new TeamError('owner_protected');
    return row;
  }

  const expiry = (now: Date) => new Date(now.getTime() + INVITATION_DAYS * DAY_MS).toISOString();

  // As teamService makes the sign-in call inside its transaction, the change is tried on a copy,
  // the sign-in call made, and only then the change written, so a failed call leaves the file as it was.
  async function updateAfter<T>(change: (data: Fixture) => T, identity: (result: T) => Promise<void>): Promise<T> {
    await identity(change(readFixtureSync(path)));
    return updateFixture(path, change);
  }

  return {
    async list(companyId, view) {
      const data = readFixtureSync(path);
      const members = data.members.filter((m) => m.companyId === companyId);
      if (view === 'estimators') {
        const estimators = members
          .filter((m) => m.role === 'estimator' && m.status === 'active')
          .map(({ membershipId, actorId, displayName, email }) => ({
            membershipId: membershipId ?? actorId,
            actorId,
            displayName,
            email: email ?? '',
          }));
        return { view, estimators };
      }
      const now = new Date();
      const open = data.invitations
        .filter((i) => i.companyId === companyId && !i.clearedAt)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { view, members: members.map(memberView), invitations: open.map((i) => invitationView(i, now)) };
    },

    async invite(companyId, _by: TeamActor, input, now) {
      const created = await updateAfter(
        (data) => {
          const company = readyCompany(data, companyId);
          if (data.members.some((m) => m.companyId === companyId && m.email === input.email)) throw new TeamError('already_member');
          if (data.invitations.some((i) => i.companyId === companyId && i.email === input.email && i.status === 'pending')) {
            throw new TeamError('invitation_pending');
          }
          const row: Invitation = {
            id: randomUUID(),
            companyId,
            email: input.email,
            role: input.role,
            status: 'pending',
            expiresAt: expiry(now),
            createdAt: now.toISOString(),
            clearedAt: null,
            acceptedByActorId: null,
          };
          data.invitations.push(row);
          return { row, tenant: company.tenantId, slug: company.signInAddress };
        },
        (made) => users.ensureAccount(made.tenant, input.email),
      );
      return {
        invitation: invitationView(created.row, now),
        delivery: 'copy_link' as const,
        link: invitationLink(created.slug, created.row.id),
      };
    },

    async resend(companyId, _by, invitationId, now) {
      const found = await updateAfter(
        (data) => {
          const company = readyCompany(data, companyId);
          const row = invitationOf(data, companyId, invitationId);
          if (row.status !== 'pending') throw new TeamError('invitation_closed');
          row.expiresAt = expiry(now);
          return { row: { ...row }, tenant: company.tenantId, slug: company.signInAddress };
        },
        (made) => users.ensureAccount(made.tenant, made.row.email),
      );
      return {
        invitation: invitationView(found.row, now),
        delivery: 'copy_link' as const,
        link: invitationLink(found.slug, invitationId),
      };
    },

    async cancel(companyId, _by, invitationId, now) {
      return updateFixture(path, (data) => {
        const row = invitationOf(data, companyId, invitationId);
        if (row.status !== 'pending') throw new TeamError('invitation_closed');
        row.status = 'cancelled';
        return { invitation: invitationView(row, now) };
      });
    },

    async clear(companyId, _by, invitationId, now) {
      return updateFixture(path, (data) => {
        const row = invitationOf(data, companyId, invitationId);
        const expired = isExpired(row, now);
        if (row.status === 'pending' && !expired) throw new TeamError('invitation_active');
        if (expired) row.status = 'cancelled';
        row.clearedAt = now.toISOString();
        return { cleared: true as const };
      });
    },

    async changeRole(companyId, _by, membershipId, role) {
      return updateFixture(path, (data) => {
        const row = memberOf(data, companyId, membershipId);
        row.role = role;
        return { member: memberView(row) };
      });
    },

    async disable(companyId, _by, membershipId) {
      const { member } = await updateAfter(
        (data) => {
          const row = memberOf(data, companyId, membershipId);
          row.status = 'disabled';
          return { member: memberView(row), tenant: tenantOf(data, companyId), uid: row.uid };
        },
        async ({ tenant, uid }) => {
          if (tenant) await users.revokeSessions(tenant, uid);
        },
      );
      return { member };
    },

    async enable(companyId, _by, membershipId) {
      return updateFixture(path, (data) => {
        const row = memberOf(data, companyId, membershipId);
        row.status = 'active';
        return { member: memberView(row) };
      });
    },

    // An invitation for another email reads as not found, as in service.ts.
    async readInvitation(account, invitationId, now) {
      const row = readFixtureSync(path).invitations.find((i) => i.companyId === account.companyId && i.id === invitationId);
      if (!row || row.email !== account.email) throw new TeamError('not_found');
      const { id, role, status, expiresAt } = invitationView(row, now);
      return { invitation: { id, role, status, expiresAt }, company: { id: account.companyId, name: account.companyName } };
    },

    async accept(account, invitationId, now) {
      return updateFixture(path, (data) => {
        const companyId = account.companyId;
        const row = data.invitations.find((i) => i.companyId === companyId && i.id === invitationId);
        if (!row || row.email !== account.email) throw new TeamError('not_found');
        const held = data.members.find((m) => m.companyId === companyId && m.uid === account.uid);

        if (row.status === 'accepted') {
          if (!held || row.acceptedByActorId !== held.actorId) throw new TeamError('invitation_closed');
          return { membershipId: held.membershipId ?? held.actorId, role: held.role, status: held.status, accepted: false };
        }
        if (row.status === 'cancelled') throw new TeamError('invitation_closed');
        if (isExpired(row, now)) throw new TeamError('invitation_expired');
        const refused = sessionRefusal(row.role, account.session, {}, Math.floor(now.getTime() / 1000));
        if (refused) throw new IdentityRefusal(refused);
        if (held) throw new TeamError('already_member');

        const actorId = randomUUID();
        const membershipId = randomUUID();
        data.members.push({
          companyId,
          uid: account.uid,
          actorId,
          membershipId,
          email: account.email,
          displayName: account.name,
          role: row.role,
          status: 'active',
        });
        row.status = 'accepted';
        row.acceptedByActorId = actorId;
        return { membershipId, role: row.role, status: 'active' as const, accepted: true };
      });
    },
  };
}
