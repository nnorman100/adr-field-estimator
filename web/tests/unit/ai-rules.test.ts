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
