import { and, desc, eq, sql } from 'drizzle-orm';
import { actors, companies, memberships } from '@/db/schema';
import { withCompany, type Database } from '@/db/tenant';
import type { IdentityDirectory, MemberRecord } from './identity';

// The sign-in records in Postgres. The company comes from sign_in_company (migration 0004), the
// one lookup allowed before a company is known; everything else is read inside withCompany, so
// the row-level security policies of 0003 limit it to that company. Both reads run in read-only
// transactions, so a refused request cannot write anything.
export function databaseDirectory(db: Database): IdentityDirectory {
  return {
    async companyForTenant(tenant) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const rows = (await tx.execute(sql`SELECT sign_in_company(${tenant})::text AS id`)) as unknown as {
          id: string | null;
        }[];
        return rows[0]?.id ?? null;
      });
    },

    async member(companyId, tenant, uid): Promise<MemberRecord | null> {
      return withCompany(db, companyId, async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const [company] = await tx
          .select({ id: companies.id, name: companies.name, status: companies.status })
          .from(companies)
          .where(eq(companies.id, companyId));
        if (!company) return null;

        // The tenant is implied by the company (a foreign key); naming it uses the (tenant, uid) key.
        const [actor] = await tx
          .select({ id: actors.id, displayName: actors.displayName })
          .from(actors)
          .where(and(eq(actors.companyId, companyId), eq(actors.authTenantId, tenant), eq(actors.uid, uid)));
        if (!actor) return { company, actor: null, membership: null };

        // At most one membership is active (a unique index); otherwise the newest disabled one.
        const [membership] = await tx
          .select({ role: memberships.role, status: memberships.status })
          .from(memberships)
          .where(and(eq(memberships.companyId, companyId), eq(memberships.actorId, actor.id)))
          .orderBy(sql`${memberships.status} = 'active' DESC`, desc(memberships.updatedAt))
          .limit(1);
        return { company, actor, membership: membership ?? null };
      });
    },
  };
}
