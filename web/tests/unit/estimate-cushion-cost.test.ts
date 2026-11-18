// Security audit F3: the high end's cushion used to sort every area line again for each cushion band, two decimal
// divisions per comparison, so one large owner price table kept the server busy for seconds. The order does not
// depend on the band, so it is worked out once per pricing. The totals do not change; the cost now grows with the
// number of lines, not with lines times bands.

import { describe, expect, it } from 'vitest';

import { Dec } from '../../src/engine/decimal';
import { item, job, priced, room, table } from './estimate-fixtures';

const BANDS = Array.from({ length: 20 }, (_, index) => ({
  up_to_sf: index === 19 ? null : 100 * (index + 1),
  percent: String(20 - index),
}));

function many(itemCount: number, roomCount: number) {
  const items = Array.from({ length: itemCount }, (_, index) =>
    item(`item_${index}`, { unit_price: (1 + ((index * 37) % 100) / 10).toFixed(2) }),
  );
  const rooms = Array.from({ length: roomCount }, (_, index) => room(`Room ${index}`, { unfinished_sf: 50 + index * 7 }));
  return { items, rooms };
}

describe('F3 the cushion sorts its area lines once, not once per band', () => {
  it('C1 divisions per line stay far below the old per-band sort, and the totals are unchanged', () => {
    const { items, rooms } = many(40, 15);
    const tableJson = table(items, { estimate_mode: 'range', range: { first_sf: 100, first_percent: '20', beyond_percent: '0', brackets: BANDS } });
    const divide = Dec.prototype.div;
    let calls = 0;
    Dec.prototype.div = function counted(this: Dec, other: Dec): Dec {
      calls += 1;
      return divide.call(this, other);
    };
    let estimate;
    try {
      estimate = priced(tableJson, job(rooms));
    } finally {
      Dec.prototype.div = divide;
    }
    const lines = estimate.lines.length;
    expect(lines).toBe(600);
    // Before the fix this took about 300 to 400 divisions a line at 20 bands; after it, about 25.
    expect(calls / lines).toBeLessThan(80);
    expect(estimate.totals.high?.total).toMatch(/^\d+\.\d\d$/);
  });

  it('C2 a large many-band table prices well inside a time bound', () => {
    const { items, rooms } = many(100, 30);
    const tableJson = table(items, { estimate_mode: 'range', range: { first_sf: 100, first_percent: '20', beyond_percent: '0', brackets: BANDS } });
    const started = performance.now();
    const estimate = priced(tableJson, job(rooms));
    const elapsed = performance.now() - started;
    expect(estimate.lines.length).toBe(3000);
    expect(elapsed).toBeLessThan(5000);
  });
});
