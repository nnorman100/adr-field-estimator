// S5a-4: the engine's company setup check. A company's profile (name, address, licence, sign-off)
// must be complete before documents are issued; the check names what is missing, the profile API
// shows that list to the owner, and the documents stay unsignable until it is empty.

import { describe, expect, it } from 'vitest';

import { companySetupMissing } from '../../src/engine/company-setup';
import { item, COMPANY, documentJob, priced, room, table } from './estimate-fixtures';

const FULL = { name: 'Example Restoration', address: '1 Synthetic Way, Testville', license: '000001', signoff: 'Pat Example' };

describe('companySetupMissing', () => {
  it('lists nothing for a complete profile', () => {
    expect(companySetupMissing(FULL)).toEqual([]);
  });

  it('lists a missing licence and a missing sign-off, in the order the owner fills them in', () => {
    expect(companySetupMissing({ ...FULL, license: '', signoff: '' })).toEqual(['CSLB license', 'Document sign-off']);
    expect(companySetupMissing({ ...FULL, license: '' })).toEqual(['CSLB license']);
    expect(companySetupMissing({ ...FULL, signoff: '' })).toEqual(['Document sign-off']);
  });

  it('counts blank space as missing', () => {
    expect(companySetupMissing({ ...FULL, license: '   ', signoff: '\t' })).toEqual(['CSLB license', 'Document sign-off']);
  });

  it('lists the name and the address too', () => {
    expect(companySetupMissing({ name: '', address: '', license: '1', signoff: 'x' })).toEqual([
      'Company name',
      'Company address',
    ]);
  });
});

describe('the documents use the same check', () => {
  const PRICES = table([item('demo')]);
  const KITCHEN = [room('Kitchen', { unfinished_sf: 100 })];

  it('are signable with a complete profile', () => {
    expect(priced(PRICES, documentJob(KITCHEN)).documents?.signable).toBe(true);
  });

  it.each([
    ['licence', { license: '' }],
    ['sign-off', { signoff: '' }],
    ['address', { address: ' ' }],
    ['name', { name: '' }],
  ])('are not signable when the %s is missing', (_label, change) => {
    const docs = priced(PRICES, documentJob(KITCHEN, {}, { company: { ...COMPANY, ...change } })).documents;
    expect(docs?.signable).toBe(false);
  });
});
