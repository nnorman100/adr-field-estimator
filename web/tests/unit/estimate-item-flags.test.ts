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

describe('the range explanation names what tax carries', () => {
  const rates: Obj = { ...CUSHION, overhead_profit_percent: '10', sales_tax: { enabled: true, percent: '10' } };
  const rooms = [room('Kitchen', { unfinished_sf: 100 })];
  const rental = { ...AIR_MOVER, taxable: true, no_overhead_profit: true };

  it('W56 a taxable item exempt from overhead and profit carries no share of it into the tax sentence', () => {
    // Demolition $200.00 (not taxable); rental 6 x $25.00 = $150.00, taxable and exempt. Tax 10% x $150.00 = $15.00.
    const exempt = priced(table([item('demo'), rental], rates), job(rooms, MOVERS));
    expect(exempt.totals.low.tax).toBe('15.00');
    expect(exempt.totals.explanation).toContain('Sales tax at 10% applies to the items marked taxable.');
    // With a taxable item that does carry it, the share is named with the same exception as the O&P sentence.
    const mixed = priced(
      table([item('demo', { taxable: true }), rental], rates),
      job(rooms, MOVERS),
    );
    expect(mixed.totals.explanation).toContain(
      'Sales tax at 10% applies to the items marked taxable and their share of overhead and profit, except on items marked as carrying none.',
    );
  });
});

describe('the cushion grows each labor line by its own band', () => {
  it('W57 a flagged labor-hours line takes the first-band percent, not the blended growth of all labor', () => {
    // Demolition 2,000 x $1.00 = $2,000.00 (not flagged); labor 10 hours x $50.00 = $500.00 (flagged).
    // Multiplier 1.5. Low: adjustment 50% x $500.00 = $250.00, total $2,750.00.
    // Cushion: first 1,000 sq ft at 50%, beyond at 0%. High area $2,000.00 + 50% x $1,000.00 = $2,500.00;
    // labor hours at the first percent, 1.5 x $500.00 = $750.00. High labor $3,250.00.
    // Adjustment 50% x $750.00 = $375.00 (not 50% x $500.00 x 3,250 / 2,500 = $325.00). High total $3,625.00.
    const result = priced(
      table(
        [
          item('demo', { unit_price: '1.00' }),
          item('labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '50.00', after_hours: true }),
        ],
        { ...NIGHT, estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '0' } },
      ),
      job([room('Kitchen', { unfinished_sf: 2000 })], { labor_hours: 10, is_after_hours: true }),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '2500.00', after_hours: '250.00', total: '2750.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '3250.00', after_hours: '375.00', total: '3625.00' });
  });

  it('W59 with three cushion bands each area line takes the bands its own dearest square feet fall in', () => {
    // Kitchen 200 sq ft: demolition $2.00 = $400.00 (flagged); antimicrobial $1.00 = $200.00. Multiplier 1.5.
    // Bands: first 100 sq ft at 50%, up to 300 at 20%, beyond at 0%. Dearest first: demolition.
    // Demolition: 100 sq ft ($200.00) at 50% + 100 sq ft ($200.00) at 20% = $140.00, so $540.00.
    // Antimicrobial: 100 sq ft ($100.00) at 20% = $20.00, so $220.00. High labor $760.00.
    // Adjustment 50% x $540.00 = $270.00 (not 50% x $400.00 x 760 / 600). High total $1,030.00. Low $800.00.
    const result = priced(
      table([item('demo', { after_hours: true }), item('antimicrobial', { group: 'treatment', unit_price: '1.00' })], {
        ...NIGHT,
        estimate_mode: 'range',
        range: {
          first_sf: 100,
          first_percent: '50',
          beyond_percent: '0',
          brackets: [
            { up_to_sf: 100, percent: '50' },
            { up_to_sf: 300, percent: '20' },
            { up_to_sf: null, percent: '0' },
          ],
        },
      }),
      job([room('Kitchen', { unfinished_sf: 200 })], { is_after_hours: true }),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '600.00', after_hours: '200.00', total: '800.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '760.00', after_hours: '270.00', total: '1030.00' });
  });
});

describe('the cushion taxes each grown labor line', () => {
  const labor = (changes: Obj) =>
    item('labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '50.00', taxable: true, ...changes });
  const range: Obj = {
    estimate_mode: 'range',
    range: { first_sf: 1000, first_percent: '50', beyond_percent: '0' },
    sales_tax: { enabled: true, percent: '10' },
  };
  const rooms = [room('Kitchen', { unfinished_sf: 2000 })];

  it('W60 a flagged taxable line and an unflagged one, or a reduced materials share, are taxed on their own growth', () => {
    // As W57, both lines taxable. High: demolition $2,500.00, labor hours $750.00 (flagged, multiplier 1.5).
    // Tax 10% x ($2,500.00 + $750.00 x 1.5) = $362.50 (not 10% x ($2,000.00 + $750.00) x 3,250 / 2,500 = $357.50).
    const night = priced(
      table([item('demo', { unit_price: '1.00', taxable: true }), labor({ after_hours: true })], { ...NIGHT, ...range }),
      job(rooms, { labor_hours: 10, is_after_hours: true }),
    );
    expect(night.totals.high).toMatchObject({ subtotal: '3250.00', after_hours: '375.00', tax: '362.50' });
    // In working hours with a 40% materials share on the labor: low 10% x ($2,000.00 + $200.00) = $220.00;
    // high 10% x ($2,500.00 + $750.00 x 40%) = $280.00 (not 10% x $2,200.00 x 3,250 / 2,500 = $286.00).
    const shared = priced(
      table([item('demo', { unit_price: '1.00', taxable: true }), labor({ materials_share_percent: '40' })], range),
      job(rooms, { labor_hours: 10 }),
    );
    expect(shared.totals.low.tax).toBe('220.00');
    expect(shared.totals.high?.tax).toBe('280.00');
  });

  it('W62 a tax flag on one labor line taxes its own growth even beside labor that is not taxable', () => {
    // As W57. Demolition 2,000 x $1.00 grows to $2,500.00; labor 10 hours x $50.00 grows to $750.00. Tax 10%.
    const hours = (changes: Obj) =>
      item('labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '50.00', ...changes });
    const highTax = (items: Obj[], changes: Obj, jobChanges: Obj) =>
      priced(table(items, { ...range, ...changes }), job(rooms, { labor_hours: 10, ...jobChanges })).totals.high?.tax;
    const demo = item('demo', { unit_price: '1.00' });
    // Only the hours are taxable, at a 40% share: 10% x $750.00 x 40% = $30.00 (not 10% x $200.00 x 3,250 / 2,500).
    expect(highTax([demo, hours({ taxable: true, materials_share_percent: '40' })], {}, {})).toBe('30.00');
    // Only the hours are taxable and flagged, multiplier 1.5: 10% x $750.00 x 1.5 = $112.50 (not $97.50).
    expect(highTax([demo, hours({ taxable: true, after_hours: true })], NIGHT, { is_after_hours: true })).toBe('112.50');
    // Only the hours are taxable and exempt, O&P 10%: 10% x $750.00 = $75.00 (not $65.00).
    expect(
      highTax([demo, hours({ taxable: true, no_overhead_profit: true })], { overhead_profit_percent: '10' }, {}),
    ).toBe('75.00');
    // Only the demolition is taxable, at a 40% share: 10% x $2,500.00 x 40% = $100.00 (not $104.00).
    expect(
      highTax([item('demo', { unit_price: '1.00', taxable: true, materials_share_percent: '40' }), hours({})], {}, {}),
    ).toBe('100.00');
    // With no flag, demolition taxable and hours not: 10% x $2,500.00 = $250.00. The old proportion,
    // 10% x $2,000.00 x 3,250 / 2,500 = $260.00, taxed the growth of labor that is not taxable.
    expect(highTax([item('demo', { unit_price: '1.00', taxable: true }), hours({})], {}, {})).toBe('250.00');
    // The hours exempt and not taxable, O&P 10%: 10% x $2,500.00 x 1.10 = $275.00 (not $286.00, which taxed
    // overhead on the hours' growth that the overhead line does not bill).
    expect(
      highTax([item('demo', { unit_price: '1.00', taxable: true }), hours({ no_overhead_profit: true })], { overhead_profit_percent: '10' }, {}),
    ).toBe('275.00');
  });
});

describe('the range explanation reads the lines at both ends', () => {
  it('W58 a taxable exempt rental that only the high end prices shapes the overhead and tax sentences', () => {
    // Uncertainty, no hidden damage or extra days. Demolition $200.00 (not taxable). Air movers entered 0, so no
    // low line; the IICRC maximum for a 100 sq ft wet floor is 3, so the high end rents 3 x 3 days x $25.00 =
    // $225.00, taxable at a 40% materials share and exempt from O&P. High tax 10% x $225.00 x 40% = $9.00.
    const result = priced(
      table(
        [item('demo'), { ...AIR_MOVER, taxable: true, materials_share_percent: '40', no_overhead_profit: true }],
        {
          estimate_mode: 'range',
          overhead_profit_percent: '10',
          sales_tax: { enabled: true, percent: '10' },
          assist: {
            drying_days: 3,
            range_method: 'uncertainty',
            extra_drying_days: 0,
            hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
          },
        },
      ),
      job([room('Kitchen', { unfinished_sf: 100, floor_sf: 100, ceiling_height_ft: 8, water_class: 2 })], {
        air_movers: 0,
        drying_days: 3,
      }),
    );
    expect(result.totals.high?.tax).toBe('9.00');
    expect(result.totals.explanation).toContain(
      'Both amounts include overhead and profit at 10%, except on items marked as carrying none.',
    );
    expect(result.totals.explanation).toContain('Sales tax at 10% applies to the materials share of the items marked taxable.');
  });

  it('W61 the sentences come from the table, so they do not change with which end the job minimum keeps', () => {
    // As W58 without the exemption, overhead 0, tax 10%. Job minimum $1,000.00: low work $200.00, high $200.00 +
    // $225.00 = $425.00, both the $1,000.00 minimum before tax, so the high end is the low end and no tax is
    // charged. With no minimum the high end is kept and taxes 10% x $225.00 x 40% = $9.00. The table is the same,
    // so the sentence is the same: it names the rental's materials share either way.
    const priceList = (minimum: string) =>
      table([item('demo'), { ...AIR_MOVER, taxable: true, materials_share_percent: '40' }], {
        estimate_mode: 'range',
        minimum_job_charge: minimum,
        sales_tax: { enabled: true, percent: '10' },
        assist: {
          drying_days: 3,
          range_method: 'uncertainty',
          extra_drying_days: 0,
          hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
        },
      });
    const rentalJob = job([room('Kitchen', { unfinished_sf: 100, floor_sf: 100, ceiling_height_ft: 8, water_class: 2 })], {
      air_movers: 0,
      drying_days: 3,
    });
    const floored = priced(priceList('1000'), rentalJob);
    expect(floored.totals.low).toMatchObject({ minimum_charge: '800.00', tax: '0.00', total: '1000.00' });
    expect(floored.totals.high).toEqual(floored.totals.low);
    const kept = priced(priceList('0'), rentalJob);
    expect(kept.totals.high?.tax).toBe('9.00');
    const sentence = 'Sales tax at 10% applies to the materials share of the items marked taxable.';
    expect(kept.totals.explanation).toContain(sentence);
    expect(floored.totals.explanation).toBe(kept.totals.explanation);
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

  it('W63 a high end whose minimum lines round below the low end takes the gap on its trade minimum line', () => {
    // Cushion 10%, three labor items of 1 hour, each under its own $100.00 heading: $10.06, $10.06 and $10.08.
    // Low: $30.20 + $89.94 + $89.94 + $89.92 = $300.00. High labor $33.22; the grown trades $11.066, $11.066 and
    // $11.088 round their lines to $88.93, $88.93 and $88.91, so the high end alone would be $299.99, a cent
    // under the low end. The high end keeps its grown labor and adds that cent to its last trade minimum line:
    // $33.22 + $88.93 + $88.93 + $88.92 = $300.00.
    const hours = (code: string, price: string) =>
      item(code, { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: price, trade: code });
    const headings = ['labor_a', 'labor_b', 'labor_c'].map((id) => ({ trade_id: id, name: id, minimum_charge: '100' }));
    const result = priced(
      withTrades([hours('labor_a', '10.06'), hours('labor_b', '10.06'), hours('labor_c', '10.08')], headings, {
        estimate_mode: 'range',
        range: { first_sf: 1000, first_percent: '10', beyond_percent: '0' },
      }),
      job([room('Kitchen', { unfinished_sf: 100 })], { labor_hours: 1 }),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '30.20', total: '300.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '33.22', total: '300.00' });
    expect(result.totals.high?.trade_minimums.map((row) => row.amount)).toEqual(['88.93', '88.93', '88.92']);
  });

  it('W64 a taxable line that does not grow is taxed on its own amount at the high end', () => {
    // Cushion 0.1% on the dearest 1 sq ft, 0% beyond, tax 10%. Demolition 5 sq ft x $2.01 = $10.05, taxable;
    // antimicrobial 5 sq ft x $3.00 = $15.00 and 1 labor hour at $10.00, not taxable. The dearest square foot is
    // the antimicrobial's, so the demolition does not grow; growth is $0.003 + $0.010 = $0.013 and high labor is
    // $35.06. Low tax 10% x $10.05 = $1.01 (half up). The high end bills $0.01 of that growth, none of it on the
    // demolition, so its tax is $1.01 too and its total $35.06 + $1.01 = $36.07, not $1.00 and $36.06.
    const result = priced(
      table(
        [
          item('demo', { unit_price: '2.01', taxable: true }),
          item('antimicrobial', { group: 'treatment', unit_price: '3.00' }),
          item('labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '10.00' }),
        ],
        {
          estimate_mode: 'range',
          range: { first_sf: 1, first_percent: '0.1', beyond_percent: '0' },
          sales_tax: { enabled: true, percent: '10' },
        },
      ),
      job([room('Kitchen', { unfinished_sf: 5 })], { labor_hours: 1 }),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '35.05', tax: '1.01', total: '36.06' });
    expect(result.totals.high).toMatchObject({ subtotal: '35.06', tax: '1.01', total: '36.07' });
  });

  it('W65 the uncertainty high end taxes its labor at the rounded high labor', () => {
    // Uncertainty, category-1 hidden damage 0.49%, tax 10%. Demolition 5 sq ft x $2.00 = $10.00, taxable, grows
    // to $10.049; high labor rounds to $10.05, so the high tax is 10% x $10.05 = $1.01 (not 10% x $10.049 = $1.00).
    const result = priced(
      table([item('demo', { taxable: true })], {
        estimate_mode: 'range',
        sales_tax: { enabled: true, percent: '10' },
        assist: {
          drying_days: 3,
          range_method: 'uncertainty',
          extra_drying_days: 0,
          hidden_damage_percent: { '1': '0.49', '2': '0', '3': '0' },
        },
      }),
      job([room('Kitchen', { unfinished_sf: 5 })]),
    );
    expect(result.totals.high).toMatchObject({ subtotal: '10.05', tax: '1.01', total: '11.06' });
  });
});

describe('flags at the high end and on approved additional work', () => {
  it('W53 a high end under the job minimum still charges the growth of items billed beyond it', () => {
    // Job minimum $1,000.00, cushion 50%. Demolition 50 x $2.00 = $100.00; antimicrobial 50 x $4.00 = $200.00,
    // exempt from O&P. Low: work $100.00, minimum line $900.00, total $300.00 + $900.00 = $1,200.00.
    // High: labor 1.5 x $300.00 = $450.00, exempt $300.00, work $150.00, minimum line $850.00, total $1,300.00.
    const result = priced(
      table(
        [item('demo'), item('antimicrobial', { group: 'treatment', unit_price: '4.00', no_overhead_profit: true })],
        { ...CUSHION, minimum_job_charge: '1000' },
      ),
      job([room('Kitchen', { unfinished_sf: 50 })]),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '300.00', minimum_charge: '900.00', total: '1200.00' });
    expect(result.totals.high).toMatchObject({ subtotal: '450.00', minimum_charge: '850.00', total: '1300.00' });
  });

  it('W54 a trade whose only line is at the high end is charged its minimum there', () => {
    // Uncertainty, no hidden damage or extra days. Demolition 100 x $2.00 = $200.00 at both ends. Air movers
    // entered 0, so no low line; the IICRC maximum for a 100 sq ft wet floor is 1 + ceil(100 / 50) = 3, so
    // the high end has 3 x 3 days x $25.00 = $225.00 under Mold work, short of $500.00 by $275.00.
    // Low $200.00. High $200.00 + $225.00 + $275.00 = $700.00.
    const result = priced(
      withTrades(
        [item('demo'), { ...AIR_MOVER, trade: 'mold_work' }],
        [{ trade_id: 'mold_work', name: 'Mold work', minimum_charge: '500' }],
        {
          estimate_mode: 'range',
          assist: {
            drying_days: 3,
            range_method: 'uncertainty',
            extra_drying_days: 0,
            hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
          },
        },
      ),
      job([room('Kitchen', { unfinished_sf: 100, floor_sf: 100, ceiling_height_ft: 8, water_class: 2 })], {
        air_movers: 0,
        drying_days: 3,
      }),
    );
    expect(result.totals.low).toMatchObject({ subtotal: '200.00', total: '200.00', trade_minimums: [] });
    expect(result.totals.high).toMatchObject({ subtotal: '425.00', total: '700.00' });
    expect(result.totals.high?.trade_minimums).toEqual([{ trade_id: 'mold_work', name: 'Mold work', amount: '275.00' }]);
  });

  it('W55 approved additional work carries the extras item materials share, O&P exemption and heading', () => {
    // Demolition 100 x $2.00 = $200.00. Approved additional work 2 hours x $50.00 = $100.00, taxable at a 40%
    // materials share. O&P 10%, tax 10%.
    // Exempt from O&P: O&P 10% x $200.00 = $20.00; tax 10% x $100.00 x 40% = $4.00. Total $324.00.
    // Under Drywall (minimum $400.00) instead: $100.00 is short by $300.00; O&P 10% x $600.00 = $60.00;
    // tax 10% x $100.00 x 40% x 1.10 = $4.40. Total $300.00 + $300.00 + $60.00 + $4.40 = $664.40.
    const extras = (changes: Obj) =>
      item('additional_work', {
        group: 'extras',
        unit: 'hour',
        quantity_source: 'field:labor_hours',
        unit_price: '50.00',
        taxable: true,
        materials_share_percent: '40',
        ...changes,
      });
    const approval = {
      accepted_by_uid: 'uid-1',
      accepted_by_name: 'Casey Customer',
      accepted_at: '2026-11-01T10:00:00Z',
      rate: '50.00',
      total: '100.00',
      company_id: 'example-co',
      company_version: 1,
    };
    const withExtra = job([room('Kitchen', { unfinished_sf: 100 })], {
      extras: [{ id: 'a'.repeat(32), description: 'Extra tear-out', hours: '2', approval }],
    });
    const rates = { overhead_profit_percent: '10', sales_tax: { enabled: true, percent: '10' } };
    const exempt = priced(table([item('demo'), extras({ no_overhead_profit: true })], rates), withExtra);
    expect(exempt.totals.low).toMatchObject({ subtotal: '300.00', overhead_profit: '20.00', tax: '4.00', total: '324.00' });
    const headed = priced(withTrades([item('demo'), extras({ trade: 'drywall' })], TRADES, rates), withExtra);
    expect(headed.totals.low).toMatchObject({ subtotal: '300.00', overhead_profit: '60.00', tax: '4.40', total: '664.40' });
    expect(headed.totals.low.trade_minimums).toEqual([{ trade_id: 'drywall', name: 'Drywall', amount: '300.00' }]);
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
