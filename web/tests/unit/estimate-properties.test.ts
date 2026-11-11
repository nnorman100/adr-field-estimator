// Properties of priceEstimate over seeded random tables and jobs (plan docs/plans/pricing.md section 6).
// The seed is fixed, so a failure names a case that reproduces on every run.

import { describe, expect, it } from 'vitest';

import {
  priceEstimate,
  type Estimate,
  type EstimateJob,
  type Json,
} from '../../src/engine/estimate';
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
const cents = (rng: Rng, low: number, high: number) =>
  (int(rng, low * 100, high * 100) / 100).toFixed(2);
const thousandths = (rng: Rng, low: number, high: number) =>
  (int(rng, low * 1000, high * 1000) / 1000).toFixed(3);

function bands(rng: Rng, field: 'unit_price' | 'percent'): Obj[] {
  const count = int(rng, 1, 3);
  let limit = 0;
  return Array.from({ length: count }, (_, index) => {
    limit += int(rng, 20, 400);
    const value = field === 'unit_price' ? cents(rng, 0.01, 20) : String(int(rng, 0, 60));
    return { up_to_sf: index === count - 1 ? null : limit, [field]: value };
  });
}

const POOL: Array<[string, Obj]> = [
  ['demo_unfinished', { quantity_source: 'room:demolition:unfinished' }],
  ['demo_finished', { quantity_source: 'room:demolition:finished' }],
  ['floor_dry', { group: 'treatment', quantity_source: 'room:floor' }],
  ['wet_clean', { group: 'treatment', quantity_source: 'room:wet_floor' }],
  ['basis_treat', { group: 'treatment', quantity_source: 'room:basis' }],
  ['typed_sf', { group: 'treatment', quantity_source: 'typed' }],
  ['labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours' }],
  [
    'service_call',
    { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls' },
  ],
  ['haul', { group: 'job_charges', unit: 'load', quantity_source: 'field:haul_loads' }],
  ['after_hours_fee', { group: 'job_charges', unit: 'each', quantity_source: 'after_hours' }],
  [
    'air_mover',
    {
      group: 'drying_equipment',
      unit: 'unit_day',
      quantity_source: 'count_days:air_movers*drying_days',
    },
  ],
  [
    'dehu',
    {
      group: 'drying_equipment',
      unit: 'unit_day',
      quantity_source: 'count_days:dehumidifiers*drying_days',
    },
  ],
];

function randomTable(rng: Rng, mode: 'tiered' | 'whole-job'): Obj {
  const chosen = POOL.filter(([id]) => id === 'demo_unfinished' || chance(rng, 0.5));
  const items = chosen.map(([id, base]) => {
    const body: Obj = { ...base, unit_price: cents(rng, 0.01, 60), taxable: chance(rng, 0.4) };
    if (chance(rng, 0.3)) body.waste_percent = String(int(rng, 1, 20));
    if (chance(rng, 0.3)) body.categories = [1, 2, 3].filter(() => chance(rng, 0.6));
    const sf = body.unit === undefined;
    const roomOrTyped =
      String(body.quantity_source).startsWith('room:') || body.quantity_source === 'typed';
    if (sf && roomOrTyped && chance(rng, 0.4)) {
      body.unit_price = '';
      body.price_brackets = bands(rng, 'unit_price');
    }
    return item(id, body);
  });
  const first = int(rng, 0, 80);
  const range: Obj = chance(rng, 0.3)
    ? { brackets: bands(rng, 'percent') }
    : {
        first_sf: int(rng, 1, 2000),
        first_percent: String(first),
        beyond_percent: String(int(rng, 0, first)),
      };
  const changes: Obj = {
    estimate_mode: chance(rng, 0.8) ? 'range' : 'single',
    area_basis: pick(rng, ['demolition', 'demolition_with_waste', 'wet_floor']),
    range,
    after_hours: { multiplier: thousandths(rng, 1, 2) },
    category_multipliers: {
      '1': thousandths(rng, 1, 1.5),
      '2': thousandths(rng, 1, 2),
      '3': thousandths(rng, 1, 3),
    },
    cabinetry: {
      multiplier: thousandths(rng, 1, 3),
      scope: pick(rng, ['finished_only', 'all_cat3']),
    },
    minimum_job_charge: chance(rng, 0.4) ? String(int(rng, 50, 2000)) : '0',
    overhead_profit_percent: chance(rng, 0.4) ? String(int(rng, 1, 20)) : '0',
    sales_tax: { enabled: chance(rng, 0.5), percent: thousandths(rng, 0, 15) },
    bracket_mode: mode,
  };
  if (chance(rng, 0.5)) {
    changes.assist = {
      drying_days: int(rng, 1, 10),
      range_method: pick(rng, ['cushion', 'uncertainty']),
      extra_drying_days: int(rng, 0, 5),
      hidden_damage_percent: {
        '1': String(int(rng, 0, 30)),
        '2': String(int(rng, 0, 30)),
        '3': String(int(rng, 0, 30)),
      },
    };
  }
  return { items, policy: policy(changes) };
}

function randomJob(rng: Rng, typed: boolean): Obj {
  const rooms = Array.from({ length: int(rng, 1, 4) }, (_, index) => {
    const body: Obj = {
      name: `Room ${index + 1}`,
      category: int(rng, 1, 3),
      unfinished_sf: int(rng, 0, 600),
      finished_sf: chance(rng, 0.5) ? int(rng, 0, 600) : 0,
      custom_cabinetry: chance(rng, 0.3),
    };
    if (chance(rng, 0.3)) body.waste_percent = int(rng, 1, 15);
    if (chance(rng, 0.6)) {
      const floor = int(rng, 10, 800);
      body.floor_sf = floor;
      if (chance(rng, 0.6)) body.wet_floor_sf = int(rng, 0, floor);
      if (chance(rng, 0.5)) {
        body.ceiling_height_ft = int(rng, 7, 12);
        body.water_class = int(rng, 1, 4);
      }
    }
    return body;
  });
  const changes: Obj = {
    labor_hours: int(rng, 0, 40),
    emergency_calls: int(rng, 0, 2),
    haul_loads: int(rng, 0, 3),
    air_movers: int(rng, 0, 12),
    dehumidifiers: int(rng, 0, 4),
    drying_days: int(rng, 1, 7),
    is_after_hours: chance(rng, 0.3),
  };
  if (chance(rng, 0.5)) changes.dehumidifier_ppd = int(rng, 50, 200);
  if (typed) changes.scope_items = { typed_sf: { quantity: String(int(rng, 1, 300)) } };
  return inspection(rooms, changes);
}

/** Add square feet or a quantity to one input; every room keeps its category. */
function grow(rng: Rng, base: Obj): Obj {
  const next = structuredClone(base) as Obj;
  const rooms = next.rooms as Obj[];
  const target = pick(rng, rooms);
  const more = int(rng, 1, 400);
  const add = (body: Obj, key: string, amount: number) =>
    (body[key] = Number(body[key] ?? 0) + amount);
  const choice = int(rng, 0, 9);
  if (choice === 0) add(target, 'unfinished_sf', more);
  else if (choice === 1) add(target, 'finished_sf', more);
  else if (choice === 2) {
    add(target, 'floor_sf', more);
    if (target.wet_floor_sf !== undefined) add(target, 'wet_floor_sf', more);
  } else if (choice === 3) {
    // A blank wet floor reads the whole floor, so growing it means growing the floor.
    if (target.wet_floor_sf === undefined && target.floor_sf !== undefined)
      add(target, 'floor_sf', more);
    else add(target, 'wet_floor_sf', more);
    if (target.floor_sf !== undefined && Number(target.floor_sf) < Number(target.wet_floor_sf)) {
      target.floor_sf = Number(target.wet_floor_sf);
    }
  } else if (choice === 4) add(next, 'labor_hours', int(rng, 1, 10));
  else if (choice === 5) add(next, 'emergency_calls', 1);
  else if (choice === 6) add(next, 'air_movers', int(rng, 1, 4));
  else if (choice === 7) add(next, 'drying_days', int(rng, 1, 3));
  else if (choice === 8) add(next, 'dehumidifiers', 1);
  else {
    const scope = next.scope_items as Obj | undefined;
    const typed = scope?.typed_sf as Obj | undefined;
    if (typed) typed.quantity = String(Number(typed.quantity) + more);
    else add(target, 'unfinished_sf', more);
  }
  return next;
}

function centsOf(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
}

function price(tableJson: Json, inspectionJson: Obj): Estimate | null {
  const result = priceEstimate(tableJson, { inspection: inspectionJson } satisfies EstimateJob);
  return result.ok ? result : null;
}

function cases(seed: number, count: number, mode: 'tiered' | 'whole-job'): Array<[Obj, Obj, Rng]> {
  const rng = seeded(seed);
  return Array.from({ length: count }, () => {
    const priceList = randomTable(rng, mode);
    const typed = (priceList.items as Obj[]).some((row) => row.item_id === 'typed_sf');
    return [priceList, randomJob(rng, typed), rng];
  });
}

describe('pricing properties', { timeout: 60_000 }, () => {
  it('adding square feet or a quantity never lowers the low or high total (tiered brackets)', () => {
    const problems: string[] = [];
    let compared = 0;
    cases(20261110, 400, 'tiered').forEach(([priceList, before, rng], index) => {
      const base = price(priceList, before);
      if (!base) return;
      for (let step = 0; step < 3; step += 1) {
        const after = grow(rng, before);
        const bigger = price(priceList, after);
        if (!bigger) {
          problems.push(`case ${index}: refused after growing`);
          continue;
        }
        compared += 1;
        if (centsOf(bigger.totals.low.total) < centsOf(base.totals.low.total)) {
          problems.push(
            `case ${index}: low ${base.totals.low.total} -> ${bigger.totals.low.total}`,
          );
        }
        const high = (estimate: Estimate) =>
          estimate.totals.high?.total ?? estimate.totals.low.total;
        if (centsOf(high(bigger)) < centsOf(high(base))) {
          problems.push(`case ${index}: high ${high(base)} -> ${high(bigger)}`);
        }
      }
    });
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(900);
  });

  it('the high total is never below the low total, and each total equals its lines plus adjustments', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const mode of ['tiered', 'whole-job'] as const) {
      cases(mode === 'tiered' ? 7 : 8, 300, mode).forEach(([priceList, before], index) => {
        const result = price(priceList, before);
        if (!result) return;
        checked += 1;
        const { low, high } = result.totals;
        const lines = result.lines.reduce((sum, line) => sum + centsOf(line.total), 0n);
        if (lines !== centsOf(low.subtotal))
          problems.push(`${mode} ${index}: lines ${lines} != ${low.subtotal}`);
        for (const end of high ? [low, high] : [low]) {
          const parts = [
            end.subtotal,
            end.after_hours,
            end.minimum_charge,
            end.overhead_profit,
            end.tax,
          ];
          const sum = parts.reduce((total, part) => total + centsOf(part), 0n);
          if (sum !== centsOf(end.total))
            problems.push(`${mode} ${index}: parts ${sum} != ${end.total}`);
        }
        if (high && centsOf(high.total) < centsOf(low.total)) {
          problems.push(`${mode} ${index}: high ${high.total} < low ${low.total}`);
        }
        if ((result.totals.mode === 'single') !== (high === null))
          problems.push(`${mode} ${index}: mode`);
      });
    }
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(450);
  });

  it('the same table gives the same content hash, whatever the item and key order', () => {
    const reorder = (value: Json): Json => {
      if (Array.isArray(value)) return value.map((entry) => reorder(entry));
      if (value === null || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reorder(entry)]),
      );
    };
    let checked = 0;
    for (const [priceList, before] of cases(99, 100, 'tiered')) {
      const first = price(priceList, before);
      if (!first) continue;
      checked += 1;
      expect(price(structuredClone(priceList), structuredClone(before))).toEqual(first);
      const shuffled = { ...priceList, items: [...(priceList.items as Obj[])].reverse() };
      expect(price(reorder(shuffled), before)?.table_sha256).toBe(first.table_sha256);
      const changed = structuredClone(priceList);
      const target = (changed.items as Obj[]).find(
        (row) => row.item_id === 'demo_unfinished',
      ) as Obj;
      target.unit_price = target.unit_price === '99.99' ? '99.98' : '99.99';
      delete target.price_brackets;
      expect(price(changed, before)?.table_sha256).not.toBe(first.table_sha256);
    }
    expect(checked).toBeGreaterThan(70);
  });
});
