import { describe, expect, it } from 'vitest';
import { PROFILE_FIELDS, profileInput } from '@/lib/profile/schema';
import { changedProfile, offersCompanyScreen, profileMessage, profileView, signedInProfileManager } from '@/lib/profile/screen';

// S5a-4, the company profile's request body and the pure helpers of its screen. The limits are the
// ones migration 0010 holds as check constraints, so a body that passes here is never refused by the
// database. tests/db/company-profile.test.ts drives the routes against Postgres.

const BASE = { revision: '2026-11-13T10:20:30.123456Z', changeId: '3E9A7C52-8B14-4F06-9D2A-6C1B5E8F0A37' };
const VALUES = {
  address: '12 Example Street, Testville, CA 90000',
  phone: '(555) 010-0100',
  email: 'Office@Example.Test',
  license: '000001',
  signoff: 'Pat Example',
};
const GOOD = { ...BASE, ...VALUES };

describe('the profile body', () => {
  it('accepts the five fields, trims them and writes the email in lower case', () => {
    const parsed = profileInput.parse({ ...GOOD, address: `  ${GOOD.address}  `, signoff: ' Pat Example ' });
    expect(parsed).toEqual({ ...GOOD, changeId: BASE.changeId.toLowerCase(), email: 'office@example.test' });
  });

  it('accepts empty fields (empty means not set)', () => {
    expect(profileInput.parse({ ...BASE, address: '', phone: '', email: '', license: '', signoff: '' })).toEqual({
      revision: BASE.revision,
      changeId: BASE.changeId.toLowerCase(),
      address: '',
      phone: '',
      email: '',
      license: '',
      signoff: '',
    });
  });

  it('names the five fields the database holds', () => {
    expect([...PROFILE_FIELDS]).toEqual(['address', 'phone', 'email', 'license', 'signoff']);
  });

  it.each(['name', 'status', 'companyId', 'signInSlug', 'authTenantId', 'logo'])(
    'refuses a body that also names %s (the owner changes the profile, nothing else)',
    (key) => {
      expect(profileInput.safeParse({ ...GOOD, [key]: 'x' }).success).toBe(false);
    },
  );

  it.each([
    ['revision', undefined],
    ['changeId', undefined],
    ['revision', '2026-11-13T10:20:30Z'],
    ['revision', 7],
    ['changeId', 'change-1'],
  ])('refuses a save whose %s is %j (every save names the revision it was based on and its own change id)', (key, value) => {
    expect(profileInput.safeParse({ ...GOOD, [key]: value }).success).toBe(false);
  });

  it('refuses a missing field and a field that is not text', () => {
    const without: Record<string, string> = { ...GOOD };
    delete without.phone;
    expect(profileInput.safeParse(without).success).toBe(false);
    expect(profileInput.safeParse({ ...GOOD, license: 950983 }).success).toBe(false);
    expect(profileInput.safeParse({ ...GOOD, signoff: null }).success).toBe(false);
    expect(profileInput.safeParse(null).success).toBe(false);
    expect(profileInput.safeParse([]).success).toBe(false);
  });

  it.each([
    ['address', 501],
    ['phone', 81],
    ['email', 255],
    ['license', 81],
    ['signoff', 151],
  ] as const)('refuses a %s of %i characters', (field, length) => {
    const long = field === 'email' ? `${'a'.repeat(length - 13)}@example.test` : 'x'.repeat(length);
    expect(profileInput.safeParse({ ...GOOD, [field]: long }).success).toBe(false);
  });

  it('accepts a field exactly at its limit', () => {
    expect(profileInput.safeParse({ ...GOOD, address: 'x'.repeat(500), signoff: 'y'.repeat(150), license: 'z'.repeat(80) }).success).toBe(true);
  });

  it.each(['line one\nline two', 'tab\there', 'bell\u0007', 'null\u0000byte', 'delete\u007f'])(
    'refuses control characters in the address (%j)',
    (address) => {
      expect(profileInput.safeParse({ ...GOOD, address }).success).toBe(false);
    },
  );

  it('refuses an email address with characters outside printable ASCII, so the database’s lower-casing never differs', () => {
    expect(profileInput.safeParse({ ...GOOD, email: 'ofﬁce@example.test' }).success).toBe(false);
    expect(profileInput.safeParse({ ...GOOD, email: 'İ@example.test' }).success).toBe(false);
  });

  it.each(['no-at-sign', 'two@@example.test', 'a b@example.test', 'a@example', '<a>@example.test', 'a@exam<ple.test'])(
    'refuses the email %s',
    (email) => {
      expect(profileInput.safeParse({ ...GOOD, email }).success).toBe(false);
    },
  );
});

describe('the company settings screen helpers', () => {
  it('offers the screen to the owner only, by the same table the server reads', () => {
    expect(offersCompanyScreen('owner')).toBe(true);
    expect(offersCompanyScreen('estimator')).toBe(false);
    expect(offersCompanyScreen('office')).toBe(false);
    expect(offersCompanyScreen('nonsense')).toBe(false);
  });

  it('reads who is signed in from /api/me', () => {
    const me = (role: string, capabilities: string[]) => ({ company: { id: 'c1' }, role, capabilities });
    expect(signedInProfileManager(me('owner', ['jobs_read', 'profile_manage']))).toEqual({ companyId: 'c1', canManageProfile: true });
    expect(signedInProfileManager(me('estimator', ['jobs_read']))).toEqual({ companyId: 'c1', canManageProfile: false });
    expect(signedInProfileManager({})).toBeNull();
    expect(signedInProfileManager(null)).toBeNull();
  });

  it('reads the profile answer, and nothing of an unexpected shape', () => {
    const view = { companyId: 'c1', name: 'Co', revision: BASE.revision, ...VALUES, setupMissing: ['CSLB license'] };
    expect(profileView(view)).toEqual(view);
    expect(profileView({ ...view, revision: undefined })).toBeNull();
    expect(profileView({ ...view, setupMissing: 'x' })).toBeNull();
    expect(profileView({ ...view, phone: 5 })).toBeNull();
    expect(profileView(null)).toBeNull();
  });

  it('reads the current profile from a 409 to a stale save, and from nothing else', () => {
    const view = { companyId: 'c1', name: 'Co', revision: BASE.revision, ...VALUES, setupMissing: [] };
    expect(changedProfile(409, { error: 'stale_revision', profile: view })).toEqual(view);
    expect(changedProfile(200, view)).toBeNull();
    expect(changedProfile(409, { error: 'stale_revision' })).toBeNull();
    expect(changedProfile(400, { error: 'invalid_request', profile: view })).toBeNull();
  });

  it('turns the server’s codes into fixed words, never echoing what was typed', () => {
    expect(profileMessage(403, { error: 'not_allowed' })).toMatch(/owner/i);
    expect(profileMessage(400, { error: 'invalid_request' })).toMatch(/check/i);
    expect(profileMessage(404, { error: 'not_found' })).toMatch(/reload/i);
    expect(profileMessage(409, { error: 'stale_revision' })).toMatch(/changed somewhere else/i);
    expect(profileMessage(503, { error: 'profile_unavailable' })).toMatch(/try again/i);
    expect(profileMessage(500, null)).toMatch(/try again/i);
  });
});
