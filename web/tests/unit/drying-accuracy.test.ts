import { describe, expect, it } from 'vitest';
import { accuracyOf, type AccuracyPolicy, type AccuracyRow } from '@/lib/drying/accuracy';

// S5b-10 slice 10B, the estimate accuracy numbers: the port of backend/outcomes.py `statistics`
// (docs/estimate-assist.md): where closed jobs landed, the nearest-rank 80th percentile suggestions with
// at least five jobs, exact cents, and which settings get a suggestion under which table settings.

const row = (extra: Partial<AccuracyRow> = {}): AccuracyRow => ({
  landed: 'inside',
  finalCents: 100_000,
  lowCents: 100_000,
  laborMaterialLowCents: 50_000,
  roomCategories: ['2'],
  plannedDays: 3,
  actualDays: 3,
  ...extra,
});
// Jobs whose final invoice ran over the low end by these many cents, each on 1,000.00 of labor and materials.
const overruns = (...cents: number[]) => cents.map((over) => row({ finalCents: 100_000 + over, laborMaterialLowCents: 100_000, landed: over > 0 ? 'above' : 'inside' }));
const cushion: AccuracyPolicy = { estimateMode: 'range', rangeMethod: 'cushion', beyondPercent: '10', customBrackets: false };
const uncertainty: AccuracyPolicy = { ...cushion, rangeMethod: 'uncertainty' };

describe('the counts', () => {
  it('counts where closed jobs landed, the share inside rounded half up, and signed jobs', () => {
    const rows = [row(), row(), row({ landed: 'above' }), row({ landed: 'below' }), row(), row(), row(), row({ landed: 'above' })];
    expect(accuracyOf(rows, 12, cushion)).toMatchObject({ signed: 12, closed: 8, inside: 5, above: 2, below: 1, insidePercent: 63 });
  });

  it('answers an empty history with counts of zero and no suggestion values', () => {
    expect(accuracyOf([], 0, cushion)).toMatchObject({
      signed: 0,
      closed: 0,
      insidePercent: null,
      extraDryingDays: { value: null, jobs: 0 },
      suggestions: { firstPercent: { value: null, jobs: 0, heldAtBeyond: false } },
    });
  });
});

describe('the cushion suggestion', () => {
  it('needs five jobs with labor and materials, leaving out those without', () => {
    const four = [...overruns(1000, 2000, 3000, 4000), row({ laborMaterialLowCents: null }), row({ laborMaterialLowCents: 0 })];
    expect(accuracyOf(four, 6, cushion).suggestions).toEqual({ firstPercent: { value: null, jobs: 4, heldAtBeyond: false } });
  });

  it('is the overrun that covers 4 of 5 jobs, as a percent up to the next 5, at most 100', () => {
    // Overruns of 1%, 2%, 11%, 12% and 40%: the 4th of 5 is 12%, up to 15.
    expect(accuracyOf(overruns(1000, 2000, 11_000, 12_000, 40_000), 5, cushion).suggestions).toEqual({ firstPercent: { value: '15', jobs: 5, heldAtBeyond: false } });
    // Exactly 15% stays 15; just over goes to 20.
    expect(accuracyOf(overruns(0, 0, 0, 15_000, 99_000), 5, cushion).suggestions).toMatchObject({ firstPercent: { value: '15' } });
    expect(accuracyOf(overruns(0, 0, 0, 15_001, 99_000), 5, cushion).suggestions).toMatchObject({ firstPercent: { value: '20' } });
    expect(accuracyOf(overruns(300_000, 300_000, 300_000, 300_000, 300_000), 5, cushion).suggestions).toMatchObject({ firstPercent: { value: '100' } });
    // Under the low end is no overrun.
    expect(accuracyOf(overruns(-5000, -5000, -5000, -5000, -5000), 5, { ...cushion, beyondPercent: '0' }).suggestions).toMatchObject({ firstPercent: { value: '0' } });
  });

  it('is held at the table’s beyond percent, which it may not go below', () => {
    expect(accuracyOf(overruns(1000, 1000, 1000, 1000, 1000), 5, { ...cushion, beyondPercent: '12.5' }).suggestions).toEqual({ firstPercent: { value: '12.5', jobs: 5, heldAtBeyond: true } });
  });
});

describe('the uncertainty suggestions', () => {
  it('suggest hidden-damage percents per category from jobs whose rooms all share it, Mold as category 3', () => {
    const category3 = overruns(5000, 5000, 5000, 5000, 5000).map((one, n) => ({ ...one, roomCategories: n % 2 === 0 ? (['3'] as AccuracyRow['roomCategories']) : (['3', 'mold'] as AccuracyRow['roomCategories']) }));
    const mixed = row({ roomCategories: ['1', '2'] });
    const result = accuracyOf([...category3, mixed], 6, uncertainty);
    expect(result.counts).toEqual({ '1': 0, '2': 0, '3': 5 });
    expect(result.suggestions).toMatchObject({ hiddenDamagePercent: { '1': { value: null, jobs: 0 }, '2': { value: null, jobs: 0 }, '3': { value: 5, jobs: 5 } } });
  });

  it('suggest extra drying days as the 4-of-5 day count over plan, at most 30', () => {
    const days = [0, 1, 2, 4, 9].map((extra) => row({ plannedDays: 3, actualDays: 3 + extra }));
    expect(accuracyOf(days, 5, uncertainty).suggestions).toMatchObject({ extraDryingDays: { value: 4, jobs: 5 } });
    expect(accuracyOf([...days.slice(0, 4), row({ actualDays: null })], 5, uncertainty).extraDryingDays).toEqual({ value: null, jobs: 4 });
    const long = [40, 40, 40, 40, 40].map((extra) => row({ plannedDays: 1, actualDays: 1 + extra }));
    expect(accuracyOf(long, 5, uncertainty).extraDryingDays).toEqual({ value: 30, jobs: 5 });
  });
});

describe('when there is nothing to suggest', () => {
  it('says why: one price, custom cushion brackets, or no compatible published table', () => {
    const rows = overruns(1000, 2000, 3000, 4000, 5000);
    expect(accuracyOf(rows, 5, { ...cushion, estimateMode: 'single' })).toMatchObject({ suggestions: null, reason: 'single_price', closed: 5 });
    expect(accuracyOf(rows, 5, { ...cushion, customBrackets: true })).toMatchObject({ suggestions: null, reason: 'custom_brackets' });
    expect(accuracyOf(rows, 5, null)).toMatchObject({ suggestions: null, reason: 'no_prices', estimateMode: null, method: null, closed: 5 });
  });
});
