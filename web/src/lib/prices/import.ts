import { parseTable, type Table } from '@/engine/table';
import { PRICE_COLUMNS, priceLocations } from './csv';

// Reading a price list back onto the working copy (S4-7, POST /api/prices/import). CSV only (Q9).
//
// What an import is: the file GET /api/prices/export writes, with prices changed. Each line is
// matched to one price of the working copy by its item, row, room type, band limit and size tier;
// the line's price replaces that price, and nothing else in the table moves. The columns before the
// price say which item a line is about, so each must still be what the working copy holds: names,
// units, trades and the on/off switch are changed in the editor, not here, and a line that disagrees
// is refused rather than half applied. A price the file leaves out keeps its price; a blank cell
// sets a price back to "not set yet". Bands and their limits are the editor's too.
//
// A cell that starts with = + - @ or a tab is refused, not repaired: a spreadsheet would run it as a
// formula, so the file is not one this app wrote. (A negative price starts with - and so is refused
// here as well as by the table's own rules.) Every refusal names the line and the column, never the
// cell's text. The result is parsed by the one table schema (`parseTable`), so a price breaking a
// table rule is refused with that rule's sentence and the item's id.

export class PriceImportError extends Error {
  constructor(readonly detail: string) {
    super('Price import refused');
    this.name = 'PriceImportError';
  }
}

const MAX_CELL_CHARS = 200;
const FORMULA_START = /^[=+\-@\t\r]/;
// Columns in the file that say which price a line is about, compared with the working copy's.
const KEY_COLUMNS = ['item_id', 'row', 'room_type', 'up_to_sf', 'tier'] as const;
const CONTEXT_COLUMNS = ['code', 'name', 'group', 'trade', 'unit', 'enabled'] as const;

const column = (name: (typeof PRICE_COLUMNS)[number]) => PRICE_COLUMNS.indexOf(name);

// RFC 4180 reading: quoted cells, "" for a quote, line breaks (CRLF or LF) inside quotes, an
// optional byte-order mark, and no record for a final line break. A line holding one empty cell is
// a blank line and is skipped.
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let started = false;
  const endCell = () => {
    record.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (!(record.length === 1 && record[0] === '')) records.push(record);
    record = [];
    started = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
      continue;
    }
    if (char === '"') {
      if (cell !== '') throw new PriceImportError('A quote opens in the middle of a cell.');
      quoted = true;
      started = true;
    } else if (char === ',') {
      endCell();
      started = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      endRecord();
    } else {
      cell += char;
      started = true;
    }
  }
  if (quoted) throw new PriceImportError('A quote is never closed.');
  if (started || cell !== '') endRecord();
  return records;
}

const isFormula = (cell: string) => FORMULA_START.test(cell) || FORMULA_START.test(cell.trimStart());

// The key of a price: the columns that say which one it is. An up_to_sf written by a spreadsheet as
// 100.0 is still 100.
function keyOf(cells: string[]): string {
  return KEY_COLUMNS.map((name) => {
    const cell = (cells[column(name)] ?? '').trim();
    return name === 'up_to_sf' && /^\d+(\.0+)?$/.test(cell) ? String(Number(cell)) : cell;
  }).join('\u0000');
}

// The name of an item, in the sentence a refusal gives, for a path such as `items.3.unit_price`
// that the schema reports by position.
function nameItems(message: string, table: { items: Array<{ item_id: string }> }): string {
  return message.replace(/^items\.(\d+)(\.|$)/, (whole, index: string, tail: string) => {
    const id = table.items[Number(index)]?.item_id;
    return id ? `item ${id}${tail === '.' ? ': ' : ''}` : whole;
  });
}

// The working copy with the file's prices applied, and how many prices that changed. Nothing is
// written to `table`; a refusal throws a PriceImportError whose `detail` says what to fix.
export function applyPriceList(table: Table, csv: string): { table: Table; changed: number } {
  const records = parseCsv(csv);
  const header = records[0]?.map((cell) => cell.trim().toLowerCase());
  if (!header || header.length !== PRICE_COLUMNS.length || PRICE_COLUMNS.some((name, index) => header[index] !== name)) {
    throw new PriceImportError(`The first line must be the header: ${PRICE_COLUMNS.join(',')}.`);
  }

  const draft = structuredClone(table);
  const locations = new Map(priceLocations(draft).map((location) => [keyOf(location.cells), location]));
  const seen = new Map<string, number>();
  records.slice(1).forEach((cells, index) => {
    const lineNumber = index + 2;
    if (cells.length !== PRICE_COLUMNS.length) {
      throw new PriceImportError(`Line ${lineNumber} has ${cells.length} cells; every line has ${PRICE_COLUMNS.length}.`);
    }
    for (const [at, cell] of cells.entries()) {
      if (cell.length > MAX_CELL_CHARS) {
        throw new PriceImportError(`Line ${lineNumber}, column ${PRICE_COLUMNS[at]}: the cell is too long.`);
      }
      if (isFormula(cell)) {
        throw new PriceImportError(
          `Line ${lineNumber}, column ${PRICE_COLUMNS[at]}: a cell may not start with = + - @ or a tab (a spreadsheet would run it as a formula).`,
        );
      }
    }
    const key = keyOf(cells);
    const earlier = seen.get(key);
    if (earlier !== undefined) throw new PriceImportError(`Line ${lineNumber} repeats line ${earlier}.`);
    seen.set(key, lineNumber);
    const location = locations.get(key);
    if (!location) {
      const tier = cells[column('tier')]!.trim();
      throw new PriceImportError(
        tier !== '' && !['s', 'm', 'l', 'xl'].includes(tier)
          ? `Line ${lineNumber}: the tier must be s, m, l or xl.`
          : `Line ${lineNumber}: the working copy has no such price (item, row, room type, band limit and tier must be as exported).`,
      );
    }
    for (const name of CONTEXT_COLUMNS) {
      const want = location.cells[column(name)]!;
      const got = cells[column(name)]!.trim();
      if (name === 'enabled' ? got.toLowerCase() !== want : got !== want) {
        throw new PriceImportError(`Line ${lineNumber}: ${name} differs from the working copy; change it in the editor, not in the file.`);
      }
    }
    location.set(cells[column('price')]!.trim());
  });

  let next: Table;
  try {
    next = parseTable(draft);
  } catch (error) {
    throw new PriceImportError(nameItems(error instanceof Error ? error.message : 'invalid price table', draft));
  }
  // The table keeps its structure, so its prices are in the same order before and after.
  const before = priceLocations(table);
  const after = priceLocations(next);
  const changed = after.filter((location, index) => location.cells.at(-1) !== before[index]?.cells.at(-1)).length;
  return { table: next, changed };
}
