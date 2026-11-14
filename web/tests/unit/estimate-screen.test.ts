import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/engine/estimate';
import type { EstimateView } from '@/lib/estimates/result';
import { item, job as pricedJob, priced, room, table } from './estimate-fixtures';
import { chargeRows, dollars, notReadyReasons, outcomeOf, photoLine, priceLines, quantityNoteLine, reviewAnswerOf, reviewerOf, warningText } from '@/lib/estimates/screen';

// S5a-9, what the Review before signing screen decides in the browser. Presentation only: amounts
// are the server's strings, printed with thousands separators and never recomputed.

const END = { subtotal: '1234.50', after_hours: '0.00', trade_minimums: [], minimum_charge: '0.00', overhead_profit: '0.00', tax: '0.00', total: '1234.50' };
const HIGH = { ...END, subtotal: '1500.00', total: '1500.00' };

function totals(mode: 'range' | 'single'): EstimateView['totals'] {
  return { mode, low: END, high: mode === 'range' ? HIGH : null, labor_material_low: '0.00', labor_material_high: '0.00', explanation: '', range_explanation: null };
}

describe('the review screen', () => {
  it('prints the server’s amounts with separators and does no arithmetic', () => {
    expect(dollars('1234.50')).toBe('$1,234.50');
    expect(dollars('1234567.00')).toBe('$1,234,567.00');
    expect(dollars('0.00')).toBe('$0.00');
    expect(dollars('-5.25')).toBe('-$5.25');
    // Not a money string: shown as it came.
    expect(dollars('12.5')).toBe('12.5');
  });

  it('shows the customer range or single price beside the itemized total', () => {
    expect(priceLines(totals('range'))).toEqual({ customer: 'Customer estimate range: $1,234.50 to $1,500.00', itemized: 'Itemized total: $1,234.50' });
    expect(priceLines(totals('single'))).toEqual({ customer: 'Price: $1,234.50', itemized: 'Itemized total: $1,234.50' });
  });

  it('knows who may price and who confirms the documents from the sign-in’s keys', () => {
    expect(reviewerOf({ capabilities: ['jobs_read', 'audit', 'sign'] })).toEqual({ canPrice: true, canSign: true });
    expect(reviewerOf({ capabilities: ['jobs_read', 'coordination'] })).toEqual({ canPrice: false, canSign: false });
    expect(reviewerOf({})).toBeNull();
  });

  it('reads the estimate routes’ answer, with or without an estimate', () => {
    const job = { id: 'j', status: 'submitted', currentDraftId: 'd', revision: 3 };
    expect(reviewAnswerOf({ job, estimate: null })).toEqual({ job: { id: 'j', status: 'submitted', currentDraftId: 'd' }, estimate: null });
    const estimate = { id: 'e', lines: [], proposal: {} };
    expect(reviewAnswerOf({ job, estimate })?.estimate).toBe(estimate);
    for (const bad of [null, {}, { job: { id: 'j' } }, { job, estimate: { id: 'e' } }, { job }]) expect(reviewAnswerOf(bad)).toBeNull();
  });

  it('says each refusal in plain words, and what to do next', () => {
    expect(outcomeOf(409, { error: 'prices_not_set' })).toMatchObject({ next: 'done', message: expect.stringContaining('no published prices') });
    expect(outcomeOf(409, { error: 'summary_missing' }).message).toContain('summary of findings');
    expect(outcomeOf(409, { error: 'scope_not_confirmed' }).message).toContain('confirm the scope');
    expect(outcomeOf(409, { error: 'details_changed' })).toMatchObject({ next: 'done', message: expect.stringContaining('Go back to editing, then finish again') });
    expect(outcomeOf(409, { error: 'estimate_refused', stage: 'documents', message: 'Enter the address' }).message).toContain('property address');
    expect(outcomeOf(0, null)).toMatchObject({ next: 'retry' });
    expect(outcomeOf(503, { error: 'whatever' })).toMatchObject({ next: 'retry' });
    expect(outcomeOf(409, { error: 'not_submitted' })).toMatchObject({ next: 'reload' });
  });

  it('names a pricing check by the engine’s own sentence or its code, never anything typed', () => {
    expect(warningText({ code: 'x', room: 'Kitchen', text: 'Air movers are below the IICRC minimum.' })).toBe('Air movers are below the IICRC minimum.');
    expect(warningText({ code: 'missing_size', item_id: 'contents', room: 'Kitchen' })).toBe('A room has no size, so a per-room item has no line (Kitchen).');
    expect(warningText({ code: 'something_new' })).toBe('A pricing check needs a look.');
  });

  it('lists a photo by number, room, shot tag and the start of its stored hash', () => {
    expect(photoLine({ id: 'p', room: 'Kitchen', shot_tag: 'source', sha256: 'ab'.repeat(32) }, 0)).toBe('Photo 1 · Kitchen · shot: source · SHA-256 abababababab…');
    expect(photoLine({ id: 'p', room: 'Hall' }, 2)).toBe('Photo 3 · Hall');
    expect(quantityNoteLine({ label: 'Wet floor area', room: 'Kitchen', measured: '120', entered: '0', reason: 'Whole floor wet' })).toBe(
      'Wet floor area (Kitchen) · measured 120, entered 0 · Reason: Whole floor wet',
    );
  });

  it('lists every charge the stored total includes, so a document’s breakdown adds up to it', () => {
    // Demolition 100 sf x $2.00 = $200.00 under the $400.00 drywall minimum: a $200.00 top-up, total $400.00.
    const result = priced(
      { ...table([item('demo', { trade: 'drywall' })]), trades: [{ trade_id: 'drywall', name: 'Drywall', minimum_charge: '400' }] },
      pricedJob([room('Kitchen', { unfinished_sf: 100 })]),
    );
    expect(chargeRows(result.totals.low)).toEqual([
      { label: 'Subtotal', amount: '200.00' },
      { label: 'Drywall trade minimum', amount: '200.00' },
    ]);
    expect(result.totals.low.total).toBe('400.00');
    const every = { subtotal: '100.00', after_hours: '10.00', trade_minimums: [{ trade_id: 't', name: 'Mold', amount: '20.00' }], minimum_charge: '30.00', overhead_profit: '40.00', tax: '5.00', total: '205.00' };
    expect(chargeRows(every).map((row) => row.label)).toEqual(['Subtotal', 'After-hours', 'Mold trade minimum', 'Minimum job charge', 'Overhead and profit', 'Sales tax']);
    const cents = (amount: string) => Number(amount.replace('.', ''));
    expect(chargeRows(every).reduce((sum, row) => sum + cents(row.amount), 0)).toBe(cents(every.total));
  });

  it('says why documents cannot be signed yet', () => {
    const view = (signable: boolean, missing: string[], unpriced: string[]) =>
      ({ documents: { signable, unpricedWork: unpriced }, staffNotes: { companySetupMissing: missing } }) as unknown as EstimateView;
    expect(notReadyReasons(view(true, [], []))).toEqual([]);
    expect(notReadyReasons(view(false, ['CSLB license'], ['Contents'])))
      .toEqual(['Company settings: CSLB license is not filled in. The owner adds it on Company settings.', 'Some work has no price. Go back to editing and change the scope.']);
    expect(notReadyReasons(view(false, [], []))).toEqual(['The scope has no priced work yet. Go back to editing and add the work.']);
  });
});

describe('the photo log of a submitted record', () => {
  const TABLE = {
    items: [{ item_id: 'demo', group: 'demolition', name: 'Demo', unit: 'sf', quantity_source: 'room:demolition:unfinished', unit_price: '2.00' }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
    },
  };
  const job = (photos: unknown[]) => ({
    inspection: { address: '1 Example Street', year_built: 1990, scope_confirmed: true, emergency_calls: 0, haul_loads: 0, air_scrubbers: 0, hepa_filters: 0, monitoring_hours: 0, rooms: [{ name: 'Kitchen', category: 1, unfinished_sf: 10 }] },
    documents: {
      company: { company_id: 'c', version: 1, name: 'Example Restoration', address: 'A', phone: 'P', email: 'e@example.invalid', license: '1', signoff: 'S' },
      ai: { summary: 'Reviewed.', suggestions: [], unpriced_work: [] },
      photos: photos as never,
    },
  });

  it('keeps only the keys a photo has: no capture time, size or reading is made up', () => {
    const sha = 'c'.repeat(64);
    const result = priceEstimate(TABLE, job([{ id: 'p1', room: 'Kitchen', sha256: sha, shot_tag: 'meter' }]));
    if (!result.ok) expect.fail(result.error);
    expect(result.documents!.photo_log).toEqual([{ id: 'p1', room: 'Kitchen', sha256: sha, shot_tag: 'meter' }]);
    expect(result.documents!.proposal.findings).toContain('Photo 1 (Kitchen) — supporting photo; no verified meter reading.');
    expect(result.documents!.signable).toBe(true);
  });

  it('refuses a hash that is not 64 lowercase hex characters', () => {
    for (const sha256 of ['C'.repeat(64), 'c'.repeat(63), '']) {
      expect(priceEstimate(TABLE, job([{ id: 'p1', room: 'Kitchen', sha256 }]))).toMatchObject({ ok: false, stage: 'documents' });
    }
  });
});
