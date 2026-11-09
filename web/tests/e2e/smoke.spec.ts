import { expect, test } from '@playwright/test';

test('home page renders the skeleton', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();
});

test('health route answers ok', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', env: 'local' });
});

test('echo route validates input', async ({ request }) => {
  const bad = await request.post('/api/echo', { data: { message: '' } });
  expect(bad.status()).toBe(400);
  const ok = await request.post('/api/echo', { data: { message: 'hi' } });
  expect(await ok.json()).toEqual({ message: 'hi' });
});
