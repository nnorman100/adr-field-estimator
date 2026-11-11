// Worked examples for room inputs: size tiers and per-room items, mold condition and containment,
// room types and room-type rows (plan docs/plans/pricing.md section 3.4, step S4-4b).
// Every expected number is worked by hand in the comment beside it, from the rule, not from an engine run.

import { describe, expect, it } from 'vitest';

import { checkTable, priceEstimate, suggestedItems, suggestEquipment } from '../../src/engine/estimate';
import { PriceTableV3, contentHash, effectiveTable, parseTable } from '../../src/engine/table';
import type { Json } from '../../src/engine/estimate';
import { inspection, item, job, lineTotals, priced, room, table, type Obj } from './estimate-fixtures';

/** Rooms up to 100 sq ft are S, up to 200 M, up to 400 L, and anything larger XL. */
const TIERS: Obj = { size_tiers: { s_up_to_sf: 100, m_up_to_sf: 200, l_up_to_sf: 400 } };

/** A per-room item: one line for each room it applies to, priced by the room's size tier. */
function perRoom(id: string, tiers: [string, string, string, string], changes: Obj = {}): Obj {
  const [s, m, l, xl] = tiers;
  const body = item(id, {
    group: 'treatment',
    unit: 'room',
    quantity_source: 'room:each',
    tier_prices: { s, m, l, xl },
    ...changes,
  });
  delete body.unit_price;
  return body;
}

/** The advisory warnings with one code, as the owner would read them. */
function advisory(result: { warnings: { advisory: Json[] } }, code: string): Json[] {
  return result.warnings.advisory.filter((row) => (row as Obj).code === code);
}

/** $50.00, $75.00, $110.00 and $160.00 for S, M, L and XL. */
const CONTENTS = perRoom('contents', ['50.00', '75.00', '110.00', '160.00']);

const floor = (name: string, floorSf: number, changes: Obj = {}) => room(name, { floor_sf: floorSf, ...changes });

describe('size tiers on per-room items', () => {
  it('W35 a room is S, M, L or XL by its floor area; each limit is the largest size in its tier', () => {
    // Limits 100 / 200 / 400. Floor areas 100, 101, 200, 201, 400 and 401 sq ft are S, M, M, L, L, XL:
    // $50.00 + $75.00 + $75.00 + $110.00 + $110.00 + $160.00 = $580.00.
    const result = priced(
      table([CONTENTS], TIERS),
      job([
        floor('A', 100),
        floor('B', 101),
        floor('C', 200),
        floor('D', 201),
        floor('E', 400),
        floor('F', 401),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'A: contents (size S) = 50.00',
      'B: contents (size M) = 75.00',
      'C: contents (size M) = 75.00',
      'D: contents (size L) = 110.00',
      'E: contents (size L) = 110.00',
      'F: contents (size XL) = 160.00',
    ]);
    expect(result.totals.low.total).toBe('580.00');
    expect(result.lines.map((line) => [line.unit, line.quantity])).toEqual(Array(6).fill(['room', '1']));
  });

  it("W36 a room with several areas: only the floor area sets the tier, not its wet floor or demolition areas", () => {
    // Hall: floor 150 sq ft (M, $75.00) although it removes 500 + 300 sq ft of drywall (800 would be XL).
    // Cellar: floor 220 sq ft (L, $110.00) although its wet floor is only 90 (S). Nook states a wet floor
    // of 90 and 120 sq ft of demolition but no floor area, so its size is unknown: no line, and the
    // warnings name it. Total $185.00.
    const result = priced(
      table([CONTENTS], TIERS),
      job([
        floor('Hall', 150, { unfinished_sf: 500, finished_sf: 300 }),
        floor('Cellar', 220, { wet_floor_sf: 90 }),
        room('Nook', { wet_floor_sf: 90, unfinished_sf: 120 }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['Hall: contents (size M) = 75.00', 'Cellar: contents (size L) = 110.00']);
    expect(result.totals.low.total).toBe('185.00');
    expect(result.warnings.engine).toContainEqual({ code: 'missing_size', item_id: 'contents', room: 'Nook' });
  });

  it('W37 a size the technician confirmed wins over the areas; a room with no size gets no line and a warning', () => {
    // Closet is 30 sq ft but confirmed XL: $160.00. Attic has no area and no tier: no line, and the
    // warnings name it once. Total $160.00.
    const result = priced(
      table([CONTENTS, perRoom('seal', ['5.00', '6.00', '7.00', '8.00'])], TIERS),
      job([floor('Closet', 30, { size_tier: 'xl' }), room('Attic')]),
    );
    expect(lineTotals(result)).toEqual(['Closet: contents (size XL) = 160.00', 'Closet: seal (size XL) = 8.00']);
    expect(result.totals.low.total).toBe('168.00');
    expect(result.warnings.engine).toContainEqual({ code: 'missing_size', item_id: 'contents', room: 'Attic' });
    expect(advisory(result, 'room_size_missing')).toEqual([
      {
        code: 'room_size_missing',
        room: 'Attic',
        text: 'Attic: its size (floor area or a size tier) is needed to price its per-room items, so those lines are not priced.',
      },
    ]);
  });

  it('W38 the default tier prices take the category multiplier; a category row of tier prices is used as set', () => {
    // Multipliers Cat 2 x1.5, Cat 3 x2. Contents: default $50 / $75 / $110 / $160, and a Cat 3 row of
    // $60 / $85 / $125 / $180 as set. Den (Cat 2, M): $75.00 x1.5 = $112.50. Bath (Cat 3, L): the row's
    // $125.00, not x2. Hall (Cat 1, S): $50.00. Total $287.50. Lines come default row first, then each row.
    const contents = perRoom('contents', ['50.00', '75.00', '110.00', '160.00'], {
      rows: [{ category: 3, tier_prices: { s: '60.00', m: '85.00', l: '125.00', xl: '180.00' } }],
    });
    const result = priced(
      table([contents], { ...TIERS, category_multipliers: { '1': '1', '2': '1.5', '3': '2' } }),
      job([
        floor('Den', 150, { category: 2 }),
        floor('Bath', 300, { category: 3 }),
        floor('Hall', 80),
      ]),
    );
    expect(lineTotals(result)).toEqual([
      'Den: contents (size M) = 112.50',
      'Hall: contents (size S) = 50.00',
      'Bath, Cat 3: contents (size L) = 125.00',
    ]);
    expect(result.totals.low.total).toBe('287.50');
  });

  it('W39 a per-room line is not priced by square feet: no bracket, no area, quantity one', () => {
    // A $2.00 per sq ft demolition item and a per-room item on a 150 sq ft Hall that removes 100 sq ft:
    // demolition 100 x $2.00 = $200.00; contents (M) $75.00. Total $275.00.
    const result = priced(
      table([item('demo'), CONTENTS], TIERS),
      job([floor('Hall', 150, { unfinished_sf: 100 })]),
    );
    expect(lineTotals(result)).toEqual(['Hall: demo = 200.00', 'Hall: contents (size M) = 75.00']);
    expect(result.totals.low.total).toBe('275.00');
  });
});

describe('per-room lines in the range', () => {
  it('W58 the cushion treats a per-room line as non-area work: the first percent applies to it', () => {
    // Hall, floor 150 (M): contents $75.00 low. Range 50% on the first 1,000 sq ft, 20% beyond: a per-room
    // line has no square feet, so it takes the first percent like labor hours: $75.00 x 1.50 = $112.50.
    const result = priced(
      table([CONTENTS], {
        ...TIERS,
        estimate_mode: 'range',
        range: { first_sf: 1000, first_percent: '50', beyond_percent: '20' },
      }),
      job([floor('Hall', 150)]),
    );
    expect(result.totals.low.total).toBe('75.00');
    expect(result.totals.high?.total).toBe('112.50');
  });

  it("W59 under the uncertainty method a per-room line grows by its own room's hidden-damage percent", () => {
    // Hidden damage 0% / 0% / 20%. Hall (Cat 3, floor 150 = M, $75.00) grows 20%: $90.00. Den (Cat 1,
    // floor 80 = S, $50.00) grows 0%: $50.00, not the job's largest 20% ($60.00). Low $125.00, high $140.00.
    const result = priced(
      table([CONTENTS], {
        ...TIERS,
        estimate_mode: 'range',
        assist: {
          drying_days: 3,
          range_method: 'uncertainty',
          extra_drying_days: 0,
          hidden_damage_percent: { '1': '0', '2': '0', '3': '20' },
        },
      }),
      job([floor('Hall', 150, { category: 3 }), floor('Den', 80)]),
    );
    expect(result.totals.low.total).toBe('125.00');
    expect(result.totals.high?.total).toBe('140.00');
  });
});

/** Mold removal ($3.00 per sq ft, Condition 3) and cleaning ($1.50, Conditions 2 and 3), mold rooms only. */
const MOLD_ITEMS = [
  item('mold_removal', { group: 'treatment', categories: ['mold'], mold_conditions: [3], unit_price: '3.00' }),
  item('mold_cleaning', { group: 'treatment', categories: ['mold'], mold_conditions: [2, 3], unit_price: '1.50' }),
];

describe('mold condition eligibility (M8)', () => {
  const mold = (name: string, condition: number | undefined, sf = 10) =>
    room(name, { category: 'mold', unfinished_sf: sf, ...(condition ? { mold_condition: condition } : {}) });

  it('W40 Condition 3: removal and cleaning', () => {
    // Closet, 10 sq ft: removal 10 x $3.00 = $30.00, cleaning 10 x $1.50 = $15.00. Total $45.00.
    const result = priced(table(MOLD_ITEMS), job([mold('Closet', 3)]));
    expect(lineTotals(result)).toEqual(['Closet: mold removal = 30.00', 'Closet: mold cleaning = 15.00']);
    expect(result.totals.low.total).toBe('45.00');
  });

  it('W41 Condition 2: cleaning only', () => {
    // Attic, 10 sq ft: cleaning 10 x $1.50 = $15.00; no removal line.
    const result = priced(table(MOLD_ITEMS), job([mold('Attic', 2)]));
    expect(lineTotals(result)).toEqual(['Attic: mold cleaning = 15.00']);
    expect(result.totals.low.total).toBe('15.00');
  });

  it('W42 Condition 1 (normal fungal ecology): neither item, and an item with no condition filter still applies', () => {
    // Den, Condition 1: neither mold item applies. An item with no condition filter ($1.00, mold
    // rooms) prices it: 10 x $1.00 = $10.00.
    const result = priced(
      table([...MOLD_ITEMS, item('sample', { categories: ['mold'], unit_price: '1.00' })]),
      job([mold('Den', 1)]),
    );
    expect(lineTotals(result)).toEqual(['Den: sample = 10.00']);
    expect(result.totals.low.total).toBe('10.00');
  });

  it('W43 a Mold room with no condition prices neither item and the warnings name the room once', () => {
    // Pantry has no condition: the two filtered items give no line, so only the unfiltered sample
    // line prices ($10.00), and the advisory warning says why.
    const result = priced(
      table([...MOLD_ITEMS, item('sample', { categories: ['mold'], unit_price: '1.00' })]),
      job([mold('Pantry', undefined)]),
    );
    expect(lineTotals(result)).toEqual(['Pantry: sample = 10.00']);
    expect(advisory(result, 'mold_condition_missing')).toEqual([
      {
        code: 'mold_condition_missing',
        room: 'Pantry',
        text: 'Pantry: its mold condition is needed to price its mold items, so those lines are not priced.',
      },
    ]);
  });
});

describe('containment by affected area (M8)', () => {
  // Three containment items, each a per-room item for one band: $100.00, $250.00, $600.00 at every size.
  const flat = (amount: string): [string, string, string, string] => [amount, amount, amount, amount];
  const CONTAINMENT = [
    perRoom('contain_small', flat('100.00'), { categories: ['mold'], affected_bands: ['up_to_10'] }),
    perRoom('contain_medium', flat('250.00'), { categories: ['mold'], affected_bands: ['over_10_to_100'] }),
    perRoom('contain_large', flat('600.00'), { categories: ['mold'], affected_bands: ['over_100'] }),
  ];
  const containment = (name: string, affected: number | string | undefined) =>
    room(name, { category: 'mold', size_tier: 's', ...(affected === undefined ? {} : { affected_sf: affected }) });

  it('W44 up to 10 sq ft: the small item, with 10 itself in this band', () => {
    // Rooms at 5 and 10 sq ft: $100.00 each. Total $200.00.
    const result = priced(table(CONTAINMENT, TIERS), job([containment('A', 5), containment('B', 10)]));
    expect(lineTotals(result)).toEqual(['A: contain small (size S) = 100.00', 'B: contain small (size S) = 100.00']);
    expect(result.totals.low.total).toBe('200.00');
  });

  it('W45 over 10 through 100 sq ft: the medium item, with 100 itself in this band', () => {
    // Rooms at 10.01 and 100 sq ft: $250.00 each. Total $500.00.
    const result = priced(table(CONTAINMENT, TIERS), job([containment('A', '10.01'), containment('B', 100)]));
    expect(lineTotals(result)).toEqual([
      'A: contain medium (size S) = 250.00',
      'B: contain medium (size S) = 250.00',
    ]);
    expect(result.totals.low.total).toBe('500.00');
  });

  it('W46 over 100 sq ft: the large item', () => {
    // A room at 100.01 sq ft: $600.00.
    const result = priced(table(CONTAINMENT, TIERS), job([containment('A', '100.01')]));
    expect(lineTotals(result)).toEqual(['A: contain large (size S) = 600.00']);
    expect(result.totals.low.total).toBe('600.00');
  });

  it('W47 a mold room with no affected area gets no containment line, and the warning names it', () => {
    // Only the room that states 5 sq ft is priced ($100.00).
    const result = priced(table(CONTAINMENT, TIERS), job([containment('A', 5), containment('B', undefined)]));
    expect(lineTotals(result)).toEqual(['A: contain small (size S) = 100.00']);
    expect(advisory(result, 'affected_area_missing')).toEqual([
      {
        code: 'affected_area_missing',
        room: 'B',
        text: 'B: its affected square feet are needed to price its mold containment, so those lines are not priced.',
      },
    ]);
  });

  it('W48 condition and band filters together: both must match', () => {
    // Containment for Condition 3 over 100 sq ft only. A (Condition 3, 150): $600.00.
    // B (Condition 2, 150) and C (Condition 3, 50) get nothing.
    const only = perRoom('contain_big', flat('600.00'), {
      categories: ['mold'],
      mold_conditions: [3],
      affected_bands: ['over_100'],
    });
    const result = priced(
      table([only], TIERS),
      job([
        room('A', { category: 'mold', size_tier: 's', mold_condition: 3, affected_sf: 150 }),
        room('B', { category: 'mold', size_tier: 's', mold_condition: 2, affected_sf: 150 }),
        room('C', { category: 'mold', size_tier: 's', mold_condition: 3, affected_sf: 50 }),
      ]),
    );
    expect(lineTotals(result)).toEqual(['A: contain big (size S) = 600.00']);
  });
});

/** Demolition $2.00 by default; Kitchen $3.00; Kitchen Cat 3 $6.00; Bathroom $4.00; Cat 3 $5.00; Other $1.00. */
function typedItem(extra: Obj[] = []): Obj {
  return item('demo', {
    rows: [
      { room_type: 'kitchen', unit_price: '3.00' },
      { room_type: 'kitchen', category: 3, unit_price: '6.00' },
      { room_type: 'bathroom', unit_price: '4.00' },
      { category: 3, unit_price: '5.00' },
      ...extra,
    ],
  });
}
const ROOM_TYPES: Obj = {
  room_type_pricing: true,
  room_types: [
    { id: 'kitchen', name: 'Kitchen' },
    { id: 'bathroom', name: 'Bathroom' },
  ],
};
const hundred = (name: string, changes: Obj = {}) => room(name, { unfinished_sf: 100, ...changes });

describe('room-type rows (off by default)', () => {
  const rooms = [
    hundred('Galley', { room_type_id: 'kitchen' }),
    hundred('Cook', { room_type_id: 'kitchen', category: 3 }),
    hundred('Cellar', { room_type_id: 'bathroom', category: 3 }),
    hundred('Shed', { room_type_id: 'other', category: 3 }),
    hundred('Pantry'),
  ];

  it('W49 on: room type plus category, then room type, then category, then the default row', () => {
    // Every room removes 100 sq ft. Galley (Kitchen, Cat 1): the Kitchen row $3.00 -> $300.00.
    // Cook (Kitchen, Cat 3): the Kitchen + Cat 3 row $6.00 -> $600.00. Cellar (Bathroom, Cat 3): the
    // Bathroom row $4.00 beats the Cat 3 row $5.00 -> $400.00. Shed (Other, Cat 3): no Other row, so the
    // Cat 3 row $5.00 -> $500.00. Pantry (no type, Cat 1): the default $2.00 -> $200.00. Total $2,000.00.
    // Lines come default row first, then the rows in their stored order (category rows, then each room type).
    const result = priced(table([typedItem()], ROOM_TYPES), job(rooms));
    expect(lineTotals(result)).toEqual([
      'Pantry: demo = 200.00',
      'Shed, Cat 3: demo = 500.00',
      'Cellar, Bathroom: demo = 400.00',
      'Galley, Kitchen: demo = 300.00',
      'Cook, Kitchen, Cat 3: demo = 600.00',
    ]);
    expect(result.totals.low.total).toBe('2000.00');
  });

  it('W50 off (the default): the same table and job ignore every room-type row', () => {
    // Galley (Cat 1): default $2.00 -> $200.00. Cook, Cellar and Shed (Cat 3): the Cat 3 row $5.00 ->
    // $500.00 each. Pantry: $200.00. Total $1,900.00. No warning mentions a room type.
    const off = { ...ROOM_TYPES, room_type_pricing: false };
    const result = priced(table([typedItem()], off), job(rooms));
    expect(lineTotals(result)).toEqual([
      'Galley: demo = 200.00',
      'Pantry: demo = 200.00',
      'Cook, Cat 3: demo = 500.00',
      'Cellar, Cat 3: demo = 500.00',
      'Shed, Cat 3: demo = 500.00',
    ]);
    expect(result.totals.low.total).toBe('1900.00');
    expect(result.warnings.advisory.filter((row) => String((row as Obj).code).startsWith('room_type'))).toEqual([]);
    // The same prices as a table that never had the room-type rows, and the stored table keeps them.
    const without = item('demo', { rows: [{ category: 3, unit_price: '5.00' }] });
    expect(priced(table([without], off), job(rooms)).totals.low.total).toBe('1900.00');
    const parsed = parseTable(table([typedItem()], off));
    expect(parsed.items[0]?.rows).toHaveLength(4);
    expect(effectiveTable(parsed).items[0]?.rows).toEqual([{ category: 3, unit_price: '5.00' }]);
  });

  it('W51 a type of Other with its own row: that row prices rooms typed Other and rooms with no type', () => {
    // Other row $1.00. Shed (Other, Cat 3) and Pantry (no type, Cat 1) both use it, even though Shed
    // also has a Cat 3 row: room type beats category. 100 x $1.00 each, $200.00.
    const result = priced(
      table([typedItem([{ room_type: 'other', unit_price: '1.00' }])], ROOM_TYPES),
      job([hundred('Shed', { room_type_id: 'other', category: 3 }), hundred('Pantry')]),
    );
    expect(lineTotals(result)).toEqual(['Shed, Other: demo = 100.00', 'Pantry, Other: demo = 100.00']);
    expect(result.totals.low.total).toBe('200.00');
  });

  it('W52 a type the pinned table does not list falls back; the warning shows only with the setting on', () => {
    // Garage is not in the table (it was removed, or the phone is older). It uses the rows without a
    // room type: Cat 3 row $5.00 -> $500.00. With room-type rows on, the warnings name Garage; with the
    // setting off nothing is said.
    const garage = job([hundred('Garage', { room_type_id: 'garage', category: 3 })]);
    const on = priced(table([typedItem()], ROOM_TYPES), garage);
    expect(lineTotals(on)).toEqual(['Garage, Cat 3: demo = 500.00']);
    expect(on.warnings.advisory).toContainEqual({
      code: 'room_type_unknown',
      room: 'Garage',
      text: 'Garage: its room type is not on your price list, so it uses the standard price for items priced by room type.',
    });
    const off = priced(table([typedItem()], { ...ROOM_TYPES, room_type_pricing: false }), garage);
    expect(lineTotals(off)).toEqual(['Garage, Cat 3: demo = 500.00']);
    expect(off.warnings.advisory).toEqual([]);
  });

  it('W53 a room typed Other (or with no type) is warned about only when an item has room-type prices', () => {
    // Pantry has no type. Item "demo" has room-type rows: warn. Item "wipe" has none: the same room
    // would not warn on its own. Off: no warning either way.
    const pantry = job([hundred('Pantry')]);
    const warned = priced(table([typedItem()], ROOM_TYPES), pantry).warnings.advisory;
    expect(warned).toContainEqual({
      code: 'room_type_other',
      room: 'Pantry',
      text: 'Pantry: its room type is Other, so it uses the standard price for items priced by room type.',
    });
    expect(priced(table([item('wipe')], ROOM_TYPES), pantry).warnings.advisory).toEqual([]);
    expect(priced(table([typedItem()], { ...ROOM_TYPES, room_type_pricing: false }), pantry).warnings.advisory).toEqual([]);
  });

  it('W54 room-type rows on a per-room item price by size tier like the default row, as set', () => {
    // Kitchen row of tier prices $70 / $90 / $130 / $190. Galley (Kitchen, 150 sq ft = M): $90.00,
    // not x1.5 (Cat 2 multiplier). Pantry (no type, Cat 2, 150 sq ft = M): default $75.00 x1.5 = $112.50.
    const contents = perRoom('contents', ['50.00', '75.00', '110.00', '160.00'], {
      rows: [{ room_type: 'kitchen', tier_prices: { s: '70.00', m: '90.00', l: '130.00', xl: '190.00' } }],
    });
    const result = priced(
      table([contents], { ...TIERS, ...ROOM_TYPES, category_multipliers: { '1': '1', '2': '1.5', '3': '1' } }),
      job([floor('Galley', 150, { room_type_id: 'kitchen', category: 2 }), floor('Pantry', 150, { category: 2 })]),
    );
    expect(lineTotals(result)).toEqual([
      'Pantry: contents (size M) = 112.50',
      'Galley, Kitchen: contents (size M) = 90.00',
    ]);
    expect(result.totals.low.total).toBe('202.50');
  });

  it('W55 brackets count per row, and a room-type row counts only the rooms it priced', () => {
    // Default $1.00 up to 100 sq ft then $0.50. Kitchen row: $4.00 up to 50 sq ft then $2.00.
    // Galley (Kitchen) 80 sq ft: 50 x $4.00 + 30 x $2.00 = $260.00 (the Kitchen row's own bands).
    // Pantry (no type) 120 sq ft: 100 x $1.00 + 20 x $0.50 = $110.00 (its bands are untouched by Galley).
    // Total $370.00.
    const demo = item('demo', {
      unit_price: '',
      price_brackets: [
        { up_to_sf: 100, unit_price: '1.00' },
        { up_to_sf: null, unit_price: '0.50' },
      ],
      rows: [
        {
          room_type: 'kitchen',
          price_brackets: [
            { up_to_sf: 50, unit_price: '4.00' },
            { up_to_sf: null, unit_price: '2.00' },
          ],
        },
      ],
    });
    const result = priced(
      table([demo], ROOM_TYPES),
      job([room('Galley', { room_type_id: 'kitchen', unfinished_sf: 80 }), room('Pantry', { unfinished_sf: 120 })]),
    );
    expect(lineTotals(result)).toEqual([
      'Pantry: demo (tiered bracket: over 0 through 100 sq ft) = 100.00',
      'Pantry: demo (tiered bracket: over 100 sq ft) = 10.00',
      'Galley, Kitchen: demo (tiered bracket: over 0 through 50 sq ft) = 200.00',
      'Galley, Kitchen: demo (tiered bracket: over 50 sq ft) = 60.00',
    ]);
    expect(result.totals.low.total).toBe('370.00');
  });

  it('a blank room-type price blocks publishing only while the setting is on', () => {
    const blank = (on: boolean) =>
      table([item('demo', { rows: [{ room_type: 'kitchen', unit_price: '' }] })], { ...ROOM_TYPES, room_type_pricing: on });
    expect(checkTable(blank(true)).ok).toBe(false);
    expect(checkTable(blank(false)).ok).toBe(true);
  });
});

describe('room types as labels with suggested item lists', () => {
  const LISTED: Obj = {
    room_types: [
      { id: 'kitchen', name: 'Kitchen', suggested_items: ['seal', 'demo', 'old_item'] },
      { id: 'hallway', name: 'Hallway' },
    ],
  };
  const items = [item('demo'), item('seal', { group: 'treatment' }), item('old_item', { enabled: false })];

  it('lists the enabled items a type suggests in the owner order, and none for Other or an unknown type', () => {
    const parsed = parseTable(table(items, LISTED));
    expect(suggestedItems(parsed, 'kitchen').map((entry) => entry.item_id)).toEqual(['seal', 'demo']);
    expect(suggestedItems(parsed, 'hallway')).toEqual([]);
    expect(suggestedItems(parsed, 'other')).toEqual([]);
    expect(suggestedItems(parsed, 'garage')).toEqual([]);
  });

  it('a suggested list changes no price, with room-type rows off or on', () => {
    const rooms = job([room('Galley', { room_type_id: 'kitchen', unfinished_sf: 100 })]);
    const plain = priced(table(items, {}), rooms);
    expect(priced(table(items, LISTED), rooms).totals).toEqual(plain.totals);
    expect(priced(table(items, { ...LISTED, room_type_pricing: true }), rooms).totals).toEqual(plain.totals);
  });
});

describe('equipment suggestions from class and room volume', () => {
  const suggestion = (rooms: Obj[], changes: Obj = {}) => {
    const result = suggestEquipment(inspection(rooms, changes));
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  it('W56 air movers and dehumidifier capacity for each room and in total', () => {
    // Living room: floor 300 x ceiling 8 = 2,400 cu ft, class 2 (factor 50): 48 pints/day. Wet floor 200:
    // air movers 1 + 200/70 -> 1 + 3 = 4 to 1 + 200/50 = 1 + 4 = 5.
    // Study: 100 x 10 = 1,000 cu ft, class 3 (factor 40): 25 pints/day. Wet floor 100: 1 + 2 = 3 to 1 + 2 = 3.
    // Totals: air movers 7 to 8; 48 + 25 = 73 pints/day; at 70 pints/day per unit, 2 dehumidifiers.
    const result = suggestion(
      [
        room('Living room', { floor_sf: 300, ceiling_height_ft: 8, water_class: 2, wet_floor_sf: 200 }),
        room('Study', { floor_sf: 100, ceiling_height_ft: 10, water_class: 3, wet_floor_sf: 100 }),
      ],
      { dehumidifier_ppd: 70 },
    );
    expect(result.rooms).toEqual([
      { room: 'Living room', status: 'ready', needs: [], cubic_feet: '2400', pints_per_day: '48', air_movers: { min: 4, max: 5 } },
      { room: 'Study', status: 'ready', needs: [], cubic_feet: '1000', pints_per_day: '25', air_movers: { min: 3, max: 3 } },
    ]);
    expect(result).toMatchObject({ air_movers: { min: 7, max: 8 }, pints_per_day: 73, dehumidifiers: 2, complete: true });
  });

  it('W57 a room missing an input says what it needs; a mold room is not part of the drying check', () => {
    // Closet has no ceiling height or class: it needs both, and the totals cover only the ready room
    // (Hall: 100 x 8 = 800 cu ft, class 1, factor 100: 8 pints/day; no wet floor stated, so the whole
    // 100 sq ft is wet: 1 + 2 = 3 to 1 + 2 = 3). Without a unit rating there is no unit count.
    const result = suggestion([
      room('Hall', { floor_sf: 100, ceiling_height_ft: 8, water_class: 1 }),
      room('Closet', { floor_sf: 20 }),
      room('Attic', { category: 'mold' }),
    ]);
    expect(result.rooms.map((row) => [row.room, row.status, row.needs])).toEqual([
      ['Hall', 'ready', []],
      ['Closet', 'needs', ['ceiling height', 'water class']],
      ['Attic', 'mold', []],
    ]);
    expect(result).toMatchObject({ air_movers: { min: 3, max: 3 }, pints_per_day: 8, dehumidifiers: null, complete: false });
  });

  it('an invalid draft is refused, not guessed at', () => {
    expect(suggestEquipment({ rooms: [{ name: '', category: 1 }] }).ok).toBe(false);
  });
});

describe('room inputs in the table schema', () => {
  const parse = (items: Obj[], changes: Obj = {}) => PriceTableV3.safeParse(table(items, changes));
  const refused = (items: Obj[], changes: Obj = {}) => !parse(items, changes).success;

  it('accepts a per-room item, parses it to a stable form, and hashes it the same in any key order', () => {
    const written = table([CONTENTS], { ...TIERS, ...ROOM_TYPES });
    const parsed = parseTable(written);
    expect(parsed.items[0]).toMatchObject({ unit: 'room', unit_price: '', tier_prices: { s: '50.00', xl: '160.00' } });
    expect(parseTable(parsed)).toEqual(parsed);
    const reordered = { policy: written.policy, items: written.items };
    expect(contentHash(parseTable(reordered))).toBe(contentHash(parsed));
  });

  it('a per-room item needs unit room, source room:each and four tier prices that never fall', () => {
    expect(refused([CONTENTS], TIERS)).toBe(false);
    expect(refused([perRoom('contents', ['50.00', '40.00', '110.00', '160.00'])], TIERS)).toBe(true);
    expect(refused([perRoom('contents', ['50.00', '', '110.00', '160.00'])], TIERS)).toBe(false);
    expect(refused([perRoom('contents', ['50.00', '50.00', '50.00', '50.00'])], TIERS)).toBe(false);
    expect(refused([item('contents', { unit: 'room' })], TIERS)).toBe(true);
    expect(refused([item('contents', { quantity_source: 'room:each' })], TIERS)).toBe(true);
    expect(refused([item('demo', { tier_prices: { s: '1', m: '2', l: '3', xl: '4' } })], TIERS)).toBe(true);
    expect(refused([{ ...CONTENTS, unit_price: '5.00' }], TIERS)).toBe(true);
    expect(refused([{ ...CONTENTS, tier_prices: { s: '1', m: '2', l: '3' } }], TIERS)).toBe(true);
    expect(refused([{ ...CONTENTS, tier_prices: { s: '1', m: '2', l: '3', xl: 4 } }], TIERS)).toBe(true);
    expect(refused([{ ...CONTENTS, price_brackets: [{ up_to_sf: null, unit_price: '1' }] }], TIERS)).toBe(true);
  });

  it('a row holds the same kind of price as its item: tier prices on a per-room item, a unit price or brackets otherwise', () => {
    const tiers = { s: '1.00', m: '2.00', l: '3.00', xl: '4.00' };
    expect(refused([perRoom('contents', ['50.00', '75.00', '110.00', '160.00'], { rows: [{ category: 3, tier_prices: tiers }] })], TIERS)).toBe(false);
    expect(refused([perRoom('contents', ['50.00', '75.00', '110.00', '160.00'], { rows: [{ category: 3, unit_price: '1.00' }] })], TIERS)).toBe(true);
    expect(refused([item('demo', { rows: [{ category: 3, tier_prices: tiers }] })])).toBe(true);
    expect(refused([perRoom('contents', ['50.00', '75.00', '110.00', '160.00'], { rows: [{ category: 3, tier_prices: { ...tiers, m: '0.50' } }] })], TIERS)).toBe(true);
  });

  it('size limits rise and are blank until the owner sets them; a per-room item cannot publish with a blank limit', () => {
    const limits = (s: number | null, m: number | null, l: number | null) => ({
      size_tiers: { s_up_to_sf: s, m_up_to_sf: m, l_up_to_sf: l },
    });
    expect(refused([CONTENTS], limits(100, 100, 400))).toBe(true);
    expect(refused([CONTENTS], limits(100, 200, 150))).toBe(true);
    expect(refused([CONTENTS], limits(0, 200, 300))).toBe(true);
    expect(refused([CONTENTS], limits(null, 200, 300))).toBe(false);
    expect(parseTable(table([item('demo')])).policy.size_tiers).toEqual({
      s_up_to_sf: null,
      m_up_to_sf: null,
      l_up_to_sf: null,
    });
    expect(checkTable(table([CONTENTS], limits(100, 200, 400))).ok).toBe(true);
    expect(checkTable(table([CONTENTS], limits(100, 200, null)))).toMatchObject({ ok: false });
    expect(checkTable(table([CONTENTS]))).toMatchObject({ ok: false });
    expect(checkTable(table([{ ...CONTENTS, enabled: false }, item('demo')])).ok).toBe(true);
    expect(priceEstimate(table([CONTENTS]), job([floor('A', 50)]))).toMatchObject({ ok: false, stage: 'table' });
  });

  it('a blank or zero tier price blocks publishing like any price', () => {
    expect(checkTable(table([perRoom('contents', ['', '', '', ''])], TIERS)).ok).toBe(false);
    const zero = perRoom('contents', ['0', '1', '2', '3'], { allow_zero: true });
    expect(PriceTableV3.safeParse(table([{ ...zero, allow_zero: false }], TIERS)).success).toBe(false);
    expect(checkTable(table([zero], TIERS)).ok).toBe(false);
    expect(checkTable(table([zero], TIERS), ['contents']).ok).toBe(true);
  });

  it('mold conditions and affected-area bands need a mold-only item and may not repeat', () => {
    const mold = { categories: ['mold'] };
    expect(refused([item('aa', { ...mold, mold_conditions: [2, 3] })])).toBe(false);
    expect(refused([item('aa', { ...mold, affected_bands: ['up_to_10', 'over_100'] })])).toBe(false);
    expect(refused([item('aa', { mold_conditions: [3] })])).toBe(true);
    expect(refused([item('aa', { categories: [1, 'mold'], mold_conditions: [3] })])).toBe(true);
    expect(refused([item('aa', { ...mold, mold_conditions: [4] })])).toBe(true);
    expect(refused([item('aa', { ...mold, mold_conditions: [3, 3] })])).toBe(true);
    expect(refused([item('aa', { ...mold, affected_bands: ['up_to_50'] })])).toBe(true);
    expect(refused([item('aa', { ...mold, affected_bands: ['up_to_10', 'up_to_10'] })])).toBe(true);
    // An empty filter is the same table as no filter.
    expect(contentHash(parseTable(table([item('aa', { mold_conditions: [] })])))).toBe(
      contentHash(parseTable(table([item('aa')]))),
    );
  });

  it('room-type rows name a known type or Other, once, and need a category or a room type', () => {
    const row = (changes: Obj) => [item('demo', { rows: [{ unit_price: '1.00', ...changes }] })];
    expect(refused(row({ room_type: 'kitchen' }), ROOM_TYPES)).toBe(false);
    expect(refused(row({ room_type: 'other' }), ROOM_TYPES)).toBe(false);
    expect(refused(row({ room_type: 'garage' }), ROOM_TYPES)).toBe(true);
    expect(refused(row({ room_type: 'Kitchen' }), ROOM_TYPES)).toBe(true);
    expect(refused(row({}), ROOM_TYPES)).toBe(true);
    expect(refused(row({ room_type: 'kitchen', category: 3 }), ROOM_TYPES)).toBe(false);
    expect(refused(row({ room_type: 'kitchen', category: 5 }), ROOM_TYPES)).toBe(true);
    // A room-type row is stored even while the setting is off, so turning it on again loses nothing.
    expect(refused(row({ room_type: 'kitchen' }), { ...ROOM_TYPES, room_type_pricing: false })).toBe(false);
    const twice = [
      item('demo', {
        rows: [
          { room_type: 'kitchen', category: 3, unit_price: '1' },
          { room_type: 'kitchen', category: 3, unit_price: '2' },
        ],
      }),
    ];
    expect(refused(twice, ROOM_TYPES)).toBe(true);
    // A row excluded by the item's category filter is refused, with or without a room type.
    expect(refused([item('demo', { categories: [1], rows: [{ room_type: 'kitchen', category: 3, unit_price: '1' }] })], ROOM_TYPES)).toBe(true);
    expect(refused([item('demo', { categories: [1], rows: [{ room_type: 'kitchen', unit_price: '1' }] })], ROOM_TYPES)).toBe(false);
  });

  it('stores rows in a fixed order: category rows, then each room type, so written order never changes the hash', () => {
    const rows: Obj[] = [
      { room_type: 'kitchen', category: 3, unit_price: '6' },
      { category: 'mold', unit_price: '4' },
      { room_type: 'bathroom', unit_price: '4' },
      { room_type: 'kitchen', unit_price: '3' },
      { category: 1, unit_price: '2' },
    ];
    const forward = parseTable(table([item('demo', { rows })], ROOM_TYPES));
    const backward = parseTable(table([item('demo', { rows: [...rows].reverse() })], ROOM_TYPES));
    expect(forward.items[0]?.rows?.map((entry) => `${entry.room_type ?? ''}|${entry.category ?? ''}`)).toEqual([
      '|1',
      '|mold',
      'bathroom|',
      'kitchen|',
      'kitchen|3',
    ]);
    expect(contentHash(backward)).toBe(contentHash(forward));
  });

  it('room types have unique ids and names, at most 30 with Other, and suggest only items the table has', () => {
    const types = (list: Obj[]) => ({ room_types: list });
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `type_${index}`, name: `Type ${index}` }));
    expect(refused([item('demo')], types([{ id: 'kitchen', name: 'Kitchen' }, { id: 'kitchen', name: 'Galley' }]))).toBe(true);
    expect(refused([item('demo')], types([{ id: 'kitchen', name: 'Kitchen' }, { id: 'galley', name: ' kitchen ' }]))).toBe(true);
    expect(refused([item('demo')], types([{ id: 'Kitchen', name: 'Kitchen' }]))).toBe(true);
    expect(refused([item('demo')], types([{ id: 'kitchen', name: '=Kitchen' }]))).toBe(true);
    expect(refused([item('demo')], types(many(29)))).toBe(false);
    expect(refused([item('demo')], types(many(30)))).toBe(true);
    expect(refused([item('demo')], types([...many(29), { id: 'other', name: 'Other' }]))).toBe(false);
    expect(refused([item('demo')], types([...many(29), { id: 'other', name: 'Other' }, { id: 'extra', name: 'Extra' }]))).toBe(true);
    expect(refused([item('demo')], types([{ id: 'kitchen', name: 'Kitchen', suggested_items: ['demo'] }]))).toBe(false);
    expect(refused([item('demo')], types([{ id: 'kitchen', name: 'Kitchen', suggested_items: ['nope'] }]))).toBe(true);
    expect(refused([item('demo')], types([{ id: 'kitchen', name: 'Kitchen', suggested_items: ['demo', 'demo'] }]))).toBe(true);
  });
});
