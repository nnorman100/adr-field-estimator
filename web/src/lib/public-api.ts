// API routes a signed-out caller may use. Everything else under /api refuses without sign-in
// (src/proxy.ts). Adding a path here makes it public: it must store and reveal nothing private.
export const publicApiPaths: readonly string[] = [
  '/api/health', // liveness, environment, build commit and whether the database answers
  '/api/echo', // sample Zod boundary; stores nothing and returns only its validated input
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
];

// Internal job routes that check a service token themselves with serviceRoute (src/lib/auth/route.ts):
// only the scheduler service account gets past them, never a person.
export const serviceApiPaths: readonly string[] = ['/api/internal/access-projection'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function matches(pattern: string, pathname: string): boolean {
  const want = pattern.split('/');
  const got = pathname.split('/');
  return want.length === got.length && want.every((part, i) => (part === ':id' ? UUID.test(got[i]!) : part === got[i]));
}

// Exact match only, so a prefix or a look-alike path never borrows a public route's status.
export function isPublicApiPath(pathname: string): boolean {
  return publicApiPaths.includes(pathname);
}

export function isMemberApiPath(pathname: string): boolean {
  return memberApiPaths.some((pattern) => matches(pattern, pathname));
}

export function isServiceApiPath(pathname: string): boolean {
  return serviceApiPaths.includes(pathname);
}
