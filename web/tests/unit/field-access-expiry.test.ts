import { afterEach, describe, expect, it, vi } from 'vitest';
import { fieldAccessExpiry } from '@/lib/projection/expiry';

// S6-3: GET /api/me returns when the member's field access record stops working, so the phone's
// sync gate can wait for a renewal that was skipped. No uid or email goes into the answer or a log.
const A = '00000000-0000-4000-8000-00000000000a';

const identityServices = () => ({
  verifier: {
    async verify() {
      return { uid: 'uid-a', tenant: 'tenant-a', emailVerified: true };
    },
    async verifyNotRevoked() {
      return { uid: 'uid-a', tenant: 'tenant-a', emailVerified: true, authTime: Math.floor(Date.now() / 1000) - 60, secondFactor: null };
    },
  },
  directory: {
    async companyForTenant() {
      return A;
    },
    async member() {
      return {
        company: { id: A, name: 'Company a', status: 'active' as const },
        actor: { id: 'actor-a', displayName: null },
        membership: { role: 'estimator' as const, status: 'active' as const },
      };
    },
  },
});

const signedIn = () => new Request('http://localhost/api/me', { headers: { Authorization: 'Bearer a.b.c' } });

describe('the field access expiry on GET /api/me', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('@/lib/auth/services');
    vi.doUnmock('@/lib/projection/services');
    vi.doUnmock('@/lib/projection/expiry');
    vi.resetModules();
  });

  it('is read after the renewal, for the signed-in member, and returned as a time', async () => {
    vi.resetModules();
    const order: string[] = [];
    const renew = vi.fn(async () => void order.push('renew'));
    const expiry = vi.fn(async () => {
      order.push('expiry');
      return new Date(Date.UTC(2031, 0, 2, 3, 4, 5));
    });
    vi.doMock('@/lib/projection/services', () => ({ renewSignedInAccess: renew }));
    vi.doMock('@/lib/projection/expiry', () => ({ fieldAccessExpiry: expiry }));
    vi.doMock('@/lib/auth/services', () => ({ identityServices }));
    const { GET } = await import('@/app/api/me/route');
    const res = await GET(signedIn(), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fieldAccessExpiresAt).toBe('2031-01-02T03:04:05.000Z');
    expect(order).toEqual(['renew', 'expiry']);
    expect(expiry).toHaveBeenCalledWith(expect.objectContaining({ companyId: A, uid: 'uid-a' }));
    // Still no uid or email in the answer.
    expect(JSON.stringify(body)).not.toContain('uid-a');
  });

  it('is null when there is no record', async () => {
    vi.resetModules();
    vi.doMock('@/lib/projection/services', () => ({ renewSignedInAccess: async () => {} }));
    vi.doMock('@/lib/projection/expiry', () => ({ fieldAccessExpiry: async () => null }));
    vi.doMock('@/lib/auth/services', () => ({ identityServices }));
    const { GET } = await import('@/app/api/me/route');
    const body = await (await GET(signedIn(), { params: Promise.resolve({}) })).json();
    expect(body).toHaveProperty('fieldAccessExpiresAt', null);
  });

  it('never fails the request when the record cannot be read, and logs fixed text only', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = () => ({
      async expiry(): Promise<Date | null> {
        throw new Error('read failed for uid-a at companies/a/access/uid-a');
      },
    });
    await expect(fieldAccessExpiry({ companyId: A, uid: 'uid-a' }, reader)).resolves.toBeNull();
    expect(errors).toHaveBeenCalledWith('access expiry unavailable', 'Error');
    expect(JSON.stringify(errors.mock.calls)).not.toContain('uid-a');
  });

  it('reads the store it is given', async () => {
    const at = new Date(Date.now() + 60_000);
    const seen: string[] = [];
    const reader = () => ({
      async expiry(companyId: string, uid: string) {
        seen.push(`${companyId}/${uid}`);
        return at;
      },
    });
    expect(await fieldAccessExpiry({ companyId: A, uid: 'uid-a' }, reader)).toEqual(at);
    expect(seen).toEqual([`${A}/uid-a`]);
  });
});
