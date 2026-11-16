import { defineConfig } from '@playwright/test';
import e2e from './playwright.config';

// The QA hold (docs/runbook/qa.md): the browser tests' emulators, servers and seeded accounts
// (playwright.config.ts), kept running by tests/qa/hold.spec.ts so an agent can use the app the way
// a person would before the owner's phone check. One browser, no time limit, no retries; the CI
// browser run reads tests/e2e only, so it never runs the hold.
export default defineConfig({
  ...e2e,
  testDir: 'tests/qa',
  timeout: 0,
  retries: 0,
  shard: undefined,
  fullyParallel: false,
  reporter: 'list',
  projects: e2e.projects!.slice(0, 1),
});
