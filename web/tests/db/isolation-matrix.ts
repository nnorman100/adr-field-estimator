import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// The company-isolation matrix (S3-17): one row for every handler of every route file under
// src/app, saying what kind of access rule it has and how the isolation suite attacks it. The suite
// (company-isolation.test.ts) fails when a route file or handler is not in this list, when a row
// names one that no longer exists, or when a row's kind disagrees with the access rule the route
// file really uses. So a new route cannot ship without somebody deciding here how another
// company's caller is refused, and the decision is read in review.
//
// Kinds, and the access rule each is held to:
//   company     memberRoute / requireFlag   a company member; the company comes from the sign-in
//   invitation  accountRoute                a verified account of the company, member or not
//   operator    operatorRoute               the platform operator; every company user is refused
//   service     serviceRoute                the scheduler's service account; no person is accepted
//   session     memberRoute                 answers about the caller's own sign-in only
//   public      publicRoute                 open to anyone; must return nothing of another company
//                                           beyond what its own comment says is public
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
  own?: 'list' | 'cross';
};

const row = (route: string, method: Method, kind: RouteKind, extra: Pick<MatrixRow, 'body' | 'own'> = {}): MatrixRow => ({
  route,
  method,
  kind,
  ...extra,
});

const COMPANY = 'api/companies/[companyId]';
const PLATFORM = 'api/platform/companies';
const PLATFORM_ONE = `${PLATFORM}/[companyId]`;

export const MATRIX: readonly MatrixRow[] = [
  row(`${COMPANY}/team`, 'GET', 'company', { own: 'list' }),
  row(`${COMPANY}/invitations`, 'POST', 'company', { body: { email: 'new-person@example.test', role: 'estimator' } }),
  row(`${COMPANY}/invitations/[invitationId]/cancel`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/invitations/[invitationId]/clear`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/invitations/[invitationId]/resend`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]`, 'PATCH', 'company', { body: { role: 'office' }, own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]/disable`, 'POST', 'company', { own: 'cross' }),
  row(`${COMPANY}/members/[membershipId]/enable`, 'POST', 'company', { own: 'cross' }),

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
  row(`${PLATFORM_ONE}/members/[membershipId]`, 'PATCH', 'operator', { body: { role: 'office' } }),
  row(`${PLATFORM_ONE}/members/[membershipId]/enable`, 'POST', 'operator'),
  row(`${PLATFORM_ONE}/members/[membershipId]/reset-second-step`, 'POST', 'operator', { body: { confirmedBy: 'phone' } }),
  row(`${PLATFORM_ONE}/invitations/[invitationId]/cancel`, 'POST', 'operator'),
  row(`${PLATFORM_ONE}/invitations/[invitationId]/resend`, 'POST', 'operator'),
];

export const APP_DIR = fileURLToPath(new URL('../../src/app', import.meta.url));
const METHODS: readonly Method[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
// Every method the framework would route to a file's export; the matrix must name each one.
const ROUTED = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// The wrappers each kind may use, from src/lib/auth/route.ts.
export const WRAPPERS: Record<RouteKind, readonly string[]> = {
  company: ['memberRoute', 'requireFlag'],
  session: ['memberRoute'],
  invitation: ['accountRoute'],
  operator: ['operatorRoute'],
  service: ['serviceRoute'],
  public: ['publicRoute'],
};

export type FoundHandler = { route: string; method: string; wrapper: string | null };

async function routeFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await routeFiles(path)));
    else if (/^route\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

// Every exported handler in every route file, found by searching src/app (never from a list), with
// the name of the wrapper the file puts around it. A handler declared any other way has none.
export async function foundHandlers(dir = APP_DIR): Promise<FoundHandler[]> {
  const found: FoundHandler[] = [];
  for (const file of await routeFiles(dir)) {
    const route = relative(dir, join(file, '..'));
    found.push(...handlersIn(route, await readFile(file, 'utf8')));
  }
  return found;
}

export function handlersIn(route: string, source: string): FoundHandler[] {
  const found: FoundHandler[] = [];
  for (const match of source.matchAll(/^export\s+(?:const|async\s+function|function)\s+([A-Z]+)\b(.*)$/gm)) {
    const method = match[1]!;
    if (!ROUTED.has(method)) continue;
    const wrapper = /^\s*=\s*(?:async\s*)?(\w+)\s*\(/.exec(match[2]!)?.[1] ?? null;
    found.push({ route, method, wrapper });
  }
  return found;
}

const key = (value: { route: string; method: string }) => `${value.method} ${value.route}`;

// What is wrong between the handlers found and the matrix; empty when they agree.
export function matrixProblems(found: readonly FoundHandler[], matrix: readonly MatrixRow[] = MATRIX): string[] {
  const problems: string[] = [];
  const rows = new Map<string, MatrixRow>();
  for (const entry of matrix) {
    if (rows.has(key(entry))) problems.push(`${key(entry)} is in the matrix twice`);
    rows.set(key(entry), entry);
  }
  const seen = new Set<string>();
  for (const handler of found) {
    seen.add(key(handler));
    const entry = rows.get(key(handler));
    if (!entry) {
      problems.push(`${key(handler)} is not in the isolation matrix (web/tests/db/isolation-matrix.ts)`);
      continue;
    }
    if (!handler.wrapper || !WRAPPERS[entry.kind].includes(handler.wrapper)) {
      problems.push(`${key(handler)} is listed as ${entry.kind} but its rule is ${handler.wrapper ?? 'not a wrapper'}`);
    }
    if (!(METHODS as readonly string[]).includes(handler.method)) {
      problems.push(`${key(handler)} uses a method the isolation suite does not attack`);
    }
  }
  for (const name of rows.keys()) {
    if (!seen.has(name)) problems.push(`${name} is in the matrix but no route file has it`);
  }
  return problems;
}
