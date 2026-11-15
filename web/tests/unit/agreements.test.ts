import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { priceEstimate, type EstimateJob, type Json } from '@/engine/estimate';
import { readSignedRecord, SIGNED_FORMAT, signedRecordBytes, SignedRecordError, type SignedRecord } from '@/lib/agreements/record';
import { signBody, signDigest } from '@/lib/agreements/schema';
import { agreementAnswerOf, signedBy, signedHow, signedWhen, signOutcomeOf } from '@/lib/agreements/screen';
import { hasSigningTexts, PROPOSAL_FORMAT, proposalBytes, proposalOf, type Proposal } from '@/lib/estimates/proposal';
import { canonicalJson } from '@/lib/field/canonical';
import { NEUTRAL_LETTERHEAD, NEUTRAL_SETTINGS, type CompanyDocuments } from '@/lib/profile/documents';

// S5a-11, sign on the phone: the signed record's bytes, the sign request, the screen's words, and
// the start-work authorization and payment terms in the proposal and in the setup check. The routes
// themselves are in tests/db/agreements-api.test.ts.

const AUTHORIZATION = '  Synthetic authorization.\n\nSecond paragraph.';
const PAYMENT = 'Synthetic terms:\n  - on completion';

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
  signing: { authorizationText: AUTHORIZATION, paymentTermsText: PAYMENT },
};

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

function job(company: Record<string, Json>): EstimateJob {
  return {
    inspection: {
      address: '12 Synthetic Lane, Testville',
      year_built: 1990,
      scope_confirmed: true,
      emergency_calls: 0,
      haul_loads: 0,
      air_scrubbers: 0,
      hepa_filters: 0,
      monitoring_hours: 0,
      rooms: [{ name: 'Kitchen', category: 2, floor_sf: 100, wet_floor_sf: 100 }],
    },
    documents: {
      company: { company_id: COMPANY.identity.companyId, version: 1, name: 'Valley Water Pros', address: '1 Synthetic Way', phone: '', email: '', license: '000002', signoff: 'Robin', ...company },
      ai: { summary: 'Water in the kitchen.', suggestions: [], unpriced_work: [] },
      customer_name: 'Casey Customer',
      photos: [],
    },
  };
}

function priced(company: Record<string, Json> = {}) {
  const result = priceEstimate(TABLE, job(company));
  if (!result.ok || !result.documents) expect.fail(result.ok ? 'no documents' : result.error);
  return result;
}

describe('the setup check of the documents (engine)', () => {
  it('given both texts, lists an empty one and makes the documents not signable', () => {
    const missing = priced({ authorization_text: '', payment_terms_text: '  \n' }).documents!;
    expect(missing.staff_notes.company_setup_missing).toEqual(['Start-work authorization', 'Payment terms']);
    expect(missing.signable).toBe(false);
    const set = priced({ authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT }).documents!;
    expect(set.staff_notes.company_setup_missing).toEqual([]);
    expect(set.signable).toBe(true);
  });

  it('without the texts (a caller that does not pass them), signability is as before', () => {
    expect(priced().documents!.signable).toBe(true);
  });
});

describe('the proposal’s signed-page texts', () => {
  const BASIS = { submission: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshotSha256: 'a'.repeat(64) }, version: { sequence: 1 } };
  const proposal = () => proposalOf({ estimate: priced({ authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT }), company: COMPANY, showLineBreakdown: false, ...BASIS });

  it('prints both exactly as entered, inside the bytes the hash is of', () => {
    const made = proposal();
    expect(made.format).toBe(PROPOSAL_FORMAT);
    expect(made.authorization_text).toBe(AUTHORIZATION);
    expect(made.payment_terms_text).toBe(PAYMENT);
    const { bytes, sha256 } = proposalBytes(made);
    expect(bytes.toString('utf8')).toContain(JSON.stringify(AUTHORIZATION));
    expect(bytes.toString('utf8')).toContain(JSON.stringify(PAYMENT));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
    expect(hasSigningTexts(made)).toBe(true);
  });

  it('is not signable with a blank text, or as a v1 proposal made before the texts existed', () => {
    expect(hasSigningTexts({ ...proposal(), payment_terms_text: ' ' })).toBe(false);
    const v1: Proposal = { ...proposal(), format: 'dryscope-proposal-v1' };
    delete v1.authorization_text;
    delete v1.payment_terms_text;
    expect(hasSigningTexts(v1)).toBe(false);
    expect(hasSigningTexts({ ...proposal(), format: 'dryscope-proposal-v1' })).toBe(false);
  });
});

function record(proposal: Proposal): SignedRecord {
  return {
    format: SIGNED_FORMAT,
    agreement_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    job_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    kind: 'original',
    signed_at: '2026-11-14T18:30:00.123Z',
    signer: { name: 'Casey Customer' },
    signed_with: { kind: 'device', presented_by: { actor_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Robin Tech' } },
    signature: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sha256: 'f'.repeat(64), content_type: 'image/png' },
    proposal_sha256: proposalBytes(proposal).sha256,
    proposal,
    documents: { itemized_claim: [], letter: 'Letter.', photo_log: [], claim: null, compliance_notes: [] },
    basis: { estimate_id: '11111111-1111-4111-8111-111111111111', submission_id: '22222222-2222-4222-8222-222222222222' },
  };
}

describe('the signed record', () => {
  const proposal = proposalOf({
    estimate: priced({ authorization_text: AUTHORIZATION, payment_terms_text: PAYMENT }),
    company: COMPANY,
    showLineBreakdown: false,
    submission: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', snapshotSha256: 'a'.repeat(64) },
    version: { sequence: 1 },
  });

  it('is canonical bytes that read back as the same record, the proposal’s text being the hashed bytes', () => {
    const made = record(proposal);
    const bytes = signedRecordBytes(made);
    expect(bytes.toString('utf8')).toBe(canonicalJson(made));
    expect(readSignedRecord(bytes)).toEqual(made);
    expect(canonicalJson(readSignedRecord(bytes).proposal)).toBe(proposalBytes(proposal).bytes.toString('utf8'));
  });

  it('can never bind a proposal other than the one its hash names', () => {
    expect(() => signedRecordBytes({ ...record(proposal), proposal_sha256: '0'.repeat(64) })).toThrow(SignedRecordError);
    const tampered = Buffer.from(canonicalJson({ ...record(proposal), proposal: { ...proposal, payment_terms_text: 'Changed.' } }), 'utf8');
    expect(() => readSignedRecord(tampered)).toThrow(SignedRecordError);
    expect(() => readSignedRecord(Buffer.from('not json'))).toThrow(SignedRecordError);
  });

  it('holds a signing link’s id in place of the presenter (S5a-11b)', () => {
    const linked = { ...record(proposal), signed_with: { kind: 'link' as const, link_id: '33333333-3333-4333-8333-333333333333' } };
    expect(readSignedRecord(signedRecordBytes(linked)).signed_with).toEqual({ kind: 'link', link_id: '33333333-3333-4333-8333-333333333333' });
  });

  it('holds the signer’s role when one was asked (S5a-11b), and reads records made without one', () => {
    const withRole = { ...record(proposal), signer: { name: 'Casey Customer', role: 'adjuster' as const } };
    expect(readSignedRecord(signedRecordBytes(withRole)).signer).toEqual({ name: 'Casey Customer', role: 'adjuster' });
    expect(readSignedRecord(signedRecordBytes(record(proposal))).signer).toEqual({ name: record(proposal).signer.name });
    const unknownRole = Buffer.from(canonicalJson({ ...record(proposal), signer: { name: 'Casey Customer', role: 'landlord' } }), 'utf8');
    expect(() => readSignedRecord(unknownRole)).toThrow(SignedRecordError);
  });
});

describe('the sign request', () => {
  const body = {
    id: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    estimateId: '11111111-1111-4111-8111-111111111111',
    proposalSha256: 'a'.repeat(64),
    signatureId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    signerName: '  Casey Customer ',
    documentsConfirmed: true,
  };

  it('trims the name and lowercases the ids; the digest follows the checked body', () => {
    const parsed = signBody.parse(body);
    expect(parsed).toMatchObject({ id: body.id.toLowerCase(), signerName: 'Casey Customer' });
    expect(signDigest(parsed)).toBe(signDigest(signBody.parse({ ...body, signerName: 'Casey Customer' })));
    expect(signDigest(parsed)).not.toBe(signDigest(signBody.parse({ ...body, signerName: 'Casey C.' })));
  });

  it('refuses an unconfirmed review, a blank or too-long name, a control character and an unknown key', () => {
    for (const change of [{ documentsConfirmed: false }, { signerName: ' ' }, { signerName: 'x'.repeat(151) }, { signerName: 'A\u0007B' }, { other: 1 }]) {
      expect(signBody.safeParse({ ...body, ...change }).success).toBe(false);
    }
    expect(signBody.safeParse({ ...body, signerName: 'x'.repeat(150) }).success).toBe(true);
  });
});

describe('the signing screen’s words', () => {
  it('says who, when and how', () => {
    const made = record(proposalOf({ estimate: priced(), company: COMPANY, showLineBreakdown: false, submission: { id: 'a', snapshotSha256: 'a'.repeat(64) }, version: { sequence: 1 } }));
    expect(signedHow(made)).toBe("Signed on the technician's phone, presented by Robin Tech.");
    expect(signedHow({ ...made, signed_with: { kind: 'device', presented_by: { actor_id: 'x', name: '' } } })).toBe("Signed on the technician's phone.");
    expect(signedHow({ ...made, signed_with: { kind: 'link', link_id: 'link-1' } })).toBe('Signed through signing link link-1.');
    expect(signedBy({ name: 'Casey Customer' })).toBe('Signed by Casey Customer');
    expect(signedBy({ name: 'Casey Customer', role: 'other' })).toBe('Signed by Casey Customer, other');
    expect(signedWhen('2026-11-14T18:30:00.123Z', 'UTC')).toBe('November 14, 2026 at 6:30:00 PM UTC');
  });

  it('answers the setup check with its own list, and a lost answer as safe to retry', () => {
    expect(signOutcomeOf(409, { error: 'company_setup_missing', missing: ['Start-work authorization', 'Payment terms'] }).message).toContain('Start-work authorization, Payment terms');
    expect(signOutcomeOf(0, null)).toMatchObject({ next: 'retry' });
    expect(signOutcomeOf(503, { error: 'agreements_unavailable' })).toMatchObject({ next: 'retry' });
    for (const [status, body] of [
      [0, null],
      [502, null],
      [503, { error: 'agreements_unavailable' }],
      [503, { error: 'photos_unavailable' }],
    ] as const) {
      const outcome = signOutcomeOf(status, body);
      expect(outcome).toEqual({ message: 'We could not confirm signing with DryScope. Check your connection, then try signing again to get the result.', next: 'retry' });
      expect(outcome.message).not.toMatch(/nothing was signed/i);
    }
    expect(signOutcomeOf(409, { error: 'estimate_superseded' })).toMatchObject({ next: 'reload' });
    expect(signOutcomeOf(409, { error: 'conflict' })).toMatchObject({ next: 'redraw' });
  });

  it('reads an agreement answer, or none', () => {
    expect(agreementAnswerOf({ agreement: null })).toEqual({ agreement: null });
    expect(agreementAnswerOf({ agreement: { id: 'x' } })).toBeNull();
    const made = { id: 'x', signedAt: '2026-11-14T18:30:00.123Z', documentsSha256: 'a'.repeat(64), record: { proposal: {}, signer: { name: 'Casey' } } };
    expect(agreementAnswerOf({ agreement: made })?.agreement).toBe(made);
  });
});
