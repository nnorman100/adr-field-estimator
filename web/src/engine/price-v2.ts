// dryscope-v3 line builder. Totals and the high-end sentences live in totals.ts.

import { Dec, HUNDRED, ONE, ZERO, money, maxDec, minDec, sumDec } from './decimal';
import type { JObj } from './json';
import {
  categoryLabel,
  collapse,
  commas,
  isWater,
  truthy,
  type SizeTier,
  type PriceLine,
} from './values';
import type { Inspection, Room } from './inspection';
import { fieldDec, roomNumber } from './inspection';
import { affectedBandOf, roomTypeOf, sizeTierOf } from './rooms';
import { pickPriceRow } from './row-pick';
import {
  BUCKET_OF_GROUP,
  COUNT_DAYS,
  FIELD_SOURCES,
  GROUPS,
  blankPrice,
  parseSource,
  rowKey,
  type Item,
  type Policy,
  type PriceBand,
  type PriceRow,
  type Source,
} from './table';

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

export function overrides(
  data: Inspection,
  warnings: EngineWarning[],
): { job: Map<string, Dec>; rooms: Map<string, Dec> } {
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
    if (cut >= 0 && ROOM_FIELDS.has(field) && names.has(roomKey(name))) {
      rooms.set(`${roomKey(name)}:${field}`, override.entered);
    } else warnings.push({ code: 'unknown_quantity_override', key });
  }
  return { job, rooms };
}

function readRoom(room: Room, field: string, rooms: Map<string, Dec>): Dec | null {
  const value = roomNumber(room, field);
  if (value === null) return null;
  return rooms.get(`${roomKey(room.name)}:${field}`) ?? value;
}

function wetFloor(room: Room, rooms: Map<string, Dec>): Dec {
  const wet = readRoom(room, 'wet_floor_sf', rooms);
  if (wet !== null) return wet;
  return readRoom(room, 'floor_sf', rooms) ?? ZERO;
}

/** The quantity a room typed for an item (`room:typed`), or null when the room does not list the item. */
function typedInRoom(room: Room, item: Item): Dec | null {
  return room.items.find((entry) => entry.itemId === item.item_id)?.quantity ?? null;
}

function roomQuantity(room: Room, item: Item, source: Source, policy: Policy, rooms: Map<string, Dec>): Dec {
  if (source.field === 'typed') return typedInRoom(room, item) ?? ZERO;
  if (source.field === 'basis') {
    if (policy.area_basis === 'wet_floor') return wetFloor(room, rooms);
    const unfinished = readRoom(room, 'unfinished_sf', rooms);
    const finished = readRoom(room, 'finished_sf', rooms);
    return (unfinished ?? ZERO).add(finished ?? ZERO);
  }
  if (source.field === 'wet_floor_sf') return wetFloor(room, rooms);
  if (source.field === 'each') return ONE;
  return readRoom(room, source.field ?? '', rooms) ?? ZERO;
}

function jobQuantity(
  item: Item,
  source: Source,
  data: Inspection,
  job: Map<string, Dec>,
  numbers: Record<string, Dec>,
): Dec {
  const read = (...fields: string[]): Dec => {
    let quantity = ONE;
    for (const field of fields) {
      const value = job.get(field) ?? fieldDec(data, field);
      quantity = quantity.mul(numbers[field] ?? value);
    }
    return quantity;
  };
  if (source.kind === 'field') return read(source.field ?? '');
  if (source.kind === 'count_days') return read(source.countField ?? '', source.daysField ?? '');
  if (source.kind === 'after_hours') return data.isAfterHours ? ONE : ZERO;
  const entry = data.scopeItems?.[item.item_id];
  if (source.kind === 'typed') return entry ? entry.quantity : Dec.parse(item.default_quantity);
  if (source.kind === 'typed_count_days') return entry ? Dec.fromInt(entry.count * entry.days) : ZERO;
  throw new Error(`Unknown quantity source kind: ${source.kind}`);
}

function unpricedQuantity(item: Item, data: Inspection): boolean {
  const entry = data.scopeItems?.[item.item_id];
  return (
    Dec.parse(item.default_quantity).cmp(ZERO) > 0 || Boolean(entry && entry.quantity.cmp(ZERO) > 0)
  );
}

export function makeLine(
  item: Item,
  description: string,
  quantity: Dec,
  price: Dec,
  waste: Dec,
  room: string | null = null,
  area: Dec | null = null,
): PriceLine {
  return {
    code: item.code,
    description,
    quantity,
    unit: item.unit,
    unitPrice: price,
    waste,
    total: money(quantity.mul(price).mul(ONE.add(waste.div(HUNDRED)))),
    itemId: item.item_id,
    group: item.group,
    bucket: bucketOf(item.group, item.code),
    taxable: item.taxable,
    materialsShare: Dec.parse(item.materials_share_percent ?? '100'),
    afterHours: item.after_hours === true,
    noOverheadProfit: item.no_overhead_profit === true,
    trade: item.trade ?? null,
    xactimateCode: item.xactimate_code,
    room,
    area,
  };
}

/**
 * The row that prices a room: the most specific one wins, room type plus category, then room type,
 * then category; null means the item's default row. A room type the table does not know matches
 * none of the room-type rows. The rule itself is pickPriceRow (row-pick.ts), shared with the
 * Prices screen's preview.
 */
function rowFor(item: Item, room: Room, type: string | null): PriceRow | null {
  return pickPriceRow(item, room.category, type);
}

/** "Bathroom, Cat 3": what a row that priced a line is called on it. */
function rowLabel(row: PriceRow, policy: Policy): string {
  const type = row.room_type === undefined ? null : (policy.room_types.find((t) => t.id === row.room_type)?.name ?? 'Other');
  return [type, row.category === undefined ? null : categoryLabel(row.category)].filter(Boolean).join(', ');
}

/**
 * A room line's unit price. A row is used as set. The default row takes the water-category
 * multiplier, and the cabinetry multiplier in a custom-cabinetry Cat 3 room; a Mold room takes neither.
 * A bracketed row's unit price is the factor its band prices are multiplied by. A per-room item
 * prices by the room's size tier.
 */
function roomPrice(item: Item, source: Source, policy: Policy, room: Room, row: PriceRow | null, tier: SizeTier | null): Dec {
  const tiers = row ? row.tier_prices : item.tier_prices;
  if (row) return tiers && tier ? Dec.parse(tiers[tier]) : row.price_brackets ? ONE : Dec.parse(row.unit_price ?? '');
  let price = tiers && tier ? Dec.parse(tiers[tier]) : item.price_brackets ? ONE : Dec.parse(item.unit_price);
  if (!isWater(room.category)) return price;
  const key = String(room.category) as '1' | '2' | '3';
  price = price.mul(Dec.parse(policy.category_multipliers[key]));
  const cabinetry = source.finish === 'finished' || policy.cabinetry.scope === 'all_cat3';
  if (room.category === 3 && room.customCabinetry && cabinetry) {
    price = price.mul(Dec.parse(policy.cabinetry.multiplier));
  }
  return price;
}

/**
 * Whether an item applies to a room beyond its category filter: a mold item may name the mold
 * conditions and affected-area bands it covers. A room that lacks the input an item asks about gets
 * no line, and a warning says which input is missing.
 */
function applies(item: Item, room: Room, warnings: EngineWarning[]): boolean {
  if (item.mold_conditions?.length) {
    if (room.moldCondition === null) {
      warnings.push({ code: 'missing_mold_condition', item_id: item.item_id, room: room.name });
      return false;
    }
    if (!item.mold_conditions.includes(room.moldCondition)) return false;
  }
  if (item.affected_bands?.length) {
    if (room.affectedSf === null) {
      warnings.push({ code: 'missing_affected_area', item_id: item.item_id, room: room.name });
      return false;
    }
    if (!item.affected_bands.includes(affectedBandOf(room.affectedSf))) return false;
  }
  return true;
}

function roomLines(
  item: Item,
  source: Source,
  data: Inspection,
  policy: Policy,
  rooms: Map<string, Dec>,
  warnings: EngineWarning[],
): PriceLine[] {
  const lines: PriceLine[] = [];
  const label = item.customer_description || item.name;
  const typed = source.field === 'typed';
  for (const room of data.rooms) {
    if (item.categories.length && !item.categories.includes(room.category)) continue;
    // A typed item prices only the rooms that list it with a quantity; the others are not missing anything.
    if (typed && !truthy(typedInRoom(room, item) ?? ZERO)) continue;
    if (!applies(item, room, warnings)) continue;
    const tier = item.unit === 'room' ? sizeTierOf(room, policy) : null;
    if (item.unit === 'room' && tier === null) {
      warnings.push({ code: 'missing_size', item_id: item.item_id, room: room.name });
      continue;
    }
    const quantity = roomQuantity(room, item, source, policy, rooms);
    if (!truthy(quantity)) {
      warnings.push({ code: 'missing_area', item_id: item.item_id, room: room.name });
      continue;
    }
    const row = rowFor(item, room, roomTypeOf(room, policy));
    const price = roomPrice(item, source, policy, room, row, tier);
    const waste = truthy(room.wastePercent) ? room.wastePercent : Dec.parse(item.waste_percent);
    const where = row ? `${room.name}, ${rowLabel(row, policy)}` : room.name;
    const size = tier ? ` (size ${tier.toUpperCase()})` : '';
    // The quantity is square feet of the room's work unless the item is priced per room, or is typed in another unit.
    const area = item.unit === 'room' || (typed && item.unit !== 'sf') ? null : quantity;
    const line = makeLine(item, `${where}: ${label}${size}`, quantity, price, waste, room.name, area);
    if (row) line.priceRow = rowKey(row);
    lines.push(line);
  }
  return lines;
}

/**
 * An item's lines split by the row that priced them, default row first, then rows in category
 * order, each with its own bracket list (null for a flat price).
 */
function byRow(item: Item, lines: PriceLine[]): Array<[PriceBand[] | null, PriceLine[]]> {
  const groups: Array<[PriceBand[] | null, PriceLine[]]> = [
    [item.price_brackets ?? null, lines.filter((line) => !line.priceRow)],
  ];
  for (const row of item.rows ?? []) {
    groups.push([row.price_brackets ?? null, lines.filter((line) => line.priceRow === rowKey(row))]);
  }
  return groups.filter(([, group]) => group.length > 0);
}

function bandFor(brackets: PriceBand[], area: Dec): PriceBand {
  const band = brackets.find((row) => row.up_to_sf === null || area.cmp(Dec.fromInt(row.up_to_sf)) <= 0);
  if (!band) throw new Error('bracket');
  return band;
}

export function jobSf(data: Inspection, items: Item[], policy: Policy): Dec {
  const { job, rooms } = overrides(data, []);
  const categories = new Set(data.rooms.map((room) => room.category));
  const areas = new Map<number, Dec>();
  let typed = ZERO;
  const demolition = parseSource('room:basis');
  const demolitionPolicy: Policy = { ...policy, area_basis: 'demolition' };
  for (const item of items) {
    if (!item.enabled || item.unit !== 'sf' || item.group === EXTRAS || blankPrice(item)) continue;
    const allowed = item.categories;
    const source = parseSource(item.quantity_source);
    if (source.kind !== 'room') {
      if (!allowed.length || allowed.some((category) => categories.has(category))) {
        typed = typed.add(jobQuantity(item, source, data, job, {}));
      }
      continue;
    }
    data.rooms.forEach((room, index) => {
      if (allowed.length && !allowed.includes(room.category)) return;
      if (!applies(item, room, [])) return;
      const area =
        source.field === 'finished_sf' || source.field === 'unfinished_sf'
          ? roomQuantity(room, item, demolition, demolitionPolicy, rooms)
          : roomQuantity(room, item, source, policy, rooms);
      areas.set(index, maxDec(areas.get(index) ?? ZERO, area));
    });
  }
  return sumDec([...areas.values()], typed);
}

function score(line: PriceLine, growth?: (line: PriceLine) => Dec): Dec {
  const waste = ONE.add(line.waste.div(HUNDRED));
  const grown = ONE.add(growth ? growth(line) : ZERO);
  return line.unitPrice.mul(waste).mul(grown);
}

/**
 * Bracket lines for one row. In tiered mode only the lines this row priced count toward its bands;
 * in whole-job mode the job's total square feet picks the band in this row's own list.
 */
function bracketLines(
  brackets: PriceBand[],
  lines: PriceLine[],
  policy: Policy,
  jobArea: Dec | null,
  growth?: (line: PriceLine) => Dec,
): PriceLine[] {
  const mode = policy.bracket_mode;
  const whole = mode === 'whole-job';
  const selected = whole ? bandFor(brackets, jobArea ?? ZERO) : null;
  let used = ZERO;
  let exact = ZERO;
  let rounded = ZERO;
  const ordered = [...lines].sort((left, right) => score(right, growth).cmp(score(left, growth)));
  const result: PriceLine[] = [];
  for (const line of ordered) {
    let remaining = line.quantity;
    while (truthy(remaining)) {
      const band =
        selected ??
        brackets.find((row) => row.up_to_sf === null || used.cmp(Dec.fromInt(row.up_to_sf)) < 0);
      if (!band) throw new Error('bracket');
      const limit = band.up_to_sf === null ? null : Dec.fromInt(band.up_to_sf);
      const take = whole || limit === null ? remaining : minDec(remaining, limit.sub(used));
      const price = Dec.parse(band.unit_price).mul(line.unitPrice);
      const waste = ONE.add(line.waste.div(HUNDRED));
      exact = exact.add(take.mul(price).mul(waste));
      const total = money(exact).sub(rounded);
      rounded = rounded.add(total);
      const index = brackets.indexOf(band);
      const lower = index > 0 ? (brackets[index - 1]?.up_to_sf ?? 0) : 0;
      const label =
        band.up_to_sf === null
          ? `over ${commas(lower)} sq ft`
          : `over ${commas(lower)} through ${commas(band.up_to_sf)} sq ft`;
      const suffix = whole ? " of the job's total square feet)" : ')';
      result.push({
        ...line,
        quantity: take,
        area: take,
        unitPrice: price,
        total,
        description: `${line.description} (${mode} bracket: ${label}${suffix}`,
        priceBracket: { upToSf: band.up_to_sf, unitPrice: band.unit_price },
        bracketMode: mode,
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
  const known = new Set(items.map((item) => item.item_id));
  for (const key of Object.keys(data.scopeItems ?? {})) {
    if (!known.has(key)) warnings.push({ code: 'unknown_scope_item', item_id: key });
  }
  const categories = new Set(data.rooms.map((room) => room.category));
  const priced: Array<[Item, PriceLine[]]> = [];
  let extrasItem: Item | null = null;
  const enabled = items
    .filter((item) => item.enabled)
    .sort((left, right) => {
      const rank =
        (RANK.get(left.group) ?? GROUPS.length) - (RANK.get(right.group) ?? GROUPS.length);
      return rank || left.sort_order - right.sort_order;
    });
  for (const item of enabled) {
    if (item.group === EXTRAS) {
      extrasItem = item;
      if (unpricedQuantity(item, data)) {
        warnings.push({ code: 'unpriced_extras_quantity', item_id: item.item_id });
      }
    }
    if (blankPrice(item)) {
      warnings.push({ code: 'blank_price_item', item_id: item.item_id });
      continue;
    }
    if (item.group === EXTRAS) continue;
    const source = parseSource(item.quantity_source);
    if (source.kind === 'room') {
      priced.push([item, roomLines(item, source, data, policy, rooms, warnings)]);
      continue;
    }
    const allowed = item.categories;
    if (allowed.length && !allowed.some((category) => categories.has(category))) continue;
    const quantity = jobQuantity(item, source, data, job, numbers);
    if (truthy(quantity)) {
      const price = item.price_brackets ? ONE : Dec.parse(item.unit_price);
      const label = item.customer_description || item.name;
      priced.push([item, [makeLine(item, label, quantity, price, Dec.parse(item.waste_percent))]]);
    }
  }
  const area = policy.bracket_mode === 'whole-job' ? jobSf(data, items, policy) : null;
  const lines: PriceLine[] = [];
  for (const [item, itemLines] of priced) {
    if (!item.rows) {
      lines.push(...(item.price_brackets ? bracketLines(item.price_brackets, itemLines, policy, area, growth) : itemLines));
      continue;
    }
    for (const [brackets, group] of byRow(item, itemLines)) {
      lines.push(...(brackets ? bracketLines(brackets, group, policy, area, growth) : group));
    }
  }
  for (const extra of data.extras) {
    if (!extra.approval) continue;
    lines.push({
      code: EXTRA,
      itemId: null,
      group: EXTRAS,
      bucket: bucketOf(EXTRAS, EXTRA),
      description: extra.description,
      quantity: extra.hours,
      unit: 'hour',
      unitPrice: extra.approval.rate,
      waste: ZERO,
      total: money(extra.hours.mul(extra.approval.rate)),
      taxable: extrasItem?.taxable ?? false,
      materialsShare: Dec.parse(extrasItem?.materials_share_percent ?? '100'),
      afterHours: false,
      noOverheadProfit: extrasItem?.no_overhead_profit === true,
      trade: extrasItem?.trade ?? null,
      xactimateCode: '',
      room: null,
      area: null,
    });
  }
  applyLineMultipliers(lines, data, warnings);
  for (const addition of data.additions ?? []) if (addition.approvedAt !== null) lines.push(additionLine(addition, extrasItem));
  return { lines, warnings };
}

/** The code of a unit or flat addition's line, apart from an hourly additional work line (`EXTRA`). */
export const ADDITION = 'ADDITION';

/**
 * Each approved custom multiplier (S5b-8, owner decision B1) on the lines it names: the item's lines in
 * that room, or its job-wide lines. Like the category multiplier it applies at both ends of the range and
 * before overhead and profit, tax, minimums and after-hours, but to the line as priced: its unit price is
 * multiplied and its total, after waste and bracket pricing, is multiplied and rounded to the cent. The line
 * keeps its own description, with "x{multiplier}" beside it. One that matches no line changes nothing and
 * says so.
 */
function applyLineMultipliers(lines: PriceLine[], data: Inspection, warnings: EngineWarning[]): void {
  for (const entry of data.lineMultipliers ?? []) {
    const room = entry.room === null ? null : roomKey(entry.room);
    let matched = false;
    for (const line of lines) {
      if (line.itemId !== entry.itemId) continue;
      if ((line.room === null ? null : roomKey(line.room)) !== room) continue;
      matched = true;
      line.unitPrice = line.unitPrice.mul(entry.multiplier);
      line.total = money(line.total.mul(entry.multiplier));
      line.description = `${line.description} x${entry.multiplier.normalize().format('f')}`;
    }
    if (!matched) warnings.push({ code: 'unmatched_line_multiplier', item_id: entry.itemId, room: entry.room });
  }
}

/**
 * A unit or flat addition's line (S5b-8, owner decision B2): taxed by its own flag (all of it), carrying
 * overhead and profit, counted toward the job minimum and the additional work item's trade heading, never
 * after-hours, and in the additional work bucket, so it does not grow at the range's high end. It is never
 * part of the company's price table. Printed as the owner approved (B3).
 */
function additionLine(addition: NonNullable<Inspection['additions']>[number], extrasItem: Item | null): PriceLine {
  const date = addition.approvedAt!.slice(0, 10);
  const price = '$' + addition.price.format('.2f');
  const unit = addition.kind === 'unit';
  const quantity = unit ? addition.quantity! : ONE;
  const description = unit
    ? `${addition.description}: ${addition.quantity!.normalize().format('f')} ${addition.unit!} at ${price}/${addition.unit!}, approved on ${date}.`
    : `${addition.description}: ${price}, approved on ${date}.`;
  return {
    code: ADDITION,
    itemId: null,
    group: EXTRAS,
    bucket: bucketOf(EXTRAS, ADDITION),
    description,
    quantity,
    unit: unit ? addition.unit! : 'each',
    unitPrice: addition.price,
    waste: ZERO,
    total: money(quantity.mul(addition.price)),
    taxable: addition.taxable,
    materialsShare: HUNDRED,
    afterHours: false,
    noOverheadProfit: false,
    trade: extrasItem?.trade ?? null,
    xactimateCode: '',
    room: null,
    area: null,
  };
}

export function exactAmount(line: PriceLine): Dec {
  return line.quantity.mul(line.unitPrice).mul(ONE.add(line.waste.div(HUNDRED)));
}

export function sumBucket(lines: PriceLine[], bucket: string, taxable = false): Dec {
  return sumDec(
    lines
      .filter((line) => line.bucket === bucket && (line.taxable || !taxable))
      .map((line) => line.total),
    ZERO,
  );
}
