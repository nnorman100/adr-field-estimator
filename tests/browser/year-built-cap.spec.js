const { test, expect } = require('@playwright/test');

// The Year built cap follows the clock: a phone opened in 2027 accepts 2027, not 2028.
test('Year built accepts the current year when the clock reads 2027', async ({ page }) => {
  await page.addInitScript(() => {
    const RealDate = Date;
    const fixed = new RealDate('2027-01-02T12:00:00Z').getTime();
    class FakeDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fixed]));
      }
      static now() {
        return fixed;
      }
    }
    window.Date = FakeDate;
  });
  await page.goto('/app');
  const year = page.locator('#yearBuilt');
  await expect(year).toHaveAttribute('max', '2027');
  await year.evaluate((el) => (el.value = '2027'));
  expect(await year.evaluate((el) => el.validity.rangeOverflow)).toBe(false);
  await year.evaluate((el) => (el.value = '2028'));
  expect(await year.evaluate((el) => el.validity.rangeOverflow)).toBe(true);
});
