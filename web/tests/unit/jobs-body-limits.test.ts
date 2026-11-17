import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@/lib/auth';
import { claimBody, customerBody } from '@/lib/jobs/schema';
import { profileInput } from '@/lib/profile/schema';

// Security audit F2: an over-long email must not reach the address pattern, whose cost grows with
// the square of the length for a crafted value, and a jobs body over the cap is refused before it
// is parsed. tests/db/jobs-api.test.ts drives the same routes against Postgres.

const saved = vi.fn(async () => ({ saved: true }));
vi.mock('@/lib/jobs/services', () => ({
  jobsServices: () => ({ saveCustomer: saved, saveClaim: saved, saveCoordination: saved }),
}));
const { saveClaim, saveCoordination, saveCustomer } = await import('@/lib/jobs/http');

const JOB_ID = '3e9a7c52-8b14-4f06-9d2a-6c1b5e8f0a37';
const CHANGE_ID = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
const identity = { companyId: 'c', actorId: 'a' } as unknown as Identity;
const context = { params: Promise.resolve({ jobId: JOB_ID }) };

// The report's slow value: a@, a long run of dots, then one refused character.
const CRAFTED = `a@${'.'.repeat(64_000)}<`;

const CUSTOMER = { revision: 1, changeId: CHANGE_ID, name: 'Pat Example', phone: '', email: 'pat@example.test', propertyAddress: '' };
const CLAIM = {
  revision: 1,
  changeId: CHANGE_ID,
  carrier: '',
  claimNumber: '',
  policyNumber: '',
  dateOfLoss: null,
  lossCause: '',
  adjusterName: '',
  adjusterEmail: 'adjuster@example.test',
  adjusterPhone: '',
  deductible: '',
};
const PROFILE = {
  revision: '2026-11-13T10:20:30.123456Z',
  changeId: CHANGE_ID,
  address: '',
  phone: '',
  email: 'office@example.test',
  license: '',
  signoff: '',
};

function timed(run: () => boolean): { ok: boolean; ms: number } {
  const start = performance.now();
  const ok = run();
  return { ok, ms: performance.now() - start };
}

// A 254-character address (the longest allowed) and one a character longer.
const LONGEST = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;

describe('the email check (audit F2)', () => {
  it.each([
    ['the customer email', () => customerBody.safeParse({ ...CUSTOMER, email: CRAFTED }).success],
    ['the adjuster email', () => claimBody.safeParse({ ...CLAIM, adjusterEmail: CRAFTED }).success],
    ['the company profile email', () => profileInput.safeParse({ ...PROFILE, email: CRAFTED }).success],
  ])('refuses %s of a@, 64,000 dots and < in well under 50 ms', (_name, run) => {
    const { ok, ms } = timed(run);
    expect(ok).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it('still accepts an address of 254 characters and refuses one of 255', () => {
    expect(LONGEST).toHaveLength(254);
    for (const schema of [customerBody, profileInput]) {
      const base = schema === customerBody ? CUSTOMER : PROFILE;
      expect(schema.safeParse({ ...base, email: LONGEST }).success).toBe(true);
      expect(schema.safeParse({ ...base, email: `a${LONGEST}` }).success).toBe(false);
    }
    expect(claimBody.safeParse({ ...CLAIM, adjusterEmail: LONGEST }).success).toBe(true);
    expect(claimBody.safeParse({ ...CLAIM, adjusterEmail: `a${LONGEST}` }).success).toBe(false);
  });

  it.each(['', 'pat@example.test', '  Pat@Example.Test  ', "o'brien+jobs@mail.example.co"])('accepts %j as before', (email) => {
    expect(customerBody.safeParse({ ...CUSTOMER, email }).success).toBe(true);
    expect(claimBody.safeParse({ ...CLAIM, adjusterEmail: email }).success).toBe(true);
    expect(profileInput.safeParse({ ...PROFILE, email }).success).toBe(true);
  });

  it.each(['pat', 'pat@example', '@example.test', 'pat@@example.test', 'pat @example.test', 'pat@exa<mple.test'])('refuses %j as before', (email) => {
    expect(customerBody.safeParse({ ...CUSTOMER, email }).success).toBe(false);
    expect(claimBody.safeParse({ ...CLAIM, adjusterEmail: email }).success).toBe(false);
    expect(profileInput.safeParse({ ...PROFILE, email }).success).toBe(false);
  });
});

function put(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/jobs/${JOB_ID}/customer`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('the jobs body cap (audit F2)', () => {
  afterEach(() => {
    saved.mockClear();
    vi.restoreAllMocks();
  });

  it('refuses a valid customer body padded past the cap with 400, before parsing it or calling the service', async () => {
    const parse = vi.spyOn(customerBody, 'safeParse');
    const padded = `${JSON.stringify(CUSTOMER).slice(0, -1)}${' '.repeat(40_000)}}`;
    expect(JSON.parse(padded)).toEqual(CUSTOMER);
    const res = await saveCustomer(put(padded), identity, context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(parse).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });

  it('refuses a claim body that declares a length over the cap, without calling the service', async () => {
    const res = await saveClaim(put(JSON.stringify(CLAIM), { 'content-length': '100000' }), identity, context);
    expect(res.status).toBe(400);
    expect(saved).not.toHaveBeenCalled();
  });

  it('refuses the crafted customer email with 400 in well under 50 ms', async () => {
    const start = performance.now();
    const res = await saveCustomer(put(JSON.stringify({ ...CUSTOMER, email: CRAFTED })), identity, context);
    expect(performance.now() - start).toBeLessThan(50);
    expect(res.status).toBe(400);
    expect(saved).not.toHaveBeenCalled();
  });

  it('still takes the same customer body without the padding', async () => {
    const res = await saveCustomer(put(JSON.stringify(CUSTOMER)), identity, context);
    expect(res.status).toBe(200);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('still takes the largest valid jobs body: a 4,000-character office note written as escapes', async () => {
    const accented = String.fromCharCode(0xe9);
    const notes = accented.repeat(4000);
    const text = JSON.stringify({ revision: 0, changeId: CHANGE_ID, notes }).split(accented).join('\\u00e9');
    expect(text.length).toBeGreaterThan(24_000);
    const res = await saveCoordination(put(text), identity, context);
    expect(res.status).toBe(200);
    expect(saved).toHaveBeenCalledTimes(1);
  });
});
