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

test('the photo download path gets the other headers but no app-wide content policy, so its own sandboxed one wins', async ({ request }) => {
  const path = '/api/jobs/5f0c6d0e-1b1a-4c55-9a43-1d2f7c9b0a11/photos/0b7d2c4e-8f61-4a4f-b3c2-6e9a1f0d5c22';
  for (const query of ['?kind=photo', '?kind=original']) {
    const headers = (await request.get(`${path}${query}`)).headers(); // refused with 401: no sign-in
    expect(headers).toMatchObject(COMMON);
    expect(headers['content-security-policy']).toBeUndefined();
  }
});

test('the field worker keeps its own cache rule beside the security headers', async ({ request }) => {
  const response = await request.get('/sw.js');
  expect(response.headers()['cache-control']).toBe('no-cache, no-store, must-revalidate');
});
