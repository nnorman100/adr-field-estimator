// Field map v1 (S5a-1): the mapper to the engine's inspection JSON, and the field rules kept in
// step with the Zod schema. The rules themselves are tested against the emulator in
// tests/emu/rules/field-map.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FieldMapError, type RoomDoc, toInspection } from '../../src/lib/field/inspection';
import { draftFieldSchema, photoFieldSchema, roomFieldSchema, SHOT_TAGS } from '../../src/lib/field/schema';
import { item, lineTotals, priced, table } from './estimate-fixtures';

const RULES = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
const CODE = RULES.split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

/** The key list a rules function allows with `f.keys().hasOnly([...])`. */
function ruleKeys(fn: string): string[] {
  const body = CODE.slice(CODE.indexOf(`function ${fn}(`));
  const list = /f\.keys\(\)\.hasOnly\(\[([^\]]*)\]\)/.exec(body)?.[1];
  if (list === undefined) throw new Error(`no key list in ${fn}`);
  return [...list.matchAll(/'([^']+)'/g)].map((match) => match[1] as string).sort();
}

describe('field rules and the Zod schema', () => {
  it('allow the same keys in each document', () => {
    expect(ruleKeys('validDraftField')).toEqual(Object.keys(draftFieldSchema.shape).sort());
    expect(ruleKeys('validRoomField')).toEqual(Object.keys(roomFieldSchema.shape).sort());
    expect(ruleKeys('validPhotoField')).toEqual(Object.keys(photoFieldSchema.shape).sort());
  });

  it('allow the same shot tags', () => {
    const list = /f\.shotTag in \[([^\]]*)\]/.exec(CODE)?.[1] ?? '';
    expect([...list.matchAll(/'([^']+)'/g)].map((match) => match[1])).toEqual([...SHOT_TAGS]);
  });
});

// A worked example. The table prices unfinished-area demolition at $2.00 per sq ft (with the
// room's waste), a service call at $150.00 each and labour at $50.00 an hour; every multiplier is
// 1, with no minimum, overhead or tax.
const TABLE = table([
  item('demo'),
  item('service_call', {
    group: 'job_charges',
    unit: 'each',
    quantity_source: 'field:emergency_calls',
    unit_price: '150.00',
  }),
  item('labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: '50.00' }),
]);

const DRAFT = {
  yearBuilt: 1990,
  roomOrder: ['room-hall', 'room-kitchen'],
  notes: 'Supply line under the sink.',
  summary: 'Category 1 water in the hall and kitchen.',
  scopeConfirmed: true,
  emergencyCalls: 1,
  laborHours: 2,
};
const ROOMS: RoomDoc[] = [
  { id: 'room-kitchen', field: { name: 'Kitchen', category: 1, unfinishedSf: 120 } },
  { id: 'room-hall', field: { name: 'Hall', category: 1, unfinishedSf: 50, wastePercent: 10 } },
];

describe('toInspection', () => {
  it("maps a draft to the engine's inspection JSON, rooms in the draft's order", () => {
    expect(toInspection(DRAFT, ROOMS)).toEqual({
      year_built: 1990,
      technician_notes: 'Supply line under the sink.',
      scope_confirmed: true,
      emergency_calls: 1,
      labor_hours: 2,
      rooms: [
        { name: 'Hall', category: 1, loss: 'water', unfinished_sf: 50, waste_percent: 10 },
        { name: 'Kitchen', category: 1, loss: 'water', unfinished_sf: 120 },
      ],
    });
  });

  it('prices the worked example', () => {
    // Hall: 50 sq ft x $2.00 x 1.10 waste = $110.00. Kitchen: 120 x $2.00 = $240.00.
    // Service call: 1 x $150.00. Labour: 2 hours x $50.00 = $100.00. Total $600.00.
    const result = priced(TABLE, { inspection: toInspection(DRAFT, ROOMS) });
    expect(lineTotals(result).sort()).toEqual(
      ['Hall: demo = 110.00', 'Kitchen: demo = 240.00', 'labor = 100.00', 'service call = 150.00'].sort(),
    );
    expect(result.lines.filter((line) => line.room).map((line) => line.room)).toEqual(['Hall', 'Kitchen']);
    expect(result.totals.low.total).toBe('600.00');
  });

  it('leaves out what the technician has not set, so the engine applies its defaults', () => {
    expect(toInspection({}, [])).toEqual({ rooms: [] });
    expect(toInspection(undefined, [])).toEqual({ rooms: [] });
  });

  it('refuses a room order that does not list the room documents exactly', () => {
    const refuse = (draft: unknown, rooms: RoomDoc[]) =>
      expect(() => toInspection(draft, rooms)).toThrow(FieldMapError);
    refuse({ ...DRAFT, roomOrder: ['room-hall'] }, ROOMS);
    refuse({ ...DRAFT, roomOrder: ['room-hall', 'room-kitchen', 'room-gone'] }, ROOMS);
    refuse({ ...DRAFT, roomOrder: ['room-hall', 'room-gone'] }, ROOMS);
    refuse(DRAFT, [...ROOMS, { id: 'room-hall', field: { name: 'Hall again' } }]);
    refuse({ ...DRAFT, roomOrder: undefined }, ROOMS);
  });

  it('refuses an unnamed room and a map the schema refuses', () => {
    expect(() => toInspection({ roomOrder: ['r'] }, [{ id: 'r', field: { category: 2 } }])).toThrow('no name');
    expect(() => toInspection({ ...DRAFT, price: 1 }, ROOMS)).toThrow(FieldMapError);
    expect(() => toInspection(DRAFT, [ROOMS[0]!, { id: 'room-hall', field: { name: 'Hall', category: 4 } }])).toThrow(
      FieldMapError,
    );
  });
});
