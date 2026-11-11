// What the second-step screens say, decided from fixed codes only: the Firebase error code of a
// failed code check or enrolment. Nothing the person typed (a code) and no secret key or token ever
// goes into a message. Pure functions, so they are unit-tested.

// The name an enrolled authenticator app is saved under, so a person with a spare can tell them
// apart when Firebase asks which one to use.
export function authenticatorName(alreadyEnrolled: number): string {
  return alreadyEnrolled <= 0 ? 'Authenticator app' : `Authenticator app ${alreadyEnrolled + 1}`;
}

// The six digits of a typed code, or null. Authenticator apps show a code as "123 456", and a phone
// keyboard may add spaces or dashes, so those are dropped.
export function normalizeCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

export const CODE_SHAPE_MESSAGE = 'Enter the 6-digit code from your authenticator app.';

// The otpauth address an authenticator app reads from a QR code, or opens from a link on the same
// phone (https://github.com/google/google-authenticator/wiki/Key-Uri-Format). Built here, with every
// part encoded, rather than by the Firebase SDK, which leaves the account name unencoded.
export function authenticatorUri(parts: {
  issuer: string;
  account: string;
  secret: string;
  digits: number;
  periodSeconds: number;
  algorithm: string;
}): string {
  const issuer = encodeURIComponent(parts.issuer);
  const label = `${issuer}:${encodeURIComponent(parts.account)}`;
  const query = [
    `secret=${encodeURIComponent(parts.secret)}`,
    `issuer=${issuer}`,
    `algorithm=${encodeURIComponent(parts.algorithm)}`,
    `digits=${parts.digits}`,
    `period=${parts.periodSeconds}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}

// A typed key in groups of four, which is how an authenticator app shows it and easier to read
// aloud or copy by eye on a phone.
export function groupedKey(key: string): string {
  return key.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ');
}

// Errors after which the step cannot continue and has to start again: the pending sign-in or the
// enrolment's secret is no longer valid.
export function secondStepExpired(code: unknown): boolean {
  return (
    code === 'auth/invalid-multi-factor-session' ||
    code === 'auth/code-expired' ||
    code === 'auth/invalid-verification-id' ||
    code === 'auth/user-token-expired'
  );
}

export function codeErrorMessage(code: unknown): string {
  switch (code) {
    case 'auth/invalid-verification-code':
      return 'That code did not match. Wait for a new code in your authenticator app, then try again.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes, then try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your signal, then try again.';
    case 'auth/user-disabled':
      return 'This account is turned off. Ask the owner of your company.';
    case 'auth/invalid-multi-factor-session':
    case 'auth/code-expired':
    case 'auth/invalid-verification-id':
    case 'auth/user-token-expired':
      return 'That sign-in timed out. Go back and sign in again.';
    default:
      return 'The code could not be checked. Try again.';
  }
}

export function enrolErrorMessage(code: unknown): string {
  switch (code) {
    case 'auth/invalid-verification-code':
      return 'That code did not match. Wait for a new code in your authenticator app, then try again.';
    case 'auth/code-expired':
    case 'auth/invalid-verification-id':
    case 'auth/invalid-multi-factor-session':
      return 'This setup timed out. Start again to get a new key.';
    case 'auth/requires-recent-login':
    case 'auth/user-token-expired':
      return 'For your safety, sign in again before changing your second step.';
    case 'auth/unverified-email':
      return 'Verify your email address first, then set up your authenticator app.';
    case 'auth/maximum-second-factor-count-exceeded':
      return 'This account already has as many authenticator apps as it can have.';
    case 'auth/second-factor-already-in-use':
      return 'That authenticator app is already set up for this account.';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a few minutes, then try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your signal, then try again.';
    case 'auth/operation-not-allowed':
      return 'An authenticator app is not switched on for this company yet. Contact DryScope support.';
    default:
      return 'The authenticator app could not be set up. Try again.';
  }
}

// After these an enrolment cannot be finished from this screen: the person signs in again.
export function enrolNeedsFreshSignIn(code: unknown): boolean {
  return code === 'auth/requires-recent-login' || code === 'auth/user-token-expired';
}
