import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Account, SessionToken, TokenVerifier } from '@/lib/auth';
import { IdentityRefusal } from '@/lib/auth';
import { readFixtureSync, updateFixture, withLocalSecondStep, type LocalSignInFixture } from '@/lib/sign-in/local-directory';
import { localTeamService } from '@/lib/team/local-team';
import { TeamError } from '@/lib/team/service';
import type { TenantUsers } from '@/lib/team/users';

// The local stand-in for the team records (S3-16) answers the team rules the way teamService does
// (tests/db/team-*.test.ts run those against Postgres), so the screens tested against it
// (tests/e2e/team.spec.ts) meet the same answers. These are the checks of S3-10 that matter to the
// screens: who may read an invitation, accepting once, and the owner staying out of reach.

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const TENANT = 'tenant-a';
const NOW = new Date('2026-11-11T10:00:00.000Z');
const OWNER_MEMBERSHIP = randomUUID();
const ESTIMATOR_MEMBERSHIP = randomUUID();
const OWNER_ACTOR = randomUUID();
const ESTIMATOR_ACTOR = randomUUID();

let dir: string;
let path: string;
const accounts: string[] = [];
const revoked: string[] = [];
const users: TenantUsers = {
  async ensureAccount(_tenant, email) {
    accounts.push(email);
  },
  async revokeSessions(tenant, uid) {
    revoked.push(`${tenant}/${uid}`);
  },
};
const by = { kind: 'member', actorId: OWNER_ACTOR } as const;

function fixture(): LocalSignInFixture {
  return {
    companies: [
      { id: COMPANY, name: 'Company A', signInAddress: 'company-a', tenantId: TENANT, status: 'active' },
      { id: OTHER_COMPANY, name: 'Company B', signInAddress: 'company-b', tenantId: 'tenant-b', status: 'active' },
    ],
    members: [
      { companyId: COMPANY, uid: 'owner-uid', actorId: OWNER_ACTOR, membershipId: OWNER_MEMBERSHIP, email: 'owner@example.com', displayName: 'Owner', role: 'owner', status: 'active', secondStep: true },
      { companyId: COMPANY, uid: 'est-uid', actorId: ESTIMATOR_ACTOR, membershipId: ESTIMATOR_MEMBERSHIP, email: 'est@example.com', displayName: 'Est', role: 'estimator', status: 'active' },
    ],
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-team-'));
  path = join(dir, 'fixture.json');
});
afterAll(() => rm(dir, { recursive: true, force: true }));
beforeEach(async () => {
  accounts.length = 0;
  revoked.length = 0;
  await writeFile(path, JSON.stringify(fixture()));
});

const account = (email: string, uid = 'invitee-uid', companyId = COMPANY): Account => ({
  companyId,
  companyName: 'Company A',
  tenant: TENANT,
  uid,
  email,
  name: null,
  session: { authTime: Math.floor(NOW.getTime() / 1000), secondFactor: null },
});

describe('the local team stand-in', () => {
  it('lets the owner invite, makes the sign-in account, and hands back the link', async () => {
    const team = localTeamService(path, users);
    const made = await team.invite(COMPANY, by, { email: 'new@example.com', role: 'office' }, NOW);
    expect(made.delivery).toBe('copy_link');
    expect(made.link).toBe(`/sign-in/company-a/invitations/${made.invitation.id}`);
    expect(accounts).toEqual(['new@example.com']);
    const listed = await team.list(COMPANY, 'full', NOW);
    expect(listed.view === 'full' && listed.invitations.map((i) => [i.email, i.role, i.status])).toEqual([['new@example.com', 'office', 'pending']]);
    await expect(team.invite(COMPANY, by, { email: 'new@example.com', role: 'office' }, NOW)).rejects.toMatchObject({ code: 'invitation_pending' });
    await expect(team.invite(COMPANY, by, { email: 'est@example.com', role: 'office' }, NOW)).rejects.toMatchObject({ code: 'already_member' });
  });

  it('shows an invitation only to the email it is addressed to', async () => {
    const team = localTeamService(path, users);
    const { invitation } = await team.invite(COMPANY, by, { email: 'new@example.com', role: 'office' }, NOW);
    const read = await team.readInvitation(account('new@example.com'), invitation.id, NOW);
    expect(read.invitation).toEqual({ id: invitation.id, role: 'office', status: 'pending', expiresAt: invitation.expiresAt });
    // Another email, a made-up id and another company's invitation all read as not found.
    await expect(team.readInvitation(account('someone-else@example.com'), invitation.id, NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(team.readInvitation(account('new@example.com'), randomUUID(), NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(team.readInvitation(account('new@example.com', 'u', OTHER_COMPANY), invitation.id, NOW)).rejects.toMatchObject({ code: 'not_found' });
    await expect(team.accept(account('someone-else@example.com'), invitation.id, NOW)).rejects.toBeInstanceOf(TeamError);
  });

  it('makes one membership however often the invitation is accepted', async () => {
    const team = localTeamService(path, users);
    const { invitation } = await team.invite(COMPANY, by, { email: 'new@example.com', role: 'office' }, NOW);
    const first = await team.accept(account('new@example.com'), invitation.id, NOW);
    const second = await team.accept(account('new@example.com'), invitation.id, NOW);
    expect([first.accepted, second.accepted]).toEqual([true, false]);
    expect(second.membershipId).toBe(first.membershipId);
    expect(readFixtureSync(path).members.filter((m) => m.email === 'new@example.com')).toHaveLength(1);
    await expect(team.accept(account('new@example.com', 'another-uid'), invitation.id, NOW)).rejects.toMatchObject({ code: 'invitation_closed' });
  });

  it('refuses an expired or cancelled invitation, and resending gives an expired one 7 days again', async () => {
    const team = localTeamService(path, users);
    const { invitation } = await team.invite(COMPANY, by, { email: 'late@example.com', role: 'estimator' }, NOW);
    const later = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    await expect(team.accept(account('late@example.com'), invitation.id, later)).rejects.toMatchObject({ code: 'invitation_expired' });
    expect((await team.readInvitation(account('late@example.com'), invitation.id, later)).invitation.status).toBe('expired');
    const resent = await team.resend(COMPANY, by, invitation.id, later);
    expect(resent.invitation.status).toBe('pending');
    await team.cancel(COMPANY, by, invitation.id, later);
    await expect(team.accept(account('late@example.com'), invitation.id, later)).rejects.toMatchObject({ code: 'invitation_closed' });
    await expect(team.cancel(COMPANY, by, invitation.id, later)).rejects.toMatchObject({ code: 'invitation_closed' });
  });

  it('clears only a finished invitation', async () => {
    const team = localTeamService(path, users);
    const { invitation } = await team.invite(COMPANY, by, { email: 'new@example.com', role: 'office' }, NOW);
    await expect(team.clear(COMPANY, by, invitation.id, NOW)).rejects.toMatchObject({ code: 'invitation_active' });
    await team.cancel(COMPANY, by, invitation.id, NOW);
    await team.clear(COMPANY, by, invitation.id, NOW);
    const listed = await team.list(COMPANY, 'full', NOW);
    expect(listed.view === 'full' && listed.invitations).toEqual([]);
    await expect(team.clear(COMPANY, by, invitation.id, NOW)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('changes a member between estimator and office, turns them off and on, and never touches the owner', async () => {
    const team = localTeamService(path, users);
    expect((await team.changeRole(COMPANY, by, ESTIMATOR_MEMBERSHIP, 'office', NOW)).member.role).toBe('office');
    const listed = await team.list(COMPANY, 'full', NOW);
    expect(listed.view === 'full' && listed.members.find((m) => m.membershipId === ESTIMATOR_MEMBERSHIP)?.role).toBe('office');

    expect((await team.disable(COMPANY, by, ESTIMATOR_MEMBERSHIP, NOW)).member.status).toBe('disabled');
    expect(revoked).toEqual([`${TENANT}/est-uid`]);
    expect((await team.enable(COMPANY, by, ESTIMATOR_MEMBERSHIP, NOW)).member.status).toBe('active');

    for (const act of [
      () => team.changeRole(COMPANY, by, OWNER_MEMBERSHIP, 'office', NOW),
      () => team.disable(COMPANY, by, OWNER_MEMBERSHIP, NOW),
      () => team.enable(COMPANY, by, OWNER_MEMBERSHIP, NOW),
    ]) {
      await expect(act()).rejects.toMatchObject({ code: 'owner_protected' });
    }
    // Another company's member is not found.
    await expect(team.changeRole(OTHER_COMPANY, by, ESTIMATOR_MEMBERSHIP, 'office', NOW)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('gives an office user only the active estimators', async () => {
    const team = localTeamService(path, users);
    await team.disable(COMPANY, by, ESTIMATOR_MEMBERSHIP, NOW);
    expect(await team.list(COMPANY, 'estimators', NOW)).toEqual({ view: 'estimators', estimators: [] });
    await team.enable(COMPANY, by, ESTIMATOR_MEMBERSHIP, NOW);
    const listed = await team.list(COMPANY, 'estimators', NOW);
    expect(listed.view === 'estimators' && listed.estimators.map((e) => e.email)).toEqual(['est@example.com']);
  });

  it('applies the second-step rule of the role being accepted', async () => {
    const team = localTeamService(path, users);
    updateFixture(path, (data) => {
      data.invitations.push({
        id: randomUUID(),
        companyId: COMPANY,
        email: 'boss@example.com',
        role: 'owner',
        status: 'pending',
        expiresAt: new Date(NOW.getTime() + 1000 * 60).toISOString(),
        createdAt: NOW.toISOString(),
        clearedAt: null,
        acceptedByActorId: null,
      });
    });
    const owner = readFixtureSync(path).invitations[0]!;
    await expect(team.accept(account('boss@example.com'), owner.id, NOW)).rejects.toBeInstanceOf(IdentityRefusal);
  });
});

describe('the fixture file', () => {
  it('changes whole, leaves no lock behind, and keeps the change when the file is read again', async () => {
    updateFixture(path, (data) => {
      data.members[1]!.role = 'office';
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(JSON.parse(await readFile(path, 'utf8')).members[1].role).toBe('office');
  });

  it('keeps the file and drops the lock when a change throws', () => {
    expect(() =>
      updateFixture(path, (data) => {
        data.members.length = 0;
        throw new Error('stop');
      }),
    ).toThrow('stop');
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(readFixtureSync(path).members).toHaveLength(2);
  });

  it('counts a member marked secondStep as having used an authenticator app, and nobody else', async () => {
    const token = (uid: string): SessionToken => ({ uid, tenant: TENANT, emailVerified: true, authTime: 1, secondFactor: null, email: null, name: null });
    const base: TokenVerifier = {
      async verify(): Promise<never> {
        throw new Error('not used');
      },
      async verifyNotRevoked(idToken) {
        return token(idToken);
      },
    };
    const verifier = withLocalSecondStep(base, path);
    expect((await verifier.verifyNotRevoked('owner-uid', TENANT)).secondFactor).toBe('totp');
    expect((await verifier.verifyNotRevoked('est-uid', TENANT)).secondFactor).toBeNull();
    // The mark counts only in the company of the tenant that signed in.
    expect((await verifier.verifyNotRevoked('owner-uid', 'tenant-b')).secondFactor).toBeNull();
  });
});
