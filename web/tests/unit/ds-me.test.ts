import { describe, expect, it } from 'vitest';
import { meKey, parseMe } from '../../src/lib/field/ds-me';

const ROW = {
  key: 'tenant-1/uid-1',
  tenantId: 'tenant-1',
  uid: 'uid-1',
  companyName: 'Company A',
  address: 'company-a',
  config: { apiKey: 'k'.repeat(20), authDomain: 'a.firebaseapp.com', projectId: 'dryscope-test', authEmulatorUrl: null },
  savedAt: 1,
};

describe('ds-me rows', () => {
  it('are keyed by company and person', () => {
    expect(meKey('tenant-1', 'uid-1')).toBe(ROW.key);
    expect(meKey('tenant-2', 'uid-1')).not.toBe(ROW.key);
  });

  it('are read when they have the shape the sign-in page writes', () => {
    expect(parseMe(ROW)).toEqual(ROW);
  });

  it.each([
    ['null', null],
    ['a string', 'row'],
    ['no tenant', { ...ROW, tenantId: '' }],
    ['no person', { ...ROW, uid: undefined }],
    ['no company', { ...ROW, companyName: 7 }],
    ['no time', { ...ROW, savedAt: '1' }],
    ['no settings', { ...ROW, config: null }],
    ['no api key', { ...ROW, config: { ...ROW.config, apiKey: '' } }],
  ])('are skipped when damaged: %s', (_name, value) => {
    expect(parseMe(value)).toBeNull();
  });
});
