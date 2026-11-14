import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import { SECURITY_HEADERS } from '@/lib/security-headers';

// F7 of the S3 security review: every page and API response carries a framing ban, HTTPS-only,
// nosniff, a referrer rule and a fixed content policy.

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name!, sources];
    }),
  );
}

const header = (name: string) => SECURITY_HEADERS.find((h) => h.key === name)?.value;

describe('security headers: the fixed set', () => {
  it('sends a framing ban in both forms, nosniff, a referrer rule and HTTPS-only', () => {
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('enforces a content policy of no framing, no plugins and no other base URL, and nothing else', () => {
    expect(directives(header('Content-Security-Policy')!)).toEqual({
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    });
    expect(SECURITY_HEADERS.map((h) => h.key)).not.toContain('Content-Security-Policy-Report-Only');
  });

  it('keeps HSTS to this host: no subdomains, no preload list', () => {
    expect(header('Strict-Transport-Security')).not.toMatch(/includeSubDomains|preload/i);
  });

  it('never repeats a header name, which Next would overwrite', () => {
    const keys = SECURITY_HEADERS.map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('next.config.ts', () => {
  it('applies the headers to every path and keeps the worker and shell cache rules', async () => {
    const rules = await nextConfig.headers!();
    expect(rules.find((r) => r.source === '/:path*')?.headers).toEqual(SECURITY_HEADERS);
    expect(rules.find((r) => r.source === '/sw.js')?.headers.map((h) => h.key)).toContain('Cache-Control');
    expect(rules.find((r) => r.source === '/field')?.headers.map((h) => h.key)).toContain('Cache-Control');
  });
});
