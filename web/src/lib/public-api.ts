// API routes a signed-out caller may use. Everything else under /api refuses without sign-in
// (src/proxy.ts). Adding a path here makes it public: it must store and reveal nothing private.
export const publicApiPaths: readonly string[] = [
  '/api/health', // liveness, environment and build commit only
  '/api/echo', // sample Zod boundary; stores nothing and returns only its validated input
];

// Exact match only, so a prefix or a look-alike path never borrows a public route's status.
export function isPublicApiPath(pathname: string): boolean {
  return publicApiPaths.includes(pathname);
}
