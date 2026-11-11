import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LocalSignInFixture } from '../../../src/lib/sign-in/local-directory';
import { createTenant, createUser } from './emulator';
import { FIXTURE_PATH, PASSWORD, SEED_PATH, STATE_DIR, type ProjectSeed, type Seed } from './seed';

// Two companies in two Auth emulator tenants, and for each browser project its own accounts, so
// Chromium and WebKit never change each other's users. The companies and memberships go to the
// file the dev server reads in place of Postgres (src/lib/sign-in/local-directory.ts).
const PROJECTS = ['chromium', 'webkit'];

export default async function globalSetup() {
  const run = randomUUID().slice(0, 8);
  const tenantA = await createTenant(`company-a-${run}`);
  const tenantB = await createTenant(`company-b-${run}`);
  const companyA = randomUUID();
  const companyB = randomUUID();
  const fixture: LocalSignInFixture = {
    companies: [
      { id: companyA, name: 'Company A Restoration', signInAddress: 'company-a', tenantId: tenantA, status: 'active' },
      { id: companyB, name: 'Company B Restoration', signInAddress: 'company-b', tenantId: tenantB, status: 'active' },
    ],
    members: [],
  };

  const projects: Record<string, ProjectSeed> = {};
  for (const project of PROJECTS) {
    const account = async (
      tenant: string,
      companyId: string,
      name: string,
      emailVerified: boolean,
      role: 'owner' | 'estimator' = 'estimator',
    ) => {
      const email = `${name}-${project}-${run}@example.com`;
      const uid = await createUser(tenant, { email, password: PASSWORD, emailVerified });
      fixture.members.push({ companyId, uid, actorId: randomUUID(), displayName: name, role, status: 'active' });
      return { email, uid };
    };
    projects[project] = {
      memberA: await account(tenantA, companyA, 'member-a', true),
      memberB: await account(tenantB, companyB, 'member-b', true),
      // The owner of company A, whose role needs the authenticator-app second step (S3-14). The
      // emulator cannot do TOTP, so this account has none there; the second-step tests stand a
      // second step in front of it at the network boundary, and it is never changed, so every test
      // can sign it in.
      ownerA: await account(tenantA, companyA, 'owner-a', true, 'owner'),
      unverifiedA: await account(tenantA, companyA, 'unverified-a', false),
      toVerifyA: [await account(tenantA, companyA, 'to-verify-a-0', false), await account(tenantA, companyA, 'to-verify-a-1', false)],
    };
  }

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture));
  const seed: Seed = { tenantA, tenantB, projects, fixture };
  await writeFile(SEED_PATH, JSON.stringify(seed));
}
