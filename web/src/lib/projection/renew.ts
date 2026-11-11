import { sql } from 'drizzle-orm';
import { withCompany, type Database } from '@/db/tenant';
import type { Identity } from '@/lib/auth/identity';
import { projectActor, RENEW_AFTER_MS, type ActorOutcome, type ProjectionOptions } from './outbox';
import type { AccessStore } from './store';

// Renews a signed-in member's access record while they use the app. Called after the sign-in check
// passed, so the membership is active now. It queues a row when the record was last written more
// than RENEW_AFTER_MS ago (or never) and nothing is waiting, then projects this one actor if any of
// its rows is due, skipping it when another run holds it. A member who stops using the app is not
// renewed, and the record stops working ACCESS_TTL_MS after it was last written.
export async function renewAccess(
  db: Database,
  store: AccessStore,
  identity: Pick<Identity, 'companyId' | 'actorId'>,
  options: ProjectionOptions = {},
): Promise<ActorOutcome | 'current'> {
  const { companyId, actorId } = identity;
  const due = await withCompany(db, companyId, async (tx) => {
    const [row] = (await tx.execute(sql`
      WITH queued AS (
        INSERT INTO access_projection_outbox (company_id, actor_id)
        SELECT ${companyId}::uuid, ${actorId}::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM access_projection_outbox
          WHERE company_id = ${companyId}::uuid AND actor_id = ${actorId}::uuid
            AND (processed_at IS NULL OR processed_at > now() - make_interval(secs => ${RENEW_AFTER_MS / 1000}))
        )
        RETURNING id
      )
      SELECT EXISTS (SELECT 1 FROM queued) OR EXISTS (
        SELECT 1 FROM access_projection_outbox
        WHERE company_id = ${companyId}::uuid AND actor_id = ${actorId}::uuid
          AND processed_at IS NULL AND available_at <= now()
      ) AS due
    `)) as unknown as { due: boolean }[];
    return row?.due === true;
  });
  if (!due) return 'current';
  return projectActor(db, store, companyId, actorId, { ...options, wait: false });
}
