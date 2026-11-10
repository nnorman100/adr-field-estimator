// adr-residential-v1 scope, range, and buckets. Money is quantized once, the way claims.amount does.

import { Dec, ZERO, money, sumDec } from './decimal';
import type { JObj } from './json';
import { decFloat, decInt } from './values';
import type { Inspection } from './inspection';
import { lineToJ, type PriceLine } from './values';

export const V1 = 'adr-residential-v1';

const RATES: Record<number, [string, string]> = {
  1: ['demo_cat1_unfinished', 'demo_cat1_finished'],
  2: ['demo_cat2_unfinished', 'demo_cat2_finished'],
  3: ['demo_cat3_unfinished', 'demo_cat3_finished'],
};

const BASELINE: Array<[string, string, keyof Counts, string, string]> = [
  ['ADR-TRIP', 'Emergency call / trip charge', 'emergencyCalls', 'EA', 'emergency_call'],
  ['ADR-MON', 'Equipment monitoring', 'monitoringHours', 'HR', 'monitoring_hourly'],
  ['ADR-HAUL', 'Haul debris & disposal', 'haulLoads', 'load', 'haul_pickup_load'],
  ['ADR-SCRUB', 'Air scrubber daily rental', 'airScrubbers', 'day', 'air_scrubber_daily'],
  ['ADR-HEPA', 'HEPA replacement filter', 'hepaFilters', 'EA', 'hepa_filter'],
];

const OPTIONAL: Array<[string, string, keyof Counts, string]> = [
  ['ADR-MATTERPORT', 'Matterport scan', 'matterportScans', 'matterport_scan'],
  ['ADR-DUMP', 'Single-axle dump truck load', 'dumpTruckLoads', 'dump_truck_load'],
  ['ADR-DECON', 'Drying equipment decontamination', 'equipmentDecon', 'equipment_decontamination'],
  ['ADR-POWER', 'Power distribution', 'powerDistribution', 'power_distribution'],
];

const JOB = new Set([
  'ADR-TRIP',
  'ADR-MON',
  'ADR-HAUL',
  'ADR-SCRUB',
  'ADR-HEPA',
  'ADR-AFTER',
  'ADR-EXTRA',
  'ADR-MATTERPORT',
  'ADR-DUMP',
  'ADR-DECON',
  'ADR-POWER',
]);
const LABOR = new Set(['ADR-DEMO', 'ADR-LABOR']);
const EQUIPMENT = new Set(['ADR-FAN', 'ADR-DEHU', 'ADR-WOOD']);

export const SCOPE_EXCLUDED = new Set([
  'ADR-TRIP',
  'ADR-MON',
  'ADR-HAUL',
  'ADR-SCRUB',
  'ADR-HEPA',
  'ADR-AFTER',
]);

export const BASELINE_SOURCES = new Set([
  'field:emergency_calls',
  'field:monitoring_hours',
  'field:haul_loads',
  'field:air_scrubbers',
  'field:hepa_filters',
  'after_hours',
]);

type Counts = {
  emergencyCalls: number;
  monitoringHours: number;
  haulLoads: number;
  airScrubbers: number;
  hepaFilters: number;
  matterportScans: number;
  dumpTruckLoads: number;
  equipmentDecon: number;
  powerDistribution: number;
};

function rate(book: Record<string, string>, key: string): Dec {
  const raw = book[key];
  if (raw === undefined) throw new Error('Company prices are required to price this job.');
  return Dec.parse(raw);
}

function line(code: string, description: string, quantity: Dec, unit: string, price: Dec, waste: Dec = ZERO): PriceLine {
  const total = money(quantity.mul(price).mul(Dec.fromInt(1).add(waste.div(Dec.fromInt(100)))));
  return {
    code,
    description,
    quantity: quantity.toNumber(),
    unit,
    unitPrice: price.toNumber(),
    waste: waste.toNumber(),
    total: total.toNumber(),
  };
}

function counted(value: number, asFloat: boolean): Dec {
  return asFloat ? decFloat(value) : decInt(value);
}

export function priceScopeV1(data: Inspection, rates: Record<string, string>): { lines: PriceLine[]; itemized: number } {
  if (!rates) throw new Error('Company prices are required to price this job.');
  const items: PriceLine[] = [];
  for (const [code, text, field, unit, key] of BASELINE) {
    const quantity = data[field];
    if (quantity) items.push(line(code, text, counted(quantity, field === 'monitoringHours'), unit, rate(rates, key)));
  }
  if (data.isAfterHours) {
    items.push(line('ADR-AFTER', 'After-hours job charge', Dec.fromInt(1), 'EA', rate(rates, 'after_hours_job_charge')));
  }
  for (const [code, description, field, key] of OPTIONAL) {
    const quantity = data[field];
    if (quantity) items.push(line(code, description, decInt(quantity), 'EA', rate(rates, key)));
  }
  for (const room of data.rooms) {
    const keys = RATES[room.category];
    if (!keys) throw new Error('category');
    const rows: Array<[number, string, string]> = [
      [room.unfinishedSf, keys[0], 'unfinished/subfloor'],
      [room.finishedSf, keys[1], 'finished/drywall/trim'],
    ];
    for (const [qty, key, finish] of rows) {
      if (!qty) continue;
      let price = rate(rates, key);
      if (finish.startsWith('finished') && room.category === 3 && room.customCabinetry) price = price.mul(Dec.fromInt(2));
      items.push(
        line('ADR-DEMO', `${room.name}: category ${room.category} ${finish} demolition`, decFloat(qty), 'SF', price, decFloat(room.wastePercent)),
      );
    }
  }
  if (data.airMovers) {
    items.push(line('ADR-FAN', 'Axial air movers', decInt(data.airMovers * data.dryingDays), 'unit-day', rate(rates, 'air_mover_daily')));
  }
  if (data.dehumidifiers) {
    items.push(
      line('ADR-DEHU', 'Commercial LGR dehumidifiers', decInt(data.dehumidifiers * data.dryingDays), 'unit-day', rate(rates, 'dehumidifier_daily')),
    );
  }
  if (data.woodFloorSystems) {
    items.push(
      line(
        'ADR-WOOD',
        'Wood-floor drying system / heater',
        decInt(data.woodFloorSystems * data.woodFloorDays),
        'unit-day',
        rate(rates, 'wood_floor_daily'),
      ),
    );
  }
  if (data.laborHours) {
    items.push(line('ADR-LABOR', 'Content manipulation / additional labor', decFloat(data.laborHours), 'HR', rate(rates, 'sheet_labor_hourly')));
  }
  for (const extra of data.extras) {
    if (extra.approval) items.push(line('ADR-EXTRA', extra.description, extra.hours, 'HR', extra.approval.rate));
  }
  const itemized = sumDec(items.map((item) => money(decFloat(item.total))), ZERO).toNumber();
  return { lines: items, itemized };
}

function bucket(lines: PriceLine[], codes: Set<string>): Dec {
  return sumDec(
    lines.filter((item) => codes.has(item.code)).map((item) => money(decFloat(item.total))),
    ZERO,
  );
}

export function proposalRange(data: Inspection, lines: PriceLine[]): { low: Dec; high: Dec } {
  const known = new Set([...JOB, ...LABOR, ...EQUIPMENT]);
  const missing = [...new Set(lines.map((item) => item.code))].filter((code) => !known.has(code)).sort();
  if (missing.length) throw new Error(`Priced codes missing from the estimate range: ${missing}`);
  const job = bucket(lines, JOB);
  const labor = bucket(lines, LABOR);
  const equipment = bucket(lines, EQUIPMENT);
  const affected = sumDec(
    data.rooms.map((room) => decFloat(room.unfinishedSf).add(decFloat(room.finishedSf))),
    ZERO,
  );
  const lowLabor = labor.mul(data.isAfterHours ? Dec.parse('1.2') : Dec.fromInt(1));
  const highLabor = lowLabor.mul(affected.cmp(Dec.fromInt(1001)) < 0 ? Dec.parse('1.5') : Dec.parse('1.2'));
  return {
    low: money(job.add(equipment).add(lowLabor)),
    high: money(job.add(equipment).add(highLabor)),
  };
}

export function v1Buckets(data: Inspection, lines: PriceLine[]): JObj {
  const affected = sumDec(
    data.rooms.map((room) => decFloat(room.unfinishedSf).add(decFloat(room.finishedSf))),
    ZERO,
  );
  return {
    affected_sf: affected.toString(),
    equipment: bucket(lines, EQUIPMENT).toString(),
    job: bucket(lines, JOB).toString(),
    labor_material: bucket(lines, LABOR).toString(),
  };
}

export function linesToJ(lines: PriceLine[]): JObj[] {
  return lines.map((item) => lineToJ(item));
}
