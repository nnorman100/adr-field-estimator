import { and, eq, sql } from 'drizzle-orm';
import { estimateHistory } from '@/db/drying-schema';
import { agreements, jobSubmissions } from '@/db/schema';
import type { CompanyTransaction } from '@/db/tenant';
import { readStoredEstimate, StoredEstimateError } from '@/lib/estimates/result';
import { snapshotManifest } from '@/lib/submissions/snapshot';

// The estimate history (S5b-10 slice 10B; docs/estimate-assist.md "Job close and estimate accuracy"):
// one insert-only sample per signed agreement, the signed figures a job close is compared with. The
// sample is read from the agreement's own stored priced result (the result after any approved named
// adjustment, multipliers and additions; plan amendment 5) and the snapshot it was signed from, never
// priced again: an amount that cannot be read from them is not invented.
//
// - Written in the signing transaction, after the agreement, with the estimate_assist switch on or off,
//   in a savepoint, so a sample that cannot be built or written leaves the signature as it is.
// - Written at the close when it is missing (a job signed before this, or whose sample failed), from the
//   same immutable data.

export type HistorySample = {
  agreementId: string;
  signedAt: Date;
  priceMode: 'range' | 'single';
  lowCents: number;
  highCents: number | null;
  laborMaterialLowCents: number | null;
  roomCategories: ('1' | '2' | '3' | 'mold')[] | null;
  plannedDays: number | null;
};

const MAX_CENTS = 9_007_199_254_740_991;
const MONEY = /^(\d+)\.(\d{2})$/;

/** Whole cents of an engine money string ("1234.56"), or null for one that is not a non-negative amount. */
export function centsOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parts = MONEY.exec(value);
  if (!parts) return null;
  const cents = BigInt(parts[1]!) * 100n + BigInt(parts[2]!);
  return cents <= BigInt(MAX_CENTS) ? Number(cents) : null;
}

const CATEGORY_ORDER = ['1', '2', '3', 'mold'] as const;

// The signed rooms' categories as the engine priced them, each once, in the database's order: the
// rooms the draft's room order lists, a room with no category priced as category 1 (the engine's
// default, src/engine/inspection.ts). Null for a record with no listed room.
function categoriesOf(manifest: { draft: unknown; rooms: { id: string; field: unknown }[] }): HistorySample['roomCategories'] {
  const order = (manifest.draft as { roomOrder?: unknown } | null)?.roomOrder;
  const listed = Array.isArray(order) ? manifest.rooms.filter((room) => order.includes(room.id)) : [];
  const found = new Set<string>();
  for (const room of listed) {
    const category = (room.field as { category?: unknown } | null)?.category ?? 1;
    if (category === 1 || category === 2 || category === 3) found.add(String(category));
    else if (category === 'mold') found.add('mold');
  }
  const ordered = CATEGORY_ORDER.filter((category) => found.has(category));
  return ordered.length > 0 ? ordered : null;
}

/**
 * The sample of a signed agreement, from its stored priced result and the snapshot it was signed from;
 * null when its signed amount cannot be proven (a result that does not read, or a low end, or a range's
 * high end, that is not an amount). Optional figures that cannot be read are left out.
 */
export function sampleOf(agreement: { id: string; signedAt: Date; pricedResult: unknown }, snapshot: Uint8Array | null): HistorySample | null {
  let totals;
  try {
    totals = readStoredEstimate(agreement.pricedResult).totals;
  } catch (error) {
    if (error instanceof StoredEstimateError) return null;
    throw error;
  }
  const lowCents = centsOf(totals.low.total);
  const highCents = totals.mode === 'range' ? centsOf(totals.high?.total) : null;
  if (lowCents === null || (totals.mode === 'range' && (highCents === null || highCents < lowCents))) return null;
  let roomCategories: HistorySample['roomCategories'] = null;
  let plannedDays: number | null = null;
  if (snapshot) {
    try {
      const manifest = snapshotManifest(snapshot);
      roomCategories = categoriesOf(manifest);
      const days = (manifest.draft as { dryingDays?: unknown } | null)?.dryingDays;
      plannedDays = typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
    } catch {
      // An unreadable snapshot keeps the sample's optional figures out, never its amounts.
    }
  }
  return {
    agreementId: agreement.id,
    signedAt: agreement.signedAt,
    priceMode: totals.mode,
    lowCents,
    highCents,
    laborMaterialLowCents: centsOf(totals.labor_material_low),
    roomCategories,
    plannedDays,
  };
}

/** The agreement's stored sample, or null. */
export async function storedSample(tx: CompanyTransaction, companyId: string, jobId: string, agreementId: string): Promise<HistorySample | null> {
  const [row] = await tx
    .select()
    .from(estimateHistory)
    .where(and(eq(estimateHistory.companyId, companyId), eq(estimateHistory.jobId, jobId), eq(estimateHistory.agreementId, agreementId)));
  if (!row) return null;
  return {
    agreementId: row.agreementId,
    signedAt: row.signedAt,
    priceMode: row.priceMode,
    lowCents: row.lowCents,
    highCents: row.highCents,
    laborMaterialLowCents: row.laborMaterialLowCents,
    roomCategories: row.roomCategories,
    plannedDays: row.plannedDays,
  };
}

/**
 * Builds the agreement's sample from its immutable signed data and inserts it (once: an existing sample
 * is kept). Null when the signed amount cannot be proven; then nothing is written.
 */
export async function writeSample(tx: CompanyTransaction, companyId: string, jobId: string, agreementId: string): Promise<HistorySample | null> {
  const [signed] = await tx
    .select({ id: agreements.id, signedAt: agreements.signedAt, pricedResult: agreements.pricedResult, snapshot: jobSubmissions.snapshotBytes })
    .from(agreements)
    .leftJoin(jobSubmissions, and(eq(jobSubmissions.companyId, agreements.companyId), eq(jobSubmissions.id, agreements.submissionId)))
    .where(and(eq(agreements.companyId, companyId), eq(agreements.jobId, jobId), eq(agreements.id, agreementId)));
  if (!signed) return null;
  const sample = sampleOf(signed, signed.snapshot ?? null);
  if (!sample) return null;
  // Named one by one: the runtime may insert only these columns (0020).
  await tx.execute(sql`
    INSERT INTO estimate_history (company_id, job_id, agreement_id, signed_at, price_mode, low_cents, high_cents, labor_material_low_cents, room_categories, planned_days, area_sf)
    VALUES (${companyId}::uuid, ${jobId}::uuid, ${agreementId}::uuid, ${sample.signedAt.toISOString()}::timestamptz, ${sample.priceMode}, ${sample.lowCents},
            ${sample.highCents}, ${sample.laborMaterialLowCents}, ${sample.roomCategories === null ? null : `{${sample.roomCategories.join(',')}}`}::text[],
            ${sample.plannedDays}, NULL)
    ON CONFLICT (company_id, job_id, agreement_id) DO NOTHING
  `);
  return (await storedSample(tx, companyId, jobId, agreementId)) ?? sample;
}

// What a failed statement leaves for the transaction around it: these end the whole transaction
// (serialization failure, deadlock, a lost connection, the server shutting down), so signing fails and
// retries as for any other error. Anything else, a statement timeout or a refused row included, rolls
// back to the savepoint and the signature goes on.
const WHOLE_TRANSACTION = /^(40001|40P01|08|57P0[1-3])/;

/**
 * The signing transaction's history capture: best effort, in a savepoint. A sample that cannot be built
 * or written is logged with fixed text and no amount, and the signature commits without it (the close
 * writes it later). A failure that ends the transaction itself is thrown, so signing follows its own
 * retry.
 */
export async function captureSample(tx: CompanyTransaction, companyId: string, jobId: string, agreementId: string): Promise<void> {
  try {
    await tx.transaction((savepoint) => writeSample(savepoint, companyId, jobId, agreementId));
  } catch (error) {
    const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (typeof code === 'string' && WHOLE_TRANSACTION.test(code)) throw error;
    console.error('estimate history sample not written', error instanceof Error ? error.name : 'unknown');
  }
}
