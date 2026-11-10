// dryscope-v2 line builder. Totals and the high-end sentences live in totals.ts.

import { Dec, HUNDRED, ONE, ZERO, money, maxDec, minDec, sumDec } from './decimal';
import type { JObj } from './json';
import { collapse, commas, decFloat, decInt, truthy } from './values';
import type { Inspection, Room } from './inspection';
import { fieldDec } from './inspection';
import {
  BUCKET_OF_GROUP,
  COUNT_DAYS,
  FIELD_SOURCES,
  GROUPS,
  bracketModeOf,
  parseSource,
  type Item,
  type Policy,
  type Source,
} from './table';
import type { PriceLine } from './values';

const EXTRA = 'EXTRA';
const EXTRAS = 'extras';
const ROOM_FIELDS = new Set(['unfinished_sf', 'finished_sf', 'wet_floor_sf', 'floor_sf']);
const JOB_FIELDS = new Set<string>([...FIELD_SOURCES, ...COUNT_DAYS.flat()]);
const RANK = new Map<string, number>(GROUPS.map((group, index) => [group, index]));

export type EngineWarning = JObj;

function bucketOf(group: string, code: string): string {
  const bucket = BUCKET_OF_GROUP[group];
  if (!bucket) throw new Error(`Priced codes missing from the estimate range: ${code} (${group})`);
  return bucket;
}

function roomKey(name: string): string {
  return collapse(name);
}

function orZero(value: Dec | null): Dec {
  if (value === null || value.isZero()) return ZERO;
  return value;
}

export function overrides(data: Inspection, warnings: EngineWarning[]): { job: Map<string, Dec>; rooms: Map<string, Dec> } {
  const job = new Map<string, Dec>();
  const rooms = new Map<string, Dec>();
  const names = new Set(data.rooms.map((room) => roomKey(room.name)));
  for (const [key, override] of Object.entries(data.quantityOverrides ?? {})) {
    if (JOB_FIELDS.has(key)) {
      job.set(key, override.entered);
      continue;
    }
    const cut = key.lastIndexOf(':');
    const name = cut >= 0 ? key.slice(0, cut) : '';
    const field = cut >= 0 ? key.slice(cut + 1) : key;
    if (cut >= 0 && ROOM_FIELDS.has(field) && names.has(roomKey(name))) rooms.set(`${roomKey(name)}:${field}`, override.entered);
    else warnings.push({ code: 'unknown_quantity_override', key });
  }
  return { job, rooms };
}

function roomValue(room: Room, field: string): number | null {
  if (field === 'unfinished_sf') return room.unfinishedSf;
  if (field === 'finished_sf') return room.finishedSf;
  if (field === 'waste_percent') return room.wastePercent;
  if (field === 'floor_sf') return room.floorSf;
  if (field === 'wet_floor_sf') return room.wetFloorSf;
  return null;
}

function readRoom(room: Room, field: string, rooms: Map<string, Dec>): Dec | null {
  const value = roomValue(room, field);
  if (value === null) return null;
  return rooms.get(`${roomKey(room.name)}:${field}`) ?? decFloat(value);
}

function wetFloor(room: Room, rooms: Map<string, Dec>): Dec {
  const wet = readRoom(room, 'wet_floor_sf', rooms);
  if (wet !== null) return wet;
  return orZero(readRoom(room, 'floor_sf', rooms));
}

function roomQuantity(room: Room, source: Source, policy: Policy, rooms: Map<string, Dec>): Dec | null {
  if (source.field === 'basis') {
    if (policy.areaBasis === 'wet_floor') return wetFloor(room, rooms);
    const unfinished = readRoom(room, 'unfinished_sf', rooms);
    const finished = readRoom(room, 'finished_sf', rooms);
    return (unfinished ?? ZERO).add(finished ?? ZERO);
  }
  if (source.field === 'wet_floor_sf') return wetFloor(room, rooms);
  return orZero(readRoom(room, source.field ?? '', rooms));
}

function jobQuantity(item: Item, source: Source, data: Inspection, job: Map<string, Dec>, numbers: Record<string, Dec>): Dec {
  const read = (...fields: string[]): Dec => {
    let quantity = ONE;
    for (const field of fields) {
      let value: Dec;
      if (job.has(field)) value = job.get(field) ?? ZERO;
      else if (data.present.has(field)) value = fieldDec(data, field);
      else return Dec.parse(item.defaultQuantity);
      const factor = numbers[field] ?? value;
      quantity = quantity.mul(factor);
    }
    return quantity;
  };
  if (source.kind === 'field') return read(source.field ?? '');
  if (source.kind === 'count_days') return read(source.countField ?? '', source.daysField ?? '');
  if (source.kind === 'after_hours') return data.isAfterHours ? ONE : ZERO;
  const entry = data.scopeItems?.[item.itemId];
  if (source.kind === 'typed') return entry ? entry.quantity : Dec.parse(item.defaultQuantity);
  if (source.kind === 'typed_count_days') return entry ? decInt(entry.count * entry.days) : ZERO;
  throw new Error(`Unknown quantity source kind: ${source.kind}`);
}

function unpricedQuantity(item: Item, data: Inspection): boolean {
  const entry = data.scopeItems?.[item.itemId];
  return Dec.parse(item.defaultQuantity).cmp(ZERO) > 0 || Boolean(entry && entry.quantity.cmp(ZERO) > 0);
}

function blank(item: Item): boolean {
  if (item.unitPrice === '' && !item.priceBrackets) return true;
  return (item.priceBrackets ?? []).some((band) => band.unitPrice === '');
}

export function makeLine(
  item: Item,
  description: string,
  quantity: Dec,
  price: Dec,
  waste: Dec,
  room: string | null = null,
  area: number | null = null,
): PriceLine {
  const total = money(quantity.mul(price).mul(ONE.add(waste.div(HUNDRED))));
  return {
    code: item.code,
    description,
    quantity: quantity.toNumber(),
    unit: item.unit,
    unitPrice: price.toNumber(),
    waste: waste.toNumber(),
    total: total.toNumber(),
    itemId: item.itemId,
    group: item.group,
    bucket: bucketOf(item.group, item.code),
    taxable: item.taxable,
    xactimateCode: item.xactimateCode,
    room,
    area,
  };
}

function catPrice(item: Item, policy: Policy, category: number): Dec {
  const base = item.priceBrackets ? ONE : Dec.parse(item.unitPrice);
  const key = String(category) as '1' | '2' | '3';
  return base.mul(Dec.parse(policy.categoryMultipliers[key]));
}

function roomLines(item: Item, source: Source, data: Inspection, policy: Policy, rooms: Map<string, Dec>, warnings: EngineWarning[]): PriceLine[] {
  const lines: PriceLine[] = [];
  const label = item.customerDescription || item.name;
  for (const room of data.rooms) {
    if (item.categories.length && !item.categories.includes(room.category)) continue;
    const quantity = roomQuantity(room, source, policy, rooms);
    if (!quantity || !truthy(quantity)) {
      warnings.push({ code: 'missing_area', item_id: item.itemId, room: room.name });
      continue;
    }
    let price = catPrice(item, policy, room.category);
    if (room.category === 3 && room.customCabinetry && (source.finish === 'finished' || policy.cabinetry.scope === 'all_cat3')) {
      price = price.mul(Dec.parse(policy.cabinetry.multiplier));
    }
    const waste = room.wastePercent > 0 ? decFloat(room.wastePercent) : Dec.parse(item.wastePercent);
    lines.push(makeLine(item, `${room.name}: ${label}`, quantity, price, waste, room.name, quantity.toNumber()));
  }
  return lines;
}

function bandFor(brackets: NonNullable<Item['priceBrackets']>, area: Dec): (typeof brackets)[number] {
  const band = brackets.find((row) => row.upToSf === null || area.cmp(Dec.fromInt(row.upToSf)) <= 0);
  if (!band) throw new Error('bracket');
  return band;
}

function jobSf(data: Inspection, items: Item[], policy: Policy): Dec {
  const { job, rooms } = overrides(data, []);
  const categories = new Set(data.rooms.map((room) => room.category));
  const areas = new Map<number, Dec>();
  let typed = ZERO;
  const demolition = parseSource('room:basis');
  const demolitionPolicy: Policy = { ...policy, areaBasis: 'demolition' };
  for (const item of items) {
    if (!item.enabled || item.unit !== 'sf' || item.group === EXTRAS || blank(item)) continue;
    const source = parseSource(item.quantitySource);
    if (source.kind !== 'room') {
      if (!item.categories.length || item.categories.some((category) => categories.has(category))) {
        typed = typed.add(jobQuantity(item, source, data, job, {}));
      }
      continue;
    }
    data.rooms.forEach((room, index) => {
      if (item.categories.length && !item.categories.includes(room.category)) return;
      const area =
        source.field === 'finished_sf' || source.field === 'unfinished_sf'
          ? roomQuantity(room, demolition, demolitionPolicy, rooms)
          : roomQuantity(room, source, policy, rooms);
      areas.set(index, maxDec(areas.get(index) ?? ZERO, area ?? ZERO));
    });
  }
  return sumDec([...areas.values()], typed);
}

function score(line: PriceLine, growth?: (line: PriceLine) => Dec): Dec {
  const waste = ONE.add(decFloat(line.waste).div(HUNDRED));
  const grown = ONE.add(growth ? growth(line) : ZERO);
  return decFloat(line.unitPrice).mul(waste).mul(grown);
}

function bracketLines(item: Item, lines: PriceLine[], policy: Policy, jobArea: Dec | null, growth?: (line: PriceLine) => Dec): PriceLine[] {
  const brackets = item.priceBrackets ?? [];
  const whole = bracketModeOf(policy) === 'whole-job';
  const selected = whole ? bandFor(brackets, jobArea ?? ZERO) : null;
  let used = ZERO;
  let exact = ZERO;
  let rounded = ZERO;
  const ordered = [...lines].sort((left, right) => score(right, growth).cmp(score(left, growth)));
  const result: PriceLine[] = [];
  for (const line of ordered) {
    let remaining = decFloat(line.quantity);
    while (truthy(remaining)) {
      const band =
        selected ?? brackets.find((row) => row.upToSf === null || used.cmp(Dec.fromInt(row.upToSf)) < 0);
      if (!band || band.unitPrice === undefined) throw new Error('bracket');
      const limit = band.upToSf === null ? null : Dec.fromInt(band.upToSf);
      const take = whole || limit === null ? remaining : minDec(remaining, limit.sub(used));
      const price = Dec.parse(band.unitPrice).mul(decFloat(line.unitPrice));
      const waste = ONE.add(decFloat(line.waste).div(HUNDRED));
      exact = exact.add(take.mul(price).mul(waste));
      const total = money(exact).sub(rounded);
      rounded = rounded.add(total);
      const index = brackets.indexOf(band);
      const lower = index > 0 ? (brackets[index - 1]?.upToSf ?? 0) : 0;
      const label = band.upToSf === null ? `over ${commas(lower)} sq ft` : `over ${commas(lower)} through ${commas(band.upToSf)} sq ft`;
      const suffix = whole ? " of the job's total square feet)" : ')';
      result.push({
        ...line,
        quantity: take.toNumber(),
        area: take.toNumber(),
        unitPrice: price.toNumber(),
        total: total.toNumber(),
        description: `${line.description} (${bracketModeOf(policy)} bracket: ${label}${suffix}`,
        priceBracket: { upToSf: band.upToSf, unitPrice: band.unitPrice },
        bracketMode: bracketModeOf(policy),
      });
      remaining = remaining.sub(take);
      used = used.add(take);
    }
  }
  return result;
}

export function priceScopeV2(
  data: Inspection,
  items: Item[],
  policy: Policy,
  numbers: Record<string, Dec> = {},
  growth?: (line: PriceLine) => Dec,
): { lines: PriceLine[]; warnings: EngineWarning[] } {
  const warnings: EngineWarning[] = [];
  const { job, rooms } = overrides(data, warnings);
  const known = new Set(items.map((item) => item.itemId));
  for (const key of Object.keys(data.scopeItems ?? {})) {
    if (!known.has(key)) warnings.push({ code: 'unknown_scope_item', item_id: key });
  }
  const categories = new Set(data.rooms.map((room) => room.category));
  const priced: Array<[Item, PriceLine[]]> = [];
  let extrasTaxable = false;
  const enabled = items.filter((item) => item.enabled).sort((left, right) => {
    const rank = (RANK.get(left.group) ?? GROUPS.length) - (RANK.get(right.group) ?? GROUPS.length);
    return rank || left.sortOrder - right.sortOrder;
  });
  for (const item of enabled) {
    if (item.group === EXTRAS) {
      extrasTaxable = item.taxable;
      if (unpricedQuantity(item, data)) warnings.push({ code: 'unpriced_extras_quantity', item_id: item.itemId });
    }
    if (blank(item)) {
      warnings.push({ code: 'blank_price_item', item_id: item.itemId });
      continue;
    }
    if (item.group === EXTRAS) continue;
    const source = parseSource(item.quantitySource);
    if (source.kind === 'room') {
      priced.push([item, roomLines(item, source, data, policy, rooms, warnings)]);
      continue;
    }
    if (item.categories.length && !item.categories.some((category) => categories.has(category))) continue;
    const quantity = jobQuantity(item, source, data, job, numbers);
    if (truthy(quantity)) {
      const price = item.priceBrackets ? ONE : Dec.parse(item.unitPrice);
      priced.push([item, [makeLine(item, item.customerDescription || item.name, quantity, price, Dec.parse(item.wastePercent))]]);
    }
  }
  const whole = bracketModeOf(policy) === 'whole-job';
  const area = whole ? jobSf(data, items, policy) : null;
  const lines: PriceLine[] = [];
  for (const [item, itemLines] of priced) {
    lines.push(...(item.priceBrackets ? bracketLines(item, itemLines, policy, area, growth) : itemLines));
  }
  for (const extra of data.extras) {
    if (!extra.approval) continue;
    const total = money(extra.hours.mul(extra.approval.rate));
    lines.push({
      code: EXTRA,
      itemId: null,
      group: EXTRAS,
      bucket: bucketOf(EXTRAS, EXTRA),
      description: extra.description,
      quantity: extra.hours.toNumber(),
      unit: 'hour',
      unitPrice: extra.approval.rate.toNumber(),
      waste: 0,
      total: total.toNumber(),
      taxable: extrasTaxable,
      xactimateCode: '',
      room: null,
      area: null,
    });
  }
  return { lines, warnings };
}

export function exactAmount(line: PriceLine): Dec {
  return decFloat(line.quantity).mul(decFloat(line.unitPrice)).mul(ONE.add(decFloat(line.waste).div(HUNDRED)));
}

export function sumBucket(lines: PriceLine[], bucket: string, taxable = false): Dec {
  return sumDec(
    lines.filter((line) => line.bucket === bucket && (line.taxable || !taxable)).map((line) => decFloat(line.total)),
    ZERO,
  );
}

export function v2Buckets(lines: PriceLine[]): JObj {
  const out: JObj = {};
  for (const bucket of ['fixed', 'equipment', 'labor_material']) {
    out[bucket] = sumBucket(lines, bucket).toString();
    out[`taxed_${bucket}`] = sumBucket(lines, bucket, true).toString();
  }
  return out;
}

export { jobSf };
