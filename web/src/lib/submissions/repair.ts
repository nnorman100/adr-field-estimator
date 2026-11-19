import { and, eq, or, sql } from 'drizzle-orm';
import { isLockTimeout } from '@/db/client';
import { auditEvents, jobSubmissions } from '@/db/schema';
import { withCompany, type Database } from '@/db/tenant';
import { lockedJob } from '@/lib/jobs/access';
import type { FenceStore } from './fence';
import { abortPending, writeMarker, type DecidedRow } from './service';

// The Submit side of the S3-12 worker (docs/plans/S5.md, section 4, step 6), run in the same
// scheduled pass as the access projection. It never decides a row that could still commit before
// its expiry, and it releases a fence only for a row that is aborted:
//
// - A `pending` row past its expiry is aborted (a conditional update, so a request that commits
//   first wins and the worker changes nothing), then its draft goes back to `editing`, for that
//   epoch only.
// - A decided row whose marker is still unwritten after the grace (the request that decided it
//   died or could not reach Firestore) gets its marker: `submitted` after a commit, `editing` after
//   an abort.
// - An aborted row whose marker is written and whose expiry passed within the last REOPEN_SECONDS
//   has its release written again, so a draft still fenced by that epoch goes back to `editing`.
//   Only companies the lookup returns for other work are visited for this.
// - A pending row whose lock, or whose job's, another transaction still holds past the lock limit
//   (a fence call in progress) is left for the next pass and counted as failed; the pass goes on
//   with the rest. The job row is locked before the submission row, as in every request.
//
// Only finding the companies with work crosses companies, through job_submission_due_companies
// (migration 0011), which returns company ids and nothing else. Every row is read and changed inside
// withCompany. No Postgres transaction is held across a Firestore call.

// A decided row's marker is the deciding request's to write first; the worker waits this long.
export const MARKER_GRACE_SECONDS = 60;

// How long after an aborted row's expiry the worker still writes its release again.
export const REOPEN_SECONDS = 15 * 60;

export type RepairSummary = { aborted: number; marked: number; failed: number };

export type RepairOptions = { maxCompanies?: number; maxRowsPerCompany?: number; markerGraceSeconds?: number };

export async function runSubmissionRepair(
  db: Database,
  store: FenceStore,
  { maxCompanies = 50, maxRowsPerCompany = 200, markerGraceSeconds = MARKER_GRACE_SECONDS }: RepairOptions = {},
): Promise<RepairSummary> {
  const companies = await db.transaction(async (tx) => {
    const found = (await tx.execute(
      sql`SELECT job_submission_due_companies(${maxCompanies}::int, ${markerGraceSeconds}::int)::text AS id`,
    )) as unknown as { id: string }[];
    return found.map((row) => row.id);
  });
  const summary: RepairSummary = { aborted: 0, marked: 0, failed: 0 };
  for (const companyId of companies) {
    const due = await withCompany(db, companyId, (tx) =>
      tx
        .select({
          id: jobSubmissions.id,
          jobId: jobSubmissions.jobId,
          draftId: jobSubmissions.draftId,
          epoch: jobSubmissions.epoch,
          status: jobSubmissions.status,
        })
        .from(jobSubmissions)
        .where(
          and(
            eq(jobSubmissions.companyId, companyId),
            or(
              and(eq(jobSubmissions.status, 'pending'), sql`${jobSubmissions.expiresAt} <= now()`),
              and(
                sql`${jobSubmissions.status} <> 'pending'`,
                eq(jobSubmissions.markerState, 'pending'),
                sql`${jobSubmissions.decidedAt} <= now() - make_interval(secs => ${markerGraceSeconds})`,
              ),
            ),
          ),
        )
        .orderBy(jobSubmissions.createdAt)
        .limit(maxRowsPerCompany),
    );
    for (const found of due) {
      let row: DecidedRow = found;
      if (row.status === 'pending') {
        const decided = await withCompany(db, companyId, async (tx) => {
          // The job row first, as every request takes it, before the submission row, so a request
          // holding the job never waits on a submission row the worker holds while the worker waits
          // on the job (the draft life-cycle redesign's field-revision trigger will lock the job row
          // whenever a submission's status moves).
          await lockedJob(tx, companyId, row.jobId);
          const aborted = await abortPending(tx, companyId, row.id);
          if (aborted) {
            await tx
              .insert(auditEvents)
              .values({ companyId, actorId: null, action: 'submission_aborted', target: row.jobId, details: { reason: 'expired' } });
          }
          const [now] = await tx
            .select({ status: jobSubmissions.status })
            .from(jobSubmissions)
            .where(and(eq(jobSubmissions.companyId, companyId), eq(jobSubmissions.id, row.id)));
          return { aborted, status: now!.status };
        }).catch((error: unknown) => {
          if (!isLockTimeout(error)) throw error;
          return null;
        });
        if (!decided) {
          summary.failed += 1;
          continue;
        }
        if (decided.aborted) summary.aborted += 1;
        row = { ...row, status: decided.status };
      }
      if (await writeMarker(db, store, companyId, row, { scheduled: true })) summary.marked += 1;
      else summary.failed += 1;
    }
    const reopen = await withCompany(db, companyId, (tx) =>
      tx
        .select({ draftId: jobSubmissions.draftId, epoch: jobSubmissions.epoch })
        .from(jobSubmissions)
        .where(
          and(
            eq(jobSubmissions.companyId, companyId),
            eq(jobSubmissions.status, 'aborted'),
            eq(jobSubmissions.markerState, 'done'),
            sql`${jobSubmissions.expiresAt} <= now()`,
            sql`${jobSubmissions.expiresAt} > now() - make_interval(secs => ${REOPEN_SECONDS})`,
          ),
        )
        .orderBy(jobSubmissions.createdAt)
        .limit(maxRowsPerCompany),
    );
    for (const row of reopen) {
      try {
        if ((await store.release(companyId, row.draftId, row.epoch)) === 'released') summary.marked += 1;
      } catch (error) {
        console.error('submission marker unavailable', error instanceof Error ? error.name : 'unknown');
        summary.failed += 1;
      }
    }
  }
  return summary;
}
