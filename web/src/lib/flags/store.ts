import { sql } from 'drizzle-orm';
import { auditEvents, companyFeatureFlags } from '@/db/schema';
import { withOperator, type Database } from '@/db/tenant';
import { FlagRefusal, isFlagName } from './known';
import type { FlagChangeStore } from './change';

// The Postgres store behind changeCompanyFlag (S3-11b). It runs in withOperator (migration 0006)
// with the operator id from the verified operator sign-in and the company set for the transaction,
// so migration 0008's policies let the write through for an active operator and for nobody else.
// The company row is locked first: two changes to one company's flags run one after the other, so
// each audit row's "previous" is the value the other left. The flag and its one audit row commit
// together or not at all.
export function postgresFlagStore(db: Database, operatorId: string): FlagChangeStore {
  return {
    inCompany(companyId, run) {
      return withOperator(
        db,
        operatorId,
        async (tx) => {
          const found = (await tx.execute(
            sql`SELECT id FROM companies WHERE id = ${companyId}::uuid FOR UPDATE`,
          )) as unknown as unknown[];
          if (found.length === 0) throw new FlagRefusal('company_not_found');
          return run({
            async stored(flag) {
              const [row] = (await tx.execute(
                sql`SELECT enabled FROM company_feature_flags WHERE company_id = ${companyId}::uuid AND flag = ${flag}`,
              )) as unknown as { enabled: boolean }[];
              return row?.enabled === true;
            },
            async write(row) {
              // A known name only: the store is the last stop before the table.
              if (!isFlagName(row.flag)) throw new FlagRefusal('unknown_flag');
              await tx
                .insert(companyFeatureFlags)
                .values({ companyId, flag: row.flag, enabled: row.enabled, updatedByOperatorId: row.updatedByOperatorId })
                .onConflictDoUpdate({
                  target: [companyFeatureFlags.companyId, companyFeatureFlags.flag],
                  set: { enabled: row.enabled, updatedByOperatorId: row.updatedByOperatorId, updatedAt: sql`now()` },
                });
            },
            async audit(event) {
              await tx.insert(auditEvents).values({
                companyId,
                actorId: null,
                operatorActorId: event.operatorActorId,
                action: event.action,
                target: event.target,
                details: event.details,
              });
            },
          });
        },
        { companyId },
      );
    },
  };
}
