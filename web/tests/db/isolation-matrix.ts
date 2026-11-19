import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { starterTable } from '@/lib/prices/starter';

// The company-isolation matrix (S3-17): one row for every handler of every route file under
// src/app, saying what kind of access rule it has and how the isolation suite attacks it. The suite
// (company-isolation.test.ts) imports every route file, fails when one of its handlers is not in
// this list or a row names one that no longer exists, and calls every exported handler with the
// other company's ids, failing by name on one it did not reach. So a new route cannot ship without
// somebody deciding here how another company's caller is refused, and the decision is read in
// review. That each handler has an access rule at all is tests/unit/route-rules.test.ts.
//
// Kinds:
//   company     a company member; the company comes from the sign-in
//   invitation  a verified account of the company, member or not
//   operator    the platform operator; every company user is refused
//   service     the scheduler's service account; no person is accepted
//   session     answers about the caller's own sign-in only
//   public      open to anyone; must return nothing of another company
//               beyond what its own comment says is public
//   link        a homeowner or adjuster holding a link token (S5a-11b); a sign-in of any company
//               is never read, so every company user without the token is refused (404)
export type RouteKind = 'company' | 'invitation' | 'operator' | 'service' | 'session' | 'public' | 'link';

export type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type MatrixRow = {
  // The route file's folder under src/app, as the file system spells it.
  route: string;
  method: Method;
  kind: RouteKind;
  // A request body that is valid for the route, so a refusal is the access rule's and not the
  // body check's. Never carries another company's id: the ids come from the path.
  body?: unknown;
  // The query string the route needs to get past its own request check (with the `?`).
  query?: string;
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

const row = (route: string, method: Method, kind: RouteKind, extra: Pick<MatrixRow, 'body' | 'query' | 'own' | 'self'> = {}): MatrixRow => ({
  route,
  method,
  kind,
  ...extra,
});

// Bodies that are valid for the job routes, so a refusal is the access rule's (the ids in them are
// the suite's own; the path carries the other company's job).
const JOB_CUSTOMER = { revision: 1, changeId: '5b7c1e0a-3f6d-4a52-9d1e-7a0c2b4f8e61', name: 'Planted Name', phone: '555-0100', email: 'planted@example.test', propertyAddress: '1 Planted Way' };
const PROFILE = { revision: '2000-01-01T00:00:00.000000Z', changeId: '3e9a7c52-8b14-4f06-9d2a-6c1b5e8f0a37', address: 'Planted Street', phone: '555-0100', email: 'planted@example.test', license: 'PLANTED', signoff: 'Planted Name', tagline: 'Planted Tagline', documents: { authorization_text: 'Planted Terms', prep_tasks: ['Planted Task'] } };
const JOB_CLAIM = { revision: 1, changeId: '8d2f4a90-61b3-4c7e-a5d8-0e9b3c1f7a24', carrier: 'Planted Mutual', claimNumber: 'PL-1', policyNumber: 'PL-2', dateOfLoss: null, lossCause: '', adjusterName: '', adjusterEmail: '', adjusterPhone: '', deductible: '' };

// A body the photo route accepts as an image (its first bytes are a PNG's), so a refusal is the
// access rule's and not the image check's.
// Submit and Back to editing bodies (S5a-8): the suite's own ids, and a digest of nothing.
const JOB_SUBMIT = { id: '6f1d9c34-2a7e-4b80-9c15-3e8a0d7b5f42', draftId: 'c4e8a2d6-7b19-4f53-8a0e-1d6b9f3c2e75', digest: '0'.repeat(64) };
const JOB_NEXT_DRAFT = { draftId: '9a3b5c7d-1e2f-4a6b-8c9d-0e1f2a3b4c5d', fromDraftId: 'c4e8a2d6-7b19-4f53-8a0e-1d6b9f3c2e75' };
const JOB_REPRICE = { revision: 1, changeId: '4d8b2f60-9c1e-4a73-8b05-2e7a6c1d9f38', versionId: '9b1e5c37-2d84-4f06-a3c9-6e0d8b4a1f52' };
const JOB_SIGN = {
  id: '2d7f4a91-6c3b-4e85-9a12-7b5c8e0f3d64',
  estimateId: '5b8e1c47-3f2a-4d96-8e01-4c7a9b2d6f15',
  proposalSha256: '0'.repeat(64),
  signatureId: '8c2a6e13-9d4f-4b70-a5e8-2f1b7c9d0e36',
  signerName: 'Isolation Check',
  documentsConfirmed: true,
};

// Office jobs (S5b-1): notes, an assignment and a field-owner move, with the suite's own ids; the
// path carries the other company's job (and assignment).
const JOB_COORDINATION = { revision: 1, changeId: '0c6e2a84-5d17-4b39-9e60-7f2a1c8d4b53', notes: 'Planted Note' };
const JOB_ASSIGN = { id: '9e4b2d76-1a3c-4f58-8b07-6d2e5a1c9f34', estimatorActorId: '3b7d1f95-8c2e-4a60-9d14-2f6b8e0a5c71' };
const JOB_TRANSFER = { revision: 1, changeId: '6a2c8e40-7b91-4d35-a2f6-1e9c3b5d7a08', toActorId: '3b7d1f95-8c2e-4a60-9d14-2f6b8e0a5c71' };

// Archive, restore and copy (S5b-2), with the suite's own ids; the path carries the other company's
// job.
const JOB_ARCHIVE = { revision: 1, changeId: '2f8a4c61-9d3b-4e07-b5a2-7c1e6f0d3b98' };
const JOB_COPY = { id: '5d9e1b37-4a2c-4f86-9e03-1b7d5c2a8f64', draftId: '8b3f7a15-2c9e-4d40-a6b1-3e5c9d7f0a82' };

// Link bodies (S5a-11b), with the suite's own ids.
const JOB_LINK = { id: '7a1c3e59-2b84-4d60-9f17-5c3e8a0b2d49', estimateId: '5b8e1c47-3f2a-4d96-8e01-4c7a9b2d6f15', proposalSha256: '0'.repeat(64) };
const JOB_DOCUMENT_LINK = { id: '1e5b9d27-6a40-4c83-b2f9-8d0e3a7c6b15', set: 'homeowner' };
const LINK_SIGN = {
  id: '4c8e2a60-9b17-4f35-8d02-6e1a3c5b7f98',
  signatureId: '8c2a6e13-9d4f-4b70-a5e8-2f1b7c9d0e36',
  signerName: 'Isolation Check',
  signerRole: 'homeowner',
  documentsConfirmed: true,
  electronicConsent: true,
};

const JOB_PHOTO = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from('planted photo')]);

const COMPANY = 'api/companies/[companyId]';
const PLATFORM = 'api/platform/companies';
const PLATFORM_ONE = `${PLATFORM}/[companyId]`;
const PRICES = 'api/prices';
// A write that is well formed but made from a revision no company has reached, so it is refused (409)
// and never writes, whoever sends it.
const STALE = 999_999;

export const MATRIX: readonly MatrixRow[] = [
  row(`${COMPANY}/team`, 'GET', 'company', { own: 'list' }),
  row(`${COMPANY}/profile`, 'GET', 'company', { own: 'list' }),
  row(`${COMPANY}/profile`, 'PUT', 'company', { body: PROFILE }),
  // S7-4: the owner's AI use; another company's id is 404 and an estimator or office user 403.
  row(`${COMPANY}/ai-usage`, 'GET', 'company', { own: 'list' }),
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
  // A file with no price in it: refused or answered about the caller's own company, never applied.
  row(`${PRICES}/import`, 'POST', 'company', { self: true, body: { expectedRevision: STALE, csv: 'item_id,code,name,group,trade,unit,enabled,row,room_type,up_to_sf,tier,price\r\n' } }),
  row(`${PRICES}/versions`, 'GET', 'company', { self: true, own: 'list' }),
  row(`${PRICES}/versions/[versionId]`, 'GET', 'company', { own: 'cross' }),
  row(`${PRICES}/versions/[versionId]/restore`, 'POST', 'company', { body: { expectedRevision: STALE }, own: 'cross' }),
  row('api/jobs', 'GET', 'company', { self: true, own: 'list' }),
  row('api/jobs', 'POST', 'company', { body: { id: '3c9a6e12-84d1-4f0b-b7a3-52e8d1c04f96', draftId: 'a1f0d7b4-2e65-4c39-8b1a-9d3e6f20c578' }, own: 'create' }),
  row('api/jobs/[jobId]', 'GET', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/customer', 'PUT', 'company', { body: JOB_CUSTOMER, own: 'cross' }),
  row('api/jobs/[jobId]/claim', 'PUT', 'company', { body: JOB_CLAIM, own: 'cross' }),
  row('api/jobs/[jobId]/photos/[photoId]', 'GET', 'company', { query: '?kind=photo', own: 'cross' }),
  row('api/jobs/[jobId]/photos/[photoId]', 'PUT', 'company', { query: '?kind=photo', body: JOB_PHOTO, own: 'cross' }),
  row('api/jobs/[jobId]/submissions', 'POST', 'company', { body: JOB_SUBMIT, own: 'cross' }),
  row('api/jobs/[jobId]/drafts', 'POST', 'company', { body: JOB_NEXT_DRAFT, own: 'cross' }),
  // S5a-9: the estimate takes no body; another company's job is 404 to every role.
  row('api/jobs/[jobId]/estimate', 'POST', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/estimate', 'GET', 'company', { own: 'cross' }),
  // S5b-6: Reprice names the revision, change and price version; another company's job is 404 to every role.
  row('api/jobs/[jobId]/reprice', 'POST', 'company', { body: JOB_REPRICE, own: 'cross' }),
  // S5a-11: signing names the phone's own agreement, estimate and signature ids; another company's
  // job is 404 to every role, and no agreement is made.
  row('api/jobs/[jobId]/agreements', 'POST', 'company', { body: JOB_SIGN, own: 'cross' }),
  row('api/jobs/[jobId]/agreements', 'GET', 'company', { own: 'cross' }),
  // S5a-10: what Check Scope picks from; another company's job is 404 to every role.
  row('api/jobs/[jobId]/scope-lists', 'GET', 'company', { own: 'cross' }),
  // S5a-11b: a signing link or document link of another company's job is 404 to every role, and
  // nothing is made; the bodies carry the suite's own ids.
  row('api/jobs/[jobId]/signing-link', 'POST', 'company', { body: JOB_LINK, own: 'cross' }),
  row('api/jobs/[jobId]/signing-link', 'GET', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/signing-link', 'DELETE', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/document-links', 'POST', 'company', { body: JOB_DOCUMENT_LINK, own: 'cross' }),
  row('api/jobs/[jobId]/document-links', 'GET', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/document-links/[linkId]', 'DELETE', 'company', { own: 'cross' }),
  // S5b-1: coordination, assignment and the field owner of another company's job are 404 to every
  // role, and nothing is changed.
  row('api/jobs/[jobId]/coordination', 'GET', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/coordination', 'PUT', 'company', { body: JOB_COORDINATION, own: 'cross' }),
  row('api/jobs/[jobId]/assignments', 'POST', 'company', { body: JOB_ASSIGN, own: 'cross' }),
  row('api/jobs/[jobId]/assignments/[assignmentId]', 'DELETE', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/field-owner', 'POST', 'company', { own: 'cross' }),
  row('api/jobs/[jobId]/field-owner/transfer', 'POST', 'company', { body: JOB_TRANSFER, own: 'cross' }),
  // S5b-2: archive, restore and copy of another company's job are 404 to every role allowed them
  // (403 to a role that is not), and nothing is changed or made.
  row('api/jobs/[jobId]/archive', 'POST', 'company', { body: JOB_ARCHIVE, own: 'cross' }),
  row('api/jobs/[jobId]/restore', 'POST', 'company', { body: JOB_ARCHIVE, own: 'cross' }),
  row('api/jobs/[jobId]/copy', 'POST', 'company', { body: JOB_COPY, own: 'cross' }),

  row('api/invitations/[invitationId]', 'GET', 'invitation'),
  row('api/invitations/[invitationId]/accept', 'POST', 'invitation'),

  row('api/me', 'GET', 'session'),

  row('api/health', 'GET', 'public'),
  row('api/echo', 'POST', 'public', { body: { message: 'hello' } }),
  row('api/sign-in/[address]', 'GET', 'public'),
  row('api/client-errors', 'POST', 'public', {
    body: { reports: [{ name: 'TypeError', message: 'x is not a function', stack: [], route: '/', browser: 'chrome' }] },
  }),

  row('api/internal/access-projection', 'POST', 'service'),

  // S5a-11b: the link routes read no sign-in; a company user's call carries no link token and is
  // refused. A real link of one company used against the other is in signing-links.test.ts.
  row('api/sign', 'GET', 'link'),
  row('api/sign', 'POST', 'link', { body: LINK_SIGN }),
  row('api/sign/signature', 'GET', 'link'),
  row('api/sign/signature/[signatureId]', 'PUT', 'link', { body: JOB_PHOTO }),
  row('api/sign/photos/[photoId]', 'GET', 'link'),
  row('api/documents', 'GET', 'link'),
  row('api/documents/signature', 'GET', 'link'),
  row('api/documents/photos/[photoId]', 'GET', 'link'),

  row(PLATFORM, 'GET', 'operator'),
  row(PLATFORM, 'POST', 'operator', { body: { name: 'Another Co', signInSlug: 'another-co' } }),
  row(`${PLATFORM_ONE}/flags`, 'POST', 'operator', { body: { flag: 'price_books', enabled: true } }),
  row(`${PLATFORM_ONE}/ai-settings`, 'PUT', 'operator', { body: { dailyCeilingMicroUsd: 1_000_000, monthlyCeilingMicroUsd: 10_000_000 } }),
  row(`${PLATFORM_ONE}/status`, 'POST', 'operator', { body: { status: 'suspended' } }),
  row(`${PLATFORM_ONE}/tenant`, 'POST', 'operator', { body: { tenantId: 'tenant-x' } }),
  row(`${PLATFORM_ONE}/owner`, 'POST', 'operator', { body: { email: 'boss@example.test', replace: true } }),
  row(`${PLATFORM_ONE}/team`, 'GET', 'operator'),
  row(`${PLATFORM_ONE}/prices`, 'GET', 'operator'),
  // S5b-5: the read-only support view of a company's jobs, one job and one photo's bytes.
  row(`${PLATFORM_ONE}/jobs`, 'GET', 'operator'),
  row(`${PLATFORM_ONE}/jobs/[jobId]`, 'GET', 'operator'),
  row(`${PLATFORM_ONE}/jobs/[jobId]/photos/[photoId]`, 'GET', 'operator', { query: '?kind=photo' }),
  // Their HEAD is refused with 405 before any sign-in check, read or audit, for anyone.
  row(`${PLATFORM_ONE}/jobs`, 'HEAD', 'public'),
  row(`${PLATFORM_ONE}/jobs/[jobId]`, 'HEAD', 'public'),
  row(`${PLATFORM_ONE}/jobs/[jobId]/photos/[photoId]`, 'HEAD', 'public', { query: '?kind=photo' }),
  // S8-3: the records check's first page; a later page also needs the operator's own run id.
  row(`${PLATFORM_ONE}/records-check`, 'POST', 'operator', { body: {} }),
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

// The path with every [name] filled in from `ids`, as the framework would hand it to the handler. A
// name that `ids` does not have is an error, not a made-up id: a route with a new path parameter
// must be given the other company's value for it before the suite can call it.
export function pathFor(route: string, ids: Readonly<Record<string, string>>): string {
  return `/${route}`.replace(/\[([A-Za-z]+)\]/g, (_match, name: string) => {
    const value = ids[name];
    if (value === undefined) throw new Error(`${route} has the path parameter [${name}], which the isolation suite has no id for (web/tests/db/company-isolation.test.ts, idsOf)`);
    return value;
  });
}

// One call the suite made: who, which handler, and the path it was given.
export const callKey = (who: string, method: string, path: string) => `${who} ${method} ${path}`;

// The calls that were expected and were not made, so a handler the loop skipped fails by name.
export const uncalled = (expected: readonly string[], made: ReadonlySet<string>): string[] => expected.filter((key) => !made.has(key));
