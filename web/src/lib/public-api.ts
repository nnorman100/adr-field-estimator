// API routes a signed-out caller may use. Everything else under /api refuses without sign-in
// (src/proxy.ts). Adding a path here makes it public: it must store and reveal nothing private.
export const publicApiPaths: readonly string[] = [
  '/api/health', // liveness, environment, build commit and whether the database answers
  '/api/echo', // sample Zod boundary; stores nothing and returns only its validated input
];

// API routes that check the sign-in themselves with memberRoute (src/lib/auth/route.ts). The proxy
// passes them on so the route can refuse with its own reason; a signed-out caller still gets no data.
export const memberApiPaths: readonly string[] = ['/api/me'];

// Exact match only, so a prefix or a look-alike path never borrows a public route's status.
export function isPublicApiPath(pathname: string): boolean {
  return publicApiPaths.includes(pathname);
}

export function isMemberApiPath(pathname: string): boolean {
  return memberApiPaths.includes(pathname);
}
