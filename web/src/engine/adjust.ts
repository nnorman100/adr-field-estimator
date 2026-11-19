// What the per-item flags and trade headings do at one end of the range (plan S4-4c, owner decisions
// M5, M6, M7 and M9). Totals.ts prices the lines; this module sums what each flag needs from them.

import { Dec, HUNDRED, ONE, ZERO, maxDec, money, sumDec } from './decimal';
import type { Trade } from './table';
import type { PriceLine } from './values';

/** One line's amount at one end of the range: the line total at the low end, a grown amount at the high end. */
export type Entry = { line: PriceLine; amount: Dec };

/** Where a flagged line's after-hours adjustment is rounded: its trade heading, or one of these two. */
const EXEMPT = '\u0000exempt';
const OPEN = '\u0000open';

/**
 * Sums over the lines at one end, from the amount each line is billed at there.
 * - `flagged`: amounts of lines that take the after-hours multiplier, by the group its adjustment rounds in.
 * - `exempt`: amounts of lines that carry no overhead and profit.
 * - `taxed`: the tax base, each taxable line's materials share at the multiplier, plus its share of overhead
 *   and profit unless it is exempt.
 * - `trades`: per trade heading, the amount of its lines that carry overhead and profit.
 */
export type Mix = { flagged: Map<string, Dec>; exempt: Dec; taxed: Dec; trades: Map<string, Dec> };

export type TradeMinimum = { tradeId: string; name: string; amount: Dec };

export function emptyMix(): Mix {
  return { flagged: new Map(), exempt: ZERO, taxed: ZERO, trades: new Map() };
}

function plus(map: Map<string, Dec>, key: string, amount: Dec): void {
  map.set(key, (map.get(key) ?? ZERO).add(amount));
}

/** `multiplier` is the after-hours multiplier on an after-hours job and 1 otherwise; `overhead` is a fraction. */
export function mixOf(entries: Entry[], multiplier: Dec, overhead: Dec): Mix {
  const mix = emptyMix();
  for (const { line, amount } of entries) {
    if (line.afterHours) plus(mix.flagged, line.noOverheadProfit ? EXEMPT : (line.trade ?? OPEN), amount);
    if (line.noOverheadProfit) mix.exempt = mix.exempt.add(amount);
    else if (line.trade !== null) plus(mix.trades, line.trade, amount);
    if (line.taxable) {
      const scaled = line.afterHours ? amount.mul(multiplier) : amount;
      const share = scaled.mul(line.materialsShare).div(HUNDRED);
      mix.taxed = mix.taxed.add(line.noOverheadProfit ? share : share.mul(ONE.add(overhead)));
    }
  }
  return mix;
}

/**
 * A line's high-end amount in whole cents, as every low-end line is. The grown amounts are rounded together
 * once, as the high labor is, and each line takes the step in that running total, so the lines add up to the
 * rounded total. A line that does not grow keeps its low amount exactly, and none ends below it: low amounts
 * are whole cents, so the step is at least the low amount.
 */
export function settle(entries: Entry[]): Entry[] {
  let exact = ZERO;
  let billed = ZERO;
  return entries.map(({ line, amount }) => {
    exact = exact.add(amount);
    const cents = money(exact).sub(billed);
    billed = billed.add(cents);
    return { line, amount: cents };
  });
}

/**
 * The after-hours adjustment, rounded once per group of lines (each trade heading, the exempt items, and the
 * rest), so the amount a trade minimum compares is the amount the trade is charged. With no trade headings and
 * no exempt items there is one group and one rounding, as for the job-wide multiplier.
 */
export function adjustments(mix: Mix, multiplier: Dec): { total: Dec; byGroup: Map<string, Dec> } {
  const extra = multiplier.sub(ONE);
  const byGroup = new Map([...mix.flagged].map(([group, amount]) => [group, money(amount.mul(extra))]));
  return { total: sumDec([...byGroup.values()], ZERO), byGroup };
}

/** What the exempt items are charged: their amounts and their own rounded adjustment. */
export function exemptCharged(mix: Mix, adjustment: ReturnType<typeof adjustments>): Dec {
  return mix.exempt.add(adjustment.byGroup.get(EXEMPT) ?? ZERO);
}

/**
 * What each trade with a line at this end that carries overhead and profit is short of its minimum, in
 * trade-id order. Items that are exempt from overhead and profit (a rental, say) are neither counted toward a
 * minimum nor able to trigger one.
 */
export function tradeMinimums(
  trades: Trade[],
  mix: Mix,
  adjustment: ReturnType<typeof adjustments>,
): TradeMinimum[] {
  const owed: TradeMinimum[] = [];
  for (const trade of trades) {
    const counted = mix.trades.get(trade.trade_id);
    if (counted === undefined) continue;
    const minimum = Dec.parse(trade.minimum_charge);
    if (minimum.isZero()) continue;
    const charged = counted.add(adjustment.byGroup.get(trade.trade_id) ?? ZERO);
    const amount = money(maxDec(ZERO, minimum.sub(charged)));
    if (!amount.isZero()) owed.push({ tradeId: trade.trade_id, name: trade.name, amount });
  }
  return owed;
}

export function minimumTotal(owed: TradeMinimum[]): Dec {
  return sumDec(owed.map((row) => row.amount), ZERO);
}
