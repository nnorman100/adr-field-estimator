// The PriceTableV3 schema, Decimal strings end to end and the content hash (plan
// docs/plans/pricing.md, S4-3 and section 6 "Schema"). Rows, room types and size tiers come in S4-4.

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate, type Json } from '../../src/engine/estimate';
import { PriceTableV3, contentHash, parseTable } from '../../src/engine/table';
import { item, job, policy, priced, room, table, type Obj } from './estimate-fixtures';

const BASE = table([
  item('demo'),
  item('antimicrobial', { group: 'treatment', unit_price: '1.10', taxable: true }),
]);

function withItem(changes: Obj): Obj {
  return table([item('demo', changes)]);
}

function refused(raw: Json): boolean {
  return !PriceTableV3.safeParse(raw).success;
}

/** Keys sorted, no spaces: written here from the rule, not taken from the engine. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => sortedJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${sortedJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('PriceTableV3: the parsed table', () => {
  it('fills every default and keeps prices as cent strings', () => {
    const parsed = parseTable(BASE);
    expect(parsed.items[0]).toEqual({
      item_id: 'demo',
      code: 'DEMO',
      group: 'demolition',
      name: 'demo',
      customer_description: '',
      unit: 'sf',
      quantity_source: 'room:demolition:unfinished',
      unit_price: '2.00',
      allow_zero: false,
      default_quantity: '0',
      waste_percent: '0',
      categories: [],
      taxable: false,
      xactimate_code: '',
      enabled: true,
      sort_order: 0,
    });
    expect(parsed.policy.assist).toEqual({
      drying_days: 3,
      range_method: 'cushion',
      extra_drying_days: 0,
      hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
    });
    expect(parsed.policy.bracket_mode).toBe('tiered');
  });

  it('is canonical: parsing the parsed table again gives the same table', () => {
    const once = parseTable(
      table(
        [
          item('demo', {
            unit_price: '',
            price_brackets: [
              { up_to_sf: 100, unit_price: '3' },
              { up_to_sf: null, unit_price: ' 1.5 ' },
            ],
            categories: [3, 1],
            waste_percent: '10.50',
          }),
        ],
        { category_multipliers: { '1': '1.000', '2': '1.25', '3': '1.5' } },
      ),
    );
    expect(once.items[0]?.price_brackets).toEqual([
      { up_to_sf: 100, unit_price: '3.00' },
      { up_to_sf: null, unit_price: '1.50' },
    ]);
    expect(once.items[0]?.categories).toEqual([1, 3]);
    expect(once.items[0]?.waste_percent).toBe('10.5');
    expect(once.policy.category_multipliers).toEqual({ '1': '1', '2': '1.25', '3': '1.5' });
    expect(parseTable(once)).toEqual(once);
  });

  it('hashes the canonical JSON of the parsed table, items in id order', () => {
    const parsed = parseTable(BASE);
    const items = [...parsed.items].sort((a, b) => (a.item_id < b.item_id ? -1 : 1));
    const expected = createHash('sha256')
      .update(sortedJson({ items, policy: parsed.policy }), 'utf8')
      .digest('hex');
    expect(contentHash(parsed)).toBe(expected);
    expect(checkTable(BASE)).toEqual({ ok: true, table_sha256: expected });
    // A default written out and a default left out are the same table.
    expect(contentHash(parseTable(withItem({ enabled: true, sort_order: 0 })))).toBe(
      contentHash(parseTable(withItem({}))),
    );
  });
});

describe('PriceTableV3: what it refuses', () => {
  it('refuses a price that is negative, has more than 2 decimals, or is a JSON number', () => {
    expect(refused(withItem({ unit_price: '-1.00' }))).toBe(true);
    expect(refused(withItem({ unit_price: '1.005' }))).toBe(true);
    expect(refused(withItem({ unit_price: '100000.01' }))).toBe(true);
    expect(refused(withItem({ unit_price: 2 }))).toBe(true);
    expect(refused(withItem({ unit_price: '1e2' }))).toBe(true);
    expect(refused(withItem({ waste_percent: 10 }))).toBe(true);
    expect(refused(withItem({ unit_price: '2' }))).toBe(false);
  });

  it('refuses a repeated item id or code', () => {
    expect(refused(table([item('demo'), item('demo')]))).toBe(true);
    expect(refused(table([item('demo', { code: 'X1' }), item('other', { code: 'X1' })]))).toBe(true);
    expect(refused(table([item('demo'), item('other')]))).toBe(false);
  });

  it('refuses text that a spreadsheet would run as a formula', () => {
    for (const name of ['=SUM(A1)', '+1', '-1', '@cmd']) {
      expect(refused(withItem({ name }))).toBe(true);
      expect(refused(withItem({ customer_description: name }))).toBe(true);
    }
    expect(refused(table([item('demo')], { after_hours: { multiplier: '1', label: '=X' } }))).toBe(true);
  });

  it('refuses an unknown or repeated category and an unknown key', () => {
    expect(refused(withItem({ categories: [4] }))).toBe(true);
    expect(refused(withItem({ categories: [2, 2] }))).toBe(true);
    expect(refused(withItem({ categories: ['3'] }))).toBe(true);
    expect(refused(withItem({ unit_prise: '2.00' }))).toBe(true);
    expect(refused({ ...BASE, extra: true })).toBe(true);
    expect(refused({ items: BASE.items as Json, policy: { ...policy(), cushion: '5' } })).toBe(true);
  });

  it('refuses lists over their limits and band limits out of order', () => {
    const many = Array.from({ length: 151 }, (_, index) => item(`item_${index}`));
    expect(refused(table(many))).toBe(true);
    expect(refused(table(many.slice(0, 150)))).toBe(false);
    const bands = (limits: Array<number | null>) =>
      withItem({
        unit_price: '',
        price_brackets: limits.map((up_to_sf) => ({ up_to_sf, unit_price: '1.00' })),
      });
    expect(refused(bands([...Array.from({ length: 20 }, (_, index) => index + 1), null]))).toBe(true);
    expect(refused(bands([200, 100, null]))).toBe(true);
    expect(refused(bands([100, 100, null]))).toBe(true);
    expect(refused(bands([100, 200]))).toBe(true);
    expect(refused(bands([100, 200, null]))).toBe(false);
  });

  it('refuses multipliers below 1 and a cushion beyond the first band', () => {
    expect(refused(table([item('demo')], { after_hours: { multiplier: '0.9' } }))).toBe(true);
    const cushion = (first: string, beyond: string) =>
      table([item('demo')], { range: { first_sf: 1000, first_percent: first, beyond_percent: beyond } });
    expect(refused(cushion('20', '50'))).toBe(true);
    expect(refused(cushion('50', '20'))).toBe(false);
  });

  it('a confirmed zero price may be confirmed by the item code', () => {
    const zero = table([item('demo'), item('free_check', { code: 'FREE', unit_price: '0', allow_zero: true })]);
    expect(checkTable(zero).ok).toBe(false);
    expect(checkTable(zero, ['FREE']).ok).toBe(true);
  });
});

describe('Decimal strings end to end', () => {
  it('prices a room measurement exactly, however many digits it has', () => {
    // A JavaScript float keeps about 17 digits, so the old engine priced 1234.5678901234568 sq ft.
    const result = priced(
      withItem({ unit_price: '10.00' }),
      job([room('Hall', { unfinished_sf: '1234.567890123456789' }), room('Bath', { unfinished_sf: 0.1 })]),
    );
    expect(result.lines.map((line) => line.quantity)).toEqual(['1234.567890123456789', '0.1']);
    // 1,234.567890123456789 x $10.00 = $12,345.67890123456789 -> $12,345.68; 0.1 x $10.00 = $1.00.
    expect(result.lines.map((line) => line.total)).toEqual(['12345.68', '1.00']);
    expect(result.totals.low.total).toBe('12346.68');
  });

  it('refuses a room measurement that is not a plain number', () => {
    for (const value of ['12a', '1e3', '', true, -1]) {
      expect(priceEstimate(BASE, job([room('Hall', { unfinished_sf: value })]))).toMatchObject({
        ok: false,
        stage: 'inspection',
      });
    }
  });

  it('refuses a quantity override keyed "__proto__" rather than dropping it', () => {
    const inspection = JSON.parse(
      '{"address":"1 Example Street","year_built":1990,"rooms":[{"name":"Hall","unfinished_sf":10}],' +
        '"quantity_overrides":{"__proto__":{"measured":"1","entered":"5","reason":"Dried out"}}}',
    ) as Json;
    expect(priceEstimate(BASE, { inspection })).toMatchObject({ ok: false, stage: 'inspection' });
  });

  it('an item id that names an object property reads only the draft, never a built-in', () => {
    // A typed item "constructor" with no entry on the draft uses its default quantity: 2 x $5.00.
    const typed = table([
      item('constructor', {
        group: 'job_charges',
        unit: 'each',
        quantity_source: 'typed',
        default_quantity: '2',
        unit_price: '5.00',
      }),
    ]);
    const result = priced(typed, job([room('Hall')], { scope_items: {} }));
    expect(result.lines.map((line) => line.total)).toEqual(['10.00']);
  });
});
