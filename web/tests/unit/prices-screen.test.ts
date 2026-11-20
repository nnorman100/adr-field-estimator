import { describe, expect, it } from 'vitest';
import { Dec } from '@/engine/decimal';
import { priceEstimate, type Json } from '@/engine/estimate';
import { parseTable, type Item, type Table } from '@/engine/table';
import type { Category } from '@/engine/values';
import {
  addBand,
  addRoomType,
  addRoomTypeRow,
  addAdjustment,
  addTrade,
  categoryPricingOn,
  changed,
  defaultForm,
  idFromName,
  removeBand,
  removeRoomType,
  removeAdjustment,
  removeTrade,
  setAdjustment,
  rowId,
  setCategoryPricing,
  setDefaultForm,
  setItemCategories,
  setRowForm,
  updateItem,
  withBrackets,
} from '@/lib/prices/edit';
import { moneyText, pricesAccess, pricesMessage, pricesView, roomPrices, unitWords } from '@/lib/prices/screen';
import { starterTable } from '@/lib/prices/starter';

// S4-8, the Prices screen's pure helpers. The screen never prices anything: "what does this room
// pay?" names the row the engine would use and that row's price as set, so the first tests hold it
// to the engine's own answer for every category, room type and setting.

const LIMITS = { s_up_to_sf: 100, m_up_to_sf: 250, l_up_to_sf: 500 };

// The starter list with every price filled in, the room-size limits set, and a 1.5 Cat 3 multiplier.
function priced(): Table {
  const table = starterTable();
  return parseTable({
    ...table,
    policy: {
      ...table.policy,
      size_tiers: LIMITS,
      category_multipliers: { '1': '1', '2': '1.25', '3': '1.5' },
    },
    items: table.items.map((item) =>
      item.unit === 'room'
        ? { ...item, tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '40.00' } }
        : { ...item, unit_price: '2.00' },
    ),
  });
}

const DRYWALL = (table: Table): Item => table.items.find((item) => item.unit === 'sf' && item.quantity_source === 'room:demolition:finished')!;

// Two items with rows: drywall removal (Cat 1 to 3) with a Cat 3 row, a Kitchen row and a
// Kitchen + Cat 2 row; mold cleaning (Mold rooms only) with a Mold row, a Kitchen row and a
// Bathroom + Mold row.
function withRows(pricing: boolean): Table {
  let next = priced();
  const id = DRYWALL(next).item_id;
  next = updateItem(next, id, (item) => setCategoryPricing(item, true));
  next = updateItem(next, id, (item) => ({ ...item, rows: item.rows!.filter((row) => row.category === 3) }));
  next = updateItem(next, id, (item) => setRowForm(item, rowId({ category: 3 }), { unit_price: '7.00' }));
  next = updateItem(next, id, (item) => addRoomTypeRow(item, 'kitchen'));
  next = updateItem(next, id, (item) => setRowForm(item, rowId({ room_type: 'kitchen' }), { unit_price: '5.00' }));
  next = updateItem(next, id, (item) => addRoomTypeRow(item, 'kitchen', 2));
  next = updateItem(next, id, (item) => setRowForm(item, rowId({ room_type: 'kitchen', category: 2 }), { unit_price: '6.00' }));
  next = updateItem(next, 'mold_cleaning', (item) => setCategoryPricing(item, true));
  next = updateItem(next, 'mold_cleaning', (item) => setRowForm(item, rowId({ category: 'mold' }), { unit_price: '7.50' }));
  next = updateItem(next, 'mold_cleaning', (item) => addRoomTypeRow(item, 'kitchen'));
  next = updateItem(next, 'mold_cleaning', (item) => setRowForm(item, rowId({ room_type: 'kitchen' }), { unit_price: '5.50' }));
  next = updateItem(next, 'mold_cleaning', (item) => addRoomTypeRow(item, 'bathroom', 'mold'));
  next = updateItem(next, 'mold_cleaning', (item) => setRowForm(item, rowId({ room_type: 'bathroom', category: 'mold' }), { unit_price: '6.50' }));
  return parseTable({ ...next, policy: { ...next.policy, room_type_pricing: pricing } });
}

function engineLine(table: Table, itemId: string, category: Category, roomType: string) {
  const room = {
    name: 'Room',
    category,
    room_type_id: roomType,
    floor_sf: 120,
    wet_floor_sf: 120,
    unfinished_sf: 50,
    finished_sf: 40,
    ceiling_height_ft: 8,
    ...(category === 'mold' ? { loss: 'mold', mold_condition: 3, affected_sf: 40 } : { water_class: 2 }),
  };
  const result = priceEstimate(table as unknown as Json, {
    inspection: { address: '', year_built: 1995, rooms: [room], scope_confirmed: true, drying_days: 3 },
  });
  if (!result.ok) throw new Error(result.error);
  return result.lines.find((line) => line.item_id === itemId);
}

describe('what does this room pay?', () => {
  for (const itemId of ['demo_drywall', 'mold_cleaning']) {
    for (const pricing of [false, true]) {
      for (const category of [1, 2, 3, 'mold'] as const) {
        for (const roomType of ['kitchen', 'bathroom', 'other']) {
          it(`names the row the engine uses (${itemId}, ${category}, ${roomType}, room-type pricing ${pricing ? 'on' : 'off'})`, () => {
            const table = withRows(pricing);
            const item = table.items.find((candidate) => candidate.item_id === itemId)!;
            const shown = roomPrices(table, { category, roomType, tier: 'm' }).find((row) => row.itemId === itemId);
            const line = engineLine(table, itemId, category, roomType);
            // An item not used in this category has no line, and the preview does not list it.
            if (!shown) {
              expect(item.categories).not.toContain(category);
              expect(line).toBeUndefined();
              return;
            }
            expect(line).toBeDefined();
            if (shown.row === null) {
              expect(line!.description).toMatch(/^Room: /);
              expect(shown.price).toEqual({ kind: 'single', price: '2.00' });
              const multiplier = shown.multiplier ?? '1';
              expect(Dec.parse(line!.unit_price).cmp(Dec.parse('2.00').mul(Dec.parse(multiplier)))).toBe(0);
            } else {
              expect(line!.description).toMatch(new RegExp(`^Room, ${shown.row}: `));
              expect(shown.multiplier).toBeNull();
              expect(shown.price.kind).toBe('single');
              if (shown.price.kind === 'single') expect(Dec.parse(line!.unit_price).cmp(Dec.parse(shown.price.price))).toBe(0);
            }
          });
        }
      }
    }
  }

  it('uses the room-type rows only while "Price varies by room type" is on', () => {
    expect(roomPrices(withRows(false), { category: 2, roomType: 'kitchen', tier: 's' }).find((row) => row.row !== null)).toBeUndefined();
    const on = roomPrices(withRows(true), { category: 2, roomType: 'kitchen', tier: 's' });
    expect(on.find((row) => row.itemId === DRYWALL(withRows(true)).item_id)?.row).toBe('Kitchen, Cat 2');
  });

  it('shows a per-room item at the chosen size, lists only items on and used in that category, and names conditions', () => {
    const table = priced();
    const off = table.items.find((item) => item.unit === 'sf' && item.quantity_source.startsWith('room:'))!;
    const shown = roomPrices(updateItem(table, off.item_id, (item) => ({ ...item, enabled: false })), { category: 'mold', roomType: 'other', tier: 'l' });
    expect(shown.some((row) => row.itemId === off.item_id)).toBe(false);
    const perRoom = shown.find((row) => row.unit === 'room');
    if (perRoom) expect(perRoom.price).toEqual({ kind: 'tier', tier: 'l', price: '30.00' });
    expect(shown.every((row) => row.multiplier === null)).toBe(true);
    const moldOnly = table.items.filter((item) => item.enabled && item.categories.length === 1 && item.categories[0] === 'mold');
    expect(roomPrices(table, { category: 1, roomType: 'other', tier: 's' }).some((row) => moldOnly.some((item) => item.item_id === row.itemId))).toBe(false);
    const conditioned = shown.find((row) => row.conditions.length > 0);
    if (table.items.some((item) => item.mold_conditions?.length)) expect(conditioned?.conditions[0]).toMatch(/^only for mold Condition/);
  });
});

describe('the editor changes', () => {
  it('turns category prices on with a blank row per category the item uses, and off again', () => {
    const table = priced();
    const item = setItemCategories(DRYWALL(table), [2, 3]);
    const on = setCategoryPricing(item, true);
    expect(categoryPricingOn(on)).toBe(true);
    expect(on.rows).toEqual([
      { category: 2, unit_price: '' },
      { category: 3, unit_price: '' },
    ]);
    const off = setCategoryPricing(on, false);
    expect(categoryPricingOn(off)).toBe(false);
    expect(off.rows).toBeUndefined();
    expect(() => parseTable({ ...table, items: table.items.map((i) => (i.item_id === item.item_id ? on : i)) })).not.toThrow();
  });

  it('gives a per-room item four blank size prices per row and a bracketed item its band limits', () => {
    const table = priced();
    const room = table.items.find((item) => item.unit === 'room')!;
    expect(setCategoryPricing(room, true).rows?.[0]).toMatchObject({ tier_prices: { s: '', m: '', l: '', xl: '' } });
    const banded = setDefaultForm(DRYWALL(table), { price_brackets: addBand(withBrackets({ unit_price: '2.00' }, true).price_brackets!) });
    expect(banded.price_brackets).toEqual([
      { up_to_sf: 100, unit_price: '' },
      { up_to_sf: null, unit_price: '2.00' },
    ]);
    expect(setCategoryPricing(banded, true).rows?.[0]?.price_brackets).toEqual([
      { up_to_sf: 100, unit_price: '' },
      { up_to_sf: null, unit_price: '' },
    ]);
    expect(removeBand(banded.price_brackets!, 1)).toEqual([{ up_to_sf: null, unit_price: '' }]);
    expect(defaultForm(bracketsOff(banded))).toEqual({ unit_price: '' });
  });

  it('keeps a price per category while category prices are on, as categories are unticked and ticked again', () => {
    const table = priced();
    let item = setCategoryPricing(setItemCategories(DRYWALL(table), [1, 2, 3]), true);
    item = setRowForm(item, rowId({ category: 1 }), { unit_price: '4.00' });
    item = setRowForm(item, rowId({ category: 2 }), { unit_price: '5.00' });
    item = setRowForm(item, rowId({ category: 3 }), { unit_price: '6.50' });
    const fewer = setItemCategories(item, [1, 3]);
    expect(fewer.rows?.map(rowId)).toEqual(['|1', '|3']);
    const again = setItemCategories(fewer, [1, 2, 3]);
    expect(again.rows).toEqual([
      { category: 1, unit_price: '4.00' },
      { category: 2, unit_price: '' },
      { category: 3, unit_price: '6.50' },
    ]);
    expect(() => parseTable({ ...table, items: table.items.map((i) => (i.item_id === item.item_id ? again : i)) })).not.toThrow();
    // With category prices off, ticking a category adds no row.
    expect(setItemCategories(setItemCategories(DRYWALL(table), [1, 3]), [1, 2, 3]).rows).toBeUndefined();
  });

  it('removes rows the schema would refuse: a category the item no longer uses, a room type removed', () => {
    const table = withRows(true);
    const id = DRYWALL(table).item_id;
    const fewer = updateItem(table, id, (item) => setItemCategories(item, [1, 2]));
    expect(fewer.items.find((item) => item.item_id === id)!.rows!.map(rowId)).toEqual(['kitchen|', 'kitchen|2']);
    expect(() => parseTable(fewer)).not.toThrow();
    const removed = removeRoomType(table, 'kitchen');
    expect(removed.items.find((item) => item.item_id === id)!.rows!.map(rowId)).toEqual(['|3']);
    expect(() => parseTable(removed)).not.toThrow();
  });

  it('adds trade headings and room types with ids the schema accepts, and keeps a heading in use', () => {
    const table = addRoomType(addTrade(priced(), 'Contents & pack-out'), '2nd Bedroom');
    expect(table.trades!.at(-1)).toEqual({ trade_id: 'contents_pack_out', name: 'Contents & pack-out', minimum_charge: '0' });
    expect(table.policy.room_types.at(-1)).toEqual({ id: 'nd_bedroom', name: '2nd Bedroom', suggested_items: [] });
    expect(() => parseTable(table)).not.toThrow();
    const used = table.items[0]!.trade!;
    expect(removeTrade(table, used)).toBe(table);
    expect(removeTrade(table, 'contents_pack_out').trades!.some((trade) => trade.trade_id === 'contents_pack_out')).toBe(false);
    expect(idFromName('Kitchen', new Set(['kitchen', 'kitchen_2']), 30)).toBe('kitchen_3');
    expect(idFromName('!', new Set(), 30)).toBe('new');
  });

  it('adds, edits and removes a named adjustment with an id the schema accepts; a new one needs a value before it saves', () => {
    const added = addAdjustment(priced(), 'Returning customer');
    expect(added.adjustments).toEqual([{ adjustment_id: 'returning_customer', name: 'Returning customer', kind: 'percent', direction: 'discount', value: '' }]);
    expect(() => parseTable(added)).toThrow();
    const edited = setAdjustment(added, 'returning_customer', { kind: 'amount', direction: 'charge', value: '50' });
    expect(parseTable(edited).adjustments).toEqual([{ adjustment_id: 'returning_customer', name: 'Returning customer', kind: 'amount', direction: 'charge', value: '50' }]);
    expect(addAdjustment(edited, 'Returning customer').adjustments!.map((row) => row.adjustment_id)).toEqual(['returning_customer', 'returning_customer_2']);
    expect(removeAdjustment(edited, 'returning_customer')).not.toHaveProperty('adjustments');
  });

  it('counts two tables that differ only in key order as unchanged', () => {
    const table = priced();
    const reordered = JSON.parse(JSON.stringify({ policy: table.policy, trades: table.trades, items: table.items })) as Table;
    expect(changed(table, reordered)).toBe(false);
    expect(changed(table, updateItem(table, table.items[0]!.item_id, (item) => ({ ...item, unit_price: '3.00' })))).toBe(true);
  });
});

function bracketsOff(item: Item): Item {
  return setDefaultForm(item, withBrackets(defaultForm(item), false));
}

describe('the screen text', () => {
  it('shows a price as typed with punctuation only, and a blank price as not set', () => {
    expect(moneyText('1234.5')).toBe('$1,234.50');
    expect(moneyText('0.00')).toBe('$0.00');
    expect(moneyText('1000000.00')).toBe('$1,000,000.00');
    expect(moneyText('')).toBe('Price not set');
    expect(unitWords('unit_day')).toBe('per unit per day');
  });

  it('reads the server answers and refuses an unexpected shape', () => {
    const table = priced();
    const owner = pricesView({ view: 'owner', current: null, workingCopy: { revision: 0, baseSequence: null, updatedAt: null, table } });
    expect(owner?.view).toBe('owner');
    const reader = pricesView({ view: 'reader', current: { id: 'v', sequence: 2, publishedAt: '2026-11-14T00:00:00Z', table } });
    expect(reader).toMatchObject({ view: 'reader', current: { sequence: 2 } });
    expect(pricesView({ view: 'owner', current: null })).toBeNull();
    expect(pricesView({ view: 'reader', current: { id: 'v' } })).toBeNull();
    expect(pricesAccess({ company: { id: 'c' }, capabilities: ['prices_read'] })).toEqual({ companyId: 'c', canRead: true, canManage: false });
    expect(pricesAccess({ company: { id: 'c' }, capabilities: [] })?.canRead).toBe(false);
  });

  it('names the item a refusal is about, by its name', () => {
    const table = priced();
    const first = table.items[0]!;
    expect(pricesMessage(422, { error: 'not_publishable', detail: `${first.item_id}: the price is blank` }, table)).toBe(
      `The prices cannot be published yet. ${first.name}: the price is blank.`,
    );
    expect(pricesMessage(422, { error: 'invalid_table', detail: 'items.0.unit_price: must have at most 2 decimal places' }, table)).toBe(
      `Something in the prices cannot be saved. ${first.name}: must have at most 2 decimal places.`,
    );
    expect(pricesMessage(0, null)).toMatch(/connection/);
  });
});
