import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { starterTable } from '@/lib/prices/starter';

// The company-isolation matrix (S3-17): one row for every handler of every route file under
// src/app, saying what kind of access rule it has and how the isolation suite attacks it. The suite
// (company-isolation.test.ts) imports every route file, fails when one of its handlers is not in
// this list or a row names one that no longer exists, and calls every row with the other company's
// ids. So a new route cannot ship without somebody deciding here how another company's caller is
// refused, and the decision is read in review. That each handler has an access rule at all is
// tests/unit/route-rules.test.ts.
//
// Kinds:
//   company     a company member; the company comes from the sign-in
//   invitation  a verified account of the company, member or not
//   operator    the platform operator; every company user is refused
//   service     the scheduler's service account; no person is accepted
//   session     answers about the caller's own sign-in only
//   public      open to anyone; must return nothing of another company
//               beyond what its own comment says is public
export type RouteKind = 'company' | 'invitation' | 'operator' | 'service' | 'session' | 'public';

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type MatrixRow = {
  // The route file's folder under src/app, as the file system spells it.
  route: string;
  method: Method;
  kind: RouteKind;
  // A request body that is valid for the route, so a refusal is the access rule's and not the
  // body check's. Never carries another company's id: the ids come from the path.
  body?: unknown;
  // How the suite also calls the route as the caller's own company, where that is a read or a
  // path that names another company's record:
  //   list   the caller's own ids; a 200 that holds none of the other company's rows
  //   cross  the caller's own company with the other company's record ids: refused
  //   create a route that makes the caller's own record from the body and names no company in its
  //          path, so the other company's people are not refused: the suite sends the other
  //          company's record ids in the body and checks the caller got only its own record and
  //          the other company's rows are unchanged
  own?: 'list' | 'cross' | 'create';
  // The route names no company and no record of one: the company is the caller's sign-in (the
  // Prices routes). A call by the other company's user is therefore answered about the caller's own
  // company, so the suite expects an answer that holds nothing of the other company and changes
  // nothing (a write here carries a stale revision, so it is refused), instead of a refusal.
  self?: true;
};

const row = (route: string, method: Method, kind: RouteKind, extra: Pick<MatrixRow, 'body' | 'own' | 'self'> = {}): MatrixRow => ({
  route,
  method,
  kind,
  ...extra,
});

// Bodies that are valid for the job routes, so a refusal is the access rule's (the ids in them are
// the suite's own; the path carries the other company's job).
const JOB_CUSTOMER = { revision: 1, changeId: '5b7c1e0a-3f6d-4a52-9d1e-7a0c2b4f8e61', name: 'Planted Name', phone: '555-0100', email: 'planted@example.test', propertyAddress: '1 Planted Way' };
const JOB_CLAIM = { revision: 1, changeId: '8d2f4a90-61b3-4c7e-a5d8-0e9b3c1f7a24', carrier: 'Planted Mutual', claimNumber: 'PL-1', policyNumber: 'PL-2', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' };

const COMPANY = 'api/companies/[companyId]';
const PLATFORM = 'api/platform/companies';
const PLATFORM_ONE = `${PLATFORM}/[companyId]`;
const PRICES = 'api/prices';
// A write that is well formed but made from a revision no company has reached, so it is refused (409)
// and never writes, whoever sends it.
const STALE = 999_999;

export const MATRIX: readonly MatrixRow[] = [
  row(`${COMPANY}/team`, 'GET', 'company', { own: 'list' }),
  row(`${COMPANY}/invitations`, 'POST', 'company', { body: { email: 'new-person@example.test', role: 'estimator' } }),
  row(`${COMPANY}/invitations/[invitationId]/cancel`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/invitations/[invitationId]/clear`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/invitations/[invitationId]/resend`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]`, 'PATCH', 'company', { body: { role: 'office' }, own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]/disable`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]/enable`, 'POST', 'company', { own: 'cross' }),

  row(PRICES, 'GET', 'company', { self: true, own: 'list' }),
  row(`${PRICES}/working-copy`, 'PUT', 'company', { self: true, body: { expectedRevision: STALE, table: starterTable() } }),
  row(`${PRICES}/preview`, 'POST', 'company', { self: true, body: {} }),
  row(`${PRICES}/publish`, 'POST', 'company', {
    self: true,
    body: { expectedRevision: STALE, reason: 'Isolation check', publishKey: 'isolation-key-1', rangeChoice: 'single' },
  }),
  row(`${PRICES}/export`, 'GET', 'company', { self: true, own: 'list' }),
  row(`${PRICES}/versions`, 'GET', 'company', { self: true, own: 'list' }),
  row(`${PRICES}/versions/[versionId]`, 'GET', 'company', { own: 'cross' }),
  row(`${PRICES}/versions/[versionId]/restore`, 'POST', 'company', { body: { expectedRevision: STALE }, own: 'cross' }),
  row('api/jobs', 'GET', 'company', { self: true, own: 'list' }),
  row('api/jobs', 'POST', 'company', { body: { id: '3c9a6e12-84d1-4f0b-b7a3-52e8d1c04f96', draftId: 'a1f0d7b4-2e65-4c39-8b1a-9d3e6f20c578' }, own: 'create' }),
  row('api/jobs/[jobId]', 'GET', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/customer', 'PUT', 'company', { body: JOB_CUSTOMER, own: 'cross' }),
  row('api/jobs/[jobId]/claim', 'PUT', 'company', { body: JOB_CLAIM, own: 'cross' }),

  row('api/invitations/[invitationId]', 'GET', 'invitation'),
  row('api/invitations/[invitationId]/accept', 'POST', 'invitation'),

  row('api/me', 'GET', 'session'),

  row('api/health', 'GET', 'public'),
  row('api/echo', 'POST', 'public', { body: { message: 'hello' } }),
  row('api/sign-in/[address]', 'GET', 'public'),

  row('api/internal/access-projection', 'POST', 'service'),

  row(PLATFORM, 'GET', 'operator'),
  row(PLATFORM, 'POST', 'operator', { body: { name: 'Another Co', signInSlug: 'another-co' } }),
  row(`${PLATFORM_ONE}/flags`, 'POST', 'operator', { body: { flag: 'price_books', enabled: true } }),
  row(`${PLATFORM_ONE}/status`, 'POST', 'operator', { body: { status: 'suspended' } }),
  row(`${PLATFORM_ONE}/tenant`, 'POST', 'operator', { body: { tenantId: 'tenant-x' } }),
  row(`${PLATFORM_ONE}/owner`, 'POST', 'operator', { body: { email: 'boss@example.test', replace: true } }),
  row(`${PLATFORM_ONE}/team`, 'GET', 'operator'),
  row(`${PLATFORM_ONE}/prices`, 'GET', 'operator'),
  row(`${PLATFORM_ONE}/members/[membershipId]`, 'PATCH', 'operator', { body: { role: 'office' } }),
  row(`${PLATFORM_ONE}/members/[membershipId]/enable`, 'POST', 'operator'),
  row(`${PLATFORM_ONE}/members/[membershipId]/reset-second-step`, 'POST', 'operator', { body: { confirmedBy: 'phone' } }),
  row(`${PLATFORM_ONE}/invitations/[invitationId]/cancel`, 'POST', 'operator'),
  row(`${PLATFORM_ONE}/invitations/[invitationId]/resend`, 'POST', 'operator'),
];

export const APP_DIR = fileURLToPath(new URL('../../src/app', import.meta.url));
// Every method the framework would route to a file's export; the matrix must name each one.
const ROUTED = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export type RouteModule = Record<string, unknown>;
export type FoundHandler = { route: string; method: string };

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (/^route\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

// Every route file under src/app, found by searching it (never from a list) and imported, keyed by
// its folder.
export async function routeModules(dir = APP_DIR): Promise<Map<string, RouteModule>> {
  const modules = new Map<string, RouteModule>();
  for (const file of await routeFiles(dir)) modules.set(relative(dir, join(file, '..')), (await import(file)) as RouteModule);
  return modules;
}

// Every handler the framework would route to: each export of a route module named for a method.
export function handlersOf(modules: ReadonlyMap<string, RouteModule>): FoundHandler[] {
  const found: FoundHandler[] = [];
  for (const [route, module] of modules) {
    for (const method of Object.keys(module).sort()) if (ROUTED.has(method)) found.push({ route, method });
  }
  return found;
}

export const matrixKey = (value: { route: string; method: string }) => `${value.method} ${value.route}`;

// What is wrong between the handlers found and the matrix; empty when they agree.
export function matrixProblems(found: readonly FoundHandler[], matrix: readonly MatrixRow[] = MATRIX): string[] {
  const problems: string[] = [];
  const rows = new Set<string>();
  for (const entry of matrix) {
    if (rows.has(matrixKey(entry))) problems.push(`${matrixKey(entry)} is in the matrix twice`);
    rows.add(matrixKey(entry));
  }
  const seen = new Set<string>();
  for (const handler of found) {
    seen.add(matrixKey(handler));
    if (!rows.has(matrixKey(handler))) problems.push(`${matrixKey(handler)} is not in the isolation matrix (web/tests/db/isolation-matrix.ts)`);
  }
  for (const name of rows) {
    if (!seen.has(name)) problems.push(`${name} is in the matrix but no route file has it`);
  }
  return problems;
}
