import { describe, expect, it } from 'vitest';
import {
  AI_MODELS,
  AI_PRICES,
  AiPriceError,
  costMicroUsd,
  rateMicroUsdPerMillion,
  ratesOn,
  reserveMicroUsd,
  usageFromMetadata,
} from '@/lib/ai/pricing';

// Token prices for the AI boundary (S7-1, docs/plans/S7.md section 3): exact decimal arithmetic in
// micro-USD, rounded up so a charge is never under-counted, with the 2027-01-01 price change for
// gemini-3.8-flash. Sources: documents/aistudio.google.com/docs/pricing (read 2026-11-13).

const BEFORE = new Date('2026-12-31T23:59:59.999Z');
const AFTER = new Date('2027-01-01T00:00:00.000Z');

describe('rates', () => {
  it('parses decimal dollar prices exactly', () => {
    expect(rateMicroUsdPerMillion('0.75')).toBe(750_000n);
    expect(rateMicroUsdPerMillion('3.75')).toBe(3_750_000n);
    expect(rateMicroUsdPerMillion('12')).toBe(12_000_000n);
    expect(rateMicroUsdPerMillion('0.000001')).toBe(1n);
    for (const bad of ['', '-1', '1e3', '0.0000001', 'abc', ' 1']) {
      expect(() => rateMicroUsdPerMillion(bad)).toThrow(AiPriceError);
    }
  });

  it('switches gemini-3.8-flash to the 2027 price at midnight UTC on 2027-01-01', () => {
    expect(ratesOn('gemini-3.8-flash', BEFORE).input.text).toBe('0.75');
    expect(ratesOn('gemini-3.8-flash', BEFORE).output.text).toBe('3.75');
    expect(ratesOn('gemini-3.8-flash', AFTER).input.text).toBe('1.50');
    expect(ratesOn('gemini-3.8-flash', AFTER).output.text).toBe('7.50');
  });

  it('prices Live per modality, with audio dearer than text', () => {
    const live = ratesOn('gemini-3.8-live', AFTER);
    expect(live.input).toEqual({ text: '0.75', image: '1.00', audio: '3.00', video: '1.00' });
    expect(live.output).toEqual({ text: '4.50', audio: '12.00' });
  });

  it('has a sorted, non-empty price history for every model', () => {
    for (const model of AI_MODELS) {
      const periods = AI_PRICES[model];
      expect(periods.length).toBeGreaterThan(0);
      const starts = periods.map((p) => p.from);
      expect([...starts].sort()).toEqual(starts);
      expect(new Set(starts).size).toBe(starts.length);
    }
  });

  it('refuses an unknown model and a date before the first price', () => {
    expect(() => ratesOn('gemini-0-unknown' as never, AFTER)).toThrow(AiPriceError);
    expect(() => ratesOn('gemini-3.8-flash', new Date('2020-01-01T00:00:00Z'))).toThrow(AiPriceError);
  });
});

describe('cost', () => {
  it('charges input and output at their own rates, rounded up to a whole micro-USD', () => {
    // 1,000 input at $0.75/M = 750 micro-USD; 1,000 output at $3.75/M = 3,750 micro-USD.
    expect(costMicroUsd('gemini-3.8-flash', { input: { text: 1000 }, output: { text: 1000 } }, BEFORE)).toBe(4500);
    // One token at $0.75/M is 0.75 micro-USD; it rounds up to 1.
    expect(costMicroUsd('gemini-3.8-flash', { input: { text: 1 }, output: {} }, BEFORE)).toBe(1);
    expect(costMicroUsd('gemini-3.8-flash', { input: {}, output: {} }, BEFORE)).toBe(0);
  });

  it('doubles the same flash call after the 2027 change', () => {
    const usage = { input: { text: 10_000 }, output: { text: 2_000 } };
    expect(costMicroUsd('gemini-3.8-flash', usage, AFTER)).toBe(2 * costMicroUsd('gemini-3.8-flash', usage, BEFORE));
  });

  it('prices Live audio in and audio out', () => {
    // 1M audio in at $3 + 1M audio out at $12 = $15.
    expect(costMicroUsd('gemini-3.8-live', { input: { audio: 1_000_000 }, output: { audio: 1_000_000 } }, AFTER)).toBe(
      15_000_000,
    );
  });

  it('refuses a modality the model has no price for, and bad token counts', () => {
    expect(() => costMicroUsd('gemini-3.5-transcribe', { input: { video: 10 }, output: {} }, AFTER)).toThrow(
      AiPriceError,
    );
    expect(() => costMicroUsd('gemini-3.8-flash', { input: { text: -1 }, output: {} }, AFTER)).toThrow(AiPriceError);
    expect(() => costMicroUsd('gemini-3.8-flash', { input: { text: 1.5 }, output: {} }, AFTER)).toThrow(AiPriceError);
  });
});

describe('reservation bound', () => {
  it('is input bytes / 3 plus the output cap, each at the dearest rate', () => {
    // 3,000 bytes -> 1,000 tokens at $0.75; 1,000 output at $3.75 => 4,500 micro-USD.
    expect(reserveMicroUsd('gemini-3.8-flash', { inputBytes: 3000, outputTokenCap: 1000 }, BEFORE)).toBe(4500);
    // Bytes not divisible by 3 round the token count up.
    expect(reserveMicroUsd('gemini-3.8-flash', { inputBytes: 1, outputTokenCap: 0 }, BEFORE)).toBe(1);
    // Live input is bounded at the audio rate, its dearest input.
    expect(reserveMicroUsd('gemini-3.8-live', { inputBytes: 3_000_000, outputTokenCap: 0 }, AFTER)).toBe(3_000_000);
  });

  it('is never below the real cost of a call that stays within it', () => {
    const reserve = reserveMicroUsd('gemini-3.8-flash', { inputBytes: 9000, outputTokenCap: 500 }, AFTER);
    const used = costMicroUsd('gemini-3.8-flash', { input: { text: 3000 }, output: { text: 500 } }, AFTER);
    expect(reserve).toBeGreaterThanOrEqual(used);
  });
});

describe('usage metadata', () => {
  it('splits input by modality and counts thinking tokens as output', () => {
    const usage = usageFromMetadata({
      promptTokenCount: 1300,
      candidatesTokenCount: 200,
      thoughtsTokenCount: 50,
      promptTokensDetails: [
        { modality: 'TEXT', tokenCount: 300 },
        { modality: 'IMAGE', tokenCount: 1000 },
      ],
      candidatesTokensDetails: [{ modality: 'TEXT', tokenCount: 200 }],
    });
    expect(usage).toEqual({ input: { text: 300, image: 1000 }, output: { text: 250 } });
  });

  it('bills tokens the details do not explain in the unknown bucket, at the dearest rate', () => {
    const usage = usageFromMetadata({ promptTokenCount: 500, candidatesTokenCount: 10 });
    expect(usage).toEqual({ input: { unknown: 500 }, output: { unknown: 10 } });
    expect(costMicroUsd('gemini-3.8-live', usage, AFTER)).toBe(
      costMicroUsd('gemini-3.8-live', { input: { audio: 500 }, output: { audio: 10 } }, AFTER),
    );
    // Details that explain only part of the count leave the rest unknown.
    expect(
      usageFromMetadata({ promptTokenCount: 30, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 20 }] }).input,
    ).toEqual({ text: 20, unknown: 10 });
  });

  it('reads tool-use prompt tokens as input and missing metadata as zero', () => {
    expect(usageFromMetadata({ promptTokenCount: 10, toolUsePromptTokenCount: 5 }).input).toEqual({ unknown: 15 });
    expect(usageFromMetadata(undefined)).toEqual({ input: {}, output: {} });
  });
});
