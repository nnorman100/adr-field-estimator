// Owner price-table normalization. Decimal strings match price_table.py, including fixed padding.

import { createHash } from 'node:crypto';

import { Dec, ZERO } from './decimal';
import { JFloat, JInt, type JObj, type JVal, canonical, jint } from './json';
import { fixedText, has, isObj } from './values';

export const V2 = 'dryscope-v2';
export const CURRENCY = 'USD';
const MAX_ITEMS = 150;
const MAX_BRACKETS = 20;

export const GROUPS = [
  'job_charges',
  'demolition',
  'treatment',
  'drying_equipment',
  'labor',
  'optional_services',
  'extras',
] as const;

export const UNITS = ['sf', 'lf', 'each', 'hour', 'day', 'unit_day', 'load', 'visit'] as const;

export const BUCKET_OF_GROUP: Record<string, string> = {
  job_charges: 'fixed',
  optional_services: 'fixed',
  extras: 'fixed',
  drying_equipment: 'equipment',
  demolition: 'labor_material',
  treatment: 'labor_material',
  labor: 'labor_material',
};

export const FIELD_SOURCES = [
  'emergency_calls',
  'monitoring_hours',
  'haul_loads',
  'air_scrubbers',
  'hepa_filters',
  'matterport_scans',
  'dump_truck_loads',
  'equipment_decon',
  'power_distribution',
  'labor_hours',
];

const DECIMAL_FIELDS = new Set(['monitoring_hours', 'labor_hours']);

export const COUNT_DAYS: Array<[string, string]> = [
  ['air_movers', 'drying_days'],
  ['dehumidifiers', 'drying_days'],
  ['wood_floor_systems', 'wood_floor_days'],
];

export const DEFAULT_AFTER_HOURS_LABEL = 'After-hours adjustment';

const ITEM_ID = /^[a-z][a-z0-9_]{1,39}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
const XACT = /^[A-Z0-9][A-Z0-9 ._/-]{0,29}$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const FORMULA = /^[=+\-@]/;

export type Source = {
  kind: 'room' | 'field' | 'count_days' | 'after_hours' | 'typed' | 'typed_count_days';
  field: string | null;
  countField: string | null;
  daysField: string | null;
  finish: 'finished' | 'unfinished' | null;
};

export type Band = { upToSf: number | null; unitPrice?: string; percent?: string };

export type Item = {
  itemId: string;
  code: string;
  group: string;
  name: string;
  customerDescription: string;
  unit: string;
  quantitySource: string;
  unitPrice: string;
  allowZero: boolean;
  defaultQuantity: string;
  wastePercent: string;
  categories: number[];
  taxable: boolean;
  xactimateCode: string;
  enabled: boolean;
  sortOrder: number;
  priceBrackets?: Band[];
};

export type Policy = {
  estimateMode: 'range' | 'single';
  areaBasis: 'demolition' | 'demolition_with_waste' | 'wet_floor';
  range: {
    firstSf: number;
    firstPercent: string;
    beyondPercent: string;
    brackets?: Band[];
  };
  afterHours: { multiplier: string; label: string };
  categoryMultipliers: Record<'1' | '2' | '3', string>;
  cabinetry: { multiplier: string; scope: 'finished_only' | 'all_cat3' };
  minimumJobCharge: string;
  overheadProfitPercent: string;
  salesTax: { enabled: boolean; percent: string };
  showLineBreakdown: boolean;
  assist?: {
    dryingDays: number;
    rangeMethod: 'cushion' | 'uncertainty';
    extraDryingDays: number;
    hiddenDamagePercent: Record<'1' | '2' | '3', string>;
  };
  bracketMode?: 'tiered' | 'whole-job';
};

export type Table = { items: Item[]; policy: Policy };

export function assistOf(policy: Policy): NonNullable<Policy['assist']> {
  return (
    policy.assist ?? {
      dryingDays: 3,
      rangeMethod: 'cushion',
      extraDryingDays: 0,
      hiddenDamagePercent: { '1': '0', '2': '0', '3': '0' },
    }
  );
}

export function bracketModeOf(policy: Policy): 'tiered' | 'whole-job' {
  return policy.bracketMode ?? 'tiered';
}

export function cushionBrackets(policy: Policy): Band[] {
  if (policy.range.brackets) return policy.range.brackets.map((band) => ({ ...band }));
  return [
    { upToSf: policy.range.firstSf, percent: policy.range.firstPercent },
    { upToSf: null, percent: policy.range.beyondPercent },
  ];
}

export function parseSource(text: string): Source {
  const empty = {
    field: null,
    countField: null,
    daysField: null,
    finish: null,
  };
  if (text === 'room:demolition:unfinished') {
    return { kind: 'room', ...empty, field: 'unfinished_sf', finish: 'unfinished' };
  }
  if (text === 'room:demolition:finished') {
    return { kind: 'room', ...empty, field: 'finished_sf', finish: 'finished' };
  }
  if (text === 'room:wet_floor') return { kind: 'room', ...empty, field: 'wet_floor_sf' };
  if (text === 'room:floor') return { kind: 'room', ...empty, field: 'floor_sf' };
  if (text === 'room:basis') return { kind: 'room', ...empty, field: 'basis' };
  if (text === 'after_hours') return { kind: 'after_hours', ...empty };
  if (text === 'typed') return { kind: 'typed', ...empty };
  if (text === 'typed_count_days') return { kind: 'typed_count_days', ...empty };
  if (text.startsWith('field:')) {
    const field = text.slice(6);
    if (FIELD_SOURCES.includes(field)) return { kind: 'field', ...empty, field };
  }
  if (text.startsWith('count_days:')) {
    const pair = COUNT_DAYS.find(([count, days]) => `${count}*${days}` === text.slice(11));
    if (pair) return { kind: 'count_days', ...empty, countField: pair[0], daysField: pair[1] };
  }
  throw new Error(`Unknown quantity source "${text}".`);
}

function decimalStr(
  raw: JVal | undefined,
  low: Dec,
  high: Dec,
  maxDecimals: number,
  fixed: number | null,
): string {
  if (raw === undefined || raw === null || typeof raw === 'boolean' || raw instanceof JFloat) {
    throw new Error('decimal');
  }
  const text = typeof raw === 'string' ? raw.trim() : raw instanceof JInt ? String(raw.value) : '';
  if (!DECIMAL_RE.test(text)) throw new Error('decimal');
  const fraction = text.split('.')[1];
  if (fraction && fraction.length > maxDecimals) throw new Error('decimal places');
  const amount = Dec.parse(text);
  if (amount.cmp(low) < 0 || amount.cmp(high) > 0) throw new Error('decimal range');
  if (fixed !== null) return fixedText(amount, fixed);
  if (amount.isZero()) return '0';
  const normalized = amount.quantize(-maxDecimals, 'HALF_UP').toString();
  if (!normalized.includes('.')) return normalized;
  return normalized.replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function printable(raw: JVal | undefined, min: number, max: number): string {
  if (typeof raw !== 'string') throw new Error('text');
  const text = raw.trim();
  if (text.length < min || text.length > max) throw new Error('text length');
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || (code >= 128 && code <= 159)) throw new Error('text');
  }
  if (FORMULA.test(text)) throw new Error('text');
  return text;
}

function asInt(value: JVal | undefined, low: number, high: number): number {
  if (!(value instanceof JInt) || value.value < low || value.value > high) throw new Error('int');
  return value.value;
}

function normalizeBrackets(raw: JVal, valueField: 'unit_price' | 'percent', allowBlank: boolean): Band[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BRACKETS) throw new Error('brackets');
  let previous = 0;
  const result: Band[] = [];
  raw.forEach((band, index) => {
    if (!isObj(band) || new Set(Object.keys(band)).size !== 2 || !has(band, 'up_to_sf') || !has(band, valueField)) {
      throw new Error('bracket keys');
    }
    const limit = band.up_to_sf;
    if (index === raw.length - 1) {
      if (limit !== null) throw new Error('unlimited');
    } else {
      if (!(limit instanceof JInt) || !(previous < limit.value && limit.value <= 100000)) {
        throw new Error('limit');
      }
      previous = limit.value;
    }
    let stored: string;
    const value = band[valueField];
    if (allowBlank && typeof value === 'string' && value.trim() === '') stored = '';
    else {
      stored = decimalStr(
        value,
        ZERO,
        Dec.parse(valueField === 'percent' ? '100' : '100000'),
        2,
        valueField === 'unit_price' ? 2 : null,
      );
    }
    const row: Band = { upToSf: limit === null ? null : (limit as JInt).value };
    if (valueField === 'unit_price') row.unitPrice = stored;
    else row.percent = stored;
    result.push(row);
  });
  return result;
}

function defaultCode(itemId: string): string {
  return itemId.toUpperCase().replaceAll('_', '-').slice(0, 16);
}

export function normalizeItems(raw: JVal, publish: boolean, acknowledgements: string[]): Item[] {
  if (!Array.isArray(raw)) throw new Error('items');
  if (raw.length > MAX_ITEMS) throw new Error('items');
  if (publish && raw.length === 0) throw new Error('items');
  const acked = new Set(acknowledgements);
  const seenIds = new Set<string>();
  const seenCodes = new Set<string>();
  const items: Item[] = [];
  raw.forEach((value, index) => {
    if (!isObj(value)) throw new Error('item');
    const itemId = value.item_id;
    if (typeof itemId !== 'string' || !ITEM_ID.test(itemId)) throw new Error(`id ${index}`);
    const rawCode = value.code;
    let code: string;
    if (rawCode === undefined || rawCode === null || (typeof rawCode === 'string' && rawCode.trim() === '')) {
      code = defaultCode(itemId);
    } else if (typeof rawCode === 'string') code = rawCode.trim();
    else throw new Error('code');
    if (!CODE_RE.test(code)) throw new Error('code');
    if (seenIds.has(itemId) || seenCodes.has(code)) throw new Error('duplicate');
    seenIds.add(itemId);
    seenCodes.add(code);
    const group = value.group;
    if (typeof group !== 'string' || !GROUPS.includes(group as (typeof GROUPS)[number])) throw new Error('group');
    const name = printable(value.name, 1, 80);
    let descRaw = value.customer_description;
    if (descRaw === undefined || descRaw === null) descRaw = '';
    const customerDescription = printable(descRaw, 0, 300);
    const unit = value.unit;
    if (typeof unit !== 'string' || !UNITS.includes(unit as (typeof UNITS)[number])) throw new Error('unit');
    const sourceText = value.quantity_source;
    if (typeof sourceText !== 'string') throw new Error('source');
    const source = parseSource(sourceText);
    if (group === 'demolition' && unit === 'sf' && source.kind !== 'room') throw new Error('demo');
    if (group === 'extras' && unit !== 'hour') throw new Error('extras unit');
    const allowZero = value.allow_zero === undefined ? false : value.allow_zero;
    const enabled = value.enabled === undefined ? true : value.enabled;
    const taxable = value.taxable === undefined ? false : value.taxable;
    if (typeof allowZero !== 'boolean' || typeof enabled !== 'boolean' || typeof taxable !== 'boolean') {
      throw new Error('flag');
    }
    let brackets: Band[] | undefined;
    if (has(value, 'price_brackets')) {
      if (unit !== 'sf' || (source.kind !== 'room' && source.kind !== 'typed')) throw new Error('brackets');
      brackets = normalizeBrackets(value.price_brackets as JVal, 'unit_price', !publish || !enabled);
      if (brackets.some((band) => band.unitPrice !== '' && Dec.parse(band.unitPrice ?? '0').isZero())) {
        if (!allowZero) throw new Error('zero bracket');
        if (publish && enabled && !acked.has(itemId) && !acked.has(code)) throw new Error('ack');
      }
    }
    let priceRaw = value.unit_price;
    if (priceRaw === undefined || priceRaw === null) priceRaw = '';
    let unitPrice: string;
    if (typeof priceRaw === 'string' && priceRaw.trim() === '') {
      if (publish && enabled && !brackets) throw new Error('price');
      unitPrice = '';
    } else {
      unitPrice = decimalStr(priceRaw, ZERO, Dec.parse('100000.00'), 2, 2);
      if (Dec.parse(unitPrice).isZero()) {
        if (!allowZero) throw new Error('zero');
        if (publish && enabled && !acked.has(itemId) && !acked.has(code)) throw new Error('ack');
      }
    }
    const defaultQuantity = decimalStr(
      has(value, 'default_quantity') ? value.default_quantity : '0',
      ZERO,
      Dec.parse('100000'),
      2,
      null,
    );
    const whole =
      (source.kind === 'field' && source.field !== null && !DECIMAL_FIELDS.has(source.field)) ||
      source.kind === 'count_days' ||
      source.kind === 'typed_count_days';
    if (whole && !Dec.parse(defaultQuantity).div(Dec.fromInt(1)).toString().includes('.') === false) {
      const qty = Dec.parse(defaultQuantity);
      const integral = qty.toIntegral('DOWN');
      if (qty.cmp(integral) !== 0) throw new Error('whole quantity');
    }
    const wastePercent = decimalStr(
      has(value, 'waste_percent') ? value.waste_percent : '0',
      ZERO,
      Dec.parse('100'),
      2,
      null,
    );
    let catsRaw = value.categories;
    if (catsRaw === undefined || catsRaw === null) catsRaw = [];
    if (!Array.isArray(catsRaw)) throw new Error('categories');
    const categories: number[] = [];
    for (const cat of catsRaw) {
      if (!(cat instanceof JInt) || ![1, 2, 3].includes(cat.value) || categories.includes(cat.value)) {
        throw new Error('categories');
      }
      categories.push(cat.value);
    }
    categories.sort((a, b) => a - b);
    let xactRaw = value.xactimate_code;
    if (xactRaw === undefined || xactRaw === null) xactRaw = '';
    if (typeof xactRaw !== 'string') throw new Error('xact');
    const xactimateCode = xactRaw.trim();
    if (xactimateCode && !XACT.test(xactimateCode)) throw new Error('xact');
    const orderRaw = has(value, 'sort_order') && value.sort_order !== null ? value.sort_order : 0;
    const sortOrder = asInt(orderRaw === 0 ? jint(0) : orderRaw, 0, 10000);
    const item: Item = {
      itemId,
      code,
      group,
      name,
      customerDescription,
      unit,
      quantitySource: sourceText,
      unitPrice,
      allowZero,
      defaultQuantity,
      wastePercent,
      categories,
      taxable,
      xactimateCode,
      enabled,
      sortOrder,
    };
    if (brackets) item.priceBrackets = brackets;
    items.push(item);
  });
  if (items.filter((item) => item.group === 'extras' && item.enabled).length > 1) throw new Error('extras');
  if (publish && !items.some((item) => item.enabled && (item.unitPrice !== '' || item.priceBrackets))) {
    throw new Error('priced');
  }
  return items;
}

function normalizeAssist(raw: JVal): NonNullable<Policy['assist']> {
  if (!isObj(raw)) throw new Error('assist');
  const method = raw.range_method === undefined ? 'cushion' : raw.range_method;
  if (method !== 'cushion' && method !== 'uncertainty') throw new Error('assist');
  const percents = isObj(raw.hidden_damage_percent) ? raw.hidden_damage_percent : null;
  if (!percents || new Set(Object.keys(percents)).size !== 3 || !has(percents, '1') || !has(percents, '2') || !has(percents, '3')) {
    if (raw.hidden_damage_percent === undefined) {
      return {
        dryingDays: asInt(raw.drying_days === undefined ? jint(3) : raw.drying_days, 1, 60),
        rangeMethod: method,
        extraDryingDays: asInt(raw.extra_drying_days === undefined ? jint(0) : raw.extra_drying_days, 0, 30),
        hiddenDamagePercent: {
          '1': decimalStr('0', ZERO, Dec.parse('100'), 2, null),
          '2': decimalStr('0', ZERO, Dec.parse('100'), 2, null),
          '3': decimalStr('0', ZERO, Dec.parse('100'), 2, null),
        },
      };
    }
    throw new Error('assist percents');
  }
  const hidden = { '1': percents['1'], '2': percents['2'], '3': percents['3'] };
  return {
    dryingDays: asInt(raw.drying_days === undefined ? jint(3) : raw.drying_days, 1, 60),
    rangeMethod: method,
    extraDryingDays: asInt(raw.extra_drying_days === undefined ? jint(0) : raw.extra_drying_days, 0, 30),
    hiddenDamagePercent: {
      '1': decimalStr(hidden['1'], ZERO, Dec.parse('100'), 2, null),
      '2': decimalStr(hidden['2'], ZERO, Dec.parse('100'), 2, null),
      '3': decimalStr(hidden['3'], ZERO, Dec.parse('100'), 2, null),
    },
  };
}

export function normalizePolicy(raw: JVal): Policy {
  if (!isObj(raw)) throw new Error('policy');
  const estimateMode = raw.estimate_mode === undefined ? 'range' : raw.estimate_mode;
  if (estimateMode !== 'range' && estimateMode !== 'single') throw new Error('mode');
  const areaBasis = raw.area_basis === undefined ? 'demolition' : raw.area_basis;
  if (areaBasis !== 'demolition' && areaBasis !== 'demolition_with_waste' && areaBasis !== 'wet_floor') {
    throw new Error('basis');
  }
  if (!isObj(raw.range)) throw new Error('range');
  const rangeRaw: JObj = has(raw.range, 'brackets')
    ? { first_sf: jint(1000), first_percent: '50', beyond_percent: '20', ...raw.range }
    : raw.range;
  const firstSf = asInt(rangeRaw.first_sf, 1, 100000);
  const firstPercent = decimalStr(rangeRaw.first_percent, ZERO, Dec.parse('100'), 2, null);
  const beyondPercent = decimalStr(rangeRaw.beyond_percent, ZERO, Dec.parse('100'), 2, null);
  if (!has(rangeRaw, 'brackets') && Dec.parse(beyondPercent).cmp(Dec.parse(firstPercent)) > 0) {
    throw new Error('cushion');
  }
  if (!isObj(raw.after_hours)) throw new Error('after hours');
  const multiplier = decimalStr(raw.after_hours.multiplier, Dec.parse('1'), Dec.parse('2'), 3, 3);
  const label = printable(
    raw.after_hours.label === undefined ? DEFAULT_AFTER_HOURS_LABEL : raw.after_hours.label,
    1,
    80,
  );
  if (!isObj(raw.category_multipliers)) throw new Error('multipliers');
  const cats = raw.category_multipliers;
  if (!has(cats, '1') || !has(cats, '2') || !has(cats, '3') || Object.keys(cats).length !== 3) {
    throw new Error('multipliers');
  }
  if (!isObj(raw.cabinetry)) throw new Error('cabinetry');
  const cabScope = raw.cabinetry.scope;
  if (cabScope !== 'finished_only' && cabScope !== 'all_cat3') throw new Error('cabinetry');
  if (!isObj(raw.sales_tax) || typeof raw.sales_tax.enabled !== 'boolean') throw new Error('tax');
  const show = raw.show_line_breakdown === undefined ? false : raw.show_line_breakdown;
  if (typeof show !== 'boolean') throw new Error('breakdown');
  const policy: Policy = {
    estimateMode,
    areaBasis,
    range: { firstSf, firstPercent, beyondPercent },
    afterHours: { multiplier, label },
    categoryMultipliers: {
      '1': decimalStr(cats['1'], Dec.parse('1'), Dec.parse('3'), 3, 3),
      '2': decimalStr(cats['2'], Dec.parse('1'), Dec.parse('3'), 3, 3),
      '3': decimalStr(cats['3'], Dec.parse('1'), Dec.parse('3'), 3, 3),
    },
    cabinetry: {
      multiplier: decimalStr(raw.cabinetry.multiplier, Dec.parse('1'), Dec.parse('3'), 3, 3),
      scope: cabScope,
    },
    minimumJobCharge: decimalStr(
      has(raw, 'minimum_job_charge') ? raw.minimum_job_charge : '0',
      ZERO,
      Dec.parse('100000'),
      2,
      null,
    ),
    overheadProfitPercent: decimalStr(
      has(raw, 'overhead_profit_percent') ? raw.overhead_profit_percent : '0',
      ZERO,
      Dec.parse('100'),
      2,
      null,
    ),
    salesTax: {
      enabled: raw.sales_tax.enabled,
      percent: decimalStr(has(raw.sales_tax, 'percent') ? raw.sales_tax.percent : '0', ZERO, Dec.parse('15'), 3, null),
    },
    showLineBreakdown: show,
  };
  if (has(raw, 'assist') && raw.assist !== null) policy.assist = normalizeAssist(raw.assist as JVal);
  if (has(raw, 'bracket_mode')) {
    if (raw.bracket_mode !== 'tiered' && raw.bracket_mode !== 'whole-job') throw new Error('bracket mode');
    policy.bracketMode = raw.bracket_mode;
  }
  if (has(rangeRaw, 'brackets')) {
    policy.range.brackets = normalizeBrackets(rangeRaw.brackets as JVal, 'percent', false);
  }
  return policy;
}

export function normalizeTable(payload: JVal, publish: boolean, acknowledgements: string[]): Table {
  if (!isObj(payload)) throw new Error('table');
  return {
    items: normalizeItems(payload.items as JVal, publish, acknowledgements),
    policy: normalizePolicy(payload.policy as JVal),
  };
}

function bandToJ(band: Band, field: 'unit_price' | 'percent'): JObj {
  return {
    [field]: (field === 'unit_price' ? band.unitPrice : band.percent) ?? '',
    up_to_sf: band.upToSf === null ? null : jint(band.upToSf),
  };
}

export function itemToJ(item: Item): JObj {
  const body: JObj = {
    allow_zero: item.allowZero,
    categories: item.categories.map((cat) => jint(cat)),
    code: item.code,
    customer_description: item.customerDescription,
    default_quantity: item.defaultQuantity,
    enabled: item.enabled,
    group: item.group,
    item_id: item.itemId,
    name: item.name,
    quantity_source: item.quantitySource,
    sort_order: jint(item.sortOrder),
    taxable: item.taxable,
    unit: item.unit,
    unit_price: item.unitPrice,
    waste_percent: item.wastePercent,
    xactimate_code: item.xactimateCode,
  };
  if (item.priceBrackets) body.price_brackets = item.priceBrackets.map((band) => bandToJ(band, 'unit_price'));
  return body;
}

export function policyToJ(policy: Policy): JObj {
  const range: JObj = {
    beyond_percent: policy.range.beyondPercent,
    first_percent: policy.range.firstPercent,
    first_sf: jint(policy.range.firstSf),
  };
  if (policy.range.brackets) range.brackets = policy.range.brackets.map((band) => bandToJ(band, 'percent'));
  const body: JObj = {
    after_hours: { label: policy.afterHours.label, multiplier: policy.afterHours.multiplier },
    area_basis: policy.areaBasis,
    cabinetry: { multiplier: policy.cabinetry.multiplier, scope: policy.cabinetry.scope },
    category_multipliers: { ...policy.categoryMultipliers },
    estimate_mode: policy.estimateMode,
    minimum_job_charge: policy.minimumJobCharge,
    overhead_profit_percent: policy.overheadProfitPercent,
    range,
    sales_tax: { enabled: policy.salesTax.enabled, percent: policy.salesTax.percent },
    show_line_breakdown: policy.showLineBreakdown,
  };
  if (policy.assist) {
    body.assist = {
      drying_days: jint(policy.assist.dryingDays),
      extra_drying_days: jint(policy.assist.extraDryingDays),
      hidden_damage_percent: { ...policy.assist.hiddenDamagePercent },
      range_method: policy.assist.rangeMethod,
    };
  }
  if (policy.bracketMode) body.bracket_mode = policy.bracketMode;
  return body;
}

export function contentHash(table: Table): string {
  const again = normalizeTable({ items: table.items.map((item) => itemToJ(item)), policy: policyToJ(policyOf(table)) }, false, []);
  if (again.items.length === 0) throw new Error('empty');
  const items = [...again.items].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  const payload = {
    calculation_version: V2,
    currency: CURRENCY,
    items: items.map((item) => itemToJ(item)),
    policy: policyToJ(again.policy),
  };
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

function policyOf(table: Table): Policy {
  return table.policy;
}
