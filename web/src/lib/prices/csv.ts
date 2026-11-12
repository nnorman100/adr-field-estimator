import type { Item, Table } from '@/engine/table';

// The price list as a CSV file (GET /api/prices/export): one line per price, so every price an
// item holds can be read, or changed in a spreadsheet, without the rest of the table. The columns
// are fixed. `row` is the default row or the category it applies to; `room_type` is set only on a
// room-type row; `up_to_sf` is set on a square-foot band (empty on the last, open-ended band);
// `tier` is set on a per-room item's size-tier price. A price not set yet is an empty cell.
//
// Import (S4-7) reads a file the same way and writes only the working copy.

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

function priceLines(item: Item, row: RowShape, label: string): Cell[][] {
  const head: Cell[] = [item.item_id, item.code, item.name, item.group, item.trade ?? '', item.unit, item.enabled];
  const where: Cell[] = [label, row.room_type ?? ''];
  if (row.tier_prices) {
    return (['s', 'm', 'l', 'xl'] as const).map((tier) => [...head, ...where, '', tier, row.tier_prices![tier]]);
  }
  if (row.price_brackets) {
    return row.price_brackets.map((band) => [...head, ...where, band.up_to_sf ?? '', '', band.unit_price]);
  }
  return [[...head, ...where, '', '', row.unit_price ?? '']];
}

const categoryLabel = (category: RowShape['category']) => (category === undefined ? 'default' : `cat_${category}`);

// Every item in the table's order, its default row first, then its category rows and room-type rows
// in the table's own row order.
export function exportPriceList(table: Table): string {
  const lines: string[] = [line([...PRICE_COLUMNS])];
  for (const item of table.items) {
    const defaults: RowShape = {
      unit_price: item.unit_price,
      ...(item.price_brackets ? { price_brackets: item.price_brackets } : {}),
      ...(item.tier_prices ? { tier_prices: item.tier_prices } : {}),
    };
    const rows: Array<[string, RowShape]> = [['default', defaults]];
    for (const row of item.rows ?? []) rows.push([categoryLabel(row.category), row]);
    for (const [label, row] of rows) {
      for (const cells of priceLines(item, row, label)) lines.push(line(cells));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
