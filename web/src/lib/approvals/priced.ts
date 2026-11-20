import { and, eq, isNull } from 'drizzle-orm';
import { jobPriceApprovals } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { Dec, money } from '@/engine/decimal';
import type { EstimateJob, Json } from '@/engine/estimate';

// What the estimate takes of a record's approvals (S5b-8): only rows approved by the owner, still
// open, at the job's revision and on the pin the estimate is priced from reach a total; any edit, a
// newer revision or a reprice leaves a row out. An open hourly row not yet approved goes in as
// additional work with no approval: it prices nothing, and the engine's pending-work check keeps the
// estimate from being signed until the owner settles it. Read by the estimate service only while the company's
// `priced_extras` flag is on (owner decision D5); off, the estimate ignores approvals.
export async function approvedFor(
  tx: CompanyTransaction,
  companyId: string,
  binding: { submissionId: string; jobRevision: number; pinId: string },
): Promise<{ adjustment?: string; extras: Json[] }> {
  const rows = await tx
    .select()
    .from(jobPriceApprovals)
    .where(
      and(
        eq(jobPriceApprovals.companyId, companyId),
        eq(jobPriceApprovals.submissionId, binding.submissionId),
        eq(jobPriceApprovals.jobRevision, binding.jobRevision),
        eq(jobPriceApprovals.pinId, binding.pinId),
        isNull(jobPriceApprovals.endedAt),
      ),
    );
  const named = rows.find((row) => row.kind === 'named_adjustment' && row.approvedAt !== null);
  const hourly = rows
    .filter((row) => row.kind === 'hourly' && row.approvedAt !== null)
    .sort((left, right) => left.approvedAt!.getTime() - right.approvedAt!.getTime() || left.id.localeCompare(right.id));
  const pending = rows
    .filter((row) => row.kind === 'hourly' && row.approvedAt === null)
    .sort((left, right) => left.proposedAt.getTime() - right.proposedAt.getTime() || left.id.localeCompare(right.id));
  // Each approved hourly row as the engine's additional work entry (web/src/engine/inspection.ts),
  // with the rate saved on the row, the approver's name as entered and the approval date, which the
  // proposal prints ("approved by {name} on {date}").
  const extras: Json[] = hourly.map((row) => ({
    id: row.id.replace(/-/g, ''),
    description: row.description!,
    hours: row.quantity!,
    approval: {
      accepted_by_uid: row.approvedByActorId!,
      accepted_by_name: row.approvedByName!,
      accepted_at: row.approvedAt!.toISOString(),
      rate: row.price!,
      total: money(Dec.parse(row.quantity!).mul(Dec.parse(row.price!))).format('.2f'),
      company_id: companyId,
      company_version: 1,
    },
  }));
  const waiting: Json[] = pending.map((row) => ({ id: row.id.replace(/-/g, ''), description: row.description!, hours: row.quantity! }));
  return { ...(named ? { adjustment: named.adjustmentId! } : {}), extras: [...extras, ...waiting] };
}

/** The job to price with its approvals: the approved named adjustment and the approved hourly additions in place of any in the record. */
export function withApprovals(job: EstimateJob, approved: { adjustment?: string; extras: Json[] }): EstimateJob {
  const inspection = { ...(job.inspection as Record<string, Json>), extras: approved.extras };
  return { ...job, inspection, ...(approved.adjustment ? { adjustment: approved.adjustment } : {}) };
}
