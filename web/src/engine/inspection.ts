// InspectionData validation and the inspection_payload dump. Types match pydantic's JSON dump.

import { Dec, ZERO } from './decimal';
import { JFloat, JInt, type JObj, type JVal, jfloat, jint, pyFloat } from './json';
import { collapse, decFloat, decInt, has, isObj, oneLine, orZero } from './values';

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
  category: number;
  loss: string | null;
  unfinishedSf: number;
  finishedSf: number;
  customCabinetry: boolean;
  wastePercent: number;
  floorSf: number | null;
  wetFloorSf: number | null;
  ceilingHeightFt: number | null;
  waterClass: number | null;
  sourceOfLoss: boolean | null;
  contentsPresent: boolean | null;
  equipmentPlaced: boolean | null;
  affectedSurfaces: number | null;
  wetMaterials: number | null;
};

export type Approval = {
  acceptedByUid: string;
  acceptedByName: string;
  acceptedAt: string;
  rate: Dec;
  total: Dec;
  companyId: string;
  companyVersion: number;
  priceVersionId: string;
  priceContentSha256: string;
};

export type Extra = {
  id: string;
  description: string;
  hours: Dec;
  origin: string;
  unpricedItem: string;
  approval: Approval | null;
};

export type ScopeEntry = {
  quantity: Dec;
  count: number;
  days: number;
  measured: Dec | null;
  reason: string | null;
};

export type QuantityOverride = {
  measured: Dec;
  entered: Dec;
  reason: string | null;
};

export type Inspection = {
  address: string;
  yearBuilt: number | null;
  hasCrawlSpace: boolean;
  graniteRemoval: boolean;
  waterHeaterLoss: boolean;
  workPerformed: boolean;
  rooms: Room[];
  airMovers: number;
  dehumidifiers: number;
  dehumidifierPpd: number | null;
  dryingDays: number;
  laborHours: number;
  isAfterHours: boolean;
  emergencyCalls: number;
  monitoringHours: number;
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
  assistantTranscript: string;
  scopeConfirmed: boolean;
  extras: Extra[];
  extrasSet: boolean;
  scopeItems: Record<string, ScopeEntry> | null;
  quantityOverrides: Record<string, QuantityOverride> | null;
  seededFromVersion: string | null;
  /** Keys present on this record. After the save dump, defaults count as set. */
  present: Set<string>;
};

const ROOM_KEYS = new Set([
  'name',
  'category',
  'loss',
  'unfinished_sf',
  'finished_sf',
  'custom_cabinetry',
  'waste_percent',
  'floor_sf',
  'wet_floor_sf',
  'ceiling_height_ft',
  'water_class',
  'source_of_loss',
  'contents_present',
  'equipment_placed',
  'affected_surfaces',
  'wet_materials',
]);

const DATA_KEYS = new Set([
  'address',
  'coordinates',
  'year_built',
  'has_crawl_space',
  'granite_removal',
  'water_heater_loss',
  'work_performed',
  'rooms',
  'air_movers',
  'dehumidifiers',
  'dehumidifier_ppd',
  'drying_days',
  'labor_hours',
  'is_after_hours',
  'emergency_calls',
  'monitoring_hours',
  'haul_loads',
  'air_scrubbers',
  'hepa_filters',
  'matterport_scans',
  'dump_truck_loads',
  'equipment_decon',
  'power_distribution',
  'wood_floor_systems',
  'wood_floor_days',
  'package_price',
  'technician_notes',
  'technician_transcript',
  'assistant_transcript',
  'scope_confirmed',
  'capture_metadata',
  'extras',
  'equipment_scans',
  'scope_items',
  'seeded_from_version',
  'quantity_overrides',
]);

const JOB_OVERRIDE = new Set([
  'emergency_calls',
  'monitoring_hours',
  'haul_loads',
  'air_scrubbers',
  'hepa_filters',
  'matterport_scans',
  'dump_truck_loads',
  'equipment_decon',
  'power_distribution',
  'labor_hours',
  'air_movers',
  'dehumidifiers',
  'wood_floor_systems',
  'drying_days',
  'wood_floor_days',
]);

const ROOM_OVERRIDE = new Set(['unfinished_sf', 'finished_sf', 'floor_sf', 'wet_floor_sf']);

function obj(value: JVal, label: string): JObj {
  if (!isObj(value)) bad(`${label} object`);
  return value;
}

function keysOf(value: JObj, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) bad(`${label} ${key}`);
  }
}

function readFloat(
  value: JVal | undefined,
  fallback: number,
  min: number,
  max: number,
  gt: boolean,
): number {
  if (value === undefined) return fallback;
  let n: number;
  if (value instanceof JInt) n = Object.is(value.value, -0) ? 0 : value.value;
  else if (value instanceof JFloat) n = value.value;
  else bad('float');
  if (gt) {
    if (!(n > min) || n > max) bad('float range');
  } else if (n < min || n > max) bad('float range');
  return n;
}

function readInt(value: JVal | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!(value instanceof JInt) || Object.is(value.value, -0)) {
    if (value instanceof JInt && Object.is(value.value, -0)) return 0;
    bad('int');
  }
  const n = value.value;
  if (n < min || n > max) bad('int range');
  return n;
}

function readBool(value: JVal | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') bad('bool');
  return value;
}

function readText(value: JVal | undefined, fallback: string, max: number): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max) bad('text');
  return value;
}

function printable(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

function readDec(
  value: JVal,
  min: Dec,
  max: Dec,
  places: number,
  gt: boolean,
): Dec {
  let text: string;
  if (typeof value === 'string') text = value.trim();
  else if (value instanceof JInt) text = Object.is(value.value, -0) ? '0' : String(value.value);
  else if (value instanceof JFloat) text = pyFloat(value.value);
  else bad('decimal');
  let amount: Dec;
  try {
    amount = Dec.parse(text);
  } catch {
    bad('decimal');
  }
  const scale = amount.exp < 0 ? -amount.exp : 0;
  if (scale > places) bad('decimal places');
  if (gt ? amount.cmp(min) <= 0 : amount.cmp(min) < 0) bad('decimal range');
  if (amount.cmp(max) > 0) bad('decimal range');
  return amount;
}

function optFloat(value: JVal | undefined, min: number, max: number, gt: boolean): number | null {
  if (value === undefined || value === null) return null;
  return readFloat(value, 0, min, max, gt);
}

function optInt(value: JVal | undefined, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  return readInt(value, 0, min, max);
}

function optBool(value: JVal | undefined): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') bad('bool');
  return value;
}

function readRoom(value: JVal): Room {
  const raw = obj(value, 'room');
  keysOf(raw, ROOM_KEYS, 'room');
  if (!has(raw, 'name') || typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 100) {
    bad('room name');
  }
  const loss = raw.loss;
  if (loss !== undefined && loss !== null && loss !== 'water' && loss !== 'mold' && loss !== 'both') {
    bad('loss');
  }
  const water = raw.water_class;
  if (
    water !== undefined &&
    water !== null &&
    (!(water instanceof JInt) || ![1, 2, 3, 4].includes(water.value))
  ) {
    bad('water class');
  }
  return {
    name: raw.name,
    category: readInt(raw.category, 1, 1, 3),
    loss: typeof loss === 'string' ? loss : null,
    unfinishedSf: readFloat(raw.unfinished_sf, 0, 0, 100000, false),
    finishedSf: readFloat(raw.finished_sf, 0, 0, 100000, false),
    customCabinetry: readBool(raw.custom_cabinetry, false),
    wastePercent: readFloat(raw.waste_percent, 0, 0, 100, false),
    floorSf: optFloat(raw.floor_sf, 0, 100000, true),
    wetFloorSf: optFloat(raw.wet_floor_sf, 0, 100000, false),
    ceilingHeightFt: optFloat(raw.ceiling_height_ft, 0, 60, true),
    waterClass: water instanceof JInt ? water.value : null,
    sourceOfLoss: optBool(raw.source_of_loss),
    contentsPresent: optBool(raw.contents_present),
    equipmentPlaced: optBool(raw.equipment_placed),
    affectedSurfaces: optInt(raw.affected_surfaces, 0, 50),
    wetMaterials: optInt(raw.wet_materials, 0, 50),
  };
}

function cleanReason(value: JVal | undefined | null, required: boolean): string | null {
  if (value === undefined || value === null) {
    if (required) bad('reason');
    return null;
  }
  if (typeof value !== 'string') bad('reason');
  const text = oneLine(value);
  if (text.length < 3 || text.length > 300 || !printable(text)) bad('reason');
  return text;
}

function readScope(value: JVal): ScopeEntry {
  const raw = obj(value, 'scope');
  const allowed = new Set(['quantity', 'count', 'days', 'measured_quantity', 'override_reason']);
  keysOf(raw, allowed, 'scope');
  const quantity = has(raw, 'quantity')
    ? readDec(raw.quantity as JVal, ZERO, Dec.parse('100000'), 2, false)
    : ZERO;
  const measured =
    raw.measured_quantity === undefined || raw.measured_quantity === null
      ? null
      : readDec(raw.measured_quantity, ZERO, Dec.parse('100000'), 2, false);
  const reason = cleanReason(raw.override_reason, false);
  if (measured !== null && measured.cmp(quantity) !== 0 && !reason) bad('scope reason');
  if (reason !== null && measured === null) bad('scope reason');
  return {
    quantity,
    count: readInt(raw.count, 0, 0, 100),
    days: readInt(raw.days, 0, 0, 60),
    measured,
    reason,
  };
}

function readOverride(value: JVal): QuantityOverride {
  const raw = obj(value, 'override');
  keysOf(raw, new Set(['measured', 'entered', 'reason']), 'override');
  if (!has(raw, 'measured') || !has(raw, 'entered')) bad('override');
  const measured = readDec(raw.measured as JVal, ZERO, Dec.parse('100000'), 2, false);
  const entered = readDec(raw.entered as JVal, ZERO, Dec.parse('100000'), 2, false);
  const reason = cleanReason(raw.reason, false);
  if (entered.cmp(measured) !== 0 && !reason) bad('override reason');
  return { measured, entered, reason };
}

function daysIn(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function validDate(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

function readInstant(value: JVal | undefined): string {
  if (typeof value !== 'string') bad('approval time');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) bad('approval time');
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  if (!validDate(Number(year), Number(month), Number(day))) bad('approval time');
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) bad('approval time');
  const micro = (fraction ?? '').padEnd(6, '0');
  let offset = '';
  if (zone !== undefined) {
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(4, 6));
    if (zone !== 'Z' && (hours > 23 || minutes > 59)) bad('approval time');
    offset = zone === 'Z' || (hours === 0 && minutes === 0) ? 'Z' : zone;
  }
  const time = `${hour}:${minute}:${second}${Number(micro) ? `.${micro}` : ''}`;
  return `${year}-${month}-${day}T${time}${offset}`;
}

function readApproval(value: JVal): Approval {
  const raw = obj(value, 'approval');
  const allowed = new Set([
    'accepted_by_uid',
    'accepted_by_name',
    'accepted_at',
    'rate',
    'total',
    'company_id',
    'company_version',
    'price_version_id',
    'price_content_sha256',
  ]);
  keysOf(raw, allowed, 'approval');
  for (const key of ['accepted_by_uid', 'accepted_by_name', 'accepted_at', 'company_id', 'rate', 'total', 'company_version']) {
    if (!has(raw, key)) bad('approval');
  }
  const uid = raw.accepted_by_uid;
  const name = raw.accepted_by_name;
  const at = readInstant(raw.accepted_at);
  const company = raw.company_id;
  if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128) bad('approval uid');
  if (typeof name !== 'string' || name.length < 1 || name.length > 150) bad('approval name');
  if (typeof company !== 'string') bad('approval company');
  const version = raw.price_version_id;
  const hash = raw.price_content_sha256;
  return {
    acceptedByUid: uid,
    acceptedByName: name,
    acceptedAt: at,
    rate: readDec(raw.rate as JVal, ZERO, Dec.parse('10000'), 2, true),
    total: readDec(raw.total as JVal, ZERO, Dec.parse('2000000'), 2, false),
    companyId: company,
    companyVersion: readInt(raw.company_version, 0, 1, 1_000_000_000),
    priceVersionId: typeof version === 'string' ? version : '',
    priceContentSha256: typeof hash === 'string' ? hash : '',
  };
}

function readExtra(value: JVal): Extra {
  const raw = obj(value, 'extra');
  keysOf(raw, new Set(['id', 'description', 'hours', 'origin', 'unpriced_item', 'approval']), 'extra');
  if (typeof raw.id !== 'string' || !/^[a-f0-9]{32}$/.test(raw.id)) bad('extra id');
  if (typeof raw.description !== 'string') bad('extra description');
  const description = oneLine(raw.description);
  if (!description || description.length > 300 || !printable(description)) bad('extra description');
  const origin = raw.origin === undefined ? 'manual' : raw.origin;
  if (origin !== 'manual') bad('extra origin');
  const unpriced = raw.unpriced_item === undefined ? '' : raw.unpriced_item;
  if (typeof unpriced !== 'string' || unpriced.length > 1000) bad('extra item');
  return {
    id: raw.id,
    description,
    hours: readDec(raw.hours as JVal, Dec.parse('0.25'), Dec.parse('200'), 2, false),
    origin: 'manual',
    unpricedItem: unpriced,
    approval: raw.approval === undefined || raw.approval === null ? null : readApproval(raw.approval),
  };
}

function readYear(value: JVal | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!(value instanceof JInt)) bad('year');
  const year = value.value;
  if (year < 1800 || year > new Date().getFullYear()) bad('year');
  return year;
}

export function validateInspection(value: JVal): Inspection {
  const raw = obj(value, 'inspection');
  keysOf(raw, DATA_KEYS, 'inspection');
  if (has(raw, 'coordinates') && raw.coordinates !== null) bad('coordinates');
  if (has(raw, 'capture_metadata') && raw.capture_metadata !== null) bad('capture');
  if (has(raw, 'equipment_scans') && !(Array.isArray(raw.equipment_scans) && raw.equipment_scans.length === 0)) {
    if (has(raw, 'equipment_scans')) bad('scans');
  }
  const roomsRaw = raw.rooms === undefined ? [] : raw.rooms;
  if (!Array.isArray(roomsRaw) || roomsRaw.length > 30) bad('rooms');
  const extrasRaw = raw.extras === undefined ? [] : raw.extras;
  if (!Array.isArray(extrasRaw) || extrasRaw.length > 30) bad('extras');
  let scope: Record<string, ScopeEntry> | null = null;
  if (has(raw, 'scope_items') && raw.scope_items !== null) {
    if (!isObj(raw.scope_items)) bad('scope');
    const entries = Object.entries(raw.scope_items);
    if (entries.length > 150) bad('scope');
    scope = {};
    for (const [key, entry] of entries) {
      if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) bad('scope id');
      scope[key] = readScope(entry as JVal);
    }
  }
  let overrides: Record<string, QuantityOverride> | null = null;
  if (has(raw, 'quantity_overrides') && raw.quantity_overrides !== null) {
    if (!isObj(raw.quantity_overrides)) bad('overrides');
    const entries = Object.entries(raw.quantity_overrides);
    if (entries.length > 150) bad('overrides');
    overrides = {};
    for (const [key, entry] of entries) {
      if (key.length < 1 || key.length > 120) bad('override key');
      overrides[key] = readOverride(entry as JVal);
    }
  }
  const seeded = raw.seeded_from_version;
  if (seeded !== undefined && seeded !== null && (typeof seeded !== 'string' || seeded.length > 120)) {
    bad('seed');
  }
  const packagePrice = raw.package_price;
  if (packagePrice !== undefined && packagePrice !== null && (typeof packagePrice !== 'string' || packagePrice.length > 30)) {
    bad('package');
  }
  return {
    address: readText(raw.address, '', 500),
    yearBuilt: readYear(raw.year_built),
    hasCrawlSpace: readBool(raw.has_crawl_space, false),
    graniteRemoval: readBool(raw.granite_removal, false),
    waterHeaterLoss: readBool(raw.water_heater_loss, false),
    workPerformed: readBool(raw.work_performed, false),
    rooms: roomsRaw.map((room) => readRoom(room)),
    airMovers: readInt(raw.air_movers, 0, 0, 100),
    dehumidifiers: readInt(raw.dehumidifiers, 0, 0, 100),
    dehumidifierPpd: optInt(raw.dehumidifier_ppd, 1, 1000),
    dryingDays: readInt(raw.drying_days, 3, 1, 60),
    laborHours: readFloat(raw.labor_hours, 0, 0, 500, false),
    isAfterHours: readBool(raw.is_after_hours, false),
    emergencyCalls: readInt(raw.emergency_calls, 1, 0, 100),
    monitoringHours: readFloat(raw.monitoring_hours, 13.25, 0, 500, false),
    haulLoads: readInt(raw.haul_loads, 1, 0, 100),
    airScrubbers: readInt(raw.air_scrubbers, 1, 0, 100),
    hepaFilters: readInt(raw.hepa_filters, 1, 0, 100),
    matterportScans: readInt(raw.matterport_scans, 0, 0, 100),
    dumpTruckLoads: readInt(raw.dump_truck_loads, 0, 0, 100),
    equipmentDecon: readInt(raw.equipment_decon, 0, 0, 100),
    powerDistribution: readInt(raw.power_distribution, 0, 0, 100),
    woodFloorSystems: readInt(raw.wood_floor_systems, 0, 0, 100),
    woodFloorDays: readInt(raw.wood_floor_days, 7, 1, 60),
    packagePrice: typeof packagePrice === 'string' ? packagePrice : null,
    technicianNotes: readText(raw.technician_notes, '', 40000),
    technicianTranscript: readText(raw.technician_transcript, '', 80000),
    assistantTranscript: readText(raw.assistant_transcript, '', 80000),
    scopeConfirmed: readBool(raw.scope_confirmed, false),
    extras: extrasRaw.map((extra) => readExtra(extra)),
    extrasSet: has(raw, 'extras'),
    scopeItems: scope,
    quantityOverrides: overrides,
    seededFromVersion: typeof seeded === 'string' ? seeded : null,
    present: new Set(Object.keys(raw)),
  };
}

function dumpRoom(room: Room): JObj {
  const out: JObj = {
    category: jint(room.category),
    custom_cabinetry: room.customCabinetry,
    finished_sf: jfloat(room.finishedSf),
    name: room.name,
    unfinished_sf: jfloat(room.unfinishedSf),
    waste_percent: jfloat(room.wastePercent),
  };
  if (room.loss !== null) out.loss = room.loss;
  if (room.floorSf !== null) out.floor_sf = jfloat(room.floorSf);
  if (room.wetFloorSf !== null) out.wet_floor_sf = jfloat(room.wetFloorSf);
  if (room.ceilingHeightFt !== null) out.ceiling_height_ft = jfloat(room.ceilingHeightFt);
  if (room.waterClass !== null) out.water_class = jint(room.waterClass);
  if (room.sourceOfLoss !== null) out.source_of_loss = room.sourceOfLoss;
  if (room.contentsPresent !== null) out.contents_present = room.contentsPresent;
  if (room.equipmentPlaced !== null) out.equipment_placed = room.equipmentPlaced;
  if (room.affectedSurfaces !== null) out.affected_surfaces = jint(room.affectedSurfaces);
  if (room.wetMaterials !== null) out.wet_materials = jint(room.wetMaterials);
  return out;
}

function dumpApproval(approval: Approval): JObj {
  return {
    accepted_at: approval.acceptedAt,
    accepted_by_name: approval.acceptedByName,
    accepted_by_uid: approval.acceptedByUid,
    company_id: approval.companyId,
    company_version: jint(approval.companyVersion),
    price_content_sha256: approval.priceContentSha256,
    price_version_id: approval.priceVersionId,
    rate: approval.rate.toString(),
    total: approval.total.toString(),
  };
}

export function dumpInspection(data: Inspection): JObj {
  const out: JObj = {
    address: data.address,
    air_movers: jint(data.airMovers),
    air_scrubbers: jint(data.airScrubbers),
    assistant_transcript: data.assistantTranscript,
    dehumidifiers: jint(data.dehumidifiers),
    drying_days: jint(data.dryingDays),
    dump_truck_loads: jint(data.dumpTruckLoads),
    emergency_calls: jint(data.emergencyCalls),
    equipment_decon: jint(data.equipmentDecon),
    granite_removal: data.graniteRemoval,
    has_crawl_space: data.hasCrawlSpace,
    haul_loads: jint(data.haulLoads),
    hepa_filters: jint(data.hepaFilters),
    is_after_hours: data.isAfterHours,
    labor_hours: jfloat(data.laborHours),
    matterport_scans: jint(data.matterportScans),
    monitoring_hours: jfloat(data.monitoringHours),
    package_price: data.packagePrice,
    power_distribution: jint(data.powerDistribution),
    rooms: data.rooms.map((room) => dumpRoom(room)),
    scope_confirmed: data.scopeConfirmed,
    technician_notes: data.technicianNotes,
    technician_transcript: data.technicianTranscript,
    water_heater_loss: data.waterHeaterLoss,
    wood_floor_days: jint(data.woodFloorDays),
    wood_floor_systems: jint(data.woodFloorSystems),
    work_performed: data.workPerformed,
    year_built: data.yearBuilt === null ? null : jint(data.yearBuilt),
  };
  if (data.present.has('coordinates')) out.coordinates = null;
  if (data.dehumidifierPpd !== null) out.dehumidifier_ppd = jint(data.dehumidifierPpd);
  if (data.extras.length > 0 || data.extrasSet) {
    out.extras = data.extras.map((extra) => ({
      approval: extra.approval ? dumpApproval(extra.approval) : null,
      description: extra.description,
      hours: extra.hours.toString(),
      id: extra.id,
      origin: extra.origin,
      unpriced_item: extra.unpricedItem,
    }));
  }
  if (data.scopeItems) {
    const items: JObj = {};
    for (const [key, entry] of Object.entries(data.scopeItems)) {
      const row: JObj = {
        count: jint(entry.count),
        days: jint(entry.days),
        quantity: entry.quantity.toString(),
      };
      if (entry.measured) row.measured_quantity = entry.measured.toString();
      if (entry.reason !== null) row.override_reason = entry.reason;
      items[key] = row;
    }
    out.scope_items = items;
  }
  if (data.seededFromVersion !== null) out.seeded_from_version = data.seededFromVersion;
  if (data.quantityOverrides) {
    const rows: JObj = {};
    for (const [key, entry] of Object.entries(data.quantityOverrides)) {
      const row: JObj = {
        entered: entry.entered.toString(),
        measured: entry.measured.toString(),
      };
      if (entry.reason !== null) row.reason = entry.reason;
      rows[key] = row;
    }
    out.quantity_overrides = rows;
  }
  return out;
}

export function distinctRooms(data: Inspection): void {
  const seen = new Set<string>();
  for (const room of data.rooms) {
    const key = collapse(room.name);
    if (seen.has(key)) bad('duplicate room');
    seen.add(key);
  }
}

function jobNumber(data: Inspection, field: string): { kind: 'int' | 'float'; value: number | null } {
  const ints: Record<string, number> = {
    emergency_calls: data.emergencyCalls,
    haul_loads: data.haulLoads,
    air_scrubbers: data.airScrubbers,
    hepa_filters: data.hepaFilters,
    matterport_scans: data.matterportScans,
    dump_truck_loads: data.dumpTruckLoads,
    equipment_decon: data.equipmentDecon,
    power_distribution: data.powerDistribution,
    air_movers: data.airMovers,
    dehumidifiers: data.dehumidifiers,
    wood_floor_systems: data.woodFloorSystems,
    drying_days: data.dryingDays,
    wood_floor_days: data.woodFloorDays,
  };
  if (field in ints) return { kind: 'int', value: ints[field] ?? 0 };
  if (field === 'monitoring_hours') return { kind: 'float', value: data.monitoringHours };
  if (field === 'labor_hours') return { kind: 'float', value: data.laborHours };
  return { kind: 'int', value: null };
}

function roomNumber(room: Room, field: string): number | null {
  if (field === 'unfinished_sf') return room.unfinishedSf;
  if (field === 'finished_sf') return room.finishedSf;
  if (field === 'floor_sf') return room.floorSf;
  if (field === 'wet_floor_sf') return room.wetFloorSf;
  return null;
}

export function checkOverrides(data: Inspection): void {
  for (const [key, override] of Object.entries(data.quantityOverrides ?? {})) {
    const name = key.slice(0, key.lastIndexOf(':'));
    const field = key.slice(key.lastIndexOf(':') + 1);
    const split = key.includes(':');
    let current: Dec;
    if (split) {
      const room = data.rooms.find((item) => item.name === name);
      if (!room || !ROOM_OVERRIDE.has(field)) bad(`override ${key}`);
      current = orZero('float', roomNumber(room, field));
    } else if (JOB_OVERRIDE.has(key)) {
      const job = jobNumber(data, key);
      current = orZero(job.kind, job.value);
    } else bad(`override ${key}`);
    if (current.add(override.entered.neg()).abs().cmp(Dec.parse('0.01')) >= 0) bad(`stale ${key}`);
  }
}

export function fieldDec(data: Inspection, field: string): Dec {
  const job = jobNumber(data, field);
  if (job.value === null) return ZERO;
  return job.kind === 'float' ? decFloat(job.value) : decInt(job.value);
}

export function jobCount(data: Inspection, field: string): number {
  return jobNumber(data, field).value ?? 0;
}
