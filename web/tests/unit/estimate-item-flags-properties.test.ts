// Properties of the per-item flags, trade minimums and materials share over seeded random tables and jobs
// (plan docs/plans/pricing.md section 6, step S4-4c). The seed is fixed, so a failure names a case that
// reproduces on every run. The tables here always carry the new keys; the older property scans are untouched.

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
const thousandths = (rng: Rng, low: number, high: number) => (int(rng, low * 1000, high * 1000) / 1000).toFixed(3);

const POOL: Array<[string, Obj]> = [
  ['demo_unfinished', { quantity_source: 'room:demolition:unfinished' }],
  ['demo_finished', { quantity_source: 'room:demolition:finished' }],
  ['floor_dry', { group: 'treatment', quantity_source: 'room:floor' }],
  ['basis_treat', { group: 'treatment', quantity_source: 'room:basis' }],
  ['typed_sf', { group: 'treatment', quantity_source: 'typed' }],
  ['labor', { group: 'labor', unit: 'hour', quantity_source: 'field:labor_hours' }],
  ['service_call', { group: 'job_charges', unit: 'each', quantity_source: 'field:emergency_calls' }],
  ['air_mover', { group: 'drying_equipment', unit: 'unit_day', quantity_source: 'count_days:air_movers*drying_days' }],
  ['dehu', { group: 'drying_equipment', unit: 'unit_day', quantity_source: 'count_days:dehumidifiers*drying_days' }],
];
const LABOR_GROUPS = new Set(['demolition', 'treatment', 'labor']);
const TRADE_IDS = ['drywall', 'flooring', 'mold_work'];

type Options = { flagAll?: boolean };

function randomTable(rng: Rng, options: Options = {}): Obj {
  const chosen = POOL.filter(([id]) => id === 'demo_unfinished' || chance(rng, 0.6));
  const items = chosen.map(([id, base]) => {
    const group = (base.group as string | undefined) ?? 'demolition';
    const body: Obj = { ...base, unit_price: cents(rng, 0.01, 60), taxable: chance(rng, 0.5) };
    if (LABOR_GROUPS.has(group) && (options.flagAll || chance(rng, 0.5))) body.after_hours = true;
    if (chance(rng, 0.3)) body.no_overhead_profit = true;
    if (body.taxable === true && chance(rng, 0.6)) body.materials_share_percent = cents(rng, 0, 100);
    if (chance(rng, 0.6)) body.trade = pick(rng, TRADE_IDS);
    if (chance(rng, 0.3)) body.waste_percent = String(int(rng, 1, 20));
    return item(id, body);
  });
  const first = int(rng, 0, 80);
  const changes: Obj = {
    estimate_mode: chance(rng, 0.85) ? 'range' : 'single',
    range: { first_sf: int(rng, 1, 2000), first_percent: String(first), beyond_percent: String(int(rng, 0, first)) },
    after_hours: { multiplier: thousandths(rng, 1, 2) },
    minimum_job_charge: chance(rng, 0.4) ? String(int(rng, 50, 2000)) : '0',
    overhead_profit_percent: chance(rng, 0.5) ? String(int(rng, 1, 20)) : '0',
    sales_tax: { enabled: chance(rng, 0.6), percent: thousandths(rng, 0, 15) },
  };
  if (chance(rng, 0.4)) {
    changes.assist = {
      drying_days: int(rng, 1, 10),
      range_method: 'uncertainty',
      extra_drying_days: int(rng, 0, 5),
      hidden_damage_percent: { '1': String(int(rng, 0, 30)), '2': String(int(rng, 0, 30)), '3': String(int(rng, 0, 30)) },
    };
  }
  const trades = TRADE_IDS.map((trade_id) => ({
    trade_id,
    name: trade_id.replaceAll('_', ' '),
    minimum_charge: chance(rng, 0.7) ? String(int(rng, 50, 1500)) : '0',
  }));
  return { items, trades, policy: policy(changes) };
}

function randomJob(rng: Rng, typed: boolean): Obj {
  const rooms = Array.from({ length: int(rng, 1, 3) }, (_, index) => ({
    name: `Room ${index + 1}`,
    category: int(rng, 1, 3),
    unfinished_sf: int(rng, 0, 300),
    finished_sf: chance(rng, 0.4) ? int(rng, 0, 300) : 0,
    ...(chance(rng, 0.6) ? { floor_sf: int(rng, 10, 400) } : {}),
  }));
  const changes: Obj = {
    labor_hours: int(rng, 0, 30),
    emergency_calls: int(rng, 0, 2),
    air_movers: int(rng, 0, 10),
    dehumidifiers: int(rng, 0, 4),
    drying_days: int(rng, 1, 7),
    is_after_hours: chance(rng, 0.5),
  };
  if (typed) changes.scope_items = { typed_sf: { quantity: String(int(rng, 1, 300)) } };
  return inspection(rooms, changes);
}

/** Add square feet or a quantity to one input; every room keeps its category. */
function grow(rng: Rng, base: Obj): Obj {
  const next = structuredClone(base) as Obj;
  const target = pick(rng, next.rooms as Obj[]);
  const more = int(rng, 1, 300);
  const add = (body: Obj, key: string, amount: number) => (body[key] = Number(body[key] ?? 0) + amount);
  const choice = int(rng, 0, 6);
  if (choice === 0) add(target, 'unfinished_sf', more);
  else if (choice === 1) add(target, 'finished_sf', more);
  else if (choice === 2) add(target, 'floor_sf', more);
  else if (choice === 3) add(next, 'labor_hours', int(rng, 1, 10));
  else if (choice === 4) add(next, 'emergency_calls', 1);
  else if (choice === 5) {
    add(next, 'air_movers', int(rng, 1, 4));
    add(next, 'dehumidifiers', 1);
  } else {
    const typed = (next.scope_items as Obj | undefined)?.typed_sf as Obj | undefined;
    if (typed) typed.quantity = String(Number(typed.quantity) + more);
    else add(target, 'unfinished_sf', more);
  }
  return next;
}

const centsOf = (amount: string): bigint => {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(2, '0')}`);
};

function price(tableJson: Json, inspectionJson: Obj): Estimate | null {
  const result = priceEstimate(tableJson, { inspection: inspectionJson });
  return result.ok ? result : null;
}

function cases(seed: number, count: number, options: Options = {}): Array<[Obj, Obj, Rng]> {
  const rng = seeded(seed);
  return Array.from({ length: count }, () => {
    const priceList = randomTable(rng, options);
    const typed = (priceList.items as Obj[]).some((row) => row.item_id === 'typed_sf');
    return [priceList, randomJob(rng, typed), rng];
  });
}

const highOf = (estimate: Estimate) => estimate.totals.high ?? estimate.totals.low;

describe('item flags, trade minimums and materials share: properties', { timeout: 120_000 }, () => {
  it('adding square feet or a quantity never lowers the low total, or the high total beyond rounding', () => {
    const problems: string[] = [];
    let compared = 0;
    let withMinimums = 0;
    let withFlags = 0;
    cases(20261112, 700).forEach(([priceList, before, rng], index) => {
      const base = price(priceList, before);
      if (!base) return;
      if (base.totals.low.trade_minimums.length) withMinimums += 1;
      if (base.totals.low.after_hours !== '0.00') withFlags += 1;
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
        // The cushion grows each trade's amount in proportion, in fractions of a cent, so a trade minimum that
        // binds can lose a cent to rounding at the high end: at most one cent per trade heading.
        if (centsOf(highOf(bigger).total) + BigInt(TRADE_IDS.length) < centsOf(highOf(base).total)) {
          problems.push(`case ${index}: high ${highOf(base).total} -> ${highOf(bigger).total}`);
        }
      }
    });
    expect(problems.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(1500);
    // The scan must reach the new rules, or it proves nothing about them.
    expect(withMinimums).toBeGreaterThan(150);
    expect(withFlags).toBeGreaterThan(150);
  });

  it('the high total is never below the low total, and each end equals its parts', () => {
    const problems: string[] = [];
    let checked = 0;
    cases(20261113, 600).forEach(([priceList, before], index) => {
      const result = price(priceList, before);
      if (!result) return;
      checked += 1;
      const { low, high } = result.totals;
      for (const end of high ? [low, high] : [low]) {
        const trades = end.trade_minimums.reduce((sum, row) => sum + centsOf(row.amount), 0n);
        const parts = [end.subtotal, end.after_hours, end.minimum_charge, end.overhead_profit, end.tax];
        const sum = parts.reduce((total, part) => total + centsOf(part), trades);
        if (sum !== centsOf(end.total)) problems.push(`case ${index}: parts ${sum} != ${end.total}`);
      }
      if (high && centsOf(high.total) < centsOf(low.total)) problems.push(`case ${index}: high ${high.total} < low ${low.total}`);
    });
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(450);
  });

  it('with every labor item flagged, the adjustment is the multiplier on all labor and materials, as before', () => {
    // The job-wide rule of dryscope-v2: round(labor and materials x (multiplier - 1)) at each end.
    const problems: string[] = [];
    let checked = 0;
    cases(20261114, 500, { flagAll: true }).forEach(([priceList, before], index) => {
      (priceList.policy as Obj).minimum_job_charge = '0';
      priceList.trades = [];
      for (const row of priceList.items as Obj[]) delete row.trade;
      const result = price(priceList, before);
      if (!result || before.is_after_hours !== true) return;
      checked += 1;
      const multiplier = Number((priceList.policy as { after_hours: { multiplier: string } }).after_hours.multiplier);
      const expected = (labor: string) => BigInt(Math.round((Number(labor) * (multiplier - 1) + Number.EPSILON) * 100));
      const ends: Array<[string, string]> = [[result.totals.low.after_hours, result.totals.labor_material_low]];
      if (result.totals.high) ends.push([result.totals.high.after_hours, result.totals.labor_material_high]);
      for (const [adjustment, labor] of ends) {
        // Allow one cent: the check above is in floating point, the engine in decimals.
        const difference = centsOf(adjustment) - expected(labor);
        if (difference > 1n || difference < -1n) problems.push(`case ${index}: ${adjustment} vs labor ${labor} x ${multiplier - 1}`);
      }
    });
    expect(problems.slice(0, 10)).toEqual([]);
    expect(checked).toBeGreaterThan(150);
  });

  it('a table with every new key left at its default prices the same as one without the keys', () => {
    let checked = 0;
    cases(20261115, 150).forEach(([priceList, before]) => {
      const plain = structuredClone(priceList);
      plain.trades = [];
      for (const row of plain.items as Obj[]) {
        delete row.after_hours;
        delete row.no_overhead_profit;
        delete row.materials_share_percent;
        delete row.trade;
      }
      const written = structuredClone(plain);
      for (const row of written.items as Obj[]) {
        row.after_hours = false;
        row.no_overhead_profit = false;
        row.materials_share_percent = '100';
      }
      const first = price(plain, before);
      if (!first) return;
      checked += 1;
      expect(price(written, before)).toEqual(first);
      expect(first.table_sha256).toBe(
        price({ items: plain.items, policy: plain.policy } as Json, before)?.table_sha256,
      );
    });
    expect(checked).toBeGreaterThan(100);
  });
});
