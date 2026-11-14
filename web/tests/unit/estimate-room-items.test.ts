// Worked examples for per-room item quantities (plan docs/plans/pricing.md step S4-4d, G1): a room's
// `items` list and the `room:typed` quantity source. Every expected number is worked by hand in the
// comment beside it, from the rule, not from an engine run.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate } from '../../src/engine/estimate';
import { validateInspection } from '../../src/engine/inspection';
import { contentHash, parseTable } from '../../src/engine/table';
import { inspection, item, job, lineTotals, priced, room, table, type Obj } from './estimate-fixtures';

/** A 4 ft flood cut, typed per room in linear feet, at $3.00 per foot. */
function floodCut(changes: Obj = {}): Obj {
  return item('flood_cut', {
    name: '4 ft flood cut',
    unit: 'lf',
    quantity_source: 'room:typed',
    unit_price: '3.00',
    ...changes,
  });
}

/** Carpet removal, typed per room in square feet, at $1.00 per sq ft. */
function carpet(changes: Obj = {}): Obj {
  return item('carpet', { quantity_source: 'room:typed', unit_price: '1.00', ...changes });
}

const typed = (id: string, quantity: number | string): Obj => ({ item_id: id, quantity });

/** Multipliers that make a wrongly applied multiplier show: Cat 1 x1, Cat 2 x1.5, Cat 3 x2. */
const MULTIPLIERS: Obj = { category_multipliers: { '1': '1', '2': '1.5', '3': '2' } };

describe('room:typed lines', () => {
  it('W68 the same item in two rooms at different quantities gives two lines and their sum', () => {
    // Bathroom 4 LF x $3.00 = $12.00. Hallway 12.5 LF x $3.00 = $37.50. Total $49.50.
    const result = priced(
      table([floodCut()]),
      job([
        room('Bathroom', { items: [typed('flood_cut', 4)] }),
        room('Hallway', { items: [typed('flood_cut', '12.5')] }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['Bathroom: 4 ft flood cut = 12.00', 'Hallway: 4 ft flood cut = 37.50']);
    expect(result.lines.map((line) => [line.room, line.quantity, line.unit])).toEqual([
      ['Bathroom', '4', 'lf'],
      ['Hallway', '12.5', 'lf'],
    ]);
    expect(result.totals.low.total).toBe('49.50');
    expect(result.engine_version).toBe('dryscope-v3');
  });

  it('W69 a Cat 3 room prices its typed line by the Cat 3 row as set, with waste; the default row keeps its multiplier', () => {
    // Cat 3 row $5.00. Kitchen, Cat 3, waste 10%, 10 LF: 10 x $5.00 x 1.10 = $55.00 (the row is used as set, not x2).
    // Bath, Cat 2, 10 LF: the default row $3.00 x1.5 = $4.50, so $45.00. Total $100.00.
    const result = priced(
      table([floodCut({ rows: [{ category: 3, unit_price: '5.00' }] })], MULTIPLIERS),
      job([
        room('Kitchen', { category: 3, waste_percent: 10, items: [typed('flood_cut', 10)] }),
        room('Bath', { category: 2, items: [typed('flood_cut', 10)] }),
      ]),
    );
    // An item's lines come default row first, then each row's (as for every room line).
    expect(lineTotals(result)).toEqual(['Bath: 4 ft flood cut = 45.00', 'Kitchen, Cat 3: 4 ft flood cut = 55.00']);
    expect(result.lines.map((line) => line.waste_percent)).toEqual(['0', '10']);
    expect(result.totals.low.total).toBe('100.00');
  });

  it('W70 a typed item with brackets counts only its own row\'s rooms toward each row\'s bands', () => {
    // Default bands: up to 100 sq ft $2.00, beyond $1.00. Cat 3 row bands: up to 100 sq ft $4.00, beyond $3.00.
    // Default row, rooms in order (same price, so the order they were entered): Hall 70 sq ft at $2.00 = $140.00;
    // Bedroom 50 sq ft: 30 more to reach 100 at $2.00 = $60.00, then 20 at $1.00 = $20.00.
    // Cat 3 row: Kitchen 80 sq ft counts alone, so all 80 at $4.00 = $320.00 (the default row's 120 sq ft do not
    // push it into the $3.00 band). Total $540.00.
    const result = priced(
      table([
        carpet({
          unit_price: '',
          price_brackets: [
            { up_to_sf: 100, unit_price: '2.00' },
            { up_to_sf: null, unit_price: '1.00' },
          ],
          rows: [
            {
              category: 3,
              price_brackets: [
                { up_to_sf: 100, unit_price: '4.00' },
                { up_to_sf: null, unit_price: '3.00' },
              ],
            },
          ],
        }),
      ]),
      job([
        room('Hall', { items: [typed('carpet', 70)] }),
        room('Bedroom', { items: [typed('carpet', 50)] }),
        room('Kitchen', { category: 3, items: [typed('carpet', 80)] }),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Hall: carpet (tiered bracket: over 0 through 100 sq ft) = 140.00',
      'Bedroom: carpet (tiered bracket: over 0 through 100 sq ft) = 60.00',
      'Bedroom: carpet (tiered bracket: over 100 sq ft) = 20.00',
      'Kitchen, Cat 3: carpet (tiered bracket: over 0 through 100 sq ft) = 320.00',
    ]);
    expect(result.totals.low.total).toBe('540.00');
  });

  it('W71 a room that does not list the item gets no line and no missing-area warning; a zero quantity is no line', () => {
    // Bath lists 6 LF: 6 x $3.00 = $18.00. Closet lists nothing; Porch lists 0 LF. Demolition $2.00 per
    // unfinished sq ft prices the Closet's 40 sq ft: $80.00. Total $98.00.
    const result = priced(
      table([floodCut(), item('demo')]),
      job([
        room('Bath', { items: [typed('flood_cut', 6)] }),
        room('Closet', { unfinished_sf: 40 }),
        room('Porch', { items: [typed('flood_cut', 0)] }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['Bath: 4 ft flood cut = 18.00', 'Closet: demo = 80.00']);
    expect(result.totals.low.total).toBe('98.00');
    const flood = result.warnings.engine.filter((row) => (row as Obj).item_id === 'flood_cut');
    expect(flood).toEqual([]);
  });

  it('W72 a room that lists no typed item is still named when nothing else prices its area', () => {
    // Only the typed flood cut is on the list. Bath lists 5 LF ($15.00); the Laundry has 30 sq ft of demolition
    // area and lists nothing, so nothing prices it and the advisory warning names it.
    const result = priced(
      table([floodCut()]),
      job([room('Bath', { items: [typed('flood_cut', 5)] }), room('Laundry', { unfinished_sf: 30 })]),
    );
    expect(lineTotals(result)).toEqual(['Bath: 4 ft flood cut = 15.00']);
    const unpriced = result.warnings.advisory.filter((row) => (row as Obj).code === 'unpriced_room');
    expect(unpriced.map((row) => (row as Obj).room)).toEqual(['Laundry']);
  });

  it('W73 the item filters still apply: a category the item excludes gets no line', () => {
    // Flood cut for Cat 2 and Cat 3 rooms only. Bath, Cat 3, 4 LF: $3.00 x2 = $6.00, so $24.00. Den, Cat 1,
    // lists 4 LF but the item excludes Cat 1, so no line. Total $24.00.
    const result = priced(
      table([floodCut({ categories: [2, 3] })], MULTIPLIERS),
      job([
        room('Bath', { category: 3, items: [typed('flood_cut', 4)] }),
        room('Den', { items: [typed('flood_cut', 4)] }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['Bath: 4 ft flood cut = 24.00']);
  });

  it('W74 whole-job mode counts a typed square-foot quantity in the job\'s total square feet', () => {
    // Bands: up to 100 sq ft $2.00, beyond $1.00, whole-job. Hall 60 + Bed 60 typed = 120 sq ft, so every
    // square foot is in the $1.00 band: $60.00 + $60.00 = $120.00 (not $240.00 at $2.00).
    const result = priced(
      table(
        [
          carpet({
            unit_price: '',
            price_brackets: [
              { up_to_sf: 100, unit_price: '2.00' },
              { up_to_sf: null, unit_price: '1.00' },
            ],
          }),
        ],
        { bracket_mode: 'whole-job' },
      ),
      job([room('Hall', { items: [typed('carpet', 60)] }), room('Bed', { items: [typed('carpet', 60)] })]),
    );
    expect(result.totals.low.total).toBe('120.00');
  });
});

describe('the high end with typed quantities', () => {
  it('W75 cushion: a typed square-foot line is an area line, a typed line in other units grows at the first percent', () => {
    // Range: first 50 sq ft at 50%, beyond at 20%. Quantities are priced as entered at both ends.
    // Bath carpet 100 sq ft x $1.00 = $100.00, an area line: its dearest 50 sq ft are $50.00, so
    // high = 1.20 x $100.00 + (0.50 - 0.20) x $50.00 = $120.00 + $15.00 = $135.00.
    // Bath flood cut 10 LF x $3.00 = $30.00 is not read from an area, so it grows at the first percent: $45.00.
    // Low $130.00, high $180.00.
    const result = priced(
      table([carpet(), floodCut()], {
        estimate_mode: 'range',
        range: { first_sf: 50, first_percent: '50', beyond_percent: '20' },
      }),
      job([room('Bath', { items: [typed('carpet', 100), typed('flood_cut', 10)] })]),
    );
    expect(result.totals.low.total).toBe('130.00');
    expect(result.totals.high?.total).toBe('180.00');
  });

  it('W76 uncertainty: a typed line grows by its own room\'s hidden-damage percent, its quantity unchanged', () => {
    // Hidden damage Cat 1 0%, Cat 3 20%. Bath, Cat 3, 10 LF x $3.00 = $30.00, high $36.00.
    // Den, Cat 1, 10 LF = $30.00, high $30.00. Low $60.00, high $66.00.
    const result = priced(
      table([floodCut()], {
        estimate_mode: 'range',
        assist: {
          drying_days: 3,
          range_method: 'uncertainty',
          extra_drying_days: 0,
          hidden_damage_percent: { '1': '0', '2': '0', '3': '20' },
        },
      }),
      job([
        room('Bath', { category: 3, items: [typed('flood_cut', 10)] }),
        room('Den', { items: [typed('flood_cut', 10)] }),
      ]),
    );
    expect(result.totals.low.total).toBe('60.00');
    expect(result.totals.high?.total).toBe('66.00');
  });
});

describe('schema rules for room items', () => {
  it('a room item names a known room:typed item; an unknown id or another source is refused', () => {
    const list = table([floodCut(), item('demo')]);
    const unknown = priceEstimate(list, job([room('Bath', { items: [typed('flood_kut', 4)] })]));
    expect(unknown).toMatchObject({ ok: false, stage: 'inspection' });
    expect(unknown.ok ? '' : unknown.error).toContain('flood_kut');
    const other = priceEstimate(list, job([room('Bath', { items: [typed('demo', 4)] })]));
    expect(other).toMatchObject({ ok: false, stage: 'inspection' });
  });

  it('a second entry for one item in a room is refused', () => {
    const twice = { items: [typed('flood_cut', 4), typed('flood_cut', 2)] };
    expect(() => validateInspection(inspection([room('Bath', twice)]))).toThrow(/rooms\.0\.items/);
    const result = priceEstimate(table([floodCut()]), job([room('Bath', twice)]));
    expect(result).toMatchObject({ ok: false, stage: 'inspection' });
  });

  it('a room holds up to 50 items; quantities are 0 to 100,000 with at most two decimals', () => {
    const ids = Array.from({ length: 51 }, (_, index) => `item_${index}`);
    const fifty = ids.slice(0, 50).map((id) => typed(id, 1));
    expect(() => validateInspection(inspection([room('Bath', { items: fifty })]))).not.toThrow();
    const many = ids.map((id) => typed(id, 1));
    expect(() => validateInspection(inspection([room('Bath', { items: many })]))).toThrow(/rooms\.0\.items/);
    for (const quantity of [-1, '1.005', 100001, 'abc']) {
      expect(() => validateInspection(inspection([room('Bath', { items: [typed('flood_cut', quantity)] })]))).toThrow();
    }
    const malformed: Obj[] = [{ item_id: 'Flood Cut', quantity: 1 }, { item_id: 'flood_cut' }, { ...typed('flood_cut', 1), note: 'x' }];
    for (const bad of malformed) {
      expect(() => validateInspection(inspection([room('Bath', { items: [bad] })]))).toThrow();
    }
  });

  it('room:typed is a room source: square-foot demolition, rows and brackets accept it; the room unit refuses it', () => {
    expect(checkTable(table([carpet({ group: 'demolition' })])).ok).toBe(true);
    expect(checkTable(table([floodCut({ rows: [{ category: 3, unit_price: '5.00' }] })])).ok).toBe(true);
    expect(
      checkTable(
        table([carpet({ unit_price: '', price_brackets: [{ up_to_sf: null, unit_price: '1.00' }] })]),
      ).ok,
    ).toBe(true);
    const perRoom = item('contents', {
      group: 'treatment',
      unit: 'room',
      quantity_source: 'room:typed',
      tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '40.00' },
    });
    delete perRoom.unit_price;
    const refused = checkTable(table([perRoom]));
    expect(refused.ok).toBe(false);
  });

  it('a table that uses room:typed is canonical: parsing it again gives the same hash', () => {
    const parsed = parseTable(table([floodCut()]));
    expect(contentHash(parseTable(parsed))).toBe(contentHash(parsed));
  });

  it('room items are job input: they never change the table hash an estimate reports', () => {
    const list = table([floodCut(), item('demo')]);
    const without = priced(list, job([room('Bath', { unfinished_sf: 10 })]));
    const withItems = priced(list, job([room('Bath', { unfinished_sf: 10, items: [typed('flood_cut', 3)] })]));
    expect(withItems.table_sha256).toBe(without.table_sha256);
  });

  it('rooms without items price exactly as before: the inspection reads an empty list', () => {
    const data = validateInspection(inspection([room('Bath', { unfinished_sf: 10 })]));
    expect(data.rooms[0]?.items).toEqual([]);
  });
});
