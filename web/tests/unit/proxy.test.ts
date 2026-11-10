import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { memberApiPaths, publicApiPaths } from '@/lib/public-api';
import { config, proxy } from '@/proxy';

const call = (path: string, method = 'GET') =>
  proxy(new NextRequest(new URL(path, 'http://localhost'), { method }));

describe('API sign-in gate', () => {
  it('runs on every API path', () => {
    expect(config.matcher).toBe('/api/:path*');
  });

  it('keeps the public list to the two routes that hold nothing private', () => {
    expect([...publicApiPaths].sort()).toEqual(['/api/echo', '/api/health']);
  });

  it('passes only /api/me on to its own sign-in check', () => {
    expect([...memberApiPaths]).toEqual(['/api/me']);
    expect(call('/api/me').headers.get('x-middleware-next')).toBe('1');
    expect(call('/api/me/extra').status).toBe(401);
  });

  it.each([['/api/health'], ['/api/echo']])('lets %s through', (path) => {
    const res = call(path);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it.each([
    ['/api/jobs', 'GET'],
    ['/api/companies', 'POST'],
    ['/api/health/details', 'GET'],
    ['/api/healthz', 'GET'],
    ['/api/echo/', 'POST'],
    ['/api', 'GET'],
  ])('refuses signed-out %s %s with 401', async (path, method) => {
    const res = call(path, method);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  });
});
