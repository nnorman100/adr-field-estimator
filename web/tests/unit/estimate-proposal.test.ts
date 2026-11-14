import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { priceEstimate, type Estimate, type EstimateJob, type Json } from '@/engine/estimate';
import { letterheadLines, PROPOSAL_FORMAT, proposalBytes, proposalHeading, proposalOf } from '@/lib/estimates/proposal';
import { estimateView, readStoredEstimate, StoredEstimateError, type EstimateRecord } from '@/lib/estimates/result';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { capabilitiesFor } from '@/lib/access';

// S5a-9: the proposal the customer is shown and signs is one canonical JSON text built from the
// engine's priced result and the company's own inputs, and what each role is shown of a stored
// estimate. The quantity-override note goes only to a caller holding `quantity_notes_read`.

const COMPANY: CompanyDocuments = {
  identity: {
    companyId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    name: 'Valley Water Pros',
    address: '1 Synthetic Way, Testville',
    phone: '555-0199',
    email: 'office@example.invalid',
    license: '000002',
    signoff: 'Robin Example',
  },
  letterhead: NEUTRAL_LETTERHEAD,
  settings: NEUTRAL_SETTINGS,
};

function table(policy: Record<string, Json> = {}): Json {
  return {
    items: [{ item_id: 'antimicrobial', group: 'treatment', name: 'Antimicrobial', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '1.00' }],
    policy: {
      estimate_mode: 'single',
      range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
      after_hours: { multiplier: '1' },
      category_multipliers: { '1': '1', '2': '1', '3': '1' },
      cabinetry: { multiplier: '1', scope: 'finished_only' },
      sales_tax: { enabled: false, percent: '0' },
      ...policy,
    },
  };
}

// A record whose technician cleared a measured wet floor with a reason: the engine prices the whole
// floor and keeps a quantity-override note for the owner.
const JOB: EstimateJob = {
  inspection: {
    address: '12 Synthetic Lane, Testville',
    year_built: 1990,
    scope_confirmed: true,
    emergency_calls: 0,
    haul_loads: 0,
    air_scrubbers: 0,
    hepa_filters: 0,
    monitoring_hours: 0,
    rooms: [{ name: 'Kitchen', category: 2, floor_sf: 160 }],
    quantity_overrides: { 'Kitchen:wet_floor_sf': { measured: '120', entered: '0', reason: 'Whole floor wet' } },
  },
  documents: {
    company: companyJson(),
    ai: { summary: 'Water under the kitchen floor.', suggestions: [], unpriced_work: [] },
    customer_name: 'Casey Customer',
    photos: [],
  },
};

function estimate(policy: Record<string, Json> = {}): Estimate {
  const result = priceEstimate(table(policy), JOB);
  if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
  return result;
}

function companyJson(): Json {
  const { companyId, ...rest } = COMPANY.identity;
  return { company_id: companyId, version: 1, ...rest };
}

// The roles' keys with price books on, as the estimate routes run.
const ON = { priceBooks: true };

const BASIS = { submission: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshotSha256: 'a'.repeat(64) }, version: { sequence: 3 } };

describe('the proposal', () => {
  it('is headed with the company’s name and prints its letterhead exactly as entered', () => {
    const proposal = proposalOf({ estimate: estimate(), company: COMPANY, showLineBreakdown: false, ...BASIS });
    expect(proposal.format).toBe(PROPOSAL_FORMAT);
    expect(proposal.heading).toBe('Valley Water Pros · Official proposal');
    expect(proposal.letterhead).toEqual(['Valley Water Pros', '1 Synthetic Way, Testville', '555-0199', 'office@example.invalid', 'CSLB #000002']);
    expect(proposal.basis).toEqual({
      submission_id: BASIS.submission.id,
      snapshot_sha256: 'a'.repeat(64),
      price_version: 3,
      content_sha256: estimate().table_sha256,
      engine_version: 'dryscope-v3',
    });
  });

  it('prints only the letterhead fields that are set, in print order', () => {
    expect(letterheadLines({ ...COMPANY, identity: { ...COMPANY.identity, phone: '', license: '  ' } })).toEqual([
      'Valley Water Pros',
      '1 Synthetic Way, Testville',
      'office@example.invalid',
    ]);
    const letterhead = { emergencyPhone: '555-0911', fax: '555-0198', website: 'example.invalid', tagline: 'Water and mold', mailingAddress: 'PO Box 1, Testville' };
    expect(letterheadLines({ ...COMPANY, letterhead })).toEqual([
      'Valley Water Pros',
      'Water and mold',
      '1 Synthetic Way, Testville',
      'Mailing address: PO Box 1, Testville',
      '555-0199',
      'Emergency: 555-0911',
      'Fax: 555-0198',
      'office@example.invalid',
      'example.invalid',
      'CSLB #000002',
    ]);
    expect(proposalHeading('  ')).toBe('Official proposal');
  });

  it('carries the engine’s findings, scope and clauses, and the price, but no staff note', () => {
    const priced = estimate();
    const proposal = proposalOf({ estimate: priced, company: COMPANY, showLineBreakdown: false, ...BASIS });
    expect(proposal.findings).toEqual(priced.documents!.proposal.findings);
    expect(proposal.recommendations).toEqual(priced.documents!.proposal.recommendations);
    expect(proposal.disclaimers).toEqual(priced.documents!.proposal.disclaimers);
    expect(proposal.price).toEqual({ mode: 'single', itemized_total: '160.00', low: priced.totals.low, high: null, explanation: priced.totals.explanation, after_hours_label: 'After-hours adjustment' });
    const text = proposalBytes(proposal).bytes.toString('utf8');
    expect(text).not.toContain('Whole floor wet');
    expect(text).not.toContain('Water under the kitchen floor.');
  });

  it('lists each line’s price only when the price table shows the line breakdown', () => {
    const shown = proposalOf({ estimate: estimate({ show_line_breakdown: true }), company: COMPANY, showLineBreakdown: true, ...BASIS });
    expect(shown.price.lines).toEqual([{ description: 'Kitchen: Antimicrobial', quantity: '160', unit: 'sf', total: '160.00' }]);
    const hidden = proposalOf({ estimate: estimate(), company: COMPANY, showLineBreakdown: false, ...BASIS });
    expect(hidden.price).not.toHaveProperty('lines');
  });

  it('carries the price table’s name for the after-hours adjustment', () => {
    const named = proposalOf({ estimate: estimate({ after_hours: { multiplier: '1.5', label: 'Emergency labor surcharge' } }), company: COMPANY, showLineBreakdown: false, ...BASIS });
    expect(named.price.after_hours_label).toBe('Emergency labor surcharge');
  });

  it('is stored as canonical bytes with their SHA-256, the same for the same input', () => {
    const input = { estimate: estimate(), company: COMPANY, showLineBreakdown: false, ...BASIS };
    const first = proposalBytes(proposalOf(input));
    const again = proposalBytes(proposalOf(input));
    expect(first.bytes.equals(again.bytes)).toBe(true);
    expect(first.sha256).toBe(createHash('sha256').update(first.bytes).digest('hex'));
    expect(JSON.parse(first.bytes.toString('utf8'))).toEqual(proposalOf(input));
    // Another company's name is another proposal.
    const other = proposalBytes(proposalOf({ ...input, company: { ...COMPANY, identity: { ...COMPANY.identity, name: 'Other Co' } } }));
    expect(other.sha256).not.toBe(first.sha256);
  });
});

function record(priced: Estimate): EstimateRecord {
  const { bytes, sha256 } = proposalBytes(proposalOf({ estimate: priced, company: COMPANY, showLineBreakdown: false, ...BASIS }));
  return {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    submissionId: BASIS.submission.id,
    pinSequence: 1,
    versionSequence: 3,
    tableHash: priced.table_sha256,
    engineVersion: priced.engine_version,
    // As jsonb gives it back.
    pricedResult: JSON.parse(JSON.stringify(priced)),
    proposalBytes: bytes,
    proposalSha256: sha256,
    createdAt: new Date('2026-11-14T00:00:00Z'),
  };
}

describe('what each role is shown of a stored estimate', () => {
  const NOTE = { entered: '0', label: 'Wet floor area', measured: '120', reason: 'Whole floor wet', room: 'Kitchen' };

  it('the owner gets the quantity-override note', () => {
    const view = estimateView(record(estimate()), capabilitiesFor('owner', ON));
    expect(view.staffNotes.quantityNotes).toEqual([NOTE]);
    expect(view.staffNotes.summary).toBe('Water under the kitchen floor.');
  });

  it('an estimator, and office, see no quantity-override note at all', () => {
    for (const role of ['estimator', 'office'] as const) {
      const view = estimateView(record(estimate()), capabilitiesFor(role, ON));
      expect(view.staffNotes).not.toHaveProperty('quantityNotes');
      expect(JSON.stringify(view)).not.toContain('Whole floor wet');
      // The rest of the review is the same for every reader.
      expect(view.totals.low.total).toBe('160.00');
      expect(view.staffNotes.summary).toBe('Water under the kitchen floor.');
    }
  });

  it('shows the proposal from the stored bytes, and the price basis', () => {
    const stored = record(estimate());
    const view = estimateView(stored, capabilitiesFor('estimator', ON));
    expect(view.proposal).toEqual(JSON.parse(Buffer.from(stored.proposalBytes).toString('utf8')));
    expect(view.proposalSha256).toBe(stored.proposalSha256);
    expect(view.price).toEqual({ pinSequence: 1, versionSequence: 3, tableHash: stored.tableHash, engineVersion: 'dryscope-v3' });
  });

  it('refuses a stored result that does not match the schema', () => {
    const priced = JSON.parse(JSON.stringify(estimate())) as Record<string, unknown>;
    expect(readStoredEstimate(priced)).toMatchObject({ ok: true });
    for (const broken of [{ ...priced, ok: false }, { ...priced, extra: 1 }, { ...priced, documents: null }, { ...priced, lines: [{ total: 12 }] }]) {
      expect(() => readStoredEstimate(broken)).toThrow(StoredEstimateError);
    }
  });
});
