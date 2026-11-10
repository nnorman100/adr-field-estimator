// Worked examples for the pricing rules (plan docs/plans/pricing.md section 6). Every expected number is
// worked by hand in the comment beside it, from the rule, not copied from an engine run or the old app.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { item, job, lineTotals, priced, room, table, type Obj } from './estimate-fixtures';

const BRACKETS = [
  { up_to_sf: 100, unit_price: '3.00' },
  { up_to_sf: null, unit_price: '1.00' },
];

const SERVICE_CALL = item('service_call', {
  group: 'job_charges',
  unit: 'each',
  quantity_source: 'field:emergency_calls',
  unit_price: '150.00',
});

const LABOR = item('labor', {
  group: 'labor',
  unit: 'hour',
  quantity_source: 'field:labor_hours',
  unit_price: '50.00',
});

const CUSHION: Obj = {
  estimate_mode: 'range',
  range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' },
};

describe('quantity, waste and eligibility', () => {
  it('W1 prices quantity times unit price', () => {
    // 120 sq ft x $2.00 = $240.00.
    const result = priced(table([item('demo')]), job([room('Kitchen', { unfinished_sf: 120 })]));
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 240.00']);
    expect(result.lines[0]).toMatchObject({
      quantity: '120',
      unit_price: '2',
      waste_percent: '0',
      room: 'Kitchen',
    });
    expect(result.totals.low.total).toBe('240.00');
    expect(result.totals.high).toBeNull();
  });

  it("W2 adds the item's waste percent", () => {
    // 120 x $2.00 x 1.10 = $264.00.
    const result = priced(
      table([item('demo', { waste_percent: '10' })]),
      job([room('Kitchen', { unfinished_sf: 120 })]),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 264.00']);
  });

  it("W3 uses the room's waste percent instead of the item's when the room has one", () => {
    // Room waste 15% replaces item waste 10%: 120 x $2.00 x 1.15 = $276.00.
    const result = priced(
      table([item('demo', { waste_percent: '10' })]),
      job([room('Kitchen', { unfinished_sf: 120, waste_percent: 15 })]),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 276.00']);
    expect(result.lines[0]?.waste_percent).toBe('15');
  });

  it("W4 prices a room item only in rooms whose category the item's filter allows", () => {
    // Cat 3 only item at $4.00: Bath 50 x $4.00 = $200.00; the Cat 1 kitchen gets no line.
    // Unfiltered item at $1.00: Kitchen 100 x $1.00 = $100.00, Bath 50 x $1.00 = $50.00. Total $350.00.
    const result = priced(
      table([
        item('demo_cat3', { categories: [3], unit_price: '4.00' }),
        item('demo_any', { unit_price: '1.00' }),
      ]),
      job([
        room('Kitchen', { unfinished_sf: 100 }),
        room('Bath', { category: 3, unfinished_sf: 50 }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Bath: demo cat3 = 200.00',
      'Kitchen: demo any = 100.00',
      'Bath: demo any = 50.00',
    ]);
    expect(result.totals.low.total).toBe('350.00');
  });

  it('W5 prices a job item only when some room has a category its filter allows', () => {
    // Containment ($95.00, Cat 2 or 3): on with a Cat 3 room, absent with only a Cat 1 room.
    const containment = item('containment', {
      group: 'job_charges',
      unit: 'each',
      quantity_source: 'typed',
      default_quantity: '1',
      categories: [2, 3],
      unit_price: '95.00',
    });
    const priceList = table([containment, item('demo')]);
    const wet = priced(priceList, job([room('Bath', { category: 3, unfinished_sf: 10 })]));
    expect(lineTotals(wet)).toEqual(['containment = 95.00', 'Bath: demo = 20.00']);
    const clean = priced(priceList, job([room('Bath', { unfinished_sf: 10 })]));
    expect(lineTotals(clean)).toEqual(['Bath: demo = 20.00']);
  });
});

describe('category and cabinetry multipliers', () => {
  it('W6 multiplies the unit price by the room category multiplier', () => {
    // Multipliers 1 / 1.25 / 1.5 on $2.00: 100 sq ft each = $200.00, $250.00, $300.00. Total $750.00.
    const result = priced(
      table([item('demo')], { category_multipliers: { '1': '1', '2': '1.25', '3': '1.5' } }),
      job([
        room('Hall', { unfinished_sf: 100 }),
        room('Bath', { category: 2, unfinished_sf: 100 }),
        room('Kitchen', { category: 3, unfinished_sf: 100 }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Hall: demo = 200.00',
      'Bath: demo = 250.00',
      'Kitchen: demo = 300.00',
    ]);
    expect(result.lines.map((line) => line.unit_price)).toEqual(['2', '2.5', '3']);
    expect(result.totals.low.total).toBe('750.00');
  });

  it('W7 adds the cabinetry multiplier to finished Cat 3 work in a custom-cabinetry room', () => {
    // Cat 3 x1.5, cabinetry x1.2, finished only. Finished 100 x $3.00 x 1.5 x 1.2 = $540.00;
    // unfinished 50 x $2.00 x 1.5 = $150.00. Total $690.00.
    const items = [
      item('demo_finished', { quantity_source: 'room:demolition:finished', unit_price: '3.00' }),
      item('demo_unfinished'),
    ];
    const rooms = [
      room('Kitchen', { category: 3, custom_cabinetry: true, finished_sf: 100, unfinished_sf: 50 }),
    ];
    const multipliers = { category_multipliers: { '1': '1', '2': '1', '3': '1.5' } };
    const finished = priced(
      table(items, { ...multipliers, cabinetry: { multiplier: '1.2', scope: 'finished_only' } }),
      job(rooms),
    );
    expect(lineTotals(finished)).toEqual([
      'Kitchen: demo finished = 540.00',
      'Kitchen: demo unfinished = 150.00',
    ]);
    // Scope "all Cat 3": unfinished also x1.2 = 50 x $3.60 = $180.00. Total $720.00.
    const all = priced(
      table(items, { ...multipliers, cabinetry: { multiplier: '1.2', scope: 'all_cat3' } }),
      job(rooms),
    );
    expect(lineTotals(all)).toEqual([
      'Kitchen: demo finished = 540.00',
      'Kitchen: demo unfinished = 180.00',
    ]);
    expect(all.totals.low.total).toBe('720.00');
  });
});

describe('square-foot brackets', () => {
  it('W8 tiered: each square foot is priced at the band it falls in', () => {
    // Bands: up to 100 sq ft at $3.00, over 100 at $1.00. 150 sq ft = 100 x $3.00 + 50 x $1.00 = $350.00.
    const result = priced(
      table([item('demo', { unit_price: '', price_brackets: BRACKETS })]),
      job([room('Kitchen', { unfinished_sf: 150 })]),
    );
    expect(lineTotals(result)).toEqual([
      'Kitchen: demo (tiered bracket: over 0 through 100 sq ft) = 300.00',
      'Kitchen: demo (tiered bracket: over 100 sq ft) = 50.00',
    ]);
    expect(result.lines[0]?.price_bracket).toEqual({ up_to_sf: 100, unit_price: '3.00' });
    expect(result.totals.low.total).toBe('350.00');
  });

  it('W9 tiered: across rooms, the dearest room fills the first band first', () => {
    // Cat 3 x1.5 makes the bath dearest. Bath 60 x $3.00 x 1.5 = $270.00 (band 1 now 60 of 100);
    // Kitchen 40 x $3.00 = $120.00 (band 1 full) and 40 x $1.00 = $40.00. Total $430.00.
    const result = priced(
      table([item('demo', { unit_price: '', price_brackets: BRACKETS })], {
        category_multipliers: { '1': '1', '2': '1', '3': '1.5' },
      }),
      job([
        room('Kitchen', { unfinished_sf: 80 }),
        room('Bath', { category: 3, unfinished_sf: 60 }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Bath: demo (tiered bracket: over 0 through 100 sq ft) = 270.00',
      'Kitchen: demo (tiered bracket: over 0 through 100 sq ft) = 120.00',
      'Kitchen: demo (tiered bracket: over 100 sq ft) = 40.00',
    ]);
    expect(result.totals.low.total).toBe('430.00');
  });

  it("W10 whole-job: the job's total square feet picks one band for every square foot", () => {
    // 150 sq ft is over 100, so all 150 x $1.00 = $150.00; 100 sq ft is in band 1, so 100 x $3.00 = $300.00.
    // The whole-job mode can price a bigger job lower just above a boundary (docs/sqft-brackets.md).
    const priceList = table([item('demo', { unit_price: '', price_brackets: BRACKETS })], {
      bracket_mode: 'whole-job',
    });
    const big = priced(priceList, job([room('Kitchen', { unfinished_sf: 150 })]));
    expect(lineTotals(big)).toEqual([
      "Kitchen: demo (whole-job bracket: over 100 sq ft of the job's total square feet) = 150.00",
    ]);
    const small = priced(priceList, job([room('Kitchen', { unfinished_sf: 100 })]));
    expect(lineTotals(small)).toEqual([
      "Kitchen: demo (whole-job bracket: over 0 through 100 sq ft of the job's total square feet) = 300.00",
    ]);
  });
});

describe('the range: cushion and uncertainty', () => {
  it('W11 cushion: the first 1,000 sq ft get 50%, area beyond 20%, labor hours 50%, job charges nothing', () => {
    // Low: 1,500 sq ft x $1.00 = $1,500.00 + 10 h x $50.00 = $500.00 + service call $150.00 = $2,150.00.
    // High labor: 1,000 x 1.5 + 500 x 1.2 = $2,100.00 area, $500.00 x 1.5 = $750.00 hours -> $2,850.00.
    // High: $2,850.00 + $150.00 = $3,000.00.
    const result = priced(
      table([SERVICE_CALL, item('demo', { unit_price: '1.00' }), LABOR], CUSHION),
      job([room('Basement', { unfinished_sf: 1500 })], { labor_hours: 10, emergency_calls: 1 }),
    );
    expect(result.totals.low.total).toBe('2150.00');
    expect(result.totals.labor_material_low).toBe('2000.00');
    expect(result.totals.labor_material_high).toBe('2850.00');
    expect(result.totals.high?.total).toBe('3000.00');
    expect(result.totals.range_explanation).toBe(
      'The high end allows 50% extra on the first 1,000 sq ft of work and 20% beyond, for hidden damage.',
    );
  });

  it('W12 single price: the same job has no high end', () => {
    // Range: 100 x $2.00 = $200.00 low, x1.5 = $300.00 high. Single: $200.00 and no high end.
    const rooms = [room('Kitchen', { unfinished_sf: 100 })];
    const range = priced(table([item('demo')], CUSHION), job(rooms));
    expect(range.totals.mode).toBe('range');
    expect([range.totals.low.total, range.totals.high?.total]).toEqual(['200.00', '300.00']);
    const single = priced(
      table([item('demo')], { ...CUSHION, estimate_mode: 'single' }),
      job(rooms),
    );
    expect(single.totals.mode).toBe('single');
    expect(single.totals.low.total).toBe('200.00');
    expect(single.totals.high).toBeNull();
    expect(single.totals.explanation).toBe('The price covers the itemized scope below.');
  });

  it('W13 uncertainty: the high end adds drying days and the hidden-damage percent', () => {
    // Low: 2 air movers x 3 days x $25.00 = $150.00 + 100 x $2.00 = $200.00 -> $350.00.
    // High: 2 x (3 + 2) days x $25.00 = $250.00 + $200.00 x 1.10 = $220.00 -> $470.00.
    const result = priced(
      table(
        [
          item('air_mover', {
            group: 'drying_equipment',
            unit: 'unit_day',
            quantity_source: 'count_days:air_movers*drying_days',
            unit_price: '25.00',
          }),
          item('demo'),
        ],
        {
          estimate_mode: 'range',
          assist: {
            drying_days: 3,
            range_method: 'uncertainty',
            extra_drying_days: 2,
            hidden_damage_percent: { '1': '10', '2': '0', '3': '0' },
          },
        },
      ),
      job([room('Kitchen', { unfinished_sf: 100 })], { air_movers: 2, drying_days: 3 }),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 200.00', 'air mover = 150.00']);
    expect(result.totals.low.total).toBe('350.00');
    expect(result.totals.high?.total).toBe('470.00');
  });
});

describe('minimum, overhead and profit, tax, after-hours', () => {
  it('W14 raises a small job to the minimum charge and leaves a larger job alone', () => {
    // Minimum $500.00. 100 x $2.00 = $200.00, so the minimum line is $300.00 and the total $500.00.
    // 300 x $2.00 = $600.00 is above the minimum: no minimum line.
    const priceList = table([item('demo')], { minimum_job_charge: '500' });
    const small = priced(priceList, job([room('Kitchen', { unfinished_sf: 100 })]));
    expect(small.totals.low).toMatchObject({
      subtotal: '200.00',
      minimum_charge: '300.00',
      total: '500.00',
    });
    const large = priced(priceList, job([room('Kitchen', { unfinished_sf: 300 })]));
    expect(large.totals.low).toMatchObject({
      subtotal: '600.00',
      minimum_charge: '0.00',
      total: '600.00',
    });
  });

  it('W15 in a range, a high end still under the minimum equals the low end', () => {
    // Low $200.00 -> $500.00 with the minimum. High labor $300.00 is still under $500.00, so high = $500.00.
    const result = priced(
      table([item('demo')], { ...CUSHION, minimum_job_charge: '500' }),
      job([room('Kitchen', { unfinished_sf: 100 })]),
    );
    expect(result.totals.low.total).toBe('500.00');
    expect(result.totals.high).toEqual(result.totals.low);
  });

  it('W16 adds overhead and profit on the subtotal, including any minimum line', () => {
    // 10% of $200.00 = $20.00 -> $220.00. With a $500.00 minimum: 10% of $500.00 = $50.00 -> $550.00.
    const rooms = [room('Kitchen', { unfinished_sf: 100 })];
    const plain = priced(table([item('demo')], { overhead_profit_percent: '10' }), job(rooms));
    expect(plain.totals.low).toMatchObject({ overhead_profit: '20.00', total: '220.00' });
    const floor = priced(
      table([item('demo')], { overhead_profit_percent: '10', minimum_job_charge: '500' }),
      job(rooms),
    );
    expect(floor.totals.low).toMatchObject({
      minimum_charge: '300.00',
      overhead_profit: '50.00',
      total: '550.00',
    });
  });

  it('W17 taxes only the items marked taxable, rounded to the cent once', () => {
    // Demolition 50 x $2.00 = $100.00 (not taxable); antimicrobial 50 x $1.10 = $55.00 (taxable).
    // Tax 8.25% x $55.00 = $4.5375 -> $4.54. Total $159.54.
    const items = [
      item('demo'),
      item('antimicrobial', { group: 'treatment', unit_price: '1.10', taxable: true }),
    ];
    const tax = { sales_tax: { enabled: true, percent: '8.25' } };
    const result = priced(table(items, tax), job([room('Kitchen', { unfinished_sf: 50 })]));
    expect(lineTotals(result)).toEqual([
      'Kitchen: demo = 100.00',
      'Kitchen: antimicrobial = 55.00',
    ]);
    expect(result.lines.map((line) => line.taxable)).toEqual([false, true]);
    expect(result.totals.low).toMatchObject({ subtotal: '155.00', tax: '4.54', total: '159.54' });
  });

  it('W18 taxes the taxable share of overhead and profit too', () => {
    // As W17 with 10% overhead and profit: O&P $15.50; tax 8.25% x $55.00 x 1.10 = $4.99125 -> $4.99.
    // Total $155.00 + $15.50 + $4.99 = $175.49.
    const items = [
      item('demo'),
      item('antimicrobial', { group: 'treatment', unit_price: '1.10', taxable: true }),
    ];
    const result = priced(
      table(items, {
        sales_tax: { enabled: true, percent: '8.25' },
        overhead_profit_percent: '10',
      }),
      job([room('Kitchen', { unfinished_sf: 50 })]),
    );
    expect(result.totals.low).toMatchObject({
      overhead_profit: '15.50',
      tax: '4.99',
      total: '175.49',
    });
  });

  it('W19 after hours: the multiplier adds to labor and materials only, and the after-hours item appears', () => {
    // Multiplier 1.5. Service call $150.00 + after-hours charge $75.00 (job charges, not multiplied)
    // + demolition 100 x $2.00 = $200.00 -> subtotal $425.00; adjustment 50% x $200.00 = $100.00; total $525.00.
    const priceList = table(
      [
        SERVICE_CALL,
        item('after_hours_charge', {
          group: 'job_charges',
          unit: 'each',
          quantity_source: 'after_hours',
          unit_price: '75.00',
        }),
        item('demo'),
      ],
      { after_hours: { multiplier: '1.5' } },
    );
    const rooms = [room('Kitchen', { unfinished_sf: 100 })];
    const night = priced(priceList, job(rooms, { is_after_hours: true, emergency_calls: 1 }));
    expect(lineTotals(night)).toEqual([
      'service call = 150.00',
      'after hours charge = 75.00',
      'Kitchen: demo = 200.00',
    ]);
    expect(night.totals.low).toMatchObject({
      subtotal: '425.00',
      after_hours: '100.00',
      total: '525.00',
    });
    // In working hours: no after-hours item and no adjustment. $150.00 + $200.00 = $350.00.
    const day = priced(priceList, job(rooms, { emergency_calls: 1 }));
    expect(lineTotals(day)).toEqual(['service call = 150.00', 'Kitchen: demo = 200.00']);
    expect(day.totals.low).toMatchObject({ after_hours: '0.00', total: '350.00' });
  });
});

describe('publishing checks and rounding', () => {
  it('W20 a blank price blocks publishing and pricing; a blank price on a disabled item does not', () => {
    const blank = table([item('demo', { unit_price: '' })]);
    expect(checkTable(blank).ok).toBe(false);
    expect(priceEstimate(blank, job([room('Kitchen', { unfinished_sf: 10 })]))).toMatchObject({
      ok: false,
      stage: 'table',
    });
    const blankBand = table([
      item('demo', {
        unit_price: '',
        price_brackets: [
          { up_to_sf: 100, unit_price: '' },
          { up_to_sf: null, unit_price: '1.00' },
        ],
      }),
    ]);
    expect(checkTable(blankBand).ok).toBe(false);
    const disabled = table([item('demo'), item('unused', { unit_price: '', enabled: false })]);
    expect(checkTable(disabled).ok).toBe(true);
  });

  it('W21 a zero price needs the allow-zero setting and the owner confirming it at publish', () => {
    const zero = (changes: Obj) =>
      table([item('demo'), item('free_check', { unit_price: '0', ...changes })]);
    expect(checkTable(zero({}), ['free_check']).ok).toBe(false);
    expect(checkTable(zero({ allow_zero: true })).ok).toBe(false);
    expect(checkTable(zero({ allow_zero: true }), ['free_check']).ok).toBe(true);
    // A published zero price prices as $0.00: 10 x $2.00 = $20.00 plus 10 x $0.00 = $0.00.
    const result = priced(
      zero({ allow_zero: true }),
      job([room('Kitchen', { unfinished_sf: 10 })]),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 20.00', 'Kitchen: free check = 0.00']);
  });

  it('W22 rounds each line to the cent once, half up, from the unrounded unit price', () => {
    // Cat 2 x2.5 on $0.05 = $0.125 per sq ft. 5 sq ft = $0.625 -> $0.63 (half up).
    // Rounding the unit price first would give 5 x $0.13 = $0.65; rounding half-even would give $0.62.
    const result = priced(
      table([item('demo', { unit_price: '0.05' })], {
        category_multipliers: { '1': '1', '2': '2.5', '3': '1' },
      }),
      job([room('Bath', { category: 2, unfinished_sf: 5 })]),
    );
    expect(result.lines[0]).toMatchObject({ unit_price: '0.125', total: '0.63' });
    expect(result.totals.low.total).toBe('0.63');
  });
});
