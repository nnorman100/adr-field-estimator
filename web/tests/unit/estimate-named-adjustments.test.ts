// Named adjustments (S5 plan step S5b-7). Every expected number is worked by hand in the comment beside it: an
// approved adjustment changes the price after price-point rounding (S4-4e) and is not rounded again; a percent is
// of the price before it, rounded to cents once; a discount prints with a minus, a charge with a plus.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { contentHash, parseTable } from '../../src/engine/table';
import { adjustmentLines, chargeRows } from '../../src/lib/estimates/screen';
import { item, job, priced, room, table, type Obj } from './estimate-fixtures';

const SENIOR: Obj = { adjustment_id: 'senior', name: 'Senior discount', kind: 'percent', direction: 'discount', value: '10' };
const LOYAL: Obj = { adjustment_id: 'loyal', name: 'Returning customer', kind: 'amount', direction: 'discount', value: '50' };
const RUSH: Obj = { adjustment_id: 'rush', name: 'Weekend start', kind: 'amount', direction: 'charge', value: '125' };

/** One job charge at `amount`, so the priced total is exactly that amount. */
function charge(amount: string, extra: Obj = {}): Obj {
  return item('service_call', { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls', unit_price: amount, ...extra });
}

function withAdjustments(amount: string, policy: Obj = {}, extra: Obj = {}): Obj {
  return { ...table([charge(amount, extra)], policy), adjustments: [SENIOR, LOYAL, RUSH] };
}

function priceWith(tableJson: Obj, approved: string[]) {
  return priced(tableJson, { ...job([room('Kitchen')], { emergency_calls: 1 }), adjustments: approved });
}

describe('named adjustment worked examples', () => {
  it('a percent discount', () => {
    // $2,431.17 x 10% = $243.117, rounded once to $243.12; $2,431.17 - $243.12 = $2,188.05.
    const result = priceWith(withAdjustments('2431.17'), ['senior']);
    expect(result.totals.low.total).toBe('2188.05');
    expect(result.totals.low.adjustments).toEqual([
      { adjustment_id: 'senior', name: 'Senior discount', direction: 'discount', before: '2431.17', amount: '243.12', after: '2188.05' },
    ]);
  });

  it('an amount discount', () => {
    // $1,000.00 - $50.00 = $950.00.
    const result = priceWith(withAdjustments('1000.00'), ['loyal']);
    expect(result.totals.low).toMatchObject({ total: '950.00' });
  });

  it('a charge', () => {
    // $1,000.00 + $125.00 = $1,125.00.
    const result = priceWith(withAdjustments('1000.00'), ['rush']);
    expect(result.totals.low.total).toBe('1125.00');
  });

  it('a discount on a rounded price is taken from the rounded price and not rounded again', () => {
    // $2,431.17 rounds up to $2,499.00 (step 100, ending 99). 10% of $2,499.00 = $249.90; $2,499.00 - $249.90 = $2,249.10,
    // which is not a price point and stays as it is.
    const result = priceWith(withAdjustments('2431.17', { price_point: { step: '100', ending: '99' } }), ['senior']);
    expect(result.totals.low).toMatchObject({ price_point: '67.83', total: '2249.10' });
    expect(result.totals.low.adjustments?.[0]).toMatchObject({ before: '2499.00', amount: '249.90', after: '2249.10' });
  });

  it('applies after tax and is not taxed', () => {
    // $1,000.00 taxable at 10%: tax $100.00, price $1,100.00; less $50.00 = $1,050.00; the tax stays $100.00.
    const result = priceWith(withAdjustments('1000.00', { sales_tax: { enabled: true, percent: '10' } }, { taxable: true }), ['loyal']);
    expect(result.totals.low).toMatchObject({ tax: '100.00', total: '1050.00' });
  });

  it('several apply in the order approved, each on the price before it', () => {
    // $1,000.00 + $125.00 = $1,125.00; 10% of $1,125.00 = $112.50; $1,125.00 - $112.50 = $1,012.50.
    const result = priceWith(withAdjustments('1000.00'), ['rush', 'senior']);
    expect(result.totals.low.total).toBe('1012.50');
  });

  it('applies to each end of a range on its own', () => {
    // 600 sq ft x $2.00 = $1,200.00 low; 50% cushion: $1,800.00 high. Less $50.00: $1,150.00 and $1,750.00.
    const result = priced(
      { ...table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }), adjustments: [LOYAL] },
      { ...job([room('Kitchen', { unfinished_sf: 600 })]), adjustments: ['loyal'] },
    );
    expect(result.totals.low.total).toBe('1150.00');
    expect(result.totals.high?.total).toBe('1750.00');
  });
});

describe('printed arithmetic', () => {
  it('prints a discount with a minus and a charge with a plus', () => {
    const discount = priceWith(withAdjustments('2431.17', { price_point: { step: '100', ending: '99' } }), ['senior']);
    expect(adjustmentLines(discount.totals.low, null)).toEqual(['$2,499.00 − Senior discount $249.90 = $2,249.10']);
    const extra = priceWith(withAdjustments('1000.00'), ['rush']);
    expect(adjustmentLines(extra.totals.low, null)).toEqual(['$1,000.00 + Weekend start $125.00 = $1,125.00']);
  });

  it('names each end in a range', () => {
    const result = priced(
      { ...table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }), adjustments: [LOYAL] },
      { ...job([room('Kitchen', { unfinished_sf: 600 })]), adjustments: ['loyal'] },
    );
    expect(adjustmentLines(result.totals.low, result.totals.high)).toEqual([
      'Low end: $1,200.00 − Returning customer $50.00 = $1,150.00',
      'High end: $1,800.00 − Returning customer $50.00 = $1,750.00',
    ]);
  });

  it('the charge rows still add up to the adjusted total', () => {
    const result = priceWith(withAdjustments('1000.00'), ['loyal']);
    const rows = chargeRows(result.totals.low, 'After-hours adjustment');
    expect(rows).toEqual([
      { label: 'Subtotal', amount: '1000.00' },
      { label: 'Returning customer', amount: '-50.00' },
    ]);
    const cents = (amount: string) => Math.round(Number(amount) * 100);
    expect(rows.reduce((sum, row) => sum + cents(row.amount), 0)).toBe(cents(result.totals.low.total));
  });
});

describe('only approved adjustments apply', () => {
  it('a table with adjustments prices as before when none is approved', () => {
    const result = priced(withAdjustments('1000.00'), job([room('Kitchen')], { emergency_calls: 1 }));
    expect(result.totals.low.total).toBe('1000.00');
    expect(result.totals.low.adjustments).toBeUndefined();
    expect(adjustmentLines(result.totals.low, null)).toEqual([]);
  });

  it('refuses an id the table does not have, one approved twice, and a discount above the price', () => {
    const run = (approved: string[], amount = '1000.00') =>
      priceEstimate(withAdjustments(amount), { ...job([room('Kitchen')], { emergency_calls: 1 }), adjustments: approved });
    expect(run(['unknown'])).toMatchObject({ ok: false, stage: 'pricing' });
    expect(run(['loyal', 'loyal'])).toMatchObject({ ok: false, stage: 'pricing' });
    expect(run(['loyal'], '40.00')).toMatchObject({ ok: false, stage: 'pricing' });
  });
});

describe('adjustment schema', () => {
  const check = (adjustment: Obj) => checkTable({ ...table([charge('10.00')]), adjustments: [adjustment] });

  it('takes a name up to 60 characters, a percent or an amount, a discount or a charge', () => {
    expect(check({ ...SENIOR, name: 'x'.repeat(60) }).ok).toBe(true);
    expect(check({ ...SENIOR, name: 'x'.repeat(61) }).ok).toBe(false);
    expect(check({ ...SENIOR, name: '' }).ok).toBe(false);
    expect(check({ ...SENIOR, kind: 'multiplier' }).ok).toBe(false);
    expect(check({ ...SENIOR, direction: 'credit' }).ok).toBe(false);
  });

  it('refuses a zero value, a percent above 100 and repeated ids', () => {
    expect(check({ ...LOYAL, value: '0' }).ok).toBe(false);
    expect(check({ ...SENIOR, value: '100.01' }).ok).toBe(false);
    expect(check({ ...SENIOR, value: '100' }).ok).toBe(true);
    expect(checkTable({ ...table([charge('10.00')]), adjustments: [SENIOR, { ...LOYAL, adjustment_id: 'senior' }] }).ok).toBe(false);
  });

  it('none are seeded: a table without adjustments keeps its content hash', () => {
    const plain = table([charge('10.00')]);
    expect(parseTable(plain)).not.toHaveProperty('adjustments');
    expect(contentHash(parseTable({ ...plain, adjustments: [] }))).toBe(contentHash(parseTable(plain)));
  });
});
