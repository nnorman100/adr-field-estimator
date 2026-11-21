import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { linkApiPaths, memberApiPaths, publicApiPaths } from '@/lib/public-api';
import { config, proxy } from '@/proxy';

const call = (path: string, method = 'GET') =>
  proxy(new NextRequest(new URL(path, 'http://localhost'), { method }));

describe('API sign-in gate', () => {
  it('runs on every API path and on pages for report-only CSP headers', () => {
    expect(config.matcher).toBe('/:path*');
  });

  it('keeps the public list to the four routes that hold nothing private', () => {
    expect([...publicApiPaths].sort()).toEqual([
      '/api/client-errors',
      '/api/echo',
      '/api/health',
      '/api/sign-in/:address',
    ]);
  });

  // S5a-11b: a homeowner or adjuster with no sign-in reaches the link routes, which refuse any
  // request without a link token of their own (linkRoute), and nothing that only looks like them.
  it('passes only the link routes on to their own link-token check', () => {
    expect([...linkApiPaths].sort()).toEqual([
      '/api/documents',
      '/api/documents/photos/:id',
      '/api/documents/signature',
      '/api/sign',
      '/api/sign/photos/:id',
      '/api/sign/signature',
      '/api/sign/signature/:id',
    ]);
    const id = '0b5a1c1e-7d2f-4c8e-9a6b-3f4e5d6c7b8a';
    for (const path of ['/api/sign', '/api/sign/signature', `/api/sign/signature/${id}`, `/api/sign/photos/${id}`, '/api/documents', '/api/documents/signature', `/api/documents/photos/${id}`]) {
      expect({ path, next: call(path).headers.get('x-middleware-next') }).toEqual({ path, next: '1' });
    }
    for (const path of ['/api/sign/', '/api/sign/x', '/api/sign/signature/not-a-uuid', '/api/signs', '/api/documents/x', `/api/documents/${id}`, '/api/sign/..%2Fme']) {
      expect({ path, status: call(path).status }).toEqual({ path, status: 401 });
    }
  });

  it('lets a signed-out phone report an error, and only at that exact path', () => {
    expect(call('/api/client-errors', 'POST').headers.get('x-middleware-next')).toBe('1');
    for (const path of ['/api/client-errors/', '/api/client-errors/x', '/api/client-errors/..%2Fme', '/api/client-error']) {
      expect({ path, status: call(path, 'POST').status }).toEqual({ path, status: 401 });
    }
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
      '/api/companies/:id/profile',
      '/api/companies/:id/ai-usage',
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
      '/api/prices/item-list',
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
      '/api/jobs/:id/photos/:id',
      '/api/jobs/:id/submissions',
      '/api/jobs/:id/drafts',
      '/api/jobs/:id/estimate',
      '/api/jobs/:id/reprice',
      '/api/jobs/:id/approvals',
      '/api/jobs/:id/approvals/:id',
      '/api/jobs/:id/approvals/:id/approve',
      '/api/jobs/:id/agreements',
      '/api/jobs/:id/scope-lists',
      '/api/jobs/:id/readiness',
      '/api/jobs/:id/drying-readings',
      '/api/jobs/:id/drying-readings/:id/void',
      '/api/jobs/:id/signing-link',
      '/api/jobs/:id/document-links',
      '/api/jobs/:id/document-links/:id',
      '/api/jobs/:id/coordination',
      '/api/jobs/:id/assignments',
      '/api/jobs/:id/assignments/:id',
      '/api/jobs/:id/field-owner',
      '/api/jobs/:id/field-owner/transfer',
      '/api/jobs/:id/archive',
      '/api/jobs/:id/restore',
      '/api/jobs/:id/copy',
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
    expect(call(`/api/jobs/${id}/photos/${id}`, 'PUT').headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/jobs/${id}/submissions`, 'POST').headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/jobs/${id}/drafts`, 'POST').headers.get('x-middleware-next')).toBe('1');
    expect(call(`/api/jobs/${id}/reprice`, 'POST').headers.get('x-middleware-next')).toBe('1');
    for (const path of [
      '/api/companies/current/team',
      `/api/companies/${id}/team/extra`,
      `/api/companies/${id}`,
      `/api/companies/${id}x/team`,
      `/api/companies/${id}/members/${id}/delete`,
      `/api/invitations/${id}/accept/`,
      `/api/jobs/${id}/archive/extra`,
      `/api/jobs/${id}/customer/`,
      `/api/jobs/${id}/photos`,
      `/api/jobs/${id}/photos/${id}/original`,
      `/api/jobs/${id}/photos/${id}/`,
      `/api/jobs/${id}/submissions/${id}`,
      `/api/jobs/${id}/drafts/`,
      `/api/jobs/${id}/reprice/`,
      `/api/jobs/${id}/reprice/extra`,
      '/api/jobs/current/reprice',
      '/api/jobs/not-a-uuid/reprice',
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
