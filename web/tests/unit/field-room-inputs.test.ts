// Field map v2 room inputs (S5a-10): the schema's new room keys, the mapper to the engine's
// inspection JSON, the Submit check of room types and items against a price version, and the Check
// Scope room form with its lists. The same keys against the field rules are
// tests/emu/rules/field-map-rooms.test.ts.
import { describe, expect, it } from 'vitest';
import { suggestEquipment } from '../../src/engine/suggestions';
import { validateInspection } from '../../src/engine/inspection';
import { parseTable } from '../../src/engine/table';
import { formOf, roomChanges, roomTypeChoice, ROOM_FIELDS } from '../../src/lib/field/forms';
import { toInspection, type RoomDoc } from '../../src/lib/field/inspection';
import { roomFieldSchema } from '../../src/lib/field/schema';
import { namesPriceIds, priceIdsKnown } from '../../src/lib/scope-lists/version';
import { item, lineTotals, priced, table } from './estimate-fixtures';

/** A 4 ft flood cut typed per room in linear feet at $3.00 a foot, and carpet removal at $1.00 per sq ft. */
const TABLE = table(
  [
    item('flood_cut', { name: '4 ft flood cut', unit: 'lf', quantity_source: 'room:typed', unit_price: '3.00' }),
    item('carpet', { name: 'Carpet removal', quantity_source: 'room:typed', unit_price: '1.00' }),
    item('demo'),
  ],
  { room_types: [{ id: 'bathroom', name: 'Bathroom', suggested_items: ['flood_cut'] }] },
);

const FULL_ROOM = {
  name: 'Bathroom',
  roomTypeId: 'bathroom',
  category: 2,
  waterClass: 2,
  ceilingHeightFt: 8,
  floorSf: 60,
  wetFloorSf: 40,
  items: { flood_cut: '4', carpet: '12.5' },
  prepTasks: ['Move the vanity contents to the garage.', 'Cover the hallway floor.'],
  findings: 'Wet drywall to 30 inches behind the toilet.',
};

describe('field map v2 room keys', () => {
  it('reads a room with every new key, and a mold room', () => {
    expect(roomFieldSchema.safeParse(FULL_ROOM).success).toBe(true);
    expect(roomFieldSchema.safeParse({ name: 'Attic', category: 'mold', moldCondition: 3, affectedSf: 45 }).success).toBe(true);
    expect(roomFieldSchema.safeParse({ items: {}, prepTasks: [], findings: '' }).success).toBe(true);
  });

  it('refuses what the engine or the limits refuse', () => {
    const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`item_${i}`, '1']));
    expect(roomFieldSchema.safeParse({ items: fifty }).success).toBe(true);
    expect(roomFieldSchema.safeParse({ prepTasks: Array(10).fill('t'.repeat(300)) }).success).toBe(true);
    expect(roomFieldSchema.safeParse({ findings: 'f'.repeat(2_000) }).success).toBe(true);
    for (const field of [
      { category: 'Mold' },
      { category: 0 },
      { roomTypeId: 'Bathroom' },
      { roomTypeId: 'b' },
      { waterClass: 5 },
      { waterClass: 1.5 },
      { moldCondition: 4 },
      { ceilingHeightFt: 0 },
      { ceilingHeightFt: 61 },
      { affectedSf: -1 },
      { items: { ...fifty, item_50: '1' } },
      { items: { 'Flood-cut': '1' } },
      { items: { __proto__x: '1' } },
      { items: { flood_cut: '1.005' } },
      { items: { flood_cut: '100001' } },
      { items: { flood_cut: '100000.5' } },
      { items: { flood_cut: '-1' } },
      { items: { flood_cut: '1,2' } },
      { items: { flood_cut: '' } },
      { items: { flood_cut: '1e3' } },
      { items: { flood_cut: 4 } },
      { items: [{ itemId: 'flood_cut', quantity: '4' }] },
      { prepTasks: Array(11).fill('t') },
      { prepTasks: ['t'.repeat(301)] },
      { prepTasks: [''] },
      { prepTasks: 'Cover the floor' },
      { findings: 'f'.repeat(2_001) },
    ]) {
      expect(roomFieldSchema.safeParse(field).success, JSON.stringify(field)).toBe(false);
    }
  });
});

describe('toInspection with room inputs', () => {
  it('maps the new keys to the engine, items as a list in id order, and leaves the words out', () => {
    const inspection = toInspection({ roomOrder: ['r1'] }, [{ id: 'r1', field: FULL_ROOM }]);
    expect(inspection.rooms).toEqual([
      {
        name: 'Bathroom',
        room_type_id: 'bathroom',
        category: 2,
        loss: 'water',
        water_class: 2,
        ceiling_height_ft: 8,
        floor_sf: 60,
        wet_floor_sf: 40,
        items: [
          { item_id: 'carpet', quantity: '12.5' },
          { item_id: 'flood_cut', quantity: '4' },
        ],
      },
    ]);
    // The engine's own strict schema reads it: prep tasks and findings are not engine inputs.
    expect(() => validateInspection({ address: '1 Example Street', ...inspection })).not.toThrow();
    const mold = toInspection({ roomOrder: ['m'] }, [{ id: 'm', field: { name: 'Attic', category: 'mold', moldCondition: 3, affectedSf: 45 } }]);
    expect(mold.rooms).toEqual([{ name: 'Attic', category: 'mold', loss: 'mold', mold_condition: 3, affected_sf: 45 }]);
  });

  it('prices two rooms with the same item at different quantities as two lines', () => {
    // Bathroom 4 LF x $3.00 = $12.00; Hallway 12.5 LF x $3.00 = $37.50; total $49.50.
    const rooms: RoomDoc[] = [
      { id: 'hall', field: { name: 'Hallway', category: 1, items: { flood_cut: '12.5' } } },
      { id: 'bath', field: { name: 'Bathroom', category: 1, roomTypeId: 'bathroom', items: { flood_cut: '4' } } },
    ];
    const inspection = toInspection({ roomOrder: ['bath', 'hall'], scopeConfirmed: true }, rooms);
    const result = priced(TABLE, { inspection: { address: '1 Example Street', ...inspection } });
    expect(lineTotals(result)).toEqual(['Bathroom: 4 ft flood cut = 12.00', 'Hallway: 4 ft flood cut = 37.50']);
    expect(result.totals.low.total).toBe('49.50');
  });

  it('gives the equipment suggestion what it needs from a water room', () => {
    const inspection = toInspection({ roomOrder: ['r1'] }, [{ id: 'r1', field: FULL_ROOM }]);
    const suggestion = suggestEquipment(inspection);
    expect(suggestion.ok && suggestion.rooms.map((room) => room.status)).toEqual(['ready']);
    const without = toInspection({ roomOrder: ['r1'] }, [{ id: 'r1', field: { ...FULL_ROOM, ceilingHeightFt: undefined } }]);
    const needs = suggestEquipment(without);
    expect(needs.ok && needs.rooms[0]?.needs).toEqual(['ceiling height']);
  });

  it('sizes a Category 3 (black water) room as water, not mold', () => {
    const black = { name: 'Basement', category: 3, waterClass: 2, floorSf: 100, ceilingHeightFt: 8 };
    const suggestion = suggestEquipment(toInspection({ roomOrder: ['b'] }, [{ id: 'b', field: black }]));
    expect(suggestion.ok && suggestion.rooms.map((room) => room.status)).toEqual(['ready']);
    expect(suggestion.ok && suggestion.air_movers).toEqual({ min: 3, max: 3 });
  });
});

describe('room types and items against a price version (Submit)', () => {
  const version = parseTable(TABLE);

  it('knows Other, the table’s room types and its typed items', () => {
    expect(priceIdsKnown([{ roomTypeId: 'bathroom', items: { flood_cut: '1', carpet: '2' } }, { roomTypeId: 'other' }, {}], version)).toBe(true);
  });

  it('refuses a room type or item the version does not have, and an item it does not price by typed quantity', () => {
    expect(priceIdsKnown([{ roomTypeId: 'kitchen' }], version)).toBe(false);
    expect(priceIdsKnown([{ items: { drywall: '1' } }], version)).toBe(false);
    expect(priceIdsKnown([{ items: { demo: '1' } }], version)).toBe(false);
  });

  it('needs no version for a draft that names no room type and no item', () => {
    expect(namesPriceIds([{ name: 'Hall', category: 2 }, { roomTypeId: 'other', items: {} }])).toBe(false);
    expect(priceIdsKnown([{ name: 'Hall' }], null)).toBe(true);
    expect(priceIdsKnown([{ items: { flood_cut: '1' } }], null)).toBe(false);
    expect(priceIdsKnown([{ roomTypeId: 'bathroom' }], null)).toBe(false);
  });
});

describe('the Check Scope room form', () => {
  const stored = { name: 'Bathroom', category: 2 as const, items: { flood_cut: '4' }, prepTasks: ['Cover the floor.'] };

  it('writes the picked type, mold and its inputs, and clears Other', () => {
    const values = { ...formOf(ROOM_FIELDS, stored), roomTypeId: 'bathroom', category: 'mold', moldCondition: '2', affectedSf: '12.5' };
    expect(roomChanges(values, stored)).toEqual({
      changes: { roomTypeId: 'bathroom', category: 'mold', moldCondition: 2, affectedSf: 12.5 },
      errors: {},
    });
    const typed = { ...stored, roomTypeId: 'bathroom' };
    expect(roomChanges({ ...formOf(ROOM_FIELDS, typed), roomTypeId: '' }, typed).changes).toEqual({ roomTypeId: null });
  });

  it('writes the items as a map of numbers, or deletes them when none is left', () => {
    const values = formOf(ROOM_FIELDS, stored);
    expect(roomChanges(values, stored, { items: { flood_cut: '6', carpet: '012.250' } }).changes).toEqual({ items: { flood_cut: '6', carpet: '12.25' } });
    expect(roomChanges(values, stored, { items: { flood_cut: '4' } }).changes).toEqual({});
    expect(roomChanges(values, stored, { items: {} }).changes).toEqual({ items: null });
  });

  it('refuses a missing or bad quantity and writes no items', () => {
    const values = formOf(ROOM_FIELDS, stored);
    const empty = roomChanges(values, stored, { items: { flood_cut: '4', carpet: '' } });
    expect(empty.changes).toEqual({});
    expect(empty.errors['items.carpet']).toBe('Enter a quantity, or remove the item.');
    const places = roomChanges(values, stored, { items: { flood_cut: '4.125' } });
    expect(places.changes).toEqual({});
    expect(places.errors['items.flood_cut']).toBeDefined();
  });

  it('keeps the prep tasks’ words as picked, trimmed, and refuses an eleventh', () => {
    const values = formOf(ROOM_FIELDS, stored);
    expect(roomChanges(values, stored, { prepTasks: ['Cover the floor.', '  Remove the baseboards.  '] }).changes).toEqual({
      prepTasks: ['Cover the floor.', 'Remove the baseboards.'],
    });
    expect(roomChanges(values, stored, { prepTasks: [] }).changes).toEqual({ prepTasks: null });
    expect(roomChanges(values, stored, { prepTasks: Array.from({ length: 11 }, (_, i) => `Task ${i}`) }).errors.prepTasks).toBeDefined();
  });

  it('ignores and keeps the inputs the category hides, so a hidden bad box never blocks a save', () => {
    const toMold = { ...formOf(ROOM_FIELDS, stored), ceilingHeightFt: '0', waterClass: '3', category: 'mold', moldCondition: '3' };
    expect(roomChanges(toMold, stored)).toEqual({ changes: { category: 'mold', moldCondition: 3 }, errors: {} });
    const mold = { name: 'Attic', category: 'mold' as const, affectedSf: 40 };
    const toWater = { ...formOf(ROOM_FIELDS, mold), affectedSf: 'x', moldCondition: '2', category: '3', ceilingHeightFt: '8' };
    expect(roomChanges(toWater, mold)).toEqual({ changes: { category: 3, ceilingHeightFt: 8 }, errors: {} });
    const shown = roomChanges({ ...formOf(ROOM_FIELDS, stored), ceilingHeightFt: '0' }, stored);
    expect(shown.changes).toEqual({});
    expect(shown.errors.ceilingHeightFt).toBeDefined();
  });

  const suggestion = (itemId: string, typed: boolean, categories: (1 | 2 | 3 | 'mold')[] = []) => ({ itemId, name: itemId, unit: 'sf', typed, categories });

  it('offers one Other, preselected with its own suggestions, and keeps a type the list no longer has', () => {
    const known = [
      { id: 'other', name: 'Other', suggestedItems: [suggestion('demo', false)] },
      { id: 'bathroom', name: 'Bathroom', suggestedItems: [suggestion('flood_cut', true)] },
    ];
    const absent = roomTypeChoice(known, '', '');
    expect(absent.value).toBe('');
    expect(absent.options).toEqual([
      { value: '', label: 'Other' },
      { value: 'bathroom', label: 'Bathroom' },
    ]);
    expect(absent.suggested.map((item) => item.itemId)).toEqual(['demo']);
    const stored = roomTypeChoice(known, 'other', '');
    expect(stored.value).toBe('');
    expect(stored.options.filter((option) => option.label === 'Other')).toHaveLength(1);
    expect(stored.suggested.map((item) => item.itemId)).toEqual(['demo']);
    expect(roomTypeChoice(known, 'bathroom', '').suggested.map((item) => item.itemId)).toEqual(['flood_cut']);
    const gone = roomTypeChoice(known, 'garage', '');
    expect(gone.options.at(-1)).toEqual({ value: 'garage', label: 'garage (not in this job’s price list)' });
    expect(gone.suggested).toEqual([]);
  });

  it('shows the picked type’s suggestions with no typed quantities, for the room’s category', () => {
    const extraction = suggestion('extraction', false, [1, 2, 3]);
    const moldClean = suggestion('mold_clean', false, ['mold']);
    const fan = suggestion('air_mover', false);
    const known = [{ id: 'bathroom', name: 'Bathroom', suggestedItems: [extraction, moldClean, fan] }];
    expect(roomTypeChoice(known, 'bathroom', '').suggested).toEqual([extraction, fan]);
    expect(roomTypeChoice(known, 'bathroom', '3').suggested).toEqual([extraction, fan]);
    expect(roomTypeChoice(known, 'bathroom', 'mold').suggested).toEqual([moldClean, fan]);
  });

  it('writes the findings note and clears an emptied one', () => {
    const noted = { ...stored, findings: 'Wet drywall.' };
    expect(roomChanges({ ...formOf(ROOM_FIELDS, noted), findings: 'Wet drywall to 30 in.' }, noted).changes).toEqual({ findings: 'Wet drywall to 30 in.' });
    expect(roomChanges({ ...formOf(ROOM_FIELDS, noted), findings: '' }, noted).changes).toEqual({ findings: null });
  });
});
