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

  it('keeps the public list to the three routes that hold nothing private', () => {
    expect([...publicApiPaths].sort()).toEqual(['/api/echo', '/api/health', '/api/sign-in/:address']);
  });

  it('matches a sign-in address segment to one sign-in address and nothing else', () => {
    expect(call('/api/sign-in/company-a').headers.get('x-middleware-next')).toBe('1');
    expect(call('/api/sign-in/a').headers.get('x-middleware-next')).toBe('1');
    for (const path of [
      '/api/sign-in',
      '/api/sign-in/',
      '/api/sign-in/Company-A',
      '/api/sign-in/-company',
      '/api/sign-in/company-',
      '/api/sign-in/company_a',
      `/api/sign-in/${'a'.repeat(41)}`,
      '/api/sign-in/company-a/extra',
      '/api/sign-in/..%2Fme',
    ]) {
      expect({ path, status: call(path).status }).toEqual({ path, status: 401 });
    }
  });

  it('passes only the member, invitation and job routes on to their own sign-in check', () => {
    expect([...memberApiPaths]).toEqual([
      '/api/me',
      '/api/companies/:id/team',
      '/api/companies/:id/invitations',
      '/api/companies/:id/invitations/:id/resend',
      '/api/companies/:id/invitations/:id/cancel',
      '/api/companies/:id/invitations/:id/clear',
      '/api/companies/:id/members/:id',
      '/api/companies/:id/members/:id/disable',
      '/api/companies/:id/members/:id/enable',
      '/api/invitations/:id',
      '/api/invitations/:id/accept',
      '/api/prices',
      '/api/prices/working-copy',
      '/api/prices/preview',
      '/api/prices/publish',
      '/api/prices/export',
      '/api/prices/import',
      '/api/prices/versions',
      '/api/prices/versions/:id',
      '/api/prices/versions/:id/restore',
      '/api/jobs',
      '/api/jobs/:id',
      '/api/jobs/:id/customer',
      '/api/jobs/:id/claim',
    ]);
    expect(call('/api/me').headers.get('x-middleware-next')).toBe('1');
    expect(call('/api/me/extra').status).toBe(401);
    // The Prices routes name no company; a look-alike path or a non-uuid version id gets no pass.
    expect(call('/api/prices').headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/api/prices/', '/api/prices/versions/current', '/api/prices/versions/x/restore', '/api/prices/other', '/api/prices/export/extra']) {
      expect({ path, status: call(path).status }).toEqual({ path, status: 401 });
    }
  });

  it('matches an id segment to one uuid and nothing else', () => {
    const id = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
    expect(call(`/api/companies/${id}/team`).headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/companies/${id}/members/${id.toUpperCase()}/disable`, 'POST').headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/invitations/${id}/accept`, 'POST').headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/jobs/${id}/customer`, 'PUT').headers.get('x-middleware-next')).toBe('1');
    for (const path of [
      '/api/companies/current/team',
      `/api/companies/${id}/team/extra`,
      `/api/companies/${id}`,
      `/api/companies/${id}x/team`,
      `/api/companies/${id}/members/${id}/delete`,
      `/api/invitations/${id}/accept/`,
      `/api/jobs/${id}/archive`,
      `/api/jobs/${id}/customer/`,
      '/api/invitations/..%2Fme',
    ]) {
      expect({ path, status: call(path).status }).toEqual({ path, status: 401 });
    }
  });

  it.each([['/api/health'], ['/api/echo']])('lets %s through', (path) => {
    const res = call(path);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it.each([
    ['/api/jobs/current', 'GET'],
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
