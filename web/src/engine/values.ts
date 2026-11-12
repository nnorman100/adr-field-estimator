// Shared conversions. Every quantity, price and amount is a Dec; text checks count code points.

import type { Dec } from './decimal';
import type { JObj } from './json';

/** A room's category: water Category 1, 2 or 3, or Mold. Only water rooms take a category multiplier. */
export const CATEGORIES = [1, 2, 3, 'mold'] as const;
export type Category = (typeof CATEGORIES)[number];
export type WaterCategory = 1 | 2 | 3;

export function isWater(category: Category): category is WaterCategory {
  return category !== 'mold';
}

/** Categories in list order: 1, 2, 3, then Mold. */
export function categoryOrder(left: Category, right: Category): number {
  return CATEGORIES.indexOf(left) - CATEGORIES.indexOf(right);
}

/** Room-size tiers, smallest to largest. The owner sets where each ends in square feet. */
export const SIZE_TIERS = ['s', 'm', 'l', 'xl'] as const;
export type SizeTier = (typeof SIZE_TIERS)[number];

/** S520 mold condition: 1 normal fungal ecology, 2 settled spores, 3 actual growth. */
export const MOLD_CONDITIONS = [1, 2, 3] as const;
export type MoldCondition = (typeof MOLD_CONDITIONS)[number];

/** Containment follows the affected area: up to 10 sq ft, over 10 through 100, over 100. */
export const AFFECTED_BANDS = ['up_to_10', 'over_10_to_100', 'over_100'] as const;
export type AffectedBand = (typeof AFFECTED_BANDS)[number];

/** The room type every room has until the estimator picks one; it always exists. */
export const OTHER_TYPE = 'other';

/** "Cat 3" or "Mold", as a document line names the row that priced it. */
export function categoryLabel(category: Category): string {
  return isWater(category) ? `Cat ${category}` : 'Mold';
}

/** "category 3 work" or "mold work", as a warning names it. */
export function categoryWords(category: Category): string {
  return isWater(category) ? `category ${category}` : 'mold';
}

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
  /** The percent of the line sales tax applies to when the item is taxable (100 unless the owner set a share). */
  materialsShare: Dec;
  /** The item takes the after-hours multiplier on an after-hours job. */
  afterHours: boolean;
  /** Overhead and profit is not charged on this line. */
  noOverheadProfit: boolean;
  /** The trade heading the item sits under, whose minimum charge it counts toward. */
  trade: string | null;
  xactimateCode: string;
  room: string | null;
  /** The square feet a room line prices; null on a job line. */
  area: Dec | null;
  /** The key of the row that priced a room line (room type and category); null or absent for the default row. */
  priceRow?: string | null;
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
