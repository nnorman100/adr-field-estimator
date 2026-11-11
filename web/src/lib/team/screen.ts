import { can, isRole, type Role } from '@/lib/access';
import type { InvitationView, MemberView, TeamErrorCode, TeamView } from './service';

// What the team and invitation screens (S3-16) decide in the browser, as pure functions so they are
// unit-tested. Everything here is convenience: the server checks the sign-in, the company and the
// role again on every call (src/lib/team/http.ts), so a wrong answer here shows the wrong screen
// but never grants anything. Words come from fixed codes only; nothing the person typed (an email)
// and no token goes into a message.

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// GET /api/me's answer as who is signed in: the company id the team routes name, the role, and
// whether the role may manage the team. null for an answer of an unexpected shape.
export type SignedInMember = { companyId: string; role: Role; canManageTeam: boolean };

export function signedInMember(body: unknown): SignedInMember | null {
  const companyId = field(field(body, 'company'), 'id');
  const role = field(body, 'role');
  const capabilities = field(body, 'capabilities');
  if (typeof companyId !== 'string' || !isRole(role) || !Array.isArray(capabilities)) return null;
  return { companyId, role, canManageTeam: capabilities.includes('team_manage') };
}

// Whether the sign-in page should offer "Team and invitations" for a role. The same table the
// server reads, so the link and the route agree.
export function offersTeamScreen(role: string): boolean {
  return can(role, 'team_manage', { priceBooks: false });
}

// GET /api/companies/{id}/team's answer for the owner. The estimators-only view an office user
// gets is not a team screen, so it is treated as no answer.
export function fullTeam(body: unknown): Extract<TeamView, { view: 'full' }> | null {
  if (field(body, 'view') !== 'full') return null;
  const members = field(body, 'members');
  const invitations = field(body, 'invitations');
  if (!Array.isArray(members) || !Array.isArray(invitations)) return null;
  return { view: 'full', members: members as MemberView[], invitations: invitations as InvitationView[] };
}

export const ROLE_LABELS: Record<Role, string> = { owner: 'Owner', estimator: 'Estimator', office: 'Office' };

export function roleLabel(role: unknown): string {
  return isRole(role) ? ROLE_LABELS[role] : 'Team member';
}

// The other staff role, for "Change to ...".
export function otherStaffRole(role: Role): 'estimator' | 'office' {
  return role === 'estimator' ? 'office' : 'estimator';
}

const TEAM_MESSAGES: Record<TeamErrorCode, string> = {
  not_allowed: 'Only the company owner can do that.',
  support_action_refused: 'That change is not available here.',
  not_found: 'That person or invitation could not be found. Reload the page.',
  already_member: 'That email address is already on the team.',
  invitation_pending: 'That email address already has an invitation. Resend or cancel it below.',
  invitation_closed: 'That invitation is no longer open.',
  invitation_active: 'An invitation that is still open cannot be cleared. Cancel it first.',
  invitation_expired: 'That invitation has expired. Ask the owner to send it again.',
  owner_protected: 'The owner cannot be changed here.',
  company_not_ready: 'This company has no sign-in link yet, so nobody can be invited. Contact DryScope support.',
  conflict: 'Two changes met at the same moment. Try again.',
};

const OTHER_MESSAGES: Record<string, string> = {
  invalid_request: 'That did not look right. Check the email address and try again.',
  second_step_required: 'Set up your second sign-in step before changing the team.',
  member_disabled: 'Your access is turned off. Ask the owner of your company.',
  company_inactive: 'Sign-in is paused for this company. Contact DryScope support.',
};

export const SIGN_IN_AGAIN_MESSAGE = 'For safety, team changes need a sign-in from the last 15 minutes. Sign in again, then repeat the change.';
const TRY_AGAIN_MESSAGE = 'We could not make that change. Check your connection, then try again.';

export function isSignInAgain(status: number, body: unknown): boolean {
  return status === 401 && field(body, 'error') === 'sign_in_again';
}

// The words for a refused or failed team call, from the server's error code.
export function teamErrorMessage(status: number, body: unknown): string {
  if (isSignInAgain(status, body)) return SIGN_IN_AGAIN_MESSAGE;
  const code = field(body, 'error');
  if (typeof code === 'string') {
    if (Object.hasOwn(TEAM_MESSAGES, code)) return TEAM_MESSAGES[code as TeamErrorCode];
    if (Object.hasOwn(OTHER_MESSAGES, code)) return OTHER_MESSAGES[code]!;
  }
  return TRY_AGAIN_MESSAGE;
}

// What an invitation says about itself in the list.
export function invitationStatusText(invitation: InvitationView): string {
  switch (invitation.status) {
    case 'pending':
      return `Open until ${formatDay(invitation.expiresAt)}`;
    case 'expired':
      return 'Expired';
    case 'accepted':
      return 'Accepted';
    case 'cancelled':
      return 'Cancelled';
  }
}

function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'a later date';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// The invitation as the invitee sees it before accepting (GET /api/invitations/{id}).
export type InvitationOffer = { role: Role; status: 'pending' | 'expired' | 'accepted' | 'cancelled'; expiresAt: string };

export function invitationOffer(body: unknown): InvitationOffer | null {
  const invitation = field(body, 'invitation');
  const role = field(invitation, 'role');
  const status = field(invitation, 'status');
  const expiresAt = field(invitation, 'expiresAt');
  if (!isRole(role) || typeof expiresAt !== 'string') return null;
  if (status !== 'pending' && status !== 'expired' && status !== 'accepted' && status !== 'cancelled') return null;
  return { role, status, expiresAt };
}
