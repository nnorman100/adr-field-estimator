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

describe('price-point rounding of a high end that is already a price point', () => {
  it('keeps a $11.00 high end with no line, step 10 ending 1', () => {
    // One labor line of $10.01 with a 9.90% cushion grows to $11.00099, which settles at $11.00: already a
    // price point (1 + 10), so the high end keeps $11.00 and prints no adjustment. The low end $10.01 rounds up to $11.00.
    const result = priced(
      table([item('labor_a', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '10.01' })], {
        estimate_mode: 'range',
        range: { first_sf: 1000, first_percent: '9.9', beyond_percent: '9.9' },
        price_point: { step: '10', ending: '1' },
      }),
      job([room('Kitchen', { unfinished_sf: 100 })], { labor_hours: 1 }),
    );
    expect(result.totals.high?.total).toBe('11.00');
    expect(result.totals.high?.price_point).toBeUndefined();
    expect(result.totals.low).toMatchObject({ subtotal: '10.01', price_point: '0.99', total: '11.00' });
  });
});

describe('price-point adjustment on the documents', () => {
  const rounded = (changes: Obj = {}) =>
    priceEstimate(table([charge('2431.17')], { price_point: POINT, ...changes }), documentJob([room('Kitchen')], { emergency_calls: 1 }));

  it('the scope defense letter states the adjustment on its own line after the rounded total', () => {
    const result = rounded();
    if (!result.ok) throw new Error(result.error);
    expect(result.documents?.letter).toContain('Itemized total: $2,499.00.\nPrice-point adjustment (not taxed): $67.83.');
  });

  it('the letter states each end of a range, and nothing when rounding is off', () => {
    const range = rounded({ estimate_mode: 'range', range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' } });
    if (!range.ok) throw new Error(range.error);
    expect(range.documents?.letter).toContain('\nPrice-point adjustment (not taxed): $67.83 at the low end and $67.83 at the high end.');
    const off = priceEstimate(table([charge('2431.17')]), documentJob([room('Kitchen')], { emergency_calls: 1 }));
    if (!off.ok) throw new Error(off.error);
    expect(off.documents?.letter).not.toContain('Price-point');
  });
});
