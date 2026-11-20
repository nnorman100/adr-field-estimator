import { and, asc, eq, sql } from 'drizzle-orm';
import { isQueueTimeout } from '@/db/client';
import { jobs } from '@/db/schema';
import { withCompany, type Database } from '@/db/tenant';
import type { DraftSync } from './draft-sync';
import type { DraftLookup } from './drafts';
import { syncJobDrafts } from './sync-job';

// The draft sync's repair pass (the draft life-cycle redesign, Design 2), run in the scheduled worker
// pass beside the access projection and the Submit repair: every job whose drafts Postgres has moved
// past (jobs.field_synced_revision below jobs.field_revision, migration 0018), and whose last change is
// older than the grace, is synced again. A field step that failed, or whose request was abandoned
// (the phone closed after the Postgres commit), so heals within one worker period with no client
// action. The grace leaves a job alone while the request that changed it is still syncing it.
//
// Only finding the companies with work crosses companies, through job_field_sync_due_companies
// (migration 0018), which returns company ids and nothing else; every job is read and synced inside
// withCompany. No Postgres transaction is held across a Firestore call.

// How long after a job's last change the pass may sync it: its request's own field step goes first.
export const SYNC_GRACE_SECONDS = 60;

export type DraftRepairSummary = { synced: number; failed: number };

export type DraftRepairOptions = { maxCompanies?: number; maxJobsPerCompany?: number; graceSeconds?: number };

export async function runDraftSyncRepair(
  db: Database,
  store: DraftSync & DraftLookup,
  { maxCompanies = 50, maxJobsPerCompany = 200, graceSeconds = SYNC_GRACE_SECONDS }: DraftRepairOptions = {},
): Promise<DraftRepairSummary> {
  const companies = await db.transaction(async (tx) => {
    const found = (await tx.execute(
      sql`SELECT job_field_sync_due_companies(${maxCompanies}::int, ${graceSeconds}::int)::text AS id`,
    )) as unknown as { id: string }[];
    return found.map((row) => row.id);
  });
  const summary: DraftRepairSummary = { synced: 0, failed: 0 };
  for (const companyId of companies) {
    const due = await withCompany(db, companyId, (tx) =>
      tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.companyId, companyId),
            sql`${jobs.fieldSyncedRevision} < ${jobs.fieldRevision}`,
            sql`${jobs.fieldChangedAt} <= now() - make_interval(secs => ${graceSeconds})`,
          ),
        )
        .orderBy(asc(jobs.fieldChangedAt))
        .limit(maxJobsPerCompany),
    );
    for (const job of due) {
      try {
        await syncJobDrafts(db, store, store, companyId, job.id);
        summary.synced += 1;
      } catch (error) {
        // No free database connection in time: the pass ends, and the next one runs it again.
        if (isQueueTimeout(error)) throw error;
        // Fixed text only: the SDK's message may quote a path. The job stays due for the next pass.
        console.error('job draft repair failed', error instanceof Error ? error.name : 'unknown');
        summary.failed += 1;
      }
    }
  }
  return summary;
}
