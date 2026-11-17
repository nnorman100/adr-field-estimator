import { describe, expect, it } from 'vitest';
import { stripPriceSentences, stripPricesDeep, statesPrice } from '@/lib/ai/rules';

// Server rules applied to every model output (S7-1, docs/plans/S7.md section 3: AI never prices).
// Ported from backend/claims.py states_price / ai_note: a sentence that names money, or a price word
// next to a number, is dropped.

describe('price sentences', () => {
  it('detects money and price words with numbers, and leaves plain readings alone', () => {
    for (const text of [
      'Drying will cost $1,200.',
      'That is about 300 dollars.',
      'Expect a total of four hundred.',
      'The quote was 2500 for demo.',
      'Charges run ten per hour.',
      'It comes to 40 bucks.',
      'Budgeted at 12 thousand.',
      'Costs €90.',
    ]) {
      expect(statesPrice(text), text).toBe(true);
    }
    for (const text of [
      'Moisture reads 23.4 percent in the north wall.',
      'Three air movers were placed in the kitchen.',
      'The price list applies.', // a price word without a number
      'Hold pressure for 15 minutes.',
    ]) {
      expect(statesPrice(text), text).toBe(false);
    }
  });

  it('drops only the sentences that state a price, line by line', () => {
    const text =
      'Water reached the hallway. Drying will cost $1,200. Check the subfloor.\nTotal is 900.\nDry for three days.';
    expect(stripPriceSentences(text)).toBe('Water reached the hallway. Check the subfloor.\nDry for three days.');
  });

  it('drops a price sentence wrapped across a line break, keeping the lines around it', () => {
    expect(stripPriceSentences('Cabinet removal total:\n1,200.00')).toBe('');
    expect(stripPriceSentences('Water reached the hallway.\nThe total for drying\ncomes to\n900.\nDry for three days.')).toBe(
      'Water reached the hallway.\nDry for three days.',
    );
  });

  it('drops a bare amount after an abbreviation with the price words before it', () => {
    expect(stripPriceSentences('Drying budget: approx.\n900.')).toBe('');
    expect(stripPriceSentences('Drying budget is approx. 900. The hall is dry.')).toBe('The hall is dry.');
  });

  it('keeps a finding on the line before a price that has no end mark', () => {
    expect(stripPriceSentences('Category 2 water in the kitchen\nDrying cost: $500.\nThe hall is dry.')).toBe(
      'Category 2 water in the kitchen\nThe hall is dry.',
    );
    expect(stripPriceSentences('- Kitchen wet\n- Total 900\n- Hall dry')).toBe('- Kitchen wet\n- Hall dry');
  });

  it('drops a price whose amount is on the next line or goes on after an abbreviation', () => {
    expect(stripPriceSentences('Drying cost: $\n900.\nThe hall is dry.')).toBe('The hall is dry.');
    expect(stripPriceSentences('Drying will cost approx. 900 for labor. The hall is dry.')).toBe('The hall is dry.');
  });

  it('keeps estimate used as a verb', () => {
    const advice = 'Estimate which of the 3 air movers can be removed.';
    expect(statesPrice(advice)).toBe(false);
    expect(stripPriceSentences(`${advice} The hall is dry.`)).toBe(`${advice} The hall is dry.`);
  });

  it('treats an estimate with an amount as a price', () => {
    expect(statesPrice('The drying estimate is 900.')).toBe(true);
    expect(stripPriceSentences('The drying estimate is 900. Fans run three days.')).toBe('Fans run three days.');
  });

  it('strips every string inside a structured output, keeping its shape', () => {
    const output = {
      summary: 'Category 2 water in the kitchen. The repair costs $4,000.',
      suggestions: ['Remove baseboards.', 'Charge 300 for demo.'],
      nested: { note: 'Price: 99 dollars.', count: 3, ok: true },
    };
    expect(stripPricesDeep(output)).toEqual({
      summary: 'Category 2 water in the kitchen.',
      suggestions: ['Remove baseboards.', ''],
      nested: { note: '', count: 3, ok: true },
    });
  });
});
