import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalSignInFixture } from '../../../src/lib/sign-in/local-directory';

// Where the sign-in tests' seed lives. Under test-results/, which Playwright empties before it
// starts the servers and runs global-setup.ts, so a run never reads an earlier run's tenants.
const webDir = fileURLToPath(new URL('../../..', import.meta.url));
export const STATE_DIR = join(webDir, 'test-results', 'sign-in-state');
// Read by the dev server (LOCAL_SIGN_IN_FIXTURE) in place of the database.
export const FIXTURE_PATH = join(STATE_DIR, 'fixture.json');
// Read by the tests: the tenants and the accounts made for each browser project.
export const SEED_PATH = join(STATE_DIR, 'seed.json');

export const PASSWORD = 'correct-horse-battery-staple';

export type SeedAccount = { email: string; uid: string };
export type ProjectSeed = {
  // A verified estimator of company A.
  memberA: SeedAccount;
  // A verified estimator of company B.
  memberB: SeedAccount;
  // The verified owner of company A, for the second-step tests (second-step.spec.ts).
  ownerA: SeedAccount;
  // An estimator of company A whose email is not verified, and stays so.
  unverifiedA: SeedAccount;
  // Estimators of company A whose email is not verified yet, one per attempt of the test that
  // verifies it (Playwright retries once in CI), so a retry starts from an unverified account.
  toVerifyA: SeedAccount[];
  // A verified platform operator, signed in through the operator tenant. The emulator cannot do
  // an authenticator-app second step, so the server asks this account for one (S3-14, S3-18).
  operator: SeedAccount;
};
export type TeamAccount = SeedAccount & { name: string };
// A company of its own for each browser project, for the team screens (tests/e2e/team.spec.ts),
// whose tests change its team.
export type TeamSeed = {
  address: string;
  companyId: string;
  companyName: string;
  tenantId: string;
  owner: TeamAccount;
  estimator: TeamAccount;
  office: TeamAccount;
  // Estimators for the tests that change a role, and for the ones that turn a member off, one per
  // attempt (Playwright retries once in CI), so a retry starts from an unchanged member.
  forRoleChange: TeamAccount[];
  forTurnOff: TeamAccount[];
  // A verified account of the company with no membership and no invitation.
  stranger: TeamAccount;
};
// A company of its own for each browser project with the price_books switch on, for the Prices
// screens (tests/e2e/prices.spec.ts), whose tests change its prices.
export type PricesSeed = {
  address: string;
  companyId: string;
  companyName: string;
  tenantId: string;
  owner: TeamAccount;
  estimator: TeamAccount;
  office: TeamAccount;
};
export type Seed = {
  tenantA: string;
  tenantB: string;
  // The operator sign-in tenant (owner decision D6).
  tenantOperators: string;
  projects: Record<string, ProjectSeed>;
  teams: Record<string, TeamSeed>;
  prices: Record<string, PricesSeed>;
  fixture: LocalSignInFixture;
};

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_PATH, 'utf8')) as Seed;
}
