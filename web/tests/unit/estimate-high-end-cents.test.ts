// The high end prices every line in whole cents, as the low end does, and then runs the same totals path.
// `settle` is the step that puts the grown amounts into cents; the worked examples W63 and W66 in
// estimate-item-flags.test.ts show its effect on a trade minimum. Every expected number is worked by hand.

import { describe, expect, it } from 'vitest';

import { settle, type Entry } from '../../src/engine/adjust';
import { Dec, ZERO, money, sumDec } from '../../src/engine/decimal';
import type { PriceLine } from '../../src/engine/values';

const entry = (amount: string): Entry => ({ line: {} as PriceLine, amount: Dec.parse(amount) });
const amounts = (entries: Entry[]): string[] => entries.map((row) => row.amount.format('.2f'));

describe('settle: grown line amounts in whole cents', () => {
  it('H1 each line is the step in the rounded running total, so the lines add up to the rounded total', () => {
    // $11.066 + $11.066 + $11.088 = $33.220. Running totals $11.066, $22.132, $33.220 round to $11.07, $22.13,
    // $33.22; the steps are $11.07, $11.06 and $11.09, which add up to $33.22.
    expect(amounts(settle([entry('11.066'), entry('11.066'), entry('11.088')]))).toEqual(['11.07', '11.06', '11.09']);
  });

  it('H2 half a cent rounds up, and a line that does not grow keeps its amount exactly', () => {
    // $10.005 rounds to $10.01. The second line is $20.00 grown by nothing: the running total goes from
    // $10.005 to $30.005, both round half up to a step of exactly $20.00.
    expect(amounts(settle([entry('10.005'), entry('20.00')]))).toEqual(['10.01', '20.00']);
    // The first line is $10.00 and grows nothing; the second grows by $0.004 and rounds back to its low amount.
    expect(amounts(settle([entry('10.00'), entry('20.004')]))).toEqual(['10.00', '20.00']);
  });

  it('H3 no line ends below its low amount, and the total is the once-rounded sum, over seeded cases', () => {
    let state = 20261112;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const problems: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      const lows = Array.from({ length: 1 + Math.floor(next() * 8) }, () => Dec.parse((Math.floor(next() * 100000) / 100).toFixed(2)));
      const grown = lows.map((low) => low.mul(Dec.parse(String(1 + Math.floor(next() * 5000) / 10000))));
      const settled = settle(grown.map((amount) => ({ line: {} as PriceLine, amount })));
      settled.forEach((row, at) => {
        if (row.amount.cmp(lows[at] ?? ZERO) < 0) problems.push(`case ${index}: line ${at} below its low amount`);
        if (!row.amount.eq(money(row.amount))) problems.push(`case ${index}: line ${at} is not whole cents`);
      });
      const total = sumDec(settled.map((row) => row.amount), ZERO);
      if (!total.eq(money(sumDec(grown, ZERO)))) problems.push(`case ${index}: lines do not add up to the rounded total`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });
});
