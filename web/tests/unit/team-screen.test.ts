import { describe, expect, it } from 'vitest';
import { CAPABILITIES, ROLES } from '@/lib/access';
import {
  ACCEPT_SECOND_STEP_MESSAGE,
  ACCEPT_SIGN_IN_AGAIN_MESSAGE,
  acceptErrorMessage,
  fullTeam,
  invitationOffer,
  invitationStatusText,
  isSignInAgain,
  offersTeamScreen,
  otherStaffRole,
  roleLabel,
  signedInMember,
  stillOpenLink,
  teamErrorMessage,
} from '@/lib/team/screen';
import { TEAM_ERRORS } from '@/lib/team/service';

// What the team and invitation screens (S3-16) decide in the browser. The screens themselves are
// driven in tests/e2e/team.spec.ts.

const COMPANY = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';

describe('who is signed in, from GET /api/me', () => {
  it('reads the company, the role and whether the role manages the team', () => {
    const body = (role: string, capabilities: string[]) => ({ company: { id: COMPANY, name: 'A' }, role, capabilities });
    expect(signedInMember(body('owner', ['team_manage', 'assignment']))).toEqual({ companyId: COMPANY, role: 'owner', canManageTeam: true });
    expect(signedInMember(body('office', ['assignment']))).toEqual({ companyId: COMPANY, role: 'office', canManageTeam: false });
    expect(signedInMember(body('estimator', []))).toEqual({ companyId: COMPANY, role: 'estimator', canManageTeam: false });
  });

  it.each([null, {}, { role: 'owner', capabilities: [] }, { company: { id: COMPANY }, role: 'superuser', capabilities: [] }, { company: { id: COMPANY }, role: 'owner' }])(
    'treats an answer of another shape as no answer: %j',
    (body) => {
      expect(signedInMember(body)).toBeNull();
    },
  );

  it('offers the team screen to exactly the roles that hold team_manage', () => {
    expect(CAPABILITIES).toContain('team_manage');
    expect(ROLES.filter((role) => offersTeamScreen(role))).toEqual(['owner']);
    expect(offersTeamScreen('superadmin')).toBe(false);
    expect(offersTeamScreen('constructor')).toBe(false);
  });
});

describe('the team list', () => {
  it('takes the owner’s view and refuses the estimators-only view', () => {
    expect(fullTeam({ view: 'full', members: [], invitations: [] })).toEqual({ view: 'full', members: [], invitations: [] });
    expect(fullTeam({ view: 'estimators', estimators: [] })).toBeNull();
    expect(fullTeam({ view: 'full', members: [] })).toBeNull();
    expect(fullTeam(null)).toBeNull();
  });

  it('words roles and the other staff role', () => {
    expect(ROLES.map(roleLabel)).toEqual(['Owner', 'Estimator', 'Office']);
    expect(roleLabel('constructor')).toBe('Team member');
    expect(otherStaffRole('estimator')).toBe('office');
    expect(otherStaffRole('office')).toBe('estimator');
  });

  it('says what each invitation is', () => {
    const base = { id: 'i', email: 'a@example.com', role: 'office', expiresAt: '2026-11-18T10:00:00.000Z', createdAt: '2026-11-11T10:00:00.000Z' } as const;
    expect(invitationStatusText({ ...base, status: 'pending' })).toBe('Open until Nov 18');
    expect(invitationStatusText({ ...base, status: 'expired' })).toBe('Expired');
    expect(invitationStatusText({ ...base, status: 'accepted' })).toBe('Accepted');
    expect(invitationStatusText({ ...base, status: 'cancelled' })).toBe('Cancelled');
  });
});

describe('words for a refused team call', () => {
  it('has words for every error the team routes can answer, and none of them repeat what was typed', () => {
    for (const code of Object.keys(TEAM_ERRORS)) {
      const message = teamErrorMessage(409, { error: code });
      expect({ code, message: message.length > 0 }).toEqual({ code, message: true });
      expect({ code, generic: message.startsWith('We could not make that change') }).toEqual({ code, generic: false });
    }
  });

  it('asks for a new sign-in on sign_in_again and for nothing else', () => {
    expect(isSignInAgain(401, { error: 'sign_in_again' })).toBe(true);
    expect(isSignInAgain(403, { error: 'sign_in_again' })).toBe(false);
    expect(isSignInAgain(401, { error: 'invalid_token' })).toBe(false);
    expect(teamErrorMessage(401, { error: 'sign_in_again' })).toContain('last 15 minutes');
  });

  it.each([
    [400, { error: 'invalid_request' }, 'Check the email address'],
    [403, { error: 'second_step_required' }, 'second sign-in step'],
    [503, { error: 'team_unavailable' }, 'We could not make that change'],
    [0, null, 'We could not make that change'],
    [409, { error: 'toString' }, 'We could not make that change'],
    [409, { error: 'a_code_nobody_knows' }, 'We could not make that change'],
  ])('%i %j says "%s"', (status, body, text) => {
    expect(teamErrorMessage(status, body)).toContain(text);
  });
});

describe('words for a refused accept', () => {
  it('asks the invitee to sign in again and accept, without the 15-minute rule of team changes', () => {
    const message = acceptErrorMessage(401, { error: 'sign_in_again' });
    expect(message).toBe(ACCEPT_SIGN_IN_AGAIN_MESSAGE);
    expect(message).not.toContain('15 minutes');
    expect(acceptErrorMessage(409, { error: 'invitation_expired' })).toBe(teamErrorMessage(409, { error: 'invitation_expired' }));
  });

  it('tells an owner invitee without a second step to set one up before accepting, not to change the team', () => {
    const message = acceptErrorMessage(403, { error: 'second_step_required' });
    expect(message).toBe(ACCEPT_SECOND_STEP_MESSAGE);
    expect(message).not.toContain('team');
    expect(teamErrorMessage(403, { error: 'second_step_required' })).toContain('changing the team');
  });
});

describe('the invitation link on screen', () => {
  const invitation = (id: string, status: 'pending' | 'expired' | 'accepted' | 'cancelled') => ({
    id,
    email: 'new@example.com',
    role: 'office' as const,
    status,
    expiresAt: '2026-11-18T10:00:00.000Z',
    createdAt: '2026-11-11T10:00:00.000Z',
  });
  const link = { id: 'inv-1', email: 'new@example.com', url: 'https://example.test/sign-in/a/invitations/inv-1' };

  it('stays while the list read from the server holds its invitation as open', () => {
    expect(stillOpenLink(link, [invitation('inv-1', 'pending')])).toBe(link);
  });

  it('goes once the list shows its invitation cancelled, accepted, expired or cleared', () => {
    for (const status of ['cancelled', 'accepted', 'expired'] as const) {
      expect(stillOpenLink(link, [invitation('inv-1', status)])).toBeNull();
    }
    expect(stillOpenLink(link, [invitation('inv-2', 'pending')])).toBeNull();
    expect(stillOpenLink(null, [invitation('inv-1', 'pending')])).toBeNull();
  });
});

describe('the invitation as the invitee reads it', () => {
  it('takes the role, status and expiry, and nothing else', () => {
    const body = { invitation: { id: 'x', role: 'office', status: 'pending', expiresAt: '2026-11-18T10:00:00.000Z' }, company: { id: COMPANY, name: 'A' } };
    expect(invitationOffer(body)).toEqual({ role: 'office', status: 'pending', expiresAt: '2026-11-18T10:00:00.000Z' });
  });

  it.each([null, {}, { invitation: {} }, { invitation: { role: 'office', status: 'weird', expiresAt: 'x' } }, { invitation: { role: 'boss', status: 'pending', expiresAt: 'x' } }])(
    'treats %j as no invitation',
    (body) => {
      expect(invitationOffer(body)).toBeNull();
    },
  );
});
