import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// The one axe check new specs use: WCAG 2.0 and 2.1, levels A and AA, the same tags as the checks
// inside the older specs (which keep their own copies). Any violation fails, with its rule id.
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

export async function expectNoAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
