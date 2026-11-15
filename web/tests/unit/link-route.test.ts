import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
