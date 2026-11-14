import { describe, expect, it } from 'vitest';
import { companySetupMissing } from '@/engine/company-setup';
import { draftOf, settingsOf } from '@/lib/profile/documents-draft';
import { LETTERHEAD_FIELDS, profileInput } from '@/lib/profile/schema';
import { profileView } from '@/lib/profile/screen';
import { nextProfile, profileOf } from '@/lib/profile/service';
import { DOCUMENT_LIMITS, changedDocumentSettings, documentSettings, neutralDocumentSettings, readDocumentSettings } from '@/lib/profile/settings';

// S5a-4b, the letterhead fields and the document settings: the one schema the settings are checked
// by at write and at read, the save body, the rule that decides a save, the setup check before
// signing, and the screen's helpers. tests/db/company-documents.test.ts drives the routes against
// Postgres and tests/db/company-documents-columns.test.ts the columns of migration 0013.

const NEUTRAL = {
  proposal_layout: 'itemized',
  company_clauses: [],
  prep_tasks: [],
  photo_log_grouping: 'room',
  authorization_text: '',
  payment_terms_text: '',
  show_previous_price: false,
};
const SET = {
  proposal_layout: 'letter',
  company_clauses: [{ title: 'Scheduling', text: 'We confirm the start date by phone.\nTwo days before.' }],
  prep_tasks: ['The homeowner removes the contents of the closet before the start date.'],
  photo_log_grouping: 'shot_tag',
  authorization_text: 'I authorize the work described in this estimate to begin.',
  payment_terms_text: 'Payment is due within 30 days of completion.',
  show_previous_price: true,
};
const FIELDS = {
  address: '12 Example Street, Testville, CA 90000',
  phone: '(555) 010-0100',
  email: 'office@example.test',
  license: '000001',
  signoff: 'Pat Example',
};
const REVISION = '2026-11-14T10:20:30.123456Z';
const BASE = { revision: REVISION, changeId: '3e9a7c52-8b14-4f06-9d2a-6c1b5e8f0a37', ...FIELDS };
const LETTERHEAD = {
  emergencyPhone: '(555) 010-0199',
  fax: '(555) 010-0102',
  website: 'www.example.com',
  tagline: 'Water damage and mold remediation',
  mailingAddress: 'PO Box 100, Testville, CA 90000',
};
const ok = (value: unknown) => documentSettings.safeParse(value).success;

describe('the document settings schema', () => {
  it('reads every company’s starting value, an empty object, as the neutral defaults', () => {
    expect(readDocumentSettings({})).toEqual(NEUTRAL);
    expect(neutralDocumentSettings()).toEqual(NEUTRAL);
  });

  it('keeps every setting the owner set, the clause’s line breaks included', () => {
    expect(documentSettings.parse(SET)).toEqual(SET);
  });

  it('keeps each text exactly as entered, leading spaces and a final line break included', () => {
    const asEntered = {
      ...SET,
      company_clauses: [{ title: '  Scheduling ', text: '  First paragraph\n\n  Second paragraph\n' }],
      prep_tasks: ['  Clear the closet. '],
      authorization_text: '  I authorize the work.\n',
      payment_terms_text: '\nDue on completion.  ',
    };
    expect(documentSettings.parse(asEntered)).toEqual(asEntered);
    expect(readDocumentSettings(JSON.parse(JSON.stringify(asEntered)))).toEqual(asEntered);
  });

  it.each([
    ['an unknown key', { ...SET, show_line_breakdown: true }],
    ['a layout outside the list', { ...SET, proposal_layout: 'brochure' }],
    ['a grouping outside the list', { ...SET, photo_log_grouping: 'date' }],
    ['an unknown key inside a clause', { ...SET, company_clauses: [{ title: 'T', text: 'x', order: 1 }] }],
    ['a clause of 2,001 characters', { ...SET, company_clauses: [{ title: 'T', text: 'x'.repeat(2_001) }] }],
    ['a clause title of 121 characters', { ...SET, company_clauses: [{ title: 'x'.repeat(121), text: 'x' }] }],
    ['eleven clauses', { ...SET, company_clauses: Array.from({ length: 11 }, () => ({ title: 'T', text: 'x' })) }],
    ['a clause with no text', { ...SET, company_clauses: [{ title: 'T', text: '  ' }] }],
    ['a clause with no title', { ...SET, company_clauses: [{ title: '', text: 'x' }] }],
    ['a line break in a clause title', { ...SET, company_clauses: [{ title: 'one\ntwo', text: 'x' }] }],
    ['thirty-one prep tasks', { ...SET, prep_tasks: Array.from({ length: 31 }, () => 'x') }],
    ['a prep task of 301 characters', { ...SET, prep_tasks: ['x'.repeat(301)] }],
    ['an empty prep task', { ...SET, prep_tasks: [' '] }],
    ['a line break in a prep task', { ...SET, prep_tasks: ['one\ntwo'] }],
    ['an authorization of 4,001 characters', { ...SET, authorization_text: 'x'.repeat(4_001) }],
    ['payment terms of 4,001 characters', { ...SET, payment_terms_text: 'x'.repeat(4_001) }],
    ['a tab in the payment terms', { ...SET, payment_terms_text: 'a\tb' }],
    ['a NUL in the authorization', { ...SET, authorization_text: 'a\u0000b' }],
    ['a carriage return in a clause', { ...SET, company_clauses: [{ title: 'T', text: 'a\r\nb' }] }],
    ['half of a surrogate pair', { ...SET, authorization_text: 'a\ud800b' }],
    ['a previous-price switch that is not true or false', { ...SET, show_previous_price: 'yes' }],
    ['a list that is not a list', { ...SET, prep_tasks: 'x' }],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_what, value) => {
    expect(ok(value)).toBe(false);
  });

  it('accepts each list and text exactly at its limit', () => {
    expect(
      ok({
        company_clauses: Array.from({ length: 10 }, () => ({ title: 'x'.repeat(120), text: 'x'.repeat(2_000) })),
        prep_tasks: Array.from({ length: 30 }, () => 'x'.repeat(300)),
        authorization_text: 'x'.repeat(4_000),
        payment_terms_text: 'x'.repeat(4_000),
      }),
    ).toBe(true);
  });

  it('refuses settings over 64,000 bytes as JSON even when every part is within its limit', () => {
    // Three bytes a character in UTF-8: ten full clauses are 60,000 bytes, and the terms pass 64,000.
    const big = {
      company_clauses: Array.from({ length: 10 }, () => ({ title: 'T', text: '€'.repeat(2_000) })),
      authorization_text: '€'.repeat(1_400),
    };
    expect(ok({ ...big, authorization_text: '€'.repeat(1_000) })).toBe(true);
    expect(ok(big)).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(documentSettings.parse({ ...big, authorization_text: '' }))).length).toBeLessThan(DOCUMENT_LIMITS.bytes);
  });

  it('refuses settings it cannot read, so a damaged stored value is never used', () => {
    expect(() => readDocumentSettings({ proposal_layout: 'brochure' })).toThrow();
    expect(() => readDocumentSettings(null)).toThrow();
  });

  it('names the settings that changed', () => {
    const before = documentSettings.parse(SET);
    expect(changedDocumentSettings(before, before)).toEqual([]);
    expect(changedDocumentSettings(before, { ...before, prep_tasks: [], show_previous_price: false })).toEqual(['prep_tasks', 'show_previous_price']);
  });
});

describe('the profile save body with letterhead and settings', () => {
  it('accepts the letterhead lines and the settings, trimmed', () => {
    const parsed = profileInput.parse({ ...BASE, ...LETTERHEAD, tagline: ` ${LETTERHEAD.tagline} `, documents: SET });
    expect(parsed).toEqual({ ...BASE, ...LETTERHEAD, documents: SET });
  });

  it('accepts a save that leaves the letterhead and the settings out (a screen that does not know them)', () => {
    expect(profileInput.parse(BASE)).toEqual(BASE);
  });

  it('fills a setting left out of the settings with its neutral default', () => {
    expect(profileInput.parse({ ...BASE, documents: { proposal_layout: 'letter' } }).documents).toEqual({ ...NEUTRAL, proposal_layout: 'letter' });
  });

  it.each([
    ['emergencyPhone', 81],
    ['fax', 81],
    ['website', 201],
    ['tagline', 151],
    ['mailingAddress', 501],
  ] as const)('refuses a %s of %i characters, and a line break in it', (field, length) => {
    expect(profileInput.safeParse({ ...BASE, [field]: 'x'.repeat(length) }).success).toBe(false);
    expect(profileInput.safeParse({ ...BASE, [field]: 'x'.repeat(length - 1) }).success).toBe(true);
    expect(profileInput.safeParse({ ...BASE, [field]: 'one\ntwo' }).success).toBe(false);
  });

  it('refuses settings the schema refuses, and a key beside them', () => {
    expect(profileInput.safeParse({ ...BASE, documents: { ...SET, proposal_layout: 'brochure' } }).success).toBe(false);
    expect(profileInput.safeParse({ ...BASE, documents: { ...SET, extra: 1 } }).success).toBe(false);
    expect(profileInput.safeParse({ ...BASE, settings: SET }).success).toBe(false);
    expect(profileInput.safeParse({ ...BASE, documents: 'letter' }).success).toBe(false);
  });

  it('names the five letterhead lines', () => {
    expect([...LETTERHEAD_FIELDS]).toEqual(['emergencyPhone', 'fax', 'website', 'tagline', 'mailingAddress']);
  });
});

describe('deciding a save', () => {
  const stored = profileOf({ id: 'c1', name: 'Co', revision: REVISION, ...FIELDS, ...LETTERHEAD, documents: SET });

  it('keeps the stored letterhead and settings when a save leaves them out', () => {
    const { values, changed } = nextProfile(stored, profileInput.parse({ ...BASE, phone: '(555) 010-0111' }));
    expect(values).toEqual({ ...FIELDS, phone: '(555) 010-0111', ...LETTERHEAD, documents: SET });
    expect(changed).toEqual(['phone']);
  });

  it('counts each letterhead line and each setting that changed, and nothing for the same values', () => {
    const same = nextProfile(stored, profileInput.parse({ ...BASE, ...LETTERHEAD, documents: SET }));
    expect(same.changed).toEqual([]);
    const cleared = nextProfile(stored, profileInput.parse({ ...BASE, ...LETTERHEAD, fax: '', documents: { ...SET, payment_terms_text: '' } }));
    expect(cleared.changed).toEqual(['fax', 'payment_terms_text']);
    expect(nextProfile(stored, profileInput.parse({ ...BASE, documents: {} })).changed).toEqual(DOCUMENT_KEYS_IN_ORDER);
  });
});
const DOCUMENT_KEYS_IN_ORDER = ['proposal_layout', 'company_clauses', 'prep_tasks', 'photo_log_grouping', 'authorization_text', 'payment_terms_text', 'show_previous_price'];

describe('the setup check before signing', () => {
  const FULL = { name: 'Example Restoration', address: '1 Synthetic Way, Testville', license: '000001', signoff: 'Pat Example' };
  const TERMS = { authorizationText: 'I authorize the work.', paymentTermsText: 'Due on completion.' };

  it('lists an empty authorization or payment terms after the other fields, when given them', () => {
    expect(companySetupMissing(FULL, TERMS)).toEqual([]);
    expect(companySetupMissing(FULL, { ...TERMS, authorizationText: '' })).toEqual(['Start-work authorization']);
    expect(companySetupMissing(FULL, { ...TERMS, paymentTermsText: ' \n ' })).toEqual(['Payment terms']);
    expect(companySetupMissing({ ...FULL, license: '' }, { authorizationText: '', paymentTermsText: '' })).toEqual([
      'CSLB license',
      'Start-work authorization',
      'Payment terms',
    ]);
  });

  it('leaves them out of the documents’ own check, which passes none', () => {
    expect(companySetupMissing(FULL)).toEqual([]);
  });

  it('is what the profile answer lists', () => {
    expect(profileOf({ id: 'c1', name: 'Co', revision: REVISION, ...FIELDS, ...LETTERHEAD, documents: {} }).setupMissing).toEqual([
      'Start-work authorization',
      'Payment terms',
    ]);
    expect(profileOf({ id: 'c1', name: 'Co', revision: REVISION, ...FIELDS, ...LETTERHEAD, documents: SET }).setupMissing).toEqual([]);
  });
});

describe('the settings screen helpers', () => {
  it('reads the profile answer with its letterhead and settings, and nothing of another shape', () => {
    const view = profileOf({ id: 'c1', name: 'Co', revision: REVISION, ...FIELDS, ...LETTERHEAD, documents: SET });
    expect(profileView(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(profileView({ ...view, documents: undefined })).toBeNull();
    expect(profileView({ ...view, documents: { ...SET, proposal_layout: 'brochure' } })).toBeNull();
    expect(profileView({ ...view, tagline: undefined })).toBeNull();
    expect(profileView({ ...view, fax: 5 })).toBeNull();
  });

  it('round-trips the settings through the editable draft', () => {
    const settings = documentSettings.parse(SET);
    const draft = draftOf(settings);
    expect(new Set(draft.company_clauses.map((c) => c.key)).size + new Set(draft.prep_tasks.map((t) => t.key)).size).toBe(2);
    expect(settingsOf(draft)).toEqual(settings);
  });

  it('leaves out a clause or prep task row left entirely blank, and sends anything typed as typed', () => {
    const draft = draftOf(documentSettings.parse(SET));
    draft.company_clauses.push({ key: -1, title: ' ', text: '' }, { key: -2, title: '', text: 'Only text' });
    draft.prep_tasks.push({ key: -3, text: '   ' });
    expect(settingsOf(draft).company_clauses).toEqual([...SET.company_clauses, { title: '', text: 'Only text' }]);
    expect(settingsOf(draft).prep_tasks).toEqual(SET.prep_tasks);
  });
});
