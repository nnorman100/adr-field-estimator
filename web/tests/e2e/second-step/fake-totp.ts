import type { Page, Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';

// Stands in for Identity Platform's authenticator-app (TOTP) second step, which the Auth emulator
// cannot do (tests/emu/totp.test.ts records that it refuses TOTP enrolment). The real Firebase
// client runs in the page as it does in production; only its network calls for the second step
// are answered here, at the boundary, and everything else (the password check, user lookups, the
// dev server's own /api/me check of the token) goes to the real emulator and server. The real flow
// is proved against a `test` tenant in S3-18, apart from these mock results.
//
// The "authenticator app" always shows APP_CODE. A token handed out after a second step carries
// `firebase.sign_in_second_factor = "totp"`, as Identity Platform's does, so the server's rules
// (S3-8) judge it. The emulator's tokens are unsigned, so adding that claim is enough for its
// Admin SDK; no real signing key is involved.

export const APP_CODE = '123456';
export const SETUP_KEY = 'JBSWY3DPEHPK3PXP';

type Factor = { id: string; name: string };

// The fields of the Identity Toolkit requests the fake reads.
type Body = {
  mfaPendingCredential?: string;
  mfaEnrollmentId?: string;
  idToken?: string;
  displayName?: string;
  totpVerificationInfo?: { verificationCode?: string };
};

export type FakeSecondStepOptions = {
  // The authenticator apps the person already has.
  factors?: string[];
  // Whether the tokens issued when an authenticator app is set up carry the second-factor claim.
  // Identity Platform's behaviour here is only known from S3-18, so the screens work either way.
  enrolmentTokenCarriesSecondFactor?: boolean;
};

export type FakeSecondStep = {
  factors: Factor[];
  // The calls the page made to the second-step endpoints, in order.
  calls: string[];
  // The enrolment ids a sign-in code was checked against.
  checkedFactors: string[];
  // Every "start setting up" fails as a sign-in that is too old. (The dev server runs each effect
  // twice, so one failure would be eaten by the call whose answer the page ignores.)
  setupFailsAsTooOld: boolean;
  // The next code check at sign-in fails as a pending sign-in that timed out.
  expireNextSignIn: boolean;
  // An operator resetting the second step (owner decision D9): the person has none afterwards.
  reset(): void;
};

function parseToken(token: string): { header: string; payload: Record<string, unknown> } {
  const [header, payload] = token.split('.');
  return {
    header: header!,
    payload: JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')),
  };
}

// The same unsigned emulator token with the second-factor claim added.
function withSecondFactor(token: string): string {
  const { header, payload } = parseToken(token);
  const firebase = {
    ...(payload.firebase as Record<string, unknown>),
    sign_in_second_factor: 'totp',
  };
  return [
    header,
    Buffer.from(JSON.stringify({ ...payload, firebase })).toString('base64url'),
    '',
  ].join('.');
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });

// An error in the shape the Identity Toolkit API answers with; the client maps `message` to a code.
const failure = (route: Route, message: string) =>
  json(route, { error: { code: 400, message, errors: [{ message }] } }, 400);

const info = (factor: Factor) => ({
  mfaEnrollmentId: factor.id,
  displayName: factor.name,
  enrolledAt: new Date().toISOString(),
  totpInfo: {},
});

export async function fakeSecondStep(
  page: Page,
  options: FakeSecondStepOptions = {},
): Promise<FakeSecondStep> {
  const fake: FakeSecondStep = {
    factors: (options.factors ?? []).map((name) => ({ id: randomUUID(), name })),
    calls: [],
    checkedFactors: [],
    setupFailsAsTooOld: false,
    expireNextSignIn: false,
    reset() {
      this.factors = [];
    },
  };
  // What the real emulator answered to the first step of a pending second-step sign-in.
  const pending = new Map<string, { idToken: string; refreshToken: string }>();
  let refreshToken = 'unused';

  await page.route(/\/identitytoolkit\.googleapis\.com\//, async (route) => {
    try {
      await answer(route);
    } catch (error) {
      // The test ended while a call was in flight: the page is gone and there is nobody to answer.
      const ending = /disposed|closed|Test ended/i.test(
        error instanceof Error ? error.message : '',
      );
      if (!ending && !page.isClosed()) throw error;
    }
  });

  async function answer(route: Route) {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() !== 'POST') return route.continue();
    const body = (request.postDataJSON() ?? {}) as Body;

    if (pathname.endsWith('/v1/accounts:signInWithPassword')) {
      const real = await route.fetch();
      const answer = (await real.json()) as Record<string, unknown>;
      if (
        !real.ok() ||
        typeof answer.idToken !== 'string' ||
        typeof answer.refreshToken !== 'string'
      ) {
        return route.fulfill({ response: real, json: answer });
      }
      refreshToken = answer.refreshToken;
      if (fake.factors.length === 0) return route.fulfill({ response: real, json: answer });
      // A person with a second step gets no session from the password alone.
      const mfaPendingCredential = randomUUID();
      pending.set(mfaPendingCredential, {
        idToken: answer.idToken,
        refreshToken: answer.refreshToken,
      });
      const session = { ...answer };
      delete session.idToken;
      delete session.refreshToken;
      delete session.expiresIn;
      return route.fulfill({
        response: real,
        json: { ...session, mfaPendingCredential, mfaInfo: fake.factors.map(info) },
      });
    }

    if (pathname.endsWith('/v2/accounts/mfaSignIn:finalize')) {
      fake.calls.push('mfaSignIn:finalize');
      fake.checkedFactors.push(String(body.mfaEnrollmentId));
      if (fake.expireNextSignIn) {
        fake.expireNextSignIn = false;
        return failure(route, 'INVALID_MFA_PENDING_CREDENTIAL');
      }
      const first = pending.get(String(body.mfaPendingCredential));
      if (!first) return failure(route, 'INVALID_MFA_PENDING_CREDENTIAL');
      if (body.totpVerificationInfo?.verificationCode !== APP_CODE)
        return failure(route, 'INVALID_CODE');
      return json(route, {
        idToken: withSecondFactor(first.idToken),
        refreshToken: first.refreshToken,
      });
    }

    if (pathname.endsWith('/v2/accounts/mfaEnrollment:start')) {
      fake.calls.push('mfaEnrollment:start');
      if (fake.setupFailsAsTooOld) {
        return failure(route, 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN');
      }
      return json(route, {
        totpSessionInfo: {
          sharedSecretKey: SETUP_KEY,
          verificationCodeLength: 6,
          hashingAlgorithm: 'SHA1',
          periodSec: 30,
          sessionInfo: randomUUID(),
          finalizeEnrollmentTime: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      });
    }

    if (pathname.endsWith('/v2/accounts/mfaEnrollment:finalize')) {
      fake.calls.push('mfaEnrollment:finalize');
      if (body.totpVerificationInfo?.verificationCode !== APP_CODE)
        return failure(route, 'INVALID_CODE');
      fake.factors.push({ id: randomUUID(), name: String(body.displayName) });
      const token = String(body.idToken);
      return json(route, {
        idToken: options.enrolmentTokenCarriesSecondFactor ? withSecondFactor(token) : token,
        refreshToken,
      });
    }

    if (pathname.endsWith('/v1/accounts:lookup') && fake.factors.length > 0) {
      // The account as the phone reads it back: with its authenticator apps listed.
      const real = await route.fetch();
      const answer = (await real.json()) as { users?: Record<string, unknown>[] };
      return route.fulfill({
        response: real,
        json: {
          ...answer,
          users: (answer.users ?? []).map((user) => ({ ...user, mfaInfo: fake.factors.map(info) })),
        },
      });
    }

    return route.continue();
  }
  return fake;
}
