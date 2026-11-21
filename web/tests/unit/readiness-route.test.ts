import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_DETAILS, FEATURE_FLAG_NAMES, FLAG_NAMES, flagsFromRows } from '@/lib/flags';
import { readinessMarker } from '@/lib/readiness/marker';
import { readinessAnswerSchema } from '@/lib/readiness/schema';
import { IdentityRefusal, type IdentityDirectory, type MemberRecord, type TokenVerifier } from '@/lib/auth';

// S5b-11 slice 11A outside the database: the default-off `readiness` switch, its exposure in /api/me,
// the route's own request checks, and the jobs list marker's rule for a current answer.

const JOB = '5d0f3c1a-8b2e-4f6a-9c7d-1e2b3a4c5d6e';
const DRAFT = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const A = '00000000-0000-4000-8000-00000000000a';

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

// A verifier that trusts the test's claims (tests/unit/identity.test.ts covers the refusals), and one
// company with the given stored flag rows, as in tests/unit/flags.test.ts.
const verifier: TokenVerifier = {
  async verify(idToken) {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, string>;
    return { uid: claims.sub!, tenant: claims.tenant ?? null, emailVerified: true };
  },
  async verifyNotRevoked(idToken, tenant) {
    const found = await this.verify(idToken);
    if (found.tenant !== tenant) throw new IdentityRefusal('invalid_token');
    return { ...found, authTime: Math.floor(Date.now() / 1000) - 60, secondFactor: 'totp' };
  },
};

const directory = (flags: MemberRecord['flags']): IdentityDirectory => ({
  companyForTenant: async (tenant) => (tenant === 'tenant-a' ? A : null),
  member: async (companyId) => ({
    company: { id: companyId, name: 'Company', status: 'active' },
    actor: { id: 'actor-a', displayName: null },
    membership: { role: 'estimator', status: 'active' },
    flags,
  }),
});

const signedIn = () => new Request('http://localhost/api/me', { headers: { Authorization: `Bearer ${token({ sub: 'uid-a', tenant: 'tenant-a' })}` } });

const checked = (extra: Record<string, unknown> = {}) => ({
  status: 'checked',
  jobId: JOB,
  draftId: DRAFT,
  jobRevision: 3,
  fieldSha256: 'a'.repeat(64),
  ready: false,
  gaps: [{ code: 'yearBuilt' }, { code: 'shot:meter', roomId: 'room-1', count: 1 }],
  unavailable: ['ocr'],
  ...extra,
});

describe('the readiness switch', () => {
  it('is a known flag, off unless stored exactly on, with an owner, a purpose and a review date', () => {
    expect(FLAG_NAMES).toContain('readiness');
    expect(FEATURE_FLAG_NAMES).toEqual(['readiness', 'priced_extras', 'drying_watch', 'estimate_assist']);
    expect(flagsFromRows([]).readiness).toBe(false);
    expect(flagsFromRows([{ flag: 'readiness', enabled: 'true' as unknown as boolean }]).readiness).toBe(false);
    expect(flagsFromRows([{ flag: 'readiness', enabled: true }]).readiness).toBe(true);
    const { owner, purpose, removeBy } = FEATURE_FLAG_DETAILS.readiness;
    expect(owner.trim().length).toBeGreaterThan(0);
    expect(purpose).toMatch(/never blocks Finish or Submit/);
    expect(new Date(`${removeBy}T00:00:00Z`).toISOString().slice(0, 10)).toBe(removeBy);
  });

  it('registers the priced_extras switch with the same owner and review date as readiness', () => {
    expect(Object.keys(FEATURE_FLAG_DETAILS).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
    expect(FLAG_NAMES.filter((n) => n === 'priced_extras')).toHaveLength(1);
    expect(FEATURE_FLAG_DETAILS.priced_extras.owner).toBe(FEATURE_FLAG_DETAILS.readiness.owner);
    expect(FEATURE_FLAG_DETAILS.priced_extras.removeBy).toBe(FEATURE_FLAG_DETAILS.readiness.removeBy);
    expect(FEATURE_FLAG_DETAILS.priced_extras.purpose).toBe('owner approvals for extras and named adjustments priced on a job');
  });
});

describe('/api/me', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });

  it('tells the screens whether readiness is on for the company, and nothing of the other switches', async () => {
    for (const [rows, expected] of [
      [[{ flag: 'readiness', enabled: true }], true],
      [[{ flag: 'readiness', enabled: false }, { flag: 'price_books', enabled: true }], false],
      [[], false],
    ] as const) {
      vi.resetModules();
      vi.doMock('@/lib/auth/services', () => ({ identityServices: () => ({ verifier, directory: directory([...rows]) }) }));
      const { GET } = await import('@/app/api/me/route');
      const res = await GET(signedIn(), { params: Promise.resolve({}) });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { features: unknown };
      expect(body.features).toEqual({ readiness: expected, drying_watch: false, estimate_assist: false });
    }
  });
});

describe('GET /api/jobs/{jobId}/readiness request checks', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/readiness/services');
    vi.resetModules();
  });

  it('refuses a query and a path that is not a job id before the check runs', async () => {
    const read = vi.fn(async () => checked());
    vi.resetModules();
    vi.doMock('@/lib/readiness/services', () => ({ readinessServices: () => ({ read }) }));
    const { readReadiness } = await import('@/lib/readiness/http');
    const identity = {} as Parameters<typeof readReadiness>[1];
    const call = (path: string, jobId: string) => readReadiness(new Request(`http://localhost${path}`), identity, { params: Promise.resolve({ jobId }) });
    const query = await call(`/api/jobs/${JOB}/readiness?draftId=${DRAFT}`, JOB);
    expect(query.status).toBe(400);
    expect(await query.json()).toEqual({ error: 'invalid_request' });
    const bad = await call('/api/jobs/current/readiness', 'current');
    expect(bad.status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    const ok = await call(`/api/jobs/${JOB.toUpperCase()}/readiness`, JOB.toUpperCase());
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(read).toHaveBeenCalledWith(identity, JOB);
    expect(readinessAnswerSchema.safeParse(await ok.json()).success).toBe(true);
  });

  it('answers 503 with fixed text when the check fails outright', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('@/lib/readiness/services', () => ({
      readinessServices: () => ({
        read: async () => {
          throw new Error('connection to 10.0.0.1 failed for 1 Secret Street');
        },
      }),
    }));
    const { readReadiness } = await import('@/lib/readiness/http');
    const res = await readReadiness(new Request(`http://localhost/api/jobs/${JOB}/readiness`), {} as never, { params: Promise.resolve({ jobId: JOB }) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'readiness_unavailable' });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('Secret Street');
    errors.mockRestore();
  });
});

describe('the jobs list marker', () => {
  const row = { id: JOB, status: 'draft', revision: 3 };
  const scope = ['jobs_read', 'scope'];

  it('shows a count, or ready, only for a current answer about that editing row, to the owner or the estimator', () => {
    expect(readinessMarker(row, checked(), scope)).toEqual({ kind: 'gaps', count: 2 });
    expect(readinessMarker(row, checked({ gaps: [], ready: true }), scope)).toEqual({ kind: 'ready' });
    // Office holds no scope; a row that is not an editing draft has no marker.
    expect(readinessMarker(row, checked(), ['jobs_read', 'coordination'])).toBeNull();
    expect(readinessMarker({ ...row, status: 'submitted' }, checked(), scope)).toBeNull();
    // An answer about another job, or another revision of this one, is not current for the row.
    expect(readinessMarker(row, checked({ jobId: DRAFT }), scope)).toBeNull();
    expect(readinessMarker({ ...row, revision: 4 }, checked(), scope)).toBeNull();
    // No answer, one of another shape, or one that says the check was unavailable.
    expect(readinessMarker(row, undefined, scope)).toBeNull();
    expect(readinessMarker(row, { error: 'readiness_unavailable' }, scope)).toBeNull();
    expect(readinessMarker(row, checked({ extra: 1 }), scope)).toBeNull();
    expect(readinessMarker(row, { status: 'unavailable', jobId: JOB, reason: 'field_unavailable' }, scope)).toBeNull();
  });

  it('shows no marker for an answer with no gap that is not ready, a check it could not run being no pass', () => {
    expect(readinessMarker(row, checked({ gaps: [], ready: false, unavailable: ['setupReadings', 'ocr'] }), scope)).toBeNull();
  });

  it('takes any uuid-shaped job id the jobs API takes, not only an RFC 4122 one', () => {
    const id = '00000000-0000-0000-0000-000000000001';
    expect(readinessMarker({ ...row, id }, checked({ jobId: id, draftId: id }), scope)).toEqual({ kind: 'gaps', count: 2 });
    // The route answers with the lowercased id, so an uppercase one is not its answer.
    expect(readinessAnswerSchema.safeParse(checked({ jobId: JOB.toUpperCase() })).success).toBe(false);
  });
});
