import { describe, expect, it } from 'vitest';
import { centsOf, sampleOf } from '@/lib/drying/history';
import { closeBody, closeDigest, landedOf } from '@/lib/drying/outcome';

// S5b-10 slice 10B, the job close outside the database: the signed amounts read as exact cents, where
// a final invoice lands (docs/estimate-assist.md), and the close request's bounds. Signing's history
// capture and the close routes are in tests/db/job-close-api.test.ts.

describe('signed amounts as cents', () => {
  it('reads the engine’s two-decimal amounts exactly, and nothing else', () => {
    expect(centsOf('0.00')).toBe(0);
    expect(centsOf('1250.07')).toBe(125007);
    expect(centsOf('90071992547409.91')).toBe(9_007_199_254_740_991);
    for (const value of ['90071992547409.92', '-1.00', '12.5', '12', 12.5, null, undefined]) expect(centsOf(value)).toBeNull();
  });

  it('proves no amount from a priced result the engine did not store', () => {
    expect(sampleOf({ id: 'a', signedAt: new Date(), pricedResult: { total: '1250.00' } }, null)).toBeNull();
  });
});

describe('where a final invoice lands', () => {
  const range = { priceMode: 'range' as const, lowCents: 100_000, highCents: 140_000 };
  const single = { priceMode: 'single' as const, lowCents: 100_000, highCents: null };

  it('is inside a range from low to high, both included, below under the low and above over the high', () => {
    expect([99_999, 100_000, 140_000, 140_001].map((final) => landedOf(final, range))).toEqual(['below', 'inside', 'inside', 'above']);
  });

  it('is inside one price at or under it, and above over it', () => {
    expect([1, 100_000, 100_001].map((final) => landedOf(final, single))).toEqual(['inside', 'inside', 'above']);
  });
});

describe('a close request', () => {
  const ID = '3f9a1c2e-5b7d-4e60-8a12-9c4d6e8f0b31';
  const AGREEMENT = '7c2e4a60-1b3d-4f85-9e07-2a6c8d0f4b19';
  const body = (extra: Record<string, unknown> = {}) => ({ id: ID, expectedAgreementId: AGREEMENT, expectedRevision: 0, finalAmount: '1250.5', ...extra });

  it('holds the final invoice as cents, $0.01 to $2,000,000.00', () => {
    expect(closeBody.parse(body())).toMatchObject({ finalAmount: 125050, actualDays: null, note: '' });
    expect(closeBody.parse(body({ finalAmount: '0.01' })).finalAmount).toBe(1);
    expect(closeBody.parse(body({ finalAmount: '2000000.00' })).finalAmount).toBe(200_000_000);
    for (const finalAmount of ['0', '0.00', '2000000.01', '1.234', '1e3', ' 12.00', '$12', 12]) expect(closeBody.safeParse(body({ finalAmount })).success).toBe(false);
  });

  it('takes blank actual days as none and keeps zero, up to 365', () => {
    expect(closeBody.parse(body({ actualDays: '' })).actualDays).toBeNull();
    expect(closeBody.parse(body({ actualDays: 0 })).actualDays).toBe(0);
    expect(closeBody.parse(body({ actualDays: 365 })).actualDays).toBe(365);
    for (const actualDays of [366, -1, 2.5, '3']) expect(closeBody.safeParse(body({ actualDays })).success).toBe(false);
  });

  it('takes a note of at most 300 characters and no other key', () => {
    expect(closeBody.safeParse(body({ note: 'x'.repeat(300) })).success).toBe(true);
    expect(closeBody.safeParse(body({ note: 'x'.repeat(301) })).success).toBe(false);
    expect(closeBody.safeParse(body({ landed: 'inside' })).success).toBe(false);
  });

  it('digests the same close the same way, whatever the amount’s form or the ids’ case', () => {
    const one = closeDigest(closeBody.parse(body()));
    expect(closeDigest(closeBody.parse(body({ finalAmount: '1250.50', id: ID.toUpperCase() })))).toBe(one);
    expect(closeDigest(closeBody.parse(body({ finalAmount: '1250.51' })))).not.toBe(one);
  });
});
