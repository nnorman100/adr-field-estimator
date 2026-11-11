import { getAuth } from 'firebase-admin/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { firebaseApp, firebaseTokenVerifier } from '@/lib/auth/firebase';
import { IdentityRefusal, type TokenVerifier } from '@/lib/auth/identity';
import { parseIdentityConfig, type IdentityConfig } from '@/lib/config';
import { firebasePlatformUsers, type PlatformUsers } from '@/lib/platform/users';
import { createTenant, enrolTextMessageSecondFactor, markEmailVerified, projectId, signIn, signUp } from './auth-emulator';

// The operator's second-step reset (owner decision D9) against the Auth emulator, with the same
// firebase-admin code the server runs. The emulator has no authenticator-app second step (see
// totp.test.ts), so a text-message one stands in: the reset removes every enrolled factor,
// whatever its kind. tests/db/platform-routes.test.ts replaces this with a fake.

let config: IdentityConfig;
let users: PlatformUsers;
let verifier: TokenVerifier;
let tenant: string;

beforeAll(async () => {
  config = parseIdentityConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  });
  users = firebasePlatformUsers(config);
  verifier = firebaseTokenVerifier(config);
  tenant = await createTenant('reset-a', { mfaConfig: { state: 'ENABLED', enabledProviders: ['PHONE_SMS'] } });
});

describe('resetting a second step', () => {
  it('removes every enrolled factor and signs the person out', async () => {
    const uid = await signUp(tenant, 'owner@example.test', 'a-long-test-password');
    await markEmailVerified(tenant, uid);
    const idToken = await signIn(tenant, 'owner@example.test', 'a-long-test-password');
    await enrolTextMessageSecondFactor(tenant, idToken, '+16505550101');
    const auth = getAuth(firebaseApp(config)).tenantManager().authForTenant(tenant);
    expect((await auth.getUser(uid)).multiFactor?.enrolledFactors).toHaveLength(1);

    // Revocation is recorded in whole seconds and refuses tokens signed in before that second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await users.resetSecondStep(tenant, uid);
    expect((await auth.getUser(uid)).multiFactor?.enrolledFactors ?? []).toEqual([]);
    await expect(verifier.verifyNotRevoked(idToken, tenant)).rejects.toEqual(new IdentityRefusal('sign_in_revoked'));
  });

  it('fails with a fixed error for an account that does not exist', async () => {
    await expect(users.resetSecondStep(tenant, 'no-such-user')).rejects.toMatchObject({ name: 'TenantUsersUnavailable' });
  });
});
