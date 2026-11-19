// Price-point rounding (pricing plan S4-4e). Every expected number is worked by hand in the comment
// beside it, from the rule: the total rounds up to the smallest amount at or above it that is `ending`
// plus a whole number of `step`s; the difference is its own line, untaxed; it never rounds down.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { Dec } from '../../src/engine/decimal';
import { pricePointOf } from '../../src/engine/totals';
import { contentHash, parseTable } from '../../src/engine/table';
import { documentJob, item, job, priced, room, table, type Obj } from './estimate-fixtures';

const POINT: Obj = { step: '100', ending: '99' };

/** One job charge at `amount`, so the total is exactly that amount. */
function charge(amount: string): Obj {
  return item('service_call', { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls', unit_price: amount });
}

function totalFor(amount: string, changes: Obj = {}) {
  return priced(table([charge(amount)], { price_point: POINT, ...changes }), job([room('Kitchen')], { emergency_calls: 1 }));
}

describe('price-point rounding worked examples', () => {
  it('rounds $2,431.17 up to $2,499.00 and prints the difference', () => {
    // Step 100, ending 99: 2,431.17 is above 2,399, so the next point is 2,499; 2,499.00 - 2,431.17 = 67.83.
    const result = totalFor('2431.17');
    expect(result.totals.low.total).toBe('2499.00');
    expect(result.totals.low.price_point).toBe('67.83');
  });

  it('keeps $2,499.00, already a price point, with no line', () => {
    const result = totalFor('2499.00');
    expect(result.totals.low.total).toBe('2499.00');
    expect(result.totals.low.price_point).toBeUndefined();
  });

  it('rounds $2,499.01 up to $2,599.00', () => {
    // One cent past 2,499 needs the next step: 2,599.00, a line of 99.99.
    const result = totalFor('2499.01');
    expect(result.totals.low.total).toBe('2599.00');
    expect(result.totals.low.price_point).toBe('99.99');
  });

  it('rounds each end of a range on its own', () => {
    // 600 sq ft x $2.00 = $1,200.00 low; cushion 50% on the first 1,000 sq ft: 1,200 x 1.5 = $1,800.00 high.
    // Step 100, ending 49: low 1,200.00 -> 1,249.00 (49.00); high 1,800.00 -> 1,849.00 (49.00).
    const result = priced(
      table([item('demo')], {
        estimate_mode: 'range',
        range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' },
        price_point: { step: '100', ending: '49' },
      }),
      job([room('Kitchen', { unfinished_sf: 600 })]),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '1200.00', price_point: '49.00', total: '1249.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '1800.00', price_point: '49.00', total: '1849.00' });
  });

  it('rounds a job at the minimum charge from the minimum', () => {
    // 50 sq ft x $2.00 = $100.00, minimum $500.00 adds $400.00; step 50, ending 0: $500.00 is a point, no line.
    // Step 50, ending 25: $500.00 -> $525.00, a line of $25.00.
    const atPoint = priced(
      table([item('demo')], { minimum_job_charge: '500', price_point: { step: '50', ending: '0' } }),
      job([room('Kitchen', { unfinished_sf: 50 })]),
    );
    expect(atPoint.totals.low).toMatchObject({ minimum_charge: '400.00', total: '500.00' });
    expect(atPoint.totals.low.price_point).toBeUndefined();
    const rounded = priced(
      table([item('demo')], { minimum_job_charge: '500', price_point: { step: '50', ending: '25' } }),
      job([room('Kitchen', { unfinished_sf: 50 })]),
    );
    expect(rounded.totals.low).toMatchObject({ minimum_charge: '400.00', price_point: '25.00', total: '525.00' });
  });

  it('applies after tax and is not taxed', () => {
    // $1,000.00 taxable item, 10% tax on its full share: $100.00, total $1,100.00 -> $1,199.00 (99.00); tax stays $100.00.
    const result = priced(
      table([{ ...charge('1000.00'), taxable: true }], { sales_tax: { enabled: true, percent: '10' }, price_point: POINT }),
      job([room('Kitchen')], { emergency_calls: 1 }),
    );
    expect(result.totals.low).toMatchObject({ tax: '100.00', price_point: '99.00', total: '1199.00' });
  });

  it('off leaves the total and the content hash as before', () => {
    const plain = table([charge('2431.17')]);
    const result = priced(plain, job([room('Kitchen')], { emergency_calls: 1 }));
    expect(result.totals.low.total).toBe('2431.17');
    expect(result.totals.low.price_point).toBeUndefined();
    expect(Object.keys(parseTable(plain).policy)).not.toContain('price_point');
    const on = parseTable(table([charge('2431.17')], { price_point: POINT }));
    expect(contentHash(on)).not.toBe(contentHash(parseTable(plain)));
  });
});

describe('price-point schema', () => {
  const refused = (point: Obj) => checkTable(table([charge('10.00')], { price_point: point }));

  it('refuses an ending at or above the step', () => {
    expect(refused({ step: '100', ending: '100' }).ok).toBe(false);
    expect(refused({ step: '100', ending: '150' }).ok).toBe(false);
    expect(refused({ step: '100', ending: '99' }).ok).toBe(true);
  });

  it('refuses cents', () => {
    expect(refused({ step: '100.00', ending: '99' }).ok).toBe(false);
    expect(refused({ step: '100', ending: '99.50' }).ok).toBe(false);
  });

  it('refuses a step outside 10 to 10,000', () => {
    expect(refused({ step: '9', ending: '0' }).ok).toBe(false);
    expect(refused({ step: '10001', ending: '0' }).ok).toBe(false);
    expect(refused({ step: '10', ending: '9' }).ok).toBe(true);
    expect(refused({ step: '10000', ending: '9999' }).ok).toBe(true);
  });
});

describe('price-point properties', () => {
  it('never rounds down, and a larger total never rounds to a smaller point', () => {
    let state = 20261119;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state;
    };
    const problems: string[] = [];
    for (let index = 0; index < 2000; index += 1) {
      const step = 10 + (next() % 9991);
      const ending = next() % step;
      const left = Dec.parse(((next() % 50_000_000) / 100).toFixed(2));
      const right = left.add(Dec.parse(((next() % 100_000) / 100).toFixed(2)));
      const [low, high] = [left, right].map((total) => pricePointOf(total, Dec.fromInt(step), Dec.fromInt(ending)));
      if (low!.lt(left) || high!.lt(right)) problems.push(`${index}: below the total`);
      if (high!.lt(low!)) problems.push(`${index}: ${left} -> ${low}, ${right} -> ${high}`);
      if (!low!.sub(Dec.fromInt(ending)).div(Dec.fromInt(step)).toIntegral('DOWN').mul(Dec.fromInt(step)).add(Dec.fromInt(ending)).eq(low!) && low!.gt(Dec.fromInt(ending)))
        problems.push(`${index}: ${low} is not a price point`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('with rounding on, adding square feet never lowers either end and the high end stays at or above the low', () => {
    const problems: string[] = [];
    const priceList = table([item('demo', { unit_price: '3.17' })], {
      estimate_mode: 'range',
      range: { first_sf: 200, first_percent: '40', beyond_percent: '10' },
      minimum_job_charge: '350',
      sales_tax: { enabled: true, percent: '7.25' },
      price_point: { step: '250', ending: '199' },
    });
    let before: { low: number; high: number } | null = null;
    for (let sf = 10; sf <= 3000; sf += 37) {
      const result = priceEstimate(priceList, job([room('Kitchen', { unfinished_sf: sf })]));
      if (!result.ok) {
        problems.push(`${sf}: refused`);
        continue;
      }
      const low = Number(result.totals.low.total);
      const high = Number(result.totals.high!.total);
      if (high < low) problems.push(`${sf}: high ${high} < low ${low}`);
      if (before && (low < before.low || high < before.high)) problems.push(`${sf}: fell`);
      before = { low, high };
    }
    expect(problems).toEqual([]);
  });
});

describe('price-point rounding keeps the high end from falling when work is added', () => {
  const hours = (code: string, price: string, changes: Obj = {}) =>
    item(code, { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: price, ...changes });

  function highFor(firstPrice: string, changes: Obj = {}) {
    // A 10% cushion, a $100.00 trade minimum on the first labor line and a $0.99 fixed charge.
    const items = [hours('labor_a', firstPrice, { trade: 'labor_a' }), hours('labor_b', '10.01'), charge('0.99')];
    return priced(
      {
        ...table(items, { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '10', beyond_percent: '10' }, ...changes }),
        trades: [{ trade_id: 'labor_a', name: 'Labor A', minimum_charge: '100' }],
      },
      job([room('Kitchen', { unfinished_sf: 100 })], { labor_hours: 1, emergency_calls: 1 }),
    );
  }

  it('a cent moved to another line by the grown amounts does not cost a whole step', () => {
    // Unrounded, the first line at $10.04 grows to $11.044 and the second $10.01 to $11.011: running totals
    // $11.044 and $22.055 round to $11.04 and $22.06, so the second line is $11.02 and the high total
    // $0.99 + $100.00 + $11.02 = $112.01. At $10.05 the first grows to $11.055, the running totals round to
    // $11.06 and $22.07, the second line is $11.01 and the high total is $112.00, because the trade minimum takes
    // the first line's increase. Both grow to $112.001 before they are put into cents. Step 100, ending 12: both
    // round up from $112.001 to $212.00, not $212.00 and then $112.00.
    const before = highFor('10.04');
    const after = highFor('10.05');
    expect(before.totals.high?.total).toBe('112.01');
    expect(after.totals.high?.total).toBe('112.00');
    const roundedBefore = highFor('10.04', { price_point: { step: '100', ending: '12' } });
    const roundedAfter = highFor('10.05', { price_point: { step: '100', ending: '12' } });
    expect(roundedBefore.totals.high).toMatchObject({ total: '212.00', price_point: '99.99' });
    expect(roundedAfter.totals.high).toMatchObject({ total: '212.00', price_point: '100.00' });
  });

  it('raising the first line a cent at a time never lowers either rounded end', () => {
    const problems: string[] = [];
    let before: { low: number; high: number } | null = null;
    for (let cents = 1000; cents <= 1100; cents += 1) {
      const result = highFor((cents / 100).toFixed(2), { price_point: { step: '100', ending: '12' } });
      const now = { low: Number(result.totals.low.total), high: Number(result.totals.high!.total) };
      if (before && (now.low < before.low || now.high < before.high)) problems.push(`${cents}: ${JSON.stringify(before)} -> ${JSON.stringify(now)}`);
      before = now;
    }
    expect(problems).toEqual([]);
  });
});

describe('price-point adjustment on the documents', () => {
  const rounded = (changes: Obj = {}) =>
    priceEstimate(table([charge('2431.17')], { price_point: POINT, ...changes }), documentJob([room('Kitchen')], { emergency_calls: 1 }));

  it('the scope defense letter states the adjustment beside the rounded total', () => {
    const result = rounded();
    if (!result.ok) throw new Error(result.error);
    expect(result.documents?.letter).toContain('Itemized total: $2,499.00. Price-point adjustment (not taxed): $67.83.');
  });

  it('the letter states each end of a range, and nothing when rounding is off', () => {
    const range = rounded({ estimate_mode: 'range', range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' } });
    if (!range.ok) throw new Error(range.error);
    expect(range.documents?.letter).toContain('Price-point adjustment (not taxed): $67.83 at each end.');
    const off = priceEstimate(table([charge('2431.17')]), documentJob([room('Kitchen')], { emergency_calls: 1 }));
    if (!off.ok) throw new Error(off.error);
    expect(off.documents?.letter).not.toContain('Price-point');
  });
});
