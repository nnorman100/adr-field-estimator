import { describe, expect, it } from 'vitest';
import { priceEstimate, type Estimate, type Json } from '@/engine/estimate';
import { canonicalJson } from '@/lib/field/canonical';
import { estimateInput, NO_ROOM, readSnapshot, SnapshotError } from '@/lib/estimates/inputs';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';
import { SNAPSHOT_FORMAT, type Snapshot } from '@/lib/submissions/snapshot';

// S5a-9: the engine's input is built from the submitted record's snapshot only, with the company's
// own document inputs. These cases check the mapping by hand: the address and summary (J1) from the
// record, the claim in the engine's names, and the photo log grouped by room in the record's room
// order with each photo's stored hash.

const PHOTO_1 = '11111111-1111-4111-8111-111111111111';
const PHOTO_2 = '22222222-2222-4222-8222-222222222222';
const PHOTO_3 = '33333333-3333-4333-8333-333333333333';
const hash = (digit: string) => digit.repeat(64);

function snapshot(changes: Partial<Snapshot> = {}): Snapshot {
  return {
    format: SNAPSHOT_FORMAT,
    submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    draftId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    fieldSha256: hash('d'),
    field: {
      draft: { yearBuilt: 1972, roomOrder: ['hall', 'kitchen'], summary: 'Category 2 water in two rooms.', scopeConfirmed: true, airMovers: 2 },
      rooms: [
        { id: 'hall', field: { name: 'Hall', category: 2, floorSf: 40, wetFloorSf: 40 } },
        { id: 'kitchen', field: { name: 'Kitchen', category: 2, floorSf: 120, wetFloorSf: 80 } },
      ],
      // The record keeps the canonical order (by id); the log orders them by room.
      photos: [
        { id: PHOTO_1, field: { roomId: 'kitchen', shotTag: 'source' } },
        { id: PHOTO_2, field: {} },
        { id: PHOTO_3, field: { roomId: 'hall', shotTag: 'overview' } },
      ],
    },
    photos: [
      { id: PHOTO_1, sha256: hash('1'), sizeBytes: 100, contentType: 'image/jpeg' },
      { id: PHOTO_2, sha256: hash('2'), sizeBytes: 100, contentType: 'image/jpeg' },
      { id: PHOTO_3, sha256: hash('3'), sizeBytes: 100, contentType: 'image/png' },
    ],
    job: { propertyAddress: '12 Synthetic Lane, Testville' },
    customer: { name: 'Casey Customer', phone: '555-0100', email: 'casey@example.invalid' },
    claim: {
      carrier: 'Example Mutual',
      claimNumber: 'CL-1',
      policyNumber: '',
      dateOfLoss: '2026-11-01',
      lossCause: 'Supply line',
      adjusterName: 'Avery Adjuster',
      adjusterEmail: '',
      adjusterPhone: '',
      deductible: null,
    },
    ...changes,
  };
}

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

// $2.00 per square foot of wet floor, one price, nothing else.
const TABLE: Json = {
  items: [{ item_id: 'extraction', group: 'treatment', name: 'Extraction', unit: 'sf', quantity_source: 'room:wet_floor', unit_price: '2.00' }],
  policy: {
    estimate_mode: 'single',
    range: { first_sf: 1000, first_percent: '0', beyond_percent: '0' },
    after_hours: { multiplier: '1' },
    category_multipliers: { '1': '1', '2': '1', '3': '1' },
    cabinetry: { multiplier: '1', scope: 'finished_only' },
    sales_tax: { enabled: false, percent: '0' },
  },
};

function priced(record: Snapshot = snapshot()): Estimate {
  const result = priceEstimate(TABLE, estimateInput(record, COMPANY).job);
  if (!result.ok) expect.fail(`refused at ${result.stage}: ${result.error}`);
  return result;
}

describe('the engine input from a submitted record', () => {
  it('takes the address, the written summary and the scope confirmation from the record', () => {
    const input = estimateInput(snapshot(), COMPANY);
    expect(input.summary).toBe('Category 2 water in two rooms.');
    expect(input.scopeConfirmed).toBe(true);
    expect(input.job.inspection).toMatchObject({ address: '12 Synthetic Lane, Testville', year_built: 1972, air_movers: 2 });
    expect(input.job.documents).toMatchObject({
      customer_name: 'Casey Customer',
      ai: { summary: 'Category 2 water in two rooms.', suggestions: [], unpriced_work: [] },
      company: { company_id: COMPANY.identity.companyId, name: 'Valley Water Pros', license: '000002', signoff: 'Robin Example' },
    });
  });

  it('a record with no summary or no confirmation says so, so the route can refuse it', () => {
    const record = snapshot();
    record.field.draft = { yearBuilt: 1972, roomOrder: ['hall', 'kitchen'] };
    expect(estimateInput(record, COMPANY)).toMatchObject({ summary: '', scopeConfirmed: false });
  });

  it('passes the claim in the engine’s names, a missing value as empty text, and no claim as none', () => {
    expect(estimateInput(snapshot(), COMPANY).job.documents!.claim).toEqual({
      carrier: 'Example Mutual',
      claim_number: 'CL-1',
      policy_number: '',
      date_of_loss: '2026-11-01',
      loss_cause: 'Supply line',
      adjuster_name: 'Avery Adjuster',
      adjuster_email: '',
      adjuster_phone: '',
      deductible: '',
    });
    expect(estimateInput(snapshot({ claim: {} }), COMPANY).job.documents!.claim).toBeNull();
  });

  it('logs the photos by room in the record’s room order, a photo with no room last, each with its stored hash', () => {
    const log = estimateInput(snapshot(), COMPANY).job.documents!.photos;
    expect(log).toEqual([
      { id: PHOTO_3, room: 'Hall', sha256: hash('3'), shot_tag: 'overview' },
      { id: PHOTO_1, room: 'Kitchen', sha256: hash('1'), shot_tag: 'source' },
      { id: PHOTO_2, room: NO_ROOM, sha256: hash('2') },
    ]);
    const docs = priced().documents!;
    expect(docs.photo_log).toEqual(log);
    expect(docs.proposal.findings).toContain('Photo 1 (Hall) — supporting photo; no verified meter reading.');
    expect(docs.proposal.findings).toContain(`Photo 3 (${NO_ROOM}) — supporting photo; no verified meter reading.`);
    // A photo the record has not sent for a reading never holds up signing.
    expect(docs.signable).toBe(true);
  });

  it('a photo reference naming a room the record does not hold is logged with no room', () => {
    const record = snapshot();
    record.field.photos = [{ id: PHOTO_1, field: { roomId: 'garage' } }];
    record.photos = [record.photos[0]!];
    expect(estimateInput(record, COMPANY).job.documents!.photos).toEqual([{ id: PHOTO_1, room: NO_ROOM, sha256: hash('1') }]);
  });

  it('refuses a photo reference with no stored photo in the record', () => {
    const record = snapshot();
    record.photos = record.photos.slice(1);
    expect(() => estimateInput(record, COMPANY)).toThrow(SnapshotError);
  });

  it('prices the record: $2.00 a square foot of wet floor, 40 + 80 sq ft = $240.00', () => {
    const estimate = priced();
    expect(estimate.lines.map((line) => `${line.description} = ${line.total}`)).toEqual(['Hall: Extraction = 80.00', 'Kitchen: Extraction = 160.00']);
    expect(estimate.totals.low.total).toBe('240.00');
  });

  it('the clauses that name the company print the company’s own name from its profile', () => {
    const docs = priced().documents!;
    expect(docs.proposal.recommendations).toContain(
      'Per IICRC and EPA protocols, Valley Water Pros technicians will don appropriate personal protective equipment during mitigation/remediation services. The technicians will set containments as needed.',
    );
    expect(docs.proposal.disclaimers).toContain(
      'NOTE: This estimate does NOT include reconstruction after remediation. Demolition is a highly unpredictable procedure. As such, any collateral damage resulting from the demolition prescribed herein will NOT be the responsibility of Valley Water Pros. This estimate does not include testing of any kind.',
    );
    // Built before 1978: the pretest notice and the age finding, exactly.
    expect(docs.proposal.disclaimers).toContain('(this does not include the pretest for lead/asbestos)');
    expect(docs.proposal.findings[0]).toBe(
      'Due to property age (1972), California State Law requires third-party lead and asbestos testing prior to destructive demolition.',
    );
    expect(docs.staff_notes).toEqual({ summary: 'Category 2 water in two rooms.', suggestions: [], company_setup_missing: [], quantity_notes: [] });
  });

  it('an empty company field is listed as missing and the documents are not signable', () => {
    const company = { ...COMPANY, identity: { ...COMPANY.identity, license: '', signoff: ' ' } };
    const result = priceEstimate(TABLE, estimateInput(snapshot(), company).job);
    if (!result.ok) expect.fail(result.error);
    expect(result.documents!.staff_notes.company_setup_missing).toEqual(['CSLB license', 'Document sign-off']);
    expect(result.documents!.signable).toBe(false);
  });
});

describe('reading a stored snapshot', () => {
  it('reads the bytes S5a-8 stores', () => {
    const record = snapshot();
    expect(readSnapshot(Buffer.from(canonicalJson(record)))).toEqual(record);
  });

  it('refuses bytes that are not a submission snapshot', () => {
    for (const bytes of ['not json', '{}', canonicalJson({ ...snapshot(), format: 'other' }), canonicalJson({ ...snapshot(), extra: 1 })]) {
      expect(() => readSnapshot(Buffer.from(bytes))).toThrow(SnapshotError);
    }
  });
});
