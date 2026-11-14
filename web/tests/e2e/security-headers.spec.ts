import { expect, test } from '@playwright/test';

// F7 of the S3 security review (src/lib/security-headers.ts) in Chromium and WebKit: the headers
// arrive on pages and API answers, error answers included.
test.use({ viewport: { width: 390, height: 844 } });

const COMMON = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
};

function expectHeaders(headers: Record<string, string>) {
  expect(headers).toMatchObject(COMMON);
  expect(headers['content-security-policy']).toBe("frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
}

test('pages and API answers carry the security headers', async ({ page, request }) => {
  for (const path of ['/', '/field', '/sign-in/company-a', '/sign-in/company-z']) {
    const response = await page.goto(path);
    expectHeaders(response!.headers());
  }
  for (const [method, path] of [
    ['get', '/api/health'],
    ['get', '/api/me'], // refused with 401: an error answer carries them too
    ['post', '/api/client-errors'],
  ] as const) {
    const response = await request[method](path);
    expectHeaders(response.headers());
  }
  expectHeaders((await request.get('/sw.js')).headers());
});

test('the field worker keeps its own cache rule beside the security headers', async ({ request }) => {
  const response = await request.get('/sw.js');
  expect(response.headers()['cache-control']).toBe('no-cache, no-store, must-revalidate');
});
