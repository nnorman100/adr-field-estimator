import { randomUUID } from 'node:crypto';

// The dev server compiles a page or route the first time it is asked for. With four workers all
// asking at once on a busy machine, that first compile can take longer than a test's wait for the
// screen it opens (5 s), and the test fails on a slow machine rather than on a fault in the app.
// So global setup asks for every page and route the specs visit once before any test starts. The
// answers do not matter (an unknown invitation, an unsigned request); only that each is compiled.
// A request that fails here is ignored: a real fault still fails the tests that need that route.
export async function warmRoutes(baseURL: string) {
  const unknown = randomUUID();
  const get = ['/', '/sign-in/company-a', `/sign-in/company-a/invitations/${unknown}`]
    .concat(['/api/health', '/api/me', '/api/sign-in/company-a', `/api/invitations/${unknown}`])
    .map((path) => ({ path, init: {} as RequestInit }));
  const post = ['/api/echo', `/api/invitations/${unknown}/accept`].map((path) => ({
    path,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  }));
  await Promise.allSettled(
    [...get, ...post].map(async ({ path, init }) => {
      const response = await fetch(new URL(path, baseURL), init);
      await response.arrayBuffer();
    }),
  );
}
