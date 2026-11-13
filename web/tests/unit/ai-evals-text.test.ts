import { describe, expect, it } from 'vitest';
import { editDistance, hasPhrase, looseText, median, normalizeWords, numberOf, numbersIn, wordErrorRate } from '../ai-evals/text';

// The S7-5 text helpers: number words fold into digits the same way on both sides of a comparison,
// so "twenty eight" and "28" are one word, and word error rate counts real misses only.

describe('normalizeWords', () => {
  it.each([
    ['Twenty eight percent', ['28', 'percent']],
    ['two hundred ninety square feet', ['290', 'square', 'feet']],
    ['six hundred forty-five', ['645']],
    ['fifteen hundred bucks', ['1500', 'bucks']],
    ['one hundred and five', ['105']],
    ['eighteen point five', ['18.5']],
    ['18 point 5', ['18.5']],
    ['1,200 sq ft', ['1200', 'sq', 'ft']],
    ['18.5%', ['18.5', 'percent']],
    ['thirty five to nineteen', ['35', 'to', '19']],
    ['one two three', ['1', '2', '3']],
    ['twenty eighteen', ['20', '18']],
    ["It's the hallway's floor.", ['its', 'the', 'hallways', 'floor']],
  ])('%s', (text, words) => {
    expect(normalizeWords(text)).toEqual(words);
  });
});

describe('word error rate', () => {
  it('is zero for the same words written differently', () => {
    expect(wordErrorRate([{ reference: 'The subfloor reads twenty eight percent.', hypothesis: 'the subfloor reads 28%' }])).toBe(0);
  });

  it('counts substitutions, insertions and deletions over all reference words', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toBe(2);
    expect(
      wordErrorRate([
        { reference: 'one two three four', hypothesis: 'one two three' },
        { reference: 'alpha beta gamma delta epsilon fox', hypothesis: 'alpha beta gamma delta epsilon fox' },
      ]),
    ).toBeCloseTo(1 / 10);
  });

  it('counts an empty transcript as every word lost', () => {
    expect(wordErrorRate([{ reference: 'drywall is wet', hypothesis: '' }])).toBe(1);
  });
});

describe('lookups', () => {
  it('finds phrases word by word, never inside another word', () => {
    expect(hasPhrase('The air movers are set.', 'air movers')).toBe(true);
    expect(hasPhrase('The air mover is set.', 'air movers')).toBe(false);
    expect(hasPhrase('baseboards', 'baseboard')).toBe(false);
  });

  it('reads numbers as digits and values as numbers', () => {
    expect([...numbersIn('About two hundred ten, maybe 210.0 square feet')]).toEqual(['210']);
    expect(numberOf('18.50%')).toBe(18.5);
    expect(numberOf(42)).toBe(42);
    expect(numberOf('no reading')).toBeNull();
    expect(numberOf(null)).toBeNull();
    expect(numberOf('1,200 sq ft')).toBe(1200);
    expect(numberOf('58.5 %RH')).toBe(58.5);
    expect(numberOf('63.8 F')).toBe(63.8);
    expect(numberOf('240 square feet')).toBe(240);
    for (const value of ['39-49', '240-300', '12 rooms', '18.5 or so', '1,2', '']) expect(numberOf(value), value).toBeNull();
  });

  it('compares quotes without case, spacing or edge punctuation', () => {
    expect(looseText('  "The Kitchen  is about 150 square feet."  ')).toBe('the kitchen is about 150 square feet');
  });

  it('takes a median of odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});
