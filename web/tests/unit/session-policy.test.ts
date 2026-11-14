import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTED_SECOND_FACTORS,
  FRESH_SIGN_IN_SECONDS,
  IdentityRefusal,
  memberRoute,
  REFUSALS,
  resolveIdentity,
  SESSION_RULES,
  sessionRefusal,
  type IdentityDirectory,
  type RouteSessionRule,
  type TokenVerifier,
} from '@/lib/auth';
import { ROLES, type Role } from '@/lib/access';

// The second-step and session rules (src/lib/auth/policy.ts), from owner decisions D1, D2, D7
// and D8. The real authenticator-app step cannot be produced by the Auth emulator, so the rule is
// proved here on token claims and in tests/emu/identity.test.ts on real emulator tokens.

const COMPANY = '00000000-0000-4000-8000-00000000000a';
const NOW = 1_800_000_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Claims = { role: Role; authTime?: number | null; secondFactor?: string | null };

// A token naming its role and session claims; the fake verifier reads them back.
function token(claims: Claims): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}
const read = (idToken: string) => JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Claims;

const verifier: TokenVerifier = {
  async verify(idToken) {
    return { uid: `uid-${read(idToken).role}`, tenant: 'tenant-a', emailVerified: true };
  },
  async verifyNotRevoked(idToken, tenant) {
    const claims = read(idToken);
    return {
      uid: `uid-${claims.role}`,
      tenant,
      emailVerified: true,
      authTime: claims.authTime === undefined ? NOW - MINUTE : claims.authTime,
      secondFactor: claims.secondFactor ?? null,
    };
  },
};

const directory: IdentityDirectory = {
  async companyForTenant() {
    return COMPANY;
  },
  async member(companyId, _tenant, uid) {
    return {
      company: { id: companyId, name: 'Synthetic company', status: 'active' },
      actor: { id: 'actor-a', displayName: null },
      membership: { role: uid.slice('uid-'.length) as Role, status: 'active' },
      flags: [],
    };
  },
};

const request = (claims: Claims) =>
  new Request('http://localhost/api/anything', { headers: { Authorization: `Bearer ${token(claims)}` } });

async function outcome(claims: Claims, route: RouteSessionRule = {}): Promise<string> {
  try {
    const identity = await resolveIdentity(request(claims), verifier, directory, { route, now: () => NOW });
    return `ok:${identity.role}`;
  } catch (error) {
    if (error instanceof IdentityRefusal) return error.code;
    throw error;
  }
}

// Every kind of route: an ordinary member route, a team or second-step change, and enrolment.
const ROUTES: [string, RouteSessionRule][] = [
  ['an ordinary member route', {}],
  ['a team change', { freshSignIn: true }],
  ['a fresh enrolment route', { secondStep: 'enrolment', freshSignIn: true }],
  ['enrolment', { secondStep: 'enrolment' }],
];

describe('the session rules match the owner decisions', () => {
  it('second step: owners, office and the operator must use it, estimators opt in (D2 as changed 2026-11-14, D6)', () => {
    expect(SESSION_RULES.owner.secondStepRequired).toBe(true);
    expect(SESSION_RULES.operator.secondStepRequired).toBe(true);
    expect(SESSION_RULES.office.secondStepRequired).toBe(true);
    expect(SESSION_RULES.estimator.secondStepRequired).toBe(false);
  });

  it('sign in again: operator 12 hours, owner and office 14 days, estimator 30 days, 15 minutes for changes (D7)', () => {
    expect(SESSION_RULES.operator.maxSignInAgeSeconds).toBe(12 * HOUR);
    expect(SESSION_RULES.owner.maxSignInAgeSeconds).toBe(14 * DAY);
    expect(SESSION_RULES.office.maxSignInAgeSeconds).toBe(14 * DAY);
    expect(SESSION_RULES.estimator.maxSignInAgeSeconds).toBe(30 * DAY);
    expect(FRESH_SIGN_IN_SECONDS).toBe(15 * MINUTE);
  });

  it('covers every company role, and cannot be changed at run time', () => {
    for (const role of ROLES) expect(SESSION_RULES[role]).toBeDefined();
    expect(Object.isFrozen(SESSION_RULES)).toBe(true);
    expect(Object.isFrozen(SESSION_RULES.owner)).toBe(true);
    expect(() => {
      (SESSION_RULES.owner as { secondStepRequired: boolean }).secondStepRequired = false;
    }).toThrow(TypeError);
  });

  it('answers with fixed codes: 403 for a missing second step, 401 to sign in again', () => {
    expect(REFUSALS.second_step_required).toBe(403);
    expect(REFUSALS.sign_in_again).toBe(401);
  });
});

describe('second step', () => {
  it.each(ROUTES.filter(([, route]) => route.secondStep !== 'enrolment'))(
    'refuses an owner token without a second factor on %s',
    async (_name, route) => {
      expect(await outcome({ role: 'owner' }, route)).toBe('second_step_required');
      expect(await outcome({ role: 'owner', secondFactor: null }, route)).toBe('second_step_required');
    },
  );

  it('lets an owner with no second step reach only enrolment, and only with a valid recent sign-in', async () => {
    expect(await outcome({ role: 'owner' }, { secondStep: 'enrolment' })).toBe('ok:owner');
    expect(await outcome({ role: 'owner', authTime: NOW - 14 * DAY - 1 }, { secondStep: 'enrolment' })).toBe('sign_in_again');
    expect(await outcome({ role: 'owner', authTime: null }, { secondStep: 'enrolment' })).toBe('invalid_token');
  });

  it.each(ROUTES)('accepts an owner who used an authenticator app on %s', async (_name, route) => {
    expect(await outcome({ role: 'owner', secondFactor: 'totp' }, route)).toBe('ok:owner');
  });

  it('accepts only the authenticator app: a text message, email or anything else is not a second step', async () => {
    expect(ACCEPTED_SECOND_FACTORS).toEqual(['totp']);
    for (const secondFactor of ['phone', 'email', 'TOTP', 'totp ', '', 'password']) {
      expect(await outcome({ role: 'owner', secondFactor })).toBe('second_step_required');
    }
  });

  it('lets an estimator sign in without a second step (opt in, D2)', async () => {
    expect(await outcome({ role: 'estimator' })).toBe('ok:estimator');
    expect(await outcome({ role: 'estimator', secondFactor: 'totp' })).toBe('ok:estimator');
  });

  // Office users see every job of the company, so since 2026-11-14 they need the second step too.
  it.each(ROUTES.filter(([, route]) => route.secondStep !== 'enrolment'))(
    'refuses an office token without a second factor on %s',
    async (_name, route) => {
      expect(await outcome({ role: 'office' }, route)).toBe('second_step_required');
      expect(await outcome({ role: 'office', secondFactor: 'phone' }, route)).toBe('second_step_required');
    },
  );

  it.each(ROUTES)('accepts an office user who used an authenticator app on %s', async (_name, route) => {
    expect(await outcome({ role: 'office', secondFactor: 'totp' }, route)).toBe('ok:office');
  });

  it('lets an office user with no second step reach only enrolment', async () => {
    expect(await outcome({ role: 'office' }, { secondStep: 'enrolment' })).toBe('ok:office');
    expect(await outcome({ role: 'office', authTime: NOW - 14 * DAY - 1 }, { secondStep: 'enrolment' })).toBe('sign_in_again');
  });

  it('requires it for the operator too (D6)', () => {
    expect(sessionRefusal('operator', { authTime: NOW, secondFactor: null }, {}, NOW)).toBe('second_step_required');
    expect(sessionRefusal('operator', { authTime: NOW, secondFactor: 'totp' }, {}, NOW)).toBeNull();
  });
});

describe('sign-in age', () => {
  it.each([
    ['owner', 14 * DAY],
    ['office', 14 * DAY],
    ['estimator', 30 * DAY],
  ] as const)('asks %s to sign in again once the sign-in is older than its limit', async (role, limit) => {
    const secondFactor = 'totp';
    expect(await outcome({ role, secondFactor, authTime: NOW - limit })).toBe(`ok:${role}`);
    expect(await outcome({ role, secondFactor, authTime: NOW - limit - 1 })).toBe('sign_in_again');
    expect(await outcome({ role, secondFactor, authTime: NOW - 400 * DAY })).toBe('sign_in_again');
  });

  it('asks the operator to sign in again after 12 hours', () => {
    const claims = (age: number) => ({ authTime: NOW - age, secondFactor: 'totp' });
    expect(sessionRefusal('operator', claims(12 * HOUR), {}, NOW)).toBeNull();
    expect(sessionRefusal('operator', claims(12 * HOUR + 1), {}, NOW)).toBe('sign_in_again');
  });

  it('asks an old sign-in to sign in again before asking for a second step', async () => {
    expect(await outcome({ role: 'owner', authTime: NOW - 15 * DAY })).toBe('sign_in_again');
  });

  it.each([
    ['missing', null],
    ['zero', 0],
    ['negative', -5],
    ['not a whole number', NOW - 0.5],
    ['more than five minutes ahead of the server clock', NOW + 5 * MINUTE + 1],
  ])('refuses a token whose sign-in time is %s', async (_name, authTime) => {
    expect(await outcome({ role: 'estimator', authTime })).toBe('invalid_token');
  });

  it('tolerates a sign-in time a little ahead of the server clock', async () => {
    expect(await outcome({ role: 'estimator', authTime: NOW + 5 * MINUTE })).toBe('ok:estimator');
  });
});

describe('fresh sign-in for team and second-step changes', () => {
  it.each(ROLES)('refuses a team change by %s with a sign-in older than 15 minutes', async (role) => {
    const teamChange = { freshSignIn: true };
    const secondFactor = 'totp';
    expect(await outcome({ role, secondFactor, authTime: NOW - 15 * MINUTE }, teamChange)).toBe(`ok:${role}`);
    expect(await outcome({ role, secondFactor, authTime: NOW - 15 * MINUTE - 1 }, teamChange)).toBe('sign_in_again');
    // The same sign-in is still good for ordinary routes.
    expect(await outcome({ role, secondFactor, authTime: NOW - 15 * MINUTE - 1 })).toBe(`ok:${role}`);
  });

  it('applies to a second-step change on the enrolment route when it says so', async () => {
    const change = { secondStep: 'enrolment' as const, freshSignIn: true };
    expect(await outcome({ role: 'owner', secondFactor: 'totp', authTime: NOW - HOUR }, change)).toBe('sign_in_again');
    expect(await outcome({ role: 'owner', authTime: NOW - HOUR }, change)).toBe('sign_in_again');
  });
});

describe('member routes', () => {
  const services = () => ({ verifier, directory });
  const context = { params: Promise.resolve({}) };
  const realNow = Date.now;
  afterEach(() => {
    Date.now = realNow;
  });

  it('refuses an owner without a second step before the handler runs, with only a code', async () => {
    const handler = vi.fn(() => Response.json({}));
    const res = await memberRoute(handler, {}, services)(request({ role: 'owner', authTime: Math.floor(Date.now() / 1000) }), context);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'second_step_required' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a team change with a stale sign-in, and lets a fresh one through', async () => {
    const now = Math.floor(Date.now() / 1000);
    const handler = vi.fn(() => Response.json({ changed: true }));
    const GET = memberRoute(handler, { freshSignIn: true }, services);
    const stale = await GET(request({ role: 'owner', secondFactor: 'totp', authTime: now - HOUR }), context);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'sign_in_again' });
    expect(handler).not.toHaveBeenCalled();
    const fresh = await GET(request({ role: 'owner', secondFactor: 'totp', authTime: now - MINUTE }), context);
    expect(fresh.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('keeps the rule a route declared even if the object passed in is changed later', async () => {
    const rule: RouteSessionRule = { freshSignIn: true };
    const GET = memberRoute(() => Response.json({}), rule, services);
    rule.freshSignIn = false;
    const now = Math.floor(Date.now() / 1000);
    const res = await GET(request({ role: 'owner', secondFactor: 'totp', authTime: now - HOUR }), context);
    expect(res.status).toBe(401);
  });

  it('uses the server clock: a sign-in that was fine becomes too old', async () => {
    const authTime = Math.floor(Date.now() / 1000);
    const GET = memberRoute(() => Response.json({}), {}, services);
    expect((await GET(request({ role: 'estimator', authTime }), context)).status).toBe(200);
    Date.now = () => (authTime + 30 * DAY + 1) * 1000;
    const res = await GET(request({ role: 'estimator', authTime }), context);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'sign_in_again' });
  });
});

describe('/api/me', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });

  it('refuses an owner without a second step, so the phone shows enrolment', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/services', () => ({ identityServices: () => ({ verifier, directory }) }));
    const { GET } = await import('@/app/api/me/route');
    const now = Math.floor(Date.now() / 1000);
    const res = await GET(request({ role: 'owner', authTime: now }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'second_step_required' });
    const ok = await GET(request({ role: 'owner', authTime: now, secondFactor: 'totp' }), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
  });

  it('refuses an office user without a second step, so the phone shows enrolment', async () => {
    vi.resetModules();
    vi.doMock('@/lib/auth/services', () => ({ identityServices: () => ({ verifier, directory }) }));
    const { GET } = await import('@/app/api/me/route');
    const now = Math.floor(Date.now() / 1000);
    const res = await GET(request({ role: 'office', authTime: now }), { params: Promise.resolve({}) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'second_step_required' });
    const ok = await GET(request({ role: 'office', authTime: now, secondFactor: 'totp' }), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
  });
});

describe('no setting widens the accepted second factors', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it('refuses a text-message owner in every environment, whatever the environment says', async () => {
    for (const appEnv of ['local', 'test', 'live']) {
      process.env = {
        ...saved,
        APP_ENV: appEnv,
        APP_ENVIRONMENT: appEnv,
        ACCEPTED_SECOND_FACTORS: 'totp,phone',
        SECOND_FACTORS: 'phone',
        MFA_FACTORS: 'phone',
        ALLOW_SMS_SECOND_FACTOR: 'true',
        SECOND_STEP_REQUIRED: 'false',
        SESSION_MAX_AGE_SECONDS: String(400 * DAY),
      };
      vi.resetModules();
      const fresh = await import('@/lib/auth/policy');
      expect(fresh.ACCEPTED_SECOND_FACTORS).toEqual(['totp']);
      expect(fresh.sessionRefusal('owner', { authTime: NOW, secondFactor: 'phone' }, {}, NOW)).toBe('second_step_required');
      expect(fresh.sessionRefusal('owner', { authTime: NOW, secondFactor: null }, {}, NOW)).toBe('second_step_required');
      expect(fresh.sessionRefusal('estimator', { authTime: NOW - 31 * DAY, secondFactor: null }, {}, NOW)).toBe(
        'sign_in_again',
      );
    }
  });

  it('the accepted list cannot be widened at run time either', () => {
    expect(Object.isFrozen(ACCEPTED_SECOND_FACTORS)).toBe(true);
    expect(() => (ACCEPTED_SECOND_FACTORS as string[]).push('phone')).toThrow(TypeError);
  });
});
