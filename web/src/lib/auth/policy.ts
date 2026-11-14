import type { Role } from '@/lib/access';
import type { RefusalCode } from './identity';

// Second-step and session-age rules, from the owner's S3 decisions (2026-11-09):
//   D1  the second step is an authenticator app (TOTP) only;
//   D2  owners, office and the platform operator must use it, estimators may opt in (office
//       added by the owner on 2026-11-14, from the sign-in security review: office users see
//       every job of the company);
//   D7  sign in again after 12 hours (operator), 14 days (owner, office) or 30 days (estimator),
//       and within the last 15 minutes for team changes and second-step changes;
//   D8  the second step is required from the first sign-in, with no grace period.
// Every value here is fixed in code. Nothing reads the environment, so no setting can widen the
// accepted factors or lengthen a session.

// Who signs in. The operator is not a company role; it signs in through its own tenant (D6).
export type SignInHolder = Role | 'operator';

// The `firebase.sign_in_second_factor` values that count as a second step. Identity Platform
// writes `totp` for an authenticator app and `phone` for a text message, which is not accepted.
export const ACCEPTED_SECOND_FACTORS: readonly string[] = Object.freeze(['totp']);

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export type SessionRule = { secondStepRequired: boolean; maxSignInAgeSeconds: number };

export const SESSION_RULES: Readonly<Record<SignInHolder, Readonly<SessionRule>>> = Object.freeze({
  operator: Object.freeze({ secondStepRequired: true, maxSignInAgeSeconds: 12 * HOUR }),
  owner: Object.freeze({ secondStepRequired: true, maxSignInAgeSeconds: 14 * DAY }),
  office: Object.freeze({ secondStepRequired: true, maxSignInAgeSeconds: 14 * DAY }),
  estimator: Object.freeze({ secondStepRequired: false, maxSignInAgeSeconds: 30 * DAY }),
});

// How recent the sign-in must be for a route that changes the team or a second step.
export const FRESH_SIGN_IN_SECONDS = 15 * 60;

// A sign-in time this far ahead of the server clock is tolerated as clock difference; further
// ahead, the token is refused.
const CLOCK_SKEW_SECONDS = 5 * 60;

// What a route declares about these rules, beside its own code (see route.ts):
//   freshSignIn  the route changes the team or a second step, so the sign-in must be fresh;
//   secondStep   'enrolment' marks the one kind of route a member who still needs a second step
//                may reach: setting one up.
export type RouteSessionRule = { freshSignIn?: boolean; secondStep?: 'enrolment' };

// From the revocation-checked token: when the person signed in (`auth_time`, seconds since the
// epoch; an ID token refreshed later keeps it) and the second factor used, if any.
export type SessionClaims = { authTime: number | null; secondFactor: string | null };

// The refusal for this sign-in, or null when the rules allow it. `now` is seconds since the epoch.
export function sessionRefusal(
  holder: SignInHolder,
  claims: SessionClaims,
  route: RouteSessionRule,
  now: number,
): RefusalCode | null {
  const rule = SESSION_RULES[holder];
  const { authTime } = claims;
  if (authTime === null || !Number.isSafeInteger(authTime) || authTime <= 0 || authTime > now + CLOCK_SKEW_SECONDS) {
    return 'invalid_token';
  }
  const age = now - authTime;
  if (age > rule.maxSignInAgeSeconds) return 'sign_in_again';

  const secondStep = claims.secondFactor !== null && ACCEPTED_SECOND_FACTORS.includes(claims.secondFactor);
  if (rule.secondStepRequired && !secondStep && route.secondStep !== 'enrolment') return 'second_step_required';

  if (route.freshSignIn === true && age > FRESH_SIGN_IN_SECONDS) return 'sign_in_again';
  return null;
}
