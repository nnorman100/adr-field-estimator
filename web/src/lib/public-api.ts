// API routes a signed-out caller may use. Everything else under /api refuses without sign-in
// (src/proxy.ts). Adding a path here makes it public: it must store and reveal nothing private.
export const publicApiPaths: readonly string[] = [
  '/api/health', // liveness, environment, build commit and whether the database answers
  '/api/echo', // sample Zod boundary; stores nothing and returns only its validated input
  // A company's name and sign-in tenant for its sign-in page, both public; `:address` matches one
  // sign-in address (src/lib/sign-in/directory.ts) and nothing else.
  '/api/sign-in/:address',
];

// API routes that check the sign-in themselves with memberRoute or accountRoute (src/lib/auth/route.ts).
// The proxy passes them on so the route can refuse with its own reason; a signed-out caller still
// gets no data. A `:id` segment matches one uuid and nothing else.
export const memberApiPaths: readonly string[] = [
  '/api/me',
  '/api/companies/:id/team',
  '/api/companies/:id/invitations',
  '/api/companies/:id/invitations/:id/resend',
  '/api/companies/:id/invitations/:id/cancel',
  '/api/companies/:id/invitations/:id/clear',
  '/api/companies/:id/members/:id',
  '/api/companies/:id/members/:id/disable',
  '/api/companies/:id/members/:id/enable',
  '/api/invitations/:id',
  '/api/invitations/:id/accept',
  '/api/jobs',
  '/api/jobs/:id',
  '/api/jobs/:id/customer',
  '/api/jobs/:id/claim',
];

// Platform operator routes that check the operator sign-in themselves with operatorRoute
// (src/lib/auth/route.ts): only an active platform operator gets past them, never a company user.
export const operatorApiPaths: readonly string[] = [
  '/api/platform/companies',
  '/api/platform/companies/:id/status',
  '/api/platform/companies/:id/flags',
  '/api/platform/companies/:id/tenant',
  '/api/platform/companies/:id/owner',
  '/api/platform/companies/:id/team',
  '/api/platform/companies/:id/members/:id',
  '/api/platform/companies/:id/members/:id/enable',
  '/api/platform/companies/:id/members/:id/reset-second-step',
  '/api/platform/companies/:id/invitations/:id/resend',
  '/api/platform/companies/:id/invitations/:id/cancel',
];

// Internal job routes that check a service token themselves with serviceRoute (src/lib/auth/route.ts):
// only the scheduler service account gets past them, never a person.
export const serviceApiPaths: readonly string[] = ['/api/internal/access-projection'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The sign-in address rule (companies_sign_in_slug_check, migration 0002).
const ADDRESS = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

function segmentMatches(part: string, got: string): boolean {
  if (part === ':id') return UUID.test(got);
  if (part === ':address') return ADDRESS.test(got);
  return part === got;
}

function matches(pattern: string, pathname: string): boolean {
  const want = pattern.split('/');
  const got = pathname.split('/');
  return want.length === got.length && want.every((part, i) => segmentMatches(part, got[i]!));
}

// Exact match, or one placeholder segment of its own shape, so a prefix or a look-alike path never
// borrows a public route's status.
export function isPublicApiPath(pathname: string): boolean {
  return publicApiPaths.some((pattern) => matches(pattern, pathname));
}

export function isMemberApiPath(pathname: string): boolean {
  return memberApiPaths.some((pattern) => matches(pattern, pathname));
}

export function isOperatorApiPath(pathname: string): boolean {
  return operatorApiPaths.some((pattern) => matches(pattern, pathname));
}

export function isServiceApiPath(pathname: string): boolean {
  return serviceApiPaths.includes(pathname);
}
