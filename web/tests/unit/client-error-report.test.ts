import { describe, expect, it } from 'vitest';
import {
  CLIENT_ROUTES,
  browserFamily,
  buildReport,
  cleanFrames,
  errorName,
  ownFrames,
  routePattern,
  scrubMessage,
} from '@/lib/client-error-report';
import { SCREENS } from '../e2e/screens';

// What a browser or phone error report may contain (TC plan decision C13, option A): the error name,
// a scrubbed message cut to 300 characters, stack lines from the app's own scripts only, the route
// pattern, and the browser family. These tests feed a crafted email, token and coordinate pair
// through every rule and fail if any of them comes out.

const EMAIL = 'jane.doe@example.com';
const BEARER = 'Bearer abcdef0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
const COORDS = '34.05223, -118.24368';

describe('scrubMessage', () => {
  it('removes an email address', () => {
    expect(scrubMessage(`could not send to ${EMAIL} today`)).not.toContain('example.com');
  });

  it('removes a bearer value and a token-shaped value', () => {
    const out = scrubMessage(`401 with ${BEARER} and ${JWT}`);
    expect(out).not.toContain('abcdef0123456789');
    expect(out).not.toContain('eyJ');
  });

  it('removes a long unbroken token, a hex digest and a uuid', () => {
    const out = scrubMessage(
      `key ${'A1b2'.repeat(10)} digest ${'0123456789abcdef'.repeat(2)} job 123e4567-e89b-12d3-a456-426614174000`,
    );
    expect(out).not.toMatch(/A1b2A1b2/);
    expect(out).not.toContain('0123456789abcdef');
    expect(out).not.toContain('123e4567');
  });

  it('removes a latitude, longitude pair', () => {
    expect(scrubMessage(`geolocation ${COORDS} failed`)).not.toMatch(/34\.05|118\.24/);
    expect(scrubMessage('at 34.05223,-118.24368')).not.toMatch(/34\.05|118\.24/);
  });

  it('removes long digit runs and phone numbers', () => {
    const out = scrubMessage('claim 20261113001 phone (555) 123-4567 and 555.123.4567');
    expect(out).not.toMatch(/\d{6}/);
    expect(out).not.toMatch(/555/);
  });

  it('keeps short numbers that carry no identity', () => {
    expect(scrubMessage('Unexpected token at position 42')).toBe('Unexpected token at position 42');
  });

  it('removes a URL query string and fragment but keeps the path', () => {
    const out = scrubMessage('Failed to fetch https://app.example/api/jobs?token=secret123&x=1#frag=abc');
    expect(out).toBe('Failed to fetch https://app.example/api/jobs');
  });

  it('cuts to 300 characters and joins lines', () => {
    const out = scrubMessage(`first\nsecond ${'x '.repeat(400)}`);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).not.toContain('\n');
    expect(out.startsWith('first second')).toBe(true);
  });

  it('is idempotent, so the server can run the same rules again', () => {
    const once = scrubMessage(`${EMAIL} ${BEARER} ${COORDS} 20261113001 ?q=1`);
    expect(scrubMessage(once)).toBe(once);
  });
});

describe('ownFrames', () => {
  const V8 = [
    'Error: boom',
    '    at fn (https://app.example/_next/static/chunks/app-0123abcd.js?dpl=abc:10:20)',
    '    at https://app.example/_next/static/chunks/main.js:3:4',
    '    at third (https://cdn.example/lib/other.js:1:1)',
    '    at fourth (https://app.example/not-ours/script.js:5:6)',
  ].join('\n');

  it('keeps only frames from the app’s own scripts, with the origin and query removed', () => {
    expect(ownFrames(V8)).toEqual([
      '    at fn (/_next/static/chunks/app-0123abcd.js:10:20)',
      '    at /_next/static/chunks/main.js:3:4',
    ]);
  });

  it('reads the Safari and Firefox frame shape', () => {
    const stack = ['fn@https://app.example/_next/static/chunks/a.js:7:8', '@https://app.example/_next/static/chunks/b.js:9:1', 'native code'].join('\n');
    expect(ownFrames(stack)).toEqual([
      '    at fn (/_next/static/chunks/a.js:7:8)',
      '    at /_next/static/chunks/b.js:9:1',
    ]);
  });

  it('does not carry the error message or a function name that is not an identifier', () => {
    const stack = `Error: ${EMAIL}\n    at ${EMAIL} (https://app.example/_next/static/chunks/a.js:1:2)`;
    const out = ownFrames(stack).join('\n');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('jane');
  });

  it('keeps at most 12 frames and nothing from a missing stack', () => {
    const many = Array.from({ length: 30 }, (_, i) => `    at f${i} (https://a.example/_next/static/c.js:${i + 1}:1)`).join('\n');
    expect(ownFrames(many)).toHaveLength(12);
    expect(ownFrames(undefined)).toEqual([]);
  });
});

describe('cleanFrames', () => {
  it('keeps a frame in the canonical shape and drops anything else', () => {
    expect(
      cleanFrames([
        '    at fn (/_next/static/chunks/a.js:1:2)',
        '    at /_next/static/chunks/b.js:3:4',
        '    at fn (https://evil.example/_next/static/chunks/a.js:1:2)',
        `    at ${EMAIL} (/_next/static/chunks/a.js:1:2)`,
        'free text jane@example.com',
        '    at fn (/_next/static/chunks/a.js?token=x:1:2)',
      ]),
    ).toEqual(['    at fn (/_next/static/chunks/a.js:1:2)', '    at /_next/static/chunks/b.js:3:4']);
  });
});

describe('errorName, routePattern, browserFamily', () => {
  it('keeps an identifier-shaped error name and falls back to Error', () => {
    expect(errorName('TypeError')).toBe('TypeError');
    expect(errorName(EMAIL)).toBe('Error');
    expect(errorName('')).toBe('Error');
    expect(errorName(undefined)).toBe('Error');
  });

  it('reports the route pattern, never the address', () => {
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/field')).toBe('/field');
    expect(routePattern('/sign-in/acme-restoration')).toBe('/sign-in/[address]');
    expect(routePattern('/sign-in/acme-restoration/team')).toBe('/sign-in/[address]/team');
    expect(routePattern('/sign-in/acme/invitations/123e4567-e89b-12d3-a456-426614174000')).toBe(
      '/sign-in/[address]/invitations/[invitationId]',
    );
    expect(routePattern('/operator/abc/companies/def/team/')).toBe('/operator/[tenantId]/companies/[companyId]/team');
  });

  it('answers unknown for a path that is not a page of the app', () => {
    expect(routePattern('/not/a/page')).toBe('unknown');
    expect(routePattern(`/${EMAIL}`)).toBe('unknown');
    expect(routePattern('')).toBe('unknown');
  });

  it('lists every screen of the app', () => {
    expect([...CLIENT_ROUTES].sort()).toEqual(expect.arrayContaining(Object.keys(SCREENS).sort()));
  });

  it('names the browser family only', () => {
    const ua = {
      safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      chrome: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      edge: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:127.0) Gecko/127.0 Firefox/127.0',
      iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
    };
    expect(browserFamily(ua.safari)).toBe('safari');
    expect(browserFamily(ua.chrome)).toBe('chrome');
    expect(browserFamily(ua.edge)).toBe('edge');
    expect(browserFamily(ua.firefox)).toBe('firefox');
    expect(browserFamily(ua.iosChrome)).toBe('chrome');
    // The browser Playwright drives says HeadlessChrome, and the check must not call it Safari.
    expect(browserFamily('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/147.0.0.0 Safari/537.36')).toBe('chrome');
    expect(browserFamily('curl/8')).toBe('other');
  });
});

describe('buildReport', () => {
  const where = { pathname: '/sign-in/acme-restoration', userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/126.0.0.0 Mobile Safari/537.36' };

  it('builds the C13 fields from an Error and nothing else', () => {
    const error = new TypeError(`bad value for ${EMAIL} ${BEARER} at ${COORDS}`);
    const report = buildReport('error', error, where);
    expect(Object.keys(report).sort()).toEqual(['browser', 'kind', 'message', 'name', 'route', 'stack']);
    expect(report).toMatchObject({ kind: 'error', name: 'TypeError', route: '/sign-in/[address]', browser: 'chrome' });
    const text = JSON.stringify(report);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('abcdef0123456789');
    expect(text).not.toMatch(/34\.05|118\.24/);
    expect(text).not.toContain('acme-restoration');
  });

  it('reads a thrown string and a rejected object without keeping the object', () => {
    expect(buildReport('error', `boom ${EMAIL}`, where).message).not.toContain('example.com');
    const rejected = buildReport('rejection', { token: BEARER, email: EMAIL }, where);
    expect(rejected.name).toBe('UnhandledRejection');
    expect(JSON.stringify(rejected)).not.toMatch(/example\.com|abcdef/);
  });
});
