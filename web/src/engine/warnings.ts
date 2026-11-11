// Advisory warnings. They are derived, never stored on a document, and never change a price.

import { Dec, ZERO } from './decimal';
import type { JObj } from './json';
import type { Inspection, Room } from './inspection';
import { fieldDec } from './inspection';
import { priceScopeV2 } from './price-v2';
import { equipmentSizing, type Sizing } from './sizing';
import { COUNT_DAYS, FIELD_SOURCES, blankPrice, parseSource, type Table } from './table';
import { numberText, truthy } from './values';
import type { Priced } from './totals';

const COMPARABLE_LOW = Dec.parse('2').div(Dec.parse('3'));
const COMPARABLE_HIGH = Dec.parse('1.5');
const FAR_LOW = Dec.parse('0.5');
const FAR_HIGH = Dec.parse('2');
const MIN_JOBS = 5;
const EXTRAS = 'Additional work hours are only priced once the owner approves them.';
const QUANTITY_FIELDS = [...FIELD_SOURCES, ...[...new Set(COUNT_DAYS.map((pair) => pair[0]))].sort()];

export type HistoryRow = { category: number; sf: Dec; low: Dec };

function warning(code: string, text: string, room = ''): JObj {
  return { code, room, text };
}

function roomArea(room: Room, wet: boolean): Dec {
  if (!wet) return room.unfinishedSf.add(room.finishedSf);
  return room.wetFloorSf ?? room.floorSf ?? ZERO;
}

function sizingWarnings(sizing: Sizing): JObj[] {
  if (sizing.status !== 'available' || !sizing.air || !sizing.dehu) return [];
  const found: JObj[] = [];
  for (const [name, check] of [
    ['air_movers', sizing.air],
    ['dehumidifiers', sizing.dehu],
  ] as const) {
    if (check.flag === 'below' || check.flag === 'above') found.push(warning(`${name}_${check.flag}`, check.reason));
  }
  return found;
}

function roomWarnings(data: Inspection, table: Table): JObj[] {
  const sources = table.items.filter((item) => {
    if (!item.enabled || item.group === 'extras') return false;
    if (blankPrice(item)) return false;
    return parseSource(item.quantity_source).kind === 'room';
  });
  const wet = table.policy.area_basis === 'wet_floor';
  const found: JObj[] = [];
  for (const room of data.rooms) {
    const allows = (categories: number[]) => !categories.length || categories.includes(room.category);
    if (sources.some((item) => allows(item.categories))) continue;
    const area = roomArea(room, wet);
    const other = roomArea(room, !wet);
    const used = truthy(area) ? area : other;
    if (!truthy(used)) continue;
    const name = room.name.trim() || 'Unnamed room';
    found.push(
      warning(
        'unpriced_room',
        `${name}: ${numberText(used)} sq ft of category ${room.category} work prices nothing on your company's price list.`,
        name,
      ),
    );
  }
  return found;
}

function quantityText(quantity: Dec, name: string): JObj {
  return warning(
    'unpriced_quantity',
    `${numberText(quantity)} ${name.replaceAll('_', ' ')} entered, but your price list has no item for it.`,
  );
}

function quantityWarnings(data: Inspection, table: Table): JObj[] {
  const listed = new Set<string>();
  for (const item of table.items) {
    if (!item.enabled) continue;
    const source = parseSource(item.quantity_source);
    if (source.field) listed.add(source.field);
    if (source.countField) listed.add(source.countField);
  }
  const found: JObj[] = [];
  for (const field of QUANTITY_FIELDS) {
    if (listed.has(field)) continue;
    const quantity = fieldDec(data, field);
    if (quantity.cmp(ZERO) > 0) found.push(quantityText(quantity, field));
  }
  for (const row of priceScopeV2(data, table.items, table.policy).warnings) {
    if (row.code !== 'unknown_scope_item' || typeof row.item_id !== 'string') continue;
    const entry = data.scopeItems?.[row.item_id];
    if (!entry) continue;
    const quantity = entry.quantity.isZero() ? Dec.fromInt(entry.count * entry.days) : entry.quantity;
    if (truthy(quantity)) found.push(quantityText(quantity, row.item_id));
  }
  return found;
}

function median(values: Dec[]): Dec {
  const ordered = [...values].sort((left, right) => left.cmp(right));
  const mid = Math.floor(ordered.length / 2);
  const upper = ordered[mid] ?? ZERO;
  if (ordered.length % 2 === 1) return upper;
  const lower = ordered[mid - 1] ?? ZERO;
  return lower.add(upper).div(Dec.fromInt(2));
}

function typicalWarning(data: Inspection, table: Table | null, priced: Priced | null, history: HistoryRow[] | null): JObj[] {
  if (!priced || !history || history.length === 0) return [];
  const category = data.rooms.reduce((best, room) => Math.max(best, room.category), 1);
  const wet = table?.policy.area_basis === 'wet_floor';
  const area = sumArea(data, wet);
  const comparable = history
    .filter((row) => row.category === category && COMPARABLE_LOW.mul(area).cmp(row.sf) <= 0 && row.sf.cmp(COMPARABLE_HIGH.mul(area)) <= 0)
    .map((row) => row.low);
  if (comparable.length < MIN_JOBS) return [];
  const typical = median(comparable);
  const low = priced.totals.low.total;
  if (typical.cmp(ZERO) <= 0 || (FAR_LOW.mul(typical).cmp(low) <= 0 && low.cmp(FAR_HIGH.mul(typical)) <= 0)) return [];
  const ratio = low.div(typical).quantize(-1, 'HALF_UP');
  return [
    warning(
      'far_from_typical',
      `This estimate's low end is about ${ratio.toString()}\u00d7 your company's typical category ${category} job of this size (${comparable.length} signed jobs). Check the quantities before you finish.`,
    ),
  ];
}

function sumArea(data: Inspection, wet: boolean): Dec {
  return data.rooms.reduce((total, room) => total.add(roomArea(room, wet)), ZERO);
}

export function advisoryWarnings(data: Inspection, table: Table | null, priced: Priced | null, history: HistoryRow[] | null): JObj[] {
  const found = sizingWarnings(equipmentSizing(data));
  if (table) {
    const engine = priceScopeV2(data, table.items, table.policy).warnings;
    found.push(...roomWarnings(data, table));
    found.push(...quantityWarnings(data, table));
    if (engine.some((row) => row.code === 'unpriced_extras_quantity')) found.push(warning('unpriced_extras', EXTRAS));
  }
  found.push(...typicalWarning(data, table, priced, history));
  return found;
}
