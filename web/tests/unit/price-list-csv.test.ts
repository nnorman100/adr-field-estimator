import { describe, expect, it } from 'vitest';
import { parseTable } from '@/engine/table';
import { csvCell, exportPriceList, PRICE_COLUMNS } from '@/lib/prices/csv';
import { readerTable } from '@/lib/prices/service';

// The CSV price list (GET /api/prices/export): one line per price, in fixed columns, safe to open in
// a spreadsheet. tests/db/prices-api.test.ts checks the route; these check the file.

const POLICY = {
  estimate_mode: 'single',
  range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
  after_hours: { multiplier: '1' },
  category_multipliers: { '1': '1', '2': '1', '3': '1' },
  cabinetry: { multiplier: '1', scope: 'finished_only' },
  sales_tax: { enabled: false, percent: '0' },
  size_tiers: { s_up_to_sf: 100, m_up_to_sf: 200, l_up_to_sf: 300 },
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
  enabled: false,
};

describe('csvCell', () => {
  it('quotes a cell with a comma, a quote or a line break, and leaves plain text alone', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(12)).toBe('12');
    expect(csvCell(true)).toBe('true');
  });

  it('never writes a cell a spreadsheet would run as a formula', () => {
    for (const text of ['=SUM(A1)', '+1', '-1', '@x', '\tcmd', '\rcmd']) {
      expect(csvCell(text).replaceAll('"', '').startsWith("'"), text).toBe(true);
    }
  });
});

describe('exportPriceList', () => {
  const table = parseTable({ items: [flooring, drywall, contents], trades: [{ trade_id: 'demo', name: 'Demolition' }], policy: POLICY });
  const lines = exportPriceList(table).split('\r\n');

  it('starts with the fixed header and ends with a line break', () => {
    expect(lines[0]).toBe(PRICE_COLUMNS.join(','));
    expect(lines.at(-1)).toBe('');
  });

  it('writes the default row, then each category row, one line per price', () => {
    expect(lines.slice(1, 3)).toEqual([
      'flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,default,,,,2.00',
      'flooring,FLOORING,"Flooring, removal",demolition,demo,sf,true,cat_3,,,,5.00',
    ]);
  });

  it('writes one line per square-foot band, the open-ended one with no limit', () => {
    expect(lines.slice(3, 5)).toEqual([
      'drywall,DRYWALL,Drywall,demolition,,sf,true,default,,100,,3.00',
      'drywall,DRYWALL,Drywall,demolition,,sf,true,default,,,,2.50',
    ]);
  });

  it('writes one line per size tier, a blank price as an empty cell, and a switched-off item as false', () => {
    expect(lines.slice(5, 9)).toEqual([
      'contents,CONTENTS,Contents,treatment,,room,false,default,,,s,10.00',
      'contents,CONTENTS,Contents,treatment,,room,false,default,,,m,20.00',
      'contents,CONTENTS,Contents,treatment,,room,false,default,,,l,30.00',
      'contents,CONTENTS,Contents,treatment,,room,false,default,,,xl,',
    ]);
    expect(lines).toHaveLength(1 + 8 + 1);
  });
});

describe('readerTable', () => {
  it('keeps the enabled items and drops them from the room types’ suggested lists', () => {
    const table = parseTable({
      items: [flooring, drywall, contents],
      trades: [{ trade_id: 'demo', name: 'Demolition' }],
      policy: { ...POLICY, room_types: [{ id: 'kitchen', name: 'Kitchen', suggested_items: ['flooring', 'contents'] }] },
    });
    const reader = readerTable(table);
    expect(reader.items.map((item) => item.item_id)).toEqual(['flooring', 'drywall']);
    expect(reader.policy.room_types[0]!.suggested_items).toEqual(['flooring']);
    // The owner's table is not touched.
    expect(table.items).toHaveLength(3);
  });
});
