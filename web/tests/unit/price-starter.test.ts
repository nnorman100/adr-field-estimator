import { describe, expect, it } from 'vitest';
import { checkTable } from '@/engine/estimate';
import { blankPrice, contentHash, parseTable, type Table } from '@/engine/table';
import { starterTable } from '@/lib/prices/starter';

// A new company's first table (plan Q13, Q14): the industry's items and units with blank prices,
// starter trade headings and room types, neutral settings. No Xactimate codes, no prices.

// The starter with every price filled in and the room-size limits set, as an owner would leave it.
function priced(table: Table): Table {
  return parseTable({
    ...table,
    policy: { ...table.policy, size_tiers: { s_up_to_sf: 100, m_up_to_sf: 250, l_up_to_sf: 500 } },
    items: table.items.map((item) =>
      item.unit === 'room'
        ? { ...item, tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '40.00' } }
        : { ...item, unit_price: '1.00' },
    ),
  });
}

describe('the starter table', () => {
  const table = starterTable();

  it('is a canonical table the one schema accepts, and the same one every time', () => {
    expect(parseTable(JSON.parse(JSON.stringify(table)))).toEqual(table);
    expect(contentHash(starterTable())).toBe(contentHash(table));
    // A caller changing its copy never changes the next caller's.
    const first = starterTable();
    first.items.pop();
    expect(starterTable().items.length).toBe(table.items.length);
  });

  it('lists the industry items with units and plain descriptions, and every price blank', () => {
    expect(table.items.length).toBeGreaterThanOrEqual(25);
    for (const item of table.items) {
      expect(blankPrice(item), item.item_id).toBe(true);
      expect(item.enabled, item.item_id).toBe(true);
      expect(item.customer_description.length, item.item_id).toBeGreaterThan(0);
      // Own scope codes: no Xactimate line, no code from anyone else's price list.
      expect(item.xactimate_code, item.item_id).toBe('');
      expect(item.allow_zero, item.item_id).toBe(false);
      for (const price of [item.unit_price, ...Object.values(item.tier_prices ?? {})]) expect(price, item.item_id).toBe('');
    }
    expect(JSON.stringify(table)).not.toMatch(/"(unit_price|s|m|l|xl|unit_price)":"[0-9]/);
    // Water, mold and the equipment units are all there.
    expect(new Set(table.items.map((item) => item.unit))).toEqual(
      new Set(['each', 'load', 'sf', 'lf', 'room', 'unit_day', 'hour']),
    );
    expect(table.items.some((item) => item.categories.includes('mold'))).toBe(true);
    expect(table.items.filter((item) => item.group === 'extras' && item.enabled)).toHaveLength(1);
  });

  it('starts trade headings and room types, with Other, and every item under a heading', () => {
    expect((table.trades ?? []).length).toBeGreaterThanOrEqual(5);
    const trades = new Set((table.trades ?? []).map((trade) => trade.trade_id));
    for (const item of table.items) expect(trades.has(item.trade ?? ''), item.item_id).toBe(true);
    const types = table.policy.room_types.map((type) => type.name);
    expect(types).toEqual(['Kitchen', 'Bathroom', 'Bedroom', 'Living room', 'Hallway', 'Laundry', 'Garage', 'Other']);
    expect(table.policy.room_types.find((type) => type.id === 'kitchen')?.suggested_items.length).toBeGreaterThan(0);
  });

  it('has neutral settings: nothing marked up, taxed, held to a minimum or priced by room type', () => {
    const policy = table.policy;
    expect(policy.category_multipliers).toEqual({ '1': '1', '2': '1', '3': '1' });
    expect(policy.cabinetry.multiplier).toBe('1');
    expect(policy.after_hours.multiplier).toBe('1');
    expect(policy.minimum_job_charge).toBe('0');
    expect(policy.overhead_profit_percent).toBe('0');
    expect(policy.sales_tax).toEqual({ enabled: false, percent: '0' });
    expect(policy.room_type_pricing).toBe(false);
    expect(policy.size_tiers).toEqual({ s_up_to_sf: null, m_up_to_sf: null, l_up_to_sf: null });
    expect(policy.range.first_percent).toBe('0');
    expect(policy.range.beyond_percent).toBe('0');
    for (const trade of table.trades ?? []) expect(trade.minimum_charge, trade.trade_id).toBe('0');
  });

  it('cannot publish as it stands (no price, no estimate), and can once each price and the size limits are set', () => {
    const blocked = checkTable(JSON.parse(JSON.stringify(table)), []);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.error).toMatch(/the price is blank|size_tiers/);
    const done = checkTable(JSON.parse(JSON.stringify(priced(table))), []);
    expect(done.ok).toBe(true);
  });
});
