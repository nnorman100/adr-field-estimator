// The owner's price table: one Zod schema (PriceTableV3) for the editor, routes, import and engine.
// Every price, percent and multiplier is a Decimal string; a JSON number is only a whole count.
// The parsed table is canonical: parsing it again gives the same value, and its hash is stable.

import { z } from 'zod';

import { Dec } from './decimal';
import { canonical, sha256, type Json } from './json';
import { chars, printable } from './values';

/** The formulas that price a table today. S4-4a moves the engine to dryscope-v3. */
export const V2 = 'dryscope-v2';
const MAX_ITEMS = 150;
const MAX_BRACKETS = 20;
const MAX_SF = 100000;

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
const XACT = /^(?:[A-Z0-9][A-Z0-9 ._/-]{0,29})?$/;
const DECIMAL_RE = /^\d+(?:\.\d+)?$/;
const FORMULA = /^[=+\-@]/;

export type Source = {
  kind: 'room' | 'field' | 'count_days' | 'after_hours' | 'typed' | 'typed_count_days';
  field: string | null;
  countField: string | null;
  daysField: string | null;
  finish: 'finished' | 'unfinished' | null;
};

export function parseSource(text: string): Source {
  const empty = { field: null, countField: null, daysField: null, finish: null };
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

function knownSource(text: string): boolean {
  try {
    parseSource(text);
    return true;
  } catch {
    return false;
  }
}

type DecimalRule = { min?: string; max: string; places: number; cents?: boolean; blank?: boolean };

/**
 * A Decimal string within the rule's range and places, kept as money (2 places) or normalized.
 * With `blank`, an empty string is kept as '' (a price not set yet).
 */
function decimal(rule: DecimalRule) {
  const low = Dec.parse(rule.min ?? '0');
  const high = Dec.parse(rule.max);
  return z.string().transform((raw, ctx) => {
    const text = raw.trim();
    if (rule.blank && text === '') return '';
    const problem = !DECIMAL_RE.test(text)
      ? 'must be a decimal number written as text, such as "12.50"'
      : (text.split('.')[1] ?? '').length > rule.places
        ? `must have at most ${rule.places} decimal places`
        : Dec.parse(text).cmp(low) < 0 || Dec.parse(text).cmp(high) > 0
          ? `must be from ${rule.min ?? '0'} to ${rule.max}`
          : null;
    if (problem) {
      ctx.addIssue({ code: 'custom', message: problem });
      return z.NEVER;
    }
    return rule.cents
      ? Dec.parse(text).quantize(-2, 'HALF_EVEN').toString()
      : Dec.parse(text).normalize().format('f');
  });
}

/** A price in cents, or blank for a price not set yet. Blank blocks publishing an enabled item. */
const price = decimal({ max: '100000', places: 2, cents: true, blank: true });

const percent = decimal({ max: '100', places: 2 });
const multiplier = (max: string) => decimal({ min: '1', max, places: 3 });

function text(min: number, max: number) {
  return z
    .string()
    .trim()
    .refine((value) => chars(value) >= min && chars(value) <= max, {
      message: `must be ${min} to ${max} characters`,
    })
    .refine((value) => printable(value), { message: 'must be printable text on one line' })
    .refine((value) => !FORMULA.test(value), { message: 'must not start with = + - or @' });
}

const limit = z.number().int().min(1).max(MAX_SF).nullable();
const PRICE_BAND = z.strictObject({ up_to_sf: limit, unit_price: price });
const CUSHION_BAND = z.strictObject({ up_to_sf: limit, percent });

/** Band limits rise strictly and the last band is open-ended. */
function checkBands(bands: Array<{ up_to_sf: number | null }>, ctx: z.RefinementCtx, path: string[]) {
  let previous = 0;
  bands.forEach((band, index) => {
    const last = index === bands.length - 1;
    if (last ? band.up_to_sf !== null : band.up_to_sf === null || band.up_to_sf <= previous) {
      ctx.addIssue({
        code: 'custom',
        path: [...path, index, 'up_to_sf'],
        message: last ? 'the last band must be open-ended' : 'band limits must rise',
      });
    }
    previous = band.up_to_sf ?? previous;
  });
}

type ParsedItem = {
  item_id: string;
  code: string;
  group: (typeof GROUPS)[number];
  name: string;
  customer_description: string;
  unit: (typeof UNITS)[number];
  quantity_source: string;
  unit_price: string;
  allow_zero: boolean;
  default_quantity: string;
  waste_percent: string;
  categories: number[];
  taxable: boolean;
  xactimate_code: string;
  enabled: boolean;
  sort_order: number;
  price_brackets?: Array<{ up_to_sf: number | null; unit_price: string }>;
};

type ParsedRange = {
  first_sf: number;
  first_percent: string;
  beyond_percent: string;
  brackets?: Array<{ up_to_sf: number | null; percent: string }>;
};

function defaultCode(itemId: string): string {
  return itemId.toUpperCase().replaceAll('_', '-').slice(0, 16);
}

function isZeroPrice(value: string): boolean {
  return value !== '' && Dec.parse(value).isZero();
}

const ITEM = z
  .strictObject({
    item_id: z.string().regex(ITEM_ID, 'must be 2 to 40 lowercase letters, digits or _'),
    code: z.string().trim().nullish(),
    group: z.enum(GROUPS),
    name: text(1, 80),
    customer_description: text(0, 300).nullish(),
    unit: z.enum(UNITS),
    quantity_source: z.string().refine(knownSource, { message: 'unknown quantity source' }),
    unit_price: price.nullish(),
    allow_zero: z.boolean().default(false),
    default_quantity: decimal({ max: '100000', places: 2 }).default('0'),
    waste_percent: percent.default('0'),
    categories: z
      .array(z.union([z.literal(1), z.literal(2), z.literal(3)]))
      .max(3)
      .nullish(),
    taxable: z.boolean().default(false),
    xactimate_code: z.string().trim().regex(XACT, 'not a valid line note').nullish(),
    enabled: z.boolean().default(true),
    sort_order: z.number().int().min(0).max(10000).nullish(),
    price_brackets: z.array(PRICE_BAND).min(1).max(MAX_BRACKETS).optional(),
  })
  .superRefine((item, ctx) => {
    const code = item.code ? item.code : defaultCode(item.item_id);
    if (!CODE_RE.test(code)) ctx.addIssue({ code: 'custom', path: ['code'], message: 'invalid code' });
    if (new Set(item.categories ?? []).size !== (item.categories ?? []).length) {
      ctx.addIssue({ code: 'custom', path: ['categories'], message: 'categories repeat' });
    }
    if (!knownSource(item.quantity_source)) return;
    const source = parseSource(item.quantity_source);
    if (item.group === 'demolition' && item.unit === 'sf' && source.kind !== 'room') {
      ctx.addIssue({ code: 'custom', path: ['quantity_source'], message: 'demolition by sq ft is priced per room' });
    }
    if (item.group === 'extras' && item.unit !== 'hour') {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'additional work is priced by the hour' });
    }
    if (item.price_brackets) {
      if (item.unit !== 'sf' || (source.kind !== 'room' && source.kind !== 'typed')) {
        ctx.addIssue({ code: 'custom', path: ['price_brackets'], message: 'brackets need a sq ft item' });
      }
      checkBands(item.price_brackets, ctx, ['price_brackets']);
    }
    const zero =
      isZeroPrice(item.unit_price ?? '') ||
      (item.price_brackets ?? []).some((band) => isZeroPrice(band.unit_price));
    if (zero && !item.allow_zero) {
      ctx.addIssue({ code: 'custom', path: ['unit_price'], message: 'a zero price needs allow_zero' });
    }
    const whole =
      (source.kind === 'field' && !DECIMAL_FIELDS.has(source.field ?? '')) ||
      source.kind === 'count_days' ||
      source.kind === 'typed_count_days';
    if (whole && item.default_quantity.includes('.')) {
      ctx.addIssue({ code: 'custom', path: ['default_quantity'], message: 'must be a whole number' });
    }
  })
  .transform((item): ParsedItem => {
    const out: ParsedItem = {
      item_id: item.item_id,
      code: item.code ? item.code : defaultCode(item.item_id),
      group: item.group,
      name: item.name,
      customer_description: item.customer_description ?? '',
      unit: item.unit,
      quantity_source: item.quantity_source,
      unit_price: item.unit_price ?? '',
      allow_zero: item.allow_zero,
      default_quantity: item.default_quantity,
      waste_percent: item.waste_percent,
      categories: [...(item.categories ?? [])].sort((a, b) => a - b),
      taxable: item.taxable,
      xactimate_code: item.xactimate_code ?? '',
      enabled: item.enabled,
      sort_order: item.sort_order ?? 0,
    };
    if (item.price_brackets) out.price_brackets = item.price_brackets;
    return out;
  });

const RANGE = z
  .strictObject({
    first_sf: z.number().int().min(1).max(MAX_SF).optional(),
    first_percent: percent.optional(),
    beyond_percent: percent.optional(),
    brackets: z.array(CUSHION_BAND).min(1).max(MAX_BRACKETS).optional(),
  })
  .superRefine((range, ctx) => {
    if (range.brackets) {
      checkBands(range.brackets, ctx, ['brackets']);
      return;
    }
    if (range.first_sf === undefined || range.first_percent === undefined || range.beyond_percent === undefined) {
      ctx.addIssue({ code: 'custom', message: 'needs first_sf, first_percent and beyond_percent, or brackets' });
    } else if (Dec.parse(range.beyond_percent).cmp(Dec.parse(range.first_percent)) > 0) {
      ctx.addIssue({ code: 'custom', path: ['beyond_percent'], message: 'must not exceed first_percent' });
    }
  })
  .transform((range): ParsedRange => {
    const out: ParsedRange = {
      first_sf: range.first_sf ?? 1000,
      first_percent: range.first_percent ?? '50',
      beyond_percent: range.beyond_percent ?? '20',
    };
    if (range.brackets) out.brackets = range.brackets;
    return out;
  });

const ASSIST_DEFAULT = {
  drying_days: 3,
  range_method: 'cushion' as const,
  extra_drying_days: 0,
  hidden_damage_percent: { '1': '0', '2': '0', '3': '0' },
};

const ASSIST = z.strictObject({
  drying_days: z.number().int().min(1).max(60).default(3),
  range_method: z.enum(['cushion', 'uncertainty']).default('cushion'),
  extra_drying_days: z.number().int().min(0).max(30).default(0),
  hidden_damage_percent: z
    .strictObject({ '1': percent, '2': percent, '3': percent })
    .default({ '1': '0', '2': '0', '3': '0' }),
});

const POLICY = z.strictObject({
  estimate_mode: z.enum(['range', 'single']).default('range'),
  area_basis: z.enum(['demolition', 'demolition_with_waste', 'wet_floor']).default('demolition'),
  range: RANGE,
  after_hours: z.strictObject({
    multiplier: multiplier('2'),
    label: text(1, 80).default(DEFAULT_AFTER_HOURS_LABEL),
  }),
  category_multipliers: z.strictObject({ '1': multiplier('3'), '2': multiplier('3'), '3': multiplier('3') }),
  cabinetry: z.strictObject({
    multiplier: multiplier('3'),
    scope: z.enum(['finished_only', 'all_cat3']),
  }),
  minimum_job_charge: decimal({ max: '100000', places: 2 }).default('0'),
  overhead_profit_percent: percent.default('0'),
  sales_tax: z.strictObject({
    enabled: z.boolean(),
    percent: decimal({ max: '15', places: 3 }).default('0'),
  }),
  show_line_breakdown: z.boolean().default(false),
  assist: ASSIST.nullish().transform((assist) => assist ?? ASSIST_DEFAULT),
  bracket_mode: z.enum(['tiered', 'whole-job']).default('tiered'),
});

export const PriceTableV3 = z
  .strictObject({ items: z.array(ITEM).max(MAX_ITEMS), policy: POLICY })
  .superRefine((table, ctx) => {
    const ids = new Set<string>();
    const codes = new Set<string>();
    table.items.forEach((item, index) => {
      if (ids.has(item.item_id) || codes.has(item.code)) {
        ctx.addIssue({ code: 'custom', path: ['items', index], message: 'repeats an item id or code' });
      }
      ids.add(item.item_id);
      codes.add(item.code);
    });
    if (table.items.filter((item) => item.group === 'extras' && item.enabled).length > 1) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'only one additional-work item may be on' });
    }
  });

export type Table = z.output<typeof PriceTableV3>;
export type Item = Table['items'][number];
export type Policy = Table['policy'];
export type PriceBand = z.output<typeof PRICE_BAND>;
export type CushionBand = z.output<typeof CUSHION_BAND>;

/** Parse a table, or throw one readable sentence naming the first problem. */
export function parseTable(raw: unknown): Table {
  const result = PriceTableV3.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new Error(`${where}${issue?.message ?? 'invalid price table'}`);
}

/** A price not set yet: a blank unit price without brackets, or a blank band. */
export function blankPrice(item: Item): boolean {
  if (item.unit_price === '' && !item.price_brackets) return true;
  return (item.price_brackets ?? []).some((band) => band.unit_price === '');
}

function zeroPrice(item: Item): boolean {
  return isZeroPrice(item.unit_price) || (item.price_brackets ?? []).some((band) => isZeroPrice(band.unit_price));
}

/**
 * The publish rules on a parsed table: at least one item, no blank price on an enabled item, and
 * every zero price on an enabled item confirmed by its id or code in `acknowledgements`.
 */
export function checkPublishable(table: Table, acknowledgements: string[]): void {
  const acked = new Set(acknowledgements);
  if (!table.items.some((item) => item.enabled)) throw new Error('items: no item is on');
  for (const item of table.items) {
    if (!item.enabled) continue;
    if (blankPrice(item)) throw new Error(`${item.item_id}: the price is blank`);
    if (zeroPrice(item) && !acked.has(item.item_id) && !acked.has(item.code)) {
      throw new Error(`${item.item_id}: confirm the zero price`);
    }
  }
}

export function cushionBrackets(policy: Policy): CushionBand[] {
  if (policy.range.brackets) {
    return policy.range.brackets.map((band) => ({ ...band }));
  }
  return [
    { up_to_sf: policy.range.first_sf, percent: policy.range.first_percent },
    { up_to_sf: null, percent: policy.range.beyond_percent },
  ];
}

export function hasCushionBrackets(policy: Policy): boolean {
  return Boolean(policy.range.brackets);
}

/** SHA-256 of the canonical JSON of the parsed table, items in id order. */
export function contentHash(table: Table): string {
  const items = [...table.items].sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
  return sha256(canonical({ items, policy: table.policy } as unknown as Json));
}
