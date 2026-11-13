import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './team-harness';

// S5a-4, the company profile API through the real route file as the runtime role against Postgres
// (see team-members.test.ts for the setup): only the company's owner reads or changes the profile,
// another company's owner is told it does not exist, a refused request writes nothing (audit row
// included), the profile's missing licence or sign-off is listed by the engine's setup check, and a
// save made from a revision that is no longer the stored one is refused unless it changes nothing.
const live = vi.hoisted(() => ({ harness: null as Harness | null }));
vi.mock('@/lib/auth/services', () => ({
  identityServices: () => live.harness!.identity,
  serverDatabase: () => live.harness!.handle.db,
}));
vi.mock('@/lib/profile/services', () => ({ profileServices: () => live.harness!.profile }));

const { GET: readProfile, PUT: saveProfile } = await import('@/app/api/companies/[companyId]/profile/route');
const { everything, owner, params, request, resetTeamDatabase, startTeamServer } = await import('./team-harness');
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

const FULL = {
  address: '12 Example Street, Testville, CA 90000',
  phone: '(555) 010-0100',
  email: 'office@example.test',
  license: '000001',
  signoff: 'Pat Example',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const get = async (claims: FakeClaims | null, companyId: string) => {
  const response = await readProfile(request(claims, `/api/companies/${companyId}/profile`), params({ companyId }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null, response };
};
const send = async (claims: FakeClaims | null, companyId: string, body: unknown) => {
  const response = await saveProfile(request(claims, `/api/companies/${companyId}/profile`, { method: 'PUT', body }), params({ companyId }));
  return { status: response.status, body: (await response.json().catch(() => null)) as Json | null, response };
};
// The revision the company's own owner reads now.
const revisionNow = async (companyId: string): Promise<string> => (await get(companyId === h.seed.b ? ownerB : owner(), companyId)).body!.revision;
// A save based on the current revision with a new change id, as the screen sends it.
const put = async (claims: FakeClaims | null, companyId: string, body: unknown) =>
  send(
    claims,
    companyId,
    body !== null && typeof body === 'object' && !Array.isArray(body) ? { revision: await revisionNow(companyId), changeId: randomUUID(), ...body } : body,
  );
const REVISION = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
const rowOf = async (companyId: string) =>
  (
    await h.admin<Json[]>`
      SELECT name, status, sign_in_slug, auth_tenant_id, profile_address, profile_phone, profile_email, profile_license, profile_signoff
      FROM companies WHERE id = ${companyId}`
  )[0]!;
const audits = () => h.admin<Json[]>`SELECT company_id, actor_id, action, target, details FROM audit_events WHERE action = 'company_profile_saved'`;

describe('reading the profile', () => {
  it('shows the owner the company name, the empty profile and what the setup check lists', async () => {
    const { status, body, response } = await get(owner(), h.seed.a);
    expect(status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({
      companyId: h.seed.a,
      name: 'Company company-a',
      revision: REVISION,
      address: '',
      phone: '',
      email: '',
      license: '',
      signoff: '',
      setupMissing: ['Company address', 'CSLB license', 'Document sign-off'],
    });
  });

  it('is refused to an estimator and to an office user, who are told the owner does it', async () => {
    for (const claims of [estimator, office]) {
      const { status, body } = await get(claims, h.seed.a);
      expect({ status, body }).toEqual({ status: 403, body: { error: 'not_allowed' } });
    }
  });

  it('is refused to a signed-out caller', async () => {
    expect((await get(null, h.seed.a)).status).toBe(401);
  });

  it('tells another company’s owner that the company does not exist, and shows nothing of it', async () => {
    await put(owner(), h.seed.a, FULL);
    const { status, body } = await get(ownerB, h.seed.a);
    expect({ status, body }).toEqual({ status: 404, body: { error: 'not_found' } });
    // The same owner reads only their own company's profile, which holds nothing of company A's.
    const own = await get(ownerB, h.seed.b);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain('Pat Example');
    expect(own.body?.companyId).toBe(h.seed.b);
  });

  it('answers 404 for an id that is not a company id', async () => {
    expect((await get(owner(), 'not-a-uuid')).status).toBe(404);
  });
});

describe('saving the profile', () => {
  it('lets the owner save the five fields, then reads them back with an empty setup list', async () => {
    const saved = await put(owner(), h.seed.a, { ...FULL, email: 'Office@Example.Test' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ companyId: h.seed.a, name: 'Company company-a', revision: REVISION, ...FULL, setupMissing: [] });
    expect((await get(owner(), h.seed.a)).body).toEqual(saved.body);
    const row = await rowOf(h.seed.a);
    expect(row).toMatchObject({
      profile_address: FULL.address,
      profile_phone: FULL.phone,
      profile_email: FULL.email,
      profile_license: FULL.license,
      profile_signoff: FULL.signoff,
    });
  });

  it('lists a missing licence or sign-off from the engine’s setup check, before any document', async () => {
    expect((await put(owner(), h.seed.a, { ...FULL, license: '' })).body?.setupMissing).toEqual(['CSLB license']);
    expect((await put(owner(), h.seed.a, { ...FULL, signoff: '   ' })).body?.setupMissing).toEqual(['Document sign-off']);
    expect((await put(owner(), h.seed.a, { ...FULL, license: '', signoff: '' })).body?.setupMissing).toEqual([
      'CSLB license',
      'Document sign-off',
    ]);
    expect((await put(owner(), h.seed.a, FULL)).body?.setupMissing).toEqual([]);
  });

  it('writes one audit row that names the actor and the change and holds no value', async () => {
    const changeId = randomUUID();
    await send(owner(), h.seed.a, { revision: await revisionNow(h.seed.a), changeId, ...FULL });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      company_id: h.seed.a,
      actor_id: h.seed.ownerA.actor,
      action: 'company_profile_saved',
      target: h.seed.a,
      details: { fields_changed: 5, change_id: changeId },
    });
    const text = JSON.stringify(rows);
    for (const value of Object.values(FULL)) expect(text).not.toContain(value);
  });

  it('writes no audit row and leaves the row alone when nothing changed', async () => {
    await put(owner(), h.seed.a, FULL);
    const before = await h.admin<Json[]>`SELECT updated_at FROM companies WHERE id = ${h.seed.a}`;
    const again = await put(owner(), h.seed.a, FULL);
    expect(again.status).toBe(200);
    expect(await audits()).toHaveLength(1);
    expect(await h.admin<Json[]>`SELECT updated_at FROM companies WHERE id = ${h.seed.a}`).toEqual(before);
  });

  it('changes only the profile: name, status, sign-in address and sign-in tenant stay as they were', async () => {
    const before = await rowOf(h.seed.a);
    await put(owner(), h.seed.a, FULL);
    const after = await rowOf(h.seed.a);
    expect({ name: after.name, status: after.status, sign_in_slug: after.sign_in_slug, auth_tenant_id: after.auth_tenant_id }).toEqual({
      name: before.name,
      status: before.status,
      sign_in_slug: before.sign_in_slug,
      auth_tenant_id: before.auth_tenant_id,
    });
  });

  it('can clear a field again', async () => {
    await put(owner(), h.seed.a, FULL);
    const cleared = await put(owner(), h.seed.a, { ...FULL, license: '' });
    expect(cleared.body?.license).toBe('');
    expect((await rowOf(h.seed.a)).profile_license).toBe('');
  });
});

describe('saving from an older revision', () => {
  it('gives each save a new revision, which the next read returns', async () => {
    const first = await revisionNow(h.seed.a);
    const saved = await put(owner(), h.seed.a, FULL);
    expect(saved.body?.revision).not.toBe(first);
    expect(await revisionNow(h.seed.a)).toBe(saved.body?.revision);
    const again = await put(owner(), h.seed.a, { ...FULL, phone: '(555) 010-0199' });
    expect(again.body?.revision).not.toBe(saved.body?.revision);
  });

  it('refuses a stale save from a second device with 409 and the current profile, keeping the newer values', async () => {
    await put(owner(), h.seed.a, FULL);
    const read = await revisionNow(h.seed.a);
    // Device one saves a new phone from the revision both devices read.
    const one = await send(owner(), h.seed.a, { revision: read, changeId: randomUUID(), ...FULL, phone: '(555) 010-0199' });
    expect(one.status).toBe(200);
    const before = await everything(h.admin);
    // Device two then saves a new sign-off from the same, now stale, revision.
    const two = await send(owner(), h.seed.a, { revision: read, changeId: randomUUID(), ...FULL, signoff: 'Robin Example' });
    expect(two.status).toBe(409);
    expect(two.body).toEqual({ error: 'stale_revision', profile: one.body });
    expect(await everything(h.admin)).toBe(before);
    expect(await rowOf(h.seed.a)).toMatchObject({ profile_phone: '(555) 010-0199', profile_signoff: FULL.signoff });
  });

  it('answers 200 with the current revision to a retry of a save whose answer was lost', async () => {
    const body = { revision: await revisionNow(h.seed.a), changeId: randomUUID(), ...FULL };
    const first = await send(owner(), h.seed.a, body);
    expect(first.status).toBe(200);
    const retry = await send(owner(), h.seed.a, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    expect(await audits()).toHaveLength(1);
  });

  it('answers 200 to a stale save that asks for exactly what is stored', async () => {
    const read = await revisionNow(h.seed.a);
    const saved = await put(owner(), h.seed.a, FULL);
    const same = await send(owner(), h.seed.a, { revision: read, changeId: randomUUID(), ...FULL });
    expect(same.status).toBe(200);
    expect(same.body).toEqual(saved.body);
  });
});

describe('a refused request writes nothing', () => {
  it.each([
    ['an estimator', estimator],
    ['an office user', office],
  ])('%s cannot save the profile, and is refused before the body is read', async (_who, claims) => {
    const before = await everything(h.admin);
    // A valid body and a body that would be a 400: both are the same 403, so the role check comes first.
    expect(await put(claims, h.seed.a, FULL)).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await put(claims, h.seed.a, { nonsense: true })).toMatchObject({ status: 403, body: { error: 'not_allowed' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('another company’s owner cannot save the profile of this company, and nothing of either changes', async () => {
    const before = await everything(h.admin);
    expect(await put(ownerB, h.seed.a, FULL)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await put(owner(), h.seed.b, FULL)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('a signed-out caller cannot save the profile', async () => {
    const before = await everything(h.admin);
    expect((await put(null, h.seed.a, FULL)).status).toBe(401);
    expect(await everything(h.admin)).toBe(before);
  });

  it('an owner saving their own company changes no other company', async () => {
    const otherBefore = await rowOf(h.seed.b);
    await put(owner(), h.seed.a, FULL);
    expect(await rowOf(h.seed.b)).toEqual(otherBefore);
    await put(ownerB, h.seed.b, { ...FULL, signoff: 'Robin Other' });
    expect((await rowOf(h.seed.a)).profile_signoff).toBe('Pat Example');
    expect((await rowOf(h.seed.b)).profile_signoff).toBe('Robin Other');
  });

  it.each([
    ['a body that names another field', { ...FULL, name: 'Renamed Co' }],
    ['a body that names the company’s status', { ...FULL, status: 'suspended' }],
    ['a missing field', { address: FULL.address }],
    ['a bad email', { ...FULL, email: 'not-an-email' }],
    ['a control character in the address', { ...FULL, address: 'one\ntwo' }],
    ['an over-long sign-off', { ...FULL, signoff: 'x'.repeat(151) }],
    ['a field that is not text', { ...FULL, license: 123456 }],
    ['an array', []],
  ])('answers 400 to %s and writes nothing', async (_what, body) => {
    const before = await everything(h.admin);
    expect(await put(owner(), h.seed.a, body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it.each([
    ['no revision', { changeId: randomUUID(), ...FULL }],
    ['no change id', { revision: '2026-01-01T00:00:00.000000Z', ...FULL }],
    ['a revision of another shape', { revision: '2026-01-01T00:00:00Z', changeId: randomUUID(), ...FULL }],
    ['a change id that is not a uuid', { revision: '2026-01-01T00:00:00.000000Z', changeId: 'change-1', ...FULL }],
  ])('answers 400 to a body with %s and writes nothing', async (_what, body) => {
    const before = await everything(h.admin);
    expect(await send(owner(), h.seed.a, body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    expect(await everything(h.admin)).toBe(before);
  });

  it('answers 400 to a body that is not JSON', async () => {
    const response = await saveProfile(
      request(owner(), `/api/companies/${h.seed.a}/profile`, { method: 'PUT', body: '{not json' }),
      params({ companyId: h.seed.a }),
    );
    expect(response.status).toBe(400);
  });
});
