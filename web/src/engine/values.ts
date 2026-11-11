// Shared conversions. Every quantity, price and amount is a Dec; text checks count code points.

import type { Dec } from './decimal';
import type { JObj } from './json';

export function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function truthy(value: Dec): boolean {
  return !value.isZero();
}

export function numberText(value: Dec): string {
  return value.normalize().format(',f');
}

export function commas(value: number): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(Math.trunc(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Code points, so a length limit counts what a person sees as one character. */
export function chars(value: string): number {
  return Array.from(value).length;
}

/** No control, format, private-use, unassigned or separator characters other than a plain space. */
export function printable(text: string): boolean {
  return !/[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u.test(text);
}

export function oneLine(value: string): string {
  return value.split(/\s+/u).filter(Boolean).join(' ');
}

/** The key two room names share when they differ only in spacing or letter case. */
export function collapse(value: string): string {
  return oneLine(value).toLowerCase();
}

export type PriceLine = {
  code: string;
  description: string;
  quantity: Dec;
  unit: string;
  unitPrice: Dec;
  waste: Dec;
  total: Dec;
  itemId: string | null;
  group: string;
  bucket: string;
  taxable: boolean;
  xactimateCode: string;
  room: string | null;
  /** The square feet a room line prices; null on a job line. */
  area: Dec | null;
  priceBracket?: { upToSf: number | null; unitPrice: string } | null;
  bracketMode?: string | null;
};

/** A line on the itemized claim, money as Decimal strings. */
export function lineJson(line: PriceLine): JObj {
  const body: JObj = {
    code: line.code,
    description: line.description,
    quantity: line.quantity.normalize().format('f'),
    total: line.total.format('.2f'),
    unit: line.unit,
    unit_price: line.unitPrice.normalize().format('f'),
    waste_percent: line.waste.normalize().format('f'),
    xactimate_code: line.xactimateCode,
  };
  if (line.priceBracket) {
    body.bracket_mode = line.bracketMode ?? '';
    body.price_bracket = {
      unit_price: line.priceBracket.unitPrice,
      up_to_sf: line.priceBracket.upToSf,
    };
  }
  return body;
}
