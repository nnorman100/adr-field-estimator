import type { CompanyStatus } from '@/lib/platform/service';
import { signInErrorMessage } from '@/lib/sign-in/outcome';

// What the platform operator's screens decide (S3-15), from fixed codes only: the server's
// refusal code from an operator route, and the company's status. Nothing a person typed and no
// token ever goes into a message. Pure functions, so they are unit-tested; the screens
// (src/app/operator) only draw what these return.

// An Identity Platform tenant id, as the owner-run command prints it (the same rule as the bind
// route's body, src/lib/platform/http.ts). The operator's pages carry the operator tenant's id in
// their address, so only this shape is ever handed to the browser's sign-in.
const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

export function isOperatorTenantId(value: unknown): value is string {
  return typeof value === 'string' && TENANT_ID.test(value);
}

// What GET /api/platform/companies, the check made right after every sign-in, tells the screens.
export type OperatorCheck =
  | { kind: 'operator' }
  // The sign-in is not an active platform operator's: a company owner, estimator or office user,
  // or an account of a company tenant. The phone drops the sign-in.
  | { kind: 'not-operator' }
  | { kind: 'verify-email' }
  // Operators always need an authenticator-app second step (D6); its screens are S3-14.
  | { kind: 'second-step' }
  // The sign-in is too old, revoked or unreadable: sign out and sign in again.
  | { kind: 'sign-in-again' }
  // The check could not be made (network, 5xx): offer to try again, keep the sign-in.
  | { kind: 'unavailable' };

const CHECKS: Record<string, OperatorCheck> = {
  not_an_operator: { kind: 'not-operator' },
  no_tenant: { kind: 'not-operator' },
  unknown_tenant: { kind: 'not-operator' },
  account_disabled: { kind: 'not-operator' },
  email_unverified: { kind: 'verify-email' },
  second_step_required: { kind: 'second-step' },
  sign_in_again: { kind: 'sign-in-again' },
  sign_in_revoked: { kind: 'sign-in-again' },
  invalid_token: { kind: 'sign-in-again' },
  missing_token: { kind: 'sign-in-again' },
};

// An answer of any other shape is "unavailable", never "operator": only a 200 opens the screens.
export function operatorCheck(status: number, code: string | null): OperatorCheck {
  if (status === 200) return { kind: 'operator' };
  if ((status === 401 || status === 403) && code !== null && Object.hasOwn(CHECKS, code)) return CHECKS[code]!;
  return status === 401 ? { kind: 'sign-in-again' } : { kind: 'unavailable' };
}

// Outcomes after which this phone should not keep the sign-in.
export function endsOperatorSession(check: OperatorCheck): boolean {
  return check.kind === 'not-operator' || check.kind === 'sign-in-again';
}

// A status change the screens may offer for a company. The server holds the same rules (archive
// needs a suspended company; reactivating works from suspended or archived), so these only keep
// the screens from offering what would be refused.
export type StatusAction = {
  to: CompanyStatus;
  label: string;
  // What the operator is asked to confirm first; null when the change needs no confirmation.
  confirm: string | null;
};

const SUSPEND: StatusAction = {
  to: 'suspended',
  label: 'Suspend',
  confirm: 'Suspending turns off sign-in and field access for everyone in this company until you reactivate it.',
};
const REACTIVATE: StatusAction = { to: 'active', label: 'Reactivate', confirm: null };
const ARCHIVE: StatusAction = {
  to: 'archived',
  label: 'Archive',
  confirm: 'Archiving closes this company. You can still reactivate it later.',
};

// Archive is offered only for a suspended company.
export function statusActions(status: CompanyStatus): StatusAction[] {
  switch (status) {
    case 'active':
      return [SUSPEND];
    case 'suspended':
      return [REACTIVATE, ARCHIVE];
    case 'archived':
      return [REACTIVATE];
  }
}

export const STATUS_LABELS: Record<CompanyStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  archived: 'Archived',
};

// A date of a job or a record in the support view, in the phone's own time zone.
export function supportDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

// What a photo that could not be read because the connection is down says.
export const PHOTO_OFFLINE_MESSAGE = 'Needs a connection. Check the signal, then try again.';

// The number each photo carries in the signed photo log (its place in the log, from 1), by photo id.
export function signedPhotoNumbers(photoLog: readonly unknown[]): Map<string, number> {
  const numbers = new Map<string, number>();
  photoLog.forEach((photo, index) => {
    const id = photo !== null && typeof photo === 'object' ? (photo as Record<string, unknown>).id : undefined;
    if (typeof id === 'string' && id && !numbers.has(id)) numbers.set(id, index + 1);
  });
  return numbers;
}

// An evidence row's name. A photo of the signed log takes the log's number, so the two sections
// agree; any other row (a photo outside the log, an original, the signature) is named by what it is
// and the order it was received in, which never reads as a number of the log.
export function evidenceLabel(item: { kind: 'photo' | 'original' | 'signature'; photoId: string }, signed: ReadonlyMap<string, number>, index: number): string {
  const number = item.kind === 'photo' ? signed.get(item.photoId) : undefined;
  if (number !== undefined) return `Photo ${number}`;
  const name = item.kind === 'photo' ? 'Photo outside the signed log' : item.kind === 'original' ? 'Full-size original' : 'Signature';
  return `${name} (received ${index + 1})`;
}

// The words for an operator action the server refused, from its fixed error code.
export function operatorErrorMessage(code: string | null): string {
  switch (code) {
    case 'not_found':
      return 'That company or person was not found.';
    case 'suspend_first':
      return 'Suspend the company before archiving it.';
    case 'sign_in_address_taken':
      return 'Another company already uses that sign-in address.';
    case 'company_not_ready':
      return 'This company has no sign-in tenant yet, so an owner cannot be invited.';
    case 'tenant_already_bound':
      return 'This company already has a sign-in tenant.';
    case 'tenant_in_use':
      return 'That sign-in tenant belongs to another company or to the operators.';
    case 'owner_exists':
      return 'This company already has an owner. Choose Replace the owner instead.';
    case 'no_owner':
      return 'This company has no owner to replace. Choose Invite the first owner instead.';
    case 'already_member':
      return 'That person is already on this company’s team.';
    case 'invitation_pending':
      return 'That person already has a pending invitation.';
    case 'conflict':
      return 'Something changed at the same time. Reload the page and try again.';
    case 'invalid_request':
      return 'Check what you entered and try again.';
    case 'identity_unavailable':
    case 'platform_unavailable':
    case 'unavailable':
      return 'That could not be done right now. Try again in a moment.';
    default:
      return 'That did not work. Try again.';
  }
}

// What a failed read of the support view says: with no answer at all, that it needs a connection;
// otherwise the words for the server's code. A refusal that ends the sign-in never shows here: the
// operator session removes the screen and asks for a new sign-in (operator-session.tsx).
export function supportReadMessage(status: number, code: string): string {
  if (status === 0) return 'Needs a connection. Check the signal, then open this page again.';
  return operatorErrorMessage(code);
}

// A refusal that only a new sign-in clears: the sign-in is too old for a change to a team or a
// second step (15 minutes), or is no longer valid.
export function isSignInAgainCode(code: string | null): boolean {
  return code !== null && ['sign_in_again', 'sign_in_revoked', 'invalid_token', 'missing_token'].includes(code);
}

// The words for a failed operator sign-in, from the Firebase error code only. Where the company
// sign-in words talk about a company or an invitation, an operator's say what is true for them.
export function operatorSignInErrorMessage(code: unknown): string | null {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match a platform operator account.';
    case 'auth/user-disabled':
      return 'This account is turned off.';
    case 'auth/admin-restricted-operation':
      return 'There is no platform operator account for that Google sign-in.';
    case 'auth/operation-not-allowed':
      return 'That way of signing in is not switched on for platform operators.';
    default:
      return signInErrorMessage(code, 'DryScope');
  }
}
