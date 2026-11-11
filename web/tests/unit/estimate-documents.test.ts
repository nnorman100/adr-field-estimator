// Exact text of the mandatory clauses (AGENTS.md section 4) and the document checks carried over from
// engine-normalization.test.ts: claim date of loss, the letter's addressee, the photo log and room overrides.

import { describe, expect, it } from 'vitest';

import { priceEstimate, type EstimateJob, type Json } from '../../src/engine/estimate';
import {
  COMPANY,
  documentJob,
  item,
  job,
  priced,
  room,
  table,
  type Obj,
} from './estimate-fixtures';

const PRICES = table([item('demo')]);
const KITCHEN = [room('Kitchen', { unfinished_sf: 100 })];

const PRETEST = '(this does not include the pretest for lead/asbestos)';
const TESTING =
  "Testing is required under California State Law due to the home's construction year. A third-party company will conduct lead and asbestos testing to determine their presence. If the results are negative, remediation can proceed as outlined below. However, if lead or asbestos is detected, we will discuss the necessary abatement steps with the homeowner, and a price adjustment will be made accordingly.";
const ADDITIONAL =
  'If technicians encounter additional affected building materials beyond the quantities previously described, the project manager will contact the property owner to discuss any additional course of action necessary and the associated cost.';
const REPRICE =
  'If the work proceeds through an insurance claim, we will reprice the estimate according to industry standards using Xactimate.';
const VALIDITY = 'Estimate is valid for 30 days from date of inspection.';

function protection(company: string): string {
  return `Per IICRC and EPA protocols, ${company} technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.`;
}

function exclusions(company: string): string {
  return `NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of ${company}. This estimate does not include testing of any kind.`;
}

function documents(estimateJob: EstimateJob) {
  const result = priced(PRICES, estimateJob);
  if (!result.documents) expect.fail('no documents');
  return result.documents;
}

function stage(estimateJob: EstimateJob): string {
  const result = priceEstimate(PRICES, estimateJob);
  return result.ok ? 'ok' : result.stage;
}

describe('mandatory clauses', () => {
  it('a home built before 1978 gets the pretest notice, the age finding and the testing paragraph', () => {
    const docs = documents(documentJob(KITCHEN, { year_built: 1977 }));
    const age =
      'Due to property age (1977), California State Law requires third-party lead and asbestos testing prior to destructive demolition.';
    expect(docs.proposal.lead_notice_required).toBe(true);
    expect(docs.proposal.findings[0]).toBe(age);
    expect(docs.compliance_notes).toEqual([
      age,
      PRETEST,
      exclusions('Example Restoration'),
      REPRICE,
      VALIDITY,
    ]);
    expect(docs.proposal.disclaimers.slice(2)).toEqual([
      PRETEST,
      exclusions('Example Restoration'),
      REPRICE,
      VALIDITY,
    ]);
    expect(docs.proposal.recommendations[0]).toBe(TESTING);
    expect(docs.proposal.recommendations[1]).toBe(protection('Example Restoration'));
    expect(docs.proposal.recommendations.at(-1)).toBe(ADDITIONAL);
    for (const clause of [
      age,
      PRETEST,
      TESTING,
      protection('Example Restoration'),
      ADDITIONAL,
      exclusions('Example Restoration'),
      REPRICE,
      VALIDITY,
    ]) {
      expect(docs.letter).toContain(clause);
    }
  });

  it('a home built in 1978 or later says no testing is required and carries no pretest wording', () => {
    for (const year of [1978, 1990]) {
      const docs = documents(documentJob(KITCHEN, { year_built: year }));
      const age = `The home was built in ${year}. Therefore, no lead or asbestos testing is required prior to the start of work.`;
      expect(docs.proposal.lead_notice_required).toBe(false);
      expect(docs.proposal.findings[0]).toBe(age);
      expect(docs.compliance_notes).toEqual([
        age,
        exclusions('Example Restoration'),
        REPRICE,
        VALIDITY,
      ]);
      expect(docs.proposal.recommendations[0]).toBe(protection('Example Restoration'));
      expect(docs.proposal.recommendations.at(-1)).toBe(ADDITIONAL);
      expect(docs.letter).not.toContain(PRETEST);
      expect(docs.letter).not.toContain(TESTING);
    }
  });

  it("the clauses that name the company use the issuing company's name", () => {
    const docs = documents(
      documentJob(
        KITCHEN,
        {},
        { company: { ...COMPANY, company_id: 'other-co', name: 'Valley Water Pros' } },
      ),
    );
    expect(docs.proposal.recommendations).toContain(protection('Valley Water Pros'));
    expect(docs.proposal.disclaimers).toContain(exclusions('Valley Water Pros'));
    expect(docs.letter).not.toContain('Example Restoration');
  });

  it('the proposal lists the priced scope between the protective-equipment and additional-materials sentences', () => {
    const docs = documents(documentJob(KITCHEN));
    expect(docs.proposal.recommendations).toEqual([
      protection('Example Restoration'),
      'Kitchen: demo',
      ADDITIONAL,
    ]);
  });
});

const CLAIM: Obj = {
  carrier: 'Example Mutual',
  claim_number: 'CLM-0001',
  policy_number: 'POL-0002',
  date_of_loss: '2026-10-10',
  loss_cause: 'Supply line failure',
  adjuster_name: 'Avery Adjuster',
  adjuster_email: 'adjuster@example.invalid',
  adjuster_phone: '555-0199',
  deductible: '$1,000',
};

function withClaim(claim: Obj): EstimateJob {
  return documentJob(KITCHEN, {}, { claim });
}

describe('claim date of loss', () => {
  it('refuses an impossible calendar date or a future date', () => {
    for (const date of ['2026-02-30', '2025-13-01', '0000-01-01', '2999-01-01']) {
      expect(stage(withClaim({ ...CLAIM, date_of_loss: date }))).toBe('documents');
    }
  });

  it('accepts a leap day and shows the date as month-day-year', () => {
    const docs = documents(withClaim({ ...CLAIM, date_of_loss: '2024-02-29' }));
    expect(docs.letter).toContain('Date of loss: 02-29-2024');
  });
});

describe('claim addressee', () => {
  it('addresses the named adjuster, the carrier and the contact line', () => {
    const docs = documents(withClaim(CLAIM));
    expect(docs.letter).toContain(
      'TO: Avery Adjuster, Adjuster\nExample Mutual\nadjuster@example.invalid · 555-0199\n\nRE: Remediation scope for 1 Example Street, Testville\nCustomer: Casey Customer\nClaim number: CLM-0001\nPolicy number: POL-0002\nDate of loss: 10-10-2026\nCause and source of loss: Supply line failure\nDeductible: $1,000\n',
    );
  });

  it('falls back to the claims examiner and skips empty lines', () => {
    const docs = documents(withClaim({ carrier: 'Example Mutual' }));
    expect(docs.letter).toContain(
      'TO: Insurance Claims Examiner / Adjuster\nExample Mutual\n\nRE:',
    );
    expect(documents(documentJob(KITCHEN)).letter).toContain(
      'TO: Insurance Claims Examiner / Adjuster\n\nRE:',
    );
  });
});

function photo(changes: Obj = {}): Obj {
  return {
    id: '575a43d60e76609d84ecd66363fba43c',
    room: 'Kitchen',
    captured_at: '2026-10-15T12:00:00Z',
    width: 1600,
    height: 1200,
    ocr_status: 'verified',
    ocr: {
      meter_detected: true,
      meter_type: 'Extech MO290',
      value: '22.0% WME',
      classification: '',
      notes: '',
    },
    location: { source: 'not_shared' },
    ...changes,
  };
}

function withPhotos(photos: Json[]): EstimateJob {
  return documentJob(KITCHEN, {}, { photos });
}

describe('photo log', () => {
  it('logs each photo and states a verified reading only for a verified photo', () => {
    const docs = documents(
      withPhotos([
        photo(),
        photo({ id: '1591add6e0884bfd9434b2e370a47c4b', ocr_status: 'no_meter', ocr: null }),
      ]),
    );
    expect(docs.photo_log).toHaveLength(2);
    expect(docs.proposal.findings).toContain('Photo 1 (Kitchen) — Extech MO290: 22.0% WME');
    expect(docs.proposal.findings).toContain(
      'Photo 2 (Kitchen) — supporting photo; no verified meter reading.',
    );
    expect(docs.signable).toBe(true);
  });

  it('a photo still waiting for its reading makes the documents unsignable', () => {
    const docs = documents(withPhotos([photo({ ocr_status: 'pending', ocr: null })]));
    expect(docs.signable).toBe(false);
  });

  it('refuses a verified photo without a complete meter reading', () => {
    const extra = {
      meter_detected: true,
      meter_type: 'M',
      value: '1',
      classification: '',
      notes: '',
      extra: '',
    };
    for (const ocr of [{}, null, extra]) {
      expect(stage(withPhotos([photo({ ocr })]))).toBe('documents');
    }
  });

  it('refuses a reading on another photo that breaks the reading contract', () => {
    const bad = {
      meter_detected: 'maybe',
      meter_type: '',
      value: '',
      classification: '',
      notes: '',
    };
    expect(stage(withPhotos([photo(), photo({ ocr_status: 'no_meter', ocr: bad })]))).toBe(
      'documents',
    );
  });

  it('refuses non-integer sizes and out-of-range or incomplete locations', () => {
    const edits: Obj[] = [
      { width: 1600.5 },
      { height: '1200.5' },
      { location: { source: 'device', latitude: 91, longitude: 0, accuracy_m: 1 } },
      { location: { source: 'device', latitude: 0, longitude: -181, accuracy_m: 1 } },
      { location: { source: 'device', latitude: 0, longitude: 0, accuracy_m: -1 } },
      { location: { source: 'device', latitude: 0, longitude: 0 } },
      { location: { source: 'not_shared', note: 'x' } },
    ];
    for (const edit of edits) expect(stage(withPhotos([photo(edit)]))).toBe('documents');
  });

  it('logs the location and the whole-number size', () => {
    const docs = documents(
      withPhotos([
        photo({ location: { source: 'device', latitude: 35, longitude: -119, accuracy_m: 0 } }),
      ]),
    );
    expect(docs.photo_log[0]).toMatchObject({
      width: 1600,
      height: 1200,
      location: { source: 'device', latitude: 35, longitude: -119, accuracy_m: 0 },
    });
  });
});

describe('room quantity overrides', () => {
  const WET = table([
    item('antimicrobial', {
      group: 'treatment',
      quantity_source: 'room:wet_floor',
      unit_price: '1.00',
    }),
  ]);

  function quantities(rooms: Obj[], changes: Obj = {}): string[] {
    return priced(WET, job(rooms, changes)).lines.map((line) => `${line.item_id}=${line.quantity}`);
  }

  it('prices a cleared wet floor as the whole floor', () => {
    // Measured 120 sq ft wet, the technician cleared it: the wet-floor item reads the 160 sq ft floor.
    const rooms = [room('Kitchen', { floor_sf: 160 })];
    const cleared = quantities(rooms, {
      quantity_overrides: {
        'Kitchen:wet_floor_sf': { measured: '120', entered: '0', reason: 'Whole floor wet' },
      },
    });
    expect(cleared).toEqual(['antimicrobial=160']);
    expect(cleared).toEqual(quantities(rooms));
  });

  it('refuses an override that names no room, disagrees with the room, or changes a value without a reason', () => {
    const rooms = [room('Kitchen', { floor_sf: 160, wet_floor_sf: 120 })];
    const refused: Obj[] = [
      { 'Garage:wet_floor_sf': { measured: '120', entered: '120' } },
      { 'Kitchen:wet_floor_sf': { measured: '150', entered: '100', reason: 'Dried overnight' } },
      { 'Kitchen:wet_floor_sf': { measured: '150', entered: '120' } },
    ];
    for (const overrides of refused) {
      expect(priceEstimate(WET, job(rooms, { quantity_overrides: overrides }))).toMatchObject({
        ok: false,
        stage: 'inspection',
      });
    }
    const kept = quantities(rooms, {
      quantity_overrides: {
        'Kitchen:wet_floor_sf': { measured: '150', entered: '120', reason: 'Dried overnight' },
      },
    });
    expect(kept).toEqual(['antimicrobial=120']);
  });
});
