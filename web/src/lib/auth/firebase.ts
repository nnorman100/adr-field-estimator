import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import type { IdentityConfig } from '@/lib/config';
import { IdentityRefusal, type SessionToken, type TokenVerifier, type VerifiedToken } from './identity';

// Sign-in tokens checked with the Firebase Admin SDK. Identity Platform signs a tenant user's
// token with the project's keys, so the first check runs on the project: the SDK checks the
// signature, audience, issuer and expiry, with no user lookup, and the tenant it returns is signed.
// The revocation check must run on the tenant; on the project it cannot find a tenant user
// (docs.cloud.google.com/identity-platform/docs/multi-tenancy-managing-tenants). It runs only for
// a tenant the database knows, because the SDK keeps a client for every tenant it is asked for.
//
// Error text from the SDK can quote the token, so it is never logged or returned: only a fixed
// refusal code leaves this file.

// Identity Platform tenant ids are short strings of letters, digits and hyphens.
const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

// The tenant a token claims, read before its signature is checked. It only picks which verifier
// checks the token; that verifier refuses a token whose signed tenant differs. Outside the
// emulator it is never used to choose a tenant client before the signature is checked.
export function claimedTenant(idToken: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) throw new IdentityRefusal('invalid_token');
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new IdentityRefusal('invalid_token');
  }
  const firebase = (claims as { firebase?: unknown } | null)?.firebase;
  const tenant = (firebase as { tenant?: unknown } | null | undefined)?.tenant;
  if (tenant === undefined || tenant === null) return null;
  if (typeof tenant !== 'string' || !TENANT_ID.test(tenant)) throw new IdentityRefusal('invalid_token');
  return tenant;
}

// Firebase error codes that mean "this token is not acceptable". Any other error (network, quota,
// missing credentials) is not a refusal: it propagates and the request fails closed with 503.
const TOKEN_ERRORS: Record<string, IdentityRefusal['code']> = {
  'auth/argument-error': 'invalid_token',
  'auth/invalid-id-token': 'invalid_token',
  'auth/id-token-expired': 'invalid_token',
  'auth/mismatching-tenant-id': 'invalid_token',
  'auth/tenant-not-found': 'invalid_token',
  'auth/user-not-found': 'sign_in_revoked',
  'auth/id-token-revoked': 'sign_in_revoked',
  'auth/user-disabled': 'account_disabled',
};

function refusalFor(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const refusal = typeof code === 'string' ? TOKEN_ERRORS[code] : undefined;
  return refusal ? new IdentityRefusal(refusal) : new IdentityUnavailable();
}

export class IdentityUnavailable extends Error {
  constructor() {
    super('The sign-in check could not be completed');
    this.name = 'IdentityUnavailable';
  }
}

function verified(decoded: DecodedIdToken): VerifiedToken {
  const tenant = decoded.firebase?.tenant;
  return {
    uid: decoded.uid,
    tenant: typeof tenant === 'string' && tenant !== '' ? tenant : null,
    emailVerified: decoded.email_verified === true,
  };
}

// The SDK does not check `auth_time` (it only compares it with a revocation time), so its type is
// checked here and its value by the session rules (policy.ts). `sign_in_second_factor` is present
// only when the sign-in used a second factor. The email and name are read for invitations only.
function withSession(decoded: DecodedIdToken): SessionToken {
  const authTime: unknown = decoded.auth_time;
  const secondFactor: unknown = decoded.firebase?.sign_in_second_factor;
  return {
    ...verified(decoded),
    authTime: typeof authTime === 'number' ? authTime : null,
    secondFactor: typeof secondFactor === 'string' ? secondFactor : null,
    email: typeof decoded.email === 'string' ? decoded.email : null,
    name: typeof decoded.name === 'string' ? decoded.name : null,
  };
}

export function firebaseApp(config: IdentityConfig): App {
  // firebase-admin reads FIREBASE_AUTH_EMULATOR_HOST from the process itself, so the checked
  // config must agree with what the SDK will see.
  if ((process.env.FIREBASE_AUTH_EMULATOR_HOST ?? null) !== config.authEmulatorHost) {
    throw new IdentityUnavailable();
  }
  const name = `dryscope-identity-${config.projectId}`;
  return getApps().find((app) => app.name === name) ?? initializeApp({ projectId: config.projectId }, name);
}

export function firebaseTokenVerifier(config: IdentityConfig): TokenVerifier {
  const auth = getAuth(firebaseApp(config));
  return {
    async verify(idToken) {
      // The emulator's tokens are unsigned, and against it the SDK always looks the user up, which
      // on the project cannot find a tenant user; only there does the claimed tenant pick the client.
      let client: Pick<typeof auth, 'verifyIdToken'> = auth;
      if (config.authEmulatorHost !== null) {
        const tenant = claimedTenant(idToken);
        if (tenant) client = auth.tenantManager().authForTenant(tenant);
      }
      try {
        return verified(await client.verifyIdToken(idToken, false));
      } catch (error) {
        throw refusalFor(error);
      }
    },
    async verifyNotRevoked(idToken, tenant) {
      // A token of another tenant is refused before the user lookup; the SDK checks the tenant
      // only after it.
      if (!TENANT_ID.test(tenant) || claimedTenant(idToken) !== tenant) throw new IdentityRefusal('invalid_token');
      try {
        return withSession(await auth.tenantManager().authForTenant(tenant).verifyIdToken(idToken, true));
      } catch (error) {
        throw refusalFor(error);
      }
    },
  };
}
