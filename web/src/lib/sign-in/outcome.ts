// What the sign-in screens show, decided from fixed codes only: the server's refusal code from
// GET /api/me, and the Firebase error code of a failed sign-in. Nothing the user typed (an email or
// a password) and no token ever goes into a message. Pure functions, so they are unit-tested.

export type MeOutcome =
  | { kind: 'signed-in'; companyName: string; role: string }
  // The account's email is not verified yet ("Verify your email").
  | { kind: 'verify-email' }
  // A verified account of this company with no membership ("Accept a company invitation").
  | { kind: 'needs-invitation' }
  | { kind: 'member-disabled' }
  | { kind: 'company-inactive' }
  // The role needs an authenticator-app second step (S3-8); its screens are S3-14.
  | { kind: 'second-step' }
  // The sign-in is too old, revoked or unreadable: sign out and sign in again.
  | { kind: 'sign-in-again' }
  // The sign-in belongs to no company the server knows.
  | { kind: 'not-this-company' }
  | { kind: 'account-disabled' }
  // The check could not be made (network, 5xx): offer to try again, keep the sign-in.
  | { kind: 'unavailable' };

const REFUSAL_OUTCOMES: Record<string, MeOutcome> = {
  email_unverified: { kind: 'verify-email' },
  not_a_member: { kind: 'needs-invitation' },
  member_disabled: { kind: 'member-disabled' },
  company_inactive: { kind: 'company-inactive' },
  second_step_required: { kind: 'second-step' },
  sign_in_again: { kind: 'sign-in-again' },
  sign_in_revoked: { kind: 'sign-in-again' },
  invalid_token: { kind: 'sign-in-again' },
  missing_token: { kind: 'sign-in-again' },
  no_tenant: { kind: 'not-this-company' },
  unknown_tenant: { kind: 'not-this-company' },
  account_disabled: { kind: 'account-disabled' },
};

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// GET /api/me's answer as a screen. An answer of an unexpected shape is treated as unavailable,
// never as signed in.
export function meOutcome(status: number, body: unknown): MeOutcome {
  if (status === 200) {
    const companyName = field(field(body, 'company'), 'name');
    const role = field(body, 'role');
    if (typeof companyName === 'string' && typeof role === 'string') return { kind: 'signed-in', companyName, role };
    return { kind: 'unavailable' };
  }
  if (status === 401 || status === 403) {
    const code = field(body, 'error');
    if (typeof code === 'string' && Object.hasOwn(REFUSAL_OUTCOMES, code)) return REFUSAL_OUTCOMES[code]!;
    return status === 401 ? { kind: 'sign-in-again' } : { kind: 'unavailable' };
  }
  return { kind: 'unavailable' };
}

// Outcomes after which this phone should not keep the sign-in.
export function endsSession(
  outcome: MeOutcome,
): outcome is Extract<MeOutcome, { kind: 'sign-in-again' | 'not-this-company' | 'account-disabled' }> {
  return outcome.kind === 'sign-in-again' || outcome.kind === 'not-this-company' || outcome.kind === 'account-disabled';
}

// The words for a failed Firebase sign-in or email request, or null when there is nothing to say
// (the person closed the Google window).
export function signInErrorMessage(code: unknown, companyName: string): string | null {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return `That email and password do not match a ${companyName} account.`;
    case 'auth/invalid-email':
      return 'Enter a valid email address.';
    case 'auth/missing-email':
      return 'Enter your email address.';
    case 'auth/missing-password':
      return 'Enter your password.';
    // The company's password rule (at least 12 characters, owner decision 2026-11-14) is newer than
    // this password, so Firebase wants a new one before it lets the person in.
    case 'auth/password-does-not-meet-requirements':
      return `${companyName} now needs a password of at least 12 characters. Choose Set your own password to pick a new one.`;
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes, then try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your signal, then try again.';
    case 'auth/user-disabled':
      return `This account is turned off. Ask the owner of ${companyName}.`;
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window. Allow pop-ups for this site, then try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return null;
    case 'auth/admin-restricted-operation':
      return `There is no ${companyName} account for that Google sign-in. Use the email address your invitation was sent to.`;
    case 'auth/account-exists-with-different-credential':
      return 'That email address signs in with a password. Use your email and password instead.';
    case 'auth/operation-not-allowed':
      return `That way of signing in is not switched on for ${companyName} yet.`;
    default:
      return 'Sign-in did not work. Try again.';
  }
}

// The code of a thrown Firebase error, without reading its message (which can quote the email).
export function errorCode(error: unknown): string | null {
  const code = field(error, 'code');
  return typeof code === 'string' ? code : null;
}
