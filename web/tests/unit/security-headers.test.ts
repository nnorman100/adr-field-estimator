import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '@/lib/security-headers';
import { servedHeaders } from '../support/next-headers';

// F7 of the S3 security review: every page and API response carries a framing ban, HTTPS-only,
// nosniff, a referrer rule and a fixed content policy. Checked on what the app sends: the rules of
// next.config.ts as Next matches and applies them (tests/support/next-headers.ts).

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name!, sources];
    }),
  );
}

const PHOTO = '/api/jobs/5f0c6d0e-1b1a-4c55-9a43-1d2f7c9b0a11/photos/0b7d2c4e-8f61-4a4f-b3c2-6e9a1f0d5c22';
const plain = () => Response.json({ ok: true });
const sandboxed = () => new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'; sandbox" } });

describe('security headers: the fixed set', () => {
  it('sends a framing ban in both forms, nosniff, a referrer rule and HTTPS-only on pages and API answers', async () => {
    for (const path of ['/', '/field', '/sign-in/company-a', '/api/health', '/api/jobs', `${PHOTO}/other`]) {
      const sent = await servedHeaders(path, plain());
      expect({ path, frame: sent.get('x-frame-options') }).toEqual({ path, frame: 'DENY' });
      expect(sent.get('x-content-type-options')).toBe('nosniff');
      expect(sent.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(sent.get('strict-transport-security')).toBe('max-age=31536000');
      expect(sent.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY.value);
    }
  });

  it('enforces a content policy of no framing, no plugins and no other base URL, and nothing else', () => {
    expect(directives(CONTENT_SECURITY_POLICY.value)).toEqual({
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    });
  });

  it('keeps HSTS to this host: no subdomains, no preload list', () => {
    expect(SECURITY_HEADERS.find((h) => h.key === 'Strict-Transport-Security')?.value).not.toMatch(/includeSubDomains|preload/i);
  });

  it('never repeats a header name, which Next would overwrite', () => {
    const keys = [...SECURITY_HEADERS, CONTENT_SECURITY_POLICY].map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('security headers: the photo download keeps its own stricter policy', () => {
  it('sends the route’s sandboxed policy, not the global one, with the other headers still on', async () => {
    for (const path of [PHOTO, `${PHOTO}?kind=photo`, `${PHOTO}?kind=original`, `${PHOTO}/`]) {
      const sent = await servedHeaders(path, sandboxed());
      expect({ path, csp: sent.get('content-security-policy') }).toEqual({ path, csp: "default-src 'none'; sandbox" });
      expect(sent.get('x-frame-options')).toBe('DENY');
      expect(sent.get('strict-transport-security')).toBe('max-age=31536000');
      expect(sent.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    }
  });

  it('would lose that policy to a global one on any other path, which is why the photo path is skipped', async () => {
    expect((await servedHeaders('/api/jobs', sandboxed())).get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY.value);
  });
});

describe('next.config.ts', () => {
  it('keeps the worker and shell cache rules', async () => {
    expect((await servedHeaders('/sw.js', plain())).get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect((await servedHeaders('/field', plain())).get('cache-control')).toBe('no-cache, must-revalidate');
  });
});
