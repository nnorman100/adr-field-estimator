import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S5a-4b, the letterhead fields and document settings through the S5a-4 profile routes, as the
// runtime role against Postgres (same setup as company-profile.test.ts): the owner saves and reads
// each one; estimator, office and the platform operator are refused; an unknown key, an oversized
// clause or list and a layout outside the list are refused and write nothing; company B never reads
// or changes company A's; a save that leaves them out keeps them; the documents' reader gets the
// letterhead.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/profile/services', () => ({ profileServices: () => live.harness!.profile }));

const { GET: readProfile, PUT: saveProfile } = await import('@/app/api/companies/[companyId]/profile/route');
const { everything, operatorClaims, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
const { withCompany } = await import('@/db/tenant');
const { readCompanyDocuments } = await import('@/lib/profile/documents');
type FakeClaims = import('./team-harness').FakeClaims;

let base: Awaited<ReturnType<typeof startTeamServer>>;
let h: Harness;

beforeAll(async () => {
  base = await startTeamServer();
});

beforeEach(async () => {
  h = await resetTeamDatabase(base, live.harness);
  live.harness = h;
});

afterAll(async () => {
  await live.harness?.handle.close();
  await base?.admin.end({ timeout: 5 });
  await base?.server.stop();
});

const estimator: FakeClaims = { tenant: 'tenant-a', uid: 'estimator-a' };
const office: FakeClaims = { tenant: 'tenant-a', uid: 'office-a' };
const ownerB: FakeClaims = { tenant: 'tenant-b', uid: 'owner-b' };

const PROFILE = {
  address: '12 Example Street, Testville, CA 90000',
  phone: '(555) 010-0100',
  email: 'office@example.test',
  license: '000001',
  signoff: 'Pat Example',
};
const LETTERHEAD = {
  emergencyPhone: '(555) 010-0199',
  fax: '(555) 010-0102',
  website: 'www.example.com',
  tagline: 'Water damage and mold remediation',
  mailingAddress: 'PO Box 100, Testville, CA 90000',
};
const DOCUMENTS = {
  proposal_layout: 'letter',
  company_clauses: [
    { title: 'Scheduling', text: 'We confirm the start date by phone two days before work begins.' },
    { title: 'Access', text: 'Please keep pets away from the work area.\nThank you.' },
  ],
  prep_tasks: ['The homeowner removes the contents of the closet before the start date.'],
  photo_log_grouping: 'shot_tag',
  authorization_text: 'I authorize the work described in this estimate to begin.',
  payment_terms_text: 'Payment is due within 30 days of completion.',
  show_previous_price: true,
};
const NEUTRAL = {
  proposal_layout: 'itemized',
  company_clauses: [],
  prep_tasks: [],
  photo_log_grouping: 'room',
  authorization_text: '',
  payment_terms_text: '',
  show_previous_price: false,
};
const EMPTY_LETTERHEAD = { emergencyPhone: '', fax: '', website: '', tagline: '', mailingAddress: '' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const get = async (claims: FakeClaims | null, companyId: string) => {
  const response = await readProfile(request(claims, `/api/companies/${companyId}/profile`), params({ companyId }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null };
};
const send = async (claims: FakeClaims | null, companyId: string, body: unknown) => {
  const response = await saveProfile(request(claims, `/api/companies/${companyId}/profile`, { method: 'PUT', body }), params({ companyId }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null };
};
const revisionNow = async (companyId: string): Promise<string> => (await get(companyId === h.seed.b ? ownerB : owner(), companyId)).body!.revision;
const put = async (claims: FakeClaims | null, companyId: string, body: Json) =>
  send(claims, companyId, { revision: await revisionNow(companyId), changeId: randomUUID(), ...body });
const rowOf = async (companyId: string) =>
  (
    await h.admin<Json[]>`
      SELECT profile_emergency_phone, profile_fax, profile_website, profile_tagline, profile_mailing_address, profile_documents
      FROM companies WHERE id = ${companyId}`
  )[0]!;
const audits = () => h.admin<Json[]>`SELECT details FROM audit_events WHERE action = 'company_profile_saved' ORDER BY created_at`;

describe('the owner saves and reads the letterhead and document settings', () => {
  it('reads every company’s starting values: the letterhead empty, the settings neutral, both texts missing', async () => {
    for (const [claims, company] of [[owner(), h.seed.a], [ownerB, h.seed.b]] as const) {
      const { status, body } = await get(claims, company);
      expect(status).toBe(200);
      expect(body).toMatchObject({ ...EMPTY_LETTERHEAD, documents: NEUTRAL });
      expect(body!.setupMissing).toEqual(['Company address', 'CSLB license', 'Document sign-off', 'Start-work authorization', 'Payment terms']);
    }
  });

  it('saves each letterhead line and each setting, reads them back and holds them on the company’s row', async () => {
    const saved = await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS, setupMissing: [] });
    expect((await get(owner(), h.seed.a)).body).toEqual(saved.body);
    expect(await rowOf(h.seed.a)).toEqual({
      profile_emergency_phone: LETTERHEAD.emergencyPhone,
      profile_fax: LETTERHEAD.fax,
      profile_website: LETTERHEAD.website,
      profile_tagline: LETTERHEAD.tagline,
      profile_mailing_address: LETTERHEAD.mailingAddress,
      profile_documents: DOCUMENTS,
    });
    // One audit row counting the five profile lines, five letterhead lines and seven settings, and no value.
    const rows = await audits();
    expect(rows.map((row) => row.details.fields_changed)).toEqual([17]);
    const text = JSON.stringify(rows);
    for (const value of [...Object.values(LETTERHEAD), DOCUMENTS.authorization_text, DOCUMENTS.prep_tasks[0]!]) expect(text).not.toContain(value);
  });

  it.each([
    ['emergencyPhone', { emergencyPhone: '(555) 010-0177' }],
    ['fax', { fax: '' }],
    ['website', { website: 'example.org/contact' }],
    ['tagline', { tagline: 'Mold remediation' }],
    ['mailingAddress', { mailingAddress: '' }],
  ])('saves the %s on its own, keeping everything else', async (field, change) => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const saved = await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, ...change, documents: DOCUMENTS });
    expect(saved.body).toMatchObject({ ...LETTERHEAD, ...change, documents: DOCUMENTS });
    expect((await audits()).at(-1)!.details.fields_changed).toBe(1);
    expect((await get(owner(), h.seed.a)).body?.[field]).toBe((change as Json)[field]);
  });

  it.each(Object.keys(NEUTRAL))('saves the setting %s on its own, keeping the others', async (key) => {
    const changed = { ...NEUTRAL, [key]: (DOCUMENTS as Json)[key] };
    const saved = await put(owner(), h.seed.a, { ...PROFILE, documents: changed });
    expect(saved.status).toBe(200);
    expect(saved.body?.documents).toEqual(changed);
    expect((await get(owner(), h.seed.a)).body?.documents).toEqual(changed);
    expect((await rowOf(h.seed.a)).profile_documents).toEqual(changed);
  });

  it('saves and reads each text exactly as entered, leading spaces and a final line break included', async () => {
    const asEntered = {
      ...DOCUMENTS,
      company_clauses: [{ title: '  Scheduling ', text: '  First paragraph\n\n  Second paragraph\n' }],
      prep_tasks: ['  Clear the closet. '],
      authorization_text: '  I authorize the work.\n',
      payment_terms_text: '\nDue on completion.  ',
    };
    const saved = await put(owner(), h.seed.a, { ...PROFILE, documents: asEntered });
    expect(saved.status).toBe(200);
    expect(saved.body?.documents).toEqual(asEntered);
    expect((await get(owner(), h.seed.a)).body?.documents).toEqual(asEntered);
    expect((await rowOf(h.seed.a)).profile_documents).toEqual(asEntered);
  });

  it('keeps the letterhead and settings when a save leaves them out (a screen that does not know them)', async () => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const saved = await put(owner(), h.seed.a, { ...PROFILE, phone: '(555) 010-0111' });
    expect(saved.body).toMatchObject({ phone: '(555) 010-0111', ...LETTERHEAD, documents: DOCUMENTS });
    expect((await rowOf(h.seed.a)).profile_documents).toEqual(DOCUMENTS);
  });

  it('lists a missing authorization or payment terms before signing, and nothing once both are set', async () => {
    expect((await put(owner(), h.seed.a, { ...PROFILE, documents: { authorization_text: 'I authorize the work.' } })).body?.setupMissing).toEqual(['Payment terms']);
    expect((await put(owner(), h.seed.a, { ...PROFILE, documents: { payment_terms_text: 'Due on completion.' } })).body?.setupMissing).toEqual([
      'Start-work authorization',
    ]);
    expect((await put(owner(), h.seed.a, { ...PROFILE, documents: DOCUMENTS })).body?.setupMissing).toEqual([]);
  });

  it('refuses a stale save that changes a setting, keeping the newer one', async () => {
    const read = await revisionNow(h.seed.a);
    const one = await send(owner(), h.seed.a, { revision: read, changeId: randomUUID(), ...PROFILE, documents: { proposal_layout: 'letter' } });
    expect(one.status).toBe(200);
    const two = await send(owner(), h.seed.a, { revision: read, changeId: randomUUID(), ...PROFILE, documents: { show_previous_price: true } });
    expect(two).toEqual({ status: 409, body: { error: 'stale_revision', profile: one.body } });
    expect((await rowOf(h.seed.a)).profile_documents).toEqual({ ...NEUTRAL, proposal_layout: 'letter' });
  });

  it('gives the documents’ one reader the letterhead lines, and the settings still at their neutral defaults', async () => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const read = await withCompany(h.handle.db, h.seed.a, (tx) => readCompanyDocuments(tx, h.seed.a));
    expect(read?.letterhead).toEqual(LETTERHEAD);
    expect(read?.identity).toEqual({ companyId: h.seed.a, name: 'Company company-a', ...PROFILE });
    expect(read?.settings).toEqual({ proposalLayout: 'itemized', companyClauses: [], photoLogGrouping: 'room' });
  });

  it('answers 503 and uses nothing when the stored settings do not read through the schema', async () => {
    await h.admin`UPDATE companies SET profile_documents = '{"proposal_layout": "brochure"}'::jsonb WHERE id = ${h.seed.a}`;
    expect(await get(owner(), h.seed.a)).toEqual({ status: 503, body: { error: 'profile_unavailable' } });
  });
});

describe('a refused request writes nothing', () => {
  it.each([
    ['an estimator', estimator, 403],
    ['an office user', office, 403],
  ])('%s cannot read or save the letterhead or settings', async (_who, claims, status) => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const before = await everything(h.admin);
    expect(await get(claims, h.seed.a)).toEqual({ status, body: { error: 'not_allowed' } });
    expect(await put(claims, h.seed.a, { ...PROFILE, ...LETTERHEAD, tagline: 'Taken over', documents: NEUTRAL })).toEqual({ status, body: { error: 'not_allowed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('the platform operator cannot read or save a company’s letterhead or settings', async () => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const before = await everything(h.admin);
    // The operator's sign-in is not a company sign-in: the member routes refuse it before any read.
    expect(await get(operatorClaims(), h.seed.a)).toEqual({ status: 403, body: { error: 'unknown_tenant' } });
    const saved = await send(operatorClaims(), h.seed.a, { revision: '2026-01-01T00:00:00.000000Z', changeId: randomUUID(), ...PROFILE, documents: NEUTRAL });
    expect(saved).toEqual({ status: 403, body: { error: 'unknown_tenant' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('company B’s owner never reads or changes company A’s letterhead or settings', async () => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const before = await everything(h.admin);
    expect(await get(ownerB, h.seed.a)).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await send(ownerB, h.seed.a, { revision: await revisionNow(h.seed.a), changeId: randomUUID(), ...PROFILE, documents: NEUTRAL })).toEqual({
      status: 404,
      body: { error: 'not_found' },
    });
    expect(await everything(h.admin)).toBe(before);
    // B's own profile holds nothing of A's, and B saving its own changes nothing of A's.
    const own = await get(ownerB, h.seed.b);
    expect(own.body).toMatchObject({ ...EMPTY_LETTERHEAD, documents: NEUTRAL });
    const text = JSON.stringify(own.body);
    for (const value of [LETTERHEAD.tagline, DOCUMENTS.authorization_text, DOCUMENTS.company_clauses[0]!.title]) expect(text).not.toContain(value);
    await put(ownerB, h.seed.b, { ...PROFILE, tagline: 'Company B line', documents: { proposal_layout: 'itemized', prep_tasks: ['B task'] } });
    expect(await rowOf(h.seed.a)).toMatchObject({ profile_tagline: LETTERHEAD.tagline, profile_documents: DOCUMENTS });
    expect(await rowOf(h.seed.b)).toMatchObject({ profile_tagline: 'Company B line', profile_documents: { ...NEUTRAL, prep_tasks: ['B task'] } });
  });

  it.each([
    ['an unknown key in the settings', { documents: { ...DOCUMENTS, show_line_breakdown: true } }],
    ['an unknown key beside the settings', { settings: DOCUMENTS }],
    ['a layout outside the list', { documents: { ...DOCUMENTS, proposal_layout: 'brochure' } }],
    ['a photo grouping outside the list', { documents: { ...DOCUMENTS, photo_log_grouping: 'date' } }],
    ['an oversized clause', { documents: { ...DOCUMENTS, company_clauses: [{ title: 'Long', text: 'x'.repeat(2_001) }] } }],
    ['eleven clauses', { documents: { ...DOCUMENTS, company_clauses: Array.from({ length: 11 }, (_, i) => ({ title: `T${i}`, text: 'x' })) } }],
    ['thirty-one prep tasks', { documents: { ...DOCUMENTS, prep_tasks: Array.from({ length: 31 }, (_, i) => `Task ${i}`) } }],
    ['an oversized prep task', { documents: { ...DOCUMENTS, prep_tasks: ['x'.repeat(301)] } }],
    ['oversized payment terms', { documents: { ...DOCUMENTS, payment_terms_text: 'x'.repeat(4_001) } }],
    ['settings over 64,000 bytes', { documents: { company_clauses: Array.from({ length: 10 }, () => ({ title: 'T', text: '€'.repeat(2_000) })), authorization_text: '€'.repeat(1_400) } }],
    ['an over-long website', { website: 'x'.repeat(201) }],
    ['a line break in the tagline', { tagline: 'one\ntwo' }],
  ])('answers 400 to %s and writes nothing', async (_what, change) => {
    await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, documents: DOCUMENTS });
    const before = await everything(h.admin);
    expect(await put(owner(), h.seed.a, { ...PROFILE, ...LETTERHEAD, ...change })).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(await everything(h.admin)).toBe(before);
  });
});
