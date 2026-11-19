// Named adjustments (S5 plan step S5b-7). Every expected number is worked by hand in the comment beside it: an
// approved adjustment changes the price after price-point rounding (S4-4e) and is not rounded again; a percent is
// of the price before it, rounded to cents once; a discount prints with a minus, a charge with a plus.

import { describe, expect, it } from 'vitest';

import { proposalOf } from '../../src/lib/estimates/proposal';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '../../src/lib/profile/documents';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { contentHash, parseTable } from '../../src/engine/table';
import { adjustmentLines, chargeRows } from '../../src/lib/estimates/screen';
import { COMPANY, documentJob, item, job, priced, room, table, type Obj } from './estimate-fixtures';

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

function priceWith(tableJson: Obj, approved: string) {
  return priced(tableJson, { ...job([room('Kitchen')], { emergency_calls: 1 }), adjustment: approved });
}

describe('named adjustment worked examples', () => {
  it('a percent discount', () => {
    // $2,431.17 x 10% = $243.117, rounded once to $243.12; $2,431.17 - $243.12 = $2,188.05.
    const result = priceWith(withAdjustments('2431.17'), 'senior');
    expect(result.totals.low.total).toBe('2188.05');
    expect(result.totals.low.adjustment).toEqual({
      adjustment_id: 'senior',
      name: 'Senior discount',
      direction: 'discount',
      before: '2431.17',
      amount: '243.12',
      after: '2188.05',
    });
  });

  it('an amount discount', () => {
    // $1,000.00 - $50.00 = $950.00.
    const result = priceWith(withAdjustments('1000.00'), 'loyal');
    expect(result.totals.low).toMatchObject({ total: '950.00' });
  });

  it('a charge', () => {
    // $1,000.00 + $125.00 = $1,125.00.
    const result = priceWith(withAdjustments('1000.00'), 'rush');
    expect(result.totals.low.total).toBe('1125.00');
  });

  it('a discount on a rounded price is taken from the rounded price and not rounded again', () => {
    // $2,431.17 rounds up to $2,499.00 (step 100, ending 99). 10% of $2,499.00 = $249.90; $2,499.00 - $249.90 = $2,249.10,
    // which is not a price point and stays as it is.
    const result = priceWith(withAdjustments('2431.17', { price_point: { step: '100', ending: '99' } }), 'senior');
    expect(result.totals.low).toMatchObject({ price_point: '67.83', total: '2249.10' });
    expect(result.totals.low.adjustment).toMatchObject({ before: '2499.00', amount: '249.90', after: '2249.10' });
  });

  it('applies after tax and is not taxed', () => {
    // $1,000.00 taxable at 10%: tax $100.00, price $1,100.00; less $50.00 = $1,050.00; the tax stays $100.00.
    const result = priceWith(withAdjustments('1000.00', { sales_tax: { enabled: true, percent: '10' } }, { taxable: true }), 'loyal');
    expect(result.totals.low).toMatchObject({ tax: '100.00', total: '1050.00' });
  });

  it('applies to each end of a range on its own', () => {
    // 600 sq ft x $2.00 = $1,200.00 low; 50% cushion: $1,800.00 high. Less $50.00: $1,150.00 and $1,750.00.
    const result = priced(
      { ...table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }), adjustments: [LOYAL] },
      { ...job([room('Kitchen', { unfinished_sf: 600 })]), adjustment: 'loyal' },
    );
    expect(result.totals.low.total).toBe('1150.00');
    expect(result.totals.high?.total).toBe('1750.00');
  });
});

describe('printed arithmetic', () => {
  it('prints a discount with a minus and a charge with a plus', () => {
    const discount = priceWith(withAdjustments('2431.17', { price_point: { step: '100', ending: '99' } }), 'senior');
    expect(adjustmentLines(discount.totals.low, null)).toEqual(['$2,499.00 − Senior discount $249.90 = $2,249.10']);
    const extra = priceWith(withAdjustments('1000.00'), 'rush');
    expect(adjustmentLines(extra.totals.low, null)).toEqual(['$1,000.00 + Weekend start $125.00 = $1,125.00']);
  });

  it('names each end in a range', () => {
    const result = priced(
      { ...table([item('demo')], { estimate_mode: 'range', range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' } }), adjustments: [LOYAL] },
      { ...job([room('Kitchen', { unfinished_sf: 600 })]), adjustment: 'loyal' },
    );
    expect(adjustmentLines(result.totals.low, result.totals.high)).toEqual([
      'Low end: $1,200.00 − Returning customer $50.00 = $1,150.00',
      'High end: $1,800.00 − Returning customer $50.00 = $1,750.00',
    ]);
  });

  it('the charge rows still add up to the adjusted total', () => {
    const result = priceWith(withAdjustments('1000.00'), 'loyal');
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
    expect(result.totals.low.adjustment).toBeUndefined();
    expect(adjustmentLines(result.totals.low, null)).toEqual([]);
  });

  it('refuses an id the table does not have and a discount above the price', () => {
    const run = (approved: string, amount = '1000.00') =>
      priceEstimate(withAdjustments(amount), { ...job([room('Kitchen')], { emergency_calls: 1 }), adjustment: approved });
    expect(run('unknown')).toMatchObject({ ok: false, stage: 'pricing' });
    expect(run('loyal', '40.00')).toMatchObject({ ok: false, stage: 'pricing' });
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

  it('takes a name as entered, with any leading character and no trimming', () => {
    expect(check({ ...SENIOR, name: '- Returning customer' }).ok).toBe(true);
    expect(check({ ...SENIOR, name: ` ${'x'.repeat(59)} ` }).ok).toBe(false);
    expect(parseTable({ ...table([charge('10.00')]), adjustments: [{ ...SENIOR, name: ' Padded ' }] }).adjustments?.[0]?.name).toBe(' Padded ');
  });

  it('refuses a zero value, a percent discount above 100 and repeated ids; a percent charge may exceed 100, and the catalog has no ceiling', () => {
    expect(check({ ...LOYAL, value: '0' }).ok).toBe(false);
    expect(check({ ...SENIOR, value: '100.01' }).ok).toBe(false);
    expect(check({ ...SENIOR, value: '100' }).ok).toBe(true);
    expect(check({ ...SENIOR, direction: 'charge', value: '150' }).ok).toBe(true);
    const many = Array.from({ length: 31 }, (_, index) => ({ ...SENIOR, adjustment_id: `rule_${index}` }));
    expect(checkTable({ ...table([charge('10.00')]), adjustments: many }).ok).toBe(true);
    expect(checkTable({ ...table([charge('10.00')]), adjustments: [SENIOR, { ...LOYAL, adjustment_id: 'senior' }] }).ok).toBe(false);
  });

  it('none are seeded: a table without adjustments keeps its content hash', () => {
    const plain = table([charge('10.00')]);
    expect(parseTable(plain)).not.toHaveProperty('adjustments');
    expect(contentHash(parseTable({ ...plain, adjustments: [] }))).toBe(contentHash(parseTable(plain)));
  });
});

describe('the documents state the adjustment', () => {
  const run = (policy: Obj, adjustment: string, extra: Obj = {}) =>
    priceEstimate(
      { ...table([charge('2431.17')], policy), adjustments: [SENIOR, LOYAL] },
      { ...documentJob([room('Kitchen', extra)], { emergency_calls: 1 }), adjustment },
    );

  it('the scope defense letter prints the adjustment arithmetic so its total reconciles', () => {
    const result = run({ price_point: { step: '100', ending: '99' } }, 'senior');
    if (!result.ok) throw new Error(result.error);
    expect(result.documents?.letter).toContain(
      'Itemized total: $2,249.10.\nPrice-point adjustment (not taxed): $67.83.\n$2,499.00 \u2212 Senior discount $249.90 = $2,249.10',
    );
  });

  it('the letter prints each end of a range', () => {
    const result = run({ estimate_mode: 'range', range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' } }, 'loyal');
    if (!result.ok) throw new Error(result.error);
    expect(result.documents?.letter).toContain(
      'Low end: $2,431.17 \u2212 Returning customer $50.00 = $2,381.17\nHigh end: $2,431.17 \u2212 Returning customer $50.00 = $2,381.17',
    );
  });

  it('the stored estimate keeps the catalog id and the proposal price leaves it out', () => {
    const result = run({}, 'senior');
    if (!result.ok) throw new Error(result.error);
    expect(result.totals.low.adjustment?.adjustment_id).toBe('senior');
    const company: CompanyDocuments = {
      identity: {
        companyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        name: COMPANY.name as string,
        address: COMPANY.address as string,
        phone: COMPANY.phone as string,
        email: COMPANY.email as string,
        license: COMPANY.license as string,
        signoff: COMPANY.signoff as string,
      },
      letterhead: NEUTRAL_LETTERHEAD,
      settings: NEUTRAL_SETTINGS,
      signing: { authorizationText: 'Synthetic start-work authorization.', paymentTermsText: 'Synthetic payment terms.' },
    };
    const proposal = proposalOf({
      estimate: result,
      company,
      showLineBreakdown: false,
      submission: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshotSha256: 'a'.repeat(64) },
      version: { sequence: 1 },
    });
    expect(proposal.price.low.adjustment).toEqual({ name: 'Senior discount', direction: 'discount', before: '2431.17', amount: '243.12', after: '2188.05' });
    expect(JSON.stringify(proposal)).not.toContain('adjustment_id');
  });

  it('a discount that rounds to nothing prints no charge row', () => {
    // 0.01% of $10.00 is $0.001, which rounds to $0.00.
    const tiny: Obj = { ...SENIOR, value: '0.01' };
    const result = priced({ ...table([charge('10.00')]), adjustments: [tiny] }, { ...job([room('Kitchen')], { emergency_calls: 1 }), adjustment: 'senior' });
    expect(result.totals.low.total).toBe('10.00');
    expect(chargeRows(result.totals.low, 'After-hours adjustment')).toEqual([{ label: 'Subtotal', amount: '10.00' }]);
  });
});
