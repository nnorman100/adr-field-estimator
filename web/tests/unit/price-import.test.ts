import { describe, expect, it } from 'vitest';
import { contentHash, parseTable } from '@/engine/table';
import { exportPriceList, PRICE_COLUMNS } from '@/lib/prices/csv';
import { applyPriceList, parseCsv, PriceImportError } from '@/lib/prices/import';
import { starterTable } from '@/lib/prices/starter';

// S4-7: reading a price list back (POST /api/prices/import) onto the working copy. The import
// changes prices and nothing else; what it refuses is named by line. tests/db/price-import-api.test.ts
// checks the route.

const POLICY = {
  estimate_mode: 'single',
  range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
  after_hours: { multiplier: '1' },
  category_multipliers: { '1': '1', '2': '1', '3': '1' },
  cabinetry: { multiplier: '1', scope: 'finished_only' },
  sales_tax: { enabled: false, percent: '0' },
  size_tiers: { s_up_to_sf: 100, m_up_to_sf: 200, l_up_to_sf: 300 },
  room_types: [{ id: 'kitchen', name: 'Kitchen', suggested_items: ['flooring'] }],
};

const flooring = {
  item_id: 'flooring',
  group: 'demolition',
  name: 'Flooring, removal',
  unit: 'sf',
  quantity_source: 'room:demolition:unfinished',
  unit_price: '2.00',
  trade: 'demo',
  rows: [{ category: 3, unit_price: '5.00' }],
};
const drywall = {
  item_id: 'drywall',
  group: 'demolition',
  name: 'Drywall',
  unit: 'sf',
  quantity_source: 'room:demolition:finished',
  unit_price: '',
  price_brackets: [
    { up_to_sf: 100, unit_price: '3.00' },
    { up_to_sf: null, unit_price: '2.50' },
  ],
};
const contents = {
  item_id: 'contents',
  group: 'treatment',
  name: 'Contents',
  unit: 'room',
  quantity_source: 'room:each',
  tier_prices: { s: '10.00', m: '20.00', l: '30.00', xl: '' },
  rows: [{ room_type: 'kitchen', tier_prices: { s: '11.00', m: '21.00', l: '31.00', xl: '41.00' } }],
  enabled: false,
};

const table = parseTable({ items: [flooring, drywall, contents], trades: [{ trade_id: 'demo', name: 'Demolition' }], policy: POLICY });
const exported = exportPriceList(table);

// The same file with one line's price cell replaced (the line is found by its start).
const withPrice = (start: string, price: string, file = exported) =>
  file
    .split('\r\n')
    .map((line) => (line.startsWith(start) ? `${line.slice(0, line.lastIndexOf(','))},${price}` : line))
    .join('\r\n');

const refusal = (file: string, against = table): string => {
  try {
    applyPriceList(against, file);
  } catch (error) {
    expect(error).toBeInstanceOf(PriceImportError);
    return (error as PriceImportError).detail;
  }
  throw new Error('the import was accepted');
};

describe('parseCsv', () => {
  it('reads quoted cells, doubled quotes, line breaks inside quotes, CRLF and LF, and a final line break', () => {
    expect(parseCsv('a,"b,c","say ""hi""","x\ny"\r\n1,,3,4\n')).toEqual([
      ['a', 'b,c', 'say "hi"', 'x\ny'],
      ['1', '', '3', '4'],
    ]);
  });

  it('drops a byte-order mark and refuses an unclosed quote', () => {
    expect(parseCsv('﻿a,b\r\n')).toEqual([['a', 'b']]);
    expect(() => parseCsv('a,"b\r\n')).toThrow(PriceImportError);
    expect(() => parseCsv('a,b"c\r\n')).toThrow(PriceImportError);
  });
});

describe('the round trip', () => {
  it('gives the same table, and so the same content hash, from an exported file', () => {
    const result = applyPriceList(table, exported);
    expect(result.changed).toBe(0);
    expect(contentHash(result.table)).toBe(contentHash(table));
    expect(result.table).toEqual(table);
  });

  it('holds for the starter list, whose prices are all blank, and for a priced one', () => {
    const starter = starterTable();
    expect(contentHash(applyPriceList(starter, exportPriceList(starter)).table)).toBe(contentHash(starter));
    const priced = parseTable({
      ...starter,
      items: starter.items.map((item) =>
        item.unit === 'room' ? { ...item, tier_prices: { s: '1', m: '2', l: '3', xl: '4' } } : { ...item, unit_price: '1.25' },
      ),
    });
    expect(contentHash(applyPriceList(priced, exportPriceList(priced)).table)).toBe(contentHash(priced));
  });

  it('survives a spreadsheet writing 2.5 for 2.50 and whole numbers for whole dollars', () => {
    const result = applyPriceList(table, withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '2.0'));
    expect(result.changed).toBe(0);
    expect(contentHash(result.table)).toBe(contentHash(table));
  });
});

describe('changing prices', () => {
  it('sets a unit price, a category row price, a band price, a size-tier price and a room-type row price', () => {
    let file = withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '2.75');
    file = withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,cat_3', '6.00', file);
    file = withPrice('drywall,DRYWALL,Drywall,demolition,,sf,true,default,,100,', '3.30', file);
    file = withPrice('drywall,DRYWALL,Drywall,demolition,,sf,true,default,,,,', '2.40', file);
    file = withPrice('contents,CONTENTS,Contents,treatment,,room,false,default,,,xl', '35.00', file);
    file = withPrice('contents,CONTENTS,Contents,treatment,,room,false,default,kitchen,,s', '12.00', file);
    const { table: next, changed } = applyPriceList(table, file);
    expect(changed).toBe(6);
    const [f, d, c] = ['flooring', 'drywall', 'contents'].map((id) => next.items.find((item) => item.item_id === id)!);
    expect(f!.unit_price).toBe('2.75');
    expect(f!.rows).toEqual([{ category: 3, unit_price: '6.00' }]);
    expect(d!.price_brackets).toEqual([
      { up_to_sf: 100, unit_price: '3.30' },
      { up_to_sf: null, unit_price: '2.40' },
    ]);
    expect(c!.tier_prices).toEqual({ s: '10.00', m: '20.00', l: '30.00', xl: '35.00' });
    expect(c!.rows![0]!.tier_prices).toEqual({ s: '12.00', m: '21.00', l: '31.00', xl: '41.00' });
    // Nothing but prices moved: the trades, the policy and the other items are the table's own.
    expect(next.trades).toEqual(table.trades);
    expect(next.policy).toEqual(table.policy);
    expect(c!.enabled).toBe(false);
    expect(contentHash(next)).not.toBe(contentHash(table));
  });

  it('leaves a price alone when its line is left out of the file', () => {
    const file = exported
      .split('\r\n')
      .filter((line) => !line.startsWith('drywall') && !line.startsWith('contents'))
      .join('\r\n');
    const { table: next, changed } = applyPriceList(table, withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '9.00', file));
    expect(changed).toBe(1);
    expect(next.items.find((item) => item.item_id === 'drywall')).toEqual(table.items.find((item) => item.item_id === 'drywall'));
  });

  it('sets a blank cell as a price not set yet', () => {
    const { table: next, changed } = applyPriceList(table, withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', ''));
    expect(changed).toBe(1);
    expect(next.items.find((item) => item.item_id === 'flooring')!.unit_price).toBe('');
  });

  it('accepts an LF file, a file with a byte-order mark and a header in capitals', () => {
    const header = PRICE_COLUMNS.join(',');
    const file = `﻿${header.toUpperCase()}\n${exported.slice(header.length + 2).replaceAll('\r\n', '\n')}`;
    expect(applyPriceList(table, file).changed).toBe(0);
  });
});

describe('what an import refuses', () => {
  it.each(['=1+1', '+5', '-5', '@SUM(A1)', '\t5', ' =5'])('refuses a cell that starts as a formula (%j), in any column', (cell) => {
    const price = refusal(withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', cell));
    expect(price).toContain('Line 2');
    expect(price).toContain('formula');
    // The cell's text is not repeated in the answer.
    expect(price).not.toContain('SUM');
    const name = refusal(exported.replace('Drywall', `${cell}Drywall`));
    expect(name).toContain('formula');
  });

  it('refuses a price the table would not hold, naming the item', () => {
    for (const price of ['12.345', 'abc', '"1,000.00"', '100001', '1e3']) {
      const detail = refusal(withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', price));
      expect(detail, price).toContain('flooring');
    }
  });

  it('refuses a price that breaks a table rule, such as a smaller room costing more than a larger one', () => {
    const detail = refusal(withPrice('contents,CONTENTS,Contents,treatment,,room,false,default,,,s', '99.00'));
    expect(detail).toContain('contents');
  });

  it('refuses a zero price the item has not been allowed to hold', () => {
    expect(refusal(withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '0.00'))).toContain('flooring');
  });

  it('refuses a header that is not the export’s, and a line with the wrong number of cells', () => {
    expect(refusal(exported.replace('item_id,', 'id,'))).toContain('header');
    expect(refusal(exported.replace('price\r\n', 'price,extra\r\n'))).toContain('header');
    expect(refusal('')).toContain('header');
    expect(refusal(`${exported}flooring,FLOORING\r\n`)).toContain('Line 14');
  });

  it('refuses a line for an item, row, band or tier the working copy does not have', () => {
    expect(refusal(`${exported}ghost,GHOST,Ghost,treatment,,sf,true,default,,,,1.00\r\n`)).toContain('Line 14');
    expect(refusal(withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,cat_3', '6.00').replace(',cat_3,', ',cat_2,'))).toContain('Line 3');
    expect(refusal(exported.replace('default,,100,', 'default,,150,'))).toContain('Line 4');
    expect(refusal(exported.replace('default,,,s,', 'default,,,xs,'))).toContain('tier');
  });

  it('refuses a line that repeats another, and a change to a name, unit, trade or switch', () => {
    const first = exported.split('\r\n')[1]!;
    expect(refusal(`${exported}${first}\r\n`)).toContain('repeats line 2');
    expect(refusal(exported.replace('"Flooring, removal"', 'Flooring removed'))).toContain('name');
    expect(refusal(exported.replace(',sf,true,default,,,,2.00', ',lf,true,default,,,,2.00'))).toContain('unit');
    expect(refusal(exported.replace(',demo,sf,', ',,sf,'))).toContain('trade');
    expect(refusal(exported.replace(',demolition,demo,', ',treatment,demo,'))).toContain('group');
    expect(refusal(exported.replace('CONTENTS,Contents,treatment,,room,false', 'CONTENTS,Contents,treatment,,room,true'))).toContain('enabled');
  });

  it('writes nothing to the table it was given', () => {
    const before = JSON.stringify(table);
    applyPriceList(table, withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '9.00'));
    expect(() => applyPriceList(table, withPrice('flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default', '=1'))).toThrow();
    expect(JSON.stringify(table)).toBe(before);
  });
});
