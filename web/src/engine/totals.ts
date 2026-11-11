// Low and high ends of a v3 estimate. Summary amounts are decimal strings; cents use HALF_UP once.

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
  minimumCharge: Dec;
  overheadProfit: Dec;
  tax: Dec;
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

function topDollars(rows: AreaRow[], first: Dec): Dec {
  if (sumDec(rows.map((row) => row.area), ZERO).cmp(first) <= 0) {
    return sumDec(rows.map((row) => row.total), ZERO);
  }
  let remaining = first;
  let dollars = ZERO;
  const ordered = [...rows].sort((left, right) => right.total.div(right.area).cmp(left.total.div(left.area)));
  for (const row of ordered) {
    const take = minDec(remaining, row.area);
    dollars = dollars.add(take.eq(row.area) ? row.total : row.total.mul(take).div(row.area));
    remaining = remaining.sub(take);
    if (remaining.isZero()) break;
  }
  return dollars;
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

function highLabor(data: Inspection, lines: PriceLine[], policy: Policy, items: Item[], areaDollars: Dec, otherDollars: Dec, areaLines: PriceLine[]): Dec {
  if (policy.assist.range_method === 'uncertainty') return uncertain(data, lines, items, policy).labor;
  const bands = cushionBrackets(policy);
  const areas = cushionRows(areaLines, policy);
  if (policy.bracket_mode === 'whole-job') {
    const percent = Dec.parse(bandFor(bands, jobSf(data, items, policy)).percent).div(HUNDRED);
    return money(areaDollars.add(otherDollars).mul(ONE.add(percent)));
  }
  const firstBand = bands[0];
  const secondBand = bands[1];
  if (bands.length === 2 && firstBand && secondBand && !areaLines.some((line) => line.priceBracket)) {
    const first = Dec.parse(firstBand.percent).div(HUNDRED);
    const beyond = Dec.parse(secondBand.percent).div(HUNDRED);
    if (firstBand.up_to_sf === null) throw new Error('cushion');
    const top = topDollars(areas, Dec.fromInt(firstBand.up_to_sf));
    return money(
      ONE.add(beyond).mul(areaDollars).add(first.sub(beyond).mul(top)).add(ONE.add(first).mul(otherDollars)),
    );
  }
  let previous = ZERO;
  let allowance = ZERO;
  for (const band of bands) {
    const top =
      band.up_to_sf === null
        ? sumDec(areas.map((row) => row.total), ZERO)
        : topDollars(areas, Dec.fromInt(band.up_to_sf));
    allowance = allowance.add(top.sub(previous).mul(Dec.parse(band.percent)).div(HUNDRED));
    previous = top;
  }
  const firstPercent = Dec.parse(firstBand?.percent ?? '0').div(HUNDRED);
  return money(areaDollars.add(allowance).add(ONE.add(firstPercent).mul(otherDollars)));
}

function uncertain(data: Inspection, lines: PriceLine[], items: Item[], policy: Policy): {
  labor: Dec;
  taxedLabor: Dec;
  equipment: Dec;
  taxedEquipment: Dec;
} {
  const percents = roomPercents(data, policy);
  const largest = [...percents.values()].reduce((best, value) => maxDec(best, value), ZERO);
  const growth = (line: PriceLine): Dec => {
    if (line.bucket !== 'labor_material') return ZERO;
    if (line.room === null) return largest;
    return percents.get(line.room) ?? largest;
  };
  const high = priceScopeV2(data, items, policy, factors(data, policy), growth).lines;
  let labor = ZERO;
  let taxed = ZERO;
  const bracketed = new Map<string, { amount: Dec; taxable: boolean }>();
  const mixed = [
    ...lines.filter((line) => !line.priceBracket),
    ...high.filter((line) => line.priceBracket),
  ];
  for (const line of mixed) {
    if (line.bucket !== 'labor_material') continue;
    if (line.priceBracket) {
      const key = `${line.itemId ?? ''}\u0000${line.priceRow ?? ''}`;
      const prior = bracketed.get(key) ?? { amount: ZERO, taxable: line.taxable === true };
      bracketed.set(key, {
        amount: prior.amount.add(exactAmount(line).mul(ONE.add(growth(line)))),
        taxable: line.taxable === true,
      });
      continue;
    }
    const grown = line.total.mul(ONE.add(growth(line)));
    labor = labor.add(grown);
    if (line.taxable) taxed = taxed.add(grown);
  }
  for (const row of bracketed.values()) {
    const rounded = money(row.amount);
    labor = labor.add(rounded);
    if (row.taxable) taxed = taxed.add(rounded);
  }
  return {
    labor: money(labor),
    taxedLabor: taxed,
    equipment: sumBucket(high, 'equipment'),
    taxedEquipment: sumBucket(high, 'equipment', true),
  };
}

export function computeTotals(data: Inspection, lines: PriceLine[], policy: Policy, items: Item[]): Totals {
  const missing = [...new Set(lines.filter((line) => !BUCKETS.has(line.bucket)).map((line) => line.code))].sort();
  if (missing.length) throw new Error(`Priced codes missing from the estimate range: ${missing}`);
  const fixed = sumBucket(lines, 'fixed');
  const equipment = sumBucket(lines, 'equipment');
  const labor = lines.filter((line) => line.bucket === 'labor_material');
  const areaLines = labor.filter((line) => line.area !== null);
  const areaDollars = sumDec(areaLines.map((line) => line.total), ZERO);
  const otherDollars = sumDec(
    labor.filter((line) => line.area === null).map((line) => line.total),
    ZERO,
  );
  const lowLabor = areaDollars.add(otherDollars);
  if (fixed.add(equipment).add(lowLabor).cmp(ZERO) <= 0) {
    throw new Error('The priced scope totals $0.00. Enter at least one quantity or room measurement before auditing.');
  }
  const uncertainEnd = policy.assist.range_method === 'uncertainty' ? uncertain(data, lines, items, policy) : null;
  const highLaborAmount = uncertainEnd
    ? uncertainEnd.labor
    : highLabor(data, lines, policy, items, areaDollars, otherDollars, areaLines);
  const multiplier = data.isAfterHours ? Dec.parse(policy.after_hours.multiplier) : ONE;
  const overhead = Dec.parse(policy.overhead_profit_percent).div(HUNDRED);
  const taxRate = policy.sales_tax.enabled ? Dec.parse(policy.sales_tax.percent).div(HUNDRED) : ZERO;
  const minimum = Dec.parse(policy.minimum_job_charge);
  const taxedFixed = sumBucket(lines, 'fixed', true);
  const taxedEquipment = sumBucket(lines, 'equipment', true);
  const taxedLabor = sumBucket(lines, 'labor_material', true);
  const highEquipment = uncertainEnd ? uncertainEnd.equipment : equipment;
  const preMinimum = (laborAmount: Dec, equipmentAmount: Dec): Dec =>
    fixed.add(equipmentAmount).add(laborAmount).add(money(laborAmount.mul(multiplier.sub(ONE))));
  const end = (laborAmount: Dec, equipmentAmount = equipment, taxedEquipmentAmount = taxedEquipment, share: Dec | null = null): End => {
    const subtotal = fixed.add(equipmentAmount).add(laborAmount);
    const adjustment = money(laborAmount.mul(multiplier.sub(ONE)));
    const floor = maxDec(ZERO, minimum.sub(subtotal.add(adjustment)));
    const overheadProfit = money(overhead.mul(subtotal.add(adjustment).add(floor)));
    const used = share ?? (lowLabor.isZero() ? ZERO : taxedLabor.mul(laborAmount).div(lowLabor));
    const tax = money(taxRate.mul(taxedFixed.add(taxedEquipmentAmount).add(multiplier.mul(used))).mul(ONE.add(overhead)));
    return {
      subtotal,
      afterHours: adjustment,
      minimumCharge: floor,
      overheadProfit,
      tax,
      total: subtotal.add(adjustment).add(floor).add(overheadProfit).add(tax),
    };
  };
  const low = end(lowLabor);
  let high: End | null = null;
  if (policy.estimate_mode === 'range') {
    if (preMinimum(highLaborAmount, highEquipment).cmp(minimum) < 0) high = { ...low };
    else if (uncertainEnd) high = end(highLaborAmount, highEquipment, uncertainEnd.taxedEquipment, uncertainEnd.taxedLabor);
    else high = end(highLaborAmount);
  }
  return {
    mode: policy.estimate_mode,
    low,
    high,
    laborMaterialLow: lowLabor,
    laborMaterialHigh: highLaborAmount,
    afterHoursLabel: policy.after_hours.label,
    minimumChargeLabel: MINIMUM_CHARGE_LABEL,
    explanation: explanation(policy, data),
    rangeExplanation: rangeExplanation(policy, data),
    uncertainty: uncertainEnd ? uncertaintyJson(data, policy) : null,
  };
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

export function explanation(policy: Policy, data: Inspection): string {
  if (policy.estimate_mode === 'single') return 'The price covers the itemized scope below.';
  const sentences = howEndsDiffer(policy, data);
  const multiplier = Dec.parse(policy.after_hours.multiplier);
  if (data.isAfterHours && multiplier.cmp(ONE) > 0) {
    const label = policy.after_hours.label;
    const named = label === DEFAULT_AFTER_HOURS_LABEL ? 'an after-hours adjustment' : `"${label}"`;
    sentences.push(`Both amounts include ${named} of ${percentText(multiplier.sub(ONE).mul(HUNDRED))}% of labor and materials.`);
  }
  const overhead = Dec.parse(policy.overhead_profit_percent);
  if (!overhead.isZero()) sentences.push(`Both amounts include overhead and profit at ${percentText(overhead)}%.`);
  const tax = Dec.parse(policy.sales_tax.percent);
  if (policy.sales_tax.enabled && !tax.isZero()) {
    const share = overhead.isZero() ? '' : ' and their share of overhead and profit';
    sentences.push(`Sales tax at ${percentText(tax)}% applies to the items marked taxable${share}.`);
  }
  return sentences.join(' ');
}

/** Price a saved draft from a parsed table with the dryscope-v3 formulas. */
export function priceAndRange(data: Inspection, table: Table): Priced {
  const scoped = priceScopeV2(data, table.items, table.policy);
  const totals = computeTotals(data, scoped.lines, table.policy, table.items);
  return { lines: scoped.lines, totals, warnings: scoped.warnings, calculationVersion: ENGINE_VERSION };
}
