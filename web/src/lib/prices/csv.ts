import type { Item, Table } from '@/engine/table';

// The price list as a CSV file (GET /api/prices/export): one line per price, so every price an
// item holds can be read, or changed in a spreadsheet, without the rest of the table. The columns
// are fixed. `row` is the default row or the category it applies to; `room_type` is set only on a
// room-type row; `up_to_sf` is set on a square-foot band (empty on the last, open-ended band);
// `tier` is set on a per-room item's size-tier price. A price not set yet is an empty cell.
//
// Import (S4-7, import.ts) reads a file the same way and writes only the working copy.

export const PRICE_COLUMNS = [
  'item_id',
  'code',
  'name',
  'group',
  'trade',
  'unit',
  'enabled',
  'row',
  'room_type',
  'up_to_sf',
  'tier',
  'price',
] as const;

type Cell = string | number | boolean | undefined;

// A cell a spreadsheet would run as a formula starts with one of these; the table's schema already
// refuses such text, and one is neutralised here as a second guard rather than written as it came.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: Cell): string {
  const text = value === undefined ? '' : String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function line(cells: Cell[]): string {
  return cells.map(csvCell).join(',');
}

type RowShape = {
  category?: 1 | 2 | 3 | 'mold';
  room_type?: string;
  unit_price?: string;
  price_brackets?: Array<{ up_to_sf: number | null; unit_price: string }>;
  tier_prices?: { s: string; m: string; l: string; xl: string };
};

// One price the file holds: its line (the columns before the price, then the price) and the way to
// set that price on the table the location was read from.
export type PriceLocation = { cells: string[]; set: (price: string) => void };

function priceLocationsOf(item: Item, row: RowShape, label: string): PriceLocation[] {
  const head: Cell[] = [item.item_id, item.code, item.name, item.group, item.trade ?? '', item.unit, item.enabled];
  const where: Cell[] = [label, row.room_type ?? ''];
  const at = (rest: Cell[], set: (price: string) => void, price: string): PriceLocation => ({
    cells: [...head, ...where, ...rest, price].map((cell) => (cell === undefined ? '' : String(cell))),
    set,
  });
  if (row.tier_prices) {
    const tiers = row.tier_prices;
    return (['s', 'm', 'l', 'xl'] as const).map((tier) => at(['', tier], (price) => void (tiers[tier] = price), tiers[tier]));
  }
  if (row.price_brackets) {
    return row.price_brackets.map((band) => at([band.up_to_sf ?? '', ''], (price) => void (band.unit_price = price), band.unit_price));
  }
  return [at(['', ''], (price) => void (row.unit_price = price), row.unit_price ?? '')];
}

const categoryLabel = (category: RowShape['category']) => (category === undefined ? 'default' : `cat_${category}`);

// Every price of the table in the file's order: each item in the table's order, its default row
// first, then its category rows and room-type rows in the table's own row order. The export writes
// these lines and the import (import.ts) matches a file's lines to them, so the two cannot drift.
// `set` changes the table the locations were read from, so read them from a copy to change it.
export function priceLocations(table: Table): PriceLocation[] {
  const out: PriceLocation[] = [];
  for (const item of table.items) {
    out.push(...priceLocationsOf(item, item, 'default'));
    for (const row of item.rows ?? []) out.push(...priceLocationsOf(item, row, categoryLabel(row.category)));
  }
  return out;
}

export function exportPriceList(table: Table): string {
  const lines: string[] = [line([...PRICE_COLUMNS])];
  for (const location of priceLocations(table)) lines.push(line(location.cells));
  return `${lines.join('\r\n')}\r\n`;
}
