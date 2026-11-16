// The QA hold (playwright.qa.config.ts, tests/qa/hold.spec.ts, docs/runbook/qa.md): starts the same
// emulators, servers and seeded accounts as the browser tests, then keeps them running for a QA pass
// instead of running the suite. It must stay out of the CI browser run and inherit the e2e stack.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import e2e from '../../playwright.config';
import qa from '../../playwright.qa.config';

const web = fileURLToPath(new URL('../..', import.meta.url));

describe('the QA hold config', () => {
  it('starts exactly the browser tests’ servers and seed', () => {
    expect(qa.webServer).toEqual(e2e.webServer);
    expect(qa.globalSetup).toBe(e2e.globalSetup);
    expect(qa.use).toEqual(e2e.use);
  });

  it('runs only the hold, in one browser, with no time limit and no retries', () => {
    expect(qa.testDir).toBe('tests/qa');
    expect(qa.timeout).toBe(0);
    expect(qa.retries).toBe(0);
    expect(qa.shard).toBeUndefined();
    expect(qa.projects).toEqual([e2e.projects![0]]);
  });

  it('is never part of the CI browser run, which reads tests/e2e only', () => {
    expect(e2e.testDir).toBe('tests/e2e');
    expect(existsSync(`${web}/tests/qa/hold.spec.ts`)).toBe(true);
  });

  it('has an npm script', () => {
    const scripts = JSON.parse(readFileSync(`${web}/package.json`, 'utf8')).scripts;
    expect(scripts['qa:hold']).toBe('playwright test -c playwright.qa.config.ts');
  });
});
