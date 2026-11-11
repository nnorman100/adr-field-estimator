// Worked examples for the per-item flags, per-trade minimums and the materials share (plan
// docs/plans/pricing.md section 3.4 and step S4-4c; owner decisions M2, M5, M6, M7 and M9). Every expected
// number is worked by hand in the comment beside it, from the rule, not from an engine run.

import { describe, expect, it } from 'vitest';

import { priceEstimate } from '../../src/engine/estimate';
import { PriceTableV3, contentHash, parseTable } from '../../src/engine/table';
import {
  documentJob,
  item,
  job,
  lineTotals,
  priced,
  room,
  table,
  type Obj,
} from './estimate-fixtures';

/** Air movers: $25.00 per unit per day, 2 movers for 3 days = 6 unit-days = $150.00. */
const AIR_MOVER = item('air_mover', {
  group: 'drying_equipment',
  unit: 'unit_day',
  quantity_source: 'count_days:air_movers*drying_days',
  unit_price: '25.00',
});
const MOVERS = { air_movers: 2, drying_days: 3 };

const NIGHT: Obj = { after_hours: { multiplier: '1.5' } };
const CUSHION: Obj = {
  estimate_mode: 'range',
  range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' },
};

/** A table with trade headings; the fixture's `table` only takes policy changes. */
function withTrades(items: Obj[], trades: Obj[], changes: Obj = {}): Obj {
  return { ...table(items, changes), trades };
}

const TRADES = [
  { trade_id: 'drywall', name: 'Drywall', minimum_charge: '400' },
  { trade_id: 'flooring', name: 'Flooring', minimum_charge: '300' },
];

describe('after-hours is a per-item flag (M5)', () => {
  const items = [
    item('demo', { after_hours: true }),
    item('antimicrobial', { group: 'treatment', unit_price: '1.00' }),
  ];
  const rooms = [room('Kitchen', { unfinished_sf: 100 })];

  it('W35 the multiplier applies only to flagged items, and only on an after-hours job', () => {
    // Demolition 100 x $2.00 = $200.00 (flagged); antimicrobial 100 x $1.00 = $100.00 (not flagged).
    // Multiplier 1.5: adjustment 50% x $200.00 = $100.00 (not 50% x $300.00). Total $300.00 + $100.00 = $400.00.
    const priceList = table(items, NIGHT);
    const night = priced(priceList, job(rooms, { is_after_hours: true }));
    expect(lineTotals(night)).toEqual(['Kitchen: demo = 200.00', 'Kitchen: antimicrobial = 100.00']);
    expect(night.totals.low).toMatchObject({ subtotal: '300.00', after_hours: '100.00', total: '400.00' });
    // In working hours there is no adjustment: $300.00.
    const day = priced(priceList, job(rooms));
    expect(day.totals.low).toMatchObject({ after_hours: '0.00', total: '300.00' });
    // With no item flagged an after-hours job has no adjustment at all.
    const none = priced(table([item('demo')], NIGHT), job(rooms, { is_after_hours: true }));
    expect(none.totals.low).toMatchObject({ after_hours: '0.00', total: '200.00' });
  });

  it('W36 at the high end the adjustment follows the flagged share of the labor and materials', () => {
    // Cushion 50% within the first 1,000 sq ft: high labor = 1.5 x $300.00 = $450.00, so flagged labor is
    // $200.00 x $450.00 / $300.00 = $300.00 and the adjustment 50% x $300.00 = $150.00. High total $600.00.
    const result = priced(table(items, { ...NIGHT, ...CUSHION }), job(rooms, { is_after_hours: true }));
    expect(result.totals.low).toMatchObject({ after_hours: '100.00', total: '400.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '450.00', after_hours: '150.00', total: '600.00' });
  });

  it('W37 equipment and job charges cannot carry the flag: the table is refused', () => {
    for (const changes of [
      { group: 'drying_equipment', unit: 'unit_day', quantity_source: 'count_days:air_movers*drying_days' },
      { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls' },
    ]) {
      expect(PriceTableV3.safeParse(table([item('x_item', { ...changes, after_hours: true })])).success).toBe(false);
    }
    expect(PriceTableV3.safeParse(table([item('labor_item', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', after_hours: true })])).success).toBe(true);
  });
});

describe('overhead and profit: off by default, its own line, per-item exemption (M6)', () => {
  const flagged = [item('demo'), { ...AIR_MOVER, no_overhead_profit: true }];
  const rooms = [room('Kitchen', { unfinished_sf: 100 })];

  it('W38 an exempt item is left out of the overhead and profit base', () => {
    // Demolition 100 x $2.00 = $200.00; air movers 6 x $25.00 = $150.00 (no O&P). Subtotal $350.00.
    // 10% x $200.00 = $20.00 on its own line. Total $370.00. Without the flag: 10% x $350.00 = $35.00, $385.00.
    const result = priced(table(flagged, { overhead_profit_percent: '10' }), job(rooms, MOVERS));
    expect(result.totals.low).toMatchObject({ subtotal: '350.00', overhead_profit: '20.00', total: '370.00' });
    const plain = priced(table([item('demo'), AIR_MOVER], { overhead_profit_percent: '10' }), job(rooms, MOVERS));
    expect(plain.totals.low).toMatchObject({ overhead_profit: '35.00', total: '385.00' });
  });

  it('W39 overhead and profit is off unless the owner sets a percent', () => {
    // No percent set: no overhead line, $350.00, flagged or not.
    expect(parseTable(table([item('demo')])).policy.overhead_profit_percent).toBe('0');
    const result = priced(table(flagged), job(rooms, MOVERS));
    expect(result.totals.low).toMatchObject({ overhead_profit: '0.00', total: '350.00' });
  });

  it('W40 an exempt item that is taxed carries no share of overhead and profit into its tax', () => {
    // Demolition 50 x $2.00 = $100.00 (not taxable); antimicrobial 50 x $1.10 = $55.00 (taxable, no O&P).
    // O&P 10% x $100.00 = $10.00. Tax 8.25% x $55.00 = $4.5375 -> $4.54 (no x 1.10). Total $155.00 + $10.00 + $4.54.
    const result = priced(
      table(
        [item('demo'), item('antimicrobial', { group: 'treatment', unit_price: '1.10', taxable: true, no_overhead_profit: true })],
        { overhead_profit_percent: '10', sales_tax: { enabled: true, percent: '8.25' } },
      ),
      job([room('Kitchen', { unfinished_sf: 50 })]),
    );
    expect(result.totals.low).toMatchObject({ overhead_profit: '10.00', tax: '4.54', total: '169.54' });
  });
});

describe('a minimum per trade heading beside the job minimum (M7)', () => {
  const items = [
    item('demo', { trade: 'drywall' }),
    item('floor_removal', { quantity_source: 'room:floor', unit_price: '4.00', trade: 'flooring' }),
  ];
  const both = [room('Kitchen', { unfinished_sf: 100, floor_sf: 120 })];
  const drywallOnly = [room('Kitchen', { unfinished_sf: 100 })];

  it('W41 a trade under its minimum is topped up on its own line; a trade over it is left alone', () => {
    // Drywall 100 x $2.00 = $200.00 < $400.00: minimum line $200.00. Flooring 120 x $4.00 = $480.00 >= $300.00: none.
    // Subtotal $680.00 + $200.00 = $880.00.
    const result = priced(withTrades(items, TRADES), job(both));
    expect(result.totals.low).toMatchObject({ subtotal: '680.00', minimum_charge: '0.00', total: '880.00' });
    expect(result.totals.low.trade_minimums).toEqual([{ trade_id: 'drywall', name: 'Drywall', amount: '200.00' }]);
  });

  it('W42 a trade with no work on the job has no minimum', () => {
    // Only drywall is priced ($200.00 -> $400.00). Flooring has no line, so no $300.00 is charged.
    const result = priced(withTrades(items, TRADES), job(drywallOnly));
    expect(result.totals.low.trade_minimums).toEqual([{ trade_id: 'drywall', name: 'Drywall', amount: '200.00' }]);
    expect(result.totals.low.total).toBe('400.00');
  });

  it('W43 the job minimum comes after the trade minimums and counts them', () => {
    // As W41: $880.00 after the trade line. Job minimum $1,000.00: minimum line $120.00, total $1,000.00.
    const result = priced(withTrades(items, TRADES, { minimum_job_charge: '1000' }), job(both));
    expect(result.totals.low).toMatchObject({ minimum_charge: '120.00', total: '1000.00' });
    expect(result.totals.low.trade_minimums).toEqual([{ trade_id: 'drywall', name: 'Drywall', amount: '200.00' }]);
  });

  it('W44 a trade minimum counts in a range; the high end tops up only what its larger amount still lacks', () => {
    // Cushion 50% within the first 1,000 sq ft. Low drywall $200.00 -> minimum line $200.00, total $400.00.
    // High drywall labor 1.5 x $200.00 = $300.00 -> minimum line $100.00, total $400.00.
    const result = priced(withTrades([items[0] as Obj], TRADES, CUSHION), job(drywallOnly));
    expect(result.totals.low).toMatchObject({ subtotal: '200.00', total: '400.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '300.00', total: '400.00' });
    expect(result.totals.high?.trade_minimums).toEqual([{ trade_id: 'drywall', name: 'Drywall', amount: '100.00' }]);
  });

  it('W45 an item that is exempt from overhead and profit does not count toward, or trigger, a minimum', () => {
    // Drywall demolition $200.00 (minimum $400.00 -> line $200.00) and a rental $150.00 under the same
    // heading, exempt from O&P. The rental is billed on top: $200.00 + $200.00 + $150.00 = $550.00.
    // With no demolition at all the rental alone triggers nothing: $150.00.
    const rental = { ...AIR_MOVER, trade: 'drywall', no_overhead_profit: true };
    const withWork = priced(withTrades([items[0] as Obj, rental], TRADES), job(drywallOnly, MOVERS));
    expect(withWork.totals.low).toMatchObject({ subtotal: '350.00', total: '550.00' });
    const rentalOnly = priced(withTrades([rental], TRADES), job(drywallOnly, MOVERS));
    expect(rentalOnly.totals.low).toMatchObject({ subtotal: '150.00', total: '150.00' });
    expect(rentalOnly.totals.low.trade_minimums).toEqual([]);
  });

  it('W46 overhead and profit applies to a minimum line, as it does to the job minimum', () => {
    // Drywall $200.00 -> $400.00. O&P 10% x $400.00 = $40.00. Total $440.00.
    const result = priced(
      withTrades([items[0] as Obj], TRADES, { overhead_profit_percent: '10' }),
      job(drywallOnly),
    );
    expect(result.totals.low).toMatchObject({ overhead_profit: '40.00', total: '440.00' });
  });

  it('W47 a heading that names no minimum, or an item with no heading, adds no line', () => {
    const noMinimum = [{ trade_id: 'drywall', name: 'Drywall', minimum_charge: '0' }];
    const result = priced(withTrades([items[0] as Obj, item('loose', { unit_price: '1.00' })], noMinimum), job(drywallOnly));
    expect(result.totals.low).toMatchObject({ subtotal: '300.00', total: '300.00' });
    expect(result.totals.low.trade_minimums).toEqual([]);
  });
});

describe('tax applies to the materials share of a taxable item (M9)', () => {
  const rooms = [room('Kitchen', { unfinished_sf: 50 })];
  const taxed = (share: Obj, changes: Obj = {}) =>
    table(
      [item('demo'), item('antimicrobial', { group: 'treatment', unit_price: '1.10', taxable: true, ...share })],
      { sales_tax: { enabled: true, percent: '8.25' }, ...changes },
    );

  it('W48 only the materials share of the line is taxed', () => {
    // Demolition 50 x $2.00 = $100.00 (not taxable); antimicrobial 50 x $1.10 = $55.00, 40% materials = $22.00.
    // Tax 8.25% x $22.00 = $1.815 -> $1.82. Total $155.00 + $1.82 = $156.82. A taxable item with no share set is
    // taxed whole, as before: 8.25% x $55.00 = $4.5375 -> $4.54.
    const result = priced(taxed({ materials_share_percent: '40' }), job(rooms));
    expect(result.totals.low).toMatchObject({ subtotal: '155.00', tax: '1.82', total: '156.82' });
    expect(priced(taxed({}), job(rooms)).totals.low.tax).toBe('4.54');
  });

  it('W49 the share of overhead and profit follows the materials share', () => {
    // As W48 with O&P 10%: O&P $15.50; tax 8.25% x $22.00 x 1.10 = $1.9965 -> $2.00. Total $155.00 + $15.50 + $2.00.
    const result = priced(taxed({ materials_share_percent: '40' }, { overhead_profit_percent: '10' }), job(rooms));
    expect(result.totals.low).toMatchObject({ overhead_profit: '15.50', tax: '2.00', total: '172.50' });
  });

  it('W50 a flagged item taxes its materials share at the after-hours multiplier', () => {
    // Demolition 100 x $2.00 = $200.00, flagged, taxable, 50% materials. Multiplier 1.5: adjustment $100.00.
    // Tax base $200.00 x 50% x 1.5 = $150.00; tax 10% = $15.00. Total $200.00 + $100.00 + $15.00 = $315.00.
    const result = priced(
      table([item('demo', { after_hours: true, taxable: true, materials_share_percent: '50' })], {
        ...NIGHT,
        sales_tax: { enabled: true, percent: '10' },
      }),
      job([room('Kitchen', { unfinished_sf: 100 })], { is_after_hours: true }),
    );
    expect(result.totals.low).toMatchObject({ after_hours: '100.00', tax: '15.00', total: '315.00' });
  });
});

describe('the "matches Xactimate line" note goes to the itemized claim, never the proposal (M2)', () => {
  const NOTE = 'WTR DRYW - tear out wet drywall, Cat 3';

  it('W51 the note is on the claim line and in no proposal, letter or compliance text', () => {
    const result = priced(
      table([item('demo', { xactimate_code: NOTE }), item('other', { unit_price: '1.00' })]),
      documentJob([room('Kitchen', { unfinished_sf: 100 })]),
    );
    const docs = result.documents;
    if (!docs) expect.fail('no documents');
    expect(docs.itemized_claim).toMatchObject([{ description: 'Kitchen: demo', xactimate_code: NOTE }, { xactimate_code: '' }]);
    for (const text of [docs.proposal, docs.letter, docs.compliance_notes]) {
      expect(JSON.stringify(text)).not.toContain('WTR DRYW');
    }
    expect(JSON.stringify(result.lines)).not.toContain('WTR DRYW');
  });

  it('W52 the note is free text up to 80 characters, with the same spreadsheet rules as other text', () => {
    const noted = (value: string) => table([item('demo', { xactimate_code: value })]);
    expect(PriceTableV3.safeParse(noted(NOTE)).success).toBe(true);
    expect(PriceTableV3.safeParse(noted('x'.repeat(80))).success).toBe(true);
    expect(PriceTableV3.safeParse(noted('x'.repeat(81))).success).toBe(false);
    expect(PriceTableV3.safeParse(noted('=WTR DRYW')).success).toBe(false);
    expect(parseTable(noted(`  ${NOTE}  `)).items[0]?.xactimate_code).toBe(NOTE);
  });
});

describe('schema and hash', () => {
  it('a flag, share or heading left at its default is the same table as none', () => {
    const plain = table([item('demo')]);
    const written = table([
      item('demo', { after_hours: false, no_overhead_profit: false, materials_share_percent: '100' }),
    ]);
    expect(parseTable(written)).toEqual(parseTable(plain));
    expect(contentHash(parseTable({ ...written, trades: [] }))).toBe(contentHash(parseTable(plain)));
    const flagged = table([item('demo', { after_hours: true })]);
    expect(contentHash(parseTable(flagged))).not.toBe(contentHash(parseTable(plain)));
    const headed = withTrades([item('demo', { trade: 'drywall' })], TRADES);
    expect(contentHash(parseTable(headed))).not.toBe(contentHash(parseTable(plain)));
  });

  it('headings are kept in id order, so the order they were written in does not change the hash', () => {
    const forward = withTrades([item('demo', { trade: 'drywall' })], TRADES);
    const backward = withTrades([item('demo', { trade: 'drywall' })], [...TRADES].reverse());
    expect(contentHash(parseTable(backward))).toBe(contentHash(parseTable(forward)));
  });

  it('refuses what cannot be priced', () => {
    const refused = (raw: unknown) => !PriceTableV3.safeParse(raw).success;
    const base = (changes: Obj) => table([item('demo', changes)]);
    expect(refused(base({ materials_share_percent: '101' }))).toBe(true);
    expect(refused(base({ taxable: true, materials_share_percent: '33.333' }))).toBe(true);
    expect(refused(base({ taxable: true, materials_share_percent: 40 }))).toBe(true);
    // A share on an item that is not taxed would be ignored silently.
    expect(refused(base({ materials_share_percent: '40' }))).toBe(true);
    expect(refused(base({ taxable: true, materials_share_percent: '40' }))).toBe(false);
    expect(refused(base({ after_hours: 'yes' }))).toBe(true);
    expect(refused(base({ no_overhead_profit: 1 }))).toBe(true);
    expect(refused(withTrades([item('demo', { trade: 'drywall' })], []))).toBe(true);
    expect(refused(withTrades([item('demo', { trade: 'plumbing' })], TRADES))).toBe(true);
    expect(refused(withTrades([item('demo')], [TRADES[0] as Obj, TRADES[0] as Obj]))).toBe(true);
    expect(refused(withTrades([item('demo')], [{ trade_id: 'Dry Wall', name: 'x', minimum_charge: '1' }]))).toBe(true);
    expect(refused(withTrades([item('demo')], [{ trade_id: 'drywall', name: '=x', minimum_charge: '1' }]))).toBe(true);
    expect(refused(withTrades([item('demo')], [{ trade_id: 'drywall', name: 'Drywall', minimum_charge: '-1' }]))).toBe(true);
    expect(refused(withTrades([item('demo')], [{ trade_id: 'drywall', name: 'Drywall', minimum_charge: 400 }]))).toBe(true);
    expect(refused(withTrades([item('demo')], [{ trade_id: 'drywall', name: 'Drywall', minimum_charge: '1', extra: 1 }]))).toBe(true);
    const many = Array.from({ length: 31 }, (_, index) => ({ trade_id: `trade_${index}`, name: `T${index}`, minimum_charge: '0' }));
    expect(refused(withTrades([item('demo')], many))).toBe(true);
    expect(refused(withTrades([item('demo', { trade: 'drywall' })], TRADES))).toBe(false);
  });

  it('an old table with none of the new keys prices as before', () => {
    const result = priceEstimate(table([item('demo')]), job([room('Kitchen', { unfinished_sf: 10 })]));
    expect(result).toMatchObject({ ok: true, totals: { low: { total: '20.00', trade_minimums: [] } } });
  });
});
