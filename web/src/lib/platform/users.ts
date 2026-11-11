import { getAuth } from 'firebase-admin/auth';
import { firebaseApp } from '@/lib/auth/firebase';
import type { IdentityConfig } from '@/lib/config';
import { firebaseTenantUsers, TenantUsersUnavailable, type TenantUsers } from '@/lib/team/users';

// What the operator's actions change in a company's sign-in tenant, with the service's own
// credentials, which hold only the narrow per-tenant user role (S3-5): users.get, users.create,
// users.update and users.sendEmail. The team's two calls (ensureAccount for an owner invitation,
// revokeSessions for a replaced owner) plus:
//
//   resetSecondStep  Owner decision D9: removes every second step the person enrolled (an
//                    authenticator app) and signs them out everywhere, so their next sign-in must
//                    enrol again (D8). Both are user updates; nothing needs more than users.update.
//
// Error text from the SDK can quote the email, so only a fixed error leaves this file.
export type PlatformUsers = TenantUsers & {
  resetSecondStep(tenant: string, uid: string): Promise<void>;
};

const TENANT_ID = /^[A-Za-z0-9-]{1,128}$/;

export function firebasePlatformUsers(config: IdentityConfig): PlatformUsers {
  const auth = getAuth(firebaseApp(config));
  return {
    ...firebaseTenantUsers(config),
    async resetSecondStep(tenant, uid) {
      if (!TENANT_ID.test(tenant)) throw new TenantUsersUnavailable();
      const users = auth.tenantManager().authForTenant(tenant);
      try {
        await users.updateUser(uid, { multiFactor: { enrolledFactors: null } });
        await users.revokeRefreshTokens(uid);
      } catch {
        throw new TenantUsersUnavailable();
      }
    },
  };
}
