// Properties of priceEstimate with room inputs (plan docs/plans/pricing.md section 6, step S4-4b):
// size tiers, per-room items, mold conditions, containment bands and room-type rows, over seeded
// random tables and jobs. The seed is fixed, so a failure names a case that reproduces on every run.

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
const TYPE_IDS = ['kitchen', 'bathroom', 'other'] as const;

/** Four prices that never fall as the room grows, as the schema requires. */
function tierPrices(rng: Rng): Obj {
  const first = int(rng, 1, 80);
  const second = first + int(rng, 0, 60);
  const third = second + int(rng, 0, 90);
  return { s: `${first}.00`, m: `${second}.00`, l: `${third}.00`, xl: `${third + int(rng, 0, 120)}.00` };
}

/** Rows for an item: some categories, some room types, some of each. */
function randomRows(rng: Rng, perRoomItem: boolean, filter: Json[]): Obj[] {
  const price = (): Obj => (perRoomItem ? { tier_prices: tierPrices(rng) } : { unit_price: cents(rng, 0.01, 60) });
  const rows: Obj[] = [];
  for (const category of filter.length ? filter : CATEGORY_LIST) {
    if (chance(rng, 0.4)) rows.push({ category, ...price() });
  }
  for (const type of TYPE_IDS) {
    if (chance(rng, 0.5)) rows.push({ room_type: type, ...price() });
    for (const category of filter.length ? filter : CATEGORY_LIST) {
      if (chance(rng, 0.2)) rows.push({ room_type: type, category, ...price() });
    }
  }
  return rows;
}

/** A per-room item has tier prices and no unit price. */
function perRoomItem(id: string, changes: Obj): Obj {
  const body = item(id, { group: 'treatment', unit: 'room', quantity_source: 'room:each', ...changes });
  delete body.unit_price;
  return body;
}

function randomTable(rng: Rng): Obj {
  const items: Obj[] = [];
  const sf = (id: string, source: string, changes: Obj = {}): Obj => {
    const body: Obj = { quantity_source: source, unit_price: cents(rng, 0.01, 40), ...changes };
    if (chance(rng, 0.3)) body.waste_percent = String(int(rng, 1, 15));
    if (chance(rng, 0.3)) {
      body.unit_price = '';
      body.price_brackets = [
        { up_to_sf: int(rng, 20, 200), unit_price: cents(rng, 0.01, 20) },
        { up_to_sf: null, unit_price: cents(rng, 0.01, 20) },
      ];
    }
    if (chance(rng, 0.6)) body.rows = randomRows(rng, false, (body.categories as Json[] | undefined) ?? []);
    return item(id, body);
  };
  items.push(sf('demo_unfinished', 'room:demolition:unfinished', { taxable: chance(rng, 0.4) }));
  if (chance(rng, 0.5)) items.push(sf('floor_dry', 'room:floor', { group: 'treatment' }));
  if (chance(rng, 0.7)) {
    const body: Obj = { group: 'treatment', unit: 'room', quantity_source: 'room:each', tier_prices: tierPrices(rng) };
    if (chance(rng, 0.3)) body.categories = [1, 2, 3].filter(() => chance(rng, 0.7));
    if (chance(rng, 0.6)) body.rows = randomRows(rng, true, (body.categories as Json[] | undefined) ?? []);
    items.push(perRoomItem('contents', body));
  }
  if (chance(rng, 0.7)) {
    items.push(
      sf('mold_removal', 'room:demolition:finished', { group: 'treatment', categories: ['mold'], mold_conditions: [3] }),
      sf('mold_cleaning', 'room:demolition:unfinished', { group: 'treatment', categories: ['mold'], mold_conditions: [2, 3] }),
    );
  }
  if (chance(rng, 0.7)) {
    for (const [id, band] of [
      ['contain_small', 'up_to_10'],
      ['contain_medium', 'over_10_to_100'],
      ['contain_large', 'over_100'],
    ] as const) {
      items.push(
        perRoomItem(id, { tier_prices: tierPrices(rng), categories: ['mold'], affected_bands: [band] }),
      );
    }
  }
  const first = int(rng, 0, 60);
  const changes: Obj = {
    estimate_mode: chance(rng, 0.8) ? 'range' : 'single',
    area_basis: pick(rng, ['demolition', 'demolition_with_waste', 'wet_floor']),
    range: { first_sf: int(rng, 1, 1500), first_percent: String(first), beyond_percent: String(int(rng, 0, first)) },
    after_hours: { multiplier: '1.250' },
    category_multipliers: { '1': '1', '2': '1.200', '3': '1.500' },
    cabinetry: { multiplier: '1.100', scope: pick(rng, ['finished_only', 'all_cat3']) },
    minimum_job_charge: chance(rng, 0.3) ? String(int(rng, 50, 1000)) : '0',
    overhead_profit_percent: chance(rng, 0.3) ? String(int(rng, 1, 20)) : '0',
    sales_tax: { enabled: chance(rng, 0.5), percent: '8.250' },
    size_tiers: { s_up_to_sf: int(rng, 40, 120), m_up_to_sf: int(rng, 121, 250), l_up_to_sf: int(rng, 251, 500) },
    room_type_pricing: chance(rng, 0.6),
    room_types: [
      { id: 'kitchen', name: 'Kitchen' },
      { id: 'bathroom', name: 'Bathroom' },
    ],
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

/** Rooms keep their category, room type, mold condition, affected area and confirmed tier for the whole scan. */
function randomJob(rng: Rng): Obj {
  const rooms = Array.from({ length: int(rng, 1, 4) }, (_, index) => {
    const body: Obj = {
      name: `Room ${index + 1}`,
      category: pick(rng, CATEGORY_LIST),
      unfinished_sf: int(rng, 0, 150),
      finished_sf: chance(rng, 0.5) ? int(rng, 0, 150) : 0,
      custom_cabinetry: chance(rng, 0.3),
    };
    if (chance(rng, 0.7)) body.floor_sf = int(rng, 10, 400);
    if (chance(rng, 0.7)) body.room_type_id = pick(rng, [...TYPE_IDS, 'garage']);
    if (chance(rng, 0.8)) body.mold_condition = int(rng, 1, 3);
    if (chance(rng, 0.8)) body.affected_sf = int(rng, 1, 150);
    if (chance(rng, 0.15)) body.size_tier = pick(rng, ['s', 'm', 'l', 'xl']);
    return body;
  });
  return inspection(rooms, { labor_hours: int(rng, 0, 20), is_after_hours: chance(rng, 0.3) });
}

/** Add square feet to one area of one room, or hours to the job. Nothing that selects a row or an item changes. */
function grow(rng: Rng, base: Obj): Obj {
  const next = structuredClone(base) as Obj;
  const target = pick(rng, next.rooms as Obj[]);
  const more = int(rng, 1, 300);
  const add = (body: Obj, key: string, amount: number) => (body[key] = Number(body[key] ?? 0) + amount);
  const choice = int(rng, 0, 3);
  if (choice === 0) add(target, 'unfinished_sf', more);
  else if (choice === 1) add(target, 'finished_sf', more);
  else if (choice === 2) add(target, 'floor_sf', more);
  else add(next, 'labor_hours', int(rng, 1, 10));
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

describe('room input properties', { timeout: 60_000 }, () => {
  it('adding square feet or hours never lowers either total, with size tiers, per-room items, mold filters and room-type rows (tiered)', () => {
    const problems: string[] = [];
    let compared = 0;
    let perRoomLines = 0;
    let typeRows = 0;
    let moldLines = 0;
    const rng = seeded(20261112);
    for (let index = 0; index < 1200; index += 1) {
      const priceList = randomTable(rng);
      const before = randomJob(rng);
      const base = price(priceList, before);
      if (!base) {
        problems.push(`case ${index}: refused`);
        continue;
      }
      if (base.lines.some((line) => line.unit === 'room')) perRoomLines += 1;
      if (base.lines.some((line) => /^[^:]*, (Kitchen|Bathroom|Other)(, Cat \d|, Mold)?: /.test(line.description))) typeRows += 1;
      if (base.lines.some((line) => /mold (removal|cleaning)/.test(line.description))) moldLines += 1;
      for (let step = 0; step < 3; step += 1) {
        const bigger = price(priceList, grow(rng, before));
        if (!bigger) {
          problems.push(`case ${index}: refused after growing`);
          continue;
        }
        compared += 1;
        if (centsOf(bigger.totals.low.total) < centsOf(base.totals.low.total)) {
          problems.push(`case ${index}: low ${base.totals.low.total} -> ${bigger.totals.low.total}`);
        }
        const high = (estimate: Estimate) => estimate.totals.high?.total ?? estimate.totals.low.total;
        if (centsOf(high(bigger)) < centsOf(high(base))) {
          problems.push(`case ${index}: high ${high(base)} -> ${high(bigger)}`);
        }
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(3000);
    // The scan has to reach the rules it guards, not only the old ones.
    expect(perRoomLines).toBeGreaterThan(500);
    expect(typeRows).toBeGreaterThan(300);
    expect(moldLines).toBeGreaterThan(200);
  });

  it('the high total is never below the low total, and each total equals its lines plus adjustments', () => {
    const problems: string[] = [];
    const rng = seeded(20261113);
    let checked = 0;
    for (let index = 0; index < 500; index += 1) {
      const result = price(randomTable(rng), randomJob(rng));
      if (!result) continue;
      checked += 1;
      const { low, high } = result.totals;
      const lines = result.lines.reduce((sum, line) => sum + centsOf(line.total), 0n);
      if (lines !== centsOf(low.subtotal)) problems.push(`case ${index}: lines ${lines} != ${low.subtotal}`);
      if (high && centsOf(high.total) < centsOf(low.total)) problems.push(`case ${index}: high ${high.total} < low ${low.total}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it('turning room-type rows off prices exactly as a table that never had them', () => {
    const problems: string[] = [];
    const rng = seeded(20261114);
    let compared = 0;
    for (let index = 0; index < 400; index += 1) {
      const priceList = randomTable(rng);
      (priceList.policy as Obj).room_type_pricing = false;
      const stripped = structuredClone(priceList);
      for (const entry of stripped.items as Obj[]) {
        if (entry.rows) {
          entry.rows = (entry.rows as Obj[]).filter((row) => row.room_type === undefined);
        }
      }
      const job = randomJob(rng);
      const withRows = price(priceList, job);
      const without = price(stripped, job);
      if (!withRows || !without) continue;
      compared += 1;
      if (JSON.stringify([withRows.lines, withRows.totals, withRows.warnings]) !== JSON.stringify([without.lines, without.totals, without.warnings])) {
        problems.push(`case ${index}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(300);
  });
});
