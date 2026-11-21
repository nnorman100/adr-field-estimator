// The saved draft the engine prices (InspectionData). Square feet, hours and quantities are Decs;
// a field may arrive as a JSON number or a Decimal string. Unknown keys are refused.

import { z } from 'zod';

import { Dec, ZERO } from './decimal';
import { chars, collapse, enteredText, oneLine, printable, type Category, type MoldCondition, type SizeTier } from './values';

export class Reject extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Reject';
  }
}

function bad(message = 'invalid'): never {
  throw new Reject(message);
}

export type Room = {
  name: string;
  category: Category;
  loss: 'water' | 'mold' | 'both' | null;
  unfinishedSf: Dec;
  finishedSf: Dec;
  customCabinetry: boolean;
  wastePercent: Dec;
  floorSf: Dec | null;
  wetFloorSf: Dec | null;
  ceilingHeightFt: Dec | null;
  waterClass: number | null;
  /** The owner's room type id; null means Other. */
  roomTypeId: string | null;
  /** The size tier the technician confirmed; null means derive it from the room's areas. */
  sizeTier: SizeTier | null;
  moldCondition: MoldCondition | null;
  affectedSf: Dec | null;
  /** Quantities typed for this room, one per item, read by the item's `room:typed` source. */
  items: RoomItem[];
};

/** A quantity of one price-list item typed for one room. */
export type RoomItem = { itemId: string; quantity: Dec };

/** The most items one room can list. */
export const MAX_ROOM_ITEMS = 50;

export type Approval = { acceptedByName: string; acceptedAt: string; rate: Dec; total: Dec };

export type Extra = { id: string; description: string; hours: Dec; approval: Approval | null };

/**
 * An owner-approved custom multiplier on one priced line (S5b-8, owner decision B1): the item's lines in
 * one room (by the room's name), or its job-wide lines when `room` is null. A surcharge only.
 */
export type LineMultiplier = { itemId: string; room: string | null; multiplier: Dec };

/**
 * A one-off addition (S5b-8, B2): a quantity of a unit at a price, or a flat amount. Priced only once the
 * owner approved it (`approvedAt`); until then it prices nothing and counts as pending work, as an
 * unapproved hourly addition does.
 */
export type Addition = {
  id: string;
  kind: 'unit' | 'flat';
  description: string;
  quantity: Dec | null;
  unit: string | null;
  price: Dec;
  taxable: boolean;
  approvedAt: string | null;
};

export type ScopeEntry = { quantity: Dec; count: number; days: number };

export type QuantityOverride = { measured: Dec; entered: Dec; reason: string | null };

export type Inspection = {
  address: string;
  yearBuilt: number | null;
  rooms: Room[];
  airMovers: number;
  dehumidifiers: number;
  dehumidifierPpd: number | null;
  dryingDays: number;
  laborHours: Dec;
  isAfterHours: boolean;
  emergencyCalls: number;
  monitoringHours: Dec;
  haulLoads: number;
  airScrubbers: number;
  hepaFilters: number;
  matterportScans: number;
  dumpTruckLoads: number;
  equipmentDecon: number;
  powerDistribution: number;
  woodFloorSystems: number;
  woodFloorDays: number;
  packagePrice: string | null;
  technicianNotes: string;
  technicianTranscript: string;
  scopeConfirmed: boolean;
  extras: Extra[];
  /** Approved custom multipliers (S5b-8); none when absent. */
  lineMultipliers?: LineMultiplier[];
  /** Approved unit and flat additions (S5b-8); none when absent. */
  additions?: Addition[];
  scopeItems: Record<string, ScopeEntry> | null;
  quantityOverrides: Record<string, QuantityOverride> | null;
};

const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** A JSON number or a Decimal string, as an exact Dec between `min` and `max`. */
function amount(min: string, max: string, options: { above?: boolean; places?: number } = {}) {
  const low = Dec.parse(min);
  const high = Dec.parse(max);
  return z.union([z.number(), z.string()]).transform((raw, ctx) => {
    const text = typeof raw === 'number' ? (Number.isFinite(raw) ? String(raw) : '') : raw.trim();
    if (typeof raw === 'string' ? !PLAIN_DECIMAL.test(text) : text === '') {
      ctx.addIssue({ code: 'custom', message: 'must be a number' });
      return z.NEVER;
    }
    const value = Dec.parse(text);
    const places = value.normalize().exp < 0 ? -value.normalize().exp : 0;
    const under = options.above ? value.cmp(low) <= 0 : value.cmp(low) < 0;
    if (under || value.cmp(high) > 0 || places > (options.places ?? 28)) {
      ctx.addIssue({ code: 'custom', message: `must be from ${min} to ${max}` });
      return z.NEVER;
    }
    return value;
  });
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);

function text(min: number, max: number) {
  return z.string().refine((value) => chars(value) >= min && chars(value) <= max, {
    message: `must be ${min} to ${max} characters`,
  });
}

const HEX_ID = /^[a-f0-9]{32}$/;
const ISO_TIME = z.iso.datetime({ offset: true });

/** A null-prototype copy, so a key such as "constructor" never reads an inherited value. */
function plainMap<T>(record: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(record)) out[key] = value;
  return out;
}

const reason = text(3, 300)
  .transform((value) => oneLine(value))
  .refine((value) => chars(value) >= 3 && printable(value), { message: 'reason' });

const quantity = amount('0', '100000', { places: 2 });

const ITEM_ID = /^[a-z][a-z0-9_]{1,39}$/;

/** A room's typed quantities: one entry per item, at most MAX_ROOM_ITEMS. */
const ROOM_ITEMS = z
  .array(z.strictObject({ item_id: z.string().regex(ITEM_ID), quantity }))
  .max(MAX_ROOM_ITEMS)
  .refine((entries) => new Set(entries.map((entry) => entry.item_id)).size === entries.length, {
    message: 'an item is listed twice',
  })
  .transform((entries): RoomItem[] => entries.map((entry) => ({ itemId: entry.item_id, quantity: entry.quantity })));

const ROOM = z
  .strictObject({
    name: text(1, 100),
    category: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal('mold')]).default(1),
    loss: z.enum(['water', 'mold', 'both']).nullish(),
    unfinished_sf: amount('0', '100000').default(ZERO),
    finished_sf: amount('0', '100000').default(ZERO),
    custom_cabinetry: z.boolean().default(false),
    waste_percent: amount('0', '100').default(ZERO),
    floor_sf: amount('0', '100000', { above: true }).nullish(),
    wet_floor_sf: amount('0', '100000').nullish(),
    ceiling_height_ft: amount('0', '60', { above: true }).nullish(),
    water_class: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullish(),
    room_type_id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,29}$/)
      .nullish(),
    size_tier: z.enum(['s', 'm', 'l', 'xl']).nullish(),
    mold_condition: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullish(),
    affected_sf: amount('0', '100000').nullish(),
    source_of_loss: z.boolean().nullish(),
    contents_present: z.boolean().nullish(),
    equipment_placed: z.boolean().nullish(),
    affected_surfaces: int(0, 50).nullish(),
    wet_materials: int(0, 50).nullish(),
    items: ROOM_ITEMS.default([]),
  })
  .transform(
    (room): Room => ({
      name: room.name,
      category: room.category,
      loss: room.loss ?? null,
      unfinishedSf: room.unfinished_sf,
      finishedSf: room.finished_sf,
      customCabinetry: room.custom_cabinetry,
      wastePercent: room.waste_percent,
      floorSf: room.floor_sf ?? null,
      wetFloorSf: room.wet_floor_sf ?? null,
      ceilingHeightFt: room.ceiling_height_ft ?? null,
      waterClass: room.water_class ?? null,
      roomTypeId: room.room_type_id ?? null,
      sizeTier: room.size_tier ?? null,
      moldCondition: room.mold_condition ?? null,
      affectedSf: room.affected_sf ?? null,
      items: room.items,
    }),
  );

const SCOPE = z
  .strictObject({
    quantity: quantity.default(ZERO),
    count: int(0, 100).default(0),
    days: int(0, 60).default(0),
    measured_quantity: quantity.nullish(),
    override_reason: reason.nullish(),
  })
  .superRefine((entry, ctx) => {
    const measured = entry.measured_quantity ?? null;
    const why = entry.override_reason ?? null;
    if ((measured !== null && !measured.eq(entry.quantity) && !why) || (why !== null && measured === null)) {
      ctx.addIssue({ code: 'custom', message: 'a changed quantity needs its measured value and a reason' });
    }
  })
  .transform((entry): ScopeEntry => ({ quantity: entry.quantity, count: entry.count, days: entry.days }));

const OVERRIDE = z
  .strictObject({ measured: quantity, entered: quantity, reason: reason.nullish() })
  .superRefine((entry, ctx) => {
    if (!entry.reason && !entry.entered.eq(entry.measured)) {
      ctx.addIssue({ code: 'custom', message: 'a changed value needs a reason' });
    }
  })
  .transform((entry): QuantityOverride => ({ ...entry, reason: entry.reason ?? null }));

const APPROVAL = z
  .strictObject({
    accepted_by_uid: text(1, 128),
    accepted_by_name: text(1, 150),
    accepted_at: ISO_TIME,
    rate: amount('0', '10000', { above: true, places: 2 }),
    total: amount('0', '2000000', { places: 2 }),
    company_id: z.string(),
    company_version: z.number().int().min(1),
    price_version_id: z.string().optional(),
    price_content_sha256: z.string().optional(),
  })
  .transform(
    (approval): Approval => ({
      acceptedByName: approval.accepted_by_name,
      acceptedAt: approval.accepted_at,
      rate: approval.rate,
      total: approval.total,
    }),
  );

const EXTRA = z
  .strictObject({
    id: z.string().regex(HEX_ID),
    description: text(1, 300)
      .transform((value) => oneLine(value))
      .refine((value) => value !== '' && printable(value), { message: 'description' }),
    hours: amount('0.25', '200', { places: 2 }),
    origin: z.literal('manual').optional(),
    unpriced_item: text(0, 1000).optional(),
    approval: APPROVAL.nullish(),
  })
  .transform(
    (extra): Extra => ({
      id: extra.id,
      description: extra.description,
      hours: extra.hours,
      approval: extra.approval ?? null,
    }),
  );

/** The key one multiplier holds: an item in one room (by the room's name as the matcher reads it), or the item job-wide. */
export function multiplierKey(itemId: string, room: string | null): string {
  return `${itemId}\u0000${room === null ? '' : `r${collapse(room)}`}`;
}

/** The most approved custom multipliers one inspection takes. */
export const MAX_LINE_MULTIPLIERS = 3000;

const LINE_MULTIPLIER = z
  .strictObject({
    item_id: z.string().regex(ITEM_ID),
    room: text(1, 120).nullable(),
    multiplier: amount('1', '3', { above: true, places: 2 }),
  })
  .transform((entry): LineMultiplier => ({ itemId: entry.item_id, room: entry.room, multiplier: entry.multiplier }));

const ADDITION = z
  .strictObject({
    id: z.string().regex(HEX_ID),
    kind: z.enum(['unit', 'flat']),
    description: text(1, 300).refine((value) => enteredText(value) && printable(oneLine(value)), { message: 'description' }),
    quantity: amount('0', '100000', { above: true, places: 2 }).nullish(),
    unit: text(1, 20).refine(enteredText, { message: 'unit' }).nullish(),
    price: amount('0', '100000', { above: true, places: 2 }),
    taxable: z.boolean(),
    approved_at: ISO_TIME.nullable(),
  })
  .superRefine((entry, ctx) => {
    const unit = entry.kind === 'unit';
    if (unit !== (entry.quantity != null) || unit !== (entry.unit != null)) {
      ctx.addIssue({ code: 'custom', message: 'a unit addition has a quantity and a unit; a flat one has neither' });
    }
  })
  .transform(
    (entry): Addition => ({
      id: entry.id,
      kind: entry.kind,
      description: entry.description,
      quantity: entry.quantity ?? null,
      unit: entry.unit ?? null,
      price: entry.price,
      taxable: entry.taxable,
      approvedAt: entry.approved_at,
    }),
  );

const COORDINATES = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: text(1, 500),
});

const SEGMENT = z.strictObject({
  speaker: z.enum(['technician', 'assistant']),
  connection_id: text(0, 64),
  sequence: z.number().int().min(1),
  text: text(0, 80000),
  finished: z.boolean().nullish(),
});

const CAPTURE = z.strictObject({
  capture_id: z.string().regex(HEX_ID),
  status: z.enum(['recording', 'complete', 'incomplete', 'truncated']).optional(),
  gap_count: int(0, 1000000).optional(),
  recovery_count: int(0, 10000).optional(),
  technician_edited: z.boolean().optional(),
  segments: z.array(SEGMENT).max(2000).optional(),
});

const SCAN = z.strictObject({
  id: z.string().regex(HEX_ID),
  kind: z.enum(['air_mover', 'dehumidifier', 'air_scrubber']),
  asset_id: z.string().regex(/^[A-Z0-9][A-Z0-9._/-]{0,31}$/),
  room: text(1, 100),
  scanned_at: ISO_TIME,
});

/** A keyed map of at most `max` entries. Zod skips a "__proto__" key, so it is refused first. */
function capped<T extends z.ZodType>(value: T, max: number) {
  return z
    .custom<unknown>((raw) => !(raw !== null && typeof raw === 'object' && Object.hasOwn(raw, '__proto__')), {
      message: '"__proto__" is not a valid key',
    })
    .pipe(z.record(z.string(), value))
    .refine((record) => Object.keys(record).length <= max, { message: `at most ${max} entries` })
    .transform((record) => plainMap(record as Record<string, z.output<T>>));
}

const YEAR = z
  .number()
  .int()
  .min(1800)
  .refine((year) => year <= new Date().getFullYear(), { message: 'year built is in the future' });

const INSPECTION = z.strictObject({
  address: text(0, 500).default(''),
  coordinates: COORDINATES.nullish(),
  year_built: YEAR.nullish(),
  has_crawl_space: z.boolean().optional(),
  granite_removal: z.boolean().optional(),
  water_heater_loss: z.boolean().optional(),
  work_performed: z.boolean().optional(),
  rooms: z.array(ROOM).max(30).default([]),
  air_movers: int(0, 100).default(0),
  dehumidifiers: int(0, 100).default(0),
  dehumidifier_ppd: int(1, 1000).nullish(),
  drying_days: int(1, 60).default(3),
  labor_hours: amount('0', '500').default(ZERO),
  is_after_hours: z.boolean().default(false),
  emergency_calls: int(0, 100).default(1),
  monitoring_hours: amount('0', '500').default(Dec.parse('13.25')),
  haul_loads: int(0, 100).default(1),
  air_scrubbers: int(0, 100).default(1),
  hepa_filters: int(0, 100).default(1),
  matterport_scans: int(0, 100).default(0),
  dump_truck_loads: int(0, 100).default(0),
  equipment_decon: int(0, 100).default(0),
  power_distribution: int(0, 100).default(0),
  wood_floor_systems: int(0, 100).default(0),
  wood_floor_days: int(1, 60).default(7),
  package_price: text(0, 30).nullish(),
  technician_notes: text(0, 40000).default(''),
  technician_transcript: text(0, 80000).default(''),
  assistant_transcript: text(0, 80000).optional(),
  scope_confirmed: z.boolean().default(false),
  capture_metadata: CAPTURE.nullish(),
  extras: z.array(EXTRA).max(30).default([]),
  line_multipliers: z
    .array(LINE_MULTIPLIER)
    .max(MAX_LINE_MULTIPLIERS)
    .refine(
      (entries) => new Set(entries.map((entry) => multiplierKey(entry.itemId, entry.room))).size === entries.length,
      { message: 'one multiplier per line' },
    )
    .optional(),
  additions: z.array(ADDITION).max(30).optional(),
  equipment_scans: z.array(SCAN).max(200).optional(),
  scope_items: capped(SCOPE, 150)
    .refine((record) => Object.keys(record).every((key) => ITEM_ID.test(key)), {
      message: 'scope item ids',
    })
    .nullish(),
  seeded_from_version: text(0, 120).nullish(),
  quantity_overrides: capped(OVERRIDE, 150)
    .refine((record) => Object.keys(record).every((key) => chars(key) >= 1 && chars(key) <= 120), {
      message: 'override keys',
    })
    .nullish(),
});

export function validateInspection(value: unknown): Inspection {
  const result = INSPECTION.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    bad(`${issue?.path.join('.') ?? 'inspection'}: ${issue?.message ?? 'invalid'}`);
  }
  const raw = result.data;
  return {
    address: raw.address,
    yearBuilt: raw.year_built ?? null,
    rooms: raw.rooms,
    airMovers: raw.air_movers,
    dehumidifiers: raw.dehumidifiers,
    dehumidifierPpd: raw.dehumidifier_ppd ?? null,
    dryingDays: raw.drying_days,
    laborHours: raw.labor_hours,
    isAfterHours: raw.is_after_hours,
    emergencyCalls: raw.emergency_calls,
    monitoringHours: raw.monitoring_hours,
    haulLoads: raw.haul_loads,
    airScrubbers: raw.air_scrubbers,
    hepaFilters: raw.hepa_filters,
    matterportScans: raw.matterport_scans,
    dumpTruckLoads: raw.dump_truck_loads,
    equipmentDecon: raw.equipment_decon,
    powerDistribution: raw.power_distribution,
    woodFloorSystems: raw.wood_floor_systems,
    woodFloorDays: raw.wood_floor_days,
    packagePrice: raw.package_price ?? null,
    technicianNotes: raw.technician_notes,
    technicianTranscript: raw.technician_transcript,
    scopeConfirmed: raw.scope_confirmed,
    extras: raw.extras,
    ...(raw.line_multipliers?.length ? { lineMultipliers: raw.line_multipliers } : {}),
    ...(raw.additions?.length ? { additions: raw.additions } : {}),
    scopeItems: raw.scope_items ?? null,
    quantityOverrides: raw.quantity_overrides ?? null,
  };
}

/**
 * Each room item names an item of the price table that reads a room's typed quantity (`room:typed`).
 * The inspection schema cannot see the table, so the server checks the ids when it prices.
 */
export function checkRoomItems(data: Inspection, typedItems: ReadonlySet<string>): void {
  data.rooms.forEach((room, index) => {
    room.items.forEach((entry, at) => {
      if (!typedItems.has(entry.itemId)) {
        bad(`rooms.${index}.items.${at}.item_id: ${entry.itemId} is not an item priced by a room's typed quantity`);
      }
    });
  });
}

export function distinctRooms(data: Inspection): void {
  const seen = new Set<string>();
  for (const room of data.rooms) {
    const key = collapse(room.name);
    if (seen.has(key)) bad('duplicate room');
    seen.add(key);
  }
}

const JOB_INTS = {
  emergency_calls: 'emergencyCalls',
  haul_loads: 'haulLoads',
  air_scrubbers: 'airScrubbers',
  hepa_filters: 'hepaFilters',
  matterport_scans: 'matterportScans',
  dump_truck_loads: 'dumpTruckLoads',
  equipment_decon: 'equipmentDecon',
  power_distribution: 'powerDistribution',
  air_movers: 'airMovers',
  dehumidifiers: 'dehumidifiers',
  wood_floor_systems: 'woodFloorSystems',
  drying_days: 'dryingDays',
  wood_floor_days: 'woodFloorDays',
} as const satisfies Record<string, keyof Inspection>;

const ROOM_OVERRIDE = new Set(['unfinished_sf', 'finished_sf', 'floor_sf', 'wet_floor_sf']);

/** A job-level number as a Dec, or null for a field the inspection does not have. */
function jobNumber(data: Inspection, field: string): Dec | null {
  if (field === 'monitoring_hours') return data.monitoringHours;
  if (field === 'labor_hours') return data.laborHours;
  if (Object.hasOwn(JOB_INTS, field)) return Dec.fromInt(data[JOB_INTS[field as keyof typeof JOB_INTS]]);
  return null;
}

export function roomNumber(room: Room, field: string): Dec | null {
  if (field === 'unfinished_sf') return room.unfinishedSf;
  if (field === 'finished_sf') return room.finishedSf;
  if (field === 'floor_sf') return room.floorSf;
  if (field === 'wet_floor_sf') return room.wetFloorSf;
  return null;
}

/** Each override names a room field or a job field and still agrees with the saved value. */
export function checkOverrides(data: Inspection): void {
  for (const [key, override] of Object.entries(data.quantityOverrides ?? {})) {
    const cut = key.lastIndexOf(':');
    let current: Dec | null;
    if (cut >= 0) {
      const room = data.rooms.find((item) => item.name === key.slice(0, cut));
      const field = key.slice(cut + 1);
      if (!room || !ROOM_OVERRIDE.has(field)) bad(`override ${key}`);
      current = roomNumber(room, field);
    } else {
      current = Object.hasOwn(JOB_INTS, key) || key === 'monitoring_hours' || key === 'labor_hours' ? jobNumber(data, key) : bad(`override ${key}`);
    }
    if ((current ?? ZERO).sub(override.entered).abs().cmp(Dec.parse('0.01')) >= 0) bad(`stale ${key}`);
  }
}

export function fieldDec(data: Inspection, field: string): Dec {
  return jobNumber(data, field) ?? ZERO;
}
