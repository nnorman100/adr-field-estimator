import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

afterEach(() => vi.unstubAllEnvs());

const headers = (path = '/field') => proxy(new NextRequest(`https://app.example${path}`)).headers;
const policy = () => headers().get('content-security-policy-report-only') ?? '';
const sources = (name: string) =>
  policy()
    .split('; ')
    .find((part) => part.startsWith(`${name} `))
    ?.split(' ')
    .slice(1);

describe('full CSP is observation only', () => {
  it('covers the app and only the Google services its browser SDKs load', () => {
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FIREBASE_AUTH_DOMAIN', 'dryscope.firebaseapp.com');
    expect(sources('default-src')).toEqual(["'self'"]);
    expect(sources('script-src')).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://apis.google.com',
      'https://www.google.com/recaptcha/',
      'https://www.gstatic.com/recaptcha/',
    ]);
    expect(sources('connect-src')).toEqual([
      "'self'",
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://firestore.googleapis.com',
      'https://firebaseappcheck.googleapis.com',
      'https://www.google.com/recaptcha/',
    ]);
    expect(sources('frame-src')).toEqual([
      "'self'",
      'https://dryscope.firebaseapp.com',
      'https://www.google.com/recaptcha/',
      'https://recaptcha.google.com/recaptcha/',
    ]);
    expect(sources('worker-src')).toEqual(["'self'"]);
    expect(sources('object-src')).toEqual(["'none'"]);
    expect(sources('script-src-attr')).toEqual(["'none'"]);
    expect(sources('report-uri')).toEqual(['/api/client-errors']);
    expect(sources('report-to')).toEqual(['csp']);
    expect(headers().get('reporting-endpoints')).toBe('csp="/api/client-errors"');
    expect(policy()).not.toMatch(/unsafe-eval|report-sample|\*|http:|ws:/);
    // The existing enforced policy remains Next's fixed header; Proxy never replaces it.
    expect(headers().has('content-security-policy')).toBe(false);
  });

  it('uses the runtime auth domain rather than baking an environment into the build', () => {
    vi.stubEnv('FIREBASE_AUTH_DOMAIN', 'login.example.com');
    expect(sources('frame-src')).toContain('https://login.example.com');
    vi.stubEnv('FIREBASE_AUTH_DOMAIN', 'evil.example; script-src *');
    expect(policy()).not.toContain('evil.example');
  });

  it('permits loopback emulators only locally, and eval only in the development server', () => {
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('NODE_ENV', 'production');
    expect(sources('connect-src')).toContain('http://127.0.0.1:*');
    expect(sources('connect-src')).toContain('http://localhost:*');
    expect(sources('script-src')).not.toContain("'unsafe-eval'");
    vi.stubEnv('NODE_ENV', 'development');
    expect(sources('script-src')).toContain("'unsafe-eval'");
    vi.stubEnv('APP_ENV', 'test');
    vi.stubEnv('NODE_ENV', 'production');
    expect(policy()).not.toMatch(/localhost|127\.0\.0\.1|unsafe-eval/);
  });

  it('also observes public pages, API refusals and the service worker, but excludes photo downloads', () => {
    for (const path of ['/', '/sign-in/company-a', '/api/unknown', '/sw.js']) {
      expect(headers(path).get('content-security-policy-report-only')).toContain('script-src');
    }
    for (const suffix of ['', '/', '?kind=original']) {
      const sent = headers(`/api/jobs/job-id/photos/photo-id${suffix}`);
      expect(sent.has('content-security-policy-report-only')).toBe(false);
      expect(sent.has('reporting-endpoints')).toBe(false);
    }
  });
});
