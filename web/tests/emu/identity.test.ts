import { getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Role } from '@/lib/access';
import { firebaseTokenVerifier } from '@/lib/auth/firebase';
import { IdentityRefusal, resolveIdentity, type IdentityDirectory, type TokenVerifier } from '@/lib/auth/identity';
import { parseIdentityConfig } from '@/lib/config';
import {
  call,
  createTenant,
  enrolTextMessageSecondFactor,
  markEmailVerified,
  projectId,
  signIn,
  signUp,
  tokenClaims,
} from './auth-emulator';

// Real sign-in tokens from the Auth emulator, checked by the same firebase-admin code the server
// runs. The company records are an in-memory stand-in here; tests/db/sign-in-lookup.test.ts reads
// them from Postgres.

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const COMPANY_B = '00000000-0000-4000-8000-00000000000b';

let verifier: TokenVerifier;
let tenantA: string;
let tenantB: string;
let directory: IdentityDirectory;
// The role of each uid; anyone not listed is an estimator, who needs no second step (D2). An owner
// needs an authenticator-app second step, which the emulator cannot give (tests/emu/totp.test.ts).
const roles = new Map<string, Role>();

beforeAll(async () => {
  verifier = firebaseTokenVerifier(
    parseIdentityConfig({
      APP_ENV: 'local',
      GOOGLE_CLOUD_PROJECT: projectId,
      FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    }),
  );
  tenantA = await createTenant('identity-a', {
    mfaConfig: { state: 'ENABLED', enabledProviders: ['PHONE_SMS'] },
  });
  tenantB = await createTenant('identity-b');
  const companies: Record<string, string> = { [tenantA]: COMPANY_A, [tenantB]: COMPANY_B };
  directory = {
    async companyForTenant(tenant) {
      return companies[tenant] ?? null;
    },
    async member(companyId, _tenant, uid) {
      return {
        company: { id: companyId, name: 'Synthetic company', status: 'active' },
        actor: { id: `actor-${companyId.slice(-1)}`, displayName: null },
        membership: { role: roles.get(uid) ?? 'estimator', status: 'active' },
      };
    },
  };
});

let counter = 0;
// A new user in a tenant and a fresh ID token for them.
async function user(tenant: string, verified = true): Promise<{ uid: string; idToken: string }> {
  counter += 1;
  const email = `member-${counter}@identity.example.test`;
  const password = `synthetic-password-${counter}`;
  const uid = await signUp(tenant, email, password);
  if (verified) await markEmailVerified(tenant, uid);
  return { uid, idToken: await signIn(tenant, email, password) };
}

const bearer = (idToken: string) =>
  new Request('http://localhost/api/me', { headers: { Authorization: `Bearer ${idToken}` } });

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof IdentityRefusal) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
}

const tenantAuth = (tenant: string) => getAuth(getApps().find((app) => app.name.startsWith('dryscope-identity-'))!).tenantManager().authForTenant(tenant);

describe('sign-in tokens from the Auth emulator', () => {
  it('resolves each tenant to its own company only', async () => {
    const a = await user(tenantA);
    const b = await user(tenantB);
    expect(await resolveIdentity(bearer(a.idToken), verifier, directory)).toMatchObject({ companyId: COMPANY_A, uid: a.uid, tenant: tenantA });
    expect(await resolveIdentity(bearer(b.idToken), verifier, directory)).toMatchObject({ companyId: COMPANY_B, uid: b.uid, tenant: tenantB });
  });

  it("refuses a tenant B token checked as tenant A's", async () => {
    const b = await user(tenantB);
    expect(await refusalOf(verifier.verifyNotRevoked(b.idToken, tenantA))).toBe('invalid_token');
  });

  it('refuses an unknown tenant', async () => {
    const stranger = await createTenant('identity-unknown');
    const s = await user(stranger);
    expect(await refusalOf(resolveIdentity(bearer(s.idToken), verifier, directory))).toBe('unknown_tenant');
  });

  it('refuses a token with no tenant', async () => {
    const signUpReply = await call('/v1/accounts:signUp', {
      email: 'project-level@identity.example.test',
      password: 'synthetic-password-root',
      returnSecureToken: true,
    });
    expect(signUpReply.status).toBe(200);
    const idToken = signUpReply.body.idToken as string;
    expect((await verifier.verify(idToken)).tenant).toBeNull();
    expect(await refusalOf(resolveIdentity(bearer(idToken), verifier, directory))).toBe('no_tenant');
  });

  it('refuses a revoked token', async () => {
    const a = await user(tenantA);
    // Revocation counts sign-ins strictly before the revocation second.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await tenantAuth(tenantA).revokeRefreshTokens(a.uid);
    expect(await refusalOf(resolveIdentity(bearer(a.idToken), verifier, directory))).toBe('sign_in_revoked');
  });

  it('refuses a disabled account', async () => {
    const a = await user(tenantA);
    await tenantAuth(tenantA).updateUser(a.uid, { disabled: true });
    expect(await refusalOf(resolveIdentity(bearer(a.idToken), verifier, directory))).toBe('account_disabled');
  });

  it('refuses an unverified email', async () => {
    const a = await user(tenantA, false);
    expect(await refusalOf(resolveIdentity(bearer(a.idToken), verifier, directory))).toBe('email_unverified');
  });

  it('refuses a token whose tenant claim was changed', async () => {
    const a = await user(tenantA);
    const [header, payload] = a.idToken.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { firebase: { tenant: string } };
    claims.firebase.tenant = tenantB;
    const forged = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    // The emulator's tokens are unsigned, so this proves the user lookup on the tenant: the uid
    // does not exist in tenant B.
    expect(await refusalOf(resolveIdentity(bearer(forged), verifier, directory))).toBe('sign_in_revoked');
  });
});

describe('second-step and session rules on emulator tokens', () => {
  it('refuses an owner who signed in without a second step, and accepts an estimator', async () => {
    const owner = await user(tenantA);
    roles.set(owner.uid, 'owner');
    expect(tokenClaims(owner.idToken).auth_time).toEqual(expect.any(Number));
    expect(await refusalOf(resolveIdentity(bearer(owner.idToken), verifier, directory))).toBe('second_step_required');
    // Only a route that sets up the second step lets the owner through.
    const enrolment = { route: { secondStep: 'enrolment' as const } };
    expect(await resolveIdentity(bearer(owner.idToken), verifier, directory, enrolment)).toMatchObject({ role: 'owner' });

    const estimator = await user(tenantA);
    expect(await resolveIdentity(bearer(estimator.idToken), verifier, directory)).toMatchObject({ role: 'estimator' });
  });

  it('does not count a text-message second factor for an owner', async () => {
    const owner = await user(tenantA);
    roles.set(owner.uid, 'owner');
    const withSms = await enrolTextMessageSecondFactor(tenantA, owner.idToken, '+15555550101');
    // The token really carries the second-factor claim the rule reads; the rule refuses `phone`.
    expect((tokenClaims(withSms).firebase as Record<string, unknown>).sign_in_second_factor).toBe('phone');
    expect(await refusalOf(resolveIdentity(bearer(withSms), verifier, directory))).toBe('second_step_required');
  });

  it("reads the token's sign-in time: an estimator must sign in again after 30 days", async () => {
    const estimator = await user(tenantA);
    const authTime = tokenClaims(estimator.idToken).auth_time as number;
    const at = (seconds: number) => ({ now: () => authTime + seconds });
    const day = 24 * 60 * 60;
    expect(await resolveIdentity(bearer(estimator.idToken), verifier, directory, at(30 * day))).toMatchObject({
      role: 'estimator',
    });
    expect(await refusalOf(resolveIdentity(bearer(estimator.idToken), verifier, directory, at(30 * day + 1)))).toBe(
      'sign_in_again',
    );
    // A team or second-step change needs a sign-in in the last 15 minutes.
    const teamChange = (seconds: number) => ({ ...at(seconds), route: { freshSignIn: true } });
    expect(await resolveIdentity(bearer(estimator.idToken), verifier, directory, teamChange(15 * 60))).toBeDefined();
    expect(await refusalOf(resolveIdentity(bearer(estimator.idToken), verifier, directory, teamChange(15 * 60 + 1)))).toBe(
      'sign_in_again',
    );
  });
});
