import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLIENT_EPOCH, CLIENT_EPOCH_HEADER } from '@/lib/app-version';
import { fullTeam, operatorCall, platformPaths } from '@/lib/operator/client';
import {
  endsOperatorSession,
  isOperatorTenantId,
  isSignInAgainCode,
  operatorCheck,
  operatorErrorMessage,
  operatorSignInErrorMessage,
  statusActions,
} from '@/lib/operator/screens';
import { PLATFORM_ERRORS } from '@/lib/platform';
import { isSignInAddress } from '@/lib/sign-in/directory';
import { localOperatorDirectory, type LocalSignInFixture } from '@/lib/sign-in/local-directory';

// What the platform operator's screens decide (S3-15) and how they call the operator routes. The
// screens themselves are driven in tests/e2e/operator.spec.ts.

const ID = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
const OTHER = '1c6b2d2f-8e3a-4d9f-8b7c-4a5f6e7d8c9b';

describe('the operator sign-in tenant in the address', () => {
  it.each(['Operators-x1y2', 'a', 'test-operators-0123456789'])('accepts %s', (value) => {
    expect(isOperatorTenantId(value)).toBe(true);
  });
  it.each(['', 'a b', 'a/b', '../me', 'a_b', 'é', 'a'.repeat(129), null, 3])('refuses %s', (value) => {
    expect(isOperatorTenantId(value)).toBe(false);
  });
});

describe('who the check says is signed in', () => {
  it('opens the screens for a 200 only', () => {
    expect(operatorCheck(200, null)).toEqual({ kind: 'operator' });
    for (const status of [201, 204, 302, 404, 500, 503, 0]) {
      expect(operatorCheck(status, null).kind).not.toBe('operator');
    }
    // Even a stray "operator-looking" code on a failed answer opens nothing.
    expect(operatorCheck(403, 'operator').kind).not.toBe('operator');
  });

  it.each([
    [403, 'not_an_operator', 'not-operator'],
    [403, 'no_tenant', 'not-operator'],
    [403, 'unknown_tenant', 'not-operator'],
    [403, 'account_disabled', 'not-operator'],
    [403, 'email_unverified', 'verify-email'],
    [403, 'second_step_required', 'second-step'],
    [401, 'sign_in_again', 'sign-in-again'],
    [401, 'sign_in_revoked', 'sign-in-again'],
    [401, 'invalid_token', 'sign-in-again'],
    [401, 'missing_token', 'sign-in-again'],
    [401, 'something_else', 'sign-in-again'],
    [403, 'something_else', 'unavailable'],
    [503, 'identity_unavailable', 'unavailable'],
    [0, 'unavailable', 'unavailable'],
  ])('%i %s is %s', (status, code, kind) => {
    expect(operatorCheck(status, code).kind).toBe(kind);
  });

  it('does not accept an inherited property name as a code', () => {
    expect(operatorCheck(403, 'constructor').kind).toBe('unavailable');
    expect(operatorCheck(403, '__proto__').kind).toBe('unavailable');
  });

  it('drops the sign-in from the phone only when it is not an operator’s or is out of date', () => {
    expect(endsOperatorSession(operatorCheck(403, 'not_an_operator'))).toBe(true);
    expect(endsOperatorSession(operatorCheck(401, 'sign_in_again'))).toBe(true);
    expect(endsOperatorSession(operatorCheck(403, 'second_step_required'))).toBe(false);
    expect(endsOperatorSession(operatorCheck(503, 'platform_unavailable'))).toBe(false);
  });

  it('knows which refusals only a new sign-in clears', () => {
    expect(isSignInAgainCode('sign_in_again')).toBe(true);
    expect(isSignInAgainCode('invalid_token')).toBe(true);
    expect(isSignInAgainCode('not_an_operator')).toBe(false);
    expect(isSignInAgainCode(null)).toBe(false);
  });
});

describe('status changes offered for a company', () => {
  const offered = (status: Parameters<typeof statusActions>[0]) => statusActions(status).map((action) => action.to);

  it('offers archive for a suspended company and for no other', () => {
    expect(offered('suspended')).toContain('archived');
    expect(offered('active')).not.toContain('archived');
    expect(offered('archived')).not.toContain('archived');
  });

  it('offers only what the server accepts', () => {
    expect(offered('active')).toEqual(['suspended']);
    expect(offered('suspended')).toEqual(['active', 'archived']);
    expect(offered('archived')).toEqual(['active']);
  });

  it('asks for a confirmation before suspending or archiving, not before reactivating', () => {
    const byTarget = (status: Parameters<typeof statusActions>[0], to: string) => statusActions(status).find((a) => a.to === to)!;
    expect(byTarget('active', 'suspended').confirm).toMatch(/turns off/);
    expect(byTarget('suspended', 'archived').confirm).toMatch(/closes/);
    expect(byTarget('suspended', 'active').confirm).toBeNull();
  });
});

describe('words for a refused action', () => {
  it('has specific words for every platform error the routes can answer', () => {
    const generic = operatorErrorMessage('a code nobody sent');
    for (const code of Object.keys(PLATFORM_ERRORS)) {
      expect(operatorErrorMessage(code), code).not.toBe(generic);
    }
    for (const code of ['invalid_request', 'identity_unavailable', 'platform_unavailable']) {
      expect(operatorErrorMessage(code), code).not.toBe(generic);
    }
  });

  it('never repeats the code it was given', () => {
    expect(operatorErrorMessage('owner@example.com')).not.toContain('owner@example.com');
    expect(operatorErrorMessage(null)).toBe(operatorErrorMessage('a code nobody sent'));
  });

  it('says what an operator’s failed sign-in means, from the Firebase code only', () => {
    expect(operatorSignInErrorMessage('auth/invalid-credential')).toBe('That email and password do not match a platform operator account.');
    expect(operatorSignInErrorMessage('auth/user-disabled')).toBe('This account is turned off.');
    expect(operatorSignInErrorMessage('auth/popup-closed-by-user')).toBeNull();
    expect(operatorSignInErrorMessage('auth/network-request-failed')).toBe('No connection. Check your signal, then try again.');
    expect(operatorSignInErrorMessage('whatever')).toBe('Sign-in did not work. Try again.');
    // Nothing in an operator's words talks about an invitation or a company.
    for (const code of ['auth/admin-restricted-operation', 'auth/operation-not-allowed', 'auth/invalid-credential']) {
      expect(operatorSignInErrorMessage(code)).not.toMatch(/invitation|owner of/i);
    }
  });

  it('checks a sign-in address as migration 0002 does', () => {
    expect(isSignInAddress('adr')).toBe(true);
    expect(isSignInAddress('Company')).toBe(false);
    expect(isSignInAddress('-a')).toBe(false);
    expect(isSignInAddress('')).toBe(false);
  });
});

describe('platform paths', () => {
  it('builds the operator route addresses from uuids only', () => {
    expect(platformPaths.companies()).toBe('/api/platform/companies');
    expect(platformPaths.status(ID)).toBe(`/api/platform/companies/${ID}/status`);
    expect(platformPaths.owner(ID)).toBe(`/api/platform/companies/${ID}/owner`);
    expect(platformPaths.team(ID.toUpperCase())).toBe(`/api/platform/companies/${ID}/team`);
    expect(platformPaths.resetSecondStep(ID, OTHER)).toBe(`/api/platform/companies/${ID}/members/${OTHER}/reset-second-step`);
  });

  it('refuses an id that is not a uuid, so a path cannot be bent', () => {
    expect(() => platformPaths.team('../../me')).toThrow();
    expect(() => platformPaths.status(`${ID}/../x`)).toThrow();
    expect(() => platformPaths.resetSecondStep(ID, '1')).toThrow();
  });
});

describe('operatorCall', () => {
  const user = { getIdToken: vi.fn(async () => 'token-value') };
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  afterEach(() => vi.unstubAllGlobals());

  it('sends the sign-in as a bearer header and nothing in the address', async () => {
    const fetchMock = reply(200, { companies: [] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await operatorCall(user, '/api/platform/companies');
    expect(result).toEqual({ ok: true, status: 200, body: { companies: [] } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/platform/companies');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-value' });
    expect(init.body).toBeUndefined();
    expect(init.cache).toBe('no-store');
  });

  it('posts JSON', async () => {
    const fetchMock = reply(201, { company: { id: ID } });
    vi.stubGlobal('fetch', fetchMock);
    await operatorCall(user, '/api/platform/companies', { method: 'POST', body: { name: 'A', signInSlug: 'a' } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      authorization: 'Bearer token-value',
      'content-type': 'application/json',
      [CLIENT_EPOCH_HEADER]: String(CLIENT_EPOCH),
    });
    expect(init.body).toBe('{"name":"A","signInSlug":"a"}');
  });

  it('turns a refusal into its fixed code', async () => {
    vi.stubGlobal('fetch', reply(403, { error: 'not_an_operator' }));
    expect(await operatorCall(user, '/api/platform/companies')).toEqual({ ok: false, status: 403, code: 'not_an_operator' });
  });

  it('treats an answer it cannot read as unavailable, never as success', async () => {
    vi.stubGlobal('fetch', reply(500, 'Internal Server Error'));
    expect(await operatorCall(user, '/api/platform/companies')).toEqual({ ok: false, status: 500, code: 'unavailable' });
    vi.stubGlobal('fetch', reply(200, 'not json'));
    expect(await operatorCall(user, '/api/platform/companies')).toEqual({ ok: false, status: 200, code: 'unavailable' });
    vi.stubGlobal('fetch', reply(403, { error: 7 }));
    expect(await operatorCall(user, '/api/platform/companies')).toEqual({ ok: false, status: 403, code: 'unavailable' });
  });

  it('reports a network failure or an unreadable sign-in as unavailable without quoting the error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('secret@example.com down'))));
    expect(await operatorCall(user, '/api/platform/companies')).toEqual({ ok: false, status: 0, code: 'unavailable' });
    const broken = { getIdToken: vi.fn(async () => Promise.reject(new Error('token refused'))) };
    expect(await operatorCall(broken, '/api/platform/companies')).toEqual({ ok: false, status: 0, code: 'unavailable' });
  });

  it('reads only the full team view', () => {
    expect(fullTeam({ view: 'full', members: [], invitations: [] })).not.toBeNull();
    expect(fullTeam({ view: 'estimators', estimators: [] })).toBeNull();
  });
});

describe('the local operator lookup', () => {
  let dir: string;
  let path: string;
  const fixture: LocalSignInFixture = {
    companies: [],
    members: [],
    operators: [{ tenantId: 'ops-tenant', uid: 'op-uid', operatorId: ID }],
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'operator-fixture-'));
    path = join(dir, 'fixture.json');
    await writeFile(path, JSON.stringify(fixture));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('finds an operator by sign-in tenant and uid together, and nobody else', async () => {
    const directory = localOperatorDirectory(path);
    expect(await directory.operatorFor('ops-tenant', 'op-uid')).toBe(ID);
    // A company owner with the same uid in another tenant, or another uid in the operator tenant.
    expect(await directory.operatorFor('company-tenant', 'op-uid')).toBeNull();
    expect(await directory.operatorFor('ops-tenant', 'owner-uid')).toBeNull();
  });

  it('has no operators in a fixture that lists none', async () => {
    const empty = join(dir, 'empty.json');
    await writeFile(empty, JSON.stringify({ companies: [], members: [] }));
    expect(await localOperatorDirectory(empty).operatorFor('ops-tenant', 'op-uid')).toBeNull();
  });
});
