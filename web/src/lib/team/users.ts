import { getAuth } from 'firebase-admin/auth';
import { firebaseApp } from '@/lib/auth/firebase';
import type { IdentityConfig } from '@/lib/config';

// The two changes team actions make to a company's sign-in tenant, through firebase-admin with the
// service's own credentials. In the cloud those hold only the narrow dryscopeIdentity<Env> role on
// each company tenant (infra/dryscope, S3-5): users.get, users.create, users.update and
// users.sendEmail, never delete and never tenant settings.
//
//   ensureAccount   An invitation needs a sign-in account for its email in the company's tenant,
//                   because public sign-up is off (owner decision D11: invitation link only). The
//                   account is made with no password and an unverified email, so nobody but the
//                   invitee can ever sign in with it: they set their own password through the
//                   company sign-in page, which proves they hold the email. An existing account
//                   for the email is left as it is.
//   revokeSessions  Signs a disabled member out everywhere: every token issued before now fails
//                   the revocation check that every request runs (lib/auth/firebase.ts).
//
// Error text from the SDK can quote the email, so only a fixed error leaves this file.
export type TenantUsers = {
  ensureAccount(tenant: string, email: string): Promise<void>;
  revokeSessions(tenant: string, uid: string): Promise<void>;
};

export class TenantUsersUnavailable extends Error {
  constructor() {
    super('The sign-in accounts could not be changed');
    this.name = 'TenantUsersUnavailable';
  }
}

// Identity Platform tenant ids are short strings of letters, digits and hyphens.
const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export function firebaseTenantUsers(config: IdentityConfig): TenantUsers {
  const auth = getAuth(firebaseApp(config));
  const forTenant = (tenant: string) => {
    if (!TENANT_ID.test(tenant)) throw new TenantUsersUnavailable();
    return auth.tenantManager().authForTenant(tenant);
  };
  return {
    async ensureAccount(tenant, email) {
      const users = forTenant(tenant);
      try {
        await users.getUserByEmail(email);
        return;
      } catch (error) {
        if (errorCode(error) !== 'auth/user-not-found') throw new TenantUsersUnavailable();
      }
      try {
        await users.createUser({ email, emailVerified: false, disabled: false });
      } catch (error) {
        // Made by a call that ran at the same moment: the account exists, which is all we need.
        if (errorCode(error) !== 'auth/email-already-exists') throw new TenantUsersUnavailable();
      }
    },
    async revokeSessions(tenant, uid) {
      try {
        await forTenant(tenant).revokeRefreshTokens(uid);
      } catch (error) {
        // An account that no longer exists has no sessions left: its tokens already fail the
        // revocation check (lib/auth/firebase.ts maps that to sign_in_revoked).
        if (errorCode(error) === 'auth/user-not-found') return;
        throw new TenantUsersUnavailable();
      }
    },
  };
}
