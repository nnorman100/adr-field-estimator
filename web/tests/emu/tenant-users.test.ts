import { getAuth } from 'firebase-admin/auth';
import { beforeAll, describe, expect, it } from 'vitest';
import { firebaseApp, firebaseTokenVerifier } from '@/lib/auth/firebase';
import { IdentityRefusal, type TokenVerifier } from '@/lib/auth/identity';
import { parseIdentityConfig, type IdentityConfig } from '@/lib/config';
import { firebaseTenantUsers, type TenantUsers } from '@/lib/team/users';
import { createTenant, markEmailVerified, projectId, signIn, signUp } from './auth-emulator';

// The two changes team actions make to a company's sign-in tenant, against the Auth emulator with
// the same firebase-admin code the server runs: making an invitee's account and signing a disabled
// member out. tests/db/team-*.test.ts replace these with a fake.

let config: IdentityConfig;
let users: TenantUsers;
let verifier: TokenVerifier;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  config = parseIdentityConfig({
    APP_ENV: 'local',
    GOOGLE_CLOUD_PROJECT: projectId,
    FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
  });
  users = firebaseTenantUsers(config);
  verifier = firebaseTokenVerifier(config);
  tenantA = await createTenant('team-a');
  tenantB = await createTenant('team-b');
});

const tenantAuth = (tenant: string) => getAuth(firebaseApp(config)).tenantManager().authForTenant(tenant);

describe('invitee accounts', () => {
  it('makes one account with no password and an unverified email, in that tenant only', async () => {
    await users.ensureAccount(tenantA, 'invitee@example.test');
    const made = await tenantAuth(tenantA).getUserByEmail('invitee@example.test');
    expect(made.emailVerified).toBe(false);
    expect(made.passwordHash).toBeUndefined();
    expect(made.tenantId).toBe(tenantA);

    // Again (a resend): the same account, unchanged.
    await users.ensureAccount(tenantA, 'invitee@example.test');
    expect((await tenantAuth(tenantA).getUserByEmail('invitee@example.test')).uid).toBe(made.uid);

    await expect(tenantAuth(tenantB).getUserByEmail('invitee@example.test')).rejects.toMatchObject({ code: 'auth/user-not-found' });
  });

  it('leaves an existing account as it is', async () => {
    const uid = await signUp(tenantA, 'existing@example.test', 'a-long-test-password');
    await markEmailVerified(tenantA, uid);
    await users.ensureAccount(tenantA, 'existing@example.test');
    const found = await tenantAuth(tenantA).getUserByEmail('existing@example.test');
    expect(found.uid).toBe(uid);
    expect(found.emailVerified).toBe(true);
  });
});

describe('revoking a member’s sessions', () => {
  it('makes every earlier token fail the revocation check', async () => {
    const uid = await signUp(tenantA, 'member@example.test', 'a-long-test-password');
    await markEmailVerified(tenantA, uid);
    const idToken = await signIn(tenantA, 'member@example.test', 'a-long-test-password');
    await expect(verifier.verifyNotRevoked(idToken, tenantA)).resolves.toMatchObject({ uid });

    // Revocation is recorded in whole seconds and refuses tokens signed in before that second.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await users.revokeSessions(tenantA, uid);
    await expect(verifier.verifyNotRevoked(idToken, tenantA)).rejects.toEqual(new IdentityRefusal('sign_in_revoked'));
  });

  it('treats an account that no longer exists as signed out', async () => {
    await expect(users.revokeSessions(tenantB, 'no-such-user')).resolves.toBeUndefined();
  });
});
