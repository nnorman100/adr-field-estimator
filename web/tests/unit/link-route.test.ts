import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { linkRoute } from '@/lib/auth/route';
import { LINK_REQUESTS_PER_ADDRESS_PER_MINUTE, linkAddressTableSize, resetLinkRequestLimits, takeLinkRequest } from '@/lib/links/address-limit';
import { isLinkToken, LINK_TOKEN_HEADER, linkTokenHashOf, newLinkToken } from '@/lib/links/token';

// S5a-11b: the link rule without a database. The token travels only in its header, the handler is
// given its SHA-256 and never the token, and the per-address limit refuses before any lookup.

const params = { params: Promise.resolve({}) };
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const request = (headers: Record<string, string> = {}, url = 'http://localhost/api/sign') => new Request(url, { headers });

afterEach(() => resetLinkRequestLimits());

describe('link tokens', () => {
  it('are 32 random bytes as 43 URL-safe characters, never the same twice', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newLinkToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are read from the header only, and only in their own shape', () => {
    const token = newLinkToken();
    expect(linkTokenHashOf(request({ [LINK_TOKEN_HEADER]: token }))).toBe(sha(token));
    // Not from the query string, the path or a bearer sign-in.
    expect(linkTokenHashOf(request({}, `http://localhost/api/sign?token=${token}`))).toBeNull();
    expect(linkTokenHashOf(request({ authorization: `Bearer ${token}` }))).toBeNull();
    for (const bad of ['', token.slice(1), `${token}a`, `${token.slice(1)}=`, `${token.slice(1)}/`, ' '.repeat(43)]) {
      expect(isLinkToken(bad)).toBe(false);
      expect(linkTokenHashOf(request({ [LINK_TOKEN_HEADER]: bad }))).toBeNull();
    }
  });
});

describe('linkRoute', () => {
  it('gives the handler the token’s SHA-256 and nothing that holds the token', async () => {
    const token = newLinkToken();
    const handler = vi.fn(async (_request: Request, link: { tokenSha256: string }) => Response.json(link));
    const answer = await linkRoute(handler)(request({ [LINK_TOKEN_HEADER]: token }), params);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ tokenSha256: sha(token) });
    expect(JSON.stringify(handler.mock.calls[0]![1])).not.toContain(token);
  });

  it('answers a missing or malformed token 404 without running the handler', async () => {
    const handler = vi.fn(async () => new Response('ran'));
    for (const headers of [{}, { [LINK_TOKEN_HEADER]: 'short' }, { authorization: `Bearer ${newLinkToken()}` }] as Record<string, string>[]) {
      const answer = await linkRoute(handler)(request(headers), params);
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: 'link_unavailable' });
      expect(answer.headers.get('cache-control')).toBe('no-store');
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an address over its share with 429 before the token is read', async () => {
    const handler = vi.fn(async () => new Response('ran'));
    const answer = await linkRoute(handler, () => false)(request({ [LINK_TOKEN_HEADER]: newLinkToken() }), params);
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: 'too_many_requests' });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('the per-address limit of the link routes', () => {
  const from = (address: string) => new Headers({ 'x-forwarded-for': `203.0.113.250, ${address}` });

  it('allows 120 requests a minute from one address, then refuses until the minute is over', () => {
    expect(LINK_REQUESTS_PER_ADDRESS_PER_MINUTE).toBe(120);
    const start = 1_000_000;
    for (let i = 0; i < 120; i += 1) expect(takeLinkRequest(from('198.51.100.7'), start + i)).toBe(true);
    expect(takeLinkRequest(from('198.51.100.7'), start + 500)).toBe(false);
    // Another address has its own share; the caller's own earlier entries do not count.
    expect(takeLinkRequest(from('198.51.100.8'), start + 500)).toBe(true);
    expect(takeLinkRequest(new Headers({ 'x-forwarded-for': '198.51.100.7, 198.51.100.9' }), start + 500)).toBe(true);
    expect(takeLinkRequest(from('198.51.100.7'), start + 60_000)).toBe(true);
  });

  it('keeps no plain address and stays bounded', () => {
    const start = 2_000_000;
    for (let i = 0; i < 6000; i += 1) takeLinkRequest(from(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`), start);
    expect(linkAddressTableSize()).toBeLessThanOrEqual(5000);
  });

  it('lets a request with no usable address through to the per-link limits', () => {
    for (let i = 0; i < 200; i += 1) expect(takeLinkRequest(new Headers({ 'x-forwarded-for': 'not an address' }))).toBe(true);
  });
});

// The route files themselves, run: every handler of a link route refuses a request that carries no
// link token, and the technician's link routes never take a link token as a sign-in. The routes'
// answers with a real token, and company isolation, are in tests/db/signing-links.test.ts and
// document-links.test.ts.
type RouteHandler = (request: Request, context: typeof params) => Response | Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'PUT' | 'DELETE', RouteHandler>>;

const LINK_ROUTES: [string, () => Promise<RouteModule>, string[]][] = [
  ['/api/sign', () => import('@/app/api/sign/route'), ['GET', 'POST']],
  ['/api/sign/signature', () => import('@/app/api/sign/signature/route'), ['GET']],
  ['/api/sign/signature/00000000-0000-4000-8000-000000000001', () => import('@/app/api/sign/signature/[signatureId]/route'), ['PUT']],
  ['/api/documents', () => import('@/app/api/documents/route'), ['GET']],
  ['/api/documents/signature', () => import('@/app/api/documents/signature/route'), ['GET']],
];

const TECHNICIAN_ROUTES: [string, () => Promise<RouteModule>, string[]][] = [
  ['/api/jobs/00000000-0000-4000-8000-000000000002/signing-link', () => import('@/app/api/jobs/[jobId]/signing-link/route'), ['GET', 'POST', 'DELETE']],
  ['/api/jobs/00000000-0000-4000-8000-000000000002/document-links', () => import('@/app/api/jobs/[jobId]/document-links/route'), ['GET', 'POST']],
  ['/api/jobs/00000000-0000-4000-8000-000000000002/document-links/00000000-0000-4000-8000-000000000003', () => import('@/app/api/jobs/[jobId]/document-links/[linkId]/route'), ['DELETE']],
];

describe('the link route files', () => {
  const verify = vi.fn(async () => {
    throw new Error('a link route checked a sign-in');
  });
  beforeAll(() => {
    vi.resetModules();
    vi.doMock('@/lib/auth/services', () => ({
      identityServices: () => ({ verifier: { verify, verifyNotRevoked: verify }, directory: {} }),
      operatorServices: () => {
        throw new Error('no operator here');
      },
    }));
  });
  afterAll(() => {
    vi.doUnmock('@/lib/auth/services');
    vi.resetModules();
  });

  it('answers 404 link_unavailable to every handler of a link route without a link token, a sign-in included', async () => {
    for (const [path, load, methods] of LINK_ROUTES) {
      const route = await load();
      expect(Object.keys(route).filter((key) => /^[A-Z]+$/.test(key)).sort()).toEqual([...methods].sort());
      for (const method of methods) {
        for (const headers of [{}, { [LINK_TOKEN_HEADER]: 'short' }, { authorization: `Bearer ${newLinkToken()}` }] as Record<string, string>[]) {
          const answer = await route[method as keyof RouteModule]!(new Request(`http://localhost${path}`, { method, headers }), params);
          expect({ path, method, status: answer.status, body: await answer.json(), cache: answer.headers.get('cache-control') }).toEqual({
            path,
            method,
            status: 404,
            body: { error: 'link_unavailable' },
            cache: 'no-store',
          });
        }
      }
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a link token as a sign-in on the technician’s link routes', async () => {
    for (const [path, load, methods] of TECHNICIAN_ROUTES) {
      const route = await load();
      for (const method of methods) {
        const answer = await route[method as keyof RouteModule]!(new Request(`http://localhost${path}`, { method, headers: { [LINK_TOKEN_HEADER]: newLinkToken() } }), params);
        expect({ path, method, status: answer.status }).toEqual({ path, method, status: 401 });
      }
    }
    expect(verify).not.toHaveBeenCalled();
  });
});
