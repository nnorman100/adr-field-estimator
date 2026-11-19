import { describe, expect, it } from 'vitest';
import { revisedLine } from '@/lib/estimates/proposal';
import { canRepriceOf, repriceLines, repriceOutcomeOf, repricePreviewOf, screenOutOfDate } from '@/lib/estimates/reprice-screen';
import { customerPriceLine, priceText } from '@/lib/estimates/screen';

// S5b-6: the revised estimate's line and the owner's Reprice banner, as pure functions.

const PREVIEW = {
  job: { revision: 4 },
  reprice: { pinned: { version: 1, price: '$240.00', refused: null }, newest: { versionId: 'v-2', version: 2, price: '$360.00', refused: null } },
};

describe('the revised line', () => {
  const made = new Date('2026-11-19T23:30:00Z');
  it('is "Revised {date}" before signing with the setting off, the date written out in UTC', () => {
    expect(revisedLine(made, { previous: '$1,240.00', signed: null, showPrevious: false })).toBe('Revised November 19, 2026');
  });
  it('names the previous price before signing only with the setting on', () => {
    expect(revisedLine(made, { previous: '$1,240.00', signed: null, showPrevious: true })).toBe('Revised November 19, 2026: was $1,240.00');
  });
  it('names the signed price of a signed parent always, whatever the setting, and not the previous estimate’s', () => {
    expect(revisedLine(made, { previous: '$1,500.00', signed: '$1,240.00', showPrevious: false })).toBe('Revised November 19, 2026: was $1,240.00');
    expect(revisedLine(made, { previous: '$1,500.00', signed: '$1,240.00', showPrevious: true })).toBe('Revised November 19, 2026: was $1,240.00');
  });
  it('states a price as the proposal does: one amount, or the range', () => {
    expect(priceText({ mode: 'single', low: { total: '1240.00' }, high: null })).toBe('$1,240.00');
    expect(priceText({ mode: 'range', low: { total: '240.00' }, high: { total: '300.50' } })).toBe('$240.00 to $300.50');
    expect(customerPriceLine({ mode: 'single', low: { total: '1240.00' }, high: null })).toBe('Price: $1,240.00');
    expect(customerPriceLine({ mode: 'range', low: { total: '240.00' }, high: { total: '300.50' } })).toBe('Customer estimate range: $240.00 to $300.50');
  });
});

describe('the Reprice banner', () => {
  it('is offered only with the owner’s job_reprice key', () => {
    expect(canRepriceOf({ capabilities: ['jobs_read', 'job_reprice'] })).toBe(true);
    expect(canRepriceOf({ capabilities: ['jobs_read', 'audit'] })).toBe(false);
    expect(canRepriceOf(null)).toBe(false);
  });
  it('reads the preview answer, nothing to reprice, and refuses anything else', () => {
    expect(repricePreviewOf(PREVIEW)).toEqual(PREVIEW);
    expect(repricePreviewOf({ ...PREVIEW, reprice: null })?.reprice).toBeNull();
    expect(repricePreviewOf({ job: PREVIEW.job, reprice: { pinned: {}, newest: {} } })).toBeNull();
    expect(repricePreviewOf({ reprice: null })).toBeNull();
    expect(repricePreviewOf({ job: {}, reprice: null })).toBeNull();
    // A side has a price or a refusal, never both and never neither.
    const side = (price: unknown, refused: unknown) => ({ ...PREVIEW, reprice: { ...PREVIEW.reprice, pinned: { version: 1, price, refused } } });
    expect(repricePreviewOf(side(null, { stage: 'inspection' }))).not.toBeNull();
    expect(repricePreviewOf(side('$1.00', { stage: 'inspection' }))).toBeNull();
    expect(repricePreviewOf(side(null, null))).toBeNull();
  });
  it('shows the before and after prices from the preview, both for the last submitted scope', () => {
    expect(repriceLines(PREVIEW.reprice)).toEqual({
      before: 'Last submitted scope at prices version 1: $240.00',
      after: 'Last submitted scope at prices version 2: $360.00',
    });
  });
  it('says why when the newest prices cannot price the record, in the fixed words for the stage', () => {
    const refused = { ...PREVIEW.reprice, newest: { ...PREVIEW.reprice.newest, price: null, refused: { stage: 'pricing' } } };
    expect(repriceLines(refused).after).toBe(
      'Last submitted scope at prices version 2: cannot be priced. The record could not be priced. Go back to editing, check the rooms and quantities, then finish again.',
    );
  });
  it('says why the pinned prices cannot price the record too', () => {
    const refused = { ...PREVIEW.reprice, pinned: { version: 1, price: null, refused: { stage: 'inspection' } } };
    expect(repriceLines(refused).before).toMatch(/^Last submitted scope at prices version 1: cannot be priced\. /);
    expect(repriceLines(refused).after).toBe('Last submitted scope at prices version 2: $360.00');
  });
  it('reads the job again when the job was signed or changed elsewhere, or is no longer reachable', () => {
    expect(screenOutOfDate(409, { error: 'stale_revision' })).toBe(true);
    expect(screenOutOfDate(409, { error: 'job_signed' })).toBe(true);
    for (const status of [403, 404, 410]) expect(screenOutOfDate(status, { error: 'x' })).toBe(true);
    expect(screenOutOfDate(409, { error: 'prices_superseded' })).toBe(false);
    expect(screenOutOfDate(503, null)).toBe(false);
  });
  it('words each refusal from its code, and a lost connection as such', () => {
    expect(repriceOutcomeOf(409, { error: 'prices_superseded' })).toMatch(/Newer prices were published/);
    expect(repriceOutcomeOf(409, { error: 'conflict' })).toMatch(/already sent with different details/);
    expect(repriceOutcomeOf(0, null)).toMatch(/could not reach DryScope/);
    expect(repriceOutcomeOf(400, { error: 'other' })).toBe('Something went wrong. Reload the job.');
  });
});
