// Worked examples for category rows and Mold rooms (plan docs/plans/pricing.md section 3.4, step S4-4a).
// Every expected number is worked by hand in the comment beside it, from the rule, not from an engine run.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { PriceTableV3, contentHash, parseTable } from '../../src/engine/table';
import { item, job, lineTotals, priced, room, table, type Obj } from './estimate-fixtures';

/** Multipliers that make a wrongly applied multiplier show: Cat 1 x1, Cat 2 x1.5, Cat 3 x2, cabinetry x1.2. */
const MULTIPLIERS: Obj = {
  category_multipliers: { '1': '1', '2': '1.5', '3': '2' },
  cabinetry: { multiplier: '1.2', scope: 'all_cat3' },
};

/** Demolition at $2.00 by default, $5.00 as set in Cat 3 rooms and $4.00 as set in Mold rooms. */
const TWO_ROWS = item('demo', {
  rows: [
    { category: 3, unit_price: '5.00' },
    { category: 'mold', unit_price: '4.00' },
  ],
});

describe('precedence: category row, then default row', () => {
  it('W24 a category row is used as set: no category or cabinetry multiplier', () => {
    // Kitchen, Cat 3 with custom cabinetry, 100 sq ft: the Cat 3 row, 100 x $5.00 = $500.00 (not x2, not x1.2).
    // Closet, Mold, 10 sq ft: the Mold row, 10 x $4.00 = $40.00. Total $540.00.
    const result = priced(
      table([TWO_ROWS], MULTIPLIERS),
      job([
        room('Kitchen', { category: 3, custom_cabinetry: true, unfinished_sf: 100 }),
        room('Closet', { category: 'mold', unfinished_sf: 10 }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['Kitchen, Cat 3: demo = 500.00', 'Closet, Mold: demo = 40.00']);
    expect(result.lines.map((line) => line.unit_price)).toEqual(['5', '4']);
    expect(result.totals.low.total).toBe('540.00');
    expect(result.engine_version).toBe('dryscope-v3');
  });

  it('W25 a water room with no row of its category uses the default row and its multiplier', () => {
    // Same item. Hall, Cat 1, 100 sq ft: $2.00 x1 = $200.00. Bath, Cat 2, 100 sq ft: $2.00 x1.5 = $3.00,
    // so $300.00. Neither room has a row, so both lines name no row. Total $500.00.
    const result = priced(
      table([TWO_ROWS], MULTIPLIERS),
      job([room('Hall', { unfinished_sf: 100 }), room('Bath', { category: 2, unfinished_sf: 100 })]),
    );
    expect(lineTotals(result)).toEqual(['Hall: demo = 200.00', 'Bath: demo = 300.00']);
    expect(result.totals.low.total).toBe('500.00');
  });

  it('W26 the default row keeps the cabinetry multiplier in a Cat 3 room when the item has no Cat 3 row', () => {
    // Item with only a Mold row. Kitchen, Cat 3 with custom cabinetry, 100 sq ft:
    // $2.00 x2 x1.2 = $4.80, so $480.00.
    const result = priced(
      table([item('demo', { rows: [{ category: 'mold', unit_price: '4.00' }] })], MULTIPLIERS),
      job([room('Kitchen', { category: 3, custom_cabinetry: true, unfinished_sf: 100 })]),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo = 480.00']);
  });
});

describe('Mold rooms', () => {
  it('W27 a Mold room priced by the default row takes no multiplier', () => {
    // Multipliers Cat 3 x2, cabinetry x1.2 on all Cat 3 work. Demolition $2.00, no rows.
    // Closet, Mold, custom cabinetry, 50 sq ft: 50 x $2.00 = $100.00, no multiplier.
    // Attic, Cat 3, custom cabinetry, 50 sq ft: $2.00 x2 x1.2 = $4.80, so $240.00.
    // Mold cleaning ($1.50, Mold rooms only): Closet 50 x $1.50 = $75.00; the Attic gets no line.
    // Total $415.00.
    const result = priced(
      table(
        [
          item('demo'),
          item('mold_clean', { group: 'treatment', categories: ['mold'], unit_price: '1.50' }),
        ],
        MULTIPLIERS,
      ),
      job([
        room('Closet', { category: 'mold', custom_cabinetry: true, unfinished_sf: 50 }),
        room('Attic', { category: 3, custom_cabinetry: true, unfinished_sf: 50 }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Closet: demo = 100.00',
      'Attic: demo = 240.00',
      'Closet: mold clean = 75.00',
    ]);
    expect(result.lines.map((line) => line.unit_price)).toEqual(['2', '4.8', '1.5']);
    expect(result.totals.low.total).toBe('415.00');
  });

  it('W28 under the uncertainty method a Mold room carries the category 3 hidden-damage percent', () => {
    // Hidden damage 0% / 0% / 20%. Closet, Mold, 100 sq ft x $2.00 = $200.00 low; high $200.00 x 1.20 = $240.00.
    const result = priced(
      table([item('demo')], {
        estimate_mode: 'range',
        assist: {
          drying_days: 3,
          range_method: 'uncertainty',
          extra_drying_days: 0,
          hidden_damage_percent: { '1': '0', '2': '0', '3': '20' },
        },
      }),
      job([room('Closet', { category: 'mold', unfinished_sf: 100 })]),
    );
    expect(result.totals.low.total).toBe('200.00');
    expect(result.totals.high?.total).toBe('240.00');
    expect(result.totals.range_explanation).toContain('hidden damage of 20% in category 3 or mold rooms');
  });

  it('W29 a Mold room that no item prices is named as mold work in the advisory warning', () => {
    // Demolition for water rooms only: the Hall prices 10 x $2.00 = $20.00; the Mold closet prices nothing.
    const result = priced(
      table([item('demo', { categories: [1, 2, 3] })]),
      job([room('Hall', { unfinished_sf: 10 }), room('Closet', { category: 'mold', unfinished_sf: 40 })]),
    );
    expect(lineTotals(result)).toEqual(['Hall: demo = 20.00']);
    expect(result.warnings.advisory).toContainEqual({
      code: 'unpriced_room',
      room: 'Closet',
      text: "Closet: 40 sq ft of mold work prices nothing on your company's price list.",
    });
  });
});

describe('brackets count per row', () => {
  it('W30 tiered: the shared-counting counterexample, as two rows of one item, never falls', () => {
    // One item: Cat 1 row flat $0.10; Cat 3 row $10.00 per sq ft up to 100 sq ft, then $1.00; default
    // $5.00 (no Cat 2 or Mold room here). Before: Hall (Cat 1) 0 sq ft, Bath (Cat 3) 100 sq ft.
    // Cat 3 row: 100 x $10.00 = $1,000.00. Total $1,000.00.
    // After: Hall grows to 100 sq ft. Cat 1 row: 100 x $0.10 = $10.00. The Cat 3 row still counts only
    // the Bath's 100 sq ft: $1,000.00. Total $1,010.00. Shared counting would put the Bath's 100 sq ft in
    // the $1.00 band ($100.00) and the total would fall by $890.00 to $110.00.
    const priceList = table([
      item('demo', {
        unit_price: '5.00',
        rows: [
          { category: 1, unit_price: '0.10' },
          {
            category: 3,
            price_brackets: [
              { up_to_sf: 100, unit_price: '10.00' },
              { up_to_sf: null, unit_price: '1.00' },
            ],
          },
        ],
      }),
    ]);
    const bath = room('Bath', { category: 3, unfinished_sf: 100 });
    const before = priced(priceList, job([room('Hall', { unfinished_sf: 0 }), bath]));
    expect(lineTotals(before)).toEqual([
      'Bath, Cat 3: demo (tiered bracket: over 0 through 100 sq ft) = 1000.00',
    ]);
    const after = priced(priceList, job([room('Hall', { unfinished_sf: 100 }), bath]));
    expect(lineTotals(after)).toEqual([
      'Hall, Cat 1: demo = 10.00',
      'Bath, Cat 3: demo (tiered bracket: over 0 through 100 sq ft) = 1000.00',
    ]);
    expect(after.totals.low.total).toBe('1010.00');
  });

  it("W31 tiered: each row fills its own bands, and the default row's bands ignore rooms a row priced", () => {
    // Default row: $3.00 up to 100 sq ft, then $1.00, with Cat 2 x1.5. Cat 3 row: $6.00 up to 50 sq ft,
    // then $4.00, as set. Mold row: flat $7.00.
    // Default row, dearest first: Bath (Cat 2) 60 x $3.00 x1.5 = $270.00 (band 1 now 60 of 100);
    // Hall (Cat 1) 40 x $3.00 = $120.00 (band 1 full), 40 x $1.00 = $40.00. Row total $430.00.
    // Cat 3 row, equal prices in room order: Kitchen 50 x $6.00 = $300.00, 20 x $4.00 = $80.00;
    // Laundry 30 x $4.00 = $120.00. Row total $500.00.
    // Mold row: Closet 10 x $7.00 = $70.00. Total $1,000.00.
    // Counting the Cat 3 rooms in the default row's bands would move the Hall's first 40 sq ft to $1.00.
    const result = priced(
      table(
        [
          item('demo', {
            unit_price: '',
            price_brackets: [
              { up_to_sf: 100, unit_price: '3.00' },
              { up_to_sf: null, unit_price: '1.00' },
            ],
            rows: [
              { category: 'mold', unit_price: '7.00' },
              {
                category: 3,
                price_brackets: [
                  { up_to_sf: 50, unit_price: '6.00' },
                  { up_to_sf: null, unit_price: '4.00' },
                ],
              },
            ],
          }),
        ],
        MULTIPLIERS,
      ),
      job([
        room('Kitchen', { category: 3, unfinished_sf: 70 }),
        room('Hall', { unfinished_sf: 80 }),
        room('Closet', { category: 'mold', unfinished_sf: 10 }),
        room('Bath', { category: 2, unfinished_sf: 60 }),
        room('Laundry', { category: 3, unfinished_sf: 30 }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Bath: demo (tiered bracket: over 0 through 100 sq ft) = 270.00',
      'Hall: demo (tiered bracket: over 0 through 100 sq ft) = 120.00',
      'Hall: demo (tiered bracket: over 100 sq ft) = 40.00',
      'Kitchen, Cat 3: demo (tiered bracket: over 0 through 50 sq ft) = 300.00',
      'Kitchen, Cat 3: demo (tiered bracket: over 50 sq ft) = 80.00',
      'Laundry, Cat 3: demo (tiered bracket: over 50 sq ft) = 120.00',
      'Closet, Mold: demo = 70.00',
    ]);
    expect(result.totals.low.total).toBe('1000.00');
  });

  it("W32 whole-job: the job's total square feet picks the band in each row's own list", () => {
    // Default flat $2.00 (no Cat 2 or Mold room here). Cat 1 row: $3.00 up to 100 sq ft, then $1.00.
    // Cat 3 row: $6.00 up to 150 sq ft, then $4.00. Hall (Cat 1) 80 sq ft, Bath (Cat 3) 60 sq ft:
    // the job's total is 140 sq ft. Cat 1 row: 140 is over 100, so 80 x $1.00 = $80.00 (the row's own
    // 80 sq ft would have been band 1). Cat 3 row: 140 is within 150, so 60 x $6.00 = $360.00. Total $440.00.
    const result = priced(
      table(
        [
          item('demo', {
            rows: [
              {
                category: 3,
                price_brackets: [
                  { up_to_sf: 150, unit_price: '6.00' },
                  { up_to_sf: null, unit_price: '4.00' },
                ],
              },
              {
                category: 1,
                price_brackets: [
                  { up_to_sf: 100, unit_price: '3.00' },
                  { up_to_sf: null, unit_price: '1.00' },
                ],
              },
            ],
          }),
        ],
        { bracket_mode: 'whole-job' },
      ),
      job([room('Hall', { unfinished_sf: 80 }), room('Bath', { category: 3, unfinished_sf: 60 })]),
    );
    expect(lineTotals(result)).toEqual([
      "Hall, Cat 1: demo (whole-job bracket: over 100 sq ft of the job's total square feet) = 80.00",
      "Bath, Cat 3: demo (whole-job bracket: over 0 through 150 sq ft of the job's total square feet) = 360.00",
    ]);
    expect(result.totals.low.total).toBe('440.00');
  });
  it('W33 uncertainty: the high end rounds each row of one item on its own, as the low end does', () => {
    // Default row and Cat 3 row each one open band at $0.67; every hidden-damage percent 0, so the high
    // end must equal the low end. Hall (Cat 1) and Bath (Cat 3) at 1.5 sq ft: each row is 1.005, so
    // $1.01 + $1.01 = $2.02 (rounding the two rows as one amount gives $2.01). At 1.2 sq ft each row is
    // 0.804, so $0.80 + $0.80 = $1.60 (as one amount, $1.61).
    const band = [{ up_to_sf: null, unit_price: '0.67' }];
    const priceList = (mode: string) =>
      table(
        [
          item('demo', {
            unit_price: '',
            price_brackets: band,
            rows: [{ category: 3, price_brackets: band }],
          }),
        ],
        {
          bracket_mode: mode,
          estimate_mode: 'range',
          assist: {
            drying_days: 3,
            range_method: 'uncertainty',
            extra_drying_days: 0,
            hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
          },
        },
      );
    const rooms = (sf: number) =>
      job([room('Hall', { unfinished_sf: sf }), room('Bath', { category: 3, unfinished_sf: sf })]);
    for (const mode of ['tiered', 'whole-job']) {
      for (const [sf, total] of [
        [1.5, '2.02'],
        [1.2, '1.60'],
      ] as const) {
        const result = priced(priceList(mode), rooms(sf));
        expect(result.totals.low.total).toBe(total);
        expect(result.totals.high?.total).toBe(total);
      }
    }
  });
});

describe('category rows in the table schema', () => {
  const refused = (changes: Obj, filter?: Obj) =>
    !PriceTableV3.safeParse(table([item('demo', { ...filter, ...changes })])).success;

  it('accepts Mold in the category list and rows in category order, with a stable hash', () => {
    const written = table([
      item('demo', {
        categories: ['mold', 3],
        rows: [
          { category: 'mold', unit_price: '4' },
          { category: 3, unit_price: '5.00' },
        ],
      }),
    ]);
    const parsed = parseTable(written);
    expect(parsed.items[0]?.categories).toEqual([3, 'mold']);
    expect(parsed.items[0]?.rows).toEqual([
      { category: 3, unit_price: '5.00' },
      { category: 'mold', unit_price: '4.00' },
    ]);
    expect(parseTable(parsed)).toEqual(parsed);
    // An empty row list is the same table as no rows, so it hashes the same.
    expect(contentHash(parseTable(table([item('demo', { rows: [] })])))).toBe(
      contentHash(parseTable(table([item('demo')]))),
    );
  });

  it('refuses a repeated row, a row the filter excludes, a row with both or neither price, and rows on a job item', () => {
    expect(refused({ rows: [{ category: 3, unit_price: '1' }] })).toBe(false);
    expect(refused({ rows: [{ category: 4, unit_price: '1' }] })).toBe(true);
    expect(refused({ rows: [{ category: '3', unit_price: '1' }] })).toBe(true);
    expect(
      refused({
        rows: [
          { category: 3, unit_price: '1' },
          { category: 3, unit_price: '2' },
        ],
      }),
    ).toBe(true);
    expect(refused({ categories: [1, 2], rows: [{ category: 3, unit_price: '1' }] })).toBe(true);
    expect(refused({ categories: [1, 3], rows: [{ category: 3, unit_price: '1' }] })).toBe(false);
    expect(refused({ rows: [{ category: 3 }] })).toBe(true);
    const bands = [{ up_to_sf: null, unit_price: '1.00' }];
    expect(refused({ rows: [{ category: 3, unit_price: '1', price_brackets: bands }] })).toBe(true);
    expect(refused({ rows: [{ category: 3, unit_price: 1 }] })).toBe(true);
    expect(refused({ rows: [{ category: 3, price_brackets: [{ up_to_sf: 100, unit_price: '1' }] }] })).toBe(true);
    const typed = { group: 'job_charges', unit: 'each', quantity_source: 'typed' };
    expect(refused({ ...typed, rows: [{ category: 3, unit_price: '1' }] })).toBe(true);
    expect(refused({ unit: 'lf', rows: [{ category: 3, price_brackets: bands }] })).toBe(true);
  });

  it('a blank row price blocks publishing; a zero row price needs allow_zero and a confirmation', () => {
    const withRow = (unitPrice: string, changes: Obj = {}) =>
      table([item('demo', { rows: [{ category: 3, unit_price: unitPrice }], ...changes })]);
    expect(checkTable(withRow('')).ok).toBe(false);
    expect(priceEstimate(withRow(''), job([room('Hall', { unfinished_sf: 10 })]))).toMatchObject({
      ok: false,
      stage: 'table',
    });
    expect(PriceTableV3.safeParse(withRow('0')).success).toBe(false);
    expect(checkTable(withRow('0', { allow_zero: true })).ok).toBe(false);
    expect(checkTable(withRow('0', { allow_zero: true }), ['demo']).ok).toBe(true);
  });
});
