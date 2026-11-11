import { sql } from 'drizzle-orm';
import type { Database } from '@/db/tenant';
import type { SignInDirectory } from './directory';

// The company sign-in page's lookup in Postgres: sign_in_company_page (migration 0007), the one read
// of a company by its address the runtime may make before a company is known. It returns the name
// and sign-in tenant of an active company with a tenant, and no row for anything else. Read-only,
// so a public request can never write.
export function databaseSignInDirectory(db: Database): SignInDirectory {
  return {
    async pageFor(address) {
      return db.transaction(
        async (tx) => {
          const rows = (await tx.execute(
            sql`SELECT company_name, tenant_id FROM sign_in_company_page(${address}::text)`,
          )) as unknown as { company_name: string; tenant_id: string }[];
          const row = rows[0];
          return row ? { companyName: row.company_name, tenantId: row.tenant_id } : null;
        },
        { accessMode: 'read only' },
      );
    },
  };
}
