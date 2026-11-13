import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './a11y';

// The start page (/) at phone width, in Chromium and WebKit, with nothing remembered on the phone.
test.use({ viewport: { width: 390, height: 844 } });

test('the start page passes the accessibility check', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'DryScope' })).toBeVisible();
  await expectNoAxeViolations(page);
});
