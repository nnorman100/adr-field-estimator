// Properties of priceEstimate with per-room typed quantities (plan docs/plans/pricing.md step S4-4d):
// raising a room's typed quantity never lowers the low or the high total, and the high is never below
// the low, over seeded random tables and jobs. The seed is fixed, so a failure names a case that
// reproduces on every run.

import { describe, expect, it } from 'vitest';

import { priceEstimate, type Estimate, type Json } from '../../src/engine/estimate';
import { inspection, item, policy, type Obj } from './estimate-fixtures';

type Rng = () => number;

/** mulberry32: a small seeded generator, so no new dependency is needed. */
function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, low: number, high: number) => low + Math.floor(rng() * (high - low + 1));
const pick = <T>(rng: Rng, values: readonly T[]): T => values[int(rng, 0, values.length - 1)] as T;
const chance = (rng: Rng, p: number) => rng() < p;
const cents = (rng: Rng, low: number, high: number) => (int(rng, low * 100, high * 100) / 100).toFixed(2);

const CATEGORY_LIST: Json[] = [1, 2, 3, 'mold'];
const TYPED_IDS = ['flood_cut', 'carpet', 'baseboard', 'antimicrobial', 'dehu_room'] as const;

/** Category rows for a typed item: some categories, each with a unit price or, on a sq ft item, its own bands. */
function categoryRows(rng: Rng, sf: boolean, filter: Json[]): Obj[] {
  const rows: Obj[] = [];
  for (const category of filter.length ? filter : CATEGORY_LIST) {
    if (!chance(rng, 0.4)) continue;
    rows.push(sf && chance(rng, 0.4) ? { category, price_brackets: bands(rng) } : { category, unit_price: cents(rng, 0.01, 40) });
  }
  return rows;
}

function bands(rng: Rng): Obj[] {
  return [
    { up_to_sf: int(rng, 20, 200), unit_price: cents(rng, 0.01, 20) },
    { up_to_sf: null, unit_price: cents(rng, 0.01, 20) },
  ];
}

/** A typed item: linear feet, square feet (sometimes bracketed), each, or equipment days. */
function typedItem(rng: Rng, id: (typeof TYPED_IDS)[number]): Obj {
  const shapes: Record<(typeof TYPED_IDS)[number], Obj> = {
    flood_cut: { group: 'demolition', unit: 'lf' },
    carpet: { group: 'demolition', unit: 'sf' },
    baseboard: { group: 'labor', unit: 'lf' },
    antimicrobial: { group: 'treatment', unit: 'sf' },
    dehu_room: { group: 'drying_equipment', unit: 'unit_day' },
  };
  const shape = shapes[id];
  const body: Obj = { ...shape, quantity_source: 'room:typed', unit_price: cents(rng, 0.01, 40) };
  if (chance(rng, 0.3)) body.categories = [1, 2, 3, 'mold'].filter(() => chance(rng, 0.7));
  if ((body.categories as Json[] | undefined)?.length === 0) delete body.categories;
  if (chance(rng, 0.3)) body.waste_percent = String(int(rng, 1, 15));
  const sf = shape.unit === 'sf';
  if (sf && chance(rng, 0.4)) {
    body.unit_price = '';
    body.price_brackets = bands(rng);
  }
  if (chance(rng, 0.5)) body.rows = categoryRows(rng, sf, (body.categories as Json[] | undefined) ?? []);
  if (body.group !== 'drying_equipment' && chance(rng, 0.3)) body.after_hours = true;
  if (chance(rng, 0.3)) body.taxable = true;
  return item(id, body);
}

function randomTable(rng: Rng): Obj {
  const items: Obj[] = TYPED_IDS.filter(() => chance(rng, 0.75)).map((id) => typedItem(rng, id));
  if (!items.length) items.push(typedItem(rng, 'flood_cut'));
  if (chance(rng, 0.6)) items.push(item('demo_unfinished', { unit_price: cents(rng, 0.01, 30) }));
  if (chance(rng, 0.4)) items.push(item('hours', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours', unit_price: cents(rng, 10, 90) }));
  const first = int(rng, 0, 60);
  const changes: Obj = {
    estimate_mode: chance(rng, 0.8) ? 'range' : 'single',
    area_basis: pick(rng, ['demolition', 'demolition_with_waste', 'wet_floor']),
    range: { first_sf: int(rng, 1, 600), first_percent: String(first), beyond_percent: String(int(rng, 0, first)) },
    after_hours: { multiplier: '1.250' },
    category_multipliers: { '1': '1', '2': '1.200', '3': '1.500' },
    minimum_job_charge: chance(rng, 0.3) ? String(int(rng, 50, 1000)) : '0',
    overhead_profit_percent: chance(rng, 0.3) ? String(int(rng, 1, 20)) : '0',
    sales_tax: { enabled: chance(rng, 0.5), percent: '8.250' },
  };
  if (chance(rng, 0.5)) {
    changes.assist = {
      drying_days: int(rng, 1, 8),
      range_method: pick(rng, ['cushion', 'uncertainty']),
      extra_drying_days: int(rng, 0, 4),
      hidden_damage_percent: { '1': String(int(rng, 0, 30)), '2': String(int(rng, 0, 30)), '3': String(int(rng, 0, 30)) },
    };
  }
  return { items, policy: policy(changes) };
}

/** A typed quantity: whole or with cents. */
function quantity(rng: Rng): string {
  return chance(rng, 0.5) ? String(int(rng, 0, 200)) : cents(rng, 0, 200);
}

/** Rooms list some of the table's typed items; categories stay fixed for the whole scan. */
function randomJob(rng: Rng, tableJson: Obj): Obj {
  const ids = (tableJson.items as Obj[]).filter((entry) => entry.quantity_source === 'room:typed').map((entry) => String(entry.item_id));
  const rooms = Array.from({ length: int(rng, 1, 4) }, (_, index) => ({
    name: `Room ${index + 1}`,
    category: pick(rng, CATEGORY_LIST),
    unfinished_sf: chance(rng, 0.5) ? int(rng, 0, 150) : 0,
    items: ids.filter(() => chance(rng, 0.6)).map((id) => ({ item_id: id, quantity: quantity(rng) })),
  }));
  return inspection(rooms, { labor_hours: int(rng, 0, 20), is_after_hours: chance(rng, 0.3) });
}

/** Raise one typed quantity in one room, or list an item the room did not list yet. */
function raise(rng: Rng, base: Obj, tableJson: Obj): Obj {
  const next = structuredClone(base) as Obj;
  const target = pick(rng, next.rooms as Obj[]);
  const list = target.items as Obj[];
  const ids = (tableJson.items as Obj[]).filter((entry) => entry.quantity_source === 'room:typed').map((entry) => String(entry.item_id));
  const missing = ids.filter((id) => !list.some((entry) => entry.item_id === id));
  const more = chance(rng, 0.5) ? int(rng, 1, 300) : Number(cents(rng, 0.01, 50));
  if (list.length && (!missing.length || chance(rng, 0.7))) {
    const entry = pick(rng, list);
    entry.quantity = (Number(entry.quantity) + more).toFixed(2);
  } else if (missing.length) {
    list.push({ item_id: pick(rng, missing), quantity: more.toFixed(2) });
  }
  return next;
}

function centsOf(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
}

function price(tableJson: Json, inspectionJson: Obj): Estimate | null {
  const result = priceEstimate(tableJson, { inspection: inspectionJson });
  return result.ok ? result : null;
}

const high = (estimate: Estimate) => estimate.totals.high?.total ?? estimate.totals.low.total;

describe('room item properties', { timeout: 60_000 }, () => {
  it('raising a typed room quantity never lowers either total (tiered)', () => {
    const problems: string[] = [];
    let compared = 0;
    let typedLines = 0;
    let rowLines = 0;
    let bracketLines = 0;
    const rng = seeded(20261114);
    for (let index = 0; index < 1200; index += 1) {
      const priceList = randomTable(rng);
      const before = randomJob(rng, priceList);
      const base = price(priceList, before);
      // A job whose typed quantities price nothing totals $0.00 and is refused; raising it is still compared below.
      for (let step = 0; step < 3; step += 1) {
        const after = raise(rng, before, priceList);
        const bigger = price(priceList, after);
        if (!bigger) {
          if (base) problems.push(`case ${index}: refused after raising`);
          continue;
        }
        if (!base) continue;
        compared += 1;
        if (centsOf(bigger.totals.low.total) < centsOf(base.totals.low.total)) {
          problems.push(`case ${index}: low ${base.totals.low.total} -> ${bigger.totals.low.total}`);
        }
        if (centsOf(high(bigger)) < centsOf(high(base))) {
          problems.push(`case ${index}: high ${high(base)} -> ${high(bigger)}`);
        }
      }
      if (!base) continue;
      const typed = base.lines.filter((line) => line.room !== null && line.item_id !== 'demo_unfinished');
      if (typed.length) typedLines += 1;
      if (typed.some((line) => /^[^:]*, (Cat \d|Mold): /.test(line.description))) rowLines += 1;
      if (typed.some((line) => line.price_bracket !== null)) bracketLines += 1;
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(2500);
    // The scan has to reach the rules it guards: typed lines, category rows on them and brackets on them.
    expect(typedLines).toBeGreaterThan(900);
    expect(rowLines).toBeGreaterThan(200);
    expect(bracketLines).toBeGreaterThan(200);
  });

  it('with typed quantities the high total is never below the low total, and the lines add up to the subtotal', () => {
    const problems: string[] = [];
    const rng = seeded(20261115);
    let checked = 0;
    for (let index = 0; index < 500; index += 1) {
      const priceList = randomTable(rng);
      const result = price(priceList, randomJob(rng, priceList));
      if (!result) continue;
      checked += 1;
      const { low } = result.totals;
      const lines = result.lines.reduce((sum, line) => sum + centsOf(line.total), 0n);
      if (lines !== centsOf(low.subtotal)) problems.push(`case ${index}: lines ${lines} != ${low.subtotal}`);
      if (centsOf(high(result)) < centsOf(low.total)) problems.push(`case ${index}: high ${high(result)} < low ${low.total}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });
});
