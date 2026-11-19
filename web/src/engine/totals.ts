// Low and high ends of a v3 estimate. Summary amounts are decimal strings; cents use HALF_UP once.

import {
  adjustments,
  exemptCharged,
  mixOf,
  minimumTotal,
  settle,
  tradeMinimums,
  type Entry,
  type TradeMinimum,
} from './adjust';
import { Dec, HUNDRED, ONE, ZERO, maxDec, minDec, money, percentText, sumDec } from './decimal';
import type { JObj, Json } from './json';
import type { Inspection } from './inspection';
import { fieldDec } from './inspection';
import { exactAmount, jobSf, priceScopeV2, sumBucket, type EngineWarning } from './price-v2';
import { equipmentSizing } from './sizing';
import {
  DEFAULT_AFTER_HOURS_LABEL,
  ENGINE_VERSION,
  cushionBrackets,
  hasCushionBrackets,
  type CushionBand,
  type Item,
  type Policy,
  type Table,
  type Trade,
} from './table';
import { commas, numberText, type Category, type PriceLine } from './values';

const MINIMUM_CHARGE_LABEL = 'Minimum job charge';

/** The hidden-damage percent key for a room: a Mold room uses the category 3 percent. */
function hiddenKey(category: Category): '1' | '2' | '3' {
  return category === 'mold' ? '3' : (String(category) as '1' | '2' | '3');
}
const BUCKETS = new Set(['fixed', 'equipment', 'labor_material']);

export type End = {
  subtotal: Dec;
  afterHours: Dec;
  /** What each trade heading under its minimum is short of it, in trade-id order. */
  tradeMinimums: TradeMinimum[];
  minimumCharge: Dec;
  overheadProfit: Dec;
  tax: Dec;
  /** What price-point rounding added, untaxed and outside every bucket; zero when off or already a price point. */
  pricePoint: Dec;
  total: Dec;
};

export type Totals = {
  mode: 'range' | 'single';
  low: End;
  high: End | null;
  laborMaterialLow: Dec;
  laborMaterialHigh: Dec;
  afterHoursLabel: string;
  minimumChargeLabel: string;
  explanation: string;
  rangeExplanation: string | null;
  uncertainty: JObj | null;
};

export type Priced = {
  lines: PriceLine[];
  totals: Totals;
  warnings: EngineWarning[];
  calculationVersion: string;
};

type Amount = { kind: 'dec'; dec: Dec } | { kind: 'int'; int: number };
type AreaRow = { total: Dec; area: Dec };

function asDec(amount: Amount): Dec {
  return amount.kind === 'int' ? Dec.fromInt(amount.int) : amount.dec;
}

function typedMax(left: Amount, right: Amount): Amount {
  return asDec(left).cmp(asDec(right)) >= 0 ? left : right;
}

function sameAmount(amount: Amount, other: number | null): boolean {
  if (other === null) return false;
  return asDec(amount).cmp(Dec.fromInt(other)) === 0;
}

function counted(amount: Amount, noun: string): string {
  const text = numberText(asDec(amount));
  const one = amount.kind === 'int' ? amount.int === 1 : amount.dec.cmp(ONE) === 0;
  return `${text} ${noun}${one ? '' : 's'}`;
}

function entered(data: Inspection, field: string): Dec {
  return data.quantityOverrides?.[field]?.entered ?? fieldDec(data, field);
}

export function highNumbers(data: Inspection, policy: Policy): {
  air: Amount;
  dehu: Amount;
  days: Dec;
  available: boolean;
} {
  const assist = policy.assist;
  const sizing = equipmentSizing(data);
  const available = sizing.status === 'available';
  let air: Amount = { kind: 'dec', dec: entered(data, 'air_movers') };
  let dehu: Amount = { kind: 'dec', dec: entered(data, 'dehumidifiers') };
  if (available && sizing.air?.max != null) air = typedMax(air, { kind: 'int', int: sizing.air.max });
  if (available && sizing.dehu?.recommendedUnits != null) {
    dehu = typedMax(dehu, { kind: 'int', int: sizing.dehu.recommendedUnits });
  }
  return {
    air,
    dehu,
    days: entered(data, 'drying_days').add(Dec.fromInt(assist.extra_drying_days)),
    available,
  };
}

function uncertaintyJson(data: Inspection, policy: Policy): JObj {
  const numbers = highNumbers(data, policy);
  const hidden: JObj = { ...policy.assist.hidden_damage_percent };
  const amount = (value: Amount): Json => (value.kind === 'int' ? value.int : value.dec.toString());
  return {
    air_movers: amount(numbers.air),
    dehumidifiers: amount(numbers.dehu),
    drying_days: numbers.days.toString(),
    hidden_damage_percent: hidden,
    sizing_available: numbers.available,
  };
}

function factors(data: Inspection, policy: Policy): Record<string, Dec> {
  const numbers = highNumbers(data, policy);
  return {
    air_movers: asDec(numbers.air),
    dehumidifiers: asDec(numbers.dehu),
    drying_days: numbers.days,
  };
}

function roomPercents(data: Inspection, policy: Policy): Map<string, Dec> {
  const percents = new Map<string, Dec>();
  for (const room of data.rooms) {
    const percent = Dec.parse(policy.assist.hidden_damage_percent[hiddenKey(room.category)]).div(HUNDRED);
    percents.set(room.name, maxDec(percents.get(room.name) ?? ZERO, percent));
  }
  return percents;
}

type Ranked = { rows: AreaRow[]; totalArea: () => Dec; order: () => { row: AreaRow; index: number }[] };

/** The rows with their total area, worked out on first use, and their order dearest rate first (ties keep their line order). */
function rankRows(rows: AreaRow[]): Ranked {
  let total: Dec | null = null;
  return {
    rows,
    totalArea: () => {
      total ??= sumDec(rows.map((row) => row.area), ZERO);
      return total;
    },
    order: () => {
      const rated = rows.map((row, index) => ({ row, index, rate: row.total.div(row.area) }));
      rated.sort((left, right) => right.rate.cmp(left.rate));
      return rated;
    },
  };
}

/** Each row's dollars within the dearest `first` square feet, by row index, in the order they are taken. */
function topShares(ranked: Ranked, first: Dec): Map<number, Dec> {
  const shares = new Map<number, Dec>();
  const { rows } = ranked;
  if (ranked.totalArea().cmp(first) <= 0) {
    rows.forEach((row, index) => shares.set(index, row.total));
    return shares;
  }
  let remaining = first;
  for (const { row, index } of ranked.order()) {
    const take = minDec(remaining, row.area);
    shares.set(index, take.eq(row.area) ? row.total : row.total.mul(take).div(row.area));
    remaining = remaining.sub(take);
    if (remaining.isZero()) break;
  }
  return shares;
}

/**
 * Each row's allowance across the bands, by row index: what the row adds to its share of the dearest square feet at
 * each band, at that band's percent. One walk down the rows dearest first; each band's area left is cut by every row
 * in turn, as a walk per band would, and a row divides only at the bands whose area left ends within its own square
 * feet, so the divisions grow with rows plus bands, not rows times bands.
 */
function bandAllowances(ranked: Ranked, bands: CushionBand[]): Dec[] {
  const steps = bands.map((band) => {
    const limit = band.up_to_sf === null ? null : Dec.fromInt(band.up_to_sf);
    return { left: limit !== null && ranked.totalArea().cmp(limit) > 0 ? limit : null, percent: Dec.parse(band.percent) };
  });
  const walk = steps.some((step) => step.left !== null)
    ? ranked.order()
    : ranked.rows.map((row, index) => ({ row, index }));
  const allowances = ranked.rows.map(() => ZERO);
  let start = 0;
  for (const { row, index } of walk) {
    while (steps[start]?.left?.isZero()) start += 1;
    let previous = ZERO;
    let allowance = ZERO;
    let whole = false;
    for (let band = start; band < steps.length; band += 1) {
      const step = steps[band];
      if (!step || (whole && step.left === null)) break;
      const take = step.left === null ? row.area : minDec(step.left, row.area);
      if (step.left !== null) step.left = step.left.sub(take);
      if (whole) continue;
      const share = take.eq(row.area) ? row.total : row.total.mul(take).div(row.area);
      allowance = allowance.add(share.sub(previous).mul(step.percent).div(HUNDRED));
      previous = share;
      whole = share === row.total;
    }
    allowances[index] = allowance;
  }
  return allowances;
}

function cushionRows(lines: PriceLine[], policy: Policy): AreaRow[] {
  const wasteCounts = policy.area_basis === 'demolition_with_waste';
  return lines.map((line) => {
    const area = line.area ?? ZERO;
    const counted =
      wasteCounts && !line.priceBracket ? area.mul(ONE.add(line.waste.div(HUNDRED))) : area;
    return { total: line.priceBracket ? exactAmount(line) : line.total, area: counted };
  });
}

function bandFor(bands: CushionBand[], area: Dec): CushionBand {
  const band = bands.find((row) => row.up_to_sf === null || area.cmp(Dec.fromInt(row.up_to_sf)) <= 0);
  if (!band) throw new Error('cushion');
  return band;
}

/**
 * Each labor line's own grown amount, unrounded: the dearest square feet at their band's percent, the rest of the
 * area at the later percents, other labor at the first percent, and in whole-job mode every line at the job's one
 * percent. `settle` puts the amounts into cents.
 */
function cushion(data: Inspection, policy: Policy, items: Item[], labor: PriceLine[]): Entry[] {
  const areaLines = labor.filter((line) => line.area !== null);
  const bands = cushionBrackets(policy);
  const areas = cushionRows(areaLines, policy);
  const ranked = rankRows(areas);
  const inPricedOrder = (areaAmounts: Dec[], otherPercent: Dec): Entry[] => {
    const byLine = new Map(areaLines.map((line, index) => [line, areaAmounts[index] ?? line.total]));
    return labor.map((line) => ({ line, amount: byLine.get(line) ?? line.total.mul(ONE.add(otherPercent)) }));
  };
  if (policy.bracket_mode === 'whole-job') {
    const percent = Dec.parse(bandFor(bands, jobSf(data, items, policy)).percent).div(HUNDRED);
    return labor.map((line) => ({ line, amount: line.total.mul(ONE.add(percent)) }));
  }
  const firstBand = bands[0];
  const secondBand = bands[1];
  if (bands.length === 2 && firstBand && secondBand && !areaLines.some((line) => line.priceBracket)) {
    const first = Dec.parse(firstBand.percent).div(HUNDRED);
    const beyond = Dec.parse(secondBand.percent).div(HUNDRED);
    if (firstBand.up_to_sf === null) throw new Error('cushion');
    const shares = topShares(ranked, Dec.fromInt(firstBand.up_to_sf));
    return inPricedOrder(
      areaLines.map((line, index) => ONE.add(beyond).mul(line.total).add(first.sub(beyond).mul(shares.get(index) ?? ZERO))),
      first,
    );
  }
  const allowances = bandAllowances(ranked, bands);
  const firstPercent = Dec.parse(firstBand?.percent ?? '0').div(HUNDRED);
  return inPricedOrder(
    areaLines.map((line, index) => line.total.add(allowances[index] ?? ZERO)),
    firstPercent,
  );
}

/** The high end's labor lines at their grown amounts, unrounded, and its equipment lines, which are whole cents. */
function uncertain(data: Inspection, lines: PriceLine[], items: Item[], policy: Policy): {
  laborEntries: Entry[];
  equipmentEntries: Entry[];
} {
  const percents = roomPercents(data, policy);
  const largest = [...percents.values()].reduce((best, value) => maxDec(best, value), ZERO);
  const growth = (line: PriceLine): Dec => {
    if (line.bucket !== 'labor_material') return ZERO;
    if (line.room === null) return largest;
    return percents.get(line.room) ?? largest;
  };
  const high = priceScopeV2(data, items, policy, factors(data, policy), growth).lines;
  const laborEntries: Entry[] = [];
  const bracketed = new Map<string, Entry>();
  const mixed = [
    ...lines.filter((line) => !line.priceBracket),
    ...high.filter((line) => line.priceBracket),
  ];
  for (const line of mixed) {
    if (line.bucket !== 'labor_material') continue;
    if (line.priceBracket) {
      const key = `${line.itemId ?? ''}\u0000${line.priceRow ?? ''}`;
      const prior = bracketed.get(key);
      bracketed.set(key, {
        line: prior?.line ?? line,
        amount: (prior?.amount ?? ZERO).add(exactAmount(line).mul(ONE.add(growth(line)))),
      });
      continue;
    }
    laborEntries.push({ line, amount: line.total.mul(ONE.add(growth(line))) });
  }
  for (const row of bracketed.values()) laborEntries.push({ line: row.line, amount: money(row.amount) });
  return {
    laborEntries,
    equipmentEntries: high.filter((line) => line.bucket === 'equipment').map((line) => ({ line, amount: line.total })),
  };
}

export function computeTotals(data: Inspection, lines: PriceLine[], policy: Policy, items: Item[], trades: Trade[] = []): Totals {
  const missing = [...new Set(lines.filter((line) => !BUCKETS.has(line.bucket)).map((line) => line.code))].sort();
  if (missing.length) throw new Error(`Priced codes missing from the estimate range: ${missing}`);
  const labor = lines.filter((line) => line.bucket === 'labor_material');
  const lowLabor = sumBucket(labor, 'labor_material');
  if (sumDec(lines.map((line) => line.total), ZERO).cmp(ZERO) <= 0) {
    throw new Error('The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing.');
  }
  const uncertainEnd = policy.assist.range_method === 'uncertainty' ? uncertain(data, lines, items, policy) : null;
  const multiplier = data.isAfterHours ? Dec.parse(policy.after_hours.multiplier) : ONE;
  const overhead = Dec.parse(policy.overhead_profit_percent).div(HUNDRED);
  const taxRate = policy.sales_tax.enabled ? Dec.parse(policy.sales_tax.percent).div(HUNDRED) : ZERO;
  const minimum = Dec.parse(policy.minimum_job_charge);
  const entriesOf = (list: PriceLine[]): Entry[] => list.map((line) => ({ line, amount: line.total }));
  // One end of the range, from the amount each of its lines is billed at: the line total at the low end, the
  // grown amount at the high end. Both ends run this one path, so the high end is priced like the low end. The
  // multiplier applies to flagged items only; an item that is exempt from overhead and profit is left out of its
  // base and out of what a minimum compares; a taxable item adds its materials share to the tax base, and the
  // rate is applied once to that base. A minimum line is never short by a cent that rounds away, so `short` is exact.
  const end = (entries: Entry[]): { end: End; short: boolean } => {
    const subtotal = sumDec(entries.map((entry) => entry.amount), ZERO);
    const mix = mixOf(entries, multiplier, overhead);
    const adjusted = adjustments(mix, multiplier);
    const adjustment = adjusted.total;
    const owed = tradeMinimums(trades, mix, adjusted);
    const topUps = minimumTotal(owed);
    const work = maxDec(ZERO, subtotal.add(adjustment).sub(exemptCharged(mix, adjusted)).add(topUps));
    const floor = money(maxDec(ZERO, minimum.sub(work)));
    const overheadProfit = money(overhead.mul(work.add(floor)));
    const tax = money(taxRate.mul(mix.taxed));
    return {
      short: work.cmp(minimum) < 0,
      end: {
        subtotal,
        afterHours: adjustment,
        tradeMinimums: owed,
        minimumCharge: floor,
        overheadProfit,
        tax,
        pricePoint: ZERO,
        total: subtotal.add(adjustment).add(topUps).add(floor).add(overheadProfit).add(tax),
      },
    };
  };
  const low = end(entriesOf(lines)).end;
  // Each labor line's grown amount in whole cents. Fixed lines stay as they are; equipment lines stay too, except
  // under the uncertainty method, which prices them again at its own counts.
  const grownLabor = settle(uncertainEnd ? uncertainEnd.laborEntries : cushion(data, policy, items, labor));
  const highLaborAmount = sumDec(grownLabor.map((entry) => entry.amount), ZERO);
  let high: End | null = null;
  if (policy.estimate_mode === 'range') {
    const candidate = end([
      ...entriesOf(lines.filter((line) => line.bucket === 'fixed')),
      ...(uncertainEnd ? uncertainEnd.equipmentEntries : entriesOf(lines.filter((line) => line.bucket === 'equipment'))),
      ...grownLabor,
    ]);
    // A high end still under the job minimum is the low end unless it charges more before tax: it is not
    // floored on its own, but growth in items billed beyond the minimum still raises it.
    const beforeTax = (value: End): Dec => value.total.sub(value.tax);
    high = candidate.short && beforeTax(candidate.end).cmp(beforeTax(low)) <= 0 ? { ...low } : candidate.end;
  }
  return {
    mode: policy.estimate_mode,
    low: roundToPricePoint(low, policy),
    high: high ? roundToPricePoint(high, policy) : null,
    laborMaterialLow: lowLabor,
    laborMaterialHigh: highLaborAmount,
    afterHoursLabel: policy.after_hours.label,
    minimumChargeLabel: MINIMUM_CHARGE_LABEL,
    explanation: explanation(policy, data, items),
    rangeExplanation: rangeExplanation(policy, data),
    uncertainty: uncertainEnd ? uncertaintyJson(data, policy) : null,
  };
}

/**
 * The smallest amount at or above `total` that is `ending` plus a whole number of `steps` (S4-4e).
 * It never rounds down, so an end is never quoted below its priced total.
 */
export function pricePointOf(total: Dec, step: Dec, ending: Dec): Dec {
  if (total.cmp(ending) <= 0) return ending;
  return ending.add(total.sub(ending).div(step).toIntegral('CEILING').mul(step));
}

/** Price-point rounding applies last, after the minimums, overhead and profit, and tax. */
function roundToPricePoint(end: End, policy: Policy): End {
  const rule = policy.price_point;
  if (!rule) return end;
  const total = money(pricePointOf(end.total, Dec.parse(rule.step), Dec.parse(rule.ending)));
  return { ...end, pricePoint: total.sub(end.total), total };
}

function equipmentClause(data: Inspection, policy: Policy): string {
  const numbers = highNumbers(data, policy);
  const extra = policy.assist.extra_drying_days;
  const days = counted({ kind: 'dec', dec: numbers.days }, 'drying day') + (extra ? ` (${extra} more than planned)` : '');
  if (!numbers.available) return `the equipment counts as entered for ${days}`;
  return `up to ${counted(numbers.air, 'air mover')} and ${counted(numbers.dehu, 'dehumidifier')} for ${days}`;
}

function sizingClause(data: Inspection, policy: Policy): string | null {
  const numbers = highNumbers(data, policy);
  if (!numbers.available) return null;
  const sizing = equipmentSizing(data);
  if (
    sameAmount(numbers.air, sizing.air?.max ?? null) &&
    sameAmount(numbers.dehu, sizing.dehu?.recommendedUnits ?? null)
  ) {
    return 'the most the IICRC S500 placement recommends for the stated room sizes';
  }
  return 'the larger of the counts entered and what the IICRC S500 placement recommends for the stated room sizes';
}

function hiddenClause(data: Inspection, policy: Policy): string | null {
  const hiddenPercent = policy.assist.hidden_damage_percent;
  const names: Record<string, string> = { '1': 'category 1', '2': 'category 2', '3': 'category 3 or mold' };
  const present = new Set(data.rooms.map((room) => hiddenKey(room.category)));
  const parts = (['1', '2', '3'] as const)
    .filter((key) => present.has(key))
    .map((key) => `${percentText(hiddenPercent[key as '1' | '2' | '3'])}% in ${names[key]} rooms`);
  if (!parts.length) return null;
  const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `hidden damage of ${text}`;
}

function uncertaintySentence(data: Inspection, policy: Policy): string | null {
  const numbers = highNumbers(data, policy);
  const assist = policy.assist;
  const categories = new Set(data.rooms.map((room) => hiddenKey(room.category)));
  const unchanged =
    asDec(numbers.air).eq(entered(data, 'air_movers')) &&
    asDec(numbers.dehu).eq(entered(data, 'dehumidifiers')) &&
    !assist.extra_drying_days &&
    ![...categories].some((key) => !Dec.parse(assist.hidden_damage_percent[key as '1' | '2' | '3']).isZero());
  if (unchanged) return null;
  let text = equipmentClause(data, policy);
  const sizing = sizingClause(data, policy);
  if (sizing) text += `, ${sizing}`;
  const hidden = hiddenClause(data, policy);
  if (hidden) text += `, and ${hidden}`;
  return `The high end allows for ${text}.`;
}

function bracketSentence(policy: Policy): string {
  const bands = cushionBrackets(policy);
  const parts: string[] = [];
  let previous = 0;
  for (const band of bands) {
    const label = band.up_to_sf === null ? `over ${commas(previous)} sq ft` : `over ${commas(previous)} through ${commas(band.up_to_sf)} sq ft`;
    parts.push(`${percentText(band.percent)}% ${label}`);
    previous = band.up_to_sf ?? previous;
  }
  const first = percentText(bands[0]?.percent ?? '0');
  if (policy.bracket_mode === 'whole-job') {
    return (
      "The high end applies one whole-job cushion to labor and materials, selected by the job's total square feet before waste: each room once at the largest area figure its priced square-foot items use (finished plus unfinished demolition is one figure), plus square feet typed without a room: " +
      parts.join('; ') +
      '.'
    );
  }
  return (
    'The high end adds a tiered cushion to area-priced labor and materials, highest-priced square feet first: ' +
    parts.join('; ') +
    `; and ${first}% on labor hours.`
  );
}

export function rangeExplanation(policy: Policy, data: Inspection): string | null {
  if (policy.estimate_mode !== 'range') return null;
  if (policy.assist.range_method === 'uncertainty') return uncertaintySentence(data, policy);
  if (hasCushionBrackets(policy) || policy.bracket_mode === 'whole-job') return bracketSentence(policy);
  const first = Dec.parse(policy.range.first_percent);
  const beyond = Dec.parse(policy.range.beyond_percent);
  if (first.isZero()) return null;
  if (first.eq(beyond)) return `The high end allows ${percentText(first)}% extra on the work, for hidden damage.`;
  const tail = beyond.isZero() ? '' : ` and ${percentText(beyond)}% beyond`;
  return `The high end allows ${percentText(first)}% extra on the first ${commas(policy.range.first_sf)} sq ft of work${tail}, for hidden damage.`;
}

function howEndsDiffer(policy: Policy, data: Inspection): string[] {
  if (policy.assist.range_method === 'uncertainty') {
    return [
      'The low amount is the itemized total at the equipment counts and drying days entered.',
      `The high amount prices ${equipmentClause(data, policy)} and adds the hidden-damage allowance above to labor and materials.`,
      'Job charges and approved additional work are the same in both amounts.',
    ];
  }
  if (hasCushionBrackets(policy) || policy.bracket_mode === 'whole-job') {
    return [
      'The low amount is the itemized total.',
      bracketSentence(policy),
      'Job charges, drying equipment and approved additional work are the same in both amounts.',
    ];
  }
  const first = percentText(policy.range.first_percent);
  const beyond = percentText(policy.range.beyond_percent);
  return [
    'The low amount is the itemized total.',
    'The high amount adds an allowance to labor and materials for conditions found during the work: ' +
      `${first}% on the first ${commas(policy.range.first_sf)} square feet of area-priced work (highest-priced areas first), ${beyond}% on area beyond that, and ${first}% on labor hours.`,
    'Job charges, drying equipment and approved additional work are the same in both amounts.',
  ];
}

/**
 * The paragraph under a range. The flag sentences are judged from the table's enabled items, not from the lines
 * either end prices, so the text never depends on which end the job minimum keeps.
 */
export function explanation(policy: Policy, data: Inspection, items: Item[]): string {
  if (policy.estimate_mode === 'single') return 'The price covers the itemized scope below.';
  const sentences = howEndsDiffer(policy, data);
  const enabled = items.filter((item) => item.enabled);
  const exempt = (item: Item): boolean => item.no_overhead_profit === true;
  const multiplier = Dec.parse(policy.after_hours.multiplier);
  if (data.isAfterHours && multiplier.cmp(ONE) > 0 && enabled.some((item) => item.after_hours === true)) {
    const label = policy.after_hours.label;
    const named = label === DEFAULT_AFTER_HOURS_LABEL ? 'an after-hours adjustment' : `"${label}"`;
    sentences.push(
      `Both amounts include ${named} of ${percentText(multiplier.sub(ONE).mul(HUNDRED))}% of the labor and materials marked as after-hours work.`,
    );
  }
  const overhead = Dec.parse(policy.overhead_profit_percent);
  if (!overhead.isZero()) {
    const except = enabled.some(exempt) ? ', except on items marked as carrying none' : '';
    sentences.push(`Both amounts include overhead and profit at ${percentText(overhead)}%${except}.`);
  }
  const tax = Dec.parse(policy.sales_tax.percent);
  if (policy.sales_tax.enabled && !tax.isZero()) {
    const taxed = enabled.filter((item) => item.taxable);
    const exempted = taxed.filter(exempt).length;
    const share =
      overhead.isZero() || (exempted > 0 && exempted === taxed.length)
        ? ''
        : ` and their share of overhead and profit${exempted > 0 ? ', except on items marked as carrying none' : ''}`;
    const reduced = taxed.some((item) => Dec.parse(item.materials_share_percent ?? '100').cmp(HUNDRED) < 0);
    sentences.push(`Sales tax at ${percentText(tax)}% applies to ${reduced ? 'the materials share of ' : ''}the items marked taxable${share}.`);
  }
  return sentences.join(' ');
}

/** Price a saved draft from a parsed table with the dryscope-v3 formulas. */
export function priceAndRange(data: Inspection, table: Table): Priced {
  const scoped = priceScopeV2(data, table.items, table.policy);
  const totals = computeTotals(data, scoped.lines, table.policy, table.items, table.trades ?? []);
  return { lines: scoped.lines, totals, warnings: scoped.warnings, calculationVersion: ENGINE_VERSION };
}
