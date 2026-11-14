import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LocalSignInFixture } from '../../../src/lib/sign-in/local-directory';
import type { FullConfig } from '@playwright/test';
import { createTenant, createUser } from './emulator';
import {
  FIXTURE_PATH,
  PASSWORD,
  SEED_PATH,
  STATE_DIR,
  type PricesSeed,
  type ProjectSeed,
  type Seed,
  type TeamAccount,
  type TeamSeed,
} from './seed';
import { warmRoutes } from './warm-routes';

// Two companies in two Auth emulator tenants, and for each browser project its own accounts, so
// Chromium and WebKit never change each other's users. The companies and memberships go to the
// file the dev server reads in place of Postgres (src/lib/sign-in/local-directory.ts).
const PROJECTS = ['chromium', 'webkit'];

export default async function globalSetup(config: FullConfig) {
  const run = randomUUID().slice(0, 8);
  const tenantA = await createTenant(`company-a-${run}`);
  const tenantB = await createTenant(`company-b-${run}`);
  const tenantOperators = await createTenant(`operators-${run}`);
  const companyA = randomUUID();
  const companyB = randomUUID();
  const fixture: LocalSignInFixture = {
    companies: [
      { id: companyA, name: 'Company A Restoration', signInAddress: 'company-a', tenantId: tenantA, status: 'active' },
      { id: companyB, name: 'Company B Restoration', signInAddress: 'company-b', tenantId: tenantB, status: 'active' },
    ],
    members: [],
    operators: [],
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
    const operatorEmail = `operator-${project}-${run}@example.com`;
    const operatorUid = await createUser(tenantOperators, { email: operatorEmail, password: PASSWORD, emailVerified: true });
    fixture.operators!.push({ tenantId: tenantOperators, uid: operatorUid, operatorId: randomUUID() });
    projects[project] = {
      operator: { email: operatorEmail, uid: operatorUid },
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

  // A company of its own for each project's team tests: the owner and the office user have the
  // second step the emulator cannot do (the fixture's `secondStep`; office needs it since
  // 2026-11-14, D2), and the team starts with one estimator and one office user besides the people
  // the tests change.
  const teams: Record<string, TeamSeed> = {};
  for (const project of PROJECTS) {
    const tenantId = await createTenant(`team-${project}-${run}`);
    const companyId = randomUUID();
    const address = `team-${project}`;
    const companyName = `Team ${project} Restoration`;
    fixture.companies.push({ id: companyId, name: companyName, signInAddress: address, tenantId, status: 'active' });
    const person = async (name: string, role: 'owner' | 'estimator' | 'office' | null): Promise<TeamAccount> => {
      const email = `${name}-${project}-${run}@example.com`;
      const uid = await createUser(tenantId, { email, password: PASSWORD, emailVerified: true });
      if (role) {
        fixture.members.push({
          companyId,
          uid,
          actorId: randomUUID(),
          membershipId: randomUUID(),
          email,
          displayName: name,
          role,
          status: 'active',
          ...(role === 'owner' || role === 'office' ? { secondStep: true } : {}),
        });
      }
      return { email, uid, name };
    };
    teams[project] = {
      address,
      companyId,
      companyName,
      tenantId,
      owner: await person('owner-team', 'owner'),
      estimator: await person('estimator-team', 'estimator'),
      office: await person('office-team', 'office'),
      forRoleChange: [await person('role-change-0', 'estimator'), await person('role-change-1', 'estimator')],
      forTurnOff: [await person('turn-off-0', 'estimator'), await person('turn-off-1', 'estimator')],
      stranger: await person('stranger-team', null),
    };
  }

  // A company of its own for each project's Prices tests, with the price_books switch on: an owner
  // and an office user with the second step (office needs it since 2026-11-14, D2), an estimator,
  // and a second office user who has not set it up yet, to show the refusal.
  const prices: Record<string, PricesSeed> = {};
  for (const project of PROJECTS) {
    const tenantId = await createTenant(`prices-${project}-${run}`);
    const companyId = randomUUID();
    const address = `prices-${project}`;
    const companyName = `Prices ${project} Restoration`;
    fixture.companies.push({ id: companyId, name: companyName, signInAddress: address, tenantId, status: 'active', flags: ['price_books'] });
    const person = async (
      name: string,
      role: 'owner' | 'estimator' | 'office',
      secondStep = role !== 'estimator',
    ): Promise<TeamAccount> => {
      const email = `${name}-${project}-${run}@example.com`;
      const uid = await createUser(tenantId, { email, password: PASSWORD, emailVerified: true });
      fixture.members.push({
        companyId,
        uid,
        actorId: randomUUID(),
        membershipId: randomUUID(),
        email,
        displayName: name,
        role,
        status: 'active',
        ...(secondStep ? { secondStep: true } : {}),
      });
      return { email, uid, name };
    };
    prices[project] = {
      address,
      companyId,
      companyName,
      tenantId,
      owner: await person('owner-prices', 'owner'),
      estimator: await person('estimator-prices', 'estimator'),
      office: await person('office-prices', 'office'),
      officeWithoutApp: await person('office-no-app-prices', 'office', false),
    };
  }

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(FIXTURE_PATH, JSON.stringify(fixture));
  const seed: Seed = { tenantA, tenantB, tenantOperators, projects, teams, prices, fixture };
  await writeFile(SEED_PATH, JSON.stringify(seed));
  // The fixture is in place, so the dev server can answer the sign-in routes: compile each route now.
  await warmRoutes(config.projects[0]!.use.baseURL!);
  await warmTeamRoutes(config.projects[0]!.use.baseURL!);
}

// The team screens' pages and routes, which warmRoutes does not ask for. Same reason: the dev server
// compiles each the first time it is asked, and four browsers waiting on those compiles at once made
// the first tests of a run miss their five-second waits. Best effort: a failure here only means a
// test meets the compile itself.
async function warmTeamRoutes(baseUrl: string) {
  const id = randomUUID();
  const paths = [
    ['GET', '/sign-in/company-z'],
    ['GET', '/sign-in/company-a/team'],
    ['GET', '/sign-in/company-a/company'],
    ['GET', '/sign-in/company-a/prices'],
    ['GET', '/api/prices'],
    ['PUT', '/api/prices/working-copy'],
    ['POST', '/api/prices/preview'],
    ['POST', '/api/prices/publish'],
    ['GET', '/api/prices/versions'],
    ['POST', `/api/prices/versions/${id}/restore`],
    ['GET', '/api/prices/export'],
    ['POST', '/api/prices/import'],
    ['GET', `/api/companies/${id}/profile`],
    ['PUT', `/api/companies/${id}/profile`],
    ['GET', `/api/companies/${id}/team`],
    ['POST', `/api/companies/${id}/invitations`],
    ['POST', `/api/companies/${id}/invitations/${id}/resend`],
    ['POST', `/api/companies/${id}/invitations/${id}/cancel`],
    ['POST', `/api/companies/${id}/invitations/${id}/clear`],
    ['PATCH', `/api/companies/${id}/members/${id}`],
    ['POST', `/api/companies/${id}/members/${id}/disable`],
    ['POST', `/api/companies/${id}/members/${id}/enable`],
  ] as const;
  for (const [method, path] of paths) {
    await fetch(new URL(path, baseUrl), { method, signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
  }
}
