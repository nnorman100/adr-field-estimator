// Keeps the browser tests' stack running for a QA pass (docs/runbook/qa.md). Run by
// `npm run qa:hold` (playwright.qa.config.ts), never by the CI browser run. Writes where the app is
// and which seeded accounts to use to test-results/sign-in-state/qa-info.json, then waits until
// qa-stop appears beside it (or Ctrl-C). The accounts live only in the local emulators; their shared
// password is PASSWORD in tests/e2e/sign-in/seed.ts.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@playwright/test';
import { JOBS_BASE_URL } from '../e2e/jobs/backend';
import { SEED_PATH, STATE_DIR, type Seed } from '../e2e/sign-in/seed';

const INFO_PATH = join(STATE_DIR, 'qa-info.json');
const STOP_PATH = join(STATE_DIR, 'qa-stop');

test('hold the app for a QA pass', async ({ baseURL }) => {
  const seed = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Seed;
  const info = {
    app: baseURL,
    jobsApp: JOBS_BASE_URL,
    password: 'PASSWORD in web/tests/e2e/sign-in/seed.ts',
    signIn: {
      companyA: { address: 'company-a', ...seed.projects.chromium },
      team: seed.teams.chromium,
      prices: seed.prices.chromium,
    },
    stop: `touch ${STOP_PATH}`,
  };
  writeFileSync(INFO_PATH, JSON.stringify(info, null, 2));
  console.log(`QA hold: the app is at ${baseURL}; accounts in ${INFO_PATH}; stop with: touch ${STOP_PATH}`);
  while (!existsSync(STOP_PATH)) await new Promise((resolve) => setTimeout(resolve, 2_000));
  rmSync(STOP_PATH, { force: true });
});
