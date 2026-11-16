import { expect, type BrowserContext, type Page } from '@playwright/test';

// Installed before the first document: catches violations during bootstrap, in subframes and
// across reloads, including while offline when a browser cannot deliver its HTTP report yet.
export async function observeCsp(context: BrowserContext) {
  const violations: { directive: string; blocked: string; disposition: string }[] = [];
  const reports: string[] = [];
  await context.exposeBinding('__cspViolation', (_source, value) => {
    violations.push(value);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (
        window as unknown as { __cspViolation: (value: unknown) => Promise<void> }
      ).__cspViolation({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
        disposition: event.disposition,
      });
    });
  });
  context.on('request', (request) => {
    if (/^application\/(?:csp-report|reports\+json)/.test(request.headers()['content-type'] ?? ''))
      reports.push(request.url());
  });
  return {
    violations,
    async expectClean(page: Page) {
      // CSP events are queued tasks; allow them and the binding calls to drain before asserting.
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
      expect(violations).toEqual([]);
      expect(reports).toEqual([]);
    },
  };
}

export async function expectReportOnly(page: Page) {
  const response = await page.request.get(page.url());
  expect(response.headers()['content-security-policy']).toBe(
    "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  expect(response.headers()['content-security-policy-report-only']).toContain('connect-src');
}
