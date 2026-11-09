// Shared conversions. Money stays on Dec; a float is only the Python JSON number.

import { Dec, HUNDRED, ONE, ZERO } from './decimal';
import { JFloat, JInt, type JObj, type JVal, decFromFloat, jfloat, jint } from './json';

export function isObj(value: JVal | undefined): value is JObj {
  return (
    value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof JInt) &&
    !(value instanceof JFloat)
  );
}

export function has(obj: JObj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function truthy(value: Dec): boolean {
  return !value.isZero();
}

export function sub(left: Dec, right: Dec): Dec {
  return left.add(right.neg());
}

export function decInt(value: number): Dec {
  return Object.is(value, -0) ? ZERO : Dec.fromInt(value);
}

/** Decimal(str(float)) for a field pydantic stored as a float. */
export function decFloat(value: number): Dec {
  return decFromFloat(value);
}

/** Python `current or 0`: 0, -0 and null become Decimal(0), not Decimal('0.0'). */
export function orZero(kind: 'int' | 'float', value: number | null): Dec {
  if (value === null || value === 0 || Object.is(value, -0)) return ZERO;
  return kind === 'int' ? decInt(value) : decFloat(value);
}

export function numberText(value: Dec): string {
  return value.normalize().format(',f');
}

export function commas(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function floatMoney(value: number): string {
  return decFloat(value).format(',.2f');
}

export function fixedText(value: Dec, places: number): string {
  return value.quantize(-places, 'HALF_EVEN').toString();
}

export function collapse(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
}

export function oneLine(value: string): string {
  return value.split(/\s+/).filter(Boolean).join(' ');
}

export function jf(value: number): JFloat {
  return jfloat(value);
}

export function ji(value: number): JInt {
  return jint(value);
}

export function percentOf(value: Dec): Dec {
  return value.div(HUNDRED);
}

export function onePlus(value: Dec): Dec {
  return ONE.add(value);
}

export type PriceLine = {
  code: string;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  waste: number;
  total: number;
  itemId?: string | null;
  group?: string;
  bucket?: string;
  taxable?: boolean;
  xactimateCode?: string;
  room?: string | null;
  area?: number | null;
  priceBracket?: { upToSf: number | null; unitPrice: string } | null;
  bracketMode?: string | null;
};

export function lineToJ(line: PriceLine): JObj {
  const body: JObj = {
    code: line.code,
    description: line.description,
    quantity: jfloat(line.quantity),
    total: jfloat(line.total),
    unit: line.unit,
    unit_price: jfloat(line.unitPrice),
    waste_percent: jfloat(line.waste),
  };
  if (line.group === undefined) return body;
  body.area = line.area == null ? null : jfloat(line.area);
  body.bucket = line.bucket ?? '';
  body.group = line.group;
  body.item_id = line.itemId ?? null;
  body.room = line.room ?? null;
  body.taxable = line.taxable ?? false;
  body.xactimate_code = line.xactimateCode ?? '';
  if (line.priceBracket) {
    body.bracket_mode = line.bracketMode ?? '';
    body.price_bracket = {
      unit_price: line.priceBracket.unitPrice,
      up_to_sf: line.priceBracket.upToSf === null ? null : jint(line.priceBracket.upToSf),
    };
  }
  return body;
}

export const V2_LINE_KEYS = [
  'price_bracket',
  'bracket_mode',
  'code',
  'description',
  'quantity',
  'unit',
  'unit_price',
  'waste_percent',
  'total',
  'xactimate_code',
] as const;

export function documentLine(line: PriceLine, v2: boolean): JObj {
  const full = lineToJ(line);
  if (!v2) return full;
  const out: JObj = {};
  for (const key of V2_LINE_KEYS) {
    if (has(full, key)) out[key] = full[key] as JVal;
  }
  return out;
}
