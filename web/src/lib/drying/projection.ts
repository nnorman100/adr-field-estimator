import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { jobCloses } from '@/db/drying-schema';
import { companyFeatureFlags } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { flagsFromRows } from '@/lib/flags';
import type { JobRow } from '@/lib/jobs/access';
import { databaseNow, watchStatesOf } from './watch-service';
import type { WatchStatus } from './watch';

// What a jobs list row shows of a signed job's outcome (S5b-10 slice 10B): the close's status and date
// with the `estimate_assist` switch on, and the drying watch's status and due indicator with
// `drying_watch` on, worked out for the whole page in a fixed number of queries from the same signed facts,
// readings and decisions as the job's own card (the watch's state function). Nothing else: no amount,
// note, reason, reading, person, action or facts hash. Read in the read-only snapshot of the page it
// decorates, for rows the caller is already allowed to list (the member jobs list, or the operator's
// audited read-only support views).

export type SignedRowProjection = {
  closed?: { closedAt: string | null };
  dryingWatch?: { status: WatchStatus | 'unavailable'; due: 'overdue' | 'due_today' | null; nextDueAt: string | null };
};

/** The projection of each signed row on a page, by job id; a row that is not signed has none. */
export async function signedRowProjections(tx: CompanyTransaction, companyId: string, rows: readonly JobRow[]): Promise<Map<string, SignedRowProjection>> {
  const signed = rows.filter((row) => row.status === 'signed');
  const found = new Map<string, SignedRowProjection>();
  if (signed.length === 0) return found;
  const flags = flagsFromRows(
    await tx.select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled }).from(companyFeatureFlags).where(eq(companyFeatureFlags.companyId, companyId)),
  );
  if (!flags.estimate_assist && !flags.drying_watch) return found;
  for (const row of signed) found.set(row.id, {});
  if (flags.estimate_assist) {
    const ids = signed.map((row) => row.id);
    const closes = await tx
      .selectDistinctOn([jobCloses.jobId], {
        jobId: jobCloses.jobId,
        closedAt: sql<string>`to_char(${jobCloses.closedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(jobCloses)
      .where(and(eq(jobCloses.companyId, companyId), inArray(jobCloses.jobId, ids)))
      .orderBy(jobCloses.jobId, desc(jobCloses.revision));
    const closedAt = new Map(closes.map((close) => [close.jobId, close.closedAt]));
    for (const row of signed) found.get(row.id)!.closed = { closedAt: closedAt.get(row.id) ?? null };
  }
  if (flags.drying_watch) {
    const states = await watchStatesOf(tx, companyId, signed.map((row) => row.id), await databaseNow(tx));
    for (const row of signed) {
      const state = states.get(row.id) ?? null;
      found.get(row.id)!.dryingWatch = state
        ? { status: state.status, due: state.flags.includes('overdue') ? 'overdue' : state.flags.includes('due_today') ? 'due_today' : null, nextDueAt: state.nextDueAt }
        : { status: 'unavailable', due: null, nextDueAt: null };
    }
  }
  return found;
}
