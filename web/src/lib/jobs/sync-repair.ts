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
// (the phone closed after the Postgres commit), so heals with no client action: within one worker
// period while one pass's bounds hold every due job (below). The grace leaves a job alone while the request that changed it is still syncing it.
//
// Each pass is bounded (at most maxCompanies companies, 100 being the most 0018's lookup returns, and
// maxJobsPerCompany jobs in each). Within a company the due jobs are taken in order of their last change
// (then id, a keyset), read in one snapshot, from a starting place that moves on by one page each
// scheduler period and wraps around, so no fixed set of jobs that keep failing (and stay the oldest) can
// hold the front of the list. A job counts as synced only once its watermark covers the version it was
// due at (its own sync, or a newer one); a job a newer write held back counts as failed and stays due. A
// company backlog beyond one pass drains over the following passes. Companies past the lookup's 100 wait
// for a later pass, the one waiting longest first: a company can wait only while more than 100 others
// each hold a job that keeps failing (a lookup paged across companies needs a migration).
//
// Only finding the companies with work crosses companies, through job_field_sync_due_companies
// (migration 0018), which returns company ids and nothing else; every job is read and synced inside
// withCompany. No Postgres transaction is held across a Firestore call.

// How long after a job's last change the pass may sync it: its request's own field step goes first.
export const SYNC_GRACE_SECONDS = 60;

// The scheduler's period (infra/dryscope/app: every five minutes): the page a pass starts on moves on once per period.
export const PASS_PERIOD_SECONDS = 300;

export type DraftRepairSummary = { synced: number; failed: number };

export type DraftRepairOptions = { maxCompanies?: number; maxJobsPerCompany?: number; graceSeconds?: number; now?: () => Date };

export async function runDraftSyncRepair(
  db: Database,
  store: DraftSync & DraftLookup,
  { maxCompanies = 100, maxJobsPerCompany = 200, graceSeconds = SYNC_GRACE_SECONDS, now = () => new Date() }: DraftRepairOptions = {},
): Promise<DraftRepairSummary> {
  const companies = await db.transaction(async (tx) => {
    const found = (await tx.execute(
      sql`SELECT job_field_sync_due_companies(${maxCompanies}::int, ${graceSeconds}::int)::text AS id`,
    )) as unknown as { id: string }[];
    return found.map((row) => row.id);
  });
  const summary: DraftRepairSummary = { synced: 0, failed: 0 };
  const period = Math.floor(now().getTime() / 1000 / PASS_PERIOD_SECONDS);
  for (const companyId of companies) {
    const due = await withCompany(db, companyId, async (tx) => {
      const isDue = and(
        eq(jobs.companyId, companyId),
        sql`${jobs.fieldSyncedRevision} < ${jobs.fieldRevision}`,
        sql`${jobs.fieldChangedAt} <= now() - make_interval(secs => ${graceSeconds})`,
      );
      const [counted] = await tx.select({ n: sql<number>`count(*)::int` }).from(jobs).where(isDue);
      const total = counted?.n ?? 0;
      if (total === 0) return [];
      // This period's starting place, then on to the end and round from the start, one page at most.
      const start = total > maxJobsPerCompany ? (period * maxJobsPerCompany) % total : 0;
      const page = (offset: number, limit: number) =>
        tx
          .select({ id: jobs.id, fieldRevision: jobs.fieldRevision })
          .from(jobs)
          .where(isDue)
          .orderBy(asc(jobs.fieldChangedAt), asc(jobs.id))
          .offset(offset)
          .limit(limit);
      const first = await page(start, maxJobsPerCompany);
      const rest = first.length < maxJobsPerCompany && start > 0 ? await page(0, Math.min(maxJobsPerCompany - first.length, start)) : [];
      // Each job once, however the two pages meet.
      return [...new Map([...first, ...rest].map((job) => [job.id, job])).values()];
    }, { snapshot: true });
    for (const job of due) {
      try {
        await syncJobDrafts(db, store, store, companyId, job.id);
        // Synced only once the watermark covers the version the job was due at.
        const [after] = await withCompany(db, companyId, (tx) =>
          tx
            .select({ covered: sql<boolean>`${jobs.fieldSyncedRevision} >= ${job.fieldRevision}` })
            .from(jobs)
            .where(and(eq(jobs.companyId, companyId), eq(jobs.id, job.id))),
        );
        if (after?.covered) summary.synced += 1;
        else summary.failed += 1;
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
