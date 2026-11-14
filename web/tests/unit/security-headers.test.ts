import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';
import { CSP_MODE, enforcedPolicy, fullPolicy, securityHeaders } from '@/lib/security-headers';

// F7 of the S3 security review: every page and API response carries a framing ban, HTTPS-only,
// nosniff, a referrer rule and a content policy limited to what the app loads.

const PROD = { NODE_ENV: 'production' } as const;

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name!, sources];
    }),
  );
}

const header = (name: string, env: Record<string, string | undefined> = PROD) =>
  securityHeaders(env).find((h) => h.key === name)?.value;

describe('security headers: the fixed set', () => {
  it('sends a framing ban in both forms, nosniff, a referrer rule and HTTPS-only', () => {
    expect(directives(header('Content-Security-Policy')!)['frame-ancestors']).toEqual(["'none'"]);
    expect(header('X-Frame-Options')).toBe('DENY');
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('Strict-Transport-Security')).toBe('max-age=31536000');
  });

  it('keeps HSTS to this host: no subdomains, no preload list', () => {
    expect(header('Strict-Transport-Security')).not.toMatch(/includeSubDomains|preload/i);
  });

  it('never repeats a header name, which Next would overwrite', () => {
    const keys = securityHeaders(PROD).map((h) => h.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('enforces the framing ban whichever mode the full policy is in', () => {
    const enforced = directives(enforcedPolicy());
    expect(enforced['frame-ancestors']).toEqual(["'none'"]);
    expect(enforced['object-src']).toEqual(["'none'"]);
    expect(enforced['base-uri']).toEqual(["'self'"]);
    expect(enforced['form-action']).toEqual(["'self'"]);
    // Nothing in the enforced part names a source Google serves, so it cannot break sign-in.
    expect(enforcedPolicy()).not.toMatch(/https?:/);
  });

  it('starts the full policy in report-only mode, as agreed (flip CSP_MODE to enforce)', () => {
    expect(CSP_MODE).toBe('report-only');
    expect(header('Content-Security-Policy-Report-Only')).toBe(fullPolicy(PROD));
  });
});

describe('security headers: the full policy allows what the app loads and no more', () => {
  const policy = directives(fullPolicy(PROD));

  it('connects to this site and the Firebase, Identity Platform, Firestore, App Check and reCAPTCHA endpoints only', () => {
    expect(policy['connect-src']).toEqual([
      "'self'",
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
      'https://firestore.googleapis.com',
      'https://firebaseappcheck.googleapis.com',
      'https://www.google.com/recaptcha/',
    ]);
  });

  it('loads script from this site, Google sign-in and reCAPTCHA only, with no eval in production', () => {
    expect(policy['script-src']).toEqual([
      "'self'",
      "'unsafe-inline'",
      'https://apis.google.com',
      'https://www.google.com/recaptcha/',
      'https://www.gstatic.com/recaptcha/',
    ]);
    expect(fullPolicy(PROD)).not.toContain('unsafe-eval');
    expect(fullPolicy({ NODE_ENV: 'development' })).toContain("'unsafe-eval'");
  });

  it('frames only the sign-in helper, Google sign-in and reCAPTCHA', () => {
    expect(policy['frame-src']).toEqual([
      "'self'",
      'https://*.firebaseapp.com',
      'https://accounts.google.com',
      'https://www.google.com/recaptcha/',
      'https://recaptcha.google.com/recaptcha/',
    ]);
  });

  it('shuts plugins, other base URLs and outside form posts, and falls back to this site', () => {
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'self'"]);
    expect(policy['form-action']).toEqual(["'self'"]);
    expect(policy['worker-src']).toEqual(["'self'"]);
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('has no bare wildcard and no wildcard on a Google API host', () => {
    const text = fullPolicy(PROD);
    expect(text).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(text).not.toMatch(/\*\.googleapis\.com|\*\.google\.com|\*\.gstatic\.com/);
  });
});

describe('security headers: emulators', () => {
  const local = { ...PROD, APP_ENV: 'local', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399', FIRESTORE_EMULATOR_HOST: 'localhost:8399' };

  it('adds the loopback emulators to connect-src for a local build only', () => {
    expect(directives(fullPolicy(local))['connect-src']).toEqual(
      expect.arrayContaining(['http://127.0.0.1:9399', 'http://localhost:8399']),
    );
    // The Auth SDK's helper frame comes from the Auth emulator; Firestore needs no frame.
    expect(directives(fullPolicy(local))['frame-src']).toContain('http://127.0.0.1:9399');
    expect(directives(fullPolicy(local))['frame-src']).not.toContain('http://localhost:8399');
    for (const env of [{ ...local, APP_ENV: 'test' }, { ...local, APP_ENV: undefined }, PROD]) {
      expect(fullPolicy(env)).not.toMatch(/http:/);
    }
  });

  it('refuses a host that is not loopback, even for a local build', () => {
    const bad = { ...local, FIREBASE_AUTH_EMULATOR_HOST: 'evil.example.com:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:80; script-src *' };
    expect(fullPolicy(bad)).not.toMatch(/evil|http:/);
  });
});

describe('next.config.ts', () => {
  it('applies the headers to every path and keeps the worker and shell cache rules', async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === '/:path*');
    expect(all?.headers.map((h) => h.key)).toEqual(securityHeaders(process.env).map((h) => h.key));
    expect(all?.headers.map((h) => h.key)).toContain('X-Frame-Options');
    expect(rules.find((r) => r.source === '/sw.js')?.headers.map((h) => h.key)).toContain('Cache-Control');
    expect(rules.find((r) => r.source === '/field')?.headers.map((h) => h.key)).toContain('Cache-Control');
  });
});
