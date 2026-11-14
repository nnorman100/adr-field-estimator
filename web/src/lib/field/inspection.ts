// Maps the field map (./schema.ts) to the engine's inspection JSON (`priceEstimate`'s
// `job.inspection`). A key the technician has not set is left out, so the engine applies its own
// default, as it did for the old app's drafts. A room's prep tasks and findings note are words for
// the documents, not inputs to a price: they stay in the submitted record (its snapshot), not here.
import type { z } from 'zod';
import type { Json } from '@/engine/estimate';
import { type DraftField, draftFieldSchema, type RoomField, roomFieldSchema } from './schema';

export class FieldMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldMapError';
  }
}

/** A room document as read from drafts/{d}/rooms/{id}: its id and its `field` map. */
export type RoomDoc = { id: string; field: unknown };

const DRAFT_KEYS: Array<[keyof DraftField, string]> = [
  ['yearBuilt', 'year_built'],
  ['notes', 'technician_notes'],
  ['scopeConfirmed', 'scope_confirmed'],
  ['airMovers', 'air_movers'],
  ['dehumidifiers', 'dehumidifiers'],
  ['airScrubbers', 'air_scrubbers'],
  ['dryingDays', 'drying_days'],
  ['woodFloorSystems', 'wood_floor_systems'],
  ['woodFloorDays', 'wood_floor_days'],
  ['emergencyCalls', 'emergency_calls'],
  ['monitoringHours', 'monitoring_hours'],
  ['haulLoads', 'haul_loads'],
  ['hepaFilters', 'hepa_filters'],
  ['matterportScans', 'matterport_scans'],
  ['dumpTruckLoads', 'dump_truck_loads'],
  ['equipmentDecon', 'equipment_decon'],
  ['powerDistribution', 'power_distribution'],
  ['laborHours', 'labor_hours'],
  ['isAfterHours', 'is_after_hours'],
];

const ROOM_KEYS: Array<[keyof RoomField, string]> = [
  ['name', 'name'],
  ['roomTypeId', 'room_type_id'],
  ['category', 'category'],
  ['waterClass', 'water_class'],
  ['ceilingHeightFt', 'ceiling_height_ft'],
  ['moldCondition', 'mold_condition'],
  ['affectedSf', 'affected_sf'],
  ['unfinishedSf', 'unfinished_sf'],
  ['finishedSf', 'finished_sf'],
  ['floorSf', 'floor_sf'],
  ['wetFloorSf', 'wet_floor_sf'],
  ['wastePercent', 'waste_percent'],
];

function copy<T extends object>(source: T, keys: Array<[keyof T, string]>): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const [from, to] of keys) {
    const value = source[from];
    if (value !== undefined) out[to] = value as Json;
  }
  return out;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new FieldMapError(`${label} does not match the field map`);
  return result.data;
}

/**
 * The engine's inspection JSON for one draft. The rooms come in the draft's `roomOrder`; every
 * room document must be listed there exactly once and must have a name.
 */
export function toInspection(draftField: unknown, rooms: RoomDoc[]): { [key: string]: Json } {
  const draft = parse(draftFieldSchema, draftField, 'the draft');
  const byId = new Map<string, RoomField>();
  for (const room of rooms) {
    if (byId.has(room.id)) throw new FieldMapError('a room document is given twice');
    byId.set(room.id, parse(roomFieldSchema, room.field, 'a room'));
  }
  const order = draft.roomOrder ?? [];
  if (order.length !== byId.size || order.some((id) => !byId.has(id))) {
    throw new FieldMapError('the room order does not list the room documents');
  }
  const inspection = copy(draft, DRAFT_KEYS);
  inspection.rooms = order.map((id) => {
    const room = byId.get(id) as RoomField;
    if (room.name === undefined) throw new FieldMapError('a room has no name');
    const out = copy(room, ROOM_KEYS);
    if (room.category !== undefined) out.loss = room.category === 'mold' ? 'mold' : 'water';
    // The engine takes a list, one entry per item; the map's ids in code-unit order, so the same
    // room always gives the same list.
    const items = Object.entries(room.items ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (items.length > 0) out.items = items.map(([itemId, quantity]) => ({ item_id: itemId, quantity }));
    return out;
  });
  return inspection;
}
