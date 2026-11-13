import { expect, test } from '@playwright/test';

// The deny-by-default API gate through the real server (src/proxy.ts). The release smoke check
// relies on these refusals.
test('signed-out business routes refuse while public routes answer', async ({ request }) => {
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await request.post('/api/echo', { data: { message: 'hi' } })).status()).toBe(200);

  for (const res of [await request.get('/api/jobs/current'), await request.post('/api/companies', { data: {} })]) {
    expect(res.status()).toBe(401);
    expect(res.headers()['www-authenticate']).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'sign_in_required' });
  }
});
