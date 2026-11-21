// Custom multipliers and unit and flat additions (S5 plan step S5b-8, Engine B; owner decisions B1 to B3,
// 2026-11-20). Every expected number is worked by hand in the comment beside it.
// B1: an approved custom multiplier applies like the category multiplier, to the line total after waste, at
// both range ends, before overhead and profit, tax, minimums and after-hours. Owner answer 2026-11-21, option
// (a): on a bracket-priced line it multiplies the unit price before the bands are allocated, as the category
// multiplier does. One that matches no line is refused.
// B2: unit and flat additions are taxed by their own flag, carry overhead and profit, count toward the job and
// trade minimums, take no after-hours and do not grow at the range's high end.
// B3: printed as "{description}: {quantity} {unit} at ${price}/{unit}, approved on {date}." and
// "{description}: ${price}, approved on {date}."; a multiplier as "x{multiplier}" beside its line.

import { describe, expect, it } from 'vitest';

import { priceEstimate } from '../../src/engine/estimate';
import { documentJob, item, job, lineTotals, priced, room, table, type Obj } from './estimate-fixtures';

const APPROVED_AT = '2026-11-20T15:30:00Z';

/** A job of the given rooms with approved multipliers and additions on its inspection. */
function withApprovals(rooms: Obj[], approvals: { line_multipliers?: Obj[]; additions?: Obj[] }, changes: Obj = {}) {
  return job(rooms, { ...changes, ...approvals });
}

const unit = (changes: Obj = {}): Obj => ({
  id: 'a'.repeat(32),
  kind: 'unit',
  description: 'Haul-away bags',
  quantity: '12',
  unit: 'bag',
  price: '4.50',
  taxable: true,
  approved_at: APPROVED_AT,
  ...changes,
});

const flat = (changes: Obj = {}): Obj => ({
  id: 'b'.repeat(32),
  kind: 'flat',
  description: 'Permit filing',
  price: '150.00',
  taxable: false,
  approved_at: APPROVED_AT,
  ...changes,
});

describe('custom multipliers (B1)', () => {
  it('multiplies one item in one room, and prints the factor beside the line', () => {
    // Kitchen: 100 sq ft x $2.00 = $200.00; x1.25 = $250.00. Hall: 50 sq ft x $2.00 = $100.00, unchanged. Total $350.00.
    const result = priced(
      table([item('demo')]),
      withApprovals([room('Kitchen', { unfinished_sf: 100 }), room('Hall', { unfinished_sf: 50 })], {
        line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '1.25' }],
      }),
    );
    expect(lineTotals(result)).toEqual(['Kitchen: demo x1.25 = 250.00', 'Hall: demo = 100.00']);
    expect(result.lines[0]).toMatchObject({ unit_price: '2.5', total: '250.00' });
    expect(result.totals.low.total).toBe('350.00');
  });

  it('multiplies a job-wide line when the room is null', () => {
    // One service call at $100.00; x2 = $200.00.
    const call = item('service_call', { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls', unit_price: '100.00' });
    const result = priced(table([call]), withApprovals([room('Kitchen')], { line_multipliers: [{ item_id: 'service_call', room: null, multiplier: '2' }] }, { emergency_calls: 1 }));
    expect(lineTotals(result)).toEqual(['service call x2 = 200.00']);
    expect(result.totals.low.total).toBe('200.00');
  });

  it('applies after waste and before overhead and profit and tax', () => {
    // 100 sq ft x $2.00 x (1 + 10% waste) = $220.00; x1.5 = $330.00.
    // O&P 10%: $33.00. Tax 10% on the line with its O&P share: $330.00 x 1.10 x 10% = $36.30.
    // Total $330.00 + $33.00 + $36.30 = $399.30.
    const result = priced(
      table([item('demo', { waste_percent: '10', taxable: true })], { overhead_profit_percent: '10', sales_tax: { enabled: true, percent: '10' } }),
      withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '1.5' }] }),
    );
    expect(result.lines[0]?.total).toBe('330.00');
    expect(result.totals.low).toMatchObject({ overhead_profit: '33.00', tax: '36.30', total: '399.30' });
  });

  it('applies at both ends of a range', () => {
    // 600 sq ft x $2.00 = $1,200.00; x1.5 = $1,800.00 low. The 50% cushion grows it to $2,700.00 high.
    const result = priced(
      table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }),
      withApprovals([room('Kitchen', { unfinished_sf: 600 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '1.5' }] }),
    );
    expect(result.totals.low.total).toBe('1800.00');
    expect(result.totals.high?.total).toBe('2700.00');
  });

  it('applies before the job minimum is compared', () => {
    // 100 sq ft x $2.00 = $200.00 is under the $300.00 minimum; x2 = $400.00 is not, so no minimum is charged.
    const result = priced(
      table([item('demo')], { minimum_job_charge: '300' }),
      withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '2' }] }),
    );
    expect(result.totals.low).toMatchObject({ minimum_charge: '0.00', total: '400.00' });
  });

  it('refuses an approved multiplier that matches no line', () => {
    const result = priceEstimate(
      table([item('demo')]),
      withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Hall', multiplier: '2' }] }),
    );
    expect(result).toMatchObject({ ok: false, stage: 'pricing' });
  });

  it('refuses a multiplier at or below 1, above 3, or with more than two decimal places', () => {
    for (const multiplier of ['1', '0.9', '3.01', '1.255']) {
      const result = priceEstimate(table([item('demo')]), withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier }] }));
      expect({ multiplier, ok: result.ok }).toEqual({ multiplier, ok: false });
    }
  });
});

describe('custom multipliers with brackets, duplicates and the letter (Engine B review)', () => {
  const uncertainty = (hidden: Obj) => ({
    estimate_mode: 'range',
    assist: { drying_days: 3, range_method: 'uncertainty', extra_drying_days: 0, hidden_damage_percent: hidden },
  });

  it('takes the factor in the unit price before a bracket line is allocated, so the high end is not below the low end', () => {
    // Two 1 sq ft rooms in one $1.04 band, 10% waste, Kitchen x2. Kitchen's unit price is 2: 1 x $2.08 x 1.1 = $2.288,
    // billed $2.29. The Hall: $2.288 + $1.144 = $3.432, billed $3.43 cumulatively, so $1.14. Low $3.43.
    // No hidden damage: the high end is the same $3.432 billed, $3.43.
    const result = priced(
      table([item('demo', { unit_price: '', waste_percent: '10', price_brackets: [{ up_to_sf: null, unit_price: '1.04' }] })], uncertainty({ '1': '0', '2': '0', '3': '0' })),
      withApprovals([room('Kitchen', { unfinished_sf: 1 }), room('Hall', { unfinished_sf: 1 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '2' }] }),
    );
    expect(lineTotals(result)).toEqual([
      'Kitchen: demo (tiered bracket: over 0 sq ft) x2 = 2.29',
      'Hall: demo (tiered bracket: over 0 sq ft) = 1.14',
    ]);
    expect(result.totals.low.total).toBe('3.43');
    expect(result.totals.high?.total).toBe('3.43');
  });

  it('ranks the factored line first and gives it the first band; the high end follows', () => {
    // $1.00 for the first 100 sq ft and $10.00 beyond; two 100 sq ft rooms, the Kitchen x3 (unit price 3), the Hall 1.
    // The Kitchen ranks first and takes the first band: 100 x $1.00 x 3 = $300.00. The Hall takes the next 100 sq ft
    // at $10.00 = $1,000.00. Low $1,300.00. Hidden damage 10% in the Hall only: $1,100.00. High $300.00 + $1,100.00 = $1,400.00.
    const bands = [
      { up_to_sf: 100, unit_price: '1.00' },
      { up_to_sf: null, unit_price: '10.00' },
    ];
    const result = priced(
      table([item('demo', { unit_price: '', price_brackets: bands })], uncertainty({ '1': '0', '2': '10', '3': '0' })),
      withApprovals([room('Kitchen', { unfinished_sf: 100 }), room('Hall', { category: 2, unfinished_sf: 100 })], {
        line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '3' }],
      }),
    );
    expect(result.totals.low.total).toBe('1300.00');
    expect(result.totals.high?.total).toBe('1400.00');
  });

  it('keeps a non-bracketed line as B1 says: its total after waste, rounded to the cent, times the factor', () => {
    // One square foot at $1.05 with 10% waste is $1.155, rounded $1.16; x2 = $2.32. The high end grows nothing: $2.32.
    const result = priced(
      table([item('demo', { unit_price: '1.05', waste_percent: '10' })], uncertainty({ '1': '0', '2': '0', '3': '0' })),
      withApprovals([room('Kitchen', { unfinished_sf: 1 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '2' }] }),
    );
    expect(result.totals.low.total).toBe('2.32');
    expect(result.totals.high?.total).toBe('2.32');
  });

  it('refuses a second multiplier for the same line, a job-wide one included, and reads rooms as the lines do', () => {
    const rooms = [room('Kitchen', { unfinished_sf: 100 }), room('Hall', { unfinished_sf: 100 })];
    const twice = (first: Obj, second: Obj) => priceEstimate(table([item('demo'), item('other')]), withApprovals(rooms, { line_multipliers: [first, second] }));
    expect(twice({ item_id: 'demo', room: 'Kitchen', multiplier: '2' }, { item_id: 'demo', room: ' kitchen ', multiplier: '2' }).ok).toBe(false);
    expect(twice({ item_id: 'demo', room: null, multiplier: '2' }, { item_id: 'demo', room: null, multiplier: '1.5' }).ok).toBe(false);
    expect(twice({ item_id: 'demo', room: 'Kitchen', multiplier: '2' }, { item_id: 'demo', room: 'Hall', multiplier: '2' }).ok).toBe(true);
    expect(twice({ item_id: 'demo', room: 'Kitchen', multiplier: '2' }, { item_id: 'other', room: 'Kitchen', multiplier: '2' }).ok).toBe(true);
  });

  it('takes a multiplier on every line of a large job', () => {
    const ids = Array.from({ length: 150 }, (_, index) => `item_${index}`);
    const items = ids.map((id) => item(id));
    const many = ids.map((id) => ({ item_id: id, room: 'Kitchen', multiplier: '2' }));
    const result = priced(table(items), withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: many }));
    expect(result.totals.low.total).toBe('60000.00');
  });

  it('prints the factor in the proposal letter beside the line', () => {
    const result = priced(
      table([item('demo')]),
      withApprovals([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '1.25' }] }),
    );
    expect(result.lines[0]?.description).toContain('x1.25');
    const letter = priced(
      table([item('demo')]),
      {
        ...documentJob([room('Kitchen', { unfinished_sf: 100 })], { line_multipliers: [{ item_id: 'demo', room: 'Kitchen', multiplier: '1.25' }] }, {
          settings: { proposal_layout: 'letter', company_clauses: [] },
          rooms: [{ name: 'Kitchen', findings: '', prep_tasks: [] }],
        }),
      },
    ).documents?.proposal.letter;
    expect(letter?.room_work[0]?.lines[0]?.text).toBe('demo: up to 100 sf x1.25');
  });
});

describe('unit and flat additions (B2, B3)', () => {
  it('keeps a description exactly as entered, with its internal spaces', () => {
    const result = priced(table([item('demo')]), withApprovals([room('Kitchen')], { additions: [flat({ description: 'Permit   filing' })] }));
    expect(lineTotals(result)).toEqual(['Permit   filing: $150.00, approved on 2026-11-20. = 150.00']);
    const padded = priced(table([item('demo')]), withApprovals([room('Kitchen')], { additions: [unit({ description: ' Haul  away ' })] }));
    expect(padded.lines[0]?.description).toBe(' Haul  away : 12 bag at $4.50/bag, approved on 2026-11-20.');
  });


  it('prices a unit addition, taxed by its own flag, and prints its approved wording', () => {
    // 12 bags x $4.50 = $54.00. Tax 10% on all of it: $5.40. Total $59.40.
    // The table's one item prices nothing here (the room has no measured area).
    const result = priced(table([item('demo')], { sales_tax: { enabled: true, percent: '10' } }), withApprovals([room('Kitchen')], { additions: [unit()] }));
    expect(lineTotals(result)).toEqual(['Haul-away bags: 12 bag at $4.50/bag, approved on 2026-11-20. = 54.00']);
    expect(result.totals.low).toMatchObject({ tax: '5.40', total: '59.40' });
  });

  it('prices a flat addition with overhead and profit, untaxed when not taxable', () => {
    // $150.00 flat; O&P 10%: $15.00; not taxable. Total $165.00.
    const result = priced(
      table([item('demo')], { overhead_profit_percent: '10', sales_tax: { enabled: true, percent: '10' } }),
      withApprovals([room('Kitchen')], { additions: [flat()] }),
    );
    expect(lineTotals(result)).toEqual(['Permit filing: $150.00, approved on 2026-11-20. = 150.00']);
    expect(result.totals.low).toMatchObject({ overhead_profit: '15.00', tax: '0.00', total: '165.00' });
  });

  it('counts toward the job minimum', () => {
    // 50 sq ft x $2.00 = $100.00 plus the $150.00 flat addition = $250.00, under the $300.00 minimum by $50.00.
    const result = priced(table([item('demo')], { minimum_job_charge: '300' }), withApprovals([room('Kitchen', { unfinished_sf: 50 })], { additions: [flat()] }));
    expect(result.totals.low).toMatchObject({ minimum_charge: '50.00', total: '300.00' });
  });

  it('does not grow at the high end of a range', () => {
    // 600 sq ft x $2.00 = $1,200.00 low and $1,800.00 high (50% cushion); the $150.00 addition is the same at both ends.
    const result = priced(
      table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }),
      withApprovals([room('Kitchen', { unfinished_sf: 600 })], { additions: [flat()] }),
    );
    expect(result.totals.low.total).toBe('1350.00');
    expect(result.totals.high?.total).toBe('1950.00');
  });

  it('takes no after-hours multiplier', () => {
    // An after-hours job at x1.5: the after-hours demolition line ($100.00) adds $50.00; the $150.00 addition adds nothing.
    const result = priced(
      table([item('demo', { after_hours: true })], { after_hours: { multiplier: '1.5' } }),
      withApprovals([room('Kitchen', { unfinished_sf: 50 })], { additions: [flat()] }, { is_after_hours: true }),
    );
    expect(result.totals.low).toMatchObject({ after_hours: '50.00', total: '300.00' });
  });

  it('refuses an addition whose shape does not match its kind', () => {
    const without = (key: string): Obj => Object.fromEntries(Object.entries(unit()).filter(([name]) => name !== key));
    for (const bad of [without('unit'), without('quantity'), flat({ quantity: '2' }), unit({ price: '0' })]) {
      const result = priceEstimate(table([item('demo')]), withApprovals([room('Kitchen')], { additions: [bad] }));
      expect(result.ok).toBe(false);
    }
  });

  it('refuses a unit or description that is blank, or holds a control or line-separator character', () => {
    for (const bad of [unit({ unit: ' ' }), unit({ unit: '\u00a0' }), unit({ unit: 'ba\ng' }), flat({ description: 'Permit\nfiling' }), flat({ description: '\u3000' })]) {
      expect(priceEstimate(table([item('demo')]), withApprovals([room('Kitchen')], { additions: [bad] })).ok).toBe(false);
    }
  });

  describe('when the proposal hides line prices', () => {
    const letter = (showLines: boolean, additions: Obj[]) =>
      priced(
        table([item('demo')], { show_line_breakdown: showLines }),
        documentJob([room('Kitchen', { unfinished_sf: 50 })], { additions }, { settings: { proposal_layout: 'letter', company_clauses: [] }, rooms: [{ name: 'Kitchen', findings: '', prep_tasks: [] }] }),
      );

    it('prints a unit and a flat addition without their price', () => {
      const hidden = letter(false, [unit(), flat()]).documents!;
      expect(hidden.proposal.letter?.job_work.map((line) => line.text)).toEqual([
        'Haul-away bags: 12 bag, approved on 2026-11-20.',
        'Permit filing, approved on 2026-11-20.',
      ]);
      expect(JSON.stringify(hidden.proposal)).not.toContain('$4.50');
      expect(JSON.stringify(hidden.proposal)).not.toContain('$150.00');
    });

    it('prints the itemized proposal without the price, and keeps it in the adjuster letter and the itemized claim', () => {
      const itemized = (showLines: boolean) =>
        priced(table([item('demo')], { show_line_breakdown: showLines }), documentJob([room('Kitchen', { unfinished_sf: 50 })], { additions: [unit(), flat()] })).documents!;
      const hidden = itemized(false);
      expect(hidden.proposal.recommendations).toEqual(expect.arrayContaining(['Haul-away bags: 12 bag, approved on 2026-11-20.', 'Permit filing, approved on 2026-11-20.']));
      expect(JSON.stringify(hidden.proposal.recommendations)).not.toContain('$150.00');
      expect(hidden.letter).toContain('Permit filing: $150.00, approved on 2026-11-20.');
      expect(hidden.letter).toContain('Haul-away bags: 12 bag at $4.50/bag, approved on 2026-11-20.');
      expect(JSON.stringify(hidden.itemized_claim)).toContain('Permit filing: $150.00, approved on 2026-11-20.');
      expect(itemized(true).proposal.recommendations).toContain('Permit filing: $150.00, approved on 2026-11-20.');
    });

    it('keeps the priced wording when line prices are shown', () => {
      const shown = letter(true, [unit(), flat()]).documents!;
      expect(shown.proposal.letter?.job_work.map((line) => line.text)).toEqual([
        'Haul-away bags: 12 bag at $4.50/bag, approved on 2026-11-20.',
        'Permit filing: $150.00, approved on 2026-11-20.',
      ]);
    });
  });

  it('counts an approved addition as covering an unpriced-work note of its description, and a pending one not', () => {
    const note = (additions: Obj[]) =>
      priced(table([item('demo')]), documentJob([room('Kitchen', { unfinished_sf: 50 })], { additions }, { ai: { summary: 'Reviewed.', suggestions: [], unpriced_work: ['Permit filing'] } })).documents!;
    expect(note([flat()])).toMatchObject({ unpriced_work: [], signable: true });
    expect(note([flat({ approved_at: null })])).toMatchObject({ signable: false });
  });
});
