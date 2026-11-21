import { and, eq, inArray, isNull } from 'drizzle-orm';
import { companyFeatureFlags, jobPriceApprovals } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { Dec, money } from '@/engine/decimal';
import type { EstimateJob, Json } from '@/engine/estimate';
import { EstimateError } from '@/lib/estimates/errors';
import type { Snapshot } from '@/lib/submissions/snapshot';

// Whether the company's `priced_extras` switch is on, read inside the caller's transaction after its
// job lock, so the switch the work is done under is the one stored at that moment, never the sign-in's
// copy (owner decision D5). A missing row is off.
// Whether both switches the approval routes need are on now, read in the request's own transaction (under
// the company lock the routes take): priced extras, and price books, which every price route needs.
export async function approvalSwitchesOn(tx: CompanyTransaction, companyId: string): Promise<boolean> {
  const rows = await tx
    .select({ flag: companyFeatureFlags.flag, enabled: companyFeatureFlags.enabled })
    .from(companyFeatureFlags)
    .where(and(eq(companyFeatureFlags.companyId, companyId), inArray(companyFeatureFlags.flag, ['priced_extras', 'price_books'])));
  const on = new Set(rows.filter((row) => row.enabled === true).map((row) => row.flag));
  return on.has('priced_extras') && on.has('price_books');
}

// The company's `price_books` switch is on now, which every estimate and price route needs.
export async function priceBooksOn(tx: CompanyTransaction, companyId: string): Promise<boolean> {
  const [flag] = await tx
    .select({ enabled: companyFeatureFlags.enabled })
    .from(companyFeatureFlags)
    .where(and(eq(companyFeatureFlags.companyId, companyId), eq(companyFeatureFlags.flag, 'price_books')));
  return flag?.enabled === true;
}

export async function pricedExtrasOn(tx: CompanyTransaction, companyId: string): Promise<boolean> {
  const [flag] = await tx
    .select({ enabled: companyFeatureFlags.enabled })
    .from(companyFeatureFlags)
    .where(and(eq(companyFeatureFlags.companyId, companyId), eq(companyFeatureFlags.flag, 'priced_extras')));
  return flag?.enabled === true;
}

// An hourly row's line total: hours times its saved rate, to the cent as the engine rounds money.
export const hourlyTotal = (hours: string, rate: string): string => money(Dec.parse(hours).mul(Dec.parse(rate))).format('.2f');

// What the estimate takes of a record's approvals (S5b-8): only rows approved by the owner, still
// open, at the job's revision and on the pin the estimate is priced from reach a total; any edit, a
// newer revision or a reprice leaves a row out. An open hourly, unit or flat row not yet approved goes in
// with no approval: it prices nothing, and the engine's pending-work check keeps the estimate from being
// signed until the owner settles it. A custom multiplier names its room by field id here; withApprovals
// turns it into the room's name, as the engine's lines carry it. Read by the estimate service only while the company's
// `priced_extras` flag is on (owner decision D5); off, the estimate ignores approvals.
export async function approvedFor(
  tx: CompanyTransaction,
  companyId: string,
  binding: { submissionId: string; jobRevision: number; pinId: string },
): Promise<Approved> {
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
      total: hourlyTotal(row.quantity!, row.price!),
      company_id: companyId,
      company_version: 1,
    },
  }));
  const waiting: Json[] = pending.map((row) => ({ id: row.id.replace(/-/g, ''), description: row.description!, hours: row.quantity! }));
  const multipliers = rows
    .filter((row) => row.kind === 'line_multiplier' && row.approvedAt !== null)
    .map((row) => ({ itemId: row.itemId!, roomId: row.roomId, multiplier: row.multiplier! }));
  // Unit and flat additions (B2), approved ones first in approval order, then those waiting for the owner.
  const additions: Json[] = rows
    .filter((row) => row.kind === 'unit' || row.kind === 'flat')
    .sort((left, right) => order(left) - order(right) || left.id.localeCompare(right.id))
    .map((row) => ({
      id: row.id.replace(/-/g, ''),
      kind: row.kind,
      description: row.description!,
      ...(row.kind === 'unit' ? { quantity: row.quantity!, unit: row.unit! } : {}),
      price: row.price!,
      taxable: row.taxable === true,
      approved_at: row.approvedAt ? row.approvedAt.toISOString() : null,
    }));
  return { ...(named ? { adjustment: named.adjustmentId! } : {}), extras: [...extras, ...waiting], multipliers, additions };
}

// Approved rows by approval time, then rows not yet approved by proposal time.
function order(row: { approvedAt: Date | null; proposedAt: Date }): number {
  return row.approvedAt ? row.approvedAt.getTime() : Number.MAX_SAFE_INTEGER / 2 + row.proposedAt.getTime();
}

/** How many hourly, unit and flat rows still wait for the owner's approval in what the estimate takes. */
export function pendingCount(approved: Approved | null): number {
  if (!approved) return 0;
  return (
    approved.extras.filter((extra) => !(extra as { approval?: unknown }).approval).length +
    approved.additions.filter((addition) => (addition as { approved_at?: unknown }).approved_at === null).length
  );
}

export type Approved = {
  adjustment?: string;
  extras: Json[];
  multipliers: Array<{ itemId: string; roomId: string | null; multiplier: string }>;
  additions: Json[];
};

/** Each room of the record by its field id, with the name the engine's lines carry. */
export function roomNamesOf(snapshot: Pick<Snapshot, 'field'>): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const room of snapshot.field.rooms ?? []) {
    const name = (room.field as { name?: unknown } | undefined)?.name;
    if (typeof name === 'string') names.set(room.id, name);
  }
  return names;
}

/**
 * The job to price with its approvals: the approved named adjustment, and the hourly, unit and flat additions and
 * the approved custom multipliers in place of any in the record. A multiplier names its room by the record's room
 * name; one whose room the record does not have is refused, as an estimate that cannot be priced (the proposal checked
 * it, so this cannot happen).
 */
export function withApprovals(job: EstimateJob, approved: Approved, rooms: ReadonlyMap<string, string>): EstimateJob {
  const lineMultipliers: Json[] = [];
  for (const entry of approved.multipliers) {
    const room = entry.roomId === null ? null : rooms.get(entry.roomId);
    if (room === undefined) throw new EstimateError('estimate_refused', { stage: 'pricing', message: 'An approved custom multiplier names a room the record does not have.' });
    lineMultipliers.push({ item_id: entry.itemId, room, multiplier: entry.multiplier });
  }
  const inspection = {
    ...(job.inspection as Record<string, Json>),
    extras: approved.extras,
    line_multipliers: lineMultipliers,
    additions: approved.additions,
  };
  return { ...job, inspection, ...(approved.adjustment ? { adjustment: approved.adjustment } : {}) };
}
