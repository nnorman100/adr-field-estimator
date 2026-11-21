import { z } from 'zod';
import { Dec } from '@/engine/decimal';

// The estimate accuracy numbers (S5b-10 slice 10B): a port of the old app's backend/outcomes.py
// `statistics` (docs/estimate-assist.md "The numbers" and "Suggestions"). Descriptive only: a suggestion
// enters the Prices working copy only when the owner uses it, and nothing here changes a price.
//
// - Each closed job counts once, by its latest close, compared with the job's first signed estimate.
// - Overrun: max(0, final - low) / the low end's labor and materials total, for jobs that have one above
//   zero. Extra days: max(0, actual - planned), for jobs with both.
// - Each suggestion is the nearest-rank 80th percentile (the smallest value that covers 4 of 5 jobs) and
//   needs at least 5 qualifying jobs, else its value is null with the count. Percents are rounded up to
//   the next 5 and held at 100; extra days at 30. All arithmetic on whole cents, as exact fractions.
// - Which settings get one follows the company's current published table: the uncertainty method
//   suggests hidden-damage percents per category (jobs whose rooms all share it; Mold counts as category
//   3, as the engine prices it) and the extra drying days; the cushion method suggests the first
//   cushion, never below the table's beyond percent. One price suggests nothing (a high end is never
//   printed), nor do custom cushion brackets (the first cushion is then unused), nor no compatible table.

export const COVERAGE_JOBS = 5;
const PERCENT_CAP = 100;
const DAYS_CAP = 30;

export type AccuracyRow = {
  landed: 'inside' | 'above' | 'below';
  finalCents: number;
  lowCents: number;
  laborMaterialLowCents: number | null;
  roomCategories: ('1' | '2' | '3' | 'mold')[] | null;
  plannedDays: number | null;
  actualDays: number | null;
};

export type AccuracyPolicy = {
  estimateMode: 'range' | 'single';
  rangeMethod: 'cushion' | 'uncertainty';
  beyondPercent: string;
  customBrackets: boolean;
};

export type Suggestion = { value: number | null; jobs: number };
// The first cushion's value is a percent as the table writes one, which may be the beyond percent it is held at.
export type CushionSuggestion = { value: string | null; jobs: number; heldAtBeyond: boolean };

export type Accuracy = {
  signed: number;
  closed: number;
  inside: number;
  above: number;
  below: number;
  insidePercent: number | null;
  // Closed jobs whose rooms all share one hidden-damage category.
  counts: { '1': number; '2': number; '3': number };
  extraDryingDays: Suggestion;
  estimateMode: 'range' | 'single' | null;
  method: 'cushion' | 'uncertainty' | null;
  suggestions: null | { hiddenDamagePercent: Record<'1' | '2' | '3', Suggestion>; extraDryingDays: Suggestion } | { firstPercent: CushionSuggestion };
  reason: null | 'no_prices' | 'single_price' | 'custom_brackets';
};

const count = z.number().int().nonnegative();
const suggestion = z.strictObject({ value: count.nullable(), jobs: count });
const categories = z.strictObject({ '1': count, '2': count, '3': count });

/** What the accuracy route answers: closed fields only, every state (none closed, too few jobs, no table) included. */
export const accuracyResponse = z.strictObject({
  signed: count,
  closed: count,
  inside: count,
  above: count,
  below: count,
  insidePercent: z.number().int().min(0).max(100).nullable(),
  counts: categories,
  extraDryingDays: suggestion,
  estimateMode: z.enum(['range', 'single']).nullable(),
  method: z.enum(['cushion', 'uncertainty']).nullable(),
  suggestions: z
    .union([
      z.null(),
      z.strictObject({ hiddenDamagePercent: z.strictObject({ '1': suggestion, '2': suggestion, '3': suggestion }), extraDryingDays: suggestion }),
      z.strictObject({ firstPercent: z.strictObject({ value: z.string().nullable(), jobs: count, heldAtBeyond: z.boolean() }) }),
    ]),
  reason: z.enum(['no_prices', 'single_price', 'custom_brackets']).nullable(),
});

// A fraction num/den with a positive denominator.
type Fraction = { num: bigint; den: bigint };
const compare = (a: Fraction, b: Fraction) => (a.num * b.den < b.num * a.den ? -1 : a.num * b.den > b.num * a.den ? 1 : 0);

/** The nearest-rank 80th percentile: the smallest value that covers 4 of 5 of them. */
function p80<T>(values: T[], order: (a: T, b: T) => number): T {
  const sorted = [...values].sort(order);
  return sorted[Math.ceil((4 * sorted.length) / 5) - 1]!;
}

function overrun(row: AccuracyRow): Fraction | null {
  if (row.laborMaterialLowCents === null || row.laborMaterialLowCents <= 0) return null;
  const over = row.finalCents - row.lowCents;
  return { num: BigInt(Math.max(0, over)), den: BigInt(row.laborMaterialLowCents) };
}

// The percent that would have covered 4 of 5 of these jobs, up to the next 5, at most 100.
function percentSuggestion(rows: AccuracyRow[]): Suggestion {
  const overruns = rows.map(overrun).filter((value): value is Fraction => value !== null);
  if (overruns.length < COVERAGE_JOBS) return { value: null, jobs: overruns.length };
  const { num, den } = p80(overruns, compare);
  // ceil(num / den * 100 / 5) * 5, exactly.
  const fifths = (num * 20n + den - 1n) / den;
  return { value: Math.min(Number(fifths) * 5, PERCENT_CAP), jobs: overruns.length };
}

function extraDays(rows: AccuracyRow[]): Suggestion {
  const extras = rows.filter((row) => row.actualDays !== null && row.plannedDays !== null).map((row) => Math.max(0, row.actualDays! - row.plannedDays!));
  if (extras.length < COVERAGE_JOBS) return { value: null, jobs: extras.length };
  return { value: Math.min(p80(extras, (a, b) => a - b), DAYS_CAP), jobs: extras.length };
}

// The one hidden-damage category every room of the job shares (Mold is priced with category 3's), or
// null when the rooms differ or none is known.
function singleCategory(row: AccuracyRow): '1' | '2' | '3' | null {
  const keys = new Set((row.roomCategories ?? []).map((category) => (category === 'mold' ? '3' : category)));
  return keys.size === 1 ? ([...keys][0] as '1' | '2' | '3') : null;
}

/** The owner's numbers from the closed jobs' rows, the count of signed jobs and the current table's policy. */
export function accuracyOf(rows: AccuracyRow[], signed: number, policy: AccuracyPolicy | null): Accuracy {
  const count = (landed: AccuracyRow['landed']) => rows.filter((row) => row.landed === landed).length;
  const byCategory = { '1': [] as AccuracyRow[], '2': [] as AccuracyRow[], '3': [] as AccuracyRow[] };
  for (const row of rows) {
    const category = singleCategory(row);
    if (category) byCategory[category].push(row);
  }
  const days = extraDays(rows);
  const inside = count('inside');
  const result: Accuracy = {
    signed,
    closed: rows.length,
    inside,
    above: count('above'),
    below: count('below'),
    // Rounded half up, in whole numbers.
    insidePercent: rows.length === 0 ? null : Math.floor((200 * inside + rows.length) / (2 * rows.length)),
    counts: { '1': byCategory['1'].length, '2': byCategory['2'].length, '3': byCategory['3'].length },
    extraDryingDays: days,
    estimateMode: policy?.estimateMode ?? null,
    method: policy?.rangeMethod ?? null,
    suggestions: null,
    reason: null,
  };
  if (!policy) return { ...result, reason: 'no_prices' };
  if (policy.estimateMode === 'single') return { ...result, reason: 'single_price' };
  if (policy.rangeMethod === 'uncertainty') {
    return {
      ...result,
      suggestions: {
        hiddenDamagePercent: { '1': percentSuggestion(byCategory['1']), '2': percentSuggestion(byCategory['2']), '3': percentSuggestion(byCategory['3']) },
        extraDryingDays: days,
      },
    };
  }
  if (policy.customBrackets) return { ...result, reason: 'custom_brackets' };
  const cushion = percentSuggestion(rows);
  // A table refuses a first cushion below its beyond cushion, so the suggestion is held there.
  const held = cushion.value !== null && Dec.fromInt(cushion.value).lt(Dec.parse(policy.beyondPercent));
  return {
    ...result,
    suggestions: { firstPercent: { jobs: cushion.jobs, value: cushion.value === null ? null : held ? policy.beyondPercent : String(cushion.value), heldAtBeyond: held } },
  };
}
