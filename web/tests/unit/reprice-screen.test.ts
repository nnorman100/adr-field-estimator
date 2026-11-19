import { describe, expect, it } from 'vitest';
import { priceText, revisedLine } from '@/lib/estimates/proposal';
import { canRepriceOf, repriceLines, repriceOutcomeOf, repricePreviewOf } from '@/lib/estimates/reprice-screen';

// S5b-6: the revised estimate's line and the owner's Reprice banner, as pure functions.

const PREVIEW = {
  job: { id: 'job-1', status: 'submitted', currentDraftId: 'draft-1', revision: 4 },
  reprice: { pinned: { sequence: 1, version: 1, price: '$240.00' }, newest: { versionId: 'v-2', version: 2, price: '$360.00', refused: null } },
};

describe('the revised line', () => {
  const made = new Date('2026-11-19T23:30:00Z');
  it('is "Revised {date}" without a previous price, the date written out in UTC', () => {
    expect(revisedLine(made, null)).toBe('Revised November 19, 2026');
  });
  it('names the previous price when given', () => {
    expect(revisedLine(made, '$1,240.00')).toBe('Revised November 19, 2026: was $1,240.00');
  });
  it('states a price as the proposal does: one amount, or the range', () => {
    expect(priceText({ mode: 'single', low: { total: '1240.00' }, high: null })).toBe('$1,240.00');
    expect(priceText({ mode: 'range', low: { total: '240.00' }, high: { total: '300.50' } })).toBe('$240.00 to $300.50');
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
  });
  it('shows the before and after prices from the preview', () => {
    expect(repriceLines(PREVIEW.reprice)).toEqual({ before: 'Now, at prices version 1: $240.00', after: 'At prices version 2: $360.00' });
  });
  it('says when the newest prices cannot price the record', () => {
    const refused = { ...PREVIEW.reprice, newest: { ...PREVIEW.reprice.newest, price: null, refused: { stage: 'pricing', message: 'x' } } };
    expect(repriceLines(refused).after).toBe("Prices version 2 cannot price this job's record as it is. Check the Prices page before repricing.");
  });
  it('words each refusal from its code, and a lost connection as such', () => {
    expect(repriceOutcomeOf(409, { error: 'prices_superseded' })).toMatch(/Newer prices were published/);
    expect(repriceOutcomeOf(409, { error: 'stale_revision' })).toMatch(/changed while you were looking/);
    expect(repriceOutcomeOf(0, null)).toMatch(/could not reach DryScope/);
    expect(repriceOutcomeOf(400, { error: 'other' })).toBe('Something went wrong. Reload the job.');
  });
});
